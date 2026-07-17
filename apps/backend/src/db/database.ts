import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CommitReview, Evidence, ExecutionStep, RunnerPolicyPreview, TaskIntent, ValidationEvidence } from "../types.js";
import type { ReadonlyCommandResultRow } from "../services/operatorService.js";
import {
  autoPosterObservationAttemptsTableSql,
  autoPosterObservationEscalationsTableSql,
  autoPosterObservationIndexesSql,
  autoPosterObservationJobsTableSql,
  autoPosterResultEventsIndexSql,
  autoPosterResultEventsTableSql,
  autoPosterResultProjectionsTableSql,
  missionGraphNodesTableSql,
  PHASE_2D_GRAPH_NODE_PRODUCT_CHECK,
  PHASE_2E_GRAPH_NODE_PRODUCT_CHECK,
  schema,
} from "./schema.js";

type TaskRow = TaskIntent;
type StepRow = Omit<ExecutionStep, "action_payload" | "requires_approval"> & {
  action_payload: string;
  requires_approval: number;
};
type EvidenceRow = Omit<Evidence, "validation_passed"> & { validation_passed: number };

export function createDatabase(databasePath: string): DatabaseSync {
  if (databasePath !== ":memory:") {
    mkdirSync(path.dirname(databasePath), { recursive: true });
  }

  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA foreign_keys = ON;");
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec(schema);

    // P0.2 migration: add product_lane column
    try {
      database.exec("ALTER TABLE task_intents ADD COLUMN product_lane TEXT NOT NULL DEFAULT 'CHANTER Operator';");
    } catch {
      // Column already exists on fresh databases created by the schema above.
    }

    // P0.6 migration: update CHECK constraint to include 'cancelled' status.
    try {
      checkAndMigrateCancelled(database);
    } catch {
      // Migration failed silently - affected databases should be recreated.
    }

    // Phase 2E-A migration: explicit, transactional, restart-safe, and
    // intentionally outside every legacy swallow-on-failure path.
    migrateMissionGraphNodesForAutoPoster(database);

    // Phase 2E-B migration: additive result projection/event tables,
    // fail-closed on any unknown existing schema variant.
    migrateAutoPosterResultProjectionTables(database);

    // Phase 2E-C migration: additive observation job / attempt / escalation
    // tables, fail-closed on any unknown existing schema variant.
    migrateAutoPosterObservationTables(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

const GRAPH_NODE_COLUMNS = [
  "graph_id",
  "node_id",
  "product",
  "action",
  "objective",
  "input_json",
  "depends_on_json",
  "child_mission_id",
  "child_trace_id",
  "child_idempotency_key",
  "status",
  "attempts",
  "result_status",
  "result_summary_json",
  "typed_error_json",
  "created_at",
  "updated_at",
] as const;

function compactSql(value: string): string {
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

export function migrateMissionGraphNodesForAutoPoster(database: DatabaseSync): boolean {
  const row = database.prepare(
    "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'operator_mission_graph_nodes'",
  ).get() as { sql: string | null } | undefined;
  if (!row?.sql) {
    throw new Error(
      "Phase 2E-A migration requires operator_mission_graph_nodes to exist.",
    );
  }

  const tableSql = compactSql(row.sql);
  const phase2eTableSql = compactSql(
    missionGraphNodesTableSql("operator_mission_graph_nodes"),
  );
  const phase2dTableSql = compactSql(
    missionGraphNodesTableSql("operator_mission_graph_nodes")
      .replace(PHASE_2E_GRAPH_NODE_PRODUCT_CHECK, PHASE_2D_GRAPH_NODE_PRODUCT_CHECK),
  );
  if (tableSql === phase2eTableSql) {
    return false;
  }
  if (tableSql !== phase2dTableSql) {
    throw new Error(
      "Phase 2E-A migration refused an unknown operator_mission_graph_nodes schema.",
    );
  }

  return withTransaction(database, () => {
    const before = database.prepare(
      "SELECT COUNT(*) AS count FROM operator_mission_graph_nodes",
    ).get() as { count: number };

    database.exec(
      missionGraphNodesTableSql("operator_mission_graph_nodes_phase2e"),
    );
    database.exec(`
      INSERT INTO operator_mission_graph_nodes_phase2e (
        ${GRAPH_NODE_COLUMNS.join(", ")}
      )
      SELECT ${GRAPH_NODE_COLUMNS.join(", ")}
      FROM operator_mission_graph_nodes;
    `);

    const copied = database.prepare(
      "SELECT COUNT(*) AS count FROM operator_mission_graph_nodes_phase2e",
    ).get() as { count: number };
    if (Number(copied.count) !== Number(before.count)) {
      throw new Error(
        "Phase 2E-A graph-node migration did not preserve every existing row.",
      );
    }

    database.exec("DROP TABLE operator_mission_graph_nodes;");
    database.exec(
      "ALTER TABLE operator_mission_graph_nodes_phase2e RENAME TO operator_mission_graph_nodes;",
    );

    const migratedSchema = database.prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'operator_mission_graph_nodes'",
    ).get() as { sql: string | null } | undefined;
    if (!migratedSchema?.sql || compactSql(migratedSchema.sql) !== phase2eTableSql) {
      throw new Error(
        "Phase 2E-A graph-node migration did not produce the exact reviewed schema.",
      );
    }

    const columns = database.prepare(
      "PRAGMA table_info('operator_mission_graph_nodes')",
    ).all() as unknown as Array<{ name: string }>;
    if (
      columns.length !== GRAPH_NODE_COLUMNS.length
      || columns.some((column, index) => column.name !== GRAPH_NODE_COLUMNS[index])
    ) {
      throw new Error(
        "Phase 2E-A graph-node migration changed the canonical column layout.",
      );
    }
    const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyViolations.length > 0) {
      throw new Error(
        "Phase 2E-A graph-node migration failed foreign-key integrity validation.",
      );
    }
    const indexes = database.prepare(
      "PRAGMA index_list('operator_mission_graph_nodes')",
    ).all() as unknown as Array<{ unique: number }>;
    if (indexes.filter((index) => index.unique === 1).length < 2) {
      throw new Error(
        "Phase 2E-A graph-node migration did not preserve primary/unique indexes.",
      );
    }
    return true;
  });
}

/**
 * Phase 2E-B additive migration: creates the AutoPoster result projection
 * and append-only observation event tables. Fail-closed: an existing table
 * whose schema differs from the reviewed definition refuses migration
 * instead of being rewritten, and creation is one atomic transaction so an
 * interrupted run leaves either both tables or neither. Existing graph and
 * mission tables are never touched.
 */
export function migrateAutoPosterResultProjectionTables(database: DatabaseSync): boolean {
  const readTableSql = (name: string): string | null => {
    const row = database.prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?",
    ).get(name) as { sql: string | null } | undefined;
    return row?.sql ?? null;
  };

  const expected: Array<{ name: string; createSql: string }> = [
    {
      name: "operator_autoposter_result_projections",
      createSql: autoPosterResultProjectionsTableSql(),
    },
    {
      name: "operator_autoposter_result_events",
      createSql: autoPosterResultEventsTableSql(),
    },
  ];

  const missing: Array<{ name: string; createSql: string }> = [];
  for (const table of expected) {
    const currentSql = readTableSql(table.name);
    if (currentSql === null) {
      missing.push(table);
      continue;
    }
    if (compactSql(currentSql) !== compactSql(table.createSql)) {
      throw new Error(
        `Phase 2E-B migration refused an unknown ${table.name} schema.`,
      );
    }
  }
  if (missing.length === 0) {
    // Restart safety: both tables already match the reviewed schema exactly.
    database.exec(autoPosterResultEventsIndexSql);
    return false;
  }

  return withTransaction(database, () => {
    for (const table of missing) {
      database.exec(table.createSql);
    }
    database.exec(autoPosterResultEventsIndexSql);

    for (const table of expected) {
      const migratedSql = readTableSql(table.name);
      if (!migratedSql || compactSql(migratedSql) !== compactSql(table.createSql)) {
        throw new Error(
          `Phase 2E-B migration did not produce the exact reviewed ${table.name} schema.`,
        );
      }
    }
    const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyViolations.length > 0) {
      throw new Error(
        "Phase 2E-B result projection migration failed foreign-key integrity validation.",
      );
    }
    return true;
  });
}

