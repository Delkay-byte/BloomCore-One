import { defineConfig } from "vitest/config";
import path from "path";
import { unitDatabase } from "./scripts/test-database-paths.cjs";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", ".next", "src", "tests/pg-*.test.ts"],
    fileParallelism: false,
    env: {
      JWT_SECRET: "test-secret-for-vitest",
      // One explicit repo-local disposable database. The helper is shared with
      // scripts/prepare-unit-db.mjs so preparation and runtime always agree.
      DATABASE_URL: `${unitDatabase().url}?connection_limit=1&socket_timeout=30`,
      NODE_ENV: "test",
      // Migration bridge for pre-existing cookie-seeded unit tests. Production
      // never sets this; new tests exercise the tab header directly.
      ALLOW_LEGACY_COOKIE_SESSIONS: "1",
    },
  },
  resolve: {
    alias: {
      "@/lib": path.resolve(__dirname, "./src/lib"),
      "@": path.resolve(__dirname, "./src"),
      "@shared": path.resolve(__dirname, "../shared/core"),
    },
  },
});
