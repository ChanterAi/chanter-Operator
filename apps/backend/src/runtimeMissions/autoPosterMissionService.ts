import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  AUTOPOSTER_ACTIONS,
  type AutoPosterConnectedAccountListSuccess,
  type AutoPosterConnectedAccountView,
  type AutoPosterPortFailure,
  type RuntimeMissionRequest,
  type RuntimeMissionResult,
  type RuntimeMissionStatus,
} from "chanter-agent-runtime";
import { withTransaction } from "../db/database.js";
import { OperatorError } from "../services/operatorService.js";
import type { AutoPosterRuntimeMissionExecutor } from "./autoPosterRuntime.js";

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
  evidenceSummary: AutoPosterMissionEvidenceSummary;
}

export interface AutoPosterMissionEvidenceSummary {
  missionId: string;
  traceId: string;
  workspaceId: string;
  provider: "tiktok" | "youtube";
  canonicalAccountReference: string;
  policyDecision: "not_evaluated" | "allowed" | "blocked" | "approval_required";
  idempotencyOutcome: "not_applicable" | "first_execution" | "duplicate";
  queueDraftId: string | null;
  persistedDraftStatus: string | null;
  operatorApprovalState: "required" | "approved";
  releaseApprovalState: "not_started" | "required";
  publishingState: "not_started" | "blocked_until_human_approval";
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
}

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

function buildEvidenceSummary(
  row: MissionRow,
  runtimeResult: RuntimeMissionResult | null,
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
    postScheduledAt.trim() &&
    Number.isFinite(Date.parse(postScheduledAt)) &&
    Date.parse(postScheduledAt) === Date.parse(row.scheduled_at) &&
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
    typedError: firstError ? { code: firstError.code, message: firstError.message } : null,
  };
}

