import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Evidence, ExecutionStep, TaskIntent } from "../types.js";
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
  return database;
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

