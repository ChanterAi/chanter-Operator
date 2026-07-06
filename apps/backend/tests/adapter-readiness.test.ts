// ── CHANTER Operator P1.6: Adapter Registry Readiness Gate Tests ──
import { describe, expect, it } from "vitest";
import {
  AdapterReadinessStatuses,
  deriveAdapterReadiness,
  evaluateAdapterReadiness,
  evaluateRegistryReadiness,
} from "../src/agentRuntime/adapters/adapterReadiness.js";
import {
  AdapterIds,
  getRegisteredAdapter,
  listRegisteredAdapters,
} from "../src/agentRuntime/adapters/adapterRegistry.js";
import type { AgentRuntimeAdapterMetadata } from "../src/agentRuntime/adapters/adapterRegistry.js";
import { AgentRunLifecycleStates } from "../src/agentRuntime/index.js";

/** Deep-clone a registered adapter's metadata as a mutable fixture. */
function fixture(adapterId: (typeof AdapterIds)[number]): AgentRuntimeAdapterMetadata {
  const r = getRegisteredAdapter(adapterId);
  expect(r.ok).toBe(true);
  return structuredClone(r.adapter!) as AgentRuntimeAdapterMetadata;
}

// ================================================================
// 1. Status vocabulary
// ================================================================
describe("P1.6 Readiness Gate — status vocabulary", () => {
  it("defines exactly the six statuses", () => {
    expect(AdapterReadinessStatuses).toEqual([
      "UNKNOWN",
      "INCOMPLETE",
      "BLOCKED",
      "MISSING_EVIDENCE",
      "NEEDS_APPROVAL",
      "READY",
    ]);
  });
});

// ================================================================
// 2. READY case
// ================================================================
describe("P1.6 Readiness Gate — READY", () => {
  it("Loop Governor is READY (low risk, no approval required)", () => {
    const report = evaluateAdapterReadiness("loop_governor");
    expect(report.status).toBe("READY");
    expect(report.usable).toBe(true);
    expect(report.reasons.length).toBeGreaterThan(0);
  });

  it("a complete, low-risk, approval-free contract derives READY", () => {
    const meta = fixture("loop_governor");
    const report = deriveAdapterReadiness(meta);
    expect(report.status).toBe("READY");
  });
});

// ================================================================
// 3. NEEDS_APPROVAL case
// ================================================================
describe("P1.6 Readiness Gate — NEEDS_APPROVAL", () => {
  it("SafeCommit needs approval (requiresApproval: true)", () => {
    const report = evaluateAdapterReadiness("safecommit");
    expect(report.status).toBe("NEEDS_APPROVAL");
    expect(report.usable).toBe(true);
    expect(report.reasons.some((r) => r.includes("approval"))).toBe(true);
  });

  it("AutoPoster needs approval (requiresApproval: true, high risk)", () => {
    const report = evaluateAdapterReadiness("autoposter");
    expect(report.status).toBe("NEEDS_APPROVAL");
    expect(report.reasons.some((r) => r.includes("approval"))).toBe(true);
    expect(report.reasons.some((r) => r.includes("high"))).toBe(true);
  });

  it("high risk alone forces NEEDS_APPROVAL even without requiresApproval", () => {
    const meta = fixture("loop_governor");
    meta.governance.riskLevel = "high";
    const report = deriveAdapterReadiness(meta);
    expect(report.status).toBe("NEEDS_APPROVAL");
  });

  it("NEEDS_APPROVAL is distinguishable from BLOCKED (usable flag)", () => {
    const approval = evaluateAdapterReadiness("safecommit");
    const blockedMeta = fixture("safecommit");
    blockedMeta.governance.availability = "blocked";
    const blocked = deriveAdapterReadiness(blockedMeta);
    expect(approval.status).toBe("NEEDS_APPROVAL");
    expect(approval.usable).toBe(true);
    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.usable).toBe(false);
  });
});

// ================================================================
// 4. BLOCKED case
// ================================================================
describe("P1.6 Readiness Gate — BLOCKED", () => {
  it("availability: blocked derives BLOCKED", () => {
    const meta = fixture("autoposter");
    meta.governance.availability = "blocked";
    const report = deriveAdapterReadiness(meta);
    expect(report.status).toBe("BLOCKED");
    expect(report.usable).toBe(false);
    expect(report.reasons.some((r) => r.toLowerCase().includes("blocked"))).toBe(true);
  });

  it("availability: deprecated derives BLOCKED", () => {
    const meta = fixture("loop_governor");
    meta.governance.availability = "deprecated";
    const report = deriveAdapterReadiness(meta);
    expect(report.status).toBe("BLOCKED");
  });

  it("allowed/forbidden action conflict derives BLOCKED", () => {
    const meta = fixture("loop_governor");
    meta.governance.forbiddenActions.push("build_manifest"); // also in allowedActions
    const report = deriveAdapterReadiness(meta);
    expect(report.status).toBe("BLOCKED");
    expect(report.reasons.some((r) => r.includes("build_manifest"))).toBe(true);
  });

  it("BLOCKED outranks approval requirement", () => {
    const meta = fixture("autoposter"); // requiresApproval: true
    meta.governance.availability = "blocked";
    expect(deriveAdapterReadiness(meta).status).toBe("BLOCKED");
  });
});

