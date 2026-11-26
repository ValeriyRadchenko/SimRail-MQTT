import { EventEmitter } from 'node:events';
import type { ChannelKind } from '../joysticks/mask.js';
import type { DeviceState, JoystickInfo, JoystickInput } from '../protocol.js';
import type {
  ComboDevice,
  Device,
  DeviceInput,
  PulseDevice,
  Settings,
  StepperDevice,
} from '../settings/schema.js';
import { isPressed, matchRule, nextPosition, REPEAT_DELAY_MS, REPEAT_INTERVAL_MS, samePosition } from './logic.js';

// Virtual devices: button channels that together drive one SimRail input.
//
//   combo    the buttons' states are matched against the rules, first match wins; its value is
//            sent when it changes (like a lever), null sends nothing. Unknown states send nothing.
//   stepper  a press moves the switch one position up (inputs[0]) or down (inputs[1]) from where
//            it is in game: the input is polled while the device exists. Optional repeat and wrap.
//   pulse    a press sends onPress, a release onRelease, and durationMs later `rest` is sent.
//
// Only the devices of the chosen locomotive are live. Presses while sending is off are ignored,
// so nothing piles up. When sending (re)starts, combos send their current value and pulses their
// rest value, like the levers; step switches follow the game.

/** Values of one quick run of steps remembered (holding a button with wrap on never ends). */
const MAX_UNCONFIRMED = 16;

/**
 * A step switch's sends the game hasn't reported yet: `values` in order (the last is where the
 * switch goes) and `from`, where it was before. A poll answered meanwhile may still carry `from`
 * or an earlier value; any other value means the switch was moved in game.
 */
interface Unconfirmed {
  from: number;
  values: number[];
  at: number;
}

export interface DeviceEngineOptions {
  /** Send a value to a SimRail input (rate-limited, dropped while not sending). `force`: even if
   *  it is what the game was sent last. */
  send: (topic: string, value: number, force: boolean) => void;
  /** Values reach the game now. */
  isActive: () => boolean;
  /** What each value of a joystick is: only button channels count as pressed or released. */
  channelsOf: (port: string) => ChannelKind[];
  /** Start / stop polling an input's value in game. */
  watch: (topic: string) => void;
  unwatch: (topic: string) => void;
  /** A step switch's sent value stays its position this long unless the game reports it sooner
   *  (a poll in flight while sending still carries the old value): a few poll intervals. */
  settleMs: number;
}

interface EngineEvents {
  /** A step switch's position changed. */
  state: [DeviceState];
}

/** A step switch's button being held, with repeat on. */
interface Held {
  input: DeviceInput;
  timer: NodeJS.Timeout;
}

type Edge = 'press' | 'release';

export class DeviceEngine extends EventEmitter<EngineEvents> {
  private readonly options: DeviceEngineOptions;
  /** Devices of the chosen locomotive. */
  private devices: Device[] = [];
  /** port -> values of its latest line that matched the mask */
  private readonly latest = new Map<string, number[]>();
  /** Inputs polled for step switches. */
  private watched = new Set<string>();
  /** topic -> its value in game */
  private readonly gameValues = new Map<string, number>();
  /** topic -> what a step switch sent, until the game reports it (or settleMs passed) */
  private readonly sent = new Map<string, Unconfirmed>();
  /** device id -> its held button */
  private readonly held = new Map<string, Held>();
  /** device id -> timer that ends its pulse */
  private readonly pulses = new Map<string, NodeJS.Timeout>();
  /** device id -> position last reported */
  private readonly reported = new Map<string, number | null>();
  /** Devices whose press found no value in game, warned about once. */
  private readonly warned = new Set<string>();
  private connected = false;

  constructor(options: DeviceEngineOptions) {
    super();
    this.options = options;
  }

