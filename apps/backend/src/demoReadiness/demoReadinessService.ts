// CHANTER Operator — Platform Readiness demo projection (CHANTER LIVE MISSION
// SHOWCASE I, §8). Read-only projection + thin control proxy over the disposable
// demo presentation server (chanter-sdk-forge/demo). Same pattern as the Forge
// Capability Workspace projection: env-configured base URL, degrades to an
// explicit unconfigured/unreachable state, never throws, never becomes mission
// authority. The demo lane is read-only and holds no secrets, so its control
// actions (start/approve/reject/reset) need no capability token.

export interface DemoReadinessConfig {
  baseUrl: string;
}

export interface DemoReadinessBadges {
  readOnlyMission: boolean;
  realInternetCapability: boolean;
  localAI: boolean;
  humanApprovalRequired: boolean;
  externalWrites: number;
  evidenceRetained: boolean;
}

export interface DemoReadinessAtom {
  atomId: string;
  title: string;
  status: string;
  capability: string | null;
  provenance: string | null;
  durationMs: number | null;
}

export interface DemoReadinessState {
  present: boolean;
  missionId?: string;
  title?: string;
  objective?: string;
  status?: string;
  currentPhase?: { atomId: string; title: string; status: string } | null;
  progress?: { done: number; total: number };
  currentCapability?: string | null;
  localModel?: string | null;
  internetSource?: string | null;
  liveProvenance?: string[];
  approvalState?: string;
  finalResult?: unknown;
  evidenceState?: { retained: boolean; evidenceRef?: string; manifestHash?: string };
  badges?: DemoReadinessBadges;
  brief?: { readiness: string; wordCount: number | null; strongestProof?: unknown } | null;
  claims?: unknown;
  counters?: { providerReads: number; providerWrites: number; modelCalls: number };
  atoms?: DemoReadinessAtom[];
  graphHash?: string;
  updatedAt?: string;
  replayed?: boolean;
}

export interface DemoReadinessResponse {
  configured: boolean;
  reachable: boolean;
  state: DemoReadinessState | null;
  fetchedAt: string;
  error?: string;
}

interface Deps { fetch?: typeof fetch; now?: () => number; }

function isSafeBaseUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password && !u.search && !u.hash;
  } catch {
    return false;
  }
}

export interface DemoReadinessService {
  readonly configured: boolean;
  getState(missionId?: string): Promise<DemoReadinessResponse>;
  start(idempotencyKey?: string): Promise<DemoReadinessResponse>;
  approve(missionId?: string, actor?: string): Promise<DemoReadinessResponse>;
  reject(missionId?: string, actor?: string, reason?: string): Promise<DemoReadinessResponse>;
  reset(): Promise<DemoReadinessResponse>;
  getBrief(missionId?: string): Promise<{ configured: boolean; reachable: boolean; markdown: string | null; error?: string }>;
}

export function createDemoReadinessService(config: DemoReadinessConfig, deps: Deps = {}): DemoReadinessService {
  const baseUrl = (config.baseUrl || "").trim().replace(/\/$/, "");
  const configured = Boolean(baseUrl && isSafeBaseUrl(baseUrl));
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;

  async function call(path: string, init?: RequestInit): Promise<DemoReadinessResponse> {
    const fetchedAt = new Date(now()).toISOString();
    const base: DemoReadinessResponse = { configured, reachable: false, state: null, fetchedAt };
    if (!configured) return base;
    try {
      const res = await doFetch(`${baseUrl}${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers || {}) } });
      if (!res.ok) return { ...base, error: `http_${res.status}` };
      const body = (await res.json()) as DemoReadinessState;
      return { configured, reachable: true, state: body ?? { present: false }, fetchedAt };
    } catch {
      return { ...base, error: "unreachable" };
    }
  }

  return {
    configured,
    getState(missionId?: string) {
      const q = missionId ? `?missionId=${encodeURIComponent(missionId)}` : "";
      return call(`/demo/state${q}`);
    },
    start(idempotencyKey?: string) {
      return call(`/demo/start`, { method: "POST", body: JSON.stringify(idempotencyKey ? { idempotencyKey } : {}) });
    },
    approve(missionId?: string, actor = "founder") {
      return call(`/demo/approve`, { method: "POST", body: JSON.stringify({ missionId, actor }) });
    },
    reject(missionId?: string, actor = "founder", reason?: string) {
      return call(`/demo/reject`, { method: "POST", body: JSON.stringify({ missionId, actor, reason }) });
    },
    async reset() {
      const fetchedAt = new Date(now()).toISOString();
      if (!configured) return { configured, reachable: false, state: null, fetchedAt };
      try {
        const res = await doFetch(`${baseUrl}/demo/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        if (!res.ok) return { configured, reachable: false, state: null, fetchedAt, error: `http_${res.status}` };
        const body = (await res.json()) as { state?: DemoReadinessState };
        return { configured, reachable: true, state: body.state ?? { present: false }, fetchedAt };
      } catch {
        return { configured, reachable: false, state: null, fetchedAt, error: "unreachable" };
      }
    },
    async getBrief(missionId?: string) {
      if (!configured) return { configured, reachable: false, markdown: null };
      const q = missionId ? `?missionId=${encodeURIComponent(missionId)}` : "";
      try {
        const res = await doFetch(`${baseUrl}/demo/brief${q}`);
        if (!res.ok) return { configured, reachable: false, markdown: null, error: `http_${res.status}` };
        const markdown = await res.text();
        return { configured, reachable: true, markdown };
      } catch {
        return { configured, reachable: false, markdown: null, error: "unreachable" };
      }
    },
  };
}
