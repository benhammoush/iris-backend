/**
 * Fixed public error representation for protected API operations.
 * @packageDocumentation
 */

/** Errors crossing the private API boundary must never include upstream data. */
export class PrivateError extends Error {
  /** Retain only a fixed public classification and HTTP status.
   * @param code - Controlled private-API error code, never provider data.
   * @param status - Public HTTP error status.
   */
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}
