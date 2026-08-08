import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgenticMissionService } from "../src/agentic/agenticMissionService.js";
import { AgenticPlanJournal } from "../src/agentic/agenticPlanJournal.js";
import { AGENTIC_ARTIFACT_MISSION_CAPABILITIES } from "../src/agentic/agenticCapabilityRegistry.js";
import type {
  AgenticGovernanceDecision,
  AgenticGovernanceSnapshot,
  AgenticPlanGovernorPort,
} from "../src/agentic/agenticPlanGovernorPort.js";
import { createDatabase } from "../src/db/database.js";

const APPROVER = "founder";
const ARTIFACT_NAME = "ORPHAN-RECOVERY.md";
const INITIAL_NOW = new Date().toISOString();
const AFTER_EXECUTION_WINDOW = new Date(Date.parse(INITIAL_NOW) + 86_400_000).toISOString();

let root: string;
let databasePath: string;
let database: ReturnType<typeof createDatabase>;

function admitAllReady(): AgenticPlanGovernorPort {
  return {
    configured: true,
    async govern(snapshot: AgenticGovernanceSnapshot): Promise<AgenticGovernanceDecision> {
      const completed = new Set(
        snapshot.nodes.filter((node) => node.state === "completed").map((node) => node.nodeId),
      );
      const admitted = snapshot.nodes
        .filter((node) =>
          (node.state === "blocked" || node.state === "ready" || node.state === "failed_recoverable")
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

function submission(missionId: string): Record<string, unknown> {
  return {
    schemaVersion: "chanter.agentic-work.v1",
    missionId,
    traceId: `${missionId}-trace`,
    workspaceId: "chanter-os",
    actorId: APPROVER,
    objective: "Prove exact orphan retirement without widening retry authority.",
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
    // The canonical cheapest-sufficient path is deterministic and makes the
    // recovery proof independent of any model provider or network transport.
    executionPolicy: "cheapest_sufficient",
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
      artifactName: ARTIFACT_NAME,
      requiredSections: ["Executive Summary", "Evidence Index"],
    },
    requestedAt: "2026-08-08T00:00:00.000Z",
  };
}

type FailureBoundary =
  | "after_node_claim_before_worker"
  | "after_node_worker_before_record"
  | "after_worker_record_before_node_commit"
  | "before_node_lease";

function serviceWithFailure(
  failure?: (boundary: FailureBoundary, context: { missionId: string; nodeId: string }) => void,
  clock: () => string = () => INITIAL_NOW,
): AgenticMissionService {
  return new AgenticMissionService({
    database,
    governor: admitAllReady(),
    clock,
    ...(failure ? { failureInjector: failure } : {}),
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
        simulatorEnabled: false,
        simulatorScenario: "succeed",
        openRouterApiKey: "",
        openRouterBaseUrl: "https://openrouter.ai",
      },
    },
  });
}

function restart(clock: () => string = () => INITIAL_NOW): AgenticMissionService {
  database.close();
  database = createDatabase(databasePath);
  return serviceWithFailure(undefined, clock);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "chanter-orphan-recovery-"));
  databasePath = path.join(root, "operator.sqlite");
  mkdirSync(path.join(root, "fixtures"), { recursive: true });
  mkdirSync(path.join(root, "artifacts"), { recursive: true });
  writeFileSync(
    path.join(root, "fixtures", "architecture-contract.json"),
    JSON.stringify({ claims: [{ claimId: "a1", statement: "Operator owns plan recovery.", confidence: "high" }] }),
    "utf8",
  );
  writeFileSync(
    path.join(root, "fixtures", "risk-register.json"),
    JSON.stringify({ claims: [{ claimId: "r1", statement: "Unknown outcomes remain fail-closed.", confidence: "high" }] }),
    "utf8",
  );
  database = createDatabase(databasePath);
});

afterEach(() => {
  database.close();
  rmSync(root, { recursive: true, force: true });
});

