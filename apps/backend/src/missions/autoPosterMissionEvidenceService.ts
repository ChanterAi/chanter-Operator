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

    const safety = await this.assertPublishingSafety(childMission);

    const evidenceReferences = new Set<string>();
    evidenceReferences.add(`graph:${graph.graphId}`);
    evidenceReferences.add(`graph-sha256:${graph.graphHash}`);
    evidenceReferences.add(`child-mission:${node.childMissionId}`);
    if (childMission?.evidenceSummary.queueDraftId) {
      evidenceReferences.add(`autoposter-queue:${childMission.evidenceSummary.queueDraftId}`);
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
      repositoryHeads: sanitizeRepositoryHeads(input.repositoryHeads),
      runtimeProfile,
      safety,
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
  ): Promise<Record<string, unknown>> {
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
        structuralAssertion,
        liveReCheck: { performed: false, reason: "no_queue_draft_yet" },
      };
    }
    const statusResult = await this.executor.getPostStatus({
      postId: queueDraftId,
      workspaceId: childMission!.workspaceId,
      accountId: childMission!.accountId,
    });
    if (!statusResult.ok) {
      return {
        structuralAssertion,
        liveReCheck: { performed: false, reason: `status_read_failed:${statusResult.code}` },
      };
    }
    if (statusResult.post.approved === true || statusResult.post.postedAt !== null) {
      throw new OperatorError(
        "Live AutoPoster status shows the queue draft is approved-for-publish or already posted; refusing to record evidence of a safe unpublished mission.",
        409,
        "OPERATOR_EVIDENCE_PUBLISH_SAFETY_VIOLATION",
      );
    }
    return {
      structuralAssertion,
      liveReCheck: {
        performed: true,
        checkedAt: this.now().toISOString(),
        approved: statusResult.post.approved,
        postedAt: statusResult.post.postedAt,
        approvalState: statusResult.post.approvalState,
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
