import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CommitReview, Evidence, ExecutionStep, RunnerPolicyPreview, TaskIntent, ValidationEvidence } from "../types.js";
import type { ReadonlyCommandResultRow } from "../services/operatorService.js";
import { schema } from "./schema.js";

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

  return database;
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
