"""Conversation management and message history endpoints."""
import base64
import logging
import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.schemas import (
    ConversationCreateRequest,
    ConversationResponse,
    MessageResponse,
    MessageVersionResponse,
    UserPublic,
)
from app.core.db import get_db
from app.core.deps import get_current_user
from app.models.conversation import Conversation
from app.models.message import Message
from app.models.message_version import MessageVersion
from app.models.user import User

router = APIRouter(prefix="/conversations", tags=["conversations"])
log = logging.getLogger("nullspace.conversations")


def _build_conversation_response(
    conv: Conversation,
    current_user_id: uuid.UUID,
    peer: User,
    last_message_at: datetime | None,
    unread_count: int,
) -> ConversationResponse:
    if current_user_id == conv.user_a_id:
        verified_by_me = conv.verified_a
        verified_by_peer = conv.verified_b
    else:
        verified_by_me = conv.verified_b
        verified_by_peer = conv.verified_a

    return ConversationResponse(
        id=conv.id,
        user_a_id=conv.user_a_id,
        user_b_id=conv.user_b_id,
        peer=UserPublic.model_validate(peer),
        verified_by_me=verified_by_me,
        verified_by_peer=verified_by_peer,
        created_at=conv.created_at,
        last_message_at=last_message_at,
        unread_count=unread_count,
    )


async def _get_conversation_stats(
    conversation_id: uuid.UUID,
    current_user_id: uuid.UUID,
    session: AsyncSession,
) -> dict:
    stmt = (
        select(
            func.max(Message.created_at).label("last_message_at"),
            func.count(
                case(
                    (
                        (Message.sender_id != current_user_id) & Message.read_at.is_(None),
                        Message.id,
                    ),
                    else_=None,
                )
            ).label("unread_count"),
        )
        .where(Message.conversation_id == conversation_id)
    )
    res = await session.execute(stmt)
    row = res.one_or_none()
    last_message_at = row[0] if row else None
    unread_count = row[1] if row and row[1] is not None else 0
    return {"last_message_at": last_message_at, "unread_count": unread_count}


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    response_model=ConversationResponse,
)
async def create_conversation(
    request: ConversationCreateRequest,
    response: Response,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_db)],
) -> ConversationResponse:
    """Create or retrieve a canonical two-party conversation."""
    if request.peer_id == current_user.user_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="cannot_chat_with_self",
        )

    peer_stmt = select(User).where(User.user_id == request.peer_id)
    peer_res = await session.execute(peer_stmt)
    peer = peer_res.scalar_one_or_none()
    if peer is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="user_not_found",
        )

    user_a_id, user_b_id = sorted([current_user.user_id, peer.user_id])

    find_stmt = select(Conversation).where(
        Conversation.user_a_id == user_a_id,
        Conversation.user_b_id == user_b_id,
    )
    existing_res = await session.execute(find_stmt)
    existing = existing_res.scalar_one_or_none()

    if existing is not None:
        response.status_code = status.HTTP_200_OK
        stats = await _get_conversation_stats(existing.id, current_user.user_id, session)
        return _build_conversation_response(
            existing, current_user.user_id, peer, stats["last_message_at"], stats["unread_count"]
        )

    conv = Conversation(user_a_id=user_a_id, user_b_id=user_b_id)
    session.add(conv)
    try:
        await session.commit()
        await session.refresh(conv)
        response.status_code = status.HTTP_201_CREATED
        return _build_conversation_response(
            conv, current_user.user_id, peer, None, 0
        )
    except IntegrityError:
        await session.rollback()
        # Handle concurrent creation race condition safely
        existing_res = await session.execute(find_stmt)
        existing = existing_res.scalar_one()
        response.status_code = status.HTTP_200_OK
        stats = await _get_conversation_stats(existing.id, current_user.user_id, session)
        return _build_conversation_response(
            existing, current_user.user_id, peer, stats["last_message_at"], stats["unread_count"]
        )


