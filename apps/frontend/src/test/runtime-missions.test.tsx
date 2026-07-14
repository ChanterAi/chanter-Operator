import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import * as client from "../api/client";
import type {
  AutoPosterConnectedAccount,
  RuntimeMission,
  RuntimeMissionResult,
  RuntimeMissionStatus,
} from "../api/types";
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
  execution: {
    state: "approval_required",
    executionAttemptId: "attempt-001",
    missionPayloadHash: "a".repeat(64),
    downstreamOperationType: "autoposter.queue.create_unapproved_draft",
    lastConfirmedBoundary: "approval_required",
    recoveryReason: "",
    recoveryClassification: "NONE",
    reconciliationOutcome: "not_started",
    downstreamQueueJobExists: false,
    authoritativeQueueId: null,
    retryCount: 0,
    nextPermittedActions: [],
    evidenceStatus: "pending",
    typedError: null,
  },
  executionJournal: [],
  evidenceSummary: {
    missionId: "mission-001",
    traceId: "trace-001",
    workspaceId: "workspace-a",
    provider: "tiktok",
    canonicalAccountReference: "tiktok:account-a",
    policyDecision: "not_evaluated",
    idempotencyOutcome: "not_applicable",
    queueDraftId: null,
    persistedDraftStatus: null,
    operatorApprovalState: "required",
    releaseApprovalState: "not_started",
    publishingState: "not_started",
    currentDurableState: "approval_required",
    lastConfirmedBoundary: "approval_required",
    recoveryReason: "",
    recoveryClassification: "NONE",
    downstreamQueueJobExists: false,
    authoritativeQueueId: null,
    nextPermittedActions: [],
    evidenceStatus: "pending",
    typedError: null,
  },
};

const youtubeAccount: AutoPosterConnectedAccount = {
  connectedAccountId: "youtube:UC-ExactCase",
  accountId: "UC-ExactCase",
  provider: "youtube",
  providerDisplayName: "YouTube",
  username: "@chanter",
  displayName: "CHANTER",
  connectionStatus: "connected",
  publishingReady: true,
  readinessBlockers: [],
  lastVerifiedAt: "2026-07-14T07:00:00.000Z",
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
  execution: {
    ...pendingMission.execution!,
    state: "completed",
    lastConfirmedBoundary: "completed",
    downstreamQueueJobExists: true,
    authoritativeQueueId: "queue-draft-001",
    evidenceStatus: "authoritative",
  },
  evidenceSummary: {
    ...pendingMission.evidenceSummary,
    policyDecision: "allowed",
    idempotencyOutcome: "first_execution",
    queueDraftId: "queue-draft-001",
    persistedDraftStatus: "scheduled",
    operatorApprovalState: "approved",
    releaseApprovalState: "required",
    publishingState: "blocked_until_human_approval",
    currentDurableState: "completed",
    lastConfirmedBoundary: "completed",
    downstreamQueueJobExists: true,
    authoritativeQueueId: "queue-draft-001",
    evidenceStatus: "authoritative",
  },
};

