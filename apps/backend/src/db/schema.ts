import type { ProductLane } from "../types.js";

export const PHASE_2D_GRAPH_NODE_PRODUCT_CHECK =
  "product TEXT NOT NULL CHECK (product <> 'auto_poster')";
export const PHASE_2E_GRAPH_NODE_PRODUCT_CHECK =
  "product TEXT NOT NULL CHECK (product <> 'auto_poster' OR action = 'autoposter.post.schedule')";

export function missionGraphNodesTableSql(
  tableName: "operator_mission_graph_nodes" | "operator_mission_graph_nodes_phase2e",
  ifNotExists = false,
): string {
  return `CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}${tableName} (
  graph_id TEXT NOT NULL REFERENCES operator_mission_graphs(graph_id) ON DELETE RESTRICT,
  node_id TEXT NOT NULL,
  ${PHASE_2E_GRAPH_NODE_PRODUCT_CHECK},
  action TEXT NOT NULL,
  objective TEXT NOT NULL,
  input_json TEXT NOT NULL,
  depends_on_json TEXT NOT NULL,
  child_mission_id TEXT NOT NULL UNIQUE,
  child_trace_id TEXT NOT NULL,
  child_idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'blocked', 'ready', 'running', 'completed',
    'failed_recoverable', 'failed_terminal', 'cancelled'
  )),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 3),
  result_status TEXT,
  result_summary_json TEXT,
  typed_error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (graph_id, node_id)
);`;
}

/**
 * Canonical Platform -> Operator AutoPoster command/linkage authority.
 *
 * One row is the complete durable cross-system identity binding. It is not a
 * second graph, mission, or publishing database: immutable command bytes are
 * persisted first, then linked to existing authorities as they materialize.
 */
export function platformAutoPosterCommandsTableSql(ifNotExists = false): string {
  return `CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}operator_platform_autoposter_commands (
  command_id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL CHECK (schema_version = 'chanter.platform.autoposter.create-work.v1'),
  tenant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  intake_key TEXT NOT NULL,
  canonical_json TEXT NOT NULL,
  command_hash TEXT NOT NULL CHECK (length(command_hash) = 64),
  graph_id TEXT UNIQUE,
  graph_hash TEXT,
  child_mission_id TEXT,
  runtime_execution_id TEXT,
  campaign_id TEXT,
  job_ids_json TEXT NOT NULL DEFAULT '[]',
  approval_id TEXT,
  evidence_bundle_id TEXT,
  evidence_manifest_path TEXT,
  evidence_available INTEGER NOT NULL DEFAULT 0 CHECK (evidence_available IN (0, 1)),
  trace_id TEXT,
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN (
    'accepted', 'approval_required', 'executing', 'failed_recoverable', 'completed', 'failed'
  )),
  product_state TEXT NOT NULL CHECK (product_state IN (
    'not_started', 'recovery_required', 'draft_created', 'failed'
  )),
  draft_execution_approval_state TEXT NOT NULL CHECK (draft_execution_approval_state IN (
    'required', 'approved'
  )),
  publication_approval_state TEXT NOT NULL CHECK (publication_approval_state = 'human_required'),
  error_code TEXT,
  error_message TEXT,
  requested_at TEXT NOT NULL,
  executed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, actor_id, intake_key)
);`;
}

/**
 * Phase 2E-B bounded Operator projection of one AutoPoster publishing
 * lifecycle observation. These are the only ten states the projection may
 * derive; exact AutoPoster source/provider statuses are stored verbatim
 * alongside so the derivation is always auditable.
 */
export const AUTOPOSTER_RESULT_PROJECTION_STATUSES = [
  "awaiting_publish_approval",
  "approved_for_publish",
  "processing",
  "retry_scheduled",
  "uploaded_private",
  "provider_accepted_unverified",
  "manually_reconciled",
  "failed",
  "outcome_unknown",
  "manual_review_required",
] as const;

const projectionStatusCheckSql = AUTOPOSTER_RESULT_PROJECTION_STATUSES
  .map((status) => `'${status}'`)
  .join(", ");

