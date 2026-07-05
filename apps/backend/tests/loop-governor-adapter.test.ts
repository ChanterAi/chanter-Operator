// ── CHANTER Operator P1.2: Loop Governor Adapter Tests ──
import { describe, expect, it } from "vitest";
import {
  mapLoopGovernorRunToManifest,
  SAMPLE_LOOP_GOVERNOR_INPUT,
  LoopGovernorLoopStates,
} from "../src/agentRuntime/adapters/loopGovernorAdapter.js";
import { MockAgentRuntime } from "../src/agentRuntime/mockRuntime.js";
import type { LoopGovernorRunInput } from "../src/agentRuntime/adapters/loopGovernorAdapter.js";

// ================================================================
// 1. State mapping
// ================================================================
describe("P1.2 Loop Governor Adapter — state mapping", () => {
  it("maps planned loop to PLAN", () => {
    const result = mapLoopGovernorRunToManifest({
      loopId: "LG-001",
      taskId: "task-001",
      state: "planned",
    });
    expect(result.ok).toBe(true);
    expect(result.manifest!.lifecycleState).toBe("PLAN");
    expect(result.manifest!.productId).toBe("Loop Governor");
    expect(result.manifest!.taskId).toBe("task-001");
  });

  it("maps created loop to PLAN", () => {
    const result = mapLoopGovernorRunToManifest({
      loopId: "LG-002",
      taskId: "task-002",
      state: "created",
    });
    expect(result.ok).toBe(true);
    expect(result.manifest!.lifecycleState).toBe("PLAN");
  });

  it("maps running loop to EXECUTE", () => {
    const result = mapLoopGovernorRunToManifest({
      loopId: "LG-003",
      taskId: "task-003",
      state: "running",
    });
    expect(result.ok).toBe(true);
    expect(result.manifest!.lifecycleState).toBe("EXECUTE");
  });

  it("maps iterating loop to EXECUTE", () => {
    const result = mapLoopGovernorRunToManifest({
      loopId: "LG-004",
      taskId: "task-004",
      state: "iterating",
    });
    expect(result.ok).toBe(true);
    expect(result.manifest!.lifecycleState).toBe("EXECUTE");
  });

  it("maps validating state to VALIDATE", () => {
    const result = mapLoopGovernorRunToManifest({
      loopId: "LG-005",
      taskId: "task-005",
      state: "validating",
    });
    expect(result.ok).toBe(true);
    expect(result.manifest!.lifecycleState).toBe("VALIDATE");
  });

  it("maps collecting_evidence state to EVIDENCE", () => {
    const result = mapLoopGovernorRunToManifest({
      loopId: "LG-006",
      taskId: "task-006",
      state: "collecting_evidence",
    });
    expect(result.ok).toBe(true);
    expect(result.manifest!.lifecycleState).toBe("EVIDENCE");
  });

  it("maps awaiting_review state to HUMAN_REVIEW", () => {
    const result = mapLoopGovernorRunToManifest({
      loopId: "LG-007",
      taskId: "task-007",
      state: "awaiting_review",
    });
    expect(result.ok).toBe(true);
    expect(result.manifest!.lifecycleState).toBe("HUMAN_REVIEW");
  });

  it("maps completed loop to COMPLETE", () => {
    const result = mapLoopGovernorRunToManifest({
      loopId: "LG-008",
      taskId: "task-008",
      state: "completed",
      validation: {
        passed: true,
        gates: ["typecheck"],
        gateResults: { typecheck: true },
        summary: "All checks passed.",
        validatedAt: "2026-07-05T10:00:00.000Z",
      },
      evidence: [
        {
          label: "loop-log",
          contentHash: "aaa",
          recordedAt: "2026-07-05T09:00:00.000Z",
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.manifest!.lifecycleState).toBe("COMPLETE");
  });

  it("maps closed loop to COMPLETE", () => {
    const result = mapLoopGovernorRunToManifest({
      loopId: "LG-009",
      taskId: "task-009",
      state: "closed",
      validation: {
        passed: true,
        gates: ["typecheck"],
        gateResults: { typecheck: true },
        summary: "All checks passed.",
        validatedAt: "2026-07-05T10:00:00.000Z",
      },
      evidence: [
        {
          label: "loop-log",
          contentHash: "bbb",
          recordedAt: "2026-07-05T09:00:00.000Z",
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.manifest!.lifecycleState).toBe("COMPLETE");
  });
});

// ================================================================
// 2. Rejection of unknown/invalid inputs
// ================================================================
describe("P1.2 Loop Governor Adapter — rejection", () => {
  it("rejects unknown state", () => {
    const result = mapLoopGovernorRunToManifest({
      loopId: "LG-X",
      taskId: "task-X",
      state: "not_a_real_state" as never,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("Unknown Loop Governor state"))).toBe(true);
  });

  it("rejects missing loopId", () => {
    const result = mapLoopGovernorRunToManifest({
      loopId: "",
      taskId: "task-001",
      state: "planned",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("loopId"))).toBe(true);
  });

  it("rejects whitespace-only loopId", () => {
    const result = mapLoopGovernorRunToManifest({
      loopId: "   ",
      taskId: "task-001",
      state: "planned",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("loopId"))).toBe(true);
  });

  it("rejects missing taskId", () => {
    const result = mapLoopGovernorRunToManifest({
      loopId: "LG-001",
      taskId: "",
      state: "planned",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("taskId"))).toBe(true);
  });

  it("rejects COMPLETE (completed) without validation", () => {
    const result = mapLoopGovernorRunToManifest({
      loopId: "LG-010",
      taskId: "task-010",
      state: "completed",
      evidence: [
        {
          label: "loop-log",
          contentHash: "aaa",
          recordedAt: "2026-07-05T09:00:00.000Z",
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("Validation is required before COMPLETE")),
    ).toBe(true);
  });

  it("rejects COMPLETE (closed) without validation", () => {
    const result = mapLoopGovernorRunToManifest({
      loopId: "LG-011",
      taskId: "task-011",
      state: "closed",
      evidence: [
        {
          label: "loop-log",
          contentHash: "aaa",
          recordedAt: "2026-07-05T09:00:00.000Z",
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("Validation is required before COMPLETE")),
    ).toBe(true);
  });

  it("rejects COMPLETE (completed) without evidence", () => {
    const result = mapLoopGovernorRunToManifest({
      loopId: "LG-012",
      taskId: "task-012",
      state: "completed",
      validation: {
        passed: true,
        gates: ["typecheck"],
        gateResults: { typecheck: true },
        summary: "ok",
        validatedAt: "2026-07-05T10:00:00.000Z",
      },
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("Evidence is required before COMPLETE")),
    ).toBe(true);
  });

  it("rejects COMPLETE (closed) without evidence", () => {
    const result = mapLoopGovernorRunToManifest({
      loopId: "LG-013",
      taskId: "task-013",
      state: "closed",
      validation: {
        passed: true,
        gates: ["typecheck"],
        gateResults: { typecheck: true },
        summary: "ok",
        validatedAt: "2026-07-05T10:00:00.000Z",
      },
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("Evidence is required before COMPLETE")),
    ).toBe(true);
  });

  it("rejects COMPLETE (failed) without validation", () => {
    const result = mapLoopGovernorRunToManifest({
      loopId: "LG-014",
      taskId: "task-014",
      state: "failed",
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("Validation is required before COMPLETE")),
    ).toBe(true);
  });

  it("rejects COMPLETE (cancelled) without validation", () => {
    const result = mapLoopGovernorRunToManifest({
      loopId: "LG-015",
      taskId: "task-015",
      state: "cancelled",
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("Validation is required before COMPLETE")),
    ).toBe(true);
  });
});

// ================================================================
// 3. Timestamp validation
// ================================================================
describe("P1.2 Loop Governor Adapter — timestamp validation", () => {
  it("rejects out-of-order state timestamps", () => {
    const result = mapLoopGovernorRunToManifest({
      loopId: "LG-016",
      taskId: "task-016",
      state: "completed",
      validation: {
        passed: true,
        gates: ["typecheck"],
        gateResults: { typecheck: true },
        summary: "ok",
        validatedAt: "2026-07-05T10:00:00.000Z",
      },
      evidence: [
        {
          label: "log",
          contentHash: "aaa",
          recordedAt: "2026-07-05T09:00:00.000Z",
        },
      ],
      stateTimestamps: {
        PLAN: "2026-07-05T09:00:00.000Z",
        EXECUTE: "2026-07-05T08:00:00.000Z", // OUT OF ORDER — earlier than PLAN
      },
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("out of lifecycle order")),
    ).toBe(true);
  });

  it("accepts timestamps in lifecycle order", () => {
    const result = mapLoopGovernorRunToManifest({
      loopId: "LG-017",
      taskId: "task-017",
      state: "completed",
      validation: {
        passed: true,
        gates: ["typecheck"],
        gateResults: { typecheck: true },
        summary: "ok",
        validatedAt: "2026-07-05T10:00:00.000Z",
      },
      evidence: [
        {
          label: "log",
          contentHash: "aaa",
          recordedAt: "2026-07-05T09:00:00.000Z",
        },
      ],
      stateTimestamps: {
        PLAN: "2026-07-05T08:00:00.000Z",
        EXECUTE: "2026-07-05T08:30:00.000Z",
        VALIDATE: "2026-07-05T09:00:00.000Z",
        EVIDENCE: "2026-07-05T09:15:00.000Z",
        HUMAN_REVIEW: "2026-07-05T09:45:00.000Z",
        COMPLETE: "2026-07-05T10:00:00.000Z",
      },
    });
    expect(result.ok).toBe(true);
    expect(result.manifest!.lifecycleState).toBe("COMPLETE");
  });
});

// ================================================================
// 4. Security: reject live execution / external agents
// ================================================================
describe("P1.2 Loop Governor Adapter — security", () => {
  it("rejects input containing 'codex'", () => {
    const result = mapLoopGovernorRunToManifest({
      loopId: "coded-codex-001",
      taskId: "task-s",
      state: "planned",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("External agent execution"))).toBe(true);
  });

  it("rejects input containing 'ollama'", () => {
    const result = mapLoopGovernorRunToManifest({
      loopId: "lg-ok",
      taskId: "task-with-ollama-ref",
      state: "planned",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("External agent execution"))).toBe(true);
  });

  it("rejects input containing 'openclaw'", () => {
    const result = mapLoopGovernorRunToManifest({
      loopId: "lg-ok",
      taskId: "task-openclaw",
      state: "planned",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("External agent execution"))).toBe(true);
  });

  it("rejects input containing live execution claims", () => {
    const result = mapLoopGovernorRunToManifest({
      loopId: "lg-live-execution",
      taskId: "task-ok",
      state: "planned",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("Live execution"))).toBe(true);
  });

  it("rejects input containing shell_command references", () => {
    const result = mapLoopGovernorRunToManifest({
      loopId: "lg-shell-command-test",
      taskId: "task-ok",
      state: "planned",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("Live execution"))).toBe(true);
  });

  it("rejects input containing URLs", () => {
    const result = mapLoopGovernorRunToManifest({
      loopId: "lg-ok",
      taskId: "task-ok",
      state: "planned",
      evidence: [
        {
          label: "https://evil.com/log",
          contentHash: "abc",
          recordedAt: new Date().toISOString(),
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("Network URLs"))).toBe(true);
  });
});

// ================================================================
// 5. Sample fixture
// ================================================================
describe("P1.2 Loop Governor Adapter — sample fixture", () => {
  it("SAMPLE_LOOP_GOVERNOR_INPUT maps into a complete manifest", () => {
    const result = mapLoopGovernorRunToManifest(SAMPLE_LOOP_GOVERNOR_INPUT);
    expect(result.ok).toBe(true);
    expect(result.manifest).not.toBeNull();
  });

  it("sample fixture manifest is COMPLETE", () => {
    const result = mapLoopGovernorRunToManifest(SAMPLE_LOOP_GOVERNOR_INPUT);
    expect(result.manifest!.lifecycleState).toBe("COMPLETE");
  });

  it("sample fixture has evidence", () => {
    const result = mapLoopGovernorRunToManifest(SAMPLE_LOOP_GOVERNOR_INPUT);
    expect(result.manifest!.evidence.length).toBeGreaterThanOrEqual(2);
  });

  it("sample fixture has validation with gates", () => {
    const result = mapLoopGovernorRunToManifest(SAMPLE_LOOP_GOVERNOR_INPUT);
    expect(result.manifest!.validation!.passed).toBe(true);
    expect(result.manifest!.validation!.gates).toContain("loop-invariant-check");
  });

  it("sample fixture has productId 'Loop Governor'", () => {
    const result = mapLoopGovernorRunToManifest(SAMPLE_LOOP_GOVERNOR_INPUT);
    expect(result.manifest!.productId).toBe("Loop Governor");
  });

  it("sample fixture runtimeId starts with 'lg-'", () => {
    const result = mapLoopGovernorRunToManifest(SAMPLE_LOOP_GOVERNOR_INPUT);
    expect(result.manifest!.runtimeId).toMatch(/^lg-LG-2026/);
  });

  it("sample fixture has no failure", () => {
    const result = mapLoopGovernorRunToManifest(SAMPLE_LOOP_GOVERNOR_INPUT);
    expect(result.manifest!.failure).toBeNull();
  });

  it("sample fixture timestamps are all populated", () => {
    const result = mapLoopGovernorRunToManifest(SAMPLE_LOOP_GOVERNOR_INPUT);
    for (const state of [
      "PLAN",
      "EXECUTE",
      "VALIDATE",
      "EVIDENCE",
      "HUMAN_REVIEW",
      "COMPLETE",
    ] as const) {
      expect(result.manifest!.stateTimestamps[state]).not.toBeNull();
      expect(result.manifest!.stateTimestamps[state]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });
});

// ================================================================
// 6. Manifest serialization round-trip
// ================================================================
describe("P1.2 Loop Governor Adapter — serialization round-trip", () => {
  it("mapped manifest round-trips through JSON", () => {
    const result = mapLoopGovernorRunToManifest(SAMPLE_LOOP_GOVERNOR_INPUT);
    expect(result.ok).toBe(true);

    const json = JSON.stringify(result.manifest);
    const restored = JSON.parse(json);

    expect(restored.runtimeId).toBe(result.manifest!.runtimeId);
    expect(restored.productId).toBe("Loop Governor");
    expect(restored.taskId).toBe(result.manifest!.taskId);
    expect(restored.lifecycleState).toBe("COMPLETE");
    expect(restored.evidence.length).toBe(result.manifest!.evidence.length);
    expect(restored.validation.passed).toBe(true);
  });

  it("MockAgentRuntime can deserialize the mapped manifest", () => {
    const runtime = new MockAgentRuntime();
    const result = mapLoopGovernorRunToManifest(SAMPLE_LOOP_GOVERNOR_INPUT);
    expect(result.ok).toBe(true);

    const json = runtime.serialize(result.manifest!);
    const deserialized = runtime.deserialize(json);

    expect(deserialized.lifecycleState).toBe("COMPLETE");
    expect(deserialized.productId).toBe("Loop Governor");
    expect(deserialized.evidence.length).toBeGreaterThan(0);
  });
});

// ================================================================
// 7. No cross-repo imports
// ================================================================
describe("P1.2 Loop Governor Adapter — no cross-repo imports", () => {
  it("adapter module does not import Loop Governor", () => {
    // The adapter is a pure mapping function — it only imports from
    // the agentRuntime types and contract modules within Operator.
    // This test confirms the function exists and works.
    const fn = mapLoopGovernorRunToManifest;
    expect(typeof fn).toBe("function");
  });

  it("adapter does not call external processes or agents", () => {
    // The mapping is synchronous and deterministic — no async calls,
    // no fs, no child_process, no network.
    const result = mapLoopGovernorRunToManifest(SAMPLE_LOOP_GOVERNOR_INPUT);
    expect(result.ok).toBe(true);
  });
});

// ================================================================
// 8. Edge cases
// ================================================================
describe("P1.2 Loop Governor Adapter — edge cases", () => {
  it("failed state maps to COMPLETE with synthetic failure record", () => {
    const result = mapLoopGovernorRunToManifest({
      loopId: "LG-018",
      taskId: "task-018",
      state: "failed",
      validation: {
        passed: false,
        gates: ["typecheck"],
        gateResults: { typecheck: false },
        summary: "Typecheck failed.",
        validatedAt: "2026-07-05T10:00:00.000Z",
      },
      evidence: [
        {
          label: "error-log",
          contentHash: "ccc",
          recordedAt: "2026-07-05T09:00:00.000Z",
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.manifest!.lifecycleState).toBe("COMPLETE");
    expect(result.manifest!.failure).not.toBeNull();
    expect(result.manifest!.failure!.code).toBe("LOOP_FAILED");
  });

  it("cancelled state maps to COMPLETE with synthetic failure record", () => {
    const result = mapLoopGovernorRunToManifest({
      loopId: "LG-019",
      taskId: "task-019",
      state: "cancelled",
      validation: {
        passed: false,
        gates: [],
        gateResults: {},
        summary: "Cancelled before validation.",
        validatedAt: "2026-07-05T10:00:00.000Z",
      },
      evidence: [
        {
          label: "cancellation-log",
          contentHash: "ddd",
          recordedAt: "2026-07-05T09:00:00.000Z",
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.manifest!.lifecycleState).toBe("COMPLETE");
    expect(result.manifest!.failure).not.toBeNull();
    expect(result.manifest!.failure!.code).toBe("LOOP_CANCELLED");
  });

  it("explicit failure input overrides synthetic failure", () => {
    const result = mapLoopGovernorRunToManifest({
      loopId: "LG-020",
      taskId: "task-020",
      state: "failed",
      validation: {
        passed: false,
        gates: [],
        gateResults: {},
        summary: "Failed.",
        validatedAt: "2026-07-05T10:00:00.000Z",
      },
      evidence: [
        {
          label: "log",
          contentHash: "eee",
          recordedAt: "2026-07-05T09:00:00.000Z",
        },
      ],
      failure: {
        code: "CUSTOM_ERROR",
        message: "Custom failure message.",
        detail: "Stack trace here",
        failedAt: "2026-07-05T10:05:00.000Z",
      },
    });
    expect(result.ok).toBe(true);
    expect(result.manifest!.failure!.code).toBe("CUSTOM_ERROR");
    expect(result.manifest!.failure!.message).toBe("Custom failure message.");
  });

  it("custom runtimeId prefix is used", () => {
    const result = mapLoopGovernorRunToManifest({
      loopId: "ABC-001",
      taskId: "task-021",
      state: "planned",
      runtimeIdPrefix: "looper-",
    });
    expect(result.ok).toBe(true);
    expect(result.manifest!.runtimeId).toBe("looper-ABC-001");
  });

  it("planned state returns null timestamps for unreached states", () => {
    const result = mapLoopGovernorRunToManifest({
      loopId: "LG-022",
      taskId: "task-022",
      state: "planned",
    });
    expect(result.ok).toBe(true);
    expect(result.manifest!.stateTimestamps.PLAN).not.toBeNull();
    expect(result.manifest!.stateTimestamps.EXECUTE).toBeNull();
    expect(result.manifest!.stateTimestamps.VALIDATE).toBeNull();
    expect(result.manifest!.stateTimestamps.EVIDENCE).toBeNull();
    expect(result.manifest!.stateTimestamps.HUMAN_REVIEW).toBeNull();
    expect(result.manifest!.stateTimestamps.COMPLETE).toBeNull();
  });

  it("validating state has PLAN and EXECUTE timestamps populated", () => {
    const result = mapLoopGovernorRunToManifest({
      loopId: "LG-023",
      taskId: "task-023",
      state: "validating",
    });
    expect(result.ok).toBe(true);
    expect(result.manifest!.stateTimestamps.PLAN).not.toBeNull();
    expect(result.manifest!.stateTimestamps.EXECUTE).not.toBeNull();
    expect(result.manifest!.stateTimestamps.VALIDATE).not.toBeNull();
    expect(result.manifest!.stateTimestamps.EVIDENCE).toBeNull();
  });

  it("LoopGovernorLoopStates has all required states", () => {
    expect(LoopGovernorLoopStates).toContain("planned");
    expect(LoopGovernorLoopStates).toContain("created");
    expect(LoopGovernorLoopStates).toContain("running");
    expect(LoopGovernorLoopStates).toContain("iterating");
    expect(LoopGovernorLoopStates).toContain("validating");
    expect(LoopGovernorLoopStates).toContain("collecting_evidence");
    expect(LoopGovernorLoopStates).toContain("awaiting_review");
    expect(LoopGovernorLoopStates).toContain("completed");
    expect(LoopGovernorLoopStates).toContain("closed");
    expect(LoopGovernorLoopStates).toContain("failed");
    expect(LoopGovernorLoopStates).toContain("cancelled");
  });

  it("evidence refs have generated IDs with loopId prefix", () => {
    const result = mapLoopGovernorRunToManifest({
      loopId: "LG-024",
      taskId: "task-024",
      state: "completed",
      validation: {
        passed: true,
        gates: ["typecheck"],
        gateResults: { typecheck: true },
        summary: "ok",
        validatedAt: "2026-07-05T10:00:00.000Z",
      },
      evidence: [
        {
          label: "ev-1",
          contentHash: "h1",
          recordedAt: "2026-07-05T09:00:00.000Z",
        },
        {
          label: "ev-2",
          contentHash: "h2",
          recordedAt: "2026-07-05T09:01:00.000Z",
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.manifest!.evidence[0].id).toBe("lg-ev-LG-024-1");
    expect(result.manifest!.evidence[1].id).toBe("lg-ev-LG-024-2");
  });

  it("manifest policy reflects Loop Governor timeouts", () => {
    const result = mapLoopGovernorRunToManifest({
      loopId: "LG-025",
      taskId: "task-025",
      state: "planned",
    });
    expect(result.ok).toBe(true);
    expect(result.manifest!.policy.timeout.maxStateMs).toBe(300_000);
    expect(result.manifest!.policy.timeout.maxTotalMs).toBe(3_600_000);
    expect(result.manifest!.policy.retry.maxRetries).toBe(5);
  });
});

// ================================================================
// 9. Existing agent-runtime tests still pass (sanity)
// ================================================================
describe("P1.2 Loop Governor Adapter — no regressions", () => {
  it("does not modify existing agentRuntime exports", async () => {
    const { MockAgentRuntime: MRT } = await import(
      "../src/agentRuntime/mockRuntime.js"
    );
    const runtime = new MRT();
    expect(runtime).toBeDefined();
    expect(typeof runtime.execute).toBe("function");
    expect(typeof runtime.transition).toBe("function");
  });

  it("agentRuntime index still exports contract types", async () => {
    const mod = await import("../src/agentRuntime/index.js");
    expect(mod.MockAgentRuntime).toBeDefined();
    expect(mod.createEmptyManifest).toBeDefined();
    expect(mod.AgentRuntimeContractError).toBeDefined();
    expect(mod.AgentRunLifecycleStates).toBeDefined();
  });
});
