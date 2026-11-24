import type { Server } from 'node:http';
import open from 'open';
import { config } from './config.js';
import { createHttpServer } from './http.js';
import type { ClientMessage, InputList, ServerMessage } from './protocol.js';
import { SimRailBridge } from './simrail/bridge.js';
import { loadCatalog } from './simrail/catalog.js';
import { buildLiveInputs } from './simrail/topics.js';
import { ValueWatch } from './value-watch.js';
import { ClientHub, type Client } from './ws.js';

async function main(): Promise<void> {
  const catalog = await loadCatalog(config.paths.catalog, config.paths.catalogOverrides);
  let inputs: InputList = { source: 'catalog', items: catalog };

  const bridge = new SimRailBridge({ ...config.mqtt, runtimeDir: config.paths.runtime });
  const values = new ValueWatch(bridge);

  const server = createHttpServer(config.paths.client);
  const { port } = config.http;
  const allowedOrigins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];

  const hub = new ClientHub(server, allowedOrigins, {
    snapshot: (): ServerMessage[] => [
      { type: 'mqtt-status', status: bridge.getStatus() },
      { type: 'trainset', trainset: bridge.getTrainset() },
      { type: 'inputs', inputs },
    ],
    onMessage: (message, client) => handleClientMessage(bridge, values, message, client),
    onDisconnect: (client) => values.set(client, null),
  });

  bridge.on('status', (status) => hub.broadcast({ type: 'mqtt-status', status }));
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
  });

  await listen(server, port, config.http.host);
  // 127.0.0.1 rather than "localhost": some browsers resolve localhost to ::1 first.
  const url = `http://127.0.0.1:${port}/`;
  console.log(`[http] UI at ${url}`);

  bridge.start();
  console.log(`[mqtt] waiting for SimRail broker at ${bridge.getStatus().broker}`);

  if (config.openBrowser) {
    open(url).catch((err: Error) => console.warn(`[http] could not open a browser (${err.message}); open ${url} manually`));
  }

  const shutdown = async () => {
    console.log('\nShutting down…');
    hub.close();
    server.close();
    await bridge.stop().catch(() => {});
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

async function handleClientMessage(
  bridge: SimRailBridge,
  values: ValueWatch,
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
