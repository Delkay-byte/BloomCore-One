import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/pg-*.test.ts"],
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@/lib": path.resolve(__dirname, "./src/lib"),
      "@": path.resolve(__dirname, "./src"),
      "@shared": path.resolve(__dirname, "../shared/core"),
    },
  },
});
