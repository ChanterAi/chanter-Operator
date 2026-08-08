/**
 * Managed approval-authority checkouts.
 *
 * A live product repository normally carries ignored and untracked operational
 * files — `node_modules/`, `dist/`, `.env`, logs — and the Runtime's canonical
 * clean-state policy (`tracked_and_untracked`, evaluated with
 * `--ignored=matching`) correctly refuses every one of them. Binding approval
 * authority directly to that checkout therefore leaves approval-required
 * execution permanently fail-closed.
 *
 * This module removes that blocker without touching the Runtime contract: it
 * derives an *isolated* checkout of one exact committed revision, containing
 * only tracked content, and hands that path to the Runtime. The Runtime remains
 * the sole judge of repository identity, committed HEAD, and clean state — this
 * module never inspects, asserts, or approximates any of those decisions.
 *
 * Three properties do the real work:
 *
 *  1. **The source repository is only ever read.** A local clone reads the
 *     object database and refs; it never writes to the product repository.
 *     `git worktree add` would instead register state inside the product
 *     repository's `.git`, where an unrelated `git worktree prune` could
 *     silently invalidate live approval authority.
 *
 *  2. **A published checkout is immutable and is never repaired.** The
 *     Runtime's `repositoryId` hashes the device and inode of the checkout, so
 *     rebuilding it — even byte-identically, even at the same path — produces a
 *     *different* repository identity that no existing approval can match.
 *     Silent repair would therefore either break live approvals or mask
 *     tampering. A damaged checkout is left exactly as it is, and the Runtime
 *     guard refuses it.
 *
 *  3. **Publication is an atomic rename, so there is no lock.** Each caller
 *     builds into its own temporary directory and renames it into place. The
 *     first writer wins; every loser detects the existing directory and adopts
 *     it. There is no lock file, no stale-lock recovery, and no unbounded wait.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

const CHECKOUT_KEY_HASH_DOMAIN = "chanter-operator-approval-authority-checkout-v1";
const GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const BUILD_PREFIX = ".building-";

export interface ManagedApprovalCheckoutConfiguration {
  /** The live product repository. Read only, never written to. */
  sourceRepositoryRoot: string;
  /** Durable root that owns published per-revision authority checkouts. */
  checkoutRoot: string;
}

export interface ResolvedApprovalCheckout {
  /** The isolated checkout the Runtime will inspect. */
  repositoryRoot: string;
  /** The exact committed revision it is checked out at. */
  head: string;
  sourceRepositoryRoot: string;
  /** True when this call published it; false when an existing one was adopted. */
  created: boolean;
}

export type ApprovalCheckoutOutcome =
  | { ok: true; checkout: ResolvedApprovalCheckout }
  | { ok: false; code: string; message: string };

function refusal(code: string, message: string): ApprovalCheckoutOutcome {
  return { ok: false, code, message };
}

/**
 * Read-only Git with a sanitized environment. Inherited `GIT_*` variables can
 * redirect the repository, index, or object database even when `-C` names the
 * right path, so none of them may participate in resolving authority.
 */
function git(args: readonly string[]): string {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase().startsWith("GIT_")) delete environment[key];
  }
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.LC_ALL = "C";
  return execFileSync("git", args, {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    env: environment,
  }).trim();
}

function isRealDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * One directory per (source repository, exact committed revision). The commit
 * id is content-addressed, so the same key can only ever name the same tree.
 * The source part is hashed so no caller-supplied byte reaches the filesystem
 * as a path segment.
 */
function sourceKey(sourceRepositoryRoot: string): string {
  return createHash("sha256")
    .update(`${CHECKOUT_KEY_HASH_DOMAIN}\n${normalize(sourceRepositoryRoot).toLowerCase()}`, "utf8")
    .digest("hex");
}

export function approvalCheckoutPath(
  checkoutRoot: string,
  sourceRepositoryRoot: string,
  head: string,
): string {
  return join(checkoutRoot, sourceKey(sourceRepositoryRoot), head);
}

/**
 * Resolves the isolated authority checkout for the source repository's current
 * committed HEAD, publishing it if it does not exist yet.
 *
 * Every failure is returned typed rather than thrown, so the calling seam
 * records a truthful refusal and the mission stays fail-closed.
 */
