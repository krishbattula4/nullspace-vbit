import type { SessionManager } from "./session";
import type { MessageStore, MessageRecord } from "../store/messageStore";
import {
  type ClientFrame,
  type ServerFrame,
  messageFrame,
} from "../lib/protocol";
import {
  encodeMessagePayload,
  decodeMessagePayload,
  type MessagePayload,
} from "./messagePayload";

export type SecureMessengerEvent = "message" | "update" | "decryptFailed";

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

  on(event: SecureMessengerEvent, handler: SecureMessengerEventHandler): () => void {
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

  async onServerFrame(frame: ServerFrame): Promise<void> {
    switch (frame.type) {
      case "MESSAGE": {
        await this.withPeerLock(frame.sender_id, async () => {
          // (1) if messages already has version 1 for frame.message_id, ignore it and do NOT call decrypt
          const versions = await this.messages.getVersions(frame.message_id);
          if (versions.some((v) => v.versionNo === 1)) {
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
          } catch (err) {
            // Decryption or payload decoding failed. Never overwrite a message that was stored
            // successfully in the meantime (for example by another tab).
            const alreadyStored = await this.messages.getVersions(frame.message_id);
            if (alreadyStored.some((v) => v.versionNo === 1)) {
              return;
            }
            const failedRecord: MessageRecord = {
              id: frame.message_id,
              conversationId: frame.conversation_id,
              senderId: frame.sender_id,
              createdAt: frame.created_at,
              status: "DELIVERED",
              currentVersion: 1,
              decryptFailed: true,
            };
            await this.messages.putMessage(failedRecord);
            await this.messages.markDecryptFailed(frame.message_id, true);
            this.emit("decryptFailed", {
              messageId: frame.message_id,
              conversationId: frame.conversation_id,
              senderId: frame.sender_id,
              error: err,
            });
          }
        });
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
        }
        break;
      }

      default:
        // Every other frame type (DELIVERED, READ, EDIT, DELETE, RETRACT, TYPING, PRESENCE) is ignored
        break;
    }
  }
}
