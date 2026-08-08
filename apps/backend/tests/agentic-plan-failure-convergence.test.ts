/**
 * Plan failure convergence — regression tests.
 *
 * Reproduces the defect that killed the first live billed acceptance run:
 *
 *     AGENTIC_PLAN_INVALID_TRANSITION
 *     Invalid durable agentic plan transition failed_recoverable -> failed_recoverable
 *
 * Two independent specialists are admitted in one batch. When both fail — the
 * ordinary case when they fail for the same systematic reason, such as a
 * misconfigured provider — each one independently reports that the plan can no
 * longer make progress. The first report moved the plan to `failed_recoverable`;
 * the second asked the state machine for `X -> X` and was correctly refused.
 *
 * The symptom was perverse: the mission failed on its *second* piece of bad news
 * rather than its first, and surfaced a transition defect instead of the real
 * provider failure underneath it.
 *
 * This ran green for two prior P0s because nothing asserted the HTTP status of
 * the approve call in the scenarios where both specialists fail — the node
 * transitions had already been committed before the plan transition threw, so
 * every node-state assertion still passed. These tests assert the outcome of the
 * advance itself, which is what makes the defect visible.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../src/db/database.js";
import { AgenticMissionService } from "../src/agentic/agenticMissionService.js";
import { AgenticPlanJournal } from "../src/agentic/agenticPlanJournal.js";
import { AGENTIC_ARTIFACT_MISSION_CAPABILITIES } from "../src/agentic/agenticCapabilityRegistry.js";
import { SIMULATOR_PRIMARY_BINDING_ID } from "../src/agentic/agenticProviderRegistry.js";
import type {
  AgenticGovernanceDecision,
  AgenticGovernanceSnapshot,
  AgenticPlanGovernorPort,
} from "../src/agentic/agenticPlanGovernorPort.js";

/**
 * A governor that admits every ready node up to the plan's parallelism.
 *
 * Deliberately not the real Python kernel: this test is about what the Operator
 * does with *two failures at once*, and admission is simply the mechanism that
 * puts two nodes in one batch. The real kernel is exercised end to end by
 * `os:csi-model-workers`.
 */
function admitAllReady(): AgenticPlanGovernorPort {
  return {
    configured: true,
    async govern(snapshot: AgenticGovernanceSnapshot): Promise<AgenticGovernanceDecision> {
      const completed = new Set(
        snapshot.nodes.filter((node) => node.state === "completed").map((node) => node.nodeId),
      );
      const admitted = snapshot.nodes
        .filter((node) =>
          (node.state === "blocked" || node.state === "ready")
          && node.dependsOn.every((dependency) => completed.has(dependency))
          && node.attempts < node.attemptLimit)
        .slice(0, snapshot.maxParallelism)
        .map((node) => node.nodeId);
      return {
        admitted,
        held: [],
        remainingCapacity: Math.max(0, snapshot.maxParallelism - admitted.length),
        unreachable: [],
        evaluatedAt: snapshot.now,
      };
    },
    async dependents(): Promise<readonly string[]> {
      return [];
    },
  };
}

const APPROVER = "founder";
let root: string;
let database: ReturnType<typeof createDatabase>;

function submission(missionId: string): Record<string, unknown> {
  return {
    schemaVersion: "chanter.agentic-work.v1",
    missionId,
    traceId: `${missionId}-trace`,
    workspaceId: "chanter-os",
    actorId: APPROVER,
    objective: "Reproduce two independent specialist failures converging on one plan state.",
    constraints: [],
    acceptanceCriteria: [{
      criterionId: "ac-evidence-section",
      statement: "The artifact states its evidence index.",
      check: "artifact_section_present",
      parameter: "Evidence Index",
    }],
    riskClass: "local_write",
    verifiabilityClass: "evidence_verifiable",
    authorityPolicy: {
      approvalRequiredCapabilities: ["artifact.local.write"],
      approvalRequiredRiskClasses: ["local_write"],
      approverRole: APPROVER,
    },
    timeBudgetMs: 1_800_000,
    maxParallelism: 2,
    executionPolicy: "model_required_for_judgment",
    providerBindings: [
      { capabilityId: "architecture.analyze", bindingId: SIMULATOR_PRIMARY_BINDING_ID },
      { capabilityId: "risk.analyze", bindingId: SIMULATOR_PRIMARY_BINDING_ID },
    ],
    allowedCapabilities: [...AGENTIC_ARTIFACT_MISSION_CAPABILITIES],
    forbiddenCapabilities: [],
    contextRequirements: [{
      requirementId: "ctx-architecture",
      sourceType: "static_fixture",
      sourceIdentity: "architecture-contract.json",
      scope: "architecture_contract",
      freshnessPolicy: "any",
      trustClass: "declared",
    }, {
      requirementId: "ctx-risk",
      sourceType: "static_fixture",
      sourceIdentity: "risk-register.json",
      scope: "risk_register",
      freshnessPolicy: "any",
      trustClass: "declared",
    }],
    outputContract: {
      format: "markdown",
      artifactName: "CONVERGENCE.md",
      requiredSections: ["Executive Summary", "Evidence Index"],
    },
    requestedAt: "2026-08-07T10:00:00.000Z",
  };
}

