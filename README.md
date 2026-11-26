# SimRail MQTT Controllers

A local app for building custom train controllers for [SimRail](https://simrail.eu) over its
[MQTT interface](https://wiki.simrail.eu/en/MQTT/Introduction).

- **Server** (TypeScript, Express, run with ts-node): connects to SimRail's MQTT broker and serves the UI.
- **Client** (plain JavaScript, no build step): talks to the server over a WebSocket.
- **Desktop app** (Electron): both in a window of their own, packaged as a portable Windows exe, see
  [Desktop app](#desktop-app).

## Running

Requires Node.js 22+. `npm install` also downloads SDL (prebuilt, from the
[node-sdl](https://github.com/ValeriyRadchenko/node-sdl) releases), which reads game controllers.

```sh
npm install
npm start             # starts the server and opens http://127.0.0.1:8090 in your default browser
npm run dev           # same, but restarts on server changes and doesn't open a browser
npm run typecheck     # ts-node only transpiles; this does the type checking
npm run fake-simrail  # a stand-in for the game, see below
npm run dev -- --fake-joystick   # a simulated joystick instead of the COM ports, see below
npm run app           # the desktop app, see below
npm run dist          # packages the desktop app as a portable exe
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
| `NO_CONTROLLERS=1`       |                            | Same as `--no-controllers`: don't load SDL      |
| `SETTINGS_FILE`          | `settings/config.json`     | Where UI settings are saved (e.g. for testing)  |
| `RUNTIME_DIR`            | `.runtime`                 | Where SimRail's last topic list is saved        |

### Desktop app

The same server and UI in a window (Electron), needing no Node.js on the PC it runs on.

```sh
npm run app     # from the project folder, with the same files as npm start
npm run dist    # packages it: release/SimRail Controllers 0.1.0.exe
```

- **Portable**: the exe is the whole app, to be copied anywhere. Its settings are saved next to it,
  in `settings\config.json`. On its first start it copies the settings of the project it was built
  from (this folder's `settings/config.json`) when that exists on the PC; from then on the two are
  separate. Each start unpacks the app to a temporary folder first, which takes a few seconds.
- **The log** (what `npm start` prints in its terminal) is
  `%APPDATA%\SimRail Controllers\logs\app.log`, started afresh each time: **File → Show log**.
  SimRail's last topic list is saved in the same folder. If the app can't start, a dialog shows
  why.
- **Closing the window quits the app**, after saving the settings and closing the ports. One runs at
  a time (starting it again brings up its window), and not next to `npm start`: both use port 8090.
- **View → Open in browser** opens the UI in a browser as well, e.g. on a second screen.
- Flags and env vars are the server's, as with `npm start`: `npm run app -- --fake-joystick`, or
  `"SimRail Controllers 0.1.0.exe" --fake-joystick`.
- The exe isn't code-signed and has Electron's icon. Copied to another PC (downloaded, sent),
  Windows SmartScreen warns on its first start: *More info → Run anyway*.
- It runs the compiled server (`npm run build`, to `dist/`), which `npm run app` and `npm run dist`
  build first. The native modules (SDL, serialport) are N-API builds and work in Electron as they
  are, so packaging doesn't rebuild them.

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
- **Joysticks**: serial (COM) ports and game controllers, and what their channels do on the chosen
  locomotive, see below.
- **Virtual devices** (second tab of the Joysticks panel): buttons combined into one control, see
  [Virtual devices](#virtual-devices).
- **Inputs**: every input field, titled from its snake_case name (`compressor_rq` → *Compressor
  Request*), grouped by vehicle category and filterable.

## Joysticks

A joystick is either a **serial device** (e.g. an Arduino) that prints one line of values per
reading, such as `{512,340}`, or a **game controller** (a USB joystick, gamepad, throttle… anything
Windows lists under *Game controllers*), see [Game controllers](#game-controllers). Both are listed
in the Joysticks column and used the same way.

The port list is checked every 2 seconds; every port is listed, and only the ones with **Read**
turned on are opened (opening a port resets most Arduinos and keeps other programs, like the Arduino
IDE, from using it). Read ports are reopened when they are plugged back in.

- **Settings** (per serial port): the **mask** and the baud rate (default 9600). In the mask, `a` is an
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

### Game controllers

Game controllers are read through SDL ([node-sdl](https://github.com/ValeriyRadchenko/node-sdl)).
They show up within half a second of being plugged in, under their name (`Generic USB Joystick`),
numbered when several have the same name. Like serial ports, they are only read once **Read** is
on, and are read again when plugged back in.

- **Channels**: the axes (*Axis 1…*), then the buttons (*Button 1…*), then
  each hat (d-pad) as four buttons: *Hat 1 up*, *right*, *down*, *left* (a diagonal presses two).
- **Axes are scaled to 0–1023**, like a serial joystick's analog values, so notches, areas and
  tolerances work the same (centre ≈ 512).
- A controller only reports **changes**: a lever nobody touches isn't flagged as silent. The status
  line lists the buttons being pressed, which helps telling them apart.
- **Ids**: identical devices share SDL's GUID, so a controller is known by its device path, which
  names the device and the USB port it is in: `sdl:HID#VID_0079&PID_0006#9&234B6673&0&0000`. Like a
  COM port's number, it stays the same across restarts **as long as the controller stays in the same
  USB port**; plugged into another one, it is listed as a new controller (assign its channels again,
  or edit the id in the settings file). Hover a controller's name to see its id.
- No settings beyond **Read**. If SDL can't be loaded, the app still runs with serial ports only
  (the console says why); `--no-controllers` doesn't load it at all.

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

## Virtual devices

A virtual device turns joystick buttons (button channels of any joysticks, hats included) into one
control that drives one feature. Like channel assignments, devices belong to a locomotive and only
the chosen locomotive's devices are live. **Add device** on the *Virtual devices* tab opens the
editor: pick the type, the feature and the buttons, either from the list or with **Detect** (then
press the button). The top line previews what the buttons do right now, before anything is saved.

- **Button combination**: each rule is a combination of the buttons (*Pressed*, *Released* or
  *Any*) and the value it sends; the first matching rule wins. A rule without a value sends nothing,
  and so does no matching rule: the game keeps its value. New devices start with one rule per
  combination (**All combinations** makes them again). Like a lever, the value is sent when it
  changes and again when sending (re)starts. For a 3-way switch wired as two buttons:

  | A        | B        | Send    |
  | -------- | -------- | ------- |
  | Pressed  | Released | 1       |
  | Released | Pressed  | 2       |
  | Released | Released | -1      |
  | Pressed  | Pressed  | nothing |

- **Step switch**: **Up** moves a multi-position switch to the next position, **Down** (optional)
  to the previous one, starting from **where it is in game**: the app polls the feature's value while
  the device exists, so the mouse or keyboard can move the switch too. **Positions** are the values
  the switch takes (`0, 1, 2`, `-1, 1` or `0..7`); **From description** fills them in from the wiki
  (`0 = disabled / 1 = TL / 2 = PL` gives `0, 1, 2`). A value between positions steps to the
  neighbouring one. **Wrap around** goes from the last position to the first (and back); with only
  Up, one button cycles through the positions or toggles between two (`-1, 1`). **Repeat while
  held** steps again after 0.4 s, then every 0.15 s. Presses while the value in game isn't known
  (SimRail not connected, or the train has no such input) are ignored; the card shows the position.
- **Pulse**: pressing the button sends *On press*, releasing it sends *On release* (either can be
  empty: nothing), and *For* ms later the *rest* value is sent; the rest value is also sent when
  sending (re)starts. A latching toggle switch working an impulse button: 1 on press and on release,
  rest -1. Working a pair of on/off requests (`-1 = turn off, 0 = default, 1 = turn on`): 1 on press,
  -1 on release, rest 0.

A channel used by a device shows *In "device name"* on the Joysticks tab. A button can be in a
device and assigned directly, or in several devices; everything it drives is sent, and the editor
points it out. Sending works as for levers: nothing goes out while paused or SimRail isn't connected,
and presses made meanwhile are dropped, not sent later.

## Settings file

Everything set up in the UI is saved to `settings/config.json` (created on first start, not in
git: COM port names and controller ids are specific to the PC; the desktop app's is next to its exe). It can be edited by hand while the app is stopped;
entries that don't validate are skipped with a warning, and a file that isn't valid JSON is moved
aside to `config.invalid-<time>.json`.

```json
{
  "version": 1,
  "locomotive": "Dragon 2 (ET25 / E6ACTa)",
  "paused": false,
  "joysticks": [
    { "port": "COM3", "enabled": true, "baudRate": 9600, "mask": "{a,a}" },
    { "port": "sdl:HID#VID_0079&PID_0006#9&234B6673&0&0000", "enabled": true }
  ],
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
  ],
  "devices": [
    {
      "id": "mi2x7k9a",
      "locomotive": "71E (CD163)",
      "name": "Cabin light",
      "type": "combo",
      "feature": "physics_input_163/cabin_light",
      "inputs": [{ "joystick": "COM3", "channel": 2 }, { "joystick": "COM3", "channel": 3 }],
      "rules": [
        { "when": ["pressed", "released"], "value": 1 },
        { "when": ["released", "pressed"], "value": 2 },
        { "when": ["released", "released"], "value": 0 },
        { "when": ["pressed", "pressed"], "value": null }
      ]
    },
    {
      "id": "mi2x8p1c",
      "locomotive": "71E (CD163)",
      "name": "Relative power",
      "type": "stepper",
      "feature": "physics_input_163/relative_power_switch",
      "inputs": [{ "joystick": "COM3", "channel": 4 }, { "joystick": "COM3", "channel": 5 }],
      "positions": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      "wrap": false,
      "repeat": true
    },
    {
      "id": "mi2x9d4f",
      "locomotive": "71E (CD163)",
      "name": "Main switch",
      "type": "pulse",
      "feature": "physics_input_163/open_main_switch_rq",
      "inputs": [{ "joystick": "COM3", "channel": 6 }],
      "onPress": 1,
      "onRelease": 1,
      "rest": -1,
      "durationMs": 200
    }
  ]
}
```

`channel` is the 0-based position of the value in the mask (`1` = *Axis 2* with `{a,a}`).
For a controller it is the position in its channel list (axes, buttons, hats; *Button 1* of a
controller with 5 axes is `5`). Button channels have `pressed` / `released` instead of
`tolerance`, `notches` and `areas`.

A device's `inputs` are button channels, numbered the same way. What they do depends on `type`:
`combo` takes 1–6 and a rule per combination (`when` has one of `pressed` / `released` / `any` per
input; `value` `null` sends nothing); `stepper` takes Up, then optionally Down, with `positions`
(ascending, at least 2), `wrap` and `repeat`; `pulse` takes one, with `onPress` / `onRelease`
(`null`: nothing), `rest` and `durationMs` (50–10000). `id` is any short unique name (letters,
digits, `-`, `_`).

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
  The features of the chosen locomotive's step switches are polled the same way.
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

`npm run dev -- --fake-joystick` (or `FAKE_JOYSTICK=1`) lists two simulated joysticks instead of the
PC's COM ports. Once read, they send lines 50 times a second; the first arrives cut off, like a real
port opened mid-line. Game controllers are still listed (`--no-controllers` leaves them out).

- `FAKE1`, `{a,a}`: axis 1 sweeps from end to end every 8 s, axis 2 rests in one of five notches
  (60, 290, 512, 735, 960) at a time, with a little jitter.
- `FAKE2`, four buttons: set its mask to `{b,b,b,b}`. Every 8 s: button 1 is held 0–1 s, button 2
  2–3 s, both 4–5 s (for a button combination), then button 3 is tapped twice and button 4 once
  (Up, Up, Down for a step switch).

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
  js/devices-view.js             Virtual devices tab: device cards, live button states
  js/device-dialog.js            virtual device editor (Detect, rules, positions, pulse)
  js/devices.js                  virtual device logic for previews (mirrors the server's)
  js/features.js                 features a channel or device can drive on a locomotive
  js/axis-mapping.js             raw value → notch / area → value (previews; mirrors the server's)
  js/axis-meter.js               0–1023 track with notches, areas and the lever
electron/
  main.ts                        desktop app: window, runs the server in a utility process, quits it
server/
  src/index.ts                   entry: Express + WebSocket + MQTT bridge + joysticks, opens the browser
  src/desktop-app.ts             the link to the desktop app (ready, shutdown)
  src/protocol.ts                WebSocket message types
  src/value-watch.ts             which tab follows which topic
  src/coalesce.ts                rate-limits joystick values sent to the browser
  src/joysticks/manager.ts       all joysticks: serial ports + game controllers
  src/joysticks/serial.ts        finds, opens and reads serial ports
  src/joysticks/controllers.ts   game controllers through SDL: list, read, report changes
  src/joysticks/mask.ts          line format ("{a,a}") parsing
  src/joysticks/fake.ts          simulated joysticks (--fake-joystick)
  src/joysticks/mapping.ts       raw value → notch / area → value (what is sent)
  src/joysticks/sender.ts        sends changed values to SimRail, pause, resync
  src/devices/engine.ts          virtual devices: button edges -> values, step switch positions
  src/devices/logic.ts           rule matching, next position (mirrored in client/js/devices.js)
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
electron-builder.js              packaging (npm run dist): portable exe, settings import
tsconfig.build.json              npm run build: compiles the server and the desktop app to dist/
dist/, release/                  build output: compiled JavaScript, the packaged app (not in git)
```

## License

[MIT](LICENSE): free to use, change and share, for anything, as long as the copyright notice stays
with it.
