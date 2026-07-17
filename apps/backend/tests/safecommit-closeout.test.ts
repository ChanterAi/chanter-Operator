import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { AuditLogger } from "../src/audit/auditLogger.js";
import { createDatabase } from "../src/db/database.js";
import { MockRunner } from "../src/runners/mockRunner.js";
import {
  SAFECOMMIT_APPROVAL_BASIS,
  SAFECOMMIT_CLOSEOUT_ACTION,
  SAFECOMMIT_CLOSEOUT_PLAN_SCHEMA,
  SAFECOMMIT_CLOSEOUT_REQUEST_SCHEMA,
  SafeCommitCloseoutService,
} from "../src/safeCommit/safeCommitCloseoutService.js";
import { OperatorService } from "../src/services/operatorService.js";
import { ensureWorkspace } from "../src/workspace/pathGuard.js";

const SUBMIT_TOKEN = "test-mission-submit-token";
const CONTROL_TOKEN = "test-operator-control-token";
const EXECUTOR_TOKEN = "test-safecommit-executor-token";
const LEDGER_TOKEN = "test-ledger-ingest-token";
const PLAN_HASH = createHash("sha256").update("safecommit-plan").digest("hex");
const EVIDENCE_DIGEST = createHash("sha256").update("closeout-evidence").digest("hex");
const MUTATION_DIGEST = createHash("sha256").update("mutation-evidence").digest("hex");
const REQUEST_ID = "safecommit-request-0001";
const NOW = "2026-07-17T12:00:00.000Z";

interface Harness {
  database: DatabaseSync;
  app: ReturnType<typeof createApp>;
  service: SafeCommitCloseoutService;
}

function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function requestBody(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: SAFECOMMIT_CLOSEOUT_REQUEST_SCHEMA,
    action: SAFECOMMIT_CLOSEOUT_ACTION,
    requestId: REQUEST_ID,
    idempotencyKey: "safecommit-idempotency-0001",
    planId: "safecommit-plan-0001",
    planSchemaVersion: SAFECOMMIT_CLOSEOUT_PLAN_SCHEMA,
    planHash: PLAN_HASH,
    requestedBy: "safecommit-cli",
    requestedAt: "2026-07-17T11:59:00.000Z",
    ...overrides,
  };
}

function createHarness(root: string, databasePath = path.join(root, "operator.sqlite")): Harness {
  const database = createDatabase(databasePath);
  const operator = new OperatorService(
    database,
    new AuditLogger(path.join(root, "audit.jsonl")),
    new MockRunner(),
    ensureWorkspace(path.join(root, "workspace")),
  );
  const service = new SafeCommitCloseoutService(database, {
    now: () => new Date(NOW),
    protectedValues: [SUBMIT_TOKEN, CONTROL_TOKEN, EXECUTOR_TOKEN, LEDGER_TOKEN],
  });
  const app = createApp(
    operator,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    service,
  );
  return { database, app, service };
}

async function submit(harness: Harness, body = requestBody(), token = SUBMIT_TOKEN) {
  return request(harness.app)
    .post("/api/safecommit-closeouts")
    .set(bearer(token))
    .send(body);
}

async function approve(
  harness: Harness,
  body: Record<string, unknown> = {
    planHash: PLAN_HASH,
    approvedBy: "founder",
    approvalBasis: SAFECOMMIT_APPROVAL_BASIS,
    approvalNote: "Reviewed the exact normalized plan and repository preflight.",
  },
  token = CONTROL_TOKEN,
) {
  return request(harness.app)
    .post(`/api/safecommit-closeouts/${REQUEST_ID}/approve`)
    .set(bearer(token))
    .send(body);
}

function evidenceBinding(responseBody: Record<string, unknown>) {
  const evidence = responseBody.approvalEvidence as {
    evidenceId: string;
    digest: string;
  };
  return {
    approvalEvidenceId: evidence.evidenceId,
    approvalEvidenceDigest: evidence.digest,
  };
}

