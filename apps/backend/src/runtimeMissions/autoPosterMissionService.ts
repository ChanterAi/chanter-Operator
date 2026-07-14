import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  AUTOPOSTER_ACTIONS,
  createRuntimeMissionPayloadHash,
  type AutoPosterConnectedAccountListSuccess,
  type AutoPosterConnectedAccountView,
  type AutoPosterPortFailure,
  type AutoPosterScheduleReconciliationSuccess,
  type RuntimeMissionRequest,
  type RuntimeMissionResult,
  type RuntimeMissionStatus,
} from "chanter-agent-runtime";
import { withTransaction } from "../db/database.js";
import { OperatorError } from "../services/operatorService.js";
import type { AutoPosterRuntimeMissionExecutor } from "./autoPosterRuntime.js";
import {
  MissionExecutionJournal,
  type MissionExecutionRecord,
  type MissionExecutionState,
  type MissionJournalTransition,
  type MissionTypedError,
} from "./missionExecutionJournal.js";

const PRODUCT = "auto_poster" as const;
const ACTION = AUTOPOSTER_ACTIONS.postSchedule;
const ACTOR_ID = "chanter-operator";
const ISO_WITH_ZONE_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const SENSITIVE_QUERY_KEY_PATTERN =
  /(?:token|secret|password|credential|api[-_]?key|signature)/i;
const REDACTED_VALUE = "[REDACTED]";
const ACCOUNT_VALIDATION_ERROR_CODES = new Set([
  "unknown_account_id",
  "account_id_case_mismatch",
  "account_id_non_canonical",
  "account_workspace_mismatch",
  "provider_account_mismatch",
  "account_disconnected",
  "account_not_publishing_ready",
  "workspace_not_found",
]);

export type AutoPosterMissionStatus =
  | "approval_required"
  | "executing"
  | RuntimeMissionStatus;

export interface AutoPosterRuntimeMission {
  missionId: string;
  traceId: string;
  product: typeof PRODUCT;
  action: typeof ACTION;
  actorId: string;
  workspaceId: string;
  accountId: string;
  provider: "tiktok" | "youtube";
  mediaUrl: string;
  caption: string;
  hashtags: string;
  title: string | null;
  description: string | null;
  scheduledAt: string;
  idempotencyKey: string;
  status: AutoPosterMissionStatus;
  approvalRequired: true;
  approvedBy: string | null;
  createdAt: string;
  updatedAt: string;
  runtimeResult: RuntimeMissionResult | null;
  execution: AutoPosterMissionExecutionView | null;
  executionJournal: MissionJournalTransition[];
  evidenceSummary: AutoPosterMissionEvidenceSummary;
}

export type AutoPosterRecoveryAction = "Reconcile" | "Resume safely" | "Stop / escalate";

export interface AutoPosterMissionExecutionView {
  state: MissionExecutionState;
  executionAttemptId: string;
  missionPayloadHash: string;
  downstreamOperationType: string;
  lastConfirmedBoundary: MissionExecutionState;
  recoveryReason: string;
  recoveryClassification: string;
  reconciliationOutcome: string;
  downstreamQueueJobExists: boolean;
  authoritativeQueueId: string | null;
  retryCount: number;
  nextPermittedActions: AutoPosterRecoveryAction[];
  evidenceStatus: "pending" | "authoritative" | "failed" | "reconciliation_required";
  typedError: MissionTypedError | null;
}

export interface AutoPosterMissionEvidenceSummary {
  missionId: string;
  traceId: string;
  workspaceId: string;
  provider: "tiktok" | "youtube";
  canonicalAccountReference: string;
  policyDecision: "not_evaluated" | "allowed" | "blocked" | "approval_required";
  idempotencyOutcome: "not_applicable" | "first_execution" | "duplicate" | "mismatch";
  queueDraftId: string | null;
  persistedDraftStatus: string | null;
  operatorApprovalState: "required" | "approved";
  releaseApprovalState: "not_started" | "required";
  publishingState: "not_started" | "blocked_until_human_approval";
  currentDurableState: MissionExecutionState | "legacy_unjournaled";
  lastConfirmedBoundary: MissionExecutionState | "legacy_unjournaled";
  recoveryReason: string;
  recoveryClassification: string;
  downstreamQueueJobExists: boolean;
  authoritativeQueueId: string | null;
  nextPermittedActions: AutoPosterRecoveryAction[];
  evidenceStatus: "pending" | "authoritative" | "failed" | "reconciliation_required";
  typedError: { code: string; message: string } | null;
}

export interface AutoPosterRuntimeReadiness {
  configured: boolean;
  executionScope: "schedule_unapproved_draft_only";
  actions: [typeof ACTION];
  publishingEnabled: false;
}

interface MissionRow {
  mission_id: string;
  trace_id: string;
  product: typeof PRODUCT;
  action: typeof ACTION;
  actor_id: string;
  workspace_id: string;
  account_id: string;
  provider: "tiktok" | "youtube";
  media_url: string;
  caption: string;
  hashtags: string;
  title: string | null;
  description: string | null;
  scheduled_at: string;
  idempotency_key: string;
  status: AutoPosterMissionStatus;
  approval_required: number;
  approved_by: string | null;
  runtime_result_json: string | null;
  created_at: string;
  updated_at: string;
}

interface AutoPosterMissionServiceOptions {
  now?: () => Date;
  idFactory?: () => string;
  protectedValues?: string[];
  failureInjector?: (boundary: MissionFailureBoundary, missionId: string) => void;
}

export type MissionFailureBoundary =
  | "after_approval_persistence"
  | "after_runtime_execution_start_persistence"
  | "after_downstream_request_preparation_persistence"
  | "before_autoposter_durable_create"
  | "after_autoposter_durable_create_before_response"
  | "after_runtime_receives_queue_id_before_result_persistence"
  | "after_runtime_result_persistence"
  | "after_operator_observes_runtime_result_before_persistence"
  | "after_reconciliation_starts_before_lookup"
  | "after_reconciliation_result_before_state_persistence"
  | "during_restart_claim_recovery"
  | "during_duplicate_replay_after_completion";

function redactProtectedValues(
  value: unknown,
  protectedValues: readonly string[],
): unknown {
  if (typeof value === "string") {
    return protectedValues.reduce(
      (redacted, protectedValue) => redacted.split(protectedValue).join(REDACTED_VALUE),
      value,
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactProtectedValues(item, protectedValues));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redactProtectedValues(key, protectedValues) as string,
        redactProtectedValues(item, protectedValues),
      ]),
    );
  }
  return value;
}

function requireBoundedString(
  input: Record<string, unknown>,
  field: string,
  maxLength: number,
  allowBlank = false,
): string {
  const value = input[field];
  if (typeof value !== "string") {
    throw new OperatorError(`${field} must be a string.`, 400);
  }
  const normalized = value.trim();
  if (!allowBlank && !normalized) {
    throw new OperatorError(`${field} is required.`, 400);
  }
  if (normalized.length > maxLength) {
    throw new OperatorError(`${field} must be at most ${maxLength} characters.`, 400);
  }
  return normalized;
}

