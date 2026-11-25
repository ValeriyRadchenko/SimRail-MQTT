import { SerialPortMock } from 'serialport';
import type { SerialBackend } from './serial.js';

// A simulated joystick on port FAKE1, for working on the app without hardware
// (`npm run dev -- --fake-joystick`). Instead of the system's ports, only FAKE1 is listed.
// Once read, it sends "{a,a}" lines like an Arduino sketch with delay(20):
//   value 1: a lever swept smoothly from end to end every 8 s
//   value 2: a notched lever, resting in one of five notches at a time (with jitter)

export const FAKE_PORT = 'FAKE1';
const LINE_INTERVAL_MS = 20;
const NOTCHES = [60, 290, 512, 735, 960];
const NOTCH_DWELL_MS = 2500;

export function fakeSerial(): SerialBackend {
  SerialPortMock.binding.createPort(FAKE_PORT, {
    echo: false,
    record: false,
    manufacturer: 'Simulated joystick (--fake-joystick)',
  });
  return {
    list: () => SerialPortMock.list(),
    create(path, baudRate) {
      const port = new SerialPortMock({ path, baudRate, autoOpen: false });
      let timer: NodeJS.Timeout | undefined;
      port.on('open', () => {
        const start = Date.now();
        // Opening a port mid-line: the first line arrives cut off.
        port.port?.emitData('0,512}\r\n');
        timer = setInterval(() => port.port?.emitData(fakeLine(Date.now() - start)), LINE_INTERVAL_MS);
      });
      port.on('close', () => clearInterval(timer));
      return port;
    },
  };
}

function fakeLine(elapsedMs: number): string {
  const jitter = (amount: number) => (Math.random() * 2 - 1) * amount;
  const clamp = (v: number) => Math.min(1023, Math.max(0, Math.round(v)));
  const sweep = 512 + 511 * Math.sin((2 * Math.PI * elapsedMs) / 8000);
  const notch = NOTCHES[Math.floor(elapsedMs / NOTCH_DWELL_MS) % NOTCHES.length]!;
  return `{${clamp(sweep + jitter(2))},${clamp(notch + jitter(4))}}\r\n`;
}
