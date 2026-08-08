/**
 * CHANTER OS — closed-world agentic capability registry.
 *
 * One capability is one *bounded kind of work* the fabric knows how to do, with
 * its contract fully declared before any plan references it: what it accepts,
 * what it must return, what risk it carries, whether a human must authorize it,
 * what it may spend, which tools it may reach, and how an ambiguous outcome is
 * resolved.
 *
 * Registration is a reviewed code change, never data. That is the whole point:
 * a capability that could be added at runtime is a capability an agent could add
 * for itself, and "the model decided it needed one more tool" is precisely the
 * failure this registry exists to make impossible.
 *
 * Two properties are enforced at module load rather than at first use, because
 * the only safe moment to discover a malformed capability is before the process
 * accepts traffic:
 *
 *   - every capability's `allowedTools` are drawn from the closed tool registry
 *     below, so no capability can name a tool nothing implements;
 *   - no capability whose risk class is `external_write` or `irreversible` may
 *     be registered at all in this P0 — those are refused structurally, not by
 *     a policy flag that a later edit could quietly flip.
 *
 * ## Relationship to the OS lane registry
 *
 * `osMissionContract.ts` registers *lanes* — how a mission enters and who owns
 * its downstream authority. This registers *capabilities* — the units of work a
 * compiled plan may contain. They are different axes and must not be merged: a
 * lane has one downstream authority, whereas one agentic mission legitimately
 * spans seven capabilities owned by three different subsystems.
 */
import type {
  AgenticNodeBudget,
  AgenticNodeEvidencePolicy,
  AgenticOutputSchema,
  AgenticRiskClass,
  AgenticSideEffectClass,
  AgenticVerifiabilityClass,
  AgenticWorkerKind,
} from "chanter-agent-runtime";
import type { AgenticExecutionPolicy } from "./agenticMissionContract.js";

// ---------------------------------------------------------------------------
// Closed tool registry
// ---------------------------------------------------------------------------

/**
 * Every tool any worker in this fabric may reach.
 *
 * All are read-only except `artifact.local.write` and `connector.state.apply`,
 * which are the only two consequential effects the plans are built to gate — one
 * per mission kind, and each reachable from exactly one capability. There is
 * deliberately no shell tool, no network tool, and no general filesystem tool: a
 * worker cannot be given a capability that was never implemented.
 */
export const AGENTIC_TOOLS = [
  "repo.metadata.read",
  "repo.file.read",
  "test.result.read",
  "operator.mission.state.read",
  "fixture.read",
  "artifact.local.read",
  "artifact.local.write",
  "connector.manifest.read",
  "connector.state.read",
  "connector.action.read",
  "connector.state.apply",
  /**
   * The compensating delete, as its own tool.
   *
   * Separate from `connector.state.apply` so a capability can be granted the
   * power to undo without being granted the power to write, and vice versa. A
   * single "mutate" tool would make the compensation node as dangerous as the
   * action node it exists to reverse.
   */
  "connector.state.compensate",
] as const;

export type AgenticToolName = (typeof AGENTIC_TOOLS)[number];

const TOOL_NAMES: ReadonlySet<string> = new Set<string>(AGENTIC_TOOLS);

/** How a capability's ambiguous outcome must be resolved before any retry. */
export type AgenticReconciliationMode =
  /** Re-read the durable worker record; retry only when provably absent. */
  | "worker_record_lookup_before_retry"
  /** Re-read the written artifact and its hash; never rewrite speculatively. */
  | "artifact_lookup_before_retry"
  /**
   * Ask the connector whether this exact idempotency key was already applied.
   *
   * Distinct from the artifact mode because the authority is different: an
   * artifact is re-read from a filesystem this fabric owns, whereas this asks
   * the system that would have performed the action. Only it knows whether the
   * action landed during the window where nothing upstream committed.
   */
  | "connector_action_lookup_before_retry";

/** Whether a human must authorize this capability before it may execute. */
export type AgenticAuthorityRequirement =
  | "none"
  | "human_approval_bound_to_candidate_hash";

export interface AgenticCapability {
  readonly capabilityId: string;
  /** The subsystem that owns this capability's behaviour and its contract. */
  readonly owner: "operator" | "agent_runtime" | "loop_governor";
  readonly description: string;
  readonly inputSchema: AgenticOutputSchema;
  readonly outputSchema: AgenticOutputSchema;
  readonly riskClass: AgenticRiskClass;
  readonly authorityRequirement: AgenticAuthorityRequirement;
  readonly defaultBudget: AgenticNodeBudget;
  /**
   * The budget this capability runs under when a mission routes it to a model,
   * or `null` when it can never be one.
   *
   * Declared separately from `defaultBudget` rather than replacing it, because
   * the two are genuinely different costs: a structured local worker answers in
   * milliseconds and spends no tokens, while a provider-backed one needs a
   * wall-clock window measured in minutes and a token ceiling. Folding them into
   * one number would either starve the model node or inflate the cheapest
   * possible plan's declared minimum, and both are wrong.
   */
  readonly modelWorkerBudget: AgenticNodeBudget | null;
  readonly verifiability: AgenticVerifiabilityClass;
  readonly allowedTools: readonly AgenticToolName[];
  /**
   * Worker kinds that can satisfy this capability, in the router's preference
   * order: cheapest and most deterministic first. See `agenticCapabilityRouter`.
   */
  readonly allowedWorkerKinds: readonly AgenticWorkerKind[];
  readonly sideEffectClass: AgenticSideEffectClass;
  readonly reconciliationMode: AgenticReconciliationMode;
  readonly evidencePolicy: AgenticNodeEvidencePolicy;
}

// ---------------------------------------------------------------------------
// Shared schema fragments
// ---------------------------------------------------------------------------

const CLAIM_SCHEMA: AgenticOutputSchema = {
  kind: "object",
  fields: {
    claimId: { kind: "string", minLength: 1, maxLength: 64 },
    statement: { kind: "string", minLength: 1, maxLength: 600 },
    confidence: { kind: "enum", values: ["high", "medium", "low"] },
    evidenceRefs: { kind: "array", items: { kind: "string", minLength: 1, maxLength: 200 }, minItems: 1, maxItems: 8 },
  },
};

