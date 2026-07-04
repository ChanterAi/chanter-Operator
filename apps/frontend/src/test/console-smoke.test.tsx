import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { ReadinessBar } from "../components/ReadinessBar";
import { TaskDetailPanel } from "../components/TaskDetailPanel";
import { ReviewPanel } from "../components/ReviewPanel";
import { TaskQueuePanel } from "../components/TaskQueuePanel";
import * as client from "../api/client";
import type { HealthResponse, ReadinessState } from "../api/types";
import {
  mockAwaitingDetail,
  mockCompletedDetail,
  mockHealthHealthy,
  mockHealthUnhealthy,
  mockRejectedDetail,
  mockTaskIntent,
} from "./fixtures";

// ── Helpers ──────────────────────────────────────────────────────────

function mockAllApi() {
  vi.spyOn(client, "fetchHealth").mockResolvedValue(mockHealthHealthy);
  vi.spyOn(client, "listTasks").mockResolvedValue([]);
  vi.spyOn(client, "getTask").mockResolvedValue(mockCompletedDetail);
  vi.spyOn(client, "createTask").mockResolvedValue(mockCompletedDetail);
  vi.spyOn(client, "approveStep").mockResolvedValue(mockCompletedDetail);
  vi.spyOn(client, "rejectStep").mockResolvedValue(mockRejectedDetail);
}

// ── 1. App shell renders ─────────────────────────────────────────────

describe("P0.3 smoke: Operator Console shell", () => {
  beforeEach(() => mockAllApi());

  it("renders the app shell with brand and cockpit panels", async () => {
    render(<App />);
    expect(screen.getByText("CHANTER")).toBeInTheDocument();
    expect(screen.getByText("Operator")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^queue$/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^review$/i })).toBeInTheDocument();
  });
});

// ── 2. Header agent/mode bar ─────────────────────────────────────────

describe("P0.3 smoke: header agent/mode bar", () => {
  beforeEach(() => mockAllApi());

  it("displays Runner: Mock Adapter", async () => {
    render(<App />);
    const header = screen.getByRole("banner");
    expect(within(header).getByText("Runner")).toBeInTheDocument();
    expect(within(header).getByText("Mock Adapter")).toBeInTheDocument();
  });

  it("displays Mode: Safe / Review-only", async () => {
    render(<App />);
    const header = screen.getByRole("banner");
    expect(within(header).getByText("Mode")).toBeInTheDocument();
    expect(within(header).getByText("Safe / Review-only")).toBeInTheDocument();
  });

  it("displays Execution: Contained Simulation", async () => {
    render(<App />);
    const header = screen.getByRole("banner");
    expect(within(header).getByText("Execution")).toBeInTheDocument();
    expect(within(header).getByText("Contained Simulation")).toBeInTheDocument();
  });
});

// ── 3. Task intake form renders ──────────────────────────────────────

describe("P0.3 smoke: task intake form", () => {
  beforeEach(() => mockAllApi());

  it("renders the task description textarea", async () => {
    render(<App />);
    expect(screen.getByPlaceholderText(/describe one reviewable/i)).toBeInTheDocument();
  });

  it("renders the create task button", async () => {
    render(<App />);
    expect(screen.getByRole("button", { name: /create task/i })).toBeInTheDocument();
  });

  it("renders the MOCK ONLY safety pill", async () => {
    render(<App />);
    expect(screen.getByText("MOCK ONLY")).toBeInTheDocument();
  });
});

// ── 4. Product lane selector ─────────────────────────────────────────

describe("P0.3 smoke: product lane selector", () => {
  beforeEach(() => mockAllApi());

  const expectedLanes = [
    "AutoPoster",
    "Loop Governor",
    "Clean Engine",
    "Crypto Radar",
    "Premium Site",
    "CHANTER Operator",
  ];

  it.each(expectedLanes)("includes lane option: %s", async (lane) => {
    render(<App />);
    const laneSelect = screen.getByLabelText(/product lane/i);
    expect(laneSelect).toBeInTheDocument();
    expect(within(laneSelect).getByRole("option", { name: lane })).toBeInTheDocument();
  });
});

// ── 5. User can create a mock task ───────────────────────────────────

