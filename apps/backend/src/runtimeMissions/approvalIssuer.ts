/**
 * Operator's approval signing identity.
 *
 * Operator is the canonical *issuer* of approvals; the Agent Runtime is the
 * canonical *verifier*. This module is the only place Operator holds private
 * signing material, and it does exactly one thing with it: sign the
 * `observationHash` of an approval the human already decided.
 *
 * The split is deliberate and asymmetric. Operator can issue. The Runtime — and
 * anything else holding the trust store — can verify but cannot forge. No
 * private key is ever written into an approval observation, the approval state
 * directory, evidence, a log line, or an error message.
 */
import { readFileSync } from "node:fs";
import { createPrivateKey, sign as signPayload, type KeyObject } from "node:crypto";
import { isAbsolute } from "node:path";

import {
  APPROVAL_AUTHENTICITY_SCHEME_ED25519,
  approvalAuthenticitySigningMaterial,
  createRuntimeApprovalTrustStore,
  type RuntimeApprovalAuthenticity,
  type RuntimeApprovalTrustedIssuer,
  type RuntimeApprovalTrustStore,
} from "chanter-agent-runtime";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;

export interface OperatorApprovalIssuerConfiguration {
  /** Stable authority identity the Runtime trusts. */
  authorityId: string;
  /** Which key of that authority signs, so rotation stays explicit. */
  keyId: string;
  /**
   * Absolute path to a PKCS#8 Ed25519 private key. A path rather than an inline
   * value so the secret stays in file-permissioned storage and never appears in
   * process environment dumps, config snapshots, or crash reports.
   */
  privateKeyFile: string;
}

export interface OperatorApprovalIssuer {
  readonly authorityId: string;
  readonly keyId: string;
  /** Signs the exact material the Runtime independently re-derives and verifies. */
  authenticityFor(observationHash: string): RuntimeApprovalAuthenticity;
}

export class OperatorApprovalIssuerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OperatorApprovalIssuerError";
    this.code = code;
  }
}

function requireCanonicalIdentifier(value: string, field: string): string {
  const candidate = value.trim();
  if (!candidate || candidate.length > 256 || !IDENTIFIER_PATTERN.test(candidate)) {
    throw new OperatorApprovalIssuerError(
      "OPERATOR_APPROVAL_ISSUER_CONFIGURATION_INVALID",
      `The approval issuer ${field} must be a canonical opaque identifier.`,
    );
  }
  return candidate;
}

function loadPrivateKey(privateKeyFile: string): KeyObject {
  const path = privateKeyFile.trim();
  if (!path || !isAbsolute(path)) {
    throw new OperatorApprovalIssuerError(
      "OPERATOR_APPROVAL_ISSUER_CONFIGURATION_INVALID",
      "The approval issuer signing key must be configured as an absolute file path.",
    );
  }
  let material: string;
  try {
    material = readFileSync(path, "utf8");
  } catch {
    // The path is named; the contents never are.
    throw new OperatorApprovalIssuerError(
      "OPERATOR_APPROVAL_ISSUER_KEY_UNREADABLE",
      "The approval issuer signing key file could not be read.",
    );
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(material);
  } catch {
    throw new OperatorApprovalIssuerError(
      "OPERATOR_APPROVAL_ISSUER_KEY_INVALID",
      "The approval issuer signing key file does not contain a readable private key.",
    );
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new OperatorApprovalIssuerError(
      "OPERATOR_APPROVAL_ISSUER_KEY_INVALID",
      "The approval issuer signing key must be an Ed25519 private key.",
    );
  }
  return key;
}

export function createOperatorApprovalIssuer(
  configuration: OperatorApprovalIssuerConfiguration,
): OperatorApprovalIssuer {
  const authorityId = requireCanonicalIdentifier(configuration.authorityId, "authorityId");
  const keyId = requireCanonicalIdentifier(configuration.keyId, "keyId");
  const privateKey = loadPrivateKey(configuration.privateKeyFile);

  return {
    authorityId,
    keyId,
    authenticityFor(observationHash) {
      const material = Buffer.from(
        approvalAuthenticitySigningMaterial({
          scheme: APPROVAL_AUTHENTICITY_SCHEME_ED25519,
          issuerAuthorityId: authorityId,
          issuerKeyId: keyId,
          observationHash,
        }),
        "utf8",
      );
      return {
        scheme: APPROVAL_AUTHENTICITY_SCHEME_ED25519,
        issuerAuthorityId: authorityId,
        issuerKeyId: keyId,
        signature: signPayload(null, material, privateKey).toString("base64"),
      };
    },
  };
}

/**
 * Loads the Runtime's trusted-issuer configuration from an explicit JSON file.
 *
 * Deliberately *not* derived from the signing key: deriving it would mean
 * "whoever holds a key is trusted", which is trust-on-first-use wearing a
 * cryptographic costume. Trust is a separate, explicit statement.
 */
export function loadOperatorApprovalTrustStore(trustedIssuersFile: string): RuntimeApprovalTrustStore {
  const path = trustedIssuersFile.trim();
  if (!path || !isAbsolute(path)) {
    throw new OperatorApprovalIssuerError(
      "OPERATOR_APPROVAL_TRUST_STORE_CONFIGURATION_INVALID",
      "The trusted approval issuer file must be configured as an absolute file path.",
    );
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new OperatorApprovalIssuerError(
      "OPERATOR_APPROVAL_TRUST_STORE_UNREADABLE",
      "The trusted approval issuer file could not be read.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OperatorApprovalIssuerError(
      "OPERATOR_APPROVAL_TRUST_STORE_CONFIGURATION_INVALID",
      "The trusted approval issuer file is not valid JSON.",
    );
  }
  const issuers = (parsed as { issuers?: unknown })?.issuers;
  if (!Array.isArray(issuers)) {
    throw new OperatorApprovalIssuerError(
      "OPERATOR_APPROVAL_TRUST_STORE_CONFIGURATION_INVALID",
      'The trusted approval issuer file must contain an "issuers" array.',
    );
  }
  // Every remaining shape, duplicate, and key-material rule is the Runtime's to
  // enforce; Operator only transports the file's contents to it.
  return createRuntimeApprovalTrustStore(issuers as readonly RuntimeApprovalTrustedIssuer[]);
}