// ================================================================
// 5. MISSING_EVIDENCE case
// ================================================================
describe("P1.6 Readiness Gate — MISSING_EVIDENCE", () => {
  it("empty evidenceRequirements derives MISSING_EVIDENCE", () => {
    const meta = fixture("loop_governor");
    meta.governance.evidenceRequirements = [];
    const report = deriveAdapterReadiness(meta);
    expect(report.status).toBe("MISSING_EVIDENCE");
    expect(report.usable).toBe(false);
  });

  it("empty validationCommands derives MISSING_EVIDENCE", () => {
    const meta = fixture("safecommit");
    meta.governance.validationCommands = [];
    expect(deriveAdapterReadiness(meta).status).toBe("MISSING_EVIDENCE");
  });

  it("missing sample fixture derives MISSING_EVIDENCE", () => {
    const meta = fixture("loop_governor");
    meta.hasSampleFixture = false;
    const report = deriveAdapterReadiness(meta);
    expect(report.status).toBe("MISSING_EVIDENCE");
    expect(report.reasons.some((r) => r.includes("fixture"))).toBe(true);
  });

  it("MISSING_EVIDENCE outranks approval requirement", () => {
    const meta = fixture("autoposter"); // requiresApproval: true
    meta.governance.evidenceRequirements = [];
    expect(deriveAdapterReadiness(meta).status).toBe("MISSING_EVIDENCE");
  });
});

// ================================================================
// 6. INCOMPLETE case
// ================================================================
describe("P1.6 Readiness Gate — INCOMPLETE", () => {
  it("missing governance section derives INCOMPLETE", () => {
    const meta = fixture("loop_governor") as Partial<AgentRuntimeAdapterMetadata>;
    delete (meta as Record<string, unknown>).governance;
    const report = deriveAdapterReadiness(meta);
    expect(report.status).toBe("INCOMPLETE");
    expect(report.reasons.some((r) => r.includes("governance"))).toBe(true);
  });

  it("empty supportedSourceStates derives INCOMPLETE", () => {
    const meta = fixture("safecommit");
    meta.supportedSourceStates = [];
    const report = deriveAdapterReadiness(meta);
    expect(report.status).toBe("INCOMPLETE");
    expect(report.reasons.some((r) => r.includes("supportedSourceStates"))).toBe(true);
  });

  it("empty safetyNotes derives INCOMPLETE", () => {
    const meta = fixture("autoposter");
    meta.safetyNotes = [];
    expect(deriveAdapterReadiness(meta).status).toBe("INCOMPLETE");
  });

  it("empty exclusions derives INCOMPLETE", () => {
    const meta = fixture("loop_governor");
    meta.exclusions = [];
    expect(deriveAdapterReadiness(meta).status).toBe("INCOMPLETE");
  });

  it("incomplete lifecycleStates derives INCOMPLETE", () => {
    const meta = fixture("loop_governor");
    (meta as Record<string, unknown>).lifecycleStates = AgentRunLifecycleStates.slice(0, 3);
    expect(deriveAdapterReadiness(meta).status).toBe("INCOMPLETE");
  });

  it("empty contractDocPath derives INCOMPLETE", () => {
    const meta = fixture("safecommit");
    meta.contractDocPath = "";
    expect(deriveAdapterReadiness(meta).status).toBe("INCOMPLETE");
  });

  it("INCOMPLETE outranks BLOCKED and evidence gaps", () => {
    const meta = fixture("autoposter");
    meta.safetyNotes = [];
    meta.governance.availability = "blocked";
    meta.governance.evidenceRequirements = [];
    expect(deriveAdapterReadiness(meta).status).toBe("INCOMPLETE");
  });

  it("lists every missing section in reasons", () => {
    const meta = fixture("loop_governor");
    meta.safetyNotes = [];
    meta.exclusions = [];
    const report = deriveAdapterReadiness(meta);
    expect(report.reasons.some((r) => r.includes("safetyNotes"))).toBe(true);
    expect(report.reasons.some((r) => r.includes("exclusions"))).toBe(true);
  });
});

// ================================================================
// 7. UNKNOWN case
// ================================================================
describe("P1.6 Readiness Gate — UNKNOWN", () => {
  it("unregistered adapter id derives UNKNOWN", () => {
    const report = evaluateAdapterReadiness("nonexistent_adapter");
    expect(report.status).toBe("UNKNOWN");
    expect(report.usable).toBe(false);
    expect(report.adapterId).toBe("nonexistent_adapter");
  });

  it("empty string derives UNKNOWN", () => {
    expect(evaluateAdapterReadiness("").status).toBe("UNKNOWN");
  });

  it("null metadata derives UNKNOWN", () => {
    const report = deriveAdapterReadiness(null, "ghost");
    expect(report.status).toBe("UNKNOWN");
    expect(report.adapterId).toBe("ghost");
  });
});

