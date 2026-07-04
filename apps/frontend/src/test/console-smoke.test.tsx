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
        onCancel={vi.fn()}
        onRetry={vi.fn()}
          onAddValidation={vi.fn()}
          onAddCommitReview={vi.fn()}
      onPolicyPreviewGenerated={vi.fn()}
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
        onCancel={vi.fn()}
        onRetry={vi.fn()}
          onAddValidation={vi.fn()}
          onAddCommitReview={vi.fn()}
      onPolicyPreviewGenerated={vi.fn()}
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
        onCancel={vi.fn()}
        onRetry={vi.fn()}
          onAddValidation={vi.fn()}
          onAddCommitReview={vi.fn()}
      onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    expect(screen.getByText("Decision needed")).toBeInTheDocument();
  });
});

// ── Rejected state ───────────────────────────────────────────────────

describe("P0.3 smoke: rejected state", () => {
  it("shows Retry available as next action in detail panel", async () => {
    render(<TaskDetailPanel detail={mockRejectedDetail} loading={false} error="" />);
    expect(screen.getByText("Retry available")).toBeInTheDocument();
  });

  it("shows retry guidance in review panel", async () => {
    render(
      <ReviewPanel
        detail={mockRejectedDetail}
        busy={false}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
          onAddValidation={vi.fn()}
          onAddCommitReview={vi.fn()}
      onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    expect(screen.getByText(/task can be retried/i)).toBeInTheDocument();
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

// ── P0.6 Lifecycle Controls ──────────────────────────────────────────

describe("P0.6 smoke: lifecycle controls visible for allowed states", () => {
  it("shows Cancel button for awaiting_approval task", async () => {
    vi.spyOn(client, "fetchHealth").mockResolvedValue(mockHealthHealthy);
    vi.spyOn(client, "listTasks").mockResolvedValue([mockAwaitingDetail.task]);
    vi.spyOn(client, "getTask").mockResolvedValue(mockAwaitingDetail);
    vi.spyOn(client, "cancelTask").mockResolvedValue(mockAwaitingDetail);
    vi.spyOn(client, "retryTask").mockResolvedValue(mockCompletedDetail);
    vi.spyOn(client, "createTask").mockResolvedValue(mockCompletedDetail);
    vi.spyOn(client, "approveStep").mockResolvedValue(mockCompletedDetail);
    vi.spyOn(client, "rejectStep").mockResolvedValue(mockRejectedDetail);
    render(<App />);
    expect(await screen.findByText("Cancel task")).toBeInTheDocument();
  });

  it("hides Cancel button for completed task", async () => {
    render(
      <ReviewPanel
        detail={mockCompletedDetail}
        busy={false}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
          onAddValidation={vi.fn()}
          onAddCommitReview={vi.fn()}
      onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    expect(screen.queryByText("Cancel task")).not.toBeInTheDocument();
  });

  it("hides Cancel button for rejected task", async () => {
    render(
      <ReviewPanel
        detail={mockRejectedDetail}
        busy={false}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
          onAddValidation={vi.fn()}
          onAddCommitReview={vi.fn()}
      onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    expect(screen.queryByText("Cancel task")).not.toBeInTheDocument();
  });

  it("shows Retry button for rejected task", async () => {
    render(
      <ReviewPanel
        detail={mockRejectedDetail}
        busy={false}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
          onAddValidation={vi.fn()}
          onAddCommitReview={vi.fn()}
      onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    expect(screen.getByText("Retry task")).toBeInTheDocument();
  });

  it("hides Retry button for awaiting_approval task", async () => {
    render(
      <ReviewPanel
        detail={mockAwaitingDetail}
        busy={false}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
          onAddValidation={vi.fn()}
          onAddCommitReview={vi.fn()}
      onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    expect(screen.queryByText("Retry task")).not.toBeInTheDocument();
  });
});

describe("P0.6 smoke: lifecycle actions call correct API", () => {
  it("clicking Cancel calls cancelTask", async () => {
    const cancelSpy = vi.fn().mockResolvedValue(undefined);
    render(
      <ReviewPanel
        detail={mockAwaitingDetail}
        busy={false}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={cancelSpy}
        onRetry={vi.fn()}
          onAddValidation={vi.fn()}
          onAddCommitReview={vi.fn()}
      onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    const btn = screen.getByText("Cancel task");
    btn.click();
    expect(cancelSpy).toHaveBeenCalledWith(mockAwaitingDetail.task.id);
  });

  it("clicking Retry calls retryTask", async () => {
    const retrySpy = vi.fn().mockResolvedValue(undefined);
    render(
      <ReviewPanel
        detail={mockRejectedDetail}
        busy={false}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={retrySpy}
          onAddValidation={vi.fn()}
          onAddCommitReview={vi.fn()}
      onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    const btn = screen.getByText("Retry task");
    btn.click();
    expect(retrySpy).toHaveBeenCalledWith(mockRejectedDetail.task.id);
  });
});

describe("P0.6 smoke: lifecycle controls show busy state", () => {
  it("Cancel button shows Cancelling... when busy", async () => {
    render(
      <ReviewPanel
        detail={mockAwaitingDetail}
        busy={true}
        cancelDecision="cancelling"
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
          onAddValidation={vi.fn()}
          onAddCommitReview={vi.fn()}
      onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    expect(screen.getByText("Cancelling...")).toBeInTheDocument();
  });

  it("Retry button shows Retrying... when busy", async () => {
    render(
      <ReviewPanel
        detail={mockRejectedDetail}
        busy={true}
        retryDecision="retrying"
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
          onAddValidation={vi.fn()}
          onAddCommitReview={vi.fn()}
      onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    expect(screen.getByText("Retrying...")).toBeInTheDocument();
  });
});

describe("P0.6 smoke: no execution controls introduced", () => {
  it("lifecycle buttons do not mention execute/run/deploy", async () => {
    render(
      <ReviewPanel
        detail={mockRejectedDetail}
        busy={false}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
          onAddValidation={vi.fn()}
          onAddCommitReview={vi.fn()}
      onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    const allButtons = screen.getAllByRole("button");
    const texts = allButtons.map((b) => b.textContent?.toLowerCase() ?? "");
    for (const t of texts) {
      expect(t).not.toMatch(/\b(execute|run|deploy|start|shell|codex|ollama)\b/);
    }
  });

describe("P0.7 manual validation evidence intake", () => {
  it("renders manual validation form in ReviewPanel", () => {
    render(
      <ReviewPanel
        busy={false}
        detail={mockCompletedDetail}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onAddValidation={vi.fn()}
          onAddCommitReview={vi.fn()}
      onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    expect(screen.getByText("Manual validation")).toBeInTheDocument();
  });

  it("renders no-execution disclaimer", () => {
    render(
      <ReviewPanel
        busy={false}
        detail={mockCompletedDetail}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onAddValidation={vi.fn()}
          onAddCommitReview={vi.fn()}
      onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    expect(screen.getByText(/Manual evidence only/i)).toBeInTheDocument();
    expect(screen.getAllByText(/no command is run/i).length).toBeGreaterThanOrEqual(1);
  });

  it("renders command label input", () => {
    render(
      <ReviewPanel
        busy={false}
        detail={mockCompletedDetail}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onAddValidation={vi.fn()}
          onAddCommitReview={vi.fn()}
      onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    const manualSection = screen.getByText("Manual validation").closest("section")!;
    expect(manualSection.querySelector('input[placeholder*="npm test"]')).toBeInTheDocument();
  });

  it("renders status selector with all options", () => {
    render(
      <ReviewPanel
        busy={false}
        detail={mockCompletedDetail}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onAddValidation={vi.fn()}
          onAddCommitReview={vi.fn()}
      onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    // The select has "Passed" as default option
    const selectEl = screen.getByRole("combobox") as HTMLSelectElement;
    expect(selectEl.value).toBe("passed");
    // Check all options exist in the select
    const options = Array.from(selectEl.options).map(o => o.value);
    expect(options).toContain("passed");
    expect(options).toContain("failed");
    expect(options).toContain("warning");
    expect(options).toContain("not_run");
  });

  it("renders add evidence button", () => {
    render(
      <ReviewPanel
        busy={false}
        detail={mockCompletedDetail}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onAddValidation={vi.fn()}
          onAddCommitReview={vi.fn()}
      onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /add evidence/i })).toBeInTheDocument();
  });

  it("renders existing validation evidence entries", () => {
    const withEvidence = {
      ...mockCompletedDetail,
      validation_evidence: [
        {
          id: "ve-001",
          task_id: "task-001",
          command_label: "npm test",
          status: "passed" as const,
          output: "42 tests passed",
          created_at: new Date().toISOString(),
        },
      ],
    };
    render(
      <ReviewPanel
        busy={false}
        detail={withEvidence}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onAddValidation={vi.fn()}
          onAddCommitReview={vi.fn()}
      onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    expect(screen.getByText("Pass")).toBeInTheDocument();
    expect(screen.getByText("npm test")).toBeInTheDocument();
    expect(screen.getByText("42 tests passed")).toBeInTheDocument();
  });

  it("renders passed/failed/warning status badges", () => {
    const withEvidence = {
      ...mockCompletedDetail,
      validation_evidence: [
        { id: "v1", task_id: "t1", command_label: "c1", status: "passed" as const, output: "", created_at: new Date().toISOString() },
        { id: "v2", task_id: "t1", command_label: "c2", status: "failed" as const, output: "", created_at: new Date().toISOString() },
        { id: "v3", task_id: "t1", command_label: "c3", status: "warning" as const, output: "", created_at: new Date().toISOString() },
      ],
    };
    render(
      <ReviewPanel
        busy={false}
        detail={withEvidence}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onAddValidation={vi.fn()}
          onAddCommitReview={vi.fn()}
      onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    expect(screen.getByText("Pass")).toBeInTheDocument();
    expect(screen.getByText("Fail")).toBeInTheDocument();
    expect(screen.getByText("Warn")).toBeInTheDocument();
  });

  it("no execute/run/deploy wording in validation section", () => {
    render(
      <ReviewPanel
        busy={false}
        detail={mockCompletedDetail}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onAddValidation={vi.fn()}
          onAddCommitReview={vi.fn()}
      onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    const section = screen.getByText("Manual validation").closest("section")!;
    const text = section.textContent || "";
    // Must contain disclaimer
    expect(text).toMatch(/no command is run/i);
    // Must NOT contain real-execution language
    expect(text).not.toMatch(/execute/i);
    expect(text).not.toMatch(/run command/i);
    expect(text).not.toMatch(/deploy/i);
    expect(text).not.toMatch(/codex/i);
    expect(text).not.toMatch(/ollama/i);
  });
});


describe("P0.8 safe commit review intake", () => {
  it("renders commit review form in ReviewPanel", () => {
    render(
      <ReviewPanel
        busy={false}
        detail={mockCompletedDetail}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onAddValidation={vi.fn()}
        onAddCommitReview={vi.fn()}
      onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    expect(screen.getByText("Safe commit review intake")).toBeInTheDocument();
  });

  it("renders no-git disclaimer", () => {
    render(
      <ReviewPanel
        busy={false}
        detail={mockCompletedDetail}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onAddValidation={vi.fn()}
        onAddCommitReview={vi.fn()}
      onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    expect(screen.getByText(/Manual review only/i)).toBeInTheDocument();
    expect(screen.getByText(/no git command is run/i)).toBeInTheDocument();
  });

  it("renders submit review button", () => {
    render(
      <ReviewPanel
        busy={false}
        detail={mockCompletedDetail}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onAddValidation={vi.fn()}
        onAddCommitReview={vi.fn()}
      onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /submit review/i })).toBeInTheDocument();
  });

  it("renders BLOCKED verdict badge", () => {
    const withReview = {
      ...mockCompletedDetail,
      commit_reviews: [{
        id: "cr-001",
        task_id: "task-001",
        summary_text: "tests failed",
        changed_files_text: "5 files",
        validation_text: "2 tests failing",
        risk_notes_text: "",
        verdict: "blocked" as const,
        reasons: ["Failing tests reported"],
        created_at: new Date().toISOString(),
      }],
    };
    render(
      <ReviewPanel
        busy={false}
        detail={withReview}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onAddValidation={vi.fn()}
        onAddCommitReview={vi.fn()}
      onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    expect(screen.getByText(/BLOCKED/i)).toBeInTheDocument();
  });

  it("renders NEEDS REVIEW verdict badge", () => {
    const withReview = {
      ...mockCompletedDetail,
      commit_reviews: [{
        id: "cr-002",
        task_id: "task-001",
        summary_text: "broad changes",
        changed_files_text: "15 files",
        validation_text: "passes",
        risk_notes_text: "",
        verdict: "needs_review" as const,
        reasons: ["High number of changed files"],
        created_at: new Date().toISOString(),
      }],
    };
    render(
      <ReviewPanel
        busy={false}
        detail={withReview}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onAddValidation={vi.fn()}
        onAddCommitReview={vi.fn()}
      onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    expect(screen.getByText(/NEEDS REVIEW/i)).toBeInTheDocument();
  });

  it("renders SAFE TO REVIEW verdict badge", () => {
    const withReview = {
      ...mockCompletedDetail,
      commit_reviews: [{
        id: "cr-003",
        task_id: "task-001",
        summary_text: "clean implementation",
        changed_files_text: "3 files",
        validation_text: "all gates pass",
        risk_notes_text: "",
        verdict: "safe_to_review" as const,
        reasons: ["All automated checks pass."],
        created_at: new Date().toISOString(),
      }],
    };
    render(
      <ReviewPanel
        busy={false}
        detail={withReview}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onAddValidation={vi.fn()}
        onAddCommitReview={vi.fn()}
      onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    expect(screen.getByText(/SAFE TO REVIEW/i)).toBeInTheDocument();
  });

  it("renders verdict reasons", () => {
    const withReview = {
      ...mockCompletedDetail,
      commit_reviews: [{
        id: "cr-004",
        task_id: "task-001",
        summary_text: "test",
        changed_files_text: "test",
        validation_text: "test",
        risk_notes_text: "",
        verdict: "blocked" as const,
        reasons: ["Failing tests reported", "Real execution or external API detected"],
        created_at: new Date().toISOString(),
      }],
    };
    render(
      <ReviewPanel
        busy={false}
        detail={withReview}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onAddValidation={vi.fn()}
        onAddCommitReview={vi.fn()}
      onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    expect(screen.getByText(/Failing tests reported/i)).toBeInTheDocument();
    expect(screen.getByText(/Real execution or external API detected/i)).toBeInTheDocument();
  });

  it("no execute/run/deploy/git push wording in commit review section", () => {
    render(
      <ReviewPanel
        busy={false}
        detail={mockCompletedDetail}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onAddValidation={vi.fn()}
        onAddCommitReview={vi.fn()}
      onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    const section = screen.getByText("Safe commit review intake").closest("section")!;
    const text = section.textContent || "";
    expect(text).toMatch(/no git command is run/i);
    expect(text).not.toMatch(/git push/i);
    expect(text).not.toMatch(/execute/i);
    expect(text).not.toMatch(/deploy/i);
    expect(text).not.toMatch(/codex/i);
    expect(text).not.toMatch(/ollama/i);
  });
});



describe("P0.9 evidence bundle export", () => {
  it("renders evidence bundle section", () => {
    render(
      <ReviewPanel
        busy={false}
        detail={mockCompletedDetail}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onAddValidation={vi.fn()}
        onAddCommitReview={vi.fn()}
      onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    expect(screen.getByText("Evidence bundle")).toBeInTheDocument();
  });

  it("renders no-command disclaimer", () => {
    render(
      <ReviewPanel
        busy={false}
        detail={mockCompletedDetail}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onAddValidation={vi.fn()}
        onAddCommitReview={vi.fn()}
      onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    expect(screen.getAllByText(/no command is run/i).length).toBeGreaterThanOrEqual(1);
  });

  it("renders generate evidence bundle button", () => {
    render(
      <ReviewPanel
        busy={false}
        detail={mockCompletedDetail}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onAddValidation={vi.fn()}
        onAddCommitReview={vi.fn()}
      onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /generate evidence bundle/i })).toBeInTheDocument();
  });

  it("generate button is not disabled when task is selected", () => {
    render(
      <ReviewPanel
        busy={false}
        detail={mockCompletedDetail}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onAddValidation={vi.fn()}
        onAddCommitReview={vi.fn()}
      onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    const button = screen.getByRole("button", { name: /generate evidence bundle/i });
    expect(button).not.toBeDisabled();
  });

  it("generate button is disabled when no task selected", () => {
    render(
      <ReviewPanel
        busy={false}
        detail={null}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onAddValidation={vi.fn()}
        onAddCommitReview={vi.fn()}
      onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    const button = screen.getByRole("button", { name: /generate evidence bundle/i });
    expect(button).toBeDisabled();
  });

  it("clears stale bundle when switching to a different task", () => {
    const { rerender } = render(
      <ReviewPanel
        busy={false}
        detail={mockCompletedDetail}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onAddValidation={vi.fn()}
        onAddCommitReview={vi.fn()}
      onPolicyPreviewGenerated={vi.fn()}
      />,
    );

    // Bundle textarea should NOT appear (no generation happened)
    const section = screen.getByText("Evidence bundle").closest("section")!;
    expect(section.querySelector(".evidence-bundle-textarea")).toBeNull();

    // Re-render with a different task
    rerender(
      <ReviewPanel
        busy={false}
        detail={mockAwaitingDetail}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onAddValidation={vi.fn()}
        onAddCommitReview={vi.fn()}
      onPolicyPreviewGenerated={vi.fn()}
      />,
    );

    // Bundle textarea still not present — bundle was cleared on task switch
    const section2 = screen.getByText("Evidence bundle").closest("section")!;
    expect(section2.querySelector(".evidence-bundle-textarea")).toBeNull();
  });

  it("no execute/run/deploy wording in evidence bundle section", () => {
    render(
      <ReviewPanel
        busy={false}
        detail={mockCompletedDetail}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onAddValidation={vi.fn()}
        onAddCommitReview={vi.fn()}
      onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    const section = screen.getByText("Evidence bundle").closest("section")!;
    const text = section.textContent || "";
    expect(text).toMatch(/no command is run/i);
    expect(text).not.toMatch(/\bexecute\b/i);
    expect(text).not.toMatch(/\bdeploy\b/i);
    expect(text).not.toMatch(/\bcodex\b/i);
    expect(text).not.toMatch(/\bollama\b/i);
  });
});


describe("P0.10 runner policy preview", () => {
  it("renders runner policy preview section", () => {
    render(
      <ReviewPanel
        busy={false}
        detail={mockCompletedDetail}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onAddValidation={vi.fn()}
        onAddCommitReview={vi.fn()}
        onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    expect(screen.getByText("Runner policy preview")).toBeInTheDocument();
  });

  it("renders no-command disclaimer", () => {
    render(
      <ReviewPanel
        busy={false}
        detail={mockCompletedDetail}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onAddValidation={vi.fn()}
        onAddCommitReview={vi.fn()}
        onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    expect(screen.getByText(/Policy preview only/i)).toBeInTheDocument();
    expect(screen.getAllByText(/no command is run/i).length).toBeGreaterThanOrEqual(1);
  });

  it("renders preview policy button", () => {
    render(
      <ReviewPanel
        busy={false}
        detail={mockCompletedDetail}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onAddValidation={vi.fn()}
        onAddCommitReview={vi.fn()}
        onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /preview policy/i })).toBeInTheDocument();
  });

  it("renders ALLOWED READ-ONLY verdict badge", () => {
    const withPreview = {
      ...mockCompletedDetail,
      runner_policy_previews: [{
        id: "rpp-001", task_id: "task-001",
        proposed_command: "git status --short",
        proposed_purpose: "check status",
        verdict: "allowed_readonly" as const,
        reasons: ["Exact allowlisted read-only command"],
        created_at: new Date().toISOString(),
      }],
    };
    render(
      <ReviewPanel
        busy={false}
        detail={withPreview}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onAddValidation={vi.fn()}
        onAddCommitReview={vi.fn()}
        onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    expect(screen.getByText(/ALLOWED.*READ-ONLY/i)).toBeInTheDocument();
  });

  it("renders REQUIRES APPROVAL verdict badge", () => {
    const withPreview = {
      ...mockCompletedDetail,
      runner_policy_previews: [{
        id: "rpp-002", task_id: "task-001",
        proposed_command: "npm test",
        proposed_purpose: "run tests",
        verdict: "requires_approval" as const,
        reasons: ["Validation/build command requires explicit human approval"],
        created_at: new Date().toISOString(),
      }],
    };
    render(
      <ReviewPanel
        busy={false}
        detail={withPreview}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onAddValidation={vi.fn()}
        onAddCommitReview={vi.fn()}
        onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    expect(screen.getByText(/REQUIRES APPROVAL/i)).toBeInTheDocument();
  });

  it("renders BLOCKED verdict badge", () => {
    const withPreview = {
      ...mockCompletedDetail,
      runner_policy_previews: [{
        id: "rpp-003", task_id: "task-001",
        proposed_command: "git push",
        proposed_purpose: "push",
        verdict: "blocked" as const,
        reasons: ["git push is blocked — no remote pushes"],
        created_at: new Date().toISOString(),
      }],
    };
    render(
      <ReviewPanel
        busy={false}
        detail={withPreview}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onAddValidation={vi.fn()}
        onAddCommitReview={vi.fn()}
        onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    expect(screen.getByText(/BLOCKED/)).toBeInTheDocument();
  });

  it("renders verdict reasons", () => {
    const withPreview = {
      ...mockCompletedDetail,
      runner_policy_previews: [{
        id: "rpp-004", task_id: "task-001",
        proposed_command: "rm -rf /tmp",
        proposed_purpose: "cleanup",
        verdict: "blocked" as const,
        reasons: ["rm/del is blocked — no file deletion"],
        created_at: new Date().toISOString(),
      }],
    };
    render(
      <ReviewPanel
        busy={false}
        detail={withPreview}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onAddValidation={vi.fn()}
        onAddCommitReview={vi.fn()}
        onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    expect(screen.getByText(/no file deletion/i)).toBeInTheDocument();
  });

  it("no execute/run/deploy wording as executable controls", () => {
    render(
      <ReviewPanel
        busy={false}
        detail={mockCompletedDetail}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onAddValidation={vi.fn()}
        onAddCommitReview={vi.fn()}
        onPolicyPreviewGenerated={vi.fn()}
      />,
    );
    const section = screen.getByText("Runner policy preview").closest("section")!;
    const text = section.textContent || "";
    expect(text).toMatch(/Policy preview only/i);
    expect(text).not.toMatch(/git push/i);
  });
});

});
