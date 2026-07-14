import express, { type ErrorRequestHandler } from "express";
import { AuditStorageError } from "./audit/auditLogger.js";
import type { OperatorService } from "./services/operatorService.js";
import { OperatorError } from "./services/operatorService.js";
import { createApiRouter } from "./routes/api.js";
import type { AutoPosterMissionService } from "./runtimeMissions/autoPosterMissionService.js";

export function createApp(
  service: OperatorService,
  runtimeMissionService?: AutoPosterMissionService,
) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));
  app.use("/api", createApiRouter(service, runtimeMissionService));

  app.use((_request, response) => {
    response.status(404).json({ error: "Route was not found." });
  });

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error instanceof OperatorError) {
      response.status(error.statusCode).json({ error: error.message });
      return;
    }
    if (error instanceof SyntaxError) {
      response.status(400).json({ error: "Request body must contain valid JSON." });
      return;
    }
    if (error instanceof AuditStorageError) {
      console.error("Operator audit storage failed", error);
      response.status(503).json({
        error: "Audit storage is unavailable. State changes are disabled until it is repaired.",
      });
      return;
    }
    console.error("Operator request failed", error);
    response.status(500).json({ error: "The local operator could not complete the request." });
  };
  app.use(errorHandler);
  return app;
}
