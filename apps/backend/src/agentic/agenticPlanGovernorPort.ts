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

export interface AgenticGovernanceSnapshot {
  readonly planId: string;
  readonly now: string;
  readonly maxParallelism: number;
  readonly nodes: readonly AgenticNodeRecord[];
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

function snapshotToRequest(snapshot: AgenticGovernanceSnapshot): Record<string, unknown> {
  return {
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

function parseDecision(stdout: string): AgenticGovernanceDecision {
  const parsed: unknown = JSON.parse(stdout);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Plan governance returned a non-object decision.");
  }
  const record = parsed as Record<string, unknown>;
  if (record.error) {
    const error = record.error as { code?: unknown; message?: unknown };
    throw new OperatorError(
      typeof error.message === "string" ? error.message : "Plan governance refused the request.",
      409,
      typeof error.code === "string" ? error.code : "PLAN_GOVERNANCE_REQUEST_INVALID",
    );
  }
  return {
    admitted: (record.admitted as string[] | undefined) ?? [],
    holds: (record.holds as AgenticGovernanceHold[] | undefined) ?? [],
    running: (record.running as string[] | undefined) ?? [],
    maxParallelism: Number(record.maxParallelism ?? 0),
    remainingCapacity: Number(record.remainingCapacity ?? 0),
    unreachable: (record.unreachable as string[] | undefined) ?? [],
    evaluatedAt: String(record.evaluatedAt ?? ""),
  };
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
      const result = await runGovernor(resolved, snapshotToRequest(snapshot));
      if (result.exitCode !== 0 && !result.stdout.trim()) {
        throw new OperatorError(
          `Plan governance exited ${result.exitCode} without a decision.`,
          502,
          "PLAN_GOVERNANCE_UNAVAILABLE",
          { stderr: result.stderr.slice(0, 400) },
        );
      }
      return parseDecision(result.stdout);
    },
    async dependents(snapshot, nodeId) {
      if (!configured) {
        throw new OperatorError(
          "The Loop Governor plan governance kernel is not configured, so stop propagation cannot be computed.",
          503,
          "PLAN_GOVERNANCE_UNAVAILABLE",
        );
      }
      const result = await runGovernor(resolved, {
        ...snapshotToRequest(snapshot),
        operation: "dependents",
        nodeId,
      });
      const parsed: unknown = JSON.parse(result.stdout);
      const record = parsed as Record<string, unknown>;
      if (record.error) {
        const error = record.error as { code?: unknown; message?: unknown };
        throw new OperatorError(
          typeof error.message === "string" ? error.message : "Plan governance refused the request.",
          409,
          typeof error.code === "string" ? error.code : "PLAN_GOVERNANCE_REQUEST_INVALID",
        );
      }
      return (record.dependents as string[] | undefined) ?? [];
    },
  };
}
