// ── CHANTER Operator P1.4: AutoPoster Adapter Contract ──
// Contract-only adapter that maps AutoPoster campaign/job concepts into AgentRunManifest.
// No AutoPoster code imported. No TikTok/Instagram API. No social posting. No tokens.
// No scheduler/cron. No network. No Codex/Ollama/OpenClaw.

import type {
  AgentRunManifest,
  AgentRunLifecycleState,
  AgentRuntimeEvidenceRef,
  AgentRuntimeValidationResult,
  AgentRuntimeFailure,
} from "../types.js";
import { AgentRunLifecycleStates } from "../types.js";
import { verifyCompletedManifest } from "../agentRuntimeContract.js";

// ── AutoPoster domain types (contract-only, no cross-repo imports) ──

export const AutoPosterRunStates = [
  "campaign_created",
  "job_created",
  "draft_ready",
  "preparing_payload",
  "generating_variants",
  "queueing_job",
  "validating_content",
  "checking_schedule",
  "checking_account_scope",
  "preview_ready",
  "evidence_collected",
  "job_recorded",
  "awaiting_human_review",
  "approval_required",
  "queued",
  "scheduled",
  "published",
  "failed",
  "cancelled",
] as const;

export type AutoPosterRunState = (typeof AutoPosterRunStates)[number];

/** Target platforms for AutoPoster jobs. */
export const AutoPosterPlatforms = [
  "tiktok",
  "instagram",
  "youtube",
  "twitter",
  "linkedin",
  "facebook",
  "custom",
] as const;

export type AutoPosterPlatform = (typeof AutoPosterPlatforms)[number];

/** Campaign-level input. */
export interface AutoPosterCampaignInput {
  /** Campaign identifier. */
  campaignId: string;
  /** Human-readable campaign name. */
  campaignName: string;
  /** Target platform. */
  platform: AutoPosterPlatform;
  /** Account alias (e.g. "@brand_account") — alias only, no tokens. */
  accountAlias: string;
}

/** Job-level input (one campaign may have multiple jobs). */
export interface AutoPosterJobInput {
  /** Job identifier. */
  jobId: string;
  /** Content type for this job. */
  contentType: "video" | "image" | "text" | "carousel";
  /** Number of variants generated. */
  variantCount: number;
}

/** Validation input from AutoPoster checks. */
export interface AutoPosterValidationInput {
  passed: boolean;
  gates: string[];
  gateResults: Record<string, boolean>;
  summary: string;
  validatedAt: string;
}

/** Evidence input from an AutoPoster run. */
export interface AutoPosterEvidenceInput {
  label: string;
  contentHash: string;
  recordedAt: string;
}

/** Failure input from an AutoPoster run. */
export interface AutoPosterFailureInput {
  code: string;
  message: string;
  detail?: string;
  failedAt: string;
}

/**
 * Input for mapping an AutoPoster run into an AgentRunManifest.
 * Contract-only — no actual AutoPoster data flows through.
 */
export interface AutoPosterRunInput {
  /** Task identifier visible in Operator (required). */
  taskId: string;
  /** Current AutoPoster state (required). */
  state: AutoPosterRunState;
  /** Campaign details. Required when campaign_created or later. */
  campaign?: AutoPosterCampaignInput;
  /** Job details. Required for job-level states (job_created and later). */
  job?: AutoPosterJobInput;
  /** Account scope (required for queued/scheduled/published COMPLETE). */
  accountScope?: string[];
  /** Validation results. */
  validation?: AutoPosterValidationInput;
  /** Evidence collected. */
  evidence?: AutoPosterEvidenceInput[];
  /** Failure information. */
  failure?: AutoPosterFailureInput;
  /** Override state timestamps. */
  stateTimestamps?: Partial<Record<AgentRunLifecycleState, string>>;
  /** Custom runtime-id prefix. Default: "ap-". */
  runtimeIdPrefix?: string;
}

export interface AutoPosterAdapterResult {
  ok: boolean;
  manifest: AgentRunManifest | null;
  errors: string[];
}

// ── State mapping ──

