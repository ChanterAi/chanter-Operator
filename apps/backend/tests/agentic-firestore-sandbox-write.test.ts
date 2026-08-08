/**
 * CHANTER OS — bounded Firestore sandbox write P0-C — fail-closed proofs.
 *
 * Every test here drives a deterministic in-memory Firestore through the
 * connector's injected transport. **No test in this file performs a real
 * external call**, which is what makes them safe to repeat: the live proof runs
 * exactly once, elsewhere, and these establish the refusals it must never need.
 *
 * The fake implements the two preconditions the real service enforces —
 * `currentDocument.exists=false` on create and `currentDocument.updateTime` on
 * delete — because those are the mechanisms the whole design rests on. A fake
 * that accepted every write would prove the connector calls Firestore, not that
 * Firestore would refuse it.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  createFirestoreDocumentConnector,
  firestoreAbsentStateHash,
  firestoreDocumentTargetId,
  firestoreIdempotencyKey,
  parseFirestoreDocumentTargetId,
  type FirestoreHttpRequest,
  type FirestoreHttpResponse,
} from "../src/agentic/agenticFirestoreDocumentConnector.js";

const PROJECT = "chanter-os-sandbox";
const DATABASE = "(default)";
const COLLECTION = "chanter_os_real_write_p0";

function targetFor(documentId: string): string {
  return firestoreDocumentTargetId({
    project: PROJECT,
    database: DATABASE,
    collection: COLLECTION,
    documentId,
  });
}

interface FakeDocument {
  readonly fields: Record<string, Record<string, unknown>>;
  readonly updateTime: string;
}

/** A Firestore that enforces the two preconditions this design depends on. */
function fakeFirestore(options: {
  readonly seed?: Record<string, FakeDocument>;
  /** Forces one specific response, for outage and ambiguity proofs. */
  readonly override?: (request: FirestoreHttpRequest, call: number) => FirestoreHttpResponse | null;
  /** Fires after a create lands, so another writer can move the document. */
  readonly afterCreate?: (store: Record<string, FakeDocument>) => void;
} = {}) {
  const store: Record<string, FakeDocument> = { ...(options.seed ?? {}) };
  let clock = 0;
  let calls = 0;

  function nextRevision(): string {
    clock += 1;
    return `2026-08-08T06:${String(clock).padStart(2, "0")}:00.000000Z`;
  }

  const http = (request: FirestoreHttpRequest): FirestoreHttpResponse => {
    calls += 1;
    const forced = options.override?.(request, calls);
    if (forced) return forced;

    const url = new URL(request.url);
    const documentId = url.pathname.split("/").pop() ?? "";
    const existing = store[documentId];

    if (request.method === "GET") {
      return existing
        ? { status: 200, body: JSON.stringify({ ...existing, name: url.pathname }) }
        : { status: 404, body: JSON.stringify({ error: { status: "NOT_FOUND" } }) };
    }

    if (request.method === "PATCH") {
      // The create-if-absent precondition. Without this the fake would happily
      // let a second create overwrite the first, and the idempotency proof
      // below would pass while proving nothing.
      if (url.searchParams.get("currentDocument.exists") !== "false") {
        return { status: 400, body: JSON.stringify({ error: { status: "INVALID_ARGUMENT" } }) };
      }
      if (existing) {
        return { status: 409, body: JSON.stringify({ error: { status: "ALREADY_EXISTS" } }) };
      }
      const body = JSON.parse(request.body ?? "{}") as {
        fields?: Record<string, Record<string, unknown>>;
      };
      const created: FakeDocument = { fields: body.fields ?? {}, updateTime: nextRevision() };
      store[documentId] = created;
      options.afterCreate?.(store);
      return { status: 200, body: JSON.stringify({ ...created, name: url.pathname }) };
    }

    if (request.method === "DELETE") {
      const expected = url.searchParams.get("currentDocument.updateTime");
      if (!expected) {
        // An unconditional delete must never reach here from this connector.
        return { status: 400, body: JSON.stringify({ error: { status: "INVALID_ARGUMENT" } }) };
      }
      if (!existing) return { status: 404, body: JSON.stringify({ error: { status: "NOT_FOUND" } }) };
      if (existing.updateTime !== expected) {
        return { status: 400, body: JSON.stringify({ error: { status: "FAILED_PRECONDITION" } }) };
      }
      delete store[documentId];
      return { status: 200, body: "{}" };
    }

    return { status: 405, body: "{}" };
  };

  return { http, store, calls: () => calls };
}

