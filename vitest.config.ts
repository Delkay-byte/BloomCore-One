import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", ".next", "src", "tests/pg-*.test.ts"],
    fileParallelism: false,
    env: {
      JWT_SECRET: "test-secret-for-vitest",
      DATABASE_URL: "file:../tests/test.db",
      NODE_ENV: "test",
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
