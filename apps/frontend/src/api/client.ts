import type {
  AddCommitReviewInput,
  AddValidationInput,
  AgentRunLedgerFilters,
  AgentRunLedgerListResponse,
  AgentRunLedgerRunDetail,
  AutoPosterConnectedAccountsResponse,
  AutoPosterObservationBatchResult,
  AutoPosterObservationEscalationsResponse,
  AutoPosterObservationEscalationView,
  AutoPosterObservationJobDetail,
  AutoPosterObservationJobsResponse,
  AutoPosterResultProjectionsResponse,
  AutoPosterResultRefreshResponse,
  CapabilityWorkspaceProjection,
  ConnectedHealthProjection,
  DemoReadinessResponse,
  CreateAutoPosterScheduleMissionInput,
  CreateTaskInput,
  EvidenceBundleResponse,
  HealthResponse,
  MissionGraphEvidenceResult,
  MissionGraphListResponse,
  MissionGraphView,
  RuntimeMission,
  TaskDetail,
  TaskIntent,
} from "./types";

export class OperatorApiError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(code ? `${code}: ${message}` : message);
  }
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers: { "Content-Type": "application/json", ...options?.headers },
    });
  } catch {
    throw new Error("Could not reach the local Operator API.");
  }

  let payload: T & { error?: string; code?: string };
  try {
    payload = (await response.json()) as T & { error?: string; code?: string };
  } catch {
    throw new Error("The local Operator API returned an unreadable response.");
  }
  if (!response.ok) {
    throw new OperatorApiError(
      payload.error || "The local operator request failed.",
      payload.code,
    );
  }
  return payload;
}

export async function fetchHealth(): Promise<HealthResponse> {
  return request<HealthResponse>("/api/health");
}

export async function fetchAutoPosterConnectedHealth(): Promise<ConnectedHealthProjection> {
  return request<ConnectedHealthProjection>("/api/runtime-missions/autoposter/connected-health");
}

export async function fetchForgeCapabilities(): Promise<CapabilityWorkspaceProjection> {
  return request<CapabilityWorkspaceProjection>("/api/capabilities");
}

// CHANTER LIVE MISSION SHOWCASE I (§8) — Platform Readiness demo presentation.
export function fetchDemoReadinessState(missionId?: string): Promise<DemoReadinessResponse> {
  const suffix = missionId ? `?missionId=${encodeURIComponent(missionId)}` : "";
  return request<DemoReadinessResponse>(`/api/demo/platform-readiness/state${suffix}`);
}

export function startDemoReadiness(idempotencyKey?: string): Promise<DemoReadinessResponse> {
  return request<DemoReadinessResponse>("/api/demo/platform-readiness/start", {
    method: "POST",
    body: JSON.stringify(idempotencyKey ? { idempotencyKey } : {}),
  });
}

export function approveDemoReadiness(missionId: string, actor = "founder"): Promise<DemoReadinessResponse> {
  return request<DemoReadinessResponse>("/api/demo/platform-readiness/approve", {
    method: "POST",
    body: JSON.stringify({ missionId, actor }),
  });
}

export function rejectDemoReadiness(missionId: string, actor = "founder"): Promise<DemoReadinessResponse> {
  return request<DemoReadinessResponse>("/api/demo/platform-readiness/reject", {
    method: "POST",
    body: JSON.stringify({ missionId, actor }),
  });
}

export function resetDemoReadiness(): Promise<DemoReadinessResponse> {
  return request<DemoReadinessResponse>("/api/demo/platform-readiness/reset", { method: "POST", body: "{}" });
}

export async function listTasks(): Promise<TaskIntent[]> {
  const result = await request<{ tasks: TaskIntent[] }>("/api/tasks");
  return result.tasks;
}

export function getTask(taskId: string): Promise<TaskDetail> {
  return request<TaskDetail>(`/api/tasks/${taskId}`);
}