function requireOpaqueAccountId(
  input: Record<string, unknown>,
  maxLength: number,
): string {
  const value = input.accountId;
  if (typeof value !== "string") {
    throw new OperatorError("accountId must be a string.", 400, "unknown_account_id");
  }
  if (!value) {
    throw new OperatorError("accountId is required.", 400, "unknown_account_id");
  }
  if (value.length > maxLength) {
    throw new OperatorError(
      `accountId must be at most ${maxLength} characters.`,
      400,
      "account_id_non_canonical",
    );
  }
  if (value !== value.trim()) {
    throw new OperatorError(
      "accountId must match the exact canonical connected-account ID; surrounding whitespace is not normalized.",
      409,
      "account_id_non_canonical",
    );
  }
  return value;
}

function optionalBoundedString(
  input: Record<string, unknown>,
  field: string,
  maxLength: number,
): string {
  const value = input[field];
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") {
    throw new OperatorError(`${field} must be a string when provided.`, 400);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new OperatorError(`${field} must be at most ${maxLength} characters.`, 400);
  }
  return normalized;
}

function validateMediaUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new OperatorError("mediaUrl must be a valid HTTPS URL.", 400);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new OperatorError(
      "mediaUrl must be an HTTPS URL without credentials or a fragment.",
      400,
    );
  }
  for (const key of parsed.searchParams.keys()) {
    if (SENSITIVE_QUERY_KEY_PATTERN.test(key)) {
      throw new OperatorError(
        "mediaUrl must not contain credential or signature query parameters.",
        400,
      );
    }
  }
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function permittedRecoveryActions(execution: MissionExecutionRecord): AutoPosterRecoveryAction[] {
  if (execution.currentState === "approved") return ["Resume safely", "Stop / escalate"];
  if (
    execution.currentState === "execution_started" ||
    execution.currentState === "downstream_request_prepared"
  ) {
    return ["Reconcile", "Stop / escalate"];
  }
  if (execution.currentState === "downstream_result_observed") {
    return ["Resume safely"];
  }
  if (execution.currentState === "result_persisted") return ["Resume safely"];
  if (execution.currentState === "failed_recoverable") {
    return execution.reconciliationOutcome === "not_found" && execution.retryCount === 0
      ? ["Reconcile", "Resume safely", "Stop / escalate"]
      : ["Reconcile", "Stop / escalate"];
  }
  if (execution.currentState === "reconciliation_required") return ["Stop / escalate"];
  if (execution.currentState === "recovery_in_progress") return ["Reconcile"];
  return [];
}

function executionEvidenceStatus(
  execution: MissionExecutionRecord,
): AutoPosterMissionExecutionView["evidenceStatus"] {
  if (execution.currentState === "completed") return "authoritative";
  if (execution.currentState === "reconciliation_required") return "reconciliation_required";
  if (execution.currentState === "failed_terminal") return "failed";
  return "pending";
}

function executionView(execution: MissionExecutionRecord): AutoPosterMissionExecutionView {
  return {
    state: execution.currentState,
    executionAttemptId: execution.executionAttemptId,
    missionPayloadHash: execution.missionPayloadHash,
    downstreamOperationType: execution.downstreamOperationType,
    lastConfirmedBoundary: execution.lastConfirmedBoundary,
    recoveryReason: execution.recoveryReason,
    recoveryClassification: execution.recoveryClassification,
    reconciliationOutcome: execution.reconciliationOutcome,
    downstreamQueueJobExists: Boolean(execution.downstreamQueueId),
    authoritativeQueueId: execution.downstreamQueueId,
    retryCount: execution.retryCount,
    nextPermittedActions: permittedRecoveryActions(execution),
    evidenceStatus: executionEvidenceStatus(execution),
    typedError: execution.typedError,
  };
}

function buildEvidenceSummary(
  row: MissionRow,
  runtimeResult: RuntimeMissionResult | null,
  execution: MissionExecutionRecord | null,
): AutoPosterMissionEvidenceSummary {
  const output = jsonObject(runtimeResult?.output);
  const post = jsonObject(output?.post);
  const postId = post && typeof post.id === "string" ? post.id : "";
  const postScheduledAt = post && typeof post.scheduledAt === "string" ? post.scheduledAt : "";
  const verifiedQueueDraft = Boolean(
    runtimeResult &&
    (runtimeResult.status === "succeeded" || runtimeResult.status === "duplicate") &&
    post &&
    postId.trim() &&
    postId === postId.trim() &&
    post.accountId === row.account_id &&
    post.provider === row.provider &&
    post.status === "scheduled" &&
    post.approved === false &&
    postScheduledAt &&
    postScheduledAt === row.scheduled_at &&
    output?.publishing === "blocked_until_human_approval"
  );
  const queueDraftId =
    verifiedQueueDraft ? postId : null;
  const persistedDraftStatus = verifiedQueueDraft ? "scheduled" : null;
  const policyDecision = runtimeResult?.policyDecision
    ? runtimeResult.policyDecision.allowed
      ? "allowed"
      : runtimeResult.policyDecision.blocked
        ? "blocked"
        : "approval_required"
    : "not_evaluated";
  const publishingState = verifiedQueueDraft
    ? "blocked_until_human_approval"
    : "not_started";
  const firstError = runtimeResult?.errors[0];
  const durableTypedError = execution?.typedError;
  const actions = execution ? permittedRecoveryActions(execution) : [];
  const evidenceStatus = execution ? executionEvidenceStatus(execution) : "pending";

  return {
    missionId: row.mission_id,
    traceId: row.trace_id,
    workspaceId: row.workspace_id,
    provider: row.provider,
    canonicalAccountReference: `${row.provider}:${row.account_id}`,
    policyDecision,
    idempotencyOutcome: runtimeResult?.idempotency.outcome ?? "not_applicable",
    queueDraftId,
    persistedDraftStatus,
    operatorApprovalState: row.approved_by ? "approved" : "required",
    releaseApprovalState: queueDraftId ? "required" : "not_started",
    publishingState,
    currentDurableState: execution?.currentState ?? "legacy_unjournaled",
    lastConfirmedBoundary: execution?.lastConfirmedBoundary ?? "legacy_unjournaled",
    recoveryReason: execution?.recoveryReason ?? "",
    recoveryClassification: execution?.recoveryClassification ?? "NONE",
    downstreamQueueJobExists: Boolean(execution?.downstreamQueueId ?? queueDraftId),
    authoritativeQueueId: execution?.downstreamQueueId ?? queueDraftId,
    nextPermittedActions: actions,
    evidenceStatus,
    typedError: durableTypedError ?? (firstError
      ? { code: firstError.code, message: firstError.message }
      : null),
  };
}

function mapMission(
  row: MissionRow,
  execution: MissionExecutionRecord | null,
  transitions: MissionJournalTransition[],
): AutoPosterRuntimeMission {
  const runtimeResult = row.runtime_result_json
    ? (JSON.parse(row.runtime_result_json) as RuntimeMissionResult)
    : null;
  return {
    missionId: row.mission_id,
    traceId: row.trace_id,
    product: row.product,
    action: row.action,
    actorId: row.actor_id,
    workspaceId: row.workspace_id,
    accountId: row.account_id,
    provider: row.provider,
    mediaUrl: row.media_url,
    caption: row.caption,
    hashtags: row.hashtags,
    title: row.title,
    description: row.description,
    scheduledAt: row.scheduled_at,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    approvalRequired: true,
    approvedBy: row.approved_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    runtimeResult,
    execution: execution ? executionView(execution) : null,
    executionJournal: transitions,
    evidenceSummary: buildEvidenceSummary(row, runtimeResult, execution),
  };
}

