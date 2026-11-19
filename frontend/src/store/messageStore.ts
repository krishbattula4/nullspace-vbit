import { openDB, deleteDB, type DBSchema, type IDBPDatabase } from "idb";

export type MessageStatus =
  | "SENDING"
  | "SENT"
  | "QUEUED"
  | "DELIVERED"
  | "READ"
  | "FAILED";

export type VersionAction = "CREATE" | "EDIT";

export interface MessageRecord {
  id: string;
  conversationId: string;
  senderId: string;
  clientMsgId?: string;
  createdAt: string; // ISO 8601 UTC
  status: MessageStatus;
  currentVersion: number;
  deletedAt?: string;
  deletedBy?: string;
  retractedAt?: string;
  retractedBy?: string;
  decryptFailed?: boolean;
}

export interface VersionRecord {
  messageId: string;
  versionNo: number;
  plaintext: string;
  action: VersionAction;
  createdAt: string;
}

export interface ConversationMetaRecord {
  conversationId: string;
  oldest: { createdAt: string; id: string } | null;
  historyComplete: boolean;
}

export interface MessageDBSchema extends DBSchema {
  messages: {
    key: string;
    value: MessageRecord;
    indexes: {
      byConversationTime: [string, string, string];
      byClientMsgId: string;
    };
  };
  versions: {
    key: [string, number];
    value: VersionRecord;
    indexes: {
      byMessage: string;
    };
  };
  meta: {
    key: string;
    value: ConversationMetaRecord;
  };
}

const STATUS_RANK: Record<MessageStatus, number> = {
  SENDING: 0,
  SENT: 1,
  QUEUED: 2,
  DELIVERED: 3,
  READ: 4,
  FAILED: -1,
};

export class MessageStore {
  private static readonly activeConnections = new Map<
    string,
    Set<IDBPDatabase<MessageDBSchema>>
  >();

  readonly userId: string;
  readonly dbName: string;
  private db: IDBPDatabase<MessageDBSchema> | null = null;

  constructor(userId: string) {
    this.userId = userId;
    this.dbName = `nullspace-messages-${userId}`;
  }

  private async getDb(): Promise<IDBPDatabase<MessageDBSchema>> {
    if (this.db) {
      return this.db;
    }

    const dbName = this.dbName;
    const db = await openDB<MessageDBSchema>(dbName, 1, {
      upgrade(database) {
        if (!database.objectStoreNames.contains("messages")) {
          const msgStore = database.createObjectStore("messages", {
            keyPath: "id",
          });
          msgStore.createIndex("byConversationTime", [
            "conversationId",
            "createdAt",
            "id",
          ]);
          msgStore.createIndex("byClientMsgId", "clientMsgId", {
            unique: true,
          });
        }
        if (!database.objectStoreNames.contains("versions")) {
          const verStore = database.createObjectStore("versions", {
            keyPath: ["messageId", "versionNo"],
          });
          verStore.createIndex("byMessage", "messageId");
        }
        if (!database.objectStoreNames.contains("meta")) {
          database.createObjectStore("meta", {
            keyPath: "conversationId",
          });
        }
      },
      blocking() {
        db.close();
      },
    });

    let set = MessageStore.activeConnections.get(dbName);
    if (!set) {
      set = new Set();
      MessageStore.activeConnections.set(dbName, set);
    }
    set.add(db);

    this.db = db;
    return this.db;
  }

  close(): void {
    if (this.db) {
      const set = MessageStore.activeConnections.get(this.dbName);
      if (set) {
        set.delete(this.db);
      }
      this.db.close();
      this.db = null;
    }
  }

  async wipe(): Promise<void> {
    const set = MessageStore.activeConnections.get(this.dbName);
    if (set) {
      for (const conn of set) {
        conn.close();
      }
      set.clear();
      MessageStore.activeConnections.delete(this.dbName);
    }
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    await deleteDB(this.dbName);
  }

  async putMessage(msg: MessageRecord): Promise<void> {
    const db = await this.getDb();
    await db.put("messages", msg);
  }

  async getMessage(id: string): Promise<MessageRecord | undefined> {
    const db = await this.getDb();
    return db.get("messages", id);
  }