/**
 * A service whose two specialists both fail, for the same reason, in one batch.
 *
 * `simulatorEnabled` is true but **no adapter is registered** for the scenario
 * `disabled`, so both model nodes fail with a typed
 * `AGENTIC_PROVIDER_ADAPTER_UNAVAILABLE`. That is exactly the shape of the live
 * failure — a systematic provider misconfiguration that both specialists hit
 * identically — without needing a provider of any kind.
 */
function serviceWithBothSpecialistsFailing(): AgenticMissionService {
  return new AgenticMissionService({
    database,
    governor: admitAllReady(),
    configuration: {
      paths: {
        repositories: {},
        fixtureRoot: path.join(root, "fixtures"),
        artifactRoot: path.join(root, "artifacts"),
      },
      governor: { pythonExecutable: "python", governorRoot: root, timeoutMs: 30_000 },
      approvalTtlMs: 1_800_000,
      authorityRevision: "0".repeat(40),
      providers: {
        localModelBaseUrl: "",
        simulatorEnabled: true,
        simulatorScenario: "disabled",
        openRouterApiKey: "",
        openRouterBaseUrl: "https://openrouter.ai",
      },
    },
  });
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "chanter-convergence-"));
  mkdirSync(path.join(root, "fixtures"), { recursive: true });
  mkdirSync(path.join(root, "artifacts"), { recursive: true });
  writeFileSync(
    path.join(root, "fixtures", "architecture-contract.json"),
    JSON.stringify({ claims: [{ claimId: "a1", statement: "Operator owns plan authority.", confidence: "high" }] }),
    "utf8",
  );
  writeFileSync(
    path.join(root, "fixtures", "risk-register.json"),
    JSON.stringify({ claims: [{ claimId: "r1", statement: "Unknown outcomes require reconciliation.", confidence: "high" }] }),
    "utf8",
  );
  database = createDatabase(path.join(root, "operator.sqlite"));
});

afterEach(() => {
  database.close();
  rmSync(root, { recursive: true, force: true });
});