function isConnectedAccountView(value: unknown): value is AutoPosterConnectedAccountView {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const account = value as Record<string, unknown>;
  const provider = account.provider;
  const accountId = account.accountId;
  return (
    (provider === "tiktok" || provider === "youtube") &&
    typeof accountId === "string" &&
    accountId.length > 0 &&
    account.connectedAccountId === `${provider}:${accountId}` &&
    typeof account.providerDisplayName === "string" &&
    typeof account.username === "string" &&
    typeof account.displayName === "string" &&
    (account.connectionStatus === "connected" ||
      account.connectionStatus === "reauthorization_required" ||
      account.connectionStatus === "disconnected") &&
    typeof account.publishingReady === "boolean" &&
    Array.isArray(account.readinessBlockers) &&
    account.readinessBlockers.every((blocker) => typeof blocker === "string") &&
    (account.lastVerifiedAt === null || typeof account.lastVerifiedAt === "string")
  );
}

function projectConnectedAccount(
  account: AutoPosterConnectedAccountView,
): AutoPosterConnectedAccountView {
  return {
    connectedAccountId: account.connectedAccountId,
    accountId: account.accountId,
    provider: account.provider,
    providerDisplayName: account.providerDisplayName,
    username: account.username,
    displayName: account.displayName,
    connectionStatus: account.connectionStatus,
    publishingReady: account.publishingReady,
    readinessBlockers: [...account.readinessBlockers],
    lastVerifiedAt: account.lastVerifiedAt,
  };
}

export class AutoPosterMissionService {
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly protectedValues: string[];
  private readonly journal: MissionExecutionJournal;
  private readonly failureInjector?: AutoPosterMissionServiceOptions["failureInjector"];

  constructor(
    private readonly database: DatabaseSync,
    private readonly executor: AutoPosterRuntimeMissionExecutor,
    options: AutoPosterMissionServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.journal = new MissionExecutionJournal(database, this.idFactory);
    this.failureInjector = options.failureInjector;
    this.protectedValues = (options.protectedValues ?? [])
      .map((value) => value.trim())
      .filter(Boolean);
  }

  private injectFailure(boundary: MissionFailureBoundary, missionId: string): void {
    this.failureInjector?.(boundary, missionId);
  }

  private assertRecoveryActionAllowed(
    execution: MissionExecutionRecord,
    action: AutoPosterRecoveryAction,
  ): void {
    if (!permittedRecoveryActions(execution).includes(action)) {
      throw new OperatorError(
        `${action} is not accepted from durable state ${execution.currentState}.`,
        409,
        "RECOVERY_ACTION_NOT_PERMITTED",
      );
    }
  }

  private assertContainsNoProtectedValue(values: string[]): void {
    if (
      this.protectedValues.some((protectedValue) =>
        values.some((value) => value.includes(protectedValue)),
      )
    ) {
      throw new OperatorError(
        "Mission input must not contain protected configuration data.",
        400,
      );
    }
  }

  private throwPortFailure(failure: AutoPosterPortFailure): never {
    const reasonCode = failure.reasonCode ?? failure.details?.reasonCode;
    const code =
      typeof reasonCode === "string" && ACCOUNT_VALIDATION_ERROR_CODES.has(reasonCode)
        ? reasonCode
        : `autoposter_${failure.code}`;
    const statusCode =
      code === "unknown_account_id" || code === "workspace_not_found"
        ? 404
        : failure.code === "unavailable"
          ? 503
          : failure.code === "unauthorized"
            ? 502
            : failure.code === "internal"
              ? 502
              : 409;
    throw new OperatorError(
      redactProtectedValues(failure.message, this.protectedValues) as string,
      statusCode,
      code,
    );
  }

  getReadiness(): AutoPosterRuntimeReadiness {
    return {
      configured: this.executor.configured,
      executionScope: "schedule_unapproved_draft_only",
      actions: [ACTION],
      publishingEnabled: false,
    };
  }

  async listConnectedAccounts(workspaceIdValue: unknown): Promise<AutoPosterConnectedAccountListSuccess> {
    const workspaceId = requireBoundedString(
      { workspaceId: workspaceIdValue },
      "workspaceId",
      160,
    );
    this.assertContainsNoProtectedValue([workspaceId]);
    const result = await this.executor.listConnectedAccounts(workspaceId);
    if (!result.ok) this.throwPortFailure(result);
    if (
      result.workspaceId !== workspaceId ||
      !Array.isArray(result.accounts) ||
      !result.accounts.every(isConnectedAccountView) ||
      result.count !== result.accounts.length
    ) {
      throw new OperatorError(
        "AutoPoster returned an invalid connected-account registry response.",
        502,
        "autoposter_account_registry_invalid",
      );
    }
    return {
      ...result,
      accounts: result.accounts.map(projectConnectedAccount),
    };
  }

  async createScheduleMission(inputValue: unknown): Promise<AutoPosterRuntimeMission> {
    if (!inputValue || typeof inputValue !== "object" || Array.isArray(inputValue)) {
      throw new OperatorError("Request body must be an object.", 400);
    }
    const input = inputValue as Record<string, unknown>;
    const workspaceId = requireBoundedString(input, "workspaceId", 160);
    const requestedAccountId = requireOpaqueAccountId(input, 256);
    const providerValue = requireBoundedString(input, "provider", 16).toLowerCase();
    if (providerValue !== "tiktok" && providerValue !== "youtube") {
      throw new OperatorError("provider must be either tiktok or youtube.", 400);
    }
    const provider = providerValue;
    const mediaUrl = requireBoundedString(input, "mediaUrl", 2_048);
    validateMediaUrl(mediaUrl);
    const caption = requireBoundedString(input, "caption", 2_200, true);
    const hashtags = requireBoundedString(input, "hashtags", 1_000, true);
    const title = optionalBoundedString(input, "title", 100);
    const description = optionalBoundedString(input, "description", 5_000);
    if (provider === "youtube" && !title) {
      throw new OperatorError("title is required when provider is youtube.", 400);
    }
    if (provider === "tiktok" && (title || description)) {
      throw new OperatorError(
        "title and description are only valid for youtube missions.",
        400,
      );
    }

    const scheduledAt = requireBoundedString(input, "scheduledAt", 64);
    if (!ISO_WITH_ZONE_PATTERN.test(scheduledAt) || Number.isNaN(Date.parse(scheduledAt))) {
      throw new OperatorError(
        "scheduledAt must be a valid ISO-8601 timestamp with an explicit timezone.",
        400,
      );
    }
    if (Date.parse(scheduledAt) <= this.now().getTime()) {
      throw new OperatorError("scheduledAt must be in the future.", 400);
    }

    this.assertContainsNoProtectedValue([
      workspaceId,
      requestedAccountId,
      provider,
      mediaUrl,
      caption,
      hashtags,
      title,
      description,
      scheduledAt,
    ]);

    const accountValidation = await this.executor.validateConnectedAccount({
      workspaceId,
      accountId: requestedAccountId,
      provider,
    });
    if (!accountValidation.ok) this.throwPortFailure(accountValidation);
    const account = accountValidation.account;
    if (
      accountValidation.workspaceId !== workspaceId ||
      !isConnectedAccountView(account) ||
      account.accountId !== requestedAccountId ||
      account.provider !== provider ||
      account.connectionStatus !== "connected" ||
      account.publishingReady !== true
    ) {
      throw new OperatorError(
        "AutoPoster did not confirm the exact publishing-ready connected account.",
        409,
        "autoposter_account_validation_invalid",
      );
    }
    const accountId = account.accountId;

    const missionId = this.idFactory();
    const traceId = this.idFactory();
    const idempotencyKey = `operator-autoposter:${missionId}`;
    const executionAttemptId = this.idFactory();
    const timestamp = this.now().toISOString();
    const normalizedScheduledAt = new Date(scheduledAt).toISOString();
    const missionPayloadHash = createRuntimeMissionPayloadHash({
      missionId,
      traceId,
      product: PRODUCT,
      action: ACTION,
      actor: { id: ACTOR_ID, kind: "service" },
      tenant: {
        userId: this.executor.tenantUserId,
        workspaceId,
        accountId,
      },
      input: {
        accountId,
        provider,
        mediaUrl,
        caption,
        hashtags,
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        scheduledAt: normalizedScheduledAt,
      },
      idempotencyKey,
    });

    withTransaction(this.database, () => {
      this.database
        .prepare(
          `INSERT INTO autoposter_runtime_missions (
            mission_id, trace_id, product, action, actor_id, workspace_id,
            account_id, provider, media_url, caption, hashtags, title,
            description, scheduled_at, idempotency_key, status,
            approval_required, approved_by, runtime_result_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approval_required', 1, NULL, NULL, ?, ?)`,
        )
        .run(
          missionId,
          traceId,
          PRODUCT,
          ACTION,
          ACTOR_ID,
          workspaceId,
          accountId,
          provider,
          mediaUrl,
          caption,
          hashtags,
          title || null,
          description || null,
          normalizedScheduledAt,
          idempotencyKey,
          timestamp,
          timestamp,
        );
      this.journal.initialize({
        missionId,
        executionAttemptId,
        missionPayloadHash,
        timestamp,
        actor: ACTOR_ID,
      });
    });

    return this.getMission(missionId);
  }

