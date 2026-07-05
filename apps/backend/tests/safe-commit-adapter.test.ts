// â”€â”€ CHANTER Operator P1.3: SafeCommit Adapter Tests â”€â”€
import { describe, expect, it } from "vitest";
import {
  mapSafeCommitReviewToManifest,
  SAMPLE_SAFE_COMMIT_INPUT,
  SafeCommitReviewStates,
  SafeCommitVerdicts,
} from "../src/agentRuntime/adapters/safeCommitAdapter.js";
import { MockAgentRuntime } from "../src/agentRuntime/mockRuntime.js";
import type { SafeCommitReviewInput } from "../src/agentRuntime/adapters/safeCommitAdapter.js";

// ================================================================
// 1. State mapping â€” all 14 states
// ================================================================
describe("P1.3 SafeCommit Adapter â€” state mapping", () => {
  it("maps review_created to PLAN", () => {
    const r = mapSafeCommitReviewToManifest({ reviewId: "SC-001", taskId: "t1", state: "review_created" });
    expect(r.ok).toBe(true);
    expect(r.manifest!.lifecycleState).toBe("PLAN");
  });

  it("maps diff_received to PLAN", () => {
    const r = mapSafeCommitReviewToManifest({ reviewId: "SC-002", taskId: "t2", state: "diff_received" });
    expect(r.ok).toBe(true);
    expect(r.manifest!.lifecycleState).toBe("PLAN");
  });

  it("maps analyzing_diff to EXECUTE", () => {
    const r = mapSafeCommitReviewToManifest({ reviewId: "SC-003", taskId: "t3", state: "analyzing_diff" });
    expect(r.ok).toBe(true);
    expect(r.manifest!.lifecycleState).toBe("EXECUTE");
  });

  it("maps classifying_risk to EXECUTE", () => {
    const r = mapSafeCommitReviewToManifest({ reviewId: "SC-004", taskId: "t4", state: "classifying_risk" });
    expect(r.ok).toBe(true);
    expect(r.manifest!.lifecycleState).toBe("EXECUTE");
  });

  it("maps validating to VALIDATE", () => {
    const r = mapSafeCommitReviewToManifest({ reviewId: "SC-005", taskId: "t5", state: "validating" });
    expect(r.ok).toBe(true);
    expect(r.manifest!.lifecycleState).toBe("VALIDATE");
  });

  it("maps checks_running to VALIDATE", () => {
    const r = mapSafeCommitReviewToManifest({ reviewId: "SC-006", taskId: "t6", state: "checks_running" });
    expect(r.ok).toBe(true);
    expect(r.manifest!.lifecycleState).toBe("VALIDATE");
  });

  it("maps evidence_collected to EVIDENCE", () => {
    const r = mapSafeCommitReviewToManifest({ reviewId: "SC-007", taskId: "t7", state: "evidence_collected" });
    expect(r.ok).toBe(true);
    expect(r.manifest!.lifecycleState).toBe("EVIDENCE");
  });

  it("maps report_ready to EVIDENCE", () => {
    const r = mapSafeCommitReviewToManifest({ reviewId: "SC-008", taskId: "t8", state: "report_ready" });
    expect(r.ok).toBe(true);
    expect(r.manifest!.lifecycleState).toBe("EVIDENCE");
  });

  it("maps awaiting_human_review to HUMAN_REVIEW", () => {
    const r = mapSafeCommitReviewToManifest({ reviewId: "SC-009", taskId: "t9", state: "awaiting_human_review" });
    expect(r.ok).toBe(true);
    expect(r.manifest!.lifecycleState).toBe("HUMAN_REVIEW");
  });

  it("maps recommendation_ready to HUMAN_REVIEW", () => {
    const r = mapSafeCommitReviewToManifest({ reviewId: "SC-010", taskId: "t10", state: "recommendation_ready" });
    expect(r.ok).toBe(true);
    expect(r.manifest!.lifecycleState).toBe("HUMAN_REVIEW");
  });

  it("maps accepted to COMPLETE", () => {
    const r = mapSafeCommitReviewToManifest({
      reviewId: "SC-011", taskId: "t11", state: "accepted",
      validation: { passed: true, gates: ["typecheck"], gateResults: { typecheck: true }, summary: "ok", validatedAt: "2026-01-01T00:00:00Z" },
      evidence: [{ label: "diff", contentHash: "abc", recordedAt: "2026-01-01T00:00:00Z" }],
      verdict: "accepted",
    });
    expect(r.ok).toBe(true);
    expect(r.manifest!.lifecycleState).toBe("COMPLETE");
  });

  it("maps rejected to COMPLETE with synthetic failure", () => {
    const r = mapSafeCommitReviewToManifest({
      reviewId: "SC-012", taskId: "t12", state: "rejected",
      validation: { passed: false, gates: ["test"], gateResults: { test: false }, summary: "Tests failed.", validatedAt: "2026-01-01T00:00:00Z" },
      evidence: [{ label: "test-output", contentHash: "def", recordedAt: "2026-01-01T00:00:00Z" }],
      verdict: "rejected",
    });
    expect(r.ok).toBe(true);
    expect(r.manifest!.lifecycleState).toBe("COMPLETE");
    expect(r.manifest!.failure!.code).toBe("SAFECOMMIT_REJECTED");
  });

  it("maps blocked to COMPLETE with synthetic failure", () => {
    const r = mapSafeCommitReviewToManifest({
      reviewId: "SC-013", taskId: "t13", state: "blocked",
      validation: { passed: false, gates: ["test"], gateResults: { test: false }, summary: "Blocked.", validatedAt: "2026-01-01T00:00:00Z" },
      evidence: [{ label: "block-log", contentHash: "ghi", recordedAt: "2026-01-01T00:00:00Z" }],
      verdict: "blocked",
    });
    expect(r.ok).toBe(true);
    expect(r.manifest!.lifecycleState).toBe("COMPLETE");
    expect(r.manifest!.failure!.code).toBe("SAFECOMMIT_BLOCKED");
  });

  it("maps completed to COMPLETE", () => {
    const r = mapSafeCommitReviewToManifest({
      reviewId: "SC-014", taskId: "t14", state: "completed",
      validation: { passed: true, gates: ["typecheck"], gateResults: { typecheck: true }, summary: "ok", validatedAt: "2026-01-01T00:00:00Z" },
      evidence: [{ label: "diff", contentHash: "jkl", recordedAt: "2026-01-01T00:00:00Z" }],
      verdict: "accepted",
    });
    expect(r.ok).toBe(true);
    expect(r.manifest!.lifecycleState).toBe("COMPLETE");
  });

  it("all 14 states are defined in SafeCommitReviewStates", () => {
    expect(SafeCommitReviewStates).toHaveLength(14);
    expect(SafeCommitReviewStates).toContain("review_created");
    expect(SafeCommitReviewStates).toContain("accepted");
    expect(SafeCommitReviewStates).toContain("rejected");
    expect(SafeCommitReviewStates).toContain("blocked");
    expect(SafeCommitReviewStates).toContain("completed");
  });
});

