import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgenticPlanJournal } from "../src/agentic/agenticPlanJournal.js";
import { createDatabase } from "../src/db/database.js";

const IDEMPOTENCY_KEY = "atomicity-mission:atomicity-plan:N1";
const ORIGINAL_HASH = "execution-hash-original";
const CHANGED_HASH = "execution-hash-changed";
const NOW = "2026-08-08T00:00:00.000Z";
const LATER = "2026-08-08T00:00:01.000Z";

interface DurableWorkerRow {
  readonly idempotency_key: string;
  readonly execution_hash: string;
  readonly claim_owner: string | null;
  readonly claimed_at: string | null;
  readonly recorded_at: string | null;
}

interface RaceResult {
  readonly outcome: string;
  readonly typedCode?: string | null;
  readonly idempotencyOutcome?: string;
}

let root: string;
let databasePath: string;
let database: ReturnType<typeof createDatabase>;
let journal: AgenticPlanJournal;

function row(): DurableWorkerRow {
  const found = database.prepare(
    `SELECT idempotency_key, execution_hash, claim_owner, claimed_at, recorded_at
       FROM operator_agentic_worker_records
      WHERE idempotency_key = ?`,
  ).get(IDEMPOTENCY_KEY) as DurableWorkerRow | undefined;
  if (!found) throw new Error("Expected one durable worker row.");
  return found;
}

function rowCount(): number {
  const found = database.prepare(
    "SELECT COUNT(*) AS count FROM operator_agentic_worker_records WHERE idempotency_key = ?",
  ).get(IDEMPOTENCY_KEY) as { count: number };
  return Number(found.count);
}

async function runRace(mode: "claim" | "runtime", executionHash = ORIGINAL_HASH): Promise<{
  readonly results: readonly RaceResult[];
  readonly workerExecutions: number;
  readonly externalSideEffects: number;
}> {
  const startBarrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const countersBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3);
  const barrier = new Int32Array(startBarrier);
  const counters = new Int32Array(countersBuffer);
  const results: RaceResult[] = [];
  const workers: Worker[] = [];

  await new Promise<void>((resolve, reject) => {
    let ready = 0;
    let exited = 0;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      if (error) {
        settled = true;
        Atomics.store(counters, 2, 1);
        Atomics.notify(counters, 2);
        for (const worker of workers) void worker.terminate();
        reject(error);
        return;
      }
      if (results.length === 2 && exited === 2) {
        settled = true;
        resolve();
      }
    };
    const timeout = setTimeout(() => {
      finish(new Error(`Timed out waiting for the ${mode} two-connection race.`));
    }, 15_000);

    for (const claimToken of ["contender-a", "contender-b"]) {
      const worker = new Worker(
        new URL("./helpers/agenticWorkerClaimRaceWorker.mjs", import.meta.url),
        {
          workerData: {
            databasePath,
            mode,
            idempotencyKey: IDEMPOTENCY_KEY,
            executionHash,
            claimToken,
            startBarrier,
            counters: countersBuffer,
          },
        },
      );
      workers.push(worker);
      worker.on("message", (message: {
        kind: "ready" | "execution_started" | "result" | "error";
        outcome?: string;
        typedCode?: string | null;
        idempotencyOutcome?: string;
        message?: string;
        stack?: string | null;
      }) => {
        if (message.kind === "ready") {
          ready += 1;
          if (ready === 2) {
            expect(Atomics.load(barrier, 0)).toBe(2);
            Atomics.store(barrier, 1, 1);
            Atomics.notify(barrier, 1, 2);
          }
          return;
        }
        if (message.kind === "error") {
          clearTimeout(timeout);
          finish(new Error(message.stack ?? message.message ?? "Claim-race worker failed."));
          return;
        }
        if (message.kind !== "result" || !message.outcome) return;
        results.push({
          outcome: message.outcome,
          typedCode: message.typedCode,
          idempotencyOutcome: message.idempotencyOutcome,
        });
        if (mode === "runtime" && message.typedCode === "AGENTIC_NODE_EXECUTION_IN_FLIGHT") {
          // The losing connection has classified the committed winner. It is
          // now deterministic and safe to let that winner reach its one tool.
          Atomics.store(counters, 2, 1);
          Atomics.notify(counters, 2);
        }
        finish();
      });
      worker.on("error", (error) => {
        clearTimeout(timeout);
        finish(error);
      });
      worker.on("exit", (code) => {
        exited += 1;
        if (code !== 0 && !settled) {
          clearTimeout(timeout);
          finish(new Error(`Claim-race worker exited with code ${code}.`));
          return;
        }
        finish();
        if (settled) clearTimeout(timeout);
      });
    }
  });

  return {
    results,
    workerExecutions: Atomics.load(counters, 0),
    externalSideEffects: Atomics.load(counters, 1),
  };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "chanter-worker-atomicity-"));
  databasePath = path.join(root, "operator.sqlite");
  database = createDatabase(databasePath);
  journal = new AgenticPlanJournal(database);
});