/**
 * Phase 2E-B result projection: one row per completed AutoPoster schedule
 * graph node, holding the latest confirmed allowlisted observation of its
 * exact queue job. This is a read-model of AutoPoster truth — never a second
 * publishing-job database — so it stores identity, bounded evidence, and a
 * snapshot hash, never the full job document.
 */
export function autoPosterResultProjectionsTableSql(ifNotExists = false): string {
  return `CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}operator_autoposter_result_projections (
  graph_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  graph_hash TEXT NOT NULL,
  child_mission_id TEXT NOT NULL UNIQUE,
  child_trace_id TEXT NOT NULL,
  queue_job_id TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL CHECK (provider IN ('tiktok', 'youtube')),
  connected_account_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  source_status TEXT NOT NULL,
  provider_status TEXT NOT NULL,
  projection_status TEXT NOT NULL CHECK (projection_status IN (
    ${projectionStatusCheckSql}
  )),
  approved INTEGER NOT NULL CHECK (approved IN (0, 1)),
  source_updated_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  escalation_reason TEXT,
  escalation_severity TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (graph_id, node_id),
  FOREIGN KEY (graph_id, node_id) REFERENCES operator_mission_graph_nodes(graph_id, node_id) ON DELETE RESTRICT
);`;
}

/**
 * Phase 2E-B append-only observation evidence. Exact replay appends nothing;
 * every validated newer observation, contradiction, or identity mismatch
 * appends exactly one row with a deterministic event id.
 */
export function autoPosterResultEventsTableSql(ifNotExists = false): string {
  return `CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}operator_autoposter_result_events (
  event_id TEXT PRIMARY KEY,
  graph_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  queue_job_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  observation_kind TEXT NOT NULL CHECK (observation_kind IN (
    'observation', 'contradiction', 'identity_mismatch'
  )),
  projection_status TEXT NOT NULL CHECK (projection_status IN (
    ${projectionStatusCheckSql}
  )),
  reason_code TEXT NOT NULL,
  source_updated_at TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  FOREIGN KEY (graph_id, node_id) REFERENCES operator_mission_graph_nodes(graph_id, node_id) ON DELETE RESTRICT,
  UNIQUE (graph_id, node_id, sequence)
);`;
}

export const autoPosterResultEventsIndexSql =
  `CREATE INDEX IF NOT EXISTS idx_operator_autoposter_result_events_node
  ON operator_autoposter_result_events(graph_id, node_id, sequence);`;

/**
 * Phase 2E-C durable observation job lifecycle (closed world). `pending` has
 * never been attempted, `waiting` sits between bounded attempts, `leased` and
 * `observing` are lease-protected in-flight states, and the four remaining
 * states are terminal: a terminal job is never claimable again.
 */
export const AUTOPOSTER_OBSERVATION_JOB_STATUSES = [
  "pending",
  "leased",
  "observing",
  "waiting",
  "converged",
  "escalation_required",
  "failed_terminal",
  "cancelled",
] as const;

const observationJobStatusCheckSql = AUTOPOSTER_OBSERVATION_JOB_STATUSES
  .map((status) => `'${status}'`)
  .join(", ");

/** Phase 2E-C durable escalation lifecycle (closed world). */
export const AUTOPOSTER_OBSERVATION_ESCALATION_STATUSES = [
  "open",
  "acknowledged",
  "resolved",
  "dismissed",
] as const;

const observationEscalationStatusCheckSql = AUTOPOSTER_OBSERVATION_ESCALATION_STATUSES
  .map((status) => `'${status}'`)
  .join(", ");

/**
 * Phase 2E-C outcome classes for one completed observation attempt. Exactly
 * the four spec classes plus `transport_retry` (a bounded typed transport or
 * contract read failure that consumed an attempt without producing provider
 * truth — it re-observes like class A but never relabels the AutoPoster job).
 */
