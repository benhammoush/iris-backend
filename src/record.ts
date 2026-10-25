/**
 * Runtime narrowing for untrusted JSON boundary values.
 * @packageDocumentation
 */

/** Reject null and arrays when narrowing unknown JSON to an object record.
 * @param value - Unknown boundary value.
 * @returns Whether it is a non-null, non-array object record.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Narrow an unknown boundary value to a record, using an empty record when it is not an object.
 * @param value - Unknown boundary value.
 * @returns The object record, or an empty record for unsupported shapes.
 */
export function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** Normalize an unknown collection to an array before iterating it.
 * @param value - Unknown collection field.
 * @returns Its unknown elements when it is an array, or an empty collection.
 */
export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Normalize an unknown failure to the supported caller-facing message.
 * @param value - Unknown failure, possibly not an Error instance.
 * @returns Its Error message, primitive text or a controlled unknown-failure label.
 */
export function errorMessage(value: unknown): string {
  return value instanceof Error
    ? value.message
    : scalarText(value, 'Unknown failure');
}

/** Convert supported scalar values without invoking untrusted object coercion.
 * @param value - Unknown quantity, identity or diagnostic field.
 * @param fallback - Text used for null, objects and other unsupported types.
 * @returns Scalar text without changing exact string or bigint quantities.
 */
export function scalarText(value: unknown, fallback: string): string {
  return typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean'
    ? String(value)
    : fallback;
}
