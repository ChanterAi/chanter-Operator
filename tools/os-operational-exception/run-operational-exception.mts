/**
 * CHANTER OS — operational exception mission proof.
 *
 * Governs one operational exception end to end and proves the properties that
 * make it safe to point at a real system later:
 *
 *     ObservedState -> DesiredState -> StateDelta -> bounded plan
 *       -> governed worker execution -> exact human authority
 *       -> one simulated external side effect -> independent verification
 *       -> TerminalOutcome -> ValueObservation
 *
 * ## What "restart" means here, exactly
 *
 * Every restart below constructs a **new mission service and a new connector
 * instance over the same durable files** — a fresh SQLite handle and a fresh
 * connector store handle, holding no in-memory state from before. That is what
 * a restarted process is from the durable state's point of view, and it is what
 * every recovery claim in this proof is measured against. It is *not* an OS
 * process kill; the artifact says so rather than letting the stronger reading
 * stand.
 *
 * ## Zero real external writes
 *
 * The connector's entire state is a JSON file under this run's temporary root.
 * There is no network path in the fabric's tool surface at all, so "no real
 * external write occurred" is a structural fact rather than an observation.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDatabase } from "../../apps/backend/src/db/database.js";
import { AgenticMissionService } from "../../apps/backend/src/agentic/agenticMissionService.js";
import { AgenticPlanJournal } from "../../apps/backend/src/agentic/agenticPlanJournal.js";
import {
  AGENTIC_EXCEPTION_MISSION_CAPABILITIES,
  AGENTIC_TOOLS,
} from "../../apps/backend/src/agentic/agenticCapabilityRegistry.js";
import {
  connectorRecordStateHash,
  createSimulatedConnector,
  SIMULATED_CONNECTOR_ID,
  type ConnectorAppliedAction,
  type SimulatedConnector,
} from "../../apps/backend/src/agentic/agenticSimulatedConnector.js";
import type {
  AgenticGovernanceDecision,
  AgenticGovernanceSnapshot,
  AgenticPlanGovernorPort,
} from "../../apps/backend/src/agentic/agenticPlanGovernorPort.js";

const operatorRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const argv = process.argv.slice(2);
const keepArtifacts = argv.includes("--keep");
const repeatIndex = Number.parseInt(
  argv[argv.indexOf("--run") + 1] ?? "1",
  10,
);
const outputDir = path.resolve(operatorRoot, path.join("var", "os-operational-exception"));

const APPROVER = "founder";
const TARGET = "INV-1001";
const startedAt = new Date().toISOString();

// ---------------------------------------------------------------------------
// Step recording
// ---------------------------------------------------------------------------

interface StepRecord {
  step: number;
  phase: string;
  name: string;
  outcome: "passed" | "failed";
  observed: Record<string, unknown>;
  failure?: string;
}

const steps: StepRecord[] = [];
const observed: Record<string, unknown> = {};
let currentPhase = "";

function phase(name: string): void {
  currentPhase = name;
  console.log("");
  console.log(`--- Phase ${name}`);
}

async function step<T extends Record<string, unknown>>(
  name: string,
  body: () => Promise<T>,
): Promise<T> {
  const index = steps.length + 1;
  try {
    const result = await body();
    steps.push({ step: index, phase: currentPhase, name, outcome: "passed", observed: result });
    console.log(`  [${index}] PASS  ${name}`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    steps.push({
      step: index, phase: currentPhase, name, outcome: "failed", observed: {}, failure: message,
    });
    console.log(`  [${index}] FAIL  ${name}`);
    console.log(`        ${message}`);
    throw error;
  }
}

/** Asserts that a call fails closed, and returns the typed code it failed with. */
async function refuses(body: () => Promise<unknown> | unknown): Promise<string> {
  try {
    await body();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : (error as Error).message;
  }
  throw new Error("Expected a refusal, but the call succeeded.");
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "chanter-os-exception-"));
const databasePath = path.join(temporaryRoot, "operator.sqlite");
const connectorRoot = path.join(temporaryRoot, "connector");
mkdirSync(connectorRoot, { recursive: true });
mkdirSync(path.join(temporaryRoot, "fixtures"), { recursive: true });
mkdirSync(path.join(temporaryRoot, "artifacts"), { recursive: true });

/**
 * The initial condition the brief names: an invoice and its expected payment
 * disagree on one bounded field, and the record is not payment-ready.
 */
const INITIAL_RECORD = Object.freeze({
  targetId: TARGET,
  revision: "r1",
  fields: Object.freeze({
    invoiceAmount: 4820.5,
    reconciledAmount: 4795,
    status: "discrepancy",
  }),
});

const EXPECTED_PAYMENT = 4820.5;

