// ── CHANTER Operator P1.3: SafeCommit Adapter Contract ──
// Contract-only adapter that maps SafeCommit review concepts into AgentRunManifest.
// No SafeCommit code imported. No git execution. No staging/commit/push. No network.
// No Codex/Ollama/OpenClaw integration.

import type {
  AgentRunManifest,
  AgentRunLifecycleState,
  AgentRuntimeEvidenceRef,
  AgentRuntimeValidationResult,
  AgentRuntimeFailure,
} from "../types.js";
import { AgentRunLifecycleStates } from "../types.js";
import { verifyCompletedManifest } from "../agentRuntimeContract.js";

// ── SafeCommit domain types (contract-only, no cross-repo imports) ──

/** Valid SafeCommit review states that can be mapped to an AgentRunLifecycleState. */
export const SafeCommitReviewStates = [
  "review_created",
  "diff_received",
  "analyzing_diff",
  "classifying_risk",
  "validating",
  "checks_running",
  "evidence_collected",
  "report_ready",
  "awaiting_human_review",
  "recommendation_ready",
  "accepted",
  "rejected",
  "blocked",
  "completed",
] as const;

export type SafeCommitReviewState = (typeof SafeCommitReviewStates)[number];

/** SafeCommit verdict — the final disposition of a review. */
export const SafeCommitVerdicts = [
  "accepted",
  "rejected",
  "blocked",
  "needs_human_review",
] as const;

export type SafeCommitVerdict = (typeof SafeCommitVerdicts)[number];

/** Details about a changed file within the review. */
export interface SafeCommitChangedFileInput {
  /** Relative filename (e.g. "src/routes/api.ts"). Must be relative — no absolute paths. */
  filename: string;
  /** Classification: "safe", "risky", "blocked", "needs_review". */
  classification: "safe" | "risky" | "blocked" | "needs_review";
  /** Number of lines added. */
  linesAdded: number;
  /** Number of lines removed. */
  linesRemoved: number;
  /** Risk notes for this specific file. */
  riskNotes?: string;
}

/** Risk assessment for the overall review. */
export interface SafeCommitRiskInput {
  /** Overall risk level. */
  level: "low" | "medium" | "high" | "critical";
  /** Human-readable risk summary. */
  summary: string;
  /** Number of risky files identified. */
  riskyFileCount: number;
  /** Number of blocked files identified. */
  blockedFileCount: number;
}

/** Validation input from SafeCommit checks (typecheck, tests, diff-check). */
export interface SafeCommitValidationInput {
  /** Whether all automated checks passed. */
  passed: boolean;
  /** Gates checked. */
  gates: string[];
  /** Per-gate results. */
  gateResults: Record<string, boolean>;
  /** Human-readable summary. */
  summary: string;
  /** ISO-8601 when validation completed. */
  validatedAt: string;
}

/** Evidence input from a SafeCommit review. */
export interface SafeCommitEvidenceInput {
  /** Evidence label (e.g. "diff-preview", "typecheck-output", "risk-report"). */
  label: string;
  /** Content hash for integrity. */
  contentHash: string;
  /** ISO-8601 when evidence was recorded. */
  recordedAt: string;
}

/** Failure input from a SafeCommit review. */
export interface SafeCommitFailureInput {
  /** Machine-readable error code. */
  code: string;
  /** Human-readable message. */
  message: string;
  /** Optional detail. */
  detail?: string;
  /** ISO-8601 when failure occurred. */
  failedAt: string;
}

/**
 * Input for mapping a SafeCommit review into an AgentRunManifest.
 * This is a contract-only representation — no actual SafeCommit data flows through.
 */
export interface SafeCommitReviewInput {
  /** Unique review identifier (required). */
  reviewId: string;
  /** Task identifier visible in Operator (required). */
  taskId: string;
  /** Current SafeCommit review state (required). */
  state: SafeCommitReviewState;
  /** Changed files under review. */
  changedFiles?: SafeCommitChangedFileInput[];
  /** Risk assessment. */
  risk?: SafeCommitRiskInput;
  /** Final verdict (required for COMPLETE states). */
  verdict?: SafeCommitVerdict;
  /** Validation results from automated checks. */
  validation?: SafeCommitValidationInput;
  /** Evidence collected during review. */
  evidence?: SafeCommitEvidenceInput[];
  /** Failure information if the review process failed. */
  failure?: SafeCommitFailureInput;
  /** Override state timestamps (ISO-8601). */
  stateTimestamps?: Partial<Record<AgentRunLifecycleState, string>>;
  /** Custom runtime-id prefix. Default: "sc-". */
  runtimeIdPrefix?: string;
}