// ================================================================
// 8. Determinism
// ================================================================
describe("P1.6 Readiness Gate — determinism", () => {
  it("same metadata always yields the same status and reasons", () => {
    for (const adapterId of AdapterIds) {
      const a = evaluateAdapterReadiness(adapterId);
      const b = evaluateAdapterReadiness(adapterId);
      expect(a.status).toBe(b.status);
      expect(a.reasons).toEqual(b.reasons);
      expect(a.usable).toBe(b.usable);
    }
  });

  it("derivation does not mutate the input metadata", () => {
    const meta = fixture("loop_governor");
    const before = JSON.stringify(meta);
    deriveAdapterReadiness(meta);
    expect(JSON.stringify(meta)).toBe(before);
  });

  it("all derived statuses are in the status vocabulary", () => {
    for (const adapterId of AdapterIds) {
      expect(AdapterReadinessStatuses).toContain(evaluateAdapterReadiness(adapterId).status);
    }
  });
});

// ================================================================
// 9. Registry-wide summary
// ================================================================
describe("P1.6 Readiness Gate — registry summary", () => {
  it("evaluates all registered adapters", () => {
    const summary = evaluateRegistryReadiness();
    expect(summary.reports).toHaveLength(listRegisteredAdapters().length);
    const ids = summary.reports.map((r) => r.adapterId);
    for (const adapterId of AdapterIds) {
      expect(ids).toContain(adapterId);
    }
  });

  it("counts cover every status and sum to the report count", () => {
    const summary = evaluateRegistryReadiness();
    for (const status of AdapterReadinessStatuses) {
      expect(summary.counts[status]).toBeGreaterThanOrEqual(0);
    }
    const total = Object.values(summary.counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(summary.reports.length);
  });

  it("current catalog: 1 READY, 2 NEEDS_APPROVAL, none blocked/incomplete", () => {
    const summary = evaluateRegistryReadiness();
    expect(summary.counts.READY).toBe(1);
    expect(summary.counts.NEEDS_APPROVAL).toBe(2);
    expect(summary.counts.BLOCKED).toBe(0);
    expect(summary.counts.INCOMPLETE).toBe(0);
    expect(summary.counts.MISSING_EVIDENCE).toBe(0);
    expect(summary.counts.UNKNOWN).toBe(0);
  });

  it("summary is serializable to JSON", () => {
    const summary = evaluateRegistryReadiness();
    const restored = JSON.parse(JSON.stringify(summary));
    expect(restored.reports).toHaveLength(summary.reports.length);
  });
});

// ================================================================
// 10. No execution
// ================================================================
describe("P1.6 Readiness Gate — no execution", () => {
  it("derivation is synchronous (no promises, no side effects)", () => {
    const report = deriveAdapterReadiness(fixture("loop_governor"));
    expect(report).not.toBeInstanceOf(Promise);
    expect(typeof report.status).toBe("string");
  });

  it("evaluateRegistryReadiness is synchronous", () => {
    const summary = evaluateRegistryReadiness();
    expect(summary).not.toBeInstanceOf(Promise);
  });

  it("readiness module exports no run/execute/deploy functions", async () => {
    const mod = await import("../src/agentRuntime/adapters/adapterReadiness.js");
    for (const key of Object.keys(mod)) {
      expect(key.toLowerCase()).not.toMatch(/run|execute|deploy|invoke|launch/);
    }
  });
});

// ================================================================
// 11. No regressions in the registry
// ================================================================
describe("P1.6 Readiness Gate — registry governance metadata", () => {
  for (const adapterId of AdapterIds) {
    it(adapterId + " has a complete governance section", () => {
      const r = getRegisteredAdapter(adapterId);
      const g = r.adapter!.governance;
      expect(g).toBeDefined();
      expect(["low", "medium", "high"]).toContain(g.riskLevel);
      expect(typeof g.requiresApproval).toBe("boolean");
      expect(g.allowedActions.length).toBeGreaterThan(0);
      expect(g.forbiddenActions.length).toBeGreaterThan(0);
      expect(g.evidenceRequirements.length).toBeGreaterThan(0);
      expect(g.validationCommands.length).toBeGreaterThan(0);
      expect(g.availability).toBe("available");
    });
  }

  it("no governance allows execution-like actions", () => {
    for (const meta of listRegisteredAdapters()) {
      for (const action of meta.governance.allowedActions) {
        expect(action).not.toMatch(/execute|run_|deploy|post|publish/);
      }
    }
  });
});