describe("P0.3 smoke: create mock task", () => {
  beforeEach(() => mockAllApi());

  it("creates a task and calls the API with correct payload", async () => {
    const user = userEvent.setup();
    render(<App />);

    // Wait for loading to finish so the form is interactive
    await screen.findByPlaceholderText(/describe one reviewable/i);

    const textarea = screen.getByPlaceholderText(/describe one reviewable/i);
    await user.type(textarea, "Run a safe analysis preview");

    const button = screen.getByRole("button", { name: /create task/i });
    expect(button).not.toBeDisabled();
    await user.click(button);

    expect(client.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        rawInput: "Run a safe analysis preview",
        actionType: expect.any(String),
        priority: expect.any(Number),
        productLane: expect.any(String),
      }),
    );
  });
});

// ── 6. Created task appears in queue ─────────────────────────────────

describe("P0.3 smoke: task appears in queue", () => {
  beforeEach(() => {
    vi.spyOn(client, "fetchHealth").mockResolvedValue(mockHealthHealthy);
    vi.spyOn(client, "listTasks").mockResolvedValue([mockTaskIntent]);
    vi.spyOn(client, "getTask").mockResolvedValue(mockCompletedDetail);
    vi.spyOn(client, "createTask").mockResolvedValue(mockCompletedDetail);
    vi.spyOn(client, "approveStep").mockResolvedValue(mockCompletedDetail);
    vi.spyOn(client, "rejectStep").mockResolvedValue(mockRejectedDetail);
  });

  it("renders the task card in the queue", async () => {
    render(<App />);
    // The task card renders the description inside a <strong> element
    const queue = await screen.findByLabelText("Task queue");
    expect(within(queue).getByText("Preview a safe configuration analysis")).toBeInTheDocument();
  });

  it("shows the product lane on the task card", async () => {
    render(<App />);
    const queue = await screen.findByLabelText("Task queue");
    expect(within(queue).getByText("CHANTER Operator")).toBeInTheDocument();
  });
});

// ── 7. Completed flow: status, next action, evidence, audit ─────────

describe("P0.3 smoke: completed task detail and review", () => {
  it("shows task status completed in detail panel", async () => {
    render(<TaskDetailPanel detail={mockCompletedDetail} loading={false} error="" />);
    // Task status appears in the heading area
    const heading = screen.getByRole("heading", { name: /preview a safe configuration analysis/i });
    expect(heading.parentElement?.parentElement).toHaveTextContent("completed");
  });

  it("shows Task complete as recommended next action in detail panel", async () => {
    render(<TaskDetailPanel detail={mockCompletedDetail} loading={false} error="" />);
    expect(screen.getByText("Task complete")).toBeInTheDocument();
  });

  it("shows evidence summary with mock validation passed", async () => {
    render(<TaskDetailPanel detail={mockCompletedDetail} loading={false} error="" />);
    expect(screen.getByText("Passed")).toBeInTheDocument();
    expect(screen.getByText(/deterministic mock evidence only/i)).toBeInTheDocument();
  });

  it("shows audit entries in review panel", async () => {
    render(
      <ReviewPanel
        detail={mockCompletedDetail}
        busy={false}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByText("task_created")).toBeInTheDocument();
    expect(screen.getByText("evidence_recorded")).toBeInTheDocument();
  });
});

// ── 8. No real execution controls ────────────────────────────────────

describe("P0.3 smoke: no real execution controls", () => {
  beforeEach(() => mockAllApi());

  it("does not render any execute / run / deploy buttons", async () => {
    render(<App />);
    const allButtons = screen.getAllByRole("button");
    const buttonTexts = allButtons.map((b) => b.textContent?.toLowerCase() ?? "");
    for (const text of buttonTexts) {
      expect(text).not.toMatch(/\b(execute|run|deploy|start process|git push|commit)\b/);
    }
  });

  it("does not mention real runner, codex, ollama, or shell execution", async () => {
    render(<App />);
    const bodyText = document.body.textContent?.toLowerCase() ?? "";
    expect(bodyText).not.toMatch(/\bcodex\b/);
    expect(bodyText).not.toMatch(/\bollama\b/);
    expect(bodyText).not.toMatch(/\bgit\s+(push|commit|clone)\b/);
    expect(bodyText).not.toMatch(/real\s+execution/);
  });

  it("TaskQueuePanel form note mentions mock-only safety", async () => {
    render(
      <TaskQueuePanel
        tasks={[]}
        busy={false}
        creating={false}
        loading={false}
        error=""
        onSelect={vi.fn()}
        onCreate={vi.fn().mockResolvedValue(true)}
      />,
    );
    expect(screen.getByText("MOCK ONLY")).toBeInTheDocument();
    expect(screen.getByText(/safe \/ review-only mode/i)).toBeInTheDocument();
  });
});