  async addVersion(v: VersionRecord): Promise<boolean> {
    const db = await this.getDb();
    const tx = db.transaction(["versions", "messages"], "readwrite");
    const verStore = tx.objectStore("versions");
    const existing = await verStore.get([v.messageId, v.versionNo]);
    if (existing) {
      await tx.done;
      return false;
    }

    const msgStore = tx.objectStore("messages");
    const msg = await msgStore.get(v.messageId);

    // A deleted message must never get its text back: a version that arrives late (out of
    // order) for a message already deleted on this device is stored with empty plaintext.
    await verStore.add(msg?.deletedAt ? { ...v, plaintext: "" } : v);

    if (msg) {
      if (msg.currentVersion === undefined || v.versionNo > msg.currentVersion) {
        msg.currentVersion = v.versionNo;
        await msgStore.put(msg);
      }
    }

    await tx.done;
    return true;
  }

  async getVersions(messageId: string): Promise<VersionRecord[]> {
    const db = await this.getDb();
    const list = await db.getAllFromIndex("versions", "byMessage", messageId);
    return list.sort((a, b) => a.versionNo - b.versionNo);
  }

  async listMessages(
    conversationId: string,
    options?: {
      before?: { createdAt: string; id: string };
      limit?: number;
    },
  ): Promise<MessageRecord[]> {
    const limit = options?.limit ?? 50;
    if (limit <= 0) return [];

    const db = await this.getDb();
    const tx = db.transaction("messages", "readonly");
    const index = tx.store.index("byConversationTime");

    const range = options?.before
      ? IDBKeyRange.bound(
          [conversationId],
          [conversationId, options.before.createdAt, options.before.id],
          false,
          true,
        )
      : IDBKeyRange.bound([conversationId], [conversationId, []]);

    const results: MessageRecord[] = [];
    let cursor = await index.openCursor(range, "prev");
    while (cursor && results.length < limit) {
      if (cursor.value.conversationId !== conversationId) {
        break;
      }
      results.push(cursor.value);
      cursor = await cursor.continue();
    }
    return results;
  }

  async getLatestMessage(
    conversationId: string,
  ): Promise<MessageRecord | undefined> {
    const db = await this.getDb();
    const tx = db.transaction("messages", "readonly");
    const index = tx.store.index("byConversationTime");
    const range = IDBKeyRange.bound([conversationId], [conversationId, []]);
    const cursor = await index.openCursor(range, "prev");
    if (cursor && cursor.value.conversationId === conversationId) {
      return cursor.value;
    }
    return undefined;
  }

  async countMessages(conversationId: string): Promise<number> {
    const db = await this.getDb();
    const range = IDBKeyRange.bound([conversationId], [conversationId, []]);
    return db.countFromIndex("messages", "byConversationTime", range);
  }

  async setStatus(
    id: string,
    status: MessageStatus,
  ): Promise<MessageStatus | undefined> {
    const db = await this.getDb();
    const tx = db.transaction("messages", "readwrite");
    const msg = await tx.store.get(id);
    if (!msg) {
      await tx.done;
      return undefined;
    }

    const current = msg.status;
    if (current === status) {
      await tx.done;
      return current;
    }

    let shouldUpdate = false;
    if (status === "FAILED") {
      shouldUpdate = current === "SENDING";
    } else if (current === "FAILED") {
      shouldUpdate = false;
    } else {
      const currentRank = STATUS_RANK[current];
      const newRank = STATUS_RANK[status];
      if (newRank > currentRank) {
        shouldUpdate = true;
      }
    }

    if (shouldUpdate) {
      msg.status = status;
      await tx.store.put(msg);
    }
    await tx.done;
    return msg.status;
  }

