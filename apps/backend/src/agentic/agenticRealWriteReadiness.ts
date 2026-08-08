/**
 * CHANTER OS — real-write readiness and compensation gate.
 *
 * Decides whether any real external action is safe enough to authorize as the
 * first bounded real write. It performs no write, and it contains no code that
 * could: this module is a *judgement* over declared semantics, and the only
 * thing it produces is evidence.
 *
 * ## Why eligibility is data rather than an opinion
 *
 * "Is this safe to write to?" is exactly the question a system under delivery
 * pressure answers optimistically. So it is answered here by evaluating a typed
 * record against explicit rules, and every rejection names the rule it failed.
 * A candidate cannot be talked into eligibility; it can only be *changed* into
 * eligibility, and the record then says so.
 *
 * ## The rule that does most of the work
 *
 * A write is only as safe as its undo. `compensationMode` is therefore not a
 * label — it is the axis eligibility turns on, and `"none"` is disqualifying no
 * matter how good the rest of the record looks. The predecessor slice's GitHub
 * ref update is the worked example: excellent identity, the strongest revision
 * semantics available anywhere in this system, independent verification — and no
 * compensation, because the only way to undo a ref update is to force it
 * backwards, which destroys whatever arrived in between.
 *
 * A force-overwrite is not a rollback. It is a second, larger write.
 *
 * ## Why the pre-state is a union rather than a revision string
 *
 * v1 asked every candidate for a revision value, which quietly assumed every
 * write mutates something that already exists. A *create* has no prior revision:
 * its exact pre-state is that the object is **absent**. v1 could only express
 * that as `null`, which the gate — correctly — read as "no exact pre-state".
 *
 * The two dishonest ways out are to invent a revision string for a thing that
 * does not exist, or to let `null` silently mean absence. Both make the record
 * say something untrue about the world. So the pre-state became a typed union:
 * absence is now a first-class condition that is explicit, hash-bound, and
 * reviewable, and Firestore enforces it server-side with `currentDocument.exists
 * =false`. A create binds to absence exactly as strictly as an update binds to a
 * revision.
 */
import { canonicalizeAgenticJson } from "chanter-agent-runtime";
import { createHash } from "node:crypto";

/**
 * v2: the pre-state condition became a typed union and the record gained an
 * unknown-outcome policy. The version is bumped rather than reused because every
 * hash in this module changes shape — an approval compiled against v1 must not
 * appear to survive the migration.
 */
export const REAL_WRITE_READINESS_SCHEMA_VERSION = "chanter.real-write-readiness.v2" as const;

const ELIGIBILITY_HASH_DOMAIN = "chanter.real-write-readiness.eligibility.v2";
const COMPENSATION_PLAN_HASH_DOMAIN = "chanter.real-write-readiness.compensation-plan.v2";
const APPROVAL_CANDIDATE_HASH_DOMAIN = "chanter.real-write-readiness.approval-candidate.v2";
const OBJECT_IDENTITY_HASH_DOMAIN = "chanter.real-write-readiness.object-identity.v1";

function digest(domain: string, payload: string): string {
  return createHash("sha256").update(domain).update(" ").update(payload).digest("hex");
}

/**
 * The hashed form of a pre-state condition.
 *
 * The two variants carry different keys, so a revision condition and an absence
 * condition can never canonicalize to the same bytes — which is what makes
 * "the approval was for a different pre-state" a detectable change rather than
 * an indistinguishable one.
 */
function canonicalPreState(condition: PreStateCondition): Record<string, string | boolean> {
  return condition.kind === "revision"
    ? {
      kind: "revision",
      revisionType: condition.revisionType,
      revisionValue: condition.revisionValue,
    }
    : {
      kind: "exists",
      expected: false,
      enforcedBy: condition.enforcedBy,
    };
}

/**
 * A stable, collision-safe object id derived from the identity of the work that
 * would create it.
 *
 * Firestore offers no request-level idempotency key, so the only thing standing
 * between a retry and a second object is the id itself. Deriving it from
 * mission and action identity means a replay of the same action addresses the
 * same document — and combined with an absence precondition, the second attempt
 * is a typed conflict rather than a duplicate.
 *
 * Uses the NUL domain separator convention the runtime's durable paths already
 * use, so `a|b` and `ab|` cannot collide.
 */
