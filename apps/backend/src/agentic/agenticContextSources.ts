/**
 * CHANTER OS — bounded context source port.
 *
 * Turns one declared context requirement into one exact read through the
 * fabric's tool surface, with the retrieval instant and the derived claims kept
 * strictly apart from the retrieved bytes.
 *
 * The separation matters more than it looks. `content` is what the source said;
 * `claims` are statements *this compiler* derived from it. Only `content` is
 * hashed into the context item's identity, so a later change to how a claim is
 * phrased cannot silently change what the item is — and a worker that cites the
 * item is citing the source, not somebody's paraphrase of it.
 *
 * Reads go through `AgenticToolSurface` rather than the filesystem directly, so
 * the same allowlists that bound a worker also bound context compilation. There
 * is no privileged path for "the system's own" reads.
 */
import type { JsonValue } from "chanter-agent-runtime";
import { OperatorError } from "../services/operatorService.js";
import type {
  AgenticContextRequirement,
  AgenticContextSourceType,
} from "./agenticMissionContract.js";
import type {
  AgenticContextSourcePort,
  AgenticContextSourceRead,
} from "./agenticContextCompiler.js";
import type { AgenticToolSurface } from "./agenticToolSurface.js";

/**
 * Which tool serves each source type. Total over the closed source-type union,
 * so adding a source type without a reader is a compile error rather than a
 * runtime surprise.
 */
const TOOL_FOR_SOURCE: Readonly<Record<AgenticContextSourceType, string>> = Object.freeze({
  repository_metadata: "repo.metadata.read",
  repository_file: "repo.file.read",
  test_result: "test.result.read",
  operator_mission_state: "operator.mission.state.read",
  static_fixture: "fixture.read",
});

/**
 * Builds the tool request for one requirement.
 *
 * `sourceIdentity` is the requirement's exact opaque identity; its shape depends
 * on the source type, and it is passed through verbatim rather than parsed, so
 * nothing here can reinterpret a caller's bytes.
 */
function toolRequest(requirement: AgenticContextRequirement): JsonValue {
  switch (requirement.sourceType) {
    case "repository_metadata":
      return { repository: requirement.sourceIdentity };
    case "repository_file": {
      const separator = requirement.sourceIdentity.indexOf(":");
      if (separator <= 0) {
        throw new OperatorError(
          `Context requirement ${requirement.requirementId} must identify a repository file as "<repository>:<path>".`,
          400,
          "AGENTIC_CONTEXT_SOURCE_IDENTITY_INVALID",
        );
      }
      return {
        repository: requirement.sourceIdentity.slice(0, separator),
        path: requirement.sourceIdentity.slice(separator + 1),
      };
    }
    case "test_result":
    case "static_fixture":
      return { name: requirement.sourceIdentity };
    case "operator_mission_state":
      return { missionId: requirement.sourceIdentity };
  }
}

/** Statements derived from one retrieved source. Never mixed into the content. */
function deriveClaims(
  requirement: AgenticContextRequirement,
  response: Record<string, JsonValue>,
): string[] {
  switch (requirement.sourceType) {
    case "repository_metadata":
      return [
        `${String(response.repository)} HEAD is ${String(response.head)}.`,
        `${String(response.repository)} branch is ${String(response.branch)}.`,
        `${String(response.repository)} worktree is ${response.clean === true ? "clean" : "not clean"}.`,
      ];
    case "repository_file":
      return [`${String(response.repository)} contains ${String(response.path)} at ${String(response.byteLength)} bytes.`];
    case "test_result":
      return [`Recorded validation result ${requirement.sourceIdentity} is available.`];
    case "static_fixture":
      return [`Approved fixture ${requirement.sourceIdentity} is available.`];
    case "operator_mission_state":
      return [`Durable Operator mission state for ${requirement.sourceIdentity} is available.`];
  }
}

/** The exact retrieved bytes, chosen per source type and never reformatted. */
function contentOf(
  requirement: AgenticContextRequirement,
  response: Record<string, JsonValue>,
): string {
  switch (requirement.sourceType) {
    case "repository_metadata":
      return [
        `repository=${String(response.repository)}`,
        `head=${String(response.head)}`,
        `branch=${String(response.branch)}`,
        `clean=${String(response.clean)}`,
        `changedPathCount=${String(response.changedPathCount)}`,
      ].join("\n");
    case "repository_file":
    case "test_result":
    case "static_fixture":
      return String(response.content ?? "");
    case "operator_mission_state":
      return JSON.stringify(response.state);
  }
}

export function createAgenticContextSourcePort(
  tools: AgenticToolSurface,
  clock: () => string,
): AgenticContextSourcePort {
  return {
    async read(requirement: AgenticContextRequirement): Promise<AgenticContextSourceRead> {
      try {
        const response = await tools.invoke(TOOL_FOR_SOURCE[requirement.sourceType], toolRequest(requirement));
        if (response === null || typeof response !== "object" || Array.isArray(response)) {
          return {
            ok: false,
            code: "AGENTIC_CONTEXT_SOURCE_MALFORMED",
            message: "The source returned no readable record.",
          };
        }
        const record = response as Record<string, JsonValue>;
        return {
          ok: true,
          content: contentOf(requirement, record),
          // The instant this compilation observed the source. Recorded here
          // rather than taken from the source, because a source's own timestamp
          // says when it was produced, not when we read it.
          retrievedAt: clock(),
          claims: deriveClaims(requirement, record),
        };
      } catch (error) {
        if (error instanceof OperatorError) {
          return { ok: false, code: error.code ?? "AGENTIC_CONTEXT_SOURCE_UNAVAILABLE", message: error.message };
        }
        return {
          ok: false,
          code: "AGENTIC_CONTEXT_SOURCE_UNAVAILABLE",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