/**
 * An accepted claim keeps the node that produced it. Synthesis groups by that
 * field rather than by parsing claim ids, so a renamed id changes nothing about
 * which section a finding lands in.
 */
const ACCEPTED_CLAIM_SCHEMA: AgenticOutputSchema = {
  kind: "object",
  fields: {
    claimId: { kind: "string", minLength: 1, maxLength: 64 },
    statement: { kind: "string", minLength: 1, maxLength: 600 },
    confidence: { kind: "enum", values: ["high", "medium", "low"] },
    evidenceRefs: { kind: "array", items: { kind: "string", minLength: 1, maxLength: 200 }, minItems: 1, maxItems: 8 },
    sourceNodeId: { kind: "string", minLength: 1, maxLength: 64 },
  },
};

const CONTEXT_INPUT_SCHEMA: AgenticOutputSchema = {
  kind: "object",
  fields: {
    contextBundleId: { kind: "string", minLength: 1, maxLength: 200 },
    acceptedContextIds: {
      kind: "array",
      items: { kind: "string", minLength: 1, maxLength: 200 },
      minItems: 1,
      maxItems: 64,
    },
    focus: { kind: "string", minLength: 1, maxLength: 200 },
  },
};

const CLAIM_SET_SCHEMA: AgenticOutputSchema = {
  kind: "object",
  fields: {
    claims: { kind: "array", items: CLAIM_SCHEMA, minItems: 1, maxItems: 16 },
  },
};