export function deriveDeterministicObjectId(input: {
  readonly missionId: string;
  readonly actionId: string;
}): string {
  return digest(
    OBJECT_IDENTITY_HASH_DOMAIN,
    `${input.missionId}\0${input.actionId}`,
  ).slice(0, 32);
}

/**
 * How an applied write could be undone, in the order §7 permits them.
 *
 * `reconciliation_safe_mutation` is last and narrowest on purpose: it is not an
 * undo at all, but a claim that the write is safe to *repeat*. It qualifies only
 * when every one of its four conditions holds, because a mutation that cannot be
 * undone and cannot be safely repeated is simply an irreversible action.
 */
export const COMPENSATION_MODES = [
  "native_rollback",
  "compensating_action",
  "idempotent_create_delete",
  "reconciliation_safe_mutation",
  "none",
] as const;

export type CompensationMode = (typeof COMPENSATION_MODES)[number];

/** What the source states about its own version, strongest first. */
export const PRECONDITION_REVISION_TYPES = [
  "content_hash",
  "etag",
  "version",
  "update_time",
  "none",
] as const;

export type PreconditionRevisionType = (typeof PRECONDITION_REVISION_TYPES)[number];

export const PRE_STATE_CONDITION_KINDS = ["revision", "exists"] as const;

export type PreStateConditionKind = (typeof PRE_STATE_CONDITION_KINDS)[number];

/** The object already exists, and the write is conditional on this exact version. */
export interface RevisionPreStateCondition {
  readonly kind: "revision";
  readonly revisionType: PreconditionRevisionType;
  readonly revisionValue: string;
}

/**
 * The object does not exist, and the write is conditional on it staying absent
 * until the moment it lands.
 *
 * `expected` is typed as the literal `false` rather than `boolean` on purpose.
 * A "must already exist" precondition is a different thing entirely — it is a
 * revision condition wearing an existence check's clothes, and it would let a
 * caller bind an approval to "something is there" without saying *which*
 * version of it. The literal makes that unrepresentable.
 *
 * `enforcedBy` names the server-side mechanism. Absence checked by the client
 * before calling is not a precondition, it is a race.
 */
export interface AbsentPreStateCondition {
  readonly kind: "exists";
  readonly expected: false;
  readonly enforcedBy: string;
}

export type PreStateCondition = RevisionPreStateCondition | AbsentPreStateCondition;

/**
 * How a lost response is resolved.
 *
 * Only the first member is honest. The other three are named so a record can
 * *declare* them and be rejected by name, which is more useful than leaving the
 * field free-text and hoping nobody writes "retry".
 */
export const UNKNOWN_OUTCOME_RESOLUTIONS = [
  "independent_read_of_exact_object",
  "blind_retry",
  "assume_applied",
  "assume_not_applied",
] as const;

export type UnknownOutcomeResolution = (typeof UNKNOWN_OUTCOME_RESOLUTIONS)[number];

/**
 * What to do when the write's response never arrives.
 *
 * "Unknown" is not "failed". A create whose response was lost may well have
 * landed, and the only way to find out is to ask the system — which is why
 * every branch below is a consequence of an independent read rather than an
 * assumption about what probably happened.
 */
export interface UnknownOutcomePolicy {
  readonly resolution: UnknownOutcomeResolution;
  /** Read says absent: the write was not observed to land. */
  readonly onAbsent: string;
  /** Read says present with the expected payload: already applied, do not repeat. */
  readonly onPresentMatchingPayload: string;
  /** Read says present with something else: a human decides. */
  readonly onPresentDifferentPayload: string;
  /** The read itself failed: still unknown. Never a licence to retry. */
  readonly onReadUnavailable: string;
}

export const IDEMPOTENCY_SUPPORTS = [
  /** The API accepts a caller-supplied key and collapses repeats itself. */
  "native_key",
  /** Object identity is chosen by the caller, so a repeat is a no-op or a conflict. */
  "deterministic_identity",
  /** The write is conditional on an exact prior revision. */
  "compare_and_swap",
  "none",
] as const;

