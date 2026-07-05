// ── CHANTER Operator P1.5: Adapter Registry Tests ──
import { describe, expect, it } from "vitest";
import {
  AdapterIds,
  listRegisteredAdapters,
  getRegisteredAdapter,
  assertAdapterRegistered,
  getAdapterLifecycleMapping,
  getCatalog,
} from "../src/agentRuntime/adapters/adapterRegistry.js";
import type { AgentRuntimeAdapterId, AgentRuntimeAdapterMetadata } from "../src/agentRuntime/adapters/adapterRegistry.js";
import { AgentRunLifecycleStates } from "../src/agentRuntime/index.js";

// ================================================================
// 1. Registry lists all adapters
// ================================================================
describe("P1.5 Adapter Registry — listing", () => {
  it("lists exactly 3 registered adapters", () => {
    const adapters = listRegisteredAdapters();
    expect(adapters).toHaveLength(3);
  });

  it("includes Loop Governor", () => {
    const adapters = listRegisteredAdapters();
    expect(adapters.some((a) => a.adapterId === "loop_governor")).toBe(true);
  });

  it("includes SafeCommit", () => {
    const adapters = listRegisteredAdapters();
    expect(adapters.some((a) => a.adapterId === "safecommit")).toBe(true);
  });

  it("includes AutoPoster", () => {
    const adapters = listRegisteredAdapters();
    expect(adapters.some((a) => a.adapterId === "autoposter")).toBe(true);
  });

  it("AdapterIds has exactly 3 entries", () => {
    expect(AdapterIds).toEqual(["loop_governor", "safecommit", "autoposter"]);
  });
});

// ================================================================
// 2. contractOnly = true
// ================================================================
describe("P1.5 Adapter Registry — contractOnly", () => {
  for (const adapterId of AdapterIds) {
    it(adapterId + " has contractOnly: true", () => {
      const r = getRegisteredAdapter(adapterId);
      expect(r.ok).toBe(true);
      expect(r.adapter!.contractOnly).toBe(true);
    });
  }
});

// ================================================================
// 3. Lifecycle mapping
// ================================================================
describe("P1.5 Adapter Registry — lifecycle mapping", () => {
  for (const adapterId of AdapterIds) {
    it(adapterId + " has non-empty lifecycle mapping", () => {
      const mapping = getAdapterLifecycleMapping(adapterId);
      expect(mapping.length).toBeGreaterThan(0);
    });

    it(adapterId + " lifecycleStates equals all 6 AgentRunLifecycleStates", () => {
      const r = getRegisteredAdapter(adapterId);
      expect(r.adapter!.lifecycleStates).toEqual(AgentRunLifecycleStates);
    });

    it(adapterId + " all mapped lifecycle values are valid", () => {
      const mapping = getAdapterLifecycleMapping(adapterId);
      for (const m of mapping) {
        expect(AgentRunLifecycleStates).toContain(m.lifecycleState);
      }
    });

    it(adapterId + " has non-empty supportedSourceStates", () => {
      const r = getRegisteredAdapter(adapterId);
      expect(r.adapter!.supportedSourceStates.length).toBeGreaterThan(0);
    });
  }

  it("Loop Governor has 11 supported source states", () => {
    const r = getRegisteredAdapter("loop_governor");
    expect(r.adapter!.supportedSourceStates).toHaveLength(11);
  });

  it("SafeCommit has 14 supported source states", () => {
    const r = getRegisteredAdapter("safecommit");
    expect(r.adapter!.supportedSourceStates).toHaveLength(14);
  });

  it("AutoPoster has 19 supported source states", () => {
    const r = getRegisteredAdapter("autoposter");
    expect(r.adapter!.supportedSourceStates).toHaveLength(19);
  });
});

