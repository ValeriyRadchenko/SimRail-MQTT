// How a joystick channel's raw value turns into a value for its SimRail feature, following the
// channel's binding (settings/config.json):
//   analog: a notch wins when the raw value is within ±tolerance of its position; otherwise an
//           area containing the raw value maps it linearly; otherwise there is no value.
//   button: 1 -> binding.pressed, 0 -> binding.released.
// The server sends what server/src/joysticks/mapping.ts computes; this copy shows the same in the
// browser, including for edits not saved yet. Keep them in step.

/** Top of an Arduino's analogRead() range (10-bit). */
export const ANALOG_MAX = 1023;
export const DEFAULT_TOLERANCE = 20;
export const DEFAULT_PRESSED = 1;
export const DEFAULT_RELEASED = 0;

/**
 * @param {{ tolerance?: number, notches?: { position: number, value: number }[],
 *           areas?: { from: number, to: number, valueFrom: number, valueTo: number }[] }} binding
 * @param {number} raw
 * @returns {{ kind: 'notch' | 'area', index: number, value: number } | null}
 */
export function resolveAnalog(binding, raw) {
  const tolerance = binding.tolerance ?? DEFAULT_TOLERANCE;
  let best = null;
  (binding.notches ?? []).forEach((notch, index) => {
    const distance = Math.abs(raw - notch.position);
    if (distance <= tolerance && (!best || distance < best.distance)) best = { index, distance, value: notch.value };
  });
  if (best) return { kind: 'notch', index: best.index, value: best.value };

  const areas = binding.areas ?? [];
  const index = areas.findIndex((a) => raw >= Math.min(a.from, a.to) && raw <= Math.max(a.from, a.to));
  if (index < 0) return null;
  const area = areas[index];
  // from > to is allowed: the lever's direction is reversed.
  const t = (raw - area.from) / (area.to - area.from);
  return { kind: 'area', index, value: area.valueFrom + t * (area.valueTo - area.valueFrom) };
}

/** @returns {{ kind: 'button', value: number }} */
export function resolveButton(binding, raw) {
  return { kind: 'button', value: raw ? (binding.pressed ?? DEFAULT_PRESSED) : (binding.released ?? DEFAULT_RELEASED) };
}

/** 0.4300000001 -> "0.43", -0 -> "0", NaN (a field being edited) -> "?" */
export function formatValue(value) {
  return Number.isFinite(value) ? String(Number(value.toFixed(3)) || 0) : '?';
}

/** "Axis 1", "Button 3", "Hat 1 up" — named by the server (joystick.labels). */
export function channelLabel(joystick, index) {
  return joystick.labels?.[index] ?? `Channel ${index + 1}`;
}
