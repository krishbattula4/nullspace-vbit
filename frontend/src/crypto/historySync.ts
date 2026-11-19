import type { SecureMessenger, ReconcileResult } from "./secureMessaging";
import type { MessageStore } from "../store/messageStore";
import { parseHistoryPage, type ServerHistoryMessage } from "../lib/history";

export interface SyncConversationHistoryArgs {
  messenger: SecureMessenger;
  messages: MessageStore;
  conversationId: string;
  peerId: string;
  authFetch: (path: string, init?: RequestInit) => Promise<Response>;
  pageSize?: number;
  maxPages?: number;
  fullResync?: boolean;
}

export type SyncConversationHistoryResult =
  | { status: "ok"; pages: number; result: ReconcileResult }
  | { status: "skipped"; reason: string };

const inFlightSyncs = new Map<string, Promise<SyncConversationHistoryResult>>();

/**
 * Reconciles local conversation history with the server by keyset-paging
 * GET /conversations/{id}/messages backwards from the newest message.
 *
 * Routine sync fetches up to `pageSize * maxPages` messages (default: 50 * 10 = 500 messages).
 * `fullResync: true` expands the window up to 200 pages (up to 10,000 messages) for a complete reload.
 * Routine sync is capped because the server does not currently provide a delta "changes since" endpoint,
 * requiring reverse keyset-paging from the head of the conversation.
 *
 * Execution guarantees:
 * - Single-flight per conversation: concurrent sync calls share the active in-flight request set.
 * - All-or-nothing: every page is fetched and validated before any state changes or decryptions occur.
 *   Any network error, non-2xx status, invalid JSON, or HistoryParseError safely aborts the sync without
 *   touching the local message store.
 */
export async function syncConversationHistory(
  args: SyncConversationHistoryArgs,
): Promise<SyncConversationHistoryResult> {
  const existing = inFlightSyncs.get(args.conversationId);
  if (existing) {
    return existing;
  }

  const syncPromise = executeSync(args).finally(() => {
    inFlightSyncs.delete(args.conversationId);
  });

  inFlightSyncs.set(args.conversationId, syncPromise);
  return syncPromise;
}

async function executeSync(
  args: SyncConversationHistoryArgs,
): Promise<SyncConversationHistoryResult> {
  try {
    const pageSize = args.pageSize ?? 50;
    const maxPages = args.fullResync ? 200 : (args.maxPages ?? 10);

    const allMessages: ServerHistoryMessage[] = [];
    let beforeCursor: string | null = null;
    let pagesFetched = 0;
    let reachedEnd = false;

    while (pagesFetched < maxPages) {
      let url = `/conversations/${encodeURIComponent(args.conversationId)}/messages?limit=${pageSize}`;
      if (beforeCursor) {
        url += `&before=${encodeURIComponent(beforeCursor)}`;
      }

      let res: Response;
      try {
        res = await args.authFetch(url);
      } catch (err) {
        return {
          status: "skipped",
          reason: `Network error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      if (!res.ok) {
        return {
          status: "skipped",
          reason: `Server responded with HTTP ${res.status}`,
        };
      }

      let data: unknown;
      try {
        data = await res.json();
      } catch (err) {
        return {
          status: "skipped",
          reason: `Failed to parse response JSON: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      let page: ServerHistoryMessage[];
      try {
        page = parseHistoryPage(data);
      } catch (err) {
        return {
          status: "skipped",
          reason: `History validation error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      pagesFetched++;
      allMessages.push(...page);

      if (page.length < pageSize) {
        reachedEnd = true;
        break;
      }

      beforeCursor = page[page.length - 1].id;
    }

    // All pages fetched and validated cleanly: invoke global reconciliation inside peer lock
    const result = await args.messenger.reconcileHistory(args.peerId, allMessages);

    // Update conversation metadata history state
    if (allMessages.length > 0) {
      let oldestMsg = allMessages[0];
      for (const m of allMessages) {
        const timeCmp = m.createdAt.localeCompare(oldestMsg.createdAt);
        if (timeCmp < 0 || (timeCmp === 0 && m.id.localeCompare(oldestMsg.id) < 0)) {
          oldestMsg = m;
        }
      }
      await args.messages.setHistoryState(args.conversationId, {
        oldest: { createdAt: oldestMsg.createdAt, id: oldestMsg.id },
        historyComplete: reachedEnd,
      });
    } else {
      await args.messages.setHistoryState(args.conversationId, {
        oldest: null,
        historyComplete: reachedEnd,
      });
    }

    return {
      status: "ok",
      pages: pagesFetched,
      result,
    };
  } catch (err) {
    return {
      status: "skipped",
      reason: `Unexpected sync error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
