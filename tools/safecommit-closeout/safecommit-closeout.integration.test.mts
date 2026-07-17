import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { CloseoutEngine } from "../../../../tools/safecommit/lib/closeout-engine.mjs";
import { OperatorClient } from "../../../../tools/safecommit/lib/operator-client.mjs";
import {
  ProcessRunner,
  ValidationRegistry,
} from "../../../../tools/safecommit/lib/process-runner.mjs";
import { StateStore } from "../../../../tools/safecommit/lib/state-store.mjs";
import {
  buildManifest,
  createFixtureWorkspace,
  FIXED_TIME,
  gitExecutable,
  gitText,
  readEvidence,
} from "../../../../tools/safecommit/tests/helpers/fixtures.mjs";

const SUBMIT_TOKEN = "operator-safecommit-e2e-submit-capability";
const CONTROL_TOKEN = "operator-safecommit-e2e-control-capability";
const EXECUTOR_TOKEN = "operator-safecommit-e2e-executor-capability";
const LEDGER_TOKEN = "operator-safecommit-e2e-ledger-capability";
const AUTOPOSTER_TOKEN = "operator-safecommit-e2e-autoposter-capability";
const APPROVAL_BASIS = "founder_reviewed_exact_plan_and_repository_preflight";

const TOKEN_ENVIRONMENT = {
  OPERATOR_MISSION_SUBMIT_TOKEN: SUBMIT_TOKEN,
  OPERATOR_CONTROL_TOKEN: CONTROL_TOKEN,
  OPERATOR_SAFECOMMIT_EXECUTOR_TOKEN: EXECUTOR_TOKEN,
  OPERATOR_LEDGER_INGEST_TOKEN: LEDGER_TOKEN,
  AUTOPOSTER_RUNTIME_TOKEN: AUTOPOSTER_TOKEN,
};

function invocationCounts(invocations: Array<{ args: readonly string[] }>) {
  const subcommand = (args: readonly string[]) => {
    let index = 0;
    while (index < args.length) {
      if (args[index] === "-c") {
        index += 2;
        continue;
      }
      if (args[index].startsWith("-")) {
        index += 1;
        continue;
      }
      return args[index];
    }
    return null;
  };
  return {
    validations: invocations.filter(({ args }) =>
      subcommand(args) === "diff" && args.includes("--check")).length,
    commits: invocations.filter(({ args }) => subcommand(args) === "commit").length,
    pushes: invocations.filter(({ args }) => subcommand(args) === "push").length,
  };
}

class FixtureProcessRunner extends ProcessRunner {
  constructor(private readonly isolatedGlobalConfig: string) {
    super({ maxOutputBytes: 262_144 });
  }

  override run(specification: any) {
    return super.run({
      ...specification,
      env: {
        ...specification.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: this.isolatedGlobalConfig,
      },
    });
  }
}

async function approveExactPlan(
  baseUrl: string,
  requestId: string,
  planHash: string,
) {
  const response = await fetch(
    `${baseUrl}/api/safecommit-closeouts/${encodeURIComponent(requestId)}/approve`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${CONTROL_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        planHash,
        approvedBy: "founder-e2e-control",
        approvalBasis: APPROVAL_BASIS,
        approvalNote: "Reviewed the exact immutable two-repository closeout plan.",
      }),
    },
  );
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload;
}

async function closeServer(server: any) {
  if (!server?.listening) return;
  server.closeIdleConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((error: Error | undefined) => error ? reject(error) : resolve());
  });
}

