// CHANTER Operator — AutoPoster connected-health projection tests.
import { describe, expect, it } from "vitest";
import { createAutoPosterConnectedHealthService } from "../src/runtimeMissions/autoPosterConnectedHealthService.js";

const CONFIGURED = {
  baseUrl: "http://127.0.0.1:3000",
  serviceToken: "runtime-token",
  timeoutMs: 2000,
  timeoutValid: true,
};

function fakeFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return async () =>
    ({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => body,
    }) as unknown as Response;
}

const AT = new Date("2026-07-24T00:00:00.000Z").getTime();

describe("AutoPoster connected-health projection", () => {
  it("is unconfigured (never throws) when base URL / token are absent", async () => {
    const svc = createAutoPosterConnectedHealthService({ baseUrl: "", serviceToken: "", timeoutValid: false });
    const p = await svc.getConnectedHealth();
    expect(svc.configured).toBe(false);
    expect(p.configured).toBe(false);
    expect(p.autoPosterReachable).toBe(false);
    expect(p.primaryLabel).toBe("unconfigured");
  });

  it("rejects an unsafe base URL (credentials/query) as unconfigured", async () => {
    const svc = createAutoPosterConnectedHealthService({
      baseUrl: "http://user:pass@host:3000?x=1",
      serviceToken: "t",
      timeoutValid: true,
    });
    expect(svc.configured).toBe(false);
  });

  it("projects verified emulator mode with freshness", async () => {
    const body = {
      ok: true,
      runtime: { configured: true, reachable: true },
      storage: { provider: "firestore", mode: "emulator", reachable: true },
      publishing: { enabled: false },
      observedAt: new Date(AT - 1000).toISOString(),
    };
    const svc = createAutoPosterConnectedHealthService(CONFIGURED, { fetch: fakeFetch(body), now: () => AT });
    const p = await svc.getConnectedHealth();
    expect(p.autoPosterReachable).toBe(true);
    expect(p.storageMode).toBe("emulator");
    expect(p.storageReachable).toBe(true);
    expect(p.publishingBlocked).toBe(true);
    expect(p.stale).toBe(false);
    expect(p.primaryLabel).toBe("firestore_emulator");
  });

  it("flags health_stale when observedAt is older than the threshold", async () => {
    const body = {
      storage: { provider: "firestore", mode: "real", reachable: true },
      publishing: { enabled: false },
      observedAt: new Date(AT - 120_000).toISOString(),
    };
    const svc = createAutoPosterConnectedHealthService(CONFIGURED, {
      fetch: fakeFetch(body),
      now: () => AT,
      staleThresholdMs: 60_000,
    });
    const p = await svc.getConnectedHealth();
    expect(p.stale).toBe(true);
    expect(p.primaryLabel).toBe("health_stale");
  });

  it("maps real+unreachable to firestore_unavailable", async () => {
    const body = { storage: { mode: "real", reachable: false }, publishing: { enabled: false }, observedAt: new Date(AT).toISOString() };
    const svc = createAutoPosterConnectedHealthService(CONFIGURED, { fetch: fakeFetch(body), now: () => AT });
    const p = await svc.getConnectedHealth();
    expect(p.primaryLabel).toBe("firestore_unavailable");
  });

  it("is unreachable (not throwing) on network failure, with a redacted reason", async () => {
    const svc = createAutoPosterConnectedHealthService(CONFIGURED, {
      fetch: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:3000");
      },
    });
    const p = await svc.getConnectedHealth();
    expect(p.autoPosterReachable).toBe(false);
    expect(p.primaryLabel).toBe("unreachable");
    expect(p.error).toBe("unreachable");
    // The service token must never appear anywhere in the projection.
    expect(JSON.stringify(p)).not.toContain("runtime-token");
  });

  it("surfaces a non-200 as unreachable with an http_ reason", async () => {
    const svc = createAutoPosterConnectedHealthService(CONFIGURED, { fetch: fakeFetch({}, { ok: false, status: 503 }) });
    const p = await svc.getConnectedHealth();
    expect(p.autoPosterReachable).toBe(false);
    expect(p.error).toBe("http_503");
  });

  it("treats an unknown storage mode honestly", async () => {
    const body = { storage: { mode: "banana" }, publishing: {}, observedAt: new Date(AT).toISOString() };
    const svc = createAutoPosterConnectedHealthService(CONFIGURED, { fetch: fakeFetch(body), now: () => AT });
    const p = await svc.getConnectedHealth();
    expect(p.storageMode).toBe(null);
    expect(p.primaryLabel).toBe("health_unknown");
    expect(p.publishingBlocked).toBe(true);
  });
});
