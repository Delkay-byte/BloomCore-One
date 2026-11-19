import { describe, expect, it } from "vitest";
import {
  normaliseAnswerMeta,
  normaliseSections,
  parseLegacyAnswer,
  SECTION_LABELS,
} from "@/lib/zeli/response-format";

describe("Zeli answer presentation", () => {
  it("uses human section labels instead of machine vocabulary", () => {
    expect(SECTION_LABELS.calculated_fact).toBe("Key figures");
    expect(SECTION_LABELS.detected_pattern).toBe("What changed");
    expect(SECTION_LABELS.automated_interpretation).toBe("How to read this");
    expect(SECTION_LABELS.suggested_action).toBe("Recommended next step");
    expect(SECTION_LABELS.unverified_hypothesis).toBe("Not established");
    expect(Object.values(SECTION_LABELS).join(" ")).not.toMatch(/^[A-Z ]+$/);
  });

  it("renders an old bracketed answer as typed sections without rewriting it", () => {
    const legacy = [
      "[CALCULATED FACT] Contributions were GH₵100.00.",
      "",
      "[DETECTED PATTERN] Contributions increased.",
      "",
      "[SUGGESTED ACTION] Open the contributions report.",
      "",
      "[PERIOD] This month · [SOURCE] MaaCash records · [FRESHNESS] Last refreshed today",
      "",
      "[LIMITATIONS] Reversed rows are excluded.",
    ].join("\n");

    const parsed = parseLegacyAnswer(legacy);
    expect(parsed?.sections.map((row) => row.label)).toEqual([
      "Key figures",
      "What changed",
      "Recommended next step",
    ]);
    expect(parsed?.sections[0].text).toContain("GH₵100.00");
    expect(parsed?.meta.period).toBe("This month");
    expect(parsed?.meta.source).toBe("MaaCash records");
    expect(parsed?.meta.freshness).toContain("Last refreshed");
    expect(parsed?.meta.limitations).toEqual(["Reversed rows are excluded."]);
    expect(parsed?.sections.map((row) => row.text).join(" ")).not.toContain("[");
  });

  it("leaves plain prose untouched", () => {
    expect(parseLegacyAnswer("Just a normal answer with no structure.")).toBeNull();
  });

  it("ignores malformed or unknown stored sections safely", () => {
    const rows = normaliseSections([
      { kind: "calculated_fact", label: "old", text: "Fact" },
      { kind: "made_up", label: "Bad", text: "Nope" },
      { kind: "suggested_action", text: 42 },
    ]);
    expect(rows).toEqual([
      { kind: "calculated_fact", label: "Key figures", text: "Fact" },
    ]);
    expect(normaliseAnswerMeta({ limitations: ["A", 2] })).toEqual({
      period: null,
      source: null,
      freshness: null,
      limitations: ["A"],
    });
  });
});