export type IdempotencySupport = (typeof IDEMPOTENCY_SUPPORTS)[number];

/**
 * Which world the target lives in.
 *
 * `production` is not disqualifying by itself — a disposable object in a
 * production system can still be bounded — but it is the fact that makes the
 * blast-radius rules bite, so it is declared rather than inferred from a name.
 */
export const TARGET_ENVIRONMENTS = ["production", "sandbox", "test_tenant", "simulated"] as const;

export type TargetEnvironment = (typeof TARGET_ENVIRONMENTS)[number];

export interface VerificationOracleDeclaration {
  readonly oracleId: string;
  /** Exactly how the oracle re-reads the system. */
  readonly method: string;
  /**
   * Whether the oracle's evidence is obtained independently of the write call.
   *
   * `false` means the only evidence is what the mutation itself reported, which
   * is the component with an interest in the answer.
   */
  readonly independentOfWriteResponse: boolean;
}

export interface BlastRadiusBound {
  readonly scope: string;
  readonly objectCount: number;
  readonly customerVisible: boolean;
  /** Whether the effect can be removed, not merely overwritten. */
  readonly reversible: boolean;
}

/**
 * One candidate's declared semantics.
 *
 * `writeEnabled` is typed as the literal `false`. This record is readiness
 * evidence; a record that could carry `true` would be a switch, and this module
 * would then be part of a write path rather than a judgement about one.
 */
export interface RealWriteEligibilityRecord {
  readonly schemaVersion: typeof REAL_WRITE_READINESS_SCHEMA_VERSION;
  readonly connectorId: string;
  readonly systemType: string;
  readonly environment: TargetEnvironment;
  readonly externalObjectId: string;
  readonly writeCapability: string;
  /** Field names the write would set, and nothing wider. */
  readonly writePayloadSchema: readonly string[];
  /** The exact state the write is conditional on: a revision, or absence. */
  readonly preStateCondition: PreStateCondition;
  /** How a lost response for this write is resolved. */
  readonly unknownOutcomePolicy: UnknownOutcomePolicy;
  readonly idempotencySupport: IdempotencySupport;
  readonly idempotencyKeyStrategy: string;
  readonly compensationMode: CompensationMode;
  readonly compensationCapability: string | null;
  readonly verificationOracle: VerificationOracleDeclaration;
  readonly maximumBlastRadius: BlastRadiusBound;
  readonly humanApprovalRequired: true;
  readonly writeEnabled: false;
  /**
   * Whether a credential authorized *for CHANTER OS* can perform this write.
   *
   * Separate from reachability. A credential belonging to another product is
   * reachable and not authorized, and conflating the two is how a proof ends up
   * spending someone else's authority.
   */
  readonly writeAuthorityEstablished: boolean;
  /** Free-text provenance for the human reading this later. */
  readonly notes: string;
}

export const REAL_WRITE_REJECTION_REASONS = [
  "no_compensation",
  "compensation_requires_force_overwrite",
  "weak_revision_semantics",
  "verification_not_independent",
  "blast_radius_unbounded",
  "no_write_authority",
  "reconciliation_unsafe_mutation",
  "unknown_outcome_not_reconcilable",
] as const;

export type RealWriteRejectionReason = (typeof REAL_WRITE_REJECTION_REASONS)[number];

export const REAL_WRITE_VERDICTS = [
  "READY_FOR_ONE_REAL_WRITE",
  "BLOCKED_NO_COMPENSABLE_TARGET",
  "BLOCKED_INSUFFICIENT_REVISION_SEMANTICS",
  "BLOCKED_INSUFFICIENT_VERIFICATION",
] as const;

export type RealWriteVerdict = (typeof REAL_WRITE_VERDICTS)[number];

export interface RealWriteEligibilityOutcome {
  readonly connectorId: string;
  readonly externalObjectId: string;
  readonly eligible: boolean;
  /** Every rule this candidate failed, sorted. Never just the first. */
  readonly rejections: readonly RealWriteRejectionReason[];
  readonly eligibilityHash: string;
}

/**
 * Judges one candidate against every rule, and reports all failures.
 *
 * Deliberately not short-circuiting: a candidate that fails three rules should
 * show three, because the person deciding what to fix needs the whole list. A
 * first-failure-wins evaluator turns readiness work into a guessing game played
 * one round at a time.
 */
