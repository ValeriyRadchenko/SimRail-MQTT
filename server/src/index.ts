import type { Server } from 'node:http';
import open from 'open';
import { coalesce } from './coalesce.js';
import { config } from './config.js';
import { createHttpServer } from './http.js';
import { FAKE_PORT, fakeSerial } from './joysticks/fake.js';
import { JoystickManager, systemSerial } from './joysticks/manager.js';
import { JoystickSender } from './joysticks/sender.js';
import type { ClientMessage, InputList, JoystickInput, ServerMessage } from './protocol.js';
import { parseSettingsChange } from './settings/schema.js';
import { SettingsStore } from './settings/store.js';
import { SimRailBridge } from './simrail/bridge.js';
import { loadCatalog } from './simrail/catalog.js';
import { buildLiveInputs } from './simrail/topics.js';
import { ValueWatch } from './value-watch.js';
import { ClientHub, type Client } from './ws.js';

/** Joystick values are shown in the browser at most this often (per joystick). */
const JOYSTICK_UI_INTERVAL_MS = 40;

interface Services {
  bridge: SimRailBridge;
  values: ValueWatch;
  settings: SettingsStore;
}

async function main(): Promise<void> {
  const catalog = await loadCatalog(config.paths.catalog, config.paths.catalogOverrides);
  let inputs: InputList = { source: 'catalog', items: catalog };

  const settings = await SettingsStore.open(config.paths.settings);
  const bridge = new SimRailBridge({ ...config.mqtt, runtimeDir: config.paths.runtime });
  const values = new ValueWatch(bridge);
  const joysticks = new JoystickManager({
    backend: config.joysticks.fake ? fakeSerial() : systemSerial,
    listIntervalMs: config.joysticks.listIntervalMs,
  });
  joysticks.configure(settings.get().joysticks);
  const sender = new JoystickSender({
    publish: (topic, value) => bridge.publishFloat(topic, value),
    channelsOf: (port) => joysticks.channelsOf(port),
    intervalMs: config.joysticks.sendIntervalMs,
  });
  sender.setSettings(settings.get());

  const server = createHttpServer(config.paths.client);
  const { port } = config.http;
  const allowedOrigins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];

  const hub = new ClientHub(server, allowedOrigins, {
    snapshot: (): ServerMessage[] => [
      { type: 'mqtt-status', status: bridge.getStatus() },
      { type: 'trainset', trainset: bridge.getTrainset() },
      { type: 'catalog', items: catalog },
      { type: 'inputs', inputs },
      { type: 'settings', settings: settings.get() },
      { type: 'joysticks', joysticks: joysticks.getJoysticks() },
      ...joysticks.getLatest().map((input): ServerMessage => ({ type: 'joystick-input', input })),
    ],
    onMessage: (message, client) => handleClientMessage({ bridge, values, settings }, message, client),
    onDisconnect: (client) => values.set(client, null),
  });

  settings.on('change', (next) => {
    joysticks.configure(next.joysticks); // first: the sender reads channel kinds from the masks
    sender.setSettings(next);
    hub.broadcast({ type: 'settings', settings: next });
  });
  joysticks.on('joysticks', (list) => {
    sender.onJoysticks(list);
    hub.broadcast({ type: 'joysticks', joysticks: list });
  });
  const showInput = coalesce<string, JoystickInput>(JOYSTICK_UI_INTERVAL_MS, (input) =>
    hub.broadcast({ type: 'joystick-input', input }),
  );
  joysticks.on('input', (input) => {
    sender.onInput(input);
    showInput(input.port, input);
  });

  bridge.on('status', (status) => {
    sender.setConnected(status.state === 'connected');
    hub.broadcast({ type: 'mqtt-status', status });
  });
  bridge.on('trainset', (trainset) => hub.broadcast({ type: 'trainset', trainset }));
  bridge.on('topics', (topics) => {
    const { items, vehicle } = buildLiveInputs(topics, catalog);
    if (items.length === 0) {
      console.warn('[mqtt] no input topics recognised in the response; keeping the current list');
      return;
    }
    if (vehicle) console.log(`[mqtt] vehicle: ${vehicle}`);
    inputs = { source: 'live', items, vehicle };
    hub.broadcast({ type: 'inputs', inputs });
    // Possibly another train (or the same one reloaded): give it the levers' positions.
    sender.resync();
  });

  await listen(server, port, config.http.host);
  // 127.0.0.1 rather than "localhost": some browsers resolve localhost to ::1 first.
  const url = `http://127.0.0.1:${port}/`;
  console.log(`[http] UI at ${url}`);

  bridge.start();
  console.log(`[mqtt] waiting for SimRail broker at ${bridge.getStatus().broker}`);

  joysticks.start();
  if (config.joysticks.fake) console.log(`[joystick] simulated joystick on ${FAKE_PORT}; system ports are not used`);

  if (config.openBrowser) {
    open(url).catch((err: Error) => console.warn(`[http] could not open a browser (${err.message}); open ${url} manually`));
  }

  const shutdown = async () => {
    console.log('\nShutting down…');
    sender.stop();
    hub.close();
    server.close();
    await Promise.all([bridge.stop().catch(() => {}), joysticks.stop().catch(() => {}), settings.flush()]);
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

async function handleClientMessage(
  { bridge, values, settings }: Services,
  message: ClientMessage,
  client: Client,
): Promise<void> {
  switch (message.type) {
    case 'publish': {
      const { requestId, topic, value } = message;
      try {
        await bridge.publishFloat(topic, value);
        console.log(`[mqtt] ${topic} <- ${value}`);
        client.send({ type: 'publish-result', requestId, ok: true, topic, value });
      } catch (err) {
        client.send({ type: 'publish-result', requestId, ok: false, topic, value, error: (err as Error).message });
      }
      break;
    }
    case 'request-topics':
      await bridge.requestTopics();
      break;
    case 'watch':
      values.set(client, message.topic);
      break;
    case 'update-settings': {
      const { requestId } = message;
      try {
        await settings.update(parseSettingsChange(message.change));
        client.send({ type: 'result', requestId, ok: true });
      } catch (err) {
        client.send({ type: 'result', requestId, ok: false, error: (err as Error).message });
      }
      break;
    }
  }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(`Port ${port} is already in use. Is the app already running? Set PORT to use another port.`)
          : err,
      );
    });
    server.listen(port, host, () => resolve());
  });
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
