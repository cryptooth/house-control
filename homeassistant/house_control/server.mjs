// House Control as a Home Assistant add-on: serves the web UI behind Ingress and stands in
// for the Mac app's native shell. The page posts the same messages it posts to the Swift
// side (`command`, `charts.history`, `savePlan`…) to /api/call, and long-polls
// /api/events for what the shell would have pushed (`applyRemote`, `adopt`).
//
// Inside Home Assistant it talks to Core through the Supervisor with the token the
// Supervisor hands every add-on, so there is no long-lived token to create. Outside it
// (for development) HA_URL and HA_TOKEN point it at any Home Assistant.
//
// No dependencies: Node 22's fetch and WebSocket are all it needs.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const WWW = path.resolve(process.env.HOUSE_WWW || path.join(here, 'www'));
const DATA = process.env.HOUSE_DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(here, 'data'));
const PORT = Number(process.env.PORT) || 8099;
const SUPERVISED = Boolean(process.env.SUPERVISOR_TOKEN);
const HA = SUPERVISED
  ? { api: 'http://supervisor/core/api', ws: 'ws://supervisor/core/websocket', token: process.env.SUPERVISOR_TOKEN }
  : {
    api: `${(process.env.HA_URL || 'http://homeassistant.local:8123').replace(/\/+$/, '')}/api`,
    ws: `${(process.env.HA_URL || 'http://homeassistant.local:8123').replace(/\/+$/, '').replace(/^http/, 'ws')}/api/websocket`,
    token: process.env.HA_TOKEN || '',
  };
// Under the Supervisor only its Ingress proxy may talk to this server.
const INGRESS_PROXY = '172.30.32.2';

fs.mkdirSync(DATA, { recursive: true });
const log = (...args) => console.log(new Date().toISOString(), ...args);

// ---------- Home Assistant ----------

class Failure extends Error {}

