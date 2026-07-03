import { useState, type FormEvent } from "react";
import type { ActionType, CreateTaskInput, TaskIntent } from "../api/types";
import { StatusBadge } from "./StatusBadge";

interface Props {
  tasks: TaskIntent[];
  selectedTaskId?: string;
  busy: boolean;
  onSelect: (taskId: string) => void;
  onCreate: (input: CreateTaskInput) => Promise<void>;
}

const actions: Array<{ value: ActionType; label: string }> = [
  { value: "analysis", label: "Analysis (safe)" },
  { value: "read_file", label: "Read preview (safe)" },
  { value: "file_write", label: "File write (approval)" },
  { value: "file_edit", label: "File edit (approval)" },
  { value: "shell_command", label: "Shell command (approval)" },
  { value: "unknown", label: "Unknown (approval)" },
];

export function TaskQueuePanel({ tasks, selectedTaskId, busy, onSelect, onCreate }: Props) {
  const [rawInput, setRawInput] = useState("");
  const [actionType, setActionType] = useState<ActionType>("file_edit");
  const [priority, setPriority] = useState(1);

  async function submit(event: FormEvent) {
    event.preventDefault();
    await onCreate({ rawInput, actionType, priority });
    setRawInput("");
  }

  return (
    <aside className="panel panel--queue">
      <div className="panel__heading">
        <div>
          <p className="eyebrow">Task intake</p>
          <h2>Queue</h2>
        </div>
        <span className="count">{tasks.length}</span>
      </div>

      <form className="task-form" onSubmit={submit}>
        <label htmlFor="task-input">Task description</label>
        <textarea
          id="task-input"
          maxLength={4000}
          onChange={(event) => setRawInput(event.target.value)}
          placeholder="Describe one reviewable operator task…"
          required
          rows={4}
          value={rawInput}
        />
        <div className="form-row">
          <label>
            Action
            <select value={actionType} onChange={(event) => setActionType(event.target.value as ActionType)}>
              {actions.map((action) => (
                <option key={action.value} value={action.value}>{action.label}</option>
              ))}
            </select>
          </label>
          <label>
            Priority
            <select value={priority} onChange={(event) => setPriority(Number(event.target.value))}>
              <option value={0}>Low</option>
              <option value={1}>Normal</option>
              <option value={2}>High</option>
            </select>
          </label>
        </div>
        <button className="button button--primary" disabled={busy || !rawInput.trim()} type="submit">
          {busy ? "Creating…" : "Create task"}
        </button>
        <p className="form-note">P0 uses a mock runner. No command or file action will execute.</p>
      </form>

      <div className="task-list" aria-label="Task queue">
        {tasks.length === 0 ? (
          <div className="empty-state">No tasks yet.</div>
        ) : tasks.map((task) => (
          <button
            className={`task-card${selectedTaskId === task.id ? " task-card--selected" : ""}`}
            key={task.id}
            onClick={() => onSelect(task.id)}
            type="button"
          >
            <div className="task-card__topline">
              <StatusBadge status={task.status} />
              <span className="priority">P{task.priority}</span>
            </div>
            <strong>{task.parsed_description}</strong>
            <time>{new Date(task.created_at).toLocaleString()}</time>
          </button>
        ))}
      </div>
    </aside>
  );
}

