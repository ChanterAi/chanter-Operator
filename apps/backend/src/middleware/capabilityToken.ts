/**
 * Capability-token middleware for Operator write endpoints.
 *
 * Fail-closed: if the expected token is not configured, write endpoints
 * return 503. Constant-time comparison avoids timing oracles. Tokens are
 * never logged or returned in responses.
 */
import type { Request, Response, NextFunction } from "express";

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function capabilityTokenIsDistinct(
  tokenValue: string,
  otherTokenValues: readonly string[] = [],
): boolean {
  return Boolean(tokenValue) && !otherTokenValues.some(
    (otherTokenValue) => Boolean(otherTokenValue) && constantTimeEqual(tokenValue, otherTokenValue),
  );
}

export function createCapabilityTokenMiddleware(options: {
  tokenEnvVar: string;
  tokenValue: string;
  endpointLabel: string;
  forbiddenTokenValues?: readonly string[];
}): (req: Request, res: Response, next: NextFunction) => void {
  const { tokenValue, endpointLabel } = options;

  return (req, res, next) => {
    if (!tokenValue) {
      res.status(503).json({
        error: `${endpointLabel} is not configured. Set ${options.tokenEnvVar} to enable it.`,
        code: "CAPABILITY_TOKEN_NOT_CONFIGURED",
      });
      return;
    }

    if (!capabilityTokenIsDistinct(tokenValue, options.forbiddenTokenValues)) {
      res.status(503).json({
        error: `${endpointLabel} capability configuration is invalid. Configure a distinct token.`,
        code: "CAPABILITY_TOKEN_CONFIGURATION_INVALID",
      });
      return;
    }

    const authHeader = String(req.headers["authorization"] ?? "");
    const xToken = String(req.headers["x-chanter-capability-token"] ?? "");

    let providedToken = "";
    if (authHeader.startsWith("Bearer ")) {
      providedToken = authHeader.slice(7).trim();
    } else if (xToken) {
      providedToken = xToken.trim();
    }

    if (!providedToken || !constantTimeEqual(providedToken, tokenValue)) {
      res.status(401).json({
        error: `${endpointLabel} requires a valid capability token.`,
        code: "CAPABILITY_TOKEN_INVALID",
      });
      return;
    }

    next();
  };
}
