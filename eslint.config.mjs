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
    rules: {
      // Downgrade to warning: the set-state-in-effect rule produces false positives
      // for the standard async data-fetching pattern (calling setState from an async
      // function invoked by useEffect). This is safe and widely used.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
]);

export default eslintConfig;
