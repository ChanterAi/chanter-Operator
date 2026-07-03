import { mkdirSync } from "node:fs";
import path from "node:path";

export function ensureWorkspace(workspaceRoot: string): string {
  const root = path.resolve(workspaceRoot);
  mkdirSync(root, { recursive: true });
  return root;
}

export function resolveWorkspacePath(workspaceRoot: string, candidate: string): string {
  if (!candidate.trim()) {
    throw new Error("Workspace path is required.");
  }
  if (path.isAbsolute(candidate)) {
    throw new Error("Workspace paths must be relative.");
  }

  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);

  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Workspace path must remain inside the local workspace.");
  }

  return resolved;
}

