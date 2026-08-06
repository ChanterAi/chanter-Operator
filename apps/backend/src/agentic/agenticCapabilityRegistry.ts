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

// ---------------------------------------------------------------------------
// Closed tool registry
// ---------------------------------------------------------------------------

/**
 * Every tool any worker in this fabric may reach.
 *
 * All are read-only except `artifact.local.write`, which is the single
 * consequential effect the whole plan is built to gate. There is deliberately no
 * shell tool, no network tool, and no general filesystem tool: a worker cannot
 * be given a capability that was never implemented.
 */
export const AGENTIC_TOOLS = [
  "repo.metadata.read",
  "repo.file.read",
  "test.result.read",
  "operator.mission.state.read",
  "fixture.read",
  "artifact.local.read",
  "artifact.local.write",
] as const;

export type AgenticToolName = (typeof AGENTIC_TOOLS)[number];

const TOOL_NAMES: ReadonlySet<string> = new Set<string>(AGENTIC_TOOLS);

/** How a capability's ambiguous outcome must be resolved before any retry. */
export type AgenticReconciliationMode =
  /** Re-read the durable worker record; retry only when provably absent. */
  | "worker_record_lookup_before_retry"
  /** Re-read the written artifact and its hash; never rewrite speculatively. */
  | "artifact_lookup_before_retry";

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
    verifiability: "deterministic" as const,
    allowedTools: ["artifact.local.read"] as const,
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
  "external_write",
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
    if (capability.sideEffectClass === "external") {
      throw new Error(`Capability ${capability.capabilityId} declares an external side effect.`);
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
 * The smallest time budget under which the required capabilities could all run.
 *
 * Derived by summing their declared default budgets rather than written down as
 * a constant, so it cannot drift away from what the plan actually costs.
 */
export function minimumExecutablePlanDurationMs(): number {
  return AGENTIC_ARTIFACT_MISSION_CAPABILITIES.reduce(
    (total, capabilityId) => total + requireAgenticCapability(capabilityId).defaultBudget.maxDurationMs,
    0,
  );
}
