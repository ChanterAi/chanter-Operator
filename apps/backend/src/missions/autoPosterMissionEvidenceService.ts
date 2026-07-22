/**
 * Persistent AutoPoster product mission — retained evidence bundle.
 *
 * Generates one compact, durable, machine-readable JSON manifest per mission
 * graph, written atomically under a configured evidence root. This service
 * owns no new durable state of its own: every field is read from the
 * existing, unmodified MissionGraphService, AutoPosterMissionService,
 * AutoPosterResultProjectionService, and AutoPosterObservationService, plus
 * one fresh, live safety re-check through the existing
 * AutoPosterRuntimeMissionExecutor.getPostStatus port call. Regenerating the
 * bundle for the same graph ID overwrites the same file atomically — replay
 * of the same mission never creates a second bundle.
 */
import { createHash } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AutoPosterPostStatusView } from "chanter-agent-runtime";
import type { AutoPosterRuntimeMissionExecutor } from "../runtimeMissions/autoPosterRuntime.js";
import {
  hasProviderProofContradiction,
  isExactPrivateProviderProof,
  isStrictZeroProviderMutation,
} from "./autoPosterProviderPredicates.js";
import type { AutoPosterMissionService } from "../runtimeMissions/autoPosterMissionService.js";
import { OperatorError } from "../services/operatorService.js";
import {
  findForbiddenProviderMaterial,
  OPERATOR_PROVIDER_MATERIAL_MESSAGE,
} from "../security/providerSafety.js";
import { ensureWorkspace, resolveWorkspacePath } from "../workspace/pathGuard.js";
import type { AutoPosterObservationService } from "./autoPosterObservationService.js";
import type { AutoPosterResultProjectionService } from "./autoPosterResultProjectionService.js";
import type { MissionGraphService } from "./missionGraphService.js";

export const EVIDENCE_SCHEMA_VERSION = "chanter.autoposter.mission-evidence.v1";
const MAX_HEAD_LENGTH = 64;
const MAX_PROFILE_LENGTH = 120;

export interface EvidenceGenerationInput {
  repositoryHeads?: Record<string, string>;
  runtimeProfile?: string;
  media?: {
    fileName?: string;
    sha256?: string;
    byteSize?: number;
    mimeType?: string;
  };
  replay?: {
    outcome?: string;
    replayed?: boolean;
    sameGraphId?: boolean;
    sameResultIdentity?: boolean;
    providerUploadCountBefore?: number;
    providerUploadCountAfter?: number;
    additionalUploadCount?: number;
    existingResourceMutations?: number;
  };
  operationalCloseout?: {
    guardedSchedulerTickCount?: number;
    claimAttemptsAtDisconnect?: number;
    finalClaimAttempts?: number;
    providerUploadRecordCount?: number;
    externalMutationCount?: number;
    youtubeDuplicateCount?: number;
    failureBoundary?: string;
    terminalClassification?: string;
    exactTitle?: string;
    channelId?: string;
    providerReadBackCheckedAt?: string;
  };
}

export interface EvidenceBundleResult {
  path: string;
  manifest: Record<string, unknown>;
}

function redactProtectedValues(value: unknown, protectedValues: readonly string[]): unknown {
  if (typeof value === "string") {
    return protectedValues.reduce(
      (redacted, protectedValue) => (protectedValue ? redacted.split(protectedValue).join("[REDACTED]") : redacted),
      value,
    );
  }
  if (Array.isArray(value)) return value.map((item) => redactProtectedValues(item, protectedValues));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactProtectedValues(item, protectedValues)]),
    );
  }
  return value;
}

