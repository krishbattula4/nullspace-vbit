import type { ServerMessageFrame, ServerEditFrame } from "../lib/protocol";

export type TimestampStyle = "iso-z" | "iso-offset" | "naive";

export interface StoredHistoryVersion {
  id: string;
  message_id: string;
  version_no: number;
  ctype: 1 | 3;
  ciphertext: string;
  action: "CREATE" | "EDIT" | "DELETE" | "RETRACT";
  actor_id: string;
  created_at: string;
  erased_at: string | null;
}

export interface StoredHistoryMessage {
  id: string;
  conversation_id: string;
  sender_id: string;
  client_msg_id: string | null;
  status: "SENT" | "QUEUED" | "DELIVERED";
  current_version: number;
  created_at: string;
  delivered_at: string | null;
  read_at: string | null;
  versions: StoredHistoryVersion[];
}

export class FakeHistoryServer {
  public messages = new Map<string, StoredHistoryMessage>();
  public requestLog: string[] = [];
  public timestampStyle: TimestampStyle = "iso-z";

  // Failure simulation switches
  public failNetwork = false;
  public failHttp500 = false;
  public failInvalidJson = false;
  public failMalformedPage = false;

  private formatTimestamp(isoStr: string | null): string | null {
    if (!isoStr) return null;
    const d = new Date(isoStr);
    const zStr = d.toISOString(); // e.g. 2026-11-19T10:05:00.000Z
    switch (this.timestampStyle) {
      case "iso-z":
        return zStr;
      case "iso-offset":
        return zStr.replace("Z", "+00:00");
      case "naive":
        return zStr.replace("Z", "").replace(".000", "");
      default:
        return zStr;
    }
  }

  addMessageFromFrame(
    frame: ServerMessageFrame,
    senderId: string,
    conversationId: string,
    clientMsgId?: string | null,
  ): void {
    const versionId = crypto.randomUUID();
    const version: StoredHistoryVersion = {
      id: versionId,
      message_id: frame.message_id,
      version_no: 1,
      ctype: frame.ctype,
      ciphertext: frame.body,
      action: "CREATE",
      actor_id: senderId,
      created_at: frame.created_at,
      erased_at: null,
    };

    const msg: StoredHistoryMessage = {
      id: frame.message_id,
      conversation_id: conversationId,
      sender_id: senderId,
      client_msg_id: clientMsgId ?? null,
      status: "SENT",
      current_version: 1,
      created_at: frame.created_at,
      delivered_at: null,
      read_at: null,
      versions: [version],
    };

    this.messages.set(frame.message_id, msg);
  }

  addEditFromFrame(frame: ServerEditFrame, senderId: string): void {
    const msg = this.messages.get(frame.message_id);
    if (!msg) return;

    const version: StoredHistoryVersion = {
      id: crypto.randomUUID(),
      message_id: frame.message_id,
      version_no: frame.version_no,
      ctype: frame.ctype,
      ciphertext: frame.body,
      action: "EDIT",
      actor_id: senderId,
      created_at: frame.edited_at,
      erased_at: null,
    };

    msg.versions.push(version);
    msg.current_version = Math.max(msg.current_version, frame.version_no);
    msg.versions.sort((a, b) => a.version_no - b.version_no);
  }

  deleteMessage(id: string, actorId: string, deletedAt?: string): void {
    const msg = this.messages.get(id);
    if (!msg) return;

    const at = deletedAt ?? new Date().toISOString();
    for (const v of msg.versions) {
      v.ciphertext = "";
      v.erased_at = at;
    }

    const delVersion: StoredHistoryVersion = {
      id: crypto.randomUUID(),
      message_id: id,
      version_no: msg.current_version + 1,
      ctype: 1,
      ciphertext: "",
      action: "DELETE",
      actor_id: actorId,
      created_at: at,
      erased_at: at,
    };

    msg.versions.push(delVersion);
    msg.current_version++;
    msg.versions.sort((a, b) => a.version_no - b.version_no);
  }

