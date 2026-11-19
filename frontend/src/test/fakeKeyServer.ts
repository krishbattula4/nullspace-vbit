import {
  type BundleProvider,
  BundleFetchError,
} from "../crypto/bundleProvider";
import type { PublicPreKeyBundle } from "../crypto/bundle";

export interface FakeServerPreKey {
  keyId: number;
  publicKey: string;
  consumed: boolean;
}

export interface FakeServerSignedPreKey {
  keyId: number;
  publicKey: string;
  signature: string;
}

export interface UserKeyState {
  userId: string;
  registrationId: number;
  identityKey: string;
  signedPreKeys: FakeServerSignedPreKey[];
  oneTimePreKeys: Map<number, FakeServerPreKey>;
}

export interface RequestRecord {
  method: string;
  path: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- request body may be any serialized payload
  body?: any;
  rawBody?: string;
}

export class FakeKeyServer implements BundleProvider {
  public users = new Map<string, UserKeyState>();
  public requests: RequestRecord[] = [];

  public countCalls = 0;
  public putCalls = 0;
  public getBundleCalls = 0;

  public failNextCount = false;
  public failNextPutNetwork = false;
  public putStatus?: number;

  constructor(public userId: string = "default-user") {}

  private getOrCreateUser(userId: string): UserKeyState {
    let user = this.users.get(userId);
    if (!user) {
      user = {
        userId,
        registrationId: 0,
        identityKey: "",
        signedPreKeys: [],
        oneTimePreKeys: new Map(),
      };
      this.users.set(userId, user);
    }
    return user;
  }

  consumeOne(userId?: string): FakeServerPreKey | null {
    const targetId = userId ?? this.userId;
    const user = this.users.get(targetId);
    if (!user) return null;

    for (const prekey of user.oneTimePreKeys.values()) {
      if (!prekey.consumed) {
        prekey.consumed = true;
        return prekey;
      }
    }
    return null;
  }

  getUnconsumedCount(userId?: string): number {
    const targetId = userId ?? this.userId;
    const user = this.users.get(targetId);
    if (!user) return 0;

    let count = 0;
    for (const prekey of user.oneTimePreKeys.values()) {
      if (!prekey.consumed) {
        count++;
      }
    }
    return count;
  }

  createAuthFetch(userId: string): (path: string, init?: RequestInit) => Promise<Response> {
    return (path: string, init?: RequestInit) => this.authFetch(path, init, userId);
  }

