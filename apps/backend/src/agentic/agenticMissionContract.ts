/**
 * CHANTER OS — canonical agentic work contract (`chanter.agentic-work.v1`).
 *
 * Pure declarations and total functions only: no database, no HTTP, no service.
 * Everything downstream — the intent compiler, the context compiler, the plan
 * compiler, the journal, the OS projection — reads its vocabulary from here, so
 * no layer can grow a private idea of identity, state, authority, or evidence.
 *
 * Three shapes matter and are deliberately distinct:
 *
 *   - **submission**: exactly what a human sent, preserved byte for byte;
 *   - **intent contract**: the normalized, immutable, hashed compilation of that
 *     submission, which is what every later decision binds to;
 *   - **plan**: the deterministic DAG compiled from an intent contract and a
 *     context bundle.
 *
 * Keeping the submission separate from the contract is what makes "the same
 * mission id arrived with different intent" a detectable typed conflict rather
 * than a silent overwrite: the human text is evidence of what was asked, and the
 * hash is evidence of what was compiled.
 */
import type {
  AgenticRiskClass,
  AgenticVerifiabilityClass,
  AgenticWorkerKind,
} from "chanter-agent-runtime";
import { canonicalizeAgenticJson } from "chanter-agent-runtime";
import { createHash } from "node:crypto";
import type {
  ExceptionAcceptanceConstraint,
  ExceptionField,
  OperationalExceptionExecutionMode,
} from "./agenticExceptionContract.js";

export const AGENTIC_WORK_SCHEMA_VERSION = "chanter.agentic-work.v1" as const;
export const AGENTIC_PLAN_SCHEMA_VERSION = "chanter.agentic-plan.v1" as const;
export const AGENTIC_CONTEXT_SCHEMA_VERSION = "chanter.agentic-context.v1" as const;
export const AGENTIC_MISSION_VIEW_SCHEMA_VERSION = "chanter.agentic-mission.view.v1" as const;

const INTENT_HASH_DOMAIN = "chanter.agentic-work.intent.v1";
const CONTEXT_ITEM_HASH_DOMAIN = "chanter.agentic-work.context-item.v1";
const CONTEXT_BUNDLE_HASH_DOMAIN = "chanter.agentic-work.context-bundle.v1";
const PLAN_HASH_DOMAIN = "chanter.agentic-work.plan.v1";
const NODE_PAYLOAD_HASH_DOMAIN = "chanter.agentic-work.node-payload.v1";
const CANDIDATE_HASH_DOMAIN = "chanter.agentic-work.candidate.v1";

function digest(domain: string, payload: string): string {
  return createHash("sha256").update(domain).update(" ").update(payload).digest("hex");
}

// ---------------------------------------------------------------------------
// Constraints
// ---------------------------------------------------------------------------

export const AGENTIC_CONSTRAINT_KINDS = ["require", "forbid"] as const;

export type AgenticConstraintKind = (typeof AGENTIC_CONSTRAINT_KINDS)[number];

/**
 * One hard requirement, typed so contradiction is machine-detectable.
 *
 * Prose constraints cannot be checked against each other without semantics
 * nothing here owns, so a constraint carries an explicit `kind` and a normalized
 * `subject`: one subject asserted both `require` and `forbid` is a contradiction,
 * decided by comparison rather than by interpretation. The human's original
 * wording survives verbatim in `statement`.
 */
export interface AgenticConstraint {
  readonly constraintId: string;
  readonly kind: AgenticConstraintKind;
  readonly subject: string;
  readonly statement: string;
}

// ---------------------------------------------------------------------------
// Acceptance criteria
// ---------------------------------------------------------------------------

/**
 * How an acceptance criterion is evaluated.
 *
 * Three are machine-checkable and one is not. `human_judgment` exists so a
 * mission can state a criterion it knows a machine cannot settle — and the
 * synthesis node must then report it as unevaluated rather than quietly passing
 * it, which is the only honest treatment.
 */
