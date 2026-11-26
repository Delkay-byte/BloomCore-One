/**
 * Regression for the post-write RSC refresh: the narrow fetch shim must attach
 * a worker-signed tab proof to router RSC GETs only, and must never invent one
 * when the worker has no mapping for this tab (fail closed).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { installRscProofShim } from "@/lib/security/tab-session-client";

type Listener = (event: MessageEvent) => void;

function installWorker(reply: Record<string, unknown> | null) {
  const postMessage = vi.fn(() => {
    const event = { data: reply };
    queueMicrotask(() => portListener?.(event as MessageEvent));
  });
  const controller = { postMessage } as unknown as ServiceWorker;
  const addEventListener = vi.fn();
  const removeEventListener = vi.fn();
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { serviceWorker: { controller, addEventListener, removeEventListener } },
  });
  return postMessage;
}

let portListener: Listener | undefined;

afterEach(() => {
  // The shim is installed on a mocked window and restored by its teardown.
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).navigator;
  portListener = undefined;
});

describe("RSC proof shim", () => {
  it("attaches proof headers to a router RSC GET", async () => {
    const postMessage = installWorker({
      type: "tab-proof-response",
      requestId: "request-1",
      proof: "signed.signature",
      assertion: "signed-assertion",
      client: "client-1",
      path: "/admin/policy",
    });
    const originalFetch = vi.fn().mockResolvedValue(new Response("ok"));
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { href: "https://maacash.test/admin/policy", origin: "https://maacash.test" },
        fetch: originalFetch,
      },
    });
    const capture = (globalThis as Record<string, unknown>).window as {
      addEventListener?: unknown;
    };
    void capture;

    const uninstall = installRscProofShim();
    const win = (globalThis as Record<string, unknown>).window as {
      fetch: typeof fetch;
    };
    const req = new Request("https://maacash.test/admin/policy?_rsc=abc", {
      headers: { rsc: "1" },
    });
    // MessageChannel is provided by the Node runtime; capture its port listener
    // through a stub so the reply is delivered deterministically.
    const NativeChannel = globalThis.MessageChannel;
    globalThis.MessageChannel = class {
      port1 = {
        set onmessage(listener: Listener) {
          portListener = listener;
        },
        close: vi.fn(),
      } as unknown as MessagePort;
      port2 = {} as MessagePort;
    } as unknown as typeof MessageChannel;

    const pending = win.fetch(req);
    await Promise.resolve();
    portListener?.({ data: { type: "tab-proof-response", proof: "signed.signature" } } as MessageEvent);
    await pending;

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tab-proof-request", method: "GET" }),
      expect.anything()
    );
    const forwarded = originalFetch.mock.calls[0][0] as Request;
    expect(forwarded.headers.get("x-bloomcore-tab-proof")).toBe("signed.signature");
    uninstall();
    globalThis.MessageChannel = NativeChannel;
  });

  it("passes ordinary fetches through untouched", async () => {
    installWorker(null);
    const originalFetch = vi.fn().mockResolvedValue(new Response("ok"));
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { href: "https://maacash.test/admin/dashboard", origin: "https://maacash.test" },
        fetch: originalFetch,
      },
    });
    const uninstall = installRscProofShim();
    const win = (globalThis as Record<string, unknown>).window as { fetch: typeof fetch };
    const req = new Request("https://maacash.test/api/health");
    await win.fetch(req);
    expect(originalFetch).toHaveBeenCalledWith(req, undefined);
    uninstall();
  });

  it("fails closed when the worker returns no proof", async () => {
    installWorker(null);
    const originalFetch = vi.fn().mockResolvedValue(new Response("ok"));
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { href: "https://maacash.test/admin/policy", origin: "https://maacash.test" },
        fetch: originalFetch,
      },
    });
    const uninstall = installRscProofShim();
    const win = (globalThis as Record<string, unknown>).window as { fetch: typeof fetch };
    const req = new Request("https://maacash.test/admin/policy", {
      headers: { rsc: "1" },
    });
    await win.fetch(req);
    const forwarded = originalFetch.mock.calls[0][0] as Request;
    expect(forwarded.headers.has("x-bloomcore-tab-proof")).toBe(false);
    uninstall();
  });
});
