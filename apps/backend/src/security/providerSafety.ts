export const OPERATOR_PROVIDER_MATERIAL_CODE = "OPERATOR_PROVIDER_MATERIAL_REJECTED";
export const OPERATOR_PROVIDER_MATERIAL_MESSAGE = "Provider-derived diagnostic material was rejected by the safety boundary.";

const FORBIDDEN_KEY = /(?:access|refresh|oauth|bearer|authorization|credential|secret|token|session.?locator|upload.?locator|raw.?response|raw.?body|raw.?payload)/i;
const FORBIDDEN_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]+|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b|https?:\/\/[^\s"']*(?:upload_id=|upload[-_/]?session|resumable|upload\.youtube\.com)/i;

function stringVariants(value: string): string[] {
  const variants = new Set([value]);
  try { variants.add(decodeURIComponent(value)); } catch { /* invalid encoding is not decoded */ }
  if (/^[A-Za-z0-9+/=_-]{16,}$/.test(value)) {
    try { variants.add(Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")); } catch { /* invalid base64 */ }
  }
  return [...variants];
}

export function findForbiddenProviderMaterial(
  value: unknown,
  protectedValues: readonly string[] = [],
  seen = new Set<object>(),
): boolean {
  if (typeof value === "string") {
    return stringVariants(value).some((variant) =>
      FORBIDDEN_VALUE.test(variant)
      || protectedValues.some((protectedValue) => protectedValue && variant.includes(protectedValue)));
  }
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => findForbiddenProviderMaterial(item, protectedValues, seen));
  return Object.entries(value).some(([key, item]) => {
    const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
    return (!normalized.endsWith("fencingtoken") && normalized !== "secretsredacted" && FORBIDDEN_KEY.test(key))
      || findForbiddenProviderMaterial(item, protectedValues, seen);
  });
}
