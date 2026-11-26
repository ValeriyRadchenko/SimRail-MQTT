import { SerialPortMock } from 'serialport';
import type { SerialBackend } from './serial.js';

// Simulated joysticks, for working on the app without hardware (`npm run dev -- --fake-joystick`).
// Instead of the system's ports, only FAKE1 and FAKE2 are listed. Once read, they send lines like
// an Arduino sketch with delay(20):
//
// FAKE1, "{a,a}":
//   value 1: a lever swept smoothly from end to end every 8 s
//   value 2: a notched lever, resting in one of five notches at a time (with jitter)
//
// FAKE2, "{b,b,b,b}" (set this mask in its settings), four buttons repeating every 8 s:
//   0–1 s button 1, 2–3 s button 2, 4–5 s buttons 1 and 2   (try a button combination)
//   6.0 s and 6.4 s button 3 tapped, 7.2 s button 4 tapped  (try a step switch: up, up, down)

export const FAKE_PORT = 'FAKE1';
export const FAKE_BUTTONS_PORT = 'FAKE2';
const LINE_INTERVAL_MS = 20;
const NOTCHES = [60, 290, 512, 735, 960];
const NOTCH_DWELL_MS = 2500;
const BUTTON_CYCLE_MS = 8000;
const TAP_MS = 200;

export function fakeSerial(): SerialBackend {
  SerialPortMock.binding.createPort(FAKE_PORT, {
    echo: false,
    record: false,
    manufacturer: 'Simulated joystick (--fake-joystick)',
  });
  SerialPortMock.binding.createPort(FAKE_BUTTONS_PORT, {
    echo: false,
    record: false,
    manufacturer: 'Simulated buttons, mask {b,b,b,b} (--fake-joystick)',
  });
  return {
    list: () => SerialPortMock.list(),
    create(path, baudRate) {
      const port = new SerialPortMock({ path, baudRate, autoOpen: false });
      const line = path === FAKE_BUTTONS_PORT ? buttonsLine : leversLine;
      let timer: NodeJS.Timeout | undefined;
      port.on('open', () => {
        const start = Date.now();
        // Opening a port mid-line: the first line arrives cut off.
        port.port?.emitData('0,512}\r\n');
        timer = setInterval(() => port.port?.emitData(line(Date.now() - start)), LINE_INTERVAL_MS);
      });
      port.on('close', () => clearInterval(timer));
      return port;
    },
  };
}

function leversLine(elapsedMs: number): string {
  const jitter = (amount: number) => (Math.random() * 2 - 1) * amount;
  const clamp = (v: number) => Math.min(1023, Math.max(0, Math.round(v)));
  const sweep = 512 + 511 * Math.sin((2 * Math.PI * elapsedMs) / 8000);
  const notch = NOTCHES[Math.floor(elapsedMs / NOTCH_DWELL_MS) % NOTCHES.length]!;
  return `{${clamp(sweep + jitter(2))},${clamp(notch + jitter(4))}}\r\n`;
}

function buttonsLine(elapsedMs: number): string {
  const t = elapsedMs % BUTTON_CYCLE_MS;
  const held = (from: number, to: number) => t >= from && t < to;
  const tapped = (...at: number[]) => at.some((start) => held(start, start + TAP_MS));
  const b1 = held(0, 1000) || held(4000, 5000);
  const b2 = held(2000, 3000) || held(4000, 5000);
  const b3 = tapped(6000, 6400);
  const b4 = tapped(7200);
  return `{${[b1, b2, b3, b4].map(Number).join(',')}}\r\n`;
}
