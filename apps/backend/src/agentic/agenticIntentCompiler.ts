/**
 * CHANTER OS — deterministic intent contract compiler.
 *
 *     submission -> normalized intent contract -> canonical hash
 *
 * Every refusal below happens *before* a plan exists, which is the point: the
 * cheapest moment to discover that a mission cannot be executed safely is before
 * any worker, any context read, and any budget has been spent. A compiler that
 * accepted an under-budgeted or self-contradictory mission would push that
 * discovery to node six, after four workers had already been paid for.
 *
 * Two rules shape the whole module:
 *
 *   - **Never silently add a capability.** If a mission's output contract needs
 *     a capability the submission did not allow, that is a refusal naming the
 *     capability — not an implicit grant. An agentic fabric that quietly widens
 *     its own permissions has no bound at all.
 *   - **Record every default explicitly.** Anything the compiler supplied is
 *     listed in `defaultsApplied` with its reason, so a reader can tell the
 *     difference between what a human asked for and what this code assumed.
 *
 * Normalization is order-insensitive where order carries no meaning (capability
 * lists, constraints, criteria are sorted by their own ids), so two submissions
 * that differ only in ordering compile to identical bytes and identical hashes.
 */
import { OperatorError } from "../services/operatorService.js";
import {
  AGENTIC_ACCEPTANCE_CHECKS,
  AGENTIC_CONSTRAINT_KINDS,
  AGENTIC_CONTEXT_SOURCE_TYPES,
  AGENTIC_EXECUTION_POLICIES,
  AGENTIC_TRUST_CLASSES,
  AGENTIC_WORK_SCHEMA_VERSION,
  createAgenticIntentHash,
  type AgenticAcceptanceCheck,
  type AgenticAcceptanceCriterion,
  type AgenticAppliedDefault,
  type AgenticConstraint,
  type AgenticConstraintKind,
  type AgenticContextRequirement,
  type AgenticContextSourceType,
  type AgenticExecutionPolicy,
  type AgenticFreshnessPolicy,
  AGENTIC_MISSION_KINDS,
  type AgenticExceptionIntent,
  type AgenticIntentContract,
  type AgenticMissionKind,
  type AgenticOutputContract,
  type AgenticProviderBindingSelection,
  type AgenticTrustClass,
} from "./agenticMissionContract.js";
import type {
  ExceptionAcceptanceConstraint,
  ExceptionField,
  ExceptionFieldValue,
} from "./agenticExceptionContract.js";
import {
  AGENTIC_ARTIFACT_MISSION_CAPABILITIES,
  AGENTIC_EXCEPTION_MISSION_CAPABILITIES,
  minimumExecutablePlanDurationMs,
  resolveAgenticCapability,
} from "./agenticCapabilityRegistry.js";
import { assertBindingSelectable } from "./agenticProviderRegistry.js";
import type { AgenticRiskClass, AgenticVerifiabilityClass } from "chanter-agent-runtime";

const SUPPORTED_RISK_CLASSES: readonly AgenticRiskClass[] = ["read_only", "local_write"];

const SUPPORTED_VERIFIABILITY_CLASSES: readonly AgenticVerifiabilityClass[] = [
  "deterministic",
  "evidence_verifiable",
  "human_judgment_required",
];

const FRESHNESS_POLICIES: readonly AgenticFreshnessPolicy[] = [
  "any",
  "compiled_at_submission",
  "max_age_seconds",
];

/** Concurrency below this cannot produce the independent specialist work the plan needs. */
export const AGENTIC_MINIMUM_PARALLELISM = 2;

/**
 * Wall-clock an operational-exception plan needs to be executable at all.
 *
 * The sum of the five nodes' declared budgets, with the human checkpoint
 * contributing nothing because a human is not on a compute clock. Stated as a
 * constant rather than derived, so a submission is refused at compile time with
 * a number a human can check against the capability registry.
 */
export const EXCEPTION_PLAN_MINIMUM_DURATION_MS = 65_000;

const MAX_TEXT = 4000;
const MAX_LIST = 32;

function refuse(code: string, message: string, status = 400): never {
  throw new OperatorError(message, status, code);
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredText(value: unknown, field: string, max = MAX_TEXT): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    refuse("AGENTIC_INTENT_FIELD_INVALID", `${field} must be a non-empty string of at most ${max} characters.`);
  }
  return value.trim();
}

function boundedIdentifier(value: unknown, field: string): string {
  const text = requiredText(value, field, 200);
  if (text !== text.trim() || /\s/.test(text)) {
    refuse("AGENTIC_INTENT_FIELD_INVALID", `${field} must be a whitespace-free identifier.`);
  }
  return text;
}

function requiredArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LIST) {
    refuse(
      "AGENTIC_INTENT_FIELD_INVALID",
      `${field} must be a non-empty array of at most ${MAX_LIST} entries.`,
    );
  }
  return value;
}

function optionalArray(value: unknown, field: string): readonly unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_LIST) {
    refuse("AGENTIC_INTENT_FIELD_INVALID", `${field} must be an array of at most ${MAX_LIST} entries.`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    refuse("AGENTIC_INTENT_FIELD_INVALID", `${field} must be a positive integer.`);
  }
  return value;
}

function optionalPositiveInteger(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  return positiveInteger(value, field);
}

// ---------------------------------------------------------------------------
// Field compilers
// ---------------------------------------------------------------------------

function compileConstraints(raw: readonly unknown[]): AgenticConstraint[] {
  const constraints: AgenticConstraint[] = [];
  const seenIds = new Set<string>();
  for (const entry of raw) {
    const record = jsonObject(entry);
    if (!record) refuse("AGENTIC_INTENT_FIELD_INVALID", "Each constraint must be an object.");
    const constraintId = boundedIdentifier(record.constraintId, "constraints[].constraintId");
    if (seenIds.has(constraintId)) {
      refuse("AGENTIC_INTENT_FIELD_INVALID", `Constraint ${constraintId} is declared twice.`);
    }
    seenIds.add(constraintId);
    const kind = record.kind;
    if (typeof kind !== "string" || !AGENTIC_CONSTRAINT_KINDS.includes(kind as AgenticConstraintKind)) {
      refuse(
        "AGENTIC_INTENT_FIELD_INVALID",
        `Constraint ${constraintId} must declare kind ${AGENTIC_CONSTRAINT_KINDS.join(" or ")}.`,
      );
    }
    constraints.push({
      constraintId,
      kind: kind as AgenticConstraintKind,
      subject: requiredText(record.subject, `constraints[${constraintId}].subject`, 200).toLowerCase(),
      statement: requiredText(record.statement, `constraints[${constraintId}].statement`),
    });
  }

  // One subject asserted both ways is a contradiction the mission cannot
  // satisfy, and no downstream node could resolve it — so it is refused here
  // rather than left to be discovered as a mysterious verification failure.
  const bySubject = new Map<string, Set<AgenticConstraintKind>>();
  for (const constraint of constraints) {
    const kinds = bySubject.get(constraint.subject) ?? new Set<AgenticConstraintKind>();
    kinds.add(constraint.kind);
    bySubject.set(constraint.subject, kinds);
  }
  for (const [subject, kinds] of bySubject) {
    if (kinds.size > 1) {
      refuse(
        "AGENTIC_INTENT_CONSTRAINTS_CONTRADICTORY",
        `Constraints both require and forbid "${subject}"; the mission cannot satisfy both.`,
        409,
      );
    }
  }
  return constraints.sort((left, right) => left.constraintId.localeCompare(right.constraintId));
}

function compileAcceptanceCriteria(raw: readonly unknown[]): AgenticAcceptanceCriterion[] {
  const criteria: AgenticAcceptanceCriterion[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const record = jsonObject(entry);
    if (!record) refuse("AGENTIC_INTENT_FIELD_INVALID", "Each acceptance criterion must be an object.");
    const criterionId = boundedIdentifier(record.criterionId, "acceptanceCriteria[].criterionId");
    if (seen.has(criterionId)) {
      refuse("AGENTIC_INTENT_FIELD_INVALID", `Acceptance criterion ${criterionId} is declared twice.`);
    }
    seen.add(criterionId);
    const check = record.check;
    if (typeof check !== "string" || !AGENTIC_ACCEPTANCE_CHECKS.includes(check as AgenticAcceptanceCheck)) {
      refuse(
        "AGENTIC_INTENT_FIELD_INVALID",
        `Acceptance criterion ${criterionId} must declare one of: ${AGENTIC_ACCEPTANCE_CHECKS.join(", ")}.`,
      );
    }
    // An absent parameter and an explicitly empty one mean the same thing: this
    // check takes no argument. Treating `""` as a malformed value would refuse
    // a submission that is saying exactly what the contract permits.
    const parameter = record.parameter === undefined || record.parameter === null
      || record.parameter === ""
      ? ""
      : requiredText(record.parameter, `acceptanceCriteria[${criterionId}].parameter`, 200);
    if ((check === "artifact_section_present" || check === "evidence_coverage_minimum") && !parameter) {
      refuse(
        "AGENTIC_INTENT_FIELD_INVALID",
        `Acceptance criterion ${criterionId} uses check ${check}, which requires a parameter.`,
      );
    }
    criteria.push({
      criterionId,
      statement: requiredText(record.statement, `acceptanceCriteria[${criterionId}].statement`),
      check: check as AgenticAcceptanceCheck,
      parameter,
    });
  }
  return criteria.sort((left, right) => left.criterionId.localeCompare(right.criterionId));
}