export function createTask(input: CreateTaskInput): Promise<TaskDetail> {
  return request<TaskDetail>("/api/tasks", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function cancelTask(taskId: string): Promise<TaskDetail> {
  return request<TaskDetail>(`/api/tasks/${taskId}/cancel`, { method: "POST", body: "{}" });
}

export function retryTask(taskId: string): Promise<TaskDetail> {
  return request<TaskDetail>(`/api/tasks/${taskId}/retry`, { method: "POST", body: "{}" });
}

export function approveStep(stepId: string): Promise<TaskDetail> {
  return request<TaskDetail>(`/api/steps/${stepId}/approve`, { method: "POST", body: "{}" });
}

export async function previewRunnerPolicy(taskId: string, proposedCommand: string, proposedPurpose: string): Promise<TaskDetail> {
  return request<TaskDetail>(`/api/tasks/${taskId}/runner-policy-previews`, {
    method: "POST",
    body: JSON.stringify({ proposedCommand, proposedPurpose }),
  });
}

export async function addCommitReview(taskId: string, input: AddCommitReviewInput): Promise<TaskDetail> {
  return request<TaskDetail>(`/api/tasks/${taskId}/commit-reviews`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchEvidenceBundle(taskId: string): Promise<EvidenceBundleResponse> {
  return request<EvidenceBundleResponse>(`/api/tasks/${taskId}/evidence-bundle`);
}

export async function addValidationEvidence(taskId: string, input: AddValidationInput): Promise<TaskDetail> {
  return request<TaskDetail>(`/api/tasks/${taskId}/validations`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function rejectStep(stepId: string): Promise<TaskDetail> {
  return request<TaskDetail>(`/api/steps/${stepId}/reject`, {
    method: "POST",
    body: JSON.stringify({ reason: "Rejected from cockpit review." }),
  });
}

export async function listRuntimeMissions(): Promise<RuntimeMission[]> {
  const result = await request<{ missions: RuntimeMission[] }>("/api/runtime-missions");
  return result.missions;
}

export function listAutoPosterConnectedAccounts(
  workspaceId: string,
): Promise<AutoPosterConnectedAccountsResponse> {
  const query = new URLSearchParams({ workspaceId });
  return request<AutoPosterConnectedAccountsResponse>(
    `/api/runtime-missions/autoposter/connected-accounts?${query.toString()}`,
  );
}

export function createAutoPosterScheduleMission(
  input: CreateAutoPosterScheduleMissionInput,
): Promise<RuntimeMission> {
  return request<RuntimeMission>("/api/runtime-missions/autoposter/schedule", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function approveRuntimeMission(
  missionId: string,
  approvedBy: string,
): Promise<RuntimeMission> {
  return request<RuntimeMission>(`/api/runtime-missions/${missionId}/approve`, {
    method: "POST",
    body: JSON.stringify({ approvedBy }),
  });
}

export function reconcileRuntimeMission(missionId: string): Promise<RuntimeMission> {
  return request<RuntimeMission>(`/api/runtime-missions/${missionId}/reconcile`, {
    method: "POST",
    body: "{}",
  });
}

export function resumeRuntimeMission(missionId: string): Promise<RuntimeMission> {
  return request<RuntimeMission>(`/api/runtime-missions/${missionId}/resume`, {
    method: "POST",
    body: "{}",
  });
}

export function stopRuntimeMission(missionId: string): Promise<RuntimeMission> {
  return request<RuntimeMission>(`/api/runtime-missions/${missionId}/stop`, {
    method: "POST",
    body: "{}",
  });
}

export function listAgentRunLedgerRuns(
  filters: AgentRunLedgerFilters = {},
): Promise<AgentRunLedgerListResponse> {
  const query = new URLSearchParams();
  const values: Array<[string, string | number | undefined]> = [
    ["product", filters.product],
    ["workflow", filters.workflow],
    ["provider", filters.provider],
    ["model", filters.model],
    ["status", filters.status],
    ["approvalStatus", filters.approvalStatus],
    ["validationResult", filters.validationResult],
    ["outcome", filters.outcome],
    ["from", filters.from],
    ["to", filters.to],
    ["limit", filters.limit],
  ];
  for (const [name, value] of values) {
    if (value !== undefined && value !== "") query.set(name, String(value));
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return request<AgentRunLedgerListResponse>(`/api/agent-run-ledger/runs${suffix}`);
}

export function getAgentRunLedgerRun(runId: string): Promise<AgentRunLedgerRunDetail> {
  return request<AgentRunLedgerRunDetail>(
    `/api/agent-run-ledger/runs/${encodeURIComponent(runId)}`,
  );
}

// ---------------------------------------------------------------------------
// Phase 2D–2F mission-graph lifecycle (Operator Ascension I).
//
// Reads to /api/mission-graphs and /api/mission-graphs/:id are unauthenticated
// projection reads. Every control action (approve/resume/cancel/refresh/
// evidence) and the entire /api/autoposter-observations surface — reads
// included — require the independent Operator control capability. As in the
// established AutoPoster mission panel, the browser never holds a token: the
// local Vite dev/preview proxy injects the correct submit/control token for
// the exact allowlisted path. No credential is ever handled here.
// ---------------------------------------------------------------------------

export async function listMissionGraphs(limit = 50): Promise<MissionGraphView[]> {
  const result = await request<MissionGraphListResponse>(`/api/mission-graphs?limit=${limit}`);
  return result.graphs;
}

export function getMissionGraph(graphId: string): Promise<MissionGraphView> {
  return request<MissionGraphView>(`/api/mission-graphs/${encodeURIComponent(graphId)}`);
}

export function approveMissionGraph(
  graphId: string,
  approvedBy: string,
  graphHash: string,
): Promise<MissionGraphView> {
  return request<MissionGraphView>(
    `/api/mission-graphs/${encodeURIComponent(graphId)}/approve`,
    { method: "POST", body: JSON.stringify({ approvedBy, graphHash }) },
  );
}

export function resumeMissionGraph(graphId: string): Promise<MissionGraphView> {
  return request<MissionGraphView>(
    `/api/mission-graphs/${encodeURIComponent(graphId)}/resume`,
    { method: "POST", body: "{}" },
  );
}

export function cancelMissionGraph(
  graphId: string,
  cancelledBy: string,
  reason: string,
): Promise<MissionGraphView> {
  return request<MissionGraphView>(
    `/api/mission-graphs/${encodeURIComponent(graphId)}/cancel`,
    { method: "POST", body: JSON.stringify({ cancelledBy, reason }) },
  );
}

export function getAutoPosterResults(
  graphId: string,
): Promise<AutoPosterResultProjectionsResponse> {
  return request<AutoPosterResultProjectionsResponse>(
    `/api/mission-graphs/${encodeURIComponent(graphId)}/autoposter-results`,
  );
}

export function refreshAutoPosterResults(
  graphId: string,
): Promise<AutoPosterResultRefreshResponse> {
  return request<AutoPosterResultRefreshResponse>(
    `/api/mission-graphs/${encodeURIComponent(graphId)}/autoposter-results/refresh`,
    { method: "POST", body: "{}" },
  );
}

export function generateMissionGraphEvidence(
  graphId: string,
): Promise<MissionGraphEvidenceResult> {
  return request<MissionGraphEvidenceResult>(
    `/api/mission-graphs/${encodeURIComponent(graphId)}/evidence`,
    { method: "POST", body: "{}" },
  );
}

export function listObservationJobs(graphId?: string): Promise<AutoPosterObservationJobsResponse> {
  const suffix = graphId ? `?graphId=${encodeURIComponent(graphId)}` : "";
  return request<AutoPosterObservationJobsResponse>(`/api/autoposter-observations/jobs${suffix}`);
}

export function getObservationJob(observationJobId: string): Promise<AutoPosterObservationJobDetail> {
  return request<AutoPosterObservationJobDetail>(
    `/api/autoposter-observations/jobs/${encodeURIComponent(observationJobId)}`,
  );
}

export function listObservationEscalations(
  graphId?: string,
): Promise<AutoPosterObservationEscalationsResponse> {
  const suffix = graphId ? `?graphId=${encodeURIComponent(graphId)}` : "";
  return request<AutoPosterObservationEscalationsResponse>(
    `/api/autoposter-observations/escalations${suffix}`,
  );
}

export function runObservationBatch(): Promise<AutoPosterObservationBatchResult> {
  return request<AutoPosterObservationBatchResult>(
    "/api/autoposter-observations/run",
    { method: "POST", body: "{}" },
  );
}

export function acknowledgeObservationEscalation(
  escalationId: string,
  acknowledgedBy: string,
): Promise<AutoPosterObservationEscalationView> {
  return request<AutoPosterObservationEscalationView>(
    `/api/autoposter-observations/escalations/${encodeURIComponent(escalationId)}/acknowledge`,
    { method: "POST", body: JSON.stringify({ acknowledgedBy }) },
  );
}

export function resolveObservationEscalation(
  escalationId: string,
  resolvedBy: string,
  note: string,
): Promise<AutoPosterObservationEscalationView> {
  // The backend resolve route reads the free-text note from `note` (and
  // defaults disposition to "resolved"); it ignores any other key.
  return request<AutoPosterObservationEscalationView>(
    `/api/autoposter-observations/escalations/${encodeURIComponent(escalationId)}/resolve`,
    { method: "POST", body: JSON.stringify({ resolvedBy, note }) },
  );
}
