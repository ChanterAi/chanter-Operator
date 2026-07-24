// CHANTER Operator — Platform Readiness demo projection tests (§8). Mirrors the
// Forge Capability Workspace projection tests: unconfigured/unsafe/unreachable
// all degrade without throwing; a live projection passes through the demo
// presentation state; control actions proxy through.
import { describe, expect, it } from "vitest";
import { createDemoReadinessService } from "../src/demoReadiness/demoReadinessService.js";

const CONFIGURED = { baseUrl: "http://127.0.0.1:4900" };

function fakeFetch(body: unknown, init: { ok?: boolean; status?: number; text?: string } = {}) {
  return async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
    text: async () => init.text ?? "",
  }) as unknown as Response;
}

const SAMPLE_STATE = {
  present: true,
  missionId: "demo:platform-readiness:abc",
  title: "CHANTER Platform Readiness Mission",
  status: "succeeded",
  progress: { done: 14, total: 14 },
  counters: { providerReads: 4, providerWrites: 0, modelCalls: 2 },
  badges: { readOnlyMission: true, realInternetCapability: true, localAI: true, humanApprovalRequired: true, externalWrites: 0, evidenceRetained: true },
  evidenceState: { retained: true, evidenceRef: "ev-x.json" },
  brief: { readiness: "internal_platform", wordCount: 487 },
};

describe("Platform Readiness demo projection", () => {
  it("rejects an unsafe base URL (credentials/query) as unconfigured", () => {
    const svc = createDemoReadinessService({ baseUrl: "http://u:p@h:4900?x=1" });
    expect(svc.configured).toBe(false);
  });

  it("is unconfigured (never throws) without a base URL", async () => {
    const svc = createDemoReadinessService({ baseUrl: "" });
    const p = await svc.getState();
    expect(svc.configured).toBe(false);
    expect(p.configured).toBe(false);
    expect(p.reachable).toBe(false);
    expect(p.state).toBe(null);
  });

  it("projects live demo presentation state, including truth badges and zero writes", async () => {
    const svc = createDemoReadinessService(CONFIGURED, { fetch: fakeFetch(SAMPLE_STATE) });
    const p = await svc.getState("demo:platform-readiness:abc");
    expect(p.reachable).toBe(true);
    expect(p.state?.present).toBe(true);
    expect(p.state?.badges?.externalWrites).toBe(0);
    expect(p.state?.badges?.evidenceRetained).toBe(true);
    expect(p.state?.brief?.readiness).toBe("internal_platform");
  });

  it("is unreachable (not throwing) on network failure", async () => {
    const svc = createDemoReadinessService(CONFIGURED, { fetch: async () => { throw new Error("ECONNREFUSED"); } });
    const p = await svc.getState();
    expect(p.reachable).toBe(false);
    expect(p.error).toBe("unreachable");
  });

  it("surfaces a non-200 as an http_ error", async () => {
    const svc = createDemoReadinessService(CONFIGURED, { fetch: fakeFetch({}, { ok: false, status: 503 }) });
    const p = await svc.getState();
    expect(p.reachable).toBe(false);
    expect(p.error).toBe("http_503");
  });

  it("start proxies through and returns the projected state", async () => {
    const svc = createDemoReadinessService(CONFIGURED, { fetch: fakeFetch({ ...SAMPLE_STATE, status: "running" }) });
    const p = await svc.start("k1");
    expect(p.reachable).toBe(true);
    expect(p.state?.status).toBe("running");
  });

  it("reset unwraps the {state} envelope", async () => {
    const svc = createDemoReadinessService(CONFIGURED, { fetch: fakeFetch({ reset: { clearedDemoEntries: 3 }, state: { present: false } }) });
    const p = await svc.reset();
    expect(p.reachable).toBe(true);
    expect(p.state?.present).toBe(false);
  });

  it("getBrief returns markdown text when reachable", async () => {
    const svc = createDemoReadinessService(CONFIGURED, { fetch: fakeFetch(null, { text: "# CHANTER Platform Readiness Brief" }) });
    const b = await svc.getBrief();
    expect(b.reachable).toBe(true);
    expect(b.markdown).toContain("# CHANTER Platform Readiness Brief");
  });
});
