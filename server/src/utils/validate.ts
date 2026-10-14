import { badRequest } from "./http";

/**
 * Read a bounded, single-line string field from a request payload.
 *
 * This mirrors the PHP `data_string()` helper exactly so validation errors
 * and accepted values stay identical:
 *   - absent / null / array / object / boolean -> ""
 *   - trimmed
 *   - invalid UTF-8 -> 400
 *   - C0 control chars (including tab/CR/LF) + DEL -> 400
 *   - longer than maxLen characters -> 400
 */
export function dataString(
  source: Record<string, unknown>,
  key: string,
  maxLen: number
): string {
  if (!Object.prototype.hasOwnProperty.call(source, key)) return "";

  const raw = source[key];
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "boolean" || typeof raw === "object") return "";

  const value = String(raw).trim();
  if (value === "") return "";

  // Reject malformed UTF-8: encode/decode round trip must be stable and the
  // string must not contain the replacement character from a decode failure.
  if (value.includes("\uFFFD")) {
    throw badRequest(`Field '${key}' is not valid UTF-8`);
  }

  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(value)) {
    throw badRequest(`Field '${key}' contains invalid control characters`);
  }

  // Count characters, not bytes.
  const length = [...value].length;
  if (length > maxLen) {
    throw badRequest(`Field '${key}' must be ${maxLen} characters or fewer`);
  }

  return value;
}

/** True when the string looks like an email address. */
export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
