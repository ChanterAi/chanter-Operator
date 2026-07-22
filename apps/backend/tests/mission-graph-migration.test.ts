import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { LoopGovernorMissionPort } from "chanter-agent-runtime";
import { AgentRunLedgerService } from "../src/agentRunLedger/agentRunLedgerService.js";
import {
  createDatabase,
  migrateMissionGraphReplayUniqueness,
  migrateMissionGraphNodesForAutoPoster,
} from "../src/db/database.js";
import {
  missionGraphNodesTableSql,
  PHASE_2D_GRAPH_NODE_PRODUCT_CHECK,
  PHASE_2E_GRAPH_NODE_PRODUCT_CHECK,
  schema,
} from "../src/db/schema.js";
import { GenericMissionService } from "../src/missions/genericMissionService.js";
import { MissionGraphChildDispatcher } from "../src/missions/missionGraphChildDispatcher.js";
import {
  compileMissionGraph,
  missionGraphChildIdempotencyKey,
  missionGraphChildMissionId,
  missionGraphChildTraceId,
} from "../src/missions/missionGraphCompiler.js";
import { MissionGraphService } from "../src/missions/missionGraphService.js";
import { MissionGraphJournal } from "../src/missions/missionGraphJournal.js";
import { createLoopGovernorMissionExecutor } from "../src/missions/loopGovernorRuntime.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryDatabasePath(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "chanter-phase2e-migration-"));
  roots.push(root);
  return path.join(root, "operator.sqlite");
}

function graphEnvelope() {
  return {
    schemaVersion: "chanter.mission.graph.v1",
    graphId: "phase2d-populated-graph",
    traceId: "phase2d-populated-trace",
    idempotencyKey: "phase2d-populated-key",
    source: { system: "operator", requestedBy: "founder-migration-test" },
    objective: "Preserve and execute a populated Phase 2D graph.",
    tenant: { userId: "owner" },
    requestedAt: "2030-01-01T00:00:00.000Z",
    nodes: [
      {
        nodeId: "node_a",
        target: {
          product: "loop_governor",
          action: "loop_governor.manual_loop.create",
        },
        objective: "Create the preserved manual loop.",
        input: {
          appName: "chanter-operator",
          taskType: "review",
          goal: "Preserved Phase 2D migration proof",
          scope: "phase2e migration validation",
        },
        dependsOn: [],
      },
      {
        nodeId: "node_b",
        target: {
          product: "loop_governor",
          action: "loop_governor.manual_loop.create",
        },
        objective: "Create the second preserved manual loop.",
        input: {
          appName: "chanter-operator",
          taskType: "review",
          goal: "Preserved Phase 2D edge and ordering proof",
          scope: "phase2e migration validation",
        },
        dependsOn: ["node_a"],
      },
    ],
  };
}

function legacySchema(): string {
  const migrated = schema.replace(
    PHASE_2E_GRAPH_NODE_PRODUCT_CHECK,
    PHASE_2D_GRAPH_NODE_PRODUCT_CHECK,
  );
  expect(migrated).not.toBe(schema);
  return migrated;
}