const FORBIDDEN_EVIDENCE_VALUE_PATTERN =
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b|https?:\/\/[^\s"']*(?:upload_id=|\/upload-session\/|resumable)/i;

function findForbiddenEvidenceMaterial(
  value: unknown,
  protectedValues: readonly string[],
): string | null {
  return findForbiddenProviderMaterial(value, protectedValues) ? "forbidden provider material" : null;
}

function projectionProviderOperation(value: unknown): AutoPosterPostStatusView["providerOperation"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = (value as Record<string, unknown>).snapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const operation = (snapshot as Record<string, unknown>).providerOperation;
  return operation && typeof operation === "object" && !Array.isArray(operation)
    ? operation as AutoPosterPostStatusView["providerOperation"]
    : null;
}

function sanitizeRepositoryHeads(input: Record<string, string> | undefined): Record<string, string> {
  if (!input || typeof input !== "object") return {};
  const sanitized: Record<string, string> = {};
  for (const [repo, head] of Object.entries(input)) {
    if (typeof repo !== "string" || !repo.trim() || repo.length > 80) continue;
    if (typeof head !== "string" || !/^[0-9a-f]{7,40}$/i.test(head)) continue;
    sanitized[repo.trim()] = head;
  }
  return sanitized;
}

function sanitizeMediaProof(input: EvidenceGenerationInput["media"]): Record<string, unknown> | null {
  if (input === undefined) return null;
  const fileName = String(input.fileName || "").trim();
  const sha256 = String(input.sha256 || "").trim().toLowerCase();
  const byteSize = Number(input.byteSize);
  const mimeType = String(input.mimeType || "").trim().toLowerCase();
  if (
    !fileName
    || fileName.length > 255
    || !/^[0-9a-f]{64}$/.test(sha256)
    || !Number.isSafeInteger(byteSize)
    || byteSize <= 0
    || mimeType !== "video/mp4"
  ) {
    throw new OperatorError(
      "Evidence media proof must contain a bounded filename, SHA-256, positive byte size, and video/mp4 MIME type.",
      400,
      "OPERATOR_EVIDENCE_MEDIA_INVALID",
    );
  }
  return { fileName, sha256, byteSize, mimeType };
}

function sanitizeReplayProof(input: EvidenceGenerationInput["replay"]): Record<string, unknown> | null {
  if (input === undefined) return null;
  const outcome = String(input.outcome || "").trim();
  const counts = [
    input.providerUploadCountBefore,
    input.providerUploadCountAfter,
    input.additionalUploadCount,
    input.existingResourceMutations,
  ];
  if (
    outcome !== "exact_replay_same_identity"
    || input.replayed !== true
    || input.sameGraphId !== true
    || input.sameResultIdentity !== true
    || counts.some((value) => !Number.isSafeInteger(value) || Number(value) < 0)
  ) {
    throw new OperatorError(
      "Evidence replay proof must confirm exact identity and non-negative provider mutation counts.",
      400,
      "OPERATOR_EVIDENCE_REPLAY_INVALID",
    );
  }
  return {
    outcome,
    replayed: true,
    sameGraphId: true,
    sameResultIdentity: true,
    providerUploadCountBefore: input.providerUploadCountBefore,
    providerUploadCountAfter: input.providerUploadCountAfter,
    additionalUploadCount: input.additionalUploadCount,
    existingResourceMutations: input.existingResourceMutations,
  };
}

interface OperationalCloseoutProof {
  guardedSchedulerTickCount: number;
  claimAttemptsAtDisconnect: number;
  finalClaimAttempts: number;
  providerUploadRecordCount: number;
  externalMutationCount: number;
  youtubeDuplicateCount: number;
  failureBoundary: "before_provider_upload_session";
  terminalClassification: "failed_pre_provider_attempt_budget_exhausted";
  exactTitle: string;
  channelId: string;
  providerReadBackCheckedAt: string;
}

function sanitizeOperationalCloseout(
  input: EvidenceGenerationInput["operationalCloseout"],
): OperationalCloseoutProof | null {
  if (input === undefined) return null;
  const counts = {
    guardedSchedulerTickCount: Number(input.guardedSchedulerTickCount),
    claimAttemptsAtDisconnect: Number(input.claimAttemptsAtDisconnect),
    finalClaimAttempts: Number(input.finalClaimAttempts),
    providerUploadRecordCount: Number(input.providerUploadRecordCount),
    externalMutationCount: Number(input.externalMutationCount),
    youtubeDuplicateCount: Number(input.youtubeDuplicateCount),
  };
  const exactTitle = String(input.exactTitle || "");
  const channelId = String(input.channelId || "").trim();
  const providerReadBackCheckedAt = String(input.providerReadBackCheckedAt || "").trim();
  if (
    Object.values(counts).some((value) => !Number.isSafeInteger(value) || value < 0)
    || counts.guardedSchedulerTickCount !== 1
    || counts.finalClaimAttempts < counts.claimAttemptsAtDisconnect
    || counts.providerUploadRecordCount !== 0
    || counts.externalMutationCount !== 0
    || counts.youtubeDuplicateCount !== 0
    || input.failureBoundary !== "before_provider_upload_session"
    || input.terminalClassification !== "failed_pre_provider_attempt_budget_exhausted"
    || !exactTitle
    || exactTitle.length > 100
    || !channelId
    || channelId.length > 256
    || !Number.isFinite(Date.parse(providerReadBackCheckedAt))
  ) {
    throw new OperatorError(
      "Operational closeout evidence must prove one guarded tick, a bounded pre-provider terminal failure, and zero provider mutations.",
      400,
      "OPERATOR_EVIDENCE_OPERATIONAL_CLOSEOUT_INVALID",
    );
  }
  return {
    ...counts,
    failureBoundary: "before_provider_upload_session",
    terminalClassification: "failed_pre_provider_attempt_budget_exhausted",
    exactTitle,
    channelId,
    providerReadBackCheckedAt,
  };
}

interface PublishingSafetyResult {
  safety: Record<string, unknown>;
  post: AutoPosterPostStatusView | null;
}

export class AutoPosterMissionEvidenceService {
  private readonly evidenceRoot: string;

  constructor(
    private readonly missionGraphService: MissionGraphService,
    private readonly runtimeMissionService: AutoPosterMissionService,
    private readonly autoPosterResultService: AutoPosterResultProjectionService,
    private readonly autoPosterObservationService: AutoPosterObservationService,
    private readonly executor: AutoPosterRuntimeMissionExecutor,
    evidenceDir: string,
    private readonly protectedValues: string[] = [],
    private readonly now: () => Date = () => new Date(),
  ) {
    // Fails closed (throws) if evidenceDir cannot be created/verified —
    // exactly the same guard already used for the runner workspace root.
    this.evidenceRoot = ensureWorkspace(evidenceDir);
  }

  async generateEvidenceBundle(graphId: string, input: EvidenceGenerationInput = {}): Promise<EvidenceBundleResult> {
    const normalizedGraphId = String(graphId || "").trim();
    if (!normalizedGraphId) {
      throw new OperatorError("graphId is required.", 400);
    }
    // Existing services already throw a typed 404 when the graph is unknown —
    // reused as-is, not re-implemented.
    const graph = this.missionGraphService.getGraph(normalizedGraphId);
    if (graph.nodes.length !== 1) {
      throw new OperatorError(
        "Evidence generation supports exactly the canonical one-node AutoPoster mission graph.",
        409,
        "OPERATOR_EVIDENCE_UNSUPPORTED_GRAPH_SHAPE",
      );
    }
    const node = graph.nodes[0]!;
    const childMission = this.runtimeMissionService.hasMission(node.childMissionId)
      ? this.runtimeMissionService.getMission(node.childMissionId)
      : null;

    const projections = this.autoPosterResultService.getProjections(normalizedGraphId);
    const nodeProjection = projections.nodes.find((entry) => entry.nodeId === node.nodeId) ?? null;

    const jobs = this.autoPosterObservationService.listJobs({ graphId: normalizedGraphId });
    const job = jobs.jobs.find((entry) => entry.nodeId === node.nodeId) ?? null;
    const jobDetail = job ? this.autoPosterObservationService.getJobDetail(job.observationJobId) : null;

    const escalations = this.autoPosterObservationService.listEscalations({ graphId: normalizedGraphId });
    const escalation = escalations.escalations.find((entry) => entry.nodeId === node.nodeId) ?? null;

    const normalizedNode = graph.normalizedGraph.nodes[0];
    const expectedTitle = typeof normalizedNode?.input.title === "string"
      ? normalizedNode.input.title
      : "";
    // Caller material is retained only as an attestation. It never supplies
    // positive provider/mutation assertions; those are derived below from
    // AutoPoster's strict provider operation plus Operator's durable graph
    // and result-projection evidence.
    const callerMedia = sanitizeMediaProof(input.media);
    const callerReplay = sanitizeReplayProof(input.replay);
    const callerOperationalCloseout = sanitizeOperationalCloseout(input.operationalCloseout);
    const publishingSafety = await this.assertPublishingSafety(childMission, expectedTitle);
    const statusPost = publishingSafety.post;
    const operation = statusPost?.providerOperation ?? null;
    const receipt = operation?.providerStatusReceipt ?? null;
    const persistedOperation = projectionProviderOperation(nodeProjection?.projection?.evidence ?? null);
    const replayEvent = graph.events.slice().reverse().find((event) => event.eventType === "graph_submission_replayed") ?? null;
    const operationPersisted = Boolean(
      operation
      && persistedOperation
      && persistedOperation.providerOperationId === operation.providerOperationId
      && persistedOperation.providerAttemptId === operation.providerAttemptId
      && persistedOperation.providerStatusReceiptSha256 === operation.providerStatusReceiptSha256
      && persistedOperation.eventDigestSha256 === operation.eventDigestSha256
    );

    const evidenceReferences = new Set<string>();
    evidenceReferences.add(`graph:${graph.graphId}`);
    evidenceReferences.add(`graph-sha256:${graph.graphHash}`);
    evidenceReferences.add(`child-mission:${node.childMissionId}`);
    if (childMission?.evidenceSummary.queueDraftId) {
      evidenceReferences.add(`autoposter-queue:${childMission.evidenceSummary.queueDraftId}`);
    }
    if (receipt?.externalVideoId) {
      evidenceReferences.add(`youtube-video:${receipt.externalVideoId}`);
    }
    if (operation) {
      evidenceReferences.add(`provider-operation:${operation.providerOperationId}`);
      evidenceReferences.add(`provider-attempt:${operation.providerAttemptId}`);
      if (operation.mediaSha256) evidenceReferences.add(`media-sha256:${operation.mediaSha256}`);
      if (operation.providerStatusReceiptSha256) {
        evidenceReferences.add(`provider-receipt-sha256:${operation.providerStatusReceiptSha256}`);
      }
    }
    if (nodeProjection?.projection?.snapshotHash) {
      evidenceReferences.add(`operator-projection-sha256:${nodeProjection.projection.snapshotHash}`);
    }
    if (replayEvent) evidenceReferences.add(`graph-event:${replayEvent.eventId}`);
    if (job) evidenceReferences.add(`observation-job:${job.observationJobId}`);
    if (escalation) evidenceReferences.add(`escalation:${escalation.escalationId}`);

    const runtimeProfile = String(input.runtimeProfile || "").trim().slice(0, MAX_PROFILE_LENGTH) || null;
    const mutationSummary = operation?.mutationSummary ?? null;
    const privateReceipt = Boolean(statusPost && isExactPrivateProviderProof(statusPost, {
      graphId: graph.graphId,
      childMissionId: node.childMissionId,
      workspaceId: graph.tenant.workspaceId ?? undefined,
      userId: graph.tenant.userId,
      expectedTitle,
    }));
    const exactlyOneUpload = Boolean(
      privateReceipt
      && operationPersisted
      && replayEvent
      && mutationSummary?.providerSessionInitiationCount === 1
      && mutationSummary.confirmedVideoArtifactCount === 1
    );
    const contradictionFree = Boolean(statusPost && !hasProviderProofContradiction(statusPost));
    const noExistingResourceModified = Boolean(
      contradictionFree
      &&
      operationPersisted
      && mutationSummary
      && mutationSummary.existingResourceUpdateCount === 0
      && mutationSummary.deleteCount === 0
    );
    const zeroProviderMutationProven = Boolean(
      operationPersisted
      && statusPost
      && isStrictZeroProviderMutation(statusPost)
    );
    const attemptBudgetExhausted = statusPost?.attemptBudgetExhausted === true;
    const noAutomaticRetryScheduled = Boolean(
      statusPost
      && statusPost.lastResult?.willRetry !== true
      && attemptBudgetExhausted
      && (
        statusPost.status === "posted"
        || statusPost.status === "failed"
        || statusPost.status === "outcome_unknown"
        || operation?.operationState === "terminal_failure"
      )
    );
    const operationRefs = operation
      ? [`provider-operation:${operation.providerOperationId}`, `provider-attempt:${operation.providerAttemptId}`]
      : [];
    const receiptRefs = operation?.providerStatusReceiptSha256
      ? [`provider-receipt-sha256:${operation.providerStatusReceiptSha256}`]
      : [];
    const projectionRefs = nodeProjection?.projection?.snapshotHash
      ? [`operator-projection-sha256:${nodeProjection.projection.snapshotHash}`]
      : [];
    const replayRefs = replayEvent ? [`graph-event:${replayEvent.eventId}`] : [];
    const safetyAssertionEvidence = {
      exactlyOneUpload: exactlyOneUpload ? [...operationRefs, ...receiptRefs, ...projectionRefs, ...replayRefs] : [],
      privateVisibilityVerified: privateReceipt ? [...receiptRefs, ...projectionRefs] : [],
      noPublicTransition: privateReceipt && noExistingResourceModified && statusPost && !hasProviderProofContradiction(statusPost)
        ? [...receiptRefs, ...operationRefs]
        : zeroProviderMutationProven ? [...operationRefs, ...projectionRefs] : [],
      noExistingResourceModified: noExistingResourceModified ? [...operationRefs, ...projectionRefs] : [],
      zeroProviderMutationProven: zeroProviderMutationProven ? [...operationRefs, ...projectionRefs] : [],
      attemptBudgetExhausted: attemptBudgetExhausted && statusPost ? [`autoposter-queue:${statusPost.id}`] : [],
      noAutomaticRetryScheduled: noAutomaticRetryScheduled && statusPost ? [`autoposter-queue:${statusPost.id}`] : [],
      secretsRedacted: [] as string[],
    };
    const manifest: Record<string, unknown> = {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      generatedAt: this.now().toISOString(),
      graphId: graph.graphId,
      graphHash: graph.graphHash,
      nodeId: node.nodeId,
      childMissionId: node.childMissionId,
      executionAttemptId: childMission?.execution?.executionAttemptId ?? null,
      approval: {
        actor: graph.approvedBy,
        approvedAt: graph.approvedAt,
        approvedGraphHash: graph.approvedGraphHash,
      },
      mcpSubmission: {
        idempotencyKey: graph.idempotencyKey,
        traceId: graph.traceId,
        requestedBy: graph.source.requestedBy,
        sourceSystem: graph.source.system,
      },
      result: childMission
        ? {
            status: childMission.runtimeResult?.status ?? null,
            queueDraftId: childMission.evidenceSummary.queueDraftId,
            output: childMission.runtimeResult?.output ?? null,
          }
        : null,
      resultProjection: nodeProjection?.projection ?? null,
      media: operation?.mediaSha256
        ? {
            fileName: operation.mediaFileName,
            sha256: operation.mediaSha256,
            byteSize: operation.mediaByteSize,
            mimeType: operation.mediaMimeType,
            sourceId: operation.mediaSourceId,
            bindingSha256: operation.bindingSha256,
          }
        : null,
      providerArtifact: receipt && statusPost && operation
        ? {
            provider: "youtube",
            providerOperationId: operation.providerOperationId,
            providerAttemptId: operation.providerAttemptId,
            configuredAccountId: statusPost.accountId,
            connectedAccountId: statusPost.connectedAccountId,
            verifiedChannelId: receipt.verifiedChannelId,
            verifiedChannelTitle: receipt.safeChannelTitle,
            verifiedChannelHandle: receipt.safeChannelHandle,
            externalYouTubeVideoId: receipt.externalVideoId,
            title: receipt.expectedTitle,
            verifiedPrivacyStatus: receipt.privacyStatus,
            providerUploadStatus: receipt.uploadStatus,
            providerProcessingStatus: receipt.processingStatus,
            providerVerificationTimestamp: receipt.verificationTimestamp,
            providerStatusReceiptSha256: operation.providerStatusReceiptSha256,
          }
        : null,
      mutationSummary,
      observation: job
        ? {
            observationJobId: job.observationJobId,
            status: job.status,
            attemptCount: job.attemptCount,
            attemptIds: jobDetail?.attempts.map((attempt) => attempt.attemptId) ?? [],
          }
        : null,
      escalation: escalation
        ? {
            escalationId: escalation.escalationId,
            reasonCode: escalation.reasonCode,
            severity: escalation.severity,
            status: escalation.status,
          }
        : null,
      evidenceReferences: [...evidenceReferences].sort(),
      finalLifecycleState: this.finalLifecycleState(graph.status, job?.status ?? null),
      callerAttestation: {
        media: callerMedia,
        replay: callerReplay,
        operationalCloseout: callerOperationalCloseout,
        authoritative: false,
      },
      validation: {
        providerOperationPresent: operation !== null,
        providerOperationPersistedInOperatorProjection: operationPersisted,
        exactGraphReplayEventPresent: replayEvent !== null,
        providerReceiptPresent: receipt !== null,
        identityBound: Boolean(operation && statusPost
          && operation.queueId === statusPost.id
          && operation.accountId === statusPost.accountId
          && operation.connectedAccountId === statusPost.connectedAccountId
          && operation.runtimeMissionId === node.childMissionId),
      },
      operationalCloseout: statusPost
        ? {
            graphId: graph.graphId,
            graphHash: graph.graphHash,
            nodeId: node.nodeId,
            childMissionId: node.childMissionId,
            queueDraftId: statusPost.id,
            connectedAccountId: statusPost.connectedAccountId,
            durableDraftStatus: statusPost.status,
            durableApprovalState: statusPost.approvalState,
            approvedAt: statusPost.approvedAt,
            approvedBy: statusPost.approvedBy,
            scheduledAt: statusPost.scheduledAt,
            sourceUpdatedAt: statusPost.updatedAt,
            failedAt: statusPost.history.slice().reverse().find((entry) => entry.event === "failed")?.at
              ?? statusPost.history.slice().reverse().find((entry) => entry.event === "attempt_budget_exhausted")?.at
              ?? statusPost.lastResult?.completedAt
              ?? null,
            claimAttempts: statusPost.claimAttempts,
            publishAttemptBudget: statusPost.publishAttemptBudget,
            attemptBudgetExhausted: statusPost.attemptBudgetExhausted,
            publishAttemptTimestamps: statusPost.history
              .filter((entry) => entry.event === "publish_attempt")
              .map((entry) => entry.at),
            providerStatus: statusPost.providerStatus,
            externalVideoId: statusPost.publishId || null,
            providerOperationId: operation?.providerOperationId ?? null,
            providerAttemptId: operation?.providerAttemptId ?? null,
            providerStatusReceiptSha256: operation?.providerStatusReceiptSha256 ?? null,
            postedAt: statusPost.postedAt,
            lastResult: statusPost.lastResult,
          }
        : null,
      repositoryHeads: sanitizeRepositoryHeads(input.repositoryHeads),
      runtimeProfile,
      safetyAssertions: {
        exactlyOneUpload,
        privateVisibilityVerified: privateReceipt,
        noPublicTransition: (privateReceipt && noExistingResourceModified) || zeroProviderMutationProven,
        noExistingResourceModified,
        zeroProviderMutationProven,
        attemptBudgetExhausted,
        noAutomaticRetryScheduled,
        secretsRedacted: false,
      },
      safetyAssertionEvidence,
      residualRisks: [
        ...(operation ? [] : ["provider_operation_absent"]),
        ...(operationPersisted ? [] : ["provider_operation_not_persisted_in_operator_projection"]),
        ...(replayEvent ? [] : ["exact_graph_replay_not_observed"]),
        ...(receipt ? [] : ["provider_receipt_absent"]),
      ],
      safety: publishingSafety.safety,
    };

    const redacted = redactProtectedValues(manifest, this.protectedValues) as Record<string, unknown>;
    const scanFailure = findForbiddenEvidenceMaterial(redacted, this.protectedValues);
    if (scanFailure) {
      throw new OperatorError(
        OPERATOR_PROVIDER_MATERIAL_MESSAGE,
        409,
        "OPERATOR_EVIDENCE_SECRET_SCAN_FAILED",
      );
    }
    (redacted.safetyAssertions as Record<string, unknown>).secretsRedacted = true;
    (redacted.safetyAssertionEvidence as Record<string, unknown>).secretsRedacted = [
      "final-artifact-secret-scan:passed",
    ];
    if (findForbiddenEvidenceMaterial(redacted, this.protectedValues)) {
      throw new OperatorError(
        OPERATOR_PROVIDER_MATERIAL_MESSAGE,
        409,
        "OPERATOR_EVIDENCE_SECRET_SCAN_FAILED",
      );
    }
    const serializedManifest = JSON.stringify(redacted, null, 2);
    if (
      FORBIDDEN_EVIDENCE_VALUE_PATTERN.test(serializedManifest)
      || this.protectedValues.some((protectedValue) => protectedValue && serializedManifest.includes(protectedValue))
    ) {
      throw new OperatorError(
        OPERATOR_PROVIDER_MATERIAL_MESSAGE,
        409,
        "OPERATOR_EVIDENCE_SECRET_SCAN_FAILED",
      );
    }
    const bundlePath = this.writeManifestAtomically(graph.graphId, redacted, serializedManifest);
    return { path: bundlePath, manifest: redacted };
  }

  /**
   * Structural assertion from already-persisted, already-verified mission
   * truth, plus one fresh live read of AutoPoster's own real status for the
   * exact queue draft (when one exists) — this never trusts the structural
   * assertion alone. A live read that actually finds the draft approved or
   * posted is a genuine safety violation and fails closed (throws) rather
   * than being silently recorded.
   */
  private async assertPublishingSafety(
    childMission: Awaited<ReturnType<AutoPosterMissionService["getMission"]>> | null,
    expectedTitle: string,
  ): Promise<PublishingSafetyResult> {
    const output = childMission?.runtimeResult?.output as { publishing?: unknown } | null | undefined;
    const structuralAssertion = {
      neverPublished: childMission === null || output?.publishing === "blocked_until_human_approval" || childMission.runtimeResult === null,
      basis: childMission?.runtimeResult
        ? String(output?.publishing ?? "unknown")
        : "no_runtime_result_yet",
    };

    const queueDraftId = childMission?.evidenceSummary.queueDraftId ?? null;
    if (!queueDraftId) {
      return {
        post: null,
        safety: {
          structuralAssertion,
          liveReCheck: { performed: false, reason: "no_queue_draft_yet" },
        },
      };
    }
    const statusResult = await this.executor.getPostStatus({
      postId: queueDraftId,
      workspaceId: childMission!.workspaceId,
      accountId: childMission!.accountId,
    });
    if (!statusResult.ok) {
      return {
        post: null,
        safety: {
          structuralAssertion,
          liveReCheck: { performed: false, reason: `status_read_failed:${statusResult.code}` },
        },
      };
    }
    const post = statusResult.post;
    if (post.status === "posted" || post.postedAt !== null) {
      const verification = post.providerVerification;
      if (
        !isExactPrivateProviderProof(post, {
          graphId: childMission?.graphId ?? undefined,
          childMissionId: childMission?.missionId,
          workspaceId: childMission?.workspaceId,
          expectedTitle,
        })
        || verification === null
      ) {
        throw new OperatorError(
          "Live AutoPoster status lacks exact private YouTube provider read-back evidence.",
          409,
          "OPERATOR_EVIDENCE_PROVIDER_VERIFICATION_INVALID",
        );
      }
      return {
        post,
        safety: {
          structuralAssertion: {
            verifiedPrivateUpload: true,
            basis: "youtube_provider_read_back",
          },
          liveReCheck: {
            performed: true,
            checkedAt: this.now().toISOString(),
            approved: post.approved,
            postedAt: post.postedAt,
            approvalState: post.approvalState,
            externalVideoId: verification.externalVideoId,
            channelId: verification.channelId,
            privacyStatus: verification.privacyStatus,
            uploadStatus: verification.uploadStatus,
            processingStatus: verification.processingStatus,
            verifiedAt: verification.verifiedAt,
          },
        },
      };
    }
    if (
      isStrictZeroProviderMutation(post)
      && post.attemptBudgetExhausted === true
      && post.lastResult?.willRetry !== true
      && post.publishId === ""
      && post.providerVerification === null
      && post.postedAt === null
    ) {
      return {
        post,
        safety: {
          structuralAssertion: {
            terminalPreProviderFailure: true,
            basis: "durable_provider_operation_zero_mutation",
          },
          liveReCheck: {
            performed: true,
            checkedAt: this.now().toISOString(),
            approved: post.approved,
            postedAt: post.postedAt,
            approvalState: post.approvalState,
            status: post.status,
            claimAttempts: post.claimAttempts,
            publishAttemptBudget: post.publishAttemptBudget,
            attemptBudgetExhausted: post.attemptBudgetExhausted,
            externalVideoId: null,
            providerVerification: null,
            automaticRetryScheduled: false,
          },
        },
      };
    }
    if (post.approved === true) {
      throw new OperatorError(
        "Live AutoPoster status shows the queue draft is approved-for-publish or already posted; refusing to record evidence of a safe unpublished mission.",
        409,
        "OPERATOR_EVIDENCE_PUBLISH_SAFETY_VIOLATION",
      );
    }
    return {
      post,
      safety: {
        structuralAssertion,
        liveReCheck: {
          performed: true,
          checkedAt: this.now().toISOString(),
          approved: post.approved,
          postedAt: post.postedAt,
          approvalState: post.approvalState,
        },
      },
    };
  }

  private finalLifecycleState(graphStatus: string, jobStatus: string | null): string {
    if (jobStatus) return `graph_${graphStatus}/observation_${jobStatus}`;
    return `graph_${graphStatus}`;
  }

  private writeManifestAtomically(
    graphId: string,
    manifest: Record<string, unknown>,
    serializedManifest = JSON.stringify(manifest, null, 2),
  ): string {
    const bundleDir = ensureWorkspace(resolveWorkspacePath(this.evidenceRoot, graphId));
    const finalPath = path.join(bundleDir, "manifest.json");
    const tempPath = path.join(bundleDir, `.manifest.${createHash("sha256").update(String(this.now().getTime())).digest("hex").slice(0, 12)}.tmp`);
    writeFileSync(tempPath, serializedManifest, "utf8");
    renameSync(tempPath, finalPath);
    return finalPath;
  }
}
