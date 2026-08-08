import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createAgenticExecutionHash,
  createAgenticWorkerRegistry,
  executeAgenticNode,
  type AgenticNodeCapabilityBinding,
  type AgenticNodeRequest,
  type AgenticNodeWorker,
  type AgenticNodeWorkerRecord,
} from "chanter-agent-runtime";
import { AgenticPlanJournal } from "../src/agentic/agenticPlanJournal.js";
import { createDatabase } from "../src/db/database.js";

const IDEMPOTENCY_KEY = "mission-1:plan-1:N1";
const ORIGINAL_HASH = "execution-hash-original";
const CHANGED_HASH = "execution-hash-changed";
const NOW = "2026-08-08T00:00:00.000Z";

interface DurableWorkerRow {
  readonly idempotency_key: string;
  readonly execution_hash: string;
  readonly claim_owner: string | null;
  readonly claimed_at: string | null;
  readonly recorded_at: string | null;
}

const CAPABILITY: AgenticNodeCapabilityBinding = {
  capabilityId: "durable.binding.verify",
  workerKind: "deterministic_tool",
  riskClass: "read_only",
  verifiability: "deterministic",
  sideEffectClass: "none",
  allowedTools: ["fixture.side-effect"],
  outputSchema: {
    kind: "object",
    fields: { ok: { kind: "boolean" } },
  },
  evidencePolicy: { minimumItems: 0, requireAcceptedContextReference: false },
};

let root: string;
let database: DatabaseSync;
let journal: AgenticPlanJournal;

function readRow(): DurableWorkerRow {
  const row = database.prepare(
    `SELECT idempotency_key, execution_hash, claim_owner, claimed_at, recorded_at
       FROM operator_agentic_worker_records
      WHERE idempotency_key = ?`,
  ).get(IDEMPOTENCY_KEY) as DurableWorkerRow | undefined;
  if (!row) throw new Error("Expected a durable worker row.");
  return row;
}

function completedRecord(): AgenticNodeWorkerRecord {
  return {
    idempotencyKey: IDEMPOTENCY_KEY,
    executionHash: ORIGINAL_HASH,
    capabilityId: CAPABILITY.capabilityId,
    status: "succeeded",
    structuredOutput: { ok: true },
    outputHash: "output-hash",
    evidence: [],
    toolCallRecords: [],
    cost: {
      toolCalls: 0,
      modelCalls: 0,
      tokenCost: null,
      monetaryCostMicros: null,
    },
    latencyMs: 1,
    typedError: null,
    recordedAt: NOW,
  };
}

function request(overrides: Partial<AgenticNodeRequest> = {}): AgenticNodeRequest {
  return {
    identity: {
      missionId: "mission-1",
      planId: "plan-1",
      nodeId: "N1",
      traceId: "trace-1",
    },
    capability: CAPABILITY,
    input: { objective: "verify the durable binding" },
    budget: {
      maxToolCalls: 1,
      maxModelCalls: 0,
      maxDurationMs: 60_000,
      maxTokens: null,
      maxCostMicros: null,
    },
    deadlineAt: "2099-01-01T00:00:00.000Z",
    idempotencyKey: IDEMPOTENCY_KEY,
    acceptedContextIds: [],
    ...overrides,
  };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "chanter-worker-binding-"));
  database = createDatabase(path.join(root, "operator.sqlite"));
  journal = new AgenticPlanJournal(database);
});

afterEach(() => {
  database.close();
  rmSync(root, { recursive: true, force: true });
});

