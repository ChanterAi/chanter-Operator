import {
  envelopeToRuntimeMissionRequest,
  validateMissionEnvelope,
  type JsonValue,
} from "chanter-agent-runtime";

const ISO_WITH_ZONE_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;
const SENSITIVE_QUERY_KEY_PATTERN =
  /(?:token|secret|password|credential|api[-_]?key|signature)/i;

export const AUTOPOSTER_SCHEDULE_INPUT_FIELDS = Object.freeze([
  "accountId",
  "provider",
  "mediaUrl",
  "caption",
  "hashtags",
  "title",
  "description",
  "scheduledAt",
] as const);

const AUTOPOSTER_SCHEDULE_INPUT_FIELD_SET = new Set<string>(
  AUTOPOSTER_SCHEDULE_INPUT_FIELDS,
);

export interface CanonicalAutoPosterSchedulePayload {
  accountId: string;
  provider: "tiktok" | "youtube";
  mediaUrl: string;
  caption: string;
  hashtags: string;
  title: string;
  description: string;
  scheduledAt: string;
}

export interface AutoPosterScheduleInputError {
  code: string;
  message: string;
  status: number;
  /** Existing direct-create behavior only exposed typed account errors. */
  serviceCode?: string;
}

export type AutoPosterScheduleInputResult =
  | { ok: true; value: CanonicalAutoPosterSchedulePayload }
  | { ok: false; error: AutoPosterScheduleInputError };

export interface AutoPosterScheduleInputOptions {
  /** Graph inputs are strict; the legacy direct-create route remains compatible. */
  rejectUnknownFields?: boolean;
  /** Direct-create historically accepted provider case and normalized it. */
  normalizeProviderCase?: boolean;
  /** Deterministic graph validation compares the schedule to requestedAt. */
  mustBeAfter?: string | Date;
}

export interface AutoPosterScheduleMissionInput
  extends CanonicalAutoPosterSchedulePayload {
  missionId: string;
  traceId: string;
  idempotencyKey: string | null;
  requestedBy: string;
  tenantUserId: string;
  workspaceId: string | null;
  product: "auto_poster";
  action: "autoposter.post.schedule";
}

export type AutoPosterScheduleEnvelopeResult =
  | { ok: true; value: AutoPosterScheduleMissionInput }
  | { ok: false; error: AutoPosterScheduleInputError };

