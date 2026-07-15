// Tests: Phase 2A — Capability-token middleware.
import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import {
  capabilityTokenIsDistinct,
  createCapabilityTokenMiddleware,
} from "../src/middleware/capabilityToken.js";

function makeApp(tokenValue: string, forbiddenTokenValues: readonly string[] = []) {
  const app = express();
  app.use(express.json());
  const middleware = createCapabilityTokenMiddleware({
    tokenEnvVar: "TEST_TOKEN",
    tokenValue,
    endpointLabel: "Test endpoint",
    forbiddenTokenValues,
  });
  app.post("/protected", middleware, (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe("Phase 2A — Capability-token middleware", () => {
  it("returns 503 when token is not configured", async () => {
    const app = makeApp("");
    const res = await request(app).post("/protected").send({});
    assert.equal(res.status, 503);
    assert.equal(res.body.code, "CAPABILITY_TOKEN_NOT_CONFIGURED");
  });

  it("returns 401 when no token is provided", async () => {
    const app = makeApp("secret-token");
    const res = await request(app).post("/protected").send({});
    assert.equal(res.status, 401);
    assert.equal(res.body.code, "CAPABILITY_TOKEN_INVALID");
  });

  it("returns 401 for wrong token", async () => {
    const app = makeApp("secret-token");
    const res = await request(app)
      .post("/protected")
      .set("Authorization", "Bearer wrong-token")
      .send({});
    assert.equal(res.status, 401);
  });

  it("fails closed when a capability value is shared with a forbidden capability", async () => {
    const app = makeApp("shared-token", ["unrelated-token", "shared-token"]);
    const res = await request(app)
      .post("/protected")
      .set("Authorization", "Bearer shared-token")
      .send({});
    assert.equal(res.status, 503);
    assert.equal(res.body.code, "CAPABILITY_TOKEN_CONFIGURATION_INVALID");
    assert.equal(JSON.stringify(res.body).includes("shared-token"), false);
  });

  it("accepts correct token via Bearer header", async () => {
    const app = makeApp("secret-token");
    const res = await request(app)
      .post("/protected")
      .set("Authorization", "Bearer secret-token")
      .send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  it("accepts correct token via x-chanter-capability-token header", async () => {
    const app = makeApp("secret-token");
    const res = await request(app)
      .post("/protected")
      .set("x-chanter-capability-token", "secret-token")
      .send({});
    assert.equal(res.status, 200);
  });

  it("detects collisions for every protected capability role", () => {
    const tokens = {
      submit: "submit-token",
      control: "control-token",
      ledger: "ledger-token",
      runtime: "runtime-token",
    };

    assert.equal(capabilityTokenIsDistinct(tokens.submit, [
      tokens.control,
      tokens.ledger,
      tokens.runtime,
    ]), true);
    assert.equal(capabilityTokenIsDistinct(tokens.ledger, [
      tokens.submit,
      tokens.control,
      tokens.runtime,
    ]), true);

    assert.equal(capabilityTokenIsDistinct(tokens.submit, [
      tokens.control,
      tokens.submit,
      tokens.runtime,
    ]), false);
    assert.equal(capabilityTokenIsDistinct(tokens.ledger, [
      tokens.ledger,
      tokens.control,
      tokens.runtime,
    ]), false);
  });

  it("never returns the token in the response", async () => {
    const app = makeApp("secret-token");
    const res = await request(app)
      .post("/protected")
      .set("Authorization", "Bearer secret-token")
      .send({});
    assert.equal(JSON.stringify(res.body).includes("secret-token"), false);
  });
});
