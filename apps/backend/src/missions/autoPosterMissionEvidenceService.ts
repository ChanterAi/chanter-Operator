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
import type { AutoPosterMissionService } from "../runtimeMissions/autoPosterMissionService.js";
import { OperatorError } from "../services/operatorService.js";
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
    const media = sanitizeMediaProof(input.media);
    const replay = sanitizeReplayProof(input.replay);
    const operationalCloseout = sanitizeOperationalCloseout(input.operationalCloseout);
    const publishingSafety = await this.assertPublishingSafety(childMission, expectedTitle, operationalCloseout);
    const statusPost = publishingSafety.post;
    const verification = statusPost?.providerVerification ?? null;

    const evidenceReferences = new Set<string>();
    evidenceReferences.add(`graph:${graph.graphId}`);
    evidenceReferences.add(`graph-sha256:${graph.graphHash}`);
    evidenceReferences.add(`child-mission:${node.childMissionId}`);
    if (childMission?.evidenceSummary.queueDraftId) {
      evidenceReferences.add(`autoposter-queue:${childMission.evidenceSummary.queueDraftId}`);
    }
    if (verification?.externalVideoId) {
      evidenceReferences.add(`youtube-video:${verification.externalVideoId}`);
    }
    if (job) evidenceReferences.add(`observation-job:${job.observationJobId}`);
    if (escalation) evidenceReferences.add(`escalation:${escalation.escalationId}`);

    const runtimeProfile = String(input.runtimeProfile || "").trim().slice(0, MAX_PROFILE_LENGTH) || null;
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
      media,
      providerArtifact: verification && statusPost
        ? {
            provider: "youtube",
            configuredAccountId: statusPost.accountId,
            connectedAccountId: statusPost.connectedAccountId,
            verifiedChannelId: verification.channelId,
            verifiedChannelTitle: verification.channelTitle,
            verifiedChannelHandle: verification.channelHandle,
            externalYouTubeVideoId: verification.externalVideoId,
            title: verification.title,
            uploadMethod: verification.uploadMethod,
            verifiedPrivacyStatus: verification.privacyStatus,
            providerUploadStatus: verification.uploadStatus,
            providerProcessingStatus: verification.processingStatus,
            providerVerificationTimestamp: verification.verifiedAt,
            // Internal worker claims are not provider uploads. Only the
            // independently reconciled provider count may populate this
            // field; keep it null until replay/read-back proof supplies it.
            providerUploadCount: replay?.providerUploadCountAfter ?? null,
          }
        : null,
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
      replay,
      operationalCloseout: operationalCloseout && statusPost
        ? {
            ...operationalCloseout,
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
            providerVerification: statusPost.providerVerification,
            postedAt: statusPost.postedAt,
            lastResult: statusPost.lastResult,
          }
        : null,
      repositoryHeads: sanitizeRepositoryHeads(input.repositoryHeads),
      runtimeProfile,
      safetyAssertions: {
        exactlyOneUpload: Boolean(
          verification
          && statusPost?.claimAttempts === 1
          && replay?.providerUploadCountBefore === 1
          && replay?.providerUploadCountAfter === 1
          && replay?.additionalUploadCount === 0
        ),
        privateVisibilityVerified: verification?.privacyStatus === "private",
        noPublicTransition: verification?.privacyStatus === "private"
          || Boolean(
            operationalCloseout
            && operationalCloseout.externalMutationCount === 0
            && operationalCloseout.youtubeDuplicateCount === 0
          ),
        noExistingResourceModified: replay?.existingResourceMutations === 0,
        zeroProviderMutationProven: Boolean(
          operationalCloseout
          && operationalCloseout.externalMutationCount === 0
          && operationalCloseout.providerUploadRecordCount === 0
          && operationalCloseout.youtubeDuplicateCount === 0
          && statusPost?.publishId === ""
          && statusPost?.providerVerification === null
          && statusPost?.postedAt === null
        ),
        attemptBudgetExhausted: statusPost?.attemptBudgetExhausted === true,
        noAutomaticRetryScheduled: statusPost?.status === "failed"
          && statusPost.lastResult?.willRetry !== true,
        secretsRedacted: true,
      },
      safety: publishingSafety.safety,
    };

    const redacted = redactProtectedValues(manifest, this.protectedValues) as Record<string, unknown>;
    const bundlePath = this.writeManifestAtomically(graph.graphId, redacted);
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
    operationalCloseout: OperationalCloseoutProof | null,
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
    if (operationalCloseout) {
      const publishAttempts = post.history.filter((entry) => entry.event === "publish_attempt");
      const failureEvidence = `${post.lastResult?.code ?? ""} ${post.lastResult?.message ?? ""} ${post.lastErrorMessage}`;
      if (
        post.provider !== "youtube"
        || post.accountId !== operationalCloseout.channelId
        || expectedTitle !== operationalCloseout.exactTitle
        || post.status !== "failed"
        || post.approved !== true
        || post.claimAttempts !== operationalCloseout.finalClaimAttempts
        || publishAttempts.length !== operationalCloseout.finalClaimAttempts
        || post.attemptBudgetExhausted !== true
        || post.publishAttemptBudget > post.claimAttempts
        || post.lastResult?.willRetry === true
        || post.publishId !== ""
        || post.providerVerification !== null
        || post.postedAt !== null
        || !/media|download|video|fetch failed/i.test(failureEvidence)
      ) {
        throw new OperatorError(
          "Live AutoPoster state does not match the bounded zero-mutation operational closeout proof.",
          409,
          "OPERATOR_EVIDENCE_OPERATIONAL_CLOSEOUT_MISMATCH",
        );
      }
      return {
        post,
        safety: {
          structuralAssertion: {
            terminalPreProviderFailure: true,
            basis: "durable_attempt_budget_exhausted",
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
    if (post.status === "posted" || post.postedAt !== null) {
      const verification = post.providerVerification;
      if (
        post.provider !== "youtube"
        || post.providerStatus !== "uploaded_private"
        || !post.publishId
        || verification === null
        || verification.externalVideoId !== post.publishId
        || verification.channelId !== post.accountId
        || verification.privacyStatus !== "private"
        || verification.uploadMethod !== "resumable"
        || !expectedTitle
        || verification.title !== expectedTitle
        || ["rejected", "deleted", "failed"].includes(verification.uploadStatus.toLowerCase())
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

  private writeManifestAtomically(graphId: string, manifest: Record<string, unknown>): string {
    const bundleDir = ensureWorkspace(resolveWorkspacePath(this.evidenceRoot, graphId));
    const finalPath = path.join(bundleDir, "manifest.json");
    const tempPath = path.join(bundleDir, `.manifest.${createHash("sha256").update(String(this.now().getTime())).digest("hex").slice(0, 12)}.tmp`);
    writeFileSync(tempPath, JSON.stringify(manifest, null, 2), "utf8");
    renameSync(tempPath, finalPath);
    return finalPath;
  }
}