export function resolveApprovalAuthorityCheckout(
  configuration: ManagedApprovalCheckoutConfiguration,
): ApprovalCheckoutOutcome {
  const sourceRepositoryRoot = configuration.sourceRepositoryRoot.trim();
  const checkoutRoot = configuration.checkoutRoot.trim();
  if (!sourceRepositoryRoot || !isAbsolute(sourceRepositoryRoot)) {
    return refusal(
      "OPERATOR_APPROVAL_CHECKOUT_SOURCE_INVALID",
      "The approval authority source repository must be configured as an absolute path.",
    );
  }
  if (!checkoutRoot || !isAbsolute(checkoutRoot)) {
    return refusal(
      "OPERATOR_APPROVAL_CHECKOUT_ROOT_INVALID",
      "The approval authority checkout root must be configured as an absolute path.",
    );
  }
  if (!isRealDirectory(sourceRepositoryRoot)) {
    return refusal(
      "OPERATOR_APPROVAL_CHECKOUT_SOURCE_UNAVAILABLE",
      "The approval authority source repository directory is unavailable.",
    );
  }

  let head: string;
  try {
    head = git(["-C", sourceRepositoryRoot, "rev-parse", "--verify", "HEAD^{commit}"]);
  } catch {
    return refusal(
      "OPERATOR_APPROVAL_CHECKOUT_SOURCE_HEAD_UNAVAILABLE",
      "The approval authority source repository has no readable committed HEAD.",
    );
  }
  if (!GIT_OBJECT_ID_PATTERN.test(head)) {
    return refusal(
      "OPERATOR_APPROVAL_CHECKOUT_SOURCE_HEAD_UNAVAILABLE",
      "The approval authority source repository reported a malformed committed HEAD.",
    );
  }

  const revisionRoot = join(checkoutRoot, sourceKey(sourceRepositoryRoot));
  const published = join(revisionRoot, head);
  // An existing published checkout is adopted exactly as it is. It is never
  // inspected, repaired, or refreshed here: repairing would mint a new
  // repository identity, and validating it would duplicate the Runtime guard.
  if (existsSync(published)) {
    return isRealDirectory(published)
      ? { ok: true, checkout: { repositoryRoot: published, head, sourceRepositoryRoot, created: false } }
      : refusal(
        "OPERATOR_APPROVAL_CHECKOUT_PUBLISHED_UNSAFE",
        "The published approval authority checkout path exists but is not a real directory.",
      );
  }

  try {
    mkdirSync(revisionRoot, { recursive: true, mode: 0o700 });
  } catch {
    return refusal(
      "OPERATOR_APPROVAL_CHECKOUT_ROOT_UNWRITABLE",
      "The approval authority checkout root could not be created or is not writable.",
    );
  }

  // Built out of the way, so a crash can only ever leave inert scratch state —
  // never a partially populated checkout that could be adopted as authority.
  const building = join(revisionRoot, `${BUILD_PREFIX}${randomUUID()}`);
  try {
    // `--local` shares the object database by hard link where the filesystem
    // allows it, and `--no-checkout` keeps the default branch from ever being
    // materialized: only the exact requested revision is.
    git(["clone", "--local", "--no-checkout", "--quiet", sourceRepositoryRoot, building]);
    git(["-C", building, "checkout", "--detach", "--quiet", head]);
    const builtHead = git(["-C", building, "rev-parse", "--verify", "HEAD^{commit}"]);
    if (builtHead !== head) {
      throw new Error("built checkout does not match the requested revision");
    }
  } catch (error) {
    rmSync(building, { recursive: true, force: true });
    return refusal(
      "OPERATOR_APPROVAL_CHECKOUT_BUILD_FAILED",
      `The isolated approval authority checkout could not be built: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  try {
    renameSync(building, published);
  } catch {
    // Either another process published this exact revision first, or the
    // rename failed outright. The published directory decides which.
    rmSync(building, { recursive: true, force: true });
    if (isRealDirectory(published)) {
      return { ok: true, checkout: { repositoryRoot: published, head, sourceRepositoryRoot, created: false } };
    }
    return refusal(
      "OPERATOR_APPROVAL_CHECKOUT_PUBLISH_FAILED",
      "The isolated approval authority checkout could not be published atomically.",
    );
  }
  return { ok: true, checkout: { repositoryRoot: published, head, sourceRepositoryRoot, created: true } };
}
