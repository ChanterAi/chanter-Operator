/**
 * Real-write readiness and compensation gate — proofs.
 *
 * These decide whether CHANTER OS may authorize its first bounded real write.
 * They perform none, and there is nothing here that could: this module imports
 * no connector, no transport, and no mission service. It evaluates declared
 * semantics and hashes the result.
 *
 * The most important test in this file is the one that proves the *predecessor's*
 * target is still ineligible. A gate that only ever confirms what the last slice
 * hoped for is not a gate.
 */
import { describe, expect, it } from "vitest";

import {
  REAL_WRITE_CANDIDATES,
  REAL_WRITE_INSPECTED_WITHOUT_CANDIDATE,
} from "../src/agentic/agenticRealWriteCandidates.js";
import {
  compileCompensationPlan,
  compileRealWriteApprovalCandidate,
  createEligibilityHash,
  decideRealWriteVerdict,
  evaluateRealWriteEligibility,
  REAL_WRITE_READINESS_SCHEMA_VERSION,
  type RealWriteEligibilityRecord,
} from "../src/agentic/agenticRealWriteReadiness.js";

/** A record that passes every rule, so each test can break exactly one. */
function eligibleRecord(
  overrides: Partial<RealWriteEligibilityRecord> = {},
): RealWriteEligibilityRecord {
  return {
    schemaVersion: REAL_WRITE_READINESS_SCHEMA_VERSION,
    connectorId: "connector.test.sandbox.v1",
    systemType: "document_store",
    environment: "sandbox",
    externalObjectId: "sandbox://probe/doc-1",
    writeCapability: "document.create",
    writePayloadSchema: ["probeId"],
    preconditionRevisionType: "etag",
    preconditionRevisionValue: "etag-1",
    idempotencySupport: "deterministic_identity",
    idempotencyKeyStrategy: "caller-chosen id",
    compensationMode: "idempotent_create_delete",
    compensationCapability: "document.delete",
    verificationOracle: {
      oracleId: "oracle.test.get.v1",
      method: "independent read",
      independentOfWriteResponse: true,
    },
    maximumBlastRadius: {
      scope: "one document in a dedicated sandbox collection",
      objectCount: 1,
      customerVisible: false,
      reversible: true,
    },
    humanApprovalRequired: true,
    writeEnabled: false,
    writeAuthorityEstablished: true,
    notes: "synthetic control record",
    ...overrides,
  };
}

