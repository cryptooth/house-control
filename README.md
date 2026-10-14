<p align="center">
  <img src="docs/icon.png" width="112" alt="House Control icon">
</p>

<h1 align="center">House Control</h1>

<p align="center">
  Your home as a live 3D model, in the Mac's menu bar and around its notch,<br>
  controlling the lights and air conditioners of your own Home Assistant.
</p>

<p align="center">
  <img src="docs/hero.png" alt="The panel, an air conditioner sheet and a colour light sheet">
</p>

This is a fork of [0xProbabillity/house-control](https://github.com/0xProbabillity/house-control), trimmed down to
one job: a Mac app for one Home Assistant. Smart Life / Tuya, Philips Hue, Apple Home, the iPhone app and its sync,
and the AI Access gateway with its Cloudflare tunnel are gone. The app makes outgoing requests to your Home
Assistant and to nothing else, and nothing on your Mac is opened to the network.

## What it does

- **Lives in the menu bar.** Click the house icon and a panel drops down; click anywhere else and it is gone.
- **Your floor plan in 3D.** Rooms, walls, doors, windows and furniture are built from one JSON file.
  Lamps light the scene the way they light the room; an AC that is running blows visible air.
- **Lights.** Tap to toggle, drag across a tile to dim, open a light for brightness, white temperature and colour.
- **Air conditioners.** Power, target temperature, mode and fan speed, with the room temperature from a real sensor if you have one.
- **Scenes.** One tap sets every light and AC: "Cozy", "Movie", "Night", or your own.
- **Charts.** Every numeric sensor of your Home Assistant (temperature, humidity, power, energy…) over the last
  day, three days or week, from its own history. See [Charts](#charts).
- **A visual editor.** Draw the rooms, drop in furniture, place lamps and ACs, and link each one to a Home Assistant entity.
- **An island around the notch.** Rest the pointer on the MacBook's notch and a small live model of the home drops
  out of it, with scenes and every device one click away. See [The island](#the-island).
- **Works without any hardware.** Until you connect Home Assistant, every device is simulated, so you can try everything first.

It is a small native Swift shell (AppKit) around a [Three.js](https://threejs.org) web UI, with the Home Assistant
client in a Swift package. No frameworks, no Electron, no server, no account of its own.

## Requirements

| | |
| --- | --- |
| macOS | 13 Ventura or newer |
| Xcode Command Line Tools | Swift 5.9 or newer: `xcode-select --install` |
| Node.js | 20.19+ or 22.12+ |
| Home Assistant | Any recent version, reachable from the Mac, and a long-lived access token |

## Build and run

```bash
git clone https://github.com/cryptooth/house-control.git
cd house-control
./scripts/build-app.sh
open build/HouseControl.app
```

The script builds the web UI with Vite, the native shell with SwiftPM, and assembles an ad-hoc signed
`build/HouseControl.app`. The first build downloads the npm packages; later builds take a few seconds.

The app is signed ad hoc, so macOS treats every build as a new app: it asks again for Local Network access and for
the Keychain item that holds your token. To stop that, sign it with your own certificate:
`CODESIGN_IDENTITY="Apple Development: you@example.com (ABCDE12345)" ./scripts/build-app.sh`.

To keep it, drag `build/HouseControl.app` into `/Applications`. To start it with your Mac, add it under
**System Settings → General → Login Items**. There is no Dock icon and no main window: look for the house in the
menu bar.

## Using it

| Do this | To get this |
| --- | --- |
| Click the menu bar icon | Open or close the panel |
| Right-click the menu bar icon | Edit Home, Charts, Load Floor Plan, Reveal Plan File, Reveal Device Log, Show Island, Reload, Quit |
| Click a lamp in the 3D view, or its tile | Toggle it |
| Drag sideways across a light tile | Dim it |
| Click the sliders icon on a light tile | Brightness, white temperature, colour |
| Click an AC, or its tile | Open its sheet: temperature, mode, fan speed |
| Click a room | Zoom in on it and list only its devices |
| Drag the 3D view / scroll over it | Rotate / zoom |
| `Esc` | Back, then close |

The menu bar icon shows how many lights are on and the target of the running AC, for example `6 · 23°`.

The gear button in the panel switches between your home and the two bundled demo plans, **Apartment** and **Studio**.

## The island

<p align="center">
  <img src="docs/island.png" width="820" alt="The island, open: a 3D model of the home, scenes and devices">
</p>

A black tab grows out of the MacBook's notch. On a display without a notch it is drawn in the middle of the menu bar.

| Do this | To get this |
| --- | --- |
| Look at it | How many lights are on, and the target of a running AC |
| Rest the pointer on it | It springs open: the 3D model, scenes, air conditioners and lights |
| Click a lamp in the model, or its chip | Toggle it; drag across a chip to dim |
| Click a room in the model | Zoom in on it |
| Move the pointer away | It closes |

When something changes elsewhere — a scene picked in the panel, a lamp switched from Home Assistant — the island
peeks out for a moment to say what happened. It never takes the keyboard from the app you are working in.
**Show Island** in the menu bar icon's right-click menu turns it off.

## Make it your home

Right-click the icon and choose **Edit Home…**

<p align="center">
  <img src="docs/editor.png" width="820" alt="The floor plan editor">
</p>

- Drag rooms to move them and drag a corner to resize; everything snaps to 5 cm.
- Where two rooms touch, the wall between them appears by itself. Walls facing the camera are cut away.
- Add doors, windows, furniture, lamps and air conditioners from the list on the left.
- **Save & apply** writes the plan and reloads the panel.

The plan is a single JSON file, `~/Library/Application Support/HouseControl/plan.json`. You can write it by hand,
export it, or import someone else's: see [docs/floor-plan.md](docs/floor-plan.md) for every field.
The demo plans in [`web/public/plans`](web/public/plans) are good starting points.

## Connect Home Assistant

1. In Home Assistant, open your profile → **Security** → **Long-lived access tokens** → **Create token**, and copy it.
2. Right-click the menu bar icon → **Edit Home… → Connections → Home Assistant**. Pick the server found on your
   network or type its address, paste the token and press **Connect**.
3. Select a lamp or an AC on the plan, choose its entity under **Real device**, and press **Save & apply**.

Lights and switches become lamps, `climate` entities become air conditioners, and temperature sensors can show an
AC's room temperature. Changes made elsewhere show up within a second. Details: [docs/connections.md](docs/connections.md).
No server at hand? [`tools/lab`](tools/lab/README.md) runs a pretend Home Assistant on your Mac.

## Charts

Right-click the menu bar icon → **Charts…** (or the gear in the panel → **Charts…**). Tick sensors on the left;
each gets a card with its current value, the minimum, time-weighted average and maximum, and a line over the
chosen range. Hover the line (or focus it and use the arrow keys) to read any moment; **Show values** lists them
as a table. The values come from Home Assistant's history API, so they reach as far back as its recorder keeps
them (ten days by default). Your selection and range are remembered.

## Privacy

House Control talks to your Home Assistant and to nothing else. There is no telemetry and no backend.

| Where | Contents |
| --- | --- |
| Login Keychain, item "HouseControl" | Your Home Assistant's address and access token |
| `~/Library/Application Support/HouseControl/plan.json` | Your floor plan, including the entity ids you linked |
| `~/Library/Application Support/HouseControl/settings.json` | Which plan is active |
| `~/Library/Application Support/HouseControl/events.log` | Commands sent to Home Assistant and its answers. No tokens |

**Disconnect** in the editor deletes the Keychain item. Deleting the folder resets the app to the demo plan.

## Development

```
web/      the UI: Three.js scene, panel, island, editor and charts (Vite, plain ES modules)
core/     the Home Assistant client, the device hub and the plan store (SwiftPM, with tests)
macos/    the Mac shell: menu bar item, panel, island and editor windows (SwiftPM)
scripts/  build-app.sh builds the app, release-mac.sh makes the .dmg,
          make-icon.swift and make-dmg-background.swift draw the icon and the disk image's window
tools/lab a pretend Home Assistant for testing without your own server
docs/     floor plan reference, the Home Assistant guide, screenshots
```

```bash
cd core && swift test
```

Work on the UI in a browser with hot reload; the native bridge is a no-op there and all devices are simulated:

```bash
cd web
npm install
npm run dev
```

Then open `http://localhost:5199/`. Add `?plan=studio` for the second demo plan, `?mode=editor` for the editor,
`?mode=island` for the island, `?mode=charts` for the charts (with made-up sensors), or `?device=living.ac` to start on a device's sheet. Set `PORT` to use another port.

Environment variables understood by the app:

| Variable | Effect |
| --- | --- |
| `HOUSE_DEV_URL=http://localhost:5199/` | Load the UI from the dev server instead of the bundle |
| `HOUSE_WEB_DIR=/path/to/dist` | Load the UI from another folder |
| `HOUSE_DATA_DIR=/some/folder` | Keep plan, token and log there instead of Application Support and the Keychain, and do not persist panel state. Handy for a clean test run |
| `HOUSE_OPEN_ON_LAUNCH=1` | Open the panel at launch |
| `HOUSE_OPEN_EDITOR=1` | Open the editor at launch (`connections` or `homeassistant` opens it on that screen) |
| `HOUSE_OPEN_CHARTS=1` | Open the charts window at launch |
| `HOUSE_OPEN_DEVICE=<id>` | Start the panel on that light's or AC's sheet |
| `HOUSE_PIN=1` | Keep the panel open when it loses focus |
| `HOUSE_DOCK=1` | Show a Dock icon, so UI automation tools can see the app |
| `HOUSE_ISLAND=0` | Run without the island (`1` forces it on) |
| `HOUSE_ISLAND_EXPANDED=1` | Keep the island open |
| `HOUSE_SNAPSHOT_DIR=/some/folder` | Write `panel.png` and `island.png` there a few seconds after launch |
| `HOUSE_RENDER_HIDDEN=1` | Keep drawing while the screen is locked, for unattended captures |
| `HOUSE_EVAL_DIR=/some/folder` | Scripted UI checks: a `panel.js` / `editor.js` / `island.js` dropped there runs in that page (as an async function body) and its result is written to `<mode>.json` |

For example, a throw-away instance on the demo plan, pinned open:

```bash
HOUSE_DATA_DIR=/tmp/house-demo HOUSE_PIN=1 HOUSE_OPEN_ON_LAUNCH=1 build/HouseControl.app/Contents/MacOS/HouseControl
```

Every pull request is built and tested on a GitHub macOS runner by [`ci.yml`](.github/workflows/ci.yml).

### Releasing the Mac app

Set `MARKETING_VERSION` in `macos/Version.xcconfig`, commit, then tag and push:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

[`release.yml`](.github/workflows/release.yml) builds the universal app on a GitHub macOS runner
(`UNSIGNED=1 ./scripts/release-mac.sh`), attests its provenance and opens a **draft** release with the disk image
and its SHA-256. Check it, then publish the draft. Running the workflow by hand from the Actions tab builds the same
image as a downloadable artifact without a release.

With an Apple Developer ID of your own, `ASC_KEY_ID=… ASC_ISSUER_ID=… ./scripts/release-mac.sh --publish` builds a
signed and notarized image locally instead; the script lists what it needs.

## Limitations

- Rooms are axis-aligned rectangles. An L-shaped room is two rooms.
- Only lights, switches, climate entities and temperature sensors can be linked so far.

## Acknowledgements

Built on [House Control](https://github.com/0xProbabillity/house-control) by 0xProbability (MIT). The 3D view is
built with [Three.js](https://threejs.org); the icons are from [Lucide](https://lucide.dev). This project is not
affiliated with or endorsed by Home Assistant.

## License

[MIT](LICENSE)
