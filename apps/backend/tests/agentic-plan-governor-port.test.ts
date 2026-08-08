import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  AGENTIC_PLAN_GOVERNANCE_WIRE_VERSION,
  createAgenticPlanDependentsRequest,
  createAgenticPlanGovernanceRequest,
  parseAgenticGovernanceDecision,
  parseAgenticGovernanceDependents,
  type AgenticGovernanceSnapshot,
} from "../src/agentic/agenticPlanGovernorPort.js";
import { OperatorError } from "../src/services/operatorService.js";

function snapshot(): AgenticGovernanceSnapshot {
  return {
    planId: "plan-conformance-1",
    now: "2030-01-01T00:00:00Z",
    maxParallelism: 2,
    planDeadlineAt: "2030-01-01T00:10:00Z",
    costBudgetMicros: 5_000,
    costSpentMicros: 1_000,
    cancellationRequested: false,
    nodes: [
      {
        nodeId: "N1",
        state: "completed",
        dependsOn: [],
        attempts: 1,
        attemptLimit: 1,
        leaseOwner: null,
        leaseExpiresAt: null,
        deadlineAt: null,
      },
      {
        nodeId: "N2",
        state: "ready",
        dependsOn: ["N1"],
        attempts: 0,
        attemptLimit: 2,
        leaseOwner: null,
        leaseExpiresAt: null,
        deadlineAt: null,
      },
      {
        nodeId: "N3",
        state: "ready",
        dependsOn: ["N1"],
        attempts: 0,
        attemptLimit: 2,
        leaseOwner: null,
        leaseExpiresAt: null,
        deadlineAt: null,
      },
    ],
  };
}

