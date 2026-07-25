import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  migrateAutoPosterSoundModeColumns,
  migratePlatformAutoPosterCommandsTable,
} from "../src/db/database.js";

describe("canonical Platform command additive migrations", () => {
  it("creates the linkage table once and is restart-safe", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("PRAGMA foreign_keys = ON");
      expect(migratePlatformAutoPosterCommandsTable(database)).toBe(true);
      expect(migratePlatformAutoPosterCommandsTable(database)).toBe(false);
      const columns = database.prepare(
        "PRAGMA table_info(operator_platform_autoposter_commands)",
      ).all() as unknown as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toEqual([
        "command_id",
        "schema_version",
        "tenant_id",
        "actor_id",
        "intake_key",
        "canonical_json",
        "command_hash",
        "graph_id",
        "graph_hash",
        "child_mission_id",
        "runtime_execution_id",
        "campaign_id",
        "job_ids_json",
        "approval_id",
        "evidence_bundle_id",
        "evidence_manifest_path",
        "evidence_available",
        "trace_id",
        "lifecycle_state",
        "product_state",
        "draft_execution_approval_state",
        "publication_approval_state",
        "error_code",
        "error_message",
        "requested_at",
        "executed_at",
        "created_at",
        "updated_at",
      ]);
    } finally {
      database.close();
    }
  });

  it("refuses an unknown lookalike linkage table without rewriting it", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        CREATE TABLE operator_platform_autoposter_commands (
          command_id TEXT PRIMARY KEY,
          unsafe_payload TEXT
        )
      `);
      expect(() => migratePlatformAutoPosterCommandsTable(database))
        .toThrow(/refused an unknown/);
      const columns = database.prepare(
        "PRAGMA table_info(operator_platform_autoposter_commands)",
      ).all() as unknown as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toEqual([
        "command_id",
        "unsafe_payload",
      ]);
    } finally {
      database.close();
    }
  });

  it("adds backward-compatible sound and graph-forwarding custody to existing mission rows", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        CREATE TABLE autoposter_runtime_missions (
          mission_id TEXT PRIMARY KEY
        );
        INSERT INTO autoposter_runtime_missions (mission_id) VALUES ('legacy-mission');
      `);
      expect(migrateAutoPosterSoundModeColumns(database)).toBe(true);
      expect(migrateAutoPosterSoundModeColumns(database)).toBe(false);
      const row = database.prepare(`
        SELECT sound_mode, sound_mode_explicit, graph_id_forwarded
          FROM autoposter_runtime_missions
         WHERE mission_id = 'legacy-mission'
      `).get() as {
        sound_mode: string;
        sound_mode_explicit: number;
        graph_id_forwarded: number;
      };
      expect(row).toEqual({
        sound_mode: "keep_original",
        sound_mode_explicit: 0,
        graph_id_forwarded: 0,
      });
    } finally {
      database.close();
    }
  });
});
