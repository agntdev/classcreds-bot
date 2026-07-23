/**
 * Injectable clock seam for schedules, cutoffs, expiry, and retention.
 * Override with setNow(() => fixedMs) in tests; never call Date.now() inline
 * for time-based domain decisions.
 */

let _now: () => number = () => Date.now();

/** Current wall-clock time in epoch milliseconds. */
export function now(): number {
  return _now();
}

/** Override the clock (tests). Pass undefined to restore system time. */
export function setNow(fn: (() => number) | undefined): void {
  _now = fn ?? (() => Date.now());
}