  setSettings(settings: Settings): void {
    const { locomotive } = settings;
    this.devices = locomotive ? settings.devices.filter((d) => d.locomotive === locomotive) : [];
    this.stopHolding();

    const wanted = new Set(this.steppers().map((d) => d.feature));
    for (const topic of this.watched) {
      if (wanted.has(topic)) continue;
      this.options.unwatch(topic);
      this.gameValues.delete(topic);
      this.sent.delete(topic);
    }
    for (const topic of wanted) if (!this.watched.has(topic)) this.options.watch(topic);
    this.watched = wanted;

    const ids = new Set(this.devices.map((d) => d.id));
    for (const id of this.reported.keys()) if (!ids.has(id)) this.reported.delete(id);
    this.resync();
  }

  setConnected(connected: boolean): void {
    if (connected === this.connected) return;
    this.connected = connected;
    if (!connected) {
      // Whatever the game had is unknown until it is polled again.
      this.gameValues.clear();
      this.sent.clear();
      this.stopHolding();
    }
    this.resync();
  }

  /** Sending (re)started or another train was loaded: combos and pulses send their current value. */
  resync(): void {
    if (this.options.isActive()) {
      for (const device of this.devices) {
        if (device.type === 'combo') this.evaluateCombo(device);
        else if (device.type === 'pulse' && !this.pulses.has(device.id)) this.options.send(device.feature, device.rest, false);
      }
    }
    for (const device of this.steppers()) this.report(device);
  }

  /** A line was read from a joystick. */
  onInput(input: JoystickInput): void {
    if (!input.values) return; // doesn't match the mask: keep the last good values
    const { port, values } = input;
    const previous = this.latest.get(port);
    this.latest.set(port, values);

    for (const device of this.devices) {
      if (!device.inputs.some((i) => i.joystick === port)) continue;
      if (device.type === 'combo') {
        this.evaluateCombo(device);
        continue;
      }
      device.inputs.forEach((i, index) => {
        const edge = i.joystick === port ? this.edge(i, previous, values) : null;
        if (!edge) return;
        if (device.type === 'stepper') this.onStepperEdge(device, i, index === 0 ? 1 : -1, edge);
        else this.onPulseEdge(device, edge);
      });
    }
  }

  /** Ports that stopped being read no longer have current values. */
  onJoysticks(joysticks: JoystickInfo[]): void {
    for (const port of this.latest.keys()) {
      if (joysticks.find((j) => j.port === port)?.state === 'open') continue;
      this.latest.delete(port);
      for (const [id, held] of this.held) if (held.input.joystick === port) this.stopStepping(id);
    }
  }

  /** An input's value in game, from polling. */
  onGameValue(topic: string, value: number): void {
    if (!this.watched.has(topic)) return; // polled for a browser tab
    this.gameValues.set(topic, value);
    const sent = this.sent.get(topic);
    if (sent) {
      const stale = [sent.from, ...sent.values.slice(0, -1)].some((v) => samePosition(v, value));
      // Either the game has what was sent last, or the switch was moved in game: the game wins.
      if (!stale) this.sent.delete(topic);
    }
    for (const device of this.steppers()) if (device.feature === topic) this.report(device);
  }

  /** Positions of the step switches. */
  getStates(): DeviceState[] {
    return this.steppers().map((d) => ({ id: d.id, value: this.position(d) }));
  }

  stop(): void {
    this.stopHolding();
    for (const timer of this.pulses.values()) clearTimeout(timer);
    this.pulses.clear();
  }

  // ---------- inputs ----------

  /** Pressed, released, or null when the channel isn't a button or hasn't been read. */
  private pressed(input: DeviceInput): boolean | null {
    if (this.options.channelsOf(input.joystick)[input.channel] !== 'button') return null;
    const raw = this.latest.get(input.joystick)?.[input.channel];
    return raw === undefined ? null : isPressed(raw);
  }

  /** The button was pressed or released between two lines. The first line has no edges: a button
   *  held while the joystick is opened doesn't count as a press. */
  private edge(input: DeviceInput, previous: number[] | undefined, values: number[]): Edge | null {
    if (this.options.channelsOf(input.joystick)[input.channel] !== 'button') return null;
    const before = previous?.[input.channel];
    const after = values[input.channel];
    if (before === undefined || after === undefined || isPressed(before) === isPressed(after)) return null;
    return isPressed(after) ? 'press' : 'release';
  }

  // ---------- combo ----------