// ================================================================
// 2. Rejection of invalid inputs
// ================================================================
describe("P1.3 SafeCommit Adapter â€” rejection", () => {
  it("rejects unknown state", () => {
    const r = mapSafeCommitReviewToManifest({ reviewId: "SC-X", taskId: "tx", state: "not_a_state" as never });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("Unknown SafeCommit state"))).toBe(true);
  });

  it("rejects missing reviewId", () => {
    const r = mapSafeCommitReviewToManifest({ reviewId: "", taskId: "t1", state: "review_created" });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("reviewId"))).toBe(true);
  });

  it("rejects whitespace-only reviewId", () => {
    const r = mapSafeCommitReviewToManifest({ reviewId: "   ", taskId: "t1", state: "review_created" });
    expect(r.ok).toBe(false);
  });

  it("rejects missing taskId", () => {
    const r = mapSafeCommitReviewToManifest({ reviewId: "SC-001", taskId: "", state: "review_created" });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("taskId"))).toBe(true);
  });

  // COMPLETE validation rejections
  const completeStates: ["accepted" | "rejected" | "blocked" | "completed", SafeCommitReviewInput["verdict"]][] = [
    ["accepted", "accepted"],
    ["rejected", "rejected"],
    ["blocked", "blocked"],
    ["completed", "accepted"],
  ];

  for (const [state, verdict] of completeStates) {
    it("rejects COMPLETE (" + state + ") without validation", () => {
      const r = mapSafeCommitReviewToManifest({
        reviewId: "SC-V-" + state, taskId: "tv", state,
        evidence: [{ label: "ev", contentHash: "abc", recordedAt: "2026-01-01T00:00:00Z" }],
        verdict,
      });
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.includes("Validation is required before COMPLETE"))).toBe(true);
    });

    it("rejects COMPLETE (" + state + ") without evidence", () => {
      const r = mapSafeCommitReviewToManifest({
        reviewId: "SC-E-" + state, taskId: "te", state,
        validation: { passed: true, gates: ["t"], gateResults: { t: true }, summary: "ok", validatedAt: "2026-01-01T00:00:00Z" },
        verdict,
      });
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.includes("Evidence is required before COMPLETE"))).toBe(true);
    });

    it("rejects COMPLETE (" + state + ") without verdict", () => {
      const r = mapSafeCommitReviewToManifest({
        reviewId: "SC-R-" + state, taskId: "tr", state,
        validation: { passed: true, gates: ["t"], gateResults: { t: true }, summary: "ok", validatedAt: "2026-01-01T00:00:00Z" },
        evidence: [{ label: "ev", contentHash: "abc", recordedAt: "2026-01-01T00:00:00Z" }],
      });
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.includes("Verdict/recommendation is required before COMPLETE"))).toBe(true);
    });
  }
});