/**
 * Phase 2E-C additive migration: creates the AutoPoster observation job,
 * append-only attempt telemetry, and durable escalation tables. Fail-closed:
 * an existing table whose schema differs from the reviewed definition
 * refuses migration instead of being rewritten, and creation is one atomic
 * transaction so an interrupted run leaves either every missing table or
 * none. Existing graph, mission, and Phase 2E-B projection tables are never
 * touched.
 */
export function migrateAutoPosterObservationTables(database: DatabaseSync): boolean {
  const readTableSql = (name: string): string | null => {
    const row = database.prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?",
    ).get(name) as { sql: string | null } | undefined;
    return row?.sql ?? null;
  };

  const expected: Array<{ name: string; createSql: string }> = [
    {
      name: "operator_autoposter_observation_jobs",
      createSql: autoPosterObservationJobsTableSql(),
    },
    {
      name: "operator_autoposter_observation_attempts",
      createSql: autoPosterObservationAttemptsTableSql(),
    },
    {
      name: "operator_autoposter_observation_escalations",
      createSql: autoPosterObservationEscalationsTableSql(),
    },
  ];

  const missing: Array<{ name: string; createSql: string }> = [];
  for (const table of expected) {
    const currentSql = readTableSql(table.name);
    if (currentSql === null) {
      missing.push(table);
      continue;
    }
    if (compactSql(currentSql) !== compactSql(table.createSql)) {
      throw new Error(
        `Phase 2E-C migration refused an unknown ${table.name} schema.`,
      );
    }
  }
  if (missing.length === 0) {
    // Restart safety: every table already matches the reviewed schema exactly.
    database.exec(autoPosterObservationIndexesSql);
    return false;
  }

  return withTransaction(database, () => {
    for (const table of missing) {
      database.exec(table.createSql);
    }
    database.exec(autoPosterObservationIndexesSql);

    for (const table of expected) {
      const migratedSql = readTableSql(table.name);
      if (!migratedSql || compactSql(migratedSql) !== compactSql(table.createSql)) {
        throw new Error(
          `Phase 2E-C migration did not produce the exact reviewed ${table.name} schema.`,
        );
      }
    }
    const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyViolations.length > 0) {
      throw new Error(
        "Phase 2E-C observation migration failed foreign-key integrity validation.",
      );
    }
    return true;
  });
}

