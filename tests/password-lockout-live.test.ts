import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, cleanDatabase, createTestAdmin } from "./setup";
import { accountThrottleKey, clearThrottle, pairThrottleKey } from "@/lib/security/login-throttle";

const { mockCookieStore } = vi.hoisted(() => ({
  mockCookieStore: new Map<string, string>(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      mockCookieStore.has(name)
        ? { name, value: mockCookieStore.get(name)! }
        : undefined,
    set: (name: string, value: string) => mockCookieStore.set(name, value),
    delete: (name: string) => mockCookieStore.delete(name),
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { adminLogin } from "@/lib/actions/auth.actions";

function form(email: string, password: string) {
  const data = new FormData();
  data.set("email", email);
  data.set("password", password);
  return data;
}

describe("live password lockout sequence", () => {
  beforeEach(async () => {
    await cleanDatabase();
    mockCookieStore.clear();
  });

  it("progresses to a 1-minute cooldown and blocks even a correct password", async () => {
    const admin = await createTestAdmin({ momo: false, susu: false });
    const email = admin.email;

    const failures: string[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await adminLogin(form(email, "WrongPassword!1"));
      if (result && "error" in result) failures.push(result.error ?? "");
    }
    expect(failures.length).toBeGreaterThanOrEqual(5);
    expect(failures[0]).toBe(failures[1]);
    const blocked = failures.some((message) => /wait|too many|try again/i.test(message));
    expect(blocked).toBe(true);
    expect(mockCookieStore.has("bik-admin-session")).toBe(false);

    const correctWhileBlocked = await adminLogin(form(email, "Test1234!"));
    expect(correctWhileBlocked && "error" in correctWhileBlocked).toBe(true);
    if (correctWhileBlocked && "error" in correctWhileBlocked) {
      expect(correctWhileBlocked.error).toMatch(/wait|too many|try again/i);
    }
    expect(mockCookieStore.has("bik-admin-session")).toBe(false);
  }, 30_000);

  it("allows a correct password after the cooldown is cleared", async () => {
    const admin = await createTestAdmin({ momo: false, susu: false });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await adminLogin(form(admin.email, "WrongPassword!1"));
    }
    await clearThrottle([pairThrottleKey(admin.email, "unknown")]);
    await clearThrottle([accountThrottleKey(admin.email)]);

    // The IP passed by the mocked headers is "unknown"; clear both bucket
    // variants used by the guard.
    for (const ip of ["unknown", "127.0.0.1", ""]) {
      await clearThrottle([pairThrottleKey(admin.email, ip)]);
    }

    await expect(adminLogin(form(admin.email, "Test1234!"))).rejects.toThrow(
      /REDIRECT:\/admin\/dashboard/
    );
    expect(mockCookieStore.has("bik-admin-session")).toBe(true);
  }, 30_000);
});
