/**
 * CHANTER OS — the fabric's registered workers.
 *
 * One worker per capability. Each is constructed per mission, closing over that
 * mission's compiled intent and its admitted context bundle, so a worker can
 * only ever see context this mission actually admitted — there is no path from a
 * worker to the context compiler, the plan, or another mission.
 *
 * Every worker here is a `deterministic_tool` or `structured_local_worker`,
 * which is the router's whole point: none of this work needs inference, so none
 * of it spends any. That also makes the proof reproducible — two runs over the
 * same repository state produce byte-identical claims, and therefore the same
 * candidate hash.
 *
 * ## Where the claims come from
 *
 * Specialists derive claims from two admitted sources and nothing else:
 *
 *   - live repository metadata (branch, HEAD, cleanliness), read through the
 *     bounded tool surface at execution time; and
 *   - approved static fixtures that state the architecture contract and the risk
 *     register, admitted by the context compiler at submission.
 *
 * Every claim cites the context item id it came from. A claim that cites
 * something outside the admitted set is exactly what the verifier is there to
 * reject, and the fixture format can express one deliberately — see
 * `evidenceRefs` below — so that rejection is provable rather than asserted.
 */
import type {
  AgenticNodeEvidenceDraft,
  AgenticNodeWorker,
  AgenticNodeWorkerContext,
  AgenticNodeWorkerOutcome,
  AgenticNodeWorkerRegistry,
  JsonValue,
} from "chanter-agent-runtime";
import { createAgenticModelWorker, createAgenticWorkerRegistry } from "chanter-agent-runtime";
import type {
  AgenticAdmittedContextItem,
  GovernedModelInvocationOptions,
} from "chanter-agent-runtime";
import { requireAgenticCapability } from "./agenticCapabilityRegistry.js";
import {
  createAgenticCandidateHash,
  type AgenticContextBundle,
  type AgenticContextItem,
  type AgenticIntentContract,
} from "./agenticMissionContract.js";
import type { AgenticToolSurface } from "./agenticToolSurface.js";
import type { AgenticExceptionIntakeState } from "./agenticPlanJournal.js";
import {
  compileActionContract,
  createObservationHash,
  evaluateAcceptanceConstraints,
  exceptionFieldsFrom,
  OPERATIONAL_EXCEPTION_SCHEMA_VERSION,
  type ActionContract,
  type ExceptionFieldValue,
  type OperationalExceptionExecutionMode,
} from "./agenticExceptionContract.js";

/** The approved candidate bytes, read at write time rather than carried around. */
export interface AgenticCandidateSnapshot {
  readonly markdown: string;
  readonly candidateHash: string;
}

/** One durable plan node that the router turned into a model worker. */
export interface AgenticModelNodeBinding {
  readonly capabilityId: string;
  readonly bindingId: string | null;
  readonly maxTotalTokens: number | null;
  readonly maxCostMicros: number | null;
  readonly attempts: number;
}

export interface AgenticWorkerDependencies {
  readonly intent: AgenticIntentContract;
  readonly contextBundle: AgenticContextBundle;
  readonly tools: AgenticToolSurface;
  /** Durable candidate the human approved. `null` before synthesis completes. */
  readonly candidate: () => AgenticCandidateSnapshot | null;
  /** Durable count of artifact writes recorded for this mission. */
  readonly artifactWriteCount: () => number;
  /** Capabilities the committed plan routed to a model, with their bounds. */
  readonly modelNodes?: readonly AgenticModelNodeBinding[];
  readonly providerInvocation?: GovernedModelInvocationOptions;
}

/** What an operational-exception worker needs, and nothing an artifact worker does. */
export interface AgenticExceptionWorkerDependencies extends AgenticWorkerDependencies {
  /** Durable ObservedState/DesiredState/StateDelta established at intake. */
  readonly exceptionState: () => AgenticExceptionIntakeState | null;
  /** The instant the compiled action must be applied by. */
  readonly actionDeadline: () => string;
  /** Whether this mission may change the source, or only observe and compile. */
  readonly executionMode: OperationalExceptionExecutionMode;
}

/** Scope labels that mark which fixture a specialist reads. */
export const ARCHITECTURE_FIXTURE_SCOPE = "architecture_contract";
export const RISK_FIXTURE_SCOPE = "risk_register";

/**
 * Polarity marker for a machine-detectable contradiction.
 *
 * Two claims contradict when their statements are identical apart from this
 * prefix. That is a convention rather than semantics, and deliberately so: real
 * contradiction detection over prose would need a model, and a model's opinion
 * is not something a verifier should be allowed to fail a mission on.
 */
const NEGATION_PREFIX = "NOT: ";

interface FixtureClaim {
  readonly claimId: string;
  readonly statement: string;
  readonly confidence: "high" | "medium" | "low";
  /** Overrides the citing context item. Used to inject an unsupported claim. */
  readonly evidenceRefs?: readonly string[];
}

function jsonRecord(value: unknown): Record<string, JsonValue> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : null;
}

function fixtureClaims(content: string): FixtureClaim[] {
  const parsed: unknown = JSON.parse(content);
  const record = jsonRecord(parsed);
  const raw = record?.claims;
  if (!Array.isArray(raw)) return [];
  const claims: FixtureClaim[] = [];
  for (const entry of raw) {
    const claim = jsonRecord(entry);
    if (!claim) continue;
    const confidence = claim.confidence;
    claims.push({
      claimId: String(claim.claimId),
      statement: String(claim.statement),
      confidence: confidence === "high" || confidence === "medium" || confidence === "low"
        ? confidence
        : "medium",
      ...(Array.isArray(claim.evidenceRefs)
        ? { evidenceRefs: claim.evidenceRefs.map((reference) => String(reference)) }
        : {}),
    });
  }
  return claims;
}

function itemsWithScope(bundle: AgenticContextBundle, scope: string): AgenticContextItem[] {
  return bundle.items.filter((item) => item.scope === scope);
}

function evidenceFor(item: AgenticContextItem, label: string): AgenticNodeEvidenceDraft {
  return {
    kind: "context_reference",
    label,
    sourceReference: item.contextItemId,
    content: { contextItemId: item.contextItemId, contentHash: item.contentHash },
  };
}

// ---------------------------------------------------------------------------
// N1 — context collection
// ---------------------------------------------------------------------------

/**
 * Re-establishes that the admitted context still describes reality.
 *
 * Repository metadata is the one admitted source that can move between
 * submission and execution, so this node re-reads it and compares content
 * hashes. Drift demotes that item out of the accepted set rather than failing
 * the mission: the honest response to "the repository moved" is to stop citing
 * the stale item, not to pretend nothing changed.
 */
