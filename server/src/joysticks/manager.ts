import { EventEmitter } from 'node:events';
import { SerialPort } from 'serialport';
import type { JoystickInfo, JoystickInput, JoystickState } from '../protocol.js';
import { comparePorts, defaultJoystick, type JoystickSettings } from '../settings/schema.js';
import { compileMask, type ChannelKind, type CompiledMask } from './mask.js';

/** A port as the system lists it. */
export interface PortListing {
  path: string;
  friendlyName?: string;
  manufacturer?: string;
}

/** The parts of a serialport stream the manager uses. */
export interface SerialConnection {
  open(callback: (err: Error | null) => void): void;
  close(callback?: (err: Error | null) => void): void;
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'close', listener: (err?: Error & { disconnected?: boolean }) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

/** Where ports come from: the system's, or simulated ones (see fake.ts). */
export interface SerialBackend {
  list(): Promise<PortListing[]>;
  /** A connection to `path`, not opened yet. */
  create(path: string, baudRate: number): SerialConnection;
}

export const systemSerial: SerialBackend = {
  list: () => SerialPort.list(),
  create: (path, baudRate) => new SerialPort({ path, baudRate, autoOpen: false }),
};

/** Lines are short; this much text without a line break means wrong baud rate or not a joystick. */
const MAX_LINE_LENGTH = 1024;
/** After a port failed to open or was lost, wait this long before trying again. */
const RETRY_MS = 3000;

interface Connection {
  conn: SerialConnection;
  baudRate: number;
  phase: 'opening' | 'open' | 'closing';
  /** Text received after the last line break. */
  pending: string;
}

interface ManagerEvents {
  /** The list of ports or their state changed. */
  joysticks: [JoystickInfo[]];
  /** Every line read, as it arrives. */
  input: [JoystickInput];
}

/**
 * Finds serial ports, reads the ones the user turned on, and turns each line into values using
 * the port's mask. Ports come and go (USB): the list is checked every few seconds, ports are
 * opened when they appear and retried when they fail.
 */
export class JoystickManager extends EventEmitter<ManagerEvents> {
  private readonly backend: SerialBackend;
  private readonly listIntervalMs: number;
  private settings = new Map<string, JoystickSettings>();
  private readonly masks = new Map<string, CompiledMask>();
  private listed = new Map<string, PortListing>();
  private readonly connections = new Map<string, Connection>();
  private readonly errors = new Map<string, { message: string; retryAt: number }>();
  private readonly latest = new Map<string, JoystickInput>();
  private listTimer: NodeJS.Timeout | null = null;
  private listError: string | null = null;
  private lastEmitted = '';
  private stopped = false;

  constructor(options: { backend: SerialBackend; listIntervalMs: number }) {
    super();
    this.backend = options.backend;
    this.listIntervalMs = options.listIntervalMs;
  }

  start(): void {
    this.stopped = false;
    void this.refresh();
    this.listTimer = setInterval(() => void this.refresh(), this.listIntervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.listTimer) clearInterval(this.listTimer);
    this.listTimer = null;
    await Promise.all(
      [...this.connections.values()].map(
        (c) => new Promise<void>((resolve) => (c.phase === 'open' ? c.conn.close(() => resolve()) : resolve())),
      ),
    );
  }

  /** Apply the user's port settings: opens, closes or reopens ports as needed. */
  configure(joysticks: JoystickSettings[]): void {
    const previous = this.settings;
    this.settings = new Map(joysticks.map((j) => [j.port, j]));
    for (const [port, next] of this.settings) {
      const before = previous.get(port);
      if (before?.mask !== next.mask) {
        this.masks.delete(port);
        this.reparseLatest(port);
      }
      // The user changed something: worth trying again right away.
      if (before?.enabled !== next.enabled || before?.baudRate !== next.baudRate) this.errors.delete(port);
    }
    this.reconcile();
  }

  getJoysticks(): JoystickInfo[] {
    const enabled = [...this.settings.values()].filter((s) => s.enabled).map((s) => s.port);
    const ports = new Set([...this.listed.keys(), ...enabled]);
    return [...ports].sort(comparePorts).map((port) => this.info(port));
  }

  /** Latest line of each port being read. */
  getLatest(): JoystickInput[] {
    return [...this.latest.values()].filter((input) => this.connections.get(input.port)?.phase === 'open');
  }

  /** What each value in the port's lines is, from its mask. */
  channelsOf(port: string): ChannelKind[] {
    return this.maskFor(port).channels;
  }

  // ---------- ports ----------

  private settingsFor(port: string): JoystickSettings {
    return this.settings.get(port) ?? defaultJoystick(port);
  }

  private maskFor(port: string): CompiledMask {
    let mask = this.masks.get(port);
    if (!mask) {
      // Settings are validated when saved, so the mask compiles.
      mask = compileMask(this.settingsFor(port).mask);
      this.masks.set(port, mask);
    }
    return mask;
  }

  private async refresh(): Promise<void> {
    try {
      const ports = await this.backend.list();
      this.listed = new Map(ports.map((p) => [p.path, p]));
      this.listError = null;
    } catch (err) {
      const message = (err as Error).message;
      if (message !== this.listError) console.warn(`[joystick] could not list serial ports: ${message}`);
      this.listError = message;
    }
    this.reconcile();
  }