function compileContextRequirements(raw: readonly unknown[]): AgenticContextRequirement[] {
  const requirements: AgenticContextRequirement[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const record = jsonObject(entry);
    if (!record) refuse("AGENTIC_INTENT_FIELD_INVALID", "Each context requirement must be an object.");
    const requirementId = boundedIdentifier(record.requirementId, "contextRequirements[].requirementId");
    if (seen.has(requirementId)) {
      refuse("AGENTIC_INTENT_FIELD_INVALID", `Context requirement ${requirementId} is declared twice.`);
    }
    seen.add(requirementId);

    const sourceType = record.sourceType;
    if (
      typeof sourceType !== "string"
      || !AGENTIC_CONTEXT_SOURCE_TYPES.includes(sourceType as AgenticContextSourceType)
    ) {
      refuse(
        "AGENTIC_INTENT_FIELD_INVALID",
        `Context requirement ${requirementId} must declare one of: ${AGENTIC_CONTEXT_SOURCE_TYPES.join(", ")}.`,
      );
    }
    const freshnessPolicy = record.freshnessPolicy ?? "any";
    if (
      typeof freshnessPolicy !== "string"
      || !FRESHNESS_POLICIES.includes(freshnessPolicy as AgenticFreshnessPolicy)
    ) {
      refuse(
        "AGENTIC_INTENT_FIELD_INVALID",
        `Context requirement ${requirementId} must declare one of: ${FRESHNESS_POLICIES.join(", ")}.`,
      );
    }
    const maxAgeSeconds = freshnessPolicy === "max_age_seconds"
      ? positiveInteger(record.maxAgeSeconds, `contextRequirements[${requirementId}].maxAgeSeconds`)
      : null;
    const trustClass = record.trustClass ?? "authoritative";
    if (typeof trustClass !== "string" || !AGENTIC_TRUST_CLASSES.includes(trustClass as AgenticTrustClass)) {
      refuse(
        "AGENTIC_INTENT_FIELD_INVALID",
        `Context requirement ${requirementId} must declare one of: ${AGENTIC_TRUST_CLASSES.join(", ")}.`,
      );
    }
    requirements.push({
      requirementId,
      sourceType: sourceType as AgenticContextSourceType,
      sourceIdentity: requiredText(record.sourceIdentity, `contextRequirements[${requirementId}].sourceIdentity`, 400),
      freshnessPolicy: freshnessPolicy as AgenticFreshnessPolicy,
      maxAgeSeconds,
      trustClass: trustClass as AgenticTrustClass,
      scope: requiredText(record.scope ?? "mission", `contextRequirements[${requirementId}].scope`, 200),
      required: record.required !== false,
    });
  }
  return requirements.sort((left, right) => left.requirementId.localeCompare(right.requirementId));
}

/**
 * Compiles the output contract.
 *
 * "Ambiguous" is not a judgement call here: an artifact with no name, no
 * required sections, or duplicate sections cannot be verified by N8, because
 * there is no unambiguous statement of what the artifact must contain.
 */
function compileOutputContract(raw: unknown): AgenticOutputContract {
  const record = jsonObject(raw);
  if (!record) {
    refuse("AGENTIC_INTENT_OUTPUT_CONTRACT_AMBIGUOUS", "outputContract must be an object.");
  }
  if (record.format !== "markdown") {
    refuse(
      "AGENTIC_INTENT_OUTPUT_CONTRACT_AMBIGUOUS",
      "outputContract.format must be markdown; no other output format is supported.",
    );
  }
  const artifactName = requiredText(record.artifactName, "outputContract.artifactName", 200);
  if (!/^[A-Za-z0-9._-]+$/.test(artifactName)) {
    refuse(
      "AGENTIC_INTENT_OUTPUT_CONTRACT_AMBIGUOUS",
      "outputContract.artifactName must be a plain file name with no path segments.",
    );
  }
  const rawSections = record.requiredSections;
  if (!Array.isArray(rawSections) || rawSections.length === 0 || rawSections.length > 16) {
    refuse(
      "AGENTIC_INTENT_OUTPUT_CONTRACT_AMBIGUOUS",
      "outputContract.requiredSections must name between 1 and 16 sections.",
    );
  }
  const sections = rawSections.map((entry, index) =>
    requiredText(entry, `outputContract.requiredSections[${index}]`, 120));
  if (new Set(sections).size !== sections.length) {
    refuse(
      "AGENTIC_INTENT_OUTPUT_CONTRACT_AMBIGUOUS",
      "outputContract.requiredSections contains a duplicate section name.",
    );
  }
  return { format: "markdown", artifactName, requiredSections: sections };
}

