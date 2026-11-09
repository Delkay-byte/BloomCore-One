import { describe, expect, it } from "vitest";
import {
  entityTypeLabel,
  friendlyAction,
  presentAuditEntry,
} from "@/lib/audit-presentation";

describe("Activity History presentation", () => {
  it("uses one label for daily_account and dailyAccount", () => {
    expect(entityTypeLabel("daily_account")).toBe("Daily Account");
    expect(entityTypeLabel("dailyAccount")).toBe("Daily Account");
    expect(entityTypeLabel("DAILY_ACCOUNT")).toBe("Daily Account");
  });

  it("maps technical entity names to business labels", () => {
    expect(entityTypeLabel("device")).toBe("Device");
    expect(entityTypeLabel("contribution")).toBe("Contribution");
    expect(entityTypeLabel("user")).toBe("User");
  });

  it("shows a human reference instead of a truncated database id", () => {
    const presentation = presentAuditEntry({
      action: "daily_account.submitted",
      entityType: "daily_account",
      entityId: "cmw8ted0000internal",
      details: JSON.stringify({ businessDate: "2026-11-09T00:00:00.000Z" }),
      entity: {
        label: "Daily Closing",
        reference: "Daily Closing — 9 November 2026",
        secondary: "Main Shop · Ama Agent",
      },
    });
    expect(presentation.entityLabel).toBe("Daily Closing");
    expect(presentation.entityReference).toBe("Daily Closing — 9 November 2026");
    expect(presentation.entityReference).not.toContain("cmw8ted");
    expect(presentation.description).toContain("Submitted a daily closing");
    expect(presentation.description).toContain("9 November 2026");
  });

  it("turns workspace JSON into a plain description", () => {
    const presentation = presentAuditEntry({
      action: "auth.workspace_switched",
      entityType: "user",
      details: JSON.stringify({ from: "momo", to: "susu" }),
      entity: { label: "User", reference: "Ama Agent" },
    });
    expect(presentation.description).toBe(
      "Switched dashboard from MoMo to Susu Collector."
    );
    expect(presentation.description).not.toContain("{");
    expect(presentation.actionLabel).toBe("Switched dashboard");
  });

  it("describes device registration without raw JSON as the primary text", () => {
    const presentation = presentAuditEntry({
      action: "offline.device_enrolled",
      entityType: "device",
      details: JSON.stringify({ deviceId: "device-secret-internal", module: "susu" }),
      entity: { label: "Device", reference: "Tecno Spark" },
    });
    expect(presentation.entityLabel).toBe("Device");
    expect(presentation.entityReference).toBe("Tecno Spark");
    expect(presentation.description).toBe(
      "Registered a device for offline use (Susu Collector)."
    );
    expect(presentation.description).not.toContain("device-secret-internal");
    const technical = presentation.technicalDetails
      .map((field) => field.value)
      .join(" ");
    expect(technical).toContain("device-secret-internal");
  });

  it("translates a daily closing update with values and no raw JSON", () => {
    const presentation = presentAuditEntry({
      action: "daily_account.updated",
      entityType: "dailyAccount",
      details: JSON.stringify({
        totalExpenses: 15,
        airtimeSold: 100,
        difference: 0,
        businessDate: "2026-11-09T00:00:00.000Z",
      }),
      entity: { label: "Daily Account", reference: "Daily Closing — 9 November 2026" },
    });
    expect(presentation.description).toContain("Expenses: GH₵15.00");
    expect(presentation.description).toContain("Airtime Sold: GH₵100.00");
    expect(presentation.description).not.toContain('"totalExpenses"');
  });

  it("falls back safely for an unknown event", () => {
    const presentation = presentAuditEntry({
      action: "future.unknown_action",
      entityType: "futureThing",
      details: JSON.stringify({ nested: { a: 1 } }),
      entity: { label: "Future Thing" },
    });
    expect(presentation.entityLabel).toBe("Future Thing");
    expect(presentation.description).toBe(
      "Activity recorded — additional details unavailable."
    );
    expect(presentation.translated).toBe(false);
    expect(presentation.description).not.toContain("{");
  });

  it("never exposes password, token or secret values", () => {
    const presentation = presentAuditEntry({
      action: "auth.login",
      entityType: "user",
      details: JSON.stringify({
        password: "should-not-appear",
        token: "jwt-should-not-appear",
        secret: "secret-should-not-appear",
        note: "Visible note",
      }),
    });
    const allValues = [
      presentation.description,
      ...presentation.detailFields.map((field) => field.value),
      ...presentation.technicalDetails.map((field) => field.value),
    ].join(" ");
    expect(allValues).not.toContain("should-not-appear");
    expect(allValues).not.toContain("jwt-should-not-appear");
    expect(allValues).not.toContain("secret-should-not-appear");
    expect(allValues).toContain("Visible note");
  });

  it("keeps action labels readable and stable", () => {
    expect(friendlyAction("daily_account.reviewed")).toBe(
      "Reviewed a daily closing"
    );
    expect(friendlyAction("daily_account.submitted")).toBe(
      "Submitted a daily closing"
    );
    expect(friendlyAction("susu.contribution_recorded")).toBe(
      "Recorded a customer payment"
    );
  });
});
