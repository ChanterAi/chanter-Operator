// ── CHANTER Operator P1.6: Adapter Registry Readiness Gate ──
// Pure, deterministic readiness derivation over registry metadata.
// Visibility only — no execution, no adapter invocation, no network, no UI.

import type {
  AgentRuntimeAdapterMetadata,
  AdapterGovernance,
} from "./adapterRegistry.js";
import {
  AdapterRiskLevels,
  AdapterAvailabilities,
  getRegisteredAdapter,
  listRegisteredAdapters,
} from "./adapterRegistry.js";
import { AgentRunLifecycleStates } from "../types.js";

// ── Readiness types ──

/**
 * Readiness statuses, from most to least restrictive.
 *
 * UNKNOWN          → adapter id is not registered / no metadata available.
 * INCOMPLETE       → required contract sections are missing or empty.
 * BLOCKED          → governance forbids use (availability blocked/deprecated,
 *                    or allowed/forbidden action conflict).
 * MISSING_EVIDENCE → contract declares no evidence requirements or no
 *                    validation commands, so runs cannot be evidenced.
 * NEEDS_APPROVAL   → usable, but human approval is required before any run.
 * READY            → contract is complete, unblocked, evidenced, and does
 *                    not require approval.
 */
export const AdapterReadinessStatuses = [
  "UNKNOWN",
  "INCOMPLETE",
  "BLOCKED",
  "MISSING_EVIDENCE",
  "NEEDS_APPROVAL",
  "READY",
] as const;

export type AdapterReadinessStatus = (typeof AdapterReadinessStatuses)[number];

/** Readiness verdict for a single adapter. */
export interface AdapterReadinessReport {
  /** The adapter id that was evaluated (echoed even when unregistered). */
  adapterId: string;
  /** Derived readiness status. */
  status: AdapterReadinessStatus;
  /** Human-readable reasons that produced the status (never empty). */
  reasons: string[];
  /** Whether the adapter may be surfaced as usable at all. */
  usable: boolean;
  /** ISO-8601 timestamp of evaluation. */
  evaluatedAt: string;
}

/** Readiness verdicts for the whole registry. */
export interface AdapterRegistryReadinessSummary {
  /** One report per registered adapter, in registry order. */
  reports: AdapterReadinessReport[];
  /** Count of reports per status (statuses with zero count included). */
  counts: Record<AdapterReadinessStatus, number>;
  /** ISO-8601 timestamp of evaluation. */
  evaluatedAt: string;
}

// ── Derivation (pure) ──

/**
 * Derive readiness for a single adapter's metadata.
 *
 * Pure and deterministic: the same metadata always yields the same status
 * and reasons. Accepts partial metadata so incomplete contracts can be
 * evaluated (and surfaced) rather than throwing.
 *
 * Precedence: UNKNOWN > INCOMPLETE > BLOCKED > MISSING_EVIDENCE
 * > NEEDS_APPROVAL > READY.
 */
export function deriveAdapterReadiness(
  metadata: Partial<AgentRuntimeAdapterMetadata> | null | undefined,
  adapterId?: string,
): AdapterReadinessReport {
  const id = metadata?.adapterId ?? adapterId ?? "(unknown)";
  const evaluatedAt = new Date().toISOString();

  if (!metadata) {
    return {
      adapterId: id,
      status: "UNKNOWN",
      reasons: ["Adapter is not registered in the catalog"],
      usable: false,
      evaluatedAt,
    };
  }

  const missing = findMissingSections(metadata);
  if (missing.length > 0) {
    return {
      adapterId: id,
      status: "INCOMPLETE",
      reasons: missing.map((section) => "Missing or empty contract section: " + section),
      usable: false,
      evaluatedAt,
    };
  }

  // All sections present past this point.
  const governance = metadata.governance as AdapterGovernance;

  const blockedReasons = findBlockedReasons(governance);
  if (blockedReasons.length > 0) {
    return {
      adapterId: id,
      status: "BLOCKED",
      reasons: blockedReasons,
      usable: false,
      evaluatedAt,
    };
  }

  const evidenceReasons = findEvidenceGaps(metadata, governance);
  if (evidenceReasons.length > 0) {
    return {
      adapterId: id,
      status: "MISSING_EVIDENCE",
      reasons: evidenceReasons,
      usable: false,
      evaluatedAt,
    };
  }

  if (governance.requiresApproval || governance.riskLevel === "high") {
    const reasons: string[] = [];
    if (governance.requiresApproval) {
      reasons.push("Contract requires human approval before any run");
    }
    if (governance.riskLevel === "high") {
      reasons.push("Declared risk level is high");
    }
    return {
      adapterId: id,
      status: "NEEDS_APPROVAL",
      reasons,
      usable: true,
      evaluatedAt,
    };
  }

  return {
    adapterId: id,
    status: "READY",
    reasons: ["Contract complete, unblocked, evidenced, and approval-free"],
    usable: true,
    evaluatedAt,
  };
}

