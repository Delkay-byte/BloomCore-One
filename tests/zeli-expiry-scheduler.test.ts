import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Regression guard for the Zeli expiry scheduler wiring.
 *
 * With a `src/app` project Next scans `<root>/src` for the instrumentation
 * hook. A hook at the repository root is ignored, which silently removed the
 * scheduled sweep once already. These tests fail if the hook moves back out of
 * `src/` or if `register()` stops starting the sweep.
 */

const ROOT = process.cwd();
const EXPIRY_MODULE = "../src/lib/zeli/expiry";

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("Zeli expiry scheduler wiring", () => {
  it("places the instrumentation hook where Next scans for a src/app project", () => {
    expect(fs.existsSync(path.join(ROOT, "src", "instrumentation.ts"))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, "instrumentation.ts"))).toBe(false);
  });

  describe("register()", () => {
    let prevRuntime: string | undefined;
    let prevVitest: string | undefined;
    let prevScheduler: string | undefined;
    let prevInterval: string | undefined;
    let setIntervalMock: ReturnType<typeof vi.spyOn> | undefined;

    beforeEach(() => {
      prevRuntime = process.env.NEXT_RUNTIME;
      prevVitest = process.env.VITEST;
      prevScheduler = process.env.ZELI_EXPIRY_SCHEDULER;
      prevInterval = process.env.ZELI_EXPIRY_INTERVAL_MS;
      process.env.NEXT_RUNTIME = "nodejs";
      delete process.env.VITEST;
      delete process.env.ZELI_EXPIRY_SCHEDULER;
      delete process.env.ZELI_EXPIRY_INTERVAL_MS;
      vi.resetModules();
      const fakeTimer = { unref: () => {} } as unknown as ReturnType<typeof setInterval>;
      setIntervalMock = vi.spyOn(globalThis, "setInterval").mockReturnValue(fakeTimer);
    });

    afterEach(() => {
      setIntervalMock?.mockRestore();
      vi.doUnmock(EXPIRY_MODULE);
      vi.resetModules();
      restore("NEXT_RUNTIME", prevRuntime);
      restore("VITEST", prevVitest);
      restore("ZELI_EXPIRY_SCHEDULER", prevScheduler);
      restore("ZELI_EXPIRY_INTERVAL_MS", prevInterval);
    });

    it("runs a catch-up sweep and schedules repeats", async () => {
      const expire = vi.fn().mockResolvedValue({ subscriptions: 0, entitlements: 0, skipped: 0 });
      vi.doMock(EXPIRY_MODULE, () => ({ expireZeliLifecycle: expire }));

      const { register } = await import("../src/instrumentation");
      register();

      await vi.waitFor(() => expect(expire).toHaveBeenCalledTimes(1));
      expect(setIntervalMock).toHaveBeenCalledTimes(1);
    });

    it("does not start twice for the same process", async () => {
      const expire = vi.fn().mockResolvedValue({ subscriptions: 0, entitlements: 0, skipped: 0 });
      vi.doMock(EXPIRY_MODULE, () => ({ expireZeliLifecycle: expire }));

      const { register } = await import("../src/instrumentation");
      register();
      register();

      await vi.waitFor(() => expect(expire).toHaveBeenCalledTimes(1));
      expect(setIntervalMock).toHaveBeenCalledTimes(1);
    });

    it("honours the explicit disabled switch", async () => {
      process.env.ZELI_EXPIRY_SCHEDULER = "disabled";
      const expire = vi.fn().mockResolvedValue({ subscriptions: 0, entitlements: 0, skipped: 0 });
      vi.doMock(EXPIRY_MODULE, () => ({ expireZeliLifecycle: expire }));

      const { register } = await import("../src/instrumentation");
      register();
      await Promise.resolve();

      expect(expire).not.toHaveBeenCalled();
      expect(setIntervalMock).not.toHaveBeenCalled();
    });

    it("stays out of the way in non-node runtimes", async () => {
      process.env.NEXT_RUNTIME = "edge";
      const expire = vi.fn().mockResolvedValue({ subscriptions: 0, entitlements: 0, skipped: 0 });
      vi.doMock(EXPIRY_MODULE, () => ({ expireZeliLifecycle: expire }));

      const { register } = await import("../src/instrumentation");
      register();
      await Promise.resolve();

      expect(expire).not.toHaveBeenCalled();
      expect(setIntervalMock).not.toHaveBeenCalled();
    });
  });
});
