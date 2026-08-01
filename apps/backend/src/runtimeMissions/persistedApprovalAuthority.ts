/**
 * The single Operator-side owner of persisted Runtime approval authority.
 *
 * Operator records a human decision, publishes it as an immutable Runtime
 * approval observation, and hands the resulting authority tuple back to
 * `executeMission`. It never decides that an approval authorizes execution:
 * every acceptance, refusal, expiry, repository, HEAD, clean-state, and
 * binding decision stays inside the Agent Runtime's authoritative pre-adapter
 * guard. Nothing here re-implements a Runtime check.
 *
 * Both mission executors (AutoPoster and Loop Governor) share this module, so
 * there is exactly one place in Operator that constructs approval authority.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";

import {
  APPROVAL_CLEAN_STATE_POLICY,
  attachRuntimeApprovalAuthenticity,
  createDurableIdempotencyStore,
  createDurableMissionRunLedger,
  createRuntimeApprovalObservation,
  createRuntimeMissionPayloadHash,
  inspectRuntimeApprovalRepository,
  type RuntimeApprovalCheckpointStore,
  type RuntimeApprovalEvidenceReference,
  type RuntimeMissionAdapterRegistry,
  type RuntimeMissionApprovalAuthorityInput,
  type RuntimeMissionIdempotencyStore,
  type RuntimeMissionRequest,
  type RuntimeMissionResult,
  type RuntimeApprovalTrustStore,
  type RuntimeMissionRunLedger,
} from "chanter-agent-runtime";

import {
  resolveApprovalAuthorityCheckout,
  type ManagedApprovalCheckoutConfiguration,
} from "./approvalAuthorityCheckout.js";
import {
  createOperatorApprovalIssuer,
  loadOperatorApprovalTrustStore,
  type OperatorApprovalIssuerConfiguration,
} from "./approvalIssuer.js";
import { OperatorError } from "../services/operatorService.js";

/** Mirrors the Runtime's canonical opaque identifier rule for bound fields. */
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;
const MAX_IDENTIFIER_LENGTH = 256;

const APPROVAL_EVIDENCE_HASH_DOMAIN = "chanter-operator-approval-evidence-v1";

export const DEFAULT_OPERATOR_APPROVAL_POLICY_ID = "chanter.operator.human-approval.v1";

export interface OperatorApprovalAuthorityConfiguration {
  /**
   * Durable root for the Runtime idempotency store, run ledger, approval
   * checkpoints, observations, and authority evidence. It is deliberately
   * outside any target product repository.
   */
  stateDir: string;
  /**
   * Direct binding: an exact Git worktree root that is *already* clean under
   * the Runtime's canonical policy. Deployments must not use this against a
   * live product checkout — normal ignored and untracked operational files
   * keep it permanently fail-closed. See `managedCheckout`.
   */
  repositoryRoot?: string;
  /**
   * Managed binding: derive an isolated per-revision checkout from a live
   * product repository, so ordinary `node_modules/`, `dist/`, `.env`, and log
   * files never reach the authority decision. This is the deployable mode.
   */
  managedCheckout?: ManagedApprovalCheckoutConfiguration;
  /**
   * Operator's approval signing identity. Without it Operator cannot issue an
   * authentic approval, so approval-required execution stays fail-closed.
   */
  issuer?: OperatorApprovalIssuerConfiguration;
  /**
   * Absolute path to the Runtime's explicit trusted-issuer configuration.
   * Separate from the signing key on purpose: holding a key is not the same
   * statement as being trusted.
   */
  trustedIssuersFile?: string;
  /** Approval policy identity carried into the immutable checkpoint. */
  policyId?: string;
  /** Recorded on claims and run events to identify the writing process. */
  ownerId?: string;
}

/** One human decision, already durably recorded by the calling service. */
export interface OperatorApprovalDecision {
  /** Exact approver identity. Bound into the observation hash. */
  approverId: string;
  note?: string | null;
  /** Canonical UTC-millisecond instant the decision was durably recorded. */
  observedAt: string;
  /**
   * Optional temporal bound, passed through to the Runtime contract unchanged.
   * Absent means unbounded — Operator adds no expiry policy of its own.
   */
  approvalExpiresAt?: string;
  /** A rejection is published as durable authority too, so it fails closed. */
  status?: "approved" | "rejected";
}

