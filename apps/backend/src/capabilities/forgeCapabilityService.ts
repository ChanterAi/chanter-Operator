// CHANTER Operator — SDK Forge Capability Workspace projection (§14).
//
// Read-only projection of the SDK Forge capability registry into a founder-
// facing list/detail. Reads the Forge HTTP runtime (env-configured base URL +
// optional SDK token), same pattern as the AutoPoster connected-health
// projection. Degrades to an explicit unconfigured/unreachable state; never
// throws, never surfaces the token, never becomes registry authority.

export interface ForgeConfig {
  baseUrl: string;
  token: string;
}

export interface CapabilitySummary {
  capabilityId: string;
  version: string;
  category: string;
  riskClass: string;
  status: string;
  health: { healthy: boolean; success: number; failure: number; lastSuccessAt: string | null } | null;
}

export interface CapabilityWorkspaceProjection {
  configured: boolean;
  reachable: boolean;
  count: number;
  capabilities: CapabilitySummary[];
  fetchedAt: string;
  error?: string;
}

interface Deps { fetch?: typeof fetch; now?: () => number; }

function isSafeBaseUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password && !u.search && !u.hash;
  } catch {
    return false;
  }
}

export interface ForgeCapabilityService {
  readonly configured: boolean;
  listCapabilities(): Promise<CapabilityWorkspaceProjection>;
  describeCapability(capabilityId: string, version?: string): Promise<unknown>;
}

export function createForgeCapabilityService(config: ForgeConfig, deps: Deps = {}): ForgeCapabilityService {
  const baseUrl = (config.baseUrl || '').trim().replace(/\/$/, '');
  const token = (config.token || '').trim();
  const configured = Boolean(baseUrl && isSafeBaseUrl(baseUrl));
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;

  function headers(): Record<string, string> {
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  async function listCapabilities(): Promise<CapabilityWorkspaceProjection> {
    const fetchedAt = new Date(now()).toISOString();
    const base: CapabilityWorkspaceProjection = { configured, reachable: false, count: 0, capabilities: [], fetchedAt };
    if (!configured) return base;
    try {
      const res = await doFetch(`${baseUrl}/capabilities`, { headers: headers() });
      if (!res.ok) return { ...base, error: `http_${res.status}` };
      const body = (await res.json()) as { capabilities?: unknown };
      const raw = Array.isArray(body.capabilities) ? body.capabilities : [];
      const capabilities: CapabilitySummary[] = raw.map((c: Record<string, unknown>) => ({
        capabilityId: String(c.capabilityId ?? ''),
        version: String(c.version ?? ''),
        category: String(c.category ?? ''),
        riskClass: String(c.riskClass ?? ''),
        status: String(c.status ?? ''),
        health: c.health && typeof c.health === 'object'
          ? {
              healthy: Boolean((c.health as Record<string, unknown>).healthy),
              success: Number((c.health as Record<string, unknown>).success ?? 0),
              failure: Number((c.health as Record<string, unknown>).failure ?? 0),
              lastSuccessAt: ((c.health as Record<string, unknown>).lastSuccessAt as string) ?? null,
            }
          : null,
      }));
      return { configured, reachable: true, count: capabilities.length, capabilities, fetchedAt };
    } catch {
      return { ...base, error: 'unreachable' };
    }
  }

  async function describeCapability(capabilityId: string, version?: string): Promise<unknown> {
    if (!configured) return { configured: false };
    const q = version ? `?version=${encodeURIComponent(version)}` : '';
    try {
      const res = await doFetch(`${baseUrl}/capabilities/${encodeURIComponent(capabilityId)}${q}`, { headers: headers() });
      if (!res.ok) return { error: `http_${res.status}` };
      return await res.json();
    } catch {
      return { error: 'unreachable' };
    }
  }

  return { configured, listCapabilities, describeCapability };
}
