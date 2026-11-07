import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// libsignal-client ships WebAssembly; keep it out of dependency pre-bundling (P0.8 may adjust this).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: { port: 5173 },
  optimizeDeps: { exclude: ["@signalapp/libsignal-client"] },
  test: { environment: "node" },
});