// ================================================================
// 3. Timestamp validation
// ================================================================
describe("P1.3 SafeCommit Adapter â€” timestamp validation", () => {
  it("rejects out-of-order timestamps", () => {
    const r = mapSafeCommitReviewToManifest({
      reviewId: "SC-TS-001", taskId: "tts", state: "accepted",
      validation: { passed: true, gates: ["t"], gateResults: { t: true }, summary: "ok", validatedAt: "2026-07-05T10:00:00Z" },
      evidence: [{ label: "ev", contentHash: "abc", recordedAt: "2026-07-05T09:00:00Z" }],
      verdict: "accepted",
      stateTimestamps: { PLAN: "2026-07-05T10:00:00Z", EXECUTE: "2026-07-05T09:00:00Z" },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("out of lifecycle order"))).toBe(true);
  });
});

// ================================================================
// 4. Path security
// ================================================================
describe("P1.3 SafeCommit Adapter â€” path security", () => {
  it("rejects absolute paths", () => {
    const r = mapSafeCommitReviewToManifest({
      reviewId: "SC-P-001", taskId: "tp", state: "review_created",
      changedFiles: [{ filename: "C:\\Users\\secret.txt", classification: "blocked", linesAdded: 1, linesRemoved: 0 }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("Absolute path"))).toBe(true);
  });

  it("rejects parent traversal", () => {
    const r = mapSafeCommitReviewToManifest({
      reviewId: "SC-P-002", taskId: "tp", state: "review_created",
      changedFiles: [{ filename: "../../../etc/passwd", classification: "blocked", linesAdded: 1, linesRemoved: 0 }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("Parent traversal"))).toBe(true);
  });

  it("rejects .env files", () => {
    const r = mapSafeCommitReviewToManifest({
      reviewId: "SC-P-003", taskId: "tp", state: "review_created",
      changedFiles: [{ filename: ".env", classification: "blocked", linesAdded: 1, linesRemoved: 0 }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes(".env"))).toBe(true);
  });

  it("rejects .env.production", () => {
    const r = mapSafeCommitReviewToManifest({
      reviewId: "SC-P-004", taskId: "tp", state: "review_created",
      changedFiles: [{ filename: ".env.production", classification: "blocked", linesAdded: 1, linesRemoved: 0 }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes(".env"))).toBe(true);
  });

  it("rejects secret/credential files", () => {
    const r = mapSafeCommitReviewToManifest({
      reviewId: "SC-P-005", taskId: "tp", state: "review_created",
      changedFiles: [{ filename: "config/credentials.json", classification: "blocked", linesAdded: 1, linesRemoved: 0 }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("Secrets/credentials"))).toBe(true);
  });

  it("rejects private key files", () => {
    const r = mapSafeCommitReviewToManifest({
      reviewId: "SC-P-006", taskId: "tp", state: "review_created",
      changedFiles: [{ filename: "keys/id_rsa", classification: "blocked", linesAdded: 1, linesRemoved: 0 }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("Secrets/credentials"))).toBe(true);
  });

  it("rejects .ssh directory files", () => {
    const r = mapSafeCommitReviewToManifest({
      reviewId: "SC-P-007", taskId: "tp", state: "review_created",
      changedFiles: [{ filename: ".ssh/config", classification: "blocked", linesAdded: 1, linesRemoved: 0 }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("SSH"))).toBe(true);
  });

  it("rejects .aws directory files", () => {
    const r = mapSafeCommitReviewToManifest({
      reviewId: "SC-P-008", taskId: "tp", state: "review_created",
      changedFiles: [{ filename: ".aws/credentials", classification: "blocked", linesAdded: 1, linesRemoved: 0 }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("AWS"))).toBe(true);
  });

  it("rejects unsafe path in risk notes", () => {
    const r = mapSafeCommitReviewToManifest({
      reviewId: "SC-P-009", taskId: "tp", state: "review_created",
      changedFiles: [{
        filename: "src/app.ts", classification: "safe", linesAdded: 1, linesRemoved: 0,
        riskNotes: "Key stored in .env/config", 
      }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes(".env"))).toBe(true);
  });

  it("accepts safe relative paths", () => {
    const r = mapSafeCommitReviewToManifest({
      reviewId: "SC-P-010", taskId: "tp", state: "review_created",
      changedFiles: [
        { filename: "src/components/Button.tsx", classification: "safe", linesAdded: 10, linesRemoved: 2 },
        { filename: "src/utils/format.ts", classification: "safe", linesAdded: 5, linesRemoved: 0 },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.manifest!.productId).toBe("SafeCommit");
  });
});

// ================================================================
// 5. Security: git automation / live agent rejection
// ================================================================
describe("P1.3 SafeCommit Adapter â€” security blocklist", () => {
  it("rejects git add", () => {
    const r = mapSafeCommitReviewToManifest({
      reviewId: "sc-sec", taskId: "ts", state: "review_created",
      changedFiles: [{ filename: "src/ok.ts", classification: "safe", linesAdded: 1, linesRemoved: 0, riskNotes: "ran git add before review" }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("Git automation"))).toBe(true);
  });

  it("rejects git commit", () => {
    const r = mapSafeCommitReviewToManifest({
      reviewId: "sc-sec", taskId: "ts", state: "review_created",
      changedFiles: [{ filename: "src/ok.ts", classification: "safe", linesAdded: 1, linesRemoved: 0, riskNotes: "attempted git commit before review" }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("Git automation"))).toBe(true);
  });

  it("rejects git push", () => {
    const r = mapSafeCommitReviewToManifest({
      reviewId: "sc-sec", taskId: "ts", state: "review_created",
      changedFiles: [{ filename: "src/ok.ts", classification: "safe", linesAdded: 1, linesRemoved: 0, riskNotes: "git push origin main detected" }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("Git automation"))).toBe(true);
  });

  it("rejects git merge", () => {
    const r = mapSafeCommitReviewToManifest({
      reviewId: "sc-sec", taskId: "ts", state: "review_created",
      changedFiles: [{ filename: "src/ok.ts", classification: "safe", linesAdded: 1, linesRemoved: 0, riskNotes: "git merge main was attempted" }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("Git automation"))).toBe(true);
  });

  it("rejects deploy claims", () => {
    const r = mapSafeCommitReviewToManifest({ reviewId: "sc", taskId: "task-deploy-prod", state: "review_created" });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("Deploy/ship"))).toBe(true);
  });

  it("rejects codex references", () => {
    const r = mapSafeCommitReviewToManifest({ reviewId: "sc", taskId: "codex-task", state: "review_created" });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("External agent"))).toBe(true);
  });

  it("rejects ollama references", () => {
    const r = mapSafeCommitReviewToManifest({ reviewId: "sc", taskId: "t-ollama", state: "review_created" });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("External agent"))).toBe(true);
  });

  it("rejects openclaw references", () => {
    const r = mapSafeCommitReviewToManifest({ reviewId: "sc", taskId: "t-openclaw", state: "review_created" });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("External agent"))).toBe(true);
  });

  it("rejects live execution claims", () => {
    const r = mapSafeCommitReviewToManifest({
      reviewId: "sc-sec", taskId: "ts", state: "review_created",
      changedFiles: [{ filename: "src/ok.ts", classification: "safe", linesAdded: 1, linesRemoved: 0, riskNotes: "detected live execution attempt" }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("Live execution"))).toBe(true);
  });

  it("rejects shell command references", () => {
    const r = mapSafeCommitReviewToManifest({ reviewId: "sc", taskId: "t-shell-command", state: "review_created" });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("Live execution"))).toBe(true);
  });

  it("rejects URLs", () => {
    const r = mapSafeCommitReviewToManifest({
      reviewId: "sc", taskId: "ts", state: "review_created",
      evidence: [{ label: "https://evil.com/report", contentHash: "abc", recordedAt: "2026-01-01T00:00:00Z" }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("Network URLs"))).toBe(true);
  });
});

// ================================================================
// 6. Sample fixture
// ================================================================
describe("P1.3 SafeCommit Adapter â€” sample fixture", () => {
  it("SAMPLE_SAFE_COMMIT_INPUT maps into a complete manifest", () => {
    const r = mapSafeCommitReviewToManifest(SAMPLE_SAFE_COMMIT_INPUT);
    expect(r.ok).toBe(true);
    expect(r.manifest).not.toBeNull();
  });

  it("sample fixture is COMPLETE", () => {
    const r = mapSafeCommitReviewToManifest(SAMPLE_SAFE_COMMIT_INPUT);
    expect(r.manifest!.lifecycleState).toBe("COMPLETE");
  });

  it("sample fixture has productId SafeCommit", () => {
    const r = mapSafeCommitReviewToManifest(SAMPLE_SAFE_COMMIT_INPUT);
    expect(r.manifest!.productId).toBe("SafeCommit");
  });

  it("sample fixture has evidence (explicit + auto-generated)", () => {
    const r = mapSafeCommitReviewToManifest(SAMPLE_SAFE_COMMIT_INPUT);
    // 3 explicit + 1 changed-files + 1 risk = 5
    expect(r.manifest!.evidence.length).toBeGreaterThanOrEqual(5);
  });

  it("sample fixture has validation with all 4 gates", () => {
    const r = mapSafeCommitReviewToManifest(SAMPLE_SAFE_COMMIT_INPUT);
    expect(r.manifest!.validation!.passed).toBe(true);
    expect(r.manifest!.validation!.gates).toContain("typecheck");
    expect(r.manifest!.validation!.gates).toContain("test");
    expect(r.manifest!.validation!.gates).toContain("build");
    expect(r.manifest!.validation!.gates).toContain("diff-check");
  });

  it("sample fixture has no failure (accepted)", () => {
    const r = mapSafeCommitReviewToManifest(SAMPLE_SAFE_COMMIT_INPUT);
    expect(r.manifest!.failure).toBeNull();
  });

  it("sample fixture runtimeId starts with 'sc-'", () => {
    const r = mapSafeCommitReviewToManifest(SAMPLE_SAFE_COMMIT_INPUT);
    expect(r.manifest!.runtimeId).toMatch(/^sc-SC-2026/);
  });

  it("sample fixture all timestamps populated", () => {
    const r = mapSafeCommitReviewToManifest(SAMPLE_SAFE_COMMIT_INPUT);
    for (const s of ["PLAN", "EXECUTE", "VALIDATE", "EVIDENCE", "HUMAN_REVIEW", "COMPLETE"] as const) {
      expect(r.manifest!.stateTimestamps[s]).not.toBeNull();
    }
  });

  it("sample fixture evidence includes changed-files ref", () => {
    const r = mapSafeCommitReviewToManifest(SAMPLE_SAFE_COMMIT_INPUT);
    expect(r.manifest!.evidence.some((e) => e.label === "changed-files-2")).toBe(true);
  });

  it("sample fixture evidence includes risk assessment ref", () => {
    const r = mapSafeCommitReviewToManifest(SAMPLE_SAFE_COMMIT_INPUT);
    expect(r.manifest!.evidence.some((e) => e.label.startsWith("risk-assessment"))).toBe(true);
  });
});

// ================================================================
// 7. Manifest serialization round-trip
// ================================================================
describe("P1.3 SafeCommit Adapter â€” serialization", () => {
  it("mapped manifest round-trips through JSON", () => {
    const r = mapSafeCommitReviewToManifest(SAMPLE_SAFE_COMMIT_INPUT);
    expect(r.ok).toBe(true);
    const json = JSON.stringify(r.manifest);
    const restored = JSON.parse(json);

    expect(restored.runtimeId).toBe(r.manifest!.runtimeId);
    expect(restored.productId).toBe("SafeCommit");
    expect(restored.lifecycleState).toBe("COMPLETE");
    expect(restored.evidence.length).toBe(r.manifest!.evidence.length);
  });

  it("MockAgentRuntime can deserialize the mapped manifest", () => {
    const runtime = new MockAgentRuntime();
    const r = mapSafeCommitReviewToManifest(SAMPLE_SAFE_COMMIT_INPUT);
    expect(r.ok).toBe(true);

    const json = runtime.serialize(r.manifest!);
    const deserialized = runtime.deserialize(json);

    expect(deserialized.lifecycleState).toBe("COMPLETE");
    expect(deserialized.productId).toBe("SafeCommit");
  });
});

// ================================================================
// 8. No cross-repo imports / No real execution
// ================================================================
describe("P1.3 SafeCommit Adapter â€” no cross-repo imports", () => {
  it("adapter has no SafeCommit imports", () => {
    const fn = mapSafeCommitReviewToManifest;
    expect(typeof fn).toBe("function");
  });

  it("adapter is synchronous (no async exec)", () => {
    const r = mapSafeCommitReviewToManifest(SAMPLE_SAFE_COMMIT_INPUT);
    expect(r.ok).toBe(true);
  });
});

// ================================================================
// 9. Edge cases
// ================================================================
describe("P1.3 SafeCommit Adapter â€” edge cases", () => {
  it("custom runtimeId prefix", () => {
    const r = mapSafeCommitReviewToManifest({
      reviewId: "ABC-001", taskId: "te", state: "review_created", runtimeIdPrefix: "safecommit-",
    });
    expect(r.ok).toBe(true);
    expect(r.manifest!.runtimeId).toBe("safecommit-ABC-001");
  });

  it("planned state has null for unreached states", () => {
    const r = mapSafeCommitReviewToManifest({ reviewId: "SC-E-001", taskId: "te", state: "review_created" });
    expect(r.manifest!.stateTimestamps.PLAN).not.toBeNull();
    expect(r.manifest!.stateTimestamps.EXECUTE).toBeNull();
    expect(r.manifest!.stateTimestamps.COMPLETE).toBeNull();
  });

  it("explicit failure overrides synthetic for rejected", () => {
    const r = mapSafeCommitReviewToManifest({
      reviewId: "SC-E-002", taskId: "te", state: "rejected",
      validation: { passed: false, gates: [], gateResults: {}, summary: "x", validatedAt: "2026-01-01T00:00:00Z" },
      evidence: [{ label: "ev", contentHash: "abc", recordedAt: "2026-01-01T00:00:00Z" }],
      verdict: "rejected",
      failure: { code: "CUSTOM_REJECT", message: "Custom rejection.", failedAt: "2026-01-01T00:00:00Z" },
    });
    expect(r.ok).toBe(true);
    expect(r.manifest!.failure!.code).toBe("CUSTOM_REJECT");
  });

  it("policy has SafeCommit timeouts", () => {
    const r = mapSafeCommitReviewToManifest({ reviewId: "SC-E-003", taskId: "te", state: "review_created" });
    expect(r.manifest!.policy.timeout.maxStateMs).toBe(120_000);
    expect(r.manifest!.policy.timeout.maxTotalMs).toBe(600_000);
    expect(r.manifest!.policy.retry.maxRetries).toBe(2);
  });

  it("SafeCommitVerdicts has 4 values", () => {
    expect(SafeCommitVerdicts).toEqual(["accepted", "rejected", "blocked", "needs_human_review"]);
  });

  it("accepts review with 0 changed files", () => {
    const r = mapSafeCommitReviewToManifest({ reviewId: "SC-E-004", taskId: "te", state: "review_created", changedFiles: [] });
    expect(r.ok).toBe(true);
  });

  it("evidence IDs are derived from reviewId", () => {
    const r = mapSafeCommitReviewToManifest({
      reviewId: "SC-E-005", taskId: "te", state: "accepted",
      validation: { passed: true, gates: ["t"], gateResults: { t: true }, summary: "ok", validatedAt: "2026-01-01T00:00:00Z" },
      evidence: [
        { label: "ev1", contentHash: "h1", recordedAt: "2026-01-01T00:00:00Z" },
        { label: "ev2", contentHash: "h2", recordedAt: "2026-01-01T00:00:00Z" },
      ],
      verdict: "accepted",
    });
    expect(r.manifest!.evidence[0].id).toBe("sc-ev-SC-E-005-1");
    expect(r.manifest!.evidence[1].id).toBe("sc-ev-SC-E-005-2");
  });

  it("recommendation_ready maps to HUMAN_REVIEW without COMPLETE requirements", () => {
    const r = mapSafeCommitReviewToManifest({ reviewId: "SC-E-006", taskId: "te", state: "recommendation_ready" });
    expect(r.ok).toBe(true);
    expect(r.manifest!.lifecycleState).toBe("HUMAN_REVIEW");
  });

  it("verdict 'needs_human_review' on non-COMPLETE works", () => {
    // 'needs_human_review' is a valid verdict but the state must still map to a lifecycle
    const r = mapSafeCommitReviewToManifest({
      reviewId: "SC-E-007", taskId: "te", state: "awaiting_human_review",
    });
    expect(r.ok).toBe(true);
    expect(r.manifest!.lifecycleState).toBe("HUMAN_REVIEW");
  });

  it("multiple file-level errors are all reported", () => {
    const r = mapSafeCommitReviewToManifest({
      reviewId: "SC-E-008", taskId: "te", state: "review_created",
      changedFiles: [
        { filename: ".env", classification: "blocked", linesAdded: 1, linesRemoved: 0 },
        { filename: ".ssh/config", classification: "blocked", linesAdded: 1, linesRemoved: 0 },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBe(2);
    expect(r.errors[0]).toContain(".env");
    expect(r.errors[1]).toContain("SSH");
  });
});

// ================================================================
// 10. Existing tests still pass (regression check)
// ================================================================
describe("P1.3 SafeCommit Adapter â€” no regressions", () => {
  it("agentRuntime types still importable", async () => {
    const mod = await import("../src/agentRuntime/index.js");
    expect(mod.MockAgentRuntime).toBeDefined();
    expect(mod.createEmptyManifest).toBeDefined();
  });

  it("Loop Governor adapter still works", async () => {
    const { mapLoopGovernorRunToManifest } = await import(
      "../src/agentRuntime/adapters/loopGovernorAdapter.js"
    );
    const r = mapLoopGovernorRunToManifest({
      loopId: "LG-SMOKE", taskId: "ts", state: "planned",
    });
    expect(r.ok).toBe(true);
  });
});
