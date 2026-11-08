import {
  SessionBuilder,
  SessionCipher,
  SignalProtocolAddress,
  type DeviceType,
  type MessageType,
} from "@privacyresearch/libsignal-protocol-typescript";
import type { IndexedDBSignalStore } from "./IndexedDBSignalStore";
import type { BundleProvider } from "./bundleProvider";
import { fromBase64, toBase64 } from "./bundle";
import { extractIdentityKeyFromPreKeyMessage } from "./prekeyMessage";

export class IdentityChangedError extends Error {
  constructor(public peerId: string) {
    super(`Identity key changed for peer: ${peerId}`);
    this.name = "IdentityChangedError";
  }
}

export type CipherEnvelope = {
  type: 1 | 3;
  body: string;
};

export type IdentityCallback = (peerId: string, identityKey: ArrayBuffer) => Promise<void> | void;

export type KeyChangeEvent = {
  peerId: string;
  direction: "incoming" | "outgoing";
  previousKey?: ArrayBuffer;
  newKey: ArrayBuffer;
  at: string;
};

export type KeyChangeCallback = (event: KeyChangeEvent) => Promise<void> | void;

export interface SessionManagerOptions {
  onIdentity?: IdentityCallback;
  onKeyChanged?: KeyChangeCallback;
}

function isIdentityFailure(err: unknown): boolean {
  if (err instanceof IdentityChangedError) {
    return true;
  }
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return msg.includes("identity key changed") || msg.includes("unknown identity key");
  }
  return false;
}

function binaryStringToBase64(binary: string): string {
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return toBase64(bytes.buffer);
}

function base64ToBinaryString(b64: string): string {
  const buf = fromBase64(b64);
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return binary;
}

export class SessionManager {
  private identityListeners = new Set<IdentityCallback>();
  private keyChangeListeners = new Set<KeyChangeCallback>();

  constructor(
    private userId: string,
    private store: IndexedDBSignalStore,
    private bundles: BundleProvider,
    options?: SessionManagerOptions,
  ) {
    void this.userId;
    if (options?.onIdentity) {
      this.identityListeners.add(options.onIdentity);
    }
    if (options?.onKeyChanged) {
      this.keyChangeListeners.add(options.onKeyChanged);
    }
  }

  addOnIdentityListener(listener: IdentityCallback): () => void {
    this.identityListeners.add(listener);
    return () => {
      this.identityListeners.delete(listener);
    };
  }

  addOnKeyChangedListener(listener: KeyChangeCallback): () => void {
    this.keyChangeListeners.add(listener);
    return () => {
      this.keyChangeListeners.delete(listener);
    };
  }

  private async notifyIdentity(peerId: string, identityKey: ArrayBuffer): Promise<void> {
    for (const listener of this.identityListeners) {
      await listener(peerId, identityKey);
    }
  }

  private async notifyKeyChanged(event: KeyChangeEvent): Promise<void> {
    for (const listener of this.keyChangeListeners) {
      await listener(event);
    }
  }

  address(peerId: string): SignalProtocolAddress {
    // Device ID is always 1 in this project
    return new SignalProtocolAddress(peerId, 1);
  }

  async hasSession(peerId: string): Promise<boolean> {
    const cipher = new SessionCipher(this.store, this.address(peerId));
    return await cipher.hasOpenSession();
  }