describe("real-write eligibility rules", () => {
  it("accepts a candidate that satisfies every rule", () => {
    const outcome = evaluateRealWriteEligibility(eligibleRecord());
    expect(outcome.rejections).toEqual([]);
    expect(outcome.eligible).toBe(true);
  });

  it("rejects a candidate with no compensation, however good the rest is", () => {
    // The whole thesis of the gate: identity, revision, and verification cannot
    // buy eligibility for a write nobody can undo.
    const outcome = evaluateRealWriteEligibility(eligibleRecord({
      compensationMode: "none",
      compensationCapability: null,
    }));
    expect(outcome.eligible).toBe(false);
    expect(outcome.rejections).toContain("no_compensation");
  });

  it("rejects a compensation mode that names no operation", () => {
    // A mode without a mechanism is a claim, not a plan.
    const outcome = evaluateRealWriteEligibility(eligibleRecord({
      compensationCapability: null,
    }));
    expect(outcome.rejections).toContain("no_compensation");
  });

  it("rejects a reconciliation-safe mutation whose preconditions do not hold", () => {
    const weakRevision = evaluateRealWriteEligibility(eligibleRecord({
      compensationMode: "reconciliation_safe_mutation",
      compensationCapability: "document.write",
      preconditionRevisionType: "update_time",
      preconditionRevisionValue: "2026-08-07T00:00:00Z",
    }));
    expect(weakRevision.rejections).toContain("reconciliation_unsafe_mutation");

    const notIdempotent = evaluateRealWriteEligibility(eligibleRecord({
      compensationMode: "reconciliation_safe_mutation",
      compensationCapability: "document.write",
      idempotencySupport: "none",
    }));
    expect(notIdempotent.rejections).toContain("reconciliation_unsafe_mutation");
  });

  it("rejects a write that cannot be made conditional on an exact pre-state", () => {
    const noType = evaluateRealWriteEligibility(eligibleRecord({
      preconditionRevisionType: "none",
    }));
    expect(noType.rejections).toContain("weak_revision_semantics");

    const noValue = evaluateRealWriteEligibility(eligibleRecord({
      preconditionRevisionValue: null,
    }));
    expect(noValue.rejections).toContain("weak_revision_semantics");
  });

  it("rejects verification that is only the write's own report", () => {
    const outcome = evaluateRealWriteEligibility(eligibleRecord({
      verificationOracle: {
        oracleId: "oracle.self.v1",
        method: "the mutation response",
        independentOfWriteResponse: false,
      },
    }));
    expect(outcome.rejections).toContain("verification_not_independent");
  });

  it("rejects a blast radius that is unbounded, visible, or irreversible", () => {
    expect(evaluateRealWriteEligibility(eligibleRecord({
      maximumBlastRadius: { scope: "many", objectCount: 12, customerVisible: false, reversible: true },
    })).rejections).toContain("blast_radius_unbounded");

    expect(evaluateRealWriteEligibility(eligibleRecord({
      maximumBlastRadius: { scope: "one", objectCount: 1, customerVisible: true, reversible: true },
    })).rejections).toContain("blast_radius_unbounded");

    expect(evaluateRealWriteEligibility(eligibleRecord({
      maximumBlastRadius: { scope: "one", objectCount: 1, customerVisible: false, reversible: false },
    })).rejections).toContain("blast_radius_unbounded");
  });

  it("rejects a target with no established write authority", () => {
    // Reachability is not authority. A credential belonging to another product
    // is reachable and not authorized, and the gate keeps those apart.
    const outcome = evaluateRealWriteEligibility(eligibleRecord({
      writeAuthorityEstablished: false,
    }));
    expect(outcome.rejections).toContain("no_write_authority");
  });

  it("reports every failed rule, not merely the first", () => {
    const outcome = evaluateRealWriteEligibility(eligibleRecord({
      compensationMode: "none",
      compensationCapability: null,
      preconditionRevisionType: "none",
      verificationOracle: {
        oracleId: "oracle.self.v1",
        method: "the mutation response",
        independentOfWriteResponse: false,
      },
      writeAuthorityEstablished: false,
    }));
    // A person deciding what to fix needs the whole list, not one round of it.
    expect(outcome.rejections).toEqual([
      "no_compensation",
      "no_write_authority",
      "verification_not_independent",
      "weak_revision_semantics",
    ]);
  });
});

describe("the real candidate inventory", () => {
  it("declares no eligible candidate, and blocks rather than degrades", () => {
    const outcomes = REAL_WRITE_CANDIDATES.map(evaluateRealWriteEligibility);
    expect(outcomes.every((outcome) => !outcome.eligible)).toBe(true);
    expect(decideRealWriteVerdict(outcomes)).toBe("BLOCKED_NO_COMPENSABLE_TARGET");
  });

  it("keeps the predecessor's git ref target explicitly ineligible", () => {
    // P0-B proved this target read-only at 16/16. It is still not writable, and
    // the gate says so by name rather than by omitting it.
    const refUpdate = REAL_WRITE_CANDIDATES.find(
      (record) => record.writeCapability === "ref.update",
    );
    expect(refUpdate).toBeDefined();
    const outcome = evaluateRealWriteEligibility(refUpdate!);
    expect(outcome.eligible).toBe(false);
    expect(outcome.rejections).toContain("no_compensation");
    // A force-push is a second, larger write — never a rollback.
    expect(refUpdate!.maximumBlastRadius.reversible).toBe(false);
  });

  it("holds every candidate at write_enabled false with approval required", () => {
    for (const record of REAL_WRITE_CANDIDATES) {
      expect(record.writeEnabled).toBe(false);
      expect(record.humanApprovalRequired).toBe(true);
      expect(record.writeAuthorityEstablished).toBe(false);
    }
  });

  it("records the systems inspected that produced no candidate at all", () => {
    const systems = REAL_WRITE_INSPECTED_WITHOUT_CANDIDATE.map((entry) => entry.system);
    expect(systems.some((system) => system.includes("solar"))).toBe(true);
    expect(systems.some((system) => system.includes("HVAC"))).toBe(true);
    for (const entry of REAL_WRITE_INSPECTED_WITHOUT_CANDIDATE) {
      expect(entry.finding.length).toBeGreaterThan(40);
    }
  });
});

