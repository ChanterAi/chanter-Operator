// ── CHANTER Operator P1.2: Loop Governor Adapter Contract ──
// Contract-only adapter that maps Loop Governor concepts into AgentRunManifest.
// No Loop Governor code imported. No real execution. No network. No Codex/Ollama.

import type {
  AgentRunManifest,
  AgentRunLifecycleState,
  AgentRuntimeEvidenceRef,
  AgentRuntimeValidationResult,
  AgentRuntimeFailure,
} from "../types.js";
import { AgentRunLifecycleStates, DEFAULT_RUNTIME_POLICY } from "../types.js";
import { verifyCompletedManifest } from "../agentRuntimeContract.js";

// ── Loop Governor domain types (contract-only, no cross-repo imports) ──

/** Valid Loop Governor states that can be mapped to an AgentRunLifecycleState. */
export const LoopGovernorLoopStates = [
  "planned",
  "created",
  "running",
  "iterating",
  "validating",
  "collecting_evidence",
  "awaiting_review",
  "completed",
  "closed",
  "failed",
  "cancelled",
] as const;

export type LoopGovernorLoopState = (typeof LoopGovernorLoopStates)[number];

/** Evidence input from a Loop Governor run. */
export interface LoopGovernorEvidenceInput {
  /** Evidence label (e.g. "loop-iteration-3-log", "git-snapshot-HASH"). */
  label: string;
  /** Content hash for integrity. */
  contentHash: string;
  /** ISO-8601 when the evidence was recorded. */
  recordedAt: string;
}

/** Validation input from a Loop Governor run. */
export interface LoopGovernorValidationInput {
  /** Whether validation passed. */
  passed: boolean;
  /** Gates checked during loop validation. */
  gates: string[];
  /** Per-gate result map. */
  gateResults: Record<string, boolean>;
  /** Human-readable summary. */
  summary: string;
  /** ISO-8601 when validation completed. */
  validatedAt: string;
}

/** Failure input from a Loop Governor run. */
export interface LoopGovernorFailureInput {
  /** Machine-readable error code. */
  code: string;
  /** Human-readable message. */
  message: string;
  /** Optional stack trace or detail. */
  detail?: string;
  /** ISO-8601 when failure occurred. */
  failedAt: string;
}

/**
 * Input for mapping a Loop Governor run into an AgentRunManifest.
 * This is a contract-only representation — no actual Loop Governor data flows through.
 */
export interface LoopGovernorRunInput {
  /** Unique loop identifier (required). */
  loopId: string;
  /** Task identifier visible in Operator (required). */
  taskId: string;
  /** Current Loop Governor state (required). */
  state: LoopGovernorLoopState;
  /** Evidence collected during this loop run. */
  evidence?: LoopGovernorEvidenceInput[];
  /** Validation results from loop smoke checks. */
  validation?: LoopGovernorValidationInput;
  /** Failure information if the loop run failed. */
  failure?: LoopGovernorFailureInput;
  /** Override state timestamps (ISO-8601). If absent, defaults are derived from state. */
  stateTimestamps?: Partial<Record<AgentRunLifecycleState, string>>;
  /** Custom runtime-id prefix. Default: "lg-". */
  runtimeIdPrefix?: string;
}

/** Result of mapping a Loop Governor run to an AgentRunManifest. */
export interface LoopGovernorAdapterResult {
  /** Whether mapping succeeded. */
  ok: boolean;
  /** The mapped manifest (only present when ok=true). */
  manifest: AgentRunManifest | null;
  /** Validation errors if mapping failed. */
  errors: string[];
}

// ── State mapping table ──

/** Maps Loop Governor domain states → AgentRunLifecycleState. */
const STATE_MAP: Record<LoopGovernorLoopState, AgentRunLifecycleState> = {
  planned: "PLAN",
  created: "PLAN",
  running: "EXECUTE",
  iterating: "EXECUTE",
  validating: "VALIDATE",
  collecting_evidence: "EVIDENCE",
  awaiting_review: "HUMAN_REVIEW",
  completed: "COMPLETE",
  closed: "COMPLETE",
  failed: "COMPLETE", // terminal Loop Governor states still map to COMPLETE
  cancelled: "COMPLETE", // but will carry a failure record
};

// ── Security: patterns that indicate live execution or external agent activity ──