export const AUTOPOSTER_OBSERVATION_OUTCOME_CLASSES = [
  "continue_observing",
  "converged",
  "escalation_required",
  "failed_terminal",
  "transport_retry",
] as const;

const observationOutcomeClassCheckSql = AUTOPOSTER_OBSERVATION_OUTCOME_CLASSES
  .map((outcomeClass) => `'${outcomeClass}'`)
  .join(", ");

/**
 * Phase 2E-C durable observation job: exactly one row per completed
 * AutoPoster schedule graph node that reached a valid downstream queue
 * binding. The Operator owns this scheduling state (leases, attempts,
 * convergence) — the job never stores provider truth beyond the immutable
 * identity binding it observes.
 */
export function autoPosterObservationJobsTableSql(ifNotExists = false): string {
  return `CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}operator_autoposter_observation_jobs (
  observation_job_id TEXT PRIMARY KEY,
  graph_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  mission_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  connected_account_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('tiktok', 'youtube')),
  queue_job_id TEXT NOT NULL UNIQUE,
  source_binding_json TEXT NOT NULL,
  source_binding_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    ${observationJobStatusCheckSql}
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL CHECK (max_attempts >= 1 AND max_attempts <= 12),
  next_attempt_at TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  convergence_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (graph_id, node_id),
  FOREIGN KEY (graph_id, node_id) REFERENCES operator_mission_graph_nodes(graph_id, node_id) ON DELETE RESTRICT
);`;
}

/**
 * Phase 2E-C append-only per-attempt telemetry and canonical observation
 * attempt record. One row per completed attempt; a crash mid-attempt leaves
 * the durable attempt counter ahead of this table, which is itself truthful
 * evidence of the interruption. Never tokens, credentials, or raw provider
 * payloads.
 */
export function autoPosterObservationAttemptsTableSql(ifNotExists = false): string {
  return `CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}operator_autoposter_observation_attempts (
  attempt_id TEXT PRIMARY KEY,
  observation_job_id TEXT NOT NULL REFERENCES operator_autoposter_observation_jobs(observation_job_id) ON DELETE RESTRICT,
  graph_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  provider TEXT NOT NULL,
  lease_owner TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
  outcome_class TEXT NOT NULL CHECK (outcome_class IN (
    ${observationOutcomeClassCheckSql}
  )),
  refresh_outcome TEXT NOT NULL,
  projection_status TEXT,
  reason_code TEXT,
  retry_delay_seconds INTEGER,
  next_attempt_at TEXT,
  error_code TEXT,
  error_message TEXT,
  UNIQUE (observation_job_id, attempt_number)
);`;
}

/**
 * Phase 2E-C durable human escalation. Exactly one escalation may ever exist
 * per observation job (the job parks terminally as `escalation_required`
 * when it is created), so replay can never duplicate one. Contains a safe
 * bounded summary and evidence references — never raw provider payloads.
 */
export function autoPosterObservationEscalationsTableSql(ifNotExists = false): string {
  return `CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}operator_autoposter_observation_escalations (
  escalation_id TEXT PRIMARY KEY,
  observation_job_id TEXT NOT NULL UNIQUE REFERENCES operator_autoposter_observation_jobs(observation_job_id) ON DELETE RESTRICT,
  graph_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'high', 'critical')),
  human_action_required INTEGER NOT NULL CHECK (human_action_required IN (0, 1)),
  recommended_human_action TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    ${observationEscalationStatusCheckSql}
  )),
  acknowledged_by TEXT,
  acknowledged_at TEXT,
  resolved_by TEXT,
  resolved_at TEXT,
  resolution_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`;
}

export const autoPosterObservationIndexesSql = `
CREATE INDEX IF NOT EXISTS idx_operator_autoposter_observation_jobs_due
  ON operator_autoposter_observation_jobs(status, next_attempt_at, observation_job_id);
CREATE INDEX IF NOT EXISTS idx_operator_autoposter_observation_attempts_job
  ON operator_autoposter_observation_attempts(observation_job_id, attempt_number);
CREATE INDEX IF NOT EXISTS idx_operator_autoposter_observation_escalations_status
  ON operator_autoposter_observation_escalations(status, created_at, escalation_id);
`;

