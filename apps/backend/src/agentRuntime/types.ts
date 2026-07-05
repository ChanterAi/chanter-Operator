// ── CHANTER Operator P1.1: Agent Runtime Contract ──
// Shared runtime types across all CHANTER products.
// Current: contract/mock only. No real runner integration yet.

/**
 * Ordered lifecycle states every agent run must pass through.
 *
 * PLAN     → task decomposed, inputs validated.
 * EXECUTE  → work is performed (mock-only for now).
 * VALIDATE → automated validation gates run.
 * EVIDENCE → traceable references recorded.
 * HUMAN_REVIEW → review step before completion.
 * COMPLETE → final terminal state.
 */
export const AgentRunLifecycleStates = [
  "PLAN",
  "EXECUTE",
  "VALIDATE",
  "EVIDENCE",
  "HUMAN_REVIEW",
  "COMPLETE",
] as const;

export type AgentRunLifecycleState = (typeof AgentRunLifecycleStates)[number];

// ── Runtime policy types ──

/** How the runtime handles timeouts. */
export type AgentRuntimeTimeoutPolicy = {
  /** Maximum milliseconds a run may spend in a given state. */
  maxStateMs: number;
  /** Total cap (ms) for the entire run across all states. */
  maxTotalMs: number;
};

/** How the runtime handles retries. */
export type AgentRuntimeRetryPolicy = {
  /** Maximum number of retry attempts for a failed state. */
  maxRetries: number;
  /** Delay between retries (ms). */
  retryDelayMs: number;
  /** States that are safe to retry without side effects. */
  retryableStates: AgentRunLifecycleState[];
};

/** How the runtime handles cancellation. */
export type AgentRuntimeCancelPolicy = {
  /** Whether cancellation is allowed during execution. */
  cancellable: boolean;
  /** States in which cancellation is permitted. */
  cancellableStates: AgentRunLifecycleState[];
  /** Cleanup action on cancel (e.g. rollback, log, no-op). */
  cleanupAction: "noop" | "rollback" | "log_only";
};

/** Combined runtime policy for a run. */
export interface AgentRuntimePolicy {
  timeout: AgentRuntimeTimeoutPolicy;
  retry: AgentRuntimeRetryPolicy;
  cancel: AgentRuntimeCancelPolicy;
}

// ── Evidence references ──

/** A single piece of evidence produced during a run. */
export interface AgentRuntimeEvidenceRef {
  /** Unique evidence identifier. */
  id: string;
  /** The lifecycle state during which this evidence was recorded. */
  recordedAtState: AgentRunLifecycleState;
  /** Human-readable label (e.g. "npm test output", "typecheck exit code"). */
  label: string;
  /** Content hash for integrity verification. */
  contentHash: string;
  /** ISO-8601 timestamp of recording. */
  recordedAt: string;
}

// ── Validation ──

/** Outcome of the VALIDATE state. */
export interface AgentRuntimeValidationResult {
  /** Whether all validation gates passed. */
  passed: boolean;
  /** Ordered list of gate names that were checked. */
  gates: string[];
  /** Per-gate results (gate name → pass/fail). */
  gateResults: Record<string, boolean>;
  /** Human-readable summary of validation. */
  summary: string;
  /** ISO-8601 timestamp of validation completion. */
  validatedAt: string;
}

// ── Failure ──

/** Structured failure record for a run. */
export interface AgentRuntimeFailure {
  /** The state during which the failure occurred. */
  failedAtState: AgentRunLifecycleState;
  /** Machine-readable error code. */
  code: string;
  /** Human-readable error message. */
  message: string;
  /** Optional stack or detail. */
  detail?: string;
  /** ISO-8601 timestamp of failure. */
  failedAt: string;
}

// ── Run manifest ──

/**
 * Serializable manifest that represents one complete agent run.
 * Every run MUST be representable as JSON.
 */
export interface AgentRunManifest {
  /** Unique identifier for this runtime invocation. */
  runtimeId: string;
  /** CHANTER product that initiated the run (e.g. "AutoPoster", "Loop Governor"). */
  productId: string;
  /** User-facing task identifier. */
  taskId: string;
  /** Current lifecycle state. */
  lifecycleState: AgentRunLifecycleState;
  /** ISO-8601 timestamps for when each state was entered. */
  stateTimestamps: Record<AgentRunLifecycleState, string | null>;
  /** Runtime policy governing this run. */
  policy: AgentRuntimePolicy;
  /** Evidence references produced so far. */
  evidence: AgentRuntimeEvidenceRef[];
  /** Validation result (populated after VALIDATE state). */
  validation: AgentRuntimeValidationResult | null;
  /** Failure record if the run failed. */
  failure: AgentRuntimeFailure | null;
  /** ISO-8601 when the manifest was created. */
  createdAt: string;
  /** ISO-8601 when the manifest was last updated. */
  updatedAt: string;
}

// ── Agent Runtime interface ──

/**
 * The shared AgentRuntime contract that every CHANTER product can implement.
 *
 * Loop Governor, SafeCommit, AutoPoster, Clean Engine, and future products
 * all implement this same interface so that Operator can orchestrate them
 * through a consistent lifecycle without knowing product internals.
 */
export interface AgentRuntime {
  /**
   * Accept a run manifest and begin execution.
   * Returns the updated manifest after completion (or failure).
   */
  execute(manifest: AgentRunManifest): Promise<AgentRunManifest>;

  /**
   * Transition the run to the next lifecycle state.
   * The runtime enforces valid transitions; invalid transitions throw.
   */
  transition(
    manifest: AgentRunManifest,
    to: AgentRunLifecycleState,
  ): AgentRunManifest;

  /**
   * Cancel an in-progress run.
   * Only permitted when the cancel policy allows it.
   */
  cancel(manifest: AgentRunManifest): AgentRunManifest;

  /**
   * Serialize the current manifest to JSON.
   */
  serialize(manifest: AgentRunManifest): string;

  /**
   * Deserialize a JSON string back to a manifest.
   */
  deserialize(json: string): AgentRunManifest;
}

// ── Default policy ──

/** Sensible defaults for a mock/development runtime. */
export const DEFAULT_RUNTIME_POLICY: AgentRuntimePolicy = {
  timeout: {
    maxStateMs: 30_000,
    maxTotalMs: 300_000,
  },
  retry: {
    maxRetries: 3,
    retryDelayMs: 1_000,
    retryableStates: ["EXECUTE", "VALIDATE"],
  },
  cancel: {
    cancellable: true,
    cancellableStates: ["PLAN", "EXECUTE", "VALIDATE"],
    cleanupAction: "log_only",
  },
};
