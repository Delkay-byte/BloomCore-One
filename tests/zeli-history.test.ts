import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { prisma, cleanDatabase, createTestAdmin, createTestTenant } from "./setup";

const { mockCookieStore } = vi.hoisted(() => ({
  mockCookieStore: new Map<string, string>(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      mockCookieStore.has(name) ? { name, value: mockCookieStore.get(name)! } : undefined,
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

import {
  listZeliConversations,
  searchZeliConversations,
} from "@/lib/actions/zeli.actions";

const JWT_SECRET = new TextEncoder().encode("test-secret-for-vitest");

async function setAdminSession(user: { id: string; email: string }) {
  const now = Math.floor(Date.now() / 1000);
  mockCookieStore.clear();
  mockCookieStore.set(
    "bik-admin-session",
    await new SignJWT({
      userId: user.id,
      email: user.email,
      fullName: "Admin",
      role: "admin",
      modules: ["momo", "susu"],
      tokenVersion: 0,
      lastActivityAt: now,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(JWT_SECRET)
  );
}

async function thread(
  tenantId: string,
  userId: string,
  title: string,
  content?: string
) {
  return prisma.zeliConversation.create({
    data: {
      tenantId,
      userId,
      title,
      messages: content
        ? { create: { role: "user", content } }
        : undefined,
    },
  });
}

beforeEach(async () => {
  await cleanDatabase();
  mockCookieStore.clear();
});

describe("Zeli history retrieval", () => {
  it("lists only the signed-in user's conversations with metadata", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });
    const colleague = await createTestAdmin({ tenantId: tenant.id });
    await thread(tenant.id, admin.id, "November Business Summary");
    await thread(tenant.id, admin.id, "Collector Remittance Review");
    await thread(tenant.id, colleague.id, "Another user's private thread");

    await setAdminSession(admin);
    const result = await listZeliConversations();
    expect(result.success).toBe(true);
    expect(result.data?.map((row) => row.title).sort()).toEqual([
      "Collector Remittance Review",
      "November Business Summary",
    ]);
    expect(result.data?.[0].createdAt).toBeTruthy();
    expect(result.data?.[0].updatedAt).toBeTruthy();
  });

  it("searches titles and message content inside the tenant and user scope", async () => {
    const tenant = await createTestTenant();
    const otherTenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });
    const otherAdmin = await createTestAdmin({ tenantId: otherTenant.id });
    await thread(
      tenant.id,
      admin.id,
      "November Business Summary",
      "Collector remittances were reviewed."
    );
    await thread(tenant.id, admin.id, "Expense Review", "Transport expenses increased.");
    await thread(
      otherTenant.id,
      otherAdmin.id,
      "Collector Remittance Review",
      "Collector remittances from another business."
    );

    await setAdminSession(admin);
    const byContent = await searchZeliConversations("collector");
    expect(byContent.success).toBe(true);
    expect(byContent.data).toHaveLength(1);
    expect(byContent.data?.[0].title).toBe("November Business Summary");
    expect(byContent.data?.[0].snippet).toContain("Collector remittances");

    const byTitle = await searchZeliConversations("Expense");
    expect(byTitle.data?.map((row) => row.title)).toEqual(["Expense Review"]);

    const none = await searchZeliConversations("another business");
    expect(none.data).toHaveLength(0);
  });

  it("returns an empty list rather than another tenant's history", async () => {
    const tenant = await createTestTenant();
    const otherTenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });
    const otherAdmin = await createTestAdmin({ tenantId: otherTenant.id });
    await thread(otherTenant.id, otherAdmin.id, "Private other tenant thread");

    await setAdminSession(admin);
    const result = await listZeliConversations();
    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });
});
