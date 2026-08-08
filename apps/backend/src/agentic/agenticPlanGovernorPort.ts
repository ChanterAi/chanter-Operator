/**
 * CHANTER OS — port to the Loop Governor's plan governance kernel.
 *
 * Admission — which nodes may be leased right now — is a Loop Governor decision,
 * not an Operator one. Operator owns the plan and its durable truth; the
 * Governor owns concurrency, attempt budgets, deadlines, leases, dependency
 * readiness, and cancellation. This port is the seam, and it carries only
 * governance vocabulary: node ids, states, dependencies, attempts, leases,
 * limits. No objective, capability, output, claim, or evidence crosses it,
 * because the kernel's request contract has no field that could hold one.
 *
 * ## Why a subprocess is the right seam
 *
 * The kernel is pure and holds no state, so the only alternative to a subprocess
 * would be a second implementation of the same rules in TypeScript — which is
 * precisely the cross-repository contract duplication the P0 forbids. One
 * `python -m governor.plan_governance` invocation per scheduling tick costs
 * roughly a fifth of a second and buys a single, testable statement of the
 * governance rules.
 *
 * ## Fail closed
 *
 * An unconfigured, crashed, malformed, or timed-out governor admits **nothing**.
 * That asymmetry is deliberate: the cost of admitting no node is a stalled plan
 * an operator can see and resume, whereas the cost of admitting a node the
 * governor would have refused is a duplicate side effect nobody asked for.
 */
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { OperatorError } from "../services/operatorService.js";
import type { AgenticNodeRecord } from "./agenticPlanJournal.js";

export const AGENTIC_PLAN_GOVERNANCE_WIRE_VERSION = "chanter.plan-governance.v1";

export const AGENTIC_GOVERNANCE_HOLD_REASONS = Object.freeze([
  "DEPENDENCY_NOT_SATISFIED",
  "DEPENDENCY_TERMINALLY_FAILED",
  "CONCURRENCY_LIMIT_REACHED",
  "ATTEMPT_LIMIT_EXHAUSTED",
  "NODE_DEADLINE_EXCEEDED",
  "PLAN_DEADLINE_EXCEEDED",
  "PLAN_COST_BUDGET_EXHAUSTED",
  "RECONCILIATION_REQUIRED",
  "LEASE_EXPIRED_RECONCILIATION_REQUIRED",
  "LEASE_HELD",
  "CANCELLATION_REQUESTED",
  "NODE_TERMINAL",
] as const);

const GOVERNANCE_HOLD_REASON_SET = new Set<string>(AGENTIC_GOVERNANCE_HOLD_REASONS);
const GOVERNANCE_ERROR_CODES = new Set([
  "PLAN_GOVERNANCE_REQUEST_INVALID",
  "PLAN_GOVERNANCE_GRAPH_INVALID",
  "PLAN_GOVERNANCE_VERSION_UNSUPPORTED",
]);

export interface AgenticGovernorConfiguration {
  readonly pythonExecutable: string;
  readonly governorRoot: string;
  readonly timeoutMs: number;
}

export interface AgenticGovernanceHold {
  readonly nodeId: string;
  readonly reason: string;
  readonly detail: string;
}

export interface AgenticGovernanceDecision {
  readonly admitted: readonly string[];
  readonly holds: readonly AgenticGovernanceHold[];
  readonly running: readonly string[];
  readonly maxParallelism: number;
  readonly remainingCapacity: number;
  readonly unreachable: readonly string[];
  readonly evaluatedAt: string;
}

export type AgenticGovernedNodeSnapshot = Pick<
  AgenticNodeRecord,
  | "nodeId"
  | "state"
  | "dependsOn"
  | "attempts"
  | "attemptLimit"
  | "leaseOwner"
  | "leaseExpiresAt"
  | "deadlineAt"
>;

export interface AgenticGovernanceSnapshot {
  readonly planId: string;
  readonly now: string;
  readonly maxParallelism: number;
  readonly nodes: readonly AgenticGovernedNodeSnapshot[];
  readonly planDeadlineAt: string | null;
  readonly costBudgetMicros: number | null;
  readonly costSpentMicros: number;
  readonly cancellationRequested: boolean;
}

export interface AgenticPlanGovernorPort {
  readonly configured: boolean;
  govern(snapshot: AgenticGovernanceSnapshot): Promise<AgenticGovernanceDecision>;
  /** Every node that transitively depends on `nodeId`, for stop propagation. */
  dependents(snapshot: AgenticGovernanceSnapshot, nodeId: string): Promise<readonly string[]>;
}