afterEach(() => {
  database.close();
  rmSync(root, { recursive: true, force: true });
});

describe("Operator durable worker-claim atomicity", () => {
  it("gives exactly one independent connection the absent-row first claim", async () => {
    const raced = await runRace("claim");

    expect(raced.results.map((result) => result.outcome).sort()).toEqual(["claimed", "in_flight"]);
    expect(raced.results.filter((result) => result.outcome === "claimed")).toHaveLength(1);
    expect(rowCount()).toBe(1);
    expect(["contender-a", "contender-b"]).toContain(row().claim_owner);
    expect(row().execution_hash).toBe(ORIGINAL_HASH);
  }, 20_000);

  it("gives exactly one independent connection a released-row reacquisition", async () => {
    const initial = journal.createWorkerRecordStore(() => NOW, () => "initial-owner");
    expect(initial.claim(IDEMPOTENCY_KEY, ORIGINAL_HASH)).toBe("claimed");
    initial.releaseClaim(IDEMPOTENCY_KEY);
    expect(row().claim_owner).toBeNull();

    const raced = await runRace("claim");

    expect(raced.results.map((result) => result.outcome).sort()).toEqual(["claimed", "in_flight"]);
    expect(raced.results.filter((result) => result.outcome === "claimed")).toHaveLength(1);
    expect(rowCount()).toBe(1);
    expect(["contender-a", "contender-b"]).toContain(row().claim_owner);
    expect(row().execution_hash).toBe(ORIGINAL_HASH);
  }, 20_000);

  it("returns binding_mismatch from an independent connection without changing the binding", () => {
    const winner = journal.createWorkerRecordStore(() => NOW, () => "original-owner");
    expect(winner.claim(IDEMPOTENCY_KEY, ORIGINAL_HASH)).toBe("claimed");
    const before = row();

    const secondDatabase = new DatabaseSync(databasePath);
    try {
      const contender = new AgenticPlanJournal(secondDatabase)
        .createWorkerRecordStore(() => LATER, () => "changed-owner");
      expect(contender.claim(IDEMPOTENCY_KEY, CHANGED_HASH)).toBe("binding_mismatch");
    } finally {
      secondDatabase.close();
    }

    expect(row()).toEqual(before);
  });

  it("executes the real Runtime worker and tool only once across two connections", async () => {
    const raced = await runRace("runtime");

    expect(raced.results.map((result) => result.outcome).sort()).toEqual(["succeeded", "unavailable"]);
    expect(raced.results.find((result) => result.outcome === "unavailable")?.typedCode)
      .toBe("AGENTIC_NODE_EXECUTION_IN_FLIGHT");
    expect(raced.workerExecutions).toBe(1);
    expect(raced.externalSideEffects).toBe(1);
    expect(rowCount()).toBe(1);
    expect(row().claim_owner).toBeNull();
    expect(row().recorded_at).not.toBeNull();
  }, 20_000);

  it("prevents a stale recovery actor from releasing a newer claim", () => {
    const first = journal.createWorkerRecordStore(() => NOW, () => "claim-a");
    expect(first.claim(IDEMPOTENCY_KEY, ORIGINAL_HASH)).toBe("claimed");
    const investigated = first.inspectActiveClaim(IDEMPOTENCY_KEY);
    expect(investigated).not.toBeNull();
    first.releaseClaim(IDEMPOTENCY_KEY);

    const second = journal.createWorkerRecordStore(() => LATER, () => "claim-b");
    expect(second.claim(IDEMPOTENCY_KEY, ORIGINAL_HASH)).toBe("claimed");
    const before = row();

    const stale = first.retireOrphanClaim(investigated!);

    expect(stale.retired).toBe(false);
    expect(stale.current).toMatchObject({
      claimOwner: "claim-b",
      claimedAt: LATER,
      executionHash: ORIGINAL_HASH,
      recordedAt: null,
    });
    expect(row()).toEqual(before);
  });
});
