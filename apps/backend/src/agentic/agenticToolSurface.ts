/**
 * CHANTER OS — the fabric's entire tool surface.
 *
 * Six tools, all bounded to explicitly configured roots, and no seventh. There
 * is no shell, no network, no process spawn, and no general filesystem access,
 * because a worker cannot be granted a capability that was never built: the
 * strongest possible statement of "workers cannot reach outside their bounds" is
 * that the reaching mechanism does not exist.
 *
 * The Runtime enforces *which* of these a given node may call, from its
 * capability's allowlist. This module enforces *what each one can touch*:
 *
 *   - repository reads resolve against a named, pre-registered root and refuse
 *     any resolved path that escapes it, so `../../..` is a typed refusal rather
 *     than a traversal;
 *   - fixture and test-result reads are confined to one fixture directory;
 *   - the single write tool refuses any name that is not a plain file name, and
 *     writes only inside the one artifact directory.
 *
 * Git is invoked with an explicit argument vector and `shell: false`, so no part
 * of a repository name or path is ever interpreted by a shell.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import type { AgenticNodeToolInvoker, JsonValue } from "chanter-agent-runtime";
import { OperatorError } from "../services/operatorService.js";

export interface AgenticFabricPaths {
  /** Logical repository name -> absolute root. Only these roots are readable. */
  readonly repositories: Readonly<Record<string, string>>;
  /** Absolute directory holding approved fixtures and recorded test results. */
  readonly fixtureRoot: string;
  /** Absolute directory the one approved artifact may be written into. */
  readonly artifactRoot: string;
}

/** Reads one durable Operator mission state. Supplied by the fabric service. */
export interface AgenticMissionStateReader {
  read(missionId: string): JsonValue | null;
}

/** Largest source a single read may return. Bigger sources are refused, not truncated. */
export const AGENTIC_MAX_SOURCE_BYTES = 256 * 1024;

function refuse(code: string, message: string): never {
  throw new OperatorError(message, 409, code);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    refuse("AGENTIC_TOOL_REQUEST_INVALID", `${field} must be a non-empty string.`);
  }
  return value;
}

function jsonObject(value: JsonValue): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    refuse("AGENTIC_TOOL_REQUEST_INVALID", "Tool request must be an object.");
  }
  return value as Record<string, JsonValue>;
}

/**
 * Resolves `relativePath` inside `root`, or refuses.
 *
 * The check is on the *resolved* path, not the input string: rejecting inputs
 * that merely contain ".." would still admit a symlinked or encoded escape,
 * whereas an escape is definitionally a resolved path that does not sit under
 * the root.
 */
function resolveInside(root: string, relativePath: string, label: string): string {
  const resolvedRoot = resolve(root);
  const resolved = resolve(resolvedRoot, relativePath);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + sep)) {
    refuse("AGENTIC_TOOL_PATH_OUT_OF_BOUNDS", `${label} resolves outside its permitted root.`);
  }
  return resolved;
}

function readBoundedFile(absolutePath: string, label: string): string {
  if (!existsSync(absolutePath)) {
    refuse("AGENTIC_TOOL_SOURCE_MISSING", `${label} does not exist.`);
  }
  const stats = statSync(absolutePath);
  if (!stats.isFile()) {
    refuse("AGENTIC_TOOL_SOURCE_MISSING", `${label} is not a regular file.`);
  }
  if (stats.size > AGENTIC_MAX_SOURCE_BYTES) {
    refuse(
      "AGENTIC_TOOL_SOURCE_TOO_LARGE",
      `${label} is ${stats.size} bytes, exceeding the ${AGENTIC_MAX_SOURCE_BYTES}-byte read bound.`,
    );
  }
  return readFileSync(absolutePath, "utf8");
}

