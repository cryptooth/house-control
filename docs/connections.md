# Connecting Home Assistant

House Control links the lamps and air conditioners of your floor plan to the entities of your
[Home Assistant](https://www.home-assistant.io). It talks to your server's own REST and WebSocket API with a
long-lived access token, and to nothing else. Everything you do not link stays simulated.

1. In Home Assistant, open your profile (your name at the bottom left) → **Security** → **Long-lived access
   tokens** → **Create token**. Name it "House Control" and copy it.
2. In House Control: right-click the menu bar icon → **Edit Home… → Connections → Home Assistant**. Servers on
   your network are found by themselves; press **Use**, or type the address (`http://homeassistant.local:8123`,
   or your own `https://` address). Paste the token and press **Connect**.
3. Select a lamp or an AC on the plan, choose its entity under **Real device**, and press **Save & apply**.
   Picking a lamp fills in what it can do (dimming, white temperature, colour); picking an AC takes over its
   temperature range.

| Home Assistant | In House Control |
| --- | --- |
| `light.*` | A lamp: on/off, brightness, white temperature and colour as its colour modes allow |
| `switch.*` | A lamp on a plug: on/off |
| `climate.*` | An air conditioner: power, target, the modes it has (`cool`, `heat`, `dry`, `fan_only`, `auto`/`heat_cool`), its fan speeds, swing, `eco` and `sleep` presets |
| `sensor.*` with `device_class: temperature` | A thermometer for an AC's room |

Areas become the room shown next to each device. House Control subscribes to Home Assistant's `state_changed`
events, so a lamp switched from a wall switch or an automation shows up in the panel within a second.

## Privacy

The address and the token are kept in your login Keychain (service "HouseControl"), and the token is only ever
sent to that address. **Disconnect** deletes it. Nothing on your Mac is opened to the network: the app makes
outgoing requests to your Home Assistant only. Because the app is signed ad hoc, macOS may ask once after each
rebuild whether House Control may read its Keychain item; choose **Always Allow**.

When something does not react, **Reveal Device Log** in the menu bar icon's menu shows each command and the answer.

## Trying it without your own server

[`tools/lab`](../tools/lab/README.md) runs a pretend Home Assistant full of demo devices on your Mac.
