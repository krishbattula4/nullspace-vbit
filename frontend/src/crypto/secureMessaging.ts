import type { SessionManager } from "./session";
import type {
  MessageStore,
  MessageRecord,
  MessageStatus,
  DecryptErrorCode,
} from "../store/messageStore";
import {
  type ClientFrame,
  type ServerFrame,
  messageFrame,
  editFrame,
  deleteFrame,
  retractFrame,
} from "../lib/protocol";
import {
  encodeMessagePayload,
  decodeMessagePayload,
  type MessagePayload,
  MessagePayloadError,
} from "./messagePayload";
import { classifyDecryptError } from "./decryptErrors";

export type MessageActionErrorCode =
  | "not_found"
  | "not_sender"
  | "not_confirmed"
  | "deleted"
  | "retracted"
  | "not_text"
  | "empty"
  | "unchanged"
  | "already_read"
  | "not_read";

export class MessageActionError extends Error {
  readonly code: MessageActionErrorCode;

  constructor(code: MessageActionErrorCode, message?: string) {
    super(message ?? code);
    this.name = "MessageActionError";
    this.code = code;
    Object.setPrototypeOf(this, MessageActionError.prototype);
  }
}

export type SecureMessengerEvent =
  | "message"
  | "update"
  | "decryptFailed"
  | "orphanEvent"
  | "protocolError";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- event data carries varying payload structures
export type SecureMessengerEventHandler = (data?: any) => void | Promise<void>;

export interface SecureMessengerOptions {
  userId: string;
  sessions: Pick<SessionManager, "encrypt" | "decrypt">;
  messages: MessageStore;
  send: (frame: ClientFrame) => void | Promise<void>;
  now?: () => Date;
  newId?: () => string;
}

export class SecureMessenger {
  readonly userId: string;
  private sessions: Pick<SessionManager, "encrypt" | "decrypt">;
  private messages: MessageStore;
  private send: (frame: ClientFrame) => void | Promise<void>;
  private now: () => Date;
  private newId: () => string;

  private peerLocks = new Map<string, Promise<void>>();
  private listeners = new Map<SecureMessengerEvent, Set<SecureMessengerEventHandler>>();

