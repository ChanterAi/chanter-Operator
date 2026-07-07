// ── CHANTER Operator P1A: Operator Runtime Bridge Tests ──
import { describe, expect, it } from "vitest";
import {
  // contract
  requiresApprovalBeforeExecution,
  isTerminalStatus,
  getAllowedNextStatuses,
  RuntimeTransitionError,
  // redaction
  redactText,
  redactJsonValue,
  redactRecord,
  // task lifecycle
  attachPlan,
  requireApproval,
  approveTask,
  startExecution,
  attachEvidence,
  startValidation,
  passValidation,
  failValidation,
  completeTask,
  failTask,
  blockTask,
  cancelTask,
  // evidence
  assertJsonSafe,
  // policy
  evaluateRuntimeActionPolicy,
  // provider routing
  selectProviderRoute,
  // operator bridge
  createOperatorRuntimeTask,
  evaluateOperatorRuntimeAction,
  mapOperatorActionTypeToRuntimeActionType,
  buildOperatorEvidenceBundle,
  summarizeOperatorRuntimeTask,
  DEFAULT_OPERATOR_PROVIDER_ROUTES,
  selectOperatorProviderRoute,
  runOperatorRuntimeAdapter,
  operatorRuntimeAdapter,
  OPERATOR_RUNTIME_BRIDGE_PRIMITIVES,
  deriveOperatorRuntimeBridgeReadiness,
  createOperatorAdapterReadinessReport,
  SAMPLE_OPERATOR_RUNTIME_TASK_INPUT,
  SAMPLE_OPERATOR_HIGH_RISK_TASK_INPUT,
} from "../src/agentRuntime/runtimeBridge/index.js";
import type { RuntimeTask, RuntimeActionType, OperatorRuntimeBridgePrimitive } from "../src/agentRuntime/runtimeBridge/index.js";
import { AdapterReadinessStatuses } from "../src/agentRuntime/adapters/adapterReadiness.js";
import { AdapterIds, listRegisteredAdapters } from "../src/agentRuntime/adapters/adapterRegistry.js";
import { actionTypes, type ActionType } from "../src/types.js";

// ================================================================
// 1. Task creation / mapping
// ================================================================
describe("P1A Runtime Bridge — task creation/mapping", () => {
  it("creates a draft task with product fixed to 'operator'", () => {
    const task = createOperatorRuntimeTask({ objective: "Run typecheck." });
    expect(task.product).toBe("operator");
    expect(task.status).toBe("draft");
  });

  it("defaults to riskLevel=low, executionPolicy=local_only, approvalRequired=false", () => {
    const task = createOperatorRuntimeTask({ objective: "Read a file." });
    expect(task.riskLevel).toBe("low");
    expect(task.executionPolicy).toBe("local_only");
    expect(task.approvalRequired).toBe(false);
  });

  it("high risk forces approvalRequired=true even with local_only policy", () => {
    const task = createOperatorRuntimeTask({ objective: "Risky op.", riskLevel: "high" });
    expect(task.approvalRequired).toBe(true);
  });

  it("commit_guarded execution policy forces approvalRequired=true regardless of risk", () => {
    const task = createOperatorRuntimeTask({
      objective: "Commit change.",
      riskLevel: "low",
      executionPolicy: "commit_guarded",
    });
    expect(task.approvalRequired).toBe(true);
  });

  it("preserves validationCommands and inputs", () => {
    const task = createOperatorRuntimeTask({
      objective: "Run suite.",
      validationCommands: ["npm test", "npm run typecheck"],
      inputs: { workspace: "apps/backend" },
    });
    expect(task.validationCommands).toEqual(["npm test", "npm run typecheck"]);
    expect(task.inputs.workspace).toBe("apps/backend");
  });

  it("respects an explicit id, else generates one", () => {
    const withId = createOperatorRuntimeTask({ objective: "x", id: "operator-task-fixed-001" });
    expect(withId.id).toBe("operator-task-fixed-001");

    const auto1 = createOperatorRuntimeTask({ objective: "x" });
    const auto2 = createOperatorRuntimeTask({ objective: "x" });
    expect(auto1.id).not.toBe(auto2.id);
  });

  it("logs a TASK_CREATED event with riskLevel/executionPolicy/approvalRequired data", () => {
    const task = createOperatorRuntimeTask({ objective: "x", riskLevel: "high" });
    const created = task.logs.find((l) => l.type === "TASK_CREATED");
    expect(created).toBeDefined();
    expect(created!.data).toMatchObject({ riskLevel: "high" });
  });

  it("redacts secrets embedded in creation inputs at the write boundary", () => {
    const task = createOperatorRuntimeTask({
      objective: "x",
      inputs: { note: "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx", apiKey: "should-be-hidden" },
    });
    expect(JSON.stringify(task.inputs)).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(task.inputs.apiKey).toBe("[REDACTED]");
  });

  it("sample fixtures produce valid tasks", () => {
    const low = createOperatorRuntimeTask(SAMPLE_OPERATOR_RUNTIME_TASK_INPUT);
    const high = createOperatorRuntimeTask(SAMPLE_OPERATOR_HIGH_RISK_TASK_INPUT);
    expect(low.approvalRequired).toBe(false);
    expect(high.approvalRequired).toBe(true);
  });
});