const STATE_MAP: Record<AutoPosterRunState, AgentRunLifecycleState> = {
  campaign_created: "PLAN",
  job_created: "PLAN",
  draft_ready: "PLAN",
  preparing_payload: "EXECUTE",
  generating_variants: "EXECUTE",
  queueing_job: "EXECUTE",
  validating_content: "VALIDATE",
  checking_schedule: "VALIDATE",
  checking_account_scope: "VALIDATE",
  preview_ready: "EVIDENCE",
  evidence_collected: "EVIDENCE",
  job_recorded: "EVIDENCE",
  awaiting_human_review: "HUMAN_REVIEW",
  approval_required: "HUMAN_REVIEW",
  queued: "COMPLETE",
  scheduled: "COMPLETE",
  published: "COMPLETE",
  failed: "COMPLETE",
  cancelled: "COMPLETE",
};

// ── States that require account scope at COMPLETE ──

const ACCOUNT_SCOPE_REQUIRED_STATES = new Set<AutoPosterRunState>([
  "queued",
  "scheduled",
  "published",
]);

const NON_PASSING_STATES = new Set<AutoPosterRunState>(["failed", "cancelled"]);

// ── Security blocklists ──

const BLOCKED_INPUT_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /access_token|refresh_token|bearer\s+\w/i, reason: "Token/credential material detected" },
  { pattern: /secret|api_key|client_secret|password\s*=/i, reason: "Secret/API key material detected" },
  { pattern: /cookie|session_id|x-csrf/i, reason: "Cookie/session material detected" },
  { pattern: /https?:\/\/[a-z0-9.-]*tiktok|https?:\/\/graph\.(instagram|facebook)/i, reason: "Live social API URL detected" },
  { pattern: /https?:\/\/|wss?:\/\//i, reason: "Network URLs detected" },
  { pattern: /codex|ollama|openclaw/i, reason: "External agent execution detected" },
  { pattern: /live.?execution|real.?runner|shell.?command|child_process|deploy/i, reason: "Live execution/deploy claims detected" },
  { pattern: /cron|scheduled.*task|at\s+\d{1,2}:\d{2}/i, reason: "Scheduler/cron execution claims detected" },
  { pattern: /C:\\|D:\\|\/home\/|\/etc\/|\/var\//i, reason: "Absolute filesystem paths detected" },
  { pattern: /tiktok.*(?:api|post|upload)|instagram.*(?:api|post|upload)/i, reason: "Live social posting claims detected" },
  { pattern: /signed.?url|presigned|upload_token/i, reason: "Signed URL / upload token detected" },
];

// ── Mapping function ──

export function mapAutoPosterRunToManifest(
  input: AutoPosterRunInput,
): AutoPosterAdapterResult {
  const errors: string[] = [];

  // 1. Validate taskId
  if (!input.taskId || input.taskId.trim().length === 0) {
    errors.push("Missing required field: taskId");
  }

  // 2. Validate state
  if (!AutoPosterRunStates.includes(input.state)) {
    errors.push("Unknown AutoPoster state: " + String(input.state) + ". Valid: " + AutoPosterRunStates.join(", "));
  }

  // 3. Security blocklist
  const inputText = JSON.stringify(input);
  for (const { pattern, reason } of BLOCKED_INPUT_PATTERNS) {
    if (pattern.test(inputText)) {
      errors.push(reason);
    }
  }

  if (errors.length > 0) return { ok: false, manifest: null, errors };

  const safeState = input.state as AutoPosterRunState;
  const lifecycleState = STATE_MAP[safeState];

  // 4. COMPLETE requirements
  if (lifecycleState === "COMPLETE") {
    if (!input.validation) {
      errors.push("Validation required before COMPLETE for state: " + safeState);
    }
    const hasEvidence = input.evidence && input.evidence.length > 0;
    if (!hasEvidence) {
      errors.push("Evidence required before COMPLETE for state: " + safeState);
    }
    if (ACCOUNT_SCOPE_REQUIRED_STATES.has(safeState)) {
      if (!input.accountScope || input.accountScope.length === 0) {
        errors.push("Account scope required for state: " + safeState + ". Must specify target accounts.");
      }
    }
  }

  if (errors.length > 0) return { ok: false, manifest: null, errors };

  // 5. Build timestamps
  const now = new Date().toISOString();
  const timestamps = buildTimestamps(lifecycleState, input.stateTimestamps);
  const tsErrors = validateTimestampOrder(timestamps);
  if (tsErrors.length > 0) return { ok: false, manifest: null, errors: tsErrors };

  // 6. Build evidence
  const evidence: AgentRuntimeEvidenceRef[] = [];
  if (input.evidence) {
    for (const [i, e] of input.evidence.entries()) {
      evidence.push({
        id: "ap-ev-" + (input.campaign?.campaignId ?? "x") + "-" + String(i + 1),
        recordedAtState: "EVIDENCE" as AgentRunLifecycleState,
        label: e.label,
        contentHash: e.contentHash,
        recordedAt: e.recordedAt,
      });
    }
  }
  // Campaign summary as evidence
  if (input.campaign) {
    evidence.push({
      id: "ap-campaign-" + input.campaign.campaignId,
      recordedAtState: "EVIDENCE" as AgentRunLifecycleState,
      label: "campaign-" + input.campaign.platform + "-" + input.campaign.campaignId,
      contentHash: hashStr(input.campaign.campaignName + input.campaign.platform + input.campaign.accountAlias),
      recordedAt: now,
    });
  }
  // Job summary as evidence
  if (input.job) {
    evidence.push({
      id: "ap-job-" + input.job.jobId,
      recordedAtState: "EVIDENCE" as AgentRunLifecycleState,
      label: "job-" + input.job.contentType + "-" + input.job.variantCount + "variants",
      contentHash: hashStr(input.job.jobId + input.job.contentType + String(input.job.variantCount)),
      recordedAt: now,
    });
  }
  // Account scope as evidence
  if (input.accountScope && input.accountScope.length > 0) {
    evidence.push({
      id: "ap-scope-" + (input.job?.jobId ?? input.campaign?.campaignId ?? "x"),
      recordedAtState: "EVIDENCE" as AgentRunLifecycleState,
      label: "account-scope-" + input.accountScope.join("+"),
      contentHash: hashStr(input.accountScope.join(",")),
      recordedAt: now,
    });
  }

  // 7. Build validation
  let validation: AgentRuntimeValidationResult | null = null;
  if (input.validation) {
    validation = {
      passed: input.validation.passed,
      gates: input.validation.gates,
      gateResults: input.validation.gateResults,
      summary: input.validation.summary,
      validatedAt: input.validation.validatedAt,
    };
  }

  // 8. Build failure
  let failure: AgentRuntimeFailure | null = null;
  if (input.failure) {
    failure = {
      failedAtState: lifecycleState,
      code: input.failure.code,
      message: input.failure.message,
      detail: input.failure.detail,
      failedAt: input.failure.failedAt,
    };
  } else if (NON_PASSING_STATES.has(safeState)) {
    failure = {
      failedAtState: lifecycleState,
      code: "AUTOPOSTER_" + safeState.toUpperCase(),
      message: safeState === "failed" ? "AutoPoster run failed." : "AutoPoster run was cancelled.",
      failedAt: now,
    };
  }

  // 9. Build runtimeId
  const prefix = input.runtimeIdPrefix ?? "ap-";
  const idSource = input.job?.jobId ?? input.campaign?.campaignId ?? "unknown";

  // 10. Assemble manifest
  const manifest: AgentRunManifest = {
    runtimeId: prefix + idSource,
    productId: "AutoPoster",
    taskId: input.taskId,
    lifecycleState,
    stateTimestamps: timestamps,
    policy: autoPosterPolicy(),
    evidence,
    validation,
    failure,
    createdAt: timestamps.PLAN ?? now,
    updatedAt: now,
  };

  // Final verification for non-error terminal states
  if (lifecycleState === "COMPLETE" && !NON_PASSING_STATES.has(safeState)) {
    const ver = verifyCompletedManifest(manifest);
    if (!ver.valid) return { ok: false, manifest: null, errors: ver.violations };
  }

  return { ok: true, manifest, errors: [] };
}

// ── Helpers ──

function buildTimestamps(
  currentState: AgentRunLifecycleState,
  overrides?: Partial<Record<AgentRunLifecycleState, string>>,
): Record<AgentRunLifecycleState, string | null> {
  const now = new Date().toISOString();
  const r: Record<AgentRunLifecycleState, string | null> = {
    PLAN: null, EXECUTE: null, VALIDATE: null, EVIDENCE: null, HUMAN_REVIEW: null, COMPLETE: null,
  };
  const idx = AgentRunLifecycleStates.indexOf(currentState);
  for (let i = 0; i < AgentRunLifecycleStates.length; i++) {
    const s = AgentRunLifecycleStates[i];
    r[s] = i <= idx ? (overrides?.[s] ?? now) : (overrides?.[s] ?? null);
  }
  return r;
}

function validateTimestampOrder(ts: Record<AgentRunLifecycleState, string | null>): string[] {
  const errors: string[] = [];
  let last = "";
  for (const s of AgentRunLifecycleStates) {
    const t = ts[s];
    if (t === null) continue;
    if (t < last) errors.push("Timestamp out of lifecycle order: " + s + " (" + t + ") before previous (" + last + ")");
    last = t;
  }
  return errors;
}

function autoPosterPolicy(): AgentRunManifest["policy"] {
  return {
    timeout: { maxStateMs: 180_000, maxTotalMs: 900_000 },
    retry: { maxRetries: 3, retryDelayMs: 3_000, retryableStates: ["EXECUTE", "VALIDATE"] },
    cancel: { cancellable: true, cancellableStates: ["PLAN", "EXECUTE", "VALIDATE"], cleanupAction: "log_only" },
  };
}

function hashStr(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return "ap-hash-" + (h >>> 0).toString(16).padStart(8, "0");
}

// ── Sample fixture ──

export const SAMPLE_AUTOPOSTER_INPUT: AutoPosterRunInput = {
  taskId: "task-operator-review-003",
  state: "published",
  campaign: {
    campaignId: "CAMP-2026-07-05-001",
    campaignName: "Summer Collection Launch",
    platform: "tiktok",
    accountAlias: "@chanter_official",
  },
  job: {
    jobId: "JOB-2026-07-05-001",
    contentType: "video",
    variantCount: 3,
  },
  accountScope: ["@chanter_official", "@chanter_style"],
  validation: {
    passed: true,
    gates: ["content-check", "schedule-check", "account-scope-check", "format-validation"],
    gateResults: {
      "content-check": true,
      "schedule-check": true,
      "account-scope-check": true,
      "format-validation": true,
    },
    summary: "[mock] All content checks passed. Schedule window valid. Account scope confirmed. Format validated.",
    validatedAt: "2026-07-05T14:00:00.000Z",
  },
  evidence: [
    { label: "content-preview", contentHash: "sha256:ccc111ddd222eee333fff444ggg555hhh666iii777jjj888kkk999lll000", recordedAt: "2026-07-05T13:30:00.000Z" },
    { label: "schedule-confirmation", contentHash: "sha256:aaa000bbb111ccc222ddd333eee444fff555ggg666hhh777iii888jjj999", recordedAt: "2026-07-05T13:45:00.000Z" },
    { label: "variant-previews", contentHash: "sha256:111222333444555666777888999000aaabbbcccdddeeefffggghhhiiijjj", recordedAt: "2026-07-05T13:50:00.000Z" },
  ],
  stateTimestamps: {
    PLAN: "2026-07-05T12:00:00.000Z",
    EXECUTE: "2026-07-05T12:30:00.000Z",
    VALIDATE: "2026-07-05T13:45:00.000Z",
    EVIDENCE: "2026-07-05T13:50:00.000Z",
    HUMAN_REVIEW: "2026-07-05T13:55:00.000Z",
    COMPLETE: "2026-07-05T14:00:00.000Z",
  },
};