const GOVERNANCE_MODULE = "governor.plan_governance";

export function createAgenticPlanGovernanceRequest(
  snapshot: AgenticGovernanceSnapshot,
): Record<string, unknown> {
  return {
    schemaVersion: AGENTIC_PLAN_GOVERNANCE_WIRE_VERSION,
    operation: "govern",
    planId: snapshot.planId,
    now: snapshot.now,
    maxParallelism: snapshot.maxParallelism,
    planDeadlineAt: snapshot.planDeadlineAt ?? "",
    costBudgetMicros: snapshot.costBudgetMicros,
    costSpentMicros: snapshot.costSpentMicros,
    cancellationRequested: snapshot.cancellationRequested,
    nodes: snapshot.nodes.map((node) => ({
      nodeId: node.nodeId,
      state: node.state,
      dependsOn: [...node.dependsOn],
      attempts: node.attempts,
      attemptLimit: node.attemptLimit,
      leaseOwner: node.leaseOwner ?? "",
      leaseExpiresAt: node.leaseExpiresAt ?? "",
      deadlineAt: node.deadlineAt ?? "",
    })),
  };
}

export function createAgenticPlanDependentsRequest(
  snapshot: AgenticGovernanceSnapshot,
  nodeId: string,
): Record<string, unknown> {
  return {
    ...createAgenticPlanGovernanceRequest(snapshot),
    operation: "dependents",
    nodeId,
  };
}

interface GovernorProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runGovernor(
  configuration: AgenticGovernorConfiguration,
  request: Record<string, unknown>,
): Promise<GovernorProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(configuration.pythonExecutable, ["-m", GOVERNANCE_MODULE], {
      cwd: configuration.governorRoot,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`Plan governance did not answer within ${configuration.timeoutMs}ms.`));
    }, configuration.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
    child.stdin.end(JSON.stringify(request), "utf8");
  });
}

function responseInvalid(message: string): never {
  throw new OperatorError(message, 502, "PLAN_GOVERNANCE_RESPONSE_INVALID");
}

