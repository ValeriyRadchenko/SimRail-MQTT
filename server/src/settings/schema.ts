import { compileMask, DEFAULT_MASK } from '../joysticks/mask.js';

// What the user sets up in the UI, saved as settings/config.json:
//
// {
//   "version": 1,
//   "locomotive": "Dragon 2 (ET25 / E6ACTa)",
//   "paused": false,
//   "joysticks": [
//     { "port": "COM3", "enabled": true, "baudRate": 9600, "mask": "{a,a}" },
//     { "port": "sdl:HID#VID_0079&PID_0006#9&234B6673&0&0000", "enabled": true }
//   ],
//   "bindings": [{
//     "locomotive": "Dragon 2 (ET25 / E6ACTa)", "joystick": "COM3", "channel": 0,
//     "feature": "physics_input_general/drive_handle",
//     "tolerance": 20,
//     "notches": [{ "position": 512, "value": 0 }],
//     "areas": [{ "from": 560, "to": 1023, "valueFrom": 0, "valueTo": 1 }]
//   }]
// }
//
// A joystick is either a serial port ("COM3") or a game controller, whose id starts with "sdl:"
// (see joysticks/controllers.ts).

export const CONTROLLER_PREFIX = 'sdl:';

export const isControllerPort = (port: string) => port.startsWith(CONTROLLER_PREFIX);

/** How a serial port is read. */
export interface SerialJoystickSettings {
  /** e.g. "COM3" */
  port: string;
  /** Read the port. Off until the user turns it on: opening a port resets most Arduinos and
   *  keeps other programs (e.g. the Arduino IDE) from using it. */
  enabled: boolean;
  baudRate: number;
  /** Line format, see joysticks/mask.ts. */
  mask: string;
}

/** A game controller (USB joystick, gamepad, throttle…) read through SDL. */
export interface ControllerSettings {
  /** "sdl:" + the device's id, e.g. "sdl:HID#VID_0079&PID_0006#9&234B6673&0&0000" */
  port: string;
  /** Read the controller. Off until the user turns it on, like serial ports. */
  enabled: boolean;
}

export type JoystickSettings = SerialJoystickSettings | ControllerSettings;

export const isSerialSettings = (j: JoystickSettings): j is SerialJoystickSettings => !isControllerPort(j.port);

/** A detent of an analog lever: raw values within the tolerance of `position` give `value`. */
export interface Notch {
  position: number;
  value: number;
}

/** Raw values from `from` to `to` map linearly onto `valueFrom`..`valueTo`. */
export interface AnalogArea {
  from: number;
  to: number;
  valueFrom: number;
  valueTo: number;
}

/** Which SimRail input (the "feature") a joystick channel drives on a locomotive, and how. */
export interface Binding {
  locomotive: string;
  /** Port of the joystick, e.g. "COM3", or a controller's "sdl:…" id. */
  joystick: string;
  /** 0-based position of the value in the joystick's mask (controllers: axes, buttons, then hats). */
  channel: number;
  /** SimRail input topic, e.g. "physics_input_general/drive_handle". */
  feature: string;
  // Analog channels. Notches win over areas where they overlap.
  /** ± raw distance from a notch's position that still counts as in the notch. */
  tolerance?: number;
  notches?: Notch[];
  areas?: AnalogArea[];
  // Button channels.
  pressed?: number;
  released?: number;
}

export interface Settings {
  version: 1;
  /** Locomotive whose bindings are shown, edited and sent to the game. */
  locomotive: string | null;
  /** Joystick values are not sent to the game while true (still read and shown). */
  paused: boolean;
  joysticks: JoystickSettings[];
  bindings: Binding[];
}

export type SettingsChange =
  | { kind: 'locomotive'; locomotive: string | null }
  | { kind: 'paused'; paused: boolean }
  /** Add or replace a joystick's settings. */
  | { kind: 'joystick'; joystick: JoystickSettings }
  /** Add or replace the binding of (locomotive, joystick, channel). */
  | { kind: 'binding'; binding: Binding }
  | { kind: 'remove-binding'; locomotive: string; joystick: string; channel: number };

export const DEFAULT_BAUD_RATE = 9600;