export function safeCommitCloseoutsTableSql(ifNotExists = false): string {
  return `CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}operator_safecommit_closeouts (
  request_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  schema_version TEXT NOT NULL CHECK (schema_version = 'chanter.operator.safecommit-closeout.v1'),
  action TEXT NOT NULL CHECK (action = 'safecommit.closeout.execute'),
  plan_id TEXT NOT NULL UNIQUE,
  plan_schema_version TEXT NOT NULL CHECK (plan_schema_version = 'chanter.safecommit.closeout.v1'),
  plan_hash TEXT NOT NULL CHECK (
    length(plan_hash) = 64 AND plan_hash NOT GLOB '*[^0-9a-f]*'
  ),
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'approval_required', 'approved', 'execution_claimed', 'completed',
    'failed_terminal', 'invalidated', 'revoked'
  )),
  approved_by TEXT,
  approval_basis TEXT CHECK (
    approval_basis IS NULL OR
    approval_basis = 'founder_reviewed_exact_plan_and_repository_preflight'
  ),
  approval_note TEXT,
  approved_at TEXT,
  approved_plan_hash TEXT,
  approval_evidence_id TEXT UNIQUE,
  approval_evidence_digest TEXT,
  claimed_by TEXT,
  claimed_at TEXT,
  terminal_actor TEXT,
  terminal_reason_code TEXT,
  terminal_reason TEXT,
  terminal_at TEXT,
  terminal_evidence_ref TEXT,
  terminal_evidence_digest TEXT,
  closeout_evidence_ref TEXT,
  closeout_evidence_digest TEXT,
  closeout_outcome TEXT CHECK (
    closeout_outcome IS NULL OR closeout_outcome IN ('completed', 'failed_terminal')
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`;
}

export function safeCommitCloseoutEventsTableSql(ifNotExists = false): string {
  return `CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}operator_safecommit_closeout_events (
  event_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES operator_safecommit_closeouts(request_id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_type TEXT NOT NULL,
  previous_state TEXT CHECK (
    previous_state IS NULL OR previous_state IN (
      'approval_required', 'approved', 'execution_claimed', 'completed',
      'failed_terminal', 'invalidated', 'revoked'
    )
  ),
  new_state TEXT NOT NULL CHECK (new_state IN (
    'approval_required', 'approved', 'execution_claimed', 'completed',
    'failed_terminal', 'invalidated', 'revoked'
  )),
  actor TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  reason TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  evidence_ref TEXT,
  evidence_digest TEXT,
  UNIQUE(request_id, sequence)
);`;
}

export const safeCommitCloseoutIndexesSql = `
CREATE INDEX IF NOT EXISTS idx_operator_safecommit_closeouts_status
  ON operator_safecommit_closeouts(status, created_at DESC, request_id);
CREATE INDEX IF NOT EXISTS idx_operator_safecommit_closeout_events_request
  ON operator_safecommit_closeout_events(request_id, sequence);
`;

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
  sound_mode TEXT NOT NULL DEFAULT 'keep_original' CHECK (sound_mode IN (
    'keep_original', 'mute', 'tiktok_recommended'
  )),
  sound_mode_explicit INTEGER NOT NULL DEFAULT 0 CHECK (sound_mode_explicit IN (0, 1)),
  graph_id TEXT,
  graph_id_forwarded INTEGER NOT NULL DEFAULT 0 CHECK (graph_id_forwarded IN (0, 1)),
  provider_proof_mode INTEGER NOT NULL DEFAULT 0 CHECK (provider_proof_mode IN (0, 1)),
  approved_media_json TEXT,
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