export function evaluateRealWriteEligibility(
  record: RealWriteEligibilityRecord,
): RealWriteEligibilityOutcome {
  const rejections: RealWriteRejectionReason[] = [];

  // §7 — the axis everything else hangs off.
  if (record.compensationMode === "none") {
    rejections.push("no_compensation");
  }
  if (record.compensationMode !== "none" && record.compensationCapability === null) {
    // A mode without a named operation is a claim without a mechanism.
    rejections.push("no_compensation");
  }
  const preState = record.preStateCondition;
  if (record.compensationMode === "reconciliation_safe_mutation") {
    // §7-D qualifies only under all four conditions. Any weakness in revision
    // or idempotency turns "safe to repeat" into "safe to repeat, probably".
    //
    // An absence condition can never satisfy this: "safe to repeat" is a claim
    // about re-applying a mutation to an object that exists, and absence is by
    // definition not that.
    const exactRevision = preState.kind === "revision"
      && (preState.revisionType === "content_hash"
        || preState.revisionType === "etag"
        || preState.revisionType === "version");
    const idempotent = record.idempotencySupport !== "none";
    if (!exactRevision || !idempotent || !record.verificationOracle.independentOfWriteResponse) {
      rejections.push("reconciliation_unsafe_mutation");
    }
  }

  // §9 — a write with no exact pre-state cannot be made conditional, so an
  // approval given at one moment could land on a state nobody approved.
  //
  // Absence is an exact pre-state, but only when something enforces it. A
  // client-side existence check before calling is a race, not a precondition,
  // so the mechanism has to be named.
  if (preState.kind === "revision") {
    if (preState.revisionType === "none" || preState.revisionValue.trim() === "") {
      rejections.push("weak_revision_semantics");
    }
  } else if (preState.enforcedBy.trim() === "") {
    rejections.push("weak_revision_semantics");
  }

  // §9 of the create-if-absent task — a lost response is not a failure, and
  // resolving it by assumption is how one logical write becomes two.
  const policy = record.unknownOutcomePolicy;
  const everyBranchAnswered = [
    policy.onAbsent,
    policy.onPresentMatchingPayload,
    policy.onPresentDifferentPayload,
    policy.onReadUnavailable,
  ].every((branch) => branch.trim() !== "");
  if (policy.resolution !== "independent_read_of_exact_object" || !everyBranchAnswered) {
    rejections.push("unknown_outcome_not_reconcilable");
  }

  // §11 — the write's own report is not evidence about the write.
  if (!record.verificationOracle.independentOfWriteResponse) {
    rejections.push("verification_not_independent");
  }

  // §8 — bounded means: countable, not customer-visible, and removable.
  if (record.maximumBlastRadius.objectCount !== 1
    || record.maximumBlastRadius.customerVisible
    || !record.maximumBlastRadius.reversible) {
    rejections.push("blast_radius_unbounded");
  }

  if (!record.writeAuthorityEstablished) {
    rejections.push("no_write_authority");
  }

  const sorted = [...new Set(rejections)].sort();
  return {
    connectorId: record.connectorId,
    externalObjectId: record.externalObjectId,
    eligible: sorted.length === 0,
    rejections: sorted,
    eligibilityHash: createEligibilityHash(record),
  };
}