export function defaultSerialJoystick(port: string): SerialJoystickSettings {
  return { port, enabled: false, baudRate: DEFAULT_BAUD_RATE, mask: DEFAULT_MASK };
}

export function defaultController(port: string): ControllerSettings {
  return { port, enabled: false };
}

export function defaultSettings(): Settings {
  return { version: 1, locomotive: null, paused: false, joysticks: [], bindings: [] };
}

/** A settings value that can't be accepted; the message is shown to the user. */
export class InvalidSettings extends Error {}

function fail(message: string): never {
  throw new InvalidSettings(message);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function text(raw: unknown, what: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') fail(`${what} is missing.`);
  const value = raw.trim();
  if (value.length > 200 || /[\u0000-\u001f]/.test(value)) fail(`${what} is not valid.`);
  return value;
}

function number(raw: unknown, what: string): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) fail(`${what} must be a number.`);
  return raw;
}

function list<T>(
  raw: unknown,
  [one, many]: [string, string],
  max: number,
  parseItem: (item: unknown, label: string) => T,
): T[] {
  if (!Array.isArray(raw)) fail(`${many} must be a list.`);
  if (raw.length > max) fail(`At most ${max} ${many.toLowerCase()}.`);
  return raw.map((item, i) => parseItem(item, `${one} ${i + 1}`));
}

export function parseJoystickSettings(raw: unknown): JoystickSettings {
  if (!isRecord(raw)) fail('Joystick settings are missing.');
  const port = text(raw.port, 'Port');
  if (typeof raw.enabled !== 'boolean') fail('"enabled" must be true or false.');
  if (isControllerPort(port)) return { port, enabled: raw.enabled };
  const baudRate = raw.baudRate;
  if (typeof baudRate !== 'number' || !Number.isInteger(baudRate) || baudRate < 110 || baudRate > 4_000_000) {
    fail('Baud rate must be a whole number between 110 and 4000000.');
  }
  if (typeof raw.mask !== 'string') fail('Mask is missing.');
  try {
    compileMask(raw.mask);
  } catch (err) {
    fail((err as Error).message);
  }
  return { port, enabled: raw.enabled, baudRate, mask: raw.mask.trim() };
}

function parseNotch(raw: unknown, label: string): Notch {
  if (!isRecord(raw)) fail(`${label} is not valid.`);
  return { position: number(raw.position, `${label}: position`), value: number(raw.value, `${label}: value`) };
}

function parseArea(raw: unknown, label: string): AnalogArea {
  if (!isRecord(raw)) fail(`${label} is not valid.`);
  const area = {
    from: number(raw.from, `${label}: from`),
    to: number(raw.to, `${label}: to`),
    valueFrom: number(raw.valueFrom, `${label}: value from`),
    valueTo: number(raw.valueTo, `${label}: value to`),
  };
  if (area.from === area.to) fail(`${label}: "from" and "to" must differ.`);
  return area;
}

