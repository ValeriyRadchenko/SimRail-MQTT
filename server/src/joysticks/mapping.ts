import type { Binding } from '../settings/schema.js';

// How a joystick channel's raw value turns into the value sent to its SimRail feature:
//   analog: a notch wins when the raw value is within ±tolerance of its position (the closest
//           one if several); otherwise an area containing the raw value maps it linearly;
//           otherwise there is no value (nothing is sent, the game keeps the last one).
//   button: 1 -> binding.pressed, 0 -> binding.released.
// client/js/axis-mapping.js does the same for the previews in the browser; keep them in step.

export const DEFAULT_TOLERANCE = 20;
export const DEFAULT_PRESSED = 1;
export const DEFAULT_RELEASED = 0;

export interface Resolved {
  kind: 'notch' | 'area' | 'button';
  /** Which notch or area (0-based); 0 for buttons. */
  index: number;
  value: number;
}

export function resolveAnalog(binding: Binding, raw: number): Resolved | null {
  const tolerance = binding.tolerance ?? DEFAULT_TOLERANCE;
  let best: { index: number; distance: number; value: number } | null = null;
  for (const [index, notch] of (binding.notches ?? []).entries()) {
    const distance = Math.abs(raw - notch.position);
    if (distance <= tolerance && (!best || distance < best.distance)) best = { index, distance, value: notch.value };
  }
  if (best) return { kind: 'notch', index: best.index, value: best.value };

  const areas = binding.areas ?? [];
  const index = areas.findIndex((a) => raw >= Math.min(a.from, a.to) && raw <= Math.max(a.from, a.to));
  const area = areas[index];
  if (!area) return null;
  // from > to is allowed: the lever's direction is reversed.
  const t = (raw - area.from) / (area.to - area.from);
  return { kind: 'area', index, value: area.valueFrom + t * (area.valueTo - area.valueFrom) };
}

export function resolveButton(binding: Binding, raw: number): Resolved {
  return {
    kind: 'button',
    index: 0,
    value: raw ? (binding.pressed ?? DEFAULT_PRESSED) : (binding.released ?? DEFAULT_RELEASED),
  };
}
