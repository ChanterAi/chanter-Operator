import type {
  AddCommitReviewInput,
  AddValidationInput,
  CreateAutoPosterScheduleMissionInput,
  CreateTaskInput,
  EvidenceBundleResponse,
  HealthResponse,
  RuntimeMission,
  TaskDetail,
  TaskIntent,
} from "./types";

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

  let payload: T & { error?: string };
  try {
    payload = (await response.json()) as T & { error?: string };
  } catch {
    throw new Error("The local Operator API returned an unreadable response.");
  }
  if (!response.ok) {
    throw new Error(payload.error || "The local operator request failed.");
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