/**
 * Evaluate readiness for a registered adapter by id.
 * Unregistered ids yield an UNKNOWN report — never throws.
 */
export function evaluateAdapterReadiness(adapterId: string): AdapterReadinessReport {
  const result = getRegisteredAdapter(adapterId);
  return deriveAdapterReadiness(result.adapter, adapterId);
}

/**
 * Evaluate readiness for every registered adapter.
 */
export function evaluateRegistryReadiness(): AdapterRegistryReadinessSummary {
  const reports = listRegisteredAdapters().map((meta) => deriveAdapterReadiness(meta));

  const counts = Object.fromEntries(
    AdapterReadinessStatuses.map((s) => [s, 0]),
  ) as Record<AdapterReadinessStatus, number>;
  for (const report of reports) {
    counts[report.status] += 1;
  }

  return {
    reports,
    counts,
    evaluatedAt: new Date().toISOString(),
  };
}

// ── Internal checks ──

function findMissingSections(metadata: Partial<AgentRuntimeAdapterMetadata>): string[] {
  const missing: string[] = [];

  if (!isNonEmptyString(metadata.adapterId)) missing.push("adapterId");
  if (!isNonEmptyString(metadata.productId)) missing.push("productId");
  if (!isNonEmptyString(metadata.displayName)) missing.push("displayName");
  if (metadata.contractOnly !== true) missing.push("contractOnly");
  if (!isNonEmptyStringArray(metadata.supportedSourceStates)) missing.push("supportedSourceStates");
  if (!hasAllLifecycleStates(metadata.lifecycleStates)) missing.push("lifecycleStates");
  if (!isNonEmptyString(metadata.contractDocPath)) missing.push("contractDocPath");
  if (!isNonEmptyStringArray(metadata.safetyNotes)) missing.push("safetyNotes");
  if (!Array.isArray(metadata.exclusions) || metadata.exclusions.length === 0) missing.push("exclusions");

  const g = metadata.governance;
  if (!g) {
    missing.push("governance");
    return missing;
  }
  if (!AdapterRiskLevels.includes(g.riskLevel)) missing.push("governance.riskLevel");
  if (typeof g.requiresApproval !== "boolean") missing.push("governance.requiresApproval");
  if (!isNonEmptyStringArray(g.allowedActions)) missing.push("governance.allowedActions");
  if (!isNonEmptyStringArray(g.forbiddenActions)) missing.push("governance.forbiddenActions");
  if (!Array.isArray(g.evidenceRequirements)) missing.push("governance.evidenceRequirements");
  if (!Array.isArray(g.validationCommands)) missing.push("governance.validationCommands");
  if (!AdapterAvailabilities.includes(g.availability)) missing.push("governance.availability");

  return missing;
}

function findBlockedReasons(governance: AdapterGovernance): string[] {
  const reasons: string[] = [];

  if (governance.availability === "blocked") {
    reasons.push("Adapter availability is declared blocked");
  }
  if (governance.availability === "deprecated") {
    reasons.push("Adapter is deprecated");
  }

  const conflicts = governance.allowedActions.filter((a) =>
    governance.forbiddenActions.includes(a),
  );
  if (conflicts.length > 0) {
    reasons.push(
      "Allowed/forbidden action conflict: " + conflicts.join(", "),
    );
  }

  return reasons;
}

function findEvidenceGaps(
  metadata: Partial<AgentRuntimeAdapterMetadata>,
  governance: AdapterGovernance,
): string[] {
  const reasons: string[] = [];

  if (governance.evidenceRequirements.length === 0) {
    reasons.push("Contract declares no evidence requirements");
  }
  if (governance.validationCommands.length === 0) {
    reasons.push("Contract declares no validation commands");
  }
  if (metadata.hasSampleFixture !== true) {
    reasons.push("Adapter ships no sample fixture");
  }

  return reasons;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function hasAllLifecycleStates(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    AgentRunLifecycleStates.every((s) => (value as string[]).includes(s))
  );
}
