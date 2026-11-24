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

// Paths are resolved relative to this file (server/src, two levels below the project root).
const fromHere = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

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
  openBrowser: !process.argv.includes('--no-open') && process.env.NO_OPEN !== '1',
  paths: {
    client: fromHere('../../client/'),
    catalog: fromHere('../data/simrail-inputs.json'),
    catalogOverrides: fromHere('../data/simrail-input-overrides.json'),
    runtime: fromHere('../../.runtime/'),
  },
} as const;
