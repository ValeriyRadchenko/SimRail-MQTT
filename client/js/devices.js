// Virtual devices: joystick buttons that together drive one SimRail input (settings/config.json
// "devices"). The server sends what server/src/devices/ computes; this copy shows the same in the
// browser, including for edits not saved yet. Keep them in step.

/** Per type: what it is called, what it does, and its inputs (min–max, and their names). */
export const DEVICE_TYPES = {
  combo: {
    title: 'Button combination',
    summary:
      'Several buttons give one value together. Each rule is a combination of pressed and released ' +
      'buttons and the value it sends; the first matching rule wins. A rule without a value sends ' +
      'nothing, and so does no matching rule: the game keeps its value.',
    min: 1,
    max: 6,
    roles: ['A', 'B', 'C', 'D', 'E', 'F'],
  },
  stepper: {
    title: 'Step switch',
    summary:
      'Up and Down move a multi-position switch one position from where it is in game (the value ' +
      'is read from SimRail). With only Up and Wrap on, one button cycles through the positions, or ' +
      'toggles between two.',
    min: 1,
    max: 2,
    roles: ['Up', 'Down'],
  },
  pulse: {
    title: 'Pulse',
    summary:
      'Pressing (or releasing) the button sends a value for a moment, then the rest value. A ' +
      'latching toggle switch can work an impulse button in game, or a pair of on/off requests.',
    min: 1,
    max: 1,
    roles: ['Button'],
  },
};

export const CONDITIONS = { pressed: 'Pressed', released: 'Released', any: 'Any' };

/** Mirrors PULSE_MIN_MS / PULSE_MAX_MS in server/src/settings/schema.ts. */
export const PULSE_MIN_MS = 50;
export const PULSE_MAX_MS = 10000;
export const DEFAULT_PULSE_MS = 200;
export const MAX_POSITIONS = 64;

/** A button channel's raw value: 1 pressed, 0 released (hats count as buttons). */
export const isPressed = (raw) => raw !== 0;

/**
 * A device input's live state: true pressed, false released, null unknown (the joystick isn't
 * being read, or the channel isn't a button).
 * @param {object | undefined} joystick  JoystickInfo
 * @param {object | undefined} latest  its latest JoystickInput
 */
export function buttonState(joystick, latest, channel) {
  if (joystick?.state !== 'open' || joystick.channels[channel] !== 'button') return null;
  const raw = latest?.values?.[channel];
  return Number.isFinite(raw) ? isPressed(raw) : null;
}

/** Why buttonState() is null, for a tooltip. */
export function unknownReason(joystick, channel) {
  if (!joystick) return 'Not connected';
  if (joystick.state !== 'open') return `${joystick.name} is not being read`;
  if (joystick.channels[channel] !== 'button') return 'Not a button channel';
  return 'No value yet';
}

/** Index of the first rule matching the buttons' states (true = pressed), or -1. */
export function matchRule(rules, pressed) {
  return rules.findIndex((rule) => rule.when.every((c, i) => c === 'any' || (c === 'pressed') === pressed[i]));
}

export function samePosition(a, b) {
  return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
}

/** Index of the position the value is at, or -1 (between positions). */
export const positionIndex = (positions, value) => positions.findIndex((p) => samePosition(p, value));

/**
 * Every combination of `count` buttons, as rules' `when`: all released first, then one pressed,
 * then two… (for 2 buttons: released+released, A, B, A+B).
 */
export function allCombinations(count) {
  const bits = (n) => n.toString(2).split('').filter((b) => b === '1').length;
  return [...Array(2 ** count).keys()]
    .sort((a, b) => bits(a) - bits(b) || a - b)
    .map((mask) => [...Array(count).keys()].map((i) => (mask & (1 << i) ? 'pressed' : 'released')));
}

/**
 * "0, 1, 2", "-1 1" or "0..7" (whole numbers from 0 to 7) -> { positions } ascending, or { error }.
 */
export function parsePositions(text) {
  const values = [];
  for (const token of String(text).split(/[\s,;]+/).filter(Boolean)) {
    const range = token.match(/^(-?\d+)\.\.(-?\d+)$/);
    if (range) {
      const [from, to] = [Number(range[1]), Number(range[2])].sort((a, b) => a - b);
      if (to - from >= MAX_POSITIONS) return { error: `${token} has more than ${MAX_POSITIONS} positions.` };
      for (let v = from; v <= to; v++) values.push(v);
    } else if (token !== '' && Number.isFinite(Number(token))) {
      values.push(Number(token));
    } else {
      return { error: `"${token}" is not a number (or a range like 0..7).` };
    }
  }
  const positions = [...new Set(values)].sort((a, b) => a - b);
  if (positions.length < 2) return { error: 'Enter at least 2 positions, e.g. 0, 1, 2 or 0..7.' };
  if (positions.length > MAX_POSITIONS) return { error: `At most ${MAX_POSITIONS} positions.` };
  return { positions };
}

/** [0, 1, 2, 3] -> "0..3", [-1, 1] -> "-1, 1" */
export function formatPositions(positions) {
  const consecutive =
    positions.length > 2 && positions.every((p, i) => Number.isInteger(p) && (i === 0 || p === positions[i - 1] + 1));
  return consecutive ? `${positions[0]}..${positions.at(-1)}` : positions.join(', ');
}

/**
 * The positions a feature's description documents (value-range.js), or null:
 * "0 = disabled / 1 = TL / 2 = PL" -> [0, 1, 2]; "1–12 = 12 positions" -> 1..12.
 */
export function positionsFromRange(range) {
  if (!range?.documented) return null;
  if (range.meanings.size >= 2) return [...range.ticks];
  const { min, max } = range;
  if (Number.isInteger(min) && Number.isInteger(max) && max - min >= 2 && max - min < MAX_POSITIONS) {
    return Array.from({ length: max - min + 1 }, (_, i) => min + i);
  }
  return range.ticks.length >= 2 ? [...range.ticks] : null;
}

/** An id for a new device: short, unique enough for one settings file. */
export function newDeviceId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
