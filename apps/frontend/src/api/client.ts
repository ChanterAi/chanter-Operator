import type { CreateTaskInput, TaskDetail, TaskIntent } from "./types";

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error || "The local operator request failed.");
  }
  return payload;
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

export function approveStep(stepId: string): Promise<TaskDetail> {
  return request<TaskDetail>(`/api/steps/${stepId}/approve`, { method: "POST", body: "{}" });
}

export function rejectStep(stepId: string): Promise<TaskDetail> {
  return request<TaskDetail>(`/api/steps/${stepId}/reject`, {
    method: "POST",
    body: JSON.stringify({ reason: "Rejected from cockpit review." }),
  });
}

