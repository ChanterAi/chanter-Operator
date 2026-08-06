import { createHash } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AutoPosterRuntimeMissionExecutor } from "../runtimeMissions/autoPosterRuntime.js";
import type {
  AutoPosterMissionService,
  AutoPosterSoundMode,
} from "../runtimeMissions/autoPosterMissionService.js";
import {
  autoPosterSchedulePayloadJson,
  validateAutoPosterScheduleInput,
} from "../runtimeMissions/autoPosterScheduleInput.js";
import { withTransaction } from "../db/database.js";
import { OperatorError } from "../services/operatorService.js";
import type { AutoPosterMissionEvidenceService } from "../missions/autoPosterMissionEvidenceService.js";
import {
  missionGraphChildMissionId,
} from "../missions/missionGraphCompiler.js";
import type {
  MissionGraphService,
  MissionGraphView,
} from "../missions/missionGraphService.js";

export const PLATFORM_AUTOPOSTER_COMMAND_SCHEMA_VERSION =
  "chanter.platform.autoposter.create-work.v1" as const;

const GRAPH_NODE_ID = "autoposter_schedule";
const STAGED_MEDIA_REFERENCE_PREFIX = "chanter-autoposter-staged://v1/";
const STAGED_MEDIA_SCHEMA_VERSION = "chanter.autoposter.staged-media.v1";
const VIDEO_MIME_BY_EXTENSION = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
} as const;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;
const ISO_WITH_ZONE_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const SENSITIVE_KEY_PATTERN =
  /(?:^|[-_])(token|secret|password|credential|api[-_]?key|private[-_]?key|authorization|cookie)(?:$|[-_])/i;
const SECRET_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
] as const;

type Provider = "tiktok" | "youtube";

export interface PlatformPublicMedia {
  kind: "public_url";
  url: string;
  mediaType: "video";
}

export interface PlatformStagedMedia {
  kind: "autoposter_staged_upload";
  reference: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
}

export type PlatformCanonicalMedia = PlatformPublicMedia | PlatformStagedMedia;

export interface PlatformAutoPosterCommand {
  schemaVersion: typeof PLATFORM_AUTOPOSTER_COMMAND_SCHEMA_VERSION;
  commandId: string;
  tenantId: string;
  actorId: string;
  intakeKey: string;
  media: PlatformCanonicalMedia;
  destinations: [{
    provider: Provider;
    accountId: string;
    soundMode: AutoPosterSoundMode;
  }];
  copy: {
    caption: string;
    hashtags: string;
    youtube: {
      title: string;
      description: string;
    };
  };
  schedule: {
    mode: "explicit";
    scheduledAt: string;
    timezoneName: string;
    timezoneOffsetMinutes: number;
  };
  approvalPolicy: {
    draftExecution: "operator_control_required";
    publication: "human_required";
  };
  requestedAt: string;
}

export type PlatformCommandLifecycleState =
  | "accepted"
  | "approval_required"
  | "executing"
  | "failed_recoverable"
  | "completed"
  | "failed";

export interface PlatformAutoPosterCommandView {
  replayed: boolean;
  commandId: string;
  schemaVersion: typeof PLATFORM_AUTOPOSTER_COMMAND_SCHEMA_VERSION;
  tenantId: string;
  actorId: string;
  intakeKey: string;
  commandHash: string;
  graphId: string | null;
  graphHash: string | null;
  missionId: string | null;
  runtimeExecutionId: string | null;
  campaignId: string | null;
  jobIds: string[];
  approvalId: string | null;
  evidenceBundleId: string | null;
  evidenceAvailable: boolean;
  evidenceReference: string | null;
  traceId: string | null;
  lifecycleState: PlatformCommandLifecycleState;
  productState: "not_started" | "recovery_required" | "draft_created" | "failed";
  draftExecutionApprovalState: "required" | "approved";
  publicationApprovalState: "human_required";
  error: { code: string; message: string } | null;
  requestedAt: string;
  createdAt: string;
  updatedAt: string;
  executedAt: string | null;
}

interface CommandRow {
  command_id: string;
  schema_version: typeof PLATFORM_AUTOPOSTER_COMMAND_SCHEMA_VERSION;
  tenant_id: string;
  actor_id: string;
  intake_key: string;
  canonical_json: string;
  command_hash: string;
  graph_id: string | null;
  graph_hash: string | null;
  child_mission_id: string | null;
  runtime_execution_id: string | null;
  campaign_id: string | null;
  job_ids_json: string;
  approval_id: string | null;
  evidence_bundle_id: string | null;
  evidence_manifest_path: string | null;
  evidence_available: number;
  trace_id: string | null;
  lifecycle_state: PlatformCommandLifecycleState;
  product_state: "not_started" | "recovery_required" | "draft_created" | "failed";
  draft_execution_approval_state: "required" | "approved";
  publication_approval_state: "human_required";
  error_code: string | null;
  error_message: string | null;
  requested_at: string;
  executed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface PlatformAutoPosterCommandServiceOptions {
  now?: () => Date;
  protectedValues?: string[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function derivePlatformAutoPosterCommandId(
  tenantId: string,
  actorId: string,
  intakeKey: string,
): string {
  return `platform-autoposter-${sha256(`${tenantId}\n${actorId}\n${intakeKey}`).slice(0, 40)}`;
}

function graphIdFor(commandId: string): string {
  return `${commandId}-graph`;
}

function traceIdFor(commandId: string): string {
  return `${commandId}-trace`;
}

function graphIdempotencyKeyFor(commandId: string): string {
  return `${commandId}-intake`;
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  scope: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length
    || actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new OperatorError(
      `${scope} must contain exactly the fields registered by ${PLATFORM_AUTOPOSTER_COMMAND_SCHEMA_VERSION}.`,
      400,
      "PLATFORM_COMMAND_SCHEMA_INVALID",
    );
  }
}

function invalidStagedMedia(message: string): never {
  throw new OperatorError(message, 400, "PLATFORM_COMMAND_MEDIA_INVALID");
}

function stagedReferencePayload(reference: string): Record<string, unknown> {
  if (!reference.startsWith(STAGED_MEDIA_REFERENCE_PREFIX)) {
    return invalidStagedMedia("The staged media reference prefix is invalid.");
  }
  const signed = reference.slice(STAGED_MEDIA_REFERENCE_PREFIX.length);
  const [encoded, signature, extra] = signed.split(".");
  if (
    !encoded
    || !signature
    || extra !== undefined
    || !/^[A-Za-z0-9_-]+$/.test(encoded)
    || !/^[0-9a-f]{64}$/.test(signature)
  ) {
    return invalidStagedMedia("The staged media reference is malformed.");
  }

  let decoded: string;
  let payload: Record<string, unknown> | null;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) {
      return invalidStagedMedia("The staged media reference encoding is not canonical.");
    }
    decoded = bytes.toString("utf8");
    payload = jsonObject(JSON.parse(decoded));
  } catch {
    return invalidStagedMedia("The staged media reference payload is invalid.");
  }
  if (!payload) {
    return invalidStagedMedia("The staged media reference payload must be an object.");
  }

