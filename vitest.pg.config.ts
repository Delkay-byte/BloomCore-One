import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/pg-*.test.ts"],
    env: {
      JWT_SECRET: "test-secret-for-vitest",
      NODE_ENV: "test",
      ALLOW_LEGACY_COOKIE_SESSIONS: "1",
      DATABASE_URL: process.env.PG_DATABASE_URL,
    },
    fileParallelism: false,
    // One worker for the whole file set. The suite is small and sequential already, and
    // reusing a single fork removes the per-file worker churn that was observed to fail
    // with "Worker exited unexpectedly" when the machine was loaded by the rest of the
    // release gate.
    maxWorkers: 1,
  },
  resolve: {
    alias: {
      "@/lib": path.resolve(__dirname, "./src/lib"),
      "@": path.resolve(__dirname, "./src"),
      "@shared": path.resolve(__dirname, "../shared/core"),
    },
  },
});