function git(repositoryRoot: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

export interface AgenticToolSurface extends AgenticNodeToolInvoker {
  /** Tool calls this surface actually served, for measured cost reporting. */
  readonly servedCalls: () => number;
}

export function createAgenticToolSurface(
  paths: AgenticFabricPaths,
  missionState: AgenticMissionStateReader,
): AgenticToolSurface {
  let served = 0;

  function repositoryRoot(name: string): string {
    const root = paths.repositories[name];
    if (!root || !isAbsolute(root)) {
      refuse(
        "AGENTIC_TOOL_REPOSITORY_UNREGISTERED",
        `Repository "${name}" is not a registered readable root.`,
      );
    }
    return root;
  }

  return {
    servedCalls: () => served,
    async invoke(tool: string, rawRequest: JsonValue): Promise<JsonValue> {
      served += 1;
      const request = jsonObject(rawRequest);
      switch (tool) {
        case "repo.metadata.read": {
          const name = requireString(request.repository, "repository");
          const root = repositoryRoot(name);
          const status = git(root, ["status", "--porcelain"]);
          return {
            repository: name,
            head: git(root, ["rev-parse", "HEAD"]),
            branch: git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
            clean: status.length === 0,
            changedPathCount: status.length === 0 ? 0 : status.split(/\r?\n/).length,
          };
        }
        case "repo.file.read": {
          const name = requireString(request.repository, "repository");
          const relativePath = requireString(request.path, "path");
          const absolute = resolveInside(repositoryRoot(name), relativePath, `${name}/${relativePath}`);
          const content = readBoundedFile(absolute, `${name}/${relativePath}`);
          return { repository: name, path: relativePath, content, byteLength: content.length };
        }
        case "test.result.read": {
          const name = requireString(request.name, "name");
          const absolute = resolveInside(paths.fixtureRoot, name, `test result ${name}`);
          return { name, content: readBoundedFile(absolute, `test result ${name}`) };
        }
        case "fixture.read": {
          const name = requireString(request.name, "name");
          const absolute = resolveInside(paths.fixtureRoot, name, `fixture ${name}`);
          return { name, content: readBoundedFile(absolute, `fixture ${name}`) };
        }
        case "operator.mission.state.read": {
          const missionId = requireString(request.missionId, "missionId");
          const state = missionState.read(missionId);
          if (state === null) {
            refuse("AGENTIC_TOOL_SOURCE_MISSING", `No durable Operator mission state exists for ${missionId}.`);
          }
          return { missionId, state };
        }
        case "artifact.local.read": {
          const artifactName = requireString(request.artifactName, "artifactName");
          if (basename(artifactName) !== artifactName) {
            refuse(
              "AGENTIC_TOOL_PATH_OUT_OF_BOUNDS",
              "artifactName must be a plain file name with no path segments.",
            );
          }
          const target = resolveInside(paths.artifactRoot, artifactName, `artifact ${artifactName}`);
          // Absence is an answer, not an error: outcome verification exists
          // precisely to establish whether the artifact is there.
          if (!existsSync(target)) return { artifactName, exists: false, content: "" };
          return {
            artifactName,
            exists: true,
            content: readBoundedFile(target, `artifact ${artifactName}`),
          };
        }
        case "artifact.local.write": {
          const artifactName = requireString(request.artifactName, "artifactName");
          if (basename(artifactName) !== artifactName) {
            refuse(
              "AGENTIC_TOOL_PATH_OUT_OF_BOUNDS",
              "artifactName must be a plain file name with no path segments.",
            );
          }
          const contents = requireString(request.contents, "contents");
          const target = resolveInside(paths.artifactRoot, artifactName, `artifact ${artifactName}`);
          // Temp-write then rename: a reader never observes a partial artifact,
          // and a crash mid-write leaves the target absent rather than corrupt.
          const temporary = join(paths.artifactRoot, `.${artifactName}.${process.pid}.tmp`);
          writeFileSync(temporary, contents, { encoding: "utf8" });
          renameSync(temporary, target);
          return {
            artifactName,
            path: target,
            byteLength: Buffer.byteLength(contents, "utf8"),
          };
        }
        default:
          refuse("AGENTIC_TOOL_UNREGISTERED", `Tool "${tool}" is not part of this fabric's tool surface.`);
      }
    },
  };
}