  listMissions(limit = 50): AutoPosterRuntimeMission[] {
    const boundedLimit = Math.max(1, Math.min(Number.isFinite(limit) ? Math.trunc(limit) : 50, 100));
    return this.database
      .prepare(
        "SELECT * FROM autoposter_runtime_missions ORDER BY created_at DESC, mission_id DESC LIMIT ?",
      )
      .all(boundedLimit)
      .map((row) => {
        const missionRow = row as unknown as MissionRow;
        const execution = this.journal.getExecution(missionRow.mission_id);
        const transitions = execution
          ? this.journal.listTransitions(missionRow.mission_id)
          : [];
        return mapMission(missionRow, execution, transitions);
      });
  }

  getMission(missionId: string): AutoPosterRuntimeMission {
    const normalizedId = String(missionId || "").trim();
    const row = this.database
      .prepare("SELECT * FROM autoposter_runtime_missions WHERE mission_id = ?")
      .get(normalizedId) as MissionRow | undefined;
    if (!row) {
      throw new OperatorError("Runtime mission was not found.", 404);
    }
    const execution = this.journal.getExecution(row.mission_id);
    const transitions = execution ? this.journal.listTransitions(row.mission_id) : [];
    return mapMission(row, execution, transitions);
  }

  private buildRuntimeRequest(
    mission: AutoPosterRuntimeMission,
    approvedBy: string,
  ): RuntimeMissionRequest {
    return {
      missionId: mission.missionId,
      traceId: mission.traceId,
      product: PRODUCT,
      action: ACTION,
      actor: { id: mission.actorId, kind: "service" },
      tenant: {
        userId: this.executor.tenantUserId,
        workspaceId: mission.workspaceId,
        accountId: mission.accountId,
      },
      input: {
        accountId: mission.accountId,
        provider: mission.provider,
        mediaUrl: mission.mediaUrl,
        caption: mission.caption,
        hashtags: mission.hashtags,
        ...(mission.title ? { title: mission.title } : {}),
        ...(mission.description ? { description: mission.description } : {}),
        scheduledAt: mission.scheduledAt,
      },
      approval: { approved: true, approvedBy },
      idempotencyKey: mission.idempotencyKey,
      requestedAt: mission.createdAt,
      policyContext: {
        reason: "Founder approved creation of one unapproved AutoPoster queue draft.",
      },
    };
  }

  private executorFailure(
    mission: AutoPosterRuntimeMission,
    approvedBy: string,
  ): RuntimeMissionResult {
    const completedAt = this.now().toISOString();
    return {
      missionId: mission.missionId,
      traceId: mission.traceId,
      product: PRODUCT,
      action: ACTION,
      status: "failed",
      output: null,
      evidence: null,
      warnings: [],
      errors: [{
        code: "OPERATOR_RUNTIME_EXECUTOR_FAILED",
        message: "The Operator runtime mission executor failed safely.",
      }],
      policyDecision: null,
      approvalDecision: { required: true, approved: true, approvedBy },
      idempotency: { key: mission.idempotencyKey, outcome: "not_applicable" },
      startedAt: mission.updatedAt,
      completedAt,
      durationMs: 0,
    };
  }

  private normalizeRuntimeResult(runtimeResult: RuntimeMissionResult): RuntimeMissionResult {
    const redacted = redactProtectedValues(
      runtimeResult,
      this.protectedValues,
    ) as RuntimeMissionResult;
    JSON.parse(JSON.stringify(redacted));
    return redacted;
  }

  private verifiedQueueId(
    mission: AutoPosterRuntimeMission,
    runtimeResult: RuntimeMissionResult,
  ): string | null {
    const output = jsonObject(runtimeResult.output);
    const post = jsonObject(output?.post);
    const postId = typeof post?.id === "string" ? post.id : "";
    const scheduledAt = typeof post?.scheduledAt === "string" ? post.scheduledAt : "";
    return (
      (runtimeResult.status === "succeeded" || runtimeResult.status === "duplicate") &&
      postId &&
      postId === postId.trim() &&
      post?.accountId === mission.accountId &&
      post?.provider === mission.provider &&
      post?.status === "scheduled" &&
      post?.approved === false &&
      scheduledAt &&
      scheduledAt === mission.scheduledAt &&
      output?.publishing === "blocked_until_human_approval"
    ) ? postId : null;
  }

