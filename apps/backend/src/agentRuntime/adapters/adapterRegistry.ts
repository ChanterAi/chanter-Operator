// ── CHANTER Operator P1.5: Adapter Registry / Runtime Catalog ──
// Metadata-only catalog of registered CHANTER product adapters.
// No execution. No cross-repo imports. No UI. No DB. No network.

import type { AgentRunLifecycleState } from "../types.js";
import { AgentRunLifecycleStates } from "../types.js";

// ── Registry types ──

/** Known adapter identifiers. */
export const AdapterIds = [
  "loop_governor",
  "safecommit",
  "autoposter",
] as const;

export type AgentRuntimeAdapterId = (typeof AdapterIds)[number];

/** Maps a single product's domain state to an AgentRunLifecycleState. */
export interface AdapterLifecycleMapping {
  sourceState: string;
  lifecycleState: AgentRunLifecycleState;
}

/** Safety exclusion for a registered adapter. */
export interface AdapterSafetyExclusion {
  category: string;
  description: string;
}

// ── Governance (P1.6) ──

/** Declared risk level for a registered adapter. */
export const AdapterRiskLevels = ["low", "medium", "high"] as const;

export type AdapterRiskLevel = (typeof AdapterRiskLevels)[number];

/** Declared availability of a registered adapter. */
export const AdapterAvailabilities = ["available", "blocked", "deprecated"] as const;

export type AdapterAvailability = (typeof AdapterAvailabilities)[number];

/**
 * Governance declaration for a registered adapter (P1.6).
 * Purely declarative — consumed by the readiness gate for display.
 * Nothing here executes, schedules, or authorizes anything.
 */
export interface AdapterGovernance {
  /** Declared risk level of the product this adapter represents. */
  riskLevel: AdapterRiskLevel;
  /** Whether runs mapped through this adapter require human approval. */
  requiresApproval: boolean;
  /** Contract-level actions the adapter is allowed to perform (mapping only). */
  allowedActions: string[];
  /** Actions the adapter must never perform. */
  forbiddenActions: string[];
  /** Evidence kinds a run must supply before it can be considered complete. */
  evidenceRequirements: string[];
  /** Validation commands the contract expects (declarative — never run by Operator). */
  validationCommands: string[];
  /** Declared availability of the adapter. */
  availability: AdapterAvailability;
}

/** Metadata for a single registered adapter. */
export interface AgentRuntimeAdapterMetadata {
  /** Unique adapter identifier. */
  adapterId: AgentRuntimeAdapterId;
  /** CHANTER product this adapter represents. */
  productId: string;
  /** Human-readable display name. */
  displayName: string;
  /** Always true — all current adapters are contract-only. */
  contractOnly: true;
  /** Valid source states this adapter accepts. */
  supportedSourceStates: string[];
  /** All 6 lifecycle states — must always be the full AgentRunLifecycleStates. */
  lifecycleStates: readonly AgentRunLifecycleState[];
  /** Path to the adapter's contract documentation. */
  contractDocPath: string;
  /** Whether the adapter ships a sample fixture. */
  hasSampleFixture: boolean;
  /** Safety notes about this adapter. */
  safetyNotes: string[];
  /** What this adapter explicitly does NOT do. */
  exclusions: AdapterSafetyExclusion[];
  /** Governance declaration consumed by the P1.6 readiness gate. */
  governance: AdapterGovernance;
}

/** The full adapter catalog. */
export interface AgentRuntimeAdapterCatalog {
  /** All registered adapters, keyed by adapterId. */
  adapters: Record<AgentRuntimeAdapterId, AgentRuntimeAdapterMetadata>;
  /** ISO-8601 when the catalog was assembled. */
  assembledAt: string;
  /** Catalog version — increments when adapters are added/removed. */
  version: number;
}

/** Result of a registry lookup. */
export interface AdapterRegistryResult {
  /** Whether the operation succeeded. */
  ok: boolean;
  /** The adapter metadata if found. */
  adapter: AgentRuntimeAdapterMetadata | null;
  /** Error message if not found. */
  error: string | null;
}

// ── Metadata ──

const LOOP_GOVERNOR_META: AgentRuntimeAdapterMetadata = {
  adapterId: "loop_governor",
  productId: "Loop Governor",
  displayName: "Loop Governor Adapter",
  contractOnly: true,
  supportedSourceStates: [
    "planned", "created", "running", "iterating",
    "validating", "collecting_evidence", "awaiting_review",
    "completed", "closed", "failed", "cancelled",
  ],
  lifecycleStates: AgentRunLifecycleStates,
  contractDocPath: "docs/LOOP_GOVERNOR_ADAPTER_CONTRACT.md",
  hasSampleFixture: true,
  safetyNotes: [
    "Contract-only — no Loop Governor code imported.",
    "No real agent execution. No Codex/Ollama/OpenClaw.",
    "All mapping is synchronous and deterministic.",
  ],
  exclusions: [
    { category: "execution", description: "No Loop Governor execution" },
    { category: "agents", description: "No Codex / Ollama / OpenClaw" },
    { category: "shell", description: "No shell execution" },
    { category: "network", description: "No network access" },
    { category: "cross-repo", description: "No cross-repo imports" },
    { category: "deployment", description: "No deployment changes" },
  ],
  governance: {
    riskLevel: "low",
    requiresApproval: false,
    allowedActions: ["map_source_state", "build_manifest", "validate_input", "serialize_manifest"],
    forbiddenActions: ["execute_loop", "run_agents", "shell_execution", "network_access", "deployment"],
    evidenceRequirements: ["loop iteration log reference", "git snapshot hash"],
    validationCommands: ["npm test", "npm run typecheck"],
    availability: "available",
  },
};