async function ha(method, route, { body, raw = false, slow = false } = {}) {
  let res;
  try {
    res = await fetch(HA.api + route, {
      method,
      headers: { Authorization: `Bearer ${HA.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(slow ? 60000 : 10000),
    });
  } catch (error) {
    throw new Failure(`Home Assistant did not answer: ${error.message}`);
  }
  if (res.status === 401 || res.status === 403) throw new Failure('Home Assistant refused the add-on’s token. Is “homeassistant_api” enabled?');
  if (res.status === 404) throw new Failure(`Home Assistant does not know ${route}`);
  if (!res.ok) throw new Failure(`Home Assistant answered ${res.status} ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  if (raw) return text;
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

let about = null;
async function servicesInfo() {
  if (!about) {
    try {
      const c = await ha('GET', '/config');
      about = { name: c.location_name || 'Home Assistant', version: c.version || '' };
    } catch {
      return { homeassistant: { connected: true, url: 'this Home Assistant', name: 'Home Assistant', version: '' } };
    }
  }
  return { homeassistant: { connected: true, url: 'this Home Assistant (add-on)', ...about } };
}

const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const offline = (value) => value === 'unavailable' || value === 'unknown';

// What a platform calls its fan speeds, onto the panel's five (same rules as the Mac app).
const FAN_ORDER = ['auto', 'low', 'medium', 'high', 'turbo'];
function fanPanel(name) {
  const n = name.toLowerCase();
  if (['turbo', 'max', 'strong', 'highest', 'powerful', 'boost', 'very high'].some((w) => n.includes(w))) return 'turbo';
  if (n.includes('high')) return 'high';
  if (n.includes('med') || n.includes('mid')) return 'medium';
  if (n.includes('low') || n.includes('quiet') || n.includes('silent')) return 'low';
  if (n.includes('auto')) return 'auto';
  return null;
}
function fanTable(names = []) {
  const out = {};
  for (const name of names) {
    if (name.toLowerCase() === 'off') continue;
    const p = fanPanel(name);
    if (p && !out[p]) out[p] = name;
  }
  return out;
}
function modeTable(hvacModes = []) {
  const out = {};
  for (const [panel, names] of [['cool', ['cool']], ['heat', ['heat']], ['dry', ['dry']], ['fan', ['fan_only']], ['auto', ['auto', 'heat_cool']]]) {
    const name = names.find((n) => hvacModes.includes(n));
    if (name) out[panel] = name;
  }
  return out;
}

const hex = (r, g, b) => `#${[r, g, b].map((c) => Math.round(clamp(c, 0, 255)).toString(16).padStart(2, '0')).join('')}`;
function rgb(text) {
  const s = String(text).trim().replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(s)) return null;
  const v = parseInt(s, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function lightCapabilities(modes) {
  const caps = [];
  if (modes.some((m) => m !== 'onoff')) caps.push('brightness');
  if (modes.includes('color_temp')) caps.push('temp');
  if (modes.some((m) => ['hs', 'xy', 'rgb', 'rgbw', 'rgbww'].includes(m))) caps.push('color');
  return caps;
}
const isTemperature = (a) => a.device_class === 'temperature' || ['°C', '°F'].includes(a.unit_of_measurement);

function device(state) {
  const id = state.entity_id;
  const a = state.attributes || {};
  const domain = id.split('.')[0];
  const base = { service: 'homeassistant', id, name: a.friendly_name || id, online: !offline(state.state), capabilities: [] };
  if (domain === 'light') {
    const modes = a.supported_color_modes || [];
    return { ...base, kind: 'light', capabilities: lightCapabilities(modes), detail: `light · ${modes.length ? modes.join(', ') : 'on/off'}` };
  }
  if (domain === 'switch') return { ...base, kind: 'light', detail: 'switch · on/off' };
  if (domain === 'climate') {
    const out = { ...base, kind: 'ac', detail: `climate · ${(a.hvac_modes || []).join(', ')}` };
    const lo = num(a.min_temp), hi = num(a.max_temp);
    if (lo != null && hi != null) { out.min = Math.max(lo, 10); out.max = Math.min(hi, 32); }
    return out;
  }
  if (domain === 'sensor' && isTemperature(a)) return { ...base, kind: 'sensor', detail: 'temperature sensor' };
  return null;
}

/** One entity's state in the panel's terms. */
function reading(state) {
  const id = state.entity_id;
  const value = state.state;
  const a = state.attributes || {};
  const out = { online: !offline(value) };
  if (!out.online) return out;
  if (id.startsWith('light.') || id.startsWith('switch.')) {
    const light = { on: value === 'on' };
    const b = num(a.brightness);
    if (value === 'on' && b != null) light.brightness = clamp(b / 255, 0.05, 1);
    if (a.color_mode === 'color_temp') {
      const k = num(a.color_temp_kelvin);
      if (k != null) { light.temp = clamp(k, 2200, 6500); light.color = null; }
    } else if (['hs', 'xy', 'rgb', 'rgbw', 'rgbww'].includes(a.color_mode) && Array.isArray(a.rgb_color) && a.rgb_color.length === 3) {
      light.color = hex(...a.rgb_color.map(Number));
    }
    out.light = light;
  } else if (id.startsWith('climate.')) {
    const modes = modeTable(a.hvac_modes);
    const ac = { on: value !== 'off' };
    const mode = Object.keys(modes).find((k) => modes[k] === value);
    if (mode) ac.mode = mode;
    const t = num(a.temperature), lo = num(a.target_temp_low), hi = num(a.target_temp_high);
    if (t != null) ac.target = t;
    else if (lo != null && hi != null) ac.target = Math.round((lo + hi) / 2);
    const room = num(a.current_temperature);
    if (room != null) ac.roomTemp = room;
    const fans = fanTable(a.fan_modes);
    const fan = a.fan_mode && fanPanel(a.fan_mode);
    if (fan && fans[fan]) ac.fan = fan;
    const swings = a.swing_modes || [];
    if (a.swing_mode && swings.length) ac.swing = a.swing_mode === 'off' ? 'off' : 'swing';
    const presets = a.preset_modes || [];
    if (presets.includes('sleep')) ac.sleep = a.preset_mode === 'sleep';
    if (presets.includes('eco')) ac.eco = a.preset_mode === 'eco';
    out.ac = ac;
    out.features = {
      modes: ['cool', 'heat', 'dry', 'fan', 'auto'].filter((m) => modes[m]),
      fans: FAN_ORDER.filter((f) => fans[f]),
      swing: swings.includes('off') && swings.length > 1,
      sleep: presets.includes('sleep'),
      eco: presets.includes('eco'),
    };
  } else if (id.startsWith('sensor.')) {
    const t = num(value);
    if (t != null) out.temperature = a.unit_of_measurement === '°F' ? (t - 32) * 5 / 9 : t;
  }
  return out;
}

/** The service calls that apply a change made in the panel. */
function calls(id, patch, state, attributes) {
  const domain = id.split('.')[0];
  const call = (service, data = {}, d = domain) => ({ domain: d, service, data: { entity_id: id, ...data } });
  if (domain === 'switch') return typeof patch.on === 'boolean' ? [call(patch.on ? 'turn_on' : 'turn_off')] : [];
  if (domain === 'light') {
    if (patch.on === false) return [call('turn_off')];
    const data = {};
    if (typeof patch.brightness === 'number') data.brightness_pct = Math.round(patch.brightness * 100);
    if (typeof patch.temp === 'number') data.color_temp_kelvin = Math.round(patch.temp);
    const c = typeof patch.color === 'string' && rgb(patch.color);
    if (c) data.rgb_color = c;
    if (!Object.keys(data).length && patch.on !== true) return [];
    return [call('turn_on', data)];
  }
  if (domain !== 'climate') return [];
  const modes = modeTable(attributes.hvac_modes);
  const fans = fanTable(attributes.fan_modes);
  if (patch.on === false) return [call('set_hvac_mode', { hvac_mode: 'off' })];
  const out = [];
  // Picking a mode is what switches a climate entity on.
  if (patch.on === true || patch.mode != null) {
    const mode = patch.mode || state.mode || 'cool';
    const name = modes[mode] || Object.values(modes)[0];
    if (name) out.push(call('set_hvac_mode', { hvac_mode: name }));
  }
  if (typeof patch.target === 'number') out.push(call('set_temperature', { temperature: patch.target }));
  if (typeof patch.fan === 'string' && fans[patch.fan]) out.push(call('set_fan_mode', { fan_mode: fans[patch.fan] }));
  if (typeof patch.swing === 'string') out.push(call('set_swing_mode', { swing_mode: patch.swing === 'off' ? 'off' : 'on' }));
  for (const preset of ['sleep', 'eco']) {
    if (typeof patch[preset] === 'boolean') out.push(call('set_preset_mode', { preset_mode: patch[preset] ? preset : 'none' }));
  }
  return out;
}

async function areaNames() {
  const template = "{% for e in states %}{{ e.entity_id }}\t{{ area_name(e.entity_id) or '' }}\n{% endfor %}";
  const text = await ha('POST', '/template', { body: { template }, raw: true });
  const out = {};
  for (const line of text.split('\n')) {
    const [id, area] = line.split('\t');
    if (id && area && area !== 'None') out[id] = area;
  }
  return out;
}

const isEntityId = (id) => /^[a-z0-9_]+\.[a-z0-9_]+$/i.test(id);

function numericSensor(state) {
  const id = state.entity_id;
  const value = num(state.state);
  if (!id.startsWith('sensor.') || value == null) return null;
  const a = state.attributes || {};
  // A number without a unit or a state class is usually an id or a counter nobody charts.
  if (a.unit_of_measurement == null && a.state_class == null) return null;
  return { id, name: a.friendly_name || id, value, unit: a.unit_of_measurement || '', deviceClass: a.device_class || '' };
}

/** History states → [ms, value] pairs, averaged into at most `points` buckets. */
function series(states, t0, t1, points = 480) {
  const raw = [];
  for (const s of states) {
    const v = num(s.state);
    const when = Date.parse(s.last_changed || s.last_updated || '');
    if (v == null || !Number.isFinite(when)) continue;
    raw.push([clamp(when, t0, t1), v]);
  }
  raw.sort((a, b) => a[0] - b[0]);
  if (raw.length <= points || t1 <= t0) return raw;
  const width = (t1 - t0) / points;
  const buckets = new Map();
  for (const [t, v] of raw) {
    const key = Math.min(points - 1, Math.floor((t - t0) / width));
    const b = buckets.get(key) || [0, 0, 0];
    buckets.set(key, [b[0] + t, b[1] + v, b[2] + 1]);
  }
  return [...buckets.keys()].sort((a, b) => a - b).map((k) => { const b = buckets.get(k); return [b[0] / b[2], b[1] / b[2]]; });
}

async function history(id, hours) {
  if (!isEntityId(id)) throw new Failure(`“${id}” is not an entity id`);
  const t1 = Date.now(), t0 = t1 - clamp(Number(hours) || 24, 1, 24 * 31) * 3600e3;
  const iso = (t) => new Date(t).toISOString();
  const lists = await ha('GET', `/history/period/${iso(t0)}?filter_entity_id=${id}&end_time=${encodeURIComponent(iso(t1))}&minimal_response&no_attributes`, { slow: true });
  return series(lists?.[0] || [], t0, t1);
}

// ---------- Plans ----------

const BUNDLED = ['home', 'studio'];
const planFile = path.join(DATA, 'plan.json');
const settingsFile = path.join(DATA, 'settings.json');
const readJSON = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
function writeJSON(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

const plans = {
  get custom() { return readJSON(planFile); },
  get active() {
    const plan = readJSON(settingsFile)?.plan;
    if (plan === 'custom') return fs.existsSync(planFile) ? 'custom' : 'home';
    return BUNDLED.includes(plan) ? plan : (fs.existsSync(planFile) ? 'custom' : 'home');
  },
  select(plan) {
    if (BUNDLED.includes(plan) || (plan === 'custom' && fs.existsSync(planFile))) writeJSON(settingsFile, { plan });
  },
  save(plan) {
    if (!plan || !Array.isArray(plan.rooms)) throw new Failure('This is not a House Control floor plan (no "rooms" list).');
    writeJSON(planFile, plan);
    plans.select('custom');
  },
  boot() {
    const active = plans.active;
    const boot = { plan: active, hasCustomPlan: fs.existsSync(planFile) };
    if (active === 'custom') boot.config = plans.custom;
    return boot;
  },
};

// ---------- Links and state (what DeviceHub does in the Mac app) ----------

/** App device id → { kind, id, sensor } for the active plan; demos are all simulated. */
let links = new Map();
function reloadLinks() {
  links = new Map();
  const plan = plans.active === 'custom' ? plans.custom : null;
  for (const [kind, key] of [['light', 'lights'], ['ac', 'acs']]) {
    for (const d of plan?.[key] || []) {
      if (!d?.id) continue;
      const sensor = d.sensor?.service === 'homeassistant' && d.sensor.id ? d.sensor.id : null;
      const target = d.link?.service === 'homeassistant' && d.link.id ? d.link.id : null;
      if (target) links.set(d.id, { kind, id: target, sensor });
      else if (sensor && kind === 'ac') links.set(d.id, { kind, id: '', sensor });
    }
  }
}
const watched = () => new Set([...links.values()].flatMap((l) => [l.id, l.sensor]).filter(Boolean));

let lastStates = new Map(); // entity id → state object, from the last read
async function poll() {
  const wanted = watched();
  if (!wanted.size) return null;
  const states = await ha('GET', '/states');
  const readings = new Map();
  for (const s of states) {
    if (!wanted.has(s.entity_id)) continue;
    lastStates.set(s.entity_id, s);
    readings.set(s.entity_id, reading(s));
  }
  const lights = {}, acs = {}, features = {};
  for (const [id, link] of links) {
    const r = readings.get(link.id);
    if (link.kind === 'light' && r?.light && r.online) lights[id] = r.light;
    if (link.kind === 'ac') {
      const ac = r?.online === false ? {} : { ...(r?.ac || {}) };
      const t = link.sensor && readings.get(link.sensor)?.temperature;
      if (typeof t === 'number') ac.roomTemp = t;
      if (Object.keys(ac).length) acs[id] = ac;
      if (r?.features) features[id] = r.features;
    }
  }
  return { lights, acs, features };
}

let latest = null;       // the last applyRemote payload, for a page that has just opened
let pollTimer = 0;
function schedulePoll(delay = 300) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    try {
      const update = await poll();
      if (update) { latest = update; publish('applyRemote', update); }
    } catch (error) {
      log('poll failed:', error.message);
    }
  }, delay);
}
// Changes arrive over the WebSocket; this only covers a dropped subscription.
setInterval(() => { if (clientsActive()) schedulePoll(0); }, 30000);

// Commands to one entity run strictly one after another.
const tails = new Map();
function command(message) {
  const link = links.get(message.id);
  if (!link?.id) return Promise.resolve({ ok: true }); // simulated device
  const patch = message.patch || {};
  const state = message.state || {};
  const run = async () => {
    let attributes = lastStates.get(link.id)?.attributes;
    if (!attributes && link.id.startsWith('climate.')) {
      attributes = (await ha('GET', `/states/${link.id}`))?.attributes;
    }
    const what = Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(' ');
    try {
      for (const c of calls(link.id, patch, state, attributes || {})) await ha('POST', `/services/${c.domain}/${c.service}`, { body: c.data });
      log(`${message.id} → ${link.id} ${what} ok`);
      return { ok: true };
    } catch (error) {
      log(`${message.id} → ${link.id} ${what} failed: ${error.message}`);
      schedulePoll(); // the panel showed it optimistically: pull the real state back in
      return { error: error.message };
    }
  };
  const next = (tails.get(link.id) || Promise.resolve()).then(run, run);
  tails.set(link.id, next);
  return next;
}

// Live updates from Home Assistant's WebSocket API.
function listen() {
  let socket;
  try { socket = new WebSocket(HA.ws); } catch (error) { log('websocket:', error.message); setTimeout(listen, 15000); return; }
  socket.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'auth_required') socket.send(JSON.stringify({ type: 'auth', access_token: HA.token }));
    else if (msg.type === 'auth_ok') socket.send(JSON.stringify({ id: 1, type: 'subscribe_events', event_type: 'state_changed' }));
    else if (msg.type === 'auth_invalid') log('websocket: token refused');
    else if (msg.type === 'event') {
      const id = msg.event?.data?.entity_id;
      if (id && watched().has(id)) schedulePoll(400); // a burst (a scene) becomes one read
    }
  });
  socket.addEventListener('close', () => setTimeout(listen, 15000));
  socket.addEventListener('error', () => {});
}

// ---------- Events for the pages (long polling: works through any proxy) ----------

const events = [];   // { seq, name, payload, except }
let seq = 0;
const waiting = new Set(); // { client, since, res, timer }
const seen = new Map();    // client id → last time it asked

function publish(name, payload, except = null) {
  events.push({ seq: ++seq, name, payload, except });
  if (events.length > 200) events.splice(0, events.length - 200);
  for (const w of [...waiting]) flush(w);
}
function pending(client, since) {
  return events.filter((e) => e.seq > since && e.except !== client).map(({ name, payload }) => ({ name, payload }));
}
function flush(w) {
  const list = pending(w.client, w.since);
  if (!list.length) return false;
  clearTimeout(w.timer);
  waiting.delete(w);
  send(w.res, 200, { seq, events: list });
  return true;
}
const clientsActive = () => [...seen.values()].some((t) => Date.now() - t < 60000);

// ---------- Messages from the page ----------

async function handleCall(msg) {
  switch (msg.type) {
    case 'command': return command(msg);
    case 'services.info': return servicesInfo();
    case 'homeassistant.connect':
    case 'service.disconnect': return servicesInfo(); // the add-on is always connected to its own Home Assistant
    case 'services.discover': return { found: [] };
    case 'devices.all': {
      try {
        const states = await ha('GET', '/states');
        const areas = await areaNames().catch(() => ({}));
        const kinds = { light: 0, ac: 1, sensor: 2 };
        const devices = states.map(device).filter(Boolean)
          .map((d) => (areas[d.id] ? { ...d, room: areas[d.id] } : d))
          .sort((a, b) => kinds[a.kind] - kinds[b.kind] || a.name.localeCompare(b.name));
        return { devices, errors: {} };
      } catch (error) {
        return { devices: [], errors: { homeassistant: error.message } };
      }
    }
    case 'charts.sensors': {
      const states = await ha('GET', '/states');
      const areas = await areaNames().catch(() => ({}));
      const sensors = states.map(numericSensor).filter(Boolean)
        .map((s) => (areas[s.id] ? { ...s, room: areas[s.id] } : s))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { sensors };
    }
    case 'charts.history': return { points: await history(String(msg.id || ''), msg.hours) };
    case 'savePlan':
      plans.save(msg.config);
      reloadLinks();
      schedulePoll(0);
      publish('reload', {});
      return { ok: true, path: 'the add-on’s data folder' };
    default: return { error: `Unknown request “${msg.type}”` };
  }
}

function handlePost(msg, client) {
  switch (msg.type) {
    case 'state': {
      // Every open page is a view of one home: what changes in one is shown by the others.
      const { type, ...state } = msg;
      publish('adopt', state, client);
      break;
    }
    case 'selectPlan':
      plans.select(msg.plan);
      reloadLinks();
      schedulePoll(0);
      publish('reload', {}, client);
      break;
    default: break; // ready, summary, close…: nothing to do in a browser
  }
}

// ---------- HTTP ----------

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.webp': 'image/webp', '.jpg': 'image/jpeg',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 5 * 1024 * 1024) throw new Failure('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

// The page reads its boot payload (the plan, the connection) the way the Mac app injects it.
async function index(res) {
  const html = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8');
  const boot = { ...plans.boot(), platform: 'addon', services: await servicesInfo() };
  const script = `<script>window.__HOUSE_BOOT__ = ${JSON.stringify(boot).replace(/</g, '\\u003c')};</script>`;
  send(res, 200, html.replace('<head>', `<head>\n    ${script}`), TYPES['.html']);
}

const server = http.createServer(async (req, res) => {
  const remote = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (SUPERVISED && remote !== INGRESS_PROXY) { send(res, 403, { error: 'Open House Control from Home Assistant.' }); return; }
  const url = new URL(req.url, 'http://local');
  const route = url.pathname;
  try {
    if (req.method === 'POST' && route === '/api/call') {
      const msg = await readBody(req);
      let result;
      try { result = await handleCall(msg); } catch (error) { result = { error: error.message }; }
      send(res, 200, result ?? {});
      return;
    }
    if (req.method === 'POST' && route === '/api/post') {
      handlePost(await readBody(req), url.searchParams.get('client'));
      send(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && route === '/api/events') {
      const client = url.searchParams.get('client') || '';
      const since = Number(url.searchParams.get('since')) || 0;
      seen.set(client, Date.now());
      if (since === 0) {
        // A page that has just opened gets the devices' state at once.
        if (latest) { send(res, 200, { seq, events: [{ name: 'applyRemote', payload: latest }] }); schedulePoll(); return; }
        schedulePoll(0);
      }
      const w = { client, since: since || seq, res, timer: 0 };
      if (flush(w)) return;
      w.timer = setTimeout(() => { waiting.delete(w); send(res, 200, { seq, events: [] }); }, 20000);
      waiting.add(w);
      req.on('close', () => { clearTimeout(w.timer); waiting.delete(w); });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { send(res, 405, { error: 'Method not allowed' }); return; }
    if (route === '/' || route === '/index.html') { await index(res); return; }
    const file = path.resolve(WWW, `.${decodeURIComponent(route)}`);
    if (!file.startsWith(WWW + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { send(res, 404, 'Not found', 'text/plain'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      // Vite's hashed assets never change; everything else is read again.
      'Cache-Control': route.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  } catch (error) {
    log(`${req.method} ${route}:`, error.message);
    if (!res.headersSent) send(res, 500, { error: error.message });
  }
});

reloadLinks();
listen();
server.listen(PORT, () => log(`House Control on port ${PORT}${SUPERVISED ? ' (Home Assistant add-on)' : ` → ${HA.api}`}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(); process.exit(0); });
