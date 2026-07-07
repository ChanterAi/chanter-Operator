// ── CHANTER Operator P1A: Operator Runtime Bridge ──
//
// Composes the mirrored chanter-agent-runtime primitives (contract.ts,
// redaction.ts, tasks.ts, evidence.ts, policy.ts, providerRouting.ts) into
// the Operator-facing bridge API. This is the module Operator code should
// import from — everything else in runtimeBridge/ is plumbing.
//
// Decision-only, contract-only:
//   - Represents Operator work as CHANTER runtime tasks.
//   - Evaluates Operator actions (read/write/shell/network/commit/deploy/
//     publish/delete) against the shared runtime policy — never performs them.
//   - Builds redacted, JSON-safe evidence/review bundles.
//   - Selects a provider/tool route from an in-memory candidate list — never
//     calls a model, tool, or network endpoint.
//   - Reports its own readiness against Operator's existing readiness gate
//     vocabulary, without registering into the closed P1.5 adapter catalog
//     (see the readiness section below for why).
//
// No execution. No network. No cross-repo imports. No commits/deploys/posts.

import type { ActionType } from "../../types.js";
import type { AdapterReadinessStatus } from "../adapters/adapterReadiness.js";
import type {
  JsonValue,
  RuntimeExecutionPolicy,
  RuntimeProduct,
  RuntimeRiskLevel,
  RuntimeTask,
} from "./contract.js";
import { createTask, type CreateTaskInput } from "./tasks.js";
import { createEvidenceBundle, summarizeTaskForReview, type RuntimeEvidenceBundle, type RuntimeReviewSummary } from "./evidence.js";
import {
  evaluateRuntimeActionPolicy,
  type RuntimeActionDecision,
  type RuntimeActionRequest,
  type RuntimeActionType,
} from "./policy.js";
import {
  selectProviderRoute,
  type RuntimeProviderRoute,
  type RuntimeProviderRouteDecision,
  type RuntimeProviderRouteRequest,
} from "./providerRouting.js";
import { redactJsonValue, redactRecord, redactText } from "./redaction.js";

// ── 1. Represent Operator work as a CHANTER runtime task ──

export type { RuntimeTask };

/** Input for mapping one piece of Operator work into a RuntimeTask. Product is always fixed to "operator". */
export interface CreateOperatorRuntimeTaskInput {
  id?: string;
  objective: string;
  riskLevel?: RuntimeRiskLevel;
  executionPolicy?: RuntimeExecutionPolicy;
  inputs?: Record<string, JsonValue>;
  validationCommands?: string[];
}

/**
 * Maps Operator work into a real RuntimeTask (product: "operator", status:
 * "draft"), driven through the same lifecycle constructor the shared
 * contract uses — not a hand-built object literal. Inputs are redacted at
 * this write boundary (see redaction.ts).
 */
export function createOperatorRuntimeTask(input: CreateOperatorRuntimeTaskInput): RuntimeTask {
  const taskInput: CreateTaskInput = {
    id: input.id,
    product: "operator",
    objective: input.objective,
    riskLevel: input.riskLevel,
    executionPolicy: input.executionPolicy,
    inputs: input.inputs,
    validationCommands: input.validationCommands,
  };
  return createTask(taskInput);
}

// ── 2. Evaluate Operator actions against runtime policy (decision only) ──

export type { RuntimeActionType, RuntimeActionRequest, RuntimeActionDecision };

/**
 * Decides whether `request` may be performed against `task` right now.
 * Never mutates `task` and never performs the action — enforcement (i.e.
 * actually refusing to run a blocked shell command) remains the caller's
 * responsibility. See policy.ts for the full read/write/shell/network/
 * commit/deploy/publish/delete rules.
 */
export function evaluateOperatorRuntimeAction(task: RuntimeTask, request: RuntimeActionRequest): RuntimeActionDecision {
  return evaluateRuntimeActionPolicy(task, request);
}

/**
 * Maps Operator's existing `ActionType` domain vocabulary (apps/backend/src/types.ts,
 * used by ExecutionStep.action_type) onto the shared `RuntimeActionType` policy
 * vocabulary, so callers already working with Operator's ExecutionStep model can
 * reach `evaluateOperatorRuntimeAction` without hand-rolling the mapping.
 * "unknown" maps conservatively to "read" (the only action allowed unconditionally).
 */
const OPERATOR_ACTION_TYPE_MAP: Record<ActionType, RuntimeActionType> = {
  analysis: "read",
  read_file: "read",
  file_write: "write",
  file_edit: "write",
  shell_command: "shell",
  unknown: "read",
};

export function mapOperatorActionTypeToRuntimeActionType(actionType: ActionType): RuntimeActionType {
  return OPERATOR_ACTION_TYPE_MAP[actionType];
}

// ── 3. Build redacted evidence / review bundles ──

export type { RuntimeEvidenceBundle, RuntimeReviewSummary };

