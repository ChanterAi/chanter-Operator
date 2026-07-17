import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDatabase,
  migrateAutoPosterResultProjectionTables,
} from "../src/db/database.js";
import {
  autoPosterResultEventsTableSql,
  autoPosterResultProjectionsTableSql,
  schema,
} from "../src/db/schema.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryDatabasePath(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "chanter-phase2eb-migration-"));
  roots.push(root);
  return path.join(root, "operator.sqlite");
}

function canonicalTableSql(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/;$/, "")
    .toLowerCase()
    .replace(/^create table if not exists /, "create table ");
}

function tableSql(database: DatabaseSync, name: string): string | null {
  const row = database.prepare(
    "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?",
  ).get(name) as { sql: string | null } | undefined;
  return row?.sql ?? null;
}

function rows(database: DatabaseSync, table: string): unknown[] {
  return database.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all();
}

function uniqueColumnSets(database: DatabaseSync, table: string): string[] {
  const indexes = database.prepare(
    `PRAGMA index_list('${table}')`,
  ).all() as unknown as Array<{ name: string; unique: number }>;
  return indexes
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
}

const TIMESTAMP = "2030-01-01T00:00:00.000Z";

/** A Phase 2E-A-era database: full current base schema, no 2E-B tables, one populated AutoPoster graph. */
function createPhase2eaDatabase(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(schema);
  insertAutoPosterGraph(database);
  database.close();
}

function insertAutoPosterGraph(database: DatabaseSync): void {
  database.prepare(`
    INSERT INTO operator_mission_graphs (
      graph_id, trace_id, idempotency_key, schema_version, source_system,
      requested_by, tenant_user_id, workspace_id, account_id, objective,
      compiled_graph_json, graph_hash, node_count, status, approval_required,
      approved_by, approved_at, approved_graph_hash, requested_at, created_at,
      updated_at
    ) VALUES ('graph-2eb', 'trace-2eb', 'key-2eb', 'chanter.mission.graph.v1',
      'operator', 'founder', 'owner', 'workspace-a', NULL, 'Populated 2E-A graph.',
      '{}', 'hash-2eb', 2, 'completed', 1, 'founder', ?, 'hash-2eb', ?, ?, ?)
  `).run(TIMESTAMP, TIMESTAMP, TIMESTAMP, TIMESTAMP);
  const insertNode = database.prepare(`
    INSERT INTO operator_mission_graph_nodes (
      graph_id, node_id, product, action, objective, input_json,
      depends_on_json, child_mission_id, child_trace_id,
      child_idempotency_key, status, attempts, result_status,
      result_summary_json, typed_error_json, created_at, updated_at
    ) VALUES (?, ?, 'auto_poster', 'autoposter.post.schedule', 'Schedule.',
      '{}', '[]', ?, ?, ?, 'completed', 1, 'succeeded', ?, NULL, ?, ?)
  `);
  for (const [nodeId, queueId] of [["node_a", "queue-job-a"], ["node_b", "queue-job-b"]] as const) {
    insertNode.run(
      "graph-2eb",
      nodeId,
      `graph:graph-2eb:node:${nodeId}`,
      `graph:trace-2eb:node:${nodeId}`,
      `graph:graph-2eb:node:${nodeId}`,
      JSON.stringify({ queueDraftId: queueId, provider: "tiktok", accountId: "account-a" }),
      TIMESTAMP,
      TIMESTAMP,
    );
  }
}

