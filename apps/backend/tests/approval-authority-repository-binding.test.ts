/**
 * Deployable approval-authority repository binding.
 *
 * Every proof uses a **real** Git product repository carrying the operational
 * files a live checkout actually has — `node_modules/`, `dist/`, `.env`, logs,
 * untracked scratch files, and an uncommitted tracked edit — plus the real
 * Runtime approval guard. Nothing about repository identity, committed HEAD, or
 * clean state is mocked or asserted by Operator; the Runtime decides all three.
 *
 * The only substituted boundary is the AutoPoster queue port, which performs no
 * external side effect and counts adapter entries.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDurableIdempotencyStore,
  createDurableMissionRunLedger,
  type AutoPosterOperationsPort,
  type AutoPosterScheduleParams,
} from "chanter-agent-runtime";
import { AgentRunLedgerService } from "../src/agentRunLedger/agentRunLedgerService.js";
import { createDatabase } from "../src/db/database.js";
import { AutoPosterMissionService } from "../src/runtimeMissions/autoPosterMissionService.js";
import { createAutoPosterRuntimeMissionExecutor } from "../src/runtimeMissions/autoPosterRuntime.js";
import {
  approvalCheckoutPath,
  resolveApprovalAuthorityCheckout,
} from "../src/runtimeMissions/approvalAuthorityCheckout.js";
import type { OperatorApprovalAuthorityConfiguration } from "../src/runtimeMissions/persistedApprovalAuthority.js";

const APPROVER = "founder";
const WORKSPACE_ID = "workspace-a-00000001";
const ACCOUNT_ID = "account-a";

const disposableRoots: string[] = [];
const openDatabases: DatabaseSync[] = [];

afterEach(() => {
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

function git(repositoryRoot: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

/**
 * A realistic live product repository: committed source plus exactly the
 * ignored and untracked operational files that made direct binding
 * permanently fail-closed.
 */
