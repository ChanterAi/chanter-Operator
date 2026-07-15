import { createHash } from "node:crypto";
import {
  createAgentRunLedgerEntry,
  deriveAgentRunLedgerOutcome,
  type AgentRunLedgerEntry,
  type AgentRunLedgerEntryDraft,
  type AgentRunLedgerStatus,
} from "chanter-agent-runtime";
import type { AgentRunLedgerService } from "../agentRunLedger/agentRunLedgerService.js";
import type { MissionJournalTransition } from "./missionExecutionJournal.js";

const PRODUCT = "auto_poster";
const WORKFLOW = "autoposter.post.schedule";
const AGENT = "chanter-agent-runtime";
const SOURCE = "chanter-operator";

export interface AutoPosterMissionLedgerContext {
  missionId: string;
  traceId: string;
  attemptId: string;
  provider: "tiktok" | "youtube";
  startedAt: string;
  updatedAt: string;
  approvalActor: string | null;
  approvalTimestamp: string | null;
  runtimeStarted: boolean;
}

export interface AutoPosterMissionLedgerFailure {
  code: string;
  reason: string;
}

export interface AutoPosterLegacyMissionLedgerLineage {
  missionId: string;
  traceId: string;
  provider: "tiktok" | "youtube";
  startedAt: string;
  serializedRuntimeResult: string | null;
  transitions: readonly MissionJournalTransition[];
}

function eventId(runId: string, sequence: number): string {
  return `operator-ledger:${createHash("sha256")
    .update(`${runId}\n${sequence}`, "utf8")
    .digest("hex")}`;
}

function runtimeResultEvidence(
  missionId: string,
  serializedRuntimeResult: string,
  capturedAt: string,
): AgentRunLedgerEntryDraft["evidence_refs"] {
  const sha256 = createHash("sha256")
    .update(serializedRuntimeResult, "utf8")
    .digest("hex");
  return [{
    evidence_id: `runtime-result:${sha256}`,
    kind: "artifact",
    uri: `operator://runtime-missions/${encodeURIComponent(missionId)}/runtime-result`,
    sha256,
    captured_at: capturedAt,
  }];
}

function actionOutcome(status: AgentRunLedgerStatus) {
  if (status === "completed") return "succeeded" as const;
  if (status === "failed") return "failed" as const;
  if (status === "reconciliation_required" || status === "blocked") return "blocked" as const;
  return "pending" as const;
}

/**
 * Narrow Operator-owned producer for the canonical Runtime ledger contract.
 * It stores no authority of its own; every append goes through the one durable
 * AgentRunLedgerService backed by the same SQLite transaction as the mission.
 */
export class AutoPosterMissionLedger {
  constructor(private readonly ledger: AgentRunLedgerService) {}

  initialize(context: AutoPosterMissionLedgerContext): void {
    this.append(context, "created");
    this.append(context, "approval_required");
  }

  /**
   * Pre-Phase2A missions already have one durable mission row and journal but
   * no Agent Run Ledger rows. Rebuild only that missing lineage from the
   * journal before the caller performs its next mutation. Existing ledger
   * rows are authoritative and are never replayed or appended here.
   */
  backfillLegacyLineage(input: AutoPosterLegacyMissionLedgerLineage): boolean {
    if (this.currentEntry(input.missionId)) return false;

    const initial = input.transitions[0];
    if (!initial || initial.newState !== "approval_required") {
      throw new Error("Legacy Runtime mission has no initial approval-required journal transition.");
    }

    const context = (
      updatedAt: string,
      approvalActor: string | null,
      approvalTimestamp: string | null,
      runtimeStarted: boolean,
    ): AutoPosterMissionLedgerContext => ({
      missionId: input.missionId,
      traceId: input.traceId,
      attemptId: initial.executionAttemptId,
      provider: input.provider,
      startedAt: input.startedAt,
      updatedAt,
      approvalActor,
      approvalTimestamp,
      runtimeStarted,
    });

    this.append(context(input.startedAt, null, null, false), "created");
    this.append(context(initial.timestamp, null, null, false), "approval_required");

    let approvalActor: string | null = null;
    let approvalTimestamp: string | null = null;
    let runtimeStarted = false;
    let lineageStatus: AgentRunLedgerStatus = "approval_required";
    for (const transition of input.transitions.slice(1)) {
      if (transition.newState === "approved") {
        approvalActor = transition.actor;
        approvalTimestamp = transition.timestamp;
      }
      if (
        transition.newState === "execution_started"
        || transition.newState === "recovery_in_progress"
      ) {
        runtimeStarted = true;
      }
      const transitionContext = context(
        transition.timestamp,
        approvalActor,
        approvalTimestamp,
        runtimeStarted,
      );
      const failure = {
        code: transition.typedError?.code ?? "LEGACY_OPERATOR_MISSION_FAILED",
        reason: transition.typedError?.message ?? transition.reason,
      };

      switch (transition.newState) {
        case "approved":
          this.recordApproved(transitionContext);
          lineageStatus = "approved";
          break;
        case "execution_started":
          this.recordRunning(transitionContext);
          lineageStatus = "running";
          break;
        case "recovery_in_progress":
          if (lineageStatus !== "validating") {
            this.recordRunning(transitionContext);
            lineageStatus = "running";
          }
          break;
        case "downstream_result_observed":
          this.recordValidating(transitionContext);
          lineageStatus = "validating";
          break;
        case "completed":
          if (!input.serializedRuntimeResult) {
            throw new Error("Completed legacy Runtime mission has no persisted result evidence.");
          }
          this.recordCompleted(transitionContext, input.serializedRuntimeResult);
          lineageStatus = "completed";
          break;
        case "failed_recoverable":
        case "reconciliation_required":
          this.recordReconciliationRequired(transitionContext, failure);
          lineageStatus = "reconciliation_required";
          break;
        case "failed_terminal":
          this.recordFailed(transitionContext, failure);
          lineageStatus = "failed";
          break;
        case "approval_required":
        case "downstream_request_prepared":
        case "result_persisted":
          break;
      }
    }
    return true;
  }

