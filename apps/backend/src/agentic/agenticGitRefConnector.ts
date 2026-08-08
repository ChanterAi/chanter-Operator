/**
 * CHANTER OS — real read-only connector: git remote ref state.
 *
 * Observes a genuine external system — a hosted git remote — and cannot change
 * it. It is the first connector in this fabric pointed at something CHANTER does
 * not own the storage for.
 *
 * ## Why a git remote is the right first real source
 *
 * It meets every requirement a shadow binding needs, and meets the hardest one
 * unusually well:
 *
 *   - **stable object identity** — `<remote-url>#<ref-path>` names one thing
 *     forever;
 *   - **revision semantics** — the commit SHA is *content-addressed*. Most
 *     systems offer a version counter or an `updated_at` that can repeat, drift,
 *     or lie; a git SHA cannot name two different states. It is the strongest
 *     freshness marker available anywhere in this codebase;
 *   - **independent re-read** — asking twice is free and side-effect free;
 *   - **no user data** — a ref advertisement is a list of names and hashes.
 *
 * And the exception it surfaces is real rather than invented: every CHANTER P0
 * ends with reviewed work committed locally and **not** pushed, so "the remote
 * does not carry the reviewed HEAD" is this system's actual standing condition.
 * The action that resolves it is a ref update, which is exactly the real external
 * write the next slice must gate. Here it is compiled and never performed.
 *
 * ## The write is structurally absent, not disabled
 *
 * This connector exposes **no `apply` method at all**. Not a guarded one, not one
 * that throws — the property is absent from the object, so there is nothing to
 * call and no flag whose value could change that. A configured git credential
 * grants this module nothing, because the module contains no code that could use
 * it to write.
 *
 * The second, independent guarantee lives one layer up: an operational-exception
 * mission bound to a connector declaring `writeCapabilitiesEnabled: false`
 * compiles a plan that contains no write node.
 *
 * ## Transport telemetry
 *
 * `git` is invoked with an explicit argument vector and `shell: false`, and every
 * invocation's argv is recorded. The permitted subcommand list is exactly
 * `["ls-remote"]`, checked before spawn. That is a stronger claim than observing
 * HTTP verbs after the fact: a mutating call is not merely unobserved, it is
 * unconstructable — `push`, `send-pack`, and `receive-pack` are not reachable
 * from any code path here.
 */
import { execFileSync } from "node:child_process";
import { OperatorError } from "../services/operatorService.js";
import {
  createObservationHash,
  exceptionFieldsFrom,
  OPERATIONAL_EXCEPTION_SCHEMA_VERSION,
} from "./agenticExceptionContract.js";
import type { ConnectorCapabilityManifest, ConnectorRecord } from "./agenticSimulatedConnector.js";

export const GIT_REF_CONNECTOR_ID = "connector.git.remote-ref.v1" as const;

/**
 * The write this system has and this connector may not perform.
 *
 * Declared so the compiled ActionContract can name the exact capability a real
 * remediation would use, which is what makes the shadow contract meaningful
 * rather than a placeholder.
 */
export const GIT_REF_UPDATE_CAPABILITY = "ref.update" as const;

/**
 * Git subcommands this connector may ever spawn.
 *
 * An allowlist checked before spawn, not a denylist of dangerous verbs. A
 * denylist would have to anticipate every mutating subcommand git has or will
 * have; this permits exactly one read.
 */
const PERMITTED_GIT_SUBCOMMANDS: readonly string[] = Object.freeze(["ls-remote"]);

export const GIT_REF_CONNECTOR_MANIFEST: ConnectorCapabilityManifest = Object.freeze({
  schemaVersion: OPERATIONAL_EXCEPTION_SCHEMA_VERSION,
  connectorId: GIT_REF_CONNECTOR_ID,
  systemType: "git_remote",
  environment: "real_read_only",
  capabilities: Object.freeze([]),
  readOperations: Object.freeze(["ref.read"]),
  // The system genuinely has this operation. This connector genuinely may not
  // perform it. Both facts are stated, because they are different facts.
  writeCapabilitiesDeclared: Object.freeze([GIT_REF_UPDATE_CAPABILITY]),
  writeCapabilitiesEnabled: false,
  revisionSemantics:
    "content-addressed commit SHA; a changed SHA is a changed state, and one SHA never names two states",
  freshnessSemantics:
    "re-read the remote ref advertisement; equal SHA proves the observed state still holds",
  writeOperations: Object.freeze([]),
  idempotencySemantics:
    "a ref update is idempotent against an expected old SHA (compare-and-swap); not exercised in shadow mode",
  reconciliationSupport: "read_ref_and_compare_sha",
  verificationSupport: "independent_read_only_reread",
  compensationSupport: "none",
  // The field a ref update would change. Declared even though this connector
  // may not perform one, because the shadow ActionContract must name the exact
  // payload a real remediation would carry — a contract that could not say what
  // it would write would prove nothing about compatibility.
  writableFields: Object.freeze(["commitSha"]),
  realExternalWrites: false,
}) as ConnectorCapabilityManifest;

/** One recorded transport invocation, for the write-safety proof. */
export interface GitTransportCall {
  readonly argv: readonly string[];
  readonly at: string;
  readonly ok: boolean;
}

export interface GitRefConnectorOptions {
  /** Absolute path to a repository whose `origin` names the real remote. */
  readonly repositoryRoot: string;
  /** The remote name to observe. Never taken from mission input. */
  readonly remote: string;
  readonly now: () => string;
  readonly timeoutMs?: number;
  /** Injected only so a test can drive read outages without a network. */
  readonly execImpl?: (argv: readonly string[], timeoutMs: number) => string;
}