function connectorWith(
  http: (request: FirestoreHttpRequest) => FirestoreHttpResponse,
  overrides: Partial<Parameters<typeof createFirestoreDocumentConnector>[0]> = {},
) {
  return createFirestoreDocumentConnector({
    project: PROJECT,
    database: DATABASE,
    collection: COLLECTION,
    staticAccessToken: "test-token",
    now: () => "2026-08-08T06:00:00.000Z",
    httpImpl: http,
    ...overrides,
  });
}

function payloadFor(documentId: string) {
  return [
    { field: "missionId", value: "mission-p0c" },
    { field: "actionId", value: "action-1" },
    { field: "createdAt", value: "2026-08-08T06:00:00.000Z" },
    { field: "probeId", value: documentId },
  ] as const;
}

function applyRequest(documentId: string, overrides: Record<string, unknown> = {}) {
  const targetId = targetFor(documentId);
  return {
    capability: "document.create",
    targetId,
    expectedPreStateHash: firestoreAbsentStateHash(targetId),
    writePayload: payloadFor(documentId),
    writePayloadHash: "a".repeat(64),
    idempotencyKey: firestoreIdempotencyKey("mission-p0c:action-1", targetId),
    ...overrides,
  } as Parameters<ReturnType<typeof connectorWith>["apply"]>[0];
}

