import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function portFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new Error(`${name} must be a TCP port number, got "${raw}"`);
  }
  return value;
}

/**
 * The folder with package.json, client/ and server/data/: the project folder, or the desktop app's
 * resources. Found by going up from this file, since that is server/src/config.ts when run with
 * ts-node but dist/server/src/config.js once compiled (npm run build, the desktop app).
 */
function findAppRoot(): string {
  const start = dirname(fileURLToPath(import.meta.url));
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    if (dirname(dir) === dir) throw new Error(`No package.json found above ${start}`);
  }
}

const appRoot = findAppRoot();
const fromRoot = (relative: string) => join(appRoot, relative);
function pathFromEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value ? resolve(value) : fallback;
}

export const config = {
  http: {
    // Local-only: the UI can drive the train, so it is not exposed to the network.
    host: '127.0.0.1',
    port: portFromEnv('PORT', 8090),
  },
  mqtt: {
    host: process.env.SIMRAIL_MQTT_HOST || '127.0.0.1',
    // SimRail's broker always listens on 1883.
    port: portFromEnv('SIMRAIL_MQTT_PORT', 1883),
    clientId: process.env.SIMRAIL_MQTT_CLIENT_ID || 'simrail-mqtt-controllers',
    reconnectMs: 3000,
    // The selected input's value is polled (SimRail doesn't push input changes); answers take ~1 ms.
    pollMs: Number(process.env.SIMRAIL_POLL_MS) || 100,
  },
  joysticks: {
    /** How often the COM port list is checked for joysticks being plugged in or out. */
    listIntervalMs: 2000,
    /** Replace the real COM ports with a simulated joystick, for working without hardware. */
    fake: process.argv.includes('--fake-joystick') || process.env.FAKE_JOYSTICK === '1',
    /** At most one value per SimRail input this often (20 per second), like the testing slider. */
    sendIntervalMs: 50,
    /** List game controllers (USB joysticks, gamepads…) through SDL. */
    controllers: !process.argv.includes('--no-controllers') && process.env.NO_CONTROLLERS !== '1',
    /** How often the controllers being read are checked for changes. */
    controllerPollMs: 10,
    /** How often the controller list is checked for controllers being plugged in or out. */
    controllerListIntervalMs: 500,
  },
  openBrowser: !process.argv.includes('--no-open') && process.env.NO_OPEN !== '1',
  paths: {
    client: fromRoot('client'),
    catalog: fromRoot('server/data/simrail-inputs.json'),
    catalogOverrides: fromRoot('server/data/simrail-input-overrides.json'),
    /** SimRail's last topic list, saved for debugging. */
    runtime: pathFromEnv('RUNTIME_DIR', fromRoot('.runtime')),
    /** What the user set up in the UI (joysticks, bindings, locomotive). */
    settings: pathFromEnv('SETTINGS_FILE', fromRoot('settings/config.json')),
  },
} as const;
