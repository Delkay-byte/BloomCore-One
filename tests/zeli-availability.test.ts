import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { prisma, cleanDatabase, createTestTenant } from "./setup";
import {
  getZeliAvailability,
  ZeliUnavailableError,
} from "@/lib/zeli/availability";
import { runZeliTurn } from "@/lib/zeli/service";
import { getZeliAnalyticsDashboard } from "@/lib/actions/zeli-analytics.actions";
import { POST as chatPost } from "@/app/api/zeli/chat/route";
import { GET as exportGet } from "@/app/api/zeli/analytics/export/route";

async function disable() {
  await prisma.zeliAvailability.update({
    where: { id: "global" },
    data: { enabled: false, reason: "Test maintenance window" },
  });
}

beforeEach(async () => {
  await cleanDatabase();
});

describe("global Zeli availability", () => {
  it("defaults to unavailable when the row is missing and recovers when created", async () => {
    await prisma.zeliAvailability.deleteMany();
    const missing = await getZeliAvailability();
    expect(missing.enabled).toBe(false);
    expect(missing.source).toBe("missing");
    await prisma.zeliAvailability.create({
      data: { id: "global", enabled: true, reason: "Fresh install" },
    });
    expect((await getZeliAvailability()).enabled).toBe(true);
  });

  it("takes effect immediately without a cache", async () => {
    expect((await getZeliAvailability()).enabled).toBe(true);
    await disable();
    expect((await getZeliAvailability()).enabled).toBe(false);
    await prisma.zeliAvailability.update({
      where: { id: "global" },
      data: { enabled: true },
    });
    expect((await getZeliAvailability()).enabled).toBe(true);
  });

  it("blocks a direct turn for every tenant role", async () => {
    const tenant = await createTestTenant();
    await disable();
    for (const role of ["admin", "worker", "collector", "customer"] as const) {
      await expect(
        runZeliTurn({
          identity: {
            userId: `${role}-user`,
            fullName: "Test",
            role,
            tenantId: tenant.id,
            module: role === "admin" ? "admin" : role === "customer" ? "customer" : "susu",
          },
          conversationId: "not-used",
          question: "Summarise this month",
        })
      ).rejects.toBeInstanceOf(ZeliUnavailableError);
    }
  });

  it("returns 503 from the chat API before authentication or provider work", async () => {
    await disable();
    const response = await chatPost(
      new NextRequest("http://localhost/api/zeli/chat", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ conversationId: "x", message: "hello" }),
      })
    );
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.code).toBe("zeli_unavailable");
  });

  it("returns 503 from the analytics export before authentication", async () => {
    await disable();
    const response = await exportGet(
      new NextRequest("http://localhost/api/zeli/analytics/export?period=this_month")
    );
    expect(response.status).toBe(503);
  });

  it("denies analytics server actions and exposes no data", async () => {
    await disable();
    const result = await getZeliAnalyticsDashboard({ period: "this_month" });
    expect(result.success).toBe(false);
    expect(result.data).toBeUndefined();
  });
});
