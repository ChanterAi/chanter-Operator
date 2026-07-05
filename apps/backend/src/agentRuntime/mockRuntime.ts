// ── CHANTER Operator P1.1: Mock AgentRuntime Adapter ──
// Deterministic mock implementation of the AgentRuntime contract.
// No real execution, no external files, no network access.
// Produces deterministic lifecycle events, validation, and evidence.

import { randomUUID } from "node:crypto";
import type {
  AgentRuntime,
  AgentRunManifest,
  AgentRunLifecycleState,
  AgentRuntimeEvidenceRef,
  AgentRuntimeFailure,
  AgentRuntimeValidationResult,
} from "./types.js";
import {
  enforceTransition,
  verifyCompletedManifest,
  type AgentRuntimeContractError,
} from "./agentRuntimeContract.js";

/**
 * Mock AgentRuntime that:
 * - Accepts a run manifest
 * - Progresses through each lifecycle state in order
 * - Emits deterministic validation results
 * - Produces deterministic evidence references
 * - Never touches external files or network
 * - Every run is serializable as JSON
 */
export class MockAgentRuntime implements AgentRuntime {
  /**
   * Execute a full run through all lifecycle states.
   * Returns the completed manifest with validation and evidence.
   */
  async execute(manifest: AgentRunManifest): Promise<AgentRunManifest> {
    let current = structuredClone(manifest);

    // Progress through each state in order
    const progression: AgentRunLifecycleState[] = [
      "PLAN",
      "EXECUTE",
      "VALIDATE",
      "EVIDENCE",
      "HUMAN_REVIEW",
      "COMPLETE",
    ];

    for (const state of progression) {
      // Skip states already passed (e.g. PLAN on a fresh manifest)
      const currentIdx = progression.indexOf(current.lifecycleState);
      const targetIdx = progression.indexOf(state);
      if (targetIdx <= currentIdx) continue;

      try {
        current = this.transition(current, state);
      } catch (err) {
        // If a transition is invalid, record failure and stop
        current = this.#recordFailure(
          current,
          state,
          "TRANSITION_DENIED",
          err instanceof Error ? err.message : String(err),
        );
        return current;
      }
    }

