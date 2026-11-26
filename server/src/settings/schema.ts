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
//   }],
//   "devices": [{
//     "id": "m3k9x2", "locomotive": "71E (CD163)", "name": "Cabin light", "type": "combo",
//     "feature": "physics_input_163/cabin_light",
//     "inputs": [{ "joystick": "COM3", "channel": 2 }, { "joystick": "COM3", "channel": 3 }],
//     "rules": [{ "when": ["released", "released"], "value": 0 }, { "when": ["pressed", "any"], "value": 1 }]
//   }]
// }
//
// A joystick is either a serial port ("COM3") or a game controller, whose id starts with "sdl:"
// (see joysticks/controllers.ts). Devices (virtual devices) combine button channels into one
// control, see devices/engine.ts.

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

/** A button channel a virtual device reads. */
export interface DeviceInput {
  /** Port of the joystick, e.g. "COM3", or a controller's "sdl:…" id. */
  joystick: string;
  /** 0-based channel, as in bindings. */
  channel: number;
}

export type DeviceType = 'combo' | 'stepper' | 'pulse';

export const DEVICE_TYPES: readonly DeviceType[] = ['combo', 'stepper', 'pulse'];

/** What a combination rule asks of one button. */
export type ButtonCondition = 'pressed' | 'released' | 'any';

/** When each input is as `when` says (one entry per input), `value` is sent; null sends nothing. */
export interface ComboRule {
  when: ButtonCondition[];
  value: number | null;
}

interface DeviceBase {
  /** Stable id, made by the UI. */
  id: string;
  locomotive: string;
  /** What the user calls it, e.g. "Cabin light". */
  name: string;
  /** SimRail input topic the device drives. */
  feature: string;
  /** Button channels; what each one does depends on the type. */
  inputs: DeviceInput[];
}

/** Buttons together give one value: the first rule matching their states is sent. */
export interface ComboDevice extends DeviceBase {
  type: 'combo';
  rules: ComboRule[];
}

/**
 * inputs[0] moves a multi-position switch one position up, inputs[1] (optional) one down,
 * from where it is in game (polled).
 */
export interface StepperDevice extends DeviceBase {
  type: 'stepper';
  /** The values the switch can take, ascending. */
  positions: number[];
  /** Past the last position comes the first, and the other way round. */
  wrap: boolean;
  /** Holding a button keeps stepping. */
  repeat: boolean;
}

/** Pressing inputs[0] sends onPress, releasing it onRelease (null: nothing); `durationMs` later, `rest`. */
export interface PulseDevice extends DeviceBase {
  type: 'pulse';
  onPress: number | null;
  onRelease: number | null;
  rest: number;
  durationMs: number;
}

export type Device = ComboDevice | StepperDevice | PulseDevice;

/** How many inputs each type takes. */
export const DEVICE_INPUTS: Record<DeviceType, { min: number; max: number }> = {
  combo: { min: 1, max: 6 },
  stepper: { min: 1, max: 2 },
  pulse: { min: 1, max: 1 },
};
export const MAX_RULES = 64;
export const MAX_POSITIONS = 64;
/** A pulse is at least one send interval long, or the rest value would overwrite it before it goes out. */
export const PULSE_MIN_MS = 50;
export const PULSE_MAX_MS = 10_000;

export interface Settings {
  version: 1;
  /** Locomotive whose bindings are shown, edited and sent to the game. */
  locomotive: string | null;
  /** Joystick values are not sent to the game while true (still read and shown). */
  paused: boolean;
  joysticks: JoystickSettings[];
  bindings: Binding[];
  devices: Device[];
}

export type SettingsChange =
  | { kind: 'locomotive'; locomotive: string | null }
  | { kind: 'paused'; paused: boolean }
  /** Add or replace a joystick's settings. */
  | { kind: 'joystick'; joystick: JoystickSettings }
  /** Add or replace the binding of (locomotive, joystick, channel). */
  | { kind: 'binding'; binding: Binding }
  | { kind: 'remove-binding'; locomotive: string; joystick: string; channel: number }
  /** Add or replace the device with this id. */
  | { kind: 'device'; device: Device }
  | { kind: 'remove-device'; id: string };

export const DEFAULT_BAUD_RATE = 9600;

export function defaultSerialJoystick(port: string): SerialJoystickSettings {
  return { port, enabled: false, baudRate: DEFAULT_BAUD_RATE, mask: DEFAULT_MASK };
}

export function defaultController(port: string): ControllerSettings {
  return { port, enabled: false };
}

export function defaultSettings(): Settings {
  return { version: 1, locomotive: null, paused: false, joysticks: [], bindings: [], devices: [] };
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

function channelNumber(raw: unknown, what: string): number {
  // Controllers can have many: DirectInput allows 8 axes, 128 buttons and 4 hats (4 channels each).
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > 255) {
    fail(`${what} must be a whole number from 0.`);
  }
  return raw;
}