export function createEligibilityHash(record: RealWriteEligibilityRecord): string {
  return digest(ELIGIBILITY_HASH_DOMAIN, canonicalizeAgenticJson({
    connectorId: record.connectorId,
    systemType: record.systemType,
    environment: record.environment,
    externalObjectId: record.externalObjectId,
    writeCapability: record.writeCapability,
    writePayloadSchema: [...record.writePayloadSchema].sort(),
    preStateCondition: canonicalPreState(record.preStateCondition),
    unknownOutcomePolicy: {
      resolution: record.unknownOutcomePolicy.resolution,
      onAbsent: record.unknownOutcomePolicy.onAbsent,
      onPresentMatchingPayload: record.unknownOutcomePolicy.onPresentMatchingPayload,
      onPresentDifferentPayload: record.unknownOutcomePolicy.onPresentDifferentPayload,
      onReadUnavailable: record.unknownOutcomePolicy.onReadUnavailable,
    },
    idempotencySupport: record.idempotencySupport,
    idempotencyKeyStrategy: record.idempotencyKeyStrategy,
    compensationMode: record.compensationMode,
    compensationCapability: record.compensationCapability,
    verificationOracle: {
      oracleId: record.verificationOracle.oracleId,
      method: record.verificationOracle.method,
      independentOfWriteResponse: record.verificationOracle.independentOfWriteResponse,
    },
    maximumBlastRadius: {
      scope: record.maximumBlastRadius.scope,
      objectCount: record.maximumBlastRadius.objectCount,
      customerVisible: record.maximumBlastRadius.customerVisible,
      reversible: record.maximumBlastRadius.reversible,
    },
    writeAuthorityEstablished: record.writeAuthorityEstablished,
  }));
}

/**
 * The exact undo, written down before the write is authorized.
 *
 * Bound by its own hash so an approval cannot be carried onto a different
 * recovery story. A compensation plan invented after an incident is not a plan;
 * it is an improvisation with a deadline.
 */
/**
 * The exact object the compensation acts on.
 *
 * Spelled out to this depth because "delete the document" is not a plan — a
 * plan has to say *which* document, in which database, in which project. A
 * compensation that names its target loosely is one incident away from being
 * pointed at the wrong system.
 */
export interface CompensationTarget {
  readonly connectorId: string;
  /** The external system: a project, account, or host. */
  readonly system: string;
  /** The container within it: a database, bucket, or repository. */
  readonly container: string;
  /** The exact object path. */
  readonly objectPath: string;
}

export interface CompensationPlan {
  readonly schemaVersion: typeof REAL_WRITE_READINESS_SCHEMA_VERSION;
  readonly mode: CompensationMode;
  readonly capability: string | null;
  readonly target: CompensationTarget;
  /** The payload whose effect this plan undoes. */
  readonly writePayloadHash: string;
  /**
   * How the revision that the delete will be conditional on is obtained.
   *
   * The distinction that matters: it must come from an independent re-read, not
   * from the create's own response. Deleting under a revision the write itself
   * reported means trusting the component with an interest in the answer.
   */
  readonly revisionAcquisition: string;
  /** The exact conditional-delete semantics, including what happens on mismatch. */
  readonly conditionalDelete: string;
  readonly verificationOracleId: string;
  /** Ordered operations that undo the write. */
  readonly steps: readonly string[];
  /** How restoration is confirmed, independently of the compensating call. */
  readonly verification: string;
  /** What remains true even after successful compensation. */
  readonly residualEffect: string;
  readonly compensationPlanHash: string;
}

export function compileCompensationPlan(input: {
  readonly mode: CompensationMode;
  readonly capability: string | null;
  readonly target: CompensationTarget;
  readonly writePayloadHash: string;
  readonly revisionAcquisition: string;
  readonly conditionalDelete: string;
  readonly verificationOracleId: string;
  readonly steps: readonly string[];
  readonly verification: string;
  readonly residualEffect: string;
}): CompensationPlan {
  const base = {
    mode: input.mode,
    capability: input.capability,
    target: {
      connectorId: input.target.connectorId,
      system: input.target.system,
      container: input.target.container,
      objectPath: input.target.objectPath,
    },
    writePayloadHash: input.writePayloadHash,
    revisionAcquisition: input.revisionAcquisition,
    conditionalDelete: input.conditionalDelete,
    verificationOracleId: input.verificationOracleId,
    steps: [...input.steps],
    verification: input.verification,
    residualEffect: input.residualEffect,
  };
  return {
    schemaVersion: REAL_WRITE_READINESS_SCHEMA_VERSION,
    ...base,
    compensationPlanHash: digest(COMPENSATION_PLAN_HASH_DOMAIN, canonicalizeAgenticJson(base)),
  };
}

/**
 * Everything a human would be agreeing to, in one hash.
 *
 * §13 requires the eventual approval to bind nine facts. Binding them
 * individually would be nine checks that could each be forgotten; binding them
 * into one candidate hash makes "the approval no longer matches" a single
 * comparison — the same mechanism the artifact and connector lanes already use.
 */
