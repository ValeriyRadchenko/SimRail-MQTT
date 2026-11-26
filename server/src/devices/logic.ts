import type { ComboRule } from '../settings/schema.js';

// What virtual devices compute from their buttons (see engine.ts for when and what is sent).
// client/js/devices.js does the same for the previews in the browser; keep them in step.

/** Holding a step switch's button (with repeat on) steps again after this… */
export const REPEAT_DELAY_MS = 400;
/** …and then this often. */
export const REPEAT_INTERVAL_MS = 150;

/** A button channel's raw value: 1 pressed, 0 released (hats count as buttons). */
export const isPressed = (raw: number) => raw !== 0;

/** Index of the first rule matching the buttons' states (true = pressed), or -1. */
export function matchRule(rules: readonly ComboRule[], pressed: readonly boolean[]): number {
  return rules.findIndex((rule) => rule.when.every((c, i) => c === 'any' || (c === 'pressed') === pressed[i]));
}

/** Two values are the same position (the game reports float32 values as text). */
export function samePosition(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * The position one step from `current`: the next listed value above it (`direction` 1) or below
 * it (-1), so a value between positions steps to the neighbouring one. Past an end: the other
 * end with `wrap`, otherwise null (it stays).
 */
export function nextPosition(
  positions: readonly number[],
  current: number,
  direction: 1 | -1,
  wrap: boolean,
): number | null {
  const beyond = (p: number) => !samePosition(p, current) && (direction > 0 ? p > current : p < current);
  const ordered = direction > 0 ? positions : [...positions].reverse();
  const next = ordered.find(beyond);
  if (next !== undefined) return next;
  return wrap ? (ordered[0] ?? null) : null;
}