function createProductRepository(): { root: string; head: string } {
  const root = disposableRoot("chanter-binding-product-");
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.name", "CHANTER Binding Tests"]);
  git(root, ["config", "user.email", "binding-tests@invalid.local"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  writeFileSync(path.join(root, ".gitignore"), "node_modules/\ndist/\n.env\n*.log\n", "utf8");
  writeFileSync(path.join(root, "product.txt"), "committed product source\n", "utf8");
  git(root, ["add", "--", ".gitignore", "product.txt"]);
  git(root, ["commit", "--quiet", "-m", "product baseline"]);
  const head = git(root, ["rev-parse", "HEAD"]);
  contaminate(root);
  return { root, head };
}

/** Everything a working checkout normally accumulates. */
function contaminate(root: string): void {
  mkdirSync(path.join(root, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(path.join(root, "node_modules", "left-pad", "index.js"), "//\n", "utf8");
  mkdirSync(path.join(root, "dist"), { recursive: true });
  writeFileSync(path.join(root, "dist", "bundle.js"), "//\n", "utf8");
  writeFileSync(path.join(root, ".env"), "AUTOPOSTER_RUNTIME_TOKEN=local\n", "utf8");
  writeFileSync(path.join(root, "server.log"), "operational noise\n", "utf8");
  writeFileSync(path.join(root, "scratch.txt"), "untracked scratch\n", "utf8");
  writeFileSync(path.join(root, "product.txt"), "committed product source + uncommitted edit\n", "utf8");
}

function advanceProductHead(root: string): string {
  writeFileSync(path.join(root, "product.txt"), "second committed revision\n", "utf8");
  git(root, ["add", "--", "product.txt"]);
  git(root, ["commit", "--quiet", "-m", "second revision"]);
  const head = git(root, ["rev-parse", "HEAD"]);
  // Re-contaminate: the working checkout is never clean for long.
  writeFileSync(path.join(root, "scratch2.txt"), "more untracked scratch\n", "utf8");
  return head;
}

function managedBinding(productRoot: string): {
  configuration: OperatorApprovalAuthorityConfiguration;
  checkoutRoot: string;
  stateDir: string;
} {
  const stateDir = disposableRoot("chanter-binding-state-");
  const checkoutRoot = disposableRoot("chanter-binding-checkout-");
  return {
    stateDir,
    checkoutRoot,
    configuration: {
      stateDir,
      managedCheckout: { sourceRepositoryRoot: productRoot, checkoutRoot },
      ownerId: "binding-test-owner",
    },
  };
}

// ---------------------------------------------------------------------------

interface Boundary {
  port: AutoPosterOperationsPort;
  scheduleCalls: AutoPosterScheduleParams[];
}

function makeBoundary(): Boundary {
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
      return {
        ok: true,
        valid: true,
        classification: "video",
        policy: { videoOnly: true, allowedExtensions: [".mp4"] },
      };
    },
    async schedulePost(params) {
      scheduleCalls.push(params);
      return {
        ok: true,
        duplicate: false,
        post: {
          id: "binding-queue-draft-1",
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

function futureIso(minutes = 120): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function openService(input: {
  databasePath: string;
  boundary: Boundary;
  approvalAuthority?: OperatorApprovalAuthorityConfiguration;
}) {
  const database = createDatabase(input.databasePath);
  openDatabases.push(database);
  const executor = createAutoPosterRuntimeMissionExecutor(
    {
      baseUrl: "https://autoposter.binding.test",
      serviceToken: "binding-service-token",
      userId: "owner",
      timeoutValid: true,
      ...(input.approvalAuthority ? { approvalAuthority: input.approvalAuthority } : {}),
    },
    { port: input.boundary.port },
  );
  const service = new AutoPosterMissionService(database, executor, {
    agentRunLedgerService: new AgentRunLedgerService(database),
  });
  return { database, service, executor };
}

function scheduleInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspaceId: WORKSPACE_ID,
    accountId: ACCOUNT_ID,
    provider: "tiktok",
    mediaUrl: "https://cdn.example.com/binding.mp4",
    caption: "Repository binding proof",
    hashtags: "#chanter",
    scheduledAt: futureIso(),
    ...overrides,
  };
}

/** Adapter entries recorded durably by the Runtime, across every run. */
function adapterStarts(stateDir: string, missionId: string): number {
  return createDurableMissionRunLedger({ stateDir })
    .listRunsByMission(missionId)
    .flatMap((run) => run.events)
    .filter((event) => event.type === "adapter_started")
    .length;
}

// ---------------------------------------------------------------------------

describe("deployable approval authority repository binding", () => {
  it("executes against a live product repository full of ignored and untracked files", async () => {
    const product = createProductRepository();
    const binding = managedBinding(product.root);
    const boundary = makeBoundary();
    const { service } = openService({
      databasePath: path.join(disposableRoot("chanter-binding-db-"), "operator.sqlite"),
      boundary,
      approvalAuthority: binding.configuration,
    });

    const created = await service.createScheduleMission(scheduleInput());
    const completed = await service.approveAndExecute(created.missionId, APPROVER);

    expect(completed.status).toBe("succeeded");
    expect(boundary.scheduleCalls).toHaveLength(1);
    expect(adapterStarts(binding.stateDir, created.missionId)).toBe(1);

    // Authority bound to the isolated checkout at the exact committed HEAD.
    const manifest = createDurableIdempotencyStore({ stateDir: binding.stateDir })
      .getApprovalCheckpointManifest(created.missionId);
    expect(manifest?.expectedHead).toBe(product.head);
    expect(manifest?.repositoryRoot).toBe(
      approvalCheckoutPath(binding.checkoutRoot, product.root, product.head),
    );
    expect(manifest?.repositoryRoot).not.toBe(product.root);
  });

  it("keeps the isolated checkout free of the source worktree's dirt", () => {
    const product = createProductRepository();
    const binding = managedBinding(product.root);
    const resolved = resolveApprovalAuthorityCheckout(binding.configuration.managedCheckout!);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("unreachable");

    const checkout = resolved.checkout.repositoryRoot;
    // Nothing ignored, nothing untracked, nothing modified, under the exact
    // canonical policy the Runtime evaluates.
    expect(git(checkout, ["status", "--porcelain", "--untracked-files=all", "--ignored=matching"]))
      .toBe("");
    expect(git(checkout, ["rev-parse", "HEAD"])).toBe(product.head);
    // The uncommitted source edit never entered the authority checkout.
    expect(readdirSync(checkout).sort()).toEqual([".git", ".gitignore", "product.txt"]);
    for (const contaminant of ["node_modules", "dist", ".env", "server.log", "scratch.txt"]) {
      expect(existsSync(path.join(checkout, contaminant))).toBe(false);
    }
  });

  it("never writes to the source repository", () => {
    const product = createProductRepository();
    const binding = managedBinding(product.root);
    const statusBefore = git(product.root, ["status", "--porcelain", "--ignored=matching"]);
    const worktreesBefore = git(product.root, ["worktree", "list"]);

    const resolved = resolveApprovalAuthorityCheckout(binding.configuration.managedCheckout!);
    expect(resolved.ok).toBe(true);

    expect(git(product.root, ["status", "--porcelain", "--ignored=matching"])).toBe(statusBefore);
    // A worktree-based design would have registered state inside the product
    // repository here, where an unrelated `git worktree prune` could revoke it.
    expect(git(product.root, ["worktree", "list"])).toBe(worktreesBefore);
    expect(git(product.root, ["rev-parse", "HEAD"])).toBe(product.head);
  });

  it("adopts an existing published checkout instead of rebuilding it", () => {
    const product = createProductRepository();
    const binding = managedBinding(product.root);
    const first = resolveApprovalAuthorityCheckout(binding.configuration.managedCheckout!);
    const second = resolveApprovalAuthorityCheckout(binding.configuration.managedCheckout!);
    expect(first.ok && first.checkout.created).toBe(true);
    expect(second.ok && second.checkout.created).toBe(false);
    expect(first.ok && second.ok && first.checkout.repositoryRoot === second.checkout.repositoryRoot)
      .toBe(true);
  });

  it("binds a new checkpoint to a new HEAD without disturbing the approval bound to the old one", async () => {
    const product = createProductRepository();
    const binding = managedBinding(product.root);
    const boundary = makeBoundary();
    const databaseRoot = disposableRoot("chanter-binding-db-");
    const { service } = openService({
      databasePath: path.join(databaseRoot, "operator.sqlite"),
      boundary,
      approvalAuthority: binding.configuration,
    });

    const first = await service.createScheduleMission(scheduleInput());
    const firstCompleted = await service.approveAndExecute(first.missionId, APPROVER);
    expect(firstCompleted.status).toBe("succeeded");

    const secondHead = advanceProductHead(product.root);
    expect(secondHead).not.toBe(product.head);

    const second = await service.createScheduleMission(
      scheduleInput({ caption: "Second revision proof" }),
    );
    const secondCompleted = await service.approveAndExecute(second.missionId, APPROVER);
    expect(secondCompleted.status).toBe("succeeded");

    const store = createDurableIdempotencyStore({ stateDir: binding.stateDir });
    expect(store.getApprovalCheckpointManifest(first.missionId)?.expectedHead).toBe(product.head);
    expect(store.getApprovalCheckpointManifest(second.missionId)?.expectedHead).toBe(secondHead);
    expect(boundary.scheduleCalls).toHaveLength(2);
    expect(adapterStarts(binding.stateDir, first.missionId)).toBe(1);
    expect(adapterStarts(binding.stateDir, second.missionId)).toBe(1);
  });

  it("refuses every form of tampering with the published checkout", async () => {
    const tamperings: Array<[string, (checkout: string) => void, string]> = [
      [
        "tracked file",
        (checkout) => writeFileSync(path.join(checkout, "product.txt"), "tampered\n", "utf8"),
        "RUNTIME_REPOSITORY_TRACKED_DIRTY",
      ],
      [
        "untracked file",
        (checkout) => writeFileSync(path.join(checkout, "injected.txt"), "tampered\n", "utf8"),
        "RUNTIME_REPOSITORY_UNTRACKED_DIRTY",
      ],
      [
        "ignored file",
        (checkout) => {
          mkdirSync(path.join(checkout, "dist"), { recursive: true });
          writeFileSync(path.join(checkout, "dist", "bundle.js"), "tampered\n", "utf8");
        },
        "RUNTIME_REPOSITORY_UNTRACKED_DIRTY",
      ],
      [
        "git HEAD",
        (checkout) => {
          writeFileSync(path.join(checkout, "extra.txt"), "second commit\n", "utf8");
          git(checkout, ["add", "--", "extra.txt"]);
          git(checkout, ["-c", "user.name=T", "-c", "user.email=t@invalid.local", "commit", "--quiet", "-m", "tamper"]);
        },
        "RUNTIME_REPOSITORY_HEAD_MISMATCH",
      ],
    ];

    for (const [label, tamper, expectedCode] of tamperings) {
      const product = createProductRepository();
      const binding = managedBinding(product.root);
      const boundary = makeBoundary();
      const { service, executor } = openService({
        databasePath: path.join(disposableRoot("chanter-binding-db-"), "operator.sqlite"),
        boundary,
        approvalAuthority: binding.configuration,
      });

      const created = await service.createScheduleMission(scheduleInput());
      // Publish authority against the pristine checkout first, so the tampering
      // below happens between a valid approval and the authoritative guard.
      const prepared = await executor.prepareApproval(service.runtimeRequestFor(created.missionId), {
        approverId: APPROVER,
        observedAt: new Date().toISOString(),
      });
      expect(prepared.ok, label).toBe(true);

      tamper(approvalCheckoutPath(binding.checkoutRoot, product.root, product.head));

      const refused = await service.approveAndExecute(created.missionId, APPROVER);
      // The Runtime guard names the exact reason; Operator only reports it.
      expect(refused.runtimeResult?.errors[0]?.code, label).toBe(expectedCode);
      expect(refused.status, label).not.toBe("succeeded");
      expect(boundary.scheduleCalls, label).toHaveLength(0);
      expect(adapterStarts(binding.stateDir, created.missionId), label).toBe(0);
    }
  });

  it("fails closed on every invalid binding configuration", async () => {
    const product = createProductRepository();
    const missingSource = path.join(disposableRoot("chanter-binding-missing-"), "absent-repo");
    const nonRepository = disposableRoot("chanter-binding-nonrepo-");
    // A real repository that has no commit yet: Git works, HEAD does not exist.
    const emptyRepository = disposableRoot("chanter-binding-empty-");
    git(emptyRepository, ["init", "--quiet"]);
    // A checkout root that cannot be created because a file already occupies it.
    const blockedRoot = path.join(disposableRoot("chanter-binding-blocked-"), "occupied");
    writeFileSync(blockedRoot, "not a directory\n", "utf8");

    const cases: Array<[string, OperatorApprovalAuthorityConfiguration, string]> = [
      ["missing source repository", {
        stateDir: disposableRoot("chanter-binding-state-"),
        managedCheckout: { sourceRepositoryRoot: missingSource, checkoutRoot: disposableRoot("chanter-binding-checkout-") },
      }, "OPERATOR_APPROVAL_CHECKOUT_SOURCE_UNAVAILABLE"],
      ["non-Git source directory", {
        stateDir: disposableRoot("chanter-binding-state-"),
        managedCheckout: { sourceRepositoryRoot: nonRepository, checkoutRoot: disposableRoot("chanter-binding-checkout-") },
      }, "OPERATOR_APPROVAL_CHECKOUT_SOURCE_HEAD_UNAVAILABLE"],
      ["relative source path", {
        stateDir: disposableRoot("chanter-binding-state-"),
        managedCheckout: { sourceRepositoryRoot: "relative/path", checkoutRoot: disposableRoot("chanter-binding-checkout-") },
      }, "OPERATOR_APPROVAL_CHECKOUT_SOURCE_INVALID"],
      ["relative checkout root", {
        stateDir: disposableRoot("chanter-binding-state-"),
        managedCheckout: { sourceRepositoryRoot: product.root, checkoutRoot: "relative/cache" },
      }, "OPERATOR_APPROVAL_CHECKOUT_ROOT_INVALID"],
      ["source repository with no committed HEAD", {
        stateDir: disposableRoot("chanter-binding-state-"),
        managedCheckout: { sourceRepositoryRoot: emptyRepository, checkoutRoot: disposableRoot("chanter-binding-checkout-") },
      }, "OPERATOR_APPROVAL_CHECKOUT_SOURCE_HEAD_UNAVAILABLE"],
      ["uncreatable checkout root", {
        stateDir: disposableRoot("chanter-binding-state-"),
        managedCheckout: { sourceRepositoryRoot: product.root, checkoutRoot: blockedRoot },
      }, "OPERATOR_APPROVAL_CHECKOUT_ROOT_UNWRITABLE"],
      ["no binding configured", {
        stateDir: disposableRoot("chanter-binding-state-"),
      }, "OPERATOR_APPROVAL_BINDING_NOT_CONFIGURED"],
      ["both bindings configured", {
        stateDir: disposableRoot("chanter-binding-state-"),
        repositoryRoot: product.root,
        managedCheckout: { sourceRepositoryRoot: product.root, checkoutRoot: disposableRoot("chanter-binding-checkout-") },
      }, "OPERATOR_APPROVAL_BINDING_NOT_CONFIGURED"],
    ];

    for (const [label, approvalAuthority, code] of cases) {
      const boundary = makeBoundary();
      const { service } = openService({
        databasePath: path.join(disposableRoot("chanter-binding-db-"), "operator.sqlite"),
        boundary,
        approvalAuthority,
      });
      const created = await service.createScheduleMission(scheduleInput());
      const refused = await service.approveAndExecute(created.missionId, APPROVER);
      expect(refused.status, label).toBe("failed");
      expect(refused.runtimeResult?.errors[0]?.code, label).toBe(code);
      expect(boundary.scheduleCalls, label).toHaveLength(0);
      expect(adapterStarts(approvalAuthority.stateDir, created.missionId), label).toBe(0);
    }
  });

  it("still refuses a live product repository bound directly", async () => {
    const product = createProductRepository();
    const stateDir = disposableRoot("chanter-binding-state-");
    const boundary = makeBoundary();
    const { service } = openService({
      databasePath: path.join(disposableRoot("chanter-binding-db-"), "operator.sqlite"),
      boundary,
      approvalAuthority: { stateDir, repositoryRoot: product.root, ownerId: "binding-test-owner" },
    });

    const created = await service.createScheduleMission(scheduleInput());
    const refused = await service.approveAndExecute(created.missionId, APPROVER);

    // This is the deployment blocker itself, still fail-closed and unchanged:
    // managed mode removes the need for it, it does not weaken the policy.
    expect(refused.runtimeResult?.errors[0]?.code).toBe("RUNTIME_REPOSITORY_TRACKED_DIRTY");
    expect(refused.status).not.toBe("succeeded");
    expect(boundary.scheduleCalls).toHaveLength(0);
    expect(adapterStarts(stateDir, created.missionId)).toBe(0);
  });

  it("survives restart, and refuses once the published checkout is deleted", async () => {
    const product = createProductRepository();
    const binding = managedBinding(product.root);
    const boundary = makeBoundary();
    const databasePath = path.join(disposableRoot("chanter-binding-db-"), "operator.sqlite");

    const first = openService({ databasePath, boundary, approvalAuthority: binding.configuration });
    const created = await first.service.createScheduleMission(scheduleInput());
    const completed = await first.service.approveAndExecute(created.missionId, APPROVER);
    expect(completed.status).toBe("succeeded");
    first.database.close();

    // Restart with the checkout intact: durable replay, no second execution.
    const restarted = openService({ databasePath, boundary, approvalAuthority: binding.configuration });
    const replayed = await restarted.service.approveAndExecute(created.missionId, APPROVER);
    expect(replayed.execution?.state).toBe("completed");
    expect(boundary.scheduleCalls).toHaveLength(1);
    expect(adapterStarts(binding.stateDir, created.missionId)).toBe(1);
    restarted.database.close();

    // A *new* mission after the checkout is deleted must not reuse the revoked
    // identity: the rebuilt checkout is a different repository to the Runtime.
    const checkout = approvalCheckoutPath(binding.checkoutRoot, product.root, product.head);
    rmSync(checkout, { recursive: true, force: true });
    const afterDeletion = openService({ databasePath, boundary, approvalAuthority: binding.configuration });
    const fresh = await afterDeletion.service.createScheduleMission(
      scheduleInput({ caption: "After checkout deletion" }),
    );
    const freshCompleted = await afterDeletion.service.approveAndExecute(fresh.missionId, APPROVER);
    // Reconstruction is allowed for a brand new checkpoint; it simply mints a
    // new repository identity, which nothing older can match.
    expect(freshCompleted.status).toBe("succeeded");
    const store = createDurableIdempotencyStore({ stateDir: binding.stateDir });
    expect(store.getApprovalCheckpointManifest(fresh.missionId)?.repositoryId)
      .not.toBe(store.getApprovalCheckpointManifest(created.missionId)?.repositoryId);
  });

  it("leaves no partial checkout adoptable and publishes exactly one under concurrency", async () => {
    const product = createProductRepository();
    const binding = managedBinding(product.root);
    const managed = binding.configuration.managedCheckout!;

    // Concurrent resolution of the same revision.
    const outcomes = await Promise.all(
      Array.from({ length: 4 }, async () => resolveApprovalAuthorityCheckout(managed)),
    );
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    const roots = new Set(outcomes.map((outcome) => (outcome.ok ? outcome.checkout.repositoryRoot : "")));
    expect(roots.size).toBe(1);

    const published = approvalCheckoutPath(binding.checkoutRoot, product.root, product.head);
    expect(git(published, ["status", "--porcelain", "--untracked-files=all", "--ignored=matching"]))
      .toBe("");
    // Scratch build directories are never adoptable as authority.
    const siblings = readdirSync(path.dirname(published));
    expect(siblings.filter((entry) => entry.startsWith(".building-"))).toEqual([]);
    expect(siblings).toEqual([product.head]);
  });
});
