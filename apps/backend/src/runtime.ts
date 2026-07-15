import { AuditLogger } from "./audit/auditLogger.js";
import { config } from "./config.js";
import { createDatabase } from "./db/database.js";
import { MockRunner } from "./runners/mockRunner.js";
import { AutoPosterMissionService } from "./runtimeMissions/autoPosterMissionService.js";
import { createAutoPosterRuntimeMissionExecutor } from "./runtimeMissions/autoPosterRuntime.js";
import { OperatorService } from "./services/operatorService.js";
import { ensureWorkspace } from "./workspace/pathGuard.js";
import { AgentRunLedgerService } from "./agentRunLedger/agentRunLedgerService.js";

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
  return { database, service, runtimeMissionService, agentRunLedgerService };
}