/** Result of mapping a SafeCommit review to an AgentRunManifest. */
export interface SafeCommitAdapterResult {
  /** Whether mapping succeeded. */
  ok: boolean;
  /** The mapped manifest (only present when ok=true). */
  manifest: AgentRunManifest | null;
  /** Validation errors if mapping failed. */
  errors: string[];
}

// ── State mapping table ──

/** Maps SafeCommit review states → AgentRunLifecycleState. */
const STATE_MAP: Record<SafeCommitReviewState, AgentRunLifecycleState> = {
  review_created: "PLAN",
  diff_received: "PLAN",
  analyzing_diff: "EXECUTE",
  classifying_risk: "EXECUTE",
  validating: "VALIDATE",
  checks_running: "VALIDATE",
  evidence_collected: "EVIDENCE",
  report_ready: "EVIDENCE",
  awaiting_human_review: "HUMAN_REVIEW",
  recommendation_ready: "HUMAN_REVIEW",
  accepted: "COMPLETE",
  rejected: "COMPLETE",
  blocked: "COMPLETE",
  completed: "COMPLETE",
};

// ── Verdict mapping ──

/** Verdicts that indicate a non-passing terminal state. */
const NON_PASSING_VERDICTS = new Set<SafeCommitVerdict>([
  "rejected",
  "blocked",
]);

// ── Security: patterns that indicate unsafe operations ──

const BLOCKED_INPUT_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /git\s+add|git\s+commit|git\s+push|git\s+merge|git\s+rebase/i, reason: "Git automation claims detected" },
  { pattern: /deploy|ship|release\s+to/i, reason: "Deploy/ship claims detected" },
  { pattern: /codex|ollama|openclaw/i, reason: "External agent execution detected" },
  { pattern: /live.?execution|real.?runner|shell.?command|child_process/i, reason: "Live execution claims detected" },
  { pattern: /https?:\/\/|wss?:\/\//i, reason: "Network URLs detected" },
];

// ── Path security: reject unsafe file paths ──