export const AGENTIC_ACCEPTANCE_CHECKS = [
  "artifact_section_present",
  "evidence_coverage_minimum",
  "no_rejected_claim_present",
  "human_judgment",
] as const;

export type AgenticAcceptanceCheck = (typeof AGENTIC_ACCEPTANCE_CHECKS)[number];

export interface AgenticAcceptanceCriterion {
  readonly criterionId: string;
  readonly statement: string;
  readonly check: AgenticAcceptanceCheck;
  /** Check-specific argument; empty for checks that take none. */
  readonly parameter: string;
}

// ---------------------------------------------------------------------------
// Authority policy
// ---------------------------------------------------------------------------

/**
 * Which work requires a human before it may execute.
 *
 * Stated as capability ids and risk classes — never node names. A node name is
 * a label the plan compiler chose; binding authority to it would mean a renamed
 * node silently changes who must approve what.
 */
export interface AgenticAuthorityPolicy {
  readonly approvalRequiredCapabilities: readonly string[];
  readonly approvalRequiredRiskClasses: readonly AgenticRiskClass[];
  /** Identifier of the human authority expected to decide. */
  readonly approverRole: string;
}

// ---------------------------------------------------------------------------
// Context requirements
// ---------------------------------------------------------------------------

export const AGENTIC_CONTEXT_SOURCE_TYPES = [
  "repository_file",
  "repository_metadata",
  "test_result",
  "operator_mission_state",
  "static_fixture",
] as const;

export type AgenticContextSourceType = (typeof AGENTIC_CONTEXT_SOURCE_TYPES)[number];

export const AGENTIC_TRUST_CLASSES = ["authoritative", "derived", "declared"] as const;

export type AgenticTrustClass = (typeof AGENTIC_TRUST_CLASSES)[number];

export type AgenticFreshnessPolicy =
  /** Any successfully retrieved value satisfies the requirement. */
  | "any"
  /** The value must have been retrieved during this mission's compilation. */
  | "compiled_at_submission"
  /** The value must be no older than `maxAgeSeconds`. */
  | "max_age_seconds";

export interface AgenticContextRequirement {
  readonly requirementId: string;
  readonly sourceType: AgenticContextSourceType;
  /** Exact opaque identity of the source: a repository name, a path, a mission id. */
  readonly sourceIdentity: string;
  readonly freshnessPolicy: AgenticFreshnessPolicy;
  readonly maxAgeSeconds: number | null;
  readonly trustClass: AgenticTrustClass;
  /** Scope label recorded with the item, e.g. which repository it describes. */
  readonly scope: string;
  /** When true, a missing or stale item fails compilation instead of being dropped. */
  readonly required: boolean;
}

// ---------------------------------------------------------------------------
// Execution policy
// ---------------------------------------------------------------------------

/**
 * How much intelligence a mission is willing to spend.
 *
 * The default preserves Effective Intelligence Density: take the cheapest worker
 * kind that is sufficient, which for every capability in this registry means no
 * inference at all. `model_required_for_judgment` is an explicit, human-declared
 * escalation for the judgement-bearing capabilities *only* — it can never reach
 * a capability the registry declares deterministic, because such a capability
 * authorizes no provider binding for it to select.
 *
 * Stated as a policy over capability *classes*, never as a list of node names. A
 * policy that named nodes would silently change meaning the moment the plan
 * compiler renamed one.
 */
export const AGENTIC_EXECUTION_POLICIES = [
  "cheapest_sufficient",
  "model_required_for_judgment",
] as const;

export type AgenticExecutionPolicy = (typeof AGENTIC_EXECUTION_POLICIES)[number];

/** One capability's chosen provider binding, drawn from the closed registry. */
export interface AgenticProviderBindingSelection {
  readonly capabilityId: string;
  readonly bindingId: string;
}

// ---------------------------------------------------------------------------
// Output contract
// ---------------------------------------------------------------------------

export interface AgenticOutputContract {
  readonly format: "markdown";
  readonly artifactName: string;
  readonly requiredSections: readonly string[];
}

