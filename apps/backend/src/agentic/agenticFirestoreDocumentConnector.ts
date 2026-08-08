/**
 * CHANTER OS — real write-capable connector: one Firestore document.
 *
 * The first connector in this fabric that changes something CHANTER does not
 * own the storage for. Everything before it either owned its own store
 * (`connector.simulated.ledger.v1`) or was structurally incapable of writing
 * (`connector.git.remote-ref.v1`, which exposes no `apply` at all).
 *
 * ## Why this target, and why absence is the pre-state
 *
 * A create has no prior revision. Its exact pre-state is that the object is not
 * there, and Firestore binds that server-side with
 * `currentDocument.exists=false`: two concurrent creates on one id cannot both
 * win, and the loser is refused rather than silently overwriting. That is what
 * lets an approval given at one moment be safe to apply at a later one — the
 * condition it was approved under is re-checked by the system being written to,
 * not by this process's memory of it.
 *
 * ## The write is bounded by construction, not by discipline
 *
 * Three separate things would each have to be rewritten before this connector
 * could touch anything unintended:
 *
 *   - **project pinning** — the configured sandbox project is compared against
 *     the project segment of every target path before any request is built. A
 *     target naming a different project is refused, so a mission cannot steer
 *     this connector at production by supplying a path;
 *   - **a request allowlist** — exactly three shapes are constructable: a GET,
 *     a PATCH carrying `currentDocument.exists=false`, and a DELETE carrying
 *     `currentDocument.updateTime`. An unconditional delete and an overwriting
 *     patch are not merely refused, there is no code path that builds them;
 *   - **no collection-level operation** — every request names one document.
 *     There is no list, no query, and no batch, so "delete by query" has nothing
 *     to be expressed in.
 *
 * ## Compensation is a delete, and only of what this mission created
 *
 * `compensate` requires the exact revision returned by an independent re-read,
 * and passes it as a precondition. If anything changed the document after the
 * create, the delete is refused and the mission ends needing a human. Forcing
 * past that would be a second write, not a rollback — it would remove whatever
 * the other writer put there.
 *
 * ## Credential
 *
 * A sandbox-only service account, read from the environment at construction and
 * never written to disk, a log line, or an evidence artifact. The private key is
 * used solely to sign the JWT assertion; the resulting access token is held in
 * memory and never returned through any method on this object.
 */
import { execFileSync } from "node:child_process";
import { createHash, createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalizeAgenticJson } from "chanter-agent-runtime";
import { OperatorError } from "../services/operatorService.js";
import {
  ABSENT_SOURCE_REVISION,
  createObservationHash,
  OPERATIONAL_EXCEPTION_SCHEMA_VERSION,
  type ExceptionField,
  type ExceptionFieldValue,
} from "./agenticExceptionContract.js";
import type {
  ConnectorAppliedAction,
  ConnectorApplyResult,
  ConnectorCapabilityManifest,
  ConnectorCompensationResult,
  ConnectorRecord,
  OperationalConnector,
} from "./agenticSimulatedConnector.js";

export const FIRESTORE_DOCUMENT_CONNECTOR_ID = "connector.firestore.document.v1" as const;
export const FIRESTORE_DOCUMENT_CREATE_CAPABILITY = "document.create" as const;
export const FIRESTORE_DOCUMENT_DELETE_CAPABILITY = "document.delete" as const;

const ABSENT_STATE_HASH_DOMAIN = "chanter.firestore.absent-pre-state.v1";

/**
 * Fields a mission may set.
 *
 * The connector adds two of its own alongside them — see `PROVENANCE_FIELDS` —
 * which a mission may not write, for the same reason a source system's revision
 * is not the caller's to choose.
 */
const WRITABLE_FIELDS: readonly string[] = Object.freeze([
  "missionId",
  "actionId",
  "createdAt",
  "probeId",
]);

