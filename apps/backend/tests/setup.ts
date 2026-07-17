// Vitest setup: configure test capability tokens for Phase 2A middleware.
// These tokens are only for local test runs; production requires real env vars.
process.env.OPERATOR_MISSION_SUBMIT_TOKEN = "test-mission-submit-token";
process.env.OPERATOR_CONTROL_TOKEN = "test-operator-control-token";
process.env.OPERATOR_SAFECOMMIT_EXECUTOR_TOKEN = "test-safecommit-executor-token";
process.env.OPERATOR_LEDGER_INGEST_TOKEN = "test-ledger-ingest-token";