  retractMessage(id: string, actorId: string, retractedAt?: string): void {
    const msg = this.messages.get(id);
    if (!msg) return;

    const at = retractedAt ?? new Date().toISOString();
    const retVersion: StoredHistoryVersion = {
      id: crypto.randomUUID(),
      message_id: id,
      version_no: msg.current_version + 1,
      ctype: 1,
      ciphertext: "",
      action: "RETRACT",
      actor_id: actorId,
      created_at: at,
      erased_at: null,
    };

    msg.versions.push(retVersion);
    msg.current_version++;
    msg.versions.sort((a, b) => a.version_no - b.version_no);
  }

  markDelivered(id: string, deliveredAt?: string): void {
    const msg = this.messages.get(id);
    if (!msg) return;
    msg.delivered_at = deliveredAt ?? new Date().toISOString();
    if (msg.status === "SENT" || msg.status === "QUEUED") {
      msg.status = "DELIVERED";
    }
  }

  markRead(id: string, readAt?: string): void {
    const msg = this.messages.get(id);
    if (!msg) return;
    const at = readAt ?? new Date().toISOString();
    msg.read_at = at;
    if (!msg.delivered_at) {
      msg.delivered_at = at;
    }
    msg.status = "DELIVERED";
  }

  authFetch: (path: string, init?: RequestInit) => Promise<Response> = async (
    path: string,
  ): Promise<Response> => {
    this.requestLog.push(path);

    if (this.failNetwork) {
      throw new Error("Network error: connection refused");
    }
    if (this.failHttp500) {
      return new Response("Internal Server Error", { status: 500 });
    }
    if (this.failInvalidJson) {
      return new Response("INVALID_JSON_BODY {", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (this.failMalformedPage) {
      return new Response(JSON.stringify([{ invalid: "structure" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Path pattern: /conversations/{id}/messages?limit=...&before=...
    const url = new URL(path, "http://localhost");
    const match = /^\/conversations\/([^/]+)\/messages$/.exec(url.pathname);
    if (!match) {
      return new Response("Not Found", { status: 404 });
    }

    const conversationId = match[1];
    const limitParam = url.searchParams.get("limit");
    const beforeParam = url.searchParams.get("before");

    let limit = 50;
    if (limitParam) {
      const parsedLimit = parseInt(limitParam, 10);
      if (!isNaN(parsedLimit) && parsedLimit > 0) {
        limit = parsedLimit;
      }
    }

    // Filter messages by conversation and sort newest first (created_at DESC, id DESC)
    const convMessages = Array.from(this.messages.values())
      .filter((m) => m.conversation_id === conversationId)
      .sort((a, b) => {
        const timeCmp = b.created_at.localeCompare(a.created_at);
        if (timeCmp !== 0) return timeCmp;
        return b.id.localeCompare(a.id);
      });

    let startIndex = 0;
    if (beforeParam) {
      const cursorIndex = convMessages.findIndex((m) => m.id === beforeParam);
      if (cursorIndex === -1) {
        return new Response(
          JSON.stringify({ detail: "Cursor message not found in conversation" }),
          { status: 422, headers: { "Content-Type": "application/json" } },
        );
      }
      startIndex = cursorIndex + 1;
    }

    const paged = convMessages.slice(startIndex, startIndex + limit);

    // Format output with configured timestamp style
    const payload = paged.map((m) => ({
      id: m.id,
      conversation_id: m.conversation_id,
      sender_id: m.sender_id,
      client_msg_id: m.client_msg_id,
      status: m.status,
      current_version: m.current_version,
      created_at: this.formatTimestamp(m.created_at)!,
      delivered_at: this.formatTimestamp(m.delivered_at),
      read_at: this.formatTimestamp(m.read_at),
      versions: m.versions.map((v) => ({
        id: v.id,
        message_id: v.message_id,
        version_no: v.version_no,
        ctype: v.ctype,
        ciphertext: v.ciphertext,
        action: v.action,
        actor_id: v.actor_id,
        created_at: this.formatTimestamp(v.created_at)!,
        erased_at: this.formatTimestamp(v.erased_at),
      })),
    }));

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}
