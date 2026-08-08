import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Mirrors scripts/bundle.mjs's esbuild alias — dashboard components import "@/..." verbatim.
    alias: { "@": fileURLToPath(new URL("./dashboard", import.meta.url)) },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["__tests__/**/*.test.ts", "dashboard/**/*.test.tsx"],
  },
});
