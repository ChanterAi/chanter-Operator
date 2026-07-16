/**
 * Phase 2D mission graph spine tests.
 *
 * Every node execution in this file goes through the REAL Phase 2C path:
 * GenericMissionService -> chanter-agent-runtime executeMission -> Loop
 * Governor mission adapter; only the process port is replaced by an
 * in-memory fake so unit runs are deterministic (the real python transport
 * is covered by the Phase 2D cross-repository integration test).
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  LoopGovernorManualLoopCreateParams,
  LoopGovernorManualLoopLookupParams,
  LoopGovernorMissionPort,
} from "chanter-agent-runtime";
import { createApp } from "../src/app.js";
import { AgentRunLedgerService } from "../src/agentRunLedger/agentRunLedgerService.js";
import { AuditLogger } from "../src/audit/auditLogger.js";
import { createDatabase } from "../src/db/database.js";
import {
  GenericMissionService,
  type GenericMissionFailureBoundary,
} from "../src/missions/genericMissionService.js";
import { compileMissionGraph } from "../src/missions/missionGraphCompiler.js";
import {
  MissionGraphService,
  type MissionGraphFailureBoundary,
} from "../src/missions/missionGraphService.js";
import { createLoopGovernorMissionExecutor } from "../src/missions/loopGovernorRuntime.js";
import { MockRunner } from "../src/runners/mockRunner.js";
import { AutoPosterMissionService } from "../src/runtimeMissions/autoPosterMissionService.js";
import { createAutoPosterRuntimeMissionExecutor } from "../src/runtimeMissions/autoPosterRuntime.js";
import { OperatorService } from "../src/services/operatorService.js";
import { ensureWorkspace } from "../src/workspace/pathGuard.js";

const MISSION_SUBMIT_TOKEN = "test-mission-submit-token";
const MISSION_CONTROL_TOKEN = "test-operator-control-token";
const LEDGER_INGEST_TOKEN = "test-ledger-ingest-token";
const PROTECTED_TOKENS = [MISSION_SUBMIT_TOKEN, MISSION_CONTROL_TOKEN, LEDGER_INGEST_TOKEN];

const GRAPH_ID = "phase2d-graph-0001";
const CHILD_A = `graph:${GRAPH_ID}:node:node_a`;
const CHILD_B = `graph:${GRAPH_ID}:node:node_b`;

function withSubmitAuth(req: ReturnType<typeof request>) {
  return req.set("Authorization", `Bearer ${MISSION_SUBMIT_TOKEN}`);
}

function withControlAuth(req: ReturnType<typeof request>) {
  return req.set("Authorization", `Bearer ${MISSION_CONTROL_TOKEN}`);
}

interface FakeLoopPort {
  port: LoopGovernorMissionPort;
  createCalls: LoopGovernorManualLoopCreateParams[];
  lookupCalls: LoopGovernorManualLoopLookupParams[];
}

function makeLoopPort(overrides: Partial<LoopGovernorMissionPort> = {}): FakeLoopPort {
  const createCalls: LoopGovernorManualLoopCreateParams[] = [];
  const lookupCalls: LoopGovernorManualLoopLookupParams[] = [];
  const bindings = new Map<string, { payloadHash: string; taskId: string; loopId: string }>();
  const port: LoopGovernorMissionPort = {
    async createManualLoop(params) {
      createCalls.push(params);
      const existing = bindings.get(params.missionId);
      if (existing) {
        if (existing.payloadHash !== params.payloadHash) {
          return {
            ok: false,
            code: "conflict",
            message: "bound to a different payload hash",
            downstreamCode: "MISSION_INTAKE_PAYLOAD_CONFLICT",
          };
        }
        return {
          ok: true,
          created: false,
          taskId: existing.taskId,
          loopId: existing.loopId,
          realAgentExecution: false,
        };
      }
      const binding = {
        payloadHash: params.payloadHash,
        taskId: `task-${bindings.size + 1}`,
        loopId: `loop-${bindings.size + 1}`,
      };
      bindings.set(params.missionId, binding);
      return {
        ok: true,
        created: true,
        taskId: binding.taskId,
        loopId: binding.loopId,
        realAgentExecution: false,
      };
    },
    async lookupManualLoop(params) {
      lookupCalls.push(params);
      const existing = bindings.get(params.missionId);
      if (!existing) return { ok: true, outcome: "not_found", binding: null };
      if (existing.payloadHash !== params.payloadHash) {
        return { ok: true, outcome: "payload_mismatch", binding: null };
      }
      return {
        ok: true,
        outcome: "unique",
        binding: { taskId: existing.taskId, loopId: existing.loopId, boundAt: "2026-07-16T00:00:00.000Z" },
      };
    },
    ...overrides,
  };
  return { port, createCalls, lookupCalls };
}

interface Harness {
  database: DatabaseSync;
  ledger: AgentRunLedgerService;
  genericService: GenericMissionService;
  graphService: MissionGraphService;
  app: ReturnType<typeof createApp>;
  rawApp: ReturnType<typeof createApp>;
}

function createHarness(
  temporaryRoot: string,
  loopPort: LoopGovernorMissionPort,
  options: {
    databasePath?: string;
    missionFailureInjector?: (boundary: GenericMissionFailureBoundary, missionId: string) => void;
    graphFailureInjector?: (
      boundary: MissionGraphFailureBoundary,
      graphId: string,
      nodeId: string | null,
    ) => void;
  } = {},
): Harness {
  const database = createDatabase(
    options.databasePath ?? path.join(temporaryRoot, "data", "operator.sqlite"),
  );
  const operatorService = new OperatorService(
    database,
    new AuditLogger(path.join(temporaryRoot, "data", "audit.jsonl")),
    new MockRunner(),
    ensureWorkspace(path.join(temporaryRoot, "workspace")),
  );
  const agentRunLedgerService = new AgentRunLedgerService(database, PROTECTED_TOKENS);
  const autoPosterService = new AutoPosterMissionService(
    database,
    createAutoPosterRuntimeMissionExecutor({
      baseUrl: "",
      serviceToken: "",
      userId: "",
      timeoutValid: true,
    }),
    { agentRunLedgerService, protectedValues: PROTECTED_TOKENS },
  );
  const loopExecutor = createLoopGovernorMissionExecutor(
    { pythonExecutable: "", governorRoot: "", dataDir: "", timeoutValid: true },
    { port: loopPort },
  );
  const genericService = new GenericMissionService(database, loopExecutor, {
    agentRunLedgerService,
    protectedValues: PROTECTED_TOKENS,
    failureInjector: options.missionFailureInjector,
  });
  const graphService = new MissionGraphService(database, genericService, {
    protectedValues: PROTECTED_TOKENS,
    failureInjector: options.graphFailureInjector,
  });
  const rawApp = createApp(
    operatorService,
    autoPosterService,
    agentRunLedgerService,
    genericService,
    graphService,
  );
  const testApp = express();
  testApp.use(rawApp);
  return { database, ledger: agentRunLedgerService, genericService, graphService, app: testApp, rawApp };
}

function graphNode(
  nodeId: string,
  goal: string,
  dependsOn?: string[],
): Record<string, unknown> {
  return {
    nodeId,
    target: { product: "loop_governor", action: "loop_governor.manual_loop.create" },
    objective: `Create the governed manual loop for ${nodeId}.`,
    input: {
      appName: "chanter-operator",
      taskType: "review",
      goal,
      scope: `phase2d graph ${nodeId}`,
    },
    ...(dependsOn ? { dependsOn } : {}),
  };
}

function graphEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "chanter.mission.graph.v1",
    graphId: GRAPH_ID,
    traceId: "phase2d-graph-trace-0001",
    idempotencyKey: "phase2d-graph-key-0001",
    source: { system: "mission_compiler", requestedBy: "founder-cli" },
    objective: "Execute one dependency-aware two-node review graph.",
    tenant: { userId: "founder" },
    nodes: [
      graphNode("node_a", "Review part A of the Phase 2D graph spine."),
      graphNode("node_b", "Review part B of the Phase 2D graph spine.", ["node_a"]),
    ],
    requestedAt: "2026-07-16T12:00:00.000Z",
    ...overrides,
  };
}

async function submitGraph(harness: Harness, envelope: Record<string, unknown> = graphEnvelope()) {
  return withSubmitAuth(request(harness.app).post("/api/mission-graphs")).send(envelope);
}

async function approveGraph(
  harness: Harness,
  graphHash: string,
  approvedBy = "founder",
  graphId = GRAPH_ID,
) {
  return withControlAuth(
    request(harness.app).post(`/api/mission-graphs/${graphId}/approve`),
  ).send({ approvedBy, graphHash });
}

function graphTableCounts(database: DatabaseSync) {
  const count = (table: string) =>
    (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  return {
    graphs: count("operator_mission_graphs"),
    nodes: count("operator_mission_graph_nodes"),
    edges: count("operator_mission_graph_edges"),
    events: count("operator_mission_graph_events"),
    missions: count("operator_missions"),
  };
}

describe("Phase 2D mission graph compiler", () => {
  it("compiles the same envelope to byte-identical normalized output and the same hash", () => {
    const first = compileMissionGraph(graphEnvelope());
    const second = compileMissionGraph(graphEnvelope());
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.normalizedJson).toBe(first.normalizedJson);
    expect(second.graphHash).toBe(first.graphHash);
    expect(first.graphHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("normalizes node ordering and dependency ordering deterministically", () => {
    const ordered = compileMissionGraph(graphEnvelope({
      nodes: [
        graphNode("node_a", "goal a"),
        graphNode("node_b", "goal b"),
        graphNode("node_c", "goal c", ["node_a", "node_b"]),
      ],
    }));
    const shuffled = compileMissionGraph(graphEnvelope({
      nodes: [
        graphNode("node_c", "goal c", ["node_b", "node_a"]),
        graphNode("node_b", "goal b"),
        graphNode("node_a", "goal a"),
      ],
    }));
    expect(ordered.ok && shuffled.ok).toBe(true);
    if (!ordered.ok || !shuffled.ok) return;
    expect(shuffled.normalizedJson).toBe(ordered.normalizedJson);
    expect(shuffled.graphHash).toBe(ordered.graphHash);
    expect(ordered.compiled.nodes.map((node) => node.nodeId)).toEqual([
      "node_a", "node_b", "node_c",
    ]);
  });

  it("rejects every malformed graph shape with a typed error", () => {
    const cases: Array<{ envelope: Record<string, unknown>; code: string }> = [
      { envelope: graphEnvelope({ schemaVersion: "chanter.mission.graph.v2" }), code: "GRAPH_SCHEMA_VERSION_UNSUPPORTED" },
      { envelope: graphEnvelope({ surprise: true }), code: "GRAPH_FIELD_UNSUPPORTED" },
      { envelope: graphEnvelope({ graphId: "bad id with spaces" }), code: "GRAPH_ID_INVALID" },
      { envelope: graphEnvelope({ nodes: [] }), code: "GRAPH_NODES_INVALID" },
      {
        envelope: graphEnvelope({
          nodes: Array.from({ length: 9 }, (_, index) => graphNode(`node_${index}`, `goal ${index}`)),
        }),
        code: "GRAPH_NODE_LIMIT_EXCEEDED",
      },
      {
        envelope: graphEnvelope({
          nodes: [graphNode("node_a", "goal a"), { ...graphNode("node_b", "goal b"), rogue: 1 }],
        }),
        code: "GRAPH_FIELD_UNSUPPORTED",
      },
      {
        envelope: graphEnvelope({
          nodes: [graphNode("node_a", "goal a"), graphNode("node_a", "goal duplicate")],
        }),
        code: "GRAPH_NODE_DUPLICATE",
      },
      {
        envelope: graphEnvelope({
          nodes: [graphNode("node_a", "goal a", ["node_missing"])],
        }),
        code: "GRAPH_DEPENDENCY_MISSING",
      },
      {
        envelope: graphEnvelope({
          nodes: [graphNode("node_a", "goal a", ["node_a"])],
        }),
        code: "GRAPH_DEPENDENCY_SELF",
      },
      {
        envelope: graphEnvelope({
          nodes: [
            graphNode("node_a", "goal a"),
            graphNode("node_b", "goal b", ["node_a", "node_a"]),
          ],
        }),
        code: "GRAPH_DEPENDENCY_DUPLICATE",
      },
      {
        envelope: graphEnvelope({
          nodes: [
            graphNode("node_a", "goal a", ["node_b"]),
            graphNode("node_b", "goal b", ["node_a"]),
          ],
        }),
        code: "GRAPH_DEPENDENCY_CYCLE",
      },
    ];
    for (const { envelope, code } of cases) {
      const result = compileMissionGraph(envelope);
      expect(result.ok, `expected rejection ${code}`).toBe(false);
      if (result.ok) continue;
      expect(result.errors.map((error) => error.code), `expected ${code}`).toContain(code);
    }
  });

  it("rejects unknown actions and closed-world input violations", () => {
    const unknownAction = compileMissionGraph(graphEnvelope({
      nodes: [{
        ...graphNode("node_a", "goal a"),
        target: { product: "clean_engine", action: "clean_engine.image.clean" },
      }],
    }));
    expect(unknownAction.ok).toBe(false);
    if (!unknownAction.ok) {
      expect(unknownAction.errors[0]!.code).toBe("GRAPH_NODE_TARGET_UNREGISTERED");
      expect(unknownAction.errors[0]!.status).toBe(409);
    }

    const autoposterLane = compileMissionGraph(graphEnvelope({
      nodes: [{
        ...graphNode("node_a", "goal a"),
        target: { product: "auto_poster", action: "autoposter.post.schedule" },
      }],
    }));
    expect(autoposterLane.ok).toBe(false);
    if (!autoposterLane.ok) {
      expect(autoposterLane.errors[0]!.code).toBe("GRAPH_NODE_TARGET_UNREGISTERED");
    }

    const rogueInput = compileMissionGraph(graphEnvelope({
      nodes: [{
        ...graphNode("node_a", "goal a"),
        input: {
          appName: "chanter-operator",
          taskType: "review",
          goal: "goal",
          shellCommand: "echo pwned",
        },
      }],
    }));
    expect(rogueInput.ok).toBe(false);
    if (!rogueInput.ok) {
      expect(rogueInput.errors[0]!.code).toBe("LOOP_GOVERNOR_INPUT_UNSUPPORTED_FIELD");
    }
  });
});

describe("Phase 2D mission graph spine", () => {
  let temporaryRoot: string;
  let database: DatabaseSync | undefined;

  beforeEach(() => {
    temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "chanter-phase2d-graph-"));
  });

  afterEach(() => {
    database?.close();
    database = undefined;
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it("rejects malformed graphs at the gateway before anything persists", async () => {
    const { port } = makeLoopPort();
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;

    const cyclic = await submitGraph(harness, graphEnvelope({
      nodes: [
        graphNode("node_a", "goal a", ["node_b"]),
        graphNode("node_b", "goal b", ["node_a"]),
      ],
    }));
    expect(cyclic.status).toBe(400);
    expect(cyclic.body.code).toBe("GRAPH_DEPENDENCY_CYCLE");

    const unknownAction = await submitGraph(harness, graphEnvelope({
      nodes: [{
        ...graphNode("node_a", "goal a"),
        target: { product: "clean_engine", action: "clean_engine.image.clean" },
      }],
    }));
    expect(unknownAction.status).toBe(409);
    expect(unknownAction.body.code).toBe("GRAPH_NODE_TARGET_UNREGISTERED");

    const protectedValue = await submitGraph(harness, graphEnvelope({
      nodes: [graphNode("node_a", `goal with ${MISSION_CONTROL_TOKEN} embedded`)],
    }));
    expect(protectedValue.status).toBe(400);

    expect(graphTableCounts(harness.database)).toEqual({
      graphs: 0, nodes: 0, edges: 0, events: 0, missions: 0,
    });
  });

  it("submits a valid graph durably as approval_required and executes nothing", async () => {
    const { port, createCalls } = makeLoopPort();
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;

    const created = await submitGraph(harness);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      replayed: false,
      graphId: GRAPH_ID,
      traceId: "phase2d-graph-trace-0001",
      schemaVersion: "chanter.mission.graph.v1",
      status: "approval_required",
      approvalRequired: true,
      approvedBy: null,
      approvedGraphHash: null,
      nodeCount: 2,
    });
    expect(created.body.graphHash).toMatch(/^[0-9a-f]{64}$/);
    expect(created.body.nodes).toHaveLength(2);
    expect(created.body.nodes[0]).toMatchObject({
      nodeId: "node_a",
      status: "blocked",
      attempts: 0,
      childMissionId: CHILD_A,
      childMission: null,
      dependsOn: [],
    });
    expect(created.body.nodes[1]).toMatchObject({
      nodeId: "node_b",
      status: "blocked",
      childMissionId: CHILD_B,
      dependsOn: ["node_a"],
    });
    expect(created.body.edges).toEqual([{ fromNodeId: "node_a", toNodeId: "node_b" }]);
    expect(created.body.events.map((event: { eventType: string }) => event.eventType))
      .toEqual(["graph_compiled_and_persisted"]);

    // Submission executed nothing: no port calls, no child missions, no runs.
    expect(createCalls).toHaveLength(0);
    expect(graphTableCounts(harness.database).missions).toBe(0);

    // Exact replay returns the durable graph; conflicts refuse with typed 409s.
    const replay = await submitGraph(harness);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(graphTableCounts(harness.database).graphs).toBe(1);

    const changedContent = await submitGraph(harness, graphEnvelope({
      nodes: [
        graphNode("node_a", "A different goal that must not silently replace the original."),
        graphNode("node_b", "Review part B of the Phase 2D graph spine.", ["node_a"]),
      ],
    }));
    expect(changedContent.status).toBe(409);
    expect(changedContent.body.code).toBe("OPERATOR_GRAPH_PAYLOAD_MISMATCH");

    const changedTrace = await submitGraph(harness, graphEnvelope({ traceId: "phase2d-graph-trace-other" }));
    expect(changedTrace.status).toBe(409);
    expect(changedTrace.body.code).toBe("OPERATOR_GRAPH_TRACE_MISMATCH");

    const stolenKey = await submitGraph(harness, graphEnvelope({
      graphId: "phase2d-graph-0002",
      traceId: "phase2d-graph-trace-0002",
    }));
    expect(stolenKey.status).toBe(409);
    expect(stolenKey.body.code).toBe("OPERATOR_GRAPH_IDEMPOTENCY_MISMATCH");
  });

  it("keeps graph approval control-owned: submit and ledger capabilities cannot approve", async () => {
    const { port, createCalls } = makeLoopPort();
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;

    const created = await submitGraph(harness);
    expect(created.status).toBe(201);
    const graphHash = created.body.graphHash as string;

    const noToken = await request(harness.rawApp)
      .post(`/api/mission-graphs/${GRAPH_ID}/approve`)
      .send({ approvedBy: "founder", graphHash });
    expect(noToken.status).toBe(401);

    const submitCannotApprove = await request(harness.rawApp)
      .post(`/api/mission-graphs/${GRAPH_ID}/approve`)
      .set("Authorization", `Bearer ${MISSION_SUBMIT_TOKEN}`)
      .send({ approvedBy: "founder", graphHash });
    expect(submitCannotApprove.status).toBe(401);

    const ledgerCannotApprove = await request(harness.rawApp)
      .post(`/api/mission-graphs/${GRAPH_ID}/approve`)
      .set("Authorization", `Bearer ${LEDGER_INGEST_TOKEN}`)
      .send({ approvedBy: "founder", graphHash });
    expect(ledgerCannotApprove.status).toBe(401);

    const controlCannotSubmit = await request(harness.rawApp)
      .post("/api/mission-graphs")
      .set("Authorization", `Bearer ${MISSION_CONTROL_TOKEN}`)
      .send(graphEnvelope({ graphId: "phase2d-graph-0002", traceId: "t2", idempotencyKey: "k2" }));
    expect(controlCannotSubmit.status).toBe(401);

    expect(createCalls).toHaveLength(0);
    const graph = harness.graphService.getGraph(GRAPH_ID);
    expect(graph.status).toBe("approval_required");
    expect(graph.approvedBy).toBeNull();
  });

  it("binds approval to the exact graph hash and refuses every other basis", async () => {
    const { port, createCalls } = makeLoopPort();
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;

    await submitGraph(harness);

    const missingHash = await withControlAuth(
      request(harness.app).post(`/api/mission-graphs/${GRAPH_ID}/approve`),
    ).send({ approvedBy: "founder" });
    expect(missingHash.status).toBe(400);
    expect(missingHash.body.code).toBe("OPERATOR_GRAPH_APPROVAL_HASH_REQUIRED");

    const wrongHash = await approveGraph(harness, "0".repeat(64));
    expect(wrongHash.status).toBe(409);
    expect(wrongHash.body.code).toBe("OPERATOR_GRAPH_APPROVAL_HASH_MISMATCH");

    expect(createCalls).toHaveLength(0);
    expect(harness.graphService.getGraph(GRAPH_ID).status).toBe("approval_required");
  });

  it("executes node A exactly once, keeps node B blocked until A completes, then executes B exactly once", async () => {
    const { port, createCalls } = makeLoopPort();
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;

    const created = await submitGraph(harness);
    const approved = await approveGraph(harness, created.body.graphHash as string);
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({
      status: "completed",
      approvedBy: "founder",
      approvedGraphHash: created.body.graphHash,
    });
    expect(approved.body.approvedAt).toBeTruthy();

    // Exactly one downstream execution per node, strictly A before B.
    expect(createCalls).toHaveLength(2);
    expect(createCalls.map((call) => call.missionId)).toEqual([CHILD_A, CHILD_B]);

    const nodeA = approved.body.nodes[0];
    const nodeB = approved.body.nodes[1];
    expect(nodeA).toMatchObject({
      nodeId: "node_a",
      status: "completed",
      attempts: 1,
      resultStatus: "succeeded",
      childMission: { status: "succeeded", executionState: "completed" },
    });
    expect(nodeB).toMatchObject({
      nodeId: "node_b",
      status: "completed",
      attempts: 1,
      resultStatus: "succeeded",
    });
    expect(nodeA.resultSummary.downstreamIds).toEqual({ loopId: "loop-1", taskId: "task-1", created: true });
    expect(nodeB.resultSummary.downstreamIds).toEqual({ loopId: "loop-2", taskId: "task-2", created: true });

    // The event journal proves the dependency ordering durably: node B's
    // ready event comes strictly after node A's completed event.
    const events = approved.body.events as Array<{
      eventType: string; nodeId: string | null; sequence: number;
    }>;
    const sequenceOf = (eventType: string, nodeId: string | null) =>
      events.find((event) => event.eventType === eventType && event.nodeId === nodeId)!.sequence;
    expect(sequenceOf("node_ready", "node_b")).toBeGreaterThan(sequenceOf("node_completed", "node_a"));
    expect(events.map((event) => event.eventType)).toEqual([
      "graph_compiled_and_persisted",
      "graph_approved",
      "graph_running",
      "node_ready", "node_running", "node_completed",
      "node_ready", "node_running", "node_completed",
      "graph_completed",
    ]);

    // Both children are ordinary Phase 2C missions with full journal + ledger lineage.
    for (const childId of [CHILD_A, CHILD_B]) {
      const mission = harness.genericService.getMission(childId);
      expect(mission.status).toBe("succeeded");
      expect(mission.approvedBy).toBe("founder");
      expect(mission.idempotencyKey).toBe(childId);
      expect(mission.executionJournal.map((transition) => transition.newState)).toEqual([
        "approval_required", "approved", "execution_started", "downstream_request_prepared",
        "downstream_result_observed", "result_persisted", "completed",
      ]);
      const run = harness.ledger.getRun(childId);
      expect(run.entry.status).toBe("completed");
      expect(run.entry.product_id).toBe("loop_governor");
      expect(run.entry.production_impact).toBe(false);
    }
    expect(harness.genericService.getMission(CHILD_A).traceId)
      .toBe("graph:phase2d-graph-trace-0001:node:node_a");
  });

  it("replays a completed graph approval with the same result and no new execution", async () => {
    const { port, createCalls } = makeLoopPort();
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;

    const created = await submitGraph(harness);
    const graphHash = created.body.graphHash as string;
    const first = await approveGraph(harness, graphHash);
    expect(first.body.status).toBe("completed");
    expect(createCalls).toHaveLength(2);

    const replay = await approveGraph(harness, graphHash);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.status).toBe("completed");
    expect(replay.body.nodes).toEqual(first.body.nodes);
    expect(createCalls).toHaveLength(2);

    const wrongActor = await approveGraph(harness, graphHash, "someone-else");
    expect(wrongActor.status).toBe(409);
    expect(wrongActor.body.code).toBe("OPERATOR_GRAPH_APPROVAL_BINDING_MISMATCH");
  });

  it("survives a full restart between submission and approval byte-for-byte", async () => {
    const databasePath = path.join(temporaryRoot, "data", "operator.sqlite");
    const firstPort = makeLoopPort();
    const first = createHarness(temporaryRoot, firstPort.port, { databasePath });
    const created = await submitGraph(first);
    expect(created.status).toBe(201);
    const beforeRestart = first.graphService.getGraph(GRAPH_ID);
    first.database.close();

    const secondPort = makeLoopPort();
    const second = createHarness(temporaryRoot, secondPort.port, { databasePath });
    database = second.database;
    expect(second.graphService.getGraph(GRAPH_ID)).toEqual(beforeRestart);

    const approved = await approveGraph(second, beforeRestart.graphHash);
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe("completed");
    expect(secondPort.createCalls).toHaveLength(2);
  });

  it("resumes correctly after a crash between node A completion and node B scheduling", async () => {
    const databasePath = path.join(temporaryRoot, "data", "operator.sqlite");
    const shared = makeLoopPort();
    const crashing = createHarness(temporaryRoot, shared.port, {
      databasePath,
      graphFailureInjector: (boundary, _graphId, nodeId) => {
        if (boundary === "after_node_completed_persistence" && nodeId === "node_a") {
          throw new Error("simulated process crash between node A and node B");
        }
      },
    });
    const created = await submitGraph(crashing);
    const crashed = await approveGraph(crashing, created.body.graphHash as string);
    expect(crashed.status).toBe(500);
    expect(shared.createCalls).toHaveLength(1);
    crashing.database.close();

    // Restart: node A is durably completed, node B untouched, graph running.
    const recovered = createHarness(temporaryRoot, shared.port, { databasePath });
    database = recovered.database;
    const stuck = recovered.graphService.getGraph(GRAPH_ID);
    expect(stuck.status).toBe("running");
    expect(stuck.nodes[0]).toMatchObject({ nodeId: "node_a", status: "completed" });
    expect(stuck.nodes[1]).toMatchObject({ nodeId: "node_b", status: "blocked" });

    const resumed = await withControlAuth(
      request(recovered.app).post(`/api/mission-graphs/${GRAPH_ID}/resume`),
    ).send({});
    expect(resumed.status).toBe(200);
    expect(resumed.body.status).toBe("completed");
    expect(resumed.body.nodes[1]).toMatchObject({ nodeId: "node_b", status: "completed" });

    // Node A was never re-executed; node B executed exactly once.
    expect(shared.createCalls).toHaveLength(2);
    expect(shared.createCalls.map((call) => call.missionId)).toEqual([CHILD_A, CHILD_B]);
  });

  it("recovers a crash after the downstream side effect without duplicating tasks or loops", async () => {
    const databasePath = path.join(temporaryRoot, "data", "operator.sqlite");
    const shared = makeLoopPort();
    const crashing = createHarness(temporaryRoot, shared.port, {
      databasePath,
      missionFailureInjector: (boundary, missionId) => {
        if (
          boundary === "after_operator_observes_runtime_result_before_persistence"
          && missionId === CHILD_A
        ) {
          throw new Error("simulated crash after the downstream side effect");
        }
      },
    });
    const created = await submitGraph(crashing);
    const crashed = await approveGraph(crashing, created.body.graphHash as string);
    expect(crashed.status).toBe(500);
    expect(shared.createCalls).toHaveLength(1);
    crashing.database.close();

    // Restart: the downstream loop exists; the child holds the durable
    // observed result; the graph node is still durably running.
    const recovered = createHarness(temporaryRoot, shared.port, { databasePath });
    database = recovered.database;
    const stuck = recovered.graphService.getGraph(GRAPH_ID);
    expect(stuck.nodes[0]).toMatchObject({ nodeId: "node_a", status: "running" });
    expect(stuck.nodes[0].childMission).toMatchObject({ executionState: "downstream_result_observed" });

    const resumed = await withControlAuth(
      request(recovered.app).post(`/api/mission-graphs/${GRAPH_ID}/resume`),
    ).send({});
    expect(resumed.status).toBe(200);
    expect(resumed.body.status).toBe("completed");
    expect(resumed.body.nodes[0]).toMatchObject({ nodeId: "node_a", status: "completed" });
    expect(resumed.body.nodes[1]).toMatchObject({ nodeId: "node_b", status: "completed" });

    // The crashed node A execution was recovered, not re-executed: exactly
    // one create per node, no lookups needed for the durable observation.
    expect(shared.createCalls).toHaveLength(2);
    expect(shared.createCalls.map((call) => call.missionId)).toEqual([CHILD_A, CHILD_B]);
  });

  it("keeps dependents blocked on recoverable node failure and resumes through bounded child recovery", async () => {
    let failNext = true;
    const inner = makeLoopPort();
    const flaky = makeLoopPort({
      async createManualLoop(params) {
        if (failNext) {
          failNext = false;
          return { ok: false, code: "unavailable", message: "intake offline" };
        }
        return inner.port.createManualLoop(params);
      },
      async lookupManualLoop(params) {
        return inner.port.lookupManualLoop(params);
      },
    });
    const harness = createHarness(temporaryRoot, flaky.port);
    database = harness.database;

    const created = await submitGraph(harness);
    const failed = await approveGraph(harness, created.body.graphHash as string);
    expect(failed.status).toBe(200);
    expect(failed.body.status).toBe("failed_recoverable");
    expect(failed.body.nodes[0]).toMatchObject({ nodeId: "node_a", status: "failed_recoverable" });
    expect(failed.body.nodes[1]).toMatchObject({ nodeId: "node_b", status: "blocked" });
    expect(inner.createCalls).toHaveLength(0);

    const resumed = await withControlAuth(
      request(harness.app).post(`/api/mission-graphs/${GRAPH_ID}/resume`),
    ).send({});
    expect(resumed.status).toBe(200);
    expect(resumed.body.status).toBe("completed");
    expect(resumed.body.nodes[0]).toMatchObject({
      nodeId: "node_a",
      status: "completed",
      attempts: 2,
    });
    expect(resumed.body.nodes[1]).toMatchObject({ nodeId: "node_b", status: "completed", attempts: 1 });
    // The child mission consumed its single bounded retry during recovery.
    expect(harness.genericService.getMission(CHILD_A).execution?.retryCount).toBe(1);
  });

  it("terminates the graph deterministically when a node fails terminally", async () => {
    const conflicted = makeLoopPort({
      async createManualLoop() {
        return {
          ok: false,
          code: "conflict",
          message: "bound to a different payload",
          downstreamCode: "MISSION_INTAKE_PAYLOAD_CONFLICT",
        };
      },
      async lookupManualLoop() {
        return { ok: true, outcome: "payload_mismatch", binding: null };
      },
    });
    const harness = createHarness(temporaryRoot, conflicted.port);
    database = harness.database;

    const created = await submitGraph(harness);
    const failed = await approveGraph(harness, created.body.graphHash as string);
    expect(failed.status).toBe(200);
    expect(failed.body.status).toBe("failed_recoverable");

    // The bounded recovery reconciles the child to a deterministic terminal
    // payload mismatch, which terminates the graph and cancels dependents.
    const resumed = await withControlAuth(
      request(harness.app).post(`/api/mission-graphs/${GRAPH_ID}/resume`),
    ).send({});
    expect(resumed.status).toBe(200);
    expect(resumed.body.status).toBe("failed_terminal");
    expect(resumed.body.nodes[0]).toMatchObject({ nodeId: "node_a", status: "failed_terminal" });
    expect(resumed.body.nodes[1]).toMatchObject({ nodeId: "node_b", status: "cancelled" });
    expect(resumed.body.nodes[0].typedError.code).toBe("RECOVERY_PAYLOAD_MISMATCH");

    // Terminal is terminal: no resume, no approval, no cancellation.
    const resumeRefused = await withControlAuth(
      request(harness.app).post(`/api/mission-graphs/${GRAPH_ID}/resume`),
    ).send({});
    expect(resumeRefused.status).toBe(409);
    expect(resumeRefused.body.code).toBe("OPERATOR_GRAPH_RECOVERY_NOT_PERMITTED");
    const approveRefused = await approveGraph(harness, created.body.graphHash as string);
    expect(approveRefused.status).toBe(409);
    expect(approveRefused.body.code).toBe("OPERATOR_GRAPH_STATE_TERMINAL");
  });

  it("cancels an unapproved graph and refuses approval afterwards", async () => {
    const { port, createCalls } = makeLoopPort();
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;

    const created = await submitGraph(harness);
    const cancelled = await withControlAuth(
      request(harness.app).post(`/api/mission-graphs/${GRAPH_ID}/cancel`),
    ).send({ cancelledBy: "founder", reason: "changed priorities" });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe("cancelled");
    expect(cancelled.body.nodes.every((node: { status: string }) => node.status === "cancelled")).toBe(true);

    const approveRefused = await approveGraph(harness, created.body.graphHash as string);
    expect(approveRefused.status).toBe(409);
    expect(approveRefused.body.code).toBe("OPERATOR_GRAPH_STATE_TERMINAL");
    expect(createCalls).toHaveLength(0);
  });

  it("keeps distinct graphs fully isolated", async () => {
    const { port, createCalls } = makeLoopPort();
    const harness = createHarness(temporaryRoot, port);
    database = harness.database;

    const firstEnvelope = graphEnvelope();
    const secondEnvelope = graphEnvelope({
      graphId: "phase2d-graph-0002",
      traceId: "phase2d-graph-trace-0002",
      idempotencyKey: "phase2d-graph-key-0002",
    });
    const first = await submitGraph(harness, firstEnvelope);
    const second = await submitGraph(harness, secondEnvelope);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    // The hash binds the full graph identity, not just the node content:
    // two graphs with identical nodes but distinct identities never share
    // an approval basis.
    expect(second.body.graphHash).not.toBe(first.body.graphHash);

    const approvedFirst = await approveGraph(harness, first.body.graphHash as string);
    const approvedSecond = await approveGraph(
      harness, second.body.graphHash as string, "founder", "phase2d-graph-0002",
    );
    expect(approvedFirst.body.status).toBe("completed");
    expect(approvedSecond.body.status).toBe("completed");

    expect(createCalls).toHaveLength(4);
    const loopIds = [
      ...approvedFirst.body.nodes, ...approvedSecond.body.nodes,
    ].map((node: { resultSummary: { downstreamIds: { loopId: string } } }) =>
      node.resultSummary.downstreamIds.loopId);
    expect(new Set(loopIds).size).toBe(4);

    const firstEvents = approvedFirst.body.events as Array<{ graphId: string }>;
    expect(firstEvents.every((event) => event.graphId === GRAPH_ID)).toBe(true);
    expect(harness.graphService.getGraph("phase2d-graph-0002").events
      .every((event) => event.graphId === "phase2d-graph-0002")).toBe(true);
  });
});
