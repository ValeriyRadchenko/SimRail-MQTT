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
npm run dev -- --fake-joystick   # a simulated joystick instead of the COM ports, see below
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
| `FAKE_JOYSTICK=1`        |                            | Same as `--fake-joystick`                       |
| `SETTINGS_FILE`          | `settings/config.json`     | Where UI settings are saved (e.g. for testing)  |

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
- **Joysticks**: serial (COM) ports and what their channels do on the chosen locomotive, see below.
- **Inputs**: every input field, titled from its snake_case name (`compressor_rq` → *Compressor
  Request*), grouped by vehicle category and filterable.

## Joysticks

Joysticks are serial devices (e.g. an Arduino) that print one line of values per reading, such as
`{512,340}`. The port list is checked every 2 seconds; every port is listed, and only the ones with
**Read** turned on are opened (opening a port resets most Arduinos and keeps other programs, like
the Arduino IDE, from using it). Read ports are reopened when they are plugged back in.

- **Settings** (per port): the **mask** and the baud rate (default 9600). In the mask, `a` is an
  analog value (a whole number, 0–1023 from `analogRead`), `b` a button (0 released, 1 pressed), and
  everything else has to appear in the line as written; spaces around it don't matter. The default
  `{a,a}` reads `{512,340}` as two axes; `{a,a,b}` reads `{512,340,1}`. A line that doesn't match
  (e.g. the first one, cut off when the port is opened) is skipped, and the card says so.
- **Locomotive**: the train whose assignments are shown and edited. Preselected the first time a
  train is recognised in game.
- **Assign / Edit** (per channel): the **feature** (SimRail input) the channel drives on that
  locomotive and how its values map:
  - **Notches**: a raw position and the value it gives. The lever counts as in a notch within
    ± **tolerance** (default 20) of its position. *Add notch* adds one at the lever's current
    position; *Capture* moves a position there.
  - **Analog areas**: raw *from*–*to* mapped linearly onto *value from*–*value to* (from > to
    reverses the direction). Notches win where they overlap an area.
  - Buttons: the values for pressed and released (default 1 and 0).

  The track at the top shows the areas, notch bands and the lever, and what the current position
  maps to, before anything is saved.

### Sending to SimRail

The values of the chosen locomotive's assigned channels are sent to their features (input topics)
while SimRail is connected. The panel header shows the state: **Sending to SimRail**, **Sending
paused** or **SimRail not connected**; values on the cards are greyed out when they don't reach the
game.

- **Only changes are sent**, at most 20 per second per feature (always ending on the final
  position), so the game's own controls still work for a lever nobody touches.
- **Between notches / outside every area nothing is sent**: the game keeps the last value (the card
  says *keeps last value*).
- **Pause sending** stops sending; the joysticks are still read and shown, so mappings can be tried
  out without moving the train. It is saved, so it stays paused after a restart.
- When sending (re)starts (resume, SimRail connects, a train is loaded, settings saved) the levers'
  current values are sent, so the game matches the hardware.
- If the train recognised in game isn't the chosen locomotive, the panel warns: the chosen
  locomotive's assignments are what gets sent.
- To see what the game makes of it, pick the feature in **Inputs**: the Testing panel's
  *In game* value follows the lever.

### Settings file

Everything set up in the UI is saved to `settings/config.json` (created on first start, not in
git: COM port names are specific to the PC). It can be edited by hand while the app is stopped;
entries that don't validate are skipped with a warning, and a file that isn't valid JSON is moved
aside to `config.invalid-<time>.json`.

```json
{
  "version": 1,
  "locomotive": "Dragon 2 (ET25 / E6ACTa)",
  "paused": false,
  "joysticks": [{ "port": "COM3", "enabled": true, "baudRate": 9600, "mask": "{a,a}" }],
  "bindings": [
    {
      "locomotive": "Dragon 2 (ET25 / E6ACTa)",
      "joystick": "COM3",
      "channel": 1,
      "feature": "physics_input_general/drive_handle",
      "tolerance": 20,
      "notches": [{ "position": 512, "value": 0 }],
      "areas": [{ "from": 0, "to": 490, "valueFrom": -1, "valueTo": 0 }]
    }
  ]
}
```

`channel` is the 0-based position of the value in the mask (`1` = *Axis 2* with `{a,a}`).
Button channels have `pressed` / `released` instead of `tolerance`, `notches` and `areas`.

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

### Without a joystick

`npm run dev -- --fake-joystick` (or `FAKE_JOYSTICK=1`) lists a simulated joystick, `FAKE1`, instead
of the PC's COM ports. Once read, it sends `{a,a}` lines 50 times a second: axis 1 sweeps from end
to end every 8 s, axis 2 rests in one of five notches (60, 290, 512, 735, 960) at a time, with a
little jitter. Its first line arrives cut off, like a real port opened mid-line.

## Layout

```
client/                          static frontend (served as-is)
  js/main.js                     wiring and connection status
  js/connection.js               WebSocket client, reconnects automatically
  js/inputs-view.js              Inputs column
  js/testing-panel.js            Testing panel: slider, live values
  js/value-range.js              slider range + value meanings from descriptions
  js/humanize.js                 snake_case → title
  js/joysticks-view.js           Joysticks column: ports, live channel values, locomotive
  js/joystick-dialogs.js         port settings and channel assignment dialogs
  js/axis-mapping.js             raw value → notch / area → value (previews; mirrors the server's)
  js/axis-meter.js               0–1023 track with notches, areas and the lever
server/
  src/index.ts                   entry: Express + WebSocket + MQTT bridge + joysticks, opens the browser
  src/protocol.ts                WebSocket message types
  src/value-watch.ts             which tab follows which topic
  src/coalesce.ts                rate-limits joystick values sent to the browser
  src/joysticks/manager.ts       finds, opens and reads serial ports
  src/joysticks/mask.ts          line format ("{a,a}") parsing
  src/joysticks/fake.ts          simulated joystick (--fake-joystick)
  src/joysticks/mapping.ts       raw value → notch / area → value (what is sent)
  src/joysticks/sender.ts        sends changed values to SimRail, pause, resync
  src/settings/schema.ts         settings/config.json shape, validation, changes
  src/settings/store.ts          loads and saves settings/config.json
  src/simrail/bridge.ts          MQTT connection to SimRail, polling of watched inputs
  src/simrail/payload.ts         payload encoding/decoding
  src/simrail/topics.ts          request_topics_response parsing, vehicle recognition
  src/simrail/catalog.ts         wiki catalogue loader (+ corrections)
  data/simrail-inputs.json       input fields scraped from the wiki (2026-11-24)
  data/simrail-input-overrides.json  our corrections to the wiki
tools/
  fake-simrail.ts                stand-in SimRail broker for development
settings/
  config.json                    what was set up in the UI (not in git)
```
