import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PROVIDER_PROOF_HUMAN_GATES,
  PROVIDER_PROOF_MAX_OBSERVATION_PASSES,
  PROVIDER_PROOF_REQUIRED_ENV_NAMES,
  ProviderProofPreflightError,
  assertProviderProofExecutionPath,
  fingerprintMp4,
  providerProofExactExecutionPath,
  runProviderProofHumanGates,
  validateProviderProofPreflight,
  type ProviderProofPreflightInput,
} from "./provider-proof-mode.mts";

const HEAD = "a".repeat(40);
const MEDIA_SHA = "b".repeat(64);

function validInput(): ProviderProofPreflightInput {
  const env = Object.fromEntries(PROVIDER_PROOF_REQUIRED_ENV_NAMES.map((name) => [name, "present"]));
  env.YOUTUBE_ENABLED = "true";
  env.YOUTUBE_PRIVATE_ONLY = "true";
  return {
    mode: "provider-proof",
    provider: "youtube",
    workspaceId: "workspace-reviewed",
    accountId: "UC-reviewed",
    idempotencyKey: "provider-proof-once",
    title: "Reviewed private proof",
    env,
    repositories: ["operator", "agent-runtime", "auto-poster", "mcp-server"].map((name) => ({
      name: name as ProviderProofPreflightInput["repositories"][number]["name"],
      currentHead: HEAD,
      reviewedHead: HEAD,
      clean: true,
    })),
    approvedMedia: { sha256: MEDIA_SHA, byteSize: 42, mimeType: "video/mp4", fileName: "reviewed.mp4", container: "mp4" },
    observedMedia: { sha256: MEDIA_SHA, byteSize: 42, mimeType: "video/mp4", fileName: "reviewed.mp4", container: "mp4" },
  };
}

function expectCode(code: string, mutate: (input: ProviderProofPreflightInput) => void): void {
  const input = validInput();
  mutate(input);
  assert.throws(
    () => validateProviderProofPreflight(input),
    (error) => error instanceof ProviderProofPreflightError && error.code === code,
  );
}

test("provider-proof preflight accepts only an exact reviewed safe state", () => {
  assert.doesNotThrow(() => validateProviderProofPreflight(validInput()));
  expectCode("EMULATOR_FORBIDDEN", (input) => { input.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080"; });
  expectCode("DIRTY_WORKTREE", (input) => { input.repositories[0]!.clean = false; });
  expectCode("REVIEWED_HEAD_MISMATCH", (input) => { input.repositories[1]!.reviewedHead = "c".repeat(40); });
  expectCode("PRIVATE_ONLY_REQUIRED", (input) => { input.env.YOUTUBE_PRIVATE_ONLY = "false"; });
  expectCode("YOUTUBE_DISABLED", (input) => { input.env.YOUTUBE_ENABLED = "false"; });
  expectCode("MEDIA_FINGERPRINT_MISMATCH", (input) => { input.observedMedia.byteSize = 43; });
  for (const field of ["sha256", "mimeType", "container"] as const) {
    expectCode("MEDIA_FINGERPRINT_MISMATCH", (input) => {
      Object.assign(input.observedMedia, field === "sha256"
        ? { sha256: "c".repeat(64) }
        : field === "mimeType"
          ? { mimeType: "video/quicktime" }
          : { container: "mov" });
    });
  }
  expectCode("APPROVED_MEDIA_INVALID", (input) => {
    (input.approvedMedia as unknown as Record<string, unknown>).unexpected = true;
  });
  expectCode("APPROVED_MEDIA_INVALID", (input) => {
    delete (input.approvedMedia as unknown as Record<string, unknown>).container;
  });
  expectCode("AUTOMATED_APPROVAL_FORBIDDEN", (input) => { input.approvalActor = "runner"; });
});

test("ADV-03/04 approved bytes and real MP4 structure are required before provider execution", async (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "chanter-provider-proof-media-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const valid = Buffer.alloc(32);
  valid.writeUInt32BE(24, 0);
  valid.write("ftyp", 4, 4, "ascii");
  valid.write("mp42", 8, 4, "ascii");
  valid.writeUInt32BE(0, 12);
  valid.write("isom", 16, 4, "ascii");
  valid.write("mp42", 20, 4, "ascii");
  valid.writeUInt32BE(8, 24);
  valid.write("mdat", 28, 4, "ascii");
  const validPath = path.join(root, "reviewed.mp4");
  writeFileSync(validPath, valid);
  const observed = await fingerprintMp4(validPath);
  assert.deepEqual(observed, {
    sha256: observed.sha256,
    byteSize: 32,
    mimeType: "video/mp4",
    fileName: "reviewed.mp4",
    container: "mp4",
  });

  const approved = validInput();
  approved.approvedMedia = { ...observed };
  approved.observedMedia = { ...observed };
  assert.doesNotThrow(() => validateProviderProofPreflight(approved));
  approved.observedMedia = { ...observed, sha256: "c".repeat(64) };
  assert.throws(
    () => validateProviderProofPreflight(approved),
    (error) => error instanceof ProviderProofPreflightError && error.code === "MEDIA_FINGERPRINT_MISMATCH",
    "filename-only equality must never substitute for byte identity",
  );

  for (const [name, bytes] of [
    ["json.mp4", Buffer.from('{"not":"video"}')],
    ["text.mp4", Buffer.from("not a video")],
    ["empty.mp4", Buffer.alloc(0)],
    ["truncated.mp4", valid.subarray(0, 20)],
  ] as const) {
    const invalidPath = path.join(root, name);
    writeFileSync(invalidPath, bytes);
    await assert.rejects(
      () => fingerprintMp4(invalidPath),
      (error) => error instanceof ProviderProofPreflightError
        && ["MEDIA_FILE_INVALID", "MEDIA_CONTAINER_INVALID"].includes(error.code),
      name,
    );
  }
});

test("provider-proof orchestration pauses at both human gates in strict order", async () => {
  const observed: string[] = [];
  await runProviderProofHumanGates({
    waitForIndependentGraphApproval: async () => { observed.push(PROVIDER_PROOF_HUMAN_GATES[0]); },
    verifyExactUnapprovedQueue: async () => { observed.push("exact_unapproved_queue_verified"); },
    waitForSeparateAutoPosterApproval: async () => { observed.push(PROVIDER_PROOF_HUMAN_GATES[1]); },
  });
  assert.deepEqual(observed, [
    "independent_graph_approval",
    "exact_unapproved_queue_verified",
    "exact_autoposter_provider_approval",
  ]);
});

test("provider-proof execution is exact-queue only and cannot use the global scheduler tick", () => {
  const path = providerProofExactExecutionPath("queue / reviewed");
  assert.equal(path, "/posts/queue%20%2F%20reviewed/prepare");
  assert.doesNotThrow(() => assertProviderProofExecutionPath(path, "queue / reviewed"));
  assert.throws(
    () => assertProviderProofExecutionPath("/api/cron/tick", "queue / reviewed"),
    (error) => error instanceof ProviderProofPreflightError && error.code === "GLOBAL_OR_WRONG_EXECUTION_PATH",
  );
  assert.equal(PROVIDER_PROOF_MAX_OBSERVATION_PASSES, 3);
});