describe("Operator SafeCommit closeout authority", () => {
  let root: string;
  let database: DatabaseSync | undefined;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "operator-safecommit-closeout-"));
  });

  afterEach(() => {
    database?.close();
    database = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it("persists only the exact immutable request identity/hash and replays without mutation", async () => {
    const harness = createHarness(root);
    database = harness.database;

    const created = await submit(harness);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      replayed: false,
      schemaVersion: SAFECOMMIT_CLOSEOUT_REQUEST_SCHEMA,
      action: SAFECOMMIT_CLOSEOUT_ACTION,
      requestId: REQUEST_ID,
      planId: "safecommit-plan-0001",
      planHash: PLAN_HASH,
      status: "approval_required",
      approvalRequired: true,
      approvalEvidence: null,
      claim: null,
      closeoutEvidence: null,
    });
    expect(created.body.events.map((event: { eventType: string }) => event.eventType))
      .toEqual(["closeout_approval_requested"]);

    const stored = harness.database.prepare(
      "SELECT * FROM operator_safecommit_closeouts WHERE request_id = ?",
    ).get(REQUEST_ID) as Record<string, unknown>;
    expect(stored.plan_hash).toBe(PLAN_HASH);
    expect(Object.keys(stored).some((key) => key.includes("plan_json"))).toBe(false);

    const replay = await submit(harness);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.events).toHaveLength(1);

    const changed = await submit(
      harness,
      requestBody({ planHash: "0".repeat(64) }),
    );
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe("OPERATOR_SAFECOMMIT_REQUEST_BINDING_MISMATCH");

    const unknown = await submit(
      harness,
      requestBody({ arbitraryCommand: "git push" }),
    );
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe("OPERATOR_SAFECOMMIT_FIELD_UNSUPPORTED");
    expect(
      harness.database.prepare(
        "SELECT COUNT(*) AS count FROM operator_safecommit_closeouts",
      ).get(),
    ).toMatchObject({ count: 1 });
  });

  it("keeps status reads on submit capability and approval on control capability only", async () => {
    const harness = createHarness(root);
    database = harness.database;
    expect((await submit(harness)).status).toBe(201);

    const noReadToken = await request(harness.app)
      .get(`/api/safecommit-closeouts/${REQUEST_ID}`);
    expect(noReadToken.status).toBe(401);
    const readBySubmit = await request(harness.app)
      .get(`/api/safecommit-closeouts/${REQUEST_ID}`)
      .set(bearer(SUBMIT_TOKEN));
    expect(readBySubmit.status).toBe(200);

    for (const token of [SUBMIT_TOKEN, EXECUTOR_TOKEN, LEDGER_TOKEN]) {
      const denied = await approve(harness, undefined, token);
      expect(denied.status).toBe(401);
    }
    const wrongHash = await approve(harness, {
      planHash: "0".repeat(64),
      approvedBy: "founder",
      approvalBasis: SAFECOMMIT_APPROVAL_BASIS,
    });
    expect(wrongHash.status).toBe(409);
    expect(wrongHash.body.code).toBe("OPERATOR_SAFECOMMIT_PLAN_HASH_MISMATCH");

    const wrongBasis = await approve(harness, {
      planHash: PLAN_HASH,
      approvedBy: "founder",
      approvalBasis: "self_approved",
    });
    expect(wrongBasis.status).toBe(400);
    expect(wrongBasis.body.code).toBe("OPERATOR_SAFECOMMIT_APPROVAL_BASIS_INVALID");

    const approved = await approve(harness);
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe("approved");
    expect(approved.body.approvalEvidence).toMatchObject({
      planHash: PLAN_HASH,
      approvedBy: "founder",
      approvalBasis: SAFECOMMIT_APPROVAL_BASIS,
      approvedAt: NOW,
    });
    expect(approved.body.approvalEvidence.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(approved.body)).not.toContain(CONTROL_TOKEN);

    const replay = await approve(harness);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.events).toHaveLength(2);
  });

  it("atomically claims one approved hash and rejects a second executor binding", async () => {
    const harness = createHarness(root);
    database = harness.database;
    await submit(harness);
    const approved = await approve(harness);
    const binding = evidenceBinding(approved.body);
    const claimBody = {
      planHash: PLAN_HASH,
      claimedBy: "safecommit-executor-a",
      ...binding,
    };

    const controlCannotClaim = await request(harness.app)
      .post(`/api/safecommit-closeouts/${REQUEST_ID}/claim`)
      .set(bearer(CONTROL_TOKEN))
      .send(claimBody);
    expect(controlCannotClaim.status).toBe(401);

    const claimed = await request(harness.app)
      .post(`/api/safecommit-closeouts/${REQUEST_ID}/claim`)
      .set(bearer(EXECUTOR_TOKEN))
      .send(claimBody);
    expect(claimed.status).toBe(200);
    expect(claimed.body).toMatchObject({
      status: "execution_claimed",
      claim: { claimedBy: "safecommit-executor-a", claimedAt: NOW },
    });

    const exactReplay = await request(harness.app)
      .post(`/api/safecommit-closeouts/${REQUEST_ID}/claim`)
      .set(bearer(EXECUTOR_TOKEN))
      .send(claimBody);
    expect(exactReplay.status).toBe(200);
    expect(exactReplay.body.replayed).toBe(true);
    expect(exactReplay.body.events).toHaveLength(3);

    const secondExecutor = await request(harness.app)
      .post(`/api/safecommit-closeouts/${REQUEST_ID}/claim`)
      .set(bearer(EXECUTOR_TOKEN))
      .send({ ...claimBody, claimedBy: "safecommit-executor-b" });
    expect(secondExecutor.status).toBe(409);
    expect(secondExecutor.body.code).toBe("OPERATOR_SAFECOMMIT_INVALID_TRANSITION");
    expect(harness.service.get(REQUEST_ID).claim?.claimedBy)
      .toBe("safecommit-executor-a");
  });

  it("accepts final evidence only from the bound executor and replays terminal truth", async () => {
    const harness = createHarness(root);
    database = harness.database;
    await submit(harness);
    const approved = await approve(harness);
    const binding = evidenceBinding(approved.body);
    const claimBody = {
      planHash: PLAN_HASH,
      claimedBy: "safecommit-executor-a",
      ...binding,
    };
    await request(harness.app)
      .post(`/api/safecommit-closeouts/${REQUEST_ID}/claim`)
      .set(bearer(EXECUTOR_TOKEN))
      .send(claimBody);

    const completionBody = {
      planHash: PLAN_HASH,
      completedBy: "safecommit-executor-a",
      ...binding,
      outcome: "completed",
      evidenceRef: "safecommit-closeout-evidence:0001",
      evidenceDigest: EVIDENCE_DIGEST,
    };
    const completed = await request(harness.app)
      .post(`/api/safecommit-closeouts/${REQUEST_ID}/complete`)
      .set(bearer(EXECUTOR_TOKEN))
      .send(completionBody);
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({
      status: "completed",
      closeoutEvidence: {
        reference: "safecommit-closeout-evidence:0001",
        digest: EVIDENCE_DIGEST,
        outcome: "completed",
        recordedAt: NOW,
      },
    });

    const replay = await request(harness.app)
      .post(`/api/safecommit-closeouts/${REQUEST_ID}/complete`)
      .set(bearer(EXECUTOR_TOKEN))
      .send(completionBody);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.events).toHaveLength(4);

    const changedEvidence = await request(harness.app)
      .post(`/api/safecommit-closeouts/${REQUEST_ID}/complete`)
      .set(bearer(EXECUTOR_TOKEN))
      .send({ ...completionBody, evidenceDigest: "f".repeat(64) });
    expect(changedEvidence.status).toBe(409);
    expect(changedEvidence.body.code).toBe("OPERATOR_SAFECOMMIT_INVALID_TRANSITION");
  });

  it("invalidates approved or claimed execution when repository truth changes", async () => {
    const harness = createHarness(root);
    database = harness.database;
    await submit(harness);
    const approved = await approve(harness);
    const binding = evidenceBinding(approved.body);
    const invalidationBody = {
      planHash: PLAN_HASH,
      invalidatedBy: "safecommit-executor-a",
      ...binding,
      reasonCode: "worktree_mutated",
      evidenceRef: "safecommit-mutation-evidence:0001",
      evidenceDigest: MUTATION_DIGEST,
    };

    const invalidated = await request(harness.app)
      .post(`/api/safecommit-closeouts/${REQUEST_ID}/invalidate`)
      .set(bearer(EXECUTOR_TOKEN))
      .send(invalidationBody);
    expect(invalidated.status).toBe(200);
    expect(invalidated.body).toMatchObject({
      status: "invalidated",
      terminal: {
        actor: "safecommit-executor-a",
        reasonCode: "worktree_mutated",
        evidenceRef: "safecommit-mutation-evidence:0001",
        evidenceDigest: MUTATION_DIGEST,
      },
    });

    const claimAfterInvalidation = await request(harness.app)
      .post(`/api/safecommit-closeouts/${REQUEST_ID}/claim`)
      .set(bearer(EXECUTOR_TOKEN))
      .send({
        planHash: PLAN_HASH,
        claimedBy: "safecommit-executor-a",
        ...binding,
      });
    expect(claimAfterInvalidation.status).toBe(409);

    const badReason = await request(harness.app)
      .post(`/api/safecommit-closeouts/${REQUEST_ID}/invalidate`)
      .set(bearer(EXECUTOR_TOKEN))
      .send({ ...invalidationBody, reasonCode: "ignore_and_push" });
    expect(badReason.status).toBe(400);
    expect(badReason.body.code)
      .toBe("OPERATOR_SAFECOMMIT_INVALIDATION_REASON_UNREGISTERED");

    const claimedRequestId = "safecommit-request-0002";
    const claimedPlanHash = createHash("sha256").update("claimed-plan").digest("hex");
    const claimed = harness.service.submit(requestBody({
      requestId: claimedRequestId,
      idempotencyKey: "safecommit-idempotency-0002",
      planId: "safecommit-plan-0002",
      planHash: claimedPlanHash,
    }));
    expect(claimed.status).toBe("approval_required");
    const claimedApproval = harness.service.approve(claimedRequestId, {
      planHash: claimedPlanHash,
      approvedBy: "founder",
      approvalBasis: SAFECOMMIT_APPROVAL_BASIS,
    });
    const claimedBinding = evidenceBinding(claimedApproval as unknown as Record<string, unknown>);
    harness.service.claim(claimedRequestId, {
      planHash: claimedPlanHash,
      claimedBy: "safecommit-executor-a",
      ...claimedBinding,
    });
    const invalidatedClaim = harness.service.invalidate(claimedRequestId, {
      planHash: claimedPlanHash,
      invalidatedBy: "safecommit-executor-a",
      ...claimedBinding,
      reasonCode: "repository_truth_changed",
      evidenceRef: "safecommit-mutation-evidence:0002",
      evidenceDigest: MUTATION_DIGEST,
    });
    expect(invalidatedClaim.status).toBe("invalidated");
    expect(invalidatedClaim.claim?.claimedBy).toBe("safecommit-executor-a");
  });

  it("allows founder revocation only before execution is claimed", async () => {
    const harness = createHarness(root);
    database = harness.database;
    await submit(harness);
    const revoked = await request(harness.app)
      .post(`/api/safecommit-closeouts/${REQUEST_ID}/revoke`)
      .set(bearer(CONTROL_TOKEN))
      .send({
        planHash: PLAN_HASH,
        revokedBy: "founder",
        reason: "Repository scope changed before approval.",
      });
    expect(revoked.status).toBe(200);
    expect(revoked.body.status).toBe("revoked");
    expect(revoked.body.approvalEvidence).toBeNull();

    const approveAfterRevocation = await approve(harness);
    expect(approveAfterRevocation.status).toBe(409);
    expect(approveAfterRevocation.body.code).toBe("OPERATOR_SAFECOMMIT_INVALID_TRANSITION");
  });

  it("survives restart with byte-stable approval evidence and event order", async () => {
    const databasePath = path.join(root, "restart.sqlite");
    let first = createHarness(root, databasePath);
    database = first.database;
    await submit(first);
    const approved = await approve(first);
    const evidenceBefore = approved.body.approvalEvidence;
    first.database.close();
    database = undefined;

    const second = createHarness(root, databasePath);
    database = second.database;
    const read = await request(second.app)
      .get(`/api/safecommit-closeouts/${REQUEST_ID}`)
      .set(bearer(SUBMIT_TOKEN));
    expect(read.status).toBe(200);
    expect(read.body.approvalEvidence).toEqual(evidenceBefore);
    expect(read.body.events.map((event: { sequence: number }) => event.sequence))
      .toEqual([1, 2]);
  });

  it("fails closed when durable approval or claim fields are tampered", async () => {
    const harness = createHarness(root);
    database = harness.database;
    await submit(harness);
    await approve(harness);
    harness.database.prepare(
      "UPDATE operator_safecommit_closeouts SET approval_evidence_digest = ? WHERE request_id = ?",
    ).run("0".repeat(64), REQUEST_ID);
    expect(() => harness.service.get(REQUEST_ID)).toThrow(
      /approval evidence digest validation failed/i,
    );

    harness.database.prepare(
      `UPDATE operator_safecommit_closeouts
       SET approval_evidence_digest = ?, status = 'execution_claimed',
           claimed_by = NULL, claimed_at = NULL
       WHERE request_id = ?`,
    ).run(
      (harness.database.prepare(
        "SELECT evidence_digest FROM operator_safecommit_closeout_events WHERE event_type = 'closeout_approved'",
      ).get() as { evidence_digest: string }).evidence_digest,
      REQUEST_ID,
    );
    expect(() => harness.service.get(REQUEST_ID)).toThrow(
      /missing its execution claim/i,
    );

    harness.database.prepare(
      `UPDATE operator_safecommit_closeouts
       SET status = 'approved', claimed_by = NULL, claimed_at = NULL,
           approved_plan_hash = NULL
       WHERE request_id = ?`,
    ).run(REQUEST_ID);
    expect(() => harness.service.get(REQUEST_ID)).toThrow(
      /approval evidence is incomplete/i,
    );
  });
});