function featureTopic(raw: unknown): string {
  const feature = text(raw, 'Feature');
  if (/[+#]/.test(feature)) fail('Feature must be a topic without wildcards.');
  return feature;
}

function bool(raw: unknown, what: string): boolean {
  if (typeof raw !== 'boolean') fail(`"${what}" must be true or false.`);
  return raw;
}

/** A number, or null for "nothing". */
function numberOrNull(raw: unknown, what: string): number | null {
  return raw === null ? null : number(raw, what);
}

export function parseBinding(raw: unknown): Binding {
  if (!isRecord(raw)) fail('Binding is missing.');
  const binding: Binding = {
    locomotive: text(raw.locomotive, 'Locomotive'),
    joystick: text(raw.joystick, 'Joystick'),
    channel: channelNumber(raw.channel, 'Channel'),
    feature: featureTopic(raw.feature),
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

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const BUTTON_CONDITIONS: readonly ButtonCondition[] = ['pressed', 'released', 'any'];
const TYPE_NAMES: Record<DeviceType, string> = { combo: 'A button combination', stepper: 'A step switch', pulse: 'A pulse' };

function parseDeviceInput(raw: unknown, label: string): DeviceInput {
  if (!isRecord(raw)) fail(`${label} is not valid.`);
  return { joystick: text(raw.joystick, `${label}: joystick`), channel: channelNumber(raw.channel, `${label}: channel`) };
}

function parseRule(raw: unknown, label: string, inputs: number): ComboRule {
  if (!isRecord(raw)) fail(`${label} is not valid.`);
  if (!Array.isArray(raw.when) || raw.when.length !== inputs) fail(`${label} needs a condition for each of the ${inputs} buttons.`);
  const when = raw.when.map((c): ButtonCondition => {
    if (!BUTTON_CONDITIONS.includes(c as ButtonCondition)) fail(`${label}: a button is "pressed", "released" or "any".`);
    return c as ButtonCondition;
  });
  return { when, value: numberOrNull(raw.value, `${label}: value`) };
}

export function parseDevice(raw: unknown): Device {
  if (!isRecord(raw)) fail('Device is missing.');
  if (typeof raw.id !== 'string' || !DEVICE_ID_RE.test(raw.id)) fail('Device id is not valid.');
  const type = raw.type as DeviceType;
  if (!DEVICE_TYPES.includes(type)) fail(`Unknown device type "${String(raw.type)}".`);

  const id = raw.id;
  const locomotive = text(raw.locomotive, 'Locomotive');
  const name = text(raw.name, 'Name');
  const feature = featureTopic(raw.feature);
  const inputs = list(raw.inputs, ['Input', 'Inputs'], DEVICE_INPUTS.combo.max, parseDeviceInput);
  const { min, max } = DEVICE_INPUTS[type];
  if (inputs.length < min || inputs.length > max) {
    fail(min === max ? `${TYPE_NAMES[type]} takes ${min} button.` : `${TYPE_NAMES[type]} takes ${min} to ${max} buttons.`);
  }
  inputs.forEach((input, i) => {
    if (inputs.findIndex((other) => other.joystick === input.joystick && other.channel === input.channel) !== i) {
      fail(`Input ${i + 1} is the same button as another input.`);
    }
  });
  const base = { id, locomotive, name, type, feature, inputs };

  switch (type) {
    case 'combo': {
      const rules = list(raw.rules, ['Rule', 'Rules'], MAX_RULES, (item, label) => parseRule(item, label, inputs.length));
      return { ...base, type, rules };
    }
    case 'stepper': {
      const positions = list(raw.positions, ['Position', 'Positions'], MAX_POSITIONS, (item, label) => number(item, label));
      positions.sort((a, b) => a - b);
      if (positions.length < 2) fail('A step switch needs at least 2 positions.');
      if (positions.some((p, i) => i > 0 && p === positions[i - 1])) fail('Positions must all differ.');
      return { ...base, type, positions, wrap: bool(raw.wrap, 'wrap'), repeat: bool(raw.repeat, 'repeat') };
    }
    case 'pulse': {
      const onPress = numberOrNull(raw.onPress, 'Value on press');
      const onRelease = numberOrNull(raw.onRelease, 'Value on release');
      if (onPress === null && onRelease === null) fail('A pulse needs a value on press, on release, or both.');
      const durationMs = raw.durationMs;
      if (typeof durationMs !== 'number' || !Number.isInteger(durationMs) || durationMs < PULSE_MIN_MS || durationMs > PULSE_MAX_MS) {
        fail(`Pulse length must be a whole number of milliseconds from ${PULSE_MIN_MS} to ${PULSE_MAX_MS}.`);
      }
      return { ...base, type, onPress, onRelease, rest: number(raw.rest, 'Rest value'), durationMs };
    }
  }
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
    case 'device':
      return { kind: 'device', device: parseDevice(raw.device) };
    case 'remove-device':
      return { kind: 'remove-device', id: text(raw.id, 'Device id') };
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
    case 'device': {
      const index = settings.devices.findIndex((d) => d.id === change.device.id);
      const devices = [...settings.devices];
      if (index >= 0) devices[index] = change.device;
      else devices.push(change.device);
      return { ...settings, devices };
    }
    case 'remove-device':
      return { ...settings, devices: settings.devices.filter((d) => d.id !== change.id) };
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
  if (raw.devices !== undefined && !Array.isArray(raw.devices)) warn('ignoring "devices": not a list');
  if (Array.isArray(raw.devices)) {
    raw.devices.forEach((entry, i) =>
      attempt(`devices[${i}]`, () => {
        settings = applyChange(settings, { kind: 'device', device: parseDevice(entry) });
      }),
    );
  }
  return settings;
}