test("real Operator HTTP authority governs an exact two-repository SafeCommit closeout", async (t) => {
  const previousEnvironment = new Map(
    Object.keys(TOKEN_ENVIRONMENT).map((key) => [key, process.env[key]]),
  );
  for (const [key, value] of Object.entries(TOKEN_ENVIRONMENT)) process.env[key] = value;

  let server: any;
  let database: any;
  try {
    const [
      { createApp },
      { AuditLogger },
      { createDatabase },
      { MockRunner },
      { SafeCommitCloseoutService },
      { OperatorService },
      { ensureWorkspace },
    ] = await Promise.all([
      import("../../apps/backend/src/app.ts"),
      import("../../apps/backend/src/audit/auditLogger.ts"),
      import("../../apps/backend/src/db/database.ts"),
      import("../../apps/backend/src/runners/mockRunner.ts"),
      import("../../apps/backend/src/safeCommit/safeCommitCloseoutService.ts"),
      import("../../apps/backend/src/services/operatorService.ts"),
      import("../../apps/backend/src/workspace/pathGuard.ts"),
    ]);

    // Operator config has captured its capabilities. Remove every capability
    // from the shared process before constructing SafeCommit so the engine has
    // no ambient founder-control authority.
    for (const key of Object.keys(TOKEN_ENVIRONMENT)) delete process.env[key];
    assert.equal(process.env.OPERATOR_CONTROL_TOKEN, undefined);

    const fixture = createFixtureWorkspace(t);
    const planId = "operator-safecommit-cross-repo-e2e";
    const manifest = buildManifest(fixture, { planId });
    assert.equal(fixture.repositories.length, 2);
    assert.equal(new Set(fixture.repositories.map((repo) => repo.branch)).size, 2);
    assert.equal(new Set(manifest.repositories.map((repo) => repo.commitMessage)).size, 2);

    database = createDatabase(path.join(fixture.root, "operator.sqlite"));
    const operatorService = new OperatorService(
      database,
      new AuditLogger(path.join(fixture.root, "operator-audit.jsonl")),
      new MockRunner(),
      ensureWorkspace(path.join(fixture.root, "operator-workspace")),
    );
    const closeoutService = new SafeCommitCloseoutService(database, {
      now: () => new Date(FIXED_TIME),
      protectedValues: Object.values(TOKEN_ENVIRONMENT),
    });
    const app = createApp(
      operatorService,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      closeoutService,
    );
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const operatorClient = new OperatorClient({
      baseUrl,
      submitToken: SUBMIT_TOKEN,
      executorToken: EXECUTOR_TOKEN,
    });
    assert.equal(typeof (operatorClient as any).approve, "undefined");
    assert.equal(Object.hasOwn(operatorClient, "controlToken"), false);

    const stateStore = new StateStore(fixture.stateDirectory, {
      now: () => FIXED_TIME,
    });
    // Temporary repositories must not inherit host-level Git-for-Windows
    // textconv/LFS commands. Production preflight remains unchanged; this
    // fixture runner supplies an explicit empty Git config for child processes.
    const isolatedGlobalConfig = path.join(fixture.root, "isolated-gitconfig");
    writeFileSync(isolatedGlobalConfig, "", "utf8");
    const runner = new FixtureProcessRunner(isolatedGlobalConfig);
    const engine = new CloseoutEngine({
      stateStore,
      runner,
      validationRegistry: new ValidationRegistry({ npmCli: process.execPath }),
      operatorClient,
      gitExecutable,
      now: () => FIXED_TIME,
    });

    const compiled = engine.compile(manifest);
    assert.equal(compiled.replayed, false);
    assert.match(compiled.planHash, /^[0-9a-f]{64}$/);

    const submitted = await engine.submit(planId);
    assert.equal(submitted.status, "approval_required");
    assert.equal(submitted.planHash, compiled.planHash);

    const approved = await approveExactPlan(
      baseUrl,
      manifest.operatorRequest.requestId,
      compiled.planHash,
    );
    assert.equal(approved.status, "approved");
    assert.equal(approved.approvalEvidence.planHash, compiled.planHash);
    assert.equal(approved.approvalEvidence.approvalBasis, APPROVAL_BASIS);

    const completed = await engine.execute(planId);
    assert.equal(completed.replayed, false);
    assert.equal(completed.evidence.status, "completed");
    assert.equal(completed.evidence.repositories.length, 2);

    const completedStatus = await engine.status(planId);
    assert.equal(completedStatus.status, "completed");
    assert.deepEqual(
      completedStatus.events.map((event: { eventType: string }) => event.eventType),
      [
        "closeout_approval_requested",
        "closeout_approved",
        "closeout_execution_claimed",
        "closeout_completed",
      ],
    );
    assert.equal(
      completedStatus.claim.claimedBy,
      completed.evidence.executionId,
    );
    assert.equal(
      completedStatus.closeoutEvidence.digest,
      completed.evidenceDigest,
    );

    const expectedById = new Map(
      manifest.repositories.map((repository) => [repository.id, repository]),
    );
    const evidenceById = new Map(
      completed.evidence.repositories.map((repository: { repositoryId: string }) =>
        [repository.repositoryId, repository]),
    );
    const headsBeforeReplay = new Map<string, string>();
    for (const repository of fixture.repositories) {
      const expected = expectedById.get(repository.id)!;
      const evidence: any = evidenceById.get(repository.id);
      const localHead = gitText(repository.repositoryPath, ["rev-parse", "HEAD"]);
      const remoteHead = gitText(repository.remotePath, [
        "rev-parse",
        `refs/heads/${repository.branch}`,
      ]);
      headsBeforeReplay.set(repository.id, localHead);
      assert.equal(localHead, remoteHead);
      assert.equal(gitText(repository.repositoryPath, ["status", "--porcelain=v1"]), "");
      assert.equal(
        gitText(repository.repositoryPath, ["rev-list", "--count", `${repository.baselineHead}..HEAD`]),
        "1",
      );
      assert.equal(gitText(repository.repositoryPath, ["log", "-1", "--format=%B"]), expected.commitMessage);
      assert.equal(evidence.branch, repository.branch);
      assert.equal(evidence.commitMessage, expected.commitMessage);
      assert.equal(evidence.localHead, localHead);
      assert.equal(evidence.remoteHead, remoteHead);
      assert.equal(evidence.clean, true);
      assert.equal(evidence.outcome, "verified");
    }

    const countsBeforeReplay = invocationCounts(runner.invocations);
    const invocationsBeforeReplay = runner.invocations.length;
    const journalBeforeReplay = stateStore.readJournal(planId);
    assert(countsBeforeReplay.validations > 0);
    assert.equal(countsBeforeReplay.commits, 2);
    assert.equal(countsBeforeReplay.pushes, 2);

    const replayed = await engine.execute(planId);
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.evidenceDigest, completed.evidenceDigest);
    assert.deepEqual(invocationCounts(runner.invocations), countsBeforeReplay);
    assert.equal(runner.invocations.length, invocationsBeforeReplay);
    assert.deepEqual(stateStore.readJournal(planId), journalBeforeReplay);

    const replayedStatus = await engine.status(planId);
    assert.equal(replayedStatus.status, "completed");
    assert.equal(replayedStatus.events.length, completedStatus.events.length);
    for (const repository of fixture.repositories) {
      assert.equal(
        gitText(repository.repositoryPath, ["rev-parse", "HEAD"]),
        headsBeforeReplay.get(repository.id),
      );
      assert.equal(
        gitText(repository.remotePath, ["rev-parse", `refs/heads/${repository.branch}`]),
        headsBeforeReplay.get(repository.id),
      );
    }

    const planDirectory = path.join(fixture.stateDirectory, "plans", planId);
    const persistedOperatorTruth = {
      closeout: database.prepare(
        "SELECT * FROM operator_safecommit_closeouts WHERE request_id = ?",
      ).get(manifest.operatorRequest.requestId),
      events: database.prepare(
        "SELECT * FROM operator_safecommit_closeout_events WHERE request_id = ? ORDER BY sequence",
      ).all(manifest.operatorRequest.requestId),
    };
    const durableEvidence = [
      readEvidence(fixture.stateDirectory, planId),
      readFileSync(path.join(planDirectory, "evidence.md"), "utf8"),
      readFileSync(path.join(planDirectory, "plan.json"), "utf8"),
      readFileSync(path.join(planDirectory, "journal.jsonl"), "utf8"),
      JSON.stringify(persistedOperatorTruth),
      JSON.stringify(replayedStatus),
    ].join("\n");
    for (const token of Object.values(TOKEN_ENVIRONMENT)) {
      assert.equal(durableEvidence.includes(token), false);
    }
  } finally {
    await closeServer(server);
    database?.close();
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