/**
 * A read-only connector.
 *
 * Deliberately *not* structurally compatible with the write-capable connector
 * port: there is no `apply`, and no `readAction`, because there are no actions.
 * A caller that needs to write cannot accidentally be handed one of these.
 */
export interface GitRefConnector {
  readonly connectorId: string;
  manifest(): ConnectorCapabilityManifest;
  /** The observed ref, or `null` when the remote does not carry it. */
  read(targetId: string): ConnectorRecord | null;
  /** Every transport invocation this connector made, in order. */
  transportCalls(): readonly GitTransportCall[];
  counts(): { readonly reads: number; readonly writes: 0 };
}

function refuse(code: string, message: string): never {
  throw new OperatorError(message, 409, code);
}

/**
 * `<remote-url>#<ref-path>` — the external object identity.
 *
 * The URL is included because a ref path alone is ambiguous across remotes, and
 * an identity that could name two different systems is not an identity.
 */
export function gitRefTargetId(remoteUrl: string, refPath: string): string {
  return `${remoteUrl}#${refPath}`;
}

/** Splits a target id back into its parts, or refuses a malformed one. */
export function parseGitRefTargetId(targetId: string): {
  readonly remoteUrl: string;
  readonly refPath: string;
} {
  const separator = targetId.lastIndexOf("#");
  if (separator <= 0 || separator === targetId.length - 1) {
    refuse(
      "CONNECTOR_TARGET_MALFORMED",
      `Target "${targetId}" is not a git ref identity of the form <remote-url>#<ref-path>.`,
    );
  }
  const refPath = targetId.slice(separator + 1);
  if (!refPath.startsWith("refs/")) {
    refuse(
      "CONNECTOR_TARGET_MALFORMED",
      `Target ref "${refPath}" must be a fully qualified ref path beginning with "refs/".`,
    );
  }
  return { remoteUrl: targetId.slice(0, separator), refPath };
}

export function createGitRefConnector(options: GitRefConnectorOptions): GitRefConnector {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const calls: GitTransportCall[] = [];
  let reads = 0;

  function git(argv: readonly string[]): string {
    const subcommand = argv[0] ?? "";
    if (!PERMITTED_GIT_SUBCOMMANDS.includes(subcommand)) {
      // Unreachable from this module's own code, and checked anyway: this is the
      // boundary the write-safety proof rests on, so it fails closed rather than
      // trusting that no future edit introduces a second call site.
      refuse(
        "CONNECTOR_TRANSPORT_FORBIDDEN",
        `Git subcommand "${subcommand}" is not readable; this connector may only run `
        + `${PERMITTED_GIT_SUBCOMMANDS.join(", ")}.`,
      );
    }
    const at = options.now();
    try {
      const output = options.execImpl
        ? options.execImpl(argv, timeoutMs)
        : execFileSync("git", ["-C", options.repositoryRoot, ...argv], {
          encoding: "utf8",
          windowsHide: true,
          timeout: timeoutMs,
          // No terminal prompt and no interactive credential path: a read that
          // cannot complete must fail, never block waiting for a human.
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
        });
      calls.push({ argv: [...argv], at, ok: true });
      return output;
    } catch (error) {
      calls.push({ argv: [...argv], at, ok: false });
      refuse(
        "CONNECTOR_READ_UNAVAILABLE",
        `The remote ref advertisement could not be read: ${
          error instanceof Error ? error.message.split("\n")[0] : String(error)
        }`,
      );
    }
  }

  return {
    connectorId: GIT_REF_CONNECTOR_ID,

    manifest: () => GIT_REF_CONNECTOR_MANIFEST,

    read(targetId) {
      reads += 1;
      const { refPath } = parseGitRefTargetId(targetId);
      // One ref, named explicitly. Listing every ref and filtering would read
      // more of the remote than the mission declared an interest in.
      const output = git(["ls-remote", options.remote, refPath]);
      const line = output
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .find((entry) => /^[0-9a-f]{40}\s/.test(entry));
      // Absence is an answer, not an error: "the remote does not carry this ref"
      // is precisely the exception this connector exists to observe.
      if (!line) return null;

      const [sha = "", advertised = ""] = line.split(/\s+/);
      if (advertised !== refPath) {
        refuse(
          "CONNECTOR_STATE_MALFORMED",
          `The remote advertised ref "${advertised}" for a read of "${refPath}".`,
        );
      }
      return {
        targetId,
        // The SHA *is* the revision. There is no separate version counter to
        // drift from the content, which is what makes this source's freshness
        // contract unusually strong.
        revision: sha,
        fields: { refPath, commitSha: sha },
      };
    },

    transportCalls: () => calls,
    // Writes are `0` as a literal type, not a counter that happens to be zero:
    // there is no code path here that could increment one.
    counts: () => ({ reads, writes: 0 }),
  };
}

/**
 * The observation hash for a real ref, derived exactly as the mission side does.
 *
 * Shared derivation rather than a parallel implementation, so "the state the
 * connector holds" and "the state the mission observed" are comparable by value.
 */
export function gitRefStateHash(record: ConnectorRecord): string {
  return createObservationHash({
    sourceSystemId: GIT_REF_CONNECTOR_ID,
    targetId: record.targetId,
    sourceRevision: record.revision,
    observedFields: exceptionFieldsFrom(record.fields),
  });
}