const SAFECOMMIT_META: AgentRuntimeAdapterMetadata = {
  adapterId: "safecommit",
  productId: "SafeCommit",
  displayName: "SafeCommit Adapter",
  contractOnly: true,
  supportedSourceStates: [
    "review_created", "diff_received", "analyzing_diff",
    "classifying_risk", "validating", "checks_running",
    "evidence_collected", "report_ready", "awaiting_human_review",
    "recommendation_ready", "accepted", "rejected", "blocked", "completed",
  ],
  lifecycleStates: AgentRunLifecycleStates,
  contractDocPath: "docs/SAFE_COMMIT_ADAPTER_CONTRACT.md",
  hasSampleFixture: true,
  safetyNotes: [
    "Contract-only — no SafeCommit code imported.",
    "No git add/commit/push/merge/rebase.",
    "Path security: rejects absolute paths, .env, secrets, SSH, AWS paths.",
    "Git automation blocked at the input validation level.",
  ],
  exclusions: [
    { category: "execution", description: "No SafeCommit execution" },
    { category: "git", description: "No git add / commit / push / merge / rebase" },
    { category: "staging", description: "No file staging" },
    { category: "agents", description: "No Codex / Ollama / OpenClaw" },
    { category: "shell", description: "No shell execution" },
    { category: "network", description: "No network access" },
    { category: "cross-repo", description: "No cross-repo imports" },
    { category: "deployment", description: "No deployment changes" },
  ],
  governance: {
    riskLevel: "medium",
    requiresApproval: true,
    allowedActions: ["map_source_state", "build_manifest", "validate_input", "serialize_manifest"],
    forbiddenActions: ["git_add", "git_commit", "git_push", "git_merge", "git_rebase", "shell_execution", "network_access"],
    evidenceRequirements: ["diff summary reference", "risk classification record", "check run results"],
    validationCommands: ["npm test", "npm run typecheck"],
    availability: "available",
  },
};

const AUTOPOSTER_META: AgentRuntimeAdapterMetadata = {
  adapterId: "autoposter",
  productId: "AutoPoster",
  displayName: "AutoPoster Adapter",
  contractOnly: true,
  supportedSourceStates: [
    "campaign_created", "job_created", "draft_ready",
    "preparing_payload", "generating_variants", "queueing_job",
    "validating_content", "checking_schedule", "checking_account_scope",
    "preview_ready", "evidence_collected", "job_recorded",
    "awaiting_human_review", "approval_required",
    "queued", "scheduled", "published", "failed", "cancelled",
  ],
  lifecycleStates: AgentRunLifecycleStates,
  contractDocPath: "docs/AUTOPOSTER_ADAPTER_CONTRACT.md",
  hasSampleFixture: true,
  safetyNotes: [
    "Contract-only — no AutoPoster code imported.",
    "No TikTok / Instagram / YouTube API calls.",
    "No social posting. No scheduler/cron.",
    "Token/secret/credential detection at input validation level.",
    "Account scope enforced for queued/scheduled/published states.",
  ],
  exclusions: [
    { category: "execution", description: "No AutoPoster execution" },
    { category: "social-api", description: "No TikTok / Instagram / YouTube API" },
    { category: "posting", description: "No social posting" },
    { category: "scheduler", description: "No scheduler / cron" },
    { category: "tokens", description: "No token handling" },
    { category: "agents", description: "No Codex / Ollama / OpenClaw" },
    { category: "shell", description: "No shell execution" },
    { category: "network", description: "No network access" },
    { category: "cross-repo", description: "No cross-repo imports" },
    { category: "deployment", description: "No deployment changes" },
  ],
  governance: {
    riskLevel: "high",
    requiresApproval: true,
    allowedActions: ["map_source_state", "build_manifest", "validate_input", "serialize_manifest"],
    forbiddenActions: ["social_posting", "social_api_calls", "scheduler", "token_handling", "network_access"],
    evidenceRequirements: ["content preview reference", "account scope record", "job record"],
    validationCommands: ["npm test", "npm run typecheck"],
    availability: "available",
  },
};

// ── Catalog ──

