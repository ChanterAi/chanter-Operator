import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import * as client from "../api/client";
import type { RuntimeMission, RuntimeMissionResult, RuntimeMissionStatus } from "../api/types";
import { AutoPosterMissionPanel } from "../components/AutoPosterMissionPanel";
import { ReadinessBar } from "../components/ReadinessBar";
import { mockHealthHealthy } from "./fixtures";

const pendingMission: RuntimeMission = {
  missionId: "mission-001",
  traceId: "trace-001",
  product: "auto_poster",
  action: "autoposter.post.schedule",
  actorId: "operator-user",
  workspaceId: "workspace-a",
  accountId: "account-a",
  provider: "tiktok",
  mediaUrl: "https://trusted-media.example/video.mp4",
  caption: "Launch caption",
  hashtags: "#one #two",
  title: null,
  description: null,
  scheduledAt: "2030-07-15T15:50:00.000Z",
  idempotencyKey: "idempotency-001",
  status: "approval_required",
  approvalRequired: true,
  approvedBy: null,
  createdAt: "2026-07-14T08:00:00.000Z",
  updatedAt: "2026-07-14T08:00:00.000Z",
  runtimeResult: null,
};

function runtimeResult(status: RuntimeMissionStatus): RuntimeMissionResult {
  return {
    status,
    output: null,
    evidence: null,
    warnings: [],
    errors: [],
    policyDecision: {
      allowed: true,
      approvalRequired: false,
      blocked: false,
      reasons: [],
    },
    approvalDecision: {
      required: true,
      approved: true,
      approvedBy: "founder",
    },
    idempotency: {
      key: "operator-autoposter:mission-001",
      outcome: "first_execution",
    },
  };
}

const succeededMission: RuntimeMission = {
  ...pendingMission,
  status: "succeeded",
  approvedBy: "founder",
  updatedAt: "2026-07-14T08:01:00.000Z",
  runtimeResult: {
    ...runtimeResult("succeeded"),
    output: {
      duplicate: false,
      post: {
        id: "queue-draft-001",
        accountId: "account-a",
        provider: "tiktok",
        status: "scheduled",
        scheduledAt: "2030-07-15T15:50:00.000Z",
        approved: false,
      },
      publishing: "blocked_until_human_approval",
    },
    evidence: {
      evidence: [
        {
          id: "evidence-001",
          type: "note",
          label: "autoposter-schedule-created",
          detail: "Queue item queue-draft-001 was created and remains unapproved.",
          createdAt: "2026-07-14T08:01:00.000Z",
        },
      ],
      validationResult: {
        passed: true,
        summary: "The AutoPoster adapter returned an unapproved queue draft.",
      },
    },
  },
};

