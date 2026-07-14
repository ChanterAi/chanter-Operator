import type {
  AddCommitReviewInput,
  AddValidationInput,
  AgentRunLedgerFilters,
  AgentRunLedgerListResponse,
  AgentRunLedgerRunDetail,
  AutoPosterConnectedAccountsResponse,
  CreateAutoPosterScheduleMissionInput,
  CreateTaskInput,
  EvidenceBundleResponse,
  HealthResponse,
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