describe("Operator durable AgenticNodeRecordStore execution-hash binding", () => {
  it("returns already_recorded for a completed row with the same execution hash", () => {
    const store = journal.createWorkerRecordStore(() => NOW);
    expect(store.claim(IDEMPOTENCY_KEY, ORIGINAL_HASH)).toBe("claimed");
    store.recordWorkerOutcome(completedRecord());

    expect(store.claim(IDEMPOTENCY_KEY, ORIGINAL_HASH)).toBe("already_recorded");
  });

  it("returns binding_mismatch for a completed row with a changed hash without rewriting it", () => {
    const store = journal.createWorkerRecordStore(() => NOW);
    expect(store.claim(IDEMPOTENCY_KEY, ORIGINAL_HASH)).toBe("claimed");
    store.recordWorkerOutcome(completedRecord());
    const before = readRow();

    expect(store.claim(IDEMPOTENCY_KEY, CHANGED_HASH)).toBe("binding_mismatch");
    expect(readRow()).toEqual(before);
    expect(readRow().execution_hash).toBe(ORIGINAL_HASH);
    expect(readRow().claim_owner).toBeNull();
  });

  it("returns in_flight for an active claim with the same execution hash", () => {
    const store = journal.createWorkerRecordStore(() => NOW);
    expect(store.claim(IDEMPOTENCY_KEY, ORIGINAL_HASH)).toBe("claimed");

    expect(store.claim(IDEMPOTENCY_KEY, ORIGINAL_HASH)).toBe("in_flight");
  });

  it("returns binding_mismatch for an active claim with a changed hash without replacing it", () => {
    const store = journal.createWorkerRecordStore(() => NOW, () => "active-claim-token");
    expect(store.claim(IDEMPOTENCY_KEY, ORIGINAL_HASH)).toBe("claimed");
    const before = readRow();

    expect(store.claim(IDEMPOTENCY_KEY, CHANGED_HASH)).toBe("binding_mismatch");
    expect(readRow()).toEqual(before);
    expect(readRow().execution_hash).toBe(ORIGINAL_HASH);
    expect(readRow().claim_owner).toBe("active-claim-token");
  });

  it("does not rebind a released claim to a changed execution hash", () => {
    const store = journal.createWorkerRecordStore(() => NOW);
    expect(store.claim(IDEMPOTENCY_KEY, ORIGINAL_HASH)).toBe("claimed");
    store.releaseClaim(IDEMPOTENCY_KEY);
    const before = readRow();

    expect(store.claim(IDEMPOTENCY_KEY, CHANGED_HASH)).toBe("binding_mismatch");
    expect(readRow()).toEqual(before);
    expect(readRow().execution_hash).toBe(ORIGINAL_HASH);
    expect(readRow().claim_owner).toBeNull();
  });

  it("makes Runtime reject a changed request against the Operator-backed active claim", async () => {
    const store = journal.createWorkerRecordStore(() => NOW, () => "runtime-claim-token");
    const original = request();
    expect(store.claim(IDEMPOTENCY_KEY, createAgenticExecutionHash(original))).toBe("claimed");
    const before = readRow();
    let workerExecutions = 0;
    let externalSideEffects = 0;
    const worker: AgenticNodeWorker = {
      workerId: "durable-binding-worker",
      capabilityId: CAPABILITY.capabilityId,
      kind: CAPABILITY.workerKind,
      async execute(context) {
        workerExecutions += 1;
        await context.tools.invoke("fixture.side-effect", { attempt: workerExecutions });
        return { ok: true, structuredOutput: { ok: true } };
      },
    };

    const result = await executeAgenticNode(
      request({ budget: { ...original.budget, maxToolCalls: 2 } }),
      {
        workers: createAgenticWorkerRegistry([worker]),
        recordStore: store,
        tools: {
          async invoke() {
            externalSideEffects += 1;
            return { ok: true };
          },
        },
      },
    );

    expect(result.status).toBe("validation_failed");
    expect(result.typedError?.code).toBe("AGENTIC_NODE_IDEMPOTENCY_BINDING_MISMATCH");
    expect(workerExecutions).toBe(0);
    expect(externalSideEffects).toBe(0);
    expect(readRow()).toEqual(before);
    expect(readRow().claim_owner).toBe("runtime-claim-token");
  });
});