function insertGraph(database: DatabaseSync): { graphHash: string; normalizedJson: string } {
  const compiled = compileMissionGraph(graphEnvelope());
  if (!compiled.ok) throw new Error(compiled.errors[0]?.message);
  const graph = compiled.compiled;
  const timestamp = "2030-01-01T00:00:00.000Z";
  database.prepare(`
    INSERT INTO operator_mission_graphs (
      graph_id, trace_id, idempotency_key, schema_version, source_system,
      requested_by, tenant_user_id, workspace_id, account_id, objective,
      compiled_graph_json, graph_hash, node_count, status, approval_required,
      approved_by, approved_at, approved_graph_hash, requested_at, created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, 'approval_required', 1,
      NULL, NULL, NULL, ?, ?, ?)
  `).run(
    graph.graphId,
    graph.traceId,
    graph.idempotencyKey,
    graph.schemaVersion,
    graph.source.system,
    graph.source.requestedBy,
    graph.tenant.userId,
    graph.objective,
    compiled.normalizedJson,
    compiled.graphHash,
    graph.nodeCount,
    graph.requestedAt,
    timestamp,
    timestamp,
  );
  const insertNode = database.prepare(`
    INSERT INTO operator_mission_graph_nodes (
      graph_id, node_id, product, action, objective, input_json,
      depends_on_json, child_mission_id, child_trace_id,
      child_idempotency_key, status, attempts, result_status,
      result_summary_json, typed_error_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'blocked', 0, NULL, NULL, NULL, ?, ?)
  `);
  const insertEdge = database.prepare(`
    INSERT INTO operator_mission_graph_edges (
      graph_id, from_node_id, to_node_id
    ) VALUES (?, ?, ?)
  `);
  for (const node of graph.nodes) {
    insertNode.run(
      graph.graphId,
      node.nodeId,
      node.target.product,
      node.target.action,
      node.objective,
      JSON.stringify(node.input),
      JSON.stringify(node.dependsOn),
      missionGraphChildMissionId(graph.graphId, node.nodeId),
      missionGraphChildTraceId(graph.traceId, node.nodeId),
      missionGraphChildIdempotencyKey(graph.graphId, node.nodeId),
      timestamp,
      timestamp,
    );
    for (const dependency of node.dependsOn) {
      insertEdge.run(graph.graphId, dependency, node.nodeId);
    }
  }
  database.prepare(`
    INSERT INTO operator_mission_graph_events (
      event_id, graph_id, sequence, scope, node_id, event_type,
      previous_state, new_state, actor, reason, timestamp,
      evidence_refs_json, typed_error_json
    ) VALUES ('event-1', ?, 1, 'graph', NULL, 'graph_compiled', NULL,
      'approval_required', 'founder-migration-test', 'legacy graph compiled', ?, '[]', NULL)
  `).run(graph.graphId, timestamp);
  database.prepare(`
    INSERT INTO operator_mission_graph_events (
      event_id, graph_id, sequence, scope, node_id, event_type,
      previous_state, new_state, actor, reason, timestamp,
      evidence_refs_json, typed_error_json
    ) VALUES ('event-2', ?, 2, 'node', 'node_a', 'node_blocked', NULL,
      'blocked', 'chanter-operator', 'legacy node persisted', ?, '[]', NULL)
  `).run(graph.graphId, timestamp);
  return { graphHash: compiled.graphHash, normalizedJson: compiled.normalizedJson };
}

function createLegacyDatabase(databasePath: string): {
  graphHash: string;
  normalizedJson: string;
} {
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(legacySchema());
  const inserted = insertGraph(database);
  database.close();
  return inserted;
}

function tableSql(database: DatabaseSync): string {
  const row = database.prepare(
    "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'operator_mission_graph_nodes'",
  ).get() as { sql: string };
  return row.sql.replace(/\s+/g, " ");
}

function canonicalTableSql(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/;$/, "")
    .toLowerCase()
    .replace(/^create table if not exists /, "create table ")
    .replace(
      /^create table "operator_mission_graph_nodes"/,
      "create table operator_mission_graph_nodes",
    );
}

