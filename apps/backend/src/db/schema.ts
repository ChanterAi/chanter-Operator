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

CREATE TABLE IF NOT EXISTS autoposter_runtime_missions (
  mission_id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL UNIQUE,
  product TEXT NOT NULL CHECK (product = 'auto_poster'),
  action TEXT NOT NULL CHECK (action = 'autoposter.post.schedule'),
  actor_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('tiktok', 'youtube')),
  media_url TEXT NOT NULL,
  caption TEXT NOT NULL,
  hashtags TEXT NOT NULL,
  title TEXT,
  description TEXT,
  scheduled_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('approval_required', 'executing', 'succeeded', 'failed', 'denied', 'validation_failed', 'duplicate', 'unavailable')),
  approval_required INTEGER NOT NULL DEFAULT 1 CHECK (approval_required = 1),
  approved_by TEXT,
  runtime_result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_autoposter_runtime_missions_created_at
  ON autoposter_runtime_missions(created_at DESC);

CREATE TABLE IF NOT EXISTS autoposter_mission_executions (
  mission_id TEXT PRIMARY KEY REFERENCES autoposter_runtime_missions(mission_id) ON DELETE RESTRICT,
  execution_attempt_id TEXT NOT NULL,
  mission_payload_hash TEXT NOT NULL,
  downstream_operation_type TEXT NOT NULL CHECK (downstream_operation_type = 'autoposter.queue.create_unapproved_draft'),
  current_state TEXT NOT NULL CHECK (current_state IN (
    'approval_required', 'approved', 'execution_started',
    'downstream_request_prepared', 'downstream_result_observed',
    'result_persisted', 'completed', 'failed_recoverable',
    'failed_terminal', 'reconciliation_required', 'recovery_in_progress'
  )),
  last_confirmed_boundary TEXT NOT NULL,
  recovery_reason TEXT NOT NULL DEFAULT '',
  recovery_classification TEXT NOT NULL DEFAULT 'NONE',
  reconciliation_outcome TEXT NOT NULL DEFAULT 'not_started' CHECK (reconciliation_outcome IN (
    'not_started', 'not_found', 'unique', 'conflict', 'unavailable',
    'scope_mismatch', 'idempotency_mismatch', 'payload_mismatch', 'invalid'
  )),
  downstream_queue_id TEXT,
  final_result_status TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0 AND retry_count <= 1),
  typed_error_json TEXT,
  reconciliation_result_json TEXT,
  runtime_observation_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS autoposter_mission_journal (
  transition_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES autoposter_runtime_missions(mission_id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  execution_attempt_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action = 'autoposter.post.schedule'),
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('tiktok', 'youtube')),
  account_id TEXT NOT NULL,
  previous_state TEXT,
  new_state TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  typed_error_json TEXT,
  UNIQUE(mission_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_autoposter_mission_journal_mission
  ON autoposter_mission_journal(mission_id, sequence);
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
