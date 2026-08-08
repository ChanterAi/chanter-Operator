/**
 * CHANTER OS — bounded human-approved Firestore sandbox write P0-C.
 *
 * The first real external mutation this fabric has ever performed, under the
 * same governance every prior slice proved against a simulated or read-only
 * connector:
 *
 *     real absence -> real ObservedState -> DesiredState -> StateDelta
 *       -> exact ActionContract -> one exact human approval
 *       -> ONE real create-if-absent -> independent read verification
 *       -> conditional delete under the *verified* revision
 *       -> independent absence verification -> completed_verified_compensated
 *
 * ## The budget, and what enforces it
 *
 * Exactly one primary mutation and exactly one compensating mutation. Neither
 * bound is this script's discipline:
 *
 *   - `connector.state.apply_external` declares `writeCount` as `1..1` in its
 *     output schema, so a second primary write is a contract violation;
 *   - the create carries `currentDocument.exists=false`, so a repeat is refused
 *     by Firestore rather than duplicated;
 *   - the delete carries `currentDocument.updateTime`, so it can only remove the
 *     exact object this mission created, in the exact state it verified.
 *
 * ## Why the compensation uses the verified revision
 *
 * X6 depends on X5, not X4. The revision the delete is conditional on comes from
 * the independent verification read, never from the create's own response — the
 * write's account of itself is not evidence about the write.
 *
 * ## Scope
 *
 * One document, in one collection, in one project CHANTER OS owns outright and
 * that holds no customer, payment, or OAuth data. The connector is pinned to
 * that project, database, and collection, and refuses any other target before a
 * request is built.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDatabase } from "../../apps/backend/src/db/database.js";
import { AgenticMissionService } from "../../apps/backend/src/agentic/agenticMissionService.js";
import { AgenticPlanJournal } from "../../apps/backend/src/agentic/agenticPlanJournal.js";
import { AGENTIC_COMPENSATED_EXCEPTION_MISSION_CAPABILITIES } from "../../apps/backend/src/agentic/agenticCapabilityRegistry.js";
import {
  createFirestoreDocumentConnector,
  createSynchronousHttpTransport,
  firestoreDocumentTargetId,
  FIRESTORE_DOCUMENT_CONNECTOR_ID,
  type FirestoreDocumentConnector,
} from "../../apps/backend/src/agentic/agenticFirestoreDocumentConnector.js";
import { deriveDeterministicObjectId } from "../../apps/backend/src/agentic/agenticRealWriteReadiness.js";
import type {
  AgenticGovernanceDecision,
  AgenticGovernanceSnapshot,
  AgenticPlanGovernorPort,
} from "../../apps/backend/src/agentic/agenticPlanGovernorPort.js";

const operatorRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const outputDir = path.resolve(operatorRoot, path.join("var", "os-firestore-sandbox-write"));

const PROJECT = "chanter-os-sandbox";
const DATABASE = "(default)";
const COLLECTION = "chanter_os_real_write_p0";
const APPROVER = "founder";
const MISSION_ID = "p0c-firestore-1";
const ACTION_ID = "create-disposable-probe";
const startedAt = new Date().toISOString();

const credentialPath = process.env.CHANTER_OS_SANDBOX_CREDENTIAL
  ?? "C:\\Users\\IT\\.chanter-os-sandbox\\chanter-os-p0c.sa.json";

/** Deterministic from mission + action identity, and collision-safe. */
const DOCUMENT_ID = deriveDeterministicObjectId({ missionId: MISSION_ID, actionId: ACTION_ID });
const TARGET = firestoreDocumentTargetId({
  project: PROJECT,
  database: DATABASE,
  collection: COLLECTION,
  documentId: DOCUMENT_ID,
});

interface StepRecord {
  step: number;
  name: string;
  outcome: "passed" | "failed";
  observed: Record<string, unknown>;
  failure?: string;
}

const steps: StepRecord[] = [];

