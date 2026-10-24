/**
 * Runtime narrowing for untrusted JSON boundary values.
 * @packageDocumentation
 */

/** Reject null and arrays when narrowing unknown JSON to an object record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Narrow an unknown boundary value to a record, using an empty record when it is not an object. */
export function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** Normalize an unknown collection to an array before iterating it. */
export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Normalize an unknown failure to the supported caller-facing message. */
export function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