/**
 * Compiles the declared terminal condition for an operational exception.
 *
 * Every refusal here exists because the alternative is an unverifiable mission.
 * A desired state with no fields states no outcome; one with no acceptance
 * constraints gives the oracle nothing to judge; a field the connector cannot
 * write compiles an action that will always be refused at the boundary, after a
 * human has already approved it.
 */
function compileExceptionContract(raw: unknown): AgenticExceptionIntent {
  const record = jsonObject(raw);
  if (!record) {
    refuse("AGENTIC_INTENT_EXCEPTION_CONTRACT_AMBIGUOUS", "exceptionContract must be an object.");
  }
  const connectorId = boundedIdentifier(record.connectorId, "exceptionContract.connectorId");
  const targetId = requiredText(record.targetId, "exceptionContract.targetId", 120);

  const rawFields = record.desiredFields;
  if (!Array.isArray(rawFields) || rawFields.length === 0 || rawFields.length > 16) {
    refuse(
      "AGENTIC_INTENT_EXCEPTION_CONTRACT_AMBIGUOUS",
      "exceptionContract.desiredFields must state between 1 and 16 fields.",
    );
  }
  const desiredFields: ExceptionField[] = rawFields.map((entry, index) => {
    const field = jsonObject(entry);
    if (!field) {
      refuse(
        "AGENTIC_INTENT_EXCEPTION_CONTRACT_AMBIGUOUS",
        `exceptionContract.desiredFields[${index}] must be an object.`,
      );
    }
    return {
      field: requiredText(field.field, `exceptionContract.desiredFields[${index}].field`, 120),
      value: exceptionFieldValue(field.value, `exceptionContract.desiredFields[${index}].value`),
    };
  });
  if (new Set(desiredFields.map((entry) => entry.field)).size !== desiredFields.length) {
    refuse(
      "AGENTIC_INTENT_EXCEPTION_CONTRACT_AMBIGUOUS",
      "exceptionContract.desiredFields names the same field twice.",
    );
  }

  const rawConstraints = record.acceptanceConstraints;
  if (!Array.isArray(rawConstraints) || rawConstraints.length === 0 || rawConstraints.length > 16) {
    refuse(
      "AGENTIC_INTENT_EXCEPTION_CONTRACT_AMBIGUOUS",
      "exceptionContract.acceptanceConstraints must state between 1 and 16 constraints.",
    );
  }
  const acceptanceConstraints: ExceptionAcceptanceConstraint[] = rawConstraints.map((entry, index) => {
    const constraint = jsonObject(entry);
    if (!constraint) {
      refuse(
        "AGENTIC_INTENT_EXCEPTION_CONTRACT_AMBIGUOUS",
        `exceptionContract.acceptanceConstraints[${index}] must be an object.`,
      );
    }
    if (constraint.comparison !== "equals") {
      refuse(
        "AGENTIC_INTENT_EXCEPTION_CONTRACT_AMBIGUOUS",
        `exceptionContract.acceptanceConstraints[${index}].comparison must be "equals".`,
      );
    }
    return {
      constraintId: boundedIdentifier(
        constraint.constraintId,
        `exceptionContract.acceptanceConstraints[${index}].constraintId`,
      ),
      field: requiredText(
        constraint.field,
        `exceptionContract.acceptanceConstraints[${index}].field`,
        120,
      ),
      comparison: "equals" as const,
      value: exceptionFieldValue(
        constraint.value,
        `exceptionContract.acceptanceConstraints[${index}].value`,
      ),
      statement: requiredText(
        constraint.statement,
        `exceptionContract.acceptanceConstraints[${index}].statement`,
        400,
      ),
    };
  });
  if (new Set(acceptanceConstraints.map((entry) => entry.constraintId)).size
    !== acceptanceConstraints.length) {
    refuse(
      "AGENTIC_INTENT_EXCEPTION_CONTRACT_AMBIGUOUS",
      "exceptionContract.acceptanceConstraints reuses a constraint id.",
    );
  }

  // Every constraint must judge a field the mission actually sets. A constraint
  // over an unstated field could never be satisfied by this action, so the
  // mission would be unverifiable by construction.
  const stated = new Set(desiredFields.map((entry) => entry.field));
  const orphaned = acceptanceConstraints
    .filter((constraint) => !stated.has(constraint.field))
    .map((constraint) => constraint.constraintId);
  if (orphaned.length > 0) {
    refuse(
      "AGENTIC_INTENT_EXCEPTION_CONTRACT_AMBIGUOUS",
      `exceptionContract.acceptanceConstraints ${orphaned.sort().join(", ")} judge fields the `
      + "desired state does not state.",
    );
  }

  return { connectorId, targetId, desiredFields, acceptanceConstraints };
}

