// CHANTER Operator — SDK Forge Capability Workspace projection tests.
import { describe, expect, it } from "vitest";
import { createForgeCapabilityService } from "../src/capabilities/forgeCapabilityService.js";

const CONFIGURED = { baseUrl: "http://127.0.0.1:4610", token: "sdk-token" };

function fakeFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return async () => ({ ok: init.ok ?? true, status: init.status ?? 200, json: async () => body }) as unknown as Response;
}

describe("Forge Capability Workspace projection", () => {
  it("is unconfigured (never throws) without a base URL", async () => {
    const svc = createForgeCapabilityService({ baseUrl: "", token: "" });
    const p = await svc.listCapabilities();
    expect(svc.configured).toBe(false);
    expect(p.configured).toBe(false);
    expect(p.reachable).toBe(false);
    expect(p.count).toBe(0);
  });

  it("rejects an unsafe base URL (credentials/query) as unconfigured", () => {
    const svc = createForgeCapabilityService({ baseUrl: "http://u:p@h:4610?x=1", token: "t" });
    expect(svc.configured).toBe(false);
  });

  it("projects a capability list with health", async () => {
    const body = {
      capabilities: [
        { capabilityId: "github.repository.inspect", version: "1.0.0", category: "internet", riskClass: "read_only", status: "certified", health: { healthy: true, success: 3, failure: 0, lastSuccessAt: "2026-07-24T00:00:00.000Z" } },
        { capabilityId: "system.health.read", version: "1.0.0", category: "system", riskClass: "read_only", status: "certified", health: { healthy: true, success: 1, failure: 0 } },
      ],
    };
    const svc = createForgeCapabilityService(CONFIGURED, { fetch: fakeFetch(body) });
    const p = await svc.listCapabilities();
    expect(p.reachable).toBe(true);
    expect(p.count).toBe(2);
    expect(p.capabilities[0].capabilityId).toBe("github.repository.inspect");
    expect(p.capabilities[0].status).toBe("certified");
    expect(p.capabilities[0].health?.success).toBe(3);
    // The SDK token must never appear in the projection.
    expect(JSON.stringify(p)).not.toContain("sdk-token");
  });

  it("is unreachable (not throwing) on network failure", async () => {
    const svc = createForgeCapabilityService(CONFIGURED, { fetch: async () => { throw new Error("ECONNREFUSED"); } });
    const p = await svc.listCapabilities();
    expect(p.reachable).toBe(false);
    expect(p.error).toBe("unreachable");
  });

  it("surfaces a non-200 as an http_ error", async () => {
    const svc = createForgeCapabilityService(CONFIGURED, { fetch: fakeFetch({}, { ok: false, status: 503 }) });
    const p = await svc.listCapabilities();
    expect(p.reachable).toBe(false);
    expect(p.error).toBe("http_503");
  });

  it("describeCapability returns the manifest projection", async () => {
    const manifest = { capabilityId: "github.repository.inspect", version: "1.0.0", inputSchema: { type: "object" } };
    const svc = createForgeCapabilityService(CONFIGURED, { fetch: fakeFetch(manifest) });
    const d = (await svc.describeCapability("github.repository.inspect")) as Record<string, unknown>;
    expect(d.capabilityId).toBe("github.repository.inspect");
  });
});
