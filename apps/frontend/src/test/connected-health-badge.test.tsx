import { describe, expect, it } from "vitest";
import { describeConnectedHealth } from "../components/AutoPosterConnectedHealthBadge";
import type { ConnectedHealthProjection } from "../api/types";

function projection(over: Partial<ConnectedHealthProjection>): ConnectedHealthProjection {
  return {
    configured: true,
    autoPosterReachable: true,
    storageMode: "emulator",
    storageReachable: true,
    publishingBlocked: true,
    runtimeConfigured: true,
    observedAt: new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
    ageMs: 1000,
    stale: false,
    staleThresholdMs: 60000,
    primaryLabel: "firestore_emulator",
    ...over,
  };
}

describe("describeConnectedHealth", () => {
  it("shows a loading state for a null projection", () => {
    const d = describeConnectedHealth(null);
    expect(d.tone).toBe("neutral");
    expect(d.text).toMatch(/loading/i);
  });

  it("renders verified emulator mode as ok with connected/publishing badges", () => {
    const d = describeConnectedHealth(projection({ primaryLabel: "firestore_emulator" }));
    expect(d.tone).toBe("ok");
    expect(d.text).toBe("Firestore: emulator");
    expect(d.badges).toContain("AutoPoster connected");
    expect(d.badges).toContain("Publishing blocked");
  });

  it("renders unreachable as error", () => {
    const d = describeConnectedHealth(projection({ primaryLabel: "unreachable", autoPosterReachable: false, error: "timeout" }));
    expect(d.tone).toBe("error");
    expect(d.text).toMatch(/unreachable/i);
    expect(d.badges).not.toContain("AutoPoster connected");
  });

  it("renders stale as a warning with a Health stale badge", () => {
    const d = describeConnectedHealth(projection({ primaryLabel: "health_stale", stale: true }));
    expect(d.tone).toBe("warn");
    expect(d.badges).toContain("Health stale");
  });

  it("renders unknown mode honestly as a warning", () => {
    const d = describeConnectedHealth(projection({ primaryLabel: "health_unknown", storageMode: null }));
    expect(d.tone).toBe("warn");
    expect(d.text).toMatch(/unknown/i);
  });

  it("renders firestore_unavailable as error", () => {
    const d = describeConnectedHealth(projection({ primaryLabel: "firestore_unavailable", storageMode: "unavailable", storageReachable: false }));
    expect(d.tone).toBe("error");
    expect(d.text).toMatch(/unavailable/i);
  });
});
