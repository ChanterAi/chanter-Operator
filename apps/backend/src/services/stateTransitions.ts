import type { StepStatus, TaskStatus } from "../types.js";

const taskTransitions: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  pending: new Set(["queued", "awaiting_approval"]),
  queued: new Set(["executing"]),
  awaiting_approval: new Set(["queued", "rejected"]),
  executing: new Set(["completed", "failed"]),
  completed: new Set(),
  failed: new Set(),
  rejected: new Set(),
};

const stepTransitions: Record<StepStatus, ReadonlySet<StepStatus>> = {
  pending_approval: new Set(["approved", "rejected"]),
  approved: new Set(["executing"]),
  executing: new Set(["completed", "failed"]),
  completed: new Set(),
  failed: new Set(),
  rejected: new Set(),
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return taskTransitions[from].has(to);
}

export function canTransitionStep(from: StepStatus, to: StepStatus): boolean {
  return stepTransitions[from].has(to);
}
