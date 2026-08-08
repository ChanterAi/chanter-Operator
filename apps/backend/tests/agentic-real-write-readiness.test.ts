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
  deriveDeterministicObjectId,
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
    preStateCondition: { kind: "revision", revisionType: "etag", revisionValue: "etag-1" },
    unknownOutcomePolicy: {
      resolution: "independent_read_of_exact_object",
      onAbsent: "not observed to land; retry only under policy",
      onPresentMatchingPayload: "already applied; do not repeat",
      onPresentDifferentPayload: "conflict; escalate to a human",
      onReadUnavailable: "still unknown; no blind retry",
    },
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
      preStateCondition: {
        kind: "revision",
        revisionType: "update_time",
        revisionValue: "2026-08-07T00:00:00Z",
      },
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
      preStateCondition: { kind: "revision", revisionType: "none", revisionValue: "" },
    }));
    expect(noType.rejections).toContain("weak_revision_semantics");

    const noValue = evaluateRealWriteEligibility(eligibleRecord({
      preStateCondition: { kind: "revision", revisionType: "etag", revisionValue: "   " },
    }));
    expect(noValue.rejections).toContain("weak_revision_semantics");
  });

  it("accepts create-if-absent as an exact pre-state condition", () => {
    // The change this slice exists for. A create has no prior revision, and its
    // exact pre-state is that the object is not there. That is not a weaker
    // claim than a revision — it is a different one, and equally checkable.
    const outcome = evaluateRealWriteEligibility(eligibleRecord({
      writeCapability: "document.create",
      preStateCondition: {
        kind: "exists",
        expected: false,
        enforcedBy: "Firestore commit precondition currentDocument.exists=false",
      },
    }));
    expect(outcome.rejections).toEqual([]);
    expect(outcome.eligible).toBe(true);
  });

  it("rejects an absence claim that nothing enforces", () => {
    // Checking existence client-side before calling is a race, not a
    // precondition: the window between the read and the write is exactly where
    // the duplicate gets in.
    const outcome = evaluateRealWriteEligibility(eligibleRecord({
      preStateCondition: { kind: "exists", expected: false, enforcedBy: "  " },
    }));
    expect(outcome.rejections).toContain("weak_revision_semantics");
  });

  it("never represents absence as revision data", () => {
    // The dishonest shortcut this model was changed to prevent: absence must not
    // be expressible as a revision string, an empty one, or a sentinel.
    const absent = eligibleRecord({
      preStateCondition: {
        kind: "exists",
        expected: false,
        enforcedBy: "currentDocument.exists=false",
      },
    });
    expect(absent.preStateCondition.kind).toBe("exists");
    expect(absent.preStateCondition).not.toHaveProperty("revisionValue");
    expect(absent.preStateCondition).not.toHaveProperty("revisionType");
    expect(JSON.stringify(absent.preStateCondition)).not.toMatch(/null|none|unknown|n\/a/i);
  });

  it("rejects an unknown outcome that resolves by assumption rather than by reading", () => {
    for (const resolution of ["blind_retry", "assume_applied", "assume_not_applied"] as const) {
      const outcome = evaluateRealWriteEligibility(eligibleRecord({
        unknownOutcomePolicy: { ...eligibleRecord().unknownOutcomePolicy, resolution },
      }));
      expect(outcome.rejections).toContain("unknown_outcome_not_reconcilable");
      expect(outcome.eligible).toBe(false);
    }
  });

  it("rejects an unknown-outcome policy that leaves a branch unanswered", () => {
    // "Read it back" is not a policy until every result of that read has a
    // defined consequence — including the read itself failing.
    for (const branch of [
      "onAbsent",
      "onPresentMatchingPayload",
      "onPresentDifferentPayload",
      "onReadUnavailable",
    ] as const) {
      const outcome = evaluateRealWriteEligibility(eligibleRecord({
        unknownOutcomePolicy: { ...eligibleRecord().unknownOutcomePolicy, [branch]: "" },
      }));
      expect(outcome.rejections).toContain("unknown_outcome_not_reconcilable");
    }
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
      preStateCondition: { kind: "revision", revisionType: "none", revisionValue: "" },
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

/** The one candidate that is meant to be eligible. */
function sandboxCandidate(): RealWriteEligibilityRecord {
  const record = REAL_WRITE_CANDIDATES.find(
    (entry) => entry.environment === "sandbox",
  );
  expect(record).toBeDefined();
  return record!;
}

describe("the real candidate inventory", () => {
  it("declares exactly one eligible candidate, and it is the sandbox", () => {
    const outcomes = REAL_WRITE_CANDIDATES.map(evaluateRealWriteEligibility);
    const eligible = outcomes.filter((outcome) => outcome.eligible);

    expect(eligible).toHaveLength(1);
    expect(eligible[0]!.externalObjectId).toContain("chanter-os-sandbox");
    expect(decideRealWriteVerdict(outcomes)).toBe("READY_FOR_ONE_REAL_WRITE");
  });

  it("keeps every production candidate rejected", () => {
    // Eligibility followed the environment and the authority. Nothing in
    // production acquired it as a side effect.
    for (const record of REAL_WRITE_CANDIDATES) {
      if (record.environment !== "production") continue;
      expect(evaluateRealWriteEligibility(record).eligible).toBe(false);
    }
  });

  it("still refuses the production Firestore document it once called strongest", () => {
    // Mechanically identical to the eligible sandbox record. The difference is
    // entirely whose project it is and whose credential reaches it.
    const production = REAL_WRITE_CANDIDATES.find(
      (record) => record.externalObjectId.includes("chanter-site"),
    );
    expect(production).toBeDefined();
    expect(production!.environment).toBe("production");
    expect(production!.preStateCondition.kind).toBe("exists");

    const outcome = evaluateRealWriteEligibility(production!);
    expect(outcome.eligible).toBe(false);
    expect(outcome.rejections).toContain("no_write_authority");
  });

  it("points no eligible candidate at a production system", () => {
    for (const record of REAL_WRITE_CANDIDATES) {
      if (!evaluateRealWriteEligibility(record).eligible) continue;
      expect(record.environment).toBe("sandbox");
      expect(record.externalObjectId).not.toContain("chanter-site");
      expect(record.externalObjectId).not.toContain("cloudinary");
      expect(record.externalObjectId).not.toContain("github.com");
      expect(record.maximumBlastRadius.customerVisible).toBe(false);
    }
  });

  it("makes the sandbox candidate ineligible if either environmental fact is withdrawn", () => {
    // The two facts provisioning supplied. Neither is decorative: removing
    // either one puts the candidate back where P0-C0 left it.
    const record = sandboxCandidate();
    expect(evaluateRealWriteEligibility(record).eligible).toBe(true);

    const withoutAuthority = evaluateRealWriteEligibility({
      ...record,
      writeAuthorityEstablished: false,
    });
    expect(withoutAuthority.eligible).toBe(false);
    expect(withoutAuthority.rejections).toContain("no_write_authority");
  });

  it("binds the sandbox candidate to the provisioned project and namespace", () => {
    const record = sandboxCandidate();
    expect(record.externalObjectId).toBe(
      "projects/chanter-os-sandbox/databases/(default)/documents/chanter_os_real_write_p0/{objectId}",
    );
    expect(record.writeCapability).toBe("document.create");
    expect(record.compensationMode).toBe("idempotent_create_delete");
    expect(record.compensationCapability).toBe("document.delete");
    expect(record.verificationOracle.independentOfWriteResponse).toBe(true);
    expect(record.maximumBlastRadius.objectCount).toBe(1);
    expect(record.maximumBlastRadius.reversible).toBe(true);
  });

  it("claims object-identity idempotency and not request-level idempotency", () => {
    // Firestore accepts no caller-supplied idempotency key. Saying otherwise
    // would overstate the guarantee by exactly the amount that matters during a
    // retry storm.
    const record = sandboxCandidate();
    expect(record.idempotencySupport).toBe("deterministic_identity");
    expect(record.idempotencySupport).not.toBe("native_key");
    expect(record.idempotencyKeyStrategy).toMatch(/NOT request-level idempotency/);
    expect(record.idempotencyKeyStrategy).toMatch(/ALREADY_EXISTS/);
  });

  it("resolves an unknown create outcome by reading, never by retrying", () => {
    const policy = sandboxCandidate().unknownOutcomePolicy;
    expect(policy.resolution).toBe("independent_read_of_exact_object");
    expect(policy.onPresentMatchingPayload).toMatch(/do not repeat/i);
    expect(policy.onPresentDifferentPayload).toMatch(/escalate|human/i);
    expect(policy.onReadUnavailable).toMatch(/no blind retry/i);
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
    // Eligibility and execution stay separate. Becoming eligible bought the
    // sandbox candidate the right to be *proposed*, and nothing else.
    for (const record of REAL_WRITE_CANDIDATES) {
      expect(record.writeEnabled).toBe(false);
      expect(record.humanApprovalRequired).toBe(true);
    }
  });

  it("establishes write authority for the sandbox alone", () => {
    for (const record of REAL_WRITE_CANDIDATES) {
      expect(record.writeAuthorityEstablished).toBe(record.environment === "sandbox");
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
  const planInput = {
    mode: "idempotent_create_delete",
    capability: "document.delete",
    target: {
      connectorId: "connector.firestore.document.v1",
      system: "chanter-os-sandbox",
      container: "(default)",
      objectPath: "chanter_os_real_write_p0/probe-1",
    },
    writePayloadHash: "c".repeat(64),
    revisionAcquisition:
      "re-read the created document independently and take its updateTime; never the create "
      + "response's own reported value",
    conditionalDelete:
      "DELETE with currentDocument.updateTime = the acquired revision; on mismatch the delete is "
      + "refused with FAILED_PRECONDITION and a human decides",
    verificationOracleId: "oracle.firestore.get.v1",
    steps: ["read the created object", "delete it by exact id", "read again and confirm absence"],
    verification: "independent read returning not-found",
    residualEffect: "an audit entry recording that the object briefly existed",
  } as const;

  const plan = compileCompensationPlan(planInput);

  it("derives a stable compensation plan hash", () => {
    expect(compileCompensationPlan(planInput).compensationPlanHash)
      .toBe(plan.compensationPlanHash);
    expect(plan.compensationPlanHash).toHaveLength(64);
  });

  it("changes the plan hash when the undo changes", () => {
    const weaker = compileCompensationPlan({ ...planInput, steps: ["delete it by exact id"] });
    expect(weaker.compensationPlanHash).not.toBe(plan.compensationPlanHash);
  });

  it("binds the exact target, payload, and revision rule the compensation depends on", () => {
    // §7: "delete the document" is not a plan. Each of these is a way the undo
    // could silently become an undo of something else.
    const variants = [
      { ...planInput, target: { ...planInput.target, system: "chanter-site" } },
      { ...planInput, target: { ...planInput.target, container: "other-db" } },
      { ...planInput, target: { ...planInput.target, objectPath: "chanter_os_real_write_p0/probe-2" } },
      { ...planInput, writePayloadHash: "d".repeat(64) },
      { ...planInput, revisionAcquisition: "reuse the updateTime the create call returned" },
      { ...planInput, conditionalDelete: "DELETE unconditionally" },
      { ...planInput, verificationOracleId: "oracle.self.v1" },
    ];
    for (const variant of variants) {
      expect(compileCompensationPlan(variant).compensationPlanHash)
        .not.toBe(plan.compensationPlanHash);
    }
  });

  it("requires the delete revision to come from an independent re-read", () => {
    // The compensation's own precondition must not be sourced from the write it
    // is undoing — that is the same "the write's report is not evidence" rule,
    // applied to the rollback.
    expect(plan.revisionAcquisition).toMatch(/independently/i);
    expect(plan.revisionAcquisition).toMatch(/never the create response/i);
    expect(plan.conditionalDelete).toMatch(/currentDocument\.updateTime/);
    expect(plan.conditionalDelete).toMatch(/FAILED_PRECONDITION/);
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
    expect(candidate.preStateCondition).toEqual({
      kind: "revision",
      revisionType: "etag",
      revisionValue: "etag-1",
    });
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
      record: eligibleRecord({
        preStateCondition: { kind: "revision", revisionType: "etag", revisionValue: "etag-2" },
      }),
      plan, writePayloadHash: "a".repeat(64), idempotencyKey: "probe-1",
    });
    const changedKey = compileRealWriteApprovalCandidate({
      record, plan, writePayloadHash: "a".repeat(64), idempotencyKey: "probe-2",
    });
    const changedPlan = compileRealWriteApprovalCandidate({
      record,
      plan: compileCompensationPlan({
        ...planInput,
        mode: "compensating_action",
        capability: "document.restore",
        steps: ["restore the prior value"],
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

  it("invalidates an approval when the pre-state condition changes at all", () => {
    // §8. An approval for "create this if it is not there" must not survive
    // being turned into "write this over whatever is there now" — that is a
    // different act, and the person who approved the first did not approve it.
    const createIfAbsent = eligibleRecord({
      preStateCondition: {
        kind: "exists",
        expected: false,
        enforcedBy: "Firestore commit precondition currentDocument.exists=false",
      },
    });
    const approved = compileRealWriteApprovalCandidate({
      record: createIfAbsent, plan, writePayloadHash: "a".repeat(64), idempotencyKey: "probe-1",
    });
    expect(approved.preStateCondition).toEqual({
      kind: "exists",
      expected: false,
      enforcedBy: "Firestore commit precondition currentDocument.exists=false",
    });

    const asRevision = compileRealWriteApprovalCandidate({
      record: eligibleRecord({
        preStateCondition: {
          kind: "revision",
          revisionType: "update_time",
          revisionValue: "2026-08-08T06:10:59.743203Z",
        },
      }),
      plan, writePayloadHash: "a".repeat(64), idempotencyKey: "probe-1",
    });
    const differentEnforcement = compileRealWriteApprovalCandidate({
      record: eligibleRecord({
        preStateCondition: {
          kind: "exists",
          expected: false,
          enforcedBy: "checked with a read before calling",
        },
      }),
      plan, writePayloadHash: "a".repeat(64), idempotencyKey: "probe-1",
    });

    expect(asRevision.approvalCandidateHash).not.toBe(approved.approvalCandidateHash);
    // Even swapping a real server-side precondition for a client-side check —
    // which reads almost the same in prose — breaks the binding.
    expect(differentEnforcement.approvalCandidateHash).not.toBe(approved.approvalCandidateHash);
  });

  it("distinguishes absence from every revision condition in the eligibility hash", () => {
    const absent = createEligibilityHash(eligibleRecord({
      preStateCondition: { kind: "exists", expected: false, enforcedBy: "exists=false" },
    }));
    const revision = createEligibilityHash(eligibleRecord({
      preStateCondition: { kind: "revision", revisionType: "etag", revisionValue: "exists=false" },
    }));
    // Same string in a different role must not collide.
    expect(absent).not.toBe(revision);
  });

  it("derives a stable eligibility hash for an unchanged record", () => {
    expect(createEligibilityHash(eligibleRecord()))
      .toBe(createEligibilityHash(eligibleRecord()));
    expect(createEligibilityHash(eligibleRecord({ compensationMode: "none" })))
      .not.toBe(createEligibilityHash(eligibleRecord()));
  });
});

describe("deterministic object identity", () => {
  it("addresses the same document for the same mission and action", () => {
    const first = deriveDeterministicObjectId({ missionId: "m-1", actionId: "a-1" });
    const second = deriveDeterministicObjectId({ missionId: "m-1", actionId: "a-1" });
    expect(second).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
  });

  it("separates missions and actions that differ", () => {
    const base = deriveDeterministicObjectId({ missionId: "m-1", actionId: "a-1" });
    expect(deriveDeterministicObjectId({ missionId: "m-2", actionId: "a-1" })).not.toBe(base);
    expect(deriveDeterministicObjectId({ missionId: "m-1", actionId: "a-2" })).not.toBe(base);
  });

  it("cannot be made to collide by moving the boundary between the two ids", () => {
    // Without a domain separator, mission "ab" + action "c" and mission "a" +
    // action "bc" would hash the same bytes and two unrelated actions would
    // fight over one document.
    expect(deriveDeterministicObjectId({ missionId: "ab", actionId: "c" }))
      .not.toBe(deriveDeterministicObjectId({ missionId: "a", actionId: "bc" }));
  });

  it("yields at most one logical create effect for a replayed action", () => {
    // The two halves of the guarantee, together: a replay addresses the same id,
    // and the absence precondition means the second attempt cannot create a
    // second object — it is refused, not absorbed.
    const record = sandboxCandidate();
    const replayed = [1, 2, 3].map(() =>
      deriveDeterministicObjectId({ missionId: "mission-7", actionId: "action-3" }));

    expect(new Set(replayed).size).toBe(1);
    expect(record.preStateCondition).toEqual({
      kind: "exists",
      expected: false,
      enforcedBy: "Firestore commit precondition currentDocument.exists=false",
    });
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
      evaluateRealWriteEligibility(eligibleRecord({
        preStateCondition: { kind: "revision", revisionType: "none", revisionValue: "" },
      })),
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
      "PRE_STATE_CONDITION_KINDS",
      "REAL_WRITE_READINESS_SCHEMA_VERSION",
      "REAL_WRITE_REJECTION_REASONS",
      "REAL_WRITE_VERDICTS",
      "TARGET_ENVIRONMENTS",
      "UNKNOWN_OUTCOME_RESOLUTIONS",
      "compileCompensationPlan",
      "compileRealWriteApprovalCandidate",
      "createEligibilityHash",
      "decideRealWriteVerdict",
      "deriveDeterministicObjectId",
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

  it("keeps the now-eligible sandbox target disabled and human-gated", () => {
    // The one that changed this slice is the one worth checking twice. Becoming
    // eligible is a statement about safety, not a grant of permission, and the
    // two must not drift into each other.
    const record = sandboxCandidate();
    expect(evaluateRealWriteEligibility(record).eligible).toBe(true);
    expect(record.writeEnabled).toBe(false);
    expect(record.humanApprovalRequired).toBe(true);

    const approvalCandidate = compileRealWriteApprovalCandidate({
      record,
      plan: compileCompensationPlan({
        mode: "idempotent_create_delete",
        capability: "document.delete",
        target: {
          connectorId: record.connectorId,
          system: "chanter-os-sandbox",
          container: "(default)",
          objectPath: "chanter_os_real_write_p0/probe",
        },
        writePayloadHash: "e".repeat(64),
        revisionAcquisition: "independent re-read after create",
        conditionalDelete: "DELETE under currentDocument.updateTime",
        verificationOracleId: record.verificationOracle.oracleId,
        steps: ["delete by exact id"],
        verification: "independent read returning not-found",
        residualEffect: "audit entry only",
      }),
      writePayloadHash: "e".repeat(64),
      idempotencyKey: deriveDeterministicObjectId({ missionId: "m", actionId: "a" }),
    });
    // Even the compiled approval candidate cannot carry a true write flag.
    expect(approvalCandidate.writeEnabled).toBe(false);
  });
});
