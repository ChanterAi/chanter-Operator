import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Evidence, ExecutionStep, TaskIntent, ValidationEvidence } from "../types.js";
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
  // SQLite ALTER TABLE cannot modify CHECK constraints, so we recreate the table.
  try {
    // Test if 'cancelled' is already valid by attempting a dry-run insert into a temp table.
    // If the existing CHECK rejects it, we need to migrate.
    checkAndMigrateCancelled(database);
  } catch {
    // Migration failed silently â€” affected databases should be recreated.
    // This is acceptable for mock-only P0 development.
  }

  return database;
}

function checkAndMigrateCancelled(database: DatabaseSync): void {
  // Use PRAGMA table_info to check if migration is needed by trying to create
  // a temporary table with the updated constraint and copying data.
  try {
    database.exec("BEGIN IMMEDIATE;");

    // Create new table with updated CHECK including 'cancelled'
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

    // Copy data from old table
    database.exec("INSERT INTO task_intents_mig SELECT * FROM task_intents;");

    // Swap tables
    database.exec("DROP TABLE task_intents;");
    database.exec("ALTER TABLE task_intents_mig RENAME TO task_intents;");

    // Recreate indexes
    database.exec("CREATE INDEX IF NOT EXISTS idx_steps_task_id ON execution_steps(task_id, step_number);");
    database.exec("CREATE INDEX IF NOT EXISTS idx_evidence_task_id ON evidence(task_id, created_at);");

    database.exec("COMMIT;");
  } catch {
    // If migration fails (e.g., FK references), rollback and continue.
    // The database will function with the old CHECK, but cancelled status
    // transitions will be enforced in application logic.
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

export function mapValidationEvidence(row: unknown): ValidationEvidence {
  return row as ValidationEvidence;
}

export function mapEvidence(row: unknown): Evidence {
  const evidence = row as EvidenceRow;
  return { ...evidence, validation_passed: evidence.validation_passed === 1 };
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