function rows(database: DatabaseSync, table: string): unknown[] {
  return (database.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`) as StatementSync).all();
}

function loopPort(): LoopGovernorMissionPort {
  const bindings = new Map<string, { taskId: string; loopId: string; payloadHash: string }>();
  return {
    async createManualLoop(params) {
      const existing = bindings.get(params.missionId);
      if (existing) {
        return {
          ok: true,
          created: false,
          taskId: existing.taskId,
          loopId: existing.loopId,
          realAgentExecution: false,
        };
      }
      const ordinal = bindings.size + 1;
      const binding = {
        taskId: `migration-task-${ordinal}`,
        loopId: `migration-loop-${ordinal}`,
        payloadHash: params.payloadHash,
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
      const existing = bindings.get(params.missionId);
      return existing
        ? {
            ok: true,
            outcome: "unique",
            binding: {
              taskId: existing.taskId,
              loopId: existing.loopId,
              boundAt: "2030-01-01T00:00:00.000Z",
            },
          }
        : { ok: true, outcome: "not_found", binding: null };
    },
  };
}

describe("Phase 2E-A graph-node SQLite migration", () => {
  it("creates the reviewed schema directly for a fresh database", () => {
    const database = createDatabase(temporaryDatabasePath());
    expect(canonicalTableSql(tableSql(database))).toBe(
      canonicalTableSql(missionGraphNodesTableSql("operator_mission_graph_nodes")),
    );
    expect(migrateMissionGraphNodesForAutoPoster(database)).toBe(false);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  });

  it("atomically preserves populated Phase 2D graph, node, edge, and ordered event truth", () => {
    const databasePath = temporaryDatabasePath();
    const legacy = createLegacyDatabase(databasePath);
    const before = new DatabaseSync(databasePath);
    const snapshot = {
      graphs: rows(before, "operator_mission_graphs"),
      nodes: rows(before, "operator_mission_graph_nodes"),
      edges: rows(before, "operator_mission_graph_edges"),
      events: rows(before, "operator_mission_graph_events"),
    };
    before.close();

    const migrated = createDatabase(databasePath);
    expect(canonicalTableSql(tableSql(migrated))).toBe(
      canonicalTableSql(missionGraphNodesTableSql("operator_mission_graph_nodes")),
    );
    expect(rows(migrated, "operator_mission_graphs")).toEqual(snapshot.graphs);
    expect(rows(migrated, "operator_mission_graph_nodes")).toEqual(snapshot.nodes);
    expect(rows(migrated, "operator_mission_graph_edges")).toEqual(snapshot.edges);
    expect(rows(migrated, "operator_mission_graph_events")).toEqual(snapshot.events);
    expect(migrated.prepare(`
      SELECT sequence FROM operator_mission_graph_events
      WHERE graph_id = ? ORDER BY sequence ASC
    `).all("phase2d-populated-graph")).toEqual([
      { sequence: 1 },
      { sequence: 2 },
    ]);
    const graph = migrated.prepare(
      "SELECT compiled_graph_json, graph_hash FROM operator_mission_graphs WHERE graph_id = ?",
    ).get("phase2d-populated-graph") as {
      compiled_graph_json: string;
      graph_hash: string;
    };
    expect(graph).toEqual({
      compiled_graph_json: legacy.normalizedJson,
      graph_hash: legacy.graphHash,
    });
    migrated.close();
  });

  it("rolls back on migration failure and leaves the Phase 2D table intact", () => {
    const databasePath = temporaryDatabasePath();
    createLegacyDatabase(databasePath);
    const collision = new DatabaseSync(databasePath);
    collision.exec("CREATE TABLE operator_mission_graph_nodes_phase2e (probe TEXT);");
    collision.close();

    expect(() => createDatabase(databasePath)).toThrow(/already exists/i);

    const inspected = new DatabaseSync(databasePath);
    expect(tableSql(inspected)).toContain(PHASE_2D_GRAPH_NODE_PRODUCT_CHECK);
    expect(rows(inspected, "operator_mission_graph_nodes")).toHaveLength(2);
    expect(rows(inspected, "operator_mission_graph_edges")).toHaveLength(1);
    expect(rows(inspected, "operator_mission_graph_events")).toHaveLength(2);
    inspected.close();
  });

  it("fails closed on an unknown Phase 2D-lookalike schema without mutating it", () => {
    const databasePath = temporaryDatabasePath();
    const canonicalLegacy = legacySchema();
    const unknownSchema = canonicalLegacy.replace(
      "attempts >= 0 AND attempts <= 3",
      "attempts >= 0 AND attempts <= 4",
    );
    expect(unknownSchema).not.toBe(canonicalLegacy);

    const database = new DatabaseSync(databasePath);
    database.exec("PRAGMA foreign_keys = ON;");
    database.exec(unknownSchema);
    insertGraph(database);
    database.close();

    expect(() => createDatabase(databasePath)).toThrow(
      /unknown operator_mission_graph_nodes schema/i,
    );

    const inspected = new DatabaseSync(databasePath);
    expect(tableSql(inspected)).toContain("attempts >= 0 AND attempts <= 4");
    expect(rows(inspected, "operator_mission_graph_nodes")).toHaveLength(2);
    expect(rows(inspected, "operator_mission_graph_edges")).toHaveLength(1);
    expect(rows(inspected, "operator_mission_graph_events")).toHaveLength(2);
    inspected.close();
  });

  it("is restart-safe and preserves foreign keys, unique indexes, and old generic execution", async () => {
    const databasePath = temporaryDatabasePath();
    const { graphHash } = createLegacyDatabase(databasePath);
    let database = createDatabase(databasePath);
    database.close();
    database = createDatabase(databasePath);

    expect(migrateMissionGraphNodesForAutoPoster(database)).toBe(false);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const indexes = database.prepare(
      "PRAGMA index_list('operator_mission_graph_nodes')",
    ).all() as unknown as Array<{ name: string; unique: number }>;
    const uniqueColumnSets = indexes
      .filter((index) => index.unique === 1)
      .map((index) => (
        database.prepare(`PRAGMA index_info('${index.name}')`).all() as unknown as Array<{
          name: string;
          seqno: number;
        }>
      )
        .sort((left, right) => left.seqno - right.seqno)
        .map((column) => column.name)
        .join(","))
      .sort();
    expect(uniqueColumnSets).toEqual(["child_mission_id", "graph_id,node_id"]);
    expect(database.prepare(
      "PRAGMA foreign_key_list('operator_mission_graph_nodes')",
    ).all()).toEqual([
      expect.objectContaining({
        table: "operator_mission_graphs",
        from: "graph_id",
        to: "graph_id",
        on_delete: "RESTRICT",
      }),
    ]);
    expect(canonicalTableSql(tableSql(database))).toBe(
      canonicalTableSql(missionGraphNodesTableSql("operator_mission_graph_nodes")),
    );

    const ledger = new AgentRunLedgerService(database, []);
    const generic = new GenericMissionService(
      database,
      createLoopGovernorMissionExecutor(
        { pythonExecutable: "", governorRoot: "", dataDir: "", timeoutValid: true },
        { port: loopPort() },
      ),
      { agentRunLedgerService: ledger },
    );
    const graphs = new MissionGraphService(
      database,
      new MissionGraphChildDispatcher(generic),
    );
    const completed = await graphs.approveGraph("phase2d-populated-graph", {
      approvedBy: "founder-migration-test",
      graphHash,
    });
    expect(completed.status).toBe("completed");
    expect(completed.nodes[0]?.resultSummary).toMatchObject({
      downstreamIds: { taskId: "migration-task-1", loopId: "migration-loop-1" },
    });
    expect(rows(database, "operator_missions")).toHaveLength(2);
    expect(rows(database, "autoposter_runtime_missions")).toHaveLength(0);

    expect(() => database.prepare(`
      INSERT INTO operator_missions (
        mission_id, trace_id, product, action, actor_id, tenant_user_id,
        workspace_id, account_id, objective, input_json, idempotency_key,
        payload_hash, status, approval_required, approved_by,
        runtime_result_json, requested_at, created_at, updated_at
      ) VALUES ('forbidden-auto', 'forbidden-auto-trace', 'auto_poster',
        'autoposter.post.schedule', 'actor', 'owner', NULL, NULL, 'forbidden',
        '{}', 'forbidden-auto-key', 'hash', 'approval_required', 1, NULL,
        NULL, '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z',
        '2030-01-01T00:00:00.000Z')
    `).run()).toThrow(/check constraint/i);
    database.close();
  });

  it("fails closed when historical authoritative replay events are duplicated", () => {
    const database = createDatabase(temporaryDatabasePath());
    const journal = new MissionGraphJournal(database, (() => {
      let sequence = 0;
      return () => `replay-migration-${++sequence}`;
    })());
    journal.insertGraph({
      graphId: "replay-duplicate-graph",
      traceId: "replay-duplicate-trace",
      idempotencyKey: "replay-duplicate-key",
      schemaVersion: "chanter.mission.graph.v1",
      sourceSystem: "operator",
      requestedBy: "migration-test",
      tenantUserId: "owner",
      workspaceId: null,
      accountId: null,
      objective: "Prove duplicate replay migration refusal.",
      compiledGraphJson: "{}",
      graphHash: "a".repeat(64),
      requestedAt: "2030-01-01T00:00:00.000Z",
      timestamp: "2030-01-01T00:00:00.000Z",
      nodes: [{
        nodeId: "node",
        product: "loop_governor",
        action: "loop_governor.manual_loop.create",
        objective: "migration canary",
        inputJson: "{}",
        dependsOn: [],
        childMissionId: "replay-child",
        childTraceId: "replay-child-trace",
        childIdempotencyKey: "replay-child-key",
      }],
    });
    for (let index = 0; index < 2; index += 1) {
      journal.appendAuditEvent("replay-duplicate-graph", "graph_submission_replayed", {
        actor: "migration-test",
        reason: "synthetic duplicate",
        timestamp: `2030-01-01T00:00:0${index + 1}.000Z`,
      });
    }
    expect(() => migrateMissionGraphReplayUniqueness(database)).toThrow(/duplicate historical events/i);
    database.close();
  });
});