/** One bounded operational value. Objects and arrays are refused, not coerced. */
function exceptionFieldValue(raw: unknown, field: string): ExceptionFieldValue {
  if (raw === null) return null;
  if (typeof raw === "string") {
    if (raw.length > 400) refuse("AGENTIC_INTENT_EXCEPTION_CONTRACT_AMBIGUOUS", `${field} is too long.`);
    return raw;
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      refuse("AGENTIC_INTENT_EXCEPTION_CONTRACT_AMBIGUOUS", `${field} must be a finite number.`);
    }
    return raw;
  }
  if (typeof raw === "boolean") return raw;
  refuse(
    "AGENTIC_INTENT_EXCEPTION_CONTRACT_AMBIGUOUS",
    `${field} must be a string, finite number, boolean, or null.`,
  );
}

function compileCapabilityList(raw: readonly unknown[], field: string): string[] {
  const capabilities = raw.map((entry, index) => boundedIdentifier(entry, `${field}[${index}]`));
  for (const capabilityId of capabilities) {
    if (!resolveAgenticCapability(capabilityId)) {
      refuse(
        "AGENTIC_INTENT_CAPABILITY_UNREGISTERED",
        `${field} names ${capabilityId}, which is not a registered capability.`,
        409,
      );
    }
  }
  return [...new Set(capabilities)].sort();
}

// ---------------------------------------------------------------------------
// Execution policy
// ---------------------------------------------------------------------------

/**
 * Compiles how much intelligence this mission is permitted to spend.
 *
 * Three refusals happen here, all before a plan exists:
 *
 *   - a policy value nobody registered;
 *   - a provider binding the closed registry does not carry, or that this
 *     capability is not authorized to reach;
 *   - a binding attached to a capability the registry declares deterministic.
 *
 * The last one is the important one. A deterministic capability authorizes no
 * binding at all, so "force the verifier onto a model" is refused *naming the
 * capability* rather than quietly honoured. A fabric that let a mission decide
 * which of its own checks are probabilistic has no checks.
 *
 * A mission that declares `model_required_for_judgment` and selects nothing is
 * not under-specified: the reviewed registry's preference order supplies the
 * binding, and the choice is recorded in `defaultsApplied` so a reader can tell
 * what a human asked for from what this code assumed.
 */
function compileExecutionPolicy(
  rawPolicy: unknown,
  rawBindings: unknown,
  allowedCapabilities: readonly string[],
  defaultsApplied: AgenticAppliedDefault[],
): {
  executionPolicy: AgenticExecutionPolicy;
  providerBindings: readonly AgenticProviderBindingSelection[];
} {
  let executionPolicy: AgenticExecutionPolicy = "cheapest_sufficient";
  if (rawPolicy === undefined || rawPolicy === null) {
    defaultsApplied.push({
      field: "executionPolicy",
      value: "cheapest_sufficient",
      reason:
        "No execution policy was declared, so the cheapest sufficient worker is used for every capability "
        + "and no inference is spent.",
    });
  } else if (typeof rawPolicy !== "string" || !AGENTIC_EXECUTION_POLICIES.includes(rawPolicy as AgenticExecutionPolicy)) {
    refuse(
      "AGENTIC_INTENT_FIELD_INVALID",
      `executionPolicy must be one of: ${AGENTIC_EXECUTION_POLICIES.join(", ")}.`,
    );
  } else {
    executionPolicy = rawPolicy as AgenticExecutionPolicy;
  }

  const selections = new Map<string, string>();
  for (const [index, entry] of optionalArray(rawBindings, "providerBindings").entries()) {
    const record = jsonObject(entry);
    if (!record) {
      refuse("AGENTIC_INTENT_FIELD_INVALID", `providerBindings[${index}] must be an object.`);
    }
    const capabilityId = boundedIdentifier(record.capabilityId, `providerBindings[${index}].capabilityId`);
    const bindingId = boundedIdentifier(record.bindingId, `providerBindings[${index}].bindingId`);
    if (!allowedCapabilities.includes(capabilityId)) {
      refuse(
        "AGENTIC_INTENT_CAPABILITY_NOT_ALLOWED",
        `providerBindings names ${capabilityId}, which this mission did not allow.`,
        409,
      );
    }
    if (selections.has(capabilityId) && selections.get(capabilityId) !== bindingId) {
      refuse(
        "AGENTIC_INTENT_CONSTRAINTS_CONTRADICTORY",
        `providerBindings names two different bindings for ${capabilityId}.`,
        409,
      );
    }
    // Throws a typed 409 naming the capability and every binding it may reach.
    assertBindingSelectable(capabilityId, bindingId);
    selections.set(capabilityId, bindingId);
  }

  // A selection under `cheapest_sufficient` would be inert — the router would
  // never reach a model to apply it — so it is refused rather than accepted and
  // ignored. Silently accepting a field that changes nothing is how a caller
  // comes to believe something is configured when it is not.
  if (executionPolicy === "cheapest_sufficient" && selections.size > 0) {
    refuse(
      "AGENTIC_INTENT_CONSTRAINTS_CONTRADICTORY",
      "providerBindings were declared under executionPolicy cheapest_sufficient, which routes no capability "
      + "to a model worker. Declare executionPolicy model_required_for_judgment to use them.",
      409,
    );
  }

  return {
    executionPolicy,
    providerBindings: [...selections.entries()]
      .map(([capabilityId, bindingId]) => ({ capabilityId, bindingId }))
      .sort((left, right) => left.capabilityId.localeCompare(right.capabilityId)),
  };
}