-- Phase 2D durable mission graph authority (additive; the Phase 2C mission
-- spine tables above are intentionally untouched). One graph compiles once
-- into an immutable normalized document + SHA-256 hash; founder approval
-- binds that exact hash; nodes materialize through their existing reviewed
-- child mission authority, so the graph layer never becomes a second
-- execution authority.
CREATE TABLE IF NOT EXISTS operator_mission_graphs (
  graph_id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  schema_version TEXT NOT NULL CHECK (schema_version = 'chanter.mission.graph.v1'),
  source_system TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  tenant_user_id TEXT NOT NULL,
  workspace_id TEXT,
  account_id TEXT,
  objective TEXT NOT NULL,
  compiled_graph_json TEXT NOT NULL,
  graph_hash TEXT NOT NULL,
  node_count INTEGER NOT NULL CHECK (node_count >= 1 AND node_count <= 8),
  status TEXT NOT NULL CHECK (status IN (
    'approval_required', 'approved', 'running', 'completed',
    'failed_recoverable', 'failed_terminal', 'cancelled'
  )),
  approval_required INTEGER NOT NULL DEFAULT 1 CHECK (approval_required = 1),
  approved_by TEXT,
  approved_at TEXT,
  approved_graph_hash TEXT,
  requested_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_operator_mission_graphs_created_at
  ON operator_mission_graphs(created_at DESC, graph_id DESC);

${missionGraphNodesTableSql("operator_mission_graph_nodes", true)}

CREATE TABLE IF NOT EXISTS operator_mission_graph_edges (
  graph_id TEXT NOT NULL REFERENCES operator_mission_graphs(graph_id) ON DELETE RESTRICT,
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  PRIMARY KEY (graph_id, from_node_id, to_node_id)
);

CREATE TABLE IF NOT EXISTS operator_mission_graph_events (
  event_id TEXT PRIMARY KEY,
  graph_id TEXT NOT NULL REFERENCES operator_mission_graphs(graph_id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  scope TEXT NOT NULL CHECK (scope IN ('graph', 'node')),
  node_id TEXT,
  event_type TEXT NOT NULL,
  previous_state TEXT,
  new_state TEXT,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  typed_error_json TEXT,
  UNIQUE(graph_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_operator_mission_graph_events_graph
  ON operator_mission_graph_events(graph_id, sequence);

CREATE TABLE IF NOT EXISTS operator_mission_graph_replays (
  graph_id TEXT NOT NULL REFERENCES operator_mission_graphs(graph_id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type = 'graph_submission_replayed'),
  replay_identity TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE REFERENCES operator_mission_graph_events(event_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (graph_id, event_type, replay_identity)
);

${safeCommitCloseoutsTableSql(true)}

${safeCommitCloseoutEventsTableSql(true)}

${safeCommitCloseoutIndexesSql}

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

-- ---------------------------------------------------------------------------
-- Governed agentic execution fabric (additive; every table above is untouched).
--
-- One human mission compiles into one immutable intent contract, one admitted
-- context bundle, and one deterministic plan whose id is a digest of both. The
-- plan's nodes are the executable unit, and every consequential fact about a
-- node -- its bounds, its lease, its one worker record, its evidence -- is a
-- row here rather than process memory, so a restart re-reads reality instead of
-- reconstructing it.
--
-- The Phase 2D mission-graph tables are deliberately not reused: their node is
-- a child-mission dispatch bound to one (product, action), whereas an agentic
-- node is a capability-bounded worker with a budget, a deadline, an output
-- schema, and an evidence requirement. Overloading one table with both would
-- have made every column optional for half its rows.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operator_agentic_missions (
  mission_id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL UNIQUE,
  schema_version TEXT NOT NULL CHECK (schema_version = 'chanter.agentic-work.v1'),
  workspace_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  objective TEXT NOT NULL,
  intent_hash TEXT NOT NULL,
  intent_json TEXT NOT NULL,
  context_bundle_id TEXT NOT NULL,
  context_bundle_json TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  routing_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'compiled', 'approval_required', 'approved', 'running', 'awaiting_authority',
    'completed', 'failed_recoverable', 'reconciliation_required', 'failed_terminal', 'cancelled'
  )),
  approval_required INTEGER NOT NULL DEFAULT 1 CHECK (approval_required = 1),
  execution_approved_by TEXT,
  execution_approved_at TEXT,
  execution_approved_plan_hash TEXT,
  candidate_hash TEXT,
  candidate_markdown TEXT,
  candidate_approved_by TEXT,
  candidate_approved_at TEXT,
  approved_candidate_hash TEXT,
  candidate_approval_expires_at TEXT,
  candidate_authority_revision TEXT,
  artifact_hash TEXT,
  artifact_name TEXT,
  -- ObservedState, DesiredState, and StateDelta for an operational-exception
  -- mission, established once at intake. A column on the mission row rather
  -- than a table of its own: these are properties *of this mission*, and a
  -- separate store would be a second place the same fact could be edited.
  -- NULL for every mission kind that resolves no operational exception.
  exception_state_json TEXT,
  value_observation_json TEXT,
  typed_error_json TEXT,
  requested_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_operator_agentic_missions_created_at
  ON operator_agentic_missions(created_at DESC, mission_id DESC);

CREATE TABLE IF NOT EXISTS operator_agentic_plan_nodes (
  plan_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  mission_id TEXT NOT NULL REFERENCES operator_agentic_missions(mission_id) ON DELETE RESTRICT,
  node_type TEXT NOT NULL CHECK (node_type IN (
    'context_collect', 'specialist', 'verifier', 'synthesis',
    'authority_checkpoint', 'artifact_write', 'outcome_verify',
    -- Operational-exception shapes. The checkpoint and the oracle are shared
    -- with the artifact plan rather than duplicated under new names.
    'state_observe', 'action_compile', 'connector_apply'
  )),
  capability_id TEXT,
  worker_kind TEXT,
  -- The reviewed provider binding this node executes against, or NULL when it
  -- runs no model. Part of payload_hash, so it cannot change under an approval.
  provider_binding_id TEXT,
  depends_on_json TEXT NOT NULL,
  input_refs_json TEXT NOT NULL,
  authority_requirement TEXT NOT NULL CHECK (authority_requirement IN (
    'none', 'human_approval_bound_to_candidate_hash'
  )),
  budget_json TEXT NOT NULL,
  deadline_offset_ms INTEGER NOT NULL CHECK (deadline_offset_ms >= 0),
  attempt_limit INTEGER NOT NULL CHECK (attempt_limit >= 1),
  reconciliation_mode TEXT NOT NULL,
  evidence_policy_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'blocked', 'ready', 'running', 'completed', 'failed_recoverable',
    'reconciliation_required', 'failed_terminal', 'cancelled'
  )),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_owner TEXT,
  lease_expires_at TEXT,
  deadline_at TEXT,
  idempotency_key TEXT NOT NULL,
  output_json TEXT,
  output_hash TEXT,
  cost_json TEXT,
  latency_ms INTEGER,
  reconciliation_outcome TEXT CHECK (reconciliation_outcome IN (
    'worker_result_found', 'no_worker_result', 'conflict'
  )),
  reconciled_at TEXT,
  typed_error_json TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (plan_id, node_id)
);

CREATE INDEX IF NOT EXISTS idx_operator_agentic_plan_nodes_mission
  ON operator_agentic_plan_nodes(mission_id, node_id);

CREATE TABLE IF NOT EXISTS operator_agentic_plan_edges (
  plan_id TEXT NOT NULL,
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  PRIMARY KEY (plan_id, from_node_id, to_node_id),
  FOREIGN KEY (plan_id, from_node_id)
    REFERENCES operator_agentic_plan_nodes(plan_id, node_id) ON DELETE RESTRICT,
  FOREIGN KEY (plan_id, to_node_id)
    REFERENCES operator_agentic_plan_nodes(plan_id, node_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS operator_agentic_plan_events (
  event_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES operator_agentic_missions(mission_id) ON DELETE RESTRICT,
  plan_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('mission', 'plan', 'node')),
  node_id TEXT,
  event_type TEXT NOT NULL,
  previous_state TEXT,
  new_state TEXT,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  typed_error_json TEXT,
  UNIQUE (mission_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_operator_agentic_plan_events_mission
  ON operator_agentic_plan_events(mission_id, sequence);

CREATE TABLE IF NOT EXISTS operator_agentic_node_evidence (
  evidence_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  mission_id TEXT NOT NULL REFERENCES operator_agentic_missions(mission_id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN (
    'context_reference', 'tool_output', 'derived_claim', 'artifact'
  )),
  label TEXT NOT NULL,
  source_reference TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (plan_id, node_id, evidence_id),
  FOREIGN KEY (plan_id, node_id)
    REFERENCES operator_agentic_plan_nodes(plan_id, node_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_operator_agentic_node_evidence_mission
  ON operator_agentic_node_evidence(mission_id, node_id);

-- The Runtime's durable memory of worker invocations. One row per node
-- execution identity: the claim is taken before the worker runs and the outcome
-- is written after it returns, so the gap between them is exactly the window a
-- node-level reconcile has to resolve.
CREATE TABLE IF NOT EXISTS operator_agentic_worker_records (
  idempotency_key TEXT PRIMARY KEY,
  execution_hash TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  claim_owner TEXT,
  claimed_at TEXT,
  status TEXT,
  structured_output_json TEXT,
  output_hash TEXT,
  evidence_json TEXT,
  tool_calls_json TEXT,
  cost_json TEXT,
  latency_ms INTEGER,
  typed_error_json TEXT,
  recorded_at TEXT
);

-- The Runtime's durable memory of provider invocations, written the instant a
-- provider's outcome is known and before the worker that requested it returns.
-- That ordering is what makes a crash between the call and the node commit
-- recoverable for free: the proof that the provider answered already exists.
--
-- One row per (node execution identity, binding), so re-running the same node
-- against the same binding is recognized as the same call while a declared
-- fallback to a different binding is correctly a different one. The primary key
-- is the enforcement — a second charge under one identity is a constraint
-- violation, not a silently doubled invoice.
--
-- No prompt, no completion, and no reasoning is stored. Only hashes, measured
-- usage, cited references, and bounded diagnostic metadata.
CREATE TABLE IF NOT EXISTS operator_agentic_provider_usage (
  provider_call_key TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  model_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  provider_request_id TEXT,
  request_hash TEXT NOT NULL,
  raw_response_hash TEXT,
  response_hash TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  monetary_cost_micros INTEGER,
  monetary_cost_source TEXT NOT NULL,
  monetary_cost_unavailable_reason TEXT,
  pricing_revision TEXT,
  latency_ms INTEGER NOT NULL,
  finish_reason TEXT,
  typed_error_json TEXT,
  fallback_decision TEXT NOT NULL,
  fallback_from_binding_id TEXT,
  evidence_references_json TEXT NOT NULL,
  -- Independent billing evidence for this exact charge, attached after the row
  -- is already durable. Written by a second statement on purpose: the charge
  -- must survive even when the evidence for it cannot be obtained.
  reconciliation_json TEXT,
  recorded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_operator_agentic_provider_usage_node
  ON operator_agentic_provider_usage(idempotency_key, provider_call_key);

CREATE INDEX IF NOT EXISTS idx_operator_agentic_provider_usage_mission
  ON operator_agentic_provider_usage(mission_id, node_id);

-- Exactly-one-write, enforced by the primary key rather than by a counter a
-- caller could forget to increment. A second write under the same identity is a
-- constraint violation, not a silently doubled artifact.
CREATE TABLE IF NOT EXISTS operator_agentic_artifact_writes (
  mission_id TEXT NOT NULL REFERENCES operator_agentic_missions(mission_id) ON DELETE RESTRICT,
  artifact_name TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  approved_candidate_hash TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length > 0),
  artifact_path TEXT NOT NULL,
  written_at TEXT NOT NULL,
  PRIMARY KEY (mission_id, artifact_name)
);
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
