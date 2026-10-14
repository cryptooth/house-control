# The lab: a Home Assistant to test against

A pretend Home Assistant, so House Control can be built and tested without your own server or hardware. It runs on
your Mac and behaves like the real thing on the network: the app's discovery finds it, it speaks the real API and
you can watch every change in its web UI.

| Command | What it is |
| --- | --- |
| `./tools/lab/homeassistant.sh` | A real Home Assistant (installed into `tools/lab/.ha` on first run, about 1 GB) with its demo devices: lights with every colour mode, three climate devices, fans, a thermometer. Prints the address and an access token |

Needs [uv](https://github.com/astral-sh/uv) (`brew install uv`).

## A full run

1. Start the lab Home Assistant.
2. Start a throw-away House Control, so your own plan and token stay untouched:

   ```bash
   HOUSE_DATA_DIR=/tmp/house-lab HOUSE_OPEN_EDITOR=connections build/HouseControl.app/Contents/MacOS/HouseControl
   ```

3. **Connections → Home Assistant**: the lab server is listed; press **Use**, paste the token, **Connect**.
4. Link a few lamps and an AC under **Real device**, **Save & apply**, and use the panel. Change something in
   Home Assistant's web UI and watch the panel follow.

## Automated tests

The unit tests cover the translation to and from Home Assistant and the hub's routing. One more runs against the lab:

```bash
cd core
HOUSE_TEST_HA_URL=http://127.0.0.1:8123 HOUSE_TEST_HA_TOKEN=$(cat ../tools/lab/.ha/token) swift test --filter ServiceTests
```

Run as a plain process on macOS, Home Assistant cannot use Bluetooth (macOS would stop it), so the lab replaces
that integration with a stub in `homeassistant/custom_components/bluetooth`. Its own Bonjour announcements do
not reach the network either; `homeassistant.sh` announces the server with `dns-sd`, in the same format.

Delete `tools/lab/.ha` to start from scratch.
