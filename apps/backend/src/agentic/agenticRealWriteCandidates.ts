/**
 * CHANTER OS — the real-write candidate inventory.
 *
 * Every real external system reachable from this environment, written down as
 * data so the readiness verdict is reproducible rather than a recollection of
 * what someone once checked.
 *
 * Each record states what the system *declares* about itself. None of it is
 * aspirational: where a field is weak, it says so, and the evaluator rejects it.
 * The point of this file is to make a "no" auditable — a reader should be able
 * to see exactly which property is missing and what would have to change.
 *
 * ## What was inspected, and what was found
 *
 * Priorities 1 and 2 of the selection order (solar/PV/inverter, HVAC/electrical)
 * do not exist in this codebase at all. A search across every source file for
 * solar, inverter, PV, Enphase, SolarEdge, Fronius, Modbus, BACnet, thermostat,
 * Tuya, and Shelly returned only Python-virtualenv noise. There is nothing to
 * inventory, not merely nothing reachable.
 *
 * Priority 3 — CHANTER-connected SaaS — produced the records below.
 *
 * ## What changed, and what did not
 *
 * P0-C0 blocked with a single finding: every technically compensable candidate
 * lived in a **production** system whose credential belonged to a different
 * product, and no dedicated non-production environment existed anywhere.
 *
 * That prerequisite has since been supplied. A dedicated Firebase project
 * (`chanter-os-sandbox`, project number 351074813259) was provisioned for
 * CHANTER OS alone, with its own service account holding exactly one role —
 * `roles/datastore.user` on that project and nothing else. It shares no
 * credential, collection, or blast radius with chanter-site, AutoPoster,
 * Cloudinary, or production git.
 *
 * So exactly one record below is now eligible. Every production record is still
 * here, and still rejected, by name — including the production Firestore
 * document that used to be the strongest candidate. Removing them would make
 * the inventory look cleaner and prove less: a gate that only lists things it
 * approves of cannot demonstrate that it refuses anything.
 */
import {
  REAL_WRITE_READINESS_SCHEMA_VERSION,
  type RealWriteEligibilityRecord,
  type UnknownOutcomePolicy,
} from "./agenticRealWriteReadiness.js";

/**
 * The reconciliation policy for any create addressed by a caller-chosen id.
 *
 * Shared because the reasoning is identical wherever object identity is the
 * caller's: a lost response is resolved by reading the exact object, and every
 * branch of that read has a defined consequence. Nothing here permits a retry
 * that has not first observed the world.
 */
const READ_BACK_ON_UNKNOWN: UnknownOutcomePolicy = Object.freeze({
  resolution: "independent_read_of_exact_object",
  onAbsent:
    "create was not observed to land; retry only under explicit policy, never automatically",
  onPresentMatchingPayload:
    "treat the create as applied and do not repeat it — the object is already the intended one",
  onPresentDifferentPayload:
    "conflict: something else owns this id. Stop and escalate to a human; never overwrite",
  onReadUnavailable:
    "still unknown. The outcome stays unresolved and no blind retry is permitted",
});

function candidate(record: RealWriteEligibilityRecord): RealWriteEligibilityRecord {
  return Object.freeze(record);
}