/**
 * What kind of thing this mission resolves.
 *
 * The discriminator the plan compiler selects a DAG from. It participates in the
 * intent hash, so the same mission id resubmitted as a different kind is a typed
 * conflict rather than a silently re-planned mission — which matters because the
 * two kinds have different consequential capabilities.
 */
export const AGENTIC_MISSION_KINDS = ["artifact", "operational_exception"] as const;

export type AgenticMissionKind = (typeof AGENTIC_MISSION_KINDS)[number];

/**
 * The declared terminal condition for one operational exception.
 *
 * This is the *submission* form of DesiredState: what a human asked for, before
 * anything was observed. The compiled `DesiredState` and its hash are derived
 * from it at intake — see `agenticExceptionContract` — and the derivation is
 * deterministic, so the same submission always yields the same desired-state
 * hash on any machine.
 *
 * ObservedState is deliberately *not* here. It comes from the connector, not
 * from the human, and a submission that could assert what the source system
 * currently holds would make "stale observation" unprovable.
 */
export interface AgenticExceptionIntent {
  readonly connectorId: string;
  readonly targetId: string;
  /**
   * Whether this mission may change the source, or only observe and compile.
   *
   * Part of the intent, and therefore of the plan identity, because the two
   * modes compile structurally different plans — a shadow plan contains no node
   * with a side effect. A mission resubmitted in the other mode is a different
   * mission, not an update to this one.
   */
  readonly executionMode: OperationalExceptionExecutionMode;
  readonly desiredFields: readonly ExceptionField[];
  readonly acceptanceConstraints: readonly ExceptionAcceptanceConstraint[];
}

/**
 * The artifact output contract, or a refusal.
 *
 * Reaching an artifact-only path on a mission that writes no artifact is a
 * defect in the plan compiler or the router, not bad input — so this throws
 * rather than substituting a default. A synthesized `artifactName` would let a
 * mission of the wrong kind quietly write a file nobody asked for.
 */
export function requireArtifactOutputContract(
  intent: Pick<AgenticIntentContract, "missionKind" | "outputContract" | "missionId">,
): AgenticOutputContract {
  if (intent.outputContract === null) {
    throw new Error(
      `Mission ${intent.missionId} is a ${intent.missionKind} mission and declares no artifact output contract.`,
    );
  }
  return intent.outputContract;
}

/** The exception contract, or a refusal, for the same reason as above. */
export function requireExceptionContract(
  intent: Pick<AgenticIntentContract, "missionKind" | "exceptionContract" | "missionId">,
): AgenticExceptionIntent {
  if (intent.exceptionContract === null) {
    throw new Error(
      `Mission ${intent.missionId} is a ${intent.missionKind} mission and declares no exception contract.`,
    );
  }
  return intent.exceptionContract;
}

// ---------------------------------------------------------------------------
// The intent contract
// ---------------------------------------------------------------------------

/** Exactly what the human sent, preserved so compiled semantics never replace it. */
export interface AgenticHumanText {
  readonly objective: string;
  readonly constraints: readonly string[];
  readonly acceptanceCriteria: readonly string[];
}

/** One default the compiler supplied, recorded so nothing is silently assumed. */
export interface AgenticAppliedDefault {
  readonly field: string;
  readonly value: string;
  readonly reason: string;
}