/** Builds the compact, JSON-safe, redacted evidence bundle for an Operator runtime task. */
export function buildOperatorEvidenceBundle(task: RuntimeTask): RuntimeEvidenceBundle {
  return createEvidenceBundle(task);
}

/** Builds a human-readable, redacted review summary (text + structured fields) for an Operator runtime task. */
export function summarizeOperatorRuntimeTask(task: RuntimeTask): RuntimeReviewSummary {
  return summarizeTaskForReview(task);
}

// ── 4. Provider / tool route selection (no network) ──

export type { RuntimeProviderRoute, RuntimeProviderRouteRequest, RuntimeProviderRouteDecision };

/**
 * Default in-memory candidate list describing Operator's existing local
 * capabilities. Purely declarative — nothing here performs a call. The
 * disabled `network-call` entry demonstrates that unconfigured/not-yet-wired
 * capabilities resolve to a `blocked` routing decision rather than silently
 * succeeding.
 */
export const DEFAULT_OPERATOR_PROVIDER_ROUTES: RuntimeProviderRoute[] = [
  {
    provider: "operator-local",
    toolId: "readonly-git-runner",
    product: "operator",
    capability: "readonly-command",
    enabled: true,
  },
  {
    provider: "operator-local",
    toolId: "mock-agent-runtime",
    product: "operator",
    capability: "lifecycle-simulation",
    enabled: true,
  },
  {
    provider: "safecommit-contract",
    toolId: "safecommit-advisory-adapter",
    product: "safecommit",
    capability: "commit-review",
    enabled: true,
  },
  {
    provider: "operator-local",
    toolId: "unconfigured-network-provider",
    product: "operator",
    capability: "network-call",
    enabled: false,
  },
];

/** Selects a provider/tool route for `request`, defaulting to Operator's own declared candidate list. No network calls. */
export function selectOperatorProviderRoute(
  request: RuntimeProviderRouteRequest,
  candidates: RuntimeProviderRoute[] = DEFAULT_OPERATOR_PROVIDER_ROUTES,
): RuntimeProviderRouteDecision {
  return selectProviderRoute(request, candidates);
}

// ── 5. Operator adapter contract (compatible with the shared runtime adapter concept) ──

/** Structural mirror of chanter-agent-runtime's `RuntimeAdapterInputEnvelope<TInput>` (src/adapters/runtimeAdapter.ts). */
export interface RuntimeAdapterInputEnvelope<TInput> {
  input: TInput;
  correlationId?: string;
  receivedAt?: string;
}

/** Structural mirror of chanter-agent-runtime's `RuntimeAdapterResult`. */
export interface RuntimeAdapterResult {
  task: RuntimeTask;
  evidenceBundle: RuntimeEvidenceBundle;
}

/** Structural mirror of chanter-agent-runtime's `RuntimeProductAdapter<TInput>` contract. */
export interface RuntimeProductAdapter<TInput> {
  id: string;
  product: RuntimeProduct;
  version: string;
  mapToRuntimeTask(input: TInput): RuntimeTask;
  buildEvidenceBundle(input: TInput): RuntimeEvidenceBundle;
}

/**
 * Runs a product adapter against an input envelope, returning a task and an
 * evidence bundle guaranteed to describe the *same* mapped task (maps once,
 * then derives the bundle from that exact task) — mirrors
 * chanter-agent-runtime's `runProductAdapter`.
 */
export function runOperatorRuntimeAdapter<TInput>(
  adapter: RuntimeProductAdapter<TInput>,
  envelope: RuntimeAdapterInputEnvelope<TInput>,
): RuntimeAdapterResult {
  const task = adapter.mapToRuntimeTask(envelope.input);
  return { task, evidenceBundle: createEvidenceBundle(task) };
}

/**
 * Operator's own adapter, exposed as a `RuntimeProductAdapter` so generic
 * runtime tooling (this bridge's `runOperatorRuntimeAdapter`, or a future
 * real `runProductAdapter` from chanter-agent-runtime once package-linked)
 * can drive Operator's work the same way it drives SafeCommit's.
 */
export const operatorRuntimeAdapter: RuntimeProductAdapter<CreateOperatorRuntimeTaskInput> = {
  id: "operator-runtime-bridge-adapter",
  product: "operator",
  version: "1.0.0",
  mapToRuntimeTask: (input) => createOperatorRuntimeTask(input),
  buildEvidenceBundle: (input) => createEvidenceBundle(createOperatorRuntimeTask(input)),
};

// ── 6. Redaction re-exports (bridge-level convenience) ──

export { redactText, redactJsonValue, redactRecord };

// ── 7. Adapter/readiness integration ──
//
// Operator's P1.5/P1.6 adapter registry + readiness gate (../adapters/) is a
// closed catalog of three *external product* adapters (loop_governor,
// safecommit, autoposter) — its tests assert an exact 3-entry catalog. The
// runtime bridge is not an external product being consumed BY Operator; it
// is Operator's own capability to speak the shared runtime contract, so it
// is deliberately NOT registered as a fourth catalog entry (that would
// change catalog semantics and break ~15 existing P1.5/P1.6 tests for no
// safety benefit). Instead, this reuses the same `AdapterReadinessStatus`
// vocabulary so the language is consistent across the app, and reports the
// bridge's own primitive coverage — what's implemented vs. what remains
// out of scope for this loop.