// ---------------------------------------------------------------------------
// The compiler
// ---------------------------------------------------------------------------

export function compileAgenticIntent(rawBody: unknown): AgenticIntentContract {
  const body = jsonObject(rawBody);
  if (!body) refuse("AGENTIC_INTENT_FIELD_INVALID", "Request body must be an object.");
  if (body.schemaVersion !== AGENTIC_WORK_SCHEMA_VERSION) {
    refuse(
      "AGENTIC_INTENT_FIELD_INVALID",
      `schemaVersion must be ${AGENTIC_WORK_SCHEMA_VERSION}.`,
    );
  }

  const defaultsApplied: AgenticAppliedDefault[] = [];
  const missionId = boundedIdentifier(body.missionId, "missionId");
  const traceId = body.traceId === undefined || body.traceId === null
    ? (defaultsApplied.push({
      field: "traceId",
      value: missionId,
      reason: "No trace id was supplied, so the mission id is used as its own correlation identity.",
    }), missionId)
    : boundedIdentifier(body.traceId, "traceId");

  const objective = requiredText(body.objective, "objective", 2000);
  const rawConstraints = optionalArray(body.constraints, "constraints");
  const constraints = compileConstraints(rawConstraints);
  const acceptanceCriteria = compileAcceptanceCriteria(
    requiredArray(body.acceptanceCriteria, "acceptanceCriteria"),
  );

  const riskClass = body.riskClass;
  if (typeof riskClass !== "string" || !SUPPORTED_RISK_CLASSES.includes(riskClass as AgenticRiskClass)) {
    refuse(
      "AGENTIC_INTENT_RISK_ACTION_UNSUPPORTED",
      `riskClass must be one of: ${SUPPORTED_RISK_CLASSES.join(", ")}. `
      + "External and irreversible missions are not executable by this fabric.",
      409,
    );
  }
  const verifiabilityClass = body.verifiabilityClass;
  if (
    typeof verifiabilityClass !== "string"
    || !SUPPORTED_VERIFIABILITY_CLASSES.includes(verifiabilityClass as AgenticVerifiabilityClass)
  ) {
    refuse(
      "AGENTIC_INTENT_FIELD_INVALID",
      `verifiabilityClass must be one of: ${SUPPORTED_VERIFIABILITY_CLASSES.join(", ")}.`,
    );
  }

  // The kind decides which plan is compiled, so it is resolved before anything
  // kind-specific is read. Defaulting to `artifact` keeps every existing
  // submission valid unchanged, and the default is recorded rather than assumed.
  const rawMissionKind = body.missionKind ?? "artifact";
  if (typeof rawMissionKind !== "string"
    || !AGENTIC_MISSION_KINDS.includes(rawMissionKind as AgenticMissionKind)) {
    refuse(
      "AGENTIC_INTENT_FIELD_INVALID",
      `missionKind must be one of: ${AGENTIC_MISSION_KINDS.join(", ")}.`,
    );
  }
  const missionKind = rawMissionKind as AgenticMissionKind;
  if (body.missionKind === undefined) {
    defaultsApplied.push({
      field: "missionKind",
      value: "artifact",
      reason: "No mission kind was declared, so the artifact-producing plan was compiled.",
    });
  }

  // Exactly one of the two output shapes, never both. A submission carrying an
  // artifact contract *and* an exception contract has not said what it wants,
  // and picking one would be the compiler deciding on the human's behalf.
  const isException = missionKind === "operational_exception";
  if (isException && body.outputContract !== undefined) {
    refuse(
      "AGENTIC_INTENT_OUTPUT_CONTRACT_AMBIGUOUS",
      "An operational-exception mission writes no artifact, so it must declare no outputContract.",
      409,
    );
  }
  if (!isException && body.exceptionContract !== undefined) {
    refuse(
      "AGENTIC_INTENT_EXCEPTION_CONTRACT_AMBIGUOUS",
      "An artifact mission resolves no operational exception, so it must declare no exceptionContract.",
      409,
    );
  }
  const outputContract = isException ? null : compileOutputContract(body.outputContract);
  const exceptionContract = isException ? compileExceptionContract(body.exceptionContract) : null;

  const allowedCapabilities = compileCapabilityList(
    requiredArray(body.allowedCapabilities, "allowedCapabilities"),
    "allowedCapabilities",
  );
  const forbiddenCapabilities = compileCapabilityList(
    optionalArray(body.forbiddenCapabilities, "forbiddenCapabilities"),
    "forbiddenCapabilities",
  );
  const overlapping = allowedCapabilities.filter((capability) => forbiddenCapabilities.includes(capability));
  if (overlapping.length > 0) {
    refuse(
      "AGENTIC_INTENT_CONSTRAINTS_CONTRADICTORY",
      `Capability ${overlapping[0]} is both allowed and forbidden.`,
      409,
    );
  }

  // The mission's declared risk class must cover the risk its own output
  // contract implies. A mission that asks for an artifact while declaring itself
  // read-only is refused rather than quietly promoted.
  const writesArtifact = allowedCapabilities.includes("artifact.local.write");
  if (writesArtifact && riskClass !== "local_write") {
    refuse(
      "AGENTIC_INTENT_RISK_ACTION_UNSUPPORTED",
      "A mission permitted to write a local artifact must declare riskClass local_write.",
      409,
    );
  }

  const authorityPolicy = jsonObject(body.authorityPolicy);
  if (!authorityPolicy) {
    refuse("AGENTIC_INTENT_AUTHORITY_POLICY_REQUIRED", "authorityPolicy must be an object.", 409);
  }
  const approvalRequiredCapabilities = compileCapabilityList(
    optionalArray(authorityPolicy.approvalRequiredCapabilities, "authorityPolicy.approvalRequiredCapabilities"),
    "authorityPolicy.approvalRequiredCapabilities",
  );
  const rawRiskClasses = optionalArray(
    authorityPolicy.approvalRequiredRiskClasses,
    "authorityPolicy.approvalRequiredRiskClasses",
  );
  const approvalRequiredRiskClasses = [...new Set(rawRiskClasses.map((entry, index) => {
    const value = boundedIdentifier(entry, `authorityPolicy.approvalRequiredRiskClasses[${index}]`);
    if (!SUPPORTED_RISK_CLASSES.includes(value as AgenticRiskClass)) {
      refuse(
        "AGENTIC_INTENT_FIELD_INVALID",
        `authorityPolicy.approvalRequiredRiskClasses names unsupported risk class ${value}.`,
      );
    }
    return value as AgenticRiskClass;
  }))].sort();
  const approverRole = requiredText(
    authorityPolicy.approverRole ?? "founder",
    "authorityPolicy.approverRole",
    120,
  );

  // A consequential mission with no approval policy would have no human
  // boundary at all, so it is refused at compile time — the one place where
  // refusing costs nothing.
  if (
    riskClass === "local_write"
    && approvalRequiredCapabilities.length === 0
    && !approvalRequiredRiskClasses.includes("local_write")
  ) {
    refuse(
      "AGENTIC_INTENT_AUTHORITY_POLICY_REQUIRED",
      "A local_write mission must name the capability or risk class that requires human approval.",
      409,
    );
  }

  // Capability sufficiency. Never widened silently: a required capability that
  // was forbidden or simply not allowed is named in the refusal. The required
  // set follows the mission kind, so an exception mission is not asked to
  // permit artifact capabilities it will never route to.
  const requiredCapabilities = isException
    ? AGENTIC_EXCEPTION_MISSION_CAPABILITIES
    : AGENTIC_ARTIFACT_MISSION_CAPABILITIES;
  for (const required of requiredCapabilities) {
    if (forbiddenCapabilities.includes(required)) {
      refuse(
        "AGENTIC_INTENT_FORBIDDEN_CAPABILITY_REQUIRED",
        `This mission's output contract requires ${required}, which it forbids.`,
        409,
      );
    }
    if (!allowedCapabilities.includes(required)) {
      refuse(
        "AGENTIC_INTENT_CAPABILITY_NOT_ALLOWED",
        `This mission's output contract requires ${required}, which it does not allow. `
        + "The compiler never grants a capability a mission did not request.",
        409,
      );
    }
  }

  // Compiled before the budget check, because how much a plan costs depends on
  // whether its judgement nodes run on a model.
  const { executionPolicy, providerBindings } = compileExecutionPolicy(
    body.executionPolicy,
    body.providerBindings,
    allowedCapabilities,
    defaultsApplied,
  );

  const timeBudgetMs = positiveInteger(body.timeBudgetMs, "timeBudgetMs");
  // The exception plan is a short linear chain of deterministic nodes, so the
  // artifact plan's minimum would demand a budget it can never spend. The bound
  // still exists — it is just the bound of the plan actually being compiled.
  const minimumDuration = isException
    ? EXCEPTION_PLAN_MINIMUM_DURATION_MS
    : minimumExecutablePlanDurationMs(executionPolicy);
  if (timeBudgetMs < minimumDuration) {
    refuse(
      "AGENTIC_INTENT_BUDGET_BELOW_MINIMUM",
      `timeBudgetMs ${timeBudgetMs} is below the ${minimumDuration}ms this mission's plan requires under `
      + `executionPolicy ${executionPolicy}.`,
      409,
    );
  }
  const maxParallelism = positiveInteger(body.maxParallelism, "maxParallelism");
  // An exception plan has no independent siblings — every node depends on the
  // one before it — so demanding parallelism would be demanding capacity the
  // plan cannot use. One is the honest floor for a chain.
  const minimumParallelism = isException ? 1 : AGENTIC_MINIMUM_PARALLELISM;
  if (maxParallelism < minimumParallelism) {
    refuse(
      "AGENTIC_INTENT_BUDGET_BELOW_MINIMUM",
      `maxParallelism must be at least ${minimumParallelism} for this mission's plan shape.`,
      409,
    );
  }

  // An exception mission's evidence is the connector's own state, read live by
  // the observe node, so it may legitimately admit no fixture context at all.
  const contextRequirements = compileContextRequirements(
    isException
      ? optionalArray(body.contextRequirements, "contextRequirements")
      : requiredArray(body.contextRequirements, "contextRequirements"),
  );

  const requestedAt = requiredText(body.requestedAt ?? new Date().toISOString(), "requestedAt", 40);
  if (Number.isNaN(Date.parse(requestedAt))) {
    refuse("AGENTIC_INTENT_FIELD_INVALID", "requestedAt must be a valid ISO-8601 instant.");
  }
  if (body.requestedAt === undefined || body.requestedAt === null) {
    defaultsApplied.push({
      field: "requestedAt",
      value: requestedAt,
      reason: "No request instant was supplied, so compilation time was recorded.",
    });
  }

  const withoutHash: Omit<AgenticIntentContract, "intentHash"> = {
    schemaVersion: AGENTIC_WORK_SCHEMA_VERSION,
    missionId,
    traceId,
    workspaceId: boundedIdentifier(body.workspaceId, "workspaceId"),
    actorId: boundedIdentifier(body.actorId, "actorId"),
    objective,
    constraints,
    acceptanceCriteria,
    riskClass: riskClass as AgenticRiskClass,
    verifiabilityClass: verifiabilityClass as AgenticVerifiabilityClass,
    authorityPolicy: { approvalRequiredCapabilities, approvalRequiredRiskClasses, approverRole },
    costBudgetMicros: optionalPositiveInteger(body.costBudgetMicros, "costBudgetMicros"),
    tokenBudget: optionalPositiveInteger(body.tokenBudget, "tokenBudget"),
    timeBudgetMs,
    maxParallelism,
    allowedCapabilities,
    forbiddenCapabilities,
    executionPolicy,
    providerBindings,
    modelNodeCostCeilingMicros: optionalPositiveInteger(
      body.modelNodeCostCeilingMicros,
      "modelNodeCostCeilingMicros",
    ),
    contextRequirements,
    missionKind,
    outputContract,
    exceptionContract,
    requestedAt,
    humanText: {
      objective,
      constraints: constraints.map((constraint) => constraint.statement),
      acceptanceCriteria: acceptanceCriteria.map((criterion) => criterion.statement),
    },
    defaultsApplied: defaultsApplied.sort((left, right) => left.field.localeCompare(right.field)),
  };

  return { ...withoutHash, intentHash: createAgenticIntentHash(withoutHash) };
}

/**
 * Refuses a resubmission whose compiled intent differs from the durable one.
 *
 * A mission identity is a promise that later approvals, plans, and artifacts all
 * refer to one thing. Letting a resubmission redefine it would silently move
 * every one of those bindings, so a changed intent under a known id is a typed
 * conflict rather than an update.
 */
export function assertAgenticIntentUnchanged(
  storedIntentHash: string,
  submitted: AgenticIntentContract,
): void {
  if (storedIntentHash !== submitted.intentHash) {
    throw new OperatorError(
      "This mission id already exists with a different compiled intent.",
      409,
      "AGENTIC_INTENT_CONFLICT",
      {
        missionId: submitted.missionId,
        storedIntentHash,
        submittedIntentHash: submitted.intentHash,
      },
    );
  }
}