  async authFetch(
    path: string,
    init?: RequestInit,
    overrideUserId?: string,
  ): Promise<Response> {
    const method = init?.method?.toUpperCase() ?? "GET";
    let parsedBody: unknown;
    let rawBody: string | undefined;

    if (init?.body && typeof init.body === "string") {
      rawBody = init.body;
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }

    this.requests.push({
      method,
      path,
      body: parsedBody,
      rawBody,
    });

    if (path === "/keys/count") {
      this.countCalls++;
      if (this.failNextCount) {
        this.failNextCount = false;
        throw new Error("Network error during /keys/count");
      }

      const targetId = overrideUserId ?? this.userId;
      const user = this.users.get(targetId);
      const signedPreKeys = user?.signedPreKeys ?? [];
      const newestSignedPreKey =
        signedPreKeys.length > 0 ? signedPreKeys[signedPreKeys.length - 1] : null;

      const data = {
        one_time_prekeys: this.getUnconsumedCount(targetId),
        signed_prekey_id: newestSignedPreKey?.keyId ?? null,
      };

      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (path === "/keys/bundle" && method === "PUT") {
      this.putCalls++;
      if (this.failNextPutNetwork) {
        this.failNextPutNetwork = false;
        throw new Error("Network error during PUT /keys/bundle");
      }

      if (this.putStatus && this.putStatus !== 200) {
        const status = this.putStatus;
        return new Response(JSON.stringify({ detail: `Server error ${status}` }), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      }

      const bundle = parsedBody as PublicPreKeyBundle;
      if (!bundle) {
        return new Response(JSON.stringify({ detail: "Missing bundle body" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (Array.isArray(bundle.oneTimePreKeys) && bundle.oneTimePreKeys.length > 200) {
        return new Response(JSON.stringify({ detail: "too_many_prekeys" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const targetId = bundle.userId || overrideUserId || this.userId;
      const user = this.getOrCreateUser(targetId);

      let identity_changed = false;
      if (user.identityKey && user.identityKey !== bundle.identityKey) {
        user.identityKey = bundle.identityKey;
        user.registrationId = bundle.registrationId;
        user.signedPreKeys = [];
        user.oneTimePreKeys.clear();
        identity_changed = true;
      } else {
        user.identityKey = bundle.identityKey;
        user.registrationId = bundle.registrationId;
      }

      // Check signed prekey conflict
      if (bundle.signedPreKey) {
        const existingSpk = user.signedPreKeys.find(
          (spk) => spk.keyId === bundle.signedPreKey.keyId,
        );
        if (existingSpk && existingSpk.publicKey !== bundle.signedPreKey.publicKey) {
          return new Response(JSON.stringify({ detail: "prekey_id_conflict" }), {
            status: 409,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      // Check one-time prekeys conflict
      if (Array.isArray(bundle.oneTimePreKeys)) {
        for (const opk of bundle.oneTimePreKeys) {
          const existing = user.oneTimePreKeys.get(opk.keyId);
          if (existing && existing.publicKey !== opk.publicKey) {
            return new Response(JSON.stringify({ detail: "prekey_id_conflict" }), {
              status: 409,
              headers: { "Content-Type": "application/json" },
            });
          }
        }
      }

      // Store signed prekey if new
      if (bundle.signedPreKey) {
        const existingSpk = user.signedPreKeys.find(
          (spk) => spk.keyId === bundle.signedPreKey.keyId,
        );
        if (!existingSpk) {
          user.signedPreKeys.push({
            keyId: bundle.signedPreKey.keyId,
            publicKey: bundle.signedPreKey.publicKey,
            signature: bundle.signedPreKey.signature,
          });
        }
      }

      // Store one-time prekeys if new
      if (Array.isArray(bundle.oneTimePreKeys)) {
        for (const opk of bundle.oneTimePreKeys) {
          if (!user.oneTimePreKeys.has(opk.keyId)) {
            user.oneTimePreKeys.set(opk.keyId, {
              keyId: opk.keyId,
              publicKey: opk.publicKey,
              consumed: false,
            });
          }
        }
      }

      return new Response(JSON.stringify({ identity_changed }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (path.startsWith("/keys/bundle/") && method === "GET") {
      this.getBundleCalls++;
      const targetUserId = decodeURIComponent(path.slice("/keys/bundle/".length));
      const user = this.users.get(targetUserId);

      if (!user || user.signedPreKeys.length === 0) {
        return new Response(JSON.stringify({ detail: "user_not_found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      const newestSpk = user.signedPreKeys[user.signedPreKeys.length - 1];
      let servedKey: { keyId: number; publicKey: string } | undefined;

      for (const opk of user.oneTimePreKeys.values()) {
        if (!opk.consumed) {
          opk.consumed = true;
          servedKey = { keyId: opk.keyId, publicKey: opk.publicKey };
          break;
        }
      }

      const bundle: PublicPreKeyBundle = {
        userId: user.userId,
        registrationId: user.registrationId,
        identityKey: user.identityKey,
        signedPreKey: {
          keyId: newestSpk.keyId,
          publicKey: newestSpk.publicKey,
          signature: newestSpk.signature,
        },
        oneTimePreKeys: servedKey ? [servedKey] : [],
        createdAt: new Date().toISOString(),
      };

      return new Response(JSON.stringify(bundle), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ detail: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  async fetchBundle(peerId: string): Promise<PublicPreKeyBundle> {
    const res = await this.authFetch(`/keys/bundle/${encodeURIComponent(peerId)}`, {
      method: "GET",
    });
    if (!res.ok) {
      throw new BundleFetchError(`User not found: ${peerId}`, res.status);
    }
    return (await res.json()) as PublicPreKeyBundle;
  }
}