// ================================================================
// 4. Unknown adapter id rejection
// ================================================================
describe("P1.5 Adapter Registry — unknown id rejection", () => {
  it("getRegisteredAdapter rejects unknown adapter", () => {
    const r = getRegisteredAdapter("nonexistent_adapter");
    expect(r.ok).toBe(false);
    expect(r.adapter).toBeNull();
    expect(r.error).toContain("Unknown adapter id");
    expect(r.error).toContain("nonexistent_adapter");
  });

  it("assertAdapterRegistered throws on unknown adapter", () => {
    expect(() => assertAdapterRegistered("bogus_adapter")).toThrow(/Unknown adapter id/);
  });

  it("getAdapterLifecycleMapping returns empty array for unknown adapter", () => {
    const mapping = getAdapterLifecycleMapping("unknown");
    expect(mapping).toEqual([]);
  });

  it("getRegisteredAdapter rejects empty string", () => {
    const r = getRegisteredAdapter("");
    expect(r.ok).toBe(false);
    expect(r.adapter).toBeNull();
  });
});

// ================================================================
// 5. Docs path
// ================================================================
describe("P1.5 Adapter Registry — doc paths", () => {
  it("Loop Governor has doc path", () => {
    const r = getRegisteredAdapter("loop_governor");
    expect(r.adapter!.contractDocPath).toBe("docs/LOOP_GOVERNOR_ADAPTER_CONTRACT.md");
  });

  it("SafeCommit has doc path", () => {
    const r = getRegisteredAdapter("safecommit");
    expect(r.adapter!.contractDocPath).toBe("docs/SAFE_COMMIT_ADAPTER_CONTRACT.md");
  });

  it("AutoPoster has doc path", () => {
    const r = getRegisteredAdapter("autoposter");
    expect(r.adapter!.contractDocPath).toBe("docs/AUTOPOSTER_ADAPTER_CONTRACT.md");
  });
});

// ================================================================
// 6. Safety notes and exclusions
// ================================================================
describe("P1.5 Adapter Registry — safety notes / exclusions", () => {
  for (const adapterId of AdapterIds) {
    it(adapterId + " has safety notes", () => {
      const r = getRegisteredAdapter(adapterId);
      expect(r.adapter!.safetyNotes.length).toBeGreaterThan(0);
    });

    it(adapterId + " has exclusions", () => {
      const r = getRegisteredAdapter(adapterId);
      expect(r.adapter!.exclusions.length).toBeGreaterThan(0);
    });

    it(adapterId + " exclusions include execution", () => {
      const r = getRegisteredAdapter(adapterId);
      expect(
        r.adapter!.exclusions.some(
          (e) => e.category === "execution" && e.description.toLowerCase().includes("no"),
        ),
      ).toBe(true);
    });

    it(adapterId + " exclusions include cross-repo", () => {
      const r = getRegisteredAdapter(adapterId);
      expect(r.adapter!.exclusions.some((e) => e.category === "cross-repo")).toBe(true);
    });

    it(adapterId + " exclusions include deployment", () => {
      const r = getRegisteredAdapter(adapterId);
      expect(r.adapter!.exclusions.some((e) => e.category === "deployment")).toBe(true);
    });

    it(adapterId + " exclusions include agents", () => {
      const r = getRegisteredAdapter(adapterId);
      expect(r.adapter!.exclusions.some((e) => e.category === "agents")).toBe(true);
    });
  }

  it("SafeCommit has git exclusion", () => {
    const r = getRegisteredAdapter("safecommit");
    expect(r.adapter!.exclusions.some((e) => e.category === "git")).toBe(true);
  });

  it("AutoPoster has social-api exclusion", () => {
    const r = getRegisteredAdapter("autoposter");
    expect(r.adapter!.exclusions.some((e) => e.category === "social-api")).toBe(true);
  });

  it("AutoPoster has tokens exclusion", () => {
    const r = getRegisteredAdapter("autoposter");
    expect(r.adapter!.exclusions.some((e) => e.category === "tokens")).toBe(true);
  });
});

// ================================================================
// 7. No metadata contains live execution claims
// ================================================================
describe("P1.5 Adapter Registry — no live execution claims in metadata", () => {
  it("no adapter safetyNotes mention live execution", () => {
    for (const adapterId of AdapterIds) {
      const r = getRegisteredAdapter(adapterId);
      for (const note of r.adapter!.safetyNotes) {
        expect(note).not.toMatch(/live execution|real execution/i);
      }
    }
  });

  it("all adapters have display names", () => {
    for (const adapterId of AdapterIds) {
      const r = getRegisteredAdapter(adapterId);
      expect(r.adapter!.displayName.length).toBeGreaterThan(0);
    }
  });

  it("all adapters have hasSampleFixture: true", () => {
    for (const adapterId of AdapterIds) {
      const r = getRegisteredAdapter(adapterId);
      expect(r.adapter!.hasSampleFixture).toBe(true);
    }
  });
});