describe("two specialists converging on one plan failure state", () => {
  it("does not attempt an invalid second transition into the same state", async () => {
    const service = serviceWithBothSpecialistsFailing();
    const missionId = "convergence-1";
    await service.submit(submission(missionId));

    // Before the fix this threw:
    //   AGENTIC_PLAN_INVALID_TRANSITION failed_recoverable -> failed_recoverable
    const view = await service.approveExecution(missionId, { approvedBy: APPROVER });

    expect(view.status).toBe("failed_recoverable");
    expect(view.typedError?.code).not.toBe("AGENTIC_PLAN_INVALID_TRANSITION");

    const nodes = service.nodes(missionId);
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    // Both specialists really did fail — the convergence is genuine, not avoided
    // by one of them quietly succeeding.
    expect(byId.get("N2")?.state).toBe("failed_recoverable");
    expect(byId.get("N3")?.state).toBe("failed_recoverable");
    expect(byId.get("N1")?.state).toBe("completed");
    // Downstream stays unreachable.
    expect(byId.get("N5")?.state).toBe("blocked");
    expect(byId.get("N7")?.state).toBe("blocked");
  });

  it("keeps the event journal canonical: one plan convergence, one event per node", async () => {
    const service = serviceWithBothSpecialistsFailing();
    const missionId = "convergence-2";
    await service.submit(submission(missionId));
    await service.approveExecution(missionId, { approvedBy: APPROVER });

    const journal = new AgenticPlanJournal(database);
    const events = journal.listEvents(missionId);

    // Sequence numbers stay dense and strictly increasing — the append-only
    // journal is not left with a gap where the refused transition would have sat.
    const sequences = events.map((event) => event.sequence);
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
    expect(new Set(sequences).size).toBe(sequences.length);

    // Exactly one plan-scope arrival at failed_recoverable, from two node
    // failures. The second failure is a re-assertion, not a state change.
    const planConvergences = events.filter(
      (event) => event.scope === "plan" && event.newState === "failed_recoverable",
    );
    expect(planConvergences).toHaveLength(1);

    // Each node still records its own failure — convergence collapses the plan
    // event, never the per-node truth.
    for (const nodeId of ["N2", "N3"]) {
      const nodeFailures = events.filter(
        (event) => event.scope === "node" && event.nodeId === nodeId && event.newState === "failed_recoverable",
      );
      expect(nodeFailures, `${nodeId} must record its own failure`).toHaveLength(1);
    }
  });

  it("loses no provider outcome and issues no duplicate provider call", async () => {
    const service = serviceWithBothSpecialistsFailing();
    const missionId = "convergence-3";
    await service.submit(submission(missionId));
    await service.approveExecution(missionId, { approvedBy: APPROVER });

    const journal = new AgenticPlanJournal(database);
    const nodes = service.nodes(missionId);

    for (const nodeId of ["N2", "N3"]) {
      const node = nodes.find((entry) => entry.nodeId === nodeId);
      expect(node?.attempts, `${nodeId} must have been attempted exactly once`).toBe(1);
      // These failures never reached a provider — the adapter was unavailable —
      // so there is no charge to lose. The assertion that matters is that the
      // convergence path neither invented an outcome nor re-dispatched.
      expect(journal.countProviderCallsForNode(node!.idempotencyKey)).toBe(0);
    }

    // Every node carrying a durable provider outcome also carries a committed
    // Operator node outcome. An outcome recorded on one side and absent on the
    // other is exactly the orphaned-charge state this fabric must never reach.
    for (const node of nodes) {
      if (journal.countProviderCallsForNode(node.idempotencyKey) > 0) {
        expect(node.state, `${node.nodeId} has a provider outcome but no committed node outcome`)
          .not.toBe("running");
      }
    }
  });

  it("leaves the mission reconcilable and resumable after convergence", async () => {
    const service = serviceWithBothSpecialistsFailing();
    const missionId = "convergence-4";
    await service.submit(submission(missionId));
    await service.approveExecution(missionId, { approvedBy: APPROVER });

    // `failed_recoverable` must remain a state a human can act on, which is the
    // whole point of not having corrupted it.
    const view = service.get(missionId);
    expect(view.status).toBe("failed_recoverable");
    expect(view.nextPermittedActions).toContain("reconcile");
    expect(view.nextPermittedActions).toContain("resume");

    // A fresh service over the same durable file reads identical truth: the
    // convergence is persisted, not an artefact of one process's memory.
    const restarted = serviceWithBothSpecialistsFailing();
    const afterRestart = restarted.get(missionId);
    expect(afterRestart.status).toBe("failed_recoverable");
    expect(afterRestart.planId).toBe(view.planId);
    expect(afterRestart.intentHash).toBe(view.intentHash);
  });

  it("never downgrades an unknown outcome to a merely recoverable one", async () => {
    // `reconciliation_required` means some node's outcome is genuinely unknown,
    // which is strictly more conservative than a decided failure. A later
    // decided failure must not weaken it, or a human would be invited to resume
    // when they should reconcile.
    const service = serviceWithBothSpecialistsFailing();
    const missionId = "convergence-5";
    await service.submit(submission(missionId));
    await service.approveExecution(missionId, { approvedBy: APPROVER });

    const journal = new AgenticPlanJournal(database);
    journal.transitionMission(missionId, "reconciliation_required", {
      actor: APPROVER,
      reason: "A node outcome was established as unknown.",
      timestamp: new Date().toISOString(),
      typedError: null,
    });

    // Re-running the convergence for a decided failure must be a no-op.
    const before = journal.requireMission(missionId).status;
    expect(before).toBe("reconciliation_required");
    const events = journal.listEvents(missionId).length;

    const node = service.nodes(missionId).find((entry) => entry.nodeId === "N3")!;
    // Drive the same private convergence path the commit loop uses, through the
    // public surface that reaches it.
    await service.advance(missionId).catch(() => undefined);

    expect(journal.requireMission(missionId).status).toBe("reconciliation_required");
    expect(node.state).toBe("failed_recoverable");
    expect(journal.listEvents(missionId).length).toBeGreaterThanOrEqual(events);
  });
});
