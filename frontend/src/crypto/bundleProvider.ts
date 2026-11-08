import { validatePreKeyBundle, type PublicPreKeyBundle } from "./bundle";

export interface BundleProvider {
  fetchBundle(userId: string): Promise<PublicPreKeyBundle>;
}

export class BundleFetchError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "BundleFetchError";
  }
}

export class InMemoryBundleProvider implements BundleProvider {
  private bundles = new Map<string, PublicPreKeyBundle>();

  register(bundle: PublicPreKeyBundle): void {
    // Store a deep copy so external mutations do not affect the provider
    this.bundles.set(bundle.userId, {
      userId: bundle.userId,
      registrationId: bundle.registrationId,
      identityKey: bundle.identityKey,
      signedPreKey: { ...bundle.signedPreKey },
      oneTimePreKeys: bundle.oneTimePreKeys.map((k) => ({ ...k })),
      createdAt: bundle.createdAt,
    });
  }

  async fetchBundle(userId: string): Promise<PublicPreKeyBundle> {
    const stored = this.bundles.get(userId);
    if (!stored) {
      throw new BundleFetchError(`No prekey bundle registered for user: ${userId}`, 404);
    }

    // Serve at most one one-time prekey and remove it from the stored copy
    const servedKey = stored.oneTimePreKeys.shift();

    return {
      userId: stored.userId,
      registrationId: stored.registrationId,
      identityKey: stored.identityKey,
      signedPreKey: { ...stored.signedPreKey },
      oneTimePreKeys: servedKey ? [{ ...servedKey }] : [],
      createdAt: stored.createdAt,
    };
  }
}

export class HttpBundleProvider implements BundleProvider {
  constructor(
    private baseUrl: string,
    private getToken: () => string | null,
  ) {}

  async fetchBundle(userId: string): Promise<PublicPreKeyBundle> {
    const token = this.getToken();
    const headers: Record<string, string> = {};
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const cleanBase = this.baseUrl.replace(/\/+$/, "");
    const url = `${cleanBase}/keys/bundle/${encodeURIComponent(userId)}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers,
      });
    } catch (err) {
      throw new BundleFetchError(
        `Network error fetching bundle for ${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!res.ok) {
      throw new BundleFetchError(
        `Failed to fetch bundle for ${userId}: HTTP ${res.status}`,
        res.status,
      );
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new BundleFetchError(`Invalid JSON response for ${userId}`, res.status);
    }

    if (!validatePreKeyBundle(body)) {
      throw new BundleFetchError(
        `Invalid prekey bundle shape received for ${userId}`,
        res.status,
      );
    }

    return body;
  }
}
