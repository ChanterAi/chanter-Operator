import { createApp } from "./app.js";
import { config } from "./config.js";
import { createRuntime } from "./runtime.js";

const {
  database,
  service,
  runtimeMissionService,
  agentRunLedgerService,
  genericMissionService,
  missionGraphService,
  autoPosterResultService,
  autoPosterObservationService,
  safeCommitCloseoutService,
} = createRuntime();
const app = createApp(
  service,
  runtimeMissionService,
  agentRunLedgerService,
  genericMissionService,
  missionGraphService,
  autoPosterResultService,
  autoPosterObservationService,
  safeCommitCloseoutService,
);
const server = app.listen(config.port, config.host, () => {
  console.log("CHANTER Operator backend: http://" + config.host + ":" + config.port);
  console.log("Runner mode: mock (task workflow) + read-only local runner" + (config.runnerWorkspaceRoot ? "" : " (disabled)"));
  if (config.runnerWorkspaceRoot) {
    console.log("Read-only runner workspace: " + config.runnerWorkspaceRoot);
    console.log("Read-only runner: git status --short, git diff --stat, git diff --check, git show --stat --oneline HEAD, git show --name-only HEAD");
  }
  console.log(
    "AutoPoster runtime missions: " +
      (runtimeMissionService.getReadiness().configured
        ? "configured (unapproved schedule drafts only)"
        : "unconfigured"),
  );
});

function shutdown() {
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
