// ── CHANTER Operator P1.4: AutoPoster Adapter Tests ──
import { describe, expect, it } from "vitest";
import {
  mapAutoPosterRunToManifest,
  SAMPLE_AUTOPOSTER_INPUT,
  AutoPosterRunStates,
  AutoPosterPlatforms,
} from "../src/agentRuntime/adapters/autoPosterAdapter.js";
import { MockAgentRuntime } from "../src/agentRuntime/mockRuntime.js";

// ================================================================
// 1. State mapping — all 19 states
// ================================================================
describe("P1.4 AutoPoster Adapter — state mapping", () => {
  it("maps campaign_created to PLAN", () => {
    const r = mapAutoPosterRunToManifest({ taskId: "t1", state: "campaign_created" });
    expect(r.ok).toBe(true);
    expect(r.manifest!.lifecycleState).toBe("PLAN");
    expect(r.manifest!.productId).toBe("AutoPoster");
  });

  it("maps job_created to PLAN", () => {
    const r = mapAutoPosterRunToManifest({ taskId: "t2", state: "job_created" });
    expect(r.ok).toBe(true);
    expect(r.manifest!.lifecycleState).toBe("PLAN");
  });

  it("maps draft_ready to PLAN", () => {
    const r = mapAutoPosterRunToManifest({ taskId: "t3", state: "draft_ready" });
    expect(r.ok).toBe(true);
    expect(r.manifest!.lifecycleState).toBe("PLAN");
  });

  it("maps preparing_payload to EXECUTE", () => {
    const r = mapAutoPosterRunToManifest({ taskId: "t4", state: "preparing_payload" });
    expect(r.ok).toBe(true);
    expect(r.manifest!.lifecycleState).toBe("EXECUTE");
  });

  it("maps generating_variants to EXECUTE", () => {
    const r = mapAutoPosterRunToManifest({ taskId: "t5", state: "generating_variants" });
    expect(r.ok).toBe(true);
    expect(r.manifest!.lifecycleState).toBe("EXECUTE");
  });

  it("maps queueing_job to EXECUTE", () => {
    const r = mapAutoPosterRunToManifest({ taskId: "t6", state: "queueing_job" });
    expect(r.ok).toBe(true);
    expect(r.manifest!.lifecycleState).toBe("EXECUTE");
  });

  it("maps validating_content to VALIDATE", () => {
    const r = mapAutoPosterRunToManifest({ taskId: "t7", state: "validating_content" });
    expect(r.ok).toBe(true);
    expect(r.manifest!.lifecycleState).toBe("VALIDATE");
  });

  it("maps checking_schedule to VALIDATE", () => {
    const r = mapAutoPosterRunToManifest({ taskId: "t8", state: "checking_schedule" });
    expect(r.ok).toBe(true);
    expect(r.manifest!.lifecycleState).toBe("VALIDATE");
  });

  it("maps checking_account_scope to VALIDATE", () => {
    const r = mapAutoPosterRunToManifest({ taskId: "t9", state: "checking_account_scope" });
    expect(r.ok).toBe(true);
    expect(r.manifest!.lifecycleState).toBe("VALIDATE");
  });

  it("maps preview_ready to EVIDENCE", () => {
    const r = mapAutoPosterRunToManifest({ taskId: "t10", state: "preview_ready" });
    expect(r.ok).toBe(true);
    expect(r.manifest!.lifecycleState).toBe("EVIDENCE");
  });

  it("maps evidence_collected to EVIDENCE", () => {
    const r = mapAutoPosterRunToManifest({ taskId: "t11", state: "evidence_collected" });
    expect(r.ok).toBe(true);
    expect(r.manifest!.lifecycleState).toBe("EVIDENCE");
  });

  it("maps job_recorded to EVIDENCE", () => {
    const r = mapAutoPosterRunToManifest({ taskId: "t12", state: "job_recorded" });
    expect(r.ok).toBe(true);
    expect(r.manifest!.lifecycleState).toBe("EVIDENCE");
  });

  it("maps awaiting_human_review to HUMAN_REVIEW", () => {
    const r = mapAutoPosterRunToManifest({ taskId: "t13", state: "awaiting_human_review" });
    expect(r.ok).toBe(true);
    expect(r.manifest!.lifecycleState).toBe("HUMAN_REVIEW");
  });

  it("maps approval_required to HUMAN_REVIEW", () => {
    const r = mapAutoPosterRunToManifest({ taskId: "t14", state: "approval_required" });
    expect(r.ok).toBe(true);
    expect(r.manifest!.lifecycleState).toBe("HUMAN_REVIEW");
  });

  // COMPLETE states
  const buildComplete = (state: "queued" | "scheduled" | "published" | "failed" | "cancelled") =>
    mapAutoPosterRunToManifest({
      taskId: "tc", state,
      validation: { passed: state !== "failed", gates: ["t"], gateResults: { t: state !== "failed" }, summary: "x", validatedAt: "2026-01-01T00:00:00Z" },
      evidence: [{ label: "ev", contentHash: "abc", recordedAt: "2026-01-01T00:00:00Z" }],
      accountScope: state === "failed" || state === "cancelled" ? undefined : ["@test"],
    });

  it("maps queued to COMPLETE", () => expect(buildComplete("queued").manifest!.lifecycleState).toBe("COMPLETE"));
  it("maps scheduled to COMPLETE", () => expect(buildComplete("scheduled").manifest!.lifecycleState).toBe("COMPLETE"));
  it("maps published to COMPLETE", () => expect(buildComplete("published").manifest!.lifecycleState).toBe("COMPLETE"));
  it("maps failed to COMPLETE with failure", () => {
    const r = buildComplete("failed");
    expect(r.manifest!.lifecycleState).toBe("COMPLETE");
    expect(r.manifest!.failure!.code).toBe("AUTOPOSTER_FAILED");
  });
  it("maps cancelled to COMPLETE with failure", () => {
    const r = buildComplete("cancelled");
    expect(r.manifest!.lifecycleState).toBe("COMPLETE");
    expect(r.manifest!.failure!.code).toBe("AUTOPOSTER_CANCELLED");
  });

  it("all 19 states defined", () => expect(AutoPosterRunStates).toHaveLength(19));
});

