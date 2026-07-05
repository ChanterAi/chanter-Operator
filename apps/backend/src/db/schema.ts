import type { ProductLane } from "../types.js";

export const schema = `
CREATE TABLE IF NOT EXISTS task_intents (
  id TEXT PRIMARY KEY,
  raw_input TEXT NOT NULL,
  parsed_description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'queued', 'awaiting_approval', 'executing', 'completed', 'failed', 'rejected', 'cancelled')),
  priority INTEGER NOT NULL DEFAULT 0,
  product_lane TEXT NOT NULL DEFAULT 'CHANTER Operator',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_steps (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task_intents(id) ON DELETE RESTRICT,
  step_number INTEGER NOT NULL,
  action_type TEXT NOT NULL CHECK (action_type IN ('analysis', 'read_file', 'file_write', 'file_edit', 'shell_command', 'unknown')),
  action_payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_approval', 'approved', 'rejected', 'executing', 'completed', 'failed')),
  requires_approval INTEGER NOT NULL CHECK (requires_approval IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(task_id, step_number)
);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task_intents(id) ON DELETE RESTRICT,
  step_id TEXT NOT NULL REFERENCES execution_steps(id) ON DELETE RESTRICT,
  stdout TEXT NOT NULL,
  stderr TEXT NOT NULL,
  exit_code INTEGER NOT NULL,
  diff TEXT NOT NULL,
  validation_passed INTEGER NOT NULL CHECK (validation_passed IN (0, 1)),
  validation_summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_steps_task_id ON execution_steps(task_id, step_number);
CREATE INDEX IF NOT EXISTS idx_evidence_task_id ON evidence(task_id, created_at);

CREATE TABLE IF NOT EXISTS validation_evidence (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task_intents(id) ON DELETE RESTRICT,
  command_label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'warning', 'not_run')),
  output TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_validation_evidence_task_id ON validation_evidence(task_id, created_at);

CREATE TABLE IF NOT EXISTS commit_reviews (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task_intents(id) ON DELETE RESTRICT,
  summary_text TEXT NOT NULL,
  changed_files_text TEXT NOT NULL,
  validation_text TEXT NOT NULL,
  risk_notes_text TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('blocked', 'needs_review', 'safe_to_review')),
  reasons TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_commit_reviews_task_id ON commit_reviews(task_id, created_at);

CREATE TABLE IF NOT EXISTS runner_policy_previews (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task_intents(id) ON DELETE RESTRICT,
  proposed_command TEXT NOT NULL,
  proposed_purpose TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('allowed_readonly', 'requires_approval', 'blocked')),
  reasons TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runner_policy_previews_task_id ON runner_policy_previews(task_id, created_at);

CREATE TABLE IF NOT EXISTS readonly_command_results (
  id TEXT PRIMARY KEY,
  command TEXT NOT NULL,
  executable TEXT NOT NULL,
  args TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('allowed_readonly', 'blocked')),
  stdout TEXT,
  stderr TEXT,
  exit_code INTEGER,
  duration_ms INTEGER,
  workspace_root TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_readonly_command_results_timestamp ON readonly_command_results(timestamp);
`;

const validLanes = new Set<string>([
  "AutoPoster",
  "Loop Governor",
  "Clean Engine",
  "Crypto Radar",
  "Premium Site",
  "CHANTER Operator",
]);

export function normalizeProductLane(value: unknown): ProductLane {
  return typeof value === "string" && validLanes.has(value)
    ? (value as ProductLane)
    : "CHANTER Operator";
}
