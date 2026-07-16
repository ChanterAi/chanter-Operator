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

CREATE TABLE IF NOT EXISTS agent_run_ledger_runs (
  run_id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL CHECK (schema_version = '1.0'),
  current_event_id TEXT NOT NULL UNIQUE,
  current_sequence INTEGER NOT NULL CHECK (current_sequence > 0),
  product_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  parent_run_id TEXT,
  trace_id TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'created', 'approval_required', 'approved', 'running', 'validating',
    'completed', 'failed', 'cancelled', 'blocked', 'reconciliation_required'
  )),
  outcome TEXT NOT NULL CHECK (outcome IN (
    'pending', 'success', 'failure', 'cancelled', 'blocked', 'reconciliation_required'
  )),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  approval_status TEXT NOT NULL CHECK (approval_status IN (
    'not_required', 'required', 'approved', 'rejected'
  )),
  validation_result TEXT NOT NULL CHECK (validation_result IN (
    'not_run', 'passed', 'failed'
  )),
  failure_reason TEXT,
  failure_code TEXT,
  evidence_count INTEGER NOT NULL CHECK (evidence_count >= 0),
  evidence_integrity_status TEXT NOT NULL CHECK (evidence_integrity_status IN (
    'not_present', 'unverified', 'verified', 'invalid'
  )),
  production_impact INTEGER NOT NULL CHECK (production_impact IN (0, 1)),
  payload_hash TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  entry_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_run_ledger_started_at
  ON agent_run_ledger_runs(started_at DESC, run_id ASC);
CREATE INDEX IF NOT EXISTS idx_agent_run_ledger_product_workflow
  ON agent_run_ledger_runs(product_id, workflow_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_run_ledger_provider_model
  ON agent_run_ledger_runs(provider, model, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_run_ledger_governance
  ON agent_run_ledger_runs(status, approval_status, validation_result, outcome, started_at DESC);

CREATE TABLE IF NOT EXISTS agent_run_ledger_transitions (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_run_ledger_runs(run_id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  attempt_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'created', 'approval_required', 'approved', 'running', 'validating',
    'completed', 'failed', 'cancelled', 'blocked', 'reconciliation_required'
  )),
  outcome TEXT NOT NULL CHECK (outcome IN (
    'pending', 'success', 'failure', 'cancelled', 'blocked', 'reconciliation_required'
  )),
  payload_hash TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  entry_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_agent_run_ledger_transitions_run
  ON agent_run_ledger_transitions(run_id, sequence ASC);

-- Phase 2C generic durable mission spine (additive; the accepted AutoPoster
-- Phase 2A tables above are intentionally untouched). The CHECK below makes
-- it impossible for the generic spine to silently absorb the AutoPoster
-- authority: 'auto_poster' missions can only ever live in their own tables.
CREATE TABLE IF NOT EXISTS operator_missions (
  mission_id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL UNIQUE,
  product TEXT NOT NULL CHECK (product <> 'auto_poster'),
  action TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  tenant_user_id TEXT NOT NULL,
  workspace_id TEXT,
  account_id TEXT,
  objective TEXT NOT NULL,
  input_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'approval_required', 'executing', 'succeeded', 'failed', 'denied',
    'validation_failed', 'duplicate', 'unavailable'
  )),
  approval_required INTEGER NOT NULL DEFAULT 1 CHECK (approval_required = 1),
  approved_by TEXT,
  runtime_result_json TEXT,
  requested_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_operator_missions_created_at
  ON operator_missions(created_at DESC, mission_id DESC);
CREATE INDEX IF NOT EXISTS idx_operator_missions_product_action
  ON operator_missions(product, action, created_at DESC);

CREATE TABLE IF NOT EXISTS operator_mission_executions (
  mission_id TEXT PRIMARY KEY REFERENCES operator_missions(mission_id) ON DELETE RESTRICT,
  execution_attempt_id TEXT NOT NULL,
  mission_payload_hash TEXT NOT NULL,
  downstream_operation_type TEXT NOT NULL,
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
    'scope_mismatch', 'idempotency_mismatch', 'payload_mismatch', 'invalid',
    'incomplete'
  )),
  downstream_ids_json TEXT,
  final_result_status TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0 AND retry_count <= 1),
  typed_error_json TEXT,
  reconciliation_result_json TEXT,
  runtime_observation_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operator_mission_journal (
  transition_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES operator_missions(mission_id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  execution_attempt_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  product TEXT NOT NULL,
  action TEXT NOT NULL,
  previous_state TEXT,
  new_state TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  typed_error_json TEXT,
  UNIQUE(mission_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_operator_mission_journal_mission
  ON operator_mission_journal(mission_id, sequence);

CREATE TABLE IF NOT EXISTS agent_run_ledger_ingest_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  contract_version TEXT NOT NULL CHECK (contract_version = '1.0'),
  producer TEXT NOT NULL,
  mission_id TEXT,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  event_type TEXT NOT NULL,
  correlation_id TEXT,
  causation_id TEXT,
  payload_hash TEXT NOT NULL,
  entry_json TEXT NOT NULL,
  ingest_outcome TEXT NOT NULL CHECK (ingest_outcome IN ('accepted', 'conflicted')),
  applied INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0, 1)),
  applied_at TEXT,
  created_at TEXT NOT NULL
);

-- Only one accepted receipt may ever own a given event_id; conflicted probes
-- are retained as evidence rows and are deliberately exempt from this index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_run_ledger_ingest_events_event_id_accepted
  ON agent_run_ledger_ingest_events(event_id)
  WHERE ingest_outcome = 'accepted';

CREATE INDEX IF NOT EXISTS idx_agent_run_ledger_ingest_events_run_sequence
  ON agent_run_ledger_ingest_events(run_id, sequence, ingest_outcome);

CREATE INDEX IF NOT EXISTS idx_agent_run_ledger_ingest_events_pending
  ON agent_run_ledger_ingest_events(run_id, applied, sequence)
  WHERE ingest_outcome = 'accepted';
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
