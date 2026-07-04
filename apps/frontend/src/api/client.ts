import type { CreateTaskInput, HealthResponse, TaskDetail, TaskIntent } from "./types";

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

export function rejectStep(stepId: string): Promise<TaskDetail> {
  return request<TaskDetail>(`/api/steps/${stepId}/reject`, {
    method: "POST",
    body: JSON.stringify({ reason: "Rejected from cockpit review." }),
  });
}
