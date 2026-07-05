// ── CHANTER Operator P1.1: Agent Runtime Contract Enforcement ──
// Lifecycle transition validator and contract enforcement.
// Enforces ordered state progression: PLAN → EXECUTE → VALIDATE → EVIDENCE → HUMAN_REVIEW → COMPLETE.

import type { AgentRunLifecycleState, AgentRunManifest } from "./types.js";

/**
 * Canonical lifecycle progression.
 * Only forward transitions are valid; backward transitions are rejected
 * unless the retry policy explicitly permits returning to an earlier state.
 */
const LIFECYCLE_ORDER: readonly AgentRunLifecycleState[] = [
  "PLAN",
  "EXECUTE",
  "VALIDATE",
  "EVIDENCE",
  "HUMAN_REVIEW",
  "COMPLETE",
];

/** Index lookup for O(1) position comparison. */
const STATE_INDEX = new Map<AgentRunLifecycleState, number>(
  LIFECYCLE_ORDER.map((s, i) => [s, i]),
);

/**
 * Check whether a transition from → to is valid.
 *
 * Forward transitions are always valid (current → next or later).
 * COMPLETE is terminal — no transitions out.
 * Backward transitions require retry policy to allow the target state.
 */
export function isValidTransition(
  from: AgentRunLifecycleState,
  to: AgentRunLifecycleState,
  retryableStates: AgentRunLifecycleState[] = [],
): boolean {
  // COMPLETE and HUMAN_REVIEW are terminal — no transitions out
  // (HUMAN_REVIEW needs explicit approval to reach COMPLETE; once at COMPLETE, no further transitions)
  if (from === "COMPLETE") return false;

  // HUMAN_REVIEW → COMPLETE is the only valid exit from HUMAN_REVIEW
  if (from === "HUMAN_REVIEW") return to === "COMPLETE";

  const fromIdx = STATE_INDEX.get(from);
  const toIdx = STATE_INDEX.get(to);
  if (fromIdx === undefined || toIdx === undefined) return false;

  // Forward (or same) is always allowed
  if (toIdx >= fromIdx) return true;

  // Backward only allowed for explicit retry states
  return retryableStates.includes(to);
}

/**
 * Enforce a lifecycle transition on a manifest.
 * Throws on invalid transitions.
 */
export function enforceTransition(
  manifest: AgentRunManifest,
  to: AgentRunLifecycleState,
): AgentRunManifest {
  if (!isValidTransition(manifest.lifecycleState, to, manifest.policy.retry.retryableStates)) {
    throw new AgentRuntimeContractError(
      "Invalid lifecycle transition: " +
        manifest.lifecycleState +
        " → " +
        to +
        ". Forward transitions only; backward requires retry policy allowance.",
    );
  }

  const now = new Date().toISOString();
  const updated: AgentRunManifest = {
    ...manifest,
    lifecycleState: to,
    stateTimestamps: {
      ...manifest.stateTimestamps,
      [to]: now,
    },
    updatedAt: now,
  };

  return updated;
}

/**
 * Verify that a completed manifest satisfies all contract requirements:
 * 1. State is COMPLETE.
 * 2. Validation result is attached.
 * 3. Evidence references are present.
 * 4. State timestamps are in correct order.
 * 5. No unexpected null timestamps between states.
 */
export function verifyCompletedManifest(
  manifest: AgentRunManifest,
): { valid: boolean; violations: string[] } {
  const violations: string[] = [];

  if (manifest.lifecycleState !== "COMPLETE") {
    violations.push("Expected lifecycleState COMPLETE, got " + manifest.lifecycleState);
  }

  if (!manifest.validation) {
    violations.push("Validation result missing — must be attached before COMPLETE");
  } else if (!manifest.validation.passed) {
    violations.push(
      "Validation did not pass. Gates: " +
        Object.entries(manifest.validation.gateResults)
          .filter(([, ok]) => !ok)
          .map(([g]) => g)
          .join(", "),
    );
  }

  if (manifest.evidence.length === 0) {
    violations.push("Evidence references missing — at least one evidence ref is required");
  }

  // Verify timestamp order
  let lastTs = "";
  for (const state of LIFECYCLE_ORDER) {
    const ts = manifest.stateTimestamps[state];
    if (ts === null) {
      violations.push("State timestamp missing for " + state);
    } else if (ts < lastTs) {
      violations.push(
        "Timestamp out of order: " + state + " (" + ts + ") is before previous state (" + lastTs + ")",
      );
    }
    lastTs = ts ?? lastTs;
  }

  return { valid: violations.length === 0, violations };
}

/**
 * Verify manifest serialization round-trips correctly.
 * Returns the deserialized manifest and any differences from the original.
 */
export function verifySerialization(
  manifest: AgentRunManifest,
): { valid: boolean; deserialized: AgentRunManifest; issues: string[] } {
  const issues: string[] = [];

  let serialized: string;
  try {
    serialized = JSON.stringify(manifest, null, 2);
  } catch (err) {
    return {
      valid: false,
      deserialized: manifest,
      issues: ["Serialization failed: " + String(err)],
    };
  }

  let deserialized: AgentRunManifest;
  try {
    deserialized = JSON.parse(serialized) as AgentRunManifest;
  } catch (err) {
    return {
      valid: false,
      deserialized: manifest,
      issues: ["Deserialization failed: " + String(err)],
    };
  }

  // Key fields must match
  if (deserialized.runtimeId !== manifest.runtimeId) {
    issues.push("runtimeId mismatch after round-trip");
  }
  if (deserialized.productId !== manifest.productId) {
    issues.push("productId mismatch after round-trip");
  }
  if (deserialized.taskId !== manifest.taskId) {
    issues.push("taskId mismatch after round-trip");
  }
  if (deserialized.lifecycleState !== manifest.lifecycleState) {
    issues.push("lifecycleState mismatch after round-trip");
  }
  if (deserialized.evidence.length !== manifest.evidence.length) {
    issues.push("evidence count mismatch after round-trip");
  }
  if (deserialized.validation?.passed !== manifest.validation?.passed) {
    issues.push("validation.passed mismatch after round-trip");
  }
  if (deserialized.failure?.code !== manifest.failure?.code) {
    issues.push("failure.code mismatch after round-trip");
  }

  return { valid: issues.length === 0, deserialized, issues };
}

/**
 * Build a fresh, empty manifest with placeholder null timestamps.
 */
export function createEmptyManifest(
  overrides: {
    runtimeId?: string;
    productId?: string;
    taskId?: string;
  } = {},
): AgentRunManifest {
  const now = new Date().toISOString();
  const nullTimestamps: Record<AgentRunLifecycleState, string | null> = {
    PLAN: null,
    EXECUTE: null,
    VALIDATE: null,
    EVIDENCE: null,
    HUMAN_REVIEW: null,
    COMPLETE: null,
  };

  return {
    runtimeId: overrides.runtimeId ?? "rt-" + crypto.randomUUID(),
    productId: overrides.productId ?? "CHANTER Operator",
    taskId: overrides.taskId ?? "task-" + crypto.randomUUID(),
    lifecycleState: "PLAN",
    stateTimestamps: { ...nullTimestamps, PLAN: now },
    policy: {
      timeout: { maxStateMs: 30_000, maxTotalMs: 300_000 },
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
    },
    evidence: [],
    validation: null,
    failure: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Error class for contract violations. */
export class AgentRuntimeContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRuntimeContractError";
  }
}
