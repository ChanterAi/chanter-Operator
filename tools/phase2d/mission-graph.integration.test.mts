/**
 * Phase 2D cross-repository integration proof.
 *
 * Real components end to end — no mocks anywhere in the execution path:
 *
 *   chanter.mission.graph.v1 envelope
 *   -> real Operator Express app (submit capability token)
 *   -> deterministic graph compiler + durable operator_mission_graphs authority
 *   -> independent control approval bound to the exact SHA-256 graph hash
 *   -> dependency-aware scheduling over the Phase 2C generic mission spine
 *   -> real chanter-agent-runtime executeMission + Loop Governor adapter
 *   -> real no-shell JSON-stdin python process (governor.mission_intake)
 *   -> real Loop Governor tasks + manual relay loops in an isolated data dir
 *   -> graph + node + mission journals and Agent Run Ledger lineage, with
 *      replay / restart / crash-boundary safety and token non-persistence.
 *
 * The P0 acceptance scenario is exactly this file's first test: a two-node
 * sequential graph (node_b depends_on node_a) where node B never starts
 * before node A completes, both executing through the real python transport.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const originalEnvironment = {
  missionSubmitToken: process.env.OPERATOR_MISSION_SUBMIT_TOKEN,
  missionControlToken: process.env.OPERATOR_CONTROL_TOKEN,
  ledgerToken: process.env.OPERATOR_LEDGER_INGEST_TOKEN,
};

const missionSubmitToken = `phase2d-submit-${randomUUID()}`;
const missionControlToken = `phase2d-control-${randomUUID()}`;
const ledgerToken = `phase2d-ledger-${randomUUID()}`;
process.env.OPERATOR_MISSION_SUBMIT_TOKEN = missionSubmitToken;
process.env.OPERATOR_CONTROL_TOKEN = missionControlToken;
process.env.OPERATOR_LEDGER_INGEST_TOKEN = ledgerToken;

const [
  { createApp },
  { AuditLogger },
  { AgentRunLedgerService },
  { createDatabase },
  { GenericMissionService },
  { MissionGraphService },
  { createLoopGovernorMissionExecutor },
  { MockRunner },
  { AutoPosterMissionService },
  { createAutoPosterRuntimeMissionExecutor },
  { OperatorService },
  { ensureWorkspace },
] = await Promise.all([
  import("../../apps/backend/src/app.js"),
  import("../../apps/backend/src/audit/auditLogger.js"),
  import("../../apps/backend/src/agentRunLedger/agentRunLedgerService.js"),
  import("../../apps/backend/src/db/database.js"),
  import("../../apps/backend/src/missions/genericMissionService.js"),
  import("../../apps/backend/src/missions/missionGraphService.js"),
  import("../../apps/backend/src/missions/loopGovernorRuntime.js"),
  import("../../apps/backend/src/runners/mockRunner.js"),
  import("../../apps/backend/src/runtimeMissions/autoPosterMissionService.js"),
  import("../../apps/backend/src/runtimeMissions/autoPosterRuntime.js"),
  import("../../apps/backend/src/services/operatorService.js"),
  import("../../apps/backend/src/workspace/pathGuard.js"),
]);

const operatorRoot = path.resolve(import.meta.dirname, "../..");
const governorRoot = path.resolve(operatorRoot, "../chanter-loop.governor");
const approvalActor = "founder-phase2d-harness";

function resolvePythonExecutable(): string {
  const command = process.platform === "win32" ? "where" : "which";
  const probe = spawnSync(command, ["python"], { encoding: "utf-8" });
  const candidate = probe.stdout?.split(/\r?\n/).find((line) => line.trim());
  assert.ok(
    probe.status === 0 && candidate && path.isAbsolute(candidate.trim()),
    "an absolute python executable is required for the Phase 2D integration proof",
  );
  return candidate!.trim();
}

const pythonExecutable = resolvePythonExecutable();

interface RunningOperator {
  appBaseUrl: string;
  database: DatabaseSync;
  databasePath: string;
  ledger: InstanceType<typeof AgentRunLedgerService>;
  graph: InstanceType<typeof MissionGraphService>;
  server: Server;
}

function startOperator(
  root: string,
  databasePath: string,
  governorDataDir: string,
  graphFailureInjector?: (boundary: string, graphId: string, nodeId: string | null) => void,
): Promise<RunningOperator> {
  const database = createDatabase(databasePath);
  const operatorService = new OperatorService(
    database,
    new AuditLogger(path.join(root, "operator-audit.jsonl")),
    new MockRunner(),
    ensureWorkspace(path.join(root, "workspace")),
  );
  const protectedValues = [missionSubmitToken, missionControlToken, ledgerToken];
  const ledger = new AgentRunLedgerService(database, protectedValues);
  const autoPoster = new AutoPosterMissionService(
    database,
    createAutoPosterRuntimeMissionExecutor({
      baseUrl: "",
      serviceToken: "",
      userId: "",
      timeoutValid: true,
    }),
    { agentRunLedgerService: ledger, protectedValues },
  );
  const executor = createLoopGovernorMissionExecutor({
    pythonExecutable,
    governorRoot,
    dataDir: governorDataDir,
    timeoutMs: 60_000,
    timeoutValid: true,
  });
  const generic = new GenericMissionService(database, executor, {
    agentRunLedgerService: ledger,
    protectedValues,
  });
  const graph = new MissionGraphService(database, generic, {
    protectedValues,
    failureInjector: graphFailureInjector as never,
  });
  const app = createApp(operatorService, autoPoster, ledger, generic, graph);
  return new Promise<RunningOperator>((resolve, reject) => {
    const server: Server = app.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        appBaseUrl: `http://127.0.0.1:${address.port}`,
        database,
        databasePath,
        ledger,
        graph,
        server,
      });
    });
    server.once("error", reject);
  });
}

async function stopOperator(running: RunningOperator): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    running.server.close((error) => (error ? reject(error) : resolve()));
  });
  running.database.close();
}

function restoreEnvironment(): void {
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  restore("OPERATOR_MISSION_SUBMIT_TOKEN", originalEnvironment.missionSubmitToken);
  restore("OPERATOR_CONTROL_TOKEN", originalEnvironment.missionControlToken);
  restore("OPERATOR_LEDGER_INGEST_TOKEN", originalEnvironment.ledgerToken);
}

test.after(() => {
  restoreEnvironment();
});

async function postJson(
  baseUrl: string,
  route: string,
  token: string | null,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function getJson(
  baseUrl: string,
  route: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${route}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function graphNode(nodeId: string, goal: string, dependsOn?: string[]) {
  return {
    nodeId,
    target: { product: "loop_governor", action: "loop_governor.manual_loop.create" },
    objective: `Create the governed manual loop for ${nodeId}.`,
    input: {
      appName: "chanter-operator",
      taskType: "review",
      goal,
      scope: `phase2d integration ${nodeId}`,
    },
    ...(dependsOn ? { dependsOn } : {}),
  };
}

function graphEnvelope(graphId: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "chanter.mission.graph.v1",
    graphId,
    traceId: `${graphId}-trace`,
    idempotencyKey: `${graphId}-key`,
    source: { system: "mission_compiler", requestedBy: "founder-cli" },
    objective: "Execute one dependency-aware two-node review graph through the full spine.",
    tenant: { userId: "founder" },
    nodes: [
      graphNode("node_a", `Review part A of the Phase 2D graph for ${graphId}.`),
      graphNode("node_b", `Review part B of the Phase 2D graph for ${graphId}.`, ["node_a"]),
    ],
    requestedAt: new Date().toISOString(),
    ...overrides,
  };
}

function governorTaskCount(governorDataDir: string): number {
  const tasksDir = path.join(governorDataDir, "tasks");
  if (!existsSync(tasksDir)) return 0;
  return readdirSync(tasksDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
}

function governorLoopCount(governorDataDir: string): number {
  const loopsFile = path.join(governorDataDir, "loops.json");
  if (!existsSync(loopsFile)) return 0;
  const parsed = JSON.parse(readFileSync(loopsFile, "utf-8")) as unknown;
  if (Array.isArray(parsed)) return parsed.length;
  if (parsed && typeof parsed === "object") return Object.keys(parsed).length;
  return 0;
}

function assertNoSecretBytes(databasePath: string, canaries: string[]): void {
  for (const candidate of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (existsSync(candidate)) {
      const bytes = readFileSync(candidate);
      for (const canary of canaries) {
        assert.equal(
          bytes.includes(Buffer.from(canary, "utf8")),
          false,
          `capability token found in ${candidate}`,
        );
      }
    }
  }
}

function assertNoSecretInTree(root: string, canaries: string[]): void {
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const filePath = path.join(entry.parentPath ?? (entry as { path?: string }).path ?? root, entry.name);
    const bytes = readFileSync(filePath);
    for (const canary of canaries) {
      assert.equal(
        bytes.includes(Buffer.from(canary, "utf8")),
        false,
        `capability token found in ${filePath}`,
      );
    }
  }
}

test("Phase 2D P0: two-node sequential graph executes A before B through the real python spine, with replay and restart safety", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "phase2d-graph-"));
  const governorDataDir = mkdtempSync(path.join(os.tmpdir(), "phase2d-governor-"));
  const databasePath = path.join(root, "operator.sqlite");
  const graphId = `phase2d-${randomUUID().slice(0, 8)}`;
  const childA = `graph:${graphId}:node:node_a`;
  const childB = `graph:${graphId}:node:node_b`;
  let running = await startOperator(root, databasePath, governorDataDir);
  try {
    // Malformed graphs are rejected deterministically; nothing persists.
    const cyclic = await postJson(running.appBaseUrl, "/api/mission-graphs", missionSubmitToken,
      graphEnvelope(graphId, {
        nodes: [graphNode("node_a", "a", ["node_b"]), graphNode("node_b", "b", ["node_a"])],
      }));
    assert.equal(cyclic.status, 400);
    assert.equal(cyclic.body.code, "GRAPH_DEPENDENCY_CYCLE");

    // Durable submission requires the submit capability and yields approval_required.
    const missing = await postJson(running.appBaseUrl, "/api/mission-graphs", null, graphEnvelope(graphId));
    assert.equal(missing.status, 401);
    const wrongCapability = await postJson(
      running.appBaseUrl, "/api/mission-graphs", missionControlToken, graphEnvelope(graphId));
    assert.equal(wrongCapability.status, 401);

    // The graph hash binds the exact submitted document, so idempotent replay
    // must present identical bytes; reuse one envelope for submit and replay.
    const envelope = graphEnvelope(graphId);
    const created = await postJson(
      running.appBaseUrl, "/api/mission-graphs", missionSubmitToken, envelope);
    assert.equal(created.status, 201);
    assert.equal(created.body.status, "approval_required");
    assert.equal(created.body.replayed, false);
    assert.equal(created.body.nodeCount, 2);
    const graphHash = created.body.graphHash as string;
    assert.match(graphHash, /^[0-9a-f]{64}$/);
    assert.equal(governorTaskCount(governorDataDir), 0, "submission must not execute anything");

    // Deterministic recompilation: an identical resubmission replays exactly.
    const replaySubmit = await postJson(
      running.appBaseUrl, "/api/mission-graphs", missionSubmitToken, envelope);
    assert.equal(replaySubmit.status, 200);
    assert.equal(replaySubmit.body.replayed, true);
    assert.equal(replaySubmit.body.graphHash, graphHash);

    // Submission capability cannot approve; ledger capability cannot approve.
    const submitCannotApprove = await postJson(
      running.appBaseUrl, `/api/mission-graphs/${graphId}/approve`, missionSubmitToken,
      { approvedBy: approvalActor, graphHash });
    assert.equal(submitCannotApprove.status, 401);
    const ledgerCannotApprove = await postJson(
      running.appBaseUrl, `/api/mission-graphs/${graphId}/approve`, ledgerToken,
      { approvedBy: approvalActor, graphHash });
    assert.equal(ledgerCannotApprove.status, 401);

    // Approval must carry the exact graph hash.
    const wrongHash = await postJson(
      running.appBaseUrl, `/api/mission-graphs/${graphId}/approve`, missionControlToken,
      { approvedBy: approvalActor, graphHash: "0".repeat(64) });
    assert.equal(wrongHash.status, 409);
    assert.equal(wrongHash.body.code, "OPERATOR_GRAPH_APPROVAL_HASH_MISMATCH");
    assert.equal(governorTaskCount(governorDataDir), 0);

    // Independent control approval executes both nodes through the real python
    // intake, strictly A before B.
    const approved = await postJson(
      running.appBaseUrl, `/api/mission-graphs/${graphId}/approve`, missionControlToken,
      { approvedBy: approvalActor, graphHash });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.status, "completed");
    assert.equal(approved.body.approvedGraphHash, graphHash);
    const nodes = approved.body.nodes as Array<Record<string, unknown>>;
    assert.equal(nodes[0].nodeId, "node_a");
    assert.equal(nodes[0].status, "completed");
    assert.equal(nodes[1].nodeId, "node_b");
    assert.equal(nodes[1].status, "completed");

    // Two real tasks + two real loops exist in the isolated Loop Governor state.
    assert.equal(governorTaskCount(governorDataDir), 2);
    assert.equal(governorLoopCount(governorDataDir), 2);

    // Node B's ready event is strictly after node A's completed event: B never
    // started before A completed.
    const events = approved.body.events as Array<{
      eventType: string; nodeId: string | null; sequence: number;
    }>;
    const seq = (eventType: string, nodeId: string | null) =>
      events.find((event) => event.eventType === eventType && event.nodeId === nodeId)!.sequence;
    assert.ok(seq("node_ready", "node_b") > seq("node_completed", "node_a"),
      "node B must not become ready before node A completes");

    // Both children are ordinary Phase 2C missions with full ledger lineage.
    for (const childId of [childA, childB]) {
      const childMission = await getJson(running.appBaseUrl, `/api/runtime-missions/${childId}`);
      assert.equal(childMission.status, 200);
      assert.equal(childMission.body.status, "succeeded");
      assert.equal((childMission.body.execution as Record<string, unknown>).state, "completed");
      const ledgerRun = await getJson(running.appBaseUrl, `/api/agent-run-ledger/runs/${childId}`);
      assert.equal(ledgerRun.status, 200);
      const runEntry = (ledgerRun.body as { entry: Record<string, unknown> }).entry;
      assert.equal(runEntry.status, "completed");
      assert.equal(runEntry.product_id, "loop_governor");
      assert.equal(runEntry.production_impact, false);
    }

    // Approval replay: same authoritative result, no third or fourth loop.
    const replayApproval = await postJson(
      running.appBaseUrl, `/api/mission-graphs/${graphId}/approve`, missionControlToken,
      { approvedBy: approvalActor, graphHash });
    assert.equal(replayApproval.status, 200);
    assert.equal(replayApproval.body.replayed, true);
    assert.equal(replayApproval.body.status, "completed");
    assert.equal(governorTaskCount(governorDataDir), 2);
    assert.equal(governorLoopCount(governorDataDir), 2);

    // Operator restart: durable truth survives byte-for-byte. Capture the
    // canonical state immediately before the restart so the comparison
    // isolates the restart boundary itself.
    const beforeRestart = (await getJson(running.appBaseUrl, `/api/mission-graphs/${graphId}`)).body;
    await stopOperator(running);
    running = await startOperator(root, databasePath, governorDataDir);
    const afterRestart = (await getJson(running.appBaseUrl, `/api/mission-graphs/${graphId}`)).body;
    assert.deepEqual(afterRestart, beforeRestart);
    const postRestartApproval = await postJson(
      running.appBaseUrl, `/api/mission-graphs/${graphId}/approve`, missionControlToken,
      { approvedBy: approvalActor, graphHash });
    assert.equal(postRestartApproval.status, 200);
    assert.equal(postRestartApproval.body.status, "completed");
    assert.equal(governorTaskCount(governorDataDir), 2);
    assert.equal(governorLoopCount(governorDataDir), 2);

    // Capability tokens never persist in the database or Loop Governor state.
    assertNoSecretBytes(databasePath, [missionSubmitToken, missionControlToken, ledgerToken]);
    assertNoSecretInTree(governorDataDir, [missionSubmitToken, missionControlToken, ledgerToken]);
  } finally {
    await stopOperator(running);
    rmSync(root, { recursive: true, force: true });
    rmSync(governorDataDir, { recursive: true, force: true });
  }
});

test("Phase 2D crash boundary: a crash between node A completion and node B scheduling never duplicates tasks or loops", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "phase2d-crash-"));
  const governorDataDir = mkdtempSync(path.join(os.tmpdir(), "phase2d-crash-governor-"));
  const databasePath = path.join(root, "operator.sqlite");
  const graphId = `phase2d-crash-${randomUUID().slice(0, 8)}`;
  const childA = `graph:${graphId}:node:node_a`;
  const childB = `graph:${graphId}:node:node_b`;
  let running = await startOperator(root, databasePath, governorDataDir, (boundary, _graphId, nodeId) => {
    if (boundary === "after_node_completed_persistence" && nodeId === "node_a") {
      throw new Error("simulated Operator crash between node A and node B");
    }
  });
  try {
    const created = await postJson(
      running.appBaseUrl, "/api/mission-graphs", missionSubmitToken, graphEnvelope(graphId));
    assert.equal(created.status, 201);
    const graphHash = created.body.graphHash as string;

    const crashed = await postJson(
      running.appBaseUrl, `/api/mission-graphs/${graphId}/approve`, missionControlToken,
      { approvedBy: approvalActor, graphHash });
    assert.equal(crashed.status, 500);
    assert.equal(governorTaskCount(governorDataDir), 1, "only node A executed before the crash");
    assert.equal(governorLoopCount(governorDataDir), 1);

    // Restart without the failure injector: node A is durably completed, node B blocked.
    await stopOperator(running);
    running = await startOperator(root, databasePath, governorDataDir);
    const stuck = (await getJson(running.appBaseUrl, `/api/mission-graphs/${graphId}`)).body;
    assert.equal(stuck.status, "running");
    const stuckNodes = stuck.nodes as Array<Record<string, unknown>>;
    assert.equal(stuckNodes[0].status, "completed");
    assert.equal(stuckNodes[1].status, "blocked");

    const resumed = await postJson(
      running.appBaseUrl, `/api/mission-graphs/${graphId}/resume`, missionControlToken, {});
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.status, "completed");
    const resumedNodes = resumed.body.nodes as Array<Record<string, unknown>>;
    assert.equal(resumedNodes[1].status, "completed");

    // Node A was recovered, not re-executed; node B ran exactly once.
    assert.equal(governorTaskCount(governorDataDir), 2, "recovery must not create a third task");
    assert.equal(governorLoopCount(governorDataDir), 2, "recovery must not create a third loop");
    const missionA = await getJson(running.appBaseUrl, `/api/runtime-missions/${childA}`);
    const missionB = await getJson(running.appBaseUrl, `/api/runtime-missions/${childB}`);
    assert.equal(missionA.body.status, "succeeded");
    assert.equal(missionB.body.status, "succeeded");
  } finally {
    await stopOperator(running);
    rmSync(root, { recursive: true, force: true });
    rmSync(governorDataDir, { recursive: true, force: true });
  }
});

test("Phase 2D concurrency: distinct graphs execute with zero cross-talk", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "phase2d-concurrent-"));
  const governorDataDir = mkdtempSync(path.join(os.tmpdir(), "phase2d-concurrent-governor-"));
  const databasePath = path.join(root, "operator.sqlite");
  const graphA = `phase2d-conc-a-${randomUUID().slice(0, 8)}`;
  const graphB = `phase2d-conc-b-${randomUUID().slice(0, 8)}`;
  const running = await startOperator(root, databasePath, governorDataDir);
  try {
    const [createdA, createdB] = await Promise.all([
      postJson(running.appBaseUrl, "/api/mission-graphs", missionSubmitToken, graphEnvelope(graphA)),
      postJson(running.appBaseUrl, "/api/mission-graphs", missionSubmitToken, graphEnvelope(graphB)),
    ]);
    assert.equal(createdA.status, 201);
    assert.equal(createdB.status, 201);

    const [approvedA, approvedB] = await Promise.all([
      postJson(running.appBaseUrl, `/api/mission-graphs/${graphA}/approve`, missionControlToken,
        { approvedBy: approvalActor, graphHash: createdA.body.graphHash }),
      postJson(running.appBaseUrl, `/api/mission-graphs/${graphB}/approve`, missionControlToken,
        { approvedBy: approvalActor, graphHash: createdB.body.graphHash }),
    ]);
    assert.equal(approvedA.body.status, "completed");
    assert.equal(approvedB.body.status, "completed");

    // Four distinct real loops, one per node across both graphs, no cross-talk.
    assert.equal(governorTaskCount(governorDataDir), 4);
    assert.equal(governorLoopCount(governorDataDir), 4);

    const eventsA = approvedA.body.events as Array<{ graphId: string }>;
    const eventsB = approvedB.body.events as Array<{ graphId: string }>;
    assert.ok(eventsA.every((event) => event.graphId === graphA));
    assert.ok(eventsB.every((event) => event.graphId === graphB));

    const runA = (await getJson(running.appBaseUrl, `/api/agent-run-ledger/runs/graph:${graphA}:node:node_a`)).body as {
      entry: Record<string, unknown>;
    };
    const runB = (await getJson(running.appBaseUrl, `/api/agent-run-ledger/runs/graph:${graphB}:node:node_a`)).body as {
      entry: Record<string, unknown>;
    };
    assert.equal(runA.entry.trace_id, `graph:${graphA}-trace:node:node_a`);
    assert.equal(runB.entry.trace_id, `graph:${graphB}-trace:node:node_a`);
  } finally {
    await stopOperator(running);
    rmSync(root, { recursive: true, force: true });
    rmSync(governorDataDir, { recursive: true, force: true });
  }
});