@router.get(
    "",
    status_code=status.HTTP_200_OK,
    response_model=list[ConversationResponse],
)
async def list_conversations(
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_db)],
) -> list[ConversationResponse]:
    """List all conversations involving the authenticated user, sorted by newest activity."""
    current_user_id = current_user.user_id

    msg_stats = (
        select(
            Message.conversation_id,
            func.max(Message.created_at).label("last_message_at"),
            func.count(
                case(
                    (
                        (Message.sender_id != current_user_id) & Message.read_at.is_(None),
                        Message.id,
                    ),
                    else_=None,
                )
            ).label("unread_count"),
        )
        .group_by(Message.conversation_id)
        .subquery()
    )

    peer_id_expr = case(
        (Conversation.user_a_id == current_user_id, Conversation.user_b_id),
        else_=Conversation.user_a_id,
    )

    stmt = (
        select(
            Conversation,
            User,
            msg_stats.c.last_message_at,
            func.coalesce(msg_stats.c.unread_count, 0).label("unread_count"),
        )
        .join(User, User.user_id == peer_id_expr)
        .outerjoin(msg_stats, Conversation.id == msg_stats.c.conversation_id)
        .where(
            or_(
                Conversation.user_a_id == current_user_id,
                Conversation.user_b_id == current_user_id,
            )
        )
        .order_by(
            func.coalesce(msg_stats.c.last_message_at, Conversation.created_at).desc(),
            Conversation.id.desc(),
        )
    )

    res = await session.execute(stmt)
    rows = res.all()

    return [
        _build_conversation_response(
            conv=conv,
            current_user_id=current_user_id,
            peer=peer,
            last_message_at=last_msg,
            unread_count=unread,
        )
        for conv, peer, last_msg, unread in rows
    ]


@router.get(
    "/{id}/messages",
    status_code=status.HTTP_200_OK,
    response_model=list[MessageResponse],
)
async def get_message_history(
    id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_db)],
    before: Annotated[str | None, Query(description="Cursor: message UUID")] = None,
    limit: Annotated[int, Query(ge=1, le=100, description="Page limit (1-100)")] = 50,
) -> list[MessageResponse]:
    """Retrieve keyset-paginated message history with nested versions."""
    # 1. Verify conversation existence and participant access
    conv_stmt = select(Conversation).where(Conversation.id == id)
    conv_res = await session.execute(conv_stmt)
    conv = conv_res.scalar_one_or_none()

    if conv is None or current_user.user_id not in (conv.user_a_id, conv.user_b_id):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="conversation_not_found",
        )

    # 2. Keyset pagination filter
    stmt = select(Message).where(Message.conversation_id == id)

    if before is not None:
        try:
            cursor_uuid = uuid.UUID(before.strip())
        except (ValueError, AttributeError) as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="invalid_cursor",
            ) from exc

        ref_msg = await session.scalar(
            select(Message).where(
                Message.id == cursor_uuid,
                Message.conversation_id == id,
            )
        )
        if ref_msg is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="invalid_cursor",
            )

        stmt = stmt.where(
            or_(
                Message.created_at < ref_msg.created_at,
                and_(
                    Message.created_at == ref_msg.created_at,
                    Message.id < ref_msg.id,
                ),
            )
        )

    stmt = stmt.order_by(Message.created_at.desc(), Message.id.desc()).limit(limit)
    msg_res = await session.execute(stmt)
    messages = list(msg_res.scalars().all())

    # 3. Fetch all versions for the entire page in a single query
    if messages:
        message_ids = [m.id for m in messages]
        ver_stmt = (
            select(MessageVersion)
            .where(MessageVersion.message_id.in_(message_ids))
            .order_by(MessageVersion.message_id, MessageVersion.version_no.asc())
        )
        ver_res = await session.execute(ver_stmt)
        versions_list = list(ver_res.scalars().all())

        versions_by_msg: dict[uuid.UUID, list[MessageVersionResponse]] = {
            m.id: [] for m in messages
        }
        for v in versions_list:
            if v.erased_at is not None or not v.ciphertext:
                b64_ciphertext = ""
            else:
                b64_ciphertext = base64.b64encode(v.ciphertext).decode("ascii")

            versions_by_msg[v.message_id].append(
                MessageVersionResponse(
                    id=v.id,
                    message_id=v.message_id,
                    version_no=v.version_no,
                    ctype=v.ctype,
                    ciphertext=b64_ciphertext,
                    action=v.action,
                    actor_id=v.actor_id,
                    created_at=v.created_at,
                    erased_at=v.erased_at,
                )
            )
    else:
        versions_by_msg = {}

    return [
        MessageResponse(
            id=m.id,
            conversation_id=m.conversation_id,
            sender_id=m.sender_id,
            client_msg_id=m.client_msg_id,
            current_version=m.current_version,
            status=m.status,
            created_at=m.created_at,
            delivered_at=m.delivered_at,
            read_at=m.read_at,
            versions=versions_by_msg.get(m.id, []),
        )
        for m in messages
    ]