// §20 requires deterministic focused proofs to run three times. Repetition is
// what distinguishes "passed" from "passes" for anything carrying a clock, a
// hash, or an accumulating counter.
describe.each([1, 2, 3])("bounded sandbox write proofs (run %i)", () => {
  it("creates, verifies, compensates, and verifies absence", () => {
    const fake = fakeFirestore();
    const connector = connectorWith(fake.http);
    const documentId = "probe-happy";
    const targetId = targetFor(documentId);

    expect(connector.read(targetId)).toBeNull();

    const applied = connector.apply(applyRequest(documentId));
    expect(applied.performedWrite).toBe(true);

    // Independent read. The revision used for compensation comes from here,
    // never from the create's own response.
    const verified = connector.read(targetId);
    expect(verified).not.toBeNull();
    expect(verified!.fields.probeId).toBe(documentId);

    const compensated = connector.compensate({
      capability: "document.delete",
      targetId,
      expectedRevision: verified!.revision,
      idempotencyKey: applied.action.idempotencyKey,
    });
    expect(compensated.performedWrite).toBe(true);

    expect(connector.read(targetId)).toBeNull();
    expect(Object.keys(fake.store)).toHaveLength(0);

    const counts = connector.counts();
    expect(counts.writes).toBe(1);
    expect(counts.compensations).toBe(1);
    expect(counts.blindRetries).toBe(0);
  });

  it("refuses when the document already exists before the write", () => {
    // §18: the approved pre-state was absence, and absence no longer holds.
    const fake = fakeFirestore({
      seed: { "probe-taken": { fields: {}, updateTime: "2026-01-01T00:00:00.000000Z" } },
    });
    const connector = connectorWith(fake.http);

    expect(() => connector.apply(applyRequest("probe-taken")))
      .toThrow(/already exists and was written by a different action/);
    expect(connector.counts().writes).toBe(0);
  });

  it("refuses a contract approved against a pre-state other than absence", () => {
    const fake = fakeFirestore();
    const connector = connectorWith(fake.http);
    expect(() => connector.apply(applyRequest("probe-prestate", {
      expectedPreStateHash: "b".repeat(64),
    }))).toThrow(/approved against a pre-state other than document absence/);
    expect(connector.counts().writes).toBe(0);
  });

  it("refuses a target in any project but the pinned sandbox", () => {
    // §18 "wrong sandbox project", and the reason a mission cannot steer this
    // connector at production by supplying a path.
    const fake = fakeFirestore();
    const connector = connectorWith(fake.http);
    const production = "projects/chanter-site/databases/(default)/documents/"
      + `${COLLECTION}/probe`;

    expect(() => connector.read(production))
      .toThrow(/pinned to project chanter-os-sandbox and may not address chanter-site/);
    // No request was even built, so nothing reached the transport.
    expect(fake.calls()).toBe(0);
    expect(connector.transportCalls()).toHaveLength(0);
  });

  it("refuses a target outside the pinned database or collection", () => {
    const fake = fakeFirestore();
    const connector = connectorWith(fake.http);

    expect(() => connector.read(
      `projects/${PROJECT}/databases/other-db/documents/${COLLECTION}/probe`,
    )).toThrow(/pinned to database/);
    expect(() => connector.read(
      `projects/${PROJECT}/databases/${DATABASE}/documents/other_collection/probe`,
    )).toThrow(/pinned to collection/);
    expect(fake.calls()).toBe(0);
  });

  it("refuses a credential issued for a different project", () => {
    // §18 "credential mismatch". Checked before the key is used to sign
    // anything, so a valid key for the wrong project never mints a token.
    const directory = mkdtempSync(path.join(tmpdir(), "chanter-p0c-"));
    const credentialPath = path.join(directory, "wrong-project.json");
    writeFileSync(credentialPath, JSON.stringify({
      client_email: "someone@chanter-site.iam.gserviceaccount.com",
      private_key: "not-used-because-the-check-comes-first",
      token_uri: "https://oauth2.googleapis.com/token",
      project_id: "chanter-site",
    }), "utf8");

    const fake = fakeFirestore();
    const connector = createFirestoreDocumentConnector({
      project: PROJECT,
      database: DATABASE,
      collection: COLLECTION,
      credentialPath,
      now: () => "2026-08-08T06:00:00.000Z",
      httpImpl: fake.http,
    });

    expect(() => connector.read(targetFor("probe")))
      .toThrow(/belongs to project chanter-site, not chanter-os-sandbox/);
  });

  it("reports insufficient authority rather than absence on a 403", () => {
    // A denied read must never read as "the document is not there".
    const fake = fakeFirestore({
      override: (request) => request.method === "GET"
        ? { status: 403, body: JSON.stringify({ error: { status: "PERMISSION_DENIED" } }) }
        : null,
    });
    const connector = connectorWith(fake.http);
    expect(() => connector.read(targetFor("probe")))
      .toThrow(/not authorized to read this document/);
  });

  it("treats a lost create response as unknown, never as failed", () => {
    // §11. The document may well exist; the only honest state is "unknown",
    // and the only honest next step is a read.
    const fake = fakeFirestore({
      override: (request) => request.method === "PATCH"
        ? { status: 0, body: "socket hang up" }
        : null,
    });
    const connector = connectorWith(fake.http);
    expect(() => connector.apply(applyRequest("probe-lost")))
      .toThrow(/outcome is unknown and must be reconciled by reading the exact document/);
  });

  it("reconciles a lost create by reading, and never creates twice", () => {
    // The ambiguous window: the create landed, the caller never learned it.
    const fake = fakeFirestore();
    const connector = connectorWith(fake.http, {
      applyInterrupt: () => {
        throw new Error("process died after the write was durable");
      },
    });
    const documentId = "probe-ambiguous";
    const targetId = targetFor(documentId);

    expect(() => connector.apply(applyRequest(documentId))).toThrow(/process died/);
    expect(Object.keys(fake.store)).toHaveLength(1);

    // Recovery reads the exact document and finds this mission's own action.
    const recovered = connector.readAction(
      firestoreIdempotencyKey("mission-p0c:action-1", targetId),
    );
    expect(recovered).not.toBeNull();
    expect(recovered!.targetId).toBe(targetId);

    // A replayed apply returns the original outcome and performs no write.
    const replayed = connector.apply(applyRequest(documentId));
    expect(replayed.performedWrite).toBe(false);
    expect(connector.counts().writes).toBe(1);
    expect(connector.counts().replays).toBe(1);
    expect(Object.keys(fake.store)).toHaveLength(1);
  });

  it("treats a document with someone else's provenance as a conflict", () => {
    // §11 "present with different payload". Not a success, not a target to
    // overwrite — a human decides.
    const targetId = targetFor("probe-foreign");
    const fake = fakeFirestore({
      seed: {
        "probe-foreign": {
          fields: { chanterIdempotencyKey: { stringValue: "someone-elses-action@x" } },
          updateTime: "2026-01-01T00:00:00.000000Z",
        },
      },
    });
    const connector = connectorWith(fake.http);

    expect(() => connector.readAction(
      firestoreIdempotencyKey("mission-p0c:action-1", targetId),
    )).toThrow(/written by a different action/);
  });

  it("refuses to compensate under a revision that has since moved", () => {
    // §18: another writer touched the document after the create. Forcing past
    // this would delete their state.
    const fake = fakeFirestore();
    const connector = connectorWith(fake.http);
    const documentId = "probe-moved";
    const targetId = targetFor(documentId);

    const applied = connector.apply(applyRequest(documentId));
    const observed = connector.read(targetId)!;

    // A concurrent writer moves it.
    fake.store[documentId] = {
      fields: fake.store[documentId]!.fields,
      updateTime: "2099-01-01T00:00:00.000000Z",
    };

    expect(() => connector.compensate({
      capability: "document.delete",
      targetId,
      expectedRevision: observed.revision,
      idempotencyKey: applied.action.idempotencyKey,
    })).toThrow(/changed after it was created, so the compensating delete was refused/);

    // The document is still there. A refused compensation leaves the world
    // alone rather than tidying it up by force.
    expect(Object.keys(fake.store)).toHaveLength(1);
    expect(connector.counts().compensations).toBe(0);
  });

  it("refuses a compensating delete with no revision at all", () => {
    const fake = fakeFirestore();
    const connector = connectorWith(fake.http);
    expect(() => connector.compensate({
      capability: "document.delete",
      targetId: targetFor("probe"),
      expectedRevision: "   ",
      idempotencyKey: "k@t",
    })).toThrow(/must name the exact revision it is conditional on/);
    expect(fake.calls()).toBe(0);
  });

  it("refuses a compensation capability the connector does not declare", () => {
    const fake = fakeFirestore();
    const connector = connectorWith(fake.http);
    expect(() => connector.compensate({
      capability: "collection.drop",
      targetId: targetFor("probe"),
      expectedRevision: "2026-08-08T06:01:00.000000Z",
      idempotencyKey: "k@t",
    })).toThrow(/declares no compensation capability/);
    expect(fake.calls()).toBe(0);
  });

  it("keeps an unavailable verification read distinct from absence", () => {
    // §18 "verification read unavailable". A 500 is not a 404, and collapsing
    // the two would let an outage read as a successful compensation.
    const fake = fakeFirestore({
      override: (request) => request.method === "GET"
        ? { status: 503, body: JSON.stringify({ error: { status: "UNAVAILABLE" } }) }
        : null,
    });
    const connector = connectorWith(fake.http);
    expect(() => connector.read(targetFor("probe")))
      .toThrow(/could not be read; Firestore answered 503/);
  });

  it("refuses to write a field outside the declared writable set", () => {
    const fake = fakeFirestore();
    const connector = connectorWith(fake.http);
    expect(() => connector.apply(applyRequest("probe-fields", {
      writePayload: [{ field: "chanterIdempotencyKey", value: "forged" }],
    }))).toThrow(/may not write chanterIdempotencyKey/);
    expect(connector.counts().writes).toBe(0);
  });

  it("refuses an unknown write capability", () => {
    const fake = fakeFirestore();
    const connector = connectorWith(fake.http);
    expect(() => connector.apply(applyRequest("probe-cap", { capability: "document.overwrite" })))
      .toThrow(/declares no write capability/);
    expect(fake.calls()).toBe(0);
  });

  it("constructs only bounded request shapes", () => {
    // The write-safety proof. Every request this connector can build names one
    // document and carries its precondition; there is no unconditional delete
    // and no overwriting patch to record because none is constructable.
    const fake = fakeFirestore();
    const connector = connectorWith(fake.http);
    const documentId = "probe-shapes";
    const targetId = targetFor(documentId);

    connector.apply(applyRequest(documentId));
    const observed = connector.read(targetId)!;
    connector.compensate({
      capability: "document.delete",
      targetId,
      expectedRevision: observed.revision,
      idempotencyKey: firestoreIdempotencyKey("mission-p0c:action-1", targetId),
    });

    for (const call of connector.transportCalls()) {
      expect(["GET", "PATCH", "DELETE"]).toContain(call.method);
      // One document per request. No collection-level operation exists.
      expect(call.path.split("/")).toHaveLength(2);
      if (call.method === "PATCH") expect(call.precondition).toBe("currentDocument.exists=false");
      if (call.method === "DELETE") expect(call.precondition).toMatch(/^currentDocument\.updateTime=/);
      if (call.method === "GET") expect(call.precondition).toBeNull();
    }
    // And no bearer token was ever recorded in the transport log.
    expect(JSON.stringify(connector.transportCalls())).not.toContain("test-token");
  });

  it("addresses one document per mission action, deterministically", () => {
    const first = parseFirestoreDocumentTargetId(targetFor("abc"));
    expect(first.project).toBe(PROJECT);
    expect(first.collection).toBe(COLLECTION);
    expect(first.documentId).toBe("abc");
    expect(() => parseFirestoreDocumentTargetId("not/a/document"))
      .toThrow(/not a Firestore document identity/);
  });

  it("replays a terminal compensation without a second delete", () => {
    // §20 "terminal replay with zero new writes".
    const fake = fakeFirestore();
    const connector = connectorWith(fake.http);
    const documentId = "probe-replay";
    const targetId = targetFor(documentId);

    const applied = connector.apply(applyRequest(documentId));
    const observed = connector.read(targetId)!;
    connector.compensate({
      capability: "document.delete",
      targetId,
      expectedRevision: observed.revision,
      idempotencyKey: applied.action.idempotencyKey,
    });

    const again = connector.compensate({
      capability: "document.delete",
      targetId,
      expectedRevision: observed.revision,
      idempotencyKey: applied.action.idempotencyKey,
    });
    // Already gone is the desired end state, but it is not a second write.
    expect(again.compensated).toBe(true);
    expect(again.performedWrite).toBe(false);
    expect(connector.counts().compensations).toBe(1);
  });
});