export interface AgenticIntentContract {
  readonly schemaVersion: typeof AGENTIC_WORK_SCHEMA_VERSION;
  readonly missionId: string;
  readonly traceId: string;
  readonly workspaceId: string;
  readonly actorId: string;
  readonly objective: string;
  readonly constraints: readonly AgenticConstraint[];
  readonly acceptanceCriteria: readonly AgenticAcceptanceCriterion[];
  readonly riskClass: AgenticRiskClass;
  readonly verifiabilityClass: AgenticVerifiabilityClass;
  readonly authorityPolicy: AgenticAuthorityPolicy;
  readonly costBudgetMicros: number | null;
  readonly tokenBudget: number | null;
  readonly timeBudgetMs: number;
  readonly maxParallelism: number;
  readonly allowedCapabilities: readonly string[];
  readonly forbiddenCapabilities: readonly string[];
  /**
   * Whether judgement-bearing capabilities must run on a model. Part of the
   * intent hash, so the same mission id submitted under a different execution
   * policy is a typed conflict rather than a silently re-planned mission.
   */
  readonly executionPolicy: AgenticExecutionPolicy;
  /** Capability -> reviewed binding, sorted by capability id. */
  readonly providerBindings: readonly AgenticProviderBindingSelection[];
  /**
   * Per-model-node monetary ceiling, distinct from `costBudgetMicros`.
   *
   * `costBudgetMicros` is the *plan* ceiling the Governor withholds admission
   * against; this is the ceiling one provider call is judged by, inside the
   * Runtime, before it is dispatched. Two ceilings because they answer two
   * different questions — "can this plan afford to continue" and "may this one
   * call be made at all" — and one number cannot answer both.
   */
  readonly modelNodeCostCeilingMicros: number | null;
  readonly contextRequirements: readonly AgenticContextRequirement[];
  readonly missionKind: AgenticMissionKind;
  /** Present for an artifact mission; `null` when the mission writes no artifact. */
  readonly outputContract: AgenticOutputContract | null;
  /** Present for an operational-exception mission; `null` otherwise. */
  readonly exceptionContract: AgenticExceptionIntent | null;
  readonly requestedAt: string;
  readonly humanText: AgenticHumanText;
  readonly defaultsApplied: readonly AgenticAppliedDefault[];
  /** Digest of every compiled field above. The mission's immutable identity. */
  readonly intentHash: string;
}

/**
 * Digest of one compiled intent.
 *
 * `humanText` participates: two submissions whose compiled semantics coincide
 * but whose original wording differs are still different intents, and treating
 * them as one would let a reworded mission inherit an approval given for other
 * words. `intentHash` itself is excluded, since it is the output.
 */
export function createAgenticIntentHash(
  contract: Omit<AgenticIntentContract, "intentHash">,
): string {
  return digest(INTENT_HASH_DOMAIN, canonicalizeAgenticJson({
    schemaVersion: contract.schemaVersion,
    missionId: contract.missionId,
    workspaceId: contract.workspaceId,
    actorId: contract.actorId,
    objective: contract.objective,
    constraints: contract.constraints.map((constraint) => ({ ...constraint })),
    acceptanceCriteria: contract.acceptanceCriteria.map((criterion) => ({ ...criterion })),
    riskClass: contract.riskClass,
    verifiabilityClass: contract.verifiabilityClass,
    authorityPolicy: {
      approvalRequiredCapabilities: [...contract.authorityPolicy.approvalRequiredCapabilities],
      approvalRequiredRiskClasses: [...contract.authorityPolicy.approvalRequiredRiskClasses],
      approverRole: contract.authorityPolicy.approverRole,
    },
    costBudgetMicros: contract.costBudgetMicros,
    tokenBudget: contract.tokenBudget,
    timeBudgetMs: contract.timeBudgetMs,
    maxParallelism: contract.maxParallelism,
    allowedCapabilities: [...contract.allowedCapabilities],
    forbiddenCapabilities: [...contract.forbiddenCapabilities],
    executionPolicy: contract.executionPolicy,
    providerBindings: contract.providerBindings.map((selection) => ({ ...selection })),
    modelNodeCostCeilingMicros: contract.modelNodeCostCeilingMicros,
    contextRequirements: contract.contextRequirements.map((requirement) => ({ ...requirement })),
    missionKind: contract.missionKind,
    outputContract: contract.outputContract === null ? null : {
      format: contract.outputContract.format,
      artifactName: contract.outputContract.artifactName,
      requiredSections: [...contract.outputContract.requiredSections],
    },
    // The desired terminal condition is part of what was asked, so it binds the
    // intent. A resubmission wanting a different reconciled amount is a
    // different mission, not an update to this one.
    exceptionContract: contract.exceptionContract === null ? null : {
      connectorId: contract.exceptionContract.connectorId,
      targetId: contract.exceptionContract.targetId,
      executionMode: contract.exceptionContract.executionMode,
      desiredFields: contract.exceptionContract.desiredFields.map((entry) => ({ ...entry })),
      acceptanceConstraints: contract.exceptionContract.acceptanceConstraints
        .map((constraint) => ({ ...constraint })),
    },
    humanText: {
      objective: contract.humanText.objective,
      constraints: [...contract.humanText.constraints],
      acceptanceCriteria: [...contract.humanText.acceptanceCriteria],
    },
  }));
}