export type OperatorApprovalAuthorityOutcome =
  | { ok: true; authority: RuntimeMissionApprovalAuthorityInput }
  | { ok: false; code: string; message: string };

export interface OperatorPersistedApprovalAuthority {
  /**
   * How this instance binds a repository. In managed mode the concrete
   * checkout is per-revision, so there is no single static root to expose.
   */
  readonly binding: "direct" | "managed" | "unconfigured";
  readonly stateDir: string;
  readonly idempotencyStore: RuntimeMissionIdempotencyStore & RuntimeApprovalCheckpointStore;
  readonly runLedger: RuntimeMissionRunLedger;
  /** Trusted issuers the Runtime verifies against; absent when unconfigured. */
  readonly trustStore: RuntimeApprovalTrustStore | undefined;
  /** True once the Runtime has published the immutable checkpoint manifest. */
  hasCheckpoint(missionId: string): boolean;
  /** Identity tuple with no persisted hashes — the checkpoint-creating call. */
  checkpointAuthorityFor(
    request: RuntimeMissionRequest,
    operationId: string,
  ): OperatorApprovalAuthorityOutcome;
  /** Publishes the human decision as an immutable observation, then resumes. */
  publishApproval(
    request: RuntimeMissionRequest,
    operationId: string,
    decision: OperatorApprovalDecision,
    /** Reuses an identity already inspected in this handoff; never a shortcut
     * around validation, since the Runtime re-derives everything at the guard. */
    knownIdentity?: RuntimeMissionApprovalAuthorityInput,
  ): OperatorApprovalAuthorityOutcome;
  /**
   * Rebuilds resume authority from durable state alone. A missing checkpoint or
   * observation is a refusal, never a synthesized approval — this is what makes
   * a restart between approval and execution safe.
   */
  resumeAuthorityFor(
    request: RuntimeMissionRequest,
    operationId: string,
  ): OperatorApprovalAuthorityOutcome;
}

function refusal(code: string, message: string): OperatorApprovalAuthorityOutcome {
  return { ok: false, code, message };
}

function isCanonicalIdentifier(value: string): boolean {
  return value.length > 0
    && value.length <= MAX_IDENTIFIER_LENGTH
    && IDENTIFIER_PATTERN.test(value);
}

function approvalEvidenceReference(
  decision: OperatorApprovalDecision,
  missionId: string,
  checkpointManifestHash: string,
  status: "approved" | "rejected",
): RuntimeApprovalEvidenceReference {
  // Content-addressed over the exact human decision *and* the checkpoint it
  // answers, so the evidence cannot be lifted onto another checkpoint.
  const material = JSON.stringify({
    domain: APPROVAL_EVIDENCE_HASH_DOMAIN,
    missionId,
    checkpointManifestHash,
    approverId: decision.approverId,
    note: decision.note ?? null,
    observedAt: decision.observedAt,
    approvalExpiresAt: decision.approvalExpiresAt ?? null,
    status,
  });
  return {
    evidenceId: `operator-approval:${missionId}`,
    kind: "operator-human-approval",
    sha256: createHash("sha256").update(material, "utf8").digest("hex"),
  };
}

/**
 * Checkpoint evidence must be derivable identically on every later resume, so
 * it binds durable mission truth (the exact payload hash) and never anything
 * that changes between calls.
 */
function checkpointEvidenceReferences(
  request: RuntimeMissionRequest,
): readonly RuntimeApprovalEvidenceReference[] {
  return [{
    evidenceId: `operator-mission-payload:${request.missionId}`,
    kind: "operator-mission-payload",
    sha256: createRuntimeMissionPayloadHash(request),
  }];
}

/**
 * Optional expiry carried by the approval decision, transported verbatim into
 * the Runtime contract. Operator applies no expiry policy of its own: an absent
 * value stays absent, which is exactly the Runtime's unbounded behavior.
 *
 * It is validated here — at the single point where an approval is published as
 * immutable authority — because that is the only place a bound is durable. A
 * value that never reached a published observation would silently vanish on the
 * next restart, so no other surface accepts one.
 */
export function canonicalApprovalExpiry(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const candidate = typeof value === "string" ? value.trim() : "";
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(candidate)
    || new Date(Date.parse(candidate)).toISOString() !== candidate
  ) {
    throw new OperatorError(
      "approvalExpiresAt must be a canonical UTC instant with millisecond precision.",
      400,
      "OPERATOR_APPROVAL_EXPIRY_NON_CANONICAL",
    );
  }
  return candidate;
}

