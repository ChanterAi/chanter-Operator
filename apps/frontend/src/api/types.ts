export type ActionType =
  | "analysis"
  | "read_file"
  | "file_write"
  | "file_edit"
  | "shell_command"
  | "unknown";

export interface TaskIntent {
  id: string;
  raw_input: string;
  parsed_description: string;
  status: string;
  priority: number;
  created_at: string;
  updated_at: string;
}

export interface ExecutionStep {
  id: string;
  task_id: string;
  step_number: number;
  action_type: ActionType;
  action_payload: Record<string, unknown>;
  status: string;
  requires_approval: boolean;
  created_at: string;
  updated_at: string;
}

export interface Evidence {
  id: string;
  task_id: string;
  step_id: string;
  stdout: string;
  stderr: string;
  exit_code: number;
  diff: string;
  validation_passed: boolean;
  validation_summary: string;
  created_at: string;
}

export interface AuditEvent {
  id: string;
  event_type: string;
  task_id: string;
  step_id?: string;
  data: Record<string, unknown>;
  created_at: string;
}

export interface TaskDetail {
  task: TaskIntent;
  steps: ExecutionStep[];
  evidence: Evidence[];
  audit_events: AuditEvent[];
}

export interface CreateTaskInput {
  rawInput: string;
  actionType: ActionType;
  priority: number;
}

