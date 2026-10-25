/**
 * Regression coverage and controlled fixtures for deferred.
 * @packageDocumentation
 */

/** Expose a promise and its controls so tests can order asynchronous completion explicitly.
 * @returns A pending promise with explicit resolve/reject controls for ordered assertions.
 */
export function deferred<T>() {
  /** Complete the controlled deferred operation with the supplied result. */
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  /** Reject the controlled deferred operation with the supplied test failure. */
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