function recordOf(value: unknown, fieldName: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return responseInvalid(`${fieldName} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactFields(
  record: Record<string, unknown>,
  expected: readonly string[],
  fieldName: string,
): void {
  const actual = Object.keys(record).sort();
  const required = [...expected].sort();
  if (actual.length === required.length && actual.every((entry, index) => entry === required[index])) {
    return;
  }
  responseInvalid(
    `${fieldName} fields do not match ${AGENTIC_PLAN_GOVERNANCE_WIRE_VERSION}.`,
  );
}

function exactString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.length === 0) {
    return responseInvalid(`${fieldName} must be a non-empty string.`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, fieldName: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return responseInvalid(`${fieldName} must be a non-negative safe integer.`);
  }
  return value as number;
}

function stringList(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    return responseInvalid(`${fieldName} must be a list.`);
  }
  const result = value.map((entry, index) => exactString(entry, `${fieldName}[${index}]`));
  if (new Set(result).size !== result.length) {
    return responseInvalid(`${fieldName} must not contain duplicate node ids.`);
  }
  return result;
}

function versionedResponse(value: unknown): Record<string, unknown> {
  const record = recordOf(value, "Plan governance response");
  if (record.schemaVersion !== AGENTIC_PLAN_GOVERNANCE_WIRE_VERSION) {
    throw new OperatorError(
      `Plan governance response schemaVersion must be ${AGENTIC_PLAN_GOVERNANCE_WIRE_VERSION}.`,
      502,
      "PLAN_GOVERNANCE_RESPONSE_VERSION_UNSUPPORTED",
    );
  }
  return record;
}

function throwIfGovernorRefused(record: Record<string, unknown>): void {
  if (!Object.prototype.hasOwnProperty.call(record, "error")) return;
  exactFields(record, ["schemaVersion", "error"], "Plan governance error response");
  const error = recordOf(record.error, "Plan governance error");
  exactFields(error, ["code", "message"], "Plan governance error");
  const code = exactString(error.code, "Plan governance error.code");
  const message = exactString(error.message, "Plan governance error.message");
  if (!GOVERNANCE_ERROR_CODES.has(code)) {
    responseInvalid(`Plan governance returned unsupported error code ${code}.`);
  }
  throw new OperatorError(message, 409, code);
}

function throwNonzeroGovernorResponse(value: unknown, exitCode: number): never {
  const record = versionedResponse(value);
  if (!Object.prototype.hasOwnProperty.call(record, "error")) {
    return responseInvalid(
      `Plan governance exited ${exitCode} but returned a non-error response.`,
    );
  }
  throwIfGovernorRefused(record);
  return responseInvalid(`Plan governance exited ${exitCode} without a typed refusal.`);
}

function parseResponseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    return responseInvalid("Plan governance returned malformed JSON.");
  }
}

function validateKnownNodeIds(
  values: readonly string[],
  knownNodeIds: ReadonlySet<string>,
  fieldName: string,
): void {
  for (const nodeId of values) {
    if (!knownNodeIds.has(nodeId)) {
      responseInvalid(`${fieldName} contains unknown node id ${nodeId}.`);
    }
  }
}

export function parseAgenticGovernanceDecision(
  value: unknown,
  snapshot: AgenticGovernanceSnapshot,
): AgenticGovernanceDecision {
  const record = versionedResponse(value);
  throwIfGovernorRefused(record);
  exactFields(record, [
    "schemaVersion",
    "planId",
    "admitted",
    "holds",
    "running",
    "maxParallelism",
    "remainingCapacity",
    "unreachable",
    "evaluatedAt",
  ], "Plan governance decision");

  const planId = exactString(record.planId, "Plan governance decision.planId");
  const evaluatedAt = exactString(record.evaluatedAt, "Plan governance decision.evaluatedAt");
  if (planId !== snapshot.planId || evaluatedAt !== snapshot.now) {
    responseInvalid("Plan governance decision is not bound to the requested plan snapshot.");
  }

  const admitted = stringList(record.admitted, "Plan governance decision.admitted");
  const running = stringList(record.running, "Plan governance decision.running");
  const unreachable = stringList(record.unreachable, "Plan governance decision.unreachable");
  const maxParallelism = nonNegativeInteger(
    record.maxParallelism,
    "Plan governance decision.maxParallelism",
  );
  const remainingCapacity = nonNegativeInteger(
    record.remainingCapacity,
    "Plan governance decision.remainingCapacity",
  );
  if (maxParallelism !== snapshot.maxParallelism) {
    responseInvalid("Plan governance decision changed the requested maxParallelism.");
  }

  if (!Array.isArray(record.holds)) {
    responseInvalid("Plan governance decision.holds must be a list.");
  }
  const holds = record.holds.map((entry, index): AgenticGovernanceHold => {
    const hold = recordOf(entry, `Plan governance decision.holds[${index}]`);
    exactFields(
      hold,
      ["nodeId", "reason", "detail"],
      `Plan governance decision.holds[${index}]`,
    );
    const reason = exactString(hold.reason, `Plan governance decision.holds[${index}].reason`);
    if (!GOVERNANCE_HOLD_REASON_SET.has(reason)) {
      responseInvalid(`Plan governance decision contains unsupported hold reason ${reason}.`);
    }
    return {
      nodeId: exactString(hold.nodeId, `Plan governance decision.holds[${index}].nodeId`),
      reason,
      detail: exactString(hold.detail, `Plan governance decision.holds[${index}].detail`),
    };
  });

  const knownNodeIds = new Set(snapshot.nodes.map((node) => node.nodeId));
  validateKnownNodeIds(admitted, knownNodeIds, "Plan governance decision.admitted");
  validateKnownNodeIds(running, knownNodeIds, "Plan governance decision.running");
  validateKnownNodeIds(unreachable, knownNodeIds, "Plan governance decision.unreachable");
  validateKnownNodeIds(holds.map((hold) => hold.nodeId), knownNodeIds, "Plan governance decision.holds");

  const resolved = [...admitted, ...holds.map((hold) => hold.nodeId)];
  if (new Set(resolved).size !== resolved.length || resolved.length !== knownNodeIds.size) {
    responseInvalid("Plan governance decision must admit or hold every node exactly once.");
  }
  const admittedNodeIds = new Set(admitted);
  const heldNodeIds = new Set(holds.map((hold) => hold.nodeId));
  if (running.some((nodeId) => admittedNodeIds.has(nodeId) || !heldNodeIds.has(nodeId))) {
    responseInvalid("Plan governance decision cannot admit a running node and must hold every runner.");
  }
  if (unreachable.some((nodeId) => admittedNodeIds.has(nodeId) || !heldNodeIds.has(nodeId))) {
    responseInvalid("Plan governance decision cannot admit an unreachable node and must hold it.");
  }
  const states = new Map(snapshot.nodes.map((node) => [node.nodeId, node.state]));
  if (running.some((nodeId) => states.get(nodeId) !== "running")) {
    responseInvalid("Plan governance decision.running contains a node not in running state.");
  }
  const expectedCapacity = Math.max(0, maxParallelism - running.length - admitted.length);
  if (remainingCapacity !== expectedCapacity) {
    responseInvalid("Plan governance decision.remainingCapacity is inconsistent with admission.");
  }

  return {
    admitted,
    holds,
    running,
    maxParallelism,
    remainingCapacity,
    unreachable,
    evaluatedAt,
  };
}

export function parseAgenticGovernanceDependents(
  value: unknown,
  snapshot: AgenticGovernanceSnapshot,
  nodeId: string,
): readonly string[] {
  const record = versionedResponse(value);
  throwIfGovernorRefused(record);
  exactFields(
    record,
    ["schemaVersion", "planId", "nodeId", "dependents"],
    "Plan governance dependents response",
  );
  if (
    exactString(record.planId, "Plan governance dependents response.planId") !== snapshot.planId
    || exactString(record.nodeId, "Plan governance dependents response.nodeId") !== nodeId
  ) {
    responseInvalid("Plan governance dependents response is not bound to the request.");
  }
  const dependents = stringList(record.dependents, "Plan governance dependents response.dependents");
  const knownNodeIds = new Set(snapshot.nodes.map((node) => node.nodeId));
  validateKnownNodeIds(dependents, knownNodeIds, "Plan governance dependents response.dependents");
  if (dependents.includes(nodeId)) {
    responseInvalid("Plan governance dependents response cannot contain the source node.");
  }
  return dependents;
}

/** Admits nothing, with a truthful hold on every node. Used when unconfigured. */
function refuseEverything(
  snapshot: AgenticGovernanceSnapshot,
  detail: string,
): AgenticGovernanceDecision {
  return {
    admitted: [],
    holds: snapshot.nodes.map((node) => ({
      nodeId: node.nodeId,
      reason: "PLAN_GOVERNANCE_UNAVAILABLE",
      detail,
    })),
    running: snapshot.nodes.filter((node) => node.state === "running").map((node) => node.nodeId),
    maxParallelism: snapshot.maxParallelism,
    remainingCapacity: 0,
    unreachable: [],
    evaluatedAt: snapshot.now,
  };
}

export function createAgenticPlanGovernorPort(
  configuration: AgenticGovernorConfiguration,
): AgenticPlanGovernorPort {
  const pythonExecutable = configuration.pythonExecutable.trim();
  const governorRoot = configuration.governorRoot.trim();
  const configured = Boolean(
    pythonExecutable
    && governorRoot
    && isAbsolute(pythonExecutable)
    && isAbsolute(governorRoot)
    && configuration.timeoutMs > 0,
  );
  const resolved: AgenticGovernorConfiguration = {
    pythonExecutable,
    governorRoot,
    timeoutMs: configuration.timeoutMs,
  };

  return {
    configured,
    async govern(snapshot) {
      if (!configured) {
        return refuseEverything(
          snapshot,
          "The Loop Governor plan governance kernel is not configured, so no node may be leased.",
        );
      }
      const result = await runGovernor(resolved, createAgenticPlanGovernanceRequest(snapshot));
      if (result.exitCode !== 0 && !result.stdout.trim()) {
        throw new OperatorError(
          `Plan governance exited ${result.exitCode} without a decision.`,
          502,
          "PLAN_GOVERNANCE_UNAVAILABLE",
          { stderr: result.stderr.slice(0, 400) },
        );
      }
      const response = parseResponseJson(result.stdout);
      if (result.exitCode !== 0) {
        return throwNonzeroGovernorResponse(response, result.exitCode);
      }
      return parseAgenticGovernanceDecision(response, snapshot);
    },
    async dependents(snapshot, nodeId) {
      if (!configured) {
        throw new OperatorError(
          "The Loop Governor plan governance kernel is not configured, so stop propagation cannot be computed.",
          503,
          "PLAN_GOVERNANCE_UNAVAILABLE",
        );
      }
      const result = await runGovernor(resolved, createAgenticPlanDependentsRequest(snapshot, nodeId));
      if (result.exitCode !== 0 && !result.stdout.trim()) {
        throw new OperatorError(
          `Plan governance exited ${result.exitCode} without a dependents response.`,
          502,
          "PLAN_GOVERNANCE_UNAVAILABLE",
          { stderr: result.stderr.slice(0, 400) },
        );
      }
      const response = parseResponseJson(result.stdout);
      if (result.exitCode !== 0) {
        return throwNonzeroGovernorResponse(response, result.exitCode);
      }
      return parseAgenticGovernanceDependents(response, snapshot, nodeId);
    },
  };
}
