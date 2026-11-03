import { describe, expect, it } from "vitest";
import {
  canonicalContributionPayload,
  idempotencyKeyIsValid,
  normalizeContributionPayload,
  payloadDigestForStored,
} from "@/lib/offline/payload";

const base = {
  accountId: "acc-12345678",
  amount: 20,
  channel: "direct_office" as const,
};

describe("offline contribution payload normalization", () => {
  it("is independent of JSON property order", () => {
    const first = normalizeContributionPayload({
      accountId: base.accountId,
      amount: 20,
      channel: "direct_office",
    });
    const second = normalizeContributionPayload({
      channel: "direct_office",
      amount: 20,
      accountId: base.accountId,
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.canonical).toBe(second.canonical);
    expect(first.hash).toBe(second.hash);
  });

  it("treats an omitted optional field and an explicit null the same", () => {
    const omitted = normalizeContributionPayload(base);
    const explicit = normalizeContributionPayload({ ...base, notes: null });
    expect(omitted.ok && explicit.ok).toBe(true);
    if (!omitted.ok || !explicit.ok) return;
    expect(omitted.hash).toBe(explicit.hash);
  });

  it("changes the digest for a materially different instruction", () => {
    const original = normalizeContributionPayload(base);
    const amount = normalizeContributionPayload({ ...base, amount: 30 });
    const account = normalizeContributionPayload({ ...base, accountId: "acc-87654321" });
    const channel = normalizeContributionPayload({ ...base, channel: "collector" });
    const notes = normalizeContributionPayload({ ...base, notes: "different" });
    expect(original.ok && amount.ok && account.ok && channel.ok && notes.ok).toBe(true);
    if (!original.ok || !amount.ok || !account.ok || !channel.ok || !notes.ok) return;
    expect(amount.hash).not.toBe(original.hash);
    expect(account.hash).not.toBe(original.hash);
    expect(channel.hash).not.toBe(original.hash);
    expect(notes.hash).not.toBe(original.hash);
  });

  it("normalizes legacy stored JSON to the same digest", () => {
    const normalized = normalizeContributionPayload(base);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const legacy = JSON.stringify({
      channel: "direct_office",
      amount: 20,
      accountId: base.accountId,
    });
    expect(payloadDigestForStored(legacy)).toBe(normalized.hash);
    expect(payloadDigestForStored("{not-json")).toBeNull();
  });

  it("rejects invalid and unsafe payloads", () => {
    expect(normalizeContributionPayload(null).ok).toBe(false);
    expect(normalizeContributionPayload({ ...base, amount: 0 }).ok).toBe(false);
    expect(normalizeContributionPayload({ ...base, amount: Number.NaN }).ok).toBe(false);
    expect(normalizeContributionPayload({ ...base, amount: "20" }).ok).toBe(false);
    expect(normalizeContributionPayload({ ...base, accountId: "" }).ok).toBe(false);
    expect(normalizeContributionPayload({ ...base, channel: "other" }).ok).toBe(false);
    expect(normalizeContributionPayload({ ...base, notes: "x".repeat(2001) }).ok).toBe(false);
  });

  it("accepts only stable idempotency key characters", () => {
    expect(idempotencyKeyIsValid("device-1234-uuid_abcd:1")).toBe(true);
    expect(idempotencyKeyIsValid("short")).toBe(false);
    expect(idempotencyKeyIsValid("has space-123")).toBe(false);
    expect(idempotencyKeyIsValid("x".repeat(201))).toBe(false);
    expect(idempotencyKeyIsValid(123 as unknown)).toBe(false);
  });

  it("produces a fixed canonical representation", () => {
    expect(
      canonicalContributionPayload({
        accountId: "acc-12345678",
        amount: 20,
        channel: "direct_office",
        notes: null,
        collectorId: null,
      })
    ).toBe(
      '{"accountId":"acc-12345678","amount":20,"channel":"direct_office","notes":null,"collectorId":null}'
    );
  });
});
