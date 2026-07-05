import { AuditLogger } from "./audit/auditLogger.js";
import { config } from "./config.js";
import { createDatabase } from "./db/database.js";
import { MockRunner } from "./runners/mockRunner.js";
import { OperatorService } from "./services/operatorService.js";
import { ensureWorkspace } from "./workspace/pathGuard.js";

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
  return { database, service };
}