// ================================================================
// 2. Rejection
// ================================================================
describe("P1.4 AutoPoster Adapter — rejection", () => {
  it("rejects unknown state", () => {
    const r = mapAutoPosterRunToManifest({ taskId: "tx", state: "bogus" as never });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes("Unknown AutoPoster state"))).toBe(true);
  });

  it("rejects missing taskId", () => {
    const r = mapAutoPosterRunToManifest({ taskId: "", state: "campaign_created" });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes("taskId"))).toBe(true);
  });

  it("rejects whitespace taskId", () => {
    const r = mapAutoPosterRunToManifest({ taskId: "   ", state: "campaign_created" });
    expect(r.ok).toBe(false);
  });

  it("rejects COMPLETE (published) without validation", () => {
    const r = mapAutoPosterRunToManifest({
      taskId: "t", state: "published",
      evidence: [{ label: "e", contentHash: "a", recordedAt: "2026-01-01T00:00:00Z" }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes("Validation"))).toBe(true);
  });

  it("rejects COMPLETE (published) without evidence", () => {
    const r = mapAutoPosterRunToManifest({
      taskId: "t", state: "published",
      validation: { passed: true, gates: ["t"], gateResults: { t: true }, summary: "x", validatedAt: "2026-01-01T00:00:00Z" },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes("Evidence"))).toBe(true);
  });

  it("rejects queued without account scope", () => {
    const r = mapAutoPosterRunToManifest({
      taskId: "t", state: "queued",
      validation: { passed: true, gates: ["t"], gateResults: { t: true }, summary: "x", validatedAt: "2026-01-01T00:00:00Z" },
      evidence: [{ label: "e", contentHash: "a", recordedAt: "2026-01-01T00:00:00Z" }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes("Account scope"))).toBe(true);
  });

  it("rejects scheduled without account scope", () => {
    const r = mapAutoPosterRunToManifest({
      taskId: "t", state: "scheduled",
      validation: { passed: true, gates: ["t"], gateResults: { t: true }, summary: "x", validatedAt: "2026-01-01T00:00:00Z" },
      evidence: [{ label: "e", contentHash: "a", recordedAt: "2026-01-01T00:00:00Z" }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes("Account scope"))).toBe(true);
  });

  it("rejects published without account scope", () => {
    const r = mapAutoPosterRunToManifest({
      taskId: "t", state: "published",
      validation: { passed: true, gates: ["t"], gateResults: { t: true }, summary: "x", validatedAt: "2026-01-01T00:00:00Z" },
      evidence: [{ label: "e", contentHash: "a", recordedAt: "2026-01-01T00:00:00Z" }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes("Account scope"))).toBe(true);
  });

  it("accepts empty account scope (rejected)", () => {
    const r = mapAutoPosterRunToManifest({
      taskId: "t", state: "published",
      validation: { passed: true, gates: ["t"], gateResults: { t: true }, summary: "x", validatedAt: "2026-01-01T00:00:00Z" },
      evidence: [{ label: "e", contentHash: "a", recordedAt: "2026-01-01T00:00:00Z" }],
      accountScope: [],
    });
    expect(r.ok).toBe(false);
  });
});

// ================================================================
// 3. Token/secret/credential rejection
// ================================================================
describe("P1.4 AutoPoster Adapter — token/secret rejection", () => {
  it("rejects access_token", () => {
    const r = mapAutoPosterRunToManifest({ taskId: "t-access_token-xyz", state: "campaign_created" });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes("Token"))).toBe(true);
  });

  it("rejects refresh_token", () => {
    const r = mapAutoPosterRunToManifest({ taskId: "t", state: "campaign_created", campaign: { campaignId: "c1", campaignName: "refresh_token here", platform: "tiktok", accountAlias: "@test" } });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes("Token"))).toBe(true);
  });

  it("rejects bearer token", () => {
    const r = mapAutoPosterRunToManifest({ taskId: "t", state: "campaign_created", campaign: { campaignId: "c1", campaignName: "with bearer abc123", platform: "tiktok", accountAlias: "@test" } });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes("Token"))).toBe(true);
  });

  it("rejects api_key", () => {
    const r = mapAutoPosterRunToManifest({ taskId: "t-api_key-secret", state: "campaign_created" });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes("Secret"))).toBe(true);
  });

  it("rejects client_secret", () => {
    const r = mapAutoPosterRunToManifest({ taskId: "t", state: "campaign_created", campaign: { campaignId: "c1", campaignName: "client_secret detected", platform: "tiktok", accountAlias: "@test" } });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes("Secret"))).toBe(true);
  });

  it("rejects cookie/session references", () => {
    const r = mapAutoPosterRunToManifest({ taskId: "t", state: "campaign_created", campaign: { campaignId: "c1", campaignName: "session_id value", platform: "tiktok", accountAlias: "@test" } });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes("Cookie"))).toBe(true);
  });

  it("rejects signed URLs", () => {
    const r = mapAutoPosterRunToManifest({ taskId: "t", state: "campaign_created", evidence: [{ label: "signed-url-for-upload", contentHash: "a", recordedAt: "2026-01-01T00:00:00Z" }] });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes("Signed URL"))).toBe(true);
  });
});