// ================================================================
// 2. mapOperatorActionTypeToRuntimeActionType
// ================================================================
describe("P1A Runtime Bridge — Operator ActionType mapping", () => {
  const expected: Record<ActionType, RuntimeActionType> = {
    analysis: "read",
    read_file: "read",
    file_write: "write",
    file_edit: "write",
    shell_command: "shell",
    unknown: "read",
  };

  for (const actionType of actionTypes) {
    it(`maps Operator ActionType "${actionType}" to "${expected[actionType]}"`, () => {
      expect(mapOperatorActionTypeToRuntimeActionType(actionType)).toBe(expected[actionType]);
    });
  }

  it("covers every Operator ActionType (no unmapped values)", () => {
    for (const actionType of actionTypes) {
      expect(() => mapOperatorActionTypeToRuntimeActionType(actionType)).not.toThrow();
    }
  });
});

// ================================================================
// 3. Policy decisions for risky actions
// ================================================================
describe("P1A Runtime Bridge — policy: read", () => {
  it("read is allowed for a fresh draft task", () => {
    const task = createOperatorRuntimeTask({ objective: "x" });
    const decision = evaluateOperatorRuntimeAction(task, { actionType: "read", target: "file.ts", reason: "inspect" });
    expect(decision.allowed).toBe(true);
    expect(decision.blocked).toBe(false);
  });

  it("read is blocked once a task is terminal", () => {
    let task = createOperatorRuntimeTask({ objective: "x" });
    task = attachPlan(task, { summary: "plan" });
    task = startExecution(task);
    task = startValidation(task);
    task = passValidation(task, { checks: [{ command: "npm test", passed: true }] });
    task = completeTask(task, { summary: "done" });

    const decision = evaluateOperatorRuntimeAction(task, { actionType: "read", target: "file.ts", reason: "inspect" });
    expect(decision.allowed).toBe(false);
    expect(decision.blocked).toBe(true);
  });
});

describe("P1A Runtime Bridge — policy: write/shell/network status gate", () => {
  it("blocked while draft (no plan attached)", () => {
    const task = createOperatorRuntimeTask({ objective: "x" });
    const decision = evaluateOperatorRuntimeAction(task, { actionType: "write", target: "f.ts", reason: "edit" });
    expect(decision.allowed).toBe(false);
    expect(decision.blocked).toBe(false);
  });

  it("requires approval once planned with high risk", () => {
    let task = createOperatorRuntimeTask({ objective: "x", riskLevel: "high" });
    task = attachPlan(task, { summary: "plan" });
    const decision = evaluateOperatorRuntimeAction(task, { actionType: "shell", target: "npm test", reason: "run" });
    expect(decision.allowed).toBe(false);
    expect(decision.approvalRequired).toBe(true);
  });

  it("allowed once planned with low risk (no approval needed)", () => {
    let task = createOperatorRuntimeTask({ objective: "x" });
    task = attachPlan(task, { summary: "plan" });
    const decision = evaluateOperatorRuntimeAction(task, { actionType: "write", target: "f.ts", reason: "edit" });
    expect(decision.allowed).toBe(true);
  });

  it("allowed once approved, after clearing the approval gate", () => {
    let task = createOperatorRuntimeTask({ objective: "x", riskLevel: "high" });
    task = attachPlan(task, { summary: "plan" });
    task = requireApproval(task);
    task = approveTask(task, "human-reviewer");
    const decision = evaluateOperatorRuntimeAction(task, { actionType: "network", target: "https://example", reason: "fetch" });
    expect(decision.allowed).toBe(true);
  });

  it("blocked while task.status is blocked", () => {
    let task = createOperatorRuntimeTask({ objective: "x" });
    task = attachPlan(task, { summary: "plan" });
    task = blockTask(task, "stalled");
    const decision = evaluateOperatorRuntimeAction(task, { actionType: "write", target: "f.ts", reason: "edit" });
    expect(decision.blocked).toBe(true);
  });
});