/** The assembled adapter catalog. */
const CATALOG: AgentRuntimeAdapterCatalog = {
  adapters: {
    loop_governor: LOOP_GOVERNOR_META,
    safecommit: SAFECOMMIT_META,
    autoposter: AUTOPOSTER_META,
  },
  assembledAt: new Date().toISOString(),
  version: 1,
};

// ── Registry functions ──

/**
 * List all registered adapters in the catalog.
 * Returns metadata for each adapter, not the adapter itself.
 * No execution happens.
 */
export function listRegisteredAdapters(): AgentRuntimeAdapterMetadata[] {
  return Object.values(CATALOG.adapters);
}

/**
 * Get metadata for a specific registered adapter.
 * Returns an AdapterRegistryResult — never throws.
 */
export function getRegisteredAdapter(
  adapterId: string,
): AdapterRegistryResult {
  if (!isAdapterId(adapterId)) {
    return {
      ok: false,
      adapter: null,
      error: "Unknown adapter id: " + adapterId + ". Registered: " + AdapterIds.join(", "),
    };
  }

  return {
    ok: true,
    adapter: CATALOG.adapters[adapterId],
    error: null,
  };
}

/**
 * Assert that an adapter id is registered.
 * Throws if unknown — use when callers need a hard guarantee.
 */
export function assertAdapterRegistered(adapterId: string): AgentRuntimeAdapterMetadata {
  const result = getRegisteredAdapter(adapterId);
  if (!result.ok) {
    throw new Error(result.error!);
  }
  return result.adapter!;
}

/**
 * Get the lifecycle mapping for a registered adapter.
 * Returns the list of { sourceState, lifecycleState } pairs.
 */
export function getAdapterLifecycleMapping(
  adapterId: string,
): AdapterLifecycleMapping[] {
  const result = getRegisteredAdapter(adapterId);
  if (!result.ok) {
    return [];
  }

  // Each adapter maps states via its mapping function.
  // The registry returns metadata-level mappings as a lookup table.
  // Actual mapping logic lives in each adapter module; the registry
  // provides the metadata reference so Operator can display mappings
  // without importing adapter code.
  return result.adapter!.supportedSourceStates.map((sourceState) => ({
    sourceState,
    lifecycleState: mapSourceStateToLifecycle(adapterId as AgentRuntimeAdapterId, sourceState),
  }));
}

/**
 * Get the catalog itself for serialization/inspection.
 */
export function getCatalog(): AgentRuntimeAdapterCatalog {
  return structuredClone(CATALOG);
}

// ── Internal helpers ──

function isAdapterId(id: string): id is AgentRuntimeAdapterId {
  return AdapterIds.includes(id as AgentRuntimeAdapterId);
}

/**
 * Maps a source state to its lifecycle state based on the adapter.
 * This mirrors the STATE_MAP constants in each adapter module.
 */
function mapSourceStateToLifecycle(
  adapterId: AgentRuntimeAdapterId,
  sourceState: string,
): AgentRunLifecycleState {
  const mappings: Record<string, Record<string, AgentRunLifecycleState>> = {
    loop_governor: {
      planned: "PLAN", created: "PLAN",
      running: "EXECUTE", iterating: "EXECUTE",
      validating: "VALIDATE",
      collecting_evidence: "EVIDENCE",
      awaiting_review: "HUMAN_REVIEW",
      completed: "COMPLETE", closed: "COMPLETE",
      failed: "COMPLETE", cancelled: "COMPLETE",
    },
    safecommit: {
      review_created: "PLAN", diff_received: "PLAN",
      analyzing_diff: "EXECUTE", classifying_risk: "EXECUTE",
      validating: "VALIDATE", checks_running: "VALIDATE",
      evidence_collected: "EVIDENCE", report_ready: "EVIDENCE",
      awaiting_human_review: "HUMAN_REVIEW", recommendation_ready: "HUMAN_REVIEW",
      accepted: "COMPLETE", rejected: "COMPLETE",
      blocked: "COMPLETE", completed: "COMPLETE",
    },
    autoposter: {
      campaign_created: "PLAN", job_created: "PLAN", draft_ready: "PLAN",
      preparing_payload: "EXECUTE", generating_variants: "EXECUTE", queueing_job: "EXECUTE",
      validating_content: "VALIDATE", checking_schedule: "VALIDATE", checking_account_scope: "VALIDATE",
      preview_ready: "EVIDENCE", evidence_collected: "EVIDENCE", job_recorded: "EVIDENCE",
      awaiting_human_review: "HUMAN_REVIEW", approval_required: "HUMAN_REVIEW",
      queued: "COMPLETE", scheduled: "COMPLETE", published: "COMPLETE",
      failed: "COMPLETE", cancelled: "COMPLETE",
    },
  };

  const adapter = mappings[adapterId];
  if (!adapter || !adapter[sourceState]) {
    return "PLAN"; // fallback for unknown states
  }
  return adapter[sourceState];
}