  /** Open what should be open, close what shouldn't, then report. */
  private reconcile(): void {
    if (this.stopped) return;
    const ports = new Set([...this.listed.keys(), ...this.settings.keys(), ...this.connections.keys()]);
    for (const port of ports) {
      const settings = this.settingsFor(port);
      const wanted = settings.enabled && this.listed.has(port);
      const connection = this.connections.get(port);
      if (connection) {
        // Opening and closing ports are dealt with once that finishes.
        if (connection.phase === 'open' && (!wanted || connection.baudRate !== settings.baudRate)) {
          this.close(port, connection);
        }
      } else if (wanted) {
        const error = this.errors.get(port);
        if (!error || Date.now() >= error.retryAt) this.open(port, settings.baudRate);
      } else if (!settings.enabled) {
        this.errors.delete(port);
      }
    }
    this.emitJoysticks();
  }

  private open(port: string, baudRate: number): void {
    let conn: SerialConnection;
    try {
      conn = this.backend.create(port, baudRate);
    } catch (err) {
      this.setError(port, (err as Error).message);
      return;
    }
    const connection: Connection = { conn, baudRate, phase: 'opening', pending: '' };
    this.connections.set(port, connection);

    conn.on('data', (chunk) => this.onData(port, connection, chunk));
    conn.on('error', (err) => {
      // Usually followed by 'close'; keep the reason to show it.
      console.warn(`[joystick] ${port}: ${err.message}`);
      this.errors.set(port, { message: err.message, retryAt: Date.now() + RETRY_MS });
    });
    conn.on('close', (err) => this.onClose(port, connection, err));

    conn.open((err) => {
      if (this.connections.get(port) !== connection) return;
      if (err) {
        this.connections.delete(port);
        this.setError(port, err.message);
        this.emitJoysticks();
        return;
      }
      connection.phase = 'open';
      this.errors.delete(port);
      console.log(`[joystick] reading ${port} at ${baudRate} baud`);
      if (this.stopped) {
        this.close(port, connection);
        return;
      }
      // Settings may have changed while the port was opening.
      this.reconcile();
    });
    this.emitJoysticks();
  }

  private close(port: string, connection: Connection): void {
    connection.phase = 'closing';
    connection.conn.close((err) => {
      if (err) console.warn(`[joystick] closing ${port}: ${err.message}`);
    });
  }

  private onClose(port: string, connection: Connection, err?: Error & { disconnected?: boolean }): void {
    if (this.connections.get(port) !== connection) return;
    this.connections.delete(port);
    this.latest.delete(port);
    if (connection.phase === 'closing') {
      console.log(`[joystick] stopped reading ${port}`);
    } else {
      this.setError(port, err?.disconnected ? 'Disconnected' : (this.errors.get(port)?.message ?? 'Port closed'));
    }
    this.reconcile();
  }

  private setError(port: string, message: string): void {
    if (this.errors.get(port)?.message !== message) console.warn(`[joystick] ${port}: ${message}`);
    this.errors.set(port, { message, retryAt: Date.now() + RETRY_MS });
  }

  // ---------- lines ----------

  private onData(port: string, connection: Connection, chunk: Buffer): void {
    // Joysticks send ASCII; latin1 maps every byte to one character, so nothing is lost or merged.
    let text = connection.pending + chunk.toString('latin1');
    let lineBreak: number;
    while ((lineBreak = text.search(/[\r\n]/)) !== -1) {
      this.onLine(port, text.slice(0, lineBreak));
      text = text.slice(lineBreak + 1);
    }
    connection.pending = text.length > MAX_LINE_LENGTH ? '' : text;
  }

  private onLine(port: string, raw: string): void {
    const line = raw.trim();
    if (line === '') return; // the \n of a \r\n, or blank lines
    const input: JoystickInput = {
      port,
      line: printable(line),
      values: this.maskFor(port).parse(line),
      receivedAt: Date.now(),
    };
    this.latest.set(port, input);
    this.emit('input', input);
  }

  /** After a mask change, show what the last line means with the new mask. */
  private reparseLatest(port: string): void {
    const latest = this.latest.get(port);
    if (!latest) return;
    const input = { ...latest, values: this.maskFor(port).parse(latest.line) };
    this.latest.set(port, input);
    this.emit('input', input);
  }

  // ---------- reporting ----------

  private info(port: string): JoystickInfo {
    const listing = this.listed.get(port);
    const settings = this.settingsFor(port);
    const error = this.errors.get(port)?.message;
    const state = this.stateOf(port, settings, Boolean(listing), error);
    return {
      port,
      present: Boolean(listing),
      description: describePort(listing),
      state,
      ...(state === 'error' && error ? { error } : {}),
      channels: this.maskFor(port).channels,
    };
  }

  private stateOf(port: string, settings: JoystickSettings, present: boolean, error?: string): JoystickState {
    const connection = this.connections.get(port);
    if (connection?.phase === 'open') return 'open';
    if (connection) return settings.enabled ? 'opening' : 'off'; // closing: reopening for a new baud rate
    if (!settings.enabled) return 'off';
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

/** "USB-SERIAL CH340 (COM3)" -> "USB-SERIAL CH340" */
function describePort(listing: PortListing | undefined): string | null {
  const name = listing?.friendlyName?.replace(/\s*\((COM\d+|[^)]*tty[^)]*)\)\s*$/i, '').trim();
  return name || listing?.manufacturer || null;
}

const printable = (line: string) => line.replace(/[^\x20-\x7e]/g, '�').slice(0, 200);