    return current;
  }

  /**
   * Transition to the next lifecycle state.
   * Enforces valid transitions via the contract.
   */
  transition(
    manifest: AgentRunManifest,
    to: AgentRunLifecycleState,
  ): AgentRunManifest {
    const current = enforceTransition(manifest, to);

    // Perform state-specific work (mock)
    switch (to) {
      case "EXECUTE":
        return this.#mockExecute(current);
      case "VALIDATE":
        return this.#mockValidate(current);
      case "EVIDENCE":
        return this.#mockRecordEvidence(current);
      case "HUMAN_REVIEW":
        return this.#mockHumanReview(current);
      case "COMPLETE":
        return this.#mockComplete(current);
      default:
        return current;
    }
  }

  /**
   * Cancel an in-progress run.
   * Only allowed from states specified in the cancel policy.
   */
  cancel(manifest: AgentRunManifest): AgentRunManifest {
    const policy = manifest.policy.cancel;
    const currentState = manifest.lifecycleState;

    if (!policy.cancellable) {
      return this.#recordFailure(
        manifest,
        currentState,
        "CANCEL_NOT_ALLOWED",
        "Cancellation is not permitted by runtime policy.",
      );
    }

    if (!policy.cancellableStates.includes(currentState)) {
      return this.#recordFailure(
        manifest,
        currentState,
        "CANCEL_STATE_DENIED",
        "Cancellation not allowed from state: " + currentState,
      );
    }

    const now = new Date().toISOString();
    return {
      ...manifest,
      lifecycleState: currentState,
      failure: {
        failedAtState: currentState,
        code: "CANCELLED",
        message: "Run cancelled by operator during " + currentState + " state.",
        failedAt: now,
      },
      updatedAt: now,
    };
  }

  /**
   * Serialize a manifest to JSON.
   */
  serialize(manifest: AgentRunManifest): string {
    return JSON.stringify(manifest, null, 2);
  }

  /**
   * Deserialize a JSON string back to a manifest.
   */
  deserialize(json: string): AgentRunManifest {
    const parsed = JSON.parse(json) as AgentRunManifest;

    // Validate basic structure
    if (!parsed.runtimeId || !parsed.productId || !parsed.taskId) {
      throw new Error("Invalid manifest JSON: missing required fields (runtimeId, productId, taskId)");
    }
    if (!parsed.lifecycleState) {
      throw new Error("Invalid manifest JSON: missing lifecycleState");
    }
    if (!parsed.stateTimestamps) {
      throw new Error("Invalid manifest JSON: missing stateTimestamps");
    }

    return parsed;
  }

  // ── Private mock methods ──

  #mockExecute(manifest: AgentRunManifest): AgentRunManifest {
    return {
      ...manifest,
      lifecycleState: "EXECUTE",
    };
  }

  #mockValidate(manifest: AgentRunManifest): AgentRunManifest {
    const now = new Date().toISOString();
    const validation: AgentRuntimeValidationResult = {
      passed: true,
      gates: ["typecheck", "test", "build", "diff-check"],
      gateResults: {
        typecheck: true,
        test: true,
        build: true,
        "diff-check": true,
      },
      summary:
        "[mock-runtime] All validation gates passed. Typecheck: ok. Tests: all passing. Build: success. Diff-check: clean.",
      validatedAt: now,
    };

    return {
      ...manifest,
      lifecycleState: "VALIDATE",
      validation,
      updatedAt: now,
    };
  }

  #mockRecordEvidence(manifest: AgentRunManifest): AgentRunManifest {
    const now = new Date().toISOString();
    const evidence: AgentRuntimeEvidenceRef[] = [
      {
        id: randomUUID(),
        recordedAtState: "EVIDENCE",
        label: "mock-execution-stdout",
        contentHash: this.#hash(
          "[mock-runtime] Execution completed. No real runner was invoked.",
        ),
        recordedAt: now,
      },
      {
        id: randomUUID(),
        recordedAtState: "EVIDENCE",
        label: "mock-validation-summary",
        contentHash: this.#hash(
          manifest.validation?.summary ?? "No validation result",
        ),
        recordedAt: now,
      },
    ];

    return {
      ...manifest,
      lifecycleState: "EVIDENCE",
      evidence: [...manifest.evidence, ...evidence],
      updatedAt: now,
    };
  }

  #mockHumanReview(manifest: AgentRunManifest): AgentRunManifest {
    return {
      ...manifest,
      lifecycleState: "HUMAN_REVIEW",
    };
  }

  #mockComplete(manifest: AgentRunManifest): AgentRunManifest {
    const now = new Date().toISOString();

    // Verify contract before completing
    const verification = verifyCompletedManifest({
      ...manifest,
      lifecycleState: "COMPLETE",
    });

    if (!verification.valid) {
      return this.#recordFailure(
        manifest,
        "COMPLETE",
        "COMPLETE_VERIFICATION_FAILED",
        verification.violations.join("; "),
      );
    }

    return {
      ...manifest,
      lifecycleState: "COMPLETE",
      updatedAt: now,
    };
  }

  #recordFailure(
    manifest: AgentRunManifest,
    failedAtState: AgentRunLifecycleState,
    code: string,
    message: string,
    detail?: string,
  ): AgentRunManifest {
    const now = new Date().toISOString();
    const failure: AgentRuntimeFailure = {
      failedAtState,
      code,
      message,
      detail,
      failedAt: now,
    };

    return {
      ...manifest,
      failure,
      updatedAt: now,
    };
  }

  /** Simple deterministic hash for content integrity. */
  #hash(input: string): string {
    let h = 0;
    for (let i = 0; i < input.length; i++) {
      h = (Math.imul(31, h) + input.charCodeAt(i)) | 0;
    }
    return "mock-" + (h >>> 0).toString(16).padStart(8, "0");
  }
}