const BLOCKED_INPUT_PATTERNS: { pattern: RegExp; reason: string }[] = [
  {
    pattern: /codex|ollama|openclaw/i,
    reason: "External agent execution detected in input",
  },
  {
    pattern: /live.?execution|real.?runner|shell.?command/i,
    reason: "Live execution claims detected in input",
  },
  {
    pattern: /https?:\/\/|wss?:\/\//i,
    reason: "Network URLs detected in input",
  },
  {
    pattern: /C:\\|D:\\|\/home\/|\/etc\/|\/var\//i,
    reason: "Absolute filesystem paths detected in input",
  },
];

// ── Mapping function ──

/**
 * Map a Loop Governor run input into an AgentRunManifest.
 *
 * This is a pure data transformation — it never executes code, imports
 * Loop Governor, accesses filesystem or network, or invokes external agents.
 *
 * Strict validation rejects:
 * - Unknown Loop Governor states
 * - Missing loopId or taskId
 * - COMPLETE without validation
 * - COMPLETE without evidence
 * - Out-of-order timestamps
 * - Any input that references live execution or external agents
 */
export function mapLoopGovernorRunToManifest(
  input: LoopGovernorRunInput,
): LoopGovernorAdapterResult {
  const errors: string[] = [];

  // 1. Validate required identifiers
  if (!input.loopId || input.loopId.trim().length === 0) {
    errors.push("Missing required field: loopId");
  }
  if (!input.taskId || input.taskId.trim().length === 0) {
    errors.push("Missing required field: taskId");
  }

  // 2. Validate state
  if (!LoopGovernorLoopStates.includes(input.state)) {
    errors.push(
      "Unknown Loop Governor state: " +
        String(input.state) +
        ". Valid states: " +
        LoopGovernorLoopStates.join(", "),
    );
  }

  // 3. Security: reject inputs that reference external agents or live execution
  const inputText = JSON.stringify(input);
  for (const { pattern, reason } of BLOCKED_INPUT_PATTERNS) {
    if (pattern.test(inputText)) {
      errors.push(reason);
    }
  }

  if (errors.length > 0) {
    return { ok: false, manifest: null, errors };
  }

  // Safe cast — validated above
  const safeState = input.state as LoopGovernorLoopState;
  const lifecycleState = STATE_MAP[safeState];

  // 4. Validate COMPLETE-specific requirements
  const isTerminalError = safeState === "failed" || safeState === "cancelled";
  if (lifecycleState === "COMPLETE") {
    if (!input.validation) {
      errors.push(
        "Validation is required before COMPLETE. A Loop Governor run marked as " +
          safeState +
          " must include validation results.",
      );
    }
    const hasEvidence =
      input.evidence !== undefined && input.evidence.length > 0;
    if (!hasEvidence) {
      errors.push(
        "Evidence is required before COMPLETE. A Loop Governor run marked as " +
          safeState +
          " must include at least one evidence reference.",
      );
    }
  }

  if (errors.length > 0) {
    return { ok: false, manifest: null, errors };
  }

  // 5. Build timestamps
  const now = new Date().toISOString();
  const timestamps = buildStateTimestamps(lifecycleState, input.stateTimestamps);

  // 6. Validate timestamp order
  const tsErrors = validateTimestampOrder(timestamps);
  if (tsErrors.length > 0) {
    return { ok: false, manifest: null, errors: tsErrors };
  }

  // 7. Build evidence refs
  const evidence: AgentRuntimeEvidenceRef[] = (input.evidence ?? []).map(
    (e, i) => ({
      id: "lg-ev-" + input.loopId + "-" + String(i + 1),
      recordedAtState: "EVIDENCE" as AgentRunLifecycleState,
      label: e.label,
      contentHash: e.contentHash,
      recordedAt: e.recordedAt,
    }),
  );

  // 8. Build validation
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

  // 9. Build failure record
  let failure: AgentRuntimeFailure | null = null;
  if (input.failure) {
    failure = {
      failedAtState: lifecycleState,
      code: input.failure.code,
      message: input.failure.message,
      detail: input.failure.detail,
      failedAt: input.failure.failedAt,
    };
  } else if (safeState === "failed" || safeState === "cancelled") {
    // Terminal Loop Governor states without explicit failure get a synthetic one
    failure = {
      failedAtState: lifecycleState,
      code: safeState === "failed" ? "LOOP_FAILED" : "LOOP_CANCELLED",
      message:
        safeState === "failed"
          ? "Loop Governor run reported as failed."
          : "Loop Governor run was cancelled.",
      failedAt: now,
    };
  }

  // 10. Assemble the manifest
  const prefix = input.runtimeIdPrefix ?? "lg-";
  const manifest: AgentRunManifest = {
    runtimeId: prefix + input.loopId,
    productId: "Loop Governor",
    taskId: input.taskId,
    lifecycleState,
    stateTimestamps: timestamps,
    policy: buildLoopGovernorPolicy(lifecycleState),
    evidence,
    validation,
    failure,
    createdAt: timestamps.PLAN ?? now,
    updatedAt: now,
  };

  // Final contract verification if COMPLETE
  // For terminal errors (failed/cancelled), skip strict verification —
  // validation may legitimately report failure, and evidence documents it.
  if (lifecycleState === "COMPLETE" && !isTerminalError) {
    const verification = verifyCompletedManifest(manifest);
    if (!verification.valid) {
      return {
        ok: false,
        manifest: null,
        errors: verification.violations,
      };
    }
  }

  return { ok: true, manifest, errors: [] };
}

