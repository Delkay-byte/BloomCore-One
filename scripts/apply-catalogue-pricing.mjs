/**
 * Apply the owner-approved catalogue prices to a **local** database.
 *
 * Prices are commercial data, not schema, so this is deliberately an operator script
 * and not a migration: a deploy must never silently re-price a customer. It refuses
 * any non-local database, defaults to a dry run, and only updates a plan row whose
 * price still equals the price it is replacing. A plan an operator has already set to
 * another figure is reported and left alone.
 *
 * Existing subscriptions are untouched: `ZeliSubscription.amount` holds what each
 * customer actually agreed to pay, so a historical charge keeps its own amount and
 * only the next renewal quotes the catalogue.
 *
 *   node scripts/apply-catalogue-pricing.mjs                # dry run, prints a table
 *   node scripts/apply-catalogue-pricing.mjs --apply        # writes the new prices
 *   node scripts/apply-catalogue-pricing.mjs --apply --addons   # also the add-on plan
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const apply = process.argv.includes("--apply");
const withAddons = process.argv.includes("--addons");

const url = process.env.DATABASE_URL || "";
const isLocalFile = url.startsWith("file:");
const isLoopbackPg =
  /^postgres(ql)?:\/\/[^@]*@(127\.0\.0\.1|localhost):\d+\//.test(url) &&
  !/neon\.tech|render\.com|amazonaws\.com|supabase|azure/i.test(url);

if (!isLocalFile && !isLoopbackPg) {
  console.error(
    "Refusing to run: DATABASE_URL must be a local SQLite file or a loopback PostgreSQL database."
  );
  process.exit(1);
}

/** Current owner-approved prices. Kept in step with src/lib/pricing/catalogue.ts. */
const MONTHLY = { starter: 129, business: 219, "multi-branch": 429 };
const ANNUAL = { "starter-annual": 1390, "business-annual": 2365, "multi-branch-annual": 4630 };
const PREVIOUS = {
  starter: 99,
  business: 169,
  "multi-branch": 339,
  "starter-annual": 1070,
  "business-annual": 1825,
  "multi-branch-annual": 3660,
};
const ADDON = { code: "ai-investigation", name: "AI Investigation", price: 159, allowance: 50 };

const targets = [
  ...Object.entries(MONTHLY).map(([code, price]) => ({ code, price, from: PREVIOUS[code] })),
  ...Object.entries(ANNUAL).map(([code, price]) => ({ code, price, from: PREVIOUS[code] })),
];

// The script body runs through a small TypeScript file so it uses the project's
// Prisma client and adapter exactly as the application does.
const tmp = path.join(repoRoot, "scripts", `_apply-pricing-${Date.now()}.mts`);
fs.writeFileSync(
  tmp,
  `import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const url = process.env.DATABASE_URL!;
const adapter = url.startsWith("file:") ? new PrismaBetterSqlite3({ url }) : undefined;
const prisma = new PrismaClient(adapter ? { adapter } : {});

const targets = ${JSON.stringify(targets)};
const addon = ${JSON.stringify(ADDON)};
const apply = ${apply};
const withAddons = ${withAddons};

const rows = await prisma.zeliPlan.findMany({
  where: { code: { in: [...targets.map((t) => t.code), addon.code] } },
  select: { id: true, code: true, name: true, price: true, usageAllowance: true, addonKey: true },
});
const byCode = new Map(rows.map((r) => [r.code, r]));

const report: string[] = [];
let updates = 0;
let skipped = 0;

for (const target of targets) {
  const row = byCode.get(target.code);
  if (!row) {
    report.push(\`  MISSING  \${target.code.padEnd(24)} (no plan row; nothing to re-price)\`);
    continue;
  }
  const current = Number(row.price);
  if (current === target.price) {
    report.push(\`  CURRENT  \${target.code.padEnd(24)} GH\${current}\`);
    continue;
  }
  if (current !== target.from) {
    report.push(
      \`  SKIPPED  \${target.code.padEnd(24)} is GH\${current}, not the GH\${target.from} this change replaces. Left alone.\`
    );
    skipped += 1;
    continue;
  }
  if (apply) {
    await prisma.zeliPlan.update({ where: { id: row.id }, data: { price: target.price } });
  }
  updates += 1;
  report.push(\`  \${apply ? "UPDATED " : "WOULD   "} \${target.code.padEnd(24)} GH\${current} -> GH\${target.price}\`);
}

if (withAddons) {
  const existing = byCode.get(addon.code);
  if (!existing) {
    if (apply) {
      await prisma.zeliPlan.create({
        data: {
          code: addon.code,
          name: addon.name,
          description: "Dedicated AI investigation package: evidence-based explanations of anomalies, with human review.",
          billingInterval: "month",
          price: addon.price,
          currency: "GHS",
          status: "active",
          isPublic: true,
          usageAllowance: addon.allowance,
          zeliIncluded: false,
          addonKey: "ai_investigation",
          sortOrder: 90,
        },
      });
    }
    updates += 1;
    report.push(\`  \${apply ? "CREATED " : "WOULD   "} \${addon.code.padEnd(24)} GH\${addon.price}/month, \${addon.allowance} investigations\`);
  } else {
    const current = Number(existing.price);
    if (current !== addon.price) {
      if (apply) {
        await prisma.zeliPlan.update({
          where: { id: existing.id },
          data: { price: addon.price, usageAllowance: addon.allowance, addonKey: "ai_investigation", zeliIncluded: false },
        });
      }
      updates += 1;
      report.push(\`  \${apply ? "UPDATED " : "WOULD   "} \${addon.code.padEnd(24)} GH\${current} -> GH\${addon.price}\`);
    } else {
      report.push(\`  CURRENT  \${addon.code.padEnd(24)} GH\${current}\`);
    }
  }
}

// A price change never touches a subscription amount: that is the customer's record
// of what they agreed to pay. Counted here so the report can prove it.
const subscriptions = await prisma.zeliSubscription.count();
report.push(\`  --- \${subscriptions} subscription record(s) left untouched ---\`);

console.log(report.join("\\n"));
console.log(
  apply
    ? \`Applied: \${updates} change(s), \${skipped} skipped.\`
    : \`Dry run: \${updates} change(s) would be made, \${skipped} skipped. Re-run with --apply.\`
);
await prisma.$disconnect();
`,
  "utf8"
);

try {
  // Node 22 can strip types, so the generated module runs without an extra toolchain.
  const output = execFileSync(
    process.execPath,
    ["--experimental-strip-types", tmp],
    { cwd: repoRoot, encoding: "utf8", env: process.env }
  );
  console.log(output);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error("Pricing update failed:", message);
  if (error && typeof error === "object" && "stdout" in error) {
    console.error(String(error.stdout));
    console.error(String(error.stderr));
  }
  process.exitCode = 1;
} finally {
  fs.rmSync(tmp, { force: true });
}