// ================================================================
// 4. API/posting/network rejection
// ================================================================
describe("P1.4 AutoPoster Adapter — API/posting/network rejection", () => {
  it("rejects tiktok API URLs", () => {
    const r = mapAutoPosterRunToManifest({ taskId: "t", state: "campaign_created", campaign: { campaignId: "c1", campaignName: "x", platform: "tiktok", accountAlias: "@test - https://tiktok.com/api" } });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes("Live social API"))).toBe(true);
  });

  it("rejects tiktok posting claims", () => {
    const r = mapAutoPosterRunToManifest({ taskId: "tiktok-post-upload", state: "campaign_created" });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes("Live social posting"))).toBe(true);
  });

  it("rejects instagram API references", () => {
    const r = mapAutoPosterRunToManifest({ taskId: "t", state: "campaign_created", evidence: [{ label: "https://graph.instagram.com result", contentHash: "a", recordedAt: "2026-01-01T00:00:00Z" }] });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes("Live social API"))).toBe(true);
  });

  it("rejects Codex", () => {
    const r = mapAutoPosterRunToManifest({ taskId: "t-codex", state: "campaign_created" });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes("External agent"))).toBe(true);
  });

  it("rejects Ollama", () => {
    const r = mapAutoPosterRunToManifest({ taskId: "t-ollama", state: "campaign_created" });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes("External agent"))).toBe(true);
  });

  it("rejects OpenClaw", () => {
    const r = mapAutoPosterRunToManifest({ taskId: "t-openclaw", state: "campaign_created" });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes("External agent"))).toBe(true);
  });

  it("rejects cron/scheduler claims", () => {
    const r = mapAutoPosterRunToManifest({ taskId: "t", state: "campaign_created", campaign: { campaignId: "c1", campaignName: "cron based post", platform: "tiktok", accountAlias: "@test" } });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes("Scheduler"))).toBe(true);
  });

  it("rejects deploy claims", () => {
    const r = mapAutoPosterRunToManifest({ taskId: "deploy-prod", state: "campaign_created" });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes("Live execution"))).toBe(true);
  });
});

