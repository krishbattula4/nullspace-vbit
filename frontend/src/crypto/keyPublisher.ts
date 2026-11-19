import type { IndexedDBSignalStore } from "./IndexedDBSignalStore";
import { provisionKeys } from "./provision";
import { maintainPrekeys } from "./prekeyMaintenance";

export interface KeyPublisherArgs {
  userId: string;
  store: IndexedDBSignalStore;
  authFetch: (path: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
}

export interface KeyPublisherResult {
  status: "ok" | "skipped" | "failed";
  published: boolean;
  reason?: string;
}

export async function ensureKeysPublished(
  args: KeyPublisherArgs,
): Promise<KeyPublisherResult> {
  const { userId, store, authFetch, now } = args;

  // 1. Provision keys locally (or load existing)
  const { created, bundle } = await provisionKeys(userId, store);

  // 2. GET /keys/count. If it fails, return { status: "skipped", published: false } without throwing
  let countRes: Response;
  try {
    countRes = await authFetch("/keys/count", { method: "GET" });
  } catch (err) {
    return {
      status: "skipped",
      published: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  if (!countRes.ok) {
    return {
      status: "skipped",
      published: false,
      reason: `HTTP ${countRes.status}`,
    };
  }

  let countData: { one_time_prekeys?: number; signed_prekey_id?: number | null };
  try {
    countData = (await countRes.json()) as {
      one_time_prekeys?: number;
      signed_prekey_id?: number | null;
    };
  } catch (err) {
    return {
      status: "skipped",
      published: false,
      reason: `Invalid JSON response: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 3. If created is true OR the count response has signed_prekey_id === null: PUT /keys/bundle with full bundle
  let published = false;
  if (created || countData.signed_prekey_id === null || countData.signed_prekey_id === undefined) {
    let putRes: Response;
    try {
      putRes = await authFetch("/keys/bundle", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bundle),
      });
    } catch (err) {
      return {
        status: "failed",
        published: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }

    if (!putRes.ok) {
      return {
        status: "failed",
        published: false,
        reason: `HTTP ${putRes.status}`,
      };
    }

    // 5. The PUT response body is {identity_changed: boolean} only; do not read any other field.
    try {
      const body = (await putRes.json()) as { identity_changed?: boolean };
      void body?.identity_changed;
    } catch {
      // Ignore JSON parse errors on 2xx responses
    }

    published = true;
  }

  // 4. Then call maintainPrekeys to top up or rotate
  const maintResult = await maintainPrekeys({
    userId,
    store,
    authFetch,
    now,
  });

  if (maintResult.status === "failed") {
    return {
      status: "failed",
      published,
      reason: maintResult.reason,
    };
  }

  if (maintResult.status === "skipped" && !published) {
    return {
      status: "skipped",
      published,
      reason: maintResult.reason,
    };
  }

  return {
    status: "ok",
    published,
  };
}