export const REAL_WRITE_CANDIDATES: readonly RealWriteEligibilityRecord[] = Object.freeze([
  /**
   * The predecessor slice's shadow target, carried forward so the gate rejects
   * it explicitly rather than by omission.
   *
   * It has the best identity and revision semantics in this system and is still
   * ineligible, which is the whole lesson: a write is only as safe as its undo.
   * Undoing a ref update means forcing the ref backwards, which destroys any
   * commit that landed in between — a second, larger write wearing a rollback's
   * name.
   */
  candidate({
    schemaVersion: REAL_WRITE_READINESS_SCHEMA_VERSION,
    connectorId: "connector.git.remote-ref.v1",
    systemType: "git_remote",
    environment: "production",
    externalObjectId: "https://github.com/ChanterAi/chanter-Operator.git#refs/heads/master",
    writeCapability: "ref.update",
    writePayloadSchema: ["commitSha"],
    preStateCondition: {
      kind: "revision",
      revisionType: "content_hash",
      revisionValue: "55c0f09025c560846ef5d28636dcc2e24e9e25b3",
    },
    unknownOutcomePolicy: READ_BACK_ON_UNKNOWN,
    idempotencySupport: "compare_and_swap",
    idempotencyKeyStrategy: "expected old SHA (compare-and-swap on the ref)",
    compensationMode: "none",
    compensationCapability: null,
    verificationOracle: {
      oracleId: "oracle.git.ls-remote.v1",
      method: "independent `git ls-remote` re-read of the ref advertisement",
      independentOfWriteResponse: true,
    },
    maximumBlastRadius: {
      scope: "one ref on a production repository other humans pull from",
      objectCount: 1,
      customerVisible: false,
      // The decisive field. A ref update cannot be removed, only overwritten.
      reversible: false,
    },
    humanApprovalRequired: true,
    writeEnabled: false,
    writeAuthorityEstablished: false,
    notes:
      "Proven read-only in P0-B at 16/16. Ineligible for a first write: compensation would be a "
      + "force-push, which destroys any commit that landed in between. Also forbidden outright by "
      + "the blast-radius rules as a production git ref mutation.",
  }),

  /**
   * A disposable branch, created and deleted.
   *
   * Genuinely create/delete symmetric — deleting a branch destroys no commit —
   * and it is the closest this environment comes to an eligible target. It fails
   * on the two facts that are not about git at all: the repository is production,
   * and no credential is established as authorized for CHANTER OS to write with.
   */
  candidate({
    schemaVersion: REAL_WRITE_READINESS_SCHEMA_VERSION,
    connectorId: "connector.git.remote-ref.v1",
    systemType: "git_remote",
    environment: "production",
    externalObjectId:
      "https://github.com/ChanterAi/chanter-Operator.git#refs/heads/chanter-p0c-probe",
    writeCapability: "ref.create",
    writePayloadSchema: ["commitSha"],
    // The ref does not exist yet, and git can bind that exactly: a create-only
    // push declares an expected old value of all-zeroes and is refused by the
    // receiving end if anything is already there.
    preStateCondition: {
      kind: "exists",
      expected: false,
      enforcedBy: "receive-pack ref update with expected old value 0000000 (create-only)",
    },
    unknownOutcomePolicy: READ_BACK_ON_UNKNOWN,
    idempotencySupport: "deterministic_identity",
    idempotencyKeyStrategy: "the ref path itself; a second create is a conflict, never a duplicate",
    compensationMode: "idempotent_create_delete",
    compensationCapability: "ref.delete",
    verificationOracle: {
      oracleId: "oracle.git.ls-remote.v1",
      method: "independent `git ls-remote` re-read; absence after delete is directly observable",
      independentOfWriteResponse: true,
    },
    maximumBlastRadius: {
      scope: "one new disposable ref on a production repository",
      objectCount: 1,
      customerVisible: false,
      reversible: true,
    },
    humanApprovalRequired: true,
    writeEnabled: false,
    writeAuthorityEstablished: false,
    notes:
      "Compensation is genuine — deleting a branch destroys no commit, and the create-only "
      + "precondition binds absence exactly. Still blocked: the repository is production with no "
      + "sandbox counterpart, and no CHANTER-OS-authorized push credential exists. The sandbox "
      + "Firestore document below is the same shape without either objection.",
  }),

  /**
   * The production Firestore document, retained specifically to be refused.
   *
   * This was P0-C0's strongest candidate, and every mechanical property that
   * made it strong is still true. What disqualifies it has never been mechanical:
   * the only credential for `chanter-site` is AutoPoster's production service
   * account, and that project holds real user records including encrypted OAuth
   * tokens.
   *
   * Now that an eligible sandbox exists, keeping this record costs nothing and
   * proves something — that eligibility followed the environment and the
   * authority, and was not quietly granted to production along the way.
   */
  candidate({
    schemaVersion: REAL_WRITE_READINESS_SCHEMA_VERSION,
    connectorId: "connector.firestore.document.v1",
    systemType: "document_store",
    environment: "production",
    externalObjectId: "projects/chanter-site/databases/(default)/documents/chanterOsProbe/{docId}",
    writeCapability: "document.create",
    writePayloadSchema: ["probeId", "createdAt"],
    preStateCondition: {
      kind: "exists",
      expected: false,
      enforcedBy: "Firestore commit precondition currentDocument.exists=false",
    },
    unknownOutcomePolicy: READ_BACK_ON_UNKNOWN,
    idempotencySupport: "deterministic_identity",
    idempotencyKeyStrategy: "caller-chosen document id; create on an existing id is a typed conflict",
    compensationMode: "idempotent_create_delete",
    compensationCapability: "document.delete",
    verificationOracle: {
      oracleId: "oracle.firestore.get.v1",
      method: "independent document read; absence after delete is directly observable",
      independentOfWriteResponse: true,
    },
    maximumBlastRadius: {
      scope: "one document in a dedicated collection inside a production project",
      objectCount: 1,
      // Not itself customer-visible, but it shares a project with real user
      // records including encrypted OAuth tokens.
      customerVisible: false,
      reversible: true,
    },
    humanApprovalRequired: true,
    writeEnabled: false,
    writeAuthorityEstablished: false,
    notes:
      "Mechanically identical to the eligible sandbox record below, and still refused. The only "
      + "credential for chanter-site is AutoPoster's production service account, and the project "
      + "holds real user data — that authority is the founder's to grant, not mine to infer. "
      + "Retained so the gate demonstrates a refusal it could have quietly dropped.",
  }),

  /**
   * The provisioned CHANTER OS sandbox document — the first eligible candidate.
   *
   * Everything that blocked its production twin was environmental, and the
   * environment changed: `chanter-os-sandbox` exists solely for this, and the
   * credential that reaches it can do nothing else anywhere.
   *
   * The pre-state is the interesting part. A create has no prior `updateTime`,
   * and P0-C0 could only record that as `null` — which the gate read, correctly,
   * as having no exact pre-state at all. The honest answer was never a revision
   * string: it is that the document is **absent**, which Firestore enforces
   * server-side via `currentDocument.exists=false`. Two concurrent creates on
   * the same id cannot both win; the loser gets ALREADY_EXISTS.
   *
   * Measured on the real project during provisioning: create returned an
   * `updateTime`, an independent read returned the same one, a delete conditional
   * on it succeeded, and a stale-revision write was refused with
   * FAILED_PRECONDITION. None of that was inferred from documentation.
   */
  candidate({
    schemaVersion: REAL_WRITE_READINESS_SCHEMA_VERSION,
    connectorId: "connector.firestore.document.v1",
    systemType: "document_store",
    environment: "sandbox",
    externalObjectId:
      "projects/chanter-os-sandbox/databases/(default)/documents/chanter_os_real_write_p0/{objectId}",
    writeCapability: "document.create",
    writePayloadSchema: ["missionId", "actionId", "createdAt", "probeId"],
    preStateCondition: {
      kind: "exists",
      expected: false,
      enforcedBy: "Firestore commit precondition currentDocument.exists=false",
    },
    unknownOutcomePolicy: READ_BACK_ON_UNKNOWN,
    idempotencySupport: "deterministic_identity",
    idempotencyKeyStrategy:
      "document id derived from mission+action identity via deriveDeterministicObjectId, combined "
      + "with currentDocument.exists=false. This is object-identity idempotency, NOT request-level "
      + "idempotency: Firestore accepts no caller-supplied idempotency key, so a replayed request "
      + "is collapsed by the id and the precondition, and a second attempt fails ALREADY_EXISTS "
      + "rather than being silently absorbed as a duplicate-free no-op.",
    compensationMode: "idempotent_create_delete",
    compensationCapability: "document.delete",
    verificationOracle: {
      oracleId: "oracle.firestore.get.v1",
      method:
        "independent document read via the Firestore REST get endpoint, issued separately from the "
        + "write call; absence after delete returns 404 NOT_FOUND and is directly observable",
      independentOfWriteResponse: true,
    },
    maximumBlastRadius: {
      scope:
        "one document in collection chanter_os_real_write_p0 of the dedicated sandbox project "
        + "chanter-os-sandbox, which holds no customer, payment, or OAuth data of any kind",
      objectCount: 1,
      customerVisible: false,
      reversible: true,
    },
    humanApprovalRequired: true,
    writeEnabled: false,
    writeAuthorityEstablished: true,
    notes:
      "Dedicated non-production project chanter-os-sandbox (number 351074813259), Firestore "
      + "(default) database, FIRESTORE_NATIVE, location nam5. Authority is service account "
      + "chanter-os-p0c@chanter-os-sandbox.iam.gserviceaccount.com holding exactly one binding "
      + "anywhere: roles/datastore.user on this project — document CRUD only, no database, index, "
      + "or rules administration, and nothing at all on chanter-site or AutoPoster. Capability was "
      + "measured, not assumed: an 8/8 provisioning probe proved read-of-absent (404 not 403), "
      + "create, independent re-read, stale-revision refusal, matching-revision acceptance, "
      + "conditional delete, and independently observed absence, leaving zero residual objects. "
      + "That probe ran outside CHANTER OS governance and is not the P0-C proof.",
  }),

  /**
   * A Cloudinary asset in a dedicated folder.
   *
   * Upload/destroy is symmetric and the asset carries a version and an etag.
   * Blocked for the same reason as Firestore, plus one of its own: deletion
   * propagation through a CDN is eventually consistent, so "verify absence"
   * is weaker than it looks.
   */
  candidate({
    schemaVersion: REAL_WRITE_READINESS_SCHEMA_VERSION,
    connectorId: "connector.cloudinary.asset.v1",
    systemType: "media_store",
    environment: "production",
    externalObjectId: "cloudinary://dufqftrpg/chanter-os-probe/{publicId}",
    writeCapability: "asset.upload",
    writePayloadSchema: ["publicId", "bytes"],
    // Cloudinary binds absence the same way: an upload with overwrite disabled
    // is refused if the public_id is already taken.
    preStateCondition: {
      kind: "exists",
      expected: false,
      enforcedBy: "Upload API with overwrite=false; an existing public_id is refused",
    },
    unknownOutcomePolicy: READ_BACK_ON_UNKNOWN,
    idempotencySupport: "deterministic_identity",
    idempotencyKeyStrategy: "caller-chosen public_id with overwrite disabled",
    compensationMode: "idempotent_create_delete",
    compensationCapability: "asset.destroy",
    verificationOracle: {
      oracleId: "oracle.cloudinary.admin-resource.v1",
      method: "independent Admin API resource read",
      independentOfWriteResponse: true,
    },
    maximumBlastRadius: {
      scope: "one asset in a dedicated folder inside a production media account",
      objectCount: 1,
      // Cloudinary assets are served from a public CDN by default.
      customerVisible: true,
      reversible: true,
    },
    humanApprovalRequired: true,
    writeEnabled: false,
    writeAuthorityEstablished: false,
    notes:
      "Upload/destroy is symmetric, but the account is AutoPoster's production media store, assets "
      + "are served from a public CDN, and delete propagation is eventually consistent — so "
      + "'verify absence' is weaker than an authoritative read. Same unestablished authority as "
      + "Firestore.",
  }),
]);

