/**
 * Real Operator <-> Loop Governor wire-conformance proof.
 *
 * This is intentionally a subprocess-only boundary test. It creates no durable
 * state, performs no network access, and gives neither repository new authority.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  AGENTIC_GOVERNANCE_HOLD_REASONS,
  AGENTIC_PLAN_GOVERNANCE_WIRE_VERSION,
  createAgenticPlanGovernorPort,
  createAgenticPlanDependentsRequest,
  createAgenticPlanGovernanceRequest,
  parseAgenticGovernanceDecision,
  parseAgenticGovernanceDependents,
  type AgenticGovernanceSnapshot,
} from "../../apps/backend/src/agentic/agenticPlanGovernorPort.js";
import { AGENTIC_NODE_STATES } from "../../apps/backend/src/agentic/agenticMissionContract.js";
import { OperatorError } from "../../apps/backend/src/services/operatorService.js";

const operatorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const governorRoot = path.resolve(operatorRoot, "../chanter-loop.governor");
const requestFixturePath = path.join(
  operatorRoot,
  "apps/backend/tests/agentic-plan-governance-request.v1.json",
);
const responseFixturePath = path.join(
  governorRoot,
  "tests/plan_governance_response_v1.json",
);

function fixture(pathname: string): Record<string, unknown> {
  return JSON.parse(readFileSync(pathname, "utf8")) as Record<string, unknown>;
}

function snapshot(): AgenticGovernanceSnapshot {
  return {
    planId: "plan-conformance-1",
    now: "2030-01-01T00:00:00Z",
    maxParallelism: 2,
    planDeadlineAt: "2030-01-01T00:10:00Z",
    costBudgetMicros: 5_000,
    costSpentMicros: 1_000,
    cancellationRequested: false,
    nodes: [
      {
        nodeId: "N1",
        state: "completed",
        dependsOn: [],
        attempts: 1,
        attemptLimit: 1,
        leaseOwner: null,
        leaseExpiresAt: null,
        deadlineAt: null,
      },
      {
        nodeId: "N2",
        state: "ready",
        dependsOn: ["N1"],
        attempts: 0,
        attemptLimit: 2,
        leaseOwner: null,
        leaseExpiresAt: null,
        deadlineAt: null,
      },
      {
        nodeId: "N3",
        state: "ready",
        dependsOn: ["N1"],
        attempts: 0,
        attemptLimit: 2,
        leaseOwner: null,
        leaseExpiresAt: null,
        deadlineAt: null,
      },
    ],
  };
}

function resolvePython(): string {
  const configured = process.env.LOOP_GOVERNOR_PYTHON?.trim();
  if (configured && path.isAbsolute(configured)) return configured;
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [configured || "python"], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(probe.status, 0, probe.stderr || "Unable to locate Python.");
  const found = probe.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && path.isAbsolute(line));
  assert.ok(found, "An absolute Python executable is required for the conformance proof.");
  return found;
}

const pythonExecutable = resolvePython();

function runGovernor(payload: Record<string, unknown>) {
  const completed = spawnSync(pythonExecutable, ["-m", "governor.plan_governance"], {
    cwd: governorRoot,
    input: JSON.stringify(payload),
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  assert.ifError(completed.error);
  assert.ok(completed.stdout.trim(), `Governor returned no JSON. stderr: ${completed.stderr}`);
  return {
    exitCode: completed.status,
    stderr: completed.stderr,
    body: JSON.parse(completed.stdout) as Record<string, unknown>,
  };
}

function assertOperatorCode(action: () => unknown, code: string): void {
  assert.throws(
    action,
    (error: unknown) => error instanceof OperatorError && error.code === code,
    `Expected ${code}.`,
  );
}

describe("Operator <-> Loop Governor plan-governance v1 conformance", () => {
  it("keeps every duplicated node-state and hold-reason enum value in parity", () => {
    const source = [
      "import json",
      "import governor.plan_governance as contract",
      "holds = [value for name, value in vars(contract).items() "
        + "if name.startswith('HOLD_') and isinstance(value, str)]",
      "print(json.dumps({'nodeStates': list(contract.NODE_STATES), 'holdReasons': holds}))",
    ].join("\n");
    const completed = spawnSync(pythonExecutable, ["-c", source], {
      cwd: governorRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.ifError(completed.error);
    assert.equal(completed.status, 0, completed.stderr);
    const governorEnums = JSON.parse(completed.stdout) as {
      nodeStates: string[];
      holdReasons: string[];
    };

    assert.deepEqual(
      [...governorEnums.nodeStates].sort(),
      [...AGENTIC_NODE_STATES].sort(),
      "Operator and Governor node-state vocabularies drifted",
    );
    assert.deepEqual(
      [...governorEnums.holdReasons].sort(),
      [...AGENTIC_GOVERNANCE_HOLD_REASONS].sort(),
      "Operator and Governor hold-reason vocabularies drifted",
    );
  });

  it("accepts the exact Operator request and the Operator accepts the exact Governor response", () => {
    const requestFixture = fixture(requestFixturePath);
    const responseFixture = fixture(responseFixturePath);
    const emitted = createAgenticPlanGovernanceRequest(snapshot());

    assert.equal(JSON.stringify(emitted), JSON.stringify(requestFixture));
    const result = runGovernor(emitted);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(JSON.stringify(result.body), JSON.stringify(responseFixture));
    assert.deepEqual(parseAgenticGovernanceDecision(result.body, snapshot()), {
      admitted: ["N2", "N3"],
      holds: [{ nodeId: "N1", reason: "NODE_TERMINAL", detail: "Node is already completed." }],
      running: [],
      maxParallelism: 2,
      remainingCapacity: 0,
      unreachable: [],
      evaluatedAt: "2030-01-01T00:00:00Z",
    });
  });

  it("the real Governor refuses missing, unsupported, and materially changed v1 requests", () => {
    const missingVersion = structuredClone(createAgenticPlanGovernanceRequest(snapshot()));
    delete missingVersion.schemaVersion;
    const unsupportedVersion = {
      ...createAgenticPlanGovernanceRequest(snapshot()),
      schemaVersion: "chanter.plan-governance.v2",
    };
    const extraField = { ...createAgenticPlanGovernanceRequest(snapshot()), authority: "expanded" };
    const renamedNodeField = structuredClone(createAgenticPlanGovernanceRequest(snapshot()));
    const renamedNodes = renamedNodeField.nodes as Record<string, unknown>[];
    renamedNodes[0]!.tryCount = renamedNodes[0]!.attempts;
    delete renamedNodes[0]!.attempts;

    for (const [payload, expectedCode] of [
      [missingVersion, "PLAN_GOVERNANCE_VERSION_UNSUPPORTED"],
      [unsupportedVersion, "PLAN_GOVERNANCE_VERSION_UNSUPPORTED"],
      [extraField, "PLAN_GOVERNANCE_REQUEST_INVALID"],
      [renamedNodeField, "PLAN_GOVERNANCE_REQUEST_INVALID"],
    ] as const) {
      const result = runGovernor(payload);
      assert.equal(result.exitCode, 2);
      assert.equal(result.body.schemaVersion, AGENTIC_PLAN_GOVERNANCE_WIRE_VERSION);
      assert.equal((result.body.error as Record<string, unknown>).code, expectedCode);
      assert.equal(Object.prototype.hasOwnProperty.call(result.body, "admitted"), false);
    }
  });

  it("Operator refuses unversioned, unsupported, or drifted Governor responses under v1", () => {
    const valid = fixture(responseFixturePath);
    const missingVersion = structuredClone(valid);
    delete missingVersion.schemaVersion;
    const unsupportedVersion = { ...valid, schemaVersion: "chanter.plan-governance.v2" };
    const extraField = { ...valid, policyAuthority: "new" };
    const enumDrift = structuredClone(valid);
    (enumDrift.holds as Record<string, unknown>[])[0]!.reason = "NODE_ALREADY_DONE";

    for (const payload of [missingVersion, unsupportedVersion]) {
      assertOperatorCode(
        () => parseAgenticGovernanceDecision(payload, snapshot()),
        "PLAN_GOVERNANCE_RESPONSE_VERSION_UNSUPPORTED",
      );
    }
    for (const payload of [extraField, enumDrift]) {
      assertOperatorCode(
        () => parseAgenticGovernanceDecision(payload, snapshot()),
        "PLAN_GOVERNANCE_RESPONSE_INVALID",
      );
    }
  });

  it("versions and validates the dependents exchange in both directions", () => {
    const request = createAgenticPlanDependentsRequest(snapshot(), "N1");
    const result = runGovernor(request);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(parseAgenticGovernanceDependents(result.body, snapshot(), "N1"), ["N2", "N3"]);

    assertOperatorCode(
      () => parseAgenticGovernanceDependents({ ...result.body, closureKind: "new" }, snapshot(), "N1"),
      "PLAN_GOVERNANCE_RESPONSE_INVALID",
    );
    assertOperatorCode(
      () => parseAgenticGovernanceDependents({ ...result.body, nodeId: "N2" }, snapshot(), "N1"),
      "PLAN_GOVERNANCE_RESPONSE_INVALID",
    );
  });

  it("never accepts a success envelope from a nonzero Governor process", async () => {
    const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "chanter-governor-exit-"));
    try {
      const packageRoot = path.join(temporaryRoot, "governor");
      mkdirSync(packageRoot);
      writeFileSync(path.join(packageRoot, "__init__.py"), "", "utf8");
      const successBody = JSON.stringify(fixture(responseFixturePath));
      writeFileSync(
        path.join(packageRoot, "plan_governance.py"),
        `import sys\nsys.stdout.write(${JSON.stringify(successBody)})\nsys.exit(7)\n`,
        "utf8",
      );
      const port = createAgenticPlanGovernorPort({
        pythonExecutable,
        governorRoot: temporaryRoot,
        timeoutMs: 10_000,
      });

      for (const call of [
        () => port.govern(snapshot()),
        () => port.dependents(snapshot(), "N1"),
      ]) {
        await assert.rejects(
          call(),
          (error: unknown) =>
            error instanceof OperatorError && error.code === "PLAN_GOVERNANCE_RESPONSE_INVALID",
        );
      }
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