// ---------------------------------------------------------------------------
// Verified context
// ---------------------------------------------------------------------------

export interface AgenticContextItem {
  readonly contextItemId: string;
  readonly sourceType: AgenticContextSourceType;
  readonly sourceIdentity: string;
  readonly contentHash: string;
  readonly retrievedAt: string;
  readonly freshnessPolicy: AgenticFreshnessPolicy;
  readonly trustClass: AgenticTrustClass;
  readonly scope: string;
  /**
   * Statements *derived* from the source, kept separate from the source bytes
   * so a worker can never present its own derivation as raw evidence.
   */
  readonly claims: readonly string[];
  readonly evidenceReference: string;
}

export interface AgenticContextBundle {
  readonly schemaVersion: typeof AGENTIC_CONTEXT_SCHEMA_VERSION;
  readonly contextBundleId: string;
  readonly items: readonly AgenticContextItem[];
  readonly rejectedRequirementIds: readonly string[];
  readonly compiledAt: string;
}

/** Digest of one context item's source identity and exact retrieved bytes. */
export function createAgenticContextItemHash(input: {
  readonly sourceType: AgenticContextSourceType;
  readonly sourceIdentity: string;
  readonly content: string;
}): string {
  return digest(CONTEXT_ITEM_HASH_DOMAIN, canonicalizeAgenticJson({
    sourceType: input.sourceType,
    sourceIdentity: input.sourceIdentity,
    content: input.content,
  }));
}

/**
 * Deterministic bundle identity.
 *
 * Derived from the accepted items' content hashes, sorted, so the same admitted
 * context always yields the same bundle id regardless of retrieval order — and
 * so a changed source changes the bundle, which in turn changes the plan.
 */
