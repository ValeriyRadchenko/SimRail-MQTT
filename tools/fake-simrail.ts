// Fake SimRail MQTT broker, for working on the app without the game running.
//
//   npm run fake-simrail                                    # 4E (EU07/EP07) on 127.0.0.1:1883
//   FAKE_SIMRAIL_VEHICLE=dragon npm run fake-simrail        # any vehicle from the wiki catalogue
//   FAKE_SIMRAIL_PORT=18830 npm run fake-simrail            # pair with SIMRAIL_MQTT_PORT=18830
//
// Mirrors what the real game does (checked against SimRail with a Dragon 2):
// - payloads it publishes are type-tagged (0x01 + float32 LE, 0x02 + UTF-8 string)
// - `request_topics` with "all" or a topic prefix is answered on `request_topics_response` as
//   { "Inputs": [{ "Topic", "Type", "CurrentValue" }], "Outputs": [...] }, CurrentValue a string;
//   the broker keeps the last answer and hands it to new subscribers
// - raw float32 values published to an input topic change that input
// - input changes are NOT published on the input topics; only request_topics reports them
// - trainset/name is "trainset-Player"; there is no trainset/vehicle_designation
//
// Type commands in this terminal to act as the driver, e.g. `set drive_handle 12`.

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Aedes } from 'aedes';
import { catalogTopic } from '../server/src/simrail/catalog.js';

interface CatalogFile {
  inputs: Array<{ category: string; name: string; vehicles: string[] }>;
}

const PORT = Number(process.env.FAKE_SIMRAIL_PORT || 1883);
const VEHICLE_QUERY = (process.env.FAKE_SIMRAIL_VEHICLE || '4E').toLowerCase();
const TRAINSET_NAME = process.env.FAKE_SIMRAIL_TRAINSET || 'trainset-Player';
const CATALOG = fileURLToPath(new URL('../server/data/simrail-inputs.json', import.meta.url));

const tagString = (text: string) => Buffer.concat([Buffer.from([0x02]), Buffer.from(text, 'utf8')]);
const log = (message: string) => console.log(`[fake] ${message}`);

// ---------- the "train" ----------

const catalog = JSON.parse(await readFile(CATALOG, 'utf8')) as CatalogFile;
const vehicles = [...new Set(catalog.inputs.flatMap((i) => i.vehicles))].filter((v) => !v.startsWith('Common')).sort();
const vehicle =
  vehicles.find((v) => v.toLowerCase().startsWith(VEHICLE_QUERY)) ??
  vehicles.find((v) => v.toLowerCase().includes(VEHICLE_QUERY));
if (!vehicle) {
  console.error(`No vehicle matches "${VEHICLE_QUERY}". Known vehicles:\n  ${vehicles.join('\n  ')}`);
  process.exit(1);
}

/** Input topic -> current value. */
const inputs = new Map<string, number>(
  catalog.inputs.filter((i) => i.vehicles.includes(vehicle)).map((i) => [catalogTopic(i.category, i.name), 0]),
);
/** Output topic -> [type, CurrentValue as the game formats it]. */
const outputs = new Map<string, ['float' | 'string', string]>([
  ['etcs/is_ready', ['float', '0']],
  ['physics_output_general/cab_light', ['float', '']],
  ['physics_output_general/time_hours', ['float', '']],
  ['trainset/name', ['string', TRAINSET_NAME]],
  ['trainset/mass', ['float', '120000']],
  ['trainset/braking_factor', ['float', '120.8333']],
]);

// ---------- broker ----------

const broker = await Aedes.createBroker();

function publish(topic: string, payload: Buffer, retain: boolean): void {
  broker.publish({ cmd: 'publish', topic, payload, qos: 0, retain, dup: false }, () => {});
}

function setInput(topic: string, value: number, by: string): void {
  inputs.set(topic, value);
  log(`${by}: ${topic} = ${value}`);
}