// ── Awaiting approval state ──────────────────────────────────────────

describe("P0.3 smoke: awaiting approval state", () => {
  it("shows Approve mock simulation as next action", async () => {
    render(<TaskDetailPanel detail={mockAwaitingDetail} loading={false} error="" />);
    expect(screen.getByText("Approve mock simulation")).toBeInTheDocument();
  });

  it("shows approval buttons in review panel", async () => {
    render(
      <ReviewPanel
        detail={mockAwaitingDetail}
        busy={false}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /approve & simulate/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reject/i })).toBeInTheDocument();
  });

  it("shows Decision needed safety indicator", async () => {
    render(
      <ReviewPanel
        detail={mockAwaitingDetail}
        busy={false}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByText("Decision needed")).toBeInTheDocument();
  });
});

// ── Rejected state ───────────────────────────────────────────────────

describe("P0.3 smoke: rejected state", () => {
  it("shows Rejected as next action in detail panel", async () => {
    render(<TaskDetailPanel detail={mockRejectedDetail} loading={false} error="" />);
    expect(screen.getByText("Rejected")).toBeInTheDocument();
  });

  it("shows rejection message in review panel", async () => {
    render(
      <ReviewPanel
        detail={mockRejectedDetail}
        busy={false}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByText(/task was rejected/i)).toBeInTheDocument();
  });
});

// ── Empty state ──────────────────────────────────────────────────────

describe("P0.3 smoke: empty state", () => {
  it("shows empty state message when no task selected", async () => {
    render(<TaskDetailPanel detail={null} loading={false} error="" />);
    expect(screen.getByText(/create or select a task/i)).toBeInTheDocument();
  });

  it("shows loading state", async () => {
    render(<TaskDetailPanel detail={null} loading={true} error="" />);
    expect(screen.getByText(/loading task evidence/i)).toBeInTheDocument();
  });

  it("shows error state", async () => {
    render(<TaskDetailPanel detail={null} loading={false} error="Connection failed" />);
    expect(screen.getByText("Connection failed")).toBeInTheDocument();
  });
});

// ── P0.5 Readiness Gate ──────────────────────────────────────────────

describe("P0.5 smoke: readiness gate renders healthy state", () => {
  beforeEach(() => {
    vi.spyOn(client, "fetchHealth").mockResolvedValue(mockHealthHealthy);
    vi.spyOn(client, "listTasks").mockResolvedValue([]);
    vi.spyOn(client, "getTask").mockResolvedValue(mockCompletedDetail);
    vi.spyOn(client, "createTask").mockResolvedValue(mockCompletedDetail);
    vi.spyOn(client, "approveStep").mockResolvedValue(mockCompletedDetail);
    vi.spyOn(client, "rejectStep").mockResolvedValue(mockRejectedDetail);
  });

  it("shows Backend Reachable in the readiness bar", async () => {
    render(<App />);
    expect(await screen.findByText("Reachable")).toBeInTheDocument();
  });

  it("shows Integrity Healthy in the readiness bar", async () => {
    render(<App />);
    expect(await screen.findByText("Healthy")).toBeInTheDocument();
  });

  it("shows record counts in the readiness bar", async () => {
    render(<App />);
    expect(await screen.findByText(/3T \/ 3S \/ 2E/i)).toBeInTheDocument();
  });

  it("shows Mock-only in the readiness bar", async () => {
    render(<App />);
    expect(await screen.findByText("Mock-only")).toBeInTheDocument();
  });
});

