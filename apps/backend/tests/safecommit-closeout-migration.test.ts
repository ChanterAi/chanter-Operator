import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDatabase,
  migrateSafeCommitCloseoutTables,
} from "../src/db/database.js";

describe("SafeCommit closeout SQLite migration", () => {
  const temporaryRoots: string[] = [];

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function databasePath(): string {
    const root = mkdtempSync(path.join(os.tmpdir(), "safecommit-closeout-migration-"));
    temporaryRoots.push(root);
    return path.join(root, "operator.sqlite");
  }

  it("creates the reviewed request/event schema and is restart-safe", () => {
    const pathValue = databasePath();
    let database = createDatabase(pathValue);
    const tables = database.prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'table' AND name LIKE 'operator_safecommit_closeout%'
       ORDER BY name`,
    ).all() as unknown as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual([
      "operator_safecommit_closeout_events",
      "operator_safecommit_closeouts",
    ]);
    expect(migrateSafeCommitCloseoutTables(database)).toBe(false);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();

    database = createDatabase(pathValue);
    expect(migrateSafeCommitCloseoutTables(database)).toBe(false);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  });

  it("fails closed on an unknown pre-existing table shape", () => {
    const pathValue = databasePath();
    const database = new DatabaseSync(pathValue);
    database.exec(`
      CREATE TABLE operator_safecommit_closeouts (
        request_id TEXT PRIMARY KEY,
        unsafe_command TEXT NOT NULL
      );
    `);
    database.close();

    expect(() => createDatabase(pathValue)).toThrow(
      /refused an unknown operator_safecommit_closeouts schema/i,
    );

    const inspection = new DatabaseSync(pathValue);
    const columns = inspection.prepare(
      "PRAGMA table_info('operator_safecommit_closeouts')",
    ).all() as unknown as Array<{ name: string }>;
    expect(columns.map((row) => row.name)).toEqual([
      "request_id",
      "unsafe_command",
    ]);
    inspection.close();
  });
});