/** The runtime-bridge primitives this module implements, one per §1–§5 above. */
export const OPERATOR_RUNTIME_BRIDGE_PRIMITIVES = [
  "task-mapping",
  "action-policy",
  "evidence-bundle",
  "provider-routing",
  "redaction",
  "adapter-contract",
] as const;

export type OperatorRuntimeBridgePrimitive = (typeof OPERATOR_RUNTIME_BRIDGE_PRIMITIVES)[number];

/** The real, currently-implemented primitive set — passed to createOperatorAdapterReadinessReport(). */
const IMPLEMENTED_PRIMITIVES: OperatorRuntimeBridgePrimitive[] = [
  "task-mapping",
  "action-policy",
  "evidence-bundle",
  "provider-routing",
  "redaction",
  "adapter-contract",
];

/** Explicitly out of scope for P1A — decision-only bridge, not an execution engine. */
const NOT_YET_IMPLEMENTED: string[] = [
  "Direct package dependency on chanter-agent-runtime — this module is a structural mirror; see contract.ts for the cross-repo-import rationale.",
  "'delete' action dry-run preview — blocked by default per the shared policy contract (policy.ts).",
  "Real provider/model invocation — selectOperatorProviderRoute is candidate selection only, never a network/model call.",
  "Wiring into Operator's live routes/API — this loop is a backend module addition, not a route or UI change.",
  "Execution of commit/deploy/publish guarded actions — evaluateOperatorRuntimeAction is decision-only; no git/deploy/publish side effect is ever performed here.",
];

/** Readiness verdict for the runtime bridge module itself (not a per-product-adapter report). */
export interface OperatorRuntimeBridgeReadinessReport {
  status: AdapterReadinessStatus;
  usable: boolean;
  reasons: string[];
  supportedPrimitives: OperatorRuntimeBridgePrimitive[];
  notImplemented: string[];
  evaluatedAt: string;
}

/**
 * Pure derivation: given the primitives actually implemented, decide
 * INCOMPLETE (something required is missing) or READY (full coverage).
 * Exposed separately from createOperatorAdapterReadinessReport() so tests
 * can exercise both branches without needing to uninstall real code.
 */
export function deriveOperatorRuntimeBridgeReadiness(
  implementedPrimitives: OperatorRuntimeBridgePrimitive[],
  notImplemented: string[] = NOT_YET_IMPLEMENTED,
): OperatorRuntimeBridgeReadinessReport {
  const evaluatedAt = new Date().toISOString();
  const missing = OPERATOR_RUNTIME_BRIDGE_PRIMITIVES.filter((p) => !implementedPrimitives.includes(p));

  if (missing.length > 0) {
    return {
      status: "INCOMPLETE",
      usable: false,
      reasons: [`Missing required runtime-bridge primitive(s): ${missing.join(", ")}.`],
      supportedPrimitives: implementedPrimitives,
      notImplemented,
      evaluatedAt,
    };
  }

  return {
    status: "READY",
    usable: true,
    reasons: [
      "All required runtime-bridge primitives are implemented (task mapping, action policy, evidence bundle, provider routing, redaction, adapter contract).",
      "Contract-only and decision-only: no execution, no network, no cross-repo imports.",
    ],
    supportedPrimitives: implementedPrimitives,
    notImplemented,
    evaluatedAt,
  };
}

/** Evaluates the real runtime bridge's readiness using its actual implemented primitive set. */
export function createOperatorAdapterReadinessReport(): OperatorRuntimeBridgeReadinessReport {
  return deriveOperatorRuntimeBridgeReadiness(IMPLEMENTED_PRIMITIVES);
}

// ── 8. Deterministic sample fixtures ──

/** Low-risk sample: no approval gate, moves straight toward execution once planned. */
export const SAMPLE_OPERATOR_RUNTIME_TASK_INPUT: CreateOperatorRuntimeTaskInput = {
  objective: "Run typecheck and test suite before marking the P1A runtime bridge complete.",
  riskLevel: "low",
  executionPolicy: "local_only",
  inputs: { workspace: "apps/backend", trigger: "manual-review" },
  validationCommands: ["npm run typecheck", "npm test"],
};

/** High-risk, commit-guarded sample: approvalRequired is forced true, demonstrating the approval gate. */
export const SAMPLE_OPERATOR_HIGH_RISK_TASK_INPUT: CreateOperatorRuntimeTaskInput = {
  objective: "Prepare a commit-guarded change for human review before any commit action is permitted.",
  riskLevel: "high",
  executionPolicy: "commit_guarded",
  inputs: { workspace: "apps/backend", changeSummary: "runtime bridge foundation" },
  validationCommands: ["npm run typecheck", "npm test", "npm run build"],
};