async function step<T extends Record<string, unknown>>(
  name: string,
  body: () => Promise<T> | T,
): Promise<T> {
  const index = steps.length + 1;
  try {
    const result = await body();
    steps.push({ step: index, name, outcome: "passed", observed: result });
    console.log(`  [${index}] PASS  ${name}`);
    for (const [key, value] of Object.entries(result)) {
      console.log(`        ${key} = ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    steps.push({ step: index, name, outcome: "failed", observed: {}, failure: message });
    console.log(`  [${index}] FAIL  ${name}`);
    console.log(`        ${message}`);
    throw error;
  }
}

function admitAllReady(): AgenticPlanGovernorPort {
  return {
    configured: true,
    async govern(snapshot: AgenticGovernanceSnapshot): Promise<AgenticGovernanceDecision> {
      const completed = new Set(
        snapshot.nodes.filter((node) => node.state === "completed").map((node) => node.nodeId),
      );
      const admitted = snapshot.nodes
        .filter((node) => node.state === "ready"
          && node.dependsOn.every((dependency) => completed.has(dependency)))
        .map((node) => node.nodeId);
      return { admitted, deferred: [], rejected: [], reason: "test governor admits ready nodes" };
    },
  };
}

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "chanter-p0c-live-"));
mkdirSync(path.join(temporaryRoot, "fixtures"), { recursive: true });
mkdirSync(path.join(temporaryRoot, "artifacts"), { recursive: true });

/**
 * A dry run exercises every line of the governed path against an in-memory
 * Firestore that enforces the same two preconditions the real service does.
 *
 * It exists because §20 permits the live proof to execute **once**. Debugging
 * wiring against the real system would mean spending that one execution on a
 * bug, and a half-applied first attempt is exactly the state this whole slice
 * is designed to avoid producing.
 */
const dryRun = process.env.CHANTER_OS_P0C_DRY_RUN === "1";

function inMemoryFirestore() {
  const store = new Map<string, { fields: Record<string, unknown>; updateTime: string }>();
  let clock = 0;
  return (request: { method: string; url: string; body: string | null }) => {
    const url = new URL(request.url);
    const documentId = url.pathname.split("/").pop() ?? "";
    const existing = store.get(documentId);
    if (request.method === "GET") {
      return existing
        ? { status: 200, body: JSON.stringify({ ...existing }) }
        : { status: 404, body: JSON.stringify({ error: { status: "NOT_FOUND" } }) };
    }
    if (request.method === "PATCH") {
      if (url.searchParams.get("currentDocument.exists") !== "false") {
        return { status: 400, body: JSON.stringify({ error: { status: "INVALID_ARGUMENT" } }) };
      }
      if (existing) return { status: 409, body: JSON.stringify({ error: { status: "ALREADY_EXISTS" } }) };
      clock += 1;
      const created = {
        fields: (JSON.parse(request.body ?? "{}") as { fields?: Record<string, unknown> }).fields ?? {},
        updateTime: `2026-08-08T07:${String(clock).padStart(2, "0")}:00.000000Z`,
      };
      store.set(documentId, created);
      return { status: 200, body: JSON.stringify(created) };
    }
    if (request.method === "DELETE") {
      const expected = url.searchParams.get("currentDocument.updateTime");
      if (!expected) return { status: 400, body: JSON.stringify({ error: { status: "INVALID_ARGUMENT" } }) };
      if (!existing) return { status: 404, body: JSON.stringify({ error: { status: "NOT_FOUND" } }) };
      if (existing.updateTime !== expected) {
        return { status: 400, body: JSON.stringify({ error: { status: "FAILED_PRECONDITION" } }) };
      }
      store.delete(documentId);
      return { status: 200, body: "{}" };
    }
    return { status: 405, body: "{}" };
  };
}

const database = createDatabase(path.join(temporaryRoot, "operator.sqlite"));
const connector: FirestoreDocumentConnector = createFirestoreDocumentConnector({
  project: PROJECT,
  database: DATABASE,
  collection: COLLECTION,
  ...(dryRun
    ? { staticAccessToken: "dry-run", httpImpl: inMemoryFirestore() }
    : { credentialPath, httpImpl: createSynchronousHttpTransport({ timeoutMs: 45_000 }) }),
  now: () => new Date().toISOString(),
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
const journal = new AgenticPlanJournal(database);

/** The payload — bounded, non-secret, and carrying no production identifier. */
const DESIRED_FIELDS = [
  { field: "missionId", value: MISSION_ID },
  { field: "actionId", value: ACTION_ID },
  { field: "createdAt", value: startedAt },
  { field: "probeId", value: DOCUMENT_ID },
];

function submission(): Record<string, unknown> {
  return {
    schemaVersion: "chanter.agentic-work.v1",
    missionId: MISSION_ID,
    traceId: `${MISSION_ID}-trace`,
    workspaceId: "chanter-os",
    actorId: APPROVER,
    missionKind: "operational_exception",
    objective: `Create one disposable probe document in ${COLLECTION} and compensate it.`,
    constraints: [],
    acceptanceCriteria: [{
      criterionId: "ac-doc",
      statement: "The disposable document exists with the exact approved payload.",
      check: "human_judgment",
    }],
    riskClass: "external_write",
    verifiabilityClass: "deterministic",
    authorityPolicy: {
      approvalRequiredCapabilities: [
        "connector.state.apply_external",
        "connector.state.compensate",
      ],
      approvalRequiredRiskClasses: ["external_write"],
      approverRole: APPROVER,
    },
    timeBudgetMs: 600_000,
    maxParallelism: 1,
    executionPolicy: "cheapest_sufficient",
    allowedCapabilities: [...AGENTIC_COMPENSATED_EXCEPTION_MISSION_CAPABILITIES],
    forbiddenCapabilities: [],
    contextRequirements: [],
    exceptionContract: {
      connectorId: FIRESTORE_DOCUMENT_CONNECTOR_ID,
      targetId: TARGET,
      executionMode: "live_compensated",
      desiredFields: DESIRED_FIELDS,
      acceptanceConstraints: [{
        constraintId: "c-probe",
        field: "probeId",
        comparison: "equals",
        value: DOCUMENT_ID,
        statement: `The document carries probeId ${DOCUMENT_ID}.`,
      }],
    },
    requestedAt: startedAt,
  };
}

async function advanceUntilSettled(missionId: string, ticks = 16): Promise<void> {
  for (let tick = 0; tick < ticks; tick += 1) {
    const view = service.get(missionId);
    if (view.status === "completed" || view.status.startsWith("failed")
      || view.status === "reconciliation_required" || view.status === "awaiting_authority") {
      if (view.status !== "running") break;
    }
    await service.advance(missionId);
  }
}

async function main(): Promise<void> {
  console.log("CHANTER OS — bounded human-approved Firestore sandbox write P0-C");
  console.log(`  MODE       ${dryRun ? "DRY RUN (in-memory Firestore, zero real calls)" : "LIVE (real Firestore)"}`);
  console.log(`  project    ${PROJECT}`);
  console.log(`  target     ${TARGET}`);
  console.log(`  credential ${path.basename(credentialPath)} (contents never read into evidence)`);
  console.log("");

  await step("sandbox target is absent before anything is approved", () => {
    const before = connector.read(TARGET);
    assert.equal(before, null, "The disposable document must not exist before the mission.");
    return { exists: false, targetId: TARGET };
  });

  await step("mission intake observes absence and compiles a delta", async () => {
    const { view } = await service.submit(submission());
    const intake = journal.requireMission(MISSION_ID).exceptionState;
    assert.ok(intake, "Intake must carry durable exception state.");
    assert.equal(intake!.observed.sourceRevision, "chanter.absent.v1");
    assert.equal(intake!.delta.changes.length, DESIRED_FIELDS.length);
    return {
      status: view.status,
      observationHash: intake!.observed.observationHash,
      deltaHash: intake!.delta.deltaHash,
      changes: intake!.delta.changes.length,
    };
  });

  await step("plan compiles the compensated seven-node shape", async () => {
    await service.approveExecution(MISSION_ID, { approvedBy: APPROVER });
    await advanceUntilSettled(MISSION_ID);
    const nodes = service.nodes(MISSION_ID);
    const ids = nodes.map((node) => node.nodeId).sort();
    assert.deepEqual(ids, ["X1", "X2", "X3", "X4", "X5", "X6", "X7"]);
    return { nodeIds: ids.join(","), status: service.get(MISSION_ID).status };
  });

  const approval = await step("exact ActionContract is compiled and awaiting one human approval", () => {
    const view = service.get(MISSION_ID);
    assert.equal(view.status, "awaiting_authority");
    const candidateHash = String(view.authority.candidateHash ?? "");
    assert.equal(candidateHash.length, 64);
    return { candidateHash, approver: APPROVER };
  });

  await step("real create-if-absent, independently verified, then compensated", async () => {
    // The one exact human approval, bound to the exact candidate hash.
    await service.approveCandidate(MISSION_ID, {
      approvedBy: APPROVER,
      candidateHash: approval.candidateHash,
    });
    await advanceUntilSettled(MISSION_ID);
    const view = service.get(MISSION_ID);
    if (view.status !== "completed") {
      // Print durable node truth before asserting. A mission that stopped short
      // has a reason recorded on the node that stopped it, and reading it beats
      // inferring one from the mission status.
      for (const node of service.nodes(MISSION_ID)) {
        console.log(`        ${node.nodeId} ${node.state}`
          + `${node.typedError ? ` :: ${JSON.stringify(node.typedError)}` : ""}`);
      }
    }
    return { status: view.status };
  });

  const nodes = new Map(service.nodes(MISSION_ID).map((node) => [node.nodeId, node]));

  await step("X4 performed exactly one real write", () => {
    const output = nodes.get("X4")?.output as Record<string, unknown> | undefined;
    assert.equal(output?.performedWrite, true, "The create must have performed a real write.");
    assert.equal(output?.writeCount, 1);
    return { performedWrite: true, writeCount: 1, idempotencyKey: String(output?.idempotencyKey ?? "") };
  });

  await step("X5 independently verified the created document", () => {
    const output = nodes.get("X5")?.output as Record<string, unknown> | undefined;
    assert.equal(output?.outcomeVerified, true, "Independent verification must confirm the write.");
    assert.equal(output?.recordExists, true);
    const revision = String(output?.verifiedRevision ?? "");
    assert.ok(revision.length > 0, "Verification must report the revision it read.");
    return { outcomeVerified: true, verifiedRevision: revision };
  });

  await step("X6 compensated under the independently verified revision", () => {
    const verify = nodes.get("X5")?.output as Record<string, unknown> | undefined;
    const output = nodes.get("X6")?.output as Record<string, unknown> | undefined;
    assert.equal(output?.compensated, true);
    assert.equal(output?.performedWrite, true);
    assert.equal(output?.connectorCompensationCount, 1);
    assert.equal(
      output?.expectedRevision,
      verify?.verifiedRevision,
      "The delete must be conditional on the revision X5 read, not the one X4 reported.",
    );
    return { compensated: true, expectedRevision: String(output?.expectedRevision ?? "") };
  });

  await step("X7 independently verified absence", () => {
    const output = nodes.get("X7")?.output as Record<string, unknown> | undefined;
    assert.equal(output?.recordAbsent, true);
    assert.equal(output?.absenceVerified, true);
    assert.equal(output?.residualObjectCount, 0);
    return { absenceVerified: true, residualObjectCount: 0 };
  });

  const terminal = await step("mission reaches completed_verified_compensated", () => {
    const outcome = service.terminalOutcome(MISSION_ID);
    assert.equal(outcome.state, "completed_verified_compensated");
    assert.equal(outcome.verified, true);
    return { state: outcome.state, verified: outcome.verified, reason: outcome.reason };
  });

  const value = await step("measured evidence", () => {
    const observation = service.exceptionValueObservation(MISSION_ID);
    const counts = connector.counts();
    assert.equal(observation.realExternalWrites, 1, "Exactly one real external write.");
    assert.equal(observation.compensationWrites, 1, "Exactly one compensating write.");
    assert.equal(observation.duplicateActions, 0);
    assert.equal(observation.blindRetries, 0);
    assert.equal(counts.writes, 1);
    assert.equal(counts.compensations, 1);
    assert.equal(counts.blindRetries, 0);
    return {
      humanApprovals: observation.humanApprovals,
      realExternalWrites: observation.realExternalWrites,
      compensationWrites: observation.compensationWrites,
      duplicateActions: observation.duplicateActions,
      blindRetries: observation.blindRetries,
      connectorReads: counts.reads,
      connectorReconciliationReads: counts.reconciliationReads,
      verificationReads: observation.verificationReads,
      providerCalls: observation.providerCalls,
      providerCostMicros: observation.providerCostMicros,
    };
  });

  await step("sandbox is empty and every transport call was bounded", () => {
    const after = connector.read(TARGET);
    assert.equal(after, null, "The sandbox must be back in its original empty state.");

    // The token exchange is the one POST, and it addresses Google's OAuth
    // endpoint rather than a document. Every call that touches Firestore is one
    // of exactly three shapes, each carrying its precondition.
    const documentCalls = connector.transportCalls().filter((call) => call.path !== "token");
    for (const call of documentCalls) {
      assert.ok(["GET", "PATCH", "DELETE"].includes(call.method), `Unexpected method ${call.method}`);
      // One document per request. No collection-level operation exists.
      assert.equal(call.path.split("/").length, 2, `Unbounded path ${call.path}`);
      if (call.method === "PATCH") assert.equal(call.precondition, "currentDocument.exists=false");
      if (call.method === "DELETE") assert.ok(call.precondition?.startsWith("currentDocument.updateTime="));
    }
    const writes = documentCalls.filter((call) => call.method === "PATCH");
    const deletes = documentCalls.filter((call) => call.method === "DELETE");
    assert.equal(writes.length, 1, "Exactly one create request may have been issued.");
    assert.equal(deletes.length, 1, "Exactly one delete request may have been issued.");
    // No credential material may appear anywhere in the evidence.
    assert.ok(!JSON.stringify(connector.transportCalls()).includes("Bearer"));

    return {
      residualObjects: 0,
      firestoreCalls: documentCalls.length,
      createRequests: writes.length,
      deleteRequests: deletes.length,
      methods: documentCalls.map((call) => call.method).join(","),
    };
  });

  mkdirSync(outputDir, { recursive: true });
  const evidence = {
    slice: "CHANTER OS — Bounded Human-Approved Firestore Sandbox Write P0-C",
    startedAt,
    finishedAt: new Date().toISOString(),
    project: PROJECT,
    database: DATABASE,
    collection: COLLECTION,
    targetId: TARGET,
    documentId: DOCUMENT_ID,
    approvedCandidateHash: approval.candidateHash,
    terminalState: terminal.state,
    measured: value,
    transportCalls: connector.transportCalls(),
    steps,
  };
  writeFileSync(
    path.join(outputDir, "evidence.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8",
  );

  console.log("");
  console.log(`CHANTER OS BOUNDED FIRESTORE SANDBOX REAL WRITE: PASS — ${steps.length}/${steps.length} steps`);
  console.log(`  evidence: ${path.join(outputDir, "evidence.json")}`);
  database.close();
}

main().catch((error) => {
  console.error("");
  console.error(`CHANTER OS BOUNDED FIRESTORE SANDBOX REAL WRITE: FAILED — ${error instanceof Error ? error.message : String(error)}`);
  database.close();
  process.exitCode = 1;
});