describe("approval binding and plan stability", () => {
  const plan = compileCompensationPlan({
    mode: "idempotent_create_delete",
    capability: "document.delete",
    steps: ["read the created object", "delete it by exact id", "read again and confirm absence"],
    verification: "independent read returning not-found",
    residualEffect: "an audit entry recording that the object briefly existed",
  });

  it("derives a stable compensation plan hash", () => {
    const again = compileCompensationPlan({
      mode: "idempotent_create_delete",
      capability: "document.delete",
      steps: ["read the created object", "delete it by exact id", "read again and confirm absence"],
      verification: "independent read returning not-found",
      residualEffect: "an audit entry recording that the object briefly existed",
    });
    expect(again.compensationPlanHash).toBe(plan.compensationPlanHash);
    expect(plan.compensationPlanHash).toHaveLength(64);
  });

  it("changes the plan hash when the undo changes", () => {
    const weaker = compileCompensationPlan({
      mode: "idempotent_create_delete",
      capability: "document.delete",
      steps: ["delete it by exact id"],
      verification: "independent read returning not-found",
      residualEffect: "an audit entry recording that the object briefly existed",
    });
    expect(weaker.compensationPlanHash).not.toBe(plan.compensationPlanHash);
  });

  it("binds every fact the eventual approval must carry", () => {
    const record = eligibleRecord();
    const candidate = compileRealWriteApprovalCandidate({
      record,
      plan,
      writePayloadHash: "a".repeat(64),
      idempotencyKey: "probe-1",
    });

    expect(candidate.connectorId).toBe(record.connectorId);
    expect(candidate.externalObjectId).toBe(record.externalObjectId);
    expect(candidate.preStateRevision).toBe("etag-1");
    expect(candidate.writeCapability).toBe("document.create");
    expect(candidate.compensationPlanHash).toBe(plan.compensationPlanHash);
    expect(candidate.verificationOracleId).toBe("oracle.test.get.v1");
    expect(candidate.maximumBlastRadius.objectCount).toBe(1);
    // A readiness candidate authorizes nothing, and cannot be made to.
    expect(candidate.writeEnabled).toBe(false);
    expect(candidate.approvalCandidateHash).toHaveLength(64);
  });

  it("refuses to carry an approval onto a changed payload, target, or revision", () => {
    const record = eligibleRecord();
    const base = compileRealWriteApprovalCandidate({
      record, plan, writePayloadHash: "a".repeat(64), idempotencyKey: "probe-1",
    });

    const changedPayload = compileRealWriteApprovalCandidate({
      record, plan, writePayloadHash: "b".repeat(64), idempotencyKey: "probe-1",
    });
    const changedTarget = compileRealWriteApprovalCandidate({
      record: eligibleRecord({ externalObjectId: "sandbox://probe/doc-2" }),
      plan, writePayloadHash: "a".repeat(64), idempotencyKey: "probe-1",
    });
    const changedRevision = compileRealWriteApprovalCandidate({
      record: eligibleRecord({ preconditionRevisionValue: "etag-2" }),
      plan, writePayloadHash: "a".repeat(64), idempotencyKey: "probe-1",
    });
    const changedKey = compileRealWriteApprovalCandidate({
      record, plan, writePayloadHash: "a".repeat(64), idempotencyKey: "probe-2",
    });
    const changedPlan = compileRealWriteApprovalCandidate({
      record,
      plan: compileCompensationPlan({
        mode: "compensating_action",
        capability: "document.restore",
        steps: ["restore the prior value"],
        verification: "independent read",
        residualEffect: "none",
      }),
      writePayloadHash: "a".repeat(64),
      idempotencyKey: "probe-1",
    });

    // One hash, five ways to invalidate it — the same single mechanism the
    // artifact and connector lanes already bind approvals with.
    for (const variant of [changedPayload, changedTarget, changedRevision, changedKey, changedPlan]) {
      expect(variant.approvalCandidateHash).not.toBe(base.approvalCandidateHash);
    }
  });

  it("derives a stable eligibility hash for an unchanged record", () => {
    expect(createEligibilityHash(eligibleRecord()))
      .toBe(createEligibilityHash(eligibleRecord()));
    expect(createEligibilityHash(eligibleRecord({ compensationMode: "none" })))
      .not.toBe(createEligibilityHash(eligibleRecord()));
  });
});

