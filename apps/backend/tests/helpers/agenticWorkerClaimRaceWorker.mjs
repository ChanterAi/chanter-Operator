import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

import {
  createAgenticWorkerRegistry,
  executeAgenticNode,
} from "chanter-agent-runtime";
import { register } from "tsx/esm/api";

// Worker threads do not inherit Vitest's transform pipeline. Register tsx
// before loading Operator source so this helper exercises the real TypeScript
// store rather than a copied test implementation.
const unregister = register();
const { AgenticPlanJournal } = await import("../../src/agentic/agenticPlanJournal.ts");

const data = workerData;
const port = parentPort;
if (!port) throw new Error("The claim-race helper requires a parent worker port.");

const CAPABILITY = {
  capabilityId: "durable.atomicity.verify",
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

function runtimeRequest() {
  return {
    identity: {
      missionId: "atomicity-mission",
      planId: "atomicity-plan",
      nodeId: "N1",
      traceId: "atomicity-trace",
    },
    capability: CAPABILITY,
    input: { objective: "prove exactly one execution" },
    budget: {
      maxToolCalls: 1,
      maxModelCalls: 0,
      maxDurationMs: 60_000,
      maxTokens: null,
      maxCostMicros: null,
    },
    deadlineAt: "2099-01-01T00:00:00.000Z",
    idempotencyKey: data.idempotencyKey,
    acceptedContextIds: [],
  };
}

async function run() {
  const database = new DatabaseSync(data.databasePath);
  try {
    database.exec("PRAGMA foreign_keys = ON;");
    const journal = new AgenticPlanJournal(database);
    const store = journal.createWorkerRecordStore(
      () => "2026-08-08T00:00:00.000Z",
      () => data.claimToken,
    );
    const barrier = new Int32Array(data.startBarrier);
    Atomics.add(barrier, 0, 1);
    port.postMessage({ kind: "ready" });
    Atomics.wait(barrier, 1, 0);

    if (data.mode === "claim") {
      const outcome = store.claim(data.idempotencyKey, data.executionHash);
      port.postMessage({ kind: "result", outcome });
      return;
    }

    if (!data.counters) throw new Error("Runtime race counters were not supplied.");
    const counters = new Int32Array(data.counters);
    const worker = {
      workerId: `atomicity-worker-${data.claimToken}`,
      capabilityId: CAPABILITY.capabilityId,
      kind: CAPABILITY.workerKind,
      async execute(context) {
        Atomics.add(counters, 0, 1);
        port.postMessage({ kind: "execution_started" });
        // Hold the winning invocation until the other connection has observed
        // the durable in-flight claim. The parent releases this exact barrier;
        // wall-clock scheduling therefore cannot make the proof pass by luck.
        Atomics.wait(counters, 2, 0);
        await context.tools.invoke("fixture.side-effect", { token: data.claimToken });
        return { ok: true, structuredOutput: { ok: true } };
      },
    };
    const result = await executeAgenticNode(runtimeRequest(), {
      workers: createAgenticWorkerRegistry([worker]),
      recordStore: store,
      tools: {
        async invoke() {
          Atomics.add(counters, 1, 1);
          return { ok: true };
        },
      },
    });
    port.postMessage({
      kind: "result",
      outcome: result.status,
      typedCode: result.typedError?.code ?? null,
      idempotencyOutcome: result.idempotencyOutcome,
    });
  } finally {
    database.close();
  }
}

run().catch((error) => {
  port.postMessage({
    kind: "error",
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : null,
  });
}).finally(async () => {
  await unregister();
});
