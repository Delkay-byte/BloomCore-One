import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ToastProvider from "@/components/ui/Toast";
import Notice from "@/components/ui/Notice";
import { ConfirmDialog } from "@/components/ui/Modal";
import { enqueueToast, MAX_VISIBLE_TOASTS } from "@/components/ui/toast-queue";
import {
  describePaymentFailure,
  describePaymentStatus,
} from "@/lib/billing/feedback";

function source(relative: string): string {
  return readFileSync(path.join(process.cwd(), relative), "utf8");
}

const BILLING = "src/app/admin/(workspace)/billing/BillingClient.tsx";
const TOAST = "src/components/ui/Toast.tsx";

describe("billing feedback rules", () => {
  it("an uncertain payment is a warning that forbids paying again", () => {
    const feedback = describePaymentFailure({
      error: "We could not confirm whether Paystack received this request.",
      state: "unresolved",
    });
    expect(feedback.tone).toBe("warning");
    expect(feedback.message).toMatch(/do not pay again/i);
    expect(feedback.message).toMatch(/check payment status/i);
  });

  it("a confirmed rejection explains the safe retry and that nothing was charged", () => {
    const feedback = describePaymentFailure({ error: "Insufficient funds.", state: "rejected" });
    expect(feedback.tone).toBe("error");
    expect(feedback.message).toMatch(/nothing was charged/i);
    expect(feedback.message).toMatch(/try again safely/i);
  });

  it("a closed attempt never suggests a retry", () => {
    const feedback = describePaymentFailure({ state: "closed" });
    expect(feedback.tone).toBe("warning");
    expect(feedback.message).not.toMatch(/try again/i);
  });

  it("an unknown failure is an error and says no money was taken", () => {
    const feedback = describePaymentFailure({});
    expect(feedback.tone).toBe("error");
    expect(feedback.message).toMatch(/no money was taken/i);
  });

  it("success is only described from a verified status result", () => {
    expect(describePaymentStatus({ status: "success", message: "Payment verified." })).toEqual({
      tone: "success",
      message: "Payment verified.",
    });
    expect(describePaymentStatus({ status: "pending", message: "" }).tone).toBe("warning");
    expect(describePaymentStatus({ status: "failed", message: "" }).tone).toBe("error");
    expect(describePaymentStatus({ status: "ignored", message: "" }).tone).toBe("info");
  });
});

describe("toast stack rules", () => {
  it("never pushes the same message twice while it is visible", () => {
    const first = enqueueToast([], { id: 1, type: "error", message: "Failed" });
    const second = enqueueToast(first.list, { id: 2, type: "error", message: "Failed" });
    expect(second.added).toBe(false);
    expect(second.list).toHaveLength(1);
    // The same text with a different tone is a different notification.
    const third = enqueueToast(first.list, { id: 3, type: "success", message: "Failed" });
    expect(third.added).toBe(true);
  });

  it("caps the stack and drops the oldest toast", () => {
    let list = enqueueToast([], { id: 1, type: "info", message: "one" }).list;
    for (let id = 2; id <= MAX_VISIBLE_TOASTS + 2; id += 1) {
      const result = enqueueToast(list, { id, type: "info", message: `message ${id}` });
      list = result.list;
      expect(result.dropped.length).toBeLessThanOrEqual(1);
    }
    expect(list).toHaveLength(MAX_VISIBLE_TOASTS);
    expect(list[0].id).toBe(3);
  });

  it("ignores an empty message", () => {
    const result = enqueueToast([], { id: 1, type: "info", message: "   " });
    expect(result.added).toBe(false);
    expect(result.list).toHaveLength(0);
  });
});

