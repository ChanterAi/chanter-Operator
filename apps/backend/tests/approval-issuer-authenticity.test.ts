/**
 * Operator-side approval issuer authenticity.
 *
 * The Runtime owns verification and is proved separately; this suite proves the
 * *issuer* half: that Operator signs what it publishes, that a process with
 * write access to Operator's approval state directory still cannot authorize
 * execution, and that every broken issuer configuration fails closed with a
 * typed reason and no leaked key material.
 *
 * Real durable stores, a real Git authority checkout, real Ed25519 keys, and
 * the real pre-adapter guard. Only the AutoPoster queue port is substituted;
 * it performs no external side effect and counts adapter entries.
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  APPROVAL_AUTHENTICITY_SCHEME_ED25519,
  createDurableIdempotencyStore,
  createDurableMissionRunLedger,
  createRuntimeApprovalObservation,
  type AutoPosterOperationsPort,
  type AutoPosterScheduleParams,
} from "chanter-agent-runtime";
import { AgentRunLedgerService } from "../src/agentRunLedger/agentRunLedgerService.js";
import { createDatabase } from "../src/db/database.js";
import { AutoPosterMissionService } from "../src/runtimeMissions/autoPosterMissionService.js";
import { createAutoPosterRuntimeMissionExecutor } from "../src/runtimeMissions/autoPosterRuntime.js";
import type { OperatorApprovalAuthorityConfiguration } from "../src/runtimeMissions/persistedApprovalAuthority.js";
import {
  approvalAuthorityFixture,
  cleanupApprovalAuthorityFixtures,
} from "./helpers/approvalAuthorityFixture.js";

const APPROVER = "founder";
const WORKSPACE_ID = "workspace-a-00000001";
const ACCOUNT_ID = "account-a";

const disposableRoots: string[] = [];
const openDatabases: DatabaseSync[] = [];

afterEach(() => {
  cleanupApprovalAuthorityFixtures();
  for (const database of openDatabases.splice(0)) {
    try {
      database.close();
    } catch {
      // Already closed by a restart proof.
    }
  }
  for (const root of disposableRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // A temp root Windows still holds open is inert.
    }
  }
});

function disposableRoot(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  disposableRoots.push(root);
  return root;
}

function futureIso(minutes = 120): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function makeBoundary(): { port: AutoPosterOperationsPort; scheduleCalls: AutoPosterScheduleParams[] } {
  const scheduleCalls: AutoPosterScheduleParams[] = [];
  const account = {
    connectedAccountId: "tiktok:account-a",
    accountId: ACCOUNT_ID,
    provider: "tiktok" as const,
    providerDisplayName: "TikTok",
    username: "creator",
    displayName: "Creator",
    connectionStatus: "connected" as const,
    publishingReady: true,
    readinessBlockers: [],
    lastVerifiedAt: new Date().toISOString(),
  };
  const port: AutoPosterOperationsPort = {
    async listConnectedAccounts(params) {
      return { ok: true, workspaceId: params.workspaceId, accounts: [account], count: 1 };
    },
    async validateConnectedAccount(params) {
      return { ok: true, workspaceId: params.workspaceId ?? WORKSPACE_ID, account };
    },
    async listQueue() {
      return { ok: true, items: [], count: 0, scope: { accountId: "all" } };
    },
    async getPostStatus(params) {
      return {
        ok: true,
        post: {
          id: params.postId,
          accountId: ACCOUNT_ID,
          username: "creator",
          status: "scheduled",
          scheduledAt: futureIso(),
          approved: false,
          mediaType: "video",
          captionSummary: "",
          createdAt: null,
          updatedAt: null,
          approvedAt: null,
          approvedBy: "",
          postedAt: null,
          publishId: "",
          claimAttempts: 0,
          lastErrorMessage: "",
        },
      };
    },
    async validateMedia() {
      return { ok: true, valid: true, classification: "video", policy: { videoOnly: true, allowedExtensions: [".mp4"] } };
    },
    async schedulePost(params) {
      scheduleCalls.push(params);
      return {
        ok: true,
        duplicate: false,
        post: {
          id: "authenticity-queue-draft-1",
          accountId: params.accountId,
          provider: params.provider ?? "tiktok",
          status: "scheduled",
          scheduledAt: params.scheduledAt,
          approved: false,
          campaignId: `autoposter-campaign:${params.missionId}`,
          approvalId: `autoposter-approval:${params.missionId}`,
          evidenceBundleId: `autoposter-evidence:${params.missionId}`,
        },
      };
    },
  };
  return { port, scheduleCalls };
}

function openService(input: {
  approvalAuthority: OperatorApprovalAuthorityConfiguration;
  port: AutoPosterOperationsPort;
  databasePath?: string;
}) {
  const databasePath = input.databasePath
    ?? path.join(disposableRoot("chanter-authenticity-db-"), "operator.sqlite");
  const database = createDatabase(databasePath);
  openDatabases.push(database);
  const executor = createAutoPosterRuntimeMissionExecutor(
    {
      baseUrl: "https://autoposter.authenticity.test",
      serviceToken: "authenticity-service-token",
      userId: "owner",
      timeoutValid: true,
      approvalAuthority: input.approvalAuthority,
    },
    { port: input.port },
  );
  const service = new AutoPosterMissionService(database, executor, {
    agentRunLedgerService: new AgentRunLedgerService(database),
  });
  return { database, service, executor, databasePath };
}

function scheduleInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspaceId: WORKSPACE_ID,
    accountId: ACCOUNT_ID,
    provider: "tiktok",
    mediaUrl: "https://cdn.example.com/authenticity.mp4",
    caption: "Issuer authenticity proof",
    hashtags: "#chanter",
    scheduledAt: futureIso(),
    ...overrides,
  };
}

function adapterStarts(stateDir: string, missionId: string): number {
  return createDurableMissionRunLedger({ stateDir })
    .listRunsByMission(missionId)
    .flatMap((run) => run.events)
    .filter((event) => event.type === "adapter_started")
    .length;
}

/** A disposable Ed25519 private key written the way a deployment supplies one. */
function writePrivateKeyFile(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  const file = path.join(disposableRoot("chanter-authenticity-key-"), "issuer.key.pem");
  writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), {
    encoding: "utf8",
    mode: 0o600,
  });
  return file;
}