  const expectedKeys = [
    "schemaVersion",
    "commandId",
    "fileName",
    "mimeType",
    "byteSize",
    "sha256",
    "extension",
  ].sort();
  const actualKeys = Object.keys(payload).sort();
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
    || payload.schemaVersion !== STAGED_MEDIA_SCHEMA_VERSION
  ) {
    return invalidStagedMedia("The staged media reference payload contract is invalid.");
  }
  return payload;
}

function exactIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new OperatorError(
      `${field} must be an exact bounded stable identifier.`,
      400,
      "PLATFORM_COMMAND_IDENTITY_INVALID",
    );
  }
  return value;
}

function exactOpaqueString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > maxLength
    || CONTROL_CHAR_PATTERN.test(value)
  ) {
    throw new OperatorError(
      `${field} must preserve one exact bounded opaque identifier.`,
      400,
      "PLATFORM_COMMAND_IDENTITY_INVALID",
    );
  }
  return value;
}

function exactString(
  value: unknown,
  field: string,
  maxLength: number,
  allowBlank = false,
): string {
  if (
    typeof value !== "string"
    || value !== value.trim()
    || value.length > maxLength
    || (!allowBlank && !value)
    || CONTROL_CHAR_PATTERN.test(value)
  ) {
    throw new OperatorError(
      `${field} must be an exact trimmed string of at most ${maxLength} characters.`,
      400,
      "PLATFORM_COMMAND_FIELD_INVALID",
    );
  }
  return value;
}

function assertNoSecretShapedMaterial(
  value: unknown,
  protectedValues: readonly string[],
  pathParts: string[] = [],
): void {
  if (typeof value === "string") {
    if (
      protectedValues.some((protectedValue) => protectedValue && value.includes(protectedValue))
      || SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))
    ) {
      throw new OperatorError(
        "Platform commands must not contain credentials or secret-shaped values.",
        400,
        "PLATFORM_COMMAND_SECRET_MATERIAL",
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoSecretShapedMaterial(entry, protectedValues, [...pathParts, String(index)]));
    return;
  }
  const object = jsonObject(value);
  if (!object) return;
  for (const [key, child] of Object.entries(object)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      throw new OperatorError(
        "Platform commands must not contain credential or secret-shaped fields.",
        400,
        "PLATFORM_COMMAND_SECRET_MATERIAL",
      );
    }
    assertNoSecretShapedMaterial(child, protectedValues, [...pathParts, key]);
  }
}

function offsetFromIso(value: string): number | null {
  const match = value.match(/(Z|([+-])(\d{2}):(\d{2}))$/);
  if (!match) return null;
  if (match[1] === "Z") return 0;
  const minutes = Number(match[3]) * 60 + Number(match[4]);
  return match[2] === "-" ? -minutes : minutes;
}

function timezoneOffsetAt(value: Date, timezoneName: string): number | null {
  try {
    const part = new Intl.DateTimeFormat("en-US", {
      timeZone: timezoneName,
      timeZoneName: "longOffset",
      year: "numeric",
    }).formatToParts(value).find((entry) => entry.type === "timeZoneName")?.value;
    if (!part) return null;
    if (part === "GMT") return 0;
    const match = part.match(/^GMT([+-])(\d{2}):(\d{2})$/);
    if (!match) return null;
    const minutes = Number(match[2]) * 60 + Number(match[3]);
    return match[1] === "-" ? -minutes : minutes;
  } catch {
    return null;
  }
}

function errorDetails(error: unknown): { code: string; message: string } {
  if (error instanceof OperatorError) {
    return {
      code: error.code ?? "PLATFORM_COMMAND_FAILED",
      message: error.message,
    };
  }
  return {
    code: "PLATFORM_COMMAND_FAILED",
    message: "The canonical Platform command failed safely.",
  };
}

function stableDownstreamId(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > 256
    || CONTROL_CHAR_PATTERN.test(value)
  ) {
    throw new OperatorError(
      `${field} is missing or invalid in the AutoPoster result.`,
      409,
      "PLATFORM_LINKAGE_RESULT_INVALID",
    );
  }
  return value;
}

export class PlatformAutoPosterCommandService {
  private readonly now: () => Date;
  private readonly protectedValues: string[];