/**
 * The Runtime requires `operationId` to equal the adapter's downstream
 * operation type exactly. Reading it back off the registered action spec keeps
 * Operator from hard-coding a second copy of that identity.
 */
export function downstreamOperationTypeFor(
  registry: RuntimeMissionAdapterRegistry,
  request: RuntimeMissionRequest,
): string {
  const adapter = registry.getAdapter(request.product);
  const spec = adapter?.actions.find((candidate) => candidate.action === request.action);
  return spec?.downstreamOperationType ?? `${request.product}:${request.action}`;
}

/** Durable sub-root for one mission, derived by digest so no caller byte reaches a path. */
export function missionScopedStateDir(stateDir: string, scope: string, missionId: string): string {
  const digest = createHash("sha256").update(missionId, "utf8").digest("hex");
  return join(stateDir, scope, digest);
}

export function createOperatorPersistedApprovalAuthority(
  configuration: OperatorApprovalAuthorityConfiguration,
): OperatorPersistedApprovalAuthority {
  const stateDir = configuration.stateDir.trim();
  const directRepositoryRoot = configuration.repositoryRoot?.trim() ?? "";
  const managedCheckout = configuration.managedCheckout ?? null;
  const policyId = (configuration.policyId ?? DEFAULT_OPERATOR_APPROVAL_POLICY_ID).trim();
  /**
   * Exactly one binding mode. Two configured sources would be two answers to
   * "which repository does this approval bind to", and the wrong one silently
   * winning is precisely the ambiguity this contract must not have.
   */
  const bindingConfigurationError = directRepositoryRoot && managedCheckout
    ? "Configure either a direct approval authority repository root or a managed checkout source, never both."
    : !directRepositoryRoot && !managedCheckout
      ? "No approval authority repository binding is configured."
      : null;
  const idempotencyStore = createDurableIdempotencyStore({
    stateDir,
    ...(configuration.ownerId ? { ownerId: configuration.ownerId } : {}),
  });
  const runLedger = createDurableMissionRunLedger({
    stateDir,
    ...(configuration.ownerId ? { ownerId: configuration.ownerId } : {}),
  });
  /**
   * Issuer and trust store are constructed eagerly so a malformed key or trust
   * file is a startup-visible configuration error rather than a surprise at the
   * moment a human approves something. A failure leaves both unset, and every
   * approval then fails closed with a typed reason.
   */
  let issuer: ReturnType<typeof createOperatorApprovalIssuer> | null = null;
  let issuerConfigurationError: { code: string; message: string } | null = null;
  if (configuration.issuer) {
    try {
      issuer = createOperatorApprovalIssuer(configuration.issuer);
    } catch (error) {
      issuerConfigurationError = {
        code: (error as { code?: string }).code ?? "OPERATOR_APPROVAL_ISSUER_CONFIGURATION_INVALID",
        message: error instanceof Error ? error.message : "The approval issuer could not be configured.",
      };
    }
  }
  let trustStore: RuntimeApprovalTrustStore | undefined;
  let trustStoreConfigurationError: { code: string; message: string } | null = null;
  if (configuration.trustedIssuersFile) {
    try {
      trustStore = loadOperatorApprovalTrustStore(configuration.trustedIssuersFile);
    } catch (error) {
      trustStoreConfigurationError = {
        code: (error as { code?: string }).code ?? "OPERATOR_APPROVAL_TRUST_STORE_CONFIGURATION_INVALID",
        message: error instanceof Error ? error.message : "The trusted approval issuers could not be loaded.",
      };
    }
  }

  const identityFor = (
    request: RuntimeMissionRequest,
    operationId: string,
  ): OperatorApprovalAuthorityOutcome => {
    const missionId = request.missionId;
    const stepId = `step:${request.action}`;
    const checkpointId = `checkpoint:${missionId}`;
    const approvalRequestId = `approval:${missionId}`;
    for (const [field, value] of [
      ["operationId", operationId],
      ["stepId", stepId],
      ["checkpointId", checkpointId],
      ["approvalRequestId", approvalRequestId],
      ["approvalPolicyId", policyId],
    ] as const) {
      if (!isCanonicalIdentifier(value)) {
        return refusal(
          "OPERATOR_APPROVAL_IDENTITY_NON_CANONICAL",
          `The persisted approval ${field} is not a canonical opaque identifier.`,
        );
      }
    }
    /**
     * Once the immutable checkpoint exists it *is* the bound repository
     * identity, so the tuple is read back from it rather than re-scanned. Only
     * the Runtime inspects the live checkout — at checkpoint publication and
     * again at the authoritative pre-adapter guard — so re-inspecting here
     * would duplicate a Runtime decision and could only ever disagree with the
     * manifest the Runtime is about to compare against.
     */
    let persisted;
    try {
      persisted = idempotencyStore.getApprovalCheckpointManifest(missionId);
    } catch (error) {
      return refusal(
        "OPERATOR_APPROVAL_AUTHORITY_UNREADABLE",
        `Durable approval authority exists but could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    let repositoryId: string;
    let boundRepositoryRoot: string;
    let expectedHead: string;
    if (persisted) {
      repositoryId = persisted.repositoryId;
      boundRepositoryRoot = persisted.repositoryRoot;
      expectedHead = persisted.expectedHead;
    } else {
      // No checkpoint yet, so a repository must be bound now. In managed mode
      // the isolated per-revision checkout is resolved (and published if this
      // is its first use) here and nowhere else: a resume never needs it,
      // because the manifest above already carries the bound identity.
      if (bindingConfigurationError) {
        return refusal("OPERATOR_APPROVAL_BINDING_NOT_CONFIGURED", bindingConfigurationError);
      }
      let candidateRoot = directRepositoryRoot;
      if (managedCheckout) {
        const resolved = resolveApprovalAuthorityCheckout(managedCheckout);
        if (!resolved.ok) return refusal(resolved.code, resolved.message);
        candidateRoot = resolved.checkout.repositoryRoot;
      }
      // The Runtime needs a candidate identity to publish, and it re-validates
      // this exact tuple against its own inspection before anything becomes
      // immutable.
      try {
        const inspection = inspectRuntimeApprovalRepository(candidateRoot);
        repositoryId = inspection.repositoryId;
        boundRepositoryRoot = inspection.repositoryRoot;
        expectedHead = inspection.head;
      } catch (error) {
        // The Runtime owns this decision; Operator only reports it truthfully.
        return refusal(
          "OPERATOR_APPROVAL_REPOSITORY_UNAVAILABLE",
          `The approval-bound repository could not be inspected: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return {
      ok: true,
      authority: {
        operationId,
        stepId,
        checkpointId,
        approvalRequestId,
        approvalPolicyId: policyId,
        repositoryId,
        repositoryRoot: boundRepositoryRoot,
        expectedHead,
        cleanStatePolicy: APPROVAL_CLEAN_STATE_POLICY,
        evidenceReferences: checkpointEvidenceReferences(request),
      },
    };
  };

  const withPersistedHashes = (
    authority: RuntimeMissionApprovalAuthorityInput,
    missionId: string,
  ): OperatorApprovalAuthorityOutcome => {
    let manifestHash: string;
    let observationHash: string;
    try {
      const manifest = idempotencyStore.getApprovalCheckpointManifest(missionId);
      if (!manifest) {
        return refusal(
          "OPERATOR_APPROVAL_CHECKPOINT_MISSING",
          "No immutable approval checkpoint is persisted for this mission.",
        );
      }
      const observation = idempotencyStore.getApprovalObservation(missionId);
      if (!observation) {
        return refusal(
          "OPERATOR_APPROVAL_OBSERVATION_MISSING",
          "No persisted approval observation is bound to this mission checkpoint.",
        );
      }
      manifestHash = manifest.manifestHash;
      observationHash = observation.observationHash;
    } catch (error) {
      return refusal(
        "OPERATOR_APPROVAL_AUTHORITY_UNREADABLE",
        `Durable approval authority exists but could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return { ok: true, authority: { ...authority, manifestHash, observationHash } };
  };

  return {
    binding: bindingConfigurationError ? "unconfigured" : managedCheckout ? "managed" : "direct",
    stateDir,
    idempotencyStore,
    runLedger,
    trustStore,
    hasCheckpoint: (missionId) => {
      try {
        return idempotencyStore.getApprovalCheckpointManifest(missionId) !== undefined;
      } catch {
        // Unreadable durable state must never read as "already checkpointed".
        return false;
      }
    },
    checkpointAuthorityFor: identityFor,
    resumeAuthorityFor: (request, operationId) => {
      const identity = identityFor(request, operationId);
      if (!identity.ok) return identity;
      return withPersistedHashes(identity.authority, request.missionId);
    },
    publishApproval: (request, operationId, decision, knownIdentity) => {
      const identity: OperatorApprovalAuthorityOutcome = knownIdentity
        ? { ok: true, authority: knownIdentity }
        : identityFor(request, operationId);
      if (!identity.ok) return identity;
      if (issuerConfigurationError) {
        return refusal(issuerConfigurationError.code, issuerConfigurationError.message);
      }
      if (trustStoreConfigurationError) {
        return refusal(trustStoreConfigurationError.code, trustStoreConfigurationError.message);
      }
      if (!issuer) {
        return refusal(
          "OPERATOR_APPROVAL_ISSUER_NOT_CONFIGURED",
          "No approval signing identity is configured, so Operator cannot issue an authentic approval.",
        );
      }
      if (!trustStore) {
        return refusal(
          "OPERATOR_APPROVAL_TRUST_STORE_NOT_CONFIGURED",
          "No trusted approval issuers are configured, so the Runtime could not verify an approval.",
        );
      }
      const approverId = decision.approverId.trim();
      const status = decision.status ?? "approved";
      const approvalExpiresAt = canonicalApprovalExpiry(decision.approvalExpiresAt);
      if (status === "approved" && !isCanonicalIdentifier(approverId)) {
        return refusal(
          "OPERATOR_APPROVAL_APPROVER_ID_NON_CANONICAL",
          "approvedBy must be a canonical opaque identifier to bind persisted approval authority.",
        );
      }
      try {
        const manifest = idempotencyStore.getApprovalCheckpointManifest(request.missionId);
        if (!manifest) {
          return refusal(
            "OPERATOR_APPROVAL_CHECKPOINT_MISSING",
            "The immutable approval checkpoint must exist before an approval can be published.",
          );
        }
        if (!idempotencyStore.getApprovalObservation(request.missionId)) {
          const observation = createRuntimeApprovalObservation({
            approvalRequestId: manifest.approvalRequestId,
            checkpointId: manifest.checkpointId,
            missionId: manifest.missionId,
            operationId: manifest.operationId,
            action: manifest.action,
            stepId: manifest.stepId,
            repositoryId: manifest.repositoryId,
            expectedHead: manifest.expectedHead,
            approvalPolicyId: manifest.approvalPolicyId,
            status,
            approverId: status === "approved" ? approverId : (approverId || null),
            note: decision.note ?? null,
            evidenceReferences: [
                  approvalEvidenceReference(
                { ...decision, approvalExpiresAt },
                manifest.missionId,
                manifest.manifestHash,
                status,
              ),
            ],
            checkpointManifestHash: manifest.manifestHash,
            observedAt: decision.observedAt,
            ...(approvalExpiresAt === undefined ? {} : { approvalExpiresAt }),
          });
          // Signed here and only here: the human decision becomes authority at
          // the exact moment it becomes immutable. The signature covers the
          // finished `observationHash`, which transitively binds every field
          // above, so no field list has to be maintained in parallel.
          const published = idempotencyStore.persistApprovalObservation(
            attachRuntimeApprovalAuthenticity(
              observation,
              issuer!.authenticityFor(observation.observationHash),
            ),
          );
          if (published.status === "conflict") {
            return refusal(
              "OPERATOR_APPROVAL_OBSERVATION_CONFLICT",
              "A different immutable approval observation is already bound to this checkpoint.",
            );
          }
        }
      } catch (error) {
        return refusal(
          "OPERATOR_APPROVAL_OBSERVATION_UNPUBLISHABLE",
          `The human approval could not be published as persisted authority: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return withPersistedHashes(identity.authority, request.missionId);
    },
  };
}

export type OperatorClaimRetirementOutcome = "retired" | "absent" | "conflict" | "unsupported";

/**
 * Retires an unresolved durable claim using the Runtime's own compare-and-set
 * reconciliation seam.
 *
 * Only the caller's *durable downstream evidence* justifies this — Operator
 * calls it exclusively after its own reconciliation proved the downstream
 * produced nothing for this exact scope. It retires the exact claim it
 * observed, so a newer claim is never touched, and it can never make anything
 * execute on its own: the approval authority guard still runs afterwards.
 */
export function retireUnresolvedRuntimeClaim(
  authority: OperatorPersistedApprovalAuthority,
  missionId: string,
): OperatorClaimRetirementOutcome {
  const store = authority.idempotencyStore;
  if (!store.inspectDurableState || !store.retireClaim) return "unsupported";
  try {
    const claim = store.inspectDurableState(missionId).claim;
    if (!claim || claim.state !== "unresolved") return "absent";
    return store.retireClaim({
      missionId,
      claimId: claim.claimId,
      state: "unresolved",
    }).kind === "conflict"
      ? "conflict"
      : "retired";
  } catch {
    return "conflict";
  }
}

/**
 * Copies the exact immutable checkpoint manifest and approval observation into
 * a second durable scope and returns resume authority against it.
 *
 * Both records are republished byte-identically, so every hash — manifest,
 * observation, authority binding, and any `approvalExpiresAt` bound into the
 * observation — is preserved. No approval decision is re-made here, and the
 * Runtime's authoritative pre-adapter guard still re-validates the whole tuple
 * against the live repository before any adapter can start.
 */
export function mirrorPersistedApprovalAuthority(
  source: OperatorPersistedApprovalAuthority,
  target: OperatorPersistedApprovalAuthority,
  request: RuntimeMissionRequest,
  operationId: string,
): OperatorApprovalAuthorityOutcome {
  try {
    const manifest = source.idempotencyStore.getApprovalCheckpointManifest(request.missionId);
    if (!manifest) {
      return refusal(
        "OPERATOR_APPROVAL_CHECKPOINT_MISSING",
        "No immutable approval checkpoint is persisted for this mission.",
      );
    }
    const observation = source.idempotencyStore.getApprovalObservation(request.missionId);
    if (!observation) {
      return refusal(
        "OPERATOR_APPROVAL_OBSERVATION_MISSING",
        "No persisted approval observation is bound to this mission checkpoint.",
      );
    }
    if (target.idempotencyStore.persistApprovalCheckpointManifest(manifest).status === "conflict") {
      return refusal(
        "OPERATOR_APPROVAL_CHECKPOINT_CONFLICT",
        "A different immutable approval checkpoint already exists in the recovered execution scope.",
      );
    }
    if (target.idempotencyStore.persistApprovalObservation(observation).status === "conflict") {
      return refusal(
        "OPERATOR_APPROVAL_OBSERVATION_CONFLICT",
        "A different immutable approval observation already exists in the recovered execution scope.",
      );
    }
  } catch (error) {
    return refusal(
      "OPERATOR_APPROVAL_AUTHORITY_UNREADABLE",
      `Persisted approval authority could not be carried into the recovered execution scope: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return target.resumeAuthorityFor(request, operationId);
}

/**
 * The canonical two-step handoff, shared by both executors: let the Runtime
 * publish the immutable checkpoint through its own `executeMission` path, then
 * publish the human decision against that exact checkpoint and return resume
 * authority. Operator never authors the checkpoint itself, so the Runtime's own
 * pre-checkpoint repository validation is never bypassed.
 */
export async function prepareApprovedRuntimeAuthority(
  authority: OperatorPersistedApprovalAuthority,
  request: RuntimeMissionRequest,
  operationId: string,
  decision: OperatorApprovalDecision,
  createCheckpoint: (
    checkpointAuthority: RuntimeMissionApprovalAuthorityInput,
  ) => Promise<RuntimeMissionResult>,
): Promise<OperatorApprovalAuthorityOutcome> {
  const checkpointAuthority = authority.checkpointAuthorityFor(request, operationId);
  if (!checkpointAuthority.ok) return checkpointAuthority;
  if (!authority.hasCheckpoint(request.missionId)) {
    let checkpointResult: RuntimeMissionResult;
    try {
      checkpointResult = await createCheckpoint(checkpointAuthority.authority);
    } catch (error) {
      return refusal(
        "OPERATOR_APPROVAL_CHECKPOINT_UNAVAILABLE",
        `The Runtime approval checkpoint could not be created: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (checkpointResult.status !== "approval_required") {
      const first = checkpointResult.errors[0];
      return refusal(
        first?.code ?? "OPERATOR_APPROVAL_CHECKPOINT_REFUSED",
        first?.message
          ?? `The Runtime refused to publish an approval checkpoint (${checkpointResult.status}).`,
      );
    }
  }
  return authority.publishApproval(request, operationId, decision, checkpointAuthority.authority);
}