  private evaluateCombo(device: ComboDevice): void {
    if (!this.options.isActive()) return;
    const states = device.inputs.map((i) => this.pressed(i));
    if (states.some((s) => s === null)) return;
    const rule = device.rules[matchRule(device.rules, states as boolean[])];
    if (rule && rule.value !== null) this.options.send(device.feature, rule.value, false);
  }

  // ---------- stepper ----------

  private steppers(): StepperDevice[] {
    return this.devices.filter((d): d is StepperDevice => d.type === 'stepper');
  }

  /** Sends to the switch the game hasn't reported yet, unless they are too old to wait for. */
  private unconfirmed(topic: string): Unconfirmed | null {
    const sent = this.sent.get(topic);
    return sent && Date.now() - sent.at < this.options.settleMs ? sent : null;
  }

  /** Where the switch is: what was just sent, else its value in game. */
  private position(device: StepperDevice): number | null {
    const recent = this.unconfirmed(device.feature)?.values.at(-1);
    return recent ?? this.gameValues.get(device.feature) ?? this.sent.get(device.feature)?.values.at(-1) ?? null;
  }

  private onStepperEdge(device: StepperDevice, input: DeviceInput, direction: 1 | -1, edge: Edge): void {
    if (edge === 'release') {
      this.stopStepping(device.id, input);
      return;
    }
    this.stopStepping(device.id);
    if (!this.step(device, direction) || !device.repeat) return;
    const repeat = () => {
      if (this.step(device, direction)) this.held.set(device.id, { input, timer: setTimeout(repeat, REPEAT_INTERVAL_MS) });
      else this.held.delete(device.id);
    };
    this.held.set(device.id, { input, timer: setTimeout(repeat, REPEAT_DELAY_MS) });
  }

  /** Move one position; false when it can't (not sending, value unknown, at an end). */
  private step(device: StepperDevice, direction: 1 | -1): boolean {
    if (!this.options.isActive()) return false;
    const current = this.position(device);
    if (current === null) {
      if (!this.warned.has(device.id)) {
        console.warn(`[device] ${device.name}: ${device.feature} has no value in game yet; press ignored`);
        this.warned.add(device.id);
      }
      return false;
    }
    this.warned.delete(device.id);
    const next = nextPosition(device.positions, current, direction, device.wrap);
    if (next === null) return false;
    const pending = this.unconfirmed(device.feature);
    if (pending) {
      pending.values = [...pending.values, next].slice(-MAX_UNCONFIRMED);
      pending.at = Date.now();
    } else {
      this.sent.set(device.feature, { from: current, values: [next], at: Date.now() });
    }
    // Forced: the game may have moved since we last sent this value (by mouse or keyboard).
    this.options.send(device.feature, next, true);
    this.report(device);
    return true;
  }

  /** Stop repeating; with `input`, only if that is the button being held. */
  private stopStepping(id: string, input?: DeviceInput): void {
    const held = this.held.get(id);
    if (!held) return;
    if (input && (held.input.joystick !== input.joystick || held.input.channel !== input.channel)) return;
    clearTimeout(held.timer);
    this.held.delete(id);
  }

  private stopHolding(): void {
    for (const id of [...this.held.keys()]) this.stopStepping(id);
  }

  private report(device: StepperDevice): void {
    const value = this.position(device);
    if (this.reported.has(device.id) && this.reported.get(device.id) === value) return;
    this.reported.set(device.id, value);
    this.emit('state', { id: device.id, value });
  }

  // ---------- pulse ----------

  private onPulseEdge(device: PulseDevice, edge: Edge): void {
    const value = edge === 'press' ? device.onPress : device.onRelease;
    if (value === null || !this.options.isActive()) return;
    clearTimeout(this.pulses.get(device.id));
    // Forced: two pulses in a row send the same value twice, and the game reset it in between.
    this.options.send(device.feature, value, true);
    const { feature, rest } = device; // the settings may change before the pulse ends
    const timer = setTimeout(() => {
      this.pulses.delete(device.id);
      this.options.send(feature, rest, true);
    }, device.durationMs);
    this.pulses.set(device.id, timer);
  }
}
