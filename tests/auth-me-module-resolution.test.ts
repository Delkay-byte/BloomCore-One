/**
 * Regression tests for the dual-role workspace defect.
 *
 * A user whose primary role is `worker` can hold a Susu tab session. The
 * module-neutral `/api/auth/me` request used to derive the tenant-resolution
 * module from `user.role`, so it looked up the MoMo session (absent in a Susu
 * tab), returned `tenant: null`, and broke both offline preparation and the
 * offline queue scope while the local device context still said "Offline
 * Ready".
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getAdminSession: vi.fn(),
  getMomoSession: vi.fn(),
  getSusuSession: vi.fn(),
  getCustomerSession: vi.fn(),
  getAnyModuleSession: vi.fn(),
  isSessionCurrent: vi.fn(),
  getTenantContext: vi.fn(),
  getZeliEntitlement: vi.fn(),
  evaluateZeliAccess: vi.fn(),
  getZeliAvailability: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getAdminSession: mocks.getAdminSession,
  getMomoSession: mocks.getMomoSession,
  getSusuSession: mocks.getSusuSession,
  getCustomerSession: mocks.getCustomerSession,
  getAnyModuleSession: mocks.getAnyModuleSession,
  isSessionCurrent: mocks.isSessionCurrent,
}));

vi.mock("@/lib/tenant", () => ({
  getTenantContext: mocks.getTenantContext,
}));

vi.mock("@/lib/zeli/entitlements", () => ({
  getZeliEntitlement: mocks.getZeliEntitlement,
  evaluateZeliAccess: mocks.evaluateZeliAccess,
}));

vi.mock("@/lib/zeli/availability", () => ({
  getZeliAvailability: mocks.getZeliAvailability,
}));

const { GET } = await import("@/app/api/auth/me/route");

const dualRoleWorker = {
  userId: "user-dual",
  email: "dual@example.com",
  fullName: "Dual Role",
  role: "worker" as const,
  modules: ["momo", "susu"] as ("momo" | "susu")[],
  tokenVersion: 0,
};

const tenant = {
  tenantId: "tenant-shared",
  tenantCode: "T-SHARED",
  tenantName: "Shared Business",
  momoEnabled: true,
  susuEnabled: true,
  userId: "user-dual",
  role: "worker",
  modules: ["momo", "susu"] as ("momo" | "susu")[],
};

function request(query = "") {
  return new NextRequest(`http://localhost:3000/api/auth/me${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAdminSession.mockResolvedValue(null);
  mocks.getMomoSession.mockResolvedValue(null);
  mocks.getSusuSession.mockResolvedValue(null);
  mocks.getCustomerSession.mockResolvedValue(null);
  mocks.getAnyModuleSession.mockResolvedValue(null);
  mocks.isSessionCurrent.mockResolvedValue(true);
  mocks.getTenantContext.mockResolvedValue(tenant);
  mocks.getZeliEntitlement.mockResolvedValue(null);
  mocks.evaluateZeliAccess.mockReturnValue({ allowed: false });
  mocks.getZeliAvailability.mockResolvedValue({ enabled: false });
});

describe("GET /api/auth/me workspace resolution", () => {
  it("resolves a neutral Susu-tab request with the Susu module, not the primary role", async () => {
    mocks.getAnyModuleSession.mockResolvedValue({
      module: "susu",
      user: dualRoleWorker,
    });

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    // The old implementation used user.role === "worker" here.
    expect(mocks.getTenantContext).toHaveBeenCalledWith("susu", "susu");
    expect(body.module).toBe("susu");
    expect(body.tenant.id).toBe("tenant-shared");
    expect(body.userId).toBe("user-dual");
  });

  it("resolves a neutral MoMo-tab request with the MoMo module", async () => {
    mocks.getAnyModuleSession.mockResolvedValue({
      module: "momo",
      user: dualRoleWorker,
    });

    const response = await GET(request());
    const body = await response.json();

    expect(mocks.getTenantContext).toHaveBeenCalledWith("momo", "momo");
    expect(body.module).toBe("momo");
    expect(body.tenant.id).toBe("tenant-shared");
  });

  it("honours an explicit Susu request even when a MoMo session could match", async () => {
    mocks.getSusuSession.mockResolvedValue(dualRoleWorker);

    const response = await GET(request("?module=susu"));
    const body = await response.json();

    expect(mocks.getSusuSession).toHaveBeenCalled();
    expect(mocks.getMomoSession).not.toHaveBeenCalled();
    expect(mocks.getTenantContext).toHaveBeenCalledWith("susu", "susu");
    expect(body.module).toBe("susu");
  });

  it("honours an explicit MoMo request without borrowing the Susu session", async () => {
    mocks.getMomoSession.mockResolvedValue(dualRoleWorker);

    const response = await GET(request("?module=momo"));
    const body = await response.json();

    expect(mocks.getMomoSession).toHaveBeenCalled();
    expect(mocks.getSusuSession).not.toHaveBeenCalled();
    expect(mocks.getTenantContext).toHaveBeenCalledWith("momo", "momo");
    expect(body.module).toBe("momo");
  });

  it("fails closed when an explicit module has no session instead of trying another module", async () => {
    mocks.getMomoSession.mockResolvedValue(null);
    mocks.getSusuSession.mockResolvedValue(dualRoleWorker);

    const response = await GET(request("?module=momo"));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error).toBe("Not authenticated");
    expect(mocks.getSusuSession).not.toHaveBeenCalled();
    expect(mocks.getTenantContext).not.toHaveBeenCalled();
  });

  it("keeps admin resolution on its own module", async () => {
    mocks.getAdminSession.mockResolvedValue({
      ...dualRoleWorker,
      role: "admin",
      modules: [],
    });

    const response = await GET(request("?module=admin"));
    const body = await response.json();

    expect(mocks.getAdminSession).toHaveBeenCalled();
    expect(mocks.getTenantContext).toHaveBeenCalledWith("admin", undefined);
    expect(body.module).toBe("admin");
  });

  it("returns 401 when no module session is attached", async () => {
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(mocks.getTenantContext).not.toHaveBeenCalled();
  });

  it("rejects an unknown explicit module rather than silently resolving another workspace", async () => {
    const response = await GET(request("?module=finance"));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Unknown module");
    expect(mocks.getAnyModuleSession).not.toHaveBeenCalled();
  });

  it("returns an accurate null tenant when the server denies tenant context", async () => {
    mocks.getAnyModuleSession.mockResolvedValue({
      module: "susu",
      user: dualRoleWorker,
    });
    mocks.getTenantContext.mockResolvedValue(null);

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.module).toBe("susu");
    expect(body.tenant).toBeNull();
  });
});