function topicsResponse(filter: string): string {
  const match = (topic: string) => filter === 'all' || topic.startsWith(filter);
  return JSON.stringify({
    Inputs: [...inputs]
      .filter(([topic]) => match(topic))
      .map(([topic, value]) => ({ Topic: topic, Type: 'float', CurrentValue: String(value) })),
    Outputs: [...outputs]
      .filter(([topic]) => match(topic))
      .map(([topic, [type, value]]) => ({ Topic: topic, Type: type, CurrentValue: value })),
  });
}

let polls = 0;
broker.on('publish', (packet, client) => {
  if (!client) return; // published by the broker itself
  const payload = Buffer.isBuffer(packet.payload) ? packet.payload : Buffer.from(packet.payload);

  if (packet.topic === 'request_topics') {
    const filter = payload.toString('utf8').trim() || 'all';
    // Polls arrive many times a second; only log full requests and every 50th poll.
    if (filter === 'all') log(`${client.id} requested all topics`);
    else if (++polls % 50 === 1) log(`${client.id} polling "${filter}" (${polls} so far)`);
    publish('request_topics_response', tagString(topicsResponse(filter)), true);
    return;
  }
  if (!inputs.has(packet.topic)) {
    log(`${client.id} published to unknown topic ${packet.topic} (${payload.length} bytes), ignored`);
    return;
  }
  if (payload.length !== 4) {
    log(`${client.id} sent ${payload.length} bytes to ${packet.topic}; expected a raw 4-byte float, ignored`);
    return;
  }
  const value = Number(payload.readFloatLE(0).toPrecision(7));
  setTimeout(() => setInput(packet.topic, value, client.id), 10); // applied on the next game frame
});

broker.on('subscribe', (subscriptions, client) => {
  log(`${client.id} subscribed ${subscriptions.map((s) => s.topic).join(', ')}`);
});

publish('trainset/name', tagString(TRAINSET_NAME), true);

const server = createServer(broker.handle);
server.on('error', (err: NodeJS.ErrnoException) => {
  console.error(
    err.code === 'EADDRINUSE'
      ? `Port ${PORT} is in use. Is SimRail (or another broker) running? Set FAKE_SIMRAIL_PORT to use another port.`
      : err.message,
  );
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  log(`SimRail broker on 127.0.0.1:${PORT}, ${vehicle}, ${inputs.size} inputs`);
  log('type "help" for commands');
});

// ---------- console: act as the driver ----------

function resolveTopic(arg: string): string | undefined {
  if (inputs.has(arg)) return arg;
  const matches = [...inputs.keys()].filter((t) => t.endsWith(`/${arg}`));
  if (matches.length > 1) log(`"${arg}" is ambiguous: ${matches.join(', ')}`);
  return matches.length === 1 ? matches[0] : undefined;
}

const HELP = `commands:
  set <field|topic> <value>   move a control in game, e.g. "set drive_handle 12"
  get <field|topic>           show a control's value
  list [filter]               list input topics and values
  quit                        stop the fake broker`;

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const [command, arg, value] = line.trim().split(/\s+/);
  switch (command) {
    case undefined:
    case '':
      return;
    case 'set': {
      const topic = arg && resolveTopic(arg);
      const number = Number(value);
      if (!topic || value === undefined || !Number.isFinite(number)) return log('usage: set <field|topic> <number>');
      return setInput(topic, number, 'driver');
    }
    case 'get': {
      const topic = arg && resolveTopic(arg);
      return log(topic ? `${topic} = ${inputs.get(topic)}` : 'usage: get <field|topic>');
    }
    case 'list':
      for (const [topic, v] of inputs) if (!arg || topic.includes(arg)) console.log(`  ${topic} = ${v}`);
      return;
    case 'quit':
    case 'exit':
      process.exit(0);
    case 'help':
      return console.log(HELP);
    default:
      return log(`unknown command "${command}"; type "help"`);
  }
});