/**
 * Connector-owned fields written beside the payload.
 *
 * These are what make reconciliation answerable. Firestore offers no
 * request-level idempotency key, so when a create's response is lost the only
 * way to tell "my create landed" from "someone else's document is at this path"
 * is to have written down which action produced it.
 */
const PROVENANCE_FIELDS = Object.freeze({
  idempotencyKey: "chanterIdempotencyKey",
  writePayloadHash: "chanterWritePayloadHash",
});

export const FIRESTORE_DOCUMENT_CONNECTOR_MANIFEST: ConnectorCapabilityManifest = Object.freeze({
  schemaVersion: OPERATIONAL_EXCEPTION_SCHEMA_VERSION,
  connectorId: FIRESTORE_DOCUMENT_CONNECTOR_ID,
  systemType: "document_store",
  environment: "real_sandbox",
  capabilities: Object.freeze([FIRESTORE_DOCUMENT_CREATE_CAPABILITY]),
  readOperations: Object.freeze(["document.read"]),
  writeCapabilitiesDeclared: Object.freeze([
    FIRESTORE_DOCUMENT_CREATE_CAPABILITY,
    FIRESTORE_DOCUMENT_DELETE_CAPABILITY,
  ]),
  writeCapabilitiesEnabled: true,
  revisionSemantics:
    "per-document updateTime, RFC3339 with nanosecond precision; a changed updateTime is a changed "
    + "state and preconditions compare it exactly",
  freshnessSemantics:
    "independent document read; the returned updateTime is the authority, never the write response",
  writeOperations: Object.freeze([
    FIRESTORE_DOCUMENT_CREATE_CAPABILITY,
    FIRESTORE_DOCUMENT_DELETE_CAPABILITY,
  ]),
  idempotencySemantics:
    "object-identity idempotency, not request-level: the caller chooses a deterministic document id "
    + "and creates under currentDocument.exists=false, so a replay is refused ALREADY_EXISTS rather "
    + "than duplicated. Firestore accepts no caller-supplied idempotency key.",
  reconciliationSupport: "read_exact_document_and_compare_provenance",
  verificationSupport: "independent_read_after_write",
  compensationSupport: "idempotent_create_delete",
  writableFields: WRITABLE_FIELDS,
  realExternalWrites: true,
}) as ConnectorCapabilityManifest;

function refuse(code: string, message: string): never {
  throw new OperatorError(message, 409, code);
}

/**
 * The hash standing for "this document does not exist".
 *
 * A real value rather than an empty string, so an absent pre-state is
 * distinguishable from a missing one. `""` would compare equal to an
 * uninitialised field, which is exactly the confusion an approval must not be
 * able to survive.
 */
export function firestoreAbsentStateHash(targetId: string): string {
  // Derived with the same function the mission side uses for `observationHash`,
  // exactly as `connectorRecordStateHash` and `gitRefStateHash` are. Shared
  // derivation is what makes "the state the connector sees" and "the state the
  // mission observed" comparable by value instead of by trust — and absence has
  // to participate in that or a create could never bind its pre-state.
  return createObservationHash({
    sourceSystemId: FIRESTORE_DOCUMENT_CONNECTOR_ID,
    targetId,
    sourceRevision: ABSENT_SOURCE_REVISION,
    observedFields: [],
  });
}

export interface FirestoreDocumentTarget {
  readonly project: string;
  readonly database: string;
  readonly collection: string;
  readonly documentId: string;
}

/** `projects/<p>/databases/<db>/documents/<collection>/<docId>` — the object identity. */
export function firestoreDocumentTargetId(target: FirestoreDocumentTarget): string {
  return `projects/${target.project}/databases/${target.database}/documents/`
    + `${target.collection}/${target.documentId}`;
}

export function parseFirestoreDocumentTargetId(targetId: string): FirestoreDocumentTarget {
  const match = /^projects\/([^/]+)\/databases\/([^/]+)\/documents\/([^/]+)\/([^/]+)$/.exec(targetId);
  if (!match) {
    refuse(
      "CONNECTOR_TARGET_MALFORMED",
      `Target "${targetId}" is not a Firestore document identity of the form `
      + "projects/<project>/databases/<database>/documents/<collection>/<documentId>.",
    );
  }
  return {
    project: match[1]!,
    database: match[2]!,
    collection: match[3]!,
    documentId: match[4]!,
  };
}