  recordApproved(context: AutoPosterMissionLedgerContext): void {
    this.append(context, "approved");
  }

  recordRunning(context: AutoPosterMissionLedgerContext): void {
    this.append(context, "running");
  }

  recordValidating(context: AutoPosterMissionLedgerContext): void {
    this.append(context, "validating");
  }

  recordCompleted(
    context: AutoPosterMissionLedgerContext,
    serializedRuntimeResult: string,
  ): void {
    this.append(context, "completed", { serializedRuntimeResult });
  }

  recordReconciliationRequired(
    context: AutoPosterMissionLedgerContext,
    failure: AutoPosterMissionLedgerFailure,
  ): void {
    this.append(context, "reconciliation_required", { failure });
  }

  recordFailed(
    context: AutoPosterMissionLedgerContext,
    failure: AutoPosterMissionLedgerFailure,
  ): void {
    this.append(context, "failed", { failure });
  }

  private append(
    context: AutoPosterMissionLedgerContext,
    status: AgentRunLedgerStatus,
    options: {
      serializedRuntimeResult?: string;
      failure?: AutoPosterMissionLedgerFailure;
    } = {},
  ): void {
    const current = this.currentEntry(context.missionId);
    if (current?.status === status) return;

    const sequence = (current?.sequence ?? 0) + 1;
    const completed = status === "completed";
    const failed = status === "failed";
    const approved = context.approvalActor !== null && context.approvalTimestamp !== null;
    const evidence = completed && options.serializedRuntimeResult
      ? runtimeResultEvidence(
          context.missionId,
          options.serializedRuntimeResult,
          context.updatedAt,
        )
      : [];
    const validationResult = completed
      ? "passed" as const
      : failed
        ? "failed" as const
        : "not_run" as const;

    const entry = createAgentRunLedgerEntry({
      schema_version: "1.0",
      run_id: context.missionId,
      event_id: eventId(context.missionId, sequence),
      sequence,
      product_id: PRODUCT,
      workflow_id: WORKFLOW,
      agent_id: AGENT,
      attempt_id: context.attemptId,
      parent_run_id: null,
      trace_id: context.traceId,
      status,
      outcome: deriveAgentRunLedgerOutcome(status),
      started_at: context.startedAt,
      completed_at: completed || failed ? context.updatedAt : null,
      provider: context.provider,
      model: "not_applicable",
      input_summary: "Create one governed, unapproved AutoPoster schedule draft.",
      actions_taken: [{
        action_id: WORKFLOW,
        action_type: WORKFLOW,
        summary: "Operator governed one AutoPoster schedule-draft mission.",
        outcome: actionOutcome(status),
      }],
      tools_used: context.runtimeStarted
        ? [{
            tool_id: "chanter-agent-runtime:auto-poster-adapter",
            name: "CHANTER Agent Runtime AutoPoster adapter",
            version: "1.0.0",
          }]
        : [],
      latency_ms: completed || failed
        ? Date.parse(context.updatedAt) - Date.parse(context.startedAt)
        : null,
      cost_estimate: {
        kind: "not_applicable",
        amount_micros: null,
        currency: null,
      },
      approval_status: approved ? "approved" : "required",
      approval_actor: approved ? context.approvalActor : null,
      approval_timestamp: approved ? context.approvalTimestamp : null,
      risk_level: "high",
      production_impact: true,
      validation_result: validationResult,
      validation_summary: completed
        ? "Operator verified the exact provider, account, schedule, unapproved state, and publishing block before completion."
        : failed
          ? "The governed mission ended without validated completion."
          : null,
      failure_reason: failed ? options.failure?.reason ?? "The governed mission failed." : null,
      failure_code: failed ? options.failure?.code ?? "OPERATOR_MISSION_FAILED" : null,
      evidence_refs: evidence,
      evidence_count: evidence.length,
      evidence_integrity_status: completed ? "verified" : "not_present",
      created_at: current?.created_at ?? context.startedAt,
      updated_at: context.updatedAt,
      source_subsystem: SOURCE,
    });
    this.ledger.appendEntry(entry);
  }

  private currentEntry(runId: string): AgentRunLedgerEntry | null {
    try {
      return this.ledger.getRun(runId).entry;
    } catch (error) {
      if (
        error instanceof Error
        && "code" in error
        && error.code === "AGENT_RUN_LEDGER_RUN_NOT_FOUND"
      ) {
        return null;
      }
      throw error;
    }
  }
}
