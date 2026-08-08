import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./tests/setup.ts"],
    /**
     * Persisted approval authority makes every approval-required mission run
     * two real read-only Git inspections of the approval-bound checkout, so a
     * test that drives several approved missions legitimately exceeds the 5s
     * default. Kept bounded so a genuine hang still fails.
     */
    testTimeout: 60_000,
    hookTimeout: 60_000,
    /**
     * Those inspections are synchronous `git` child processes. Under the
     * default forked-process pool their combined load starved Vitest's own
     * reporter RPC, so a fully passing run still ended with two
     * `Timeout calling "onTaskUpdate"` unhandled errors and exit code 1. The
     * worker-thread pool keeps the same parallelism and reports truthfully.
     */
    pool: "threads",
  },
});
