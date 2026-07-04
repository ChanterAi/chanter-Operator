import type { TaskDetail, TaskIntent } from "../api/types";

export const mockTaskIntent: TaskIntent = {
  id: "task-001",
  raw_input: "Preview a safe configuration analysis",
  parsed_description: "Preview a safe configuration analysis",
  status: "completed",
  priority: 1,
  product_lane: "CHANTER Operator",
  created_at: "2026-07-04T09:00:00.000Z",
  updated_at: "2026-07-04T09:00:05.000Z",
};

export const mockCompletedDetail: TaskDetail = {
  task: mockTaskIntent,
  steps: [
    {
      id: "step-001",
      task_id: "task-001",
      step_number: 1,
      action_type: "analysis",
      action_payload: { description: "Preview a safe configuration analysis" },
      status: "completed",
      requires_approval: false,
      created_at: "2026-07-04T09:00:00.000Z",
      updated_at: "2026-07-04T09:00:05.000Z",
    },
  ],
  evidence: [
    {
      id: "ev-001",
      task_id: "task-001",
      step_id: "step-001",
      stdout: "[mock-runner] Analysis preview completed. No external model was called.",
      stderr: "",
      exit_code: 0,
      diff: "--- mock-preview\n+++ mock-preview\n+ Mock preview only",
      validation_passed: true,
      validation_summary: "Mock validation passed: analysis output is deterministic and safe.",
      created_at: "2026-07-04T09:00:05.000Z",
    },
  ],
  audit_events: [
    { id: "a1", event_type: "task_created", task_id: "task-001", data: {}, created_at: "2026-07-04T09:00:00.000Z" },
    { id: "a2", event_type: "step_created", task_id: "task-001", step_id: "step-001", data: {}, created_at: "2026-07-04T09:00:00.000Z" },
    { id: "a3", event_type: "step_execution_started", task_id: "task-001", step_id: "step-001", data: {}, created_at: "2026-07-04T09:00:03.000Z" },
    { id: "a4", event_type: "step_executed", task_id: "task-001", step_id: "step-001", data: {}, created_at: "2026-07-04T09:00:05.000Z" },
    { id: "a5", event_type: "evidence_recorded", task_id: "task-001", step_id: "step-001", data: {}, created_at: "2026-07-04T09:00:05.000Z" },
    { id: "a6", event_type: "validation_passed", task_id: "task-001", step_id: "step-001", data: {}, created_at: "2026-07-04T09:00:05.000Z" },
    { id: "a7", event_type: "task_completed", task_id: "task-001", step_id: "step-001", data: {}, created_at: "2026-07-04T09:00:05.000Z" },
  ],
};

export const mockAwaitingDetail: TaskDetail = {
  task: { ...mockTaskIntent, id: "task-002", status: "awaiting_approval", raw_input: "Preview a guarded file edit", parsed_description: "Preview a guarded file edit" },
  steps: [
    {
      id: "step-002",
      task_id: "task-002",
      step_number: 1,
      action_type: "file_edit",
      action_payload: { description: "Preview a guarded file edit", workspace_relative_path: "config/preview.json" },
      status: "pending_approval",
      requires_approval: true,
      created_at: "2026-07-04T09:10:00.000Z",
      updated_at: "2026-07-04T09:10:00.000Z",
    },
  ],
  evidence: [],
  audit_events: [
    { id: "b1", event_type: "task_created", task_id: "task-002", data: {}, created_at: "2026-07-04T09:10:00.000Z" },
    { id: "b2", event_type: "step_created", task_id: "task-002", step_id: "step-002", data: {}, created_at: "2026-07-04T09:10:00.000Z" },
    { id: "b3", event_type: "approval_required", task_id: "task-002", step_id: "step-002", data: {}, created_at: "2026-07-04T09:10:00.000Z" },
  ],
};

export const mockRejectedDetail: TaskDetail = {
  task: { ...mockTaskIntent, id: "task-003", status: "rejected", raw_input: "Reject this shell command", parsed_description: "Reject this shell command" },
  steps: [
    {
      id: "step-003",
      task_id: "task-003",
      step_number: 1,
      action_type: "shell_command",
      action_payload: { description: "Reject this shell command" },
      status: "rejected",
      requires_approval: true,
      created_at: "2026-07-04T09:20:00.000Z",
      updated_at: "2026-07-04T09:20:05.000Z",
    },
  ],
  evidence: [],
  audit_events: [
    { id: "c1", event_type: "task_created", task_id: "task-003", data: {}, created_at: "2026-07-04T09:20:00.000Z" },
    { id: "c2", event_type: "step_created", task_id: "task-003", step_id: "step-003", data: {}, created_at: "2026-07-04T09:20:00.000Z" },
    { id: "c3", event_type: "approval_required", task_id: "task-003", step_id: "step-003", data: {}, created_at: "2026-07-04T09:20:00.000Z" },
    { id: "c4", event_type: "step_rejected", task_id: "task-003", step_id: "step-003", data: {}, created_at: "2026-07-04T09:20:05.000Z" },
  ],
};