  constructor(
    private readonly database: DatabaseSync,
    private readonly missionGraphService: MissionGraphService,
    private readonly runtimeMissionService: AutoPosterMissionService,
    private readonly executor: AutoPosterRuntimeMissionExecutor,
    private readonly evidenceService: AutoPosterMissionEvidenceService,
    options: PlatformAutoPosterCommandServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.protectedValues = (options.protectedValues ?? [])
      .map((value) => value.trim())
      .filter(Boolean);
  }

  async submit(rawBody: unknown): Promise<PlatformAutoPosterCommandView> {
    const input = jsonObject(rawBody);
    if (!input) {
      throw new OperatorError("Request body must be an object.", 400);
    }
    assertNoSecretShapedMaterial(input, this.protectedValues);
    exactKeys(input, [
      "schemaVersion", "commandId", "tenantId", "actorId", "intakeKey",
      "media", "destinations", "copy", "schedule", "approvalPolicy", "requestedAt",
    ], "Platform command");

    const tenantId = exactIdentifier(input.tenantId, "tenantId");
    const actorId = exactIdentifier(input.actorId, "actorId");
    const intakeKey = exactIdentifier(input.intakeKey, "intakeKey");
    const commandId = exactIdentifier(input.commandId, "commandId");
    const expectedCommandId = derivePlatformAutoPosterCommandId(tenantId, actorId, intakeKey);
    if (commandId !== expectedCommandId) {
      throw new OperatorError(
        "commandId does not match the exact tenant, actor, and intake binding.",
        409,
        "PLATFORM_COMMAND_IDENTITY_MISMATCH",
      );
    }

    const existing = this.findExisting(commandId, tenantId, actorId, intakeKey);
    const durableRequestedAt = existing?.requested_at;
    const command = this.parseCommand(input, durableRequestedAt);
    const canonicalJson = JSON.stringify(command);
    const commandHash = sha256(canonicalJson);

    if (existing) {
      this.assertExistingIntegrity(existing, canonicalJson, commandHash);
      return this.submitPersistedCommand(command, existing, true);
    }

    const timestamp = this.now().toISOString();
    withTransaction(this.database, () => {
      const raced = this.findExisting(commandId, tenantId, actorId, intakeKey);
      if (raced) {
        this.assertExistingIntegrity(raced, canonicalJson, commandHash);
        return;
      }
      this.database.prepare(`
        INSERT INTO operator_platform_autoposter_commands (
          command_id, schema_version, tenant_id, actor_id, intake_key,
          canonical_json, command_hash, graph_id, graph_hash, child_mission_id,
          runtime_execution_id, campaign_id, job_ids_json, approval_id,
          evidence_bundle_id, evidence_manifest_path, evidence_available,
          trace_id, lifecycle_state, product_state,
          draft_execution_approval_state, publication_approval_state,
          error_code, error_message, requested_at, executed_at, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, '[]', NULL,
          NULL, NULL, 0, NULL, 'accepted', 'not_started', 'required',
          'human_required', NULL, NULL, ?, NULL, ?, ?
        )
      `).run(
        command.commandId,
        command.schemaVersion,
        command.tenantId,
        command.actorId,
        command.intakeKey,
        canonicalJson,
        commandHash,
        command.requestedAt,
        timestamp,
        timestamp,
      );
    });

    return this.submitPersistedCommand(
      command,
      this.requireRow(command.commandId),
      false,
    );
  }

  async execute(
    commandIdValue: unknown,
    rawBody: unknown,
  ): Promise<PlatformAutoPosterCommandView> {
    const commandId = exactIdentifier(commandIdValue, "commandId");
    const body = jsonObject(rawBody);
    if (!body) throw new OperatorError("Request body must be an object.", 400);
    assertNoSecretShapedMaterial(body, this.protectedValues);
    exactKeys(body, ["graphHash"], "Platform command execution request");
    const graphHash = exactString(body.graphHash, "graphHash", 64);
    if (!/^[0-9a-f]{64}$/.test(graphHash)) {
      throw new OperatorError(
        "graphHash must be the exact lowercase SHA-256 graph binding.",
        400,
        "OPERATOR_GRAPH_HASH_INVALID",
      );
    }

    const row = this.requireRow(commandId);
    this.assertRowIntegrity(row);
    if (!row.graph_id || !row.graph_hash || !row.child_mission_id) {
      throw new OperatorError(
        "The canonical command has no durable graph binding.",
        409,
        "PLATFORM_COMMAND_GRAPH_NOT_READY",
      );
    }
    if (graphHash !== row.graph_hash) {
      throw new OperatorError(
        "The supplied graphHash does not match the canonical command binding.",
        409,
        "OPERATOR_GRAPH_APPROVAL_HASH_MISMATCH",
      );
    }

    const startedAt = this.now().toISOString();
    this.database.prepare(`
      UPDATE operator_platform_autoposter_commands
         SET lifecycle_state = 'executing',
             draft_execution_approval_state = 'approved',
             error_code = NULL,
             error_message = NULL,
             updated_at = ?
       WHERE command_id = ?
    `).run(startedAt, commandId);

    try {
      const graphBeforeApproval = this.missionGraphService.getGraph(row.graph_id);
      let graph = await this.missionGraphService.approveGraph(row.graph_id, {
        approvedBy: row.actor_id,
        graphHash,
      });
      if (
        graphBeforeApproval.status !== "approval_required"
        && (
          graph.status === "approved"
          || graph.status === "running"
          || graph.status === "failed_recoverable"
        )
      ) {
        graph = await this.missionGraphService.resumeGraph(row.graph_id);
      }
      if (graph.status !== "completed") {
        throw new OperatorError(
          `The canonical graph did not complete draft execution (${graph.status}).`,
          409,
          "PLATFORM_COMMAND_EXECUTION_INCOMPLETE",
        );
      }

      const refreshed = await this.completeLinkage(row, graph);
      return { ...refreshed, replayed: row.lifecycle_state === "completed" };
    } catch (error) {
      this.persistExecutionFailure(commandId, error);
      throw error;
    }
  }

