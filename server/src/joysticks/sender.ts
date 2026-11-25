import type { JoystickInfo, JoystickInput } from '../protocol.js';
import type { Settings } from '../settings/schema.js';
import type { ChannelKind } from './mask.js';
import { resolveAnalog, resolveButton } from './mapping.js';

export interface SenderOptions {
  /** Publishes a float to a SimRail input topic. */
  publish: (topic: string, value: number) => Promise<void>;
  /** What each value of a port's lines is (from its mask). */
  channelsOf: (port: string) => ChannelKind[];
  /** At most one value per feature this often; the last one always goes out. */
  intervalMs: number;
}

interface Slot {
  /** Value waiting for the interval to pass. */
  pending: number | null;
  timer: NodeJS.Timeout | null;
  lastAt: number;
}

/**
 * Sends joystick values to the game: for each channel assigned on the selected locomotive, the
 * value its notches/areas give, published to the feature's topic.
 *
 * - Only changes are sent, so the game's own controls (keyboard, mouse) still work for a lever
 *   nobody moves. A lever between notches (outside any area) sends nothing.
 * - Nothing is sent while paused or while SimRail isn't connected. When sending starts again (resume,
 *   connect, other train, changed settings), the levers' current values are sent, so the game
 *   matches the hardware.
 */
export class JoystickSender {
  private readonly options: SenderOptions;
  private settings: Settings | null = null;
  private connected = false;
  /** port -> values of its latest line that matched the mask */
  private readonly latest = new Map<string, number[]>();
  /** topic -> last value published, as float32 (what the game receives) */
  private readonly lastSent = new Map<string, number>();
  private readonly slots = new Map<string, Slot>();
  private wasActive = false;

  constructor(options: SenderOptions) {
    this.options = options;
  }

  setSettings(settings: Settings): void {
    this.settings = settings;
    // Assignments, notches or the locomotive may have changed: bring the game in line.
    this.resync();
  }

  setConnected(connected: boolean): void {
    if (connected === this.connected) return;
    this.connected = connected;
    this.resync();
  }

  /** A line was read from a joystick. */
  onInput(input: JoystickInput): void {
    if (!input.values) return; // doesn't match the mask: keep the last good values
    this.latest.set(input.port, input.values);
    this.evaluate(input.port);
  }

  /** Ports that stopped being read no longer have current values. */
  onJoysticks(joysticks: JoystickInfo[]): void {
    for (const port of this.latest.keys()) {
      if (joysticks.find((j) => j.port === port)?.state !== 'open') this.latest.delete(port);
    }
  }

  /** Forget what was sent and send every lever's current value (e.g. a new train was loaded). */
  resync(): void {
    this.lastSent.clear();
    for (const slot of this.slots.values()) slot.pending = null;
    const active = this.isActive();
    if (active !== this.wasActive) {
      this.wasActive = active;
      console.log(active ? '[send] sending joystick values to SimRail' : `[send] not sending: ${this.whyInactive()}`);
    }
    for (const port of this.latest.keys()) this.evaluate(port);
  }

  stop(): void {
    for (const slot of this.slots.values()) if (slot.timer) clearTimeout(slot.timer);
    this.slots.clear();
  }

  private isActive(): boolean {
    return this.connected && this.settings !== null && !this.settings.paused && this.settings.locomotive !== null;
  }

  private whyInactive(): string {
    if (this.settings?.paused) return 'paused';
    if (!this.connected) return 'SimRail not connected';
    return 'no locomotive chosen';
  }

  private evaluate(port: string): void {
    const values = this.latest.get(port);
    if (!values || !this.isActive() || !this.settings) return;
    const { locomotive, bindings } = this.settings;
    const channels = this.options.channelsOf(port);
    for (const binding of bindings) {
      if (binding.locomotive !== locomotive || binding.joystick !== port) continue;
      const raw = values[binding.channel];
      if (raw === undefined) continue;
      const resolved = channels[binding.channel] === 'button' ? resolveButton(binding, raw) : resolveAnalog(binding, raw);
      if (resolved) this.queue(binding.feature, Math.fround(resolved.value));
    }
  }

  private queue(topic: string, value: number): void {
    let slot = this.slots.get(topic);
    if (!slot) {
      slot = { pending: null, timer: null, lastAt: 0 };
      this.slots.set(topic, slot);
    }
    if (slot.pending === null && this.lastSent.get(topic) === value) return; // the game has it
    slot.pending = value;
    if (slot.timer) return;
    const wait = this.options.intervalMs - (Date.now() - slot.lastAt);
    if (wait <= 0) this.flush(topic, slot);
    else slot.timer = setTimeout(() => this.flush(topic, slot), wait);
  }

  private flush(topic: string, slot: Slot): void {
    slot.timer = null;
    const value = slot.pending;
    slot.pending = null;
    if (value === null || !this.isActive() || this.lastSent.get(topic) === value) return;
    slot.lastAt = Date.now();
    this.lastSent.set(topic, value);
    this.options.publish(topic, value).catch((err: Error) => {
      // Not marked as sent, so the next change (or resync) tries again.
      if (this.lastSent.get(topic) === value) this.lastSent.delete(topic);
      console.warn(`[send] ${topic} <- ${value} failed: ${err.message}`);
    });
  }
}
