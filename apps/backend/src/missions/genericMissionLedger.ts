/**
 * Phase 2C generic mission Agent Run Ledger producer.
 *
 * A copy-generalization of the accepted AutoPosterMissionLedger onto the
 * generic mission spine: one ledger run per mission (run_id = missionId),
 * ordered lifecycle transitions, runtime-result evidence on completion.
 * Every append goes through the one durable AgentRunLedgerService in the
 * same SQLite transaction as the mission mutation that caused it, so the
 * mission ⋈ ledger lineage is atomic.
 *
 * The manual-loop action is deliberately non-production-impacting:
 * provider "local", model "not_applicable", risk medium,
 * production_impact false, real-agent execution frozen.
 */
import { createHash } from "node:crypto";
import {
  createAgentRunLedgerEntry,
  deriveAgentRunLedgerOutcome,
  type AgentRunLedgerEntry,
  type AgentRunLedgerEntryDraft,
  type AgentRunLedgerStatus,
} from "chanter-agent-runtime";
import type { AgentRunLedgerService } from "../agentRunLedger/agentRunLedgerService.js";

const AGENT = "chanter-agent-runtime";
const SOURCE = "chanter-operator";

export interface GenericMissionLedgerIdentity {
  productId: string;
  workflowId: string;
  toolId: string;
  toolName: string;
  inputSummary: string;
  actionSummary: string;
  completedValidationSummary: string;
}

export interface GenericMissionLedgerContext {
  missionId: string;
  traceId: string;
  attemptId: string;
  startedAt: string;
  updatedAt: string;
  approvalActor: string | null;
  approvalTimestamp: string | null;
  runtimeStarted: boolean;
}

export interface GenericMissionLedgerFailure {
  code: string;
  reason: string;
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

export class GenericMissionLedger {
  constructor(
    private readonly ledger: AgentRunLedgerService,
    private readonly identity: GenericMissionLedgerIdentity,
  ) {}

  initialize(context: GenericMissionLedgerContext): void {
    this.append(context, "created");
    this.append(context, "approval_required");
  }

  recordApproved(context: GenericMissionLedgerContext): void {
    this.append(context, "approved");
  }

  recordRunning(context: GenericMissionLedgerContext): void {
    this.append(context, "running");
  }

  recordValidating(context: GenericMissionLedgerContext): void {
    this.append(context, "validating");
  }

  recordCompleted(
    context: GenericMissionLedgerContext,
    serializedRuntimeResult: string,
  ): void {
    this.append(context, "completed", { serializedRuntimeResult });
  }

  recordReconciliationRequired(
    context: GenericMissionLedgerContext,
    failure: GenericMissionLedgerFailure,
  ): void {
    this.append(context, "reconciliation_required", { failure });
  }

  recordFailed(
    context: GenericMissionLedgerContext,
    failure: GenericMissionLedgerFailure,
  ): void {
    this.append(context, "failed", { failure });
  }

  private append(
    context: GenericMissionLedgerContext,
    status: AgentRunLedgerStatus,
    options: {
      serializedRuntimeResult?: string;
      failure?: GenericMissionLedgerFailure;
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
      product_id: this.identity.productId,
      workflow_id: this.identity.workflowId,
      agent_id: AGENT,
      attempt_id: context.attemptId,
      parent_run_id: null,
      trace_id: context.traceId,
      status,
      outcome: deriveAgentRunLedgerOutcome(status),
      started_at: context.startedAt,
      completed_at: completed || failed ? context.updatedAt : null,
      provider: "local",
      model: "not_applicable",
      input_summary: this.identity.inputSummary,
      actions_taken: [{
        action_id: this.identity.workflowId,
        action_type: this.identity.workflowId,
        summary: this.identity.actionSummary,
        outcome: actionOutcome(status),
      }],
      tools_used: context.runtimeStarted
        ? [{
            tool_id: this.identity.toolId,
            name: this.identity.toolName,
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
      risk_level: "medium",
      production_impact: false,
      validation_result: validationResult,
      validation_summary: completed
        ? this.identity.completedValidationSummary
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
