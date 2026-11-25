import { EventEmitter } from 'node:events';
import type { Sdl } from '@kmamal/sdl';
import type { ControllerLayout, JoystickInfo, JoystickInput, JoystickState } from '../protocol.js';
import { comparePorts, CONTROLLER_PREFIX, defaultController, type ControllerSettings } from '../settings/schema.js';
import type { ChannelKind } from './mask.js';

// Game controllers (USB joysticks, gamepads, throttles…), read through SDL (@kmamal/sdl). They are
// listed next to the serial ports and used the same way: turn on Read, then assign channels.
//
// - Channels: the axes, then the buttons, then each hat (d-pad) as four buttons: up, right, down, left.
// - Axes are scaled from SDL's -1…1 to 0–1023, the range of a serial joystick's analog values, so
//   notches, areas and their defaults work the same.
// - Ids: identical devices (two "Generic USB Joystick"s) have the same SDL GUID, so a controller is
//   known by its device path. On Windows the path names the device and the USB port it is in:
//     \\?\HID#VID_0079&PID_0006#9&234b6673&0&0000#{4d1e55b2-…}  ->  sdl:HID#VID_0079&PID_0006#9&234B6673&0&0000
//   Like a COM port's number, it stays the same across restarts while the device stays in that port.
// - The state is read every few milliseconds and reported when it changed (unlike serial ports,
//   a controller that nobody touches sends nothing).

/** A controller as the backend lists it. */
export interface ControllerListing {
  /** "sdl:…", see above. */
  port: string;
  name: string | null;
  /** SDL's guess at what it is, e.g. "throttle"; null for most USB joysticks. */
  type: string | null;
}

/** What a controller reports: axes from -1 to 1, buttons, hats ("centered", "up", "rightup"…). */
export interface ControllerState {
  axes: readonly number[];
  buttons: readonly boolean[];
  hats: readonly string[];
}

/** An opened controller. */
export interface ControllerConnection {
  /** True once the controller was unplugged (or closed). */
  readonly closed: boolean;
  /** The current state, taking in what changed since the last read. */
  read(): ControllerState;
  close(): void;
}

/** Where controllers come from (SDL, see sdlControllers). */
export interface ControllerBackend {
  list(): ControllerListing[];
  /** Throws when the controller can't be opened. */
  open(port: string): ControllerConnection;
}

/** Loads SDL. Throws when it can't be (e.g. its native module is missing or fails to load). */
export async function sdlControllers(): Promise<ControllerBackend> {
  const { default: sdl } = await import('@kmamal/sdl');
  if (!sdl.info.initialized.joystick) throw new Error('SDL could not start its joystick support');

  // Reading `devices`, `axes`, `buttons` or `hats` makes SDL take in what happened since the last
  // read (movements, plugging, unplugging). @kmamal/sdl does that by itself only once a second, or
  // every millisecond once an event listener is attached; reading every few ms costs much less.
  const devices = () => withPorts(sdl.joystick.devices);
  return {
    list: () => devices().map(({ port, device }) => ({ port, name: device.name, type: device.type })),
    open(port) {
      // SDL's device objects change as devices come and go: use the current one.
      const device = devices().find((d) => d.port === port)?.device;
      if (!device) throw new Error('Not connected');
      const instance = sdl.joystick.openDevice(device);
      return {
        get closed() {
          return instance.closed;
        },
        read: () => ({ axes: instance.axes, buttons: instance.buttons, hats: instance.hats }),
        close() {
          if (!instance.closed) instance.close();
        },
      };
    },
  };
}

function withPorts(devices: readonly Sdl.Joystick.Device[]): { port: string; device: Sdl.Joystick.Device }[] {
  const seen = new Map<string, number>();
  return devices.map((device) => {
    const id = CONTROLLER_PREFIX + deviceId(device);
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    return { port: n === 1 ? id : `${id}#${n}`, device };
  });
}