function failure(
  code: string,
  message: string,
  status = 400,
  serviceCode?: string,
): AutoPosterScheduleInputResult {
  return { ok: false, error: { code, message, status, serviceCode } };
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(
  input: Record<string, unknown>,
  field: string,
  maxLength: number,
  allowBlank = false,
): { ok: true; value: string } | { ok: false; result: AutoPosterScheduleInputResult } {
  const value = input[field];
  if (typeof value !== "string") {
    return {
      ok: false,
      result: failure(
        `AUTOPOSTER_${field.toUpperCase()}_INVALID`,
        `${field} must be a string.`,
      ),
    };
  }
  const normalized = value.trim();
  if (!allowBlank && !normalized) {
    return {
      ok: false,
      result: failure(
        `AUTOPOSTER_${field.toUpperCase()}_REQUIRED`,
        `${field} is required.`,
      ),
    };
  }
  if (normalized.length > maxLength) {
    return {
      ok: false,
      result: failure(
        `AUTOPOSTER_${field.toUpperCase()}_TOO_LONG`,
        `${field} must be at most ${maxLength} characters.`,
      ),
    };
  }
  return { ok: true, value: normalized };
}

function optionalString(
  input: Record<string, unknown>,
  field: string,
  maxLength: number,
): { ok: true; value: string } | { ok: false; result: AutoPosterScheduleInputResult } {
  const value = input[field];
  if (value === undefined || value === null || value === "") {
    return { ok: true, value: "" };
  }
  if (typeof value !== "string") {
    return {
      ok: false,
      result: failure(
        `AUTOPOSTER_${field.toUpperCase()}_INVALID`,
        `${field} must be a string when provided.`,
      ),
    };
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    return {
      ok: false,
      result: failure(
        `AUTOPOSTER_${field.toUpperCase()}_TOO_LONG`,
        `${field} must be at most ${maxLength} characters.`,
      ),
    };
  }
  return { ok: true, value: normalized };
}

export function validateAutoPosterScheduleInput(
  value: unknown,
  options: AutoPosterScheduleInputOptions = {},
): AutoPosterScheduleInputResult {
  const input = jsonObject(value);
  if (!input) {
    return failure(
      "AUTOPOSTER_SCHEDULE_INPUT_INVALID",
      "AutoPoster schedule input must be an object payload.",
    );
  }

  if (options.rejectUnknownFields !== false) {
    const unsupported = Object.keys(input)
      .filter((key) => !AUTOPOSTER_SCHEDULE_INPUT_FIELD_SET.has(key))
      .sort()[0];
    if (unsupported) {
      return failure(
        "OPERATOR_MISSION_INPUT_UNSUPPORTED_FIELD",
        "The mission input contains a field that is not registered for this action.",
      );
    }
  }

  const accountValue = input.accountId;
  if (typeof accountValue !== "string") {
    return failure(
      "AUTOPOSTER_ACCOUNT_ID_INVALID",
      "accountId must be a string.",
      400,
      "unknown_account_id",
    );
  }
  if (!accountValue) {
    return failure(
      "AUTOPOSTER_ACCOUNT_ID_REQUIRED",
      "accountId is required.",
      400,
      "unknown_account_id",
    );
  }
  if (accountValue.length > 256) {
    return failure(
      "AUTOPOSTER_ACCOUNT_ID_TOO_LONG",
      "accountId must be at most 256 characters.",
      400,
      "account_id_non_canonical",
    );
  }
  if (accountValue !== accountValue.trim() || CONTROL_CHAR_PATTERN.test(accountValue)) {
    return failure(
      "AUTOPOSTER_ACCOUNT_ID_NON_CANONICAL",
      "accountId must match the exact canonical connected-account ID; surrounding whitespace is not normalized.",
      409,
      "account_id_non_canonical",
    );
  }

  const providerString = requiredString(input, "provider", 16);
  if (!providerString.ok) return providerString.result;
  const providerValue = options.normalizeProviderCase
    ? providerString.value.toLowerCase()
    : providerString.value;
  if (providerValue !== "tiktok" && providerValue !== "youtube") {
    return failure(
      "AUTOPOSTER_PROVIDER_INVALID",
      "provider must be either tiktok or youtube.",
    );
  }

  const mediaUrlValue = requiredString(input, "mediaUrl", 2_048);
  if (!mediaUrlValue.ok) return mediaUrlValue.result;
  let parsedMediaUrl: URL;
  try {
    parsedMediaUrl = new URL(mediaUrlValue.value);
  } catch {
    return failure(
      "AUTOPOSTER_MEDIA_URL_INVALID",
      "mediaUrl must be a valid HTTPS URL.",
    );
  }
  if (
    parsedMediaUrl.protocol !== "https:"
    || parsedMediaUrl.username
    || parsedMediaUrl.password
    || parsedMediaUrl.hash
  ) {
    return failure(
      "AUTOPOSTER_MEDIA_URL_INVALID",
      "mediaUrl must be an HTTPS URL without credentials or a fragment.",
    );
  }
  for (const key of parsedMediaUrl.searchParams.keys()) {
    if (SENSITIVE_QUERY_KEY_PATTERN.test(key)) {
      return failure(
        "AUTOPOSTER_MEDIA_URL_SENSITIVE",
        "mediaUrl must not contain credential or signature query parameters.",
      );
    }
  }

  const caption = requiredString(input, "caption", 2_200, true);
  if (!caption.ok) return caption.result;
  const hashtags = requiredString(input, "hashtags", 1_000, true);
  if (!hashtags.ok) return hashtags.result;
  const title = optionalString(input, "title", 100);
  if (!title.ok) return title.result;
  const description = optionalString(input, "description", 5_000);
  if (!description.ok) return description.result;
  if (providerValue === "youtube" && !title.value) {
    return failure(
      "AUTOPOSTER_YOUTUBE_TITLE_REQUIRED",
      "title is required when provider is youtube.",
    );
  }
  if (providerValue === "tiktok" && (title.value || description.value)) {
    return failure(
      "AUTOPOSTER_PROVIDER_METADATA_INVALID",
      "title and description are only valid for youtube missions.",
    );
  }

  const scheduledAt = requiredString(input, "scheduledAt", 64);
  if (!scheduledAt.ok) return scheduledAt.result;
  if (
    !ISO_WITH_ZONE_PATTERN.test(scheduledAt.value)
    || Number.isNaN(Date.parse(scheduledAt.value))
  ) {
    return failure(
      "AUTOPOSTER_SCHEDULED_AT_INVALID",
      "scheduledAt must be a valid ISO-8601 timestamp with an explicit timezone.",
    );
  }
  const normalizedScheduledAt = new Date(scheduledAt.value).toISOString();
  if (options.mustBeAfter !== undefined) {
    const reference = options.mustBeAfter instanceof Date
      ? options.mustBeAfter.getTime()
      : Date.parse(options.mustBeAfter);
    if (!Number.isFinite(reference) || Date.parse(normalizedScheduledAt) <= reference) {
      return failure(
        "AUTOPOSTER_SCHEDULED_AT_NOT_FUTURE",
        "scheduledAt must be later than the graph requestedAt timestamp.",
      );
    }
  }

  return {
    ok: true,
    value: {
      accountId: accountValue,
      provider: providerValue,
      mediaUrl: mediaUrlValue.value,
      caption: caption.value,
      hashtags: hashtags.value,
      title: title.value,
      description: description.value,
      scheduledAt: normalizedScheduledAt,
    },
  };
}

export function autoPosterSchedulePayloadJson(
  value: CanonicalAutoPosterSchedulePayload,
): Record<string, JsonValue> {
  return {
    accountId: value.accountId,
    provider: value.provider,
    mediaUrl: value.mediaUrl,
    caption: value.caption,
    hashtags: value.hashtags,
    ...(value.title ? { title: value.title } : {}),
    ...(value.description ? { description: value.description } : {}),
    scheduledAt: value.scheduledAt,
  };
}

export function autoPosterScheduleInputFromEnvelope(
  envelope: unknown,
  options: { requireWorkspace?: boolean; mustBeAfter?: string | Date } = {},
): AutoPosterScheduleEnvelopeResult {
  const validation = validateMissionEnvelope(envelope);
  if (!validation.ok) {
    const first = validation.errors[0];
    return {
      ok: false,
      error: {
        code: first?.code ?? "OPERATOR_MISSION_ENVELOPE_INVALID",
        message: first?.message ?? "Mission envelope validation failed.",
        status: 400,
      },
    };
  }
  const request = envelopeToRuntimeMissionRequest(validation.value);
  if (
    request.product !== "auto_poster"
    || request.action !== "autoposter.post.schedule"
  ) {
    return {
      ok: false,
      error: {
        code: "OPERATOR_MISSION_TARGET_MISMATCH",
        message: "The mission target is not registered with the Operator gateway.",
        status: 409,
      },
    };
  }
  if (!request.tenant.accountId) {
    return {
      ok: false,
      error: {
        code: "OPERATOR_MISSION_SCOPE_INVALID",
        message: "tenant.accountId is required for an AutoPoster schedule mission.",
        status: 400,
      },
    };
  }
  if (options.requireWorkspace && !request.tenant.workspaceId) {
    return {
      ok: false,
      error: {
        code: "OPERATOR_MISSION_SCOPE_INVALID",
        message: "tenant.workspaceId is required for an AutoPoster graph schedule mission.",
        status: 400,
      },
    };
  }
  if (
    request.input.accountId !== undefined
    && request.input.accountId !== request.tenant.accountId
  ) {
    return {
      ok: false,
      error: {
        code: "OPERATOR_MISSION_SCOPE_MISMATCH",
        message: "The mission input account does not match the exact tenant account scope.",
        status: 409,
      },
    };
  }

  const payload = validateAutoPosterScheduleInput(
    { ...request.input, accountId: request.tenant.accountId },
    { mustBeAfter: options.mustBeAfter },
  );
  if (!payload.ok) return payload;

  return {
    ok: true,
    value: {
      missionId: request.missionId,
      traceId: request.traceId ?? request.missionId,
      idempotencyKey: request.idempotencyKey ?? null,
      requestedBy: request.actor.id,
      tenantUserId: request.tenant.userId,
      workspaceId: request.tenant.workspaceId ?? null,
      product: "auto_poster",
      action: "autoposter.post.schedule",
      ...payload.value,
    },
  };
}