describe("Operator orphaned durable worker-claim recovery", () => {
  it("retires a proven no-result claim after restart and converges through normal Runtime execution", async () => {
    const missionId = "pure-orphan-recovery";
    let interrupted = false;
    const service = serviceWithFailure((boundary, context) => {
      if (!interrupted && boundary === "after_node_claim_before_worker" && context.nodeId === "N1") {
        interrupted = true;
        throw new Error("simulated process interruption after durable claim");
      }
    });
    await service.submit(submission(missionId));

    await expect(service.approveExecution(missionId, { approvedBy: APPROVER }))
      .rejects.toThrow("simulated process interruption after durable claim");

    const beforeRestart = new AgenticPlanJournal(database);
    const interruptedNode = beforeRestart.requireNode(service.get(missionId).planId, "N1");
    const orphan = beforeRestart.createWorkerRecordStore(() => new Date().toISOString())
      .inspectActiveClaim(interruptedNode.idempotencyKey);
    expect(interruptedNode.state).toBe("running");
    expect(orphan).not.toBeNull();
    expect(beforeRestart.countProviderCallsForNode(interruptedNode.idempotencyKey)).toBe(0);
    expect(beforeRestart.countArtifactWrites(missionId)).toBe(0);

    const restarted = restart();
    const early = restarted.reconcileNode(missionId, "N1");
    const afterEarlyReconcile = new AgenticPlanJournal(database);

    expect(early.state).toBe("reconciliation_required");
    expect(early.reconciliationOutcome).toBe("conflict");
    expect(afterEarlyReconcile.createWorkerRecordStore(() => INITIAL_NOW)
      .inspectActiveClaim(interruptedNode.idempotencyKey)).toEqual(orphan);

    const recoveryService = serviceWithFailure(undefined, () => AFTER_EXECUTION_WINDOW);
    const reconciled = recoveryService.reconcileNode(missionId, "N1");
    const afterReconcile = new AgenticPlanJournal(database);
    expect(reconciled.reconciliationOutcome).toBe("no_worker_result");
    expect(afterReconcile.createWorkerRecordStore(() => AFTER_EXECUTION_WINDOW)
      .inspectActiveClaim(interruptedNode.idempotencyKey)).toBeNull();

    const resumed = await recoveryService.resumeNode(missionId, "N1");
    const recorded = afterReconcile.createWorkerRecordStore(() => AFTER_EXECUTION_WINDOW)
      .read(interruptedNode.idempotencyKey);

    expect(resumed.state).toBe("completed");
    expect(resumed.attempts).toBe(2);
    expect(recorded?.status).toBe("succeeded");
    expect(afterReconcile.countProviderCallsForNode(interruptedNode.idempotencyKey)).toBe(0);
    expect(afterReconcile.countArtifactWrites(missionId)).toBe(0);
  });

  it("preserves an uncertain local-write claim and refuses duplicate execution", async () => {
    const missionId = "unknown-write-outcome";
    let interrupted = false;
    const service = serviceWithFailure((boundary, context) => {
      if (!interrupted && boundary === "after_node_worker_before_record" && context.nodeId === "N7") {
        interrupted = true;
        throw new Error("simulated process interruption after artifact write");
      }
    });
    await service.submit(submission(missionId));
    await service.approveExecution(missionId, { approvedBy: APPROVER });
    const candidateHash = service.get(missionId).authority.candidateHash;
    expect(candidateHash).not.toBeNull();

    await expect(service.approveCandidate(missionId, {
      approvedBy: APPROVER,
      candidateHash,
    })).rejects.toThrow("simulated process interruption after artifact write");

    const artifactPath = path.join(root, "artifacts", ARTIFACT_NAME);
    expect(existsSync(artifactPath)).toBe(true);
    const bytesAfterFirstWrite = readFileSync(artifactPath, "utf8");
    const beforeRestart = new AgenticPlanJournal(database);
    const node = beforeRestart.requireNode(service.get(missionId).planId, "N7");
    const store = beforeRestart.createWorkerRecordStore(() => new Date().toISOString());
    const uncertainClaim = store.inspectActiveClaim(node.idempotencyKey);
    expect(node.state).toBe("running");
    expect(uncertainClaim).not.toBeNull();
    expect(store.read(node.idempotencyKey)).toBeNull();
    expect(beforeRestart.countArtifactWrites(missionId)).toBe(0);

    const restarted = restart(() => AFTER_EXECUTION_WINDOW);
    const reconciled = restarted.reconcileNode(missionId, "N7");
    const restartedJournal = new AgenticPlanJournal(database);
    const restartedStore = restartedJournal.createWorkerRecordStore(() => new Date().toISOString());

    expect(reconciled.reconciliationOutcome).toBe("conflict");
    expect(restartedStore.inspectActiveClaim(node.idempotencyKey)).toEqual(uncertainClaim);
    await expect(restarted.resumeNode(missionId, "N7"))
      .rejects.toMatchObject({ code: "AGENTIC_NODE_RECONCILIATION_CONFLICT" });
    expect(readFileSync(artifactPath, "utf8")).toBe(bytesAfterFirstWrite);
    expect(restartedJournal.countArtifactWrites(missionId)).toBe(0);
    expect(restartedStore.read(node.idempotencyKey)).toBeNull();
    expect(restartedStore.inspectActiveClaim(node.idempotencyKey)).toEqual(uncertainClaim);
  });
});
