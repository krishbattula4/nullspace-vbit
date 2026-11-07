# ADR-001: Signal Protocol Library Selection for Browser

- Status: accepted
- Date: 2026-11-07
- Task: P0.8

## Context

Nullspace requires end-to-end encryption (E2EE) using the Signal Protocol in the browser client under Vite. The server must only handle ciphertext, while private keys and message encryption/decryption happen exclusively on client devices. We needed to verify whether the official `@signalapp/libsignal-client` package can run directly in a browser environment with Vite or if an alternative Signal Protocol implementation is necessary, strictly adhering to the constraint of avoiding Node polyfills.

## Decision

We chose `@privacyresearch/libsignal-protocol-typescript` (version `0.0.16`).

This library is a pure TypeScript/JavaScript implementation of the Signal Protocol (Double Ratchet, X3DH, Curve25519) utilizing the standard WebCrypto API (`globalThis.crypto.subtle`). It builds, bundles, and runs natively in modern browsers and under Vite with zero Node polyfills or native compilation.

Regarding Vite configuration:
- No Node polyfills were added to Vite.
- Removed the obsolete `optimizeDeps: { exclude: ["@signalapp/libsignal-client"] }` from `frontend/vite.config.ts`.
- No additional Vite plugins or configuration workarounds are required.

## Alternatives considered

### `@signalapp/libsignal-client`
- Tested installing `@signalapp/libsignal-client` (version `0.106.2`).
- Inspection of its `package.json` revealed that neither `"browser"` nor `"exports"` fields are provided.
- Its entry point (`dist/Native.js`) imports `node-gyp-build` to dynamically load prebuilt native C++/Rust binary addons (`.node` binaries in `prebuilds/`).
- It does not distribute a WebAssembly or browser-compatible entrypoint via npm.
- Running it in Vite would require extensive Node core polyfills (`crypto`, `fs`, `path`, etc.) and shimming native addons, which is explicitly forbidden by project architecture guidelines.
- Rejected per task instructions.

## Consequences

- **Provenance and audit status**: The chosen library is a community TypeScript port (derived from `libsignal-protocol-javascript`), not published or audited by Signal (Signal Messenger, LLC).
- **Curve25519 & Vite externalization warnings**: Its Curve25519 implementation is an asm.js build (`@privacyresearch/curve25519-typescript/lib/built/curveasm.js`) that includes environment checks referencing Node modules, which causes Vite during build to log warnings that `path` and `fs` have been externalized for browser compatibility. These warnings are harmless in the browser.
- **Bundle size**: The library adds roughly 400 kB minified to the frontend bundle (resulting in a minified production bundle of ~612 kB).
- **Future revisit**: The official `@signalapp/libsignal-client` should be revisited if an official browser or WebAssembly build is published by Signal.
- **Required IndexedDB stores for task P3.1**: The library separates protocol logic from persistence via the `StorageType` interface. For task P3.1, the project must implement four store interfaces in IndexedDB:
  1. **Identity key store**: `getIdentityKeyPair()`, `getLocalRegistrationId()`, `saveIdentity()`, `isTrustedIdentity()`.
  2. **Prekey store**: `loadPreKey()`, `storePreKey()`, `removePreKey()`.
  3. **Signed prekey store**: `loadSignedPreKey()`, `storeSignedPreKey()`, `removeSignedPreKey()`.
  4. **Session store**: `loadSession()`, `storeSession()`.