function mapMission(row: MissionRow): AutoPosterRuntimeMission {
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
    evidenceSummary: buildEvidenceSummary(row, runtimeResult),
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

  constructor(
    private readonly database: DatabaseSync,
    private readonly executor: AutoPosterRuntimeMissionExecutor,
    options: AutoPosterMissionServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.protectedValues = (options.protectedValues ?? [])
      .map((value) => value.trim())
      .filter(Boolean);
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
    const timestamp = this.now().toISOString();

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
        new Date(scheduledAt).toISOString(),
        idempotencyKey,
        timestamp,
        timestamp,
      );

    return this.getMission(missionId);
  }

  listMissions(limit = 50): AutoPosterRuntimeMission[] {
    const boundedLimit = Math.max(1, Math.min(Number.isFinite(limit) ? Math.trunc(limit) : 50, 100));
    return this.database
      .prepare(
        "SELECT * FROM autoposter_runtime_missions ORDER BY created_at DESC, mission_id DESC LIMIT ?",
      )
      .all(boundedLimit)
      .map((row) => mapMission(row as unknown as MissionRow));
  }

  getMission(missionId: string): AutoPosterRuntimeMission {
    const normalizedId = String(missionId || "").trim();
    const row = this.database
      .prepare("SELECT * FROM autoposter_runtime_missions WHERE mission_id = ?")
      .get(normalizedId) as MissionRow | undefined;
    if (!row) {
      throw new OperatorError("Runtime mission was not found.", 404);
    }
    return mapMission(row);
  }

  async approveAndExecute(
    missionId: string,
    approvedByValue: unknown,
  ): Promise<AutoPosterRuntimeMission> {
    const approvedBy =
      typeof approvedByValue === "string" ? approvedByValue.trim() : "";
    if (!approvedBy) {
      throw new OperatorError("approvedBy is required.", 400);
    }
    if (approvedBy.length > 120) {
      throw new OperatorError("approvedBy must be at most 120 characters.", 400);
    }
    this.assertContainsNoProtectedValue([approvedBy]);

    const claim = withTransaction(this.database, () => {
      const mission = this.getMission(missionId);
      if (mission.runtimeResult) {
        return { execute: false as const, mission };
      }
      if (mission.status === "executing") {
        throw new OperatorError("Runtime mission execution is already in progress.", 409);
      }
      if (mission.status !== "approval_required") {
        throw new OperatorError(
          `Runtime mission cannot execute from status ${mission.status}.`,
          409,
        );
      }
      const updatedAt = this.now().toISOString();
      const result = this.database
        .prepare(
          `UPDATE autoposter_runtime_missions
             SET status = 'executing', approved_by = ?, updated_at = ?
           WHERE mission_id = ? AND status = 'approval_required' AND runtime_result_json IS NULL`,
        )
        .run(approvedBy, updatedAt, mission.missionId);
      if (Number(result.changes) !== 1) {
        throw new OperatorError(
          "Runtime mission state changed before approval could be saved.",
          409,
        );
      }
      return { execute: true as const, mission: this.getMission(mission.missionId) };
    });

    if (!claim.execute) return claim.mission;

    const request: RuntimeMissionRequest = {
      missionId: claim.mission.missionId,
      traceId: claim.mission.traceId,
      product: PRODUCT,
      action: ACTION,
      actor: { id: claim.mission.actorId, kind: "service" },
      tenant: {
        userId: this.executor.tenantUserId,
        workspaceId: claim.mission.workspaceId,
        accountId: claim.mission.accountId,
      },
      input: {
        accountId: claim.mission.accountId,
        provider: claim.mission.provider,
        mediaUrl: claim.mission.mediaUrl,
        caption: claim.mission.caption,
        hashtags: claim.mission.hashtags,
        ...(claim.mission.title ? { title: claim.mission.title } : {}),
        ...(claim.mission.description
          ? { description: claim.mission.description }
          : {}),
        scheduledAt: claim.mission.scheduledAt,
      },
      approval: { approved: true, approvedBy },
      idempotencyKey: claim.mission.idempotencyKey,
      requestedAt: claim.mission.createdAt,
      policyContext: {
        reason: "Founder approved creation of one unapproved AutoPoster queue draft.",
      },
    };

    let runtimeResult: RuntimeMissionResult;
    try {
      runtimeResult = await this.executor.execute(request);
    } catch {
      const completedAt = this.now().toISOString();
      runtimeResult = {
        missionId: claim.mission.missionId,
        traceId: claim.mission.traceId,
        product: PRODUCT,
        action: ACTION,
        status: "failed",
        output: null,
        evidence: null,
        warnings: [],
        errors: [
          {
            code: "OPERATOR_RUNTIME_EXECUTOR_FAILED",
            message: "The Operator runtime mission executor failed safely.",
          },
        ],
        policyDecision: null,
        approvalDecision: { required: true, approved: true, approvedBy },
        idempotency: {
          key: claim.mission.idempotencyKey,
          outcome: "not_applicable",
        },
        startedAt: claim.mission.updatedAt,
        completedAt,
        durationMs: 0,
      };
    }

    runtimeResult = redactProtectedValues(
      runtimeResult,
      this.protectedValues,
    ) as RuntimeMissionResult;
    const serializedResult = JSON.stringify(runtimeResult);
    JSON.parse(serializedResult);
    const completedAt = this.now().toISOString();
    withTransaction(this.database, () => {
      const result = this.database
        .prepare(
          `UPDATE autoposter_runtime_missions
             SET status = ?, runtime_result_json = ?, updated_at = ?
           WHERE mission_id = ? AND status = 'executing' AND runtime_result_json IS NULL`,
        )
        .run(
          runtimeResult.status,
          serializedResult,
          completedAt,
          claim.mission.missionId,
        );
      if (Number(result.changes) !== 1) {
        throw new OperatorError(
          "Runtime mission result could not be saved without overwriting newer state.",
          409,
        );
      }
    });

    return this.getMission(claim.mission.missionId);
  }
}