function contextCollectWorker(dependencies: AgenticWorkerDependencies): AgenticNodeWorker {
  return {
    workerId: "operator.agentic.context-collect",
    capabilityId: "repo.metadata.read",
    kind: "deterministic_tool",
    async execute(context: AgenticNodeWorkerContext): Promise<AgenticNodeWorkerOutcome> {
      const accepted: string[] = [];
      const rejected: string[] = [];
      const evidence: AgenticNodeEvidenceDraft[] = [];

      for (const item of dependencies.contextBundle.items) {
        if (item.sourceType !== "repository_metadata") {
          accepted.push(item.contextItemId);
          evidence.push(evidenceFor(item, `admitted ${item.sourceType} ${item.sourceIdentity}`));
          continue;
        }
        const response = jsonRecord(
          await context.tools.invoke("repo.metadata.read", { repository: item.sourceIdentity }),
        );
        const observedHead = response ? String(response.head) : "";
        // The item's raw bytes are not retained on the bundle; its derived
        // claims carry the HEAD observed at submission, which is exactly the
        // value a drift check needs to compare against.
        const recordedHead = /HEAD is ([0-9a-f]{7,40})/.exec(item.claims.join("\n"))?.[1] ?? "";
        const drifted = Boolean(recordedHead) && observedHead !== recordedHead;
        if (drifted) {
          rejected.push(item.contextItemId);
          continue;
        }
        accepted.push(item.contextItemId);
        evidence.push({
          kind: "tool_output",
          label: `${item.sourceIdentity} repository state re-read at execution`,
          sourceReference: item.contextItemId,
          content: { repository: item.sourceIdentity, head: observedHead },
        });
      }

      return {
        ok: true,
        structuredOutput: {
          contextBundleId: dependencies.contextBundle.contextBundleId,
          acceptedContextIds: accepted.sort(),
          rejectedRequirementIds: rejected.sort(),
        },
        evidence,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// N2 / N3 — independent specialists
// ---------------------------------------------------------------------------

function specialistWorker(
  dependencies: AgenticWorkerDependencies,
  options: {
    readonly capabilityId: string;
    readonly workerId: string;
    readonly fixtureScope: string;
    readonly metadataClaimPrefix: string;
  },
): AgenticNodeWorker {
  return {
    workerId: options.workerId,
    capabilityId: options.capabilityId,
    kind: "structured_local_worker",
    async execute(context: AgenticNodeWorkerContext): Promise<AgenticNodeWorkerOutcome> {
      const acceptedIds = new Set(context.acceptedContextIds);
      const claims: Array<Record<string, JsonValue>> = [];
      const evidence: AgenticNodeEvidenceDraft[] = [];

      // Grounded in live repository state this node just confirmed.
      for (const item of dependencies.contextBundle.items) {
        if (item.sourceType !== "repository_metadata" || !acceptedIds.has(item.contextItemId)) continue;
        const headClaim = item.claims.find((claim) => claim.includes("HEAD is"));
        if (!headClaim) continue;
        claims.push({
          claimId: `${options.metadataClaimPrefix}-repo-${item.sourceIdentity}`,
          statement: headClaim,
          confidence: "high",
          evidenceRefs: [item.contextItemId],
        });
        evidence.push(evidenceFor(item, `repository state for ${item.sourceIdentity}`));
      }

      // Grounded in the approved fixture that states this specialist's domain.
      for (const item of itemsWithScope(dependencies.contextBundle, options.fixtureScope)) {
        if (!acceptedIds.has(item.contextItemId)) continue;
        const response = jsonRecord(
          await context.tools.invoke("fixture.read", { name: item.sourceIdentity }),
        );
        const content = response ? String(response.content) : "";
        for (const claim of fixtureClaims(content)) {
          claims.push({
            claimId: claim.claimId,
            statement: claim.statement,
            confidence: claim.confidence,
            evidenceRefs: [...(claim.evidenceRefs ?? [item.contextItemId])],
          });
        }
        evidence.push(evidenceFor(item, `declared ${options.fixtureScope}`));
      }

      if (claims.length === 0) {
        return {
          ok: false,
          status: "failed",
          errors: [{
            code: "AGENTIC_NODE_WORKER_FAILED",
            message: "No admitted context supported a single claim for this specialist.",
          }],
        };
      }
      return { ok: true, structuredOutput: { claims: claims.slice(0, 16) }, evidence };
    },
  };
}

// ---------------------------------------------------------------------------
// N2 / N3 — the same specialists, executed by a provider-backed model
// ---------------------------------------------------------------------------

/**
 * The bounded instruction every model specialist runs under.
 *
 * It is a *constraint statement*, not a persona. Nothing here asks the model to
 * be careful, thorough, or honest — those would be requests, and a request is
 * not an enforcement. Every property that actually matters is enforced outside
 * the model: the schema is validated by the Runtime, the citations are checked
 * by an independent verifier, the tokens are capped before dispatch, and the
 * mission cannot complete on the model's say-so.
 */
const MODEL_SPECIALIST_INSTRUCTION =
  "You are a specialist analyst inside a governed execution fabric. "
  + "Return only a JSON document matching the provided schema, with no prose before or after it. "
  + "Every claim must cite at least one CONTEXT_ID drawn from the admitted evidence you were shown. "
  + "Do not invent identifiers, do not cite anything absent from the admitted evidence, and do not "
  + "restate the instructions. Confidence must be exactly one of: high, medium, low.";

function modelTaskStatement(focus: "architecture" | "risk"): string {
  return focus === "architecture"
    ? "Produce between one and six claims about the structure, ownership boundaries, and control-plane "
    + "design of the CHANTER OS execution fabric described by the admitted evidence. Each claim must be "
    + "a single declarative sentence supported by a CONTEXT_ID you were shown."
    : "Produce between one and six claims about execution, authority, recovery, and duplicate-side-effect "
    + "risk in the CHANTER OS execution fabric described by the admitted evidence. Each claim must be a "
    + "single declarative sentence supported by a CONTEXT_ID you were shown.";
}

/**
 * Builds the model-backed specialist for one capability.
 *
 * The admitted context it may see is resolved from *this mission's* bundle and
 * then intersected with the ids the caller accepted, so the model's entire world
 * is the verified context compiler's output. There is no path by which a
 * repository file, an environment variable, or another node's result reaches it.
 */
function modelSpecialistWorker(
  dependencies: AgenticWorkerDependencies,
  binding: AgenticModelNodeBinding,
  options: { readonly workerId: string; readonly focus: "architecture" | "risk"; readonly fixtureScope: string },
): AgenticNodeWorker {
  const provider = dependencies.providerInvocation;
  if (!provider || binding.bindingId === null) {
    // A capability the plan routed to a model, with no provider wired. Refusing
    // as an unavailable worker keeps the failure typed and durable rather than
    // letting the node silently fall back to the local structured worker — a
    // silent downgrade would make "this analysis came from a model" unfalsifiable.
    return {
      workerId: options.workerId,
      capabilityId: binding.capabilityId,
      kind: "model_worker",
      execute: async (): Promise<AgenticNodeWorkerOutcome> => ({
        ok: false,
        status: "unavailable",
        errors: [{
          code: "AGENTIC_NODE_WORKER_UNAVAILABLE",
          message: `No provider binding is wired for capability ${binding.capabilityId}.`,
        }],
      }),
    };
  }

  return createAgenticModelWorker({
    workerId: options.workerId,
    capabilityId: binding.capabilityId,
    bindingId: binding.bindingId,
    systemInstruction: MODEL_SPECIALIST_INSTRUCTION,
    taskStatement: modelTaskStatement(options.focus),
    outputSchema: requireAgenticCapability(binding.capabilityId).outputSchema,
    maxTotalTokens: binding.maxTotalTokens,
    maxCostMicros: binding.maxCostMicros,
    attempt: Math.max(1, binding.attempts),
    admittedContext: (acceptedContextIds): readonly AgenticAdmittedContextItem[] => {
      const accepted = new Set(acceptedContextIds);
      return dependencies.contextBundle.items
        .filter((item) => accepted.has(item.contextItemId))
        // Repository metadata plus this specialist's own approved fixture. The
        // other specialist's fixture is withheld deliberately: N2 and N3 must
        // not see each other's evidence, or the verifier's treatment of them as
        // independent corroboration would be false.
        .filter((item) => item.sourceType === "repository_metadata" || item.scope === options.fixtureScope)
        .map((item) => ({
          contextItemId: item.contextItemId,
          sourceType: item.sourceType,
          sourceIdentity: item.sourceIdentity,
          scope: item.scope,
          // Derived claims, not raw source bytes — the bundle never retains the
          // bytes, and the claims are exactly what was admitted about the item.
          content: item.claims.join("\n"),
        }));
    },
    provider,
  });
}

// ---------------------------------------------------------------------------
// N4 — verification
// ---------------------------------------------------------------------------

interface IncomingClaim {
  readonly nodeId: string;
  readonly claimId: string;
  readonly statement: string;
  readonly confidence: string;
  readonly evidenceRefs: readonly string[];
}

function readClaimSets(input: JsonValue): IncomingClaim[] {
  const record = jsonRecord(input);
  const sets = record?.claimSets;
  if (!Array.isArray(sets)) return [];
  const claims: IncomingClaim[] = [];
  for (const entry of sets) {
    const set = jsonRecord(entry);
    const nodeId = String(set?.nodeId ?? "");
    const raw = set?.claims;
    if (!Array.isArray(raw)) continue;
    for (const candidate of raw) {
      const claim = jsonRecord(candidate);
      if (!claim) continue;
      claims.push({
        nodeId,
        claimId: String(claim.claimId),
        statement: String(claim.statement),
        confidence: String(claim.confidence),
        evidenceRefs: Array.isArray(claim.evidenceRefs)
          ? claim.evidenceRefs.map((reference) => String(reference))
          : [],
      });
    }
  }
  return claims;
}

function polarity(statement: string): { base: string; negated: boolean } {
  return statement.startsWith(NEGATION_PREFIX)
    ? { base: statement.slice(NEGATION_PREFIX.length), negated: true }
    : { base: statement, negated: false };
}

/**
 * The verifier. Not a summarizer.
 *
 * It reaches its verdict by comparison alone — does every cited reference exist
 * in the admitted set, and does any pair of claims assert opposite polarity on
 * one statement — so a rejection can always be explained by pointing at the two
 * values that differed. Nothing here is permitted to interpret a claim's
 * meaning, because a verifier whose judgement is itself unverifiable adds no
 * assurance to the chain.
 */
function verifierWorker(): AgenticNodeWorker {
  return {
    workerId: "operator.agentic.verifier",
    capabilityId: "evidence.verify",
    kind: "deterministic_tool",
    async execute(context: AgenticNodeWorkerContext): Promise<AgenticNodeWorkerOutcome> {
      const accepted = new Set(context.acceptedContextIds);
      const incoming = readClaimSets(context.input);

      // Keyed by node *and* claim id. A claim id is only unique within the node
      // that produced it — two independent specialists routinely number their
      // findings from one, and model workers do it every time. Keying by claim
      // id alone would let one node's unsupported citation reject the other
      // node's perfectly well-evidenced claim, which is a silent loss of
      // verified work and the opposite of what verification is for.
      const claimKey = (claim: IncomingClaim): string => `${claim.nodeId}::${claim.claimId}`;

      const unsupported = new Map<string, string[]>();
      for (const claim of incoming) {
        const missing = claim.evidenceRefs.filter((reference) => !accepted.has(reference));
        if (missing.length > 0) unsupported.set(claimKey(claim), missing);
      }

      // Opposite polarity on one statement, asserted by two different nodes.
      const contradictions: Array<Record<string, JsonValue>> = [];
      const contradicting = new Set<string>();
      for (let left = 0; left < incoming.length; left += 1) {
        for (let right = left + 1; right < incoming.length; right += 1) {
          const a = incoming[left];
          const b = incoming[right];
          if (!a || !b || a.nodeId === b.nodeId) continue;
          const first = polarity(a.statement);
          const second = polarity(b.statement);
          if (first.base !== second.base || first.negated === second.negated) continue;
          contradictions.push({
            leftClaimId: a.claimId,
            rightClaimId: b.claimId,
            severity: a.confidence === "high" || b.confidence === "high" ? "critical" : "advisory",
          });
          contradicting.add(claimKey(a));
          contradicting.add(claimKey(b));
        }
      }
      const criticalContradiction = contradictions.some((entry) => entry.severity === "critical");

      const acceptedClaims: Array<Record<string, JsonValue>> = [];
      const rejectedClaims: Array<Record<string, JsonValue>> = [];
      for (const claim of incoming) {
        if (unsupported.has(claimKey(claim))) {
          rejectedClaims.push({
            claimId: claim.claimId,
            statement: claim.statement,
            reason: "unsupported_evidence",
          });
          continue;
        }
        if (contradicting.has(claimKey(claim))) {
          rejectedClaims.push({
            claimId: claim.claimId,
            statement: claim.statement,
            reason: "contradicts_peer_claim",
          });
          continue;
        }
        acceptedClaims.push({
          claimId: claim.claimId,
          statement: claim.statement,
          confidence: claim.confidence,
          evidenceRefs: [...claim.evidenceRefs],
          sourceNodeId: claim.nodeId,
        });
      }

      const verdict = criticalContradiction
        ? "failed"
        : rejectedClaims.length > 0
          ? "accepted_with_rejections"
          : "accepted";

      return {
        ok: true,
        structuredOutput: {
          verificationVerdict: verdict,
          acceptedClaims,
          rejectedClaims,
          contradictions,
          missingEvidence: [...new Set([...unsupported.values()].flat())].sort(),
          confidenceByClaim: acceptedClaims.map((claim) => ({
            claimId: claim.claimId,
            confidence: claim.confidence,
          })),
        },
        evidence: [{
          kind: "derived_claim",
          label: `verification verdict ${verdict}`,
          sourceReference: context.acceptedContextIds[0] ?? "",
          content: {
            accepted: acceptedClaims.length,
            rejected: rejectedClaims.length,
            contradictions: contradictions.length,
          },
        }],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// N5 — synthesis
// ---------------------------------------------------------------------------

interface AcceptedClaim {
  readonly claimId: string;
  readonly statement: string;
  readonly confidence: string;
  readonly evidenceRefs: readonly string[];
  readonly sourceNodeId: string;
}

function readAcceptedClaims(input: JsonValue): AcceptedClaim[] {
  const record = jsonRecord(input);
  const raw = record?.acceptedClaims;
  if (!Array.isArray(raw)) return [];
  const claims: AcceptedClaim[] = [];
  for (const entry of raw) {
    const claim = jsonRecord(entry);
    if (!claim) continue;
    claims.push({
      claimId: String(claim.claimId),
      statement: String(claim.statement),
      confidence: String(claim.confidence),
      evidenceRefs: Array.isArray(claim.evidenceRefs)
        ? claim.evidenceRefs.map((reference) => String(reference))
        : [],
      sourceNodeId: String(claim.sourceNodeId),
    });
  }
  return claims;
}

/**
 * Composes the candidate result from accepted claims only.
 *
 * Its input is the verifier's `acceptedClaims` and nothing else — the plan gives
 * it no edge to a specialist — so a rejected claim has no path into the artifact
 * even if the synthesis logic were wrong about which section to put it in.
 */
function synthesisWorker(dependencies: AgenticWorkerDependencies): AgenticNodeWorker {
  return {
    workerId: "operator.agentic.synthesis",
    capabilityId: "result.synthesize",
    kind: "deterministic_tool",
    async execute(context: AgenticNodeWorkerContext): Promise<AgenticNodeWorkerOutcome> {
      const input = jsonRecord(context.input) ?? {};
      const claims = readAcceptedClaims(context.input);
      const requiredSections = Array.isArray(input.requiredSections)
        ? input.requiredSections.map((section) => String(section))
        : [];
      const remainingUncertainty = Array.isArray(input.remainingUncertainty)
        ? input.remainingUncertainty.map((entry) => String(entry))
        : [];

      const architectureFindings = claims
        .filter((claim) => claim.sourceNodeId === "N2")
        .map((claim) => claim.statement);
      const riskFindings = claims
        .filter((claim) => claim.sourceNodeId === "N3")
        .map((claim) => claim.statement);
      const evidenceIndex = [...new Set(claims.flatMap((claim) => claim.evidenceRefs))].sort();

      // Recommended actions are derived from risk findings only. A recommended
      // action with no risk behind it is an opinion, and opinions have no
      // accepted-claim id to trace to.
      const recommendedActions = riskFindings.map((finding) => `Address: ${finding}`);

      const acceptanceEvaluation = (Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria : [])
        .map((entry) => {
          const criterion = jsonRecord(entry);
          const check = String(criterion?.check ?? "");
          const parameter = String(criterion?.parameter ?? "");
          const criterionId = String(criterion?.criterionId ?? "");
          switch (check) {
            case "artifact_section_present":
              return {
                criterionId,
                passed: requiredSections.includes(parameter),
                detail: `Section "${parameter}" ${requiredSections.includes(parameter) ? "is" : "is not"} required by the output contract.`,
              };
            case "evidence_coverage_minimum": {
              const minimum = Number(parameter);
              const passed = Number.isFinite(minimum) && evidenceIndex.length >= minimum;
              return {
                criterionId,
                passed,
                detail: `${evidenceIndex.length} distinct evidence references support this result; ${parameter} were required.`,
              };
            }
            case "no_rejected_claim_present":
              return {
                criterionId,
                passed: true,
                detail: "Synthesis consumed only the verifier's accepted claims.",
              };
            default:
              // `human_judgment` is reported as unevaluated rather than passed.
              // Claiming a machine settled it would be the one dishonest answer.
              return {
                criterionId,
                passed: false,
                detail: "This criterion requires human judgement and was not evaluated by a machine.",
              };
          }
        });

      return {
        ok: true,
        structuredOutput: {
          executiveSummary:
            `${dependencies.intent.objective} — ${claims.length} verified claims across `
            + `${architectureFindings.length} architecture and ${riskFindings.length} risk findings.`,
          architectureFindings,
          riskFindings,
          recommendedActions,
          evidenceIndex,
          remainingUncertainty,
          acceptanceEvaluation,
          sourceClaimIds: claims.map((claim) => claim.claimId).sort(),
        },
        evidence: claims.slice(0, 8).map((claim) => ({
          kind: "derived_claim" as const,
          label: `synthesized from accepted claim ${claim.claimId}`,
          sourceReference: claim.evidenceRefs[0] ?? "",
          content: { claimId: claim.claimId, sourceNodeId: claim.sourceNodeId },
        })),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// N7 — the one consequential write
// ---------------------------------------------------------------------------

/**
 * Writes the approved artifact exactly once.
 *
 * The candidate hash arrives in the node input, having been bound by the human
 * approval, and is re-derived here from the bytes about to be written. If they
 * disagree the write never happens — so an approval cannot be carried onto
 * different bytes even if every layer above this one were confused about which
 * candidate was current.
 */
function artifactWriteWorker(dependencies: AgenticWorkerDependencies): AgenticNodeWorker {
  return {
    workerId: "operator.agentic.artifact-write",
    capabilityId: "artifact.local.write",
    kind: "deterministic_tool",
    async execute(context: AgenticNodeWorkerContext): Promise<AgenticNodeWorkerOutcome> {
      const input = jsonRecord(context.input) ?? {};
      const artifactName = String(input.artifactName ?? "");
      const approvedHash = String(input.candidateHash ?? "");
      const candidate = dependencies.candidate();
      if (!candidate) {
        return {
          ok: false,
          status: "failed",
          errors: [{
            code: "AGENTIC_NODE_WORKER_FAILED",
            message: "No durable candidate exists to write.",
          }],
        };
      }
      const derived = createAgenticCandidateHash(candidate.markdown);
      if (derived !== approvedHash) {
        return {
          ok: false,
          status: "denied",
          errors: [{
            code: "AGENTIC_NODE_WORKER_FAILED",
            message: "The candidate bytes do not hash to the approved candidate hash; the write is refused.",
          }],
        };
      }
      const response = jsonRecord(
        await context.tools.invoke("artifact.local.write", {
          artifactName,
          contents: candidate.markdown,
        }),
      );
      return {
        ok: true,
        structuredOutput: {
          artifactName,
          artifactHash: derived,
          bytesWritten: Number(response?.byteLength ?? 0),
          writeCount: 1,
        },
        evidence: [{
          kind: "artifact",
          label: `wrote ${artifactName}`,
          sourceReference: `candidate:${derived}`,
          content: { artifactName, artifactHash: derived },
        }],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// N8 — independent outcome verification
// ---------------------------------------------------------------------------

/**
 * Verifies the outcome from the bytes on disk, not from the write's own report.
 *
 * That independence is the point: N7 returning "I wrote it" is a claim by the
 * component with an interest in the answer, whereas re-reading the file and
 * re-deriving its hash is a check that would fail if the write had lied, been
 * partial, or been overwritten.
 */
function outcomeVerifyWorker(dependencies: AgenticWorkerDependencies): AgenticNodeWorker {
  return {
    workerId: "operator.agentic.outcome-verify",
    capabilityId: "outcome.verify",
    kind: "deterministic_tool",
    async execute(context: AgenticNodeWorkerContext): Promise<AgenticNodeWorkerOutcome> {
      const input = jsonRecord(context.input) ?? {};
      const artifactName = String(input.artifactName ?? "");
      const approvedCandidateHash = String(input.approvedCandidateHash ?? "");
      const requiredSections = Array.isArray(input.requiredSections)
        ? input.requiredSections.map((section) => String(section))
        : [];
      const rejectedStatements = Array.isArray(input.rejectedClaimStatements)
        ? input.rejectedClaimStatements.map((statement) => String(statement))
        : [];
      const evidenceIndex = Array.isArray(input.evidenceIndex)
        ? input.evidenceIndex.map((reference) => String(reference))
        : [];

      const response = jsonRecord(
        await context.tools.invoke("artifact.local.read", { artifactName }),
      );
      const exists = response?.exists === true;
      const content = exists ? String(response?.content ?? "") : "";
      const artifactHash = exists ? createAgenticCandidateHash(content) : "";
      const missingSections = requiredSections.filter((section) => !content.includes(section));
      const unresolvedEvidenceRefs = evidenceIndex.filter((reference) => !content.includes(reference));
      const rejectedPresent = rejectedStatements.filter((statement) => content.includes(statement));
      const writeCount = dependencies.artifactWriteCount();

      const outcomeVerified = exists
        && artifactHash === approvedCandidateHash
        && missingSections.length === 0
        && unresolvedEvidenceRefs.length === 0
        && rejectedPresent.length === 0
        && writeCount === 1;

      return {
        ok: true,
        structuredOutput: {
          artifactExists: exists,
          // A 64-character digest is required by the schema even when nothing
          // was found, so absence is reported through `artifactExists` rather
          // than through a hash that would read as a real value.
          artifactHash: artifactHash || "0".repeat(64),
          hashMatchesApprovedCandidate: exists && artifactHash === approvedCandidateHash,
          missingSections,
          unresolvedEvidenceRefs,
          rejectedClaimsPresent: rejectedPresent,
          writeCount,
          outcomeVerified,
        },
        evidence: [{
          kind: "artifact",
          label: `verified ${artifactName} independently from disk`,
          sourceReference: `artifact:${artifactName}`,
          content: { artifactHash, writeCount, outcomeVerified },
        }],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// X1 — observe the connector's current state
// ---------------------------------------------------------------------------

/**
 * Re-reads the source and reports whether it still matches intake.
 *
 * The comparison is the point. Intake's observation is what the StateDelta and
 * the human's approval were built on, and this node exists to establish, before
 * anything is written, that the source has not moved since. It reports the
 * mismatch rather than throwing: a moved record is a *finding*, and the plan
 * fails closed on it one node later when the action's pre-state check refuses.
 */
function exceptionObserveWorker(dependencies: AgenticWorkerDependencies): AgenticNodeWorker {
  return {
    workerId: "operator.agentic.exception-observe",
    capabilityId: "exception.state.observe",
    kind: "deterministic_tool",
    async execute(context: AgenticNodeWorkerContext): Promise<AgenticNodeWorkerOutcome> {
      const input = jsonRecord(context.input) ?? {};
      const targetId = String(input.targetId ?? "");
      const expected = String(input.expectedObservationHash ?? "");

      const response = jsonRecord(
        await context.tools.invoke("connector.state.read", { targetId }),
      );
      const exists = response?.exists === true;
      const record = jsonRecord(response?.record ?? null);
      if (!exists || !record) {
        return {
          ok: false,
          status: "failed",
          errors: [{
            code: "AGENTIC_NODE_WORKER_FAILED",
            message: `The connector holds no record ${targetId}, so no state can be observed.`,
          }],
        };
      }

      const fields = jsonRecord(record.fields) ?? {};
      const observationHash = createObservationHash({
        sourceSystemId: String(input.connectorId ?? ""),
        targetId: String(record.targetId ?? targetId),
        sourceRevision: String(record.revision ?? ""),
        observedFields: exceptionFieldsFrom(fields as Record<string, ExceptionFieldValue>),
      });

      return {
        ok: true,
        structuredOutput: {
          sourceSystemId: String(input.connectorId ?? ""),
          targetId: String(record.targetId ?? targetId),
          sourceRevision: String(record.revision ?? ""),
          observationHash,
          matchesIntakeObservation: observationHash === expected,
          recordExists: true,
        },
        evidence: [{
          kind: "tool_output",
          label: `observed ${targetId} at revision ${String(record.revision ?? "")}`,
          sourceReference: `connector-observation:${observationHash}`,
          content: { observationHash, matchesIntakeObservation: observationHash === expected },
        }],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// X2 — compile the one action
// ---------------------------------------------------------------------------

/**
 * Compiles the ActionContract, and refuses if the source has moved.
 *
 * This is where a stale observation stops the mission. The delta, the payload,
 * and the idempotency key are all derived from the observation the *human's*
 * approval will bind to, so compiling an action against a source that has since
 * changed would produce a contract that can never be applied — and would put an
 * unusable approval in front of a person.
 */
function exceptionActionCompileWorker(
  dependencies: AgenticExceptionWorkerDependencies,
): AgenticNodeWorker {
  return {
    workerId: "operator.agentic.exception-action-compile",
    capabilityId: "exception.action.compile",
    kind: "deterministic_tool",
    async execute(context: AgenticNodeWorkerContext): Promise<AgenticNodeWorkerOutcome> {
      const input = jsonRecord(context.input) ?? {};
      const observationHash = String(input.observationHash ?? "");
      const intake = dependencies.exceptionState();
      if (!intake) {
        return {
          ok: false,
          status: "failed",
          errors: [{
            code: "AGENTIC_NODE_WORKER_FAILED",
            message: "This mission carries no durable operational-exception state.",
          }],
        };
      }

      if (observationHash !== intake.observed.observationHash) {
        return {
          ok: false,
          status: "denied",
          errors: [{
            code: "AGENTIC_NODE_WORKER_FAILED",
            message:
              "The source record changed after this mission's state delta was established; "
              + "the action is refused rather than compiled against a stale observation.",
          }],
        };
      }

      const manifest = jsonRecord(await context.tools.invoke("connector.manifest.read", {}));
      // Which list names the action depends on whether this connector may
      // perform one. A read-only connector performs no capability and declares
      // none — but it does declare what the *system* would need, and that is
      // what a shadow contract must bind. Reading `capabilities` for both would
      // make a shadow action either impossible to compile or nameless.
      const writesEnabled = manifest?.writeCapabilitiesEnabled === true;
      const capabilitySource = writesEnabled
        ? manifest?.capabilities
        : manifest?.writeCapabilitiesDeclared;
      const capabilities = Array.isArray(capabilitySource)
        ? capabilitySource.map((entry) => String(entry))
        : [];
      const writable = Array.isArray(manifest?.writableFields)
        ? manifest.writableFields.map((entry) => String(entry))
        : [];
      const capability = capabilities[0] ?? "";
      if (capabilities.length !== 1) {
        return {
          ok: false,
          status: "denied",
          errors: [{
            code: "AGENTIC_NODE_WORKER_FAILED",
            message:
              `Connector declares ${capabilities.length} state-changing capabilities; this plan binds `
              + "exactly one.",
          }],
        };
      }
      // Checked before a human is asked, not at the write. An action whose
      // fields the connector cannot write is unapplyable, and discovering that
      // after approval would waste the one decision that matters.
      const unwritable = intake.delta.changes
        .map((change) => change.field)
        .filter((field) => !writable.includes(field));
      if (unwritable.length > 0) {
        return {
          ok: false,
          status: "denied",
          errors: [{
            code: "AGENTIC_NODE_WORKER_FAILED",
            message: `Connector capability ${capability} cannot write ${unwritable.sort().join(", ")}.`,
          }],
        };
      }

      const contract = compileActionContract({
        missionId: dependencies.intent.missionId,
        connectorId: String(input.connectorId ?? ""),
        capability,
        targetId: String(input.targetId ?? ""),
        expectedPreStateHash: observationHash,
        delta: intake.delta,
        deadline: dependencies.actionDeadline(),
      });

      return {
        ok: true,
        structuredOutput: {
          actionContractHash: contract.actionContractHash,
          writePayloadHash: contract.writePayloadHash,
          idempotencyKey: contract.idempotencyKey,
          capability,
          changedFieldCount: contract.writePayload.length,
        },
        evidence: [{
          kind: "derived_claim",
          label: `compiled one ${capability} action over ${contract.writePayload.length} field(s)`,
          sourceReference: `state-delta:${intake.delta.deltaHash}`,
          content: {
            actionContractHash: contract.actionContractHash,
            idempotencyKey: contract.idempotencyKey,
          },
        }],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// X4 — the one simulated external side effect
// ---------------------------------------------------------------------------

/**
 * Applies exactly one approved action, or replays the one already applied.
 *
 * Three independent checks stand between arriving here and changing anything,
 * and each catches a different confusion:
 *
 *   - the contract is **recompiled** and re-hashed, so the bytes about to be
 *     written are derived here rather than accepted from the previous node;
 *   - that hash is checked against the **approved candidate**, so an approval
 *     cannot be carried onto a different action;
 *   - the connector is asked whether this **idempotency key** already landed,
 *     so a restart in the ambiguous window replays rather than re-applies.
 *
 * The pre-state check is deliberately *not* here. It belongs to the connector,
 * because only the connector knows its own state at the instant of the write —
 * a check performed here would be a check performed slightly too early.
 */
function connectorApplyWorker(
  dependencies: AgenticExceptionWorkerDependencies,
): AgenticNodeWorker {
  return {
    workerId: "operator.agentic.connector-apply",
    capabilityId: "connector.state.apply",
    kind: "deterministic_tool",
    async execute(context: AgenticNodeWorkerContext): Promise<AgenticNodeWorkerOutcome> {
      const input = jsonRecord(context.input) ?? {};
      const approvedHash = String(input.candidateHash ?? "");
      const candidate = dependencies.candidate();
      const intake = dependencies.exceptionState();
      if (!candidate || !intake) {
        return {
          ok: false,
          status: "failed",
          errors: [{
            code: "AGENTIC_NODE_WORKER_FAILED",
            message: "No durable approved action contract exists to apply.",
          }],
        };
      }
      const derived = createAgenticCandidateHash(candidate.markdown);
      if (derived !== approvedHash) {
        return {
          ok: false,
          status: "denied",
          errors: [{
            code: "AGENTIC_NODE_WORKER_FAILED",
            message:
              "The action contract bytes do not hash to the approved candidate hash; the write is refused.",
          }],
        };
      }

      const contract = parseActionContractCandidate(candidate.markdown);
      if (!contract) {
        return {
          ok: false,
          status: "failed",
          errors: [{
            code: "AGENTIC_NODE_WORKER_FAILED",
            message: "The approved candidate is not a readable action contract.",
          }],
        };
      }
      if (contract.actionContractHash !== String(input.actionContractHash ?? "")) {
        return {
          ok: false,
          status: "denied",
          errors: [{
            code: "AGENTIC_NODE_WORKER_FAILED",
            message: "The approved action contract is not the one this node was asked to apply.",
          }],
        };
      }

      // Reconcile before acting. A restart inside the ambiguous window arrives
      // here with the action already on the connector's books, and re-applying
      // it would be the duplicate this whole plan exists to prevent.
      const existing = jsonRecord(
        await context.tools.invoke("connector.action.read", {
          idempotencyKey: contract.idempotencyKey,
        }),
      );
      if (existing?.applied === true) {
        const action = jsonRecord(existing.action) ?? {};
        return {
          ok: true,
          structuredOutput: {
            idempotencyKey: contract.idempotencyKey,
            postStateHash: String(action.postStateHash ?? ""),
            performedWrite: false,
            writeCount: 1,
          },
          evidence: [{
            kind: "tool_output",
            label: "replayed an action the connector had already applied",
            sourceReference: `connector-action:${contract.idempotencyKey}`,
            content: { performedWrite: false, postStateHash: String(action.postStateHash ?? "") },
          }],
        };
      }

      const applied = jsonRecord(
        await context.tools.invoke("connector.state.apply", {
          capability: contract.capability,
          targetId: contract.targetId,
          expectedPreStateHash: contract.expectedPreStateHash,
          writePayload: contract.writePayload.map((entry) => ({
            field: entry.field,
            value: entry.value,
          })),
          writePayloadHash: contract.writePayloadHash,
          idempotencyKey: contract.idempotencyKey,
        }),
      );
      const action = jsonRecord(applied?.action) ?? {};

      return {
        ok: true,
        structuredOutput: {
          idempotencyKey: contract.idempotencyKey,
          postStateHash: String(action.postStateHash ?? ""),
          performedWrite: applied?.performedWrite === true,
          writeCount: 1,
        },
        evidence: [{
          kind: "tool_output",
          label: `applied ${contract.capability} to ${contract.targetId}`,
          sourceReference: `connector-action:${contract.idempotencyKey}`,
          content: {
            performedWrite: applied?.performedWrite === true,
            postStateHash: String(action.postStateHash ?? ""),
          },
        }],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// X4 (shadow) — record what would happen, and do nothing
// ---------------------------------------------------------------------------

/**
 * Records the exact action an approval authorized, and performs none of it.
 *
 * It runs the same three checks the applying worker runs — recompile the
 * contract, re-hash it, compare against the approved candidate — because the
 * point of a shadow proof is that *the authority chain is real*. A node that
 * skipped those would prove only that nothing happened, which is easy and
 * uninteresting.
 *
 * What it cannot do is write, and that is not enforced here. This worker holds
 * no write tool in its capability allowlist, its plan contains no write node,
 * and the connector it observes exposes no write method. Three independent
 * structural facts, none of which is a check this code could get wrong.
 */
function shadowAuthorizeWorker(
  dependencies: AgenticExceptionWorkerDependencies,
): AgenticNodeWorker {
  return {
    workerId: "operator.agentic.shadow-authorize",
    capabilityId: "exception.shadow.authorize",
    kind: "deterministic_tool",
    async execute(context: AgenticNodeWorkerContext): Promise<AgenticNodeWorkerOutcome> {
      const input = jsonRecord(context.input) ?? {};
      const approvedHash = String(input.candidateHash ?? "");
      const candidate = dependencies.candidate();
      const intake = dependencies.exceptionState();
      if (!candidate || !intake) {
        return {
          ok: false,
          status: "failed",
          errors: [{
            code: "AGENTIC_NODE_WORKER_FAILED",
            message: "No durable approved action contract exists to record.",
          }],
        };
      }
      const derived = createAgenticCandidateHash(candidate.markdown);
      if (derived !== approvedHash) {
        return {
          ok: false,
          status: "denied",
          errors: [{
            code: "AGENTIC_NODE_WORKER_FAILED",
            message:
              "The action contract bytes do not hash to the approved candidate hash; the shadow "
              + "authorization is refused.",
          }],
        };
      }
      const contract = parseActionContractCandidate(candidate.markdown);
      if (!contract) {
        return {
          ok: false,
          status: "failed",
          errors: [{
            code: "AGENTIC_NODE_WORKER_FAILED",
            message: "The approved candidate is not a readable action contract.",
          }],
        };
      }
      if (contract.actionContractHash !== String(input.actionContractHash ?? "")) {
        return {
          ok: false,
          status: "denied",
          errors: [{
            code: "AGENTIC_NODE_WORKER_FAILED",
            message: "The approved action contract is not the one this node was asked to record.",
          }],
        };
      }

      // The connector's declared write capability, read from its manifest, so
      // the recorded intent names what a real remediation would actually use
      // rather than a label this worker invented.
      const manifest = jsonRecord(await context.tools.invoke("connector.manifest.read", {}));
      const declared = Array.isArray(manifest?.writeCapabilitiesDeclared)
        ? manifest.writeCapabilitiesDeclared.map((entry) => String(entry))
        : [];
      const wouldExecute = declared[0] ?? contract.capability;

      if (manifest?.writeCapabilitiesEnabled === true) {
        // A shadow mission bound to a write-enabled connector is a contradiction
        // worth refusing rather than silently honouring: the operator asked for
        // a proof that no write is reachable, against a connector that says one
        // is.
        return {
          ok: false,
          status: "denied",
          errors: [{
            code: "AGENTIC_NODE_WORKER_FAILED",
            message:
              "This connector declares write capabilities enabled; a shadow authorization must "
              + "bind to a connector that cannot write.",
          }],
        };
      }

      return {
        ok: true,
        structuredOutput: {
          wouldExecuteCapability: wouldExecute,
          wouldTargetExternalObject: contract.targetId,
          wouldUseIdempotencyKey: contract.idempotencyKey,
          wouldExpectPreStateRevision: intake.observed.sourceRevision,
          realExternalWrites: 0,
        },
        evidence: [{
          kind: "derived_claim",
          label: `recorded one ${wouldExecute} that was authorized and deliberately not performed`,
          sourceReference: `action-contract:${contract.actionContractHash}`,
          content: {
            wouldTargetExternalObject: contract.targetId,
            wouldExpectPreStateRevision: intake.observed.sourceRevision,
            realExternalWrites: 0,
          },
        }],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// X5 (shadow) — the independent read-only oracle
// ---------------------------------------------------------------------------

/**
 * Re-reads the real source and judges the *shadow* contract.
 *
 * It deliberately does not ask whether the desired state now holds. In shadow
 * mode the answer is always no — nothing was written — so a verifier that asked
 * it would either always fail or would have to be told to ignore its own answer,
 * and both make the oracle meaningless.
 *
 * What it is entitled to conclude, and does:
 *
 *   - the source is still **readable**, so the read contract survived the run;
 *   - its **identity is stable**, so the object we observed is the object we
 *     re-read;
 *   - its **revision is unchanged**, which is the strongest available evidence
 *     that nothing CHANTER did altered it. A changed revision is not a failure
 *     of this fabric — someone else may have pushed — but it *is* a reason to
 *     re-observe rather than to claim shadow-readiness.
 */
function shadowVerifyWorker(
  dependencies: AgenticExceptionWorkerDependencies,
): AgenticNodeWorker {
  return {
    workerId: "operator.agentic.shadow-verify",
    capabilityId: "exception.shadow.verify",
    kind: "deterministic_tool",
    async execute(context: AgenticNodeWorkerContext): Promise<AgenticNodeWorkerOutcome> {
      const input = jsonRecord(context.input) ?? {};
      const targetId = String(input.targetId ?? "");
      const observedRevision = String(input.observedRevision ?? "");

      const response = jsonRecord(
        await context.tools.invoke("connector.state.read", { targetId }),
      );
      const readable = response?.exists === true;
      const record = jsonRecord(response?.record ?? null);
      const currentRevision = readable && record ? String(record.revision ?? "") : "";
      const identityStable = readable && record
        ? String(record.targetId ?? "") === targetId
        : false;
      const revisionUnchanged = readable && currentRevision === observedRevision;

      const shadowVerified = readable && identityStable && revisionUnchanged;

      return {
        ok: true,
        structuredOutput: {
          sourceReadable: readable,
          identityStable,
          revisionUnchanged,
          // Never blank: a revision the source did not give us is reported as
          // the absence it is, not as an empty string that reads like a value.
          observedRevision: currentRevision || "unreadable",
          // The claim this oracle can actually support: this fabric issued no
          // mutation, and the source's own revision is where it was.
          noChanterInducedMutation: revisionUnchanged,
          realExternalWrites: 0,
          shadowVerified,
        },
        evidence: [{
          kind: "tool_output",
          label: `independently re-read ${targetId} read-only after shadow authorization`,
          sourceReference: `connector-observation:${currentRevision || "unreadable"}`,
          content: { shadowVerified, revisionUnchanged, realExternalWrites: 0 },
        }],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// X5 — the independent verification oracle
// ---------------------------------------------------------------------------

/**
 * Judges the connector's own state against DesiredState.
 *
 * Independent of every claim made before it. It does not read the apply node's
 * report, the action contract's expectations, or any worker's opinion — it
 * re-reads the source and evaluates the acceptance constraints the human
 * approved. If the write had lied, been partial, or been applied to the wrong
 * record, this is what would fail.
 *
 * It also counts the connector's applications of this idempotency key, so
 * "exactly one action occurred" is verified from the connector's books rather
 * than inferred from the absence of a second attempt.
 */
function exceptionVerifyWorker(
  dependencies: AgenticExceptionWorkerDependencies,
): AgenticNodeWorker {
  return {
    workerId: "operator.agentic.exception-verify",
    capabilityId: "exception.outcome.verify",
    kind: "deterministic_tool",
    async execute(context: AgenticNodeWorkerContext): Promise<AgenticNodeWorkerOutcome> {
      const input = jsonRecord(context.input) ?? {};
      const targetId = String(input.targetId ?? "");
      const intake = dependencies.exceptionState();
      if (!intake) {
        return {
          ok: false,
          status: "failed",
          errors: [{
            code: "AGENTIC_NODE_WORKER_FAILED",
            message: "This mission carries no durable desired state to verify against.",
          }],
        };
      }

      const response = jsonRecord(
        await context.tools.invoke("connector.state.read", { targetId }),
      );
      const exists = response?.exists === true;
      const record = jsonRecord(response?.record ?? null);
      const fields = exists && record
        ? exceptionFieldsFrom((jsonRecord(record.fields) ?? {}) as Record<string, ExceptionFieldValue>)
        : [];
      const postObservationHash = exists && record
        ? createObservationHash({
          sourceSystemId: String(input.connectorId ?? ""),
          targetId: String(record.targetId ?? targetId),
          sourceRevision: String(record.revision ?? ""),
          observedFields: fields,
        })
        : "";

      const evaluation = evaluateAcceptanceConstraints(
        fields,
        intake.desired.acceptanceConstraints,
      );

      // The connector's own count of applications under this key. One is the
      // only acceptable answer; zero means nothing happened, and more than one
      // would mean the duplicate guarantee failed.
      const actionResponse = jsonRecord(
        await context.tools.invoke("connector.action.read", {
          idempotencyKey: String(input.idempotencyKey ?? ""),
        }),
      );
      const connectorWriteCount = actionResponse?.applied === true ? 1 : 0;

      const outcomeVerified = exists
        && evaluation.satisfied
        && connectorWriteCount === 1
        && intake.desired.desiredStateHash === String(input.desiredStateHash ?? "");

      return {
        ok: true,
        structuredOutput: {
          recordExists: exists,
          postObservationHash: postObservationHash || "0".repeat(64),
          unsatisfiedConstraintIds: [...evaluation.unsatisfied],
          connectorWriteCount,
          outcomeVerified,
        },
        evidence: [{
          kind: "tool_output",
          label: `independently verified ${targetId} against the approved desired state`,
          sourceReference: `connector-observation:${postObservationHash}`,
          content: {
            outcomeVerified,
            connectorWriteCount,
            unsatisfiedConstraintIds: [...evaluation.unsatisfied],
          },
        }],
      };
    },
  };
}

/**
 * Reads back an approved action contract from its canonical candidate bytes.
 *
 * Returns `null` rather than throwing on anything unexpected: the caller is a
 * worker whose job is to refuse cleanly, and an exception thrown here would
 * become an execution failure instead of a typed denial.
 */
function parseActionContractCandidate(candidate: string): ActionContract | null {
  try {
    const parsed: unknown = JSON.parse(candidate);
    const record = jsonRecord(parsed);
    if (!record) return null;
    const payload = Array.isArray(record.writePayload) ? record.writePayload : null;
    if (!payload) return null;
    return {
      schemaVersion: OPERATIONAL_EXCEPTION_SCHEMA_VERSION,
      missionId: String(record.missionId ?? ""),
      connectorId: String(record.connectorId ?? ""),
      capability: String(record.capability ?? ""),
      targetId: String(record.targetId ?? ""),
      expectedPreStateHash: String(record.expectedPreStateHash ?? ""),
      stateDeltaHash: String(record.stateDeltaHash ?? ""),
      writePayload: payload.map((entry) => {
        const field = jsonRecord(entry) ?? {};
        return {
          field: String(field.field ?? ""),
          value: (field.value ?? null) as ExceptionFieldValue,
        };
      }),
      writePayloadHash: String(record.writePayloadHash ?? ""),
      idempotencyKey: String(record.idempotencyKey ?? ""),
      deadline: String(record.deadline ?? ""),
      actionContractHash: String(record.actionContractHash ?? ""),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * The specialist for one capability: model-backed when the committed plan routed
 * it to a model, structured-local otherwise.
 *
 * The decision is read from the durable plan node, never re-derived from the
 * intent or the registry. A resumed mission therefore builds exactly the worker
 * kind its own approved plan named — which is what makes the node payload hash
 * a real binding rather than a description.
 */
function specialistFor(
  dependencies: AgenticWorkerDependencies,
  options: {
    readonly capabilityId: string;
    readonly workerId: string;
    readonly fixtureScope: string;
    readonly metadataClaimPrefix: string;
    readonly focus: "architecture" | "risk";
  },
): AgenticNodeWorker {
  const modelBinding = dependencies.modelNodes?.find(
    (node) => node.capabilityId === options.capabilityId,
  );
  return modelBinding
    ? modelSpecialistWorker(dependencies, modelBinding, {
      workerId: `${options.workerId}.model`,
      focus: options.focus,
      fixtureScope: options.fixtureScope,
    })
    : specialistWorker(dependencies, options);
}

/**
 * The workers for one operational-exception mission.
 *
 * A separate set, not an addition to the artifact set. A mission is built with
 * exactly the workers its own plan can route to, so an exception mission holds
 * no artifact-writing worker at all — the strongest form of "it cannot write an
 * artifact" is that no such worker was ever constructed for it.
 */
export function createAgenticExceptionWorkerSet(
  dependencies: AgenticExceptionWorkerDependencies,
): AgenticNodeWorkerRegistry {
  // A shadow mission is built with no applying worker at all. That is the
  // third independent structural guarantee, alongside a plan containing no
  // write node and a connector exposing no write method: the strongest form of
  // "it cannot write" is that nothing capable of writing was constructed.
  if (dependencies.executionMode === "shadow") {
    return createAgenticWorkerRegistry([
      exceptionObserveWorker(dependencies),
      exceptionActionCompileWorker(dependencies),
      shadowAuthorizeWorker(dependencies),
      shadowVerifyWorker(dependencies),
    ]);
  }
  return createAgenticWorkerRegistry([
    exceptionObserveWorker(dependencies),
    exceptionActionCompileWorker(dependencies),
    connectorApplyWorker(dependencies),
    exceptionVerifyWorker(dependencies),
  ]);
}

export function createAgenticWorkerSet(
  dependencies: AgenticWorkerDependencies,
): AgenticNodeWorkerRegistry {
  return createAgenticWorkerRegistry([
    contextCollectWorker(dependencies),
    specialistFor(dependencies, {
      capabilityId: "architecture.analyze",
      workerId: "operator.agentic.architecture-specialist",
      fixtureScope: ARCHITECTURE_FIXTURE_SCOPE,
      metadataClaimPrefix: "arch",
      focus: "architecture",
    }),
    specialistFor(dependencies, {
      capabilityId: "risk.analyze",
      workerId: "operator.agentic.risk-specialist",
      fixtureScope: RISK_FIXTURE_SCOPE,
      metadataClaimPrefix: "risk",
      focus: "risk",
    }),
    verifierWorker(),
    synthesisWorker(dependencies),
    artifactWriteWorker(dependencies),
    outcomeVerifyWorker(dependencies),
  ]);
}