  private assertCompletedReplayBinding(
    mission: AutoPosterRuntimeMission,
    replayApprovedBy: string,
  ): void {
    const execution = this.journal.requireExecution(mission.missionId);
    const runtimeResult = mission.runtimeResult;
    const mismatch = (code: string, message: string): never => {
      throw new OperatorError(message, 409, code);
    };
    if (!runtimeResult) {
      throw new OperatorError(
        "The mission has no authoritative completed result to replay.",
        409,
        "OPERATOR_COMPLETED_REPLAY_STATE_MISMATCH",
      );
    }
    if (execution.currentState !== "completed") {
      mismatch("OPERATOR_COMPLETED_REPLAY_STATE_MISMATCH", "The mission durable execution is not completed.");
    }
    const durableApprovedBy = mission.approvedBy;
    if (!durableApprovedBy || durableApprovedBy !== replayApprovedBy) {
      throw new OperatorError(
        "Replay approval identity does not match the durable approval binding.",
        409,
        "OPERATOR_APPROVAL_BINDING_MISMATCH",
      );
    }
    const request = this.buildRuntimeRequest(mission, durableApprovedBy);
    if (createRuntimeMissionPayloadHash(request) !== execution.missionPayloadHash) {
      mismatch("OPERATOR_PAYLOAD_MISMATCH", "The completed mission payload no longer matches its durable payload hash.");
    }
    if (runtimeResult.missionId !== mission.missionId || runtimeResult.action !== mission.action) {
      mismatch("OPERATOR_REPLAY_SCOPE_MISMATCH", "The Runtime result mission/action binding does not match Operator truth.");
    }
    if (
      runtimeResult.idempotency.key !== mission.idempotencyKey
      || runtimeResult.idempotency.outcome === "mismatch"
    ) {
      mismatch("OPERATOR_IDEMPOTENCY_MISMATCH", "The Runtime result idempotency binding does not match Operator truth.");
    }
    if (
      runtimeResult.approvalDecision.required !== true
      || runtimeResult.approvalDecision.approved !== true
      || runtimeResult.approvalDecision.approvedBy !== durableApprovedBy
    ) {
      mismatch("OPERATOR_APPROVAL_BINDING_MISMATCH", "The Runtime approval decision does not match the durable human approval.");
    }
    if (
      execution.finalResultStatus !== runtimeResult.status
      || JSON.stringify(execution.runtimeObservation) !== JSON.stringify(runtimeResult)
    ) {
      mismatch("OPERATOR_RUNTIME_RESULT_BINDING_MISMATCH", "The completed Runtime result is not the result observed by its durable execution attempt.");
    }
    const queueId = this.verifiedQueueId(mission, runtimeResult);
    if (!queueId || queueId !== execution.downstreamQueueId) {
      mismatch("OPERATOR_EVIDENCE_BINDING_MISMATCH", "The completed queue evidence does not match the authoritative downstream result.");
    }
    const transitions = mission.executionJournal;
    if (transitions.some((transition) =>
      transition.missionId !== mission.missionId
      || transition.action !== mission.action
      || transition.workspaceId !== mission.workspaceId
      || transition.provider !== mission.provider
      || transition.accountId !== mission.accountId
      || transition.idempotencyKey !== mission.idempotencyKey
    )) {
      mismatch("OPERATOR_JOURNAL_BINDING_MISMATCH", "A durable journal transition belongs to a different exact mission scope.");
    }
    const resultTransition = [...transitions].reverse().find((transition) => transition.newState === "result_persisted");
    const completedTransition = [...transitions].reverse().find((transition) => transition.newState === "completed");
    const attemptTransition = resultTransition && transitions.find((transition) =>
      transition.executionAttemptId === resultTransition.executionAttemptId
      && transition.sequence < resultTransition.sequence
      && ["execution_started", "downstream_request_prepared", "recovery_in_progress"].includes(transition.newState)
    );
    if (
      !resultTransition
      || !completedTransition
      || !attemptTransition
      || completedTransition.sequence <= resultTransition.sequence
      || resultTransition.executionAttemptId !== execution.executionAttemptId
    ) {
      mismatch("OPERATOR_RUNTIME_ATTEMPT_BINDING_MISMATCH", "The durable Runtime attempt/result/completion relationship is incomplete or contradictory.");
    }
  }

  private persistObservedRuntimeResult(
    missionId: string,
    runtimeResult: RuntimeMissionResult,
    recoveryClassification?: string,
  ): AutoPosterRuntimeMission {
    const serializedResult = JSON.stringify(runtimeResult);
    const persistedAt = this.now().toISOString();
    withTransaction(this.database, () => {
      const result = this.database.prepare(
        `UPDATE autoposter_runtime_missions
           SET status = ?, runtime_result_json = ?, updated_at = ?
         WHERE mission_id = ? AND status = 'executing' AND runtime_result_json IS NULL`,
      ).run(runtimeResult.status, serializedResult, persistedAt, missionId);
      if (Number(result.changes) !== 1) {
        throw new OperatorError(
          "Runtime mission result could not be saved without overwriting newer state.",
          409,
        );
      }
      this.journal.transition(missionId, "result_persisted", {
        actor: ACTOR_ID,
        reason: "The redacted Runtime result was durably persisted by Operator.",
        timestamp: persistedAt,
        lastConfirmedBoundary: "result_persisted",
        finalResultStatus: runtimeResult.status,
        recoveryClassification,
        evidenceReferences: [`runtime-result:${missionId}`],
      });
    });
    const completedAt = this.now().toISOString();
    withTransaction(this.database, () => {
      this.journal.transition(missionId, "completed", {
        actor: ACTOR_ID,
        reason: "Mission completed only after the authoritative result was persisted.",
        timestamp: completedAt,
        lastConfirmedBoundary: "completed",
        recoveryClassification,
        typedError: null,
        evidenceReferences: [`mission:${missionId}`, `runtime-result:${missionId}`],
      });
    });
    return this.getMission(missionId);
  }

  private prepareLegacyMissionRowForRecovery(missionId: string, timestamp: string): void {
    const result = this.database.prepare(
      `UPDATE autoposter_runtime_missions
         SET status = 'executing', runtime_result_json = NULL, updated_at = ?
       WHERE mission_id = ? AND approved_by IS NOT NULL`,
    ).run(timestamp, missionId);
    if (Number(result.changes) !== 1) {
      throw new OperatorError(
        "The approved mission row could not be claimed for recovery.",
        409,
        "RECOVERY_RECONCILIATION_REQUIRED",
      );
    }
  }

  private persistRuntimeOutcome(
    mission: AutoPosterRuntimeMission,
    runtimeResultValue: RuntimeMissionResult,
    recoveryClassification?: string,
  ): AutoPosterRuntimeMission {
    const runtimeResult = this.normalizeRuntimeResult(runtimeResultValue);
    const queueId = this.verifiedQueueId(mission, runtimeResult);
    if (queueId) {
      const observedAt = this.now().toISOString();
      withTransaction(this.database, () => {
        this.journal.transition(mission.missionId, "downstream_result_observed", {
          actor: "chanter-agent-runtime",
          reason: "Runtime observed one exact unapproved AutoPoster queue result.",
          timestamp: observedAt,
          lastConfirmedBoundary: "downstream_result_observed",
          downstreamQueueId: queueId,
          runtimeObservation: runtimeResult,
          recoveryClassification,
          typedError: null,
          evidenceReferences: [`autoposter-queue:${queueId}`, `runtime-result:${mission.missionId}`],
        });
      });
      this.injectFailure("after_operator_observes_runtime_result_before_persistence", mission.missionId);
      return this.persistObservedRuntimeResult(
        mission.missionId,
        runtimeResult,
        recoveryClassification,
      );
    }

    const firstError = runtimeResult.errors[0] ?? {
      code: "RECOVERY_EVIDENCE_INVALID",
      message: "Runtime did not return authoritative queue evidence.",
    };
    const typedError = { code: firstError.code, message: firstError.message };
    const recoverable = runtimeResult.status === "unavailable" || runtimeResult.status === "failed";
    const failedState = recoverable ? "failed_recoverable" : "failed_terminal";
    const failedAt = this.now().toISOString();
    withTransaction(this.database, () => {
      const serializedResult = JSON.stringify(runtimeResult);
      const result = this.database.prepare(
        `UPDATE autoposter_runtime_missions
           SET status = ?, runtime_result_json = ?, updated_at = ?
         WHERE mission_id = ? AND status = 'executing'`,
      ).run(runtimeResult.status, serializedResult, failedAt, mission.missionId);
      if (Number(result.changes) !== 1) {
        throw new OperatorError("Runtime mission failure could not be saved safely.", 409);
      }
      const current = this.journal.requireExecution(mission.missionId);
      this.journal.transition(mission.missionId, failedState, {
        actor: "chanter-agent-runtime",
        reason: recoverable
          ? "Runtime could not prove whether the downstream boundary completed; reconciliation is required before retry."
          : "Runtime returned a terminal typed refusal before authoritative completion.",
        timestamp: failedAt,
        lastConfirmedBoundary: current.lastConfirmedBoundary,
        recoveryReason: typedError.message,
        recoveryClassification: recoveryClassification ?? (recoverable
          ? "RECOVERY_DOWNSTREAM_UNAVAILABLE"
          : "RECOVERY_EVIDENCE_INVALID"),
        finalResultStatus: runtimeResult.status,
        runtimeObservation: runtimeResult,
        typedError,
        evidenceReferences: [`runtime-result:${mission.missionId}`],
      });
    });
    return this.getMission(mission.missionId);
  }