/** "\\?\HID#VID_0079&PID_0006#9&234b6673&0&0000#{4d1e55b2-…}" -> "HID#VID_0079&PID_0006#9&234B6673&0&0000" */
function deviceId(device: Sdl.Joystick.Device): string {
  // Windows device paths aren't case-sensitive, and different APIs report them in different cases.
  const windowsPath = device.path?.match(/^\\\\\?\\(.+?)(?:#\{[\da-f-]+\})?$/i);
  if (windowsPath) return windowsPath[1]!.toUpperCase();
  return device.path || device.guid || device.name || 'unknown';
}

// ---------- reading ----------

/** Top of the raw range axes are scaled to: an Arduino's analogRead, like serial joysticks. */
const AXIS_MAX = 1023;
const HAT_DIRECTIONS = ['up', 'right', 'down', 'left'] as const;
/** After a controller failed to open, wait this long before trying again. */
const RETRY_MS = 3000;

const TYPE_NAMES: Record<string, string> = {
  gamecontroller: 'Gamepad',
  wheel: 'Wheel',
  arcadestick: 'Arcade stick',
  flightstick: 'Flight stick',
  dancepad: 'Dance pad',
  guitar: 'Guitar',
  drumkit: 'Drum kit',
  arcadepad: 'Arcade pad',
  throttle: 'Throttle',
};

interface Layout extends ControllerLayout {
  channels: ChannelKind[];
  labels: string[];
}

interface Connection {
  conn: ControllerConnection;
  /** Last values reported, to report only changes. */
  values: number[] | null;
}

interface ControllerEvents {
  /** The list of controllers or their state changed. */
  joysticks: [JoystickInfo[]];
  /** A controller's values changed (and once when it is opened). */
  input: [JoystickInput];
}

/**
 * Lists game controllers, reads the ones the user turned on and reports their values. Controllers
 * come and go (USB): they are opened when they appear and closed when they are unplugged.
 */
export class GameControllers extends EventEmitter<ControllerEvents> {
  private readonly backend: ControllerBackend;
  private readonly pollMs: number;
  private readonly listIntervalMs: number;
  private settings = new Map<string, ControllerSettings>();
  private listed = new Map<string, ControllerListing>();
  /** Last listing and layout of every controller seen, to show it while it is unplugged. */
  private readonly lastListing = new Map<string, ControllerListing>();
  private readonly layouts = new Map<string, Layout>();
  private readonly connections = new Map<string, Connection>();
  private readonly errors = new Map<string, { message: string; retryAt: number }>();
  private readonly latest = new Map<string, JoystickInput>();
  private timer: NodeJS.Timeout | null = null;
  private nextListAt = 0;
  private lastError: string | null = null;
  private lastEmitted = '';
  private stopped = false;

  constructor(options: { backend: ControllerBackend; pollMs: number; listIntervalMs: number }) {
    super();
    this.backend = options.backend;
    this.pollMs = options.pollMs;
    this.listIntervalMs = options.listIntervalMs;
  }

  start(): void {
    this.stopped = false;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.pollMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const [port, connection] of this.connections) this.close(port, connection);
  }

  /** Apply the user's settings: opens or closes controllers as needed. */
  configure(controllers: ControllerSettings[]): void {
    const previous = this.settings;
    this.settings = new Map(controllers.map((c) => [c.port, c]));
    for (const [port, next] of this.settings) {
      // The user changed something: worth trying again right away.
      if (previous.get(port)?.enabled !== next.enabled) this.errors.delete(port);
    }
    this.reconcile();
  }

  getJoysticks(): JoystickInfo[] {
    const enabled = [...this.settings.values()].filter((s) => s.enabled).map((s) => s.port);
    const infos = [...new Set([...this.listed.keys(), ...enabled])]
      .map((port) => this.info(port))
      .sort((a, b) => a.name.localeCompare(b.name) || comparePorts(a.port, b.port));
    // Several called the same (identical devices): number them, in a stable order.
    const total = new Map<string, number>();
    for (const { name } of infos) total.set(name, (total.get(name) ?? 0) + 1);
    const numbered = new Map<string, number>();
    return infos.map((info) => {
      if (total.get(info.name)! < 2) return info;
      const n = (numbered.get(info.name) ?? 0) + 1;
      numbered.set(info.name, n);
      return { ...info, name: `${info.name} #${n}` };
    });
  }

  /** Latest values of each controller being read. */
  getLatest(): JoystickInput[] {
    return [...this.latest.values()];
  }

  /** What each value of the controller is: its axes, buttons, then hat directions. */
  channelsOf(port: string): ChannelKind[] {
    return this.layouts.get(port)?.channels ?? [];
  }

  // ---------- controllers ----------

  private tick(): void {
    // SDL is native code behind a JS layer; whatever it throws must not stop the server.
    try {
      if (Date.now() >= this.nextListAt) this.refresh();
      for (const [port, connection] of this.connections) this.read(port, connection);
      this.lastError = null;
    } catch (err) {
      const message = (err as Error).message;
      if (message !== this.lastError) console.warn(`[controller] ${message}`);
      this.lastError = message;
    }
  }

  private refresh(): void {
    this.nextListAt = Date.now() + this.listIntervalMs;
    const listing = this.backend.list();
    const before = this.listed;
    this.listed = new Map(listing.map((c) => [c.port, c]));
    for (const controller of listing) {
      this.lastListing.set(controller.port, controller);
      if (!before.has(controller.port)) console.log(`[controller] found ${controller.name ?? 'a controller'} (${controller.port})`);
    }
    for (const [port, controller] of before) {
      if (!this.listed.has(port)) console.log(`[controller] ${controller.name ?? 'controller'} unplugged (${port})`);
    }
    this.reconcile();
  }

  /** Open what should be open, close what shouldn't, then report. */
  private reconcile(): void {
    if (this.stopped) return;
    const ports = new Set([...this.listed.keys(), ...this.settings.keys(), ...this.connections.keys()]);
    for (const port of ports) {
      const enabled = this.settingsFor(port).enabled;
      const wanted = enabled && this.listed.has(port);
      const connection = this.connections.get(port);
      if (connection && !wanted) {
        this.close(port, connection);
      } else if (!connection && wanted) {
        const error = this.errors.get(port);
        if (!error || Date.now() >= error.retryAt) this.open(port);
      } else if (!enabled) {
        this.errors.delete(port);
      }
    }
    this.emitJoysticks();
  }

  private open(port: string): void {
    let conn: ControllerConnection | undefined;
    let state: ControllerState;
    try {
      conn = this.backend.open(port);
      state = conn.read();
    } catch (err) {
      conn?.close();
      this.setError(port, (err as Error).message);
      return;
    }
    const connection: Connection = { conn, values: null };
    this.layouts.set(port, layoutOf(state));
    this.errors.delete(port);
    this.connections.set(port, connection);
    console.log(`[controller] reading ${this.nameOf(port)} (${port})`);
    this.report(port, connection, state);
  }

  private close(port: string, connection: Connection): void {
    this.connections.delete(port);
    this.latest.delete(port);
    connection.conn.close();
    console.log(`[controller] stopped reading ${this.nameOf(port)} (${port})`);
  }

  private read(port: string, connection: Connection): void {
    const state = connection.conn.read();
    if (connection.conn.closed) {
      // Unplugged; SDL has closed it. It is opened again when it is plugged back in.
      this.connections.delete(port);
      this.latest.delete(port);
      this.refresh();
      return;
    }
    this.report(port, connection, state);
  }

  /** Emit the controller's values if they changed. */
  private report(port: string, connection: Connection, state: ControllerState): void {
    const values = valuesOf(state);
    const last = connection.values;
    if (last && last.length === values.length && last.every((v, i) => v === values[i])) return;
    connection.values = values;
    const input: JoystickInput = { port, values, receivedAt: Date.now() };
    this.latest.set(port, input);
    this.emit('input', input);
  }

  private setError(port: string, message: string): void {
    if (this.errors.get(port)?.message !== message) console.warn(`[controller] ${this.nameOf(port)} (${port}): ${message}`);
    this.errors.set(port, { message, retryAt: Date.now() + RETRY_MS });
  }

  // ---------- reporting ----------

  private settingsFor(port: string): ControllerSettings {
    return this.settings.get(port) ?? defaultController(port);
  }

  private nameOf(port: string): string {
    return (this.listed.get(port) ?? this.lastListing.get(port))?.name ?? 'Unnamed controller';
  }

  private info(port: string): JoystickInfo {
    const listing = this.listed.get(port) ?? this.lastListing.get(port);
    const present = this.listed.has(port);
    const layout = this.layouts.get(port);
    const error = this.errors.get(port)?.message;
    const state = this.stateOf(port, present, error);
    return {
      port,
      kind: 'controller',
      name: this.nameOf(port),
      present,
      description: (listing?.type && TYPE_NAMES[listing.type]) || 'Game controller',
      state,
      ...(state === 'error' && error ? { error } : {}),
      channels: layout?.channels ?? [],
      labels: layout?.labels ?? [],
      ...(layout ? { layout: { axes: layout.axes, buttons: layout.buttons, hats: layout.hats } } : {}),
    };
  }

  private stateOf(port: string, present: boolean, error?: string): JoystickState {
    if (this.connections.has(port)) return 'open';
    if (!this.settingsFor(port).enabled) return 'off';
    if (!present) return 'absent';
    return error ? 'error' : 'opening';
  }

  private emitJoysticks(): void {
    const joysticks = this.getJoysticks();
    const json = JSON.stringify(joysticks);
    if (json === this.lastEmitted) return;
    this.lastEmitted = json;
    this.emit('joysticks', joysticks);
  }
}

function layoutOf({ axes, buttons, hats }: ControllerState): Layout {
  const channels: ChannelKind[] = [];
  const labels: string[] = [];
  axes.forEach((_, i) => {
    channels.push('analog');
    labels.push(`Axis ${i + 1}`);
  });
  buttons.forEach((_, i) => {
    channels.push('button');
    labels.push(`Button ${i + 1}`);
  });
  hats.forEach((_, i) => {
    for (const direction of HAT_DIRECTIONS) {
      channels.push('button');
      labels.push(`Hat ${i + 1} ${direction}`);
    }
  });
  return { axes: axes.length, buttons: buttons.length, hats: hats.length, channels, labels };
}

/** Values in channel order (see layoutOf): axes 0–1023, buttons and hat directions 0 or 1. */
function valuesOf({ axes, buttons, hats }: ControllerState): number[] {
  return [
    ...axes.map((v) => Math.round(((Math.min(Math.max(v, -1), 1) + 1) / 2) * AXIS_MAX)),
    ...buttons.map((pressed) => (pressed ? 1 : 0)),
    // "rightup" is both right and up.
    ...hats.flatMap((hat) => HAT_DIRECTIONS.map((direction) => (hat.includes(direction) ? 1 : 0))),
  ];
}
