import { NextResponse } from "next/server";

/**
 * Public health endpoint. Also reports the exact deployed git commit so
 * deployment truth can be verified externally:
 *
 *   curl https://<host>/api/health
 *
 * Platform-provided env vars (Render: RENDER_GIT_COMMIT, Vercel:
 * VERCEL_GIT_COMMIT_SHA, Heroku: SOURCE_VERSION) are injected at build time —
 * no secrets are exposed.
 */
function deployedCommitSha(): string | null {
  return (
    process.env.RENDER_GIT_COMMIT ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ||
    process.env.GIT_COMMIT ||
    process.env.SOURCE_VERSION ||
    null
  );
}

export async function GET() {
  return NextResponse.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    app: "maacash",
    env: process.env.APP_ENV || process.env.NODE_ENV || "unknown",
    commit: deployedCommitSha(),
  });
}