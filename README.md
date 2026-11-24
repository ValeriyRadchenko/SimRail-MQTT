# SimRail MQTT Controllers

A local app for building custom train controllers for [SimRail](https://simrail.eu) over its
[MQTT interface](https://wiki.simrail.eu/en/MQTT/Introduction).

- **Server** (TypeScript, Express, run with ts-node): connects to SimRail's MQTT broker and serves the UI.
- **Client** (plain JavaScript, no build step): talks to the server over a WebSocket.

## Running

Requires Node.js 22+.

```sh
npm install
npm start             # starts the server and opens http://127.0.0.1:8090 in your default browser
npm run dev           # same, but restarts on server changes and doesn't open a browser
npm run typecheck     # ts-node only transpiles; this does the type checking
npm run fake-simrail  # a stand-in for the game, see below
```

In SimRail, enable MQTT under **Options → Control → External input**. The broker only exists while
you are in a session (not in the main menu or depot), and toggling MQTT requires restarting the
session. Until then the app shows **Waiting for SimRail** and keeps retrying.

| Env var                  | Default                    | Purpose                                         |
| ------------------------ | -------------------------- | ----------------------------------------------- |
| `PORT`                   | `8090`                     | Local UI port                                   |
| `SIMRAIL_MQTT_HOST`      | `127.0.0.1`                | Machine running SimRail                         |
| `SIMRAIL_MQTT_PORT`      | `1883`                     | SimRail's broker port (fixed)                   |
| `SIMRAIL_MQTT_CLIENT_ID` | `simrail-mqtt-controllers` | MQTT client ID                                  |
| `SIMRAIL_POLL_MS`        | `100`                      | How often the selected input's value is polled  |
| `NO_OPEN=1`              |                            | Don't open the browser                          |

## UI

- **Testing panel**: pick an input, then drag the slider or type a value and press Enter.
  - The slider's min/max/step come from the input's description (e.g. 0–43 in whole steps for the
    drive handle, 0–1 in 0.01 steps for light intensity), with ticks at documented values and the
    meaning of the current value shown below it. Min/max/step are editable.
  - **Send while dragging** publishes as the slider moves (at most 20 values/s, always ending on the
    released position). Off: the slider only sets the value and Enter/Apply sends it.
  - The slider starts at, and follows, the input's value in game (**In game: …**), except while you
    are dragging or have typed a value you haven't sent yet.
  - Fields can mean different things per vehicle; **Description for** switches between them and is
    preselected for the train you are driving, recognised from its input topics
    (`physics_input_e6act/*` → Dragon 2), since `trainset/name` is just `trainset-Player`.
- **Joysticks**: empty for now.
- **Inputs**: every input field, titled from its snake_case name (`compressor_rq` → *Compressor
  Request*), grouped by vehicle category and filterable.

## How it talks to SimRail

Checked against the game (Dragon 2, 2026-11-24):

- Broker on port 1883, no authentication, MQTT 3.1.1.
- Messages **received** from SimRail start with a type byte: `0x01` + 4-byte float, or `0x02` + string.
- Values **published** to inputs are raw little-endian float32, without the type byte.
- Input topics are `<category lowercased>/<field>`, e.g. `physics_input_general/drive_handle`.
- `request_topics` with `all` (or a topic prefix) is answered on `request_topics_response` with
  `{"Inputs": [{"Topic", "Type", "CurrentValue"}], "Outputs": [...]}`; `CurrentValue` is a string.
  The broker keeps the last answer and hands it to new subscribers, so the app ignores that copy.
- **The game does not publish input changes on the input topics.** The only way to read an input is
  `request_topics`. The app polls the selected input with its topic as the prefix (answered in about
  1 ms, ~200 bytes) every 100 ms; that is what moves the slider when the value changes in game.
- On connect the app asks for `all`; the answer replaces the input list (badge: *Live from SimRail*).
  Until then the list comes from the wiki catalogue in `server/data/simrail-inputs.json` (badge:
  *Wiki catalogue*). The last full answer is saved to `.runtime/request_topics_response.json`.

### Corrections to the wiki

`server/data/simrail-input-overrides.json` replaces wiki descriptions per field and vehicle, with a
note on what was wrong; the UI marks them *(corrected)*. Current corrections:

- Dragon 2 (ET25 / E6ACTa) `drive_handle`: floats from -1 to 1, not the 0–4 positions the wiki lists.

## Developing without the game

`npm run fake-simrail` starts a broker that behaves like SimRail as observed above: the same
`request_topics` answers (with prefix filtering), published inputs applied, input changes not pushed,
`trainset/name` = `trainset-Player`. Its inputs come from the wiki catalogue for one vehicle. Type in
its terminal to act as the driver:

```
set drive_handle 12     move a control "in game" (field name or full topic)
get main_brake          show a value
list brake              list inputs (optionally filtered)
```

| Env var                 | Default           | Purpose                                     |
| ----------------------- | ----------------- | ------------------------------------------- |
| `FAKE_SIMRAIL_PORT`     | `1883`            | Broker port (SimRail itself must be closed) |
| `FAKE_SIMRAIL_VEHICLE`  | `4E`              | Vehicle, by name prefix, e.g. `dragon`      |
| `FAKE_SIMRAIL_TRAINSET` | `trainset-Player` | `trainset/name`                             |

## Layout

```
client/                          static frontend (served as-is)
  js/main.js                     wiring and connection status
  js/connection.js               WebSocket client, reconnects automatically
  js/inputs-view.js              Inputs column
  js/testing-panel.js            Testing panel: slider, live values
  js/value-range.js              slider range + value meanings from descriptions
  js/humanize.js                 snake_case → title
server/
  src/index.ts                   entry: Express + WebSocket + MQTT bridge, opens the browser
  src/protocol.ts                WebSocket message types
  src/value-watch.ts             which tab follows which topic
  src/simrail/bridge.ts          MQTT connection to SimRail, polling of watched inputs
  src/simrail/payload.ts         payload encoding/decoding
  src/simrail/topics.ts          request_topics_response parsing, vehicle recognition
  src/simrail/catalog.ts         wiki catalogue loader (+ corrections)
  data/simrail-inputs.json       input fields scraped from the wiki (2026-11-24)
  data/simrail-input-overrides.json  our corrections to the wiki
tools/
  fake-simrail.ts                stand-in SimRail broker for development
```