function decision(): Record<string, unknown> {
  return {
    schemaVersion: AGENTIC_PLAN_GOVERNANCE_WIRE_VERSION,
    planId: "plan-conformance-1",
    admitted: ["N2", "N3"],
    holds: [{ nodeId: "N1", reason: "NODE_TERMINAL", detail: "Node is already completed." }],
    running: [],
    maxParallelism: 2,
    remainingCapacity: 0,
    unreachable: [],
    evaluatedAt: "2030-01-01T00:00:00Z",
  };
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(OperatorError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected ${code}.`);
}

describe("AgenticPlanGovernorPort v1 wire contract", () => {
  it("emits the exact Operator-owned v1 request fixture", () => {
    const fixture = JSON.parse(readFileSync(
      new URL("./agentic-plan-governance-request.v1.json", import.meta.url),
      "utf8",
    )) as Record<string, unknown>;
    const emitted = createAgenticPlanGovernanceRequest(snapshot());

    expect(AGENTIC_PLAN_GOVERNANCE_WIRE_VERSION).toBe("chanter.plan-governance.v1");
    expect(emitted).toEqual(fixture);
    expect(JSON.stringify(emitted)).toBe(JSON.stringify(fixture));
    expect(createAgenticPlanDependentsRequest(snapshot(), "N1")).toEqual({
      ...fixture,
      operation: "dependents",
      nodeId: "N1",
    });
  });

  it("accepts a complete Governor v1 decision bound to the request", () => {
    expect(parseAgenticGovernanceDecision(decision(), snapshot())).toEqual({
      admitted: ["N2", "N3"],
      holds: [{ nodeId: "N1", reason: "NODE_TERMINAL", detail: "Node is already completed." }],
      running: [],
      maxParallelism: 2,
      remainingCapacity: 0,
      unreachable: [],
      evaluatedAt: "2030-01-01T00:00:00Z",
    });
  });

  it("rejects missing or unsupported versions before accepting success or error", () => {
    for (const payload of [decision(), {
      schemaVersion: AGENTIC_PLAN_GOVERNANCE_WIRE_VERSION,
      error: { code: "PLAN_GOVERNANCE_REQUEST_INVALID", message: "refused" },
    }]) {
      const missing = structuredClone(payload);
      delete missing.schemaVersion;
      expectCode(
        () => parseAgenticGovernanceDecision(missing, snapshot()),
        "PLAN_GOVERNANCE_RESPONSE_VERSION_UNSUPPORTED",
      );

      const unsupported = { ...payload, schemaVersion: "chanter.plan-governance.v2" };
      expectCode(
        () => parseAgenticGovernanceDecision(unsupported, snapshot()),
        "PLAN_GOVERNANCE_RESPONSE_VERSION_UNSUPPORTED",
      );
    }
  });

  it("preserves a valid typed refusal but rejects an unrecognized v1 error shape", () => {
    expectCode(
      () => parseAgenticGovernanceDecision({
        schemaVersion: AGENTIC_PLAN_GOVERNANCE_WIRE_VERSION,
        error: { code: "PLAN_GOVERNANCE_GRAPH_INVALID", message: "cycle" },
      }, snapshot()),
      "PLAN_GOVERNANCE_GRAPH_INVALID",
    );
    expectCode(
      () => parseAgenticGovernanceDecision({
        schemaVersion: AGENTIC_PLAN_GOVERNANCE_WIRE_VERSION,
        error: { code: "NEW_V1_AUTHORITY", message: "drift", retryable: true },
      }, snapshot()),
      "PLAN_GOVERNANCE_RESPONSE_INVALID",
    );
  });

  it("rejects field, type, enum, coverage, and request-binding drift under v1", () => {
    const extra = { ...decision(), newlyAdded: true };
    const renamed = structuredClone(decision());
    renamed.held = renamed.holds;
    delete renamed.holds;
    const coerced = { ...decision(), remainingCapacity: "0" };
    const enumDrift = structuredClone(decision());
    (enumDrift.holds as Record<string, unknown>[])[0]!.reason = "NODE_ALREADY_DONE";
    const missingNode = { ...decision(), admitted: ["N2"] };
    const wrongPlan = { ...decision(), planId: "plan-other" };
    const wrongTime = { ...decision(), evaluatedAt: "2030-01-01T00:00:01Z" };

    for (const payload of [extra, renamed, coerced, enumDrift, missingNode, wrongPlan, wrongTime]) {
      expectCode(
        () => parseAgenticGovernanceDecision(payload, snapshot()),
        "PLAN_GOVERNANCE_RESPONSE_INVALID",
      );
    }

    const runningSnapshot: AgenticGovernanceSnapshot = {
      ...snapshot(),
      nodes: snapshot().nodes.map((entry) =>
        entry.nodeId === "N2" ? { ...entry, state: "running" as const } : entry),
    };
    expectCode(
      () => parseAgenticGovernanceDecision({ ...decision(), running: ["N2"] }, runningSnapshot),
      "PLAN_GOVERNANCE_RESPONSE_INVALID",
    );
    expectCode(
      () => parseAgenticGovernanceDecision({ ...decision(), unreachable: ["N2"] }, snapshot()),
      "PLAN_GOVERNANCE_RESPONSE_INVALID",
    );
  });

  it("accepts only an exact dependents response bound to plan and source node", () => {
    const response = {
      schemaVersion: AGENTIC_PLAN_GOVERNANCE_WIRE_VERSION,
      planId: "plan-conformance-1",
      nodeId: "N1",
      dependents: ["N2", "N3"],
    };
    expect(parseAgenticGovernanceDependents(response, snapshot(), "N1")).toEqual(["N2", "N3"]);

    expectCode(
      () => parseAgenticGovernanceDependents({ ...response, planId: "plan-other" }, snapshot(), "N1"),
      "PLAN_GOVERNANCE_RESPONSE_INVALID",
    );
    expectCode(
      () => parseAgenticGovernanceDependents({ ...response, transitive: true }, snapshot(), "N1"),
      "PLAN_GOVERNANCE_RESPONSE_INVALID",
    );
    expectCode(
      () => parseAgenticGovernanceDependents({ ...response, dependents: ["N1"] }, snapshot(), "N1"),
      "PLAN_GOVERNANCE_RESPONSE_INVALID",
    );
  });
});
