// CHANTER Operator — AutoPoster connected-health projection.
//
// Cheap, read-only projection of AutoPoster's GET /api/runtime/connected-health
// into a founder-facing truth label with freshness. This closes the honest gap
// left by Operator Ascension II: Operator can now display a *verified* Firestore
// mode instead of deferring it to the evidence bundle.
//
// Self-contained: one bounded request, the same runtime service token used for
// connected-accounts, a strict field allowlist (never echo unknown fields, never
// surface the token), and an explicit unreachable/unconfigured/stale state.

export interface AutoPosterConnectedHealthConfig {
  baseUrl: string;
  serviceToken: string;
  timeoutMs?: number;
  timeoutValid: boolean;
}

export type StorageMode = "emulator" | "real" | "unavailable" | "unknown";

export interface ConnectedHealthProjection {
  /** Runtime service token + safe base URL are present. */
  configured: boolean;
  /** A well-formed connected-health response was received. */
  autoPosterReachable: boolean;
  /** Verified Firestore mode, or null when unreachable/unconfigured. */
  storageMode: StorageMode | null;
  storageReachable: boolean | null;
  /** Autonomous external publishing is disabled at the runtime boundary. */
  publishingBlocked: boolean;
  runtimeConfigured: boolean;
  /** AutoPoster's own observation timestamp. */
  observedAt: string | null;
  /** When Operator fetched it. */
  fetchedAt: string;
  ageMs: number | null;
  stale: boolean;
  staleThresholdMs: number;
  /** Primary founder-facing label. */
  primaryLabel:
    | "unconfigured"
    | "unreachable"
    | "health_stale"
    | "firestore_emulator"
    | "firestore_real"
    | "firestore_unavailable"
    | "health_unknown";
  /** Redacted reason when unreachable. */
  error?: string;
}

export interface AutoPosterConnectedHealthService {
  readonly configured: boolean;
  getConnectedHealth(): Promise<ConnectedHealthProjection>;
}

interface Deps {
  fetch?: typeof fetch;
  now?: () => number;
  staleThresholdMs?: number;
}

const DEFAULT_STALE_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 3_000;

function isSafeBaseUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

function coerceMode(value: unknown): StorageMode | null {
  return value === "emulator" || value === "real" || value === "unavailable" || value === "unknown"
    ? value
    : null;
}

function base(configured: boolean, staleThresholdMs: number, fetchedAt: string): ConnectedHealthProjection {
  return {
    configured,
    autoPosterReachable: false,
    storageMode: null,
    storageReachable: null,
    publishingBlocked: true,
    runtimeConfigured: false,
    observedAt: null,
    fetchedAt,
    ageMs: null,
    stale: false,
    staleThresholdMs,
    primaryLabel: configured ? "unreachable" : "unconfigured",
  };
}

export function createAutoPosterConnectedHealthService(
  configuration: AutoPosterConnectedHealthConfig,
  deps: Deps = {},
): AutoPosterConnectedHealthService {
  const baseUrl = configuration.baseUrl.trim();
  const serviceToken = configuration.serviceToken.trim();
  const configured = Boolean(baseUrl && serviceToken && configuration.timeoutValid && isSafeBaseUrl(baseUrl));
  const timeoutMs =
    configuration.timeoutMs && configuration.timeoutValid ? configuration.timeoutMs : DEFAULT_TIMEOUT_MS;
  const staleThresholdMs = deps.staleThresholdMs ?? DEFAULT_STALE_MS;
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;

  async function getConnectedHealth(): Promise<ConnectedHealthProjection> {
    const fetchedAt = new Date(now()).toISOString();
    if (!configured) {
      return base(false, staleThresholdMs, fetchedAt);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let body: Record<string, unknown>;
    try {
      const response = await doFetch(`${baseUrl.replace(/\/$/, "")}/api/runtime/connected-health`, {
        method: "GET",
        headers: { "x-chanter-runtime-token": serviceToken },
        signal: controller.signal,
      });
      if (!response.ok) {
        const projection = base(true, staleThresholdMs, fetchedAt);
        projection.error = `http_${response.status}`;
        return projection;
      }
      body = (await response.json()) as Record<string, unknown>;
    } catch (error) {
      const projection = base(true, staleThresholdMs, fetchedAt);
      // Redact: never surface the token or a raw stack — just a bounded reason.
      projection.error = error instanceof Error && error.name === "AbortError" ? "timeout" : "unreachable";
      return projection;
    } finally {
      clearTimeout(timer);
    }

    const storage = (body.storage ?? {}) as Record<string, unknown>;
    const publishing = (body.publishing ?? {}) as Record<string, unknown>;
    const runtime = (body.runtime ?? {}) as Record<string, unknown>;
    const storageMode = coerceMode(storage.mode);
    const observedAt = typeof body.observedAt === "string" ? body.observedAt : null;
    const observedMs = observedAt ? Date.parse(observedAt) : NaN;
    const ageMs = Number.isFinite(observedMs) ? now() - observedMs : null;
    const stale = ageMs !== null && ageMs > staleThresholdMs;

    let primaryLabel: ConnectedHealthProjection["primaryLabel"];
    if (stale) {
      primaryLabel = "health_stale";
    } else if (storageMode === "emulator") {
      primaryLabel = "firestore_emulator";
    } else if (storageMode === "real") {
      primaryLabel = storage.reachable === true ? "firestore_real" : "firestore_unavailable";
    } else if (storageMode === "unavailable") {
      primaryLabel = "firestore_unavailable";
    } else {
      primaryLabel = "health_unknown";
    }

    return {
      configured: true,
      autoPosterReachable: true,
      storageMode,
      storageReachable: typeof storage.reachable === "boolean" ? storage.reachable : null,
      publishingBlocked: publishing.enabled !== true,
      runtimeConfigured: runtime.configured === true,
      observedAt,
      fetchedAt,
      ageMs,
      stale,
      staleThresholdMs,
      primaryLabel,
    };
  }

  return { configured, getConnectedHealth };
}
