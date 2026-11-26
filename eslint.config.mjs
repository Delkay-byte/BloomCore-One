import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".prisma-pg-gen/**",
    ".prisma-gen/**",
    "test-results/**",
    "playwright-report/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Utility scripts not part of the application
    "prisma/pre-migration-snapshot.ts",
    "prisma/staging-rehearsal.ts",
    "prisma/go-live-rehearsal.ts",
    "prisma/test-susu-logic.ts",
    "snapshot-sqlite.js",
  ]),
  {
    // Plain CommonJS helpers are loaded by Playwright and Vitest before any
    // transpilation, so they legitimately use require().
    files: ["**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    // Flat config resolves a rule's plugin from the same config object, so the
    // react-hooks plugin registered by eslint-config-next is carried over here
    // instead of being left behind by an override that only lists rules.
    plugins: {
      "react-hooks": nextVitals.find(
        (entry) => entry?.plugins && "react-hooks" in entry.plugins
      ).plugins["react-hooks"],
    },
    rules: {
      // Downgrade to warning: the set-state-in-effect rule produces false positives
      // for the standard async data-fetching pattern (calling setState from an async
      // function invoked by useEffect). This is safe and widely used.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
]);

export default eslintConfig;