/** One recorded transport invocation, for the write-safety proof. */
export interface FirestoreTransportCall {
  readonly method: string;
  /** Path and precondition only. Never the access token, never the payload. */
  readonly path: string;
  readonly precondition: string | null;
  readonly at: string;
  readonly status: number;
}

export interface FirestoreHttpRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

export interface FirestoreHttpResponse {
  readonly status: number;
  readonly body: string;
}

export interface FirestoreDocumentConnectorOptions {
  /** The one project this connector may ever address. */
  readonly project: string;
  readonly database: string;
  readonly collection: string;
  /** Absolute path to the sandbox service-account JSON. Never logged. */
  readonly credentialPath?: string;
  /** Pre-resolved bearer token, for tests. Mutually exclusive with a credential. */
  readonly staticAccessToken?: string;
  readonly now: () => string;
  /** Injected so failure proofs can drive outcomes without a network. */
  readonly httpImpl?: (request: FirestoreHttpRequest) => FirestoreHttpResponse;
  /**
   * Fires after the create is durable in Firestore and before the outcome
   * returns — the genuinely ambiguous window §11 requires. Throwing here means
   * the external system has acted and this process does not know it.
   */
  readonly applyInterrupt?: (action: ConnectorAppliedAction) => void;
}

export interface FirestoreDocumentConnector extends OperationalConnector {
  readAction(idempotencyKey: string, targetId?: string): ConnectorAppliedAction | null;
  apply(request: {
    readonly capability: string;
    readonly targetId: string;
    readonly expectedPreStateHash: string;
    readonly writePayload: readonly ExceptionField[];
    readonly writePayloadHash: string;
    readonly idempotencyKey: string;
  }): ConnectorApplyResult;
  compensate(request: {
    readonly capability: string;
    readonly targetId: string;
    readonly expectedRevision: string;
    readonly idempotencyKey: string;
  }): ConnectorCompensationResult;
  transportCalls(): readonly FirestoreTransportCall[];
  counts(): {
    readonly reads: number;
    readonly writes: number;
    readonly compensations: number;
    readonly replays: number;
    readonly reconciliationReads: number;
    readonly blindRetries: 0;
  };
}

/** Firestore's typed value envelope, narrowed to what this connector writes. */
function toFirestoreValue(value: ExceptionFieldValue): Record<string, unknown> {
  if (value === null) return { nullValue: null };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === "boolean") return { booleanValue: value };
  return { stringValue: String(value) };
}

function fromFirestoreValue(value: Record<string, unknown>): ExceptionFieldValue {
  if ("nullValue" in value) return null;
  if ("booleanValue" in value) return Boolean(value.booleanValue);
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("timestampValue" in value) return String(value.timestampValue);
  return String(value.stringValue ?? "");
}

