import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// Signal Protocol library runs in pure TypeScript/WebCrypto; no Node polyfills or dependency exclusions needed.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5173,
    fs: {
      allow: [".."],
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./src/test/setup.ts"],
    // Signal key generation and ratchet tests take 1 to 4 seconds each and run in parallel; the
    // 5 second default is too close on a slow CI runner and caused random failures.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