// ================================================================
// 5. Sample fixture
// ================================================================
describe("P1.4 AutoPoster Adapter — sample fixture", () => {
  it("maps into complete manifest", () => {
    const r = mapAutoPosterRunToManifest(SAMPLE_AUTOPOSTER_INPUT);
    expect(r.ok).toBe(true);
    expect(r.manifest).not.toBeNull();
  });

  it("is COMPLETE", () => expect(mapAutoPosterRunToManifest(SAMPLE_AUTOPOSTER_INPUT).manifest!.lifecycleState).toBe("COMPLETE"));
  it("has productId AutoPoster", () => expect(mapAutoPosterRunToManifest(SAMPLE_AUTOPOSTER_INPUT).manifest!.productId).toBe("AutoPoster"));
  it("has no failure (published)", () => expect(mapAutoPosterRunToManifest(SAMPLE_AUTOPOSTER_INPUT).manifest!.failure).toBeNull());
  it("validation passed", () => expect(mapAutoPosterRunToManifest(SAMPLE_AUTOPOSTER_INPUT).manifest!.validation!.passed).toBe(true));
  it("has 4 validation gates", () => expect(mapAutoPosterRunToManifest(SAMPLE_AUTOPOSTER_INPUT).manifest!.validation!.gates).toHaveLength(4));
  it("all timestamps populated", () => {
    const r = mapAutoPosterRunToManifest(SAMPLE_AUTOPOSTER_INPUT);
    for (const s of ["PLAN","EXECUTE","VALIDATE","EVIDENCE","HUMAN_REVIEW","COMPLETE"] as const)
      expect(r.manifest!.stateTimestamps[s]).not.toBeNull();
  });
  it("runtimeId starts with ap-", () => expect(mapAutoPosterRunToManifest(SAMPLE_AUTOPOSTER_INPUT).manifest!.runtimeId).toMatch(/^ap-JOB/));
  it("evidence includes campaign ref", () => {
    const r = mapAutoPosterRunToManifest(SAMPLE_AUTOPOSTER_INPUT);
    expect(r.manifest!.evidence.some(e => e.label.includes("campaign"))).toBe(true);
  });
  it("evidence includes job ref", () => {
    const r = mapAutoPosterRunToManifest(SAMPLE_AUTOPOSTER_INPUT);
    expect(r.manifest!.evidence.some(e => e.label.includes("job"))).toBe(true);
  });
  it("evidence includes account scope ref", () => {
    const r = mapAutoPosterRunToManifest(SAMPLE_AUTOPOSTER_INPUT);
    expect(r.manifest!.evidence.some(e => e.label.includes("account-scope"))).toBe(true);
  });
  // total evidence: 3 explicit + 1 campaign + 1 job + 1 scope = 6
  it("has 6 evidence entries", () => {
    expect(mapAutoPosterRunToManifest(SAMPLE_AUTOPOSTER_INPUT).manifest!.evidence.length).toBe(6);
  });
});

// ================================================================
// 6. Serialization
// ================================================================
describe("P1.4 AutoPoster Adapter — serialization", () => {
  it("round-trips through JSON", () => {
    const r = mapAutoPosterRunToManifest(SAMPLE_AUTOPOSTER_INPUT);
    const restored = JSON.parse(JSON.stringify(r.manifest));
    expect(restored.runtimeId).toBe(r.manifest!.runtimeId);
    expect(restored.productId).toBe("AutoPoster");
    expect(restored.lifecycleState).toBe("COMPLETE");
  });

  it("MockAgentRuntime deserializes", () => {
    const runtime = new MockAgentRuntime();
    const r = mapAutoPosterRunToManifest(SAMPLE_AUTOPOSTER_INPUT);
    const d = runtime.deserialize(runtime.serialize(r.manifest!));
    expect(d.lifecycleState).toBe("COMPLETE");
    expect(d.productId).toBe("AutoPoster");
  });
});

// ================================================================
// 7. No cross-repo imports
// ================================================================
describe("P1.4 AutoPoster Adapter — no cross-repo", () => {
  it("is a function", () => expect(typeof mapAutoPosterRunToManifest).toBe("function"));
  it("is synchronous", () => {
    const r = mapAutoPosterRunToManifest(SAMPLE_AUTOPOSTER_INPUT);
    expect(r.ok).toBe(true);
  });
});