function writeTrustFile(contents: unknown): string {
  const file = path.join(disposableRoot("chanter-authenticity-trust-"), "trusted-issuers.json");
  writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents), "utf8");
  return file;
}

// ---------------------------------------------------------------------------

describe("Operator approval issuer authenticity", () => {
  it("signs the approval it publishes and executes exactly once", async () => {
    const approvalAuthority = approvalAuthorityFixture();
    const { port, scheduleCalls } = makeBoundary();
    const { service } = openService({ approvalAuthority, port });

    const created = await service.createScheduleMission(scheduleInput());
    const completed = await service.approveAndExecute(created.missionId, APPROVER);

    expect(completed.status).toBe("succeeded");
    expect(scheduleCalls).toHaveLength(1);
    expect(adapterStarts(approvalAuthority.stateDir, created.missionId)).toBe(1);

    // The published observation carries a real signature from Operator's issuer.
    const observation = createDurableIdempotencyStore({ stateDir: approvalAuthority.stateDir })
      .getApprovalObservation(created.missionId);
    expect(observation?.authenticity?.scheme).toBe(APPROVAL_AUTHENTICITY_SCHEME_ED25519);
    expect(observation?.authenticity?.issuerAuthorityId).toBe(approvalAuthority.issuer?.authorityId);
    expect(observation?.authenticity?.issuerKeyId).toBe(approvalAuthority.issuer?.keyId);
    expect(observation?.authenticity?.signature).toMatch(/^[A-Za-z0-9+/]+=*$/);
    // No private material anywhere near the durable authority record.
    expect(JSON.stringify(observation)).not.toMatch(/PRIVATE KEY/);
  });

  it("refuses an approval authored directly in the state directory", async () => {
    const approvalAuthority = approvalAuthorityFixture();
    const { port, scheduleCalls } = makeBoundary();
    const { service, executor } = openService({ approvalAuthority, port });

    const created = await service.createScheduleMission(scheduleInput());
    // Publish only the checkpoint, exactly as a pending approval would.
    const request = service.runtimeRequestFor(created.missionId);
    const checkpointOnly = createAutoPosterRuntimeMissionExecutor(
      {
        baseUrl: "https://autoposter.authenticity.test",
        serviceToken: "authenticity-service-token",
        userId: "owner",
        timeoutValid: true,
        approvalAuthority,
      },
      { port },
    );
    void checkpointOnly;
    void executor;

    // A separate process holding full write access to the same durable state
    // directory. It reads the checkpoint and authors a perfectly formed,
    // correctly hashed, correctly bound, *unsigned* approval.
    const attackerStore = createDurableIdempotencyStore({
      stateDir: approvalAuthority.stateDir,
      ownerId: "attacker-with-filesystem-access",
    });
    // Force checkpoint publication first.
    await executor.prepareApproval(request, {
      approverId: APPROVER,
      observedAt: new Date().toISOString(),
    }).catch(() => undefined);
    const manifest = attackerStore.getApprovalCheckpointManifest(created.missionId);
    expect(manifest).toBeDefined();

    const forgedMission = await service.createScheduleMission(
      scheduleInput({ caption: "Forged approval target" }),
    );
    const forgedRequest = service.runtimeRequestFor(forgedMission.missionId);
    // Publish the forged mission's checkpoint through the legitimate path,
    // then author its approval by hand with no signature.
    await executor.prepareApproval(forgedRequest, {
      approverId: APPROVER,
      observedAt: new Date().toISOString(),
      status: "rejected",
    }).catch(() => undefined);

    const forgedManifest = attackerStore.getApprovalCheckpointManifest(forgedMission.missionId)!;
    const forged = createRuntimeApprovalObservation({
      approvalRequestId: forgedManifest.approvalRequestId,
      checkpointId: forgedManifest.checkpointId,
      missionId: forgedManifest.missionId,
      operationId: forgedManifest.operationId,
      action: forgedManifest.action,
      stepId: forgedManifest.stepId,
      repositoryId: forgedManifest.repositoryId,
      expectedHead: forgedManifest.expectedHead,
      approvalPolicyId: forgedManifest.approvalPolicyId,
      status: "approved",
      approverId: "attacker",
      note: "authored directly in durable storage",
      evidenceReferences: forgedManifest.evidenceReferences,
      checkpointManifestHash: forgedManifest.manifestHash,
      observedAt: new Date().toISOString(),
    });
    // The attacker's write itself is not what must fail; reaching the adapter is.
    void attackerStore.persistApprovalObservation(forged);

    const refused = await service.approveAndExecute(forgedMission.missionId, APPROVER);

    expect(refused.status).not.toBe("succeeded");
    expect(scheduleCalls).toHaveLength(0);
    expect(adapterStarts(approvalAuthority.stateDir, forgedMission.missionId)).toBe(0);
  });

  it("fails closed on every broken issuer or trust configuration, without leaking key material", async () => {
    const valid = approvalAuthorityFixture();
    const otherKeyFile = writePrivateKeyFile();
    const { publicKey } = generateKeyPairSync("ed25519");
    const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privatePem = generateKeyPairSync("ed25519").privateKey
      .export({ type: "pkcs8", format: "pem" }).toString();

    const cases: Array<[string, Partial<OperatorApprovalAuthorityConfiguration>, string]> = [
      ["no signing identity", { issuer: undefined }, "OPERATOR_APPROVAL_ISSUER_NOT_CONFIGURED"],
      // The Runtime refuses first here, before Operator's own trust check ever
      // runs. That is the stronger ordering: the verifier, not the issuer,
      // decides that an unverifiable approval cannot execute.
      ["no trusted issuers", { trustedIssuersFile: undefined }, "RUNTIME_APPROVAL_AUTHENTICITY_CONFIGURATION_UNAVAILABLE"],
      [
        "unreadable signing key",
        { issuer: { ...valid.issuer!, privateKeyFile: path.join(disposableRoot("chanter-authenticity-missing-"), "absent.pem") } },
        "OPERATOR_APPROVAL_ISSUER_KEY_UNREADABLE",
      ],
      [
        "relative signing key path",
        { issuer: { ...valid.issuer!, privateKeyFile: "relative/issuer.pem" } },
        "OPERATOR_APPROVAL_ISSUER_CONFIGURATION_INVALID",
      ],
      [
        "non-canonical issuer id",
        { issuer: { ...valid.issuer!, authorityId: "not an id" } },
        "OPERATOR_APPROVAL_ISSUER_CONFIGURATION_INVALID",
      ],
      [
        "malformed trust file",
        { trustedIssuersFile: writeTrustFile("{ not json") },
        "RUNTIME_APPROVAL_AUTHENTICITY_CONFIGURATION_UNAVAILABLE",
      ],
      [
        "trust file without issuers",
        { trustedIssuersFile: writeTrustFile({ trusted: [] }) },
        "RUNTIME_APPROVAL_AUTHENTICITY_CONFIGURATION_UNAVAILABLE",
      ],
      [
        "trust file with a private key",
        {
          trustedIssuersFile: writeTrustFile({
            issuers: [{
              authorityId: valid.issuer!.authorityId,
              authorizedPolicyIds: ["chanter.operator.human-approval.v1"],
              keys: [{ keyId: valid.issuer!.keyId, publicKey: privatePem }],
            }],
          }),
        },
        "RUNTIME_APPROVAL_AUTHENTICITY_CONFIGURATION_UNAVAILABLE",
      ],
      [
        "trust file with duplicate key ids",
        {
          trustedIssuersFile: writeTrustFile({
            issuers: [{
              authorityId: valid.issuer!.authorityId,
              authorizedPolicyIds: ["chanter.operator.human-approval.v1"],
              keys: [
                { keyId: valid.issuer!.keyId, publicKey: publicPem },
                { keyId: valid.issuer!.keyId, publicKey: publicPem },
              ],
            }],
          }),
        },
        "RUNTIME_APPROVAL_AUTHENTICITY_CONFIGURATION_UNAVAILABLE",
      ],
    ];

    for (const [label, override, code] of cases) {
      const approvalAuthority = { ...approvalAuthorityFixture(), ...override };
      const { port, scheduleCalls } = makeBoundary();
      const { service } = openService({ approvalAuthority, port });
      const created = await service.createScheduleMission(scheduleInput());
      const refused = await service.approveAndExecute(created.missionId, APPROVER);

      expect(refused.status, label).toBe("failed");
      expect(refused.runtimeResult?.errors[0]?.code, label).toBe(code);
      const message = refused.runtimeResult?.errors[0]?.message ?? "";
      expect(message, label).not.toMatch(/PRIVATE KEY|BEGIN [A-Z ]*KEY/);
      expect(scheduleCalls, label).toHaveLength(0);
      expect(adapterStarts(approvalAuthority.stateDir, created.missionId), label).toBe(0);
    }
    void otherKeyFile;
  });

  it("refuses an approval signed by a key the trust file does not name", async () => {
    // Operator signs with a real key; the Runtime trusts a *different* key id.
    const base = approvalAuthorityFixture();
    const approvalAuthority: OperatorApprovalAuthorityConfiguration = {
      ...base,
      issuer: { ...base.issuer!, keyId: "rotated-out-key" },
    };
    const { port, scheduleCalls } = makeBoundary();
    const { service } = openService({ approvalAuthority, port });

    const created = await service.createScheduleMission(scheduleInput());
    const refused = await service.approveAndExecute(created.missionId, APPROVER);

    expect(refused.status).not.toBe("succeeded");
    expect(refused.runtimeResult?.errors[0]?.code).toBe("RUNTIME_APPROVAL_AUTHENTICITY_KEY_UNKNOWN");
    expect(scheduleCalls).toHaveLength(0);
    expect(adapterStarts(approvalAuthority.stateDir, created.missionId)).toBe(0);
  });

  it("refuses an issuer the trust file does not name at all", async () => {
    const base = approvalAuthorityFixture();
    const approvalAuthority: OperatorApprovalAuthorityConfiguration = {
      ...base,
      issuer: { ...base.issuer!, authorityId: "chanter.operator.impostor" },
    };
    const { port, scheduleCalls } = makeBoundary();
    const { service } = openService({ approvalAuthority, port });

    const created = await service.createScheduleMission(scheduleInput());
    const refused = await service.approveAndExecute(created.missionId, APPROVER);

    expect(refused.runtimeResult?.errors[0]?.code).toBe("RUNTIME_APPROVAL_AUTHENTICITY_ISSUER_UNKNOWN");
    expect(scheduleCalls).toHaveLength(0);
    expect(adapterStarts(approvalAuthority.stateDir, created.missionId)).toBe(0);
  });

  it("resumes an authentic approval across a restart without re-signing", async () => {
    const approvalAuthority = approvalAuthorityFixture();
    const { port, scheduleCalls } = makeBoundary();
    const databasePath = path.join(disposableRoot("chanter-authenticity-db-"), "operator.sqlite");

    const first = openService({ approvalAuthority, port, databasePath });
    const created = await first.service.createScheduleMission(scheduleInput());
    // Publish authority, then simulate the process ending before execution.
    const prepared = await first.executor.prepareApproval(
      first.service.runtimeRequestFor(created.missionId),
      { approverId: APPROVER, observedAt: new Date().toISOString() },
    );
    expect(prepared.ok).toBe(true);
    const signedBefore = createDurableIdempotencyStore({ stateDir: approvalAuthority.stateDir })
      .getApprovalObservation(created.missionId)!;
    first.database.close();

    const restarted = openService({ approvalAuthority, port, databasePath });
    const completed = await restarted.service.approveAndExecute(created.missionId, APPROVER);

    expect(completed.status).toBe("succeeded");
    expect(scheduleCalls).toHaveLength(1);
    expect(adapterStarts(approvalAuthority.stateDir, created.missionId)).toBe(1);
    // The very same signature authorized it; nothing was re-issued.
    const signedAfter = createDurableIdempotencyStore({ stateDir: approvalAuthority.stateDir })
      .getApprovalObservation(created.missionId)!;
    expect(signedAfter.authenticity?.signature).toBe(signedBefore.authenticity?.signature);

    // A duplicate resume still produces at most one adapter entry.
    const replayed = await restarted.service.approveAndExecute(created.missionId, APPROVER);
    expect(replayed.execution?.state).toBe("completed");
    expect(scheduleCalls).toHaveLength(1);
    expect(adapterStarts(approvalAuthority.stateDir, created.missionId)).toBe(1);
  });
});