describe("AutoPoster runtime mission panel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(client, "listRuntimeMissions").mockResolvedValue([]);
  });

  it("renders the bounded mission form and every required input", async () => {
    render(<AutoPosterMissionPanel />);

    await screen.findByText("No AutoPoster schedule missions yet.");

    expect(screen.getByRole("heading", { name: /autoposter schedule mission/i })).toBeInTheDocument();
    expect(screen.getByLabelText("Workspace ID")).toBeInTheDocument();
    expect(screen.getByLabelText("Account ID")).toBeInTheDocument();
    expect(screen.getByLabelText("Provider")).toBeInTheDocument();
    expect(screen.getByLabelText("Media URL")).toBeInTheDocument();
    expect(screen.getByLabelText("Caption")).toBeInTheDocument();
    expect(screen.getByLabelText("Hashtags")).toBeInTheDocument();
    expect(screen.getByLabelText(/scheduled date\/time.*explicit timezone/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create schedule mission" })).toBeInTheDocument();
  });

  it("shows YouTube metadata fields only when YouTube is selected", async () => {
    const user = userEvent.setup();
    render(<AutoPosterMissionPanel />);
    await screen.findByText("No AutoPoster schedule missions yet.");
    const provider = screen.getByLabelText("Provider");

    expect(screen.queryByLabelText("YouTube title")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/YouTube description/i)).not.toBeInTheDocument();

    await user.selectOptions(provider, "youtube");
    expect(screen.getByLabelText("YouTube title")).toBeRequired();
    expect(screen.getByLabelText(/YouTube description/i)).toBeInTheDocument();

    await user.selectOptions(provider, "tiktok");
    expect(screen.queryByLabelText("YouTube title")).not.toBeInTheDocument();
  });

  it("sends the exact safe schedule payload when creating a mission", async () => {
    const user = userEvent.setup();
    const createSpy = vi
      .spyOn(client, "createAutoPosterScheduleMission")
      .mockResolvedValue({
        ...pendingMission,
        provider: "youtube",
        accountId: "youtube-account",
        title: "Launch title",
        description: "Launch description",
      });
    render(<AutoPosterMissionPanel />);

    await waitFor(() => expect(screen.getByLabelText("Workspace ID")).not.toBeDisabled());
    await user.type(screen.getByLabelText("Workspace ID"), " workspace-a ");
    await user.type(screen.getByLabelText("Account ID"), "youtube-account");
    await user.selectOptions(screen.getByLabelText("Provider"), "youtube");
    await user.type(screen.getByLabelText("Media URL"), "https://trusted-media.example/video.mp4");
    await user.type(screen.getByLabelText("Caption"), "Launch caption");
    await user.type(screen.getByLabelText("Hashtags"), "#one #two");
    await user.type(screen.getByLabelText("YouTube title"), "Launch title");
    await user.type(screen.getByLabelText(/YouTube description/i), "Launch description");
    await user.type(
      screen.getByLabelText(/scheduled date\/time.*explicit timezone/i),
      "2030-07-15T18:50:00+03:00",
    );
    await user.click(screen.getByRole("button", { name: "Create schedule mission" }));

    expect(createSpy).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      accountId: "youtube-account",
      provider: "youtube",
      mediaUrl: "https://trusted-media.example/video.mp4",
      caption: "Launch caption",
      hashtags: "#one #two",
      title: "Launch title",
      description: "Launch description",
      scheduledAt: "2030-07-15T18:50:00+03:00",
    });
  });

  it("loads a persisted pending mission and displays its exact approval-required summary", async () => {
    vi.mocked(client.listRuntimeMissions).mockResolvedValue([pendingMission]);
    render(<AutoPosterMissionPanel />);

    expect(await screen.findByRole("heading", { name: "Approval required" })).toBeInTheDocument();
    const summary = screen.getByRole("heading", { name: "Requested operation" }).parentElement;
    expect(summary).toHaveTextContent("workspace-a");
    expect(summary).toHaveTextContent("account-a");
    expect(summary).toHaveTextContent("https://trusted-media.example/video.mp4");
    expect(summary).toHaveTextContent("Launch caption");
    expect(summary).toHaveTextContent("#one #two");
    expect(summary).toHaveTextContent("2030-07-15T15:50:00.000Z");
    expect(screen.getByRole("button", { name: "Approve and schedule draft" })).toBeDisabled();
  });

  it("requires an approver and disables the explicit approval action while scheduling", async () => {
    const user = userEvent.setup();
    let resolveApproval: (mission: RuntimeMission) => void = () => undefined;
    const approvalPromise = new Promise<RuntimeMission>((resolve) => {
      resolveApproval = resolve;
    });
    vi.mocked(client.listRuntimeMissions).mockResolvedValue([pendingMission]);
    const approveSpy = vi.spyOn(client, "approveRuntimeMission").mockReturnValue(approvalPromise);
    render(<AutoPosterMissionPanel />);

    const approvedBy = await screen.findByLabelText("Approved by");
    const initialButton = screen.getByRole("button", { name: "Approve and schedule draft" });
    expect(initialButton).toBeDisabled();

    await user.type(approvedBy, "founder");
    expect(initialButton).not.toBeDisabled();
    await user.click(initialButton);

    expect(approveSpy).toHaveBeenCalledWith("mission-001", "founder");
    expect(screen.getByRole("button", { name: "Scheduling draft..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Create schedule mission" })).toBeDisabled();
    expect(screen.getByLabelText("Workspace ID")).toBeDisabled();

    resolveApproval(succeededMission);
    expect(await screen.findByRole("heading", { name: "Queue draft created" })).toBeInTheDocument();
  });

  it("shows only a verified unapproved queue draft for a completed schedule", async () => {
    vi.mocked(client.listRuntimeMissions).mockResolvedValue([succeededMission]);
    render(<AutoPosterMissionPanel />);

    const result = await screen.findByRole("heading", { name: "Queue draft created" });
    const resultSection = result.parentElement;
    expect(resultSection).toHaveTextContent("queue-draft-001");
    expect(resultSection).toHaveTextContent("ApprovedNo");
    expect(resultSection).toHaveTextContent("scheduled");
    expect(document.body.textContent).not.toMatch(/\bpublished\b/i);
  });

  it("shows a duplicate as the existing unapproved queue draft", async () => {
    const duplicateMission: RuntimeMission = {
      ...succeededMission,
      status: "duplicate",
      runtimeResult: {
        ...succeededMission.runtimeResult!,
        status: "duplicate",
        warnings: ["The existing queue draft was returned; no second item was created."],
      },
    };
    vi.mocked(client.listRuntimeMissions).mockResolvedValue([duplicateMission]);
    render(<AutoPosterMissionPanel />);

    expect(await screen.findByRole("heading", { name: "Existing queue draft" })).toBeInTheDocument();
    expect(screen.getByText("queue-draft-001")).toBeInTheDocument();
    expect(screen.getByText(/no second item was created/i)).toBeInTheDocument();
  });

  it.each([
    { id: "must-not-render", accountId: "account-a", provider: "tiktok", status: "scheduled", scheduledAt: "2030-07-15T15:50:00.000Z", approved: true },
    { id: "   ", accountId: "account-a", provider: "tiktok", status: "scheduled", scheduledAt: "2030-07-15T15:50:00.000Z", approved: false },
    { id: "must-not-render", accountId: "account-a", provider: "tiktok", status: "published", scheduledAt: "2030-07-15T15:50:00.000Z", approved: false },
    { id: "must-not-render", accountId: "account-a", provider: "tiktok", status: "scheduled", scheduledAt: "2030-07-16T15:50:00.000Z", approved: false },
    { id: "must-not-render", accountId: "account-a", provider: "youtube", status: "scheduled", scheduledAt: "2030-07-15T15:50:00.000Z", approved: false },
  ])("fails the display gate for an unsafe completed response: $status/$approved", async (post) => {
    const unsafeResultMission: RuntimeMission = {
      ...succeededMission,
      runtimeResult: {
        ...succeededMission.runtimeResult!,
        output: { post },
      },
    };
    vi.mocked(client.listRuntimeMissions).mockResolvedValue([unsafeResultMission]);
    render(<AutoPosterMissionPanel />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be verified as an unapproved queue draft/i);
    expect(screen.queryByText("must-not-render")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /queue draft created|existing queue draft/i })).not.toBeInTheDocument();
    expect(screen.queryByText("Draft scheduled")).not.toBeInTheDocument();
    expect(screen.getAllByText("Runtime response rejected").length).toBeGreaterThan(0);
  });

  it.each<RuntimeMissionStatus>(["denied", "unavailable", "validation_failed", "failed"])(
    "renders %s truthfully without draft-completion language",
    async (status) => {
      const failedMission: RuntimeMission = {
        ...pendingMission,
        status,
        approvedBy: "founder",
        runtimeResult: {
          ...runtimeResult(status),
          errors: [{ code: `AUTOPOSTER_${status.toUpperCase()}`, message: `Downstream result: ${status}.` }],
        },
      };
      vi.mocked(client.listRuntimeMissions).mockResolvedValue([failedMission]);
      render(<AutoPosterMissionPanel />);

      expect(await screen.findByText(`AUTOPOSTER_${status.toUpperCase()}`)).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: /queue draft created|existing queue draft/i })).not.toBeInTheDocument();
      expect(screen.queryByText("Draft scheduled")).not.toBeInTheDocument();
      expect(screen.queryByText("Unapproved for publishing")).not.toBeInTheDocument();
      expect(document.body.textContent).not.toMatch(/\bpublished\b/i);
    },
  );

  it("renders trace identity, runtime decisions, and the redacted evidence summary", async () => {
    vi.mocked(client.listRuntimeMissions).mockResolvedValue([succeededMission]);
    render(<AutoPosterMissionPanel />);

    expect(await screen.findByText("mission-001")).toBeInTheDocument();
    expect(screen.getByText("trace-001")).toBeInTheDocument();
    const decisions = screen.getByRole("heading", { name: "Runtime decisions" }).parentElement;
    expect(decisions).toHaveTextContent("PolicyAllowed");
    expect(decisions).toHaveTextContent("Runtime approvalApproved by founder");
    expect(decisions).toHaveTextContent("Idempotencyfirst execution");
    expect(decisions).toHaveTextContent("operator-autoposter:mission-001");
    expect(screen.getByText("autoposter-schedule-created")).toBeInTheDocument();
    expect(screen.getByText(/queue item queue-draft-001 was created and remains unapproved/i)).toBeInTheDocument();
    expect(screen.getByText(/adapter returned an unapproved queue draft/i)).toBeInTheDocument();
  });

  it("exposes no token, credential, or secret input", async () => {
    render(<AutoPosterMissionPanel />);

    await screen.findByText("No AutoPoster schedule missions yet.");

    expect(screen.queryByLabelText(/token/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/credential/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/secret/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/api key/i)).not.toBeInTheDocument();
  });

  it("reports bounded AutoPoster readiness separately from the generic mock runner", () => {
    render(<ReadinessBar state={{ kind: "healthy", health: mockHealthHealthy }} />);
    const readiness = screen.getByRole("status");

    expect(within(readiness).getByText("AutoPoster drafts")).toBeInTheDocument();
    expect(within(readiness).getByText("Configured")).toBeInTheDocument();
    expect(within(readiness).getByText("Publishing")).toBeInTheDocument();
    expect(within(readiness).getByText("Disabled")).toBeInTheDocument();
    expect(within(readiness).getByText("Mock-only")).toBeInTheDocument();
  });

  it("opens from a third tab without replacing the existing cockpit", async () => {
    const user = userEvent.setup();
    vi.spyOn(client, "fetchHealth").mockResolvedValue(mockHealthHealthy);
    vi.spyOn(client, "listTasks").mockResolvedValue([]);
    render(<App />);

    expect(screen.getByRole("heading", { name: "Queue" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "AutoPoster Mission" }));
    expect(screen.getByRole("heading", { name: /autoposter schedule mission/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cockpit" })).toBeInTheDocument();
  });
});