function checkAndMigrateCancelled(database: DatabaseSync): void {
  try {
    database.exec("BEGIN IMMEDIATE;");

    database.exec(`
      CREATE TABLE IF NOT EXISTS task_intents_mig (
        id TEXT PRIMARY KEY,
        raw_input TEXT NOT NULL,
        parsed_description TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'queued', 'awaiting_approval', 'executing', 'completed', 'failed', 'rejected', 'cancelled')),
        priority INTEGER NOT NULL DEFAULT 0,
        product_lane TEXT NOT NULL DEFAULT 'CHANTER Operator',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    database.exec("INSERT INTO task_intents_mig SELECT * FROM task_intents;");
    database.exec("DROP TABLE task_intents;");
    database.exec("ALTER TABLE task_intents_mig RENAME TO task_intents;");
    database.exec("CREATE INDEX IF NOT EXISTS idx_steps_task_id ON execution_steps(task_id, step_number);");
    database.exec("CREATE INDEX IF NOT EXISTS idx_evidence_task_id ON evidence(task_id, created_at);");
    database.exec("COMMIT;");
  } catch {
    try { database.exec("ROLLBACK;"); } catch { /* ignore */ }
  }
}

export function mapTask(row: unknown): TaskIntent {
  return row as TaskRow;
}

export function mapStep(row: unknown): ExecutionStep {
  const step = row as StepRow;
  return {
    ...step,
    action_payload: JSON.parse(step.action_payload) as Record<string, unknown>,
    requires_approval: step.requires_approval === 1,
  };
}

export function mapRunnerPolicyPreview(row: unknown): RunnerPolicyPreview {
  const r = row as Omit<RunnerPolicyPreview, "reasons"> & { reasons: string };
  return { ...r, reasons: JSON.parse(r.reasons) as string[] };
}

export function mapCommitReview(row: unknown): CommitReview {
  const r = row as Omit<CommitReview, "reasons"> & { reasons: string };
  return { ...r, reasons: JSON.parse(r.reasons) as string[] };
}

export function mapValidationEvidence(row: unknown): ValidationEvidence {
  return row as ValidationEvidence;
}

export function mapEvidence(row: unknown): Evidence {
  const evidence = row as EvidenceRow;
  return { ...evidence, validation_passed: evidence.validation_passed === 1 };
}

export function mapReadonlyCommandResult(row: unknown): ReadonlyCommandResultRow {
  return row as ReadonlyCommandResultRow;
}

export function withTransaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE;");
  try {
    const result = operation();
    database.exec("COMMIT;");
    return result;
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}