// ── Internal helpers ──

/**
 * Build state timestamps for the lifecycle.
 * For states the run hasn't reached yet, timestamps are null.
 * For past states without explicit timestamps, synthesize them from the
 * present state's timestamp or now.
 */
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
      // This state has been reached — use override or synthetic timestamp
      result[state] = overrides?.[state] ?? now;
    } else {
      // Not yet reached
      result[state] = overrides?.[state] ?? null;
    }
  }

  return result;
}

/**
 * Validate that state timestamps are in lifecycle order (non-decreasing).
 */
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

/**
 * Build a Loop Governor-specific runtime policy.
 * Loop Governor runs have longer timeouts than the default — loops can run for minutes/hours.
 */
function buildLoopGovernorPolicy(
  _state: AgentRunLifecycleState,
): AgentRunManifest["policy"] {
  return {
    timeout: {
      maxStateMs: 300_000, // 5 minutes per state (loops may run long)
      maxTotalMs: 3_600_000, // 1 hour total
    },
    retry: {
      maxRetries: 5,
      retryDelayMs: 5_000,
      retryableStates: ["EXECUTE", "VALIDATE"],
    },
    cancel: {
      cancellable: true,
      cancellableStates: ["PLAN", "EXECUTE", "VALIDATE"],
      cleanupAction: "log_only",
    },
  };
}

// ── Deterministic sample fixture ──

/**
 * Sample Loop Governor adapter input that maps into a complete AgentRunManifest.
 * No real operational data. No private paths. No actual agent logs.
 */
export const SAMPLE_LOOP_GOVERNOR_INPUT: LoopGovernorRunInput = {
  loopId: "LG-2026-07-05-001",
  taskId: "task-operator-review-001",
  state: "closed",
  evidence: [
    {
      label: "loop-iteration-summary",
      contentHash: "sha256:abc123def456789abc123def456789abc123def456789abc123def456789ab",
      recordedAt: "2026-07-05T09:00:00.000Z",
    },
    {
      label: "git-snapshot-abcd1234",
      contentHash: "sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
      recordedAt: "2026-07-05T09:15:00.000Z",
    },
  ],
  validation: {
    passed: true,
    gates: ["loop-invariant-check", "step-count-bound", "error-rate-threshold"],
    gateResults: {
      "loop-invariant-check": true,
      "step-count-bound": true,
      "error-rate-threshold": true,
    },
    summary:
      "[mock] All loop invariant checks passed. Steps within bounds. Error rate below threshold. Ready for review.",
    validatedAt: "2026-07-05T09:30:00.000Z",
  },
  stateTimestamps: {
    PLAN: "2026-07-05T08:00:00.000Z",
    EXECUTE: "2026-07-05T08:05:00.000Z",
    VALIDATE: "2026-07-05T09:15:00.000Z",
    EVIDENCE: "2026-07-05T09:25:00.000Z",
    HUMAN_REVIEW: "2026-07-05T09:45:00.000Z",
    COMPLETE: "2026-07-05T10:00:00.000Z",
  },
};