  get(commandIdValue: unknown): PlatformAutoPosterCommandView {
    const commandId = exactIdentifier(commandIdValue, "commandId");
    const row = this.requireRow(commandId);
    this.assertRowIntegrity(row);
    return this.mapRow(row);
  }

  list(limit = 50): PlatformAutoPosterCommandView[] {
    const bounded = Math.max(1, Math.min(
      Number.isFinite(limit) ? Math.trunc(limit) : 50,
      100,
    ));
    return (this.database.prepare(`
      SELECT *
        FROM operator_platform_autoposter_commands
       ORDER BY created_at DESC, command_id DESC
       LIMIT ?
    `).all(bounded) as unknown as CommandRow[]).map((row) => {
      this.assertRowIntegrity(row);
      return this.mapRow(row);
    });
  }

  /**
   * Every AutoPoster child mission currently owned by a canonical Platform
   * command.
   *
   * Read-only, and deliberately owned here rather than by the caller: the
   * unified CHANTER OS read model needs to exclude these missions from its
   * direct-AutoPoster lane so one command is never counted twice, and the
   * service that owns this table is the only place that should query it.
   */
  ownedChildMissionIds(): ReadonlySet<string> {
    const rows = this.database.prepare(`
      SELECT child_mission_id
        FROM operator_platform_autoposter_commands
       WHERE child_mission_id IS NOT NULL
    `).all() as unknown as Array<{ child_mission_id: string }>;
    return new Set(rows.map((row) => row.child_mission_id));
  }