const recoverableMission: RuntimeMission = {
  ...pendingMission,
  status: "unavailable",
  approvedBy: "founder",
  runtimeResult: {
    ...runtimeResult("unavailable"),
    errors: [{ code: "RECOVERY_DOWNSTREAM_UNAVAILABLE", message: "Downstream truth is uncertain." }],
  },
  execution: {
    ...pendingMission.execution!,
    state: "failed_recoverable",
    lastConfirmedBoundary: "downstream_request_prepared",
    recoveryReason: "Process interruption requires exact downstream reconciliation.",
    recoveryClassification: "RECOVERY_DOWNSTREAM_UNAVAILABLE",
    nextPermittedActions: ["Reconcile", "Stop / escalate"],
    typedError: { code: "RECOVERY_DOWNSTREAM_UNAVAILABLE", message: "Downstream truth is uncertain." },
  },
  evidenceSummary: {
    ...pendingMission.evidenceSummary,
    operatorApprovalState: "approved",
    currentDurableState: "failed_recoverable",
    lastConfirmedBoundary: "downstream_request_prepared",
    recoveryReason: "Process interruption requires exact downstream reconciliation.",
    recoveryClassification: "RECOVERY_DOWNSTREAM_UNAVAILABLE",
    nextPermittedActions: ["Reconcile", "Stop / escalate"],
    typedError: { code: "RECOVERY_DOWNSTREAM_UNAVAILABLE", message: "Downstream truth is uncertain." },
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
    expect(screen.getByRole("button", { name: "Load connected accounts" })).toBeInTheDocument();
    expect(screen.getByLabelText("Connected account")).toBeInTheDocument();
    expect(screen.getByLabelText("Media URL")).toBeInTheDocument();
    expect(screen.getByLabelText("Caption")).toBeInTheDocument();
    expect(screen.getByLabelText("Hashtags")).toBeInTheDocument();
    expect(screen.getByLabelText(/scheduled date\/time.*explicit timezone/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create schedule mission" })).toBeInTheDocument();
  });

  it("shows YouTube metadata fields only when YouTube is selected", async () => {
    const user = userEvent.setup();
    vi.spyOn(client, "listAutoPosterConnectedAccounts").mockResolvedValue({
      ok: true,
      workspaceId: "workspace-a",
      accounts: [youtubeAccount],
      count: 1,
    });
    render(<AutoPosterMissionPanel />);
    await screen.findByText("No AutoPoster schedule missions yet.");

    expect(screen.queryByLabelText("YouTube title")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/YouTube description/i)).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Workspace ID"), "workspace-a");
    await user.click(screen.getByRole("button", { name: "Load connected accounts" }));
    await user.selectOptions(screen.getByLabelText("Connected account"), youtubeAccount.connectedAccountId);
    const selectedAccount = screen.getByLabelText("Selected connected account");
    expect(selectedAccount).toHaveTextContent("YouTube");
    expect(selectedAccount).toHaveTextContent("CHANTER");
    expect(selectedAccount).toHaveTextContent("connected");
    expect(selectedAccount).toHaveTextContent("Ready");
    expect(selectedAccount).toHaveTextContent("UC-ExactCase");
    expect(screen.getByLabelText("YouTube title")).toBeRequired();
    expect(screen.getByLabelText(/YouTube description/i)).toBeInTheDocument();
  });

  it("sends the exact safe schedule payload when creating a mission", async () => {
    const user = userEvent.setup();
    const createSpy = vi
      .spyOn(client, "createAutoPosterScheduleMission")
      .mockResolvedValue({
        ...pendingMission,
        provider: "youtube",
        accountId: youtubeAccount.accountId,
        title: "Launch title",
        description: "Launch description",
      });
    const accountsSpy = vi
      .spyOn(client, "listAutoPosterConnectedAccounts")
      .mockResolvedValue({
        ok: true,
        workspaceId: "workspace-a",
        accounts: [youtubeAccount],
        count: 1,
      });
    render(<AutoPosterMissionPanel />);

    await waitFor(() => expect(screen.getByLabelText("Workspace ID")).not.toBeDisabled());
    await user.type(screen.getByLabelText("Workspace ID"), " workspace-a ");
    await user.click(screen.getByRole("button", { name: "Load connected accounts" }));
    await user.selectOptions(screen.getByLabelText("Connected account"), youtubeAccount.connectedAccountId);
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

    expect(accountsSpy).toHaveBeenCalledWith("workspace-a");
    expect(createSpy).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      accountId: "UC-ExactCase",
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

  it("shows truthful recovery state and enables only bounded reconcile/resume controls", async () => {
    const user = userEvent.setup();
    const reconciledMission: RuntimeMission = {
      ...recoverableMission,
      execution: {
        ...recoverableMission.execution!,
        reconciliationOutcome: "not_found",
        recoveryClassification: "SAFE_RETRY_AVAILABLE",
        nextPermittedActions: ["Reconcile", "Resume safely", "Stop / escalate"],
        typedError: null,
      },
      evidenceSummary: {
        ...recoverableMission.evidenceSummary,
        recoveryClassification: "SAFE_RETRY_AVAILABLE",
        nextPermittedActions: ["Reconcile", "Resume safely", "Stop / escalate"],
        typedError: null,
      },
    };
    vi.mocked(client.listRuntimeMissions).mockResolvedValue([recoverableMission]);
    const reconcileSpy = vi.spyOn(client, "reconcileRuntimeMission").mockResolvedValue(reconciledMission);
    const resumeSpy = vi.spyOn(client, "resumeRuntimeMission").mockResolvedValue(succeededMission);
    render(<AutoPosterMissionPanel />);

    const recovery = (await screen.findByRole("heading", { name: "Recovery supervision" })).parentElement;
    expect(recovery).toHaveTextContent("failed recoverable");
    expect(recovery).toHaveTextContent("downstream request prepared");
    expect(recovery).toHaveTextContent("Process interruption requires exact downstream reconciliation.");
    expect(recovery).toHaveTextContent("Not confirmed");
    expect(screen.queryByRole("button", { name: /^Retry$/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reconcile" }));
    expect(reconcileSpy).toHaveBeenCalledWith("mission-001");
    const resume = await screen.findByRole("button", { name: "Resume safely" });
    await user.click(resume);
    expect(resumeSpy).toHaveBeenCalledWith("mission-001");
    expect((await screen.findAllByText("Draft scheduled")).length).toBeGreaterThan(0);
  });

  it("shows conflict evidence and wires the explicit stop/escalate action", async () => {
    const user = userEvent.setup();
    const conflictMission: RuntimeMission = {
      ...recoverableMission,
      execution: {
        ...recoverableMission.execution!,
        state: "reconciliation_required",
        reconciliationOutcome: "conflict",
        recoveryClassification: "RECONCILIATION_REQUIRED",
        nextPermittedActions: ["Stop / escalate"],
        evidenceStatus: "reconciliation_required",
        typedError: { code: "RECONCILIATION_REQUIRED", message: "Two conflicting queue records exist." },
      },
      evidenceSummary: {
        ...recoverableMission.evidenceSummary,
        currentDurableState: "reconciliation_required",
        recoveryClassification: "RECONCILIATION_REQUIRED",
        nextPermittedActions: ["Stop / escalate"],
        evidenceStatus: "reconciliation_required",
        typedError: { code: "RECONCILIATION_REQUIRED", message: "Two conflicting queue records exist." },
      },
    };
    vi.mocked(client.listRuntimeMissions).mockResolvedValue([conflictMission]);
    const stopped = {
      ...conflictMission,
      execution: { ...conflictMission.execution!, state: "failed_terminal" as const, nextPermittedActions: [] },
    };
    const stopSpy = vi.spyOn(client, "stopRuntimeMission").mockResolvedValue(stopped);
    render(<AutoPosterMissionPanel />);

    expect((await screen.findAllByText("RECONCILIATION_REQUIRED")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Reconcile" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Stop / escalate" }));
    expect(stopSpy).toHaveBeenCalledWith("mission-001");
  });

  it("renders exactly the backend-permitted action for an observed downstream result", async () => {
    const observedMission: RuntimeMission = {
      ...recoverableMission,
      execution: {
        ...recoverableMission.execution!,
        state: "downstream_result_observed",
        reconciliationOutcome: "unique",
        authoritativeQueueId: "queue-observed-1",
        nextPermittedActions: ["Resume safely"],
      },
      evidenceSummary: {
        ...recoverableMission.evidenceSummary,
        currentDurableState: "downstream_result_observed",
        authoritativeQueueId: "queue-observed-1",
        nextPermittedActions: ["Resume safely"],
      },
    };
    vi.mocked(client.listRuntimeMissions).mockResolvedValue([observedMission]);
    vi.spyOn(client, "resumeRuntimeMission").mockResolvedValue(succeededMission);
    render(<AutoPosterMissionPanel />);

    expect(await screen.findByRole("button", { name: "Resume safely" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reconcile" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop / escalate" })).not.toBeInTheDocument();
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
      evidenceSummary: {
        ...succeededMission.evidenceSummary,
        idempotencyOutcome: "duplicate",
      },
    };
    vi.mocked(client.listRuntimeMissions).mockResolvedValue([duplicateMission]);
    render(<AutoPosterMissionPanel />);

    expect(await screen.findByRole("heading", { name: "Existing queue draft" })).toBeInTheDocument();
    expect(screen.getAllByText("queue-draft-001").length).toBeGreaterThan(0);
    expect(screen.getByText(/no second item was created/i)).toBeInTheDocument();
  });

  it.each([
    { id: "must-not-render", accountId: "account-a", provider: "tiktok", status: "scheduled", scheduledAt: "2030-07-15T15:50:00.000Z", approved: true },
    { id: "must-not-render", accountId: "account-a ", provider: "tiktok", status: "scheduled", scheduledAt: "2030-07-15T15:50:00.000Z", approved: false },
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
        evidenceSummary: {
          ...pendingMission.evidenceSummary,
          operatorApprovalState: "approved",
          policyDecision: "allowed",
          typedError: {
            code: `AUTOPOSTER_${status.toUpperCase()}`,
            message: `Downstream result: ${status}.`,
          },
        },
      };
      vi.mocked(client.listRuntimeMissions).mockResolvedValue([failedMission]);
      render(<AutoPosterMissionPanel />);

      expect((await screen.findAllByText(`AUTOPOSTER_${status.toUpperCase()}`)).length).toBeGreaterThan(0);
      expect(screen.queryByRole("heading", { name: /queue draft created|existing queue draft/i })).not.toBeInTheDocument();
      expect(screen.queryByText("Draft scheduled")).not.toBeInTheDocument();
      expect(screen.queryByText("Unapproved for publishing")).not.toBeInTheDocument();
      expect(document.body.textContent).not.toMatch(/\bpublished\b/i);
    },
  );

  it("renders trace identity, runtime decisions, and the redacted evidence summary", async () => {
    vi.mocked(client.listRuntimeMissions).mockResolvedValue([succeededMission]);
    render(<AutoPosterMissionPanel />);

    expect((await screen.findAllByText("mission-001")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("trace-001").length).toBeGreaterThan(0);
    const decisions = screen.getByRole("heading", { name: "Runtime decisions" }).parentElement;
    expect(decisions).toHaveTextContent("PolicyAllowed");
    expect(decisions).toHaveTextContent("Runtime approvalApproved by founder");
    expect(decisions).toHaveTextContent("Idempotencyfirst execution");
    expect(decisions).toHaveTextContent("operator-autoposter:mission-001");
    expect(screen.getByText("autoposter-schedule-created")).toBeInTheDocument();
    expect(screen.getByText(/queue item queue-draft-001 was created and remains unapproved/i)).toBeInTheDocument();
    expect(screen.getByText(/adapter returned an unapproved queue draft/i)).toBeInTheDocument();
    const evidence = screen.getByRole("heading", { name: "Evidence summary" }).parentElement;
    expect(evidence).toHaveTextContent("Canonical accounttiktok:account-a");
    expect(evidence).toHaveTextContent("Queue draft IDqueue-draft-001");
    expect(evidence).toHaveTextContent("Release approvalrequired");
    expect(evidence).toHaveTextContent("Publishingblocked until human approval");
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