describe("toast presentation", () => {
  it("mounts one fixed, bottom-right notification region", () => {
    const html = renderToStaticMarkup(
      createElement(ToastProvider, null, createElement("div", null, "page"))
    );
    expect(html).toContain('aria-label="Notifications"');
    expect(html).toContain("fixed");
    expect(html).toContain("bottom-3");
    expect(html).toContain("sm:right-6");
    expect(html).toContain("z-[110]");
    expect(html).toContain("pointer-events-none");
  });

  it("keeps errors on screen until dismissed and announces them assertively", () => {
    const toast = source(TOAST);
    expect(toast).toMatch(/error:\s*null/);
    expect(toast).toContain('toast.type === "error" ? "alert" : "status"');
    expect(toast).toContain("aria-label={`Dismiss ${label.toLowerCase()}");
    expect(toast).toContain("focus-visible:outline");
    expect(toast).toContain("pointer-events-auto");
  });

  it("uses one shared notice primitive instead of per-page banners", () => {
    const notice = source("src/components/ui/Notice.tsx");
    expect(notice).toContain("toast.push(type, value)");
    expect(notice).toContain("banner banner-${type}");
    expect(notice).toContain('role ?? (type === "error" ? "alert" : "status")');
  });

  it("renders an inline notice with the shared banner classes", () => {
    const html = renderToStaticMarkup(
      createElement(Notice, { type: "error", message: "Nope" })
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("banner banner-error");
    expect(html).toContain("Nope");
  });
});

describe("replacement confirmation stays a safe, accessible dialog", () => {
  it("renders an alertdialog with the keep option focused by default", () => {
    const html = renderToStaticMarkup(
      createElement(ConfirmDialog, {
        open: true,
        title: "Replace the pending payment?",
        description: "Reference ZELI-123 will be released.",
        confirmLabel: "Replace and continue",
        cancelLabel: "Keep the current reference",
        safeCancelFocus: true,
        onClose: () => {},
        onConfirm: () => {},
      })
    );
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("Keep the current reference");
    expect(html).toContain("Replace and continue");
    expect(html).toContain('data-autofocus="true"');
  });

  it("renders nothing while closed", () => {
    const html = renderToStaticMarkup(
      createElement(ConfirmDialog, {
        open: false,
        title: "Replace?",
        onClose: () => {},
        onConfirm: () => {},
      })
    );
    expect(html).toBe("");
  });

  it("traps focus and honours Escape and the loading lock", () => {
    const modal = source("src/components/ui/Modal.tsx");
    expect(modal).toContain('e.key === "Escape"');
    expect(modal).toContain('e.key !== "Tab"');
    expect(modal).toContain("previouslyFocused.current?.focus?.()");
    expect(modal).toContain("if (!loading) onClose();");
    expect(modal).toContain('role="alertdialog"');
  });
});

describe("billing page notification wiring", () => {
  it("uses the shared toast, never alert(), and no top-of-page action banner", () => {
    const billing = source(BILLING);
    expect(billing).toContain('from "@/components/ui/Toast"');
    expect(billing).toContain("toast.push");
    expect(billing).not.toMatch(/\balert\s*\(/);
    expect(billing).not.toContain("banner banner-error");
    expect(billing).not.toContain("banner banner-success");
    expect(billing).not.toContain("setNotice(");
    expect(billing).not.toContain("setError(");
  });

  it("shows loading feedback and blocks duplicate submissions", () => {
    const billing = source(BILLING);
    expect(billing).toContain("aria-busy");
    expect(billing).toContain("disabled={busy !== null");
    expect(billing).toContain("payLock.current");
    expect(billing).toContain("if (payLock.current || busy) return;");
    expect(billing).toContain("if (busy) return;");
  });

  it("keeps the pending intent when the owner cancels the replacement", () => {
    const billing = source(BILLING);
    expect(billing).toContain("function keepExistingIntent()");
    expect(billing).toContain("Kept your existing payment reference");
    // Cancelling only closes the dialog: no server call, no reference change.
    const start = billing.indexOf("function keepExistingIntent()");
    const body = billing.slice(start, billing.indexOf("// Bounded verification", start));
    expect(body).not.toContain("selectPackageAction");
    expect(body).not.toContain("setPendingSubscriptionId");
    expect(body).toContain("setReplaceRequest(null)");
  });

  it("always offers Check payment status for a payable intent", () => {
    const billing = source(BILLING);
    expect(billing).toContain("Check payment status");
    expect(billing).toContain("checkBillingPaymentAction");
  });

  it("refreshes server state after a successful selection instead of requiring a manual reload", () => {
    const billing = source(BILLING);
    expect(billing).toContain("router.refresh()");
    expect(billing).toContain("setSelectionAmount");
  });

  it("uses neutral customer payment copy and never exposes key or local-test state", () => {
    const billing = source(BILLING);
    expect(billing).toContain("Payments are processed securely by Paystack");
    expect(billing).not.toContain("liveReadiness");
    expect(billing).not.toContain("providerMode");
    expect(billing).not.toMatch(/local[- ]live|test key|live key|allowlist|safeguard/i);
    const overview = source("src/lib/actions/billing.actions.ts");
    expect(overview).toContain("liveCheckoutReadiness(");
    expect(overview).toContain("paymentsAvailable:");
    expect(overview).not.toContain("liveReadiness: {");
  });

  it("has no browser alert() or window.confirm anywhere in the app", () => {
    const billing = source(BILLING);
    expect(billing).not.toContain("window.confirm");
    expect(billing).not.toContain("window.alert");
    expect(source("src/components/ui/Toast.tsx")).not.toContain("window.alert");
  });
});

describe("application-wide notice consistency", () => {
  it("routes the operational dashboards through the shared notice primitive", () => {
    for (const file of [
      "src/app/admin/(workspace)/staff/page.tsx",
      "src/app/admin/(workspace)/workers/page.tsx",
      "src/app/admin/(workspace)/locations/page.tsx",
      "src/app/susu/admin/contributions/page.tsx",
      "src/app/susu/admin/customers/page.tsx",
      "src/app/susu/admin/remittances/page.tsx",
      "src/app/susu/admin/withdrawals/page.tsx",
      "src/app/susu/admin/collectors/page.tsx",
    ]) {
      const text = source(file);
      expect(text, file).toContain('from "@/components/ui/Notice"');
      expect(text, file).not.toContain('className="banner banner-error mb-4"');
    }
  });

  it("mirrors rich inline banners into the same toast stack", () => {
    const collector = source(
      "src/app/collector/(workspace)/dashboard/CollectorDashboardClient.tsx"
    );
    expect(collector).toContain("useNoticeToast(");
    const hook = source("src/hooks/useNoticeToast.ts");
    expect(hook).toContain("toast.push(type, text)");
  });
});