  constructor(options: SecureMessengerOptions) {
    this.userId = options.userId;
    this.sessions = options.sessions;
    this.messages = options.messages;
    this.send = options.send;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  on(
    event: "message",
    handler: (data: MessageRecord & { payload?: MessagePayload }) => void | Promise<void>,
  ): () => void;
  on(
    event: "update",
    handler: (data: {
      messageId?: string;
      clientMsgId?: string;
      versionNo?: number;
      deleted?: boolean;
      retracted?: boolean;
      status?: MessageStatus;
      code?: string;
      detail?: string;
    }) => void | Promise<void>,
  ): () => void;
  on(
    event: "decryptFailed",
    handler: (data: {
      messageId: string;
      conversationId?: string;
      senderId?: string;
      kind?: "MESSAGE" | "EDIT";
      versionNo?: number;
      code: DecryptErrorCode;
      error?: unknown;
    }) => void | Promise<void>,
  ): () => void;
  on(
    event: "orphanEvent",
    handler: (data: {
      kind: "EDIT" | "DELETE" | "RETRACT";
      messageId: string;
    }) => void | Promise<void>,
  ): () => void;
  on(
    event: "protocolError",
    handler: (data: { code: string; detail?: string }) => void | Promise<void>,
  ): () => void;
  on(
    event: SecureMessengerEvent,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- overloaded event signatures
    handler: (data?: any) => void | Promise<void>,
  ): () => void;
  on(
    event: SecureMessengerEvent,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- overloaded event signatures
    handler: (data?: any) => void | Promise<void>,
  ): () => void {
    let handlers = this.listeners.get(event);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(event, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers?.delete(handler);
    };
  }

  private emit(event: SecureMessengerEvent, data?: unknown): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const handler of Array.from(handlers)) {
      try {
        const res = handler(data);
        if (res && typeof (res as Promise<void>).catch === "function") {
          (res as Promise<void>).catch(() => {});
        }
      } catch {
        // A throwing handler must not break the engine or other handlers
      }
    }
  }

  /**
   * Cross-tab exclusion: two tabs of the same account share one IndexedDB Signal store, and the
   * server delivers every message to every open tab. The Double Ratchet state is sequential, so the
   * work for one peer must also be serialised ACROSS tabs. The Web Locks API provides that when
   * the browser has it; otherwise the in-tab promise chain below is the only protection.
   */
  private runExclusive<T>(peerId: string, fn: () => Promise<T>): Promise<T> {
    if (typeof navigator !== "undefined" && navigator.locks && typeof navigator.locks.request === "function") {
      return navigator.locks.request(`nullspace-peer-${this.userId}-${peerId}`, fn);
    }
    return fn();
  }

  private async withPeerLock<T>(peerId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.peerLocks.get(peerId) ?? Promise.resolve();

    let executeTask: () => Promise<T>;
    const taskPromise = new Promise<T>((resolve, reject) => {
      executeTask = async () => {
        try {
          const result = await this.runExclusive(peerId, fn);
          resolve(result);
          return result;
        } catch (err) {
          reject(err);
          throw err;
        }
      };
    });

    const nextLock = previous
      .catch(() => {})
      .then(async () => {
        try {
          await executeTask();
        } catch {
          // Failure handled via taskPromise reject
        }
      });

    this.peerLocks.set(peerId, nextLock);

    nextLock.finally(() => {
      if (this.peerLocks.get(peerId) === nextLock) {
        this.peerLocks.delete(peerId);
      }
    });

    return taskPromise;
  }

  async sendText(
    conversationId: string,
    peerId: string,
    text: string,
  ): Promise<{ clientMsgId: string }> {
    return this.sendPayload(conversationId, peerId, { type: "TEXT", text });
  }

  async sendPayload(
    conversationId: string,
    peerId: string,
    payload: MessagePayload,
  ): Promise<{ clientMsgId: string }> {
    return this.withPeerLock(peerId, async () => {

      // a. clientMsgId = newId(); plaintext = encodeMessagePayload(payload)
      const clientMsgId = this.newId();
      const plaintext = encodeMessagePayload(payload);
      const createdAt = this.now().toISOString();

      // b. Save the outgoing message locally FIRST: messages.putMessage(...) and messages.addVersion(...)
      const outgoingMsg: MessageRecord = {
        id: clientMsgId,
        clientMsgId,
        conversationId,
        senderId: this.userId,
        createdAt,
        status: "SENDING",
        currentVersion: 1,
      };
      await this.messages.putMessage(outgoingMsg);
      await this.messages.addVersion({
        messageId: clientMsgId,
        versionNo: 1,
        plaintext,
        action: "CREATE",
        createdAt,
      });
      this.emit("message", outgoingMsg);

      // c. envelope = await sessions.encrypt(peerId, plaintext). If it throws, mark FAILED, emit "update", and rethrow
      let envelope: { type: 1 | 3; body: string };
      try {
        envelope = await this.sessions.encrypt(peerId, plaintext);
      } catch (err) {
        await this.messages.setStatus(clientMsgId, "FAILED");
        this.emit("update", { clientMsgId, status: "FAILED" });
        throw err;
      }

      // d. send(messageFrame(conversationId, clientMsgId, envelope.type, envelope.body))
      const frame = messageFrame(conversationId, clientMsgId, envelope.type, envelope.body);
      try {
        await this.send(frame);
      } catch (err) {
        // The frame never left (for example the socket is closed): do not leave the bubble
        // in SENDING forever. The ciphertext is discarded; a retry encrypts again.
        await this.messages.setStatus(clientMsgId, "FAILED");
        this.emit("update", { clientMsgId, status: "FAILED" });
        throw err;
      }

      return { clientMsgId };
    });
  }

  async canEdit(
    messageId: string,
  ): Promise<{ allowed: true } | { allowed: false; reason: MessageActionErrorCode }> {
    const msg = await this.messages.getMessage(messageId);
    if (!msg) {
      return { allowed: false, reason: "not_found" };
    }
    if (msg.senderId !== this.userId) {
      return { allowed: false, reason: "not_sender" };
    }
    if (msg.status === "SENDING" || msg.status === "FAILED") {
      return { allowed: false, reason: "not_confirmed" };
    }
    if (msg.deletedAt) {
      return { allowed: false, reason: "deleted" };
    }
    if (msg.retractedAt) {
      return { allowed: false, reason: "retracted" };
    }

    const versions = await this.messages.getVersions(messageId);
    const latest = versions[versions.length - 1];
    if (!latest || !latest.plaintext) {
      return { allowed: false, reason: "not_text" };
    }
    try {
      const payload = decodeMessagePayload(latest.plaintext);
      if (payload.type !== "TEXT") {
        return { allowed: false, reason: "not_text" };
      }
    } catch {
      return { allowed: false, reason: "not_text" };
    }

    return { allowed: true };
  }

  async canDelete(
    messageId: string,
  ): Promise<{ allowed: true } | { allowed: false; reason: MessageActionErrorCode }> {
    const msg = await this.messages.getMessage(messageId);
    if (!msg) {
      return { allowed: false, reason: "not_found" };
    }
    if (msg.senderId !== this.userId) {
      return { allowed: false, reason: "not_sender" };
    }
    if (msg.status === "SENDING" || msg.status === "FAILED") {
      return { allowed: false, reason: "not_confirmed" };
    }
    if (msg.deletedAt) {
      return { allowed: false, reason: "deleted" };
    }
    if (msg.retractedAt) {
      return { allowed: false, reason: "retracted" };
    }
    if (msg.status === "READ") {
      return { allowed: false, reason: "already_read" };
    }

    return { allowed: true };
  }

  async canRetract(
    messageId: string,
  ): Promise<{ allowed: true } | { allowed: false; reason: MessageActionErrorCode }> {
    const msg = await this.messages.getMessage(messageId);
    if (!msg) {
      return { allowed: false, reason: "not_found" };
    }
    if (msg.senderId !== this.userId) {
      return { allowed: false, reason: "not_sender" };
    }
    if (msg.status === "SENDING" || msg.status === "FAILED") {
      return { allowed: false, reason: "not_confirmed" };
    }
    if (msg.deletedAt) {
      return { allowed: false, reason: "deleted" };
    }
    if (msg.retractedAt) {
      return { allowed: false, reason: "retracted" };
    }
    if (msg.status !== "READ") {
      return { allowed: false, reason: "not_read" };
    }

    return { allowed: true };
  }

  async sendEdit(
    // Kept for a symmetric API with sendText; the EDIT frame itself carries only the message id.
    _conversationId: string,
    peerId: string,
    messageId: string,
    newText: string,
  ): Promise<{ versionNo: number }> {
    return this.withPeerLock(peerId, async () => {

      const can = await this.canEdit(messageId);
      if (!can.allowed) {
        throw new MessageActionError(can.reason);
      }

      if (typeof newText !== "string" || newText.trim().length === 0) {
        throw new MessageActionError("empty");
      }

      // Check unchanged against latest version
      const versions = await this.messages.getVersions(messageId);
      const latest = versions[versions.length - 1];
      if (latest && latest.plaintext) {
        try {
          const currentPayload = decodeMessagePayload(latest.plaintext);
          if (currentPayload.type === "TEXT" && currentPayload.text === newText) {
            throw new MessageActionError("unchanged");
          }
        } catch (err) {
          if (err instanceof MessageActionError) throw err;
        }
      }

      // If over MAX_TEXT_CHARS, let MessagePayloadError propagate
      const plaintext = encodeMessagePayload({ type: "TEXT", text: newText });

      // Encrypt with sessions.encrypt(peerId, plaintext) (IdentityChangedError propagates untouched)
      const envelope = await this.sessions.encrypt(peerId, plaintext);

      // Send edit frame over wire
      const frame = editFrame(messageId, envelope.type, envelope.body);
      await this.send(frame);

      // ONLY if send did not throw, add the new version locally
      const currentVersions = await this.messages.getVersions(messageId);
      const maxVer = currentVersions.reduce((max, v) => Math.max(max, v.versionNo), 0);
      const versionNo = maxVer + 1;
      const createdAt = this.now().toISOString();

      await this.messages.addVersion({
        messageId,
        versionNo,
        plaintext,
        action: "EDIT",
        createdAt,
      });

      this.emit("update", { messageId, versionNo });
      return { versionNo };
    });
  }

  async sendDelete(peerId: string, messageId: string): Promise<void> {
    return this.withPeerLock(peerId, async () => {
      const can = await this.canDelete(messageId);
      if (!can.allowed) {
        throw new MessageActionError(can.reason);
      }
      await this.send(deleteFrame(messageId));
    });
  }

  async sendRetract(peerId: string, messageId: string): Promise<void> {
    return this.withPeerLock(peerId, async () => {
      const can = await this.canRetract(messageId);
      if (!can.allowed) {
        throw new MessageActionError(can.reason);
      }
      await this.send(retractFrame(messageId));
    });
  }

  private async autoRetryFailedEnvelopes(senderId: string): Promise<void> {
    try {
      const envelopes = await this.messages.listFailedEnvelopes({ senderId });
      const eligible = envelopes.filter(
        (env) =>
          (env.lastErrorCode === "unknown" || env.lastErrorCode === "storage") &&
          env.attempts < 3,
      );
      const toRetry = eligible.slice(0, 20);

      for (const envelope of toRetry) {
        // If version 1 already exists, clean up and skip
        const versions = await this.messages.getVersions(envelope.messageId);
        if (versions.some((v) => v.versionNo === 1)) {
          await this.messages.deleteFailedEnvelope(envelope.messageId);
          await this.messages.markDecryptFailed(envelope.messageId, false);
          continue;
        }

        try {
          const plaintext = await this.sessions.decrypt(envelope.senderId, {
            type: envelope.ctype,
            body: envelope.body,
          });
          const payload = decodeMessagePayload(plaintext);

          const receivedMsg: MessageRecord = {
            id: envelope.messageId,
            conversationId: envelope.conversationId,
            senderId: envelope.senderId,
            createdAt: envelope.receivedAt,
            status: "DELIVERED",
            currentVersion: 1,
          };
          await this.messages.putMessage(receivedMsg);
          await this.messages.addVersion({
            messageId: envelope.messageId,
            versionNo: 1,
            plaintext,
            action: "CREATE",
            createdAt: envelope.receivedAt,
          });
          await this.messages.deleteFailedEnvelope(envelope.messageId);
          await this.messages.markDecryptFailed(envelope.messageId, false);
          this.emit("message", { ...receivedMsg, payload });
        } catch (err) {
          const code = classifyDecryptError(err);
          await this.messages.incrementFailedAttempts(envelope.messageId, code);
          await this.messages.markDecryptFailed(envelope.messageId, true, code);
        }
      }
    } catch {
      // Auto-retry failures must never crash or throw
    }
  }

  async retryDecrypt(
    messageId: string,
  ): Promise<
    | { status: "ok" }
    | { status: "failed"; code: DecryptErrorCode }
    | { status: "not_found" }
  > {
    try {
      const initialEnvelope = await this.messages.getFailedEnvelope(messageId);
      if (!initialEnvelope) {
        const versions = await this.messages.getVersions(messageId);
        if (versions.some((v) => v.versionNo === 1)) {
          await this.messages.markDecryptFailed(messageId, false);
          return { status: "ok" };
        }
        return { status: "not_found" };
      }

      return await this.withPeerLock(initialEnvelope.senderId, async () => {
        const envelope = await this.messages.getFailedEnvelope(messageId);
        if (!envelope) {
          const versions = await this.messages.getVersions(messageId);
          if (versions.some((v) => v.versionNo === 1)) {
            await this.messages.markDecryptFailed(messageId, false);
            return { status: "ok" };
          }
          return { status: "not_found" };
        }

        // If a version 1 already exists (decrypted meanwhile) delete envelope, clear flag, return ok
        const versions = await this.messages.getVersions(messageId);
        if (versions.some((v) => v.versionNo === 1)) {
          await this.messages.deleteFailedEnvelope(messageId);
          await this.messages.markDecryptFailed(messageId, false);
          return { status: "ok" };
        }

        try {
          const plaintext = await this.sessions.decrypt(envelope.senderId, {
            type: envelope.ctype,
            body: envelope.body,
          });
          const payload = decodeMessagePayload(plaintext);

          const receivedMsg: MessageRecord = {
            id: envelope.messageId,
            conversationId: envelope.conversationId,
            senderId: envelope.senderId,
            createdAt: envelope.receivedAt,
            status: "DELIVERED",
            currentVersion: 1,
          };
          await this.messages.putMessage(receivedMsg);
          await this.messages.addVersion({
            messageId: envelope.messageId,
            versionNo: 1,
            plaintext,
            action: "CREATE",
            createdAt: envelope.receivedAt,
          });
          await this.messages.deleteFailedEnvelope(messageId);
          await this.messages.markDecryptFailed(messageId, false);
          this.emit("message", { ...receivedMsg, payload });

          // Auto-retry eligible failed envelopes for this sender
          await this.autoRetryFailedEnvelopes(envelope.senderId);

          return { status: "ok" };
        } catch (err) {
          const code = classifyDecryptError(err);
          await this.messages.incrementFailedAttempts(messageId, code);
          await this.messages.markDecryptFailed(messageId, true, code);
          return { status: "failed", code };
        }
      });
    } catch {
      return { status: "failed", code: "storage" };
    }
  }

  async listFailed(conversationId: string): Promise<MessageRecord[]> {
    const envelopes = await this.messages.listFailedEnvelopes({ conversationId });
    const records: MessageRecord[] = [];
    const seenIds = new Set<string>();

    for (const env of envelopes) {
      const msg = await this.messages.getMessage(env.messageId);
      if (msg && msg.decryptFailed) {
        records.push(msg);
        seenIds.add(msg.id);
      }
    }

    const allConvMessages = await this.messages.listMessages(conversationId, { limit: 1000 });
    for (const msg of allConvMessages) {
      if (msg.decryptFailed && !seenIds.has(msg.id)) {
        records.push(msg);
        seenIds.add(msg.id);
      }
    }

    records.sort((a, b) => {
      if (a.createdAt !== b.createdAt) {
        return a.createdAt.localeCompare(b.createdAt);
      }
      return a.id.localeCompare(b.id);
    });

    return records;
  }

  async onServerFrame(frame: ServerFrame): Promise<void> {
    switch (frame.type) {
      case "MESSAGE": {
        try {
          await this.withPeerLock(frame.sender_id, async () => {

            // (1) if messages already has version 1 for frame.message_id, ignore it and do NOT call decrypt
            const versions = await this.messages.getVersions(frame.message_id);
            if (versions.some((v) => v.versionNo === 1)) {
              return;
            }

            // If a failed envelope already exists for that message id (a replay of a failed frame)
            // do not reset its attempts; ignore the replay.
            const existingEnv = await this.messages.getFailedEnvelope(frame.message_id);
            if (existingEnv) {
              return;
            }

            const existingMsg = await this.messages.getMessage(frame.message_id);
            if (existingMsg?.decryptFailed) {
              return;
            }

            // (2) decrypt; (3) decode; (4) store; (5) emit
            try {
              const plaintext = await this.sessions.decrypt(frame.sender_id, {
                type: frame.ctype,
                body: frame.body,
              });
              const payload = decodeMessagePayload(plaintext);

              const receivedMsg: MessageRecord = {
                id: frame.message_id,
                conversationId: frame.conversation_id,
                senderId: frame.sender_id,
                createdAt: frame.created_at,
                status: "DELIVERED",
                currentVersion: 1,
              };
              await this.messages.putMessage(receivedMsg);
              await this.messages.addVersion({
                messageId: frame.message_id,
                versionNo: 1,
                plaintext,
                action: "CREATE",
                createdAt: frame.created_at,
              });
              this.emit("message", { ...receivedMsg, payload });

              // Auto-retry eligible failed envelopes for this sender
              await this.autoRetryFailedEnvelopes(frame.sender_id);
            } catch (err) {
              try {
                // Decryption or payload decoding failed. Never overwrite a message that was stored
                // successfully in the meantime (for example by another tab).
                const alreadyStored = await this.messages.getVersions(frame.message_id);
                if (alreadyStored.some((v) => v.versionNo === 1)) {
                  return;
                }

                // Check again if a failed envelope already exists
                const envCheck = await this.messages.getFailedEnvelope(frame.message_id);
                if (envCheck) {
                  return;
                }

                const code = classifyDecryptError(err);

                // Store the ciphertext with saveFailedEnvelope (attempts 1) BEFORE anything else
                await this.messages.saveFailedEnvelope({
                  messageId: frame.message_id,
                  conversationId: frame.conversation_id,
                  senderId: frame.sender_id,
                  ctype: frame.ctype,
                  body: frame.body,
                  receivedAt: frame.created_at,
                  attempts: 1,
                  lastErrorCode: code,
                });

                const failedRecord: MessageRecord = {
                  id: frame.message_id,
                  conversationId: frame.conversation_id,
                  senderId: frame.sender_id,
                  createdAt: frame.created_at,
                  status: "DELIVERED",
                  currentVersion: 1,
                  decryptFailed: true,
                  decryptErrorCode: code,
                };
                await this.messages.putMessage(failedRecord);
                await this.messages.markDecryptFailed(frame.message_id, true, code);

                this.emit("decryptFailed", {
                  messageId: frame.message_id,
                  conversationId: frame.conversation_id,
                  senderId: frame.sender_id,
                  code,
                  error: err,
                });
              } catch (storageErr) {
                // Saving the failure record itself failed (swallow and emit "decryptFailed" with code "storage")
                this.emit("decryptFailed", {
                  messageId: frame.message_id,
                  conversationId: frame.conversation_id,
                  senderId: frame.sender_id,
                  code: "storage",
                  error: storageErr,
                });
              }
            }
          });
        } catch (outerErr) {
          // withPeerLock or mutex wrapper failed: never throw for any MESSAGE frame
          this.emit("decryptFailed", {
            messageId: frame.message_id,
            conversationId: frame.conversation_id,
            senderId: frame.sender_id,
            code: "storage",
            error: outerErr,
          });
        }
        break;
      }

      case "EDIT": {
        try {
          const message = await this.messages.getMessage(frame.message_id);
          if (!message) {
            this.emit("orphanEvent", { kind: "EDIT", messageId: frame.message_id });
            break;
          }

          if (message.senderId === this.userId) {
            // Server misbehaviour: the server never sends the sender its own edit
            break;
          }

          await this.withPeerLock(message.senderId, async () => {
            const currentMsg = await this.messages.getMessage(frame.message_id);
            if (!currentMsg) {
              this.emit("orphanEvent", { kind: "EDIT", messageId: frame.message_id });
              return;
            }

            if (currentMsg.deletedAt || currentMsg.retractedAt) {
              return;
            }

            const versions = await this.messages.getVersions(frame.message_id);
            if (versions.some((v) => v.versionNo === frame.version_no)) {
              return;
            }

            try {
              const plaintext = await this.sessions.decrypt(currentMsg.senderId, {
                type: frame.ctype,
                body: frame.body,
              });
              const payload = decodeMessagePayload(plaintext);
              if (payload.type !== "TEXT") {
                throw new MessagePayloadError("EDIT payload must be TEXT");
              }

              await this.messages.addVersion({
                messageId: frame.message_id,
                versionNo: frame.version_no,
                plaintext,
                action: "EDIT",
                createdAt: frame.edited_at,
              });
              this.emit("update", {
                messageId: frame.message_id,
                versionNo: frame.version_no,
              });
            } catch (err) {
              const code = classifyDecryptError(err);
              this.emit("decryptFailed", {
                messageId: frame.message_id,
                kind: "EDIT",
                versionNo: frame.version_no,
                code,
                error: err,
              });
            }
          });
        } catch {
          // Never throw
        }
        break;
      }

      case "DELETE": {
        try {
          const message = await this.messages.getMessage(frame.message_id);
          if (!message) {
            this.emit("orphanEvent", { kind: "DELETE", messageId: frame.message_id });
            break;
          }

          const applyDelete = async () => {
            const currentMsg = await this.messages.getMessage(frame.message_id);
            if (!currentMsg) {
              this.emit("orphanEvent", { kind: "DELETE", messageId: frame.message_id });
              return;
            }
            if (currentMsg.retractedAt) {
              return;
            }

            await this.messages.markDeleted(frame.message_id, {
              at: this.now().toISOString(),
              by: currentMsg.senderId,
            });
            this.emit("update", { messageId: frame.message_id, deleted: true });
          };

          if (message.senderId !== this.userId) {
            await this.withPeerLock(message.senderId, applyDelete);
          } else {
            await applyDelete();
          }
        } catch {
          // Never throw
        }
        break;
      }

      case "RETRACT": {
        try {
          const message = await this.messages.getMessage(frame.message_id);
          if (!message) {
            this.emit("orphanEvent", { kind: "RETRACT", messageId: frame.message_id });
            break;
          }

          const applyRetract = async () => {
            const currentMsg = await this.messages.getMessage(frame.message_id);
            if (!currentMsg) {
              this.emit("orphanEvent", { kind: "RETRACT", messageId: frame.message_id });
              return;
            }
            if (currentMsg.deletedAt) {
              return;
            }

            await this.messages.markRetracted(frame.message_id, {
              at: this.now().toISOString(),
              by: currentMsg.senderId,
            });
            this.emit("update", { messageId: frame.message_id, retracted: true });
          };

          if (message.senderId !== this.userId) {
            await this.withPeerLock(message.senderId, applyRetract);
          } else {
            await applyRetract();
          }
        } catch {
          // Never throw
        }
        break;
      }

      case "DELIVERED": {
        try {
          const newStatus = await this.messages.setStatus(frame.message_id, "DELIVERED");
          if (newStatus) {
            this.emit("update", { messageId: frame.message_id, status: newStatus });
          }
        } catch {
          // Never throw
        }
        break;
      }

      case "READ": {
        try {
          const newStatus = await this.messages.setStatus(frame.message_id, "READ");
          if (newStatus) {
            this.emit("update", { messageId: frame.message_id, status: newStatus });
          }
        } catch {
          // Never throw
        }
        break;
      }

      case "ACK": {
        await this.messages.confirmSent(frame.client_msg_id, {
          messageId: frame.message_id,
          status: frame.status,
        });
        this.emit("update", {
          clientMsgId: frame.client_msg_id,
          messageId: frame.message_id,
          status: frame.status,
        });
        break;
      }

      case "ERROR": {
        if (frame.client_msg_id) {
          await this.messages.setStatus(frame.client_msg_id, "FAILED");
          this.emit("update", {
            clientMsgId: frame.client_msg_id,
            status: "FAILED",
            code: frame.code,
            detail: frame.detail,
          });
        } else {
          this.emit("protocolError", {
            code: frame.code,
            detail: frame.detail,
          });
        }
        break;
      }

      default:
        // Every other frame type (TYPING, PRESENCE) is ignored
        break;
    }
  }
}