function admitAllReady(): AgenticPlanGovernorPort {
  return {
    configured: true,
    async govern(snapshot: AgenticGovernanceSnapshot): Promise<AgenticGovernanceDecision> {
      const completed = new Set(
        snapshot.nodes.filter((node) => node.state === "completed").map((node) => node.nodeId),
      );
      const admitted = snapshot.nodes
        .filter((node) =>
          // `failed_recoverable` is admissible because that is what "recoverable"
          // means: a node owed another bounded attempt. The attempt ceiling is
          // what stops it from being owed one forever, and it is enforced here
          // rather than assumed — a node at its limit is never admitted.
          (node.state === "blocked" || node.state === "ready" || node.state === "failed_recoverable")
          && node.dependsOn.every((dependency) => completed.has(dependency))
          && node.attempts < node.attemptLimit)
        .slice(0, snapshot.maxParallelism)
        .map((node) => node.nodeId);
      return {
        admitted,
        holds: [],
        running: snapshot.nodes.filter((node) => node.state === "running").map((node) => node.nodeId),
        maxParallelism: snapshot.maxParallelism,
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

function submission(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "chanter.agentic-work.v1",
    missionId: "exception-1",
    traceId: "exception-1-trace",
    workspaceId: "chanter-os",
    actorId: APPROVER,
    missionKind: "operational_exception",
    objective: `Reconcile invoice ${TARGET} against the expected payment record.`,
    constraints: [],
    acceptanceCriteria: [{
      criterionId: "ac-reconciled",
      statement: "The invoice is reconciled into a payment-ready state.",
      check: "human_judgment",
    }],
    riskClass: "local_write",
    verifiabilityClass: "deterministic",
    authorityPolicy: {
      approvalRequiredCapabilities: ["connector.state.apply"],
      approvalRequiredRiskClasses: ["local_write"],
      approverRole: APPROVER,
    },
    timeBudgetMs: 600_000,
    maxParallelism: 1,
    executionPolicy: "cheapest_sufficient",
    allowedCapabilities: [...AGENTIC_EXCEPTION_MISSION_CAPABILITIES],
    forbiddenCapabilities: [],
    contextRequirements: [],
    exceptionContract: {
      connectorId: SIMULATED_CONNECTOR_ID,
      targetId: TARGET,
      desiredFields: [
        { field: "reconciledAmount", value: EXPECTED_PAYMENT },
        { field: "status", value: "payment_ready" },
      ],
      acceptanceConstraints: [
        {
          constraintId: "c-amount",
          field: "reconciledAmount",
          comparison: "equals",
          value: EXPECTED_PAYMENT,
          statement: `The reconciled amount equals the expected payment of ${EXPECTED_PAYMENT}.`,
        },
        {
          constraintId: "c-status",
          field: "status",
          comparison: "equals",
          value: "payment_ready",
          statement: "The invoice is marked payment_ready.",
        },
      ],
    },
    requestedAt: startedAt,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Restartable harness
// ---------------------------------------------------------------------------

interface Harness {
  readonly service: AgenticMissionService;
  readonly journal: AgenticPlanJournal;
  readonly connector: SimulatedConnector;
  close(): void;
}

/**
 * One "process".
 *
 * A fresh database handle and a fresh connector handle over the same files,
 * holding nothing in memory from any previous instance. Calling this again is
 * the restart every recovery proof below is measured against.
 */
function open(options: {
  readonly applyInterrupt?: (action: ConnectorAppliedAction) => void;
} = {}): Harness {
  const database = createDatabase(databasePath);
  const connector = createSimulatedConnector({
    root: connectorRoot,
    now: () => new Date().toISOString(),
    ...(options.applyInterrupt ? { applyInterrupt: options.applyInterrupt } : {}),
  });
  const service = new AgenticMissionService({
    database,
    governor: admitAllReady(),
    connector,
    configuration: {
      paths: {
        repositories: {},
        fixtureRoot: path.join(temporaryRoot, "fixtures"),
        artifactRoot: path.join(temporaryRoot, "artifacts"),
      },
      governor: { pythonExecutable: "python", governorRoot: temporaryRoot, timeoutMs: 30_000 },
      approvalTtlMs: 1_800_000,
      authorityRevision: "0".repeat(40),
      providers: {
        localModelBaseUrl: "",
        simulatorEnabled: false,
        simulatorScenario: "disabled",
        openRouterApiKey: "",
        openRouterBaseUrl: "https://openrouter.ai",
      },
    },
  });
  return {
    service,
    journal: new AgenticPlanJournal(database),
    connector,
    close: () => database.close(),
  };
}

/** Drives a mission until it needs a human or reaches a terminal state. */
async function driveToAuthority(harness: Harness, missionId: string): Promise<void> {
  await requireHarness().service.approveExecution(missionId, { approvedBy: APPROVER });
  for (let tick = 0; tick < 8; tick += 1) {
    const view = requireHarness().service.get(missionId);
    if (view.status !== "running") break;
    await requireHarness().service.advance(missionId);
  }
}

/** Approves the exact compiled action contract and lets the plan finish. */
async function approveAndFinish(harness: Harness, missionId: string): Promise<void> {
  const view = requireHarness().service.get(missionId);
  const candidateHash = String(view.authority.candidateHash ?? "");
  await requireHarness().service.approveCandidate(missionId, { approvedBy: APPROVER, candidateHash });
  for (let tick = 0; tick < 8; tick += 1) {
    const current = requireHarness().service.get(missionId);
    if (current.status === "completed" || current.status.startsWith("failed")) break;
    await requireHarness().service.advance(missionId);
  }
}

/**
 * Writes a record through a connector handle of its own.
 *
 * Used to stand in for something *other than this mission* changing the source.
 * A separate handle matters: a concurrent writer is by definition not the
 * instance the mission is holding.
 */
function reseed(
  targetId: string,
  revision: string,
  fields: Readonly<Record<string, string | number | boolean | null>>,
): void {
  const writer = createSimulatedConnector({ root: connectorRoot, now: () => new Date().toISOString() });
  writer.seed([{ targetId, revision, fields }]);
}

function connectorWrites(): number {
  // Read from a fresh handle so the count is durable truth, not a live counter.
  const probe = createSimulatedConnector({ root: connectorRoot, now: () => "" });
  const record = probe.read(TARGET);
  return record === null ? 0 : Number.parseInt(record.revision.replace(/^r/, ""), 10) - 1;
}

// ---------------------------------------------------------------------------
// The proof
// ---------------------------------------------------------------------------

let verdict = "FAIL";
let failure: string | null = null;
/**
 * Declared out here so cleanup can close it.
 *
 * On Windows an open SQLite handle makes the temporary root undeletable, and a
 * teardown that throws would turn a passing proof into a non-zero exit — a gate
 * wiring this in would then report failure for a run that proved everything.
 */
let harness: Harness | null = null;

/** The live harness, or a clear failure rather than a null dereference. */
function requireHarness(): Harness {
  if (!harness) throw new Error("No harness is open.");
  return harness;
}

try {
  console.log("CHANTER OS — operational exception mission proof");
  console.log(`  run: ${repeatIndex}`);
  console.log(`  temporary root: ${temporaryRoot}`);
  console.log(`  connector: ${SIMULATED_CONNECTOR_ID} (local store, zero real external writes)`);

  // =========================================================================
  phase("A — intake: observed, desired, delta");
  // =========================================================================

  harness = open();
  requireHarness().connector.seed([INITIAL_RECORD]);

  const intake = await step(
    "Compile one mission from a real discrepancy into a bounded state delta",
    async () => {
      const { view } = await requireHarness().service.submit(submission());
      const mission = requireHarness().journal.requireMission("exception-1");
      const state = mission.exceptionState;
      assert.ok(state, "Intake must establish observed, desired, and delta state.");

      // ObservedState is what the connector actually held.
      assert.equal(state.observed.sourceSystemId, SIMULATED_CONNECTOR_ID);
      assert.equal(state.observed.sourceRevision, "r1");
      assert.equal(state.observed.observationHash.length, 64);

      // DesiredState was declared by the human, before anything was read.
      assert.equal(state.desired.desiredStateHash.length, 64);
      assert.equal(state.desired.acceptanceConstraints.length, 2);

      // StateDelta is bounded to exactly the fields that disagree.
      const changed = state.delta.changes.map((change) => change.field).sort();
      assert.deepEqual(changed, ["reconciledAmount", "status"]);
      assert.equal(state.delta.observationHash, state.observed.observationHash);
      assert.equal(state.delta.desiredStateHash, state.desired.desiredStateHash);

      // The connector declared what it can do before anything bound to it.
      assert.equal(state.connectorManifest.compensationSupport, "none");
      assert.equal(state.connectorManifest.realExternalWrites, false);
      assert.equal(state.connectorManifest.capabilities.length, 1);

      observed.observationHash = state.observed.observationHash;
      observed.desiredStateHash = state.desired.desiredStateHash;
      observed.deltaHash = state.delta.deltaHash;
      return {
        missionId: view.missionId,
        planId: view.planId,
        observationHash: state.observed.observationHash,
        desiredStateHash: state.desired.desiredStateHash,
        deltaHash: state.delta.deltaHash,
        changedFields: changed,
        connectorWrites: connectorWrites(),
      };
    },
  );

  await step("Prove the plan is the exception shape and nothing was written yet", async () => {
    const nodes = requireHarness().service.nodes("exception-1");
    const shape = nodes.map((node) => `${node.nodeId}:${node.nodeType}`);
    assert.deepEqual(shape, [
      "X1:state_observe",
      "X2:action_compile",
      "X3:authority_checkpoint",
      "X4:connector_apply",
      "X5:outcome_verify",
    ]);
    // The one consequential node gets a single attempt, by construction.
    assert.equal(nodes.find((node) => node.nodeId === "X4")?.attemptLimit, 1);
    assert.equal(connectorWrites(), 0, "Nothing may be written before a human decides.");
    return { shape, applyAttemptLimit: 1, connectorWrites: 0 };
  });

  await step("Refuse a mission whose record already satisfies the desired state", async () => {
    // Not an exception at all. Compiling a plan for it would put a meaningless
    // approval in front of a person.
    const code = await refuses(() => requireHarness().service.submit(submission({
      missionId: "exception-no-delta",
      traceId: "exception-no-delta-trace",
      exceptionContract: {
        connectorId: SIMULATED_CONNECTOR_ID,
        targetId: TARGET,
        desiredFields: [{ field: "status", value: "discrepancy" }],
        acceptanceConstraints: [{
          constraintId: "c-noop",
          field: "status",
          comparison: "equals",
          value: "discrepancy",
          statement: "The status is unchanged.",
        }],
      },
    })));
    assert.equal(code, "AGENTIC_EXCEPTION_NO_DELTA");
    return { refusedWith: code };
  });

  await step("Refuse a mission naming a connector this deployment does not run", async () => {
    const code = await refuses(() => requireHarness().service.submit(submission({
      missionId: "exception-wrong-connector",
      traceId: "exception-wrong-connector-trace",
      exceptionContract: {
        connectorId: "connector.simulated.other.v1",
        targetId: TARGET,
        desiredFields: [{ field: "status", value: "payment_ready" }],
        acceptanceConstraints: [{
          constraintId: "c-status",
          field: "status",
          comparison: "equals",
          value: "payment_ready",
          statement: "The invoice is payment_ready.",
        }],
      },
    })));
    assert.equal(code, "AGENTIC_CONNECTOR_MISMATCH");
    return { refusedWith: code };
  });

  await step("Refuse an acceptance constraint judging a field the mission never sets", async () => {
    const code = await refuses(() => requireHarness().service.submit(submission({
      missionId: "exception-orphan-constraint",
      traceId: "exception-orphan-constraint-trace",
      exceptionContract: {
        connectorId: SIMULATED_CONNECTOR_ID,
        targetId: TARGET,
        desiredFields: [{ field: "status", value: "payment_ready" }],
        acceptanceConstraints: [{
          constraintId: "c-orphan",
          field: "reconciledAmount",
          comparison: "equals",
          value: EXPECTED_PAYMENT,
          statement: "The amount matches.",
        }],
      },
    })));
    assert.equal(code, "AGENTIC_INTENT_EXCEPTION_CONTRACT_AMBIGUOUS");
    return { refusedWith: code };
  });

  // =========================================================================
  phase("B — bounded execution up to the human boundary");
  // =========================================================================

  const compiled = await step(
    "Observe, compile one action contract, and stop at the authority checkpoint",
    async () => {
      await driveToAuthority(requireHarness(), "exception-1");
      const view = requireHarness().service.get("exception-1");
      assert.equal(view.status, "awaiting_authority");

      const nodes = requireHarness().service.nodes("exception-1");
      const byId = new Map(nodes.map((node) => [node.nodeId, node]));
      assert.equal(byId.get("X1")?.state, "completed");
      assert.equal(byId.get("X2")?.state, "completed");
      assert.equal(byId.get("X4")?.state, "blocked", "The write must be unreachable before approval.");

      // The observe node re-read the source and found it unmoved.
      const observation = byId.get("X1")?.output as Record<string, unknown>;
      assert.equal(observation.matchesIntakeObservation, true);

      const action = byId.get("X2")?.output as Record<string, unknown>;
      assert.equal(String(action.capability), "record.reconcile");
      assert.equal(Number(action.changedFieldCount), 2);

      assert.ok(view.authority.candidateHash, "An action contract must be bound before approval.");
      assert.equal(view.authority.approvedCandidateHash, null);
      assert.equal(connectorWrites(), 0, "Still nothing written.");

      observed.actionContractHash = String(action.actionContractHash);
      observed.idempotencyKey = String(action.idempotencyKey);
      return {
        status: view.status,
        actionContractHash: String(action.actionContractHash),
        idempotencyKey: String(action.idempotencyKey),
        connectorWrites: 0,
      };
    },
  );

  await step("Refuse an approval bound to a different action", async () => {
    const code = await refuses(() => requireHarness().service.approveCandidate("exception-1", {
      approvedBy: APPROVER,
      candidateHash: "0".repeat(64),
    }));
    assert.equal(code, "AGENTIC_AUTHORITY_CANDIDATE_MISMATCH");
    assert.equal(connectorWrites(), 0, "A refused approval must write nothing.");
    return { refusedWith: code, connectorWrites: 0 };
  });

  // =========================================================================
  phase("C — recovery A: restart before the write");
  // =========================================================================

  await step("Restart before the write and preserve the same approval subject", async () => {
    const before = requireHarness().service.get("exception-1").authority.candidateHash;
    harness!.close();
    harness = open();

    const after = requireHarness().service.get("exception-1");
    assert.equal(after.authority.candidateHash, before, "The approval subject must survive a restart.");
    assert.equal(after.status, "awaiting_authority");
    assert.equal(connectorWrites(), 0, "A restart before the write must produce no side effect.");
    return { candidateHashPreserved: true, connectorWrites: 0, status: after.status };
  });

  // =========================================================================
  phase("D — the one approved side effect, and its verification");
  // =========================================================================

  const applied = await step(
    "Apply exactly one approved action and verify it independently",
    async () => {
      await approveAndFinish(requireHarness(), "exception-1");
      const view = requireHarness().service.get("exception-1");
      assert.equal(view.status, "completed");

      const nodes = requireHarness().service.nodes("exception-1");
      const byId = new Map(nodes.map((node) => [node.nodeId, node]));
      const apply = byId.get("X4")?.output as Record<string, unknown>;
      assert.equal(apply.performedWrite, true);
      assert.equal(Number(apply.writeCount), 1);

      // The oracle re-read the connector rather than trusting the write.
      const verification = byId.get("X5")?.output as Record<string, unknown>;
      assert.equal(verification.outcomeVerified, true);
      assert.equal(Number(verification.connectorWriteCount), 1);
      assert.deepEqual(verification.unsatisfiedConstraintIds, []);

      // And the connector's own state really did change, exactly once.
      const record = requireHarness().connector.read(TARGET);
      assert.equal(record?.fields.reconciledAmount, EXPECTED_PAYMENT);
      assert.equal(record?.fields.status, "payment_ready");
      assert.equal(record?.revision, "r2");
      assert.equal(connectorWrites(), 1);

      const outcome = requireHarness().service.terminalOutcome("exception-1");
      assert.equal(outcome.state, "completed_verified");
      assert.equal(outcome.verified, true);

      observed.terminalState = outcome.state;
      return {
        status: view.status,
        terminalState: outcome.state,
        performedWrite: true,
        connectorWrites: 1,
        recordRevision: record?.revision,
        reconciledAmount: record?.fields.reconciledAmount,
        statusField: record?.fields.status,
      };
    },
  );

  await step("Report a bounded value observation counted from durable rows", async () => {
    const value = requireHarness().service.exceptionValueObservation("exception-1");
    assert.equal(value.exceptionDetected, 1);
    assert.equal(value.stateChangingActions, 1);
    assert.equal(value.duplicateActions, 0);
    assert.equal(value.humanApprovals, 1);
    assert.equal(value.verificationCount, 1);
    assert.equal(value.providerCalls, 0, "This plan routes nothing to a model.");
    assert.equal(value.providerCostMicros, 0);
    assert.ok(
      value.timeToVerifiedResolutionMs !== null && value.timeToVerifiedResolutionMs >= 0,
      "A verified mission must report how long it took.",
    );
    observed.valueObservation = value as unknown as Record<string, unknown>;
    return { ...value } as unknown as Record<string, unknown>;
  });

  // =========================================================================
  phase("E — recovery C: restart after verified completion");
  // =========================================================================

  await step("Restart after completion and re-report only", async () => {
    const beforeWrites = connectorWrites();
    harness!.close();
    harness = open();

    const view = requireHarness().service.get("exception-1");
    const outcome = requireHarness().service.terminalOutcome("exception-1");
    assert.equal(view.status, "completed");
    assert.equal(outcome.state, "completed_verified");
    assert.equal(connectorWrites(), beforeWrites, "A restart after completion must write nothing.");

    // Replaying the identical submission is a replay, never a second mission.
    const replayed = await requireHarness().service.submit(submission());
    assert.equal(replayed.replayed, true);
    assert.equal(connectorWrites(), beforeWrites, "A terminal replay must buy nothing.");
    return {
      replayed: true,
      connectorWrites: `${beforeWrites} -> ${connectorWrites()}`,
      terminalState: outcome.state,
    };
  });

  // =========================================================================
  phase("F — recovery B: the ambiguous window");
  // =========================================================================

  const ambiguous = await step(
    "Interrupt after the connector applied but before the outcome was committed",
    async () => {
      // A second mission over a second record, so the first mission's evidence
      // is untouched by anything this scenario does.
      const secondTarget = "INV-1002";
      requireHarness().connector.seed([{
        targetId: secondTarget,
        revision: "r1",
        fields: { invoiceAmount: 900, reconciledAmount: 880, status: "discrepancy" },
      }]);

      harness!.close();
      let interrupted: ConnectorAppliedAction | null = null;
      // One shot, because a process is lost once. Re-arming it for every
      // subsequent apply would not simulate an interruption — it would simulate
      // a permanently broken connector, and the recovery it then "proved" would
      // be recovery from a fault that does not exist.
      let armed = true;
      harness = open({
        applyInterrupt: (action) => {
          if (!armed) return;
          armed = false;
          interrupted = action;
          // The connector has durably applied the action; the caller is about
          // to learn nothing. This is the exact window reconciliation exists for.
          throw new Error("simulated process loss after the connector applied");
        },
      });

      const missionId = "exception-ambiguous";
      await requireHarness().service.submit(submission({
        missionId,
        traceId: `${missionId}-trace`,
        exceptionContract: {
          connectorId: SIMULATED_CONNECTOR_ID,
          targetId: secondTarget,
          desiredFields: [
            { field: "reconciledAmount", value: 900 },
            { field: "status", value: "payment_ready" },
          ],
          acceptanceConstraints: [
            {
              constraintId: "c-amount",
              field: "reconciledAmount",
              comparison: "equals",
              value: 900,
              statement: "The reconciled amount equals the expected payment of 900.",
            },
            {
              constraintId: "c-status",
              field: "status",
              comparison: "equals",
              value: "payment_ready",
              statement: "The invoice is marked payment_ready.",
            },
          ],
        },
      }));
      await driveToAuthority(requireHarness(), missionId);
      const candidateHash = String(requireHarness().service.get(missionId).authority.candidateHash ?? "");
      await requireHarness().service.approveCandidate(missionId, { approvedBy: APPROVER, candidateHash });
      for (let tick = 0; tick < 4; tick += 1) {
        const view = requireHarness().service.get(missionId);
        if (view.status !== "running") break;
        await requireHarness().service.advance(missionId);
      }

      const record = requireHarness().connector.read(secondTarget);
      assert.ok(interrupted, "The interrupt must have fired after a real application.");
      assert.equal(record?.revision, "r2", "The connector really did apply the action.");

      const node = requireHarness().service.nodes(missionId).find((entry) => entry.nodeId === "X4");
      assert.notEqual(node?.state, "completed", "The outcome was never committed upstream.");

      observed.ambiguousMissionId = missionId;
      observed.ambiguousTarget = secondTarget;
      observed.ambiguousIdempotencyKey = interrupted === null
        ? ""
        : (interrupted as ConnectorAppliedAction).idempotencyKey;
      return {
        missionId,
        connectorApplied: true,
        recordRevision: record?.revision,
        applyNodeState: String(node?.state),
      };
    },
  );

  await step("Reconcile the ambiguity against the connector, then resume with no second write", async () => {
    const missionId = String(ambiguous.missionId);
    const target = String(observed.ambiguousTarget);

    // Restart without the interrupt: a live process again, over durable state
    // it did not create.
    harness!.close();
    harness = open();

    const beforeRevision = requireHarness().connector.read(target)?.revision;

    // A blind retry is refused. Reconciliation must happen first.
    const refusal = await refuses(() => requireHarness().service.resumeNode(missionId, "X4"));
    assert.equal(refusal, "AGENTIC_NODE_RECONCILIATION_REQUIRED");

    const reconciled = requireHarness().service.reconcileNode(missionId, "X4");
    assert.equal(
      reconciled.reconciliationOutcome,
      "worker_result_found",
      "The connector's own books prove the action landed.",
    );

    await requireHarness().service.resumeNode(missionId, "X4");
    for (let tick = 0; tick < 6; tick += 1) {
      const view = requireHarness().service.get(missionId);
      if (view.status === "completed" || view.status.startsWith("failed")) break;
      await requireHarness().service.advance(missionId);
    }

    const afterRevision = requireHarness().connector.read(target)?.revision;
    assert.equal(afterRevision, beforeRevision, "Recovery must not apply the action a second time.");

    const view = requireHarness().service.get(missionId);
    assert.equal(view.status, "completed");
    const outcome = requireHarness().service.terminalOutcome(missionId);
    assert.equal(outcome.state, "completed_verified");

    const apply = requireHarness().service.nodes(missionId)
      .find((node) => node.nodeId === "X4")?.output as Record<string, unknown>;
    assert.equal(apply.performedWrite, false, "The resumed node replayed rather than re-applied.");

    const value = requireHarness().service.exceptionValueObservation(missionId);
    assert.equal(value.stateChangingActions, 1);
    assert.equal(value.duplicateActions, 0);

    observed.ambiguousRecovered = true;
    return {
      resumeBeforeReconcile: refusal,
      reconciliationOutcome: reconciled.reconciliationOutcome,
      connectorRevision: `${String(beforeRevision)} -> ${String(afterRevision)}`,
      performedWriteOnResume: false,
      duplicateActions: 0,
      terminalState: outcome.state,
    };
  });

  // =========================================================================
  phase("G — fail-closed proofs");
  // =========================================================================

  await step("Refuse an action compiled against a source that moved", async () => {
    // A third record, changed by something else between submission and
    // execution — the stale-observation and stale-writer case.
    const target = "INV-1003";
    requireHarness().connector.seed([{
      targetId: target,
      revision: "r1",
      fields: { invoiceAmount: 250, reconciledAmount: 200, status: "discrepancy" },
    }]);

    const missionId = "exception-stale";
    await requireHarness().service.submit(submission({
      missionId,
      traceId: `${missionId}-trace`,
      exceptionContract: {
        connectorId: SIMULATED_CONNECTOR_ID,
        targetId: target,
        desiredFields: [{ field: "status", value: "payment_ready" }],
        acceptanceConstraints: [{
          constraintId: "c-status",
          field: "status",
          comparison: "equals",
          value: "payment_ready",
          statement: "The invoice is marked payment_ready.",
        }],
      },
    }));

    // A concurrent writer moves the record after intake observed it.
    reseed(target, "r9", { invoiceAmount: 250, reconciledAmount: 249, status: "under_review" });

    await driveToAuthority(requireHarness(), missionId);

    const nodes = requireHarness().service.nodes(missionId);
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const observation = byId.get("X1")?.output as Record<string, unknown> | undefined;
    assert.equal(
      observation?.matchesIntakeObservation,
      false,
      "The observe node must detect that the source moved.",
    );
    assert.notEqual(byId.get("X2")?.state, "completed", "A stale action must not compile.");
    assert.equal(byId.get("X4")?.state, "blocked", "The write stays unreachable.");
    assert.equal(
      requireHarness().service.get(missionId).authority.candidateHash,
      null,
      "No approval may be offered for an action that cannot be applied.",
    );
    const record = requireHarness().connector.read(target);
    assert.equal(record?.revision, "r9", "The concurrent writer's state is untouched.");

    const outcome = requireHarness().service.terminalOutcome(missionId);
    assert.notEqual(outcome.state, "completed_verified");

    return {
      matchesIntakeObservation: false,
      actionCompiled: false,
      candidateOffered: false,
      terminalState: outcome.state,
    };
  });

  await step("Refuse a connector action whose pre-state no longer holds", async () => {
    // The pre-state check belongs to the connector, and this exercises it
    // directly: an action carrying a stale expected hash must be refused at the
    // boundary even if everything upstream were confused.
    const record = requireHarness().connector.read(TARGET);
    assert.ok(record);
    const code = await refuses(() => requireHarness().connector.apply({
      capability: "record.reconcile",
      targetId: TARGET,
      expectedPreStateHash: "0".repeat(64),
      writePayload: [{ field: "status", value: "payment_ready" }],
      writePayloadHash: "0".repeat(64),
      idempotencyKey: "never-applied-key",
    }));
    assert.equal(code, "CONNECTOR_PRE_STATE_MISMATCH");
    assert.equal(requireHarness().connector.read(TARGET)?.revision, record.revision, "Nothing changed.");
    return { refusedWith: code, connectorWrites: connectorWrites() };
  });

  await step("Refuse a connector capability and a field the manifest does not declare", async () => {
    const record = requireHarness().connector.read(TARGET);
    assert.ok(record);
    const preStateHash = connectorRecordStateHash(record);

    const unknownCapability = await refuses(() => requireHarness().connector.apply({
      capability: "record.delete",
      targetId: TARGET,
      expectedPreStateHash: preStateHash,
      writePayload: [{ field: "status", value: "void" }],
      writePayloadHash: "0".repeat(64),
      idempotencyKey: "unknown-capability-key",
    }));
    assert.equal(unknownCapability, "CONNECTOR_CAPABILITY_UNKNOWN");

    const unwritableField = await refuses(() => requireHarness().connector.apply({
      capability: "record.reconcile",
      targetId: TARGET,
      expectedPreStateHash: preStateHash,
      writePayload: [{ field: "invoiceAmount", value: 1 }],
      writePayloadHash: "0".repeat(64),
      idempotencyKey: "unwritable-field-key",
    }));
    assert.equal(unwritableField, "CONNECTOR_FIELD_NOT_WRITABLE");

    assert.equal(requireHarness().connector.read(TARGET)?.revision, record.revision, "Nothing changed.");
    return { unknownCapability, unwritableField, connectorWrites: connectorWrites() };
  });

  await step("Report an unverified outcome as unverified, never as complete", async () => {
    // The oracle judges the connector, not the worker's report. A record whose
    // constraints do not hold must fail verification even though the write
    // itself succeeded.
    const target = "INV-1004";
    reseed(target, "r1", { invoiceAmount: 70, reconciledAmount: 60, status: "discrepancy" });

    // The sabotage rides the connector's own post-apply hook, so it lands
    // deterministically *between* the action and the oracle's read. That is the
    // window that matters: a verifier that only ever reads a state nothing else
    // touched is not being tested.
    harness!.close();
    let sabotaged = false;
    harness = open({
      applyInterrupt: (action) => {
        if (sabotaged || action.targetId !== "INV-1004") return;
        sabotaged = true;
        reseed("INV-1004", "r7", { invoiceAmount: 70, reconciledAmount: 60, status: "discrepancy" });
      },
    });

    const missionId = "exception-disagreement";
    await requireHarness().service.submit(submission({
      missionId,
      traceId: `${missionId}-trace`,
      exceptionContract: {
        connectorId: SIMULATED_CONNECTOR_ID,
        targetId: target,
        desiredFields: [{ field: "reconciledAmount", value: 70 }],
        acceptanceConstraints: [{
          constraintId: "c-amount",
          field: "reconciledAmount",
          comparison: "equals",
          value: 70,
          statement: "The reconciled amount equals the expected payment of 70.",
        }],
      },
    }));
    await driveToAuthority(requireHarness(), missionId);
    await approveAndFinish(requireHarness(), missionId);
    assert.equal(sabotaged, true, "The concurrent writer must have raced the oracle.");

    const verification = requireHarness().service.nodes(missionId)
      .find((node) => node.nodeId === "X5")?.output as Record<string, unknown> | undefined;
    const outcome = requireHarness().service.terminalOutcome(missionId);
    assert.equal(verification?.outcomeVerified, false, "The oracle must not confirm an unmet state.");
    assert.notEqual(outcome.state, "completed_verified");
    assert.equal(outcome.verified, false);

    return {
      outcomeVerified: false,
      unsatisfiedConstraintIds: verification?.unsatisfiedConstraintIds,
      terminalState: outcome.state,
    };
  });

  await step("Prove no real external write and no second authority existed", async () => {
    // Structural, not observational: the fabric's whole tool surface is a
    // closed set of named local operations. There is no network tool, so there
    // is no path by which a real external system could have been reached.
    const networkish = AGENTIC_TOOLS.filter((tool: string) =>
      /http|fetch|net|url|shell|exec|spawn/i.test(tool));
    assert.deepEqual(networkish, [], "The tool surface must expose no network or process tool.");

    // One mission store, one approval mechanism: the exception plan's approval
    // is the same candidate-hash authority the artifact plan uses.
    const mission = requireHarness().journal.requireMission("exception-1");
    assert.ok(mission.approvedCandidateHash, "The approval is recorded on the one mission row.");
    assert.equal(mission.candidateAuthorityRevision, "0".repeat(40));

    observed.realExternalWrites = 0;
    observed.toolSurface = [...AGENTIC_TOOLS];
    return {
      realExternalWrites: 0,
      networkTools: 0,
      missionStores: 1,
      approvalSystems: 1,
      toolCount: AGENTIC_TOOLS.length,
    };
  });

  verdict = "PASS";
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  verdict = "FAIL";
} finally {
  // Closed before cleanup: an open SQLite handle makes the temporary root
  // undeletable on Windows, and the resulting teardown error would report a
  // passing proof as a failing one.
  try {
    harness?.close();
  } catch {
    // Already closed by a restart step. Nothing to release.
  }

  mkdirSync(outputDir, { recursive: true });
  const reportPath = path.join(outputDir, `operational-exception-report-run${repeatIndex}.json`);
  writeFileSync(
    reportPath,
    `${JSON.stringify({
      verdict,
      failure,
      run: repeatIndex,
      startedAt,
      completedAt: new Date().toISOString(),
      connectorId: SIMULATED_CONNECTOR_ID,
      realExternalWrites: 0,
      observed,
      steps,
    }, null, 2)}\n`,
    "utf8",
  );

  console.log("");
  console.log(`Report: ${reportPath}`);
  const passed = steps.filter((entry) => entry.outcome === "passed").length;
  console.log(`${verdict}  (${passed}/${steps.length} steps)`);
  if (failure) console.error(`Failure: ${failure}`);

  // A failed run keeps its state. The connector store is the only record of
  // what the simulated external system actually holds, and deleting it to keep
  // the filesystem tidy would destroy the evidence a failure needs explaining.
  if (!keepArtifacts && verdict === "PASS") {
    // Best effort. A temporary directory that will not delete is untidy, never
    // a reason to report a proof as failed.
    try {
      rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      console.log(`Temporary root could not be removed and was left in place: ${temporaryRoot}`);
    }
  } else {
    console.log(`Kept temporary root: ${temporaryRoot}`);
  }
  process.exitCode = verdict === "PASS" ? 0 : 1;
}