describe("Phase 2E-B result projection SQLite migration", () => {
  it("creates both reviewed tables for a fresh database", () => {
    const database = createDatabase(temporaryDatabasePath());
    expect(canonicalTableSql(tableSql(database, "operator_autoposter_result_projections")!)).toBe(
      canonicalTableSql(autoPosterResultProjectionsTableSql()),
    );
    expect(canonicalTableSql(tableSql(database, "operator_autoposter_result_events")!)).toBe(
      canonicalTableSql(autoPosterResultEventsTableSql()),
    );
    expect(migrateAutoPosterResultProjectionTables(database)).toBe(false);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  });

  it("adds the tables to a populated Phase 2E-A database without touching graph truth", () => {
    const databasePath = temporaryDatabasePath();
    createPhase2eaDatabase(databasePath);
    const before = new DatabaseSync(databasePath);
    expect(tableSql(before, "operator_autoposter_result_projections")).toBeNull();
    const snapshot = {
      graphs: rows(before, "operator_mission_graphs"),
      nodes: rows(before, "operator_mission_graph_nodes"),
    };
    before.close();

    const migrated = createDatabase(databasePath);
    expect(tableSql(migrated, "operator_autoposter_result_projections")).not.toBeNull();
    expect(tableSql(migrated, "operator_autoposter_result_events")).not.toBeNull();
    expect(rows(migrated, "operator_mission_graphs")).toEqual(snapshot.graphs);
    expect(rows(migrated, "operator_mission_graph_nodes")).toEqual(snapshot.nodes);
    expect(rows(migrated, "operator_autoposter_result_projections")).toEqual([]);
    expect(rows(migrated, "operator_autoposter_result_events")).toEqual([]);
    migrated.close();
  });

  it("fails closed on an unknown existing projection-table schema without mutating it", () => {
    const databasePath = temporaryDatabasePath();
    createPhase2eaDatabase(databasePath);
    const sabotaged = new DatabaseSync(databasePath);
    sabotaged.exec("CREATE TABLE operator_autoposter_result_projections (probe TEXT);");
    sabotaged.close();

    expect(() => createDatabase(databasePath)).toThrow(
      /refused an unknown operator_autoposter_result_projections schema/i,
    );

    const inspected = new DatabaseSync(databasePath);
    expect(tableSql(inspected, "operator_autoposter_result_projections")).toContain("probe TEXT");
    expect(tableSql(inspected, "operator_autoposter_result_events")).toBeNull();
    expect(rows(inspected, "operator_mission_graph_nodes")).toHaveLength(2);
    inspected.close();
  });

  it("rolls back atomically when creation fails mid-migration", () => {
    const databasePath = temporaryDatabasePath();
    createPhase2eaDatabase(databasePath);
    // An index and a table share one SQLite namespace: occupying the reviewed
    // index name with a table makes CREATE INDEX fail after both CREATE TABLE
    // statements succeeded, so rollback must remove them again.
    const sabotaged = new DatabaseSync(databasePath);
    sabotaged.exec("CREATE TABLE idx_operator_autoposter_result_events_node (probe TEXT);");
    sabotaged.close();

    expect(() => createDatabase(databasePath)).toThrow(/already a table/i);

    const inspected = new DatabaseSync(databasePath);
    expect(tableSql(inspected, "operator_autoposter_result_projections")).toBeNull();
    expect(tableSql(inspected, "operator_autoposter_result_events")).toBeNull();
    expect(rows(inspected, "operator_mission_graph_nodes")).toHaveLength(2);
    inspected.close();
  });

  it("is restart-safe and enforces keys, uniqueness, and referential integrity", () => {
    const databasePath = temporaryDatabasePath();
    createPhase2eaDatabase(databasePath);
    let database = createDatabase(databasePath);
    database.close();
    database = createDatabase(databasePath);
    expect(migrateAutoPosterResultProjectionTables(database)).toBe(false);

    expect(uniqueColumnSets(database, "operator_autoposter_result_projections")).toEqual([
      "child_mission_id",
      "graph_id,node_id",
      "queue_job_id",
    ]);
    expect(uniqueColumnSets(database, "operator_autoposter_result_events")).toEqual([
      "event_id",
      "graph_id,node_id,sequence",
    ]);
    const foreignKeys = database.prepare(
      "PRAGMA foreign_key_list('operator_autoposter_result_projections')",
    ).all() as unknown as Array<{ table: string; from: string; to: string; on_delete: string }>;
    expect(foreignKeys.map((fk) => `${fk.from}->${fk.table}.${fk.to}:${fk.on_delete}`).sort()).toEqual([
      "graph_id->operator_mission_graph_nodes.graph_id:RESTRICT",
      "node_id->operator_mission_graph_nodes.node_id:RESTRICT",
    ]);

    const insertProjection = (graphId: string, nodeId: string, queueJobId: string) =>
      database.prepare(`
        INSERT INTO operator_autoposter_result_projections (
          graph_id, node_id, graph_hash, child_mission_id, child_trace_id,
          queue_job_id, provider, connected_account_id, account_id,
          workspace_id, source_status, provider_status, projection_status,
          approved, source_updated_at, observed_at, snapshot_hash,
          evidence_json, escalation_reason, escalation_severity, created_at,
          updated_at
        ) VALUES (?, ?, 'hash-2eb', ?, 'trace', ?, 'tiktok', 'tiktok:account-a',
          'account-a', 'workspace-a', 'scheduled', '', 'awaiting_publish_approval',
          0, ?, ?, 'snapshot-hash', '{}', NULL, NULL, ?, ?)
      `).run(
        graphId, nodeId, `graph:${graphId}:node:${nodeId}`, queueJobId,
        TIMESTAMP, TIMESTAMP, TIMESTAMP, TIMESTAMP,
      );

    // A projection may only exist for a real graph node.
    expect(() => insertProjection("graph-2eb", "node_missing", "queue-x")).toThrow(/foreign key/i);
    insertProjection("graph-2eb", "node_a", "queue-job-a");
    // The queue job binding is immutable and unique across projections.
    expect(() => insertProjection("graph-2eb", "node_b", "queue-job-a")).toThrow(/unique/i);
    // Only the ten reviewed projection statuses are storable.
    expect(() => database.prepare(`
      UPDATE operator_autoposter_result_projections
      SET projection_status = 'completed' WHERE graph_id = 'graph-2eb' AND node_id = 'node_a'
    `).run()).toThrow(/check constraint/i);

    // Events are bound to real nodes with per-node monotonic uniqueness.
    const insertEvent = (eventId: string, nodeId: string, sequence: number) =>
      database.prepare(`
        INSERT INTO operator_autoposter_result_events (
          event_id, graph_id, node_id, queue_job_id, sequence,
          observation_kind, projection_status, reason_code, source_updated_at,
          snapshot_hash, observed_at, evidence_json
        ) VALUES (?, 'graph-2eb', ?, 'queue-job-a', ?, 'observation',
          'awaiting_publish_approval', 'publish_approval_required', ?, 'snapshot-hash', ?, '{}')
      `).run(eventId, nodeId, sequence, TIMESTAMP, TIMESTAMP);
    insertEvent("event-1", "node_a", 1);
    expect(() => insertEvent("event-2", "node_a", 1)).toThrow(/unique/i);
    expect(() => insertEvent("event-1", "node_a", 2)).toThrow(/unique/i);
    expect(() => insertEvent("event-3", "node_missing", 1)).toThrow(/foreign key/i);

    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  });
});