// ================================================================
// 8. Edge cases
// ================================================================
describe("P1.4 AutoPoster Adapter — edge cases", () => {
  it("custom runtimeId prefix", () => {
    const r = mapAutoPosterRunToManifest({ taskId: "t", state: "campaign_created", runtimeIdPrefix: "xyz-", campaign: { campaignId: "C1", campaignName: "n", platform: "tiktok", accountAlias: "@a" } });
    expect(r.manifest!.runtimeId).toBe("xyz-C1");
  });

  it("uses jobId over campaignId for runtimeId", () => {
    const r = mapAutoPosterRunToManifest({
      taskId: "t", state: "published",
      campaign: { campaignId: "CAMP-1", campaignName: "n", platform: "tiktok", accountAlias: "@a" },
      job: { jobId: "JOB-1", contentType: "video", variantCount: 1 },
      validation: { passed: true, gates: ["t"], gateResults: { t: true }, summary: "x", validatedAt: "2026-01-01T00:00:00Z" },
      evidence: [{ label: "e", contentHash: "a", recordedAt: "2026-01-01T00:00:00Z" }],
      accountScope: ["@test"],
    });
    expect(r.manifest!.runtimeId).toBe("ap-JOB-1");
  });

  it("null timestamps for unreached states", () => {
    const r = mapAutoPosterRunToManifest({ taskId: "t", state: "campaign_created" });
    expect(r.manifest!.stateTimestamps.PLAN).not.toBeNull();
    expect(r.manifest!.stateTimestamps.EXECUTE).toBeNull();
    expect(r.manifest!.stateTimestamps.COMPLETE).toBeNull();
  });

  it("policy has AutoPoster timeouts", () => {
    const r = mapAutoPosterRunToManifest({ taskId: "t", state: "campaign_created" });
    expect(r.manifest!.policy.timeout.maxStateMs).toBe(180_000);
    expect(r.manifest!.policy.timeout.maxTotalMs).toBe(900_000);
  });

  it("explicit failure overrides synthetic for failed", () => {
    const r = mapAutoPosterRunToManifest({
      taskId: "t", state: "failed",
      validation: { passed: false, gates: [], gateResults: {}, summary: "x", validatedAt: "2026-01-01T00:00:00Z" },
      evidence: [{ label: "e", contentHash: "a", recordedAt: "2026-01-01T00:00:00Z" }],
      failure: { code: "CUSTOM", message: "Custom fail.", failedAt: "2026-01-01T00:00:00Z" },
    });
    expect(r.manifest!.failure!.code).toBe("CUSTOM");
  });

  it("AutoPosterPlatforms has 7 platforms", () => {
    expect(AutoPosterPlatforms).toEqual(["tiktok","instagram","youtube","twitter","linkedin","facebook","custom"]);
  });

  it("accepts campaign + job fields in mid-lifecycle state", () => {
    const r = mapAutoPosterRunToManifest({
      taskId: "t", state: "generating_variants",
      campaign: { campaignId: "C1", campaignName: "Test", platform: "instagram", accountAlias: "@brand" },
      job: { jobId: "J1", contentType: "carousel", variantCount: 5 },
    });
    expect(r.ok).toBe(true);
    // evidence auto-generated: campaign + job (no explicit evidence or validation for EXECUTE state)
    expect(r.manifest!.evidence.length).toBe(2);
  });

  it("rejects out-of-order timestamps", () => {
    const r = mapAutoPosterRunToManifest({
      taskId: "t", state: "published",
      validation: { passed: true, gates: ["t"], gateResults: { t: true }, summary: "x", validatedAt: "2026-01-01T00:00:00Z" },
      evidence: [{ label: "e", contentHash: "a", recordedAt: "2026-01-01T00:00:00Z" }],
      accountScope: ["@test"],
      stateTimestamps: { PLAN: "2026-07-05T10:00:00Z", EXECUTE: "2026-07-05T09:00:00Z" },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes("out of lifecycle order"))).toBe(true);
  });
});

// ================================================================
// 9. No regressions
// ================================================================
describe("P1.4 AutoPoster Adapter — no regressions", () => {
  it("agentRuntime still importable", async () => {
    const mod = await import("../src/agentRuntime/index.js");
    expect(mod.MockAgentRuntime).toBeDefined();
  });

  it("Loop Governor adapter still works", async () => {
    const { mapLoopGovernorRunToManifest } = await import("../src/agentRuntime/adapters/loopGovernorAdapter.js");
    expect(mapLoopGovernorRunToManifest({ loopId: "LG-SMOKE", taskId: "ts", state: "planned" }).ok).toBe(true);
  });

  it("SafeCommit adapter still works", async () => {
    const { mapSafeCommitReviewToManifest } = await import("../src/agentRuntime/adapters/safeCommitAdapter.js");
    expect(mapSafeCommitReviewToManifest({ reviewId: "SC-SMOKE", taskId: "ts", state: "review_created" }).ok).toBe(true);
  });
});
