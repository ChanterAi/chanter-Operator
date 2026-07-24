// CHANTER Operator — Platform Readiness presentation helper tests (§8). Pure
// formatting helpers so the founder display cannot drift from the projection
// contract (badges, atom tone).
import { describe, expect, it } from "vitest";
import { atomTone, badgeList } from "../components/PlatformReadinessPanel";
import type { DemoReadinessState } from "../api/types";

describe("Platform Readiness presentation helpers", () => {
  it("maps atom status to a tone", () => {
    expect(atomTone("succeeded")).toBe("ok");
    expect(atomTone("degraded")).toBe("warn");
    expect(atomTone("failed")).toBe("error");
    expect(atomTone("pending")).toBe("muted");
    expect(atomTone("blocked_approval")).toBe("warn");
  });

  it("projects the six required truth badges with zero-write highlighted", () => {
    const state: DemoReadinessState = {
      present: true,
      badges: { readOnlyMission: true, realInternetCapability: true, localAI: true, humanApprovalRequired: true, externalWrites: 0, evidenceRetained: true },
    };
    const badges = badgeList(state);
    expect(badges).toHaveLength(6);
    expect(badges.map((b) => b.label)).toEqual([
      "Read-only mission",
      "Real internet capability",
      "Local AI",
      "Human approval required",
      "External writes: 0",
      "Evidence retained",
    ]);
    // External writes badge is "on" (green) only when the count is exactly zero.
    expect(badges[4].on).toBe(true);
  });

  it("marks the external-writes badge as not-ok if any write were ever recorded", () => {
    const state: DemoReadinessState = {
      present: true,
      badges: { readOnlyMission: true, realInternetCapability: true, localAI: true, humanApprovalRequired: true, externalWrites: 1, evidenceRetained: true },
    };
    const badges = badgeList(state);
    expect(badges[4].label).toBe("External writes: 1");
    expect(badges[4].on).toBe(false);
  });

  it("returns no badges when the projection has none", () => {
    expect(badgeList({ present: false })).toEqual([]);
  });
});