// ================================================================
// 8. Registry does not execute adapters
// ================================================================
describe("P1.5 Adapter Registry — no execution", () => {
  it("listRegisteredAdapters is synchronous", () => {
    const result = listRegisteredAdapters();
    expect(Array.isArray(result)).toBe(true);
  });

  it("getRegisteredAdapter is synchronous", () => {
    const result = getRegisteredAdapter("loop_governor");
    expect(result.ok).toBe(true);
  });

  it("getAdapterLifecycleMapping is synchronous", () => {
    const mapping = getAdapterLifecycleMapping("loop_governor");
    expect(Array.isArray(mapping)).toBe(true);
    expect(mapping.length).toBe(11);
  });

  it("catalog is serializable to JSON", () => {
    const catalog = getCatalog();
    const json = JSON.stringify(catalog);
    const restored = JSON.parse(json);
    expect(restored.version).toBe(1);
    expect(Object.keys(restored.adapters)).toHaveLength(3);
  });
});

// ================================================================
// 9. Catalog integrity
// ================================================================
describe("P1.5 Adapter Registry — catalog integrity", () => {
  it("getCatalog returns all 3 adapters keyed by id", () => {
    const catalog = getCatalog();
    expect(catalog.adapters.loop_governor).toBeDefined();
    expect(catalog.adapters.safecommit).toBeDefined();
    expect(catalog.adapters.autoposter).toBeDefined();
    expect(catalog.adapters.loop_governor.adapterId).toBe("loop_governor");
    expect(catalog.adapters.safecommit.adapterId).toBe("safecommit");
    expect(catalog.adapters.autoposter.adapterId).toBe("autoposter");
  });

  it("catalog has assembledAt timestamp", () => {
    const catalog = getCatalog();
    expect(catalog.assembledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("catalog version is 1", () => {
    const catalog = getCatalog();
    expect(catalog.version).toBe(1);
  });

  it("assertAdapterRegistered returns metadata for all 3", () => {
    for (const adapterId of AdapterIds) {
      const meta = assertAdapterRegistered(adapterId);
      expect(meta.adapterId).toBe(adapterId);
    }
  });

  it("all productIds are unique", () => {
    const adapters = listRegisteredAdapters();
    const productIds = adapters.map((a) => a.productId);
    expect(new Set(productIds).size).toBe(adapters.length);
  });

  it("all adapterIds match their metadata", () => {
    const adapters = listRegisteredAdapters();
    for (const a of adapters) {
      expect(a.adapterId).toBeDefined();
      expect(a.productId).toBeDefined();
      // adapterId should be a valid AdapterIds entry
      expect(AdapterIds).toContain(a.adapterId);
    }
  });
});

// ================================================================
// 10. No regressions
// ================================================================
describe("P1.5 Adapter Registry — no regressions", () => {
  it("Loop Governor adapter still works", async () => {
    const { mapLoopGovernorRunToManifest } = await import(
      "../src/agentRuntime/adapters/loopGovernorAdapter.js"
    );
    expect(mapLoopGovernorRunToManifest({ loopId: "LG-SMOKE", taskId: "t", state: "planned" }).ok).toBe(true);
  });

  it("SafeCommit adapter still works", async () => {
    const { mapSafeCommitReviewToManifest } = await import(
      "../src/agentRuntime/adapters/safeCommitAdapter.js"
    );
    expect(mapSafeCommitReviewToManifest({ reviewId: "SC-SMOKE", taskId: "t", state: "review_created" }).ok).toBe(true);
  });

  it("AutoPoster adapter still works", async () => {
    const { mapAutoPosterRunToManifest } = await import(
      "../src/agentRuntime/adapters/autoPosterAdapter.js"
    );
    expect(mapAutoPosterRunToManifest({ taskId: "t", state: "campaign_created" }).ok).toBe(true);
  });

  it("agentRuntime types still importable", async () => {
    const mod = await import("../src/agentRuntime/index.js");
    expect(mod.MockAgentRuntime).toBeDefined();
  });
});