const UNSAFE_PATH_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /^[A-Za-z]:\\|^\//, reason: "Absolute path not allowed" },
  { pattern: /\.\./, reason: "Parent traversal not allowed" },
  { pattern: /\.env($|\.|\/|\\)/i, reason: ".env files not allowed in changed files" },
  { pattern: /secret|credential|private.?key|\.pem$|id_rsa/i, reason: "Secrets/credentials files not allowed" },
  { pattern: /\.ssh\//i, reason: "SSH directory files not allowed" },
  { pattern: /\.aws\//i, reason: "AWS config files not allowed" },
];

// ── Mapping function ──

/**
 * Map a SafeCommit review input into an AgentRunManifest.
 *
 * Pure data transformation — never imports SafeCommit, executes git,
 * stages files, commits, pushes, or invokes external agents.
 *
 * Strict validation rejects:
 * - Unknown SafeCommit states
 * - Missing reviewId or taskId
 * - COMPLETE without validation / evidence / verdict
 * - Unsafe file paths (absolute, .env, secrets, credentials)
 * - Git automation / deploy / live agent / Codex / Ollama / OpenClaw claims
 * - Network URLs
 * - Out-of-order timestamps
 */
export function mapSafeCommitReviewToManifest(
  input: SafeCommitReviewInput,
): SafeCommitAdapterResult {
  const errors: string[] = [];

  // 1. Validate required identifiers
  if (!input.reviewId || input.reviewId.trim().length === 0) {
    errors.push("Missing required field: reviewId");
  }
  if (!input.taskId || input.taskId.trim().length === 0) {
    errors.push("Missing required field: taskId");
  }

  // 2. Validate state
  if (!SafeCommitReviewStates.includes(input.state)) {
    errors.push(
      "Unknown SafeCommit state: " +
        String(input.state) +
        ". Valid states: " +
        SafeCommitReviewStates.join(", "),
    );
  }

  // 3. Security: reject unsafe claims
  const inputText = JSON.stringify(input);
  for (const { pattern, reason } of BLOCKED_INPUT_PATTERNS) {
    if (pattern.test(inputText)) {
      errors.push(reason);
    }
  }

  // 4. Path security: reject unsafe file paths
  for (const file of input.changedFiles ?? []) {
    for (const { pattern, reason } of UNSAFE_PATH_PATTERNS) {
      if (pattern.test(file.filename)) {
        errors.push(
          "Unsafe file path in changed files: " +
            file.filename +
            " — " +
            reason,
        );
      }
    }
    // Also check risk notes for unsafe references
    if (file.riskNotes) {
      for (const { pattern, reason } of UNSAFE_PATH_PATTERNS) {
        if (pattern.test(file.riskNotes)) {
          errors.push(
            "Unsafe reference in risk notes for " +
              file.filename +
              ": " +
              reason,
          );
        }
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, manifest: null, errors };
  }

  // Safe cast — validated above
  const safeState = input.state as SafeCommitReviewState;
  const lifecycleState = STATE_MAP[safeState];

  // 5. Validate COMPLETE-specific requirements
  const isTerminal =
    safeState === "accepted" ||
    safeState === "rejected" ||
    safeState === "blocked" ||
    safeState === "completed";

  if (lifecycleState === "COMPLETE") {
    if (!input.validation) {
      errors.push(
        "Validation is required before COMPLETE. A SafeCommit review marked as " +
          safeState +
          " must include validation results.",
      );
    }
    const hasEvidence =
      input.evidence !== undefined && input.evidence.length > 0;
    if (!hasEvidence) {
      errors.push(
        "Evidence is required before COMPLETE. A SafeCommit review marked as " +
          safeState +
          " must include at least one evidence reference.",
      );
    }
    if (!input.verdict) {
      errors.push(
        "Verdict/recommendation is required before COMPLETE. A SafeCommit review marked as " +
          safeState +
          " must include a verdict.",
      );
    }
  }

  if (errors.length > 0) {
    return { ok: false, manifest: null, errors };
  }

  // 6. Build timestamps
  const now = new Date().toISOString();
  const timestamps = buildStateTimestamps(lifecycleState, input.stateTimestamps);

  // 7. Validate timestamp order
  const tsErrors = validateTimestampOrder(timestamps);
  if (tsErrors.length > 0) {
    return { ok: false, manifest: null, errors: tsErrors };
  }

  // 8. Build evidence refs (include changed files as evidence)
  const evidence: AgentRuntimeEvidenceRef[] = [];

  // Evidence from review process
  if (input.evidence) {
    for (const [i, e] of input.evidence.entries()) {
      evidence.push({
        id: "sc-ev-" + input.reviewId + "-" + String(i + 1),
        recordedAtState: "EVIDENCE" as AgentRunLifecycleState,
        label: e.label,
        contentHash: e.contentHash,
        recordedAt: e.recordedAt,
      });
    }
  }

  // Changed file list as evidence
  if (input.changedFiles && input.changedFiles.length > 0) {
    const filesSummary = input.changedFiles
      .map((f) => f.filename + ":" + f.classification)
      .join(";");
    evidence.push({
      id: "sc-files-" + input.reviewId,
      recordedAtState: "EVIDENCE" as AgentRunLifecycleState,
      label: "changed-files-" + input.changedFiles.length,
      contentHash: hashString(filesSummary),
      recordedAt: now,
    });
  }

  // Risk report as evidence
  if (input.risk) {
    evidence.push({
      id: "sc-risk-" + input.reviewId,
      recordedAtState: "EVIDENCE" as AgentRunLifecycleState,
      label: "risk-assessment-" + input.risk.level,
      contentHash: hashString(input.risk.summary),
      recordedAt: now,
    });
  }

  // 9. Build validation
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

  // 10. Build failure record
  let failure: AgentRuntimeFailure | null = null;
  if (input.failure) {
    failure = {
      failedAtState: lifecycleState,
      code: input.failure.code,
      message: input.failure.message,
      detail: input.failure.detail,
      failedAt: input.failure.failedAt,
    };
  } else if (input.verdict && NON_PASSING_VERDICTS.has(input.verdict)) {
    // Rejected/blocked verdicts get a synthetic failure record
    failure = {
      failedAtState: lifecycleState,
      code: "SAFECOMMIT_" + input.verdict.toUpperCase(),
      message:
        input.verdict === "rejected"
          ? "SafeCommit review was rejected."
          : "SafeCommit review was blocked.",
      failedAt: now,
    };
  }

  // 11. Assemble the manifest
  const prefix = input.runtimeIdPrefix ?? "sc-";
  const manifest: AgentRunManifest = {
    runtimeId: prefix + input.reviewId,
    productId: "SafeCommit",
    taskId: input.taskId,
    lifecycleState,
    stateTimestamps: timestamps,
    policy: buildSafeCommitPolicy(lifecycleState),
    evidence,
    validation,
    failure,
    createdAt: timestamps.PLAN ?? now,
    updatedAt: now,
  };

  // Final contract verification for passing terminal states
  if (lifecycleState === "COMPLETE" && input.verdict === "accepted") {
    const verification = verifyCompletedManifest(manifest);
    if (!verification.valid) {
      return { ok: false, manifest: null, errors: verification.violations };
    }
  }

  return { ok: true, manifest, errors: [] };
}

// ── Internal helpers ──

function buildStateTimestamps(
  currentState: AgentRunLifecycleState,
  overrides?: Partial<Record<AgentRunLifecycleState, string>>,
): Record<AgentRunLifecycleState, string | null> {
  const now = new Date().toISOString();
  const result: Record<AgentRunLifecycleState, string | null> = {
    PLAN: null,
    EXECUTE: null,
    VALIDATE: null,
    EVIDENCE: null,
    HUMAN_REVIEW: null,
    COMPLETE: null,
  };

  const currentIdx = AgentRunLifecycleStates.indexOf(currentState);
  for (let i = 0; i < AgentRunLifecycleStates.length; i++) {
    const state = AgentRunLifecycleStates[i];
    if (i <= currentIdx) {
      result[state] = overrides?.[state] ?? now;
    } else {
      result[state] = overrides?.[state] ?? null;
    }
  }
  return result;
}

function validateTimestampOrder(
  timestamps: Record<AgentRunLifecycleState, string | null>,
): string[] {
  const errors: string[] = [];
  let lastTs = "";
  for (const state of AgentRunLifecycleStates) {
    const ts = timestamps[state];
    if (ts === null) continue;
    if (ts < lastTs) {
      errors.push(
        "Timestamp out of lifecycle order: " +
          state +
          " (" +
          ts +
          ") is before previous state (" +
          lastTs +
          ")",
      );
    }
    lastTs = ts;
  }
  return errors;
}

function buildSafeCommitPolicy(
  _state: AgentRunLifecycleState,
): AgentRunManifest["policy"] {
  return {
    timeout: {
      maxStateMs: 120_000, // 2 minutes per state
      maxTotalMs: 600_000, // 10 minutes total
    },
    retry: {
      maxRetries: 2,
      retryDelayMs: 2_000,
      retryableStates: ["EXECUTE", "VALIDATE"],
    },
    cancel: {
      cancellable: true,
      cancellableStates: ["PLAN", "EXECUTE", "VALIDATE"],
      cleanupAction: "noop",
    },
  };
}

function hashString(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (Math.imul(31, h) + input.charCodeAt(i)) | 0;
  }
  return "sc-hash-" + (h >>> 0).toString(16).padStart(8, "0");
}

// ── Deterministic sample fixture ──

/**
 * Sample SafeCommit adapter input that maps into a complete AgentRunManifest.
 * No real diffs. No private paths. No credentials. No operational logs.
 */
export const SAMPLE_SAFE_COMMIT_INPUT: SafeCommitReviewInput = {
  reviewId: "SC-2026-07-05-001",
  taskId: "task-operator-review-002",
  state: "accepted",
  changedFiles: [
    {
      filename: "src/components/StatusBadge.tsx",
      classification: "safe",
      linesAdded: 12,
      linesRemoved: 3,
      riskNotes: "Minor UI polish — safe to commit.",
    },
    {
      filename: "docs/CHANGELOG.md",
      classification: "safe",
      linesAdded: 8,
      linesRemoved: 0,
      riskNotes: "Documentation update.",
    },
  ],
  risk: {
    level: "low",
    summary: "Two files changed: one UI component, one doc file. No risky patterns detected.",
    riskyFileCount: 0,
    blockedFileCount: 0,
  },
  verdict: "accepted",
  validation: {
    passed: true,
    gates: ["typecheck", "test", "build", "diff-check"],
    gateResults: {
      typecheck: true,
      test: true,
      build: true,
      "diff-check": true,
    },
    summary:
      "[mock] All validation gates passed. 2 files reviewed. Risk: low. Recommendation: accept.",
    validatedAt: "2026-07-05T10:30:00.000Z",
  },
  evidence: [
    {
      label: "diff-preview",
      contentHash: "sha256:111aaa222bbb333ccc444ddd555eee666fff777ggg888hhh999iii000jjj",
      recordedAt: "2026-07-05T10:00:00.000Z",
    },
    {
      label: "typecheck-output",
      contentHash: "sha256:aaa111bbb222ccc333ddd444eee555fff666ggg777hhh888iii999jjj000",
      recordedAt: "2026-07-05T10:15:00.000Z",
    },
    {
      label: "risk-assessment-report",
      contentHash: "sha256:999888777666555444333222111000aaabbbcccdddeeefffggghhh",
      recordedAt: "2026-07-05T10:20:00.000Z",
    },
  ],
  stateTimestamps: {
    PLAN: "2026-07-05T09:00:00.000Z",
    EXECUTE: "2026-07-05T09:10:00.000Z",
    VALIDATE: "2026-07-05T10:15:00.000Z",
    EVIDENCE: "2026-07-05T10:20:00.000Z",
    HUMAN_REVIEW: "2026-07-05T10:25:00.000Z",
    COMPLETE: "2026-07-05T10:30:00.000Z",
  },
};