  private parseCommand(
    input: Record<string, unknown>,
    durableRequestedAt?: string,
  ): PlatformAutoPosterCommand {
    if (input.schemaVersion !== PLATFORM_AUTOPOSTER_COMMAND_SCHEMA_VERSION) {
      throw new OperatorError(
        `schemaVersion must be ${PLATFORM_AUTOPOSTER_COMMAND_SCHEMA_VERSION}.`,
        400,
        "PLATFORM_COMMAND_SCHEMA_INVALID",
      );
    }
    const tenantId = exactIdentifier(input.tenantId, "tenantId");
    const actorId = exactIdentifier(input.actorId, "actorId");
    const intakeKey = exactIdentifier(input.intakeKey, "intakeKey");
    const commandId = exactIdentifier(input.commandId, "commandId");

    const mediaInput = jsonObject(input.media);
    if (!mediaInput) {
      throw new OperatorError("media must be a typed object.", 400, "PLATFORM_COMMAND_MEDIA_INVALID");
    }
    let media: PlatformCanonicalMedia;
    if (mediaInput.kind === "public_url") {
      exactKeys(mediaInput, ["kind", "url", "mediaType"], "media");
      if (mediaInput.mediaType !== "video") {
        throw new OperatorError(
          "Public media must have mediaType video.",
          400,
          "PLATFORM_COMMAND_MEDIA_INVALID",
        );
      }
      media = {
        kind: "public_url",
        url: exactString(mediaInput.url, "media.url", 2_048),
        mediaType: "video",
      };
    } else if (mediaInput.kind === "autoposter_staged_upload") {
      exactKeys(
        mediaInput,
        ["kind", "reference", "fileName", "mimeType", "byteSize", "sha256"],
        "media",
      );
      const reference = exactOpaqueString(mediaInput.reference, "media.reference", 2_048);
      const fileName = exactString(mediaInput.fileName, "media.fileName", 255);
      const mimeType = exactString(mediaInput.mimeType, "media.mimeType", 64);
      const extension = Object.entries(VIDEO_MIME_BY_EXTENSION)
        .find(([candidate, expectedMimeType]) =>
          fileName.toLowerCase().endsWith(candidate) && mimeType === expectedMimeType)?.[0];
      if (
        !extension
        || /[<>:"/\\|?*]/.test(fileName)
        || !Number.isSafeInteger(mediaInput.byteSize)
        || Number(mediaInput.byteSize) <= 0
        || typeof mediaInput.sha256 !== "string"
        || !/^[0-9a-f]{64}$/.test(mediaInput.sha256)
      ) {
        throw new OperatorError(
          "Staged media must preserve one exact signed reference and supported video identity with lowercase SHA-256.",
          400,
          "PLATFORM_COMMAND_MEDIA_INVALID",
        );
      }
      const referencePayload = stagedReferencePayload(reference);
      if (
        referencePayload.commandId !== commandId
        || referencePayload.fileName !== fileName
        || referencePayload.mimeType !== mimeType
        || referencePayload.byteSize !== Number(mediaInput.byteSize)
        || referencePayload.sha256 !== mediaInput.sha256
        || referencePayload.extension !== extension
      ) {
        throw new OperatorError(
          "The signed staged-media payload must match the canonical command and duplicated media identity exactly.",
          409,
          "PLATFORM_COMMAND_MEDIA_BINDING_MISMATCH",
        );
      }
      media = {
        kind: "autoposter_staged_upload",
        reference,
        fileName,
        mimeType,
        byteSize: Number(mediaInput.byteSize),
        sha256: mediaInput.sha256,
      };
    } else {
      throw new OperatorError(
        "media.kind is not registered.",
        400,
        "PLATFORM_COMMAND_MEDIA_INVALID",
      );
    }

    if (!Array.isArray(input.destinations) || input.destinations.length !== 1) {
      throw new OperatorError(
        "destinations must contain exactly one AutoPoster destination.",
        400,
        "PLATFORM_COMMAND_DESTINATIONS_INVALID",
      );
    }
    const destinationInput = jsonObject(input.destinations[0]);
    if (!destinationInput) {
      throw new OperatorError(
        "destinations[0] must be an object.",
        400,
        "PLATFORM_COMMAND_DESTINATIONS_INVALID",
      );
    }
    exactKeys(destinationInput, ["provider", "accountId", "soundMode"], "destinations[0]");
    if (destinationInput.provider !== "tiktok" && destinationInput.provider !== "youtube") {
      throw new OperatorError(
        "destinations[0].provider must be tiktok or youtube.",
        400,
        "PLATFORM_COMMAND_DESTINATIONS_INVALID",
      );
    }
    if (
      destinationInput.soundMode !== "keep_original"
      && destinationInput.soundMode !== "mute"
      && destinationInput.soundMode !== "tiktok_recommended"
    ) {
      throw new OperatorError(
        "destinations[0].soundMode is not registered.",
        400,
        "PLATFORM_COMMAND_DESTINATIONS_INVALID",
      );
    }
    const destination: PlatformAutoPosterCommand["destinations"][0] = {
      provider: destinationInput.provider,
      accountId: exactOpaqueString(
        destinationInput.accountId,
        "destinations[0].accountId",
        256,
      ),
      soundMode: destinationInput.soundMode,
    };

    const copyInput = jsonObject(input.copy);
    if (!copyInput) {
      throw new OperatorError("copy must be an object.", 400, "PLATFORM_COMMAND_COPY_INVALID");
    }
    exactKeys(copyInput, ["caption", "hashtags", "youtube"], "copy");
    const youtubeInput = jsonObject(copyInput.youtube);
    if (!youtubeInput) {
      throw new OperatorError(
        "copy.youtube must be an object.",
        400,
        "PLATFORM_COMMAND_COPY_INVALID",
      );
    }
    exactKeys(youtubeInput, ["title", "description"], "copy.youtube");
    const copy = {
      caption: exactString(copyInput.caption, "copy.caption", 2_200, true),
      hashtags: exactString(copyInput.hashtags, "copy.hashtags", 1_000, true),
      youtube: {
        title: exactString(
          youtubeInput.title,
          "copy.youtube.title",
          100,
          destination.provider !== "youtube",
        ),
        description: exactString(
          youtubeInput.description,
          "copy.youtube.description",
          5_000,
          true,
        ),
      },
    };

    const scheduleInput = jsonObject(input.schedule);
    if (!scheduleInput) {
      throw new OperatorError(
        "schedule must be an object.",
        400,
        "PLATFORM_COMMAND_SCHEDULE_INVALID",
      );
    }
    exactKeys(
      scheduleInput,
      ["mode", "scheduledAt", "timezoneName", "timezoneOffsetMinutes"],
      "schedule",
    );
    if (scheduleInput.mode !== "explicit") {
      throw new OperatorError(
        "schedule.mode must be explicit.",
        400,
        "PLATFORM_COMMAND_SCHEDULE_INVALID",
      );
    }
    const scheduledAt = exactString(scheduleInput.scheduledAt, "schedule.scheduledAt", 64);
    const timezoneName = exactString(scheduleInput.timezoneName, "schedule.timezoneName", 100);
    if (
      !ISO_WITH_ZONE_PATTERN.test(scheduledAt)
      || Number.isNaN(Date.parse(scheduledAt))
      || !Number.isSafeInteger(scheduleInput.timezoneOffsetMinutes)
      || Number(scheduleInput.timezoneOffsetMinutes) < -840
      || Number(scheduleInput.timezoneOffsetMinutes) > 840
    ) {
      throw new OperatorError(
        "schedule must contain a valid zoned timestamp and bounded integer offset.",
        400,
        "PLATFORM_COMMAND_SCHEDULE_INVALID",
      );
    }
    const timezoneOffsetMinutes = Number(scheduleInput.timezoneOffsetMinutes);
    const scheduledDate = new Date(scheduledAt);
    if (
      offsetFromIso(scheduledAt) !== -timezoneOffsetMinutes
      || timezoneOffsetAt(scheduledDate, timezoneName) !== -timezoneOffsetMinutes
    ) {
      throw new OperatorError(
        "schedule timezoneName, timestamp offset, and timezoneOffsetMinutes do not describe the same instant.",
        400,
        "PLATFORM_COMMAND_SCHEDULE_TIMEZONE_MISMATCH",
      );
    }

    const approvalInput = jsonObject(input.approvalPolicy);
    if (!approvalInput) {
      throw new OperatorError(
        "approvalPolicy must be an object.",
        400,
        "PLATFORM_COMMAND_APPROVAL_POLICY_INVALID",
      );
    }
    exactKeys(approvalInput, ["draftExecution", "publication"], "approvalPolicy");
    if (
      approvalInput.draftExecution !== "operator_control_required"
      || approvalInput.publication !== "human_required"
    ) {
      throw new OperatorError(
        "approvalPolicy must preserve Operator draft control and human publication approval.",
        400,
        "PLATFORM_COMMAND_APPROVAL_POLICY_INVALID",
      );
    }

    const suppliedRequestedAt = exactString(input.requestedAt, "requestedAt", 64);
    if (
      !ISO_WITH_ZONE_PATTERN.test(suppliedRequestedAt)
      || Number.isNaN(Date.parse(suppliedRequestedAt))
    ) {
      throw new OperatorError(
        "requestedAt must be a valid ISO-8601 timestamp with an explicit timezone.",
        400,
        "PLATFORM_COMMAND_REQUESTED_AT_INVALID",
      );
    }
    if (
      durableRequestedAt !== undefined
      && suppliedRequestedAt !== durableRequestedAt
    ) {
      throw new OperatorError(
        "The command or intake identity is already bound to a different canonical payload.",
        409,
        "PLATFORM_COMMAND_PAYLOAD_MISMATCH",
      );
    }
    const requestedAt = durableRequestedAt ?? suppliedRequestedAt;
    if (
      scheduledDate.getTime() <= Date.parse(requestedAt)
      || (durableRequestedAt === undefined && scheduledDate.getTime() <= this.now().getTime())
    ) {
      throw new OperatorError(
        "schedule.scheduledAt must be later than requestedAt and current time.",
        400,
        "PLATFORM_COMMAND_SCHEDULE_NOT_FUTURE",
      );
    }

    const mediaUrl = media.kind === "public_url"
      ? media.url
      : media.reference;
    const scheduleValidation = validateAutoPosterScheduleInput({
      accountId: destination.accountId,
      provider: destination.provider,
      mediaUrl,
      caption: copy.caption,
      hashtags: copy.hashtags,
      ...(destination.provider === "youtube" ? {
        title: copy.youtube.title,
        description: copy.youtube.description,
      } : {}),
      soundMode: destination.soundMode,
      scheduledAt,
    }, { mustBeAfter: requestedAt });
    if (!scheduleValidation.ok) {
      throw new OperatorError(
        scheduleValidation.error.message,
        scheduleValidation.error.status,
        scheduleValidation.error.code,
      );
    }

    return {
      schemaVersion: PLATFORM_AUTOPOSTER_COMMAND_SCHEMA_VERSION,
      commandId,
      tenantId,
      actorId,
      intakeKey,
      media,
      destinations: [destination],
      copy,
      schedule: {
        mode: "explicit",
        scheduledAt,
        timezoneName,
        timezoneOffsetMinutes,
      },
      approvalPolicy: {
        draftExecution: "operator_control_required",
        publication: "human_required",
      },
      requestedAt,
    };
  }

  private async submitPersistedCommand(
    command: PlatformAutoPosterCommand,
    existing: CommandRow,
    replayed: boolean,
  ): Promise<PlatformAutoPosterCommandView> {
    if (replayed && existing.graph_id) {
      return this.mapRow(existing, true);
    }
    try {
      const destination = command.destinations[0];
      const accountValidation = await this.executor.validateConnectedAccount({
        workspaceId: command.tenantId,
        accountId: destination.accountId,
        provider: destination.provider,
      });
      if (!accountValidation.ok) {
        throw new OperatorError(
          accountValidation.message,
          accountValidation.code === "unavailable" ? 503 : 409,
          accountValidation.reasonCode
            ?? accountValidation.details?.reasonCode
            ?? `autoposter_${accountValidation.code}`,
        );
      }
      if (
        accountValidation.workspaceId !== command.tenantId
        || accountValidation.account.accountId !== destination.accountId
        || accountValidation.account.provider !== destination.provider
        || accountValidation.account.connectionStatus !== "connected"
        || accountValidation.account.publishingReady !== true
      ) {
        throw new OperatorError(
          "AutoPoster did not confirm the exact tenant-bound publishing-ready account.",
          409,
          "autoposter_account_validation_invalid",
        );
      }

      const mediaUrl = command.media.kind === "public_url"
        ? command.media.url
        : command.media.reference;
      const scheduleValidation = validateAutoPosterScheduleInput({
        accountId: destination.accountId,
        provider: destination.provider,
        mediaUrl,
        caption: command.copy.caption,
        hashtags: command.copy.hashtags,
        ...(destination.provider === "youtube" ? {
          title: command.copy.youtube.title,
          description: command.copy.youtube.description,
        } : {}),
        soundMode: destination.soundMode,
        scheduledAt: command.schedule.scheduledAt,
      }, { mustBeAfter: command.requestedAt });
      if (!scheduleValidation.ok) {
        throw new OperatorError(
          scheduleValidation.error.message,
          scheduleValidation.error.status,
          scheduleValidation.error.code,
        );
      }

      const graphId = graphIdFor(command.commandId);
      const traceId = traceIdFor(command.commandId);
      const graph = this.missionGraphService.submitGraph({
        schemaVersion: "chanter.mission.graph.v1",
        graphId,
        traceId,
        idempotencyKey: graphIdempotencyKeyFor(command.commandId),
        source: { system: "platform", requestedBy: command.actorId },
        objective: "Create one governed AutoPoster work item accepted through the Platform composer.",
        tenant: {
          userId: this.executor.tenantUserId,
          workspaceId: command.tenantId,
          accountId: destination.accountId,
        },
        nodes: [{
          nodeId: GRAPH_NODE_ID,
          target: { product: "auto_poster", action: "autoposter.post.schedule" },
          objective: "Create one unapproved AutoPoster queue draft; publication remains human-gated.",
          input: autoPosterSchedulePayloadJson(scheduleValidation.value),
          dependsOn: [],
        }],
        requestedAt: command.requestedAt,
      });
      const childMissionId = missionGraphChildMissionId(graph.graphId, GRAPH_NODE_ID);
      const timestamp = this.now().toISOString();
      this.database.prepare(`
        UPDATE operator_platform_autoposter_commands
           SET graph_id = ?,
               graph_hash = ?,
               child_mission_id = ?,
               trace_id = ?,
               lifecycle_state = CASE
                 WHEN lifecycle_state = 'completed' THEN lifecycle_state
                 ELSE 'approval_required'
               END,
               product_state = CASE
                 WHEN lifecycle_state = 'completed' THEN product_state
                 ELSE 'not_started'
               END,
               error_code = NULL,
               error_message = NULL,
               updated_at = ?
         WHERE command_id = ?
      `).run(
        graph.graphId,
        graph.graphHash,
        childMissionId,
        graph.traceId,
        timestamp,
        command.commandId,
      );
      return this.mapRow(this.requireRow(command.commandId), replayed || graph.replayed);
    } catch (error) {
      this.persistFailure(existing.command_id, error, false);
      throw error;
    }
  }

  private async completeLinkage(
    row: CommandRow,
    graph: MissionGraphView,
  ): Promise<PlatformAutoPosterCommandView> {
    const node = graph.nodes[0];
    if (
      graph.nodes.length !== 1
      || !node
      || node.childMissionId !== row.child_mission_id
      || !this.runtimeMissionService.hasMission(node.childMissionId)
    ) {
      throw new OperatorError(
        "The completed graph does not have the exact canonical child mission.",
        409,
        "PLATFORM_LINKAGE_CHILD_INVALID",
      );
    }
    const mission = this.runtimeMissionService.getMission(node.childMissionId);
    const output = jsonObject(mission.runtimeResult?.output);
    const post = jsonObject(output?.post);
    const downstream = jsonObject(node.childMission?.downstreamIds);
    if (
      !mission.execution
      || mission.execution.state !== "completed"
      || !post
      || !downstream
    ) {
      throw new OperatorError(
        "The completed graph has no authoritative Runtime/AutoPoster linkage.",
        409,
        "PLATFORM_LINKAGE_RESULT_INVALID",
      );
    }

    const queueId = stableDownstreamId(post.id, "jobId");
    const campaignId = stableDownstreamId(post.campaignId, "campaignId");
    const approvalId = stableDownstreamId(post.approvalId, "approvalId");
    const evidenceBundleId = stableDownstreamId(post.evidenceBundleId, "evidenceBundleId");
    const expectedApprovalId = `autoposter-approval:${mission.missionId}`;
    const expectedEvidenceBundleId = `autoposter-evidence:${graph.graphId}`;
    if (
      approvalId !== expectedApprovalId
      || evidenceBundleId !== expectedEvidenceBundleId
      || downstream.queueDraftId !== queueId
      || downstream.campaignId !== campaignId
      || downstream.approvalId !== approvalId
      || downstream.evidenceBundleId !== evidenceBundleId
      || JSON.stringify(downstream.jobIds) !== JSON.stringify([queueId])
      || post.approved !== false
      || output?.publishing !== "blocked_until_human_approval"
    ) {
      throw new OperatorError(
        "AutoPoster linkage identities or approval state do not match the canonical command.",
        409,
        "PLATFORM_LINKAGE_RESULT_MISMATCH",
      );
    }

    const timestamp = this.now().toISOString();
    this.database.prepare(`
      UPDATE operator_platform_autoposter_commands
         SET runtime_execution_id = ?,
             campaign_id = ?,
             job_ids_json = ?,
             approval_id = ?,
             evidence_bundle_id = ?,
             lifecycle_state = 'completed',
             product_state = 'draft_created',
             draft_execution_approval_state = 'approved',
             publication_approval_state = 'human_required',
             error_code = NULL,
             error_message = NULL,
             executed_at = COALESCE(executed_at, ?),
             updated_at = ?
       WHERE command_id = ?
    `).run(
      mission.execution.executionAttemptId,
      campaignId,
      JSON.stringify([queueId]),
      approvalId,
      evidenceBundleId,
      timestamp,
      timestamp,
      row.command_id,
    );

    try {
      const evidence = await this.evidenceService.generateEvidenceBundle(graph.graphId);
      const evidenceTimestamp = this.now().toISOString();
      this.database.prepare(`
        UPDATE operator_platform_autoposter_commands
           SET evidence_manifest_path = ?,
               evidence_available = 1,
               error_code = NULL,
               error_message = NULL,
               updated_at = ?
         WHERE command_id = ?
      `).run(evidence.path, evidenceTimestamp, row.command_id);
    } catch (error) {
      if (error instanceof OperatorError) throw error;
      const evidenceTimestamp = this.now().toISOString();
      this.database.prepare(`
        UPDATE operator_platform_autoposter_commands
           SET error_code = 'PLATFORM_EVIDENCE_UNAVAILABLE',
               error_message = 'The AutoPoster draft exists, but its retained evidence manifest could not be refreshed safely.',
               updated_at = ?
         WHERE command_id = ?
      `).run(evidenceTimestamp, row.command_id);
    }
    return this.mapRow(this.requireRow(row.command_id));
  }

  private findExisting(
    commandId: string,
    tenantId: string,
    actorId: string,
    intakeKey: string,
  ): CommandRow | null {
    const byCommand = this.rowByCommandId(commandId);
    const byIntake = this.database.prepare(`
      SELECT *
        FROM operator_platform_autoposter_commands
       WHERE tenant_id = ? AND actor_id = ? AND intake_key = ?
    `).get(tenantId, actorId, intakeKey) as CommandRow | undefined;
    if (byCommand && byIntake && byCommand.command_id !== byIntake.command_id) {
      throw new OperatorError(
        "The command and tenant-bound intake identities resolve to different records.",
        409,
        "PLATFORM_COMMAND_IDENTITY_MISMATCH",
      );
    }
    const existing = byCommand ?? byIntake ?? null;
    if (
      existing
      && (
        existing.command_id !== commandId
        || existing.tenant_id !== tenantId
        || existing.actor_id !== actorId
        || existing.intake_key !== intakeKey
      )
    ) {
      throw new OperatorError(
        "The command identity is already bound to another tenant, actor, or intake key.",
        409,
        "PLATFORM_COMMAND_IDENTITY_MISMATCH",
      );
    }
    return existing;
  }

  private rowByCommandId(commandId: string): CommandRow | null {
    return (this.database.prepare(`
      SELECT * FROM operator_platform_autoposter_commands WHERE command_id = ?
    `).get(commandId) as CommandRow | undefined) ?? null;
  }

  private requireRow(commandId: string): CommandRow {
    const row = this.rowByCommandId(commandId);
    if (!row) {
      throw new OperatorError(
        "Platform AutoPoster command was not found.",
        404,
        "PLATFORM_COMMAND_NOT_FOUND",
      );
    }
    return row;
  }

  private assertExistingIntegrity(
    row: CommandRow,
    canonicalJson: string,
    commandHash: string,
  ): void {
    this.assertRowIntegrity(row);
    if (row.canonical_json !== canonicalJson || row.command_hash !== commandHash) {
      throw new OperatorError(
        "The command or intake identity is already bound to a different canonical payload.",
        409,
        "PLATFORM_COMMAND_PAYLOAD_MISMATCH",
      );
    }
  }

  private assertRowIntegrity(row: CommandRow): void {
    if (
      row.schema_version !== PLATFORM_AUTOPOSTER_COMMAND_SCHEMA_VERSION
      || sha256(row.canonical_json) !== row.command_hash
    ) {
      throw new OperatorError(
        "The durable Platform command no longer matches its immutable hash.",
        409,
        "PLATFORM_COMMAND_INTEGRITY_VIOLATION",
      );
    }
    const canonical = JSON.parse(row.canonical_json) as PlatformAutoPosterCommand;
    if (
      canonical.commandId !== row.command_id
      || canonical.tenantId !== row.tenant_id
      || canonical.actorId !== row.actor_id
      || canonical.intakeKey !== row.intake_key
      || canonical.requestedAt !== row.requested_at
      || derivePlatformAutoPosterCommandId(
        row.tenant_id,
        row.actor_id,
        row.intake_key,
      ) !== row.command_id
    ) {
      throw new OperatorError(
        "The durable Platform command identity binding is inconsistent.",
        409,
        "PLATFORM_COMMAND_INTEGRITY_VIOLATION",
      );
    }
  }

  private persistFailure(
    commandId: string,
    error: unknown,
    draftExecutionApproved: boolean,
  ): void {
    const detail = errorDetails(error);
    const timestamp = this.now().toISOString();
    this.database.prepare(`
      UPDATE operator_platform_autoposter_commands
         SET lifecycle_state = 'failed',
             product_state = 'failed',
             draft_execution_approval_state = ?,
             error_code = ?,
             error_message = ?,
             updated_at = ?
       WHERE command_id = ?
    `).run(
      draftExecutionApproved ? "approved" : "required",
      detail.code,
      detail.message,
      timestamp,
      commandId,
    );
  }

  private persistExecutionFailure(commandId: string, error: unknown): void {
    const row = this.requireRow(commandId);
    let graphStatus: string | null = null;
    if (row.graph_id) {
      try {
        graphStatus = this.missionGraphService.getGraph(row.graph_id).status;
      } catch {
        graphStatus = null;
      }
    }
    if (
      graphStatus !== "approved"
      && graphStatus !== "running"
      && graphStatus !== "failed_recoverable"
    ) {
      this.persistFailure(commandId, error, true);
      return;
    }

    const detail = errorDetails(error);
    const timestamp = this.now().toISOString();
    this.database.prepare(`
      UPDATE operator_platform_autoposter_commands
         SET lifecycle_state = 'failed_recoverable',
             product_state = CASE
               WHEN product_state = 'draft_created' THEN product_state
               ELSE 'recovery_required'
             END,
             draft_execution_approval_state = 'approved',
             error_code = ?,
             error_message = ?,
             updated_at = ?
       WHERE command_id = ?
    `).run(detail.code, detail.message, timestamp, commandId);
  }

  private mapRow(row: CommandRow, replayed = false): PlatformAutoPosterCommandView {
    let jobIds: string[];
    try {
      const parsed = JSON.parse(row.job_ids_json) as unknown;
      if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
        throw new Error("invalid job ids");
      }
      jobIds = parsed;
    } catch {
      throw new OperatorError(
        "The durable Platform job linkage is invalid.",
        409,
        "PLATFORM_COMMAND_INTEGRITY_VIOLATION",
      );
    }
    return {
      replayed,
      commandId: row.command_id,
      schemaVersion: row.schema_version,
      tenantId: row.tenant_id,
      actorId: row.actor_id,
      intakeKey: row.intake_key,
      commandHash: row.command_hash,
      graphId: row.graph_id,
      graphHash: row.graph_hash,
      missionId: row.child_mission_id,
      runtimeExecutionId: row.runtime_execution_id,
      campaignId: row.campaign_id,
      jobIds,
      approvalId: row.approval_id,
      evidenceBundleId: row.evidence_bundle_id,
      evidenceAvailable: row.evidence_available === 1,
      evidenceReference: row.evidence_manifest_path
        ? path.basename(row.evidence_manifest_path)
        : null,
      traceId: row.trace_id,
      lifecycleState: row.lifecycle_state,
      productState: row.product_state,
      draftExecutionApprovalState: row.draft_execution_approval_state,
      publicationApprovalState: row.publication_approval_state,
      error: row.error_code && row.error_message
        ? { code: row.error_code, message: row.error_message }
        : null,
      requestedAt: row.requested_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      executedAt: row.executed_at,
    };
  }
}
