/**
 * CHANTER OS — resolves the committed revision a candidate approval binds to.
 *
 * Read once at startup, from the same repository the persisted approval
 * authority already uses. Binding an approval to a revision is what lets a
 * reader later ask "what did this deployment look like when a human authorized
 * this write?" and get an answer that is checkable rather than remembered.
 *
 * An unreadable or unconfigured repository yields `null`, and the OS authority
 * view then reports the approval as untrusted rather than inventing a revision.
 * A fabricated binding would be strictly worse than an absent one: it would look
 * exactly like a real one to every consumer.
 */
import { execFileSync } from "node:child_process";
import { isAbsolute } from "node:path";

export function resolveAgenticAuthorityRevision(repositoryRoot: string): string | null {
  const root = repositoryRoot.trim();
  if (!root || !isAbsolute(root)) return null;
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    }).trim() || null;
  } catch {
    // Not a repository, or git is unavailable. Reported as absent.
    return null;
  }
}