function budget(overrides: Partial<AgenticNodeBudget>): AgenticNodeBudget {
  return {
    maxToolCalls: 8,
    maxModelCalls: 0,
    maxDurationMs: 30_000,
    maxTokens: null,
    maxCostMicros: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * Contextual typing gate. Wrapping each entry means every schema literal below
 * is checked against `AgenticOutputSchema` as it is written, so a mistyped
 * `kind` is a compile error at the offending capability rather than one
 * unreadable error about the whole array.
 */
function capability(entry: AgenticCapability): AgenticCapability {
  return Object.freeze(entry);
}

const CAPABILITIES: readonly AgenticCapability[] = Object.freeze([
  capability({
    capabilityId: "repo.metadata.read",
    owner: "operator" as const,
    description: "Collects verified repository state (branch, HEAD, cleanliness) as context items.",
    inputSchema: {
      kind: "object",
      fields: {
        requirementIds: {
          kind: "array",
          items: { kind: "string", minLength: 1, maxLength: 200 },
          minItems: 1,
          maxItems: 32,
        },
      },
    },
    outputSchema: {
      kind: "object",
      fields: {
        contextBundleId: { kind: "string", minLength: 1, maxLength: 200 },
        acceptedContextIds: {
          kind: "array",
          items: { kind: "string", minLength: 1, maxLength: 200 },
          minItems: 1,
          maxItems: 64,
        },
        rejectedRequirementIds: {
          kind: "array",
          items: { kind: "string", minLength: 1, maxLength: 200 },
          maxItems: 32,
        },
      },
    },
    riskClass: "read_only" as const,
    authorityRequirement: "none" as const,
    defaultBudget: budget({ maxToolCalls: 16, maxDurationMs: 20_000 }),
    modelWorkerBudget: null,
    verifiability: "deterministic" as const,
    allowedTools: ["repo.metadata.read", "repo.file.read", "test.result.read", "operator.mission.state.read", "fixture.read"] as const,
    allowedWorkerKinds: ["deterministic_tool"] as const,
    sideEffectClass: "none" as const,
    reconciliationMode: "worker_record_lookup_before_retry" as const,
    evidencePolicy: { minimumItems: 1, requireAcceptedContextReference: true },
  }),
  capability({
    capabilityId: "repo.file.read",
    // Registered because the P0 names it as a required capability. This proof
    // mission reaches repository files through N1's `repo.file.read` *tool*
    // rather than routing a separate node to this capability, so it is
    // available and contract-complete without being exercised as a node here.
    owner: "operator" as const,
    description: "Reads one approved repository file into a hashed context item.",
    inputSchema: {
      kind: "object",
      fields: { path: { kind: "string", minLength: 1, maxLength: 400 } },
    },
    outputSchema: {
      kind: "object",
      fields: {
        contextItemId: { kind: "string", minLength: 1, maxLength: 200 },
        contentHash: { kind: "string", minLength: 64, maxLength: 64 },
      },
    },
    riskClass: "read_only" as const,
    authorityRequirement: "none" as const,
    defaultBudget: budget({ maxToolCalls: 2, maxDurationMs: 10_000 }),
    modelWorkerBudget: null,
    verifiability: "deterministic" as const,
    allowedTools: ["repo.file.read"] as const,
    allowedWorkerKinds: ["deterministic_tool"] as const,
    sideEffectClass: "none" as const,
    reconciliationMode: "worker_record_lookup_before_retry" as const,
    evidencePolicy: { minimumItems: 1, requireAcceptedContextReference: false },
  }),
  capability({
    capabilityId: "architecture.analyze",
    owner: "agent_runtime" as const,
    description: "Produces evidence-cited structural claims about the OS control plane.",
    inputSchema: CONTEXT_INPUT_SCHEMA,
    outputSchema: CLAIM_SET_SCHEMA,
    riskClass: "read_only" as const,
    authorityRequirement: "none" as const,
    defaultBudget: budget({ maxToolCalls: 8, maxModelCalls: 1, maxDurationMs: 45_000 }),
    modelWorkerBudget: budget({
      // No tool at all. The provider call is the Runtime's bounded execution
      // port, not something the model may reach for.
      maxToolCalls: 0,
      // One primary dispatch plus one declared fallback. Not a retry budget:
      // an unknown outcome consumes neither, because it is never re-attempted.
      maxModelCalls: 2,
      // A local model answers in tens of seconds, not milliseconds. The window
      // is wall clock for the whole node, and the Governor's plan deadline still
      // caps the plan.
      maxDurationMs: 240_000,
      maxTokens: 8_192,
      maxCostMicros: null,
    }),
    verifiability: "evidence_verifiable" as const,
    allowedTools: ["fixture.read"] as const,
    allowedWorkerKinds: ["structured_local_worker", "model_worker"] as const,
    sideEffectClass: "none" as const,
    reconciliationMode: "worker_record_lookup_before_retry" as const,
    evidencePolicy: { minimumItems: 1, requireAcceptedContextReference: true },
  }),
  capability({
    capabilityId: "risk.analyze",
    owner: "agent_runtime" as const,
    description: "Produces evidence-cited claims about execution, authority, and recovery risk.",
    inputSchema: CONTEXT_INPUT_SCHEMA,
    outputSchema: CLAIM_SET_SCHEMA,
    riskClass: "read_only" as const,
    authorityRequirement: "none" as const,
    defaultBudget: budget({ maxToolCalls: 8, maxModelCalls: 1, maxDurationMs: 45_000 }),
    modelWorkerBudget: budget({
      // No tool at all. The provider call is the Runtime's bounded execution
      // port, not something the model may reach for.
      maxToolCalls: 0,
      // One primary dispatch plus one declared fallback. Not a retry budget:
      // an unknown outcome consumes neither, because it is never re-attempted.
      maxModelCalls: 2,
      // A local model answers in tens of seconds, not milliseconds. The window
      // is wall clock for the whole node, and the Governor's plan deadline still
      // caps the plan.
      maxDurationMs: 240_000,
      maxTokens: 8_192,
      maxCostMicros: null,
    }),
    verifiability: "evidence_verifiable" as const,
    allowedTools: ["fixture.read"] as const,
    allowedWorkerKinds: ["structured_local_worker", "model_worker"] as const,
    sideEffectClass: "none" as const,
    reconciliationMode: "worker_record_lookup_before_retry" as const,
    evidencePolicy: { minimumItems: 1, requireAcceptedContextReference: true },
  }),
  capability({
    capabilityId: "evidence.verify",
    owner: "operator" as const,
    description: "Independently accepts or rejects specialist claims against admitted context.",
    inputSchema: {
      kind: "object",
      fields: {
        contextBundleId: { kind: "string", minLength: 1, maxLength: 200 },
        acceptedContextIds: {
          kind: "array",
          items: { kind: "string", minLength: 1, maxLength: 200 },
          minItems: 1,
          maxItems: 64,
        },
        claimSets: {
          kind: "array",
          items: {
            kind: "object",
            fields: {
              nodeId: { kind: "string", minLength: 1, maxLength: 64 },
              claims: { kind: "array", items: CLAIM_SCHEMA, minItems: 1, maxItems: 16 },
            },
          },
          minItems: 2,
          maxItems: 8,
        },
      },
    },
    outputSchema: {
      kind: "object",
      fields: {
        verificationVerdict: { kind: "enum", values: ["accepted", "accepted_with_rejections", "failed"] },
        acceptedClaims: { kind: "array", items: ACCEPTED_CLAIM_SCHEMA, maxItems: 32 },
        rejectedClaims: {
          kind: "array",
          items: {
            kind: "object",
            fields: {
              claimId: { kind: "string", minLength: 1, maxLength: 64 },
              statement: { kind: "string", minLength: 1, maxLength: 600 },
              reason: {
                kind: "enum",
                values: ["unsupported_evidence", "contradicts_peer_claim", "schema_invalid"],
              },
            },
          },
          maxItems: 32,
        },
        contradictions: {
          kind: "array",
          items: {
            kind: "object",
            fields: {
              leftClaimId: { kind: "string", minLength: 1, maxLength: 64 },
              rightClaimId: { kind: "string", minLength: 1, maxLength: 64 },
              severity: { kind: "enum", values: ["critical", "advisory"] },
            },
          },
          maxItems: 16,
        },
        missingEvidence: { kind: "array", items: { kind: "string", minLength: 1, maxLength: 200 }, maxItems: 32 },
        confidenceByClaim: {
          kind: "array",
          items: {
            kind: "object",
            fields: {
              claimId: { kind: "string", minLength: 1, maxLength: 64 },
              confidence: { kind: "enum", values: ["high", "medium", "low"] },
            },
          },
          maxItems: 32,
        },
      },
    },
    riskClass: "read_only" as const,
    authorityRequirement: "none" as const,
    defaultBudget: budget({ maxToolCalls: 0, maxDurationMs: 20_000 }),
    modelWorkerBudget: null,
    verifiability: "deterministic" as const,
    allowedTools: [] as const,
    allowedWorkerKinds: ["deterministic_tool"] as const,
    sideEffectClass: "none" as const,
    reconciliationMode: "worker_record_lookup_before_retry" as const,
    evidencePolicy: { minimumItems: 1, requireAcceptedContextReference: true },
  }),
  capability({
    capabilityId: "result.synthesize",
    owner: "operator" as const,
    description: "Composes a candidate result from accepted claims only. Writes nothing.",
    inputSchema: {
      kind: "object",
      fields: {
        acceptedClaims: { kind: "array", items: ACCEPTED_CLAIM_SCHEMA, minItems: 1, maxItems: 32 },
        requiredSections: {
          kind: "array",
          items: { kind: "string", minLength: 1, maxLength: 120 },
          minItems: 1,
          maxItems: 16,
        },
        acceptanceCriteria: {
          kind: "array",
          items: {
            kind: "object",
            fields: {
              criterionId: { kind: "string", minLength: 1, maxLength: 64 },
              statement: { kind: "string", minLength: 1, maxLength: 400 },
              check: {
                kind: "enum",
                values: [
                  "artifact_section_present",
                  "evidence_coverage_minimum",
                  "no_rejected_claim_present",
                  "human_judgment",
                ],
              },
              parameter: { kind: "string", maxLength: 200 },
            },
          },
          minItems: 1,
          maxItems: 16,
        },
        remainingUncertainty: {
          kind: "array",
          items: { kind: "string", minLength: 1, maxLength: 400 },
          maxItems: 16,
        },
      },
    },
    outputSchema: {
      kind: "object",
      fields: {
        executiveSummary: { kind: "string", minLength: 1, maxLength: 2000 },
        architectureFindings: { kind: "array", items: { kind: "string", minLength: 1, maxLength: 600 }, maxItems: 32 },
        riskFindings: { kind: "array", items: { kind: "string", minLength: 1, maxLength: 600 }, maxItems: 32 },
        recommendedActions: { kind: "array", items: { kind: "string", minLength: 1, maxLength: 600 }, maxItems: 32 },
        evidenceIndex: { kind: "array", items: { kind: "string", minLength: 1, maxLength: 200 }, minItems: 1, maxItems: 64 },
        remainingUncertainty: { kind: "array", items: { kind: "string", minLength: 1, maxLength: 400 }, maxItems: 16 },
        acceptanceEvaluation: {
          kind: "array",
          items: {
            kind: "object",
            fields: {
              criterionId: { kind: "string", minLength: 1, maxLength: 64 },
              passed: { kind: "boolean" },
              detail: { kind: "string", minLength: 1, maxLength: 400 },
            },
          },
          minItems: 1,
          maxItems: 16,
        },
        sourceClaimIds: { kind: "array", items: { kind: "string", minLength: 1, maxLength: 64 }, minItems: 1, maxItems: 32 },
      },
    },
    riskClass: "read_only" as const,
    authorityRequirement: "none" as const,
    defaultBudget: budget({ maxToolCalls: 0, maxDurationMs: 20_000 }),
    modelWorkerBudget: null,
    verifiability: "evidence_verifiable" as const,
    allowedTools: [] as const,
    allowedWorkerKinds: ["deterministic_tool"] as const,
    sideEffectClass: "none" as const,
    reconciliationMode: "worker_record_lookup_before_retry" as const,
    evidencePolicy: { minimumItems: 1, requireAcceptedContextReference: true },
  }),
  capability({
    capabilityId: "artifact.local.write",
    owner: "operator" as const,
    description: "Writes exactly one approved local artifact, atomically, inside an allowlisted directory.",
    inputSchema: {
      kind: "object",
      fields: {
        artifactName: { kind: "string", minLength: 1, maxLength: 200 },
        candidateHash: { kind: "string", minLength: 64, maxLength: 64 },
        approvalId: { kind: "string", minLength: 1, maxLength: 200 },
      },
    },
    outputSchema: {
      kind: "object",
      fields: {
        artifactName: { kind: "string", minLength: 1, maxLength: 200 },
        artifactHash: { kind: "string", minLength: 64, maxLength: 64 },
        bytesWritten: { kind: "number", minimum: 1, integer: true },
        writeCount: { kind: "number", minimum: 1, maximum: 1, integer: true },
      },
    },
    riskClass: "local_write" as const,
    // The one consequential capability in this P0, and the only one carrying an
    // authority requirement. It is declared here, on the capability, so the plan
    // compiler reads authority from a reviewed contract rather than inferring it
    // from a node's name.
    authorityRequirement: "human_approval_bound_to_candidate_hash" as const,
    defaultBudget: budget({ maxToolCalls: 1, maxDurationMs: 15_000 }),
    modelWorkerBudget: null,
    verifiability: "deterministic" as const,
    allowedTools: ["artifact.local.write"] as const,
    allowedWorkerKinds: ["deterministic_tool"] as const,
    sideEffectClass: "local_artifact" as const,
    reconciliationMode: "artifact_lookup_before_retry" as const,
    evidencePolicy: { minimumItems: 1, requireAcceptedContextReference: false },
  }),
  capability({
    capabilityId: "outcome.verify",
    owner: "operator" as const,
    description: "Independently verifies the written artifact against the approved candidate and criteria.",
    inputSchema: {
      kind: "object",
      fields: {
        artifactName: { kind: "string", minLength: 1, maxLength: 200 },
        approvedCandidateHash: { kind: "string", minLength: 64, maxLength: 64 },
        requiredSections: {
          kind: "array",
          items: { kind: "string", minLength: 1, maxLength: 120 },
          minItems: 1,
          maxItems: 16,
        },
        rejectedClaimStatements: {
          kind: "array",
          items: { kind: "string", minLength: 1, maxLength: 600 },
          maxItems: 32,
        },
        evidenceIndex: { kind: "array", items: { kind: "string", minLength: 1, maxLength: 200 }, minItems: 1, maxItems: 64 },
      },
    },
    outputSchema: {
      kind: "object",
      fields: {
        artifactExists: { kind: "boolean" },
        artifactHash: { kind: "string", minLength: 64, maxLength: 64 },
        hashMatchesApprovedCandidate: { kind: "boolean" },
        missingSections: { kind: "array", items: { kind: "string", minLength: 1, maxLength: 120 }, maxItems: 16 },
        unresolvedEvidenceRefs: { kind: "array", items: { kind: "string", minLength: 1, maxLength: 200 }, maxItems: 64 },
        rejectedClaimsPresent: { kind: "array", items: { kind: "string", minLength: 1, maxLength: 600 }, maxItems: 32 },
        writeCount: { kind: "number", minimum: 0, maximum: 8, integer: true },
        outcomeVerified: { kind: "boolean" },
      },
    },
    riskClass: "read_only" as const,
    authorityRequirement: "none" as const,
    defaultBudget: budget({ maxToolCalls: 4, maxDurationMs: 20_000 }),
    modelWorkerBudget: null,
    verifiability: "deterministic" as const,
    allowedTools: ["artifact.local.read"] as const,
    allowedWorkerKinds: ["deterministic_tool"] as const,
    sideEffectClass: "none" as const,
    reconciliationMode: "worker_record_lookup_before_retry" as const,
    evidencePolicy: { minimumItems: 1, requireAcceptedContextReference: false },
  }),

  // -------------------------------------------------------------------------
  // Operational exception capabilities
  // -------------------------------------------------------------------------

  capability({
    capabilityId: "exception.state.observe",
    owner: "operator" as const,
    description:
      "Reads the connector's current record into a typed, hashed, source-identified ObservedState.",
    inputSchema: {
      kind: "object",
      fields: {
        connectorId: { kind: "string", minLength: 1, maxLength: 120 },
        targetId: { kind: "string", minLength: 1, maxLength: 120 },
        expectedObservationHash: { kind: "string", minLength: 64, maxLength: 64 },
      },
    },
    outputSchema: {
      kind: "object",
      fields: {
        sourceSystemId: { kind: "string", minLength: 1, maxLength: 120 },
        targetId: { kind: "string", minLength: 1, maxLength: 120 },
        sourceRevision: { kind: "string", minLength: 1, maxLength: 64 },
        observationHash: { kind: "string", minLength: 64, maxLength: 64 },
        // The whole reason this node re-observes rather than trusting intake.
        matchesIntakeObservation: { kind: "boolean" },
        recordExists: { kind: "boolean" },
      },
    },
    riskClass: "read_only" as const,
    authorityRequirement: "none" as const,
    defaultBudget: budget({ maxToolCalls: 4, maxDurationMs: 15_000 }),
    modelWorkerBudget: null,
    verifiability: "deterministic" as const,
    allowedTools: ["connector.manifest.read", "connector.state.read"] as const,
    allowedWorkerKinds: ["deterministic_tool"] as const,
    sideEffectClass: "none" as const,
    reconciliationMode: "worker_record_lookup_before_retry" as const,
    evidencePolicy: { minimumItems: 1, requireAcceptedContextReference: false },
  }),
  capability({
    capabilityId: "exception.action.compile",
    owner: "operator" as const,
    description:
      "Compiles the one ActionContract that resolves the approved StateDelta, and nothing else.",
    inputSchema: {
      kind: "object",
      fields: {
        connectorId: { kind: "string", minLength: 1, maxLength: 120 },
        targetId: { kind: "string", minLength: 1, maxLength: 120 },
        observationHash: { kind: "string", minLength: 64, maxLength: 64 },
        deltaHash: { kind: "string", minLength: 64, maxLength: 64 },
      },
    },
    outputSchema: {
      kind: "object",
      fields: {
        actionContractHash: { kind: "string", minLength: 64, maxLength: 64 },
        writePayloadHash: { kind: "string", minLength: 64, maxLength: 64 },
        idempotencyKey: { kind: "string", minLength: 1, maxLength: 200 },
        capability: { kind: "string", minLength: 1, maxLength: 120 },
        changedFieldCount: { kind: "number", minimum: 1, integer: true },
      },
    },
    riskClass: "read_only" as const,
    authorityRequirement: "none" as const,
    defaultBudget: budget({ maxToolCalls: 2, maxDurationMs: 15_000 }),
    modelWorkerBudget: null,
    verifiability: "deterministic" as const,
    allowedTools: ["connector.manifest.read"] as const,
    allowedWorkerKinds: ["deterministic_tool"] as const,
    sideEffectClass: "none" as const,
    reconciliationMode: "worker_record_lookup_before_retry" as const,
    evidencePolicy: { minimumItems: 1, requireAcceptedContextReference: false },
  }),
  capability({
    capabilityId: "connector.state.apply",
    owner: "operator" as const,
    description:
      "Applies exactly one approved ActionContract to the simulated connector, once.",
    inputSchema: {
      kind: "object",
      fields: {
        actionContractHash: { kind: "string", minLength: 64, maxLength: 64 },
        candidateHash: { kind: "string", minLength: 64, maxLength: 64 },
        approvalId: { kind: "string", minLength: 1, maxLength: 200 },
      },
    },
    outputSchema: {
      kind: "object",
      fields: {
        idempotencyKey: { kind: "string", minLength: 1, maxLength: 200 },
        postStateHash: { kind: "string", minLength: 64, maxLength: 64 },
        // `false` means this execution replayed an action the connector had
        // already applied — the recovery case, and never a second write.
        performedWrite: { kind: "boolean" },
        writeCount: { kind: "number", minimum: 1, maximum: 1, integer: true },
        connectorReconciliationReads: { kind: "number", minimum: 0, maximum: 8, integer: true },
      },
    },
    // Truthfully `local_write`: the connector's entire state is local. The
    // *simulation* of an external system is carried by `sideEffectClass`, so
    // `external_write` stays an unsupported risk class rather than being
    // quietly admitted through this capability.
    riskClass: "local_write" as const,
    authorityRequirement: "human_approval_bound_to_candidate_hash" as const,
    defaultBudget: budget({ maxToolCalls: 3, maxDurationMs: 15_000 }),
    modelWorkerBudget: null,
    verifiability: "deterministic" as const,
    allowedTools: ["connector.state.read", "connector.action.read", "connector.state.apply"] as const,
    allowedWorkerKinds: ["deterministic_tool"] as const,
    sideEffectClass: "simulated_external" as const,
    reconciliationMode: "connector_action_lookup_before_retry" as const,
    evidencePolicy: { minimumItems: 1, requireAcceptedContextReference: false },
  }),
  /**
   * The real external create — the only capability in this fabric that changes
   * a system CHANTER does not own.
   *
   * Deliberately *not* a mode of `connector.state.apply`. That capability is
   * honestly classed `local_write`/`simulated_external`, and widening it to
   * cover real writes would have made every existing simulated proof read as
   * though it might have touched the world. Two capabilities, two honest
   * classifications, and a plan names exactly one of them.
   *
   * `writeCount` is bounded `1..1` by the output schema, so §5's budget of
   * exactly one primary mutation is enforced by the contract rather than by the
   * worker remembering to stop.
   */
  capability({
    capabilityId: "connector.state.apply_external",
    owner: "operator" as const,
    description:
      "Applies exactly one approved ActionContract to a real external system, once, under a "
      + "create-if-absent precondition.",
    inputSchema: {
      kind: "object",
      fields: {
        actionContractHash: { kind: "string", minLength: 64, maxLength: 64 },
        candidateHash: { kind: "string", minLength: 64, maxLength: 64 },
        approvalId: { kind: "string", minLength: 1, maxLength: 200 },
      },
    },
    outputSchema: {
      kind: "object",
      fields: {
        idempotencyKey: { kind: "string", minLength: 1, maxLength: 400 },
        postStateHash: { kind: "string", minLength: 1, maxLength: 120 },
        performedWrite: { kind: "boolean" },
        writeCount: { kind: "number", minimum: 1, maximum: 1, integer: true },
        connectorReconciliationReads: { kind: "number", minimum: 0, maximum: 8, integer: true },
      },
    },
    // The honest classification, and the reason the module-load denylist had to
    // give up `external_write` rather than this capability giving up the truth.
    riskClass: "external_write" as const,
    authorityRequirement: "human_approval_bound_to_candidate_hash" as const,
    defaultBudget: budget({ maxToolCalls: 4, maxDurationMs: 60_000 }),
    modelWorkerBudget: null,
    verifiability: "deterministic" as const,
    allowedTools: ["connector.state.read", "connector.action.read", "connector.state.apply"] as const,
    allowedWorkerKinds: ["deterministic_tool"] as const,
    sideEffectClass: "external" as const,
    reconciliationMode: "connector_action_lookup_before_retry" as const,
    evidencePolicy: { minimumItems: 1, requireAcceptedContextReference: false },
  }),
  /**
   * The pre-approved undo, and nothing else.
   *
   * It carries `human_approval_bound_to_candidate_hash` for the same reason the
   * action does: the compensation plan is part of what the human approved, so a
   * different undo is a different decision. It cannot reach
   * `connector.state.apply`, so this node can remove the object its mission
   * created and cannot create anything.
   */
  capability({
    capabilityId: "connector.state.compensate",
    owner: "operator" as const,
    description:
      "Deletes exactly the object this mission created, conditional on its exact post-create "
      + "revision, and nothing else.",
    inputSchema: {
      kind: "object",
      fields: {
        actionContractHash: { kind: "string", minLength: 64, maxLength: 64 },
        candidateHash: { kind: "string", minLength: 64, maxLength: 64 },
        approvalId: { kind: "string", minLength: 1, maxLength: 200 },
        verifiedRevision: { kind: "string", minLength: 1, maxLength: 120 },
      },
    },
    outputSchema: {
      kind: "object",
      fields: {
        compensated: { kind: "boolean" },
        performedWrite: { kind: "boolean" },
        expectedRevision: { kind: "string", minLength: 1, maxLength: 120 },
        connectorCompensationCount: { kind: "number", minimum: 0, maximum: 1, integer: true },
      },
    },
    riskClass: "external_write" as const,
    authorityRequirement: "human_approval_bound_to_candidate_hash" as const,
    defaultBudget: budget({ maxToolCalls: 3, maxDurationMs: 60_000 }),
    modelWorkerBudget: null,
    verifiability: "deterministic" as const,
    allowedTools: ["connector.state.read", "connector.state.compensate"] as const,
    allowedWorkerKinds: ["deterministic_tool"] as const,
    sideEffectClass: "external" as const,
    reconciliationMode: "connector_action_lookup_before_retry" as const,
    evidencePolicy: { minimumItems: 1, requireAcceptedContextReference: false },
  }),
  /**
   * The oracle for the compensated end state.
   *
   * Separate from `exception.outcome.verify` because it judges the opposite
   * proposition. That oracle asks "is the desired state present"; this one asks
   * "is the object gone" — and an oracle that could answer both by flipping a
   * boolean would be one edit away from reporting absence as success.
   */
  capability({
    capabilityId: "exception.absence.verify",
    owner: "operator" as const,
    description:
      "Independently re-reads the exact object and confirms it is absent after compensation.",
    inputSchema: {
      kind: "object",
      fields: {
        connectorId: { kind: "string", minLength: 1, maxLength: 120 },
        targetId: { kind: "string", minLength: 1, maxLength: 400 },
      },
    },
    outputSchema: {
      kind: "object",
      fields: {
        recordAbsent: { kind: "boolean" },
        absenceVerified: { kind: "boolean" },
        residualObjectCount: { kind: "number", minimum: 0, maximum: 1, integer: true },
      },
    },
    riskClass: "read_only" as const,
    authorityRequirement: "none" as const,
    defaultBudget: budget({ maxToolCalls: 3, maxDurationMs: 30_000 }),
    modelWorkerBudget: null,
    verifiability: "deterministic" as const,
    // Read-only tools only. An oracle that could delete could manufacture the
    // absence it is supposed to be observing.
    allowedTools: ["connector.state.read"] as const,
    allowedWorkerKinds: ["deterministic_tool"] as const,
    sideEffectClass: "none" as const,
    reconciliationMode: "worker_record_lookup_before_retry" as const,
    evidencePolicy: { minimumItems: 1, requireAcceptedContextReference: false },
  }),
  capability({
    capabilityId: "exception.shadow.authorize",
    owner: "operator" as const,
    description:
      "Records what an approved action *would* do against the real source, and performs nothing.",
    inputSchema: {
      kind: "object",
      fields: {
        actionContractHash: { kind: "string", minLength: 64, maxLength: 64 },
        candidateHash: { kind: "string", minLength: 64, maxLength: 64 },
        approvalId: { kind: "string", minLength: 1, maxLength: 200 },
      },
    },
    outputSchema: {
      kind: "object",
      fields: {
        wouldExecuteCapability: { kind: "string", minLength: 1, maxLength: 120 },
        wouldTargetExternalObject: { kind: "string", minLength: 1, maxLength: 400 },
        wouldUseIdempotencyKey: { kind: "string", minLength: 1, maxLength: 200 },
        wouldExpectPreStateRevision: { kind: "string", minLength: 1, maxLength: 120 },
        // The whole point, asserted in the node's own output rather than left
        // to a reader to infer from the absence of a write.
        realExternalWrites: { kind: "number", minimum: 0, maximum: 0, integer: true },
      },
    },
    riskClass: "read_only" as const,
    // Still human-gated. The approval is the real thing being proven — a shadow
    // action a human never saw would prove nothing about the authority chain.
    authorityRequirement: "human_approval_bound_to_candidate_hash" as const,
    defaultBudget: budget({ maxToolCalls: 1, maxDurationMs: 15_000 }),
    modelWorkerBudget: null,
    verifiability: "deterministic" as const,
    // Read-only tools only: the manifest, to record what the connector declares
    // it *would* need. There is no write tool in this allowlist.
    allowedTools: ["connector.manifest.read"] as const,
    allowedWorkerKinds: ["deterministic_tool"] as const,
    sideEffectClass: "none" as const,
    reconciliationMode: "worker_record_lookup_before_retry" as const,
    evidencePolicy: { minimumItems: 1, requireAcceptedContextReference: false },
  }),
  capability({
    capabilityId: "exception.shadow.verify",
    owner: "operator" as const,
    description:
      "Independently re-reads the real source and judges the shadow contract, not the desired state.",
    inputSchema: {
      kind: "object",
      fields: {
        connectorId: { kind: "string", minLength: 1, maxLength: 120 },
        targetId: { kind: "string", minLength: 1, maxLength: 400 },
        observedRevision: { kind: "string", minLength: 1, maxLength: 120 },
        observationHash: { kind: "string", minLength: 64, maxLength: 64 },
      },
    },
    outputSchema: {
      kind: "object",
      fields: {
        sourceReadable: { kind: "boolean" },
        identityStable: { kind: "boolean" },
        revisionUnchanged: { kind: "boolean" },
        observedRevision: { kind: "string", minLength: 1, maxLength: 120 },
        // The claim this oracle is actually entitled to make.
        noChanterInducedMutation: { kind: "boolean" },
        realExternalWrites: { kind: "number", minimum: 0, maximum: 0, integer: true },
        shadowVerified: { kind: "boolean" },
      },
    },
    riskClass: "read_only" as const,
    authorityRequirement: "none" as const,
    defaultBudget: budget({ maxToolCalls: 4, maxDurationMs: 30_000 }),
    modelWorkerBudget: null,
    verifiability: "deterministic" as const,
    allowedTools: ["connector.state.read", "connector.manifest.read"] as const,
    allowedWorkerKinds: ["deterministic_tool"] as const,
    sideEffectClass: "none" as const,
    reconciliationMode: "worker_record_lookup_before_retry" as const,
    evidencePolicy: { minimumItems: 1, requireAcceptedContextReference: false },
  }),
  capability({
    capabilityId: "exception.outcome.verify",
    owner: "operator" as const,
    description:
      "Independently re-observes the connector and judges it against DesiredState.",
    inputSchema: {
      kind: "object",
      fields: {
        connectorId: { kind: "string", minLength: 1, maxLength: 120 },
        targetId: { kind: "string", minLength: 1, maxLength: 120 },
        desiredStateHash: { kind: "string", minLength: 64, maxLength: 64 },
        idempotencyKey: { kind: "string", minLength: 1, maxLength: 200 },
      },
    },
    outputSchema: {
      kind: "object",
      fields: {
        recordExists: { kind: "boolean" },
        postObservationHash: { kind: "string", minLength: 64, maxLength: 64 },
        unsatisfiedConstraintIds: {
          kind: "array",
          items: { kind: "string", minLength: 1, maxLength: 120 },
          maxItems: 32,
        },
        connectorWriteCount: { kind: "number", minimum: 0, maximum: 8, integer: true },
        outcomeVerified: { kind: "boolean" },
        // Empty when the record was absent: an oracle that found nothing has no
        // revision to report, and inventing one would hand the compensation a
        // precondition nothing stands behind.
        verifiedRevision: { kind: "string", minLength: 0, maxLength: 120 },
      },
    },
    riskClass: "read_only" as const,
    authorityRequirement: "none" as const,
    defaultBudget: budget({ maxToolCalls: 4, maxDurationMs: 20_000 }),
    modelWorkerBudget: null,
    verifiability: "deterministic" as const,
    // Read-only tools only. An oracle that could write is not an oracle.
    allowedTools: ["connector.state.read", "connector.action.read"] as const,
    allowedWorkerKinds: ["deterministic_tool"] as const,
    sideEffectClass: "none" as const,
    reconciliationMode: "worker_record_lookup_before_retry" as const,
    evidencePolicy: { minimumItems: 1, requireAcceptedContextReference: false },
  }),
]);

/**
 * Risk classes no capability may be registered under in this P0.
 *
 * A refusal at module load, rather than at routing time, is deliberate: an
 * unsupported risk class must be impossible to introduce, not merely impossible
 * to reach along today's code path.
 */
const UNSUPPORTED_RISK_CLASSES: ReadonlySet<AgenticRiskClass> = new Set<AgenticRiskClass>([
  // `external_write` was here until P0-C, and the predecessor slice went out of
  // its way not to slip past it: `connector.state.apply` is classed
  // `local_write` with `sideEffectClass: "simulated_external"`, because its
  // store really is local and pretending otherwise would have been the easy lie.
  //
  // It is removed now because a capability that genuinely writes to a real
  // external system must be able to say so. Registering such a capability under
  // `local_write` to satisfy this denylist would defeat the point of having it:
  // the guard exists to make real writes *visible*, not to make them
  // unnameable.
  //
  // What did not move: `irreversible` is still refused, and that is the bound
  // that matters now. The one capability admitted under `external_write` creates
  // an object whose undo is deleting exactly that object — compensable by
  // construction. A capability whose effect could not be removed still cannot be
  // registered at all.
  "irreversible",
]);

function assertRegistryIsConsistent(): void {
  const seen = new Set<string>();
  for (const capability of CAPABILITIES) {
    if (seen.has(capability.capabilityId)) {
      throw new Error(`Capability ${capability.capabilityId} is registered twice.`);
    }
    seen.add(capability.capabilityId);
    if (UNSUPPORTED_RISK_CLASSES.has(capability.riskClass)) {
      throw new Error(
        `Capability ${capability.capabilityId} declares unsupported risk class ${capability.riskClass}.`,
      );
    }
    for (const tool of capability.allowedTools) {
      if (!TOOL_NAMES.has(tool)) {
        throw new Error(`Capability ${capability.capabilityId} allows unregistered tool ${tool}.`);
      }
    }
    if (capability.allowedWorkerKinds.length === 0) {
      throw new Error(`Capability ${capability.capabilityId} declares no worker kind.`);
    }
    // `external` was refused outright until P0-C. It is now permitted, but only
    // for a capability that also declares the risk honestly — the two fields
    // must agree. A capability claiming a real external effect at
    // `local_write` risk, or the reverse, is a record that contradicts itself,
    // and a contradiction at module load is better than one at write time.
    if (capability.sideEffectClass === "external"
      && capability.riskClass !== "external_write") {
      throw new Error(
        `Capability ${capability.capabilityId} declares an external side effect but risk class `
        + `${capability.riskClass}.`,
      );
    }
    if (capability.riskClass === "external_write"
      && capability.sideEffectClass !== "external") {
      throw new Error(
        `Capability ${capability.capabilityId} declares external_write risk but side effect `
        + `${capability.sideEffectClass}.`,
      );
    }
    // Every consequential capability must be gated, and the gate is declared on
    // the capability rather than inferred from a node name. Checking it here
    // means a future capability that writes without an authority requirement
    // fails at module load, not at the moment it writes.
    if (capability.sideEffectClass !== "none"
      && capability.authorityRequirement !== "human_approval_bound_to_candidate_hash") {
      throw new Error(
        `Capability ${capability.capabilityId} has a side effect but requires no human authority.`,
      );
    }
    // A connector write must be reconcilable against the system that would have
    // performed it. Any other mode would resolve an ambiguous outcome by reading
    // something that cannot know the answer.
    //
    // Extended to cover `external` alongside `simulated_external`: the rule was
    // written for the simulated case, and it matters incomparably more for the
    // real one, where guessing wrong means a duplicate in someone else's system.
    if ((capability.sideEffectClass === "simulated_external"
      || capability.sideEffectClass === "external")
      && capability.reconciliationMode !== "connector_action_lookup_before_retry") {
      throw new Error(
        `Capability ${capability.capabilityId} writes to a connector but does not reconcile against it.`,
      );
    }
    // A model budget on a capability that can never route to a model would be
    // dead declaration, and worse, one a later edit could accidentally make
    // live. Refuse the combination outright.
    const modelEligible = capability.allowedWorkerKinds.includes("model_worker");
    if (capability.modelWorkerBudget !== null && !modelEligible) {
      throw new Error(
        `Capability ${capability.capabilityId} declares a model worker budget but registers no model worker kind.`,
      );
    }
    if (modelEligible && capability.modelWorkerBudget !== null) {
      if (capability.modelWorkerBudget.maxTokens === null) {
        throw new Error(
          `Capability ${capability.capabilityId} may route to a model but declares no token ceiling for it.`,
        );
      }
      if (capability.modelWorkerBudget.maxToolCalls !== 0) {
        throw new Error(
          `Capability ${capability.capabilityId} grants a model worker tool calls; the provider call is the `
          + "Runtime's execution port, never a tool exposed to the model.",
        );
      }
    }
  }
}

assertRegistryIsConsistent();

export function listAgenticCapabilities(): readonly AgenticCapability[] {
  return CAPABILITIES;
}

export function resolveAgenticCapability(capabilityId: unknown): AgenticCapability | null {
  if (typeof capabilityId !== "string") return null;
  return CAPABILITIES.find((entry) => entry.capabilityId === capabilityId) ?? null;
}

export function requireAgenticCapability(capabilityId: string): AgenticCapability {
  const capability = resolveAgenticCapability(capabilityId);
  if (!capability) {
    throw new Error(`No agentic capability is registered for ${capabilityId}.`);
  }
  return capability;
}

/**
 * The capabilities any mission whose output contract is a written artifact must
 * be permitted to use.
 *
 * The intent compiler checks a submission against this set, so "your budget is
 * too small" and "you forbade something you need" are answered at compile time
 * with the exact capability named — rather than at node 6, after four workers
 * have already been paid for.
 */
export const AGENTIC_ARTIFACT_MISSION_CAPABILITIES: readonly string[] = Object.freeze([
  "repo.metadata.read",
  "architecture.analyze",
  "risk.analyze",
  "evidence.verify",
  "result.synthesize",
  "artifact.local.write",
  "outcome.verify",
]);

/**
 * The capabilities an operational-exception mission must be permitted to use.
 *
 * Deliberately a different, much smaller set than the artifact mission's. An
 * exception mission compiles no prose and writes no artifact, so granting it
 * those capabilities would widen its reach for no reason the plan can use.
 */
export const AGENTIC_EXCEPTION_MISSION_CAPABILITIES: readonly string[] = Object.freeze([
  "exception.state.observe",
  "exception.action.compile",
  "connector.state.apply",
  "exception.outcome.verify",
]);

/**
 * The capabilities a real-external, compensated exception mission may use.
 *
 * `connector.state.apply` is deliberately **absent**, and so is
 * `connector.state.apply_external` from the simulated set above. The two live
 * modes cannot reach each other's write capability, so a simulated mission is
 * structurally incapable of a real write and a real one cannot quietly fall
 * back to writing locally and calling it done.
 *
 * Compensation is granted here and nowhere else, because it is only meaningful
 * where something real was changed.
 */
export const AGENTIC_COMPENSATED_EXCEPTION_MISSION_CAPABILITIES: readonly string[] = Object.freeze([
  "exception.state.observe",
  "exception.action.compile",
  "connector.state.apply_external",
  "exception.outcome.verify",
  "connector.state.compensate",
  "exception.absence.verify",
]);

/**
 * The capabilities a *shadow* operational-exception mission must be permitted.
 *
 * `connector.state.apply` is deliberately absent. A shadow mission is not
 * merely one that declines to write — it is one that was never granted the
 * capability to, so the permission the plan would need does not exist in its
 * allowed set.
 */
export const AGENTIC_SHADOW_EXCEPTION_MISSION_CAPABILITIES: readonly string[] = Object.freeze([
  "exception.state.observe",
  "exception.action.compile",
  "exception.shadow.authorize",
  "exception.shadow.verify",
]);

/**
 * The budget one capability actually runs under, given how it was routed.
 *
 * One function so the plan compiler, the intent compiler's minimum check, and
 * the worker factory can never disagree about what a model node may spend.
 */
export function budgetForWorkerKind(
  capability: AgenticCapability,
  workerKind: AgenticWorkerKind | null,
): AgenticNodeBudget {
  return workerKind === "model_worker" && capability.modelWorkerBudget !== null
    ? capability.modelWorkerBudget
    : capability.defaultBudget;
}

/**
 * The smallest time budget under which the required capabilities could all run.
 *
 * Derived by summing their declared budgets rather than written down as a
 * constant, so it cannot drift away from what the plan actually costs — and
 * derived *per execution policy*, because a mission that requires model-backed
 * judgement genuinely needs a larger window than the cheapest sufficient plan.
 * Answering with the cheap plan's minimum for a model mission would accept a
 * budget the plan then exceeds at node two.
 */
export function minimumExecutablePlanDurationMs(
  executionPolicy: AgenticExecutionPolicy = "cheapest_sufficient",
): number {
  return AGENTIC_ARTIFACT_MISSION_CAPABILITIES.reduce((total, capabilityId) => {
    const capability = requireAgenticCapability(capabilityId);
    const routesToModel = executionPolicy === "model_required_for_judgment"
      && capability.verifiability !== "deterministic"
      && capability.allowedWorkerKinds.includes("model_worker");
    return total + budgetForWorkerKind(capability, routesToModel ? "model_worker" : null).maxDurationMs;
  }, 0);
}