export function parseBinding(raw: unknown): Binding {
  if (!isRecord(raw)) fail('Binding is missing.');
  const channel = raw.channel;
  // Controllers can have many: DirectInput allows 8 axes, 128 buttons and 4 hats (4 channels each).
  if (typeof channel !== 'number' || !Number.isInteger(channel) || channel < 0 || channel > 255) {
    fail('Channel must be a whole number from 0.');
  }
  const feature = text(raw.feature, 'Feature');
  if (/[+#]/.test(feature)) fail('Feature must be a topic without wildcards.');

  const binding: Binding = {
    locomotive: text(raw.locomotive, 'Locomotive'),
    joystick: text(raw.joystick, 'Joystick'),
    channel,
    feature,
  };
  if (raw.tolerance !== undefined) {
    binding.tolerance = number(raw.tolerance, 'Tolerance');
    if (binding.tolerance < 0) fail('Tolerance can not be negative.');
  }
  if (raw.notches !== undefined) {
    binding.notches = list(raw.notches, ['Notch', 'Notches'], 100, parseNotch).sort((a, b) => a.position - b.position);
  }
  if (raw.areas !== undefined) binding.areas = list(raw.areas, ['Area', 'Areas'], 50, parseArea);
  if (raw.pressed !== undefined) binding.pressed = number(raw.pressed, 'Pressed value');
  if (raw.released !== undefined) binding.released = number(raw.released, 'Released value');
  return binding;
}

export function parseSettingsChange(raw: unknown): SettingsChange {
  if (!isRecord(raw)) fail('Change is missing.');
  switch (raw.kind) {
    case 'locomotive':
      return { kind: 'locomotive', locomotive: raw.locomotive === null ? null : text(raw.locomotive, 'Locomotive') };
    case 'paused':
      if (typeof raw.paused !== 'boolean') fail('"paused" must be true or false.');
      return { kind: 'paused', paused: raw.paused };
    case 'joystick':
      return { kind: 'joystick', joystick: parseJoystickSettings(raw.joystick) };
    case 'binding':
      return { kind: 'binding', binding: parseBinding(raw.binding) };
    case 'remove-binding': {
      const { channel } = raw;
      if (typeof channel !== 'number' || !Number.isInteger(channel)) fail('Channel must be a whole number.');
      return {
        kind: 'remove-binding',
        locomotive: text(raw.locomotive, 'Locomotive'),
        joystick: text(raw.joystick, 'Joystick'),
        channel,
      };
    }
    default:
      return fail(`Unknown change "${String(raw.kind)}".`);
  }
}

const sameSlot = (a: Pick<Binding, 'locomotive' | 'joystick' | 'channel'>, b: typeof a) =>
  a.locomotive === b.locomotive && a.joystick === b.joystick && a.channel === b.channel;

/** The settings with `change` applied (the input is not modified). */
export function applyChange(settings: Settings, change: SettingsChange): Settings {
  switch (change.kind) {
    case 'locomotive':
      return { ...settings, locomotive: change.locomotive };
    case 'paused':
      return { ...settings, paused: change.paused };
    case 'joystick': {
      const others = settings.joysticks.filter((j) => j.port !== change.joystick.port);
      const joysticks = [...others, change.joystick].sort((a, b) => comparePorts(a.port, b.port));
      return { ...settings, joysticks };
    }
    case 'binding': {
      const index = settings.bindings.findIndex((b) => sameSlot(b, change.binding));
      const bindings = [...settings.bindings];
      if (index >= 0) bindings[index] = change.binding;
      else bindings.push(change.binding);
      return { ...settings, bindings };
    }
    case 'remove-binding':
      return { ...settings, bindings: settings.bindings.filter((b) => !sameSlot(b, change)) };
  }
}

/** COM2 before COM10. */
export const comparePorts = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/**
 * Settings read from disk. Entries that don't validate are dropped with a warning, so one bad
 * hand edit doesn't throw away everything else.
 */
export function parseSettingsFile(raw: unknown, warn: (message: string) => void): Settings {
  let settings = defaultSettings();
  if (!isRecord(raw)) {
    warn('not a JSON object; using defaults');
    return settings;
  }
  const attempt = (what: string, fn: () => void) => {
    try {
      fn();
    } catch (err) {
      warn(`ignoring ${what}: ${(err as Error).message}`);
    }
  };

  if (raw.locomotive !== undefined && raw.locomotive !== null) {
    attempt('locomotive', () => (settings.locomotive = text(raw.locomotive, 'Locomotive')));
  }
  if (raw.paused !== undefined) {
    if (typeof raw.paused === 'boolean') settings.paused = raw.paused;
    else warn('ignoring "paused": not true or false');
  }
  if (raw.joysticks !== undefined && !Array.isArray(raw.joysticks)) warn('ignoring "joysticks": not a list');
  if (Array.isArray(raw.joysticks)) {
    raw.joysticks.forEach((entry, i) =>
      attempt(`joysticks[${i}]`, () => {
        settings = applyChange(settings, { kind: 'joystick', joystick: parseJoystickSettings(entry) });
      }),
    );
  }
  if (raw.bindings !== undefined && !Array.isArray(raw.bindings)) warn('ignoring "bindings": not a list');
  if (Array.isArray(raw.bindings)) {
    raw.bindings.forEach((entry, i) =>
      attempt(`bindings[${i}]`, () => {
        settings = applyChange(settings, { kind: 'binding', binding: parseBinding(entry) });
      }),
    );
  }
  return settings;
}