  private async executePreparedMission(
    mission: AutoPosterRuntimeMission,
    request: RuntimeMissionRequest,
    recovered?: AutoPosterScheduleReconciliationSuccess,
    recoveryClassification?: string,
  ): Promise<AutoPosterRuntimeMission> {
    const execution = this.journal.requireExecution(mission.missionId);
    if (createRuntimeMissionPayloadHash(request) !== execution.missionPayloadHash) {
      throw new OperatorError(
        "The reconstructed mission payload does not match the durable payload hash.",
        409,
        "RECOVERY_SCOPE_MISMATCH",
      );
    }
    let runtimeResult: RuntimeMissionResult;
    try {
      runtimeResult = recovered
        ? await this.executor.executeRecovered(request, recovered)
        : await this.executor.execute(request);
    } catch {
      runtimeResult = this.executorFailure(mission, request.approval?.approvedBy ?? "unknown");
    }
    return this.persistRuntimeOutcome(mission, runtimeResult, recoveryClassification);
  }

  async approveAndExecute(
    missionId: string,
    approvedByValue: unknown,
  ): Promise<AutoPosterRuntimeMission> {
    const approvedBy = typeof approvedByValue === "string" ? approvedByValue.trim() : "";
    if (!approvedBy) throw new OperatorError("approvedBy is required.", 400);
    if (approvedBy.length > 120) {
      throw new OperatorError("approvedBy must be at most 120 characters.", 400);
    }
    this.assertContainsNoProtectedValue([approvedBy]);

    const current = this.getMission(missionId);
    if (current.runtimeResult && current.execution?.state === "completed") {
      this.assertCompletedReplayBinding(current, approvedBy);
      withTransaction(this.database, () => {
        this.journal.transition(current.missionId, "completed", {
          actor: ACTOR_ID,
          reason: "Exact durable replay returned the existing authoritative result without execution.",
          timestamp: this.now().toISOString(),
          lastConfirmedBoundary: "completed",
          recoveryClassification: "DURABLE_REPLAY",
          evidenceReferences: [
            `mission:${current.missionId}`,
            ...(current.execution?.authoritativeQueueId
              ? [`autoposter-queue:${current.execution.authoritativeQueueId}`]
              : []),
          ],
        });
      });
      this.injectFailure("during_duplicate_replay_after_completion", current.missionId);
      return this.getMission(current.missionId);
    }
    if (current.status === "executing") {
      throw new OperatorError(
        "Runtime mission is interrupted or already active; use Reconcile before any retry.",
        409,
        "RECOVERY_RECONCILIATION_REQUIRED",
      );
    }
    if (current.status !== "approval_required" || current.execution?.state !== "approval_required") {
      throw new OperatorError(`Runtime mission cannot execute from status ${current.status}.`, 409);
    }

    const approvedAt = this.now().toISOString();
    withTransaction(this.database, () => {
      const result = this.database.prepare(
        `UPDATE autoposter_runtime_missions
           SET status = 'executing', approved_by = ?, updated_at = ?
         WHERE mission_id = ? AND status = 'approval_required' AND runtime_result_json IS NULL`,
      ).run(approvedBy, approvedAt, current.missionId);
      if (Number(result.changes) !== 1) {
        throw new OperatorError("Runtime mission state changed before approval could be saved.", 409);
      }
      this.journal.transition(current.missionId, "approved", {
        actor: approvedBy,
        reason: "Founder approval was durably persisted before execution.",
        timestamp: approvedAt,
        lastConfirmedBoundary: "approved",
        evidenceReferences: [`approval:${approvedBy}`],
      });
    });
    this.injectFailure("after_approval_persistence", current.missionId);

    const startedAt = this.now().toISOString();
    withTransaction(this.database, () => {
      this.journal.transition(current.missionId, "execution_started", {
        actor: "chanter-agent-runtime",
        reason: "Runtime execution attempt began under the persisted approval.",
        timestamp: startedAt,
        lastConfirmedBoundary: "execution_started",
        evidenceReferences: [`attempt:${current.execution!.executionAttemptId}`],
      });
    });
    this.injectFailure("after_runtime_execution_start_persistence", current.missionId);

    const preparedAt = this.now().toISOString();
    withTransaction(this.database, () => {
      this.journal.transition(current.missionId, "downstream_request_prepared", {
        actor: "chanter-agent-runtime",
        reason: "Exact AutoPoster request scope and payload hash were durably prepared.",
        timestamp: preparedAt,
        lastConfirmedBoundary: "downstream_request_prepared",
        evidenceReferences: [`payload-sha256:${current.execution!.missionPayloadHash}`],
      });
    });
    this.injectFailure("after_downstream_request_preparation_persistence", current.missionId);

    const mission = this.getMission(current.missionId);
    return this.executePreparedMission(
      mission,
      this.buildRuntimeRequest(mission, approvedBy),
    );
  }

