/**
 * CHANTER OS — verified context compiler.
 *
 * Context becomes a first-class evidence object here, never a prompt string. The
 * distinction is load-bearing: a prompt string carries no provenance, so nothing
 * downstream can tell whether a worker's citation refers to something real. An
 * admitted context item, by contrast, has an exact source identity, a content
 * hash, a retrieval instant, a trust class, and a stable id — which is what lets
 * the verifier reject a claim that cites nothing.
 *
 *     context requirements -> bounded reads -> freshness + trust checks
 *       -> deduplication -> hashed items -> one deterministic bundle id
 *
 * Four properties this module exists to guarantee:
 *
 *   1. **Provenance survives.** An item always names where it came from, and the
 *      content hash covers the source identity, so identical bytes read from two
 *      different sources remain two different items.
 *   2. **Derived claims never masquerade as source.** `claims` is a separate
 *      field from the hashed content. A statement *about* a source is not the
 *      source, and collapsing the two is how an inference becomes "evidence".
 *   3. **Stale means refused, not shrugged at.** A requirement that declared a
 *      freshness policy and cannot meet it fails compilation when required, and
 *      is recorded as rejected when not.
 *   4. **Only admitted context reaches a worker.** The bundle's item ids are the
 *      complete set of things a worker may cite; the Runtime enforces that.
 *
 * The whole repository is never fed in. Each requirement names one bounded
 * source, and reads happen through a port whose implementation is separately
 * allowlisted — so "give the agent the codebase" is not expressible here.
 */
import { OperatorError } from "../services/operatorService.js";
import {
  AGENTIC_CONTEXT_SCHEMA_VERSION,
  createAgenticContextBundleId,
  createAgenticContextItemHash,
  type AgenticContextBundle,
  type AgenticContextItem,
  type AgenticContextRequirement,
  type AgenticIntentContract,
} from "./agenticMissionContract.js";

/** What a bounded source read produced, or why it could not. */
export type AgenticContextSourceRead =
  | {
    readonly ok: true;
    /** Exact retrieved bytes. Hashed verbatim; never edited or summarized. */
    readonly content: string;
    readonly retrievedAt: string;
    /** Statements derived from the content, kept strictly separate from it. */
    readonly claims: readonly string[];
  }
  | {
    readonly ok: false;
    readonly code: string;
    readonly message: string;
  };

/**
 * The only way this compiler reaches the outside world.
 *
 * Implementations are responsible for their own allowlists — a port that can
 * read an arbitrary path would make every bound above decorative.
 */
export interface AgenticContextSourcePort {
  read(requirement: AgenticContextRequirement): Promise<AgenticContextSourceRead>;
}

export interface AgenticContextCompilationOptions {
  /** Instant compilation began, for the `compiled_at_submission` policy. */
  readonly compiledAt: string;
}

function contextItemId(contentHash: string): string {
  return `ctx-${contentHash.slice(0, 24)}`;
}

/**
 * Decides whether a retrieved item satisfies its declared freshness policy.
 *
 * `compiled_at_submission` is deliberately strict — the item must have been read
 * during *this* compilation, not merely recently — because a mission that asks
 * for current repository state and receives a value cached from a previous run
 * would compile a plan against a reality that no longer exists.
 */
function freshnessFailure(
  requirement: AgenticContextRequirement,
  retrievedAt: string,
  compiledAt: string,
): string | null {
  const retrievedMs = Date.parse(retrievedAt);
  if (Number.isNaN(retrievedMs)) return "The source did not report a valid retrieval instant.";
  switch (requirement.freshnessPolicy) {
    case "any":
      return null;
    case "compiled_at_submission":
      return retrievedMs >= Date.parse(compiledAt)
        ? null
        : "The item predates this compilation, but the requirement demands a value read during it.";
    case "max_age_seconds": {
      const maxAgeMs = (requirement.maxAgeSeconds ?? 0) * 1000;
      const ageMs = Date.parse(compiledAt) - retrievedMs;
      return ageMs <= maxAgeMs
        ? null
        : `The item is ${Math.round(ageMs / 1000)}s old, exceeding the ${requirement.maxAgeSeconds}s limit.`;
    }
  }
}

/**
 * Compiles one deterministic, provenance-carrying context bundle.
 *
 * Requirements are processed in their already-normalized id order, so two
 * compilations of the same intent against unchanged sources produce byte-
 * identical bundles and therefore the same bundle id and the same plan.
 */
export async function compileVerifiedContext(
  intent: AgenticIntentContract,
  port: AgenticContextSourcePort,
  options: AgenticContextCompilationOptions,
): Promise<AgenticContextBundle> {
  const items = new Map<string, AgenticContextItem>();
  const rejected: string[] = [];

  for (const requirement of intent.contextRequirements) {
    const read = await port.read(requirement);
    if (!read.ok) {
      if (requirement.required) {
        throw new OperatorError(
          `Required context ${requirement.requirementId} could not be compiled: ${read.message}`,
          409,
          "AGENTIC_CONTEXT_REQUIRED_SOURCE_UNAVAILABLE",
          { requirementId: requirement.requirementId, sourceCode: read.code },
        );
      }
      rejected.push(requirement.requirementId);
      continue;
    }

    const stale = freshnessFailure(requirement, read.retrievedAt, options.compiledAt);
    if (stale) {
      if (requirement.required) {
        throw new OperatorError(
          `Required context ${requirement.requirementId} is stale: ${stale}`,
          409,
          "AGENTIC_CONTEXT_STALE",
          { requirementId: requirement.requirementId, freshnessPolicy: requirement.freshnessPolicy },
        );
      }
      rejected.push(requirement.requirementId);
      continue;
    }

    const contentHash = createAgenticContextItemHash({
      sourceType: requirement.sourceType,
      sourceIdentity: requirement.sourceIdentity,
      content: read.content,
    });
    const identity = contextItemId(contentHash);
    const existing = items.get(identity);
    if (existing) {
      // Identical source and identical bytes: one item, with the union of the
      // derived claims. Deduplicating on content rather than on requirement id
      // is what stops two requirements naming one file from producing two items
      // a verifier would then have to treat as independent corroboration.
      items.set(identity, {
        ...existing,
        claims: [...new Set([...existing.claims, ...read.claims])].sort(),
      });
      continue;
    }
    items.set(identity, {
      contextItemId: identity,
      sourceType: requirement.sourceType,
      sourceIdentity: requirement.sourceIdentity,
      contentHash,
      retrievedAt: read.retrievedAt,
      freshnessPolicy: requirement.freshnessPolicy,
      trustClass: requirement.trustClass,
      scope: requirement.scope,
      claims: [...new Set(read.claims)].sort(),
      evidenceReference: `context:${identity}`,
    });
  }

  const accepted = [...items.values()].sort((left, right) =>
    left.contextItemId.localeCompare(right.contextItemId));
  if (accepted.length === 0) {
    throw new OperatorError(
      "No context requirement produced an admissible item, so no plan can be compiled.",
      409,
      "AGENTIC_CONTEXT_EMPTY",
    );
  }

  return {
    schemaVersion: AGENTIC_CONTEXT_SCHEMA_VERSION,
    contextBundleId: createAgenticContextBundleId(accepted),
    items: accepted,
    rejectedRequirementIds: rejected.sort(),
    compiledAt: options.compiledAt,
  };
}
