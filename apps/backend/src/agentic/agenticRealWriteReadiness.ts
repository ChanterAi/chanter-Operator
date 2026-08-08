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
 */
import { canonicalizeAgenticJson } from "chanter-agent-runtime";
import { createHash } from "node:crypto";

export const REAL_WRITE_READINESS_SCHEMA_VERSION = "chanter.real-write-readiness.v1" as const;

const ELIGIBILITY_HASH_DOMAIN = "chanter.real-write-readiness.eligibility.v1";
const COMPENSATION_PLAN_HASH_DOMAIN = "chanter.real-write-readiness.compensation-plan.v1";
const APPROVAL_CANDIDATE_HASH_DOMAIN = "chanter.real-write-readiness.approval-candidate.v1";

function digest(domain: string, payload: string): string {
  return createHash("sha256").update(domain).update(" ").update(payload).digest("hex");
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
  readonly preconditionRevisionType: PreconditionRevisionType;
  readonly preconditionRevisionValue: string | null;
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
  if (record.compensationMode === "reconciliation_safe_mutation") {
    // §7-D qualifies only under all four conditions. Any weakness in revision
    // or idempotency turns "safe to repeat" into "safe to repeat, probably".
    const exactRevision = record.preconditionRevisionType === "content_hash"
      || record.preconditionRevisionType === "etag"
      || record.preconditionRevisionType === "version";
    const idempotent = record.idempotencySupport !== "none";
    if (!exactRevision || !idempotent || !record.verificationOracle.independentOfWriteResponse) {
      rejections.push("reconciliation_unsafe_mutation");
    }
  }

  // §9 — a write with no exact pre-state cannot be made conditional, so an
  // approval given at one moment could land on a state nobody approved.
  if (record.preconditionRevisionType === "none" || record.preconditionRevisionValue === null) {
    rejections.push("weak_revision_semantics");
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
    preconditionRevisionType: record.preconditionRevisionType,
    preconditionRevisionValue: record.preconditionRevisionValue,
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
export interface CompensationPlan {
  readonly schemaVersion: typeof REAL_WRITE_READINESS_SCHEMA_VERSION;
  readonly mode: CompensationMode;
  readonly capability: string | null;
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
  readonly steps: readonly string[];
  readonly verification: string;
  readonly residualEffect: string;
}): CompensationPlan {
  const base = {
    mode: input.mode,
    capability: input.capability,
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
  readonly preStateRevision: string;
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
    // A candidate compiled against no revision is refused rather than hashed:
    // an approval that cannot name the state it applies to is not bindable.
    preStateRevision: input.record.preconditionRevisionValue ?? "",
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
    || everyRejection.has("no_write_authority");
  if (compensationBlocked) return "BLOCKED_NO_COMPENSABLE_TARGET";
  if (everyRejection.has("weak_revision_semantics")) {
    return "BLOCKED_INSUFFICIENT_REVISION_SEMANTICS";
  }
  return "BLOCKED_INSUFFICIENT_VERIFICATION";
}