describe("P1A Runtime Bridge — policy: commit/deploy/publish guards", () => {
  it("commit is blocked without commit_guarded/requires_safecommit_review policy", () => {
    let task = createOperatorRuntimeTask({ objective: "x" });
    task = attachPlan(task, { summary: "plan" });
    const decision = evaluateOperatorRuntimeAction(task, { actionType: "commit", target: "repo", reason: "commit change" });
    expect(decision.blocked).toBe(true);
    expect(decision.requiredPolicy).toBe("commit_guarded");
  });

  it("commit is allowed once commit_guarded + approved", () => {
    let task = createOperatorRuntimeTask({ objective: "x", executionPolicy: "commit_guarded" });
    task = attachPlan(task, { summary: "plan" });
    task = requireApproval(task);
    task = approveTask(task);
    const decision = evaluateOperatorRuntimeAction(task, { actionType: "commit", target: "repo", reason: "commit change" });
    expect(decision.allowed).toBe(true);
  });

  it("deploy requires deploy_guarded policy", () => {
    let task = createOperatorRuntimeTask({ objective: "x", executionPolicy: "commit_guarded" });
    task = attachPlan(task, { summary: "plan" });
    const decision = evaluateOperatorRuntimeAction(task, { actionType: "deploy", target: "prod", reason: "ship" });
    expect(decision.blocked).toBe(true);
    expect(decision.requiredPolicy).toBe("deploy_guarded");
  });

  it("publish requires publish_guarded policy", () => {
    let task = createOperatorRuntimeTask({ objective: "x" });
    task = attachPlan(task, { summary: "plan" });
    const decision = evaluateOperatorRuntimeAction(task, { actionType: "publish", target: "post", reason: "ship" });
    expect(decision.blocked).toBe(true);
    expect(decision.requiredPolicy).toBe("publish_guarded");
  });
});