describe("P0.5 smoke: unhealthy integrity renders warning", () => {
  beforeEach(() => {
    vi.spyOn(client, "fetchHealth").mockResolvedValue(mockHealthUnhealthy);
    vi.spyOn(client, "listTasks").mockResolvedValue([]);
    vi.spyOn(client, "getTask").mockResolvedValue(mockCompletedDetail);
    vi.spyOn(client, "createTask").mockResolvedValue(mockCompletedDetail);
    vi.spyOn(client, "approveStep").mockResolvedValue(mockCompletedDetail);
    vi.spyOn(client, "rejectStep").mockResolvedValue(mockRejectedDetail);
  });

  it("shows Unhealthy in the readiness bar", async () => {
    render(<App />);
    expect(await screen.findByText("Unhealthy")).toBeInTheDocument();
  });

  it("shows issue counts when unhealthy", async () => {
    render(<App />);
    // DB: 2 issues, Audit: 2 issues (1 parse + 1 crossRef)
    const bar = await screen.findByText("Unhealthy");
    expect(bar.closest(".readiness-bar")).toBeInTheDocument();
    expect(screen.getByText(/DB: 2/)).toBeInTheDocument();
    expect(screen.getByText(/Audit: 2/)).toBeInTheDocument();
  });

  it("still keeps the task creation form functional", async () => {
    render(<App />);
    expect(await screen.findByPlaceholderText(/describe one reviewable/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create task/i })).toBeInTheDocument();
  });
});

describe("P0.5 smoke: backend unavailable renders safely", () => {
  beforeEach(() => {
    vi.spyOn(client, "fetchHealth").mockRejectedValue(new Error("Cannot connect to local backend."));
    vi.spyOn(client, "listTasks").mockResolvedValue([]);
    vi.spyOn(client, "getTask").mockResolvedValue(mockCompletedDetail);
    vi.spyOn(client, "createTask").mockResolvedValue(mockCompletedDetail);
    vi.spyOn(client, "approveStep").mockResolvedValue(mockCompletedDetail);
    vi.spyOn(client, "rejectStep").mockResolvedValue(mockRejectedDetail);
  });

  it("shows Backend unavailable in the readiness bar", async () => {
    render(<App />);
    expect(await screen.findByText("Backend unavailable")).toBeInTheDocument();
  });

  it("does not crash the rest of the UI", async () => {
    render(<App />);
    expect(await screen.findByText("CHANTER")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^queue$/i })).toBeInTheDocument();
  });
});

describe("P0.5 smoke: ReadinessBar component isolation", () => {
  it("renders loading state", () => {
    render(<ReadinessBar state={{ kind: "loading" }} />);
    expect(screen.getByText(/checking backend readiness/i)).toBeInTheDocument();
  });

  it("renders unavailable state with error text", () => {
    render(<ReadinessBar state={{ kind: "unavailable", error: "Connection refused." }} />);
    expect(screen.getByText("Backend unavailable")).toBeInTheDocument();
    expect(screen.getByText("Connection refused.")).toBeInTheDocument();
  });

  it("renders healthy state with record counts", () => {
    render(<ReadinessBar state={{ kind: "healthy", health: mockHealthHealthy }} />);
    expect(screen.getByText("Reachable")).toBeInTheDocument();
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.getByText("Mock-only")).toBeInTheDocument();
  });

  it("renders unhealthy state with issue counts", () => {
    render(<ReadinessBar state={{ kind: "unhealthy", health: mockHealthUnhealthy }} />);
    expect(screen.getByText("Unhealthy")).toBeInTheDocument();
    expect(screen.getByText(/DB: 2/)).toBeInTheDocument();
    expect(screen.getByText(/Audit: 2/)).toBeInTheDocument();
  });
});

describe("P0.5 smoke: no new real execution controls or wording", () => {
  beforeEach(() => {
    vi.spyOn(client, "fetchHealth").mockResolvedValue(mockHealthHealthy);
    vi.spyOn(client, "listTasks").mockResolvedValue([]);
    vi.spyOn(client, "getTask").mockResolvedValue(mockCompletedDetail);
    vi.spyOn(client, "createTask").mockResolvedValue(mockCompletedDetail);
    vi.spyOn(client, "approveStep").mockResolvedValue(mockCompletedDetail);
    vi.spyOn(client, "rejectStep").mockResolvedValue(mockRejectedDetail);
  });

  it("does not introduce execute/run/deploy in readiness text", async () => {
    render(<App />);
    await screen.findByText("Reachable");
    const bar = document.querySelector(".readiness-bar");
    const text = bar?.textContent?.toLowerCase() ?? "";
    expect(text).not.toMatch(/\b(execute|run|deploy|start|network)\b/);
  });
});