export interface RealWriteApprovalCandidate {
  readonly schemaVersion: typeof REAL_WRITE_READINESS_SCHEMA_VERSION;
  readonly connectorId: string;
  readonly externalObjectId: string;
  /**
   * The exact pre-state being approved.
   *
   * Changing `exists(false)` to any other condition changes the candidate hash,
   * so an approval given for "create this if it is not there" cannot be carried
   * onto "overwrite whatever is there now".
   */
  readonly preStateCondition: PreStateCondition;
  readonly writeCapability: string;
  readonly writePayloadHash: string;
  readonly idempotencyKey: string;
  readonly compensationPlanHash: string;
  readonly verificationOracleId: string;
  readonly maximumBlastRadius: BlastRadiusBound;
  /** Always `false` here. A readiness candidate authorizes nothing. */
  readonly writeEnabled: false;
  readonly approvalCandidateHash: string;
}

export function compileRealWriteApprovalCandidate(input: {
  readonly record: RealWriteEligibilityRecord;
  readonly plan: CompensationPlan;
  readonly writePayloadHash: string;
  readonly idempotencyKey: string;
}): RealWriteApprovalCandidate {
  const base = {
    connectorId: input.record.connectorId,
    externalObjectId: input.record.externalObjectId,
    // Every pre-state is now nameable — a revision, or absence — so there is no
    // longer a case where an approval cannot say what state it applies to.
    preStateCondition: canonicalPreState(input.record.preStateCondition),
    writeCapability: input.record.writeCapability,
    writePayloadHash: input.writePayloadHash,
    idempotencyKey: input.idempotencyKey,
    compensationPlanHash: input.plan.compensationPlanHash,
    verificationOracleId: input.record.verificationOracle.oracleId,
    maximumBlastRadius: {
      scope: input.record.maximumBlastRadius.scope,
      objectCount: input.record.maximumBlastRadius.objectCount,
      customerVisible: input.record.maximumBlastRadius.customerVisible,
      reversible: input.record.maximumBlastRadius.reversible,
    },
    writeEnabled: false as const,
  };
  return {
    schemaVersion: REAL_WRITE_READINESS_SCHEMA_VERSION,
    ...base,
    // The hash is taken over the canonical form; the candidate carries the typed
    // condition so a reviewer reads the real thing, not its hashed projection.
    preStateCondition: input.record.preStateCondition,
    approvalCandidateHash: digest(APPROVAL_CANDIDATE_HASH_DOMAIN, canonicalizeAgenticJson(base)),
  };
}

/**
 * The gate's verdict over the whole inventory.
 *
 * Reports the *most specific* blocking reason rather than a generic one, because
 * "no compensable target" and "revision semantics too weak" call for completely
 * different next steps — one needs a different system, the other needs a
 * different capability on the same system.
 */
export function decideRealWriteVerdict(
  outcomes: readonly RealWriteEligibilityOutcome[],
): RealWriteVerdict {
  if (outcomes.some((outcome) => outcome.eligible)) return "READY_FOR_ONE_REAL_WRITE";

  const everyRejection = new Set(outcomes.flatMap((outcome) => [...outcome.rejections]));
  // Ordered by which finding a human should act on first. A candidate that has
  // no undo is not made eligible by better revision semantics, so compensation
  // is reported ahead of both other blockers.
  const compensationBlocked = everyRejection.has("no_compensation")
    || everyRejection.has("compensation_requires_force_overwrite")
    || everyRejection.has("reconciliation_unsafe_mutation")
    || everyRejection.has("blast_radius_unbounded")
    || everyRejection.has("no_write_authority")
    // A write that cannot resolve its own unknown outcome cannot be compensated
    // either: you cannot undo what you are not sure happened.
    || everyRejection.has("unknown_outcome_not_reconcilable");
  if (compensationBlocked) return "BLOCKED_NO_COMPENSABLE_TARGET";
  if (everyRejection.has("weak_revision_semantics")) {
    return "BLOCKED_INSUFFICIENT_REVISION_SEMANTICS";
  }
  return "BLOCKED_INSUFFICIENT_VERIFICATION";
}
