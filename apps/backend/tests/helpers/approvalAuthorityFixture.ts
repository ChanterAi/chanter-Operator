/**
 * Controlled persisted-approval-authority binding for Operator tests.
 *
 * The Runtime binds every approval to a real repository identity, an exact
 * committed HEAD, and a strictly clean worktree. Tests therefore need a real
 * Git checkout — one disposable repository is created per test process and
 * shared, because it is only ever inspected, never written to.
 *
 * Each fixture gets its own durable state directory, so mission claims,
 * checkpoints, observations, and run ledgers never leak between tests.
 */
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { OperatorApprovalAuthorityConfiguration } from "../../src/runtimeMissions/persistedApprovalAuthority.js";

const disposableRoots: string[] = [];
let sharedRepositoryRoot: string | null = null;

export const TEST_ISSUER_AUTHORITY_ID = "chanter.operator.test-authority";
export const TEST_ISSUER_KEY_ID = "operator-test-key-1";

interface DisposableIssuer {
  authorityId: string;
  keyId: string;
  privateKeyFile: string;
  publicKeyPem: string;
}

let sharedIssuer: DisposableIssuer | null = null;

/**
 * A disposable Ed25519 signing identity for tests, written to a temp file
 * exactly the way a deployment supplies one. The key is generated per test
 * process and never committed.
 */
function disposableIssuer(): DisposableIssuer {
  if (sharedIssuer) return sharedIssuer;
  const root = createDisposableRoot("chanter-operator-approval-issuer-");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateKeyFile = path.join(root, "issuer.key.pem");
  writeFileSync(
    privateKeyFile,
    privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    { encoding: "utf8", mode: 0o600 },
  );
  sharedIssuer = {
    authorityId: TEST_ISSUER_AUTHORITY_ID,
    keyId: TEST_ISSUER_KEY_ID,
    privateKeyFile,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  return sharedIssuer;
}

/** Writes the Runtime's explicit trust file; only public material is written. */
function trustedIssuersFileFor(
  issuer: DisposableIssuer,
  authorizedPolicyIds: readonly string[],
): string {
  const root = createDisposableRoot("chanter-operator-approval-trust-");
  const file = path.join(root, "trusted-issuers.json");
  writeFileSync(file, JSON.stringify({
    issuers: [{
      authorityId: issuer.authorityId,
      authorizedPolicyIds,
      keys: [{ keyId: issuer.keyId, publicKey: issuer.publicKeyPem }],
    }],
  }), "utf8");
  return file;
}

/** The approval policy id Operator's seam mints by default. */
export const TEST_AUTHORIZED_POLICY_IDS = ["chanter.operator.human-approval.v1"] as const;

export function testIssuerPublicKeyPem(): string {
  return disposableIssuer().publicKeyPem;
}

function git(repositoryRoot: string, args: readonly string[]): void {
  execFileSync("git", ["-C", repositoryRoot, ...args], {
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
}

function createDisposableRoot(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  disposableRoots.push(root);
  return root;
}

/**
 * One clean committed checkout, reused by every fixture in this process. It
 * must stay free of untracked *and* ignored files: the Runtime's clean-state
 * policy is `tracked_and_untracked` and refuses either.
 */
export function approvalAuthorityRepositoryRoot(): string {
  if (sharedRepositoryRoot) return sharedRepositoryRoot;
  const repositoryRoot = createDisposableRoot("chanter-operator-approval-repo-");
  git(repositoryRoot, ["init", "--quiet"]);
  git(repositoryRoot, ["config", "user.name", "CHANTER Operator Tests"]);
  git(repositoryRoot, ["config", "user.email", "operator-tests@invalid.local"]);
  git(repositoryRoot, ["config", "commit.gpgsign", "false"]);
  writeFileSync(path.join(repositoryRoot, "APPROVAL_AUTHORITY.md"), "approval authority fixture\n", "utf8");
  git(repositoryRoot, ["add", "--", "APPROVAL_AUTHORITY.md"]);
  git(repositoryRoot, ["commit", "--quiet", "-m", "approval authority fixture"]);
  sharedRepositoryRoot = repositoryRoot;
  return repositoryRoot;
}

/** A fresh durable authority binding bound to the shared clean checkout. */
export function approvalAuthorityFixture(
  overrides: Partial<OperatorApprovalAuthorityConfiguration> = {},
): OperatorApprovalAuthorityConfiguration {
  const issuer = disposableIssuer();
  return {
    stateDir: createDisposableRoot("chanter-operator-approval-state-"),
    repositoryRoot: approvalAuthorityRepositoryRoot(),
    ownerId: "operator-test-owner",
    issuer: {
      authorityId: issuer.authorityId,
      keyId: issuer.keyId,
      privateKeyFile: issuer.privateKeyFile,
    },
    trustedIssuersFile: trustedIssuersFileFor(issuer, TEST_AUTHORIZED_POLICY_IDS),
    ...overrides,
  };
}

const fixturesByKey = new Map<string, OperatorApprovalAuthorityConfiguration>();

/**
 * Stable binding for one durable mission universe, keyed by (usually) the
 * SQLite path. A "restart" that rebuilds services against the same database
 * must see the same persisted checkpoints, observations, and claims — a fresh
 * state directory would silently hide exactly the restart behavior under test.
 */
export function approvalAuthorityFixtureFor(
  key: string,
  overrides: Partial<OperatorApprovalAuthorityConfiguration> = {},
): OperatorApprovalAuthorityConfiguration {
  const existing = fixturesByKey.get(key);
  if (existing) return existing;
  const created = approvalAuthorityFixture(overrides);
  fixturesByKey.set(key, created);
  return created;
}

/** Points at a real directory that is not a Git worktree, so authority refuses. */
export function nonRepositoryApprovalAuthorityFixture(): OperatorApprovalAuthorityConfiguration {
  return approvalAuthorityFixture({
    repositoryRoot: createDisposableRoot("chanter-operator-approval-norepo-"),
  });
}

export function cleanupApprovalAuthorityFixtures(): void {
  fixturesByKey.clear();
  sharedIssuer = null;
  while (disposableRoots.length > 0) {
    const root = disposableRoots.pop();
    if (!root) continue;
    if (root === sharedRepositoryRoot) sharedRepositoryRoot = null;
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // A disposable temp root that Windows still holds open is inert.
    }
  }
}
