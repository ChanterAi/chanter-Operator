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
  const runtimeMissionExecutor = createAutoPosterRuntimeMissionExecutor(
    config.autoPosterRuntime,
  );
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
  const loopGovernorMissionExecutor = createLoopGovernorMissionExecutor(
    config.loopGovernorRuntime,
  );
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
  const safeCommitCloseoutService = new SafeCommitCloseoutService(database, {
    protectedValues,
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
    safeCommitCloseoutService,
  };
}
