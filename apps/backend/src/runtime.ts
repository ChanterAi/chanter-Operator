import { AuditLogger } from "./audit/auditLogger.js";
import { config } from "./config.js";
import { createDatabase } from "./db/database.js";
import { AutoPosterGraphIntakeService } from "./missions/autoPosterGraphIntake.js";
import { GenericMissionService } from "./missions/genericMissionService.js";
import { MissionGraphChildDispatcher } from "./missions/missionGraphChildDispatcher.js";
import { MissionGraphService } from "./missions/missionGraphService.js";
import { AutoPosterResultProjectionService } from "./missions/autoPosterResultProjectionService.js";
import { AutoPosterObservationService } from "./missions/autoPosterObservationService.js";
import { AutoPosterObservationWorker } from "./missions/autoPosterObservationWorker.js";
import { AutoPosterMissionEvidenceService } from "./missions/autoPosterMissionEvidenceService.js";
import { createLoopGovernorMissionExecutor } from "./missions/loopGovernorRuntime.js";
import { MockRunner } from "./runners/mockRunner.js";
import { AutoPosterMissionService } from "./runtimeMissions/autoPosterMissionService.js";
import { createAutoPosterRuntimeMissionExecutor } from "./runtimeMissions/autoPosterRuntime.js";
import { OperatorService } from "./services/operatorService.js";
import { ensureWorkspace } from "./workspace/pathGuard.js";
import { AgentRunLedgerService } from "./agentRunLedger/agentRunLedgerService.js";
import { SafeCommitCloseoutService } from "./safeCommit/safeCommitCloseoutService.js";
import { PlatformAutoPosterCommandService } from "./platform/platformAutoPosterCommandService.js";
import { OsMissionControlService } from "./os/osMissionControlService.js";
import { AgenticMissionService } from "./agentic/agenticMissionService.js";
import { resolveAgenticAuthorityRevision } from "./agentic/agenticAuthorityRevision.js";

export function createRuntime() {
  const database = createDatabase(config.databasePath);
  const workspaceRoot = ensureWorkspace(config.workspaceRoot);
  const audit = new AuditLogger(config.auditPath);
  const service = new OperatorService(
    database,
    audit,
    new MockRunner(),
    workspaceRoot,
    config.runnerWorkspaceRoot,
  );
  const runtimeMissionExecutor = createAutoPosterRuntimeMissionExecutor({
    ...config.autoPosterRuntime,
    ...(config.approvalAuthority ? { approvalAuthority: config.approvalAuthority } : {}),
  });
  const protectedValues = [
    config.autoPosterRuntime.serviceToken,
    config.missionSubmit.token,
    config.missionControl.token,
    config.safeCommitExecutor.token,
    config.ledgerIngest.token,
  ];
  const agentRunLedgerService = new AgentRunLedgerService(database, protectedValues);
  const runtimeMissionService = new AutoPosterMissionService(
    database,
    runtimeMissionExecutor,
    {
      agentRunLedgerService,
      protectedValues,
    },
  );
  const loopGovernorMissionExecutor = createLoopGovernorMissionExecutor({
    ...config.loopGovernorRuntime,
    ...(config.approvalAuthority ? { approvalAuthority: config.approvalAuthority } : {}),
  });
  const genericMissionService = new GenericMissionService(
    database,
    loopGovernorMissionExecutor,
    {
      agentRunLedgerService,
      protectedValues,
    },
  );
  const missionGraphChildren = new MissionGraphChildDispatcher(
    genericMissionService,
    runtimeMissionService,
  );
  const autoPosterResultService = new AutoPosterResultProjectionService(
    database,
    runtimeMissionExecutor,
  );
  const autoPosterObservationService = new AutoPosterObservationService(
    database,
    autoPosterResultService,
    { policy: config.autoPosterObservation },
  );
  const autoPosterObservationWorker = new AutoPosterObservationWorker(
    autoPosterObservationService,
    config.autoPosterObservationWorker,
  );
  const missionGraphService = new MissionGraphService(database, missionGraphChildren, {
    protectedValues,
    observationScheduler: autoPosterObservationService,
  });
  const autoPosterGraphIntakeService = new AutoPosterGraphIntakeService(
    missionGraphService,
    runtimeMissionService,
    runtimeMissionExecutor,
  );
  const autoPosterMissionEvidenceService = new AutoPosterMissionEvidenceService(
    missionGraphService,
    runtimeMissionService,
    autoPosterResultService,
    autoPosterObservationService,
    runtimeMissionExecutor,
    config.evidenceDir,
    protectedValues,
  );
  const platformAutoPosterCommandService = new PlatformAutoPosterCommandService(
    database,
    missionGraphService,
    runtimeMissionService,
    runtimeMissionExecutor,
    autoPosterMissionEvidenceService,
    { protectedValues },
  );
  const safeCommitCloseoutService = new SafeCommitCloseoutService(database, {
    protectedValues,
  });
  // The governed agentic execution fabric. It shares the same SQLite file as
  // every other authority above, which is what makes "the worker ran" and "the
  // node completed" two rows in one durable store.
  const agenticMissionService = new AgenticMissionService({
    database,
    configuration: {
      paths: {
        repositories: config.agenticFabric.repositories,
        fixtureRoot: config.agenticFabric.fixtureRoot,
        artifactRoot: config.agenticFabric.artifactRoot,
      },
      governor: {
        pythonExecutable: config.loopGovernorRuntime.pythonExecutable,
        governorRoot: config.loopGovernorRuntime.governorRoot,
        timeoutMs: config.loopGovernorRuntime.timeoutMs ?? 30_000,
      },
      approvalTtlMs: config.agenticFabric.approvalTtlMs,
      authorityRevision: resolveAgenticAuthorityRevision(
        config.agenticFabric.authorityRepositoryRoot,
      ),
    },
  });
  // The unified CHANTER OS control plane is composed from the same canonical
  // authorities constructed above — it owns no store of its own, so it is
  // wired last and holds only references.
  const osMissionControlService = new OsMissionControlService({
    genericMissions: genericMissionService,
    autoPosterMissions: runtimeMissionService,
    platformCommands: platformAutoPosterCommandService,
    missionGraphs: missionGraphService,
    loopGovernorExecutor: loopGovernorMissionExecutor,
    autoPosterExecutor: runtimeMissionExecutor,
    agenticMissions: agenticMissionService,
  });
  return {
    database,
    service,
    runtimeMissionService,
    agentRunLedgerService,
    genericMissionService,
    missionGraphService,
    autoPosterGraphIntakeService,
    autoPosterResultService,
    autoPosterObservationService,
    autoPosterObservationWorker,
    autoPosterMissionEvidenceService,
    platformAutoPosterCommandService,
    agenticMissionService,
    osMissionControlService,
    safeCommitCloseoutService,
  };
}
