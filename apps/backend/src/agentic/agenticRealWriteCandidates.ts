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
 * Priority 3 — CHANTER-connected SaaS — produced the four records below.
 *
 * ## The finding that decides the gate
 *
 * Every technically compensable candidate lives in a **production** system whose
 * credential belongs to a different product, and this environment contains **no
 * sandbox, test tenant, or dedicated non-production project of any kind**. The
 * only non-production environment available is a local Firestore emulator, which
 * is not a real external system and so cannot satisfy a real-write proof.
 *
 * That is a missing prerequisite, not a missing capability — and it is one only
 * the founder can supply.
 */
import {
  REAL_WRITE_READINESS_SCHEMA_VERSION,
  type RealWriteEligibilityRecord,
} from "./agenticRealWriteReadiness.js";

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
    preconditionRevisionType: "content_hash",
    preconditionRevisionValue: "55c0f09025c560846ef5d28636dcc2e24e9e25b3",
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
    preconditionRevisionType: "content_hash",
    // Absent by definition: the ref does not exist yet, so there is no prior
    // revision to bind an approval to.
    preconditionRevisionValue: null,
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
      "Compensation is genuine — deleting a branch destroys no commit. Blocked on two grounds: the "
      + "repository is production with no sandbox counterpart, and no CHANTER-OS-authorized push "
      + "credential exists. A create also has no prior revision to bind an approval to.",
  }),

  /**
   * A Firestore document in a dedicated collection.
   *
   * Technically the strongest candidate on every mechanical axis: exact
   * per-document `updateTime` with real compare-and-swap preconditions, caller
   * chosen document ids, create/delete symmetry, and an independent read oracle.
   * It fails on authority and environment, and those are the founder's to change.
   */
  candidate({
    schemaVersion: REAL_WRITE_READINESS_SCHEMA_VERSION,
    connectorId: "connector.firestore.document.v1",
    systemType: "document_store",
    environment: "production",
    externalObjectId: "projects/chanter-site/databases/(default)/documents/chanterOsProbe/{docId}",
    writeCapability: "document.create",
    writePayloadSchema: ["probeId", "createdAt"],
    preconditionRevisionType: "update_time",
    // Unknown without reading the real project, which would mean using another
    // product's production credential. Left null rather than guessed.
    preconditionRevisionValue: null,
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
      "Mechanically the strongest candidate: real compare-and-swap on updateTime, caller-chosen "
      + "identity, true create/delete symmetry, independent read oracle. Blocked because the only "
      + "credential is AutoPoster's production service account for project chanter-site, which also "
      + "holds real user data — that authority is the founder's to grant, not mine to infer. No "
      + "dedicated CHANTER OS project exists. The configured Firestore emulator is local and "
      + "therefore not a real external system.",
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
    preconditionRevisionType: "version",
    preconditionRevisionValue: null,
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
