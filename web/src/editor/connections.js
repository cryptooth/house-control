// The editor's "Connections": the Home Assistant server House Control links the plan's
// lamps and ACs to, the screen that connects it, and the pickers that link a lamp or an AC
// to one of its entities.
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { isNative, isAddon, call } from '../bridge.js';
import { SERVICES, linkOf } from '../config.js';

const ORDER = ['homeassistant'];
const LOOK = {
  homeassistant: { icon: 'homeassistant', tint: '#18bcf2', blurb: 'Everything it runs: Zigbee, Matter, Nest, Xiaomi, Sonoff…' },
};
const KIND_TITLES = { light: 'Lights and plugs', ac: 'Air conditioners', sensor: 'Temperature sensors' };

export function createConnections({ rerender, toast, usedBy, onOpen }) {
  const boot = window.__HOUSE_BOOT__ || {};
  const state = {
    info: boot.services || {},
    devices: null,
    errors: {},
    loading: false,
    found: {},       // service -> discovered servers
    scanning: {},
  };

  const connected = (id) => Boolean(state.info[id]?.connected);
  const anyConnected = () => ORDER.some(connected);
  const devicesOf = (id) => (state.devices || []).filter((d) => d.service === id);

  async function refreshInfo() {
    if (!isNative) return;
    try { state.info = await call('services.info'); } catch { /* keep what we had */ }
  }

  async function load({ quiet = false } = {}) {
    if (!isNative || !anyConnected()) { state.devices = null; rerender(); return; }
    state.loading = true;
    if (!quiet) rerender();
    try {
      const r = await call('devices.all');
      state.devices = r.devices;
      state.errors = r.errors || {};
    } catch (e) {
      state.errors = { all: e.message };
    }
    state.loading = false;
    rerender();
  }

  /* ---------- sidebar ---------- */

  function sidebarRow(active, select) {
    const n = ORDER.filter(connected).length;
    return h(`button.row.tuya-row${active ? '.active' : ''}`, { onclick: select },
      icon('link', 15), h('span.row-name', 'Connections'),
      h(`span.pill${n ? '.on' : ''}`, n ? `${n} connected` : 'Demo mode'));
  }

  /* ---------- overview ---------- */

  function tile(id, size = 34) {
    return h('span.svc-tile', { vars: { '--tint': LOOK[id].tint, '--size': `${size}px` } }, icon(LOOK[id].icon, Math.round(size * 0.52), 2));
  }

  function statusText(id) {
    const info = state.info[id] || {};
    if (!info.connected) return 'Not connected';
    const count = devicesOf(id).length;
    const name = info.name;
    return [name, state.devices ? `${count} device${count === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ') || 'Connected';
  }

  function overview() {
    if (anyConnected() && !state.devices && !state.loading) setTimeout(() => load(), 0);
    return [
      h('div.svc-cards', ORDER.map((id) => h('button.svc-card', { onclick: () => onOpen(id) },
        tile(id),
        h('div.svc-text', h('b', SERVICES[id].name), h('span', LOOK[id].blurb)),
        h(`span.svc-status${connected(id) ? '.on' : ''}`, connected(id) ? icon('ok', 13, 2.4) : null, statusText(id)),
        icon('next', 16)))),
      h('p.note', 'Lamps and ACs stay simulated until you link them: pick one on the plan, then choose its entity under “Real device”.'),
      isNative ? null : h('p.note.bad', 'Connecting is only available inside the macOS app (this is the browser preview).'),
    ];
  }

  /* ---------- shared pieces ---------- */

  const section = (title, ...nodes) => h('section.block', h('h3', title), nodes);

  function deviceList(id) {
    if (state.loading) return h('p.note.busy', icon('spinner', 13), 'Asking for the devices…');
    if (state.errors[id]) return h('p.note.bad', state.errors[id]);
    const list = devicesOf(id);
    if (!state.devices) return null;
    if (!list.length) return h('p.note', 'Connected, but no lamps, air conditioners or temperature sensors were found.');
    const used = usedBy();
    const groups = ['light', 'ac', 'sensor'].map((kind) => [kind, list.filter((d) => d.kind === kind)]).filter(([, l]) => l.length);
    return h('div.devices-list', groups.map(([kind, items]) => [
      h('h3', `${KIND_TITLES[kind]} · ${items.length}`),
      items.map((d) => h('div.device',
        h(`span.dot${d.online ? '.on' : ''}`, { title: d.online ? 'Online' : 'Offline' }),
        h('div', h('b', d.name), h('span', [d.room, d.detail].filter(Boolean).join(' · ') || d.id)),
        used.get(`${d.service}|${d.id}`) ? h('span.pill.on', used.get(`${d.service}|${d.id}`)) : null)),
    ]));
  }

  function connectedHeader(id, title, name, line) {
    return section(title,
      h('div.device', h('span.dot.on'), h('div', h('b', name), h('span', line))),
      h('div.fields',
        h('button.btn', { onclick: () => load() }, 'Refresh devices'),
        // The add-on is always connected to the Home Assistant it runs in.
        isAddon ? null : h('button.btn', { onclick: () => disconnect(id) }, 'Disconnect')));
  }

  async function disconnect(id) {
    try {
      state.info = await call('service.disconnect', { service: id });
      state.devices = state.devices?.filter((d) => d.service !== id) ?? null;
      toast(`${SERVICES[id].name} disconnected`);
    } catch (e) { toast(e.message, true); }
    rerender();
  }

  async function scan(id) {
    if (!isNative || state.scanning[id]) return;
    state.scanning[id] = true;
    rerender();
    try {
      state.found[id] = (await call('services.discover', { service: id })).found;
    } catch { state.found[id] = []; }
    state.scanning[id] = false;
    rerender();
  }

  /* ---------- Home Assistant ---------- */

  const ha = { url: '', token: '', error: null, busy: false };

  function homeAssistant() {
    const info = state.info.homeassistant || {};
    if (info.connected) {
      if (!state.devices && !state.loading) setTimeout(() => load(), 0);
      return [connectedHeader('homeassistant', 'Server', info.name, [info.url, info.version && `version ${info.version}`].filter(Boolean).join(' · ')),
        deviceList('homeassistant')];
    }
    if (!state.found.homeassistant && !state.scanning.homeassistant) setTimeout(() => scan('homeassistant'), 0);
    const url = h('input', { type: 'url', spellcheck: 'false', placeholder: 'http://homeassistant.local:8123', value: ha.url });
    const token = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Long-lived access token', value: ha.token });
    const ready = () => isNative && !ha.busy && ha.url.trim() && ha.token.trim();
    url.addEventListener('input', () => { ha.url = url.value; button.disabled = !ready(); });
    token.addEventListener('input', () => { ha.token = token.value; button.disabled = !ready(); });
    const connect = async () => {
      ha.busy = true; ha.error = null; rerender();
      try {
        state.info = await call('homeassistant.connect', { url: ha.url, token: ha.token });
        ha.token = '';
        toast(`Connected to ${state.info.homeassistant?.name || 'Home Assistant'}`);
        await load();
      } catch (e) { ha.error = e.message; }
      ha.busy = false;
      rerender();
    };
    const button = h('button.btn.primary.wide', { onclick: connect, disabled: !ready() }, ha.busy ? 'Connecting…' : 'Connect');
    const found = state.found.homeassistant || [];
    return [
      section('On your network',
        state.scanning.homeassistant ? h('p.note.busy', icon('spinner', 13), 'Looking for Home Assistant…')
          : found.length ? found.map((s) => h('div.device',
            h('span.dot.on'), h('div', h('b', s.name), h('span', [s.url, s.version && `version ${s.version}`].filter(Boolean).join(' · '))),
            h('button.btn', { onclick: () => { ha.url = s.url; rerender(); } }, ha.url === s.url ? 'Selected' : 'Use')))
            : h('p.note', 'None found by itself. Type its address below.'),
        state.scanning.homeassistant ? null : h('button.btn.link', { onclick: () => scan('homeassistant') }, icon('radar', 13), 'Look again')),
      section('Connect',
        h('label.field', h('span', 'Address'), url),
        h('label.field', h('span', 'Access token'), token),
        h('ol.steps',
          h('li', 'In Home Assistant, open your profile (your name at the bottom left) → Security.'),
          h('li', 'Under “Long-lived access tokens” press Create token, name it “House Control”, copy it here.')),
        button,
        ha.error ? h('p.note.bad', ha.error) : null,
        h('p.note', 'The token stays in this Mac’s Keychain and is sent only to the address above. Lights, switches, climate devices and temperature sensors appear here.')),
    ];
  }

  /* ---------- detail screen ---------- */

  function detail() {
    return homeAssistant();
  }

  /* ---------- linking a lamp or an AC ---------- */

  function optionLabel(d) {
    return `${d.name}${d.room ? ` — ${d.room}` : ''}${d.online ? '' : ' (offline)'}`;
  }

  function picker(kind, current, include = () => true) {
    const select = h('select');
    select.append(h('option', { value: '' }, kind === 'sensor' ? 'None — estimated' : 'Not linked — simulated'));
    let found = false;
    for (const id of ORDER) {
      const list = devicesOf(id).filter((d) => d.kind === kind && include(d));
      if (!list.length) continue;
      select.append(h('optgroup', { label: SERVICES[id].name }, list.map((d) => {
        const value = `${d.service}|${d.id}`;
        if (value === current) found = true;
        return h('option', { value }, optionLabel(d));
      })));
    }
    if (current && !found) {
      const [service, id] = current.split('|');
      select.append(h('option', { value: current }, `${SERVICES[service]?.short || service}: ${id} (not found now)`));
    }
    select.value = current;
    return select;
  }

  const find = (value) => (state.devices || []).find((d) => `${d.service}|${d.id}` === value);

  /** The "Real device" section of a lamp or an AC. `onLinked(device)` adapts the item. */
  function deviceSection(item, kind, { snapshot, changed }) {
    const link = linkOf(item);
    const current = link ? `${link.service}|${link.id}` : '';
    if (!anyConnected()) {
      return section('Real device',
        h('p.note', 'Simulated. Connect Home Assistant to control the real one.'),
        h('button.btn.wide', { onclick: () => onOpen(null) }, icon('link', 14), 'Open Connections'));
    }
    if (!state.devices && !state.loading) setTimeout(() => load({ quiet: true }), 0);
    const select = picker(kind, current);
    select.addEventListener('change', () => {
      snapshot();
      const value = select.value;
      delete item.link;
      const device = find(value);
      if (value) {
        const [service, id] = value.split('|');
        item.link = { service, id };
      }
      let note = null;
      if (device && kind === 'light' && device.capabilities) {
        item.capabilities = [...device.capabilities];
        note = device.capabilities.length ? `Matched what it can do: ${device.capabilities.join(', ').replace('temp', 'white temperature').replace('color', 'colour')}` : 'Matched: an on/off switch';
      }
      if (device && kind === 'ac' && device.min != null) { item.min = Math.round(device.min); item.max = Math.round(device.max); }
      changed(note);
    });
    const device = find(current);
    const info = device ? [SERVICES[device.service].name, device.detail, device.room].filter(Boolean).join(' · ')
      : current && state.devices ? 'This device was not found in its platform right now.'
        : state.loading ? 'Loading your devices…' : '';
    const offline = device && !device.online;
    return section('Real device',
      h('label.field', h('span', 'Device'), select),
      info ? h(`p.note${offline ? '.bad' : ''}`, offline ? `${info} · offline` : info) : null,
      Object.keys(state.errors).length ? h('p.note.bad', Object.entries(state.errors).map(([s, e]) => `${SERVICES[s]?.name || s}: ${e}`).join(' · ')) : null);
  }

  /** An AC's thermometer: a temperature sensor entity. */
  function sensorSection(item, { snapshot, changed }) {
    const current = item.sensor?.id ? `${item.sensor.service}|${item.sensor.id}` : '';
    const select = picker('sensor', current);
    select.addEventListener('change', () => {
      snapshot();
      delete item.sensor;
      const [service, id] = select.value ? select.value.split('|') : [];
      if (service) item.sensor = { service, id };
      changed();
    });
    return section('Room temperature',
      h('label.field', h('span', 'Thermometer'), select),
      h('p.note', 'A temperature sensor in the same room. Without one, the AC’s own reading is used, or the temperature is estimated.'));
  }

  /** "id → plan item name" for every device the plan links, to mark them in the lists. */
  function usedMap(doc) {
    const out = new Map();
    for (const d of [...doc.lights, ...doc.acs]) {
      const l = linkOf(d);
      if (l) out.set(`${l.service}|${l.id}`, d.name || d.id);
      if (d.sensor?.id) out.set(`${d.sensor.service}|${d.sensor.id}`, `${d.name || d.id} · room`);
    }
    return out;
  }

  return {
    state, load, refreshInfo, sidebarRow, overview, detail, tile, deviceSection, sensorSection, usedMap,
    connected,
    title: (id) => SERVICES[id]?.name,
    blurb: (id) => LOOK[id]?.blurb,
  };
}
