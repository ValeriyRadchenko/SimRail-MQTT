import { ServerConnection } from './connection.js';
import { InputsView } from './inputs-view.js';
import { TestingPanel } from './testing-panel.js';

const $ = (id) => document.getElementById(id);

const state = {
  serverOnline: false,
  /** @type {{ state: 'connected' | 'waiting', broker: string, error?: string } | null} */
  mqtt: null,
  /** @type {{ name: string | null, vehicleDesignation: string | null } | null} */
  trainset: null,
  /** Vehicle the server recognised from the live topics, e.g. "Dragon 2 (ET25 / E6ACTa)". */
  vehicle: null,
};

const connection = new ServerConnection(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);

const testingPanel = new TestingPanel(document, {
  onApply: (topic, value) => connection.publish(topic, value),
  onWatch: (topic) => connection.watch(topic),
});

const inputsView = new InputsView(
  { list: $('inputs-list'), filter: $('inputs-filter'), count: $('inputs-count'), source: $('inputs-source') },
  (item, { byUser }) => testingPanel.select(item, { focus: byUser }),
);

const refreshButton = $('refresh-topics');
refreshButton.addEventListener('click', () => connection.requestTopics());

function render() {
  const mqttConnected = state.serverOnline && state.mqtt?.state === 'connected';

  const status = $('status');
  const text = $('status-text');
  if (!state.serverOnline) {
    status.dataset.state = 'offline';
    text.textContent = 'Local server offline. Reconnecting…';
    status.title = '';
  } else if (mqttConnected) {
    status.dataset.state = 'connected';
    text.textContent = `Connected to SimRail · ${state.mqtt.broker}`;
    status.title = '';
  } else {
    status.dataset.state = 'waiting';
    text.textContent = `Waiting for SimRail · ${state.mqtt?.broker ?? ''}`;
    status.title = state.mqtt?.error ?? '';
  }

  const trainset = $('trainset');
  const { name, vehicleDesignation } = state.trainset ?? {};
  const parts = [name, state.vehicle ?? vehicleDesignation].filter(Boolean);
  trainset.hidden = !(mqttConnected && parts.length);
  trainset.textContent = parts.join(' · ');

  refreshButton.disabled = !mqttConnected;
  inputsView.setConnected(mqttConnected);

  testingPanel.setContext({
    serverOnline: state.serverOnline,
    mqttConnected,
    mqttError: state.mqtt?.error ?? null,
    trainset: state.trainset,
    vehicle: state.vehicle,
  });
}

connection.addEventListener('open', () => {
  state.serverOnline = true;
  render();
});

connection.addEventListener('close', () => {
  state.serverOnline = false;
  render();
});

connection.addEventListener('message', ({ detail: message }) => {
  switch (message.type) {
    case 'mqtt-status':
      state.mqtt = message.status;
      break;
    case 'trainset':
      state.trainset = message.trainset;
      break;
    case 'inputs':
      state.vehicle = message.inputs.vehicle ?? null;
      inputsView.setInputs(message.inputs);
      break;
    case 'value':
      // Frequent while the game moves a control: update the panel only, skip the full render.
      testingPanel.setGameValue(message.topic, message.value, message.receivedAt);
      return;
  }
  render();
});

render();
connection.connect();