  async reconcileMission(missionId: string): Promise<AutoPosterRuntimeMission> {
    const mission = this.getMission(missionId);
    const execution = this.journal.requireExecution(mission.missionId);
    this.assertRecoveryActionAllowed(execution, "Reconcile");
    if (!mission.approvedBy) {
      throw new OperatorError("Mission approval is missing; recovery cannot bypass approval.", 409);
    }
    const attemptId = this.idFactory();
    withTransaction(this.database, () => {
      let currentExecution = this.journal.requireExecution(mission.missionId);
      if (currentExecution.currentState !== "failed_recoverable") {
        currentExecution = this.journal.transition(mission.missionId, "failed_recoverable", {
          actor: ACTOR_ID,
          reason: "A restarted process detected an uncertain downstream execution boundary.",
          timestamp: this.now().toISOString(),
          lastConfirmedBoundary: currentExecution.lastConfirmedBoundary,
          recoveryReason: "Process interruption requires exact downstream reconciliation.",
          recoveryClassification: "INTERRUPTED_EXECUTION_DETECTED",
          typedError: {
            code: "RECOVERY_INTERRUPTED_EXECUTION",
            message: "Execution was interrupted before Operator persisted an authoritative result.",
          },
        });
      }
      this.journal.transition(mission.missionId, "recovery_in_progress", {
        actor: ACTOR_ID,
        reason: "Operator claimed one bounded read-only reconciliation attempt.",
        timestamp: this.now().toISOString(),
        executionAttemptId: attemptId,
        lastConfirmedBoundary: currentExecution.lastConfirmedBoundary,
        typedError: null,
      });
    });
    this.injectFailure("during_restart_claim_recovery", mission.missionId);

    const request = this.buildRuntimeRequest(mission, mission.approvedBy);
    if (createRuntimeMissionPayloadHash(request) !== execution.missionPayloadHash) {
      throw new OperatorError("Recovery request does not match the durable payload hash.", 409, "RECOVERY_SCOPE_MISMATCH");
    }
    this.injectFailure("after_reconciliation_starts_before_lookup", mission.missionId);
    const result = await this.executor.reconcileSchedule(request);
    this.injectFailure("after_reconciliation_result_before_state_persistence", mission.missionId);
    const reconciledAt = this.now().toISOString();

    if (!result.ok) {
      const reasonCode = result.reasonCode ?? result.details?.reasonCode;
      const scopeMismatch = reasonCode === "recovery_scope_mismatch";
      const unavailable = result.code === "unavailable";
      const typedError: MissionTypedError = {
        code: scopeMismatch
          ? "RECOVERY_SCOPE_MISMATCH"
          : unavailable
            ? "RECOVERY_DOWNSTREAM_UNAVAILABLE"
            : "RECOVERY_EVIDENCE_INVALID",
        message: result.message,
      };
      withTransaction(this.database, () => {
        const currentExecution = this.journal.requireExecution(mission.missionId);
        this.journal.transition(
          mission.missionId,
          unavailable ? "failed_recoverable" : "failed_terminal",
          {
            actor: ACTOR_ID,
            reason: typedError.message,
            timestamp: reconciledAt,
            lastConfirmedBoundary: currentExecution.lastConfirmedBoundary,
            recoveryReason: typedError.message,
            recoveryClassification: typedError.code,
            reconciliationOutcome: scopeMismatch
              ? "scope_mismatch"
              : unavailable
                ? "unavailable"
                : "invalid",
            typedError,
          },
        );
      });
      return this.getMission(mission.missionId);
    }

    if (
      result.outcome === "scope_mismatch"
      || result.outcome === "idempotency_mismatch"
      || result.outcome === "payload_mismatch"
    ) {
      const typedError: MissionTypedError = {
        code: result.outcome === "idempotency_mismatch"
          ? "RECOVERY_IDEMPOTENCY_MISMATCH"
          : result.outcome === "payload_mismatch"
            ? "RECOVERY_PAYLOAD_MISMATCH"
            : "RECOVERY_SCOPE_MISMATCH",
        message: `AutoPoster durable truth reported ${result.outcome} for this mission binding.`,
      };
      withTransaction(this.database, () => {
        const currentExecution = this.journal.requireExecution(mission.missionId);
        this.journal.transition(mission.missionId, "failed_terminal", {
          actor: ACTOR_ID,
          reason: typedError.message,
          timestamp: reconciledAt,
          lastConfirmedBoundary: currentExecution.lastConfirmedBoundary,
          recoveryReason: typedError.message,
          recoveryClassification: typedError.code,
          reconciliationOutcome: result.outcome,
          reconciliationResult: result,
          runtimeObservation: null,
          typedError,
          evidenceReferences: [],
        });
      });
      return this.getMission(mission.missionId);
    }

    if (result.outcome === "conflict") {
      const typedError = {
        code: "RECONCILIATION_REQUIRED",
        message: `AutoPoster reported ${result.count} conflicting records for one exact recovery scope.`,
      };
      withTransaction(this.database, () => {
        const currentExecution = this.journal.requireExecution(mission.missionId);
        this.journal.transition(mission.missionId, "reconciliation_required", {
          actor: ACTOR_ID,
          reason: typedError.message,
          timestamp: reconciledAt,
          lastConfirmedBoundary: currentExecution.lastConfirmedBoundary,
          recoveryReason: typedError.message,
          recoveryClassification: "RECONCILIATION_REQUIRED",
          reconciliationOutcome: "conflict",
          reconciliationResult: result,
          typedError,
          evidenceReferences: (result.conflictingPostIds ?? []).map((id) => `autoposter-conflict:${id}`),
        });
      });
      return this.getMission(mission.missionId);
    }

    if (result.outcome === "unique" && result.safeToReuse && result.post) {
      withTransaction(this.database, () => {
        this.journal.transition(mission.missionId, "downstream_result_observed", {
          actor: ACTOR_ID,
          reason: "AutoPoster confirmed one exact reusable queue result after restart.",
          timestamp: reconciledAt,
          lastConfirmedBoundary: "downstream_result_observed",
          recoveryReason: "The existing downstream queue draft was recovered exactly.",
          recoveryClassification: "RECOVERED_EXISTING_DOWNSTREAM_RESULT",
          reconciliationOutcome: "unique",
          downstreamQueueId: result.post!.id,
          reconciliationResult: result,
          runtimeObservation: null,
          typedError: null,
          evidenceReferences: [`autoposter-queue:${result.post!.id}`],
        });
      });
      return this.getMission(mission.missionId);
    }

    if (result.outcome === "not_found") {
      withTransaction(this.database, () => {
        const currentExecution = this.journal.requireExecution(mission.missionId);
        this.journal.transition(mission.missionId, "failed_recoverable", {
          actor: ACTOR_ID,
          reason: "AutoPoster confirmed that no downstream queue record exists for the exact scope.",
          timestamp: reconciledAt,
          lastConfirmedBoundary: currentExecution.lastConfirmedBoundary,
          recoveryReason: "No downstream result exists; one bounded safe retry is permitted.",
          recoveryClassification: "SAFE_RETRY_AVAILABLE",
          reconciliationOutcome: "not_found",
          reconciliationResult: result,
          runtimeObservation: null,
          typedError: null,
        });
      });
      return this.getMission(mission.missionId);
    }

    const typedError = {
      code: "RECOVERY_EVIDENCE_INVALID",
      message: "AutoPoster found one record but did not mark its evidence safe to reuse.",
    };
    withTransaction(this.database, () => {
      const currentExecution = this.journal.requireExecution(mission.missionId);
      this.journal.transition(mission.missionId, "failed_terminal", {
        actor: ACTOR_ID,
        reason: typedError.message,
        timestamp: reconciledAt,
        lastConfirmedBoundary: currentExecution.lastConfirmedBoundary,
        recoveryReason: typedError.message,
        recoveryClassification: typedError.code,
        reconciliationOutcome: "invalid",
        reconciliationResult: result,
        typedError,
      });
    });
    return this.getMission(mission.missionId);
  }

