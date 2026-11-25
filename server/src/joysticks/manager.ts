import { EventEmitter } from 'node:events';
import type { JoystickInfo, JoystickInput } from '../protocol.js';
import {
  isControllerPort,
  isSerialSettings,
  type ControllerSettings,
  type JoystickSettings,
} from '../settings/schema.js';
import type { GameControllers } from './controllers.js';
import type { ChannelKind } from './mask.js';
import type { SerialJoysticks } from './serial.js';

interface ManagerEvents {
  /** The list of joysticks or their state changed. */
  joysticks: [JoystickInfo[]];
  /** Values read from a joystick. */
  input: [JoystickInput];
}

/**
 * All joysticks: serial ports (serial.ts) and game controllers (controllers.ts; null when SDL
 * couldn't be loaded or controllers are turned off). Hands each its settings and merges their lists.
 */
export class JoystickManager extends EventEmitter<ManagerEvents> {
  private readonly serial: SerialJoysticks;
  private readonly controllers: GameControllers | null;

  constructor(sources: { serial: SerialJoysticks; controllers: GameControllers | null }) {
    super();
    this.serial = sources.serial;
    this.controllers = sources.controllers;
    const emitList = () => this.emit('joysticks', this.getJoysticks());
    const emitInput = (input: JoystickInput) => this.emit('input', input);
    this.serial.on('joysticks', emitList).on('input', emitInput);
    this.controllers?.on('joysticks', emitList).on('input', emitInput);
  }

  start(): void {
    this.serial.start();
    this.controllers?.start();
  }

  async stop(): Promise<void> {
    await Promise.all([this.serial.stop(), this.controllers?.stop()]);
  }

  configure(joysticks: JoystickSettings[]): void {
    this.serial.configure(joysticks.filter(isSerialSettings));
    this.controllers?.configure(joysticks.filter((j): j is ControllerSettings => isControllerPort(j.port)));
  }

  /** Serial ports, then controllers. */
  getJoysticks(): JoystickInfo[] {
    return [...this.serial.getJoysticks(), ...(this.controllers?.getJoysticks() ?? [])];
  }

  /** Latest values of each joystick being read. */
  getLatest(): JoystickInput[] {
    return [...this.serial.getLatest(), ...(this.controllers?.getLatest() ?? [])];
  }

  /** What each value of the joystick is. */
  channelsOf(port: string): ChannelKind[] {
    if (isControllerPort(port)) return this.controllers?.channelsOf(port) ?? [];
    return this.serial.channelsOf(port);
  }
}