describe("verdict selection", () => {
  it("reports the most actionable blocker rather than a generic one", () => {
    const compensation = decideRealWriteVerdict([
      evaluateRealWriteEligibility(eligibleRecord({
        compensationMode: "none", compensationCapability: null,
      })),
    ]);
    expect(compensation).toBe("BLOCKED_NO_COMPENSABLE_TARGET");

    const revision = decideRealWriteVerdict([
      evaluateRealWriteEligibility(eligibleRecord({ preconditionRevisionType: "none" })),
    ]);
    expect(revision).toBe("BLOCKED_INSUFFICIENT_REVISION_SEMANTICS");

    const verification = decideRealWriteVerdict([
      evaluateRealWriteEligibility(eligibleRecord({
        verificationOracle: {
          oracleId: "oracle.self.v1",
          method: "the mutation response",
          independentOfWriteResponse: false,
        },
      })),
    ]);
    expect(verification).toBe("BLOCKED_INSUFFICIENT_VERIFICATION");
  });

  it("reports ready only when some candidate is actually eligible", () => {
    expect(decideRealWriteVerdict([evaluateRealWriteEligibility(eligibleRecord())]))
      .toBe("READY_FOR_ONE_REAL_WRITE");
  });
});

describe("the gate cannot write", () => {
  it("exposes no operation that could reach a real system", async () => {
    // Structural rather than behavioural: the readiness module's entire export
    // surface is evaluation, compilation, and hashing. A gate that could also
    // perform the write it is judging would be the wrong shape no matter how
    // carefully it declined to use that power.
    const readiness = await import("../src/agentic/agenticRealWriteReadiness.js");
    const exported = Object.keys(readiness).sort();

    expect(exported).toEqual([
      "COMPENSATION_MODES",
      "IDEMPOTENCY_SUPPORTS",
      "PRECONDITION_REVISION_TYPES",
      "REAL_WRITE_READINESS_SCHEMA_VERSION",
      "REAL_WRITE_REJECTION_REASONS",
      "REAL_WRITE_VERDICTS",
      "TARGET_ENVIRONMENTS",
      "compileCompensationPlan",
      "compileRealWriteApprovalCandidate",
      "createEligibilityHash",
      "decideRealWriteVerdict",
      "evaluateRealWriteEligibility",
    ]);
    // No export is an imperative that *performs* something. "write" itself is
    // excluded from this list deliberately: it is this module's subject matter,
    // not an action it takes — `compileRealWriteApprovalCandidate` compiles a
    // description of a write, which is exactly the distinction being kept.
    for (const name of exported) {
      expect(/apply|execute|perform|invoke|mutate|send|dispatch|push/i.test(name)).toBe(false);
    }

    const candidates = await import("../src/agentic/agenticRealWriteCandidates.js");
    for (const record of candidates.REAL_WRITE_CANDIDATES) {
      expect(record.writeEnabled).toBe(false);
    }
  });
});
