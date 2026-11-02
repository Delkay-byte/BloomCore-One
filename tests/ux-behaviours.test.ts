import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  SkeletonPage,
  SkeletonTable,
} from "../src/components/ui/Skeletons";
import {
  fromHttpStatus,
  messageForCode,
  safeServerMessage,
  syncFailureMessage,
  toUserMessage,
} from "../src/lib/errors/friendly";
import { performOptimistic } from "../src/hooks/useOptimisticAction";

function source(relative: string): string {
  return readFileSync(path.join(process.cwd(), relative), "utf8");
}

describe("skeleton loading UI", () => {
  it("announces loading once and marks the region busy", () => {
    const html = renderToStaticMarkup(
      createElement(SkeletonPage, { variant: "table" })
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Loading content"');
    expect(html).toContain("skeleton");
  });

  it("renders the requested number of table rows and columns", () => {
    const html = renderToStaticMarkup(
      createElement(SkeletonTable, { rows: 3, columns: 4 })
    );
    const rows = (html.match(/grid items-center gap-4/g) ?? []).length;
    expect(rows).toBe(3);
    expect(html).toContain("repeat(4, minmax(0, 1fr))");
  });

  it("keeps the reduced-motion override in the global stylesheet", () => {
    const css = source("src/app/globals.css");
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce/);
    expect(css).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
  });
});

describe("autofill and financial safeguards", () => {
  it("marks identity and contact fields for browser autofill", () => {
    const customerForm = source("src/app/susu/admin/customers/page.tsx");
    expect(customerForm).toContain('autoComplete="name"');
    expect(customerForm).toContain('autoComplete="tel"');
    expect(customerForm).toContain('autoComplete="street-address"');

    const staffForm = source("src/app/admin/(workspace)/staff/page.tsx");
    expect(staffForm).toContain('autoComplete="email"');

    const locationForm = source("src/app/admin/(workspace)/locations/page.tsx");
    expect(locationForm).toContain('autoComplete="organization"');
  });

  it("keeps financial amount inputs out of browser autofill", () => {
    const customerForm = source("src/app/susu/admin/customers/page.tsx");
    expect(customerForm).toMatch(
      /name="dailyContribution"\s+autoComplete="off"/
    );
    const dailyAccount = source("src/app/worker/daily/[id]/page.tsx");
    expect(dailyAccount).toContain('type="number" autoComplete="off"');
  });

  it("never persists credential fields in a draft", () => {
    const draftHook = source("src/hooks/useFormDraft.ts");
    expect(draftHook).toContain('"password", "file", "submit", "button", "reset"');
    const draftStore = source("src/lib/offline/drafts.ts");
    expect(draftStore).toContain("SECRET_KEY_PATTERN");
  });
});

describe("friendly error handling", () => {
  it("maps authentication and permission failures to actionable text", () => {
    expect(fromHttpStatus(401).message).toBe(
      "Your session has expired. Please sign in again."
    );
    expect(fromHttpStatus(403).message).toBe(
      "You don't have permission to perform this action."
    );
    expect(fromHttpStatus(404).message).toContain("couldn't find that record");
    expect(fromHttpStatus(500).message).toBe("Something went wrong. Please try again.");
  });

  it("returns a real cooldown for HTTP 429", () => {
    const result = fromHttpStatus(429, null, 42);
    expect(result.code).toBe("rate_limited");
    expect(result.retryAfterSeconds).toBe(42);
    expect(result.retryable).toBe(true);
  });

  it("never exposes SQL, stack traces or framework details", () => {
    expect(
      safeServerMessage("PrismaClientKnownRequestError at /src/app/page.tsx")
    ).toBeNull();
    expect(safeServerMessage("duplicate key value violates unique constraint")).toBeNull();
    expect(safeServerMessage("Please check the highlighted fields.")).toBe(
      "Please check the highlighted fields."
    );
    expect(syncFailureMessage("SQLITE_ERROR: no such table")).toBe(
      messageForCode("sync_failed").message
    );
  });

  it("recognises storage-quota failures", () => {
    const error = new DOMException("quota", "QuotaExceededError");
    expect(toUserMessage(error).code).toBe("storage_full");
    expect(toUserMessage(error).message).toContain("run out of storage");
  });
});

describe("optimistic updates", () => {
  it("keeps the optimistic state when the server accepts it", async () => {
    let state = "active";
    const result = await performOptimistic({
      apply: () => {
        state = "inactive";
      },
      rollback: () => {
        state = "active";
      },
      action: async () => ({ success: true, status: "inactive" }),
    });
    expect(result?.success).toBe(true);
    expect(state).toBe("inactive");
  });

  it("rolls back and explains a server rejection", async () => {
    let state = "active";
    let message = "";
    const result = await performOptimistic({
      apply: () => {
        state = "inactive";
      },
      rollback: () => {
        state = "active";
      },
      action: async () => ({ success: false, error: "Not permitted for this role" }),
      onError: (value) => {
        message = value;
      },
    });
    expect(result?.success).toBe(false);
    expect(state).toBe("active");
    expect(message).toBe("Not permitted for this role");
  });

  it("rolls back and hides technical detail when the request throws", async () => {
    let state = "inactive";
    let message = "";
    const result = await performOptimistic({
      apply: () => {
        state = "active";
      },
      rollback: () => {
        state = "inactive";
      },
      action: async () => {
        throw new Error("PrismaClientKnownRequestError at /src/app/page.tsx");
      },
      onError: (value) => {
        message = value;
      },
    });
    expect(result).toBeNull();
    expect(state).toBe("inactive");
    expect(message).not.toContain("Prisma");
  });
});

describe("offline sign-out safety", () => {
  it("does not delete offline databases on sign-out", () => {
    const button = source("src/components/ConfirmSignOutButton.tsx");
    expect(button).not.toContain("clearCurrentOfflineData");
    expect(button).toContain("syncBeforeSignOut");
    expect(button).toContain("endOfflineSession");
    expect(button).toContain("keep records");
  });

  it("requires explicit confirmation before destructive offline cleanup", () => {
    const session = source("src/lib/offline/session.ts");
    expect(session).toContain('DISCARD_CONFIRMATION = "DELETE OFFLINE DATA"');
    expect(session).toContain("allowPendingLoss");
  });
});
