import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` throws outside a React Server environment; tests run plain Node.
      "server-only": fileURLToPath(new URL("./src/test/empty.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Tests and their hooks import heavy modules (WDK, web3.js, the routes) cold, which takes over 20 s on a busy
    // laptop. These only bound a hang; no assertion depends on them.
    testTimeout: 90_000,
    hookTimeout: 90_000,
  },
});