  async resumeSafely(missionId: string): Promise<AutoPosterRuntimeMission> {
    const mission = this.getMission(missionId);
    const execution = this.journal.requireExecution(mission.missionId);
    this.assertRecoveryActionAllowed(execution, "Resume safely");
    if (!mission.approvedBy) {
      throw new OperatorError("Mission approval is missing; recovery cannot bypass approval.", 409);
    }

    if (execution.currentState === "result_persisted") {
      withTransaction(this.database, () => {
        this.journal.transition(mission.missionId, "completed", {
          actor: ACTOR_ID,
          reason: "Restart completed the mission from its already-persisted Operator result.",
          timestamp: this.now().toISOString(),
          lastConfirmedBoundary: "completed",
          recoveryClassification: "RECOVERED_OPERATOR_RESULT",
        });
      });
      return this.getMission(mission.missionId);
    }

    if (
      execution.currentState === "downstream_result_observed" &&
      execution.runtimeObservation
    ) {
      withTransaction(this.database, () => {
        const currentExecution = this.journal.requireExecution(mission.missionId);
        if (currentExecution.currentState !== "downstream_result_observed" || !currentExecution.runtimeObservation) {
          throw new OperatorError("The observed Runtime result was already claimed by another recovery process.", 409, "MISSION_JOURNAL_CONCURRENT_TRANSITION");
        }
        this.prepareLegacyMissionRowForRecovery(mission.missionId, this.now().toISOString());
      });
      return this.persistObservedRuntimeResult(
        mission.missionId,
        execution.runtimeObservation as RuntimeMissionResult,
        "RECOVERED_RUNTIME_RESULT",
      );
    }

    const request = this.buildRuntimeRequest(mission, mission.approvedBy);
    const attemptId = this.idFactory();
    if (execution.currentState === "approved") {
      withTransaction(this.database, () => {
        if (this.journal.requireExecution(mission.missionId).currentState !== "approved") {
          throw new OperatorError("The approved mission was already claimed by another recovery process.", 409, "MISSION_JOURNAL_CONCURRENT_TRANSITION");
        }
        this.prepareLegacyMissionRowForRecovery(mission.missionId, this.now().toISOString());
        this.journal.transition(mission.missionId, "execution_started", {
          actor: "chanter-agent-runtime",
          reason: "Restart resumed an approved mission before any downstream request was prepared.",
          timestamp: this.now().toISOString(),
          executionAttemptId: attemptId,
          lastConfirmedBoundary: "execution_started",
          recoveryClassification: "RESUMED_BEFORE_DOWNSTREAM",
        });
        this.journal.transition(mission.missionId, "downstream_request_prepared", {
          actor: "chanter-agent-runtime",
          reason: "The resumed execution durably prepared the exact downstream request.",
          timestamp: this.now().toISOString(),
          lastConfirmedBoundary: "downstream_request_prepared",
        });
      });
      return this.executePreparedMission(
        this.getMission(mission.missionId),
        request,
        undefined,
        "RESUMED_BEFORE_DOWNSTREAM",
      );
    }

    if (
      execution.currentState === "downstream_result_observed" &&
      execution.reconciliationOutcome === "unique"
    ) {
      const reconciliation = execution.reconciliationResult as AutoPosterScheduleReconciliationSuccess | null;
      if (!reconciliation?.safeToReuse || !reconciliation.post) {
        throw new OperatorError("Recovered queue evidence is unavailable or invalid.", 409, "RECOVERY_EVIDENCE_INVALID");
      }
      withTransaction(this.database, () => {
        const currentExecution = this.journal.requireExecution(mission.missionId);
        if (
          currentExecution.currentState !== "downstream_result_observed"
          || currentExecution.reconciliationOutcome !== "unique"
        ) {
          throw new OperatorError("The reconciled queue result was already claimed by another recovery process.", 409, "MISSION_JOURNAL_CONCURRENT_TRANSITION");
        }
        this.prepareLegacyMissionRowForRecovery(mission.missionId, this.now().toISOString());
        this.journal.transition(mission.missionId, "recovery_in_progress", {
          actor: ACTOR_ID,
          reason: "Operator is attaching the previously reconciled queue result without creating another job.",
          timestamp: this.now().toISOString(),
          executionAttemptId: attemptId,
          lastConfirmedBoundary: "downstream_result_observed",
        });
      });
      return this.executePreparedMission(
        this.getMission(mission.missionId),
        request,
        reconciliation,
        "RECOVERED_EXISTING_DOWNSTREAM_RESULT",
      );
    }

    if (
      execution.currentState === "failed_recoverable" &&
      execution.reconciliationOutcome === "not_found" &&
      execution.retryCount === 0
    ) {
      withTransaction(this.database, () => {
        const currentExecution = this.journal.requireExecution(mission.missionId);
        if (
          currentExecution.currentState !== "failed_recoverable"
          || currentExecution.reconciliationOutcome !== "not_found"
          || currentExecution.retryCount !== 0
        ) {
          throw new OperatorError("The single safe retry was already claimed by another recovery process.", 409, "MISSION_JOURNAL_CONCURRENT_TRANSITION");
        }
        this.prepareLegacyMissionRowForRecovery(mission.missionId, this.now().toISOString());
        this.journal.transition(mission.missionId, "recovery_in_progress", {
          actor: ACTOR_ID,
          reason: "Operator claimed the single permitted safe retry after exact not-found reconciliation.",
          timestamp: this.now().toISOString(),
          executionAttemptId: attemptId,
          lastConfirmedBoundary: execution.lastConfirmedBoundary,
          retryCount: 1,
          recoveryClassification: "SAFE_RETRY_IN_PROGRESS",
          typedError: null,
        });
        this.journal.transition(mission.missionId, "downstream_request_prepared", {
          actor: "chanter-agent-runtime",
          reason: "The single safe retry durably prepared the exact original downstream request.",
          timestamp: this.now().toISOString(),
          lastConfirmedBoundary: "downstream_request_prepared",
          recoveryClassification: "SAFE_RETRY_IN_PROGRESS",
          evidenceReferences: [`payload-sha256:${execution.missionPayloadHash}`],
        });
      });
      return this.executePreparedMission(
        this.getMission(mission.missionId),
        request,
        undefined,
        "SAFE_RETRY_COMPLETED",
      );
    }

    throw new OperatorError(
      `Mission cannot resume safely from durable state ${execution.currentState} without a valid reconciliation decision.`,
      409,
      "RECOVERY_RECONCILIATION_REQUIRED",
    );
  }

  stopAndEscalate(missionId: string): AutoPosterRuntimeMission {
    const mission = this.getMission(missionId);
    const execution = this.journal.requireExecution(mission.missionId);
    this.assertRecoveryActionAllowed(execution, "Stop / escalate");
    const stoppedAt = this.now().toISOString();
    const typedError = {
      code: "RECOVERY_STOPPED_FOR_ESCALATION",
      message: "A human stopped automatic recovery and escalated the mission.",
    };
    withTransaction(this.database, () => {
      this.database.prepare(
        `UPDATE autoposter_runtime_missions SET status = 'failed', updated_at = ? WHERE mission_id = ?`,
      ).run(stoppedAt, mission.missionId);
      this.journal.transition(mission.missionId, "failed_terminal", {
        actor: ACTOR_ID,
        reason: typedError.message,
        timestamp: stoppedAt,
        lastConfirmedBoundary: execution.lastConfirmedBoundary,
        recoveryReason: typedError.message,
        recoveryClassification: "STOPPED_FOR_ESCALATION",
        typedError,
      });
    });
    return this.getMission(mission.missionId);
  }
}