export function createFirestoreDocumentConnector(
  options: FirestoreDocumentConnectorOptions,
): FirestoreDocumentConnector {
  const calls: FirestoreTransportCall[] = [];
  let reads = 0;
  let writes = 0;
  let compensations = 0;
  let replays = 0;
  let reconciliationReads = 0;

  let cachedToken: { readonly value: string; readonly expiresAt: number } | null = null;

  function accessToken(): string {
    if (options.staticAccessToken !== undefined) return options.staticAccessToken;
    const nowMs = Date.now();
    if (cachedToken && cachedToken.expiresAt > nowMs + 60_000) return cachedToken.value;
    if (options.credentialPath === undefined) {
      refuse(
        "CONNECTOR_CREDENTIAL_MISSING",
        "No sandbox credential is configured, so this connector has no write authority.",
      );
    }

    const key = JSON.parse(readFileSync(options.credentialPath, "utf8")) as {
      client_email?: string;
      private_key?: string;
      token_uri?: string;
      project_id?: string;
    };
    if (!key.client_email || !key.private_key || !key.token_uri) {
      refuse("CONNECTOR_CREDENTIAL_MALFORMED", "The configured credential is not a service-account key.");
    }
    // The credential must belong to the project this connector is pinned to.
    // A valid key for a *different* project is exactly the confusion that would
    // let a sandbox binding reach something else.
    if (key.project_id !== undefined && key.project_id !== options.project) {
      refuse(
        "CONNECTOR_CREDENTIAL_PROJECT_MISMATCH",
        `The configured credential belongs to project ${key.project_id}, not ${options.project}.`,
      );
    }

    const encode = (input: string): string =>
      Buffer.from(input).toString("base64")
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const issuedAt = Math.floor(nowMs / 1000);
    const header = encode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = encode(JSON.stringify({
      iss: key.client_email,
      // The narrowest scope that permits document CRUD. Not cloud-platform.
      scope: "https://www.googleapis.com/auth/datastore",
      aud: key.token_uri,
      iat: issuedAt,
      exp: issuedAt + 3600,
    }));
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${claims}`);
    const signature = signer.sign(key.private_key).toString("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    const response = http({
      method: "POST",
      url: key.token_uri,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${header}.${claims}.${signature}`,
      }).toString(),
    }, "token", null);
    if (response.status !== 200) {
      refuse("CONNECTOR_CREDENTIAL_REJECTED", "The sandbox credential was not accepted.");
    }
    const parsed = JSON.parse(response.body) as { access_token?: string; expires_in?: number };
    if (!parsed.access_token) {
      refuse("CONNECTOR_CREDENTIAL_REJECTED", "The token endpoint returned no access token.");
    }
    cachedToken = {
      value: parsed.access_token,
      expiresAt: nowMs + (parsed.expires_in ?? 3600) * 1000,
    };
    return cachedToken.value;
  }

  function http(
    request: FirestoreHttpRequest,
    recordedPath: string,
    precondition: string | null,
  ): FirestoreHttpResponse {
    const at = options.now();
    if (!options.httpImpl) {
      refuse(
        "CONNECTOR_TRANSPORT_UNAVAILABLE",
        "No HTTP transport is configured for this connector.",
      );
    }
    const response = options.httpImpl(request);
    calls.push({
      method: request.method,
      path: recordedPath,
      precondition,
      at,
      status: response.status,
    });
    return response;
  }

  /**
   * The one place a document URL is built.
   *
   * Pins the project before anything else. A target naming another project
   * never reaches the point of having a URL, so this connector cannot be
   * steered at production by mission input.
   */
  function documentUrl(targetId: string): { readonly url: string; readonly path: string } {
    const target = parseFirestoreDocumentTargetId(targetId);
    if (target.project !== options.project) {
      refuse(
        "CONNECTOR_TARGET_PROJECT_FORBIDDEN",
        `This connector is pinned to project ${options.project} and may not address `
        + `${target.project}. A mission cannot widen a connector's reach by supplying a path.`,
      );
    }
    if (target.database !== options.database) {
      refuse(
        "CONNECTOR_TARGET_DATABASE_FORBIDDEN",
        `This connector is pinned to database ${options.database} and may not address ${target.database}.`,
      );
    }
    if (target.collection !== options.collection) {
      refuse(
        "CONNECTOR_TARGET_COLLECTION_FORBIDDEN",
        `This connector is pinned to collection ${options.collection} and may not address `
        + `${target.collection}.`,
      );
    }
    const path = `${target.collection}/${target.documentId}`;
    return {
      url: `https://firestore.googleapis.com/v1/projects/${target.project}`
        + `/databases/${target.database}/documents/${path}`,
      path,
    };
  }

  function readDocument(targetId: string): ConnectorRecord | null {
    const { url, path } = documentUrl(targetId);
    const response = http({
      method: "GET",
      url,
      headers: { Authorization: `Bearer ${accessToken()}` },
      body: null,
    }, path, null);

    if (response.status === 404) return null;
    if (response.status === 403) {
      refuse(
        "CONNECTOR_AUTHORITY_INSUFFICIENT",
        "The configured credential is not authorized to read this document.",
      );
    }
    if (response.status !== 200) {
      // A read that did not answer is not a read that said "absent". Collapsing
      // the two is how a mission concludes nothing is there because the network
      // was down.
      refuse(
        "CONNECTOR_READ_UNAVAILABLE",
        `The document could not be read; Firestore answered ${response.status}.`,
      );
    }

    const document = JSON.parse(response.body) as {
      updateTime?: string;
      fields?: Record<string, Record<string, unknown>>;
    };
    if (!document.updateTime) {
      refuse("CONNECTOR_STATE_MALFORMED", "Firestore returned a document carrying no updateTime.");
    }
    const fields: Record<string, ExceptionFieldValue> = {};
    for (const [name, value] of Object.entries(document.fields ?? {})) {
      fields[name] = fromFirestoreValue(value);
    }
    return { targetId, revision: document.updateTime, fields };
  }

  return {
    connectorId: FIRESTORE_DOCUMENT_CONNECTOR_ID,

    manifest: () => FIRESTORE_DOCUMENT_CONNECTOR_MANIFEST,

    read(targetId) {
      reads += 1;
      return readDocument(targetId);
    },

    /**
     * Reconciliation: did *this* action land?
     *
     * Firestore cannot be asked "what happened to request X", so the question is
     * answered by reading the exact document and comparing the provenance the
     * create wrote into it. A document at the right path carrying a different
     * action's key is a conflict, not a success — and saying so is the whole
     * difference between reconciling and assuming.
     */
    readAction(idempotencyKey, requestedTargetId) {
      reconciliationReads += 1;
      // The caller's target when it has one, otherwise a key that carries its
      // own. Firestore offers no index from an idempotency key to a document,
      // so this connector must be told which object the question is about.
      const parts = idempotencyKey.split("@");
      const targetId = requestedTargetId
        ?? (parts.length > 1 ? parts.slice(1).join("@") : "");
      if (targetId === "") {
        refuse(
          "CONNECTOR_RECONCILIATION_TARGET_REQUIRED",
          "This connector cannot resolve an action without the target it addressed; Firestore has "
          + "no index from an idempotency key to a document.",
        );
      }
      const record = readDocument(targetId);
      if (!record) return null;

      const observedKey = String(record.fields[PROVENANCE_FIELDS.idempotencyKey] ?? "");
      if (observedKey !== idempotencyKey) {
        refuse(
          "CONNECTOR_TARGET_CONFLICT",
          `Document ${targetId} exists but was written by a different action. This is a conflict `
          + "requiring a human, never a target to overwrite.",
        );
      }
      return {
        idempotencyKey,
        targetId,
        capability: FIRESTORE_DOCUMENT_CREATE_CAPABILITY,
        writePayloadHash: String(record.fields[PROVENANCE_FIELDS.writePayloadHash] ?? ""),
        preStateHash: firestoreAbsentStateHash(targetId),
        postStateHash: record.revision,
        appliedAt: record.revision,
      };
    },

    apply(request) {
      if (request.capability !== FIRESTORE_DOCUMENT_CREATE_CAPABILITY) {
        refuse(
          "CONNECTOR_CAPABILITY_UNKNOWN",
          `Connector ${FIRESTORE_DOCUMENT_CONNECTOR_ID} declares no write capability `
          + `"${request.capability}".`,
        );
      }

      const unwritable = request.writePayload
        .map((entry) => entry.field)
        .filter((field) => !WRITABLE_FIELDS.includes(field));
      if (unwritable.length > 0) {
        refuse(
          "CONNECTOR_FIELD_NOT_WRITABLE",
          `Connector capability ${request.capability} may not write ${unwritable.sort().join(", ")}.`,
        );
      }

      // The pre-state for a create is absence, and it is checked twice: here
      // against what the contract was approved under, and again by Firestore
      // itself via the precondition below. The first catches a contract compiled
      // against the wrong idea of the world; the second catches the world moving
      // between this check and the write.
      const expectedAbsent = firestoreAbsentStateHash(request.targetId);
      if (request.expectedPreStateHash !== expectedAbsent) {
        refuse(
          "CONNECTOR_PRE_STATE_MISMATCH",
          "This action was approved against a pre-state other than document absence.",
        );
      }

      // Replay before anything else: an action that already landed must return
      // its original outcome rather than be attempted again.
      const existing = readDocument(request.targetId);
      if (existing) {
        const observedKey = String(existing.fields[PROVENANCE_FIELDS.idempotencyKey] ?? "");
        if (observedKey !== request.idempotencyKey) {
          refuse(
            "CONNECTOR_TARGET_CONFLICT",
            `Document ${request.targetId} already exists and was written by a different action.`,
          );
        }
        replays += 1;
        return {
          applied: true,
          performedWrite: false,
          action: {
            idempotencyKey: request.idempotencyKey,
            targetId: request.targetId,
            capability: request.capability,
            writePayloadHash: request.writePayloadHash,
            preStateHash: expectedAbsent,
            postStateHash: existing.revision,
            appliedAt: existing.revision,
          },
          record: existing,
        };
      }

      const fields: Record<string, Record<string, unknown>> = {};
      for (const entry of request.writePayload) {
        fields[entry.field] = toFirestoreValue(entry.value);
      }
      fields[PROVENANCE_FIELDS.idempotencyKey] = { stringValue: request.idempotencyKey };
      fields[PROVENANCE_FIELDS.writePayloadHash] = { stringValue: request.writePayloadHash };

      const { url, path } = documentUrl(request.targetId);
      // The precondition is not optional and has no other value. A PATCH that
      // could overwrite is not constructable from this module.
      const response = http({
        method: "PATCH",
        url: `${url}?currentDocument.exists=false`,
        headers: {
          Authorization: `Bearer ${accessToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fields }),
      }, path, "currentDocument.exists=false");

      if (response.status === 409 || response.status === 400) {
        refuse(
          "CONNECTOR_PRE_STATE_MISMATCH",
          "Firestore refused the create: the document already exists. The approved pre-state "
          + "no longer holds, so no write was performed.",
        );
      }
      if (response.status === 403) {
        refuse(
          "CONNECTOR_AUTHORITY_INSUFFICIENT",
          "The configured credential is not authorized to write this document.",
        );
      }
      if (response.status !== 200) {
        refuse(
          "CONNECTOR_WRITE_OUTCOME_UNKNOWN",
          `The create did not return a usable outcome; Firestore answered ${response.status}. `
          + "The outcome is unknown and must be reconciled by reading the exact document.",
        );
      }

      writes += 1;
      const created = JSON.parse(response.body) as { updateTime?: string };
      const action: ConnectorAppliedAction = {
        idempotencyKey: request.idempotencyKey,
        targetId: request.targetId,
        capability: request.capability,
        writePayloadHash: request.writePayloadHash,
        preStateHash: expectedAbsent,
        // The write's own reported revision. Recorded, but deliberately not used
        // as the compensation precondition — that comes from an independent read.
        postStateHash: created.updateTime ?? "",
        appliedAt: options.now(),
      };

      options.applyInterrupt?.(action);

      const record: ConnectorRecord = {
        targetId: request.targetId,
        revision: created.updateTime ?? "",
        fields: Object.fromEntries(
          request.writePayload.map((entry) => [entry.field, entry.value] as const),
        ),
      };
      return { applied: true, performedWrite: true, action, record };
    },

    compensate(request) {
      if (request.capability !== FIRESTORE_DOCUMENT_DELETE_CAPABILITY) {
        refuse(
          "CONNECTOR_CAPABILITY_UNKNOWN",
          `Connector ${FIRESTORE_DOCUMENT_CONNECTOR_ID} declares no compensation capability `
          + `"${request.capability}".`,
        );
      }
      if (request.expectedRevision.trim() === "") {
        // Without a revision this would be a force-delete: it would remove
        // whatever is at the path now, including another writer's document.
        refuse(
          "CONNECTOR_COMPENSATION_REVISION_REQUIRED",
          "A compensating delete must name the exact revision it is conditional on.",
        );
      }

      const { url, path } = documentUrl(request.targetId);
      const response = http({
        method: "DELETE",
        url: `${url}?currentDocument.updateTime=${encodeURIComponent(request.expectedRevision)}`,
        headers: { Authorization: `Bearer ${accessToken()}` },
        body: null,
      }, path, `currentDocument.updateTime=${request.expectedRevision}`);

      if (response.status === 404) {
        // Already gone. Not a failure — the desired end state holds — but it did
        // not perform a write, and the count must say so.
        replays += 1;
        return {
          compensated: true,
          performedWrite: false,
          targetId: request.targetId,
          expectedRevision: request.expectedRevision,
          compensatedAt: options.now(),
        };
      }
      if (response.status === 400 || response.status === 409) {
        refuse(
          "CONNECTOR_COMPENSATION_PRECONDITION_FAILED",
          "The document changed after it was created, so the compensating delete was refused. "
          + "Forcing past this would delete another writer's state; this requires a human.",
        );
      }
      if (response.status === 403) {
        refuse(
          "CONNECTOR_AUTHORITY_INSUFFICIENT",
          "The configured credential is not authorized to delete this document.",
        );
      }
      if (response.status !== 200) {
        refuse(
          "CONNECTOR_COMPENSATION_OUTCOME_UNKNOWN",
          `The compensating delete did not return a usable outcome; Firestore answered `
          + `${response.status}.`,
        );
      }

      compensations += 1;
      return {
        compensated: true,
        performedWrite: true,
        targetId: request.targetId,
        expectedRevision: request.expectedRevision,
        compensatedAt: options.now(),
      };
    },

    transportCalls: () => calls,

    counts: () => ({
      reads,
      writes,
      compensations,
      replays,
      reconciliationReads,
      // Typed as the literal `0`: this connector contains no retry loop, so
      // there is no code path that could increment one.
      blindRetries: 0,
    }),
  };
}

/**
 * A synchronous HTTP transport, because the connector port is synchronous.
 *
 * The same shape the git connector uses for `ls-remote`: a child process does
 * the I/O and the parent blocks. Making the whole port async instead would be a
 * refactor of every connector and worker in the fabric to enable one call.
 *
 * The request — including the bearer token — is passed over **stdin**, never
 * argv. Arguments are visible in the process list to any other user on the
 * machine; stdin is not. That is the only reason this is not a one-line
 * `execFileSync` with the URL as an argument.
 */
export function createSynchronousHttpTransport(
  options: { readonly timeoutMs?: number } = {},
): (request: FirestoreHttpRequest) => FirestoreHttpResponse {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const child = `
const input = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
fetch(input.url, {
  method: input.method,
  headers: input.headers,
  body: input.body === null ? undefined : input.body,
})
  .then(async (response) => {
    process.stdout.write(JSON.stringify({
      status: response.status,
      body: await response.text(),
    }));
  })
  .catch((error) => {
    process.stdout.write(JSON.stringify({ status: 0, body: String(error && error.message) }));
  });
`;
  return (request) => {
    const output = execFileSync(process.execPath, ["-e", child], {
      input: JSON.stringify(request),
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(output) as FirestoreHttpResponse;
  };
}

/**
 * The idempotency key shape this connector's reconciliation depends on.
 *
 * Carries the target inside the key, because reconciliation is asked only for a
 * key and must be able to reach the exact document without a second lookup
 * table — and a table would be a second authority over which document an action
 * addressed.
 */
export function firestoreIdempotencyKey(contractKey: string, targetId: string): string {
  return `${contractKey}@${targetId}`;
}
