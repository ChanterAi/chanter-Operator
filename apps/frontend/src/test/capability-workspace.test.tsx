import { describe, expect, it } from "vitest";
import { statusTone, riskTone, healthLabel } from "../components/CapabilityWorkspacePanel";
import type { CapabilitySummary } from "../api/types";

function cap(over: Partial<CapabilitySummary>): CapabilitySummary {
  return { capabilityId: "x.y", version: "1.0.0", category: "system", riskClass: "read_only", status: "certified", health: null, ...over };
}

describe("capability workspace helpers", () => {
  it("maps status to a tone", () => {
    expect(statusTone("certified")).toBe("ok");
    expect(statusTone("deprecated")).toBe("warn");
    expect(statusTone("disabled")).toBe("error");
    expect(statusTone("draft")).toBe("muted");
  });

  it("maps risk class to a tone", () => {
    expect(riskTone("read_only")).toBe("ok");
    expect(riskTone("destructive")).toBe("error");
    expect(riskTone("bounded_write")).toBe("warn");
  });

  it("summarizes invocation health", () => {
    expect(healthLabel(cap({ health: null }))).toBe("no invocations");
    expect(healthLabel(cap({ health: { healthy: true, success: 0, failure: 0, lastSuccessAt: null } }))).toBe("no invocations");
    expect(healthLabel(cap({ health: { healthy: true, success: 3, failure: 1, lastSuccessAt: null } }))).toBe("3✓ / 1✗");
  });
});