  async ensureSession(peerId: string): Promise<void> {
    const has = await this.hasSession(peerId);
    if (has) {
      return;
    }

    const bundle = await this.bundles.fetchBundle(peerId);

    const device: DeviceType = {
      registrationId: bundle.registrationId,
      identityKey: fromBase64(bundle.identityKey),
      signedPreKey: {
        keyId: bundle.signedPreKey.keyId,
        publicKey: fromBase64(bundle.signedPreKey.publicKey),
        signature: fromBase64(bundle.signedPreKey.signature),
      },
      preKey:
        bundle.oneTimePreKeys.length > 0
          ? {
              keyId: bundle.oneTimePreKeys[0].keyId,
              publicKey: fromBase64(bundle.oneTimePreKeys[0].publicKey),
            }
          : undefined,
    };

    const sessionBuilder = new SessionBuilder(this.store, this.address(peerId));
    try {
      await sessionBuilder.processPreKey(device);
      await this.notifyIdentity(peerId, device.identityKey);
    } catch (err) {
      if (isIdentityFailure(err)) {
        const address = this.address(peerId).toString();
        const previousKey = await this.store.loadIdentityKey(address);
        try {
          await this.notifyIdentity(peerId, device.identityKey);
        } catch {
          // Do not mask IdentityChangedError if notification hook encounters an issue
        }
        await this.notifyKeyChanged({
          peerId,
          direction: "outgoing",
          previousKey,
          newKey: device.identityKey,
          at: new Date().toISOString(),
        });
        throw new IdentityChangedError(peerId);
      }
      throw err;
    }
  }

  async acceptNewIdentity(peerId: string): Promise<void> {
    const bundle = await this.bundles.fetchBundle(peerId);
    const newKey = fromBase64(bundle.identityKey);
    const address = this.address(peerId).toString();

    // Saves its identity key into the Signal store for the address
    await this.store.saveIdentity(address, newKey);

    // Removes any existing session for the peer so the next encrypt re-runs X3DH
    await this.store.removeAllSessions(peerId);
    await this.store.removeSession(address);

    // Notifies listeners with the key (VerificationStore will see the same key it already recorded, so state stays KEY_CHANGED)
    await this.notifyIdentity(peerId, newKey);
  }

  async encrypt(peerId: string, plaintext: string): Promise<CipherEnvelope> {
    await this.ensureSession(peerId);

    const plaintextBytes = new TextEncoder().encode(plaintext);
    const cipher = new SessionCipher(this.store, this.address(peerId));

    let result: MessageType;
    try {
      result = await cipher.encrypt(plaintextBytes.buffer);
    } catch (err) {
      if (isIdentityFailure(err)) {
        throw new IdentityChangedError(peerId);
      }
      throw err;
    }

    if (!result.body) {
      throw new Error("Ciphertext body is missing from cipher output");
    }

    if (result.type !== 1 && result.type !== 3) {
      throw new Error(`Unsupported cipher message type: ${result.type}`);
    }

    const body = binaryStringToBase64(result.body);

    return {
      type: result.type,
      body,
    };
  }

  async decrypt(peerId: string, envelope: CipherEnvelope): Promise<string> {
    const binary = base64ToBinaryString(envelope.body);
    const cipher = new SessionCipher(this.store, this.address(peerId));

    let decryptedBuffer: ArrayBuffer;
    try {
      if (envelope.type === 3) {
        const incomingKey = extractIdentityKeyFromPreKeyMessage(binary);
        const address = this.address(peerId).toString();
        const previousKey = await this.store.loadIdentityKey(address);
        const changed = await this.store.identityChanged(address, incomingKey);

        if (changed) {
          await this.notifyIdentity(peerId, incomingKey); // VerificationStore records KEY_CHANGED
          await this.store.saveIdentity(address, incomingKey); // accept so decryption can proceed
          await this.notifyKeyChanged({
            peerId,
            direction: "incoming",
            previousKey,
            newKey: incomingKey,
            at: new Date().toISOString(),
          });
        }

        decryptedBuffer = await cipher.decryptPreKeyWhisperMessage(binary, "binary");

        if (!changed && !previousKey) {
          await this.notifyIdentity(peerId, incomingKey);
        }
      } else if (envelope.type === 1) {
        decryptedBuffer = await cipher.decryptWhisperMessage(binary, "binary");
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- defensive runtime check
        throw new Error(`Unsupported envelope type: ${(envelope as any).type}`);
      }
    } catch (err) {
      if (isIdentityFailure(err)) {
        throw new IdentityChangedError(peerId);
      }
      throw err;
    }

    return new TextDecoder().decode(decryptedBuffer);
  }
}
