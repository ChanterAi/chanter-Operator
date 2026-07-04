import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";

export class WorkspacePathError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspacePathError";
  }
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

export function ensureWorkspace(workspaceRoot: string): string {
  const root = path.resolve(workspaceRoot);
  mkdirSync(root, { recursive: true });
  return realpathSync.native(root);
}

export function resolveWorkspacePath(workspaceRoot: string, candidate: string): string {
  if (!candidate.trim()) {
    throw new WorkspacePathError("Workspace path is required.");
  }
  if (path.isAbsolute(candidate)) {
    throw new WorkspacePathError("Workspace paths must be relative.");
  }

  let root: string;
  try {
    root = realpathSync.native(path.resolve(workspaceRoot));
  } catch (cause) {
    throw new WorkspacePathError("The local workspace could not be verified.", { cause });
  }
  const resolved = path.resolve(root, candidate);
  if (!isContained(root, resolved)) {
    throw new WorkspacePathError("Workspace path must remain inside the local workspace.");
  }

  // Resolve the deepest existing ancestor. This catches directory symlinks and
  // Windows junctions even when the requested leaf does not exist yet.
  let existingAncestor = resolved;
  while (isContained(root, existingAncestor)) {
    try {
      lstatSync(existingAncestor);
      break;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new WorkspacePathError("Workspace path could not be verified safely.", { cause });
      }
      if (existingAncestor === root) {
        throw new WorkspacePathError("The local workspace could not be verified.");
      }
      existingAncestor = path.dirname(existingAncestor);
    }
  }

  let canonicalAncestor: string;
  try {
    canonicalAncestor = realpathSync.native(existingAncestor);
  } catch (cause) {
    throw new WorkspacePathError("Workspace path contains an unreadable or broken link.", { cause });
  }
  if (!isContained(root, canonicalAncestor)) {
    throw new WorkspacePathError("Workspace path must not traverse a link outside the local workspace.");
  }

  return resolved;
}