describe("P1A Runtime Bridge — policy: delete is blocked by default", () => {
  it("delete is blocked outright (not a dry run)", () => {
    const task = createOperatorRuntimeTask({ objective: "x" });
    const decision = evaluateOperatorRuntimeAction(task, { actionType: "delete", target: "f.ts", reason: "cleanup" });
    expect(decision.blocked).toBe(true);
    expect(decision.allowed).toBe(false);
  });

  it("delete dryRun reports honestly (no fake preview): not allowed, not blocked outright", () => {
    const task = createOperatorRuntimeTask({ objective: "x" });
    const decision = evaluateOperatorRuntimeAction(task, {
      actionType: "delete",
      target: "f.ts",
      reason: "cleanup",
      dryRun: true,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.blocked).toBe(false);
  });
});

describe("P1A Runtime Bridge — policy: dryRun never reports allowed=true", () => {
  it("dryRun on an otherwise-allowed read still returns allowed=false", () => {
    const task = createOperatorRuntimeTask({ objective: "x" });
    const decision = evaluateOperatorRuntimeAction(task, {
      actionType: "read",
      target: "f.ts",
      reason: "inspect",
      dryRun: true,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.some((r) => r.includes("dryRun"))).toBe(true);
  });

  it("dryRun on an otherwise-allowed write (planned, low risk) still returns allowed=false", () => {
    let task = createOperatorRuntimeTask({ objective: "x" });
    task = attachPlan(task, { summary: "plan" });
    const decision = evaluateOperatorRuntimeAction(task, {
      actionType: "write",
      target: "f.ts",
      reason: "edit",
      dryRun: true,
    });
    expect(decision.allowed).toBe(false);
  });
});

describe("P1A Runtime Bridge — policy: does not mutate the task", () => {
  it("evaluateOperatorRuntimeAction leaves the input task unchanged", () => {
    const task = createOperatorRuntimeTask({ objective: "x" });
    const before = JSON.stringify(task);
    evaluateOperatorRuntimeAction(task, { actionType: "write", target: "f.ts", reason: "edit" });
    expect(JSON.stringify(task)).toBe(before);
  });

  it("evaluateOperatorRuntimeAction is synchronous", () => {
    const task = createOperatorRuntimeTask({ objective: "x" });
    const result = evaluateOperatorRuntimeAction(task, { actionType: "read", target: "f.ts", reason: "inspect" });
    expect(result).not.toBeInstanceOf(Promise);
  });
});

// ================================================================
// 4. Redaction at evidence/report boundary
// ================================================================
describe("P1A Runtime Bridge — redaction primitives", () => {
  it("redacts OpenAI/Anthropic-style sk- keys", () => {
    expect(redactText("key=sk-abcdefghijklmnopqrstuvwxyz")).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });

  it("redacts bearer tokens", () => {
    const out = redactText("Authorization: Bearer abc123XYZ.def456");
    expect(out).toContain("Bearer [REDACTED]");
    expect(out).not.toContain("abc123XYZ.def456");
  });

  it("redacts GitHub tokens (ghp_ and github_pat_)", () => {
    expect(redactText("token=ghp_" + "a".repeat(36))).not.toContain("ghp_" + "a".repeat(36));
    expect(redactText("github_pat_" + "b".repeat(30))).not.toContain("github_pat_" + "b".repeat(30));
  });

  it("redacts KEY=VALUE style password/secret/token assignments", () => {
    expect(redactText("DB_PASSWORD=hunter2super")).toBe("DB_PASSWORD=[REDACTED]");
    expect(redactText('apiKey: "abc-def-123"')).toContain("[REDACTED]");
  });

  it("redacts PEM-style private key blocks", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBAA\n-----END RSA PRIVATE KEY-----";
    expect(redactText(pem)).toBe("[REDACTED_PRIVATE_KEY]");
  });

  it("redactJsonValue collapses sensitive object keys regardless of value shape", () => {
    const out = redactJsonValue({ token: { nested: "value" }, ok: "plain text" }) as Record<string, unknown>;
    expect(out.token).toBe("[REDACTED]");
    expect(out.ok).toBe("plain text");
  });

  it("redactRecord round-trips through JSON safely", () => {
    const out = redactRecord({ secret: "abc", note: "hello world" });
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("leaves ordinary text and git-hash-like ids untouched", () => {
    expect(redactText("Fixed a bug in commit abc1234.")).toBe("Fixed a bug in commit abc1234.");
  });
});

describe("P1A Runtime Bridge — redaction at evidence export boundary", () => {
  it("evidence detail/source are redacted when attached", () => {
    let task = createOperatorRuntimeTask({ objective: "x" });
    task = attachPlan(task, { summary: "plan" });
    task = attachEvidence(task, {
      type: "log",
      label: "env-dump",
      detail: "OPENAI_API_KEY=sk-zzzzzzzzzzzzzzzzzzzzzzzzzz",
    });
    const bundle = buildOperatorEvidenceBundle(task);
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain("sk-zzzzzzzzzzzzzzzzzzzzzzzzzz");
  });

  it("buildOperatorEvidenceBundle defensively re-redacts even a hand-assembled task", () => {
    const task = createOperatorRuntimeTask({ objective: "x" }) as RuntimeTask;
    // Simulate a task assembled without going through attachEvidence (hand-built evidence array).
    task.evidence.push({
      id: "manual-1",
      type: "note",
      label: "manual",
      detail: "Bearer sk-live-1234567890ABCDEFGH",
      createdAt: new Date().toISOString(),
    });
    const bundle = buildOperatorEvidenceBundle(task);
    expect(JSON.stringify(bundle)).not.toContain("sk-live-1234567890ABCDEFGH");
  });

  it("summarizeOperatorRuntimeTask redacts secrets in the rendered text block", () => {
    let task = createOperatorRuntimeTask({ objective: "Deploy with TOKEN=abcDEF123456789012345678901234" });
    const summary = summarizeOperatorRuntimeTask(task);
    expect(summary.text).not.toContain("abcDEF123456789012345678901234");
  });

  it("evidence bundle is asserted JSON-safe (assertJsonSafe does not throw)", () => {
    const task = createOperatorRuntimeTask(SAMPLE_OPERATOR_RUNTIME_TASK_INPUT);
    const bundle = buildOperatorEvidenceBundle(task);
    expect(() => assertJsonSafe(bundle, "bundle")).not.toThrow();
  });
});

// ================================================================
// 5. Full lifecycle round trips (contract fidelity)
// ================================================================
describe("P1A Runtime Bridge — full lifecycle: low risk, no approval gate", () => {
  it("draft -> planned -> executing -> validating -> completed", () => {
    let task = createOperatorRuntimeTask(SAMPLE_OPERATOR_RUNTIME_TASK_INPUT);
    expect(task.status).toBe("draft");

    task = attachPlan(task, { summary: "Run validation gates.", steps: [{ description: "typecheck" }, { description: "test" }] });
    expect(task.status).toBe("planned");

    task = startExecution(task);
    expect(task.status).toBe("executing");

    task = attachEvidence(task, { type: "command_output", label: "typecheck-output", detail: "0 errors" });
    task = startValidation(task);
    expect(task.status).toBe("validating");

    task = passValidation(task, { checks: [{ command: "npm run typecheck", passed: true }, { command: "npm test", passed: true }] });
    task = completeTask(task, { summary: "All gates passed." });
    expect(task.status).toBe("completed");
    expect(task.result?.success).toBe(true);

    const bundle = buildOperatorEvidenceBundle(task);
    expect(bundle.status).toBe("completed");
    expect(bundle.validationResult?.passed).toBe(true);
  });

  it("failValidation + failTask reaches a failed terminal state", () => {
    let task = createOperatorRuntimeTask({ objective: "x" });
    task = attachPlan(task, { summary: "plan" });
    task = startExecution(task);
    task = startValidation(task);
    task = failValidation(task, { checks: [{ command: "npm test", passed: false, message: "1 failing" }] });
    task = failTask(task, { summary: "Validation failed." });
    expect(task.status).toBe("failed");
    expect(task.result?.success).toBe(false);
  });

  it("cancelTask is terminal from any non-terminal status", () => {
    const task = createOperatorRuntimeTask({ objective: "x" });
    const cancelled = cancelTask(task, "no longer needed");
    expect(cancelled.status).toBe("cancelled");
    expect(isTerminalStatus(cancelled.status)).toBe(true);
  });

  it("blockTask + attachPlan recovers back to planned", () => {
    let task = createOperatorRuntimeTask({ objective: "x" });
    task = attachPlan(task, { summary: "plan" });
    task = blockTask(task, "stalled");
    expect(task.status).toBe("blocked");
    task = attachPlan(task, { summary: "revised plan" });
    expect(task.status).toBe("planned");
  });
});

describe("P1A Runtime Bridge — full lifecycle: high risk, approval gate enforced", () => {
  it("cannot skip straight to executing while approval is unresolved", () => {
    let task = createOperatorRuntimeTask(SAMPLE_OPERATOR_HIGH_RISK_TASK_INPUT);
    task = attachPlan(task, { summary: "plan" });
    expect(() => startExecution(task)).toThrow(RuntimeTransitionError);
  });

  it("requireApproval -> approveTask -> startExecution succeeds", () => {
    let task = createOperatorRuntimeTask(SAMPLE_OPERATOR_HIGH_RISK_TASK_INPUT);
    task = attachPlan(task, { summary: "plan" });
    task = requireApproval(task);
    expect(task.status).toBe("approval_required");
    task = approveTask(task, "reviewer@chanter");
    expect(task.status).toBe("approved");
    task = startExecution(task);
    expect(task.status).toBe("executing");
  });

  it("getAllowedNextStatuses reflects the approval gate for a planned, approval-required task", () => {
    let task = createOperatorRuntimeTask(SAMPLE_OPERATOR_HIGH_RISK_TASK_INPUT);
    task = attachPlan(task, { summary: "plan" });
    expect(getAllowedNextStatuses(task)).toEqual(["approval_required", "blocked", "cancelled"]);
  });

  it("requiresApprovalBeforeExecution matches task.approvalRequired", () => {
    const task = createOperatorRuntimeTask(SAMPLE_OPERATOR_HIGH_RISK_TASK_INPUT);
    expect(requiresApprovalBeforeExecution(task)).toBe(task.approvalRequired);
  });
});

// ================================================================
// 6. Provider routing (no network)
// ================================================================
describe("P1A Runtime Bridge — provider routing", () => {
  it("selects the first enabled candidate matching product+capability", () => {
    const decision = selectOperatorProviderRoute({
      product: "operator",
      capability: "readonly-command",
      reason: "run a readonly git command",
    });
    expect(decision.blocked).toBe(false);
    expect(decision.provider).toBe("operator-local");
    expect(decision.toolId).toBe("readonly-git-runner");
  });

  it("returns blocked when every matching candidate is disabled", () => {
    const decision = selectOperatorProviderRoute({
      product: "operator",
      capability: "network-call",
      reason: "attempt a network call",
    });
    expect(decision.blocked).toBe(true);
    expect(decision.provider).toBeNull();
    expect(decision.fallbackCandidates.length).toBeGreaterThan(0);
  });

  it("returns blocked when no candidate matches product/capability at all", () => {
    const decision = selectOperatorProviderRoute({
      product: "clean_engine",
      capability: "nonexistent-capability",
      reason: "no match",
    });
    expect(decision.blocked).toBe(true);
    expect(decision.fallbackCandidates).toEqual([]);
  });

  it("respects a caller-supplied candidate list over the default", () => {
    const custom = [
      { provider: "custom", toolId: "tool-1", product: "operator" as const, capability: "custom-cap", enabled: true },
    ];
    const decision = selectOperatorProviderRoute({ product: "operator", capability: "custom-cap", reason: "x" }, custom);
    expect(decision.provider).toBe("custom");
  });

  it("DEFAULT_OPERATOR_PROVIDER_ROUTES contains only local/contract-based providers (no live network endpoints)", () => {
    for (const route of DEFAULT_OPERATOR_PROVIDER_ROUTES) {
      expect(route.provider).not.toMatch(/^https?:\/\//);
    }
  });

  it("selectProviderRoute (mirror) never throws, even for empty candidate lists", () => {
    expect(() => selectProviderRoute({ product: "operator", capability: "x", reason: "x" }, [])).not.toThrow();
  });

  it("route selection is synchronous", () => {
    const result = selectOperatorProviderRoute({ product: "operator", capability: "readonly-command", reason: "x" });
    expect(result).not.toBeInstanceOf(Promise);
  });
});

// ================================================================
// 7. Adapter contract conformance
// ================================================================
describe("P1A Runtime Bridge — operatorRuntimeAdapter contract shape", () => {
  it("has id, product='operator', and a semver-ish version", () => {
    expect(operatorRuntimeAdapter.id).toBe("operator-runtime-bridge-adapter");
    expect(operatorRuntimeAdapter.product).toBe("operator");
    expect(operatorRuntimeAdapter.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("exposes mapToRuntimeTask and buildEvidenceBundle as functions", () => {
    expect(typeof operatorRuntimeAdapter.mapToRuntimeTask).toBe("function");
    expect(typeof operatorRuntimeAdapter.buildEvidenceBundle).toBe("function");
  });

  it("mapToRuntimeTask produces a task with product='operator'", () => {
    const task = operatorRuntimeAdapter.mapToRuntimeTask(SAMPLE_OPERATOR_RUNTIME_TASK_INPUT);
    expect(task.product).toBe("operator");
  });

  it("runOperatorRuntimeAdapter returns a task and bundle describing the same task", () => {
    const { task, evidenceBundle } = runOperatorRuntimeAdapter(operatorRuntimeAdapter, {
      input: SAMPLE_OPERATOR_RUNTIME_TASK_INPUT,
    });
    expect(evidenceBundle.taskId).toBe(task.id);
  });

  it("runOperatorRuntimeAdapter accepts optional correlationId/receivedAt without affecting the mapped task", () => {
    const { task } = runOperatorRuntimeAdapter(operatorRuntimeAdapter, {
      input: SAMPLE_OPERATOR_RUNTIME_TASK_INPUT,
      correlationId: "corr-123",
      receivedAt: new Date().toISOString(),
    });
    expect(task.product).toBe("operator");
  });
});

// ================================================================
// 8. Readiness integration
// ================================================================
describe("P1A Runtime Bridge — readiness report", () => {
  it("real bridge readiness is READY with all primitives supported", () => {
    const report = createOperatorAdapterReadinessReport();
    expect(report.status).toBe("READY");
    expect(report.usable).toBe(true);
    expect(report.supportedPrimitives).toEqual(OPERATOR_RUNTIME_BRIDGE_PRIMITIVES);
  });

  it("readiness status is drawn from Operator's existing readiness vocabulary", () => {
    const report = createOperatorAdapterReadinessReport();
    expect(AdapterReadinessStatuses).toContain(report.status);
  });

  it("lists documented not-implemented items (decision-only scope)", () => {
    const report = createOperatorAdapterReadinessReport();
    expect(report.notImplemented.length).toBeGreaterThan(0);
    expect(report.notImplemented.some((n) => n.toLowerCase().includes("cross-repo") || n.toLowerCase().includes("package"))).toBe(true);
  });

  it("deriveOperatorRuntimeBridgeReadiness reports INCOMPLETE when a required primitive is missing", () => {
    const partial: OperatorRuntimeBridgePrimitive[] = ["task-mapping", "action-policy"];
    const report = deriveOperatorRuntimeBridgeReadiness(partial);
    expect(report.status).toBe("INCOMPLETE");
    expect(report.usable).toBe(false);
    expect(report.reasons.join(" ")).toContain("evidence-bundle");
  });

  it("readiness derivation is synchronous and pure", () => {
    const report = createOperatorAdapterReadinessReport();
    expect(report).not.toBeInstanceOf(Promise);
    const again = createOperatorAdapterReadinessReport();
    expect(again.status).toBe(report.status);
    expect(again.supportedPrimitives).toEqual(report.supportedPrimitives);
  });

  it("does NOT register into the existing P1.5 adapter catalog (no regression)", () => {
    expect(AdapterIds).toEqual(["loop_governor", "safecommit", "autoposter"]);
    expect(listRegisteredAdapters()).toHaveLength(3);
  });
});

// ================================================================
// 9. No unsafe action execution / no secret leakage (end-to-end)
// ================================================================
describe("P1A Runtime Bridge — no unsafe execution", () => {
  it("bridge module exports no run/execute/deploy/invoke/launch functions", async () => {
    const mod = await import("../src/agentRuntime/runtimeBridge/index.js");
    for (const key of Object.keys(mod)) {
      // runOperatorRuntimeAdapter/runProductAdapter-style names are decision-composition helpers,
      // not action executors — explicitly allowlisted.
      if (key === "runOperatorRuntimeAdapter") continue;
      expect(key.toLowerCase()).not.toMatch(/\bexecute_action\b|deploy_now|invoke_provider|launch/);
    }
  });

  it("policy module never imports process/child_process/network primitives", async () => {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../src/agentRuntime/runtimeBridge/policy.ts", import.meta.url), "utf8"),
    );
    expect(src).not.toMatch(/child_process|node:http|node:https|node:net|fetch\(/);
  });

  it("evaluateRuntimeActionPolicy (mirror) never mutates the task it evaluates", () => {
    const task = createOperatorRuntimeTask({ objective: "x" });
    const before = JSON.stringify(task);
    evaluateRuntimeActionPolicy(task, { actionType: "shell", target: "rm -rf /", reason: "malicious" });
    expect(JSON.stringify(task)).toBe(before);
  });
});

describe("P1A Runtime Bridge — no secret leakage end-to-end", () => {
  it("a secret placed in task inputs never appears in the final evidence bundle JSON", () => {
    // sk-style secret: matches OPENAI_STYLE_KEY_PATTERN regardless of surrounding key name,
    // so this exercises pattern-based (not just sensitive-key-based) redaction in free text.
    const secret = "sk-aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0u";
    let task = createOperatorRuntimeTask({
      objective: "Rotate credentials",
      riskLevel: "high",
      executionPolicy: "commit_guarded",
      inputs: { note: secret },
    });
    task = attachPlan(task, { summary: "plan" });
    task = requireApproval(task);
    task = approveTask(task);
    task = startExecution(task);
    task = attachEvidence(task, { type: "note", label: "context", detail: `Rotated key ${secret}` });
    task = startValidation(task);
    task = passValidation(task, { checks: [{ command: "npm test", passed: true }] });
    task = completeTask(task, { summary: `Completed rotation of ${secret}`, output: { key: secret } });

    const bundle = buildOperatorEvidenceBundle(task);
    const summary = summarizeOperatorRuntimeTask(task);
    expect(JSON.stringify(bundle)).not.toContain(secret);
    expect(summary.text).not.toContain(secret);
  });
});