  async confirmSent(
    clientMsgId: string,
    confirmation: {
      messageId: string;
      status?: MessageStatus;
      createdAt?: string;
    },
  ): Promise<void> {
    const { messageId, status, createdAt } = confirmation;
    const db = await this.getDb();
    const tx = db.transaction(["messages", "versions"], "readwrite");
    const msgStore = tx.objectStore("messages");
    const verStore = tx.objectStore("versions");

    const tempMsg = await msgStore.get(clientMsgId);
    const existingRealMsg = await msgStore.get(messageId);

    if (!tempMsg) {
      if (existingRealMsg && status) {
        const currentRank = STATUS_RANK[existingRealMsg.status];
        const newRank = STATUS_RANK[status];
        if (newRank > currentRank) {
          existingRealMsg.status = status;
          await msgStore.put(existingRealMsg);
        }
      }
      await tx.done;
      return;
    }

    const tempVersions = await verStore.index("byMessage").getAll(clientMsgId);

    // Delete temporary message record FIRST to release the unique byClientMsgId index key
    await msgStore.delete(clientMsgId);

    if (existingRealMsg) {
      existingRealMsg.clientMsgId =
        existingRealMsg.clientMsgId ?? tempMsg.clientMsgId ?? clientMsgId;

      const currentRank = STATUS_RANK[existingRealMsg.status];
      const incomingStatus = status ?? tempMsg.status;
      const incomingRank = STATUS_RANK[incomingStatus];
      if (incomingRank > currentRank) {
        existingRealMsg.status = incomingStatus;
      }

      if (createdAt && !existingRealMsg.createdAt) {
        existingRealMsg.createdAt = createdAt;
      }
      existingRealMsg.currentVersion = Math.max(
        existingRealMsg.currentVersion ?? 0,
        tempMsg.currentVersion ?? 0,
      );
      if (tempMsg.deletedAt && !existingRealMsg.deletedAt) {
        existingRealMsg.deletedAt = tempMsg.deletedAt;
        existingRealMsg.deletedBy = tempMsg.deletedBy;
      }
      if (tempMsg.retractedAt && !existingRealMsg.retractedAt) {
        existingRealMsg.retractedAt = tempMsg.retractedAt;
        existingRealMsg.retractedBy = tempMsg.retractedBy;
      }
      if (
        tempMsg.decryptFailed !== undefined &&
        existingRealMsg.decryptFailed === undefined
      ) {
        existingRealMsg.decryptFailed = tempMsg.decryptFailed;
      }

      await msgStore.put(existingRealMsg);
    } else {
      const newMsg: MessageRecord = {
        ...tempMsg,
        id: messageId,
        clientMsgId: tempMsg.clientMsgId ?? clientMsgId,
        createdAt: createdAt ?? tempMsg.createdAt,
        status: status ?? tempMsg.status,
      };
      await msgStore.put(newMsg);
    }

    for (const v of tempVersions) {
      await verStore.delete([clientMsgId, v.versionNo]);
      const existingVersion = await verStore.get([messageId, v.versionNo]);
      if (!existingVersion) {
        await verStore.put({
          ...v,
          messageId,
        });
      }
    }

    await tx.done;
  }

  async markDeleted(
    id: string,
    details?: { at?: string; by?: string },
  ): Promise<void> {
    const db = await this.getDb();
    const tx = db.transaction(["messages", "versions"], "readwrite");
    const msgStore = tx.objectStore("messages");
    const verStore = tx.objectStore("versions");

    const msg = await msgStore.get(id);
    if (msg) {
      msg.deletedAt = details?.at ?? msg.deletedAt ?? new Date().toISOString();
      if (details?.by !== undefined) {
        msg.deletedBy = details.by;
      }
      await msgStore.put(msg);
    }

    const versions = await verStore.index("byMessage").getAll(id);
    for (const v of versions) {
      if (v.plaintext !== "") {
        v.plaintext = "";
        await verStore.put(v);
      }
    }

    await tx.done;
  }

  async markRetracted(
    id: string,
    details?: { at?: string; by?: string },
  ): Promise<void> {
    const db = await this.getDb();
    const tx = db.transaction("messages", "readwrite");
    const msg = await tx.store.get(id);
    if (msg) {
      msg.retractedAt =
        details?.at ?? msg.retractedAt ?? new Date().toISOString();
      if (details?.by !== undefined) {
        msg.retractedBy = details.by;
      }
      await tx.store.put(msg);
    }
    await tx.done;
  }

  async markDecryptFailed(id: string, failed: boolean): Promise<void> {
    const db = await this.getDb();
    const tx = db.transaction("messages", "readwrite");
    const msg = await tx.store.get(id);
    if (msg) {
      msg.decryptFailed = failed;
      await tx.store.put(msg);
    }
    await tx.done;
  }

  async getHistoryState(
    conversationId: string,
  ): Promise<ConversationMetaRecord | undefined> {
    const db = await this.getDb();
    return db.get("meta", conversationId);
  }

  async setHistoryState(
    conversationId: string,
    state:
      | Omit<ConversationMetaRecord, "conversationId">
      | ConversationMetaRecord,
  ): Promise<void> {
    const db = await this.getDb();
    const record: ConversationMetaRecord = {
      conversationId,
      oldest: state.oldest,
      historyComplete: state.historyComplete,
    };
    await db.put("meta", record);
  }
}