/**
 * Systems inspected and found to have nothing to offer, recorded so the next
 * reader does not re-derive the same dead ends.
 */
export const REAL_WRITE_INSPECTED_WITHOUT_CANDIDATE: readonly {
  readonly system: string;
  readonly finding: string;
}[] = Object.freeze([
  Object.freeze({
    system: "solar PV / inverter / monitoring (selection priority 1)",
    finding:
      "No integration exists. A codebase-wide search for solar, inverter, PV, Enphase, SolarEdge, "
      + "Fronius, GoodWe, Growatt, and Modbus matched only Python-virtualenv files.",
  }),
  Object.freeze({
    system: "HVAC / electrical operational source (selection priority 2)",
    finding:
      "No integration exists. The same search over hvac, thermostat, heat-pump, BACnet, Zigbee, "
      + "Tuya, and Shelly matched nothing outside vendored dependencies.",
  }),
  Object.freeze({
    system: "TikTok / YouTube / Instagram",
    finding:
      "Only OAuth *client* credentials are configured; per-user access tokens live encrypted in "
      + "Firestore. No write is possible without them, and every available capability is a "
      + "customer-visible publication, which the blast-radius rules forbid outright.",
  }),
  Object.freeze({
    system: "OpenAI / Gemini / OpenRouter",
    finding:
      "Inference providers with no addressable object model: nothing to create, revise, or delete, "
      + "so there is no compensable write to consider.",
  }),
  Object.freeze({
    system: "Firestore emulator (FIRESTORE_EMULATOR_HOST)",
    finding:
      "Local process, not a real external system. Writing to it would prove nothing this fabric's "
      + "simulated connector has not already proven at 18/18.",
  }),
]);