export function createAgenticContextBundleId(items: readonly AgenticContextItem[]): string {
  const hashes = items.map((item) => `${item.contextItemId}:${item.contentHash}`).sort();
  return `ctxb-${digest(CONTEXT_BUNDLE_HASH_DOMAIN, hashes.join("\n")).slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// Plan and node contract
// ---------------------------------------------------------------------------

export const AGENTIC_NODE_TYPES = [
  "context_collect",
  "specialist",
  "verifier",
  "synthesis",
  "authority_checkpoint",
  "artifact_write",
  "outcome_verify",
  // Operational-exception shapes. `authority_checkpoint` and `outcome_verify`
  // are shared with the artifact plan on purpose: the human gate and the
  // independent oracle are the same structural roles, and giving them different
  // names per mission kind would invite two implementations of one guarantee.
  "state_observe",
  "action_compile",
  "connector_apply",
  // The shadow counterpart of `connector_apply`. A separate node type rather
  // than a flag on the same one, so "this plan contains no write node" is
  // answerable by reading the compiled plan.
  "shadow_authorize",
] as const;

export type AgenticNodeType = (typeof AGENTIC_NODE_TYPES)[number];

/**
 * Node lifecycle, shared byte for byte with the Loop Governor kernel's
 * vocabulary so no translation layer can drift between admission and truth.
 */
export const AGENTIC_NODE_STATES = [
  "blocked",
  "ready",
  "running",
  "completed",
  "failed_recoverable",
  "reconciliation_required",
  "failed_terminal",
  "cancelled",
] as const;

export type AgenticNodeState = (typeof AGENTIC_NODE_STATES)[number];

export const AGENTIC_NODE_TERMINAL_STATES: ReadonlySet<AgenticNodeState> =
  new Set<AgenticNodeState>(["completed", "failed_terminal", "cancelled"]);

export const AGENTIC_PLAN_STATES = [
  "compiled",
  "approval_required",
  "approved",
  "running",
  "awaiting_authority",
  "completed",
  "failed_recoverable",
  "reconciliation_required",
  "failed_terminal",
  "cancelled",
] as const;

export type AgenticPlanState = (typeof AGENTIC_PLAN_STATES)[number];

export interface AgenticPlanNode {
  readonly nodeId: string;
  readonly nodeType: AgenticNodeType;
  /** `null` only for an authority checkpoint, which runs no worker at all. */
  readonly capabilityId: string | null;
  readonly workerKind: AgenticWorkerKind | null;
  /**
   * The reviewed provider binding this node executes against, or `null` when it
   * runs no model. It participates in `payloadHash`, so changing which provider
   * a node uses changes the node, which changes the plan — an approval given for
   * one provider cannot silently carry onto another.
   */
  readonly providerBindingId: string | null;
  readonly dependencyIds: readonly string[];
  /** Node ids whose accepted output becomes this node's input. */
  readonly inputRefs: readonly string[];
  readonly authorityRequirement: "none" | "human_approval_bound_to_candidate_hash";
  readonly budget: {
    readonly maxToolCalls: number;
    readonly maxModelCalls: number;
    readonly maxDurationMs: number;
    readonly maxTokens: number | null;
    readonly maxCostMicros: number | null;
  };
  readonly deadlineOffsetMs: number;
  readonly attemptLimit: number;
  readonly reconciliationMode: string;
  readonly evidencePolicy: {
    readonly minimumItems: number;
    readonly requireAcceptedContextReference: boolean;
  };
  /** Canonical digest of everything above. Changes when any bound changes. */
  readonly payloadHash: string;
}

export interface AgenticPlanEdge {
  readonly fromNodeId: string;
  readonly toNodeId: string;
}

export interface AgenticCompiledPlan {
  readonly schemaVersion: typeof AGENTIC_PLAN_SCHEMA_VERSION;
  readonly planId: string;
  readonly missionId: string;
  readonly intentHash: string;
  readonly contextBundleId: string;
  readonly nodes: readonly AgenticPlanNode[];
  readonly edges: readonly AgenticPlanEdge[];
  readonly maxParallelism: number;
  readonly planHash: string;
}

export function createAgenticNodePayloadHash(node: Omit<AgenticPlanNode, "payloadHash">): string {
  return digest(NODE_PAYLOAD_HASH_DOMAIN, canonicalizeAgenticJson({
    nodeId: node.nodeId,
    nodeType: node.nodeType,
    capabilityId: node.capabilityId,
    workerKind: node.workerKind,
    providerBindingId: node.providerBindingId,
    dependencyIds: [...node.dependencyIds],
    inputRefs: [...node.inputRefs],
    authorityRequirement: node.authorityRequirement,
    budget: { ...node.budget },
    deadlineOffsetMs: node.deadlineOffsetMs,
    attemptLimit: node.attemptLimit,
    reconciliationMode: node.reconciliationMode,
    evidencePolicy: { ...node.evidencePolicy },
  }));
}

/**
 * Deterministic plan identity.
 *
 * A pure function of the intent hash, the context bundle id, and every node
 * payload hash — so the same approved mission and the same admitted context
 * always compile to the same `planId`, and any change produces a different one
 * rather than mutating the plan an approval was bound to.
 */
export function createAgenticPlanHash(input: {
  readonly missionId: string;
  readonly intentHash: string;
  readonly contextBundleId: string;
  readonly maxParallelism: number;
  readonly nodes: readonly AgenticPlanNode[];
  readonly edges: readonly AgenticPlanEdge[];
}): string {
  return digest(PLAN_HASH_DOMAIN, canonicalizeAgenticJson({
    missionId: input.missionId,
    intentHash: input.intentHash,
    contextBundleId: input.contextBundleId,
    maxParallelism: input.maxParallelism,
    nodes: input.nodes
      .map((node) => `${node.nodeId}:${node.payloadHash}`)
      .sort(),
    edges: input.edges
      .map((edge) => `${edge.fromNodeId}->${edge.toNodeId}`)
      .sort(),
  }));
}

export function agenticPlanIdFor(planHash: string): string {
  return `plan-${planHash.slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// Candidate and artifact digests
// ---------------------------------------------------------------------------

/**
 * Digest of the exact bytes an approval authorizes.
 *
 * One digest serves both roles on purpose: the approval binds this value, the
 * write refuses bytes that hash differently, and outcome verification recomputes
 * it from what is actually on disk. A second "artifact digest" over the same
 * bytes would only create two numbers that must be kept in agreement.
 */
export function createAgenticCandidateHash(renderedMarkdown: string): string {
  return digest(CANDIDATE_HASH_DOMAIN, renderedMarkdown);
}

// ---------------------------------------------------------------------------
// Value observation
// ---------------------------------------------------------------------------

/**
 * The terminal, durable answer to "what did this mission actually produce".
 *
 * Every numeric field is measured. Unmeasured cost is `null` rather than zero,
 * because zero is a claim and `null` is the truth.
 */
export interface AgenticValueObservation {
  readonly objectiveSatisfied: boolean;
  readonly acceptanceCriteriaPassed: boolean;
  readonly acceptedClaimCount: number;
  readonly rejectedClaimCount: number;
  readonly evidenceCoverage: number;
  readonly uncertaintyCount: number;
  readonly artifactHash: string | null;
  readonly artifactWriteCount: number;
  readonly workerCount: number;
  readonly parallelismObserved: number;
  readonly toolCallCount: number;
  readonly modelCallCount: number;
  readonly tokenCost: number | null;
  readonly monetaryCost: number | null;
  readonly latencyMs: number;
  readonly humanApprovals: number;
  readonly recoveryEvents: number;
  readonly duplicateExecutionsPrevented: number;
  // -- Measured model usage -------------------------------------------------
  // Every field below is read from durable provider usage rows. A count is zero
  // only when zero was observed; a cost is `null` whenever it was never
  // measured, and no branch anywhere turns an unknown into a zero.
  readonly modelWorkerCount: number;
  readonly providerCallCount: number;
  readonly providerFallbackCount: number;
  readonly inputTokenCount: number | null;
  readonly outputTokenCount: number | null;
  readonly totalTokenCount: number | null;
  /** How the token counts were obtained, or why there are none. */
  readonly tokenCostSource: "provider_measured" | "not_measured";
  readonly monetaryCostMicros: number | null;
  readonly monetaryCostSource:
    | "provider_reported"
    | "local_price_snapshot"
    | "unpriced_local_compute"
    | "not_measured"
    | "mixed";
  readonly duplicateModelCallsPrevented: number;
  /**
   * Provider calls that actually cost money — those carrying a measured charge.
   *
   * Distinct from `providerCallCount`, which includes unbilled local inference
   * and failed dispatches. Conflating them would make an unbilled run look
   * financially identical to a billed one.
   */
  readonly billedProviderCallCount: number;
  /**
   * Whether those charges were independently confirmed against the provider's
   * own billing record. `mixed` when billed calls disagree, which is itself the
   * signal — it must never be collapsed into the more favourable verdict.
   */
  readonly billingReconciliationVerdict:
    | "matched"
    | "mismatched"
    | "unavailable"
    | "not_attempted"
    | "mixed";
  /** `provider/model` identities actually invoked, sorted and de-duplicated. */
  readonly modelIdentitiesUsed: readonly string[];
  /** Provider call keys of the durable usage rows this observation summarizes. */
  readonly providerUsageReferences: readonly string[];
}
