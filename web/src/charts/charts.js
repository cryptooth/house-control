// The charts window: Home Assistant's numeric sensors (temperature, humidity, power…) over the
// last day or week, read through the native bridge from Home Assistant's history API. In a
// plain browser it shows made-up sensors, so the page can be worked on with `vite dev`.
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { isNative, isAddon, call, post, openMode } from '../bridge.js';
import './charts.css';

const RANGES = [
  { id: '24h', label: '24 h', hours: 24 },
  { id: '3d', label: '3 days', hours: 72 },
  { id: '7d', label: '7 days', hours: 168 },
];
const GROUPS = [
  ['temperature', 'Temperature'], ['humidity', 'Humidity'], ['power', 'Power'], ['energy', 'Energy'],
  ['illuminance', 'Light level'], ['battery', 'Battery'], ['', 'Other'],
];
const STORE_KEY = 'charts.v1';
const SVG = 'http://www.w3.org/2000/svg';
const CHART_H = 168;
const PAD = { top: 10, right: 12, bottom: 24, left: 44 };

const remember = {
  load() { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; } },
  save(value) { try { localStorage.setItem(STORE_KEY, JSON.stringify(value)); } catch { /* private window */ } },
};

const groupOf = (s) => (GROUPS.some(([id]) => id && id === s.deviceClass) ? s.deviceClass : '');

export async function bootCharts(root) {
  const saved = remember.load();
  const state = {
    sensors: null,
    error: null,
    range: RANGES.some((r) => r.id === saved.range) ? saved.range : '24h',
    pinned: Array.isArray(saved.pinned) ? saved.pinned : null,
    query: '',
  };
  const connected = !isNative || Boolean(window.__HOUSE_BOOT__?.services?.homeassistant?.connected);
  const persist = () => remember.save({ range: state.range, pinned: state.pinned });

  const list = h('div.ch-list');
  const grid = h('div.ch-grid');
  const search = h('input.ch-search', { type: 'search', placeholder: 'Search sensors', spellcheck: 'false' });
  search.addEventListener('input', () => { state.query = search.value.trim().toLowerCase(); renderList(); });
  const ranges = h('div.ch-ranges', { role: 'radiogroup', 'aria-label': 'Time range' });
  const refresh = h('button.btn', { onclick: () => renderGrid(true), title: 'Read the history again' }, icon('rotate', 14), 'Refresh');

  root.replaceChildren(h('div.charts',
    h('header.ch-bar',
      h('div.ch-title', icon('activity', 18), h('b', 'Charts'), h('span', isNative ? 'from Home Assistant' : 'demo data')),
      ranges, refresh,
      isAddon ? h('button.btn', { onclick: () => openMode('panel'), title: 'Back to the 3D view' }, icon('home', 14), 'Home') : null),
    h('aside.ch-side', search, list),
    h('main.ch-main', grid)));

  function renderRanges() {
    ranges.replaceChildren(...RANGES.map((r) => h(`button.ch-range${r.id === state.range ? '.on' : ''}`, {
      role: 'radio', 'aria-checked': String(r.id === state.range),
      onclick: () => { state.range = r.id; persist(); renderRanges(); renderGrid(); },
    }, r.label)));
  }

  function renderList() {
    if (!state.sensors) {
      list.replaceChildren(h('p.note', state.error || 'Loading sensors…'));
      return;
    }
    const q = state.query;
    const shown = state.sensors.filter((s) => !q || `${s.name} ${s.id} ${s.room || ''}`.toLowerCase().includes(q));
    list.replaceChildren(...GROUPS.flatMap(([id, title]) => {
      const items = shown.filter((s) => groupOf(s) === id);
      if (!items.length) return [];
      return h('section.ch-group', h('h3', `${title} · ${items.length}`), items.map((s) => {
        const on = state.pinned.includes(s.id);
        return h(`button.ch-item${on ? '.on' : ''}`, {
          'aria-pressed': String(on),
          onclick: () => {
            state.pinned = on ? state.pinned.filter((p) => p !== s.id) : [...state.pinned, s.id];
            persist(); renderList(); renderGrid();
          },
        },
        h('span.ch-check', on ? icon('check', 12, 3) : null),
        h('span.ch-item-text', h('b', s.name), h('span', [s.room, formatValue(s.value, s.unit)].filter(Boolean).join(' · '))));
      }));
    }), ...(shown.length ? [] : [h('p.note', 'No sensor matches.')]));
  }

  // Charts already drawn, by sensor id: kept while only the selection changes.
  const cards = new Map();

  function renderGrid(reload = false) {
    if (!connected) {
      grid.replaceChildren(h('div.ch-empty', h('b', 'Home Assistant is not connected'),
        h('span', 'Connect it in the editor, then come back here.'),
        h('button.btn.primary', { onclick: () => post('openEditor') }, 'Open the editor')));
      return;
    }
    if (!state.sensors) { grid.replaceChildren(h('p.note', state.error || 'Loading…')); return; }
    const byId = new Map(state.sensors.map((s) => [s.id, s]));
    const pinned = state.pinned.filter((id) => byId.has(id));
    if (!pinned.length) {
      grid.replaceChildren(h('div.ch-empty', h('b', 'Nothing to chart yet'), h('span', 'Pick sensors on the left.')));
      return;
    }
    const hours = RANGES.find((r) => r.id === state.range).hours;
    for (const [id, card] of cards) if (!pinned.includes(id)) { card.dispose(); cards.delete(id); }
    grid.replaceChildren(...pinned.map((id) => {
      let card = cards.get(id);
      if (!card) { card = createCard(byId.get(id)); cards.set(id, card); }
      card.show(hours, reload);
      return card.el;
    }));
  }

  renderRanges();
  renderList();
  renderGrid();
  try {
    state.sensors = isNative ? (await call('charts.sensors')).sensors : demoSensors();
  } catch (e) {
    state.error = e.message;
  }
  if (state.sensors && !state.pinned) {
    // First visit: a few temperatures and humidities to start from.
    state.pinned = state.sensors.filter((s) => ['temperature', 'humidity'].includes(s.deviceClass)).slice(0, 4).map((s) => s.id);
    persist();
  }
  state.pinned ||= [];
  renderList();
  renderGrid();
  post('ready');
}

/* ---------- one chart ---------- */

function createCard(sensor) {
  const value = h('div.ch-value');
  const stats = h('div.ch-stats');
  const plot = h('div.ch-plot');
  const tip = h('div.ch-tip', { role: 'status', 'aria-live': 'polite' });
  const table = h('div.ch-table', { hidden: true });
  const toggle = h('button.btn.link', { 'aria-expanded': 'false' }, 'Show values');
  const el = h('article.ch-card',
    h('div.ch-head',
      h('div.ch-name', h('b', sensor.name), h('span', [sensor.room, sensor.id].filter(Boolean).join(' · '))),
      value),
    stats,
    h('div.ch-plot-wrap', plot, tip),
    h('div.ch-foot', toggle),
    table);
  let points = [];
  let loadedHours = 0;
  let span = [0, 0];
  let request = 0;

  toggle.addEventListener('click', () => {
    table.hidden = !table.hidden;
    toggle.textContent = table.hidden ? 'Show values' : 'Hide values';
    toggle.setAttribute('aria-expanded', String(!table.hidden));
    if (!table.hidden) renderTable();
  });

  const observer = new ResizeObserver(() => draw());
  observer.observe(plot);

  async function show(hours, reload) {
    if (hours === loadedHours && !reload) return;
    loadedHours = hours;
    const mine = ++request;
    el.classList.add('loading');
    let result;
    try {
      result = isNative ? (await call('charts.history', { id: sensor.id, hours })).points : demoHistory(sensor, hours);
    } catch (e) {
      if (mine !== request) return;
      el.classList.remove('loading');
      plot.replaceChildren(h('p.note.bad', e.message));
      return;
    }
    if (mine !== request) return;
    el.classList.remove('loading');
    const now = Date.now();
    span = [now - hours * 3600_000, now];
    points = result.filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v));
    // The sensor still reads its last value now: carry the line to the right edge.
    if (points.length) points.push([now, points[points.length - 1][1]]);
    draw();
    if (!table.hidden) renderTable();
  }

  function draw() {
    const width = plot.clientWidth;
    if (!width) return;
    const last = points[points.length - 1];
    value.replaceChildren(last ? formatValue(last[1], sensor.unit) : '—');
    if (points.length < 2) {
      stats.replaceChildren();
      plot.replaceChildren(h('p.note', points.length ? 'Not enough history yet.' : 'No history in this range.'));
      return;
    }
    const values = points.map((p) => p[1]);
    const lo = Math.min(...values), hi = Math.max(...values);
    const avg = timeWeightedMean(points);
    stats.replaceChildren(...[['Min', lo], ['Average', avg], ['Max', hi]].map(([label, v]) =>
      h('span', h('em', label), formatValue(v, sensor.unit))));

    const ticks = niceTicks(lo, hi, 4);
    const y0 = ticks[0], y1 = ticks[ticks.length - 1];
    const innerW = width - PAD.left - PAD.right, innerH = CHART_H - PAD.top - PAD.bottom;
    const x = (t) => PAD.left + ((t - span[0]) / (span[1] - span[0])) * innerW;
    const y = (v) => PAD.top + (1 - (v - y0) / (y1 - y0 || 1)) * innerH;

    const svg = svgEl('svg', { width, height: CHART_H, viewBox: `0 0 ${width} ${CHART_H}`, role: 'img',
      'aria-label': `${sensor.name}, ${formatValue(lo, sensor.unit)} to ${formatValue(hi, sensor.unit)}` });
    for (const v of ticks) {
      svg.append(svgEl('line', { class: 'grid', x1: PAD.left, x2: width - PAD.right, y1: y(v), y2: y(v) }));
      const label = svgEl('text', { class: 'tick', x: PAD.left - 8, y: y(v), 'text-anchor': 'end', 'dominant-baseline': 'middle' });
      label.textContent = formatNumber(v, ticks);
      svg.append(label);
    }
    for (const t of timeTicks(span, innerW)) {
      const label = svgEl('text', { class: 'tick', x: x(t.at), y: CHART_H - 6, 'text-anchor': 'middle' });
      label.textContent = t.label;
      svg.append(label);
    }
    const line = points.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join('');
    const base = y(y0);
    svg.append(svgEl('path', { class: 'area', d: `${line}L${x(points[points.length - 1][0]).toFixed(1)},${base}L${x(points[0][0]).toFixed(1)},${base}Z` }));
    svg.append(svgEl('path', { class: 'line', d: line }));
    svg.append(svgEl('circle', { class: 'end', cx: x(last[0]), cy: y(last[1]), r: 4 }));
    const cross = svgEl('line', { class: 'cross', y1: PAD.top, y2: PAD.top + innerH, visibility: 'hidden' });
    const dot = svgEl('circle', { class: 'end', r: 4, visibility: 'hidden' });
    svg.append(cross, dot);
    const hit = svgEl('rect', { class: 'hit', x: PAD.left, y: 0, width: innerW, height: CHART_H, tabindex: 0 });
    svg.append(hit);

    const at = (index) => {
      const [t, v] = points[index];
      cross.setAttribute('x1', x(t)); cross.setAttribute('x2', x(t)); cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', x(t)); dot.setAttribute('cy', y(v)); dot.setAttribute('visibility', 'visible');
      tip.replaceChildren(h('b', formatValue(v, sensor.unit)), h('span', formatWhen(t)));
      tip.style.left = `${clampPx(x(t), 70, width - 70)}px`;
      tip.classList.add('show');
    };
    const hide = () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.classList.remove('show'); };
    let focused = points.length - 1;
    hit.addEventListener('pointermove', (ev) => {
      const box = svg.getBoundingClientRect();
      const t = span[0] + ((ev.clientX - box.left - PAD.left) / innerW) * (span[1] - span[0]);
      focused = nearest(points, t);
      at(focused);
    });
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('blur', hide);
    hit.addEventListener('focus', () => at(focused));
    hit.addEventListener('keydown', (ev) => {
      const step = ev.key === 'ArrowLeft' ? -1 : ev.key === 'ArrowRight' ? 1 : 0;
      if (!step) return;
      ev.preventDefault();
      focused = Math.max(0, Math.min(points.length - 1, focused + step));
      at(focused);
    });
    plot.replaceChildren(svg);
  }

  // One row per hour (per six hours over a week), newest first.
  function renderTable() {
    if (points.length < 2) { table.replaceChildren(); return; }
    const hours = (span[1] - span[0]) / 3600_000;
    const every = (hours > 72 ? 6 : 1) * 3600_000;
    const rows = [];
    for (let t = span[1]; t >= span[0]; t -= every) rows.push([t, points[nearest(points, t)][1]]);
    table.replaceChildren(h('table',
      h('thead', h('tr', h('th', 'Time'), h('th', sensor.unit ? `Value (${sensor.unit})` : 'Value'))),
      h('tbody', rows.map(([t, v]) => h('tr', h('td', formatWhen(t)), h('td', formatNumber(v)))))));
  }

  return {
    el,
    show,
    dispose() { observer.disconnect(); request++; },
  };
}

/* ---------- helpers ---------- */

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

const clampPx = (v, a, b) => (b < a ? v : Math.min(b, Math.max(a, v)));

function nearest(points, t) {
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] < t) lo = mid; else hi = mid;
  }
  return Math.abs(points[lo][0] - t) <= Math.abs(points[hi][0] - t) ? lo : hi;
}

// Each value counts for as long as the sensor held it, so a burst of readings does not tip the mean.
function timeWeightedMean(points) {
  let sum = 0, total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const dt = points[i + 1][0] - points[i][0];
    sum += points[i][1] * dt;
    total += dt;
  }
  return total ? sum / total : points[0][1];
}

/** Round tick values spanning lo…hi: steps of 1, 2 or 5 times a power of ten. */
export function niceTicks(lo, hi, count = 4) {
  if (lo === hi) { const pad = Math.abs(lo) * 0.05 || 1; lo -= pad; hi += pad; }
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const out = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 0.5; v += step) {
    out.push(Math.round(v / step) * step);
    if (v >= hi) break;
  }
  return out.length > 1 ? out : [out[0], out[0] + step];
}

function timeTicks([from, to], width) {
  const hours = (to - from) / 3600_000;
  const out = [];
  if (hours <= 30) {
    const every = (width < 420 ? 6 : 4) * 3600_000;
    const first = new Date(from); first.setMinutes(0, 0, 0);
    for (let t = first.getTime() + 3600_000; t < to; t += 3600_000) {
      const d = new Date(t);
      if (d.getHours() % (every / 3600_000) === 0) out.push({ at: t, label: d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
    }
  } else {
    const first = new Date(from); first.setHours(24, 0, 0, 0);
    const days = Math.ceil(hours / 24);
    const every = days > 4 && width < 520 ? 2 : 1;
    for (let t = first.getTime(), i = 0; t < to; t += 86_400_000, i++) {
      if (i % every === 0) out.push({ at: t, label: new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric' }) });
    }
  }
  return out.filter((t) => t.at > from && t.at < to);
}

function decimalsFor(ticks) {
  if (!ticks || ticks.length < 2) return null;
  const step = Math.abs(ticks[1] - ticks[0]);
  return step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step)));
}

function formatNumber(v, ticks) {
  const decimals = decimalsFor(ticks);
  if (decimals != null) return v.toLocaleString([], { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const abs = Math.abs(v);
  if (abs >= 10_000) return v.toLocaleString([], { notation: 'compact', maximumFractionDigits: 1 });
  return v.toLocaleString([], { maximumFractionDigits: abs >= 100 ? 0 : abs >= 10 ? 1 : 2 });
}

function formatValue(v, unit) {
  if (!Number.isFinite(v)) return '—';
  return unit ? `${formatNumber(v)} ${unit}` : formatNumber(v);
}

function formatWhen(t) {
  return new Date(t).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

/* ---------- browser preview ---------- */

function demoSensors() {
  return [
    { id: 'sensor.living_temperature', name: 'Living room temperature', room: 'Living', unit: '°C', deviceClass: 'temperature', value: 22.4 },
    { id: 'sensor.bedroom_temperature', name: 'Bedroom temperature', room: 'Bedroom', unit: '°C', deviceClass: 'temperature', value: 20.9 },
    { id: 'sensor.outdoor_temperature', name: 'Outdoor temperature', room: 'Balcony', unit: '°C', deviceClass: 'temperature', value: 14.2 },
    { id: 'sensor.bath_humidity', name: 'Bathroom humidity', room: 'Bathroom', unit: '%', deviceClass: 'humidity', value: 63 },
    { id: 'sensor.living_humidity', name: 'Living room humidity', room: 'Living', unit: '%', deviceClass: 'humidity', value: 48 },
    { id: 'sensor.house_power', name: 'House power', unit: 'W', deviceClass: 'power', value: 412 },
    { id: 'sensor.house_energy', name: 'House energy', unit: 'kWh', deviceClass: 'energy', value: 1834.2 },
    { id: 'sensor.phone_battery', name: 'Phone battery', unit: '%', deviceClass: 'battery', value: 81 },
    { id: 'sensor.co2', name: 'Office CO₂', room: 'Office', unit: 'ppm', deviceClass: 'carbon_dioxide', value: 640 },
  ];
}

function demoHistory(sensor, hours) {
  const now = Date.now();
  const out = [];
  let seed = [...sensor.id].reduce((a, c) => a + c.charCodeAt(0), 0);
  const noise = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280 - 0.5; };
  const n = Math.min(480, hours * 12);
  for (let i = 0; i <= n; i++) {
    const t = now - hours * 3600_000 + (i / n) * hours * 3600_000;
    const day = Math.sin(((new Date(t).getHours() + new Date(t).getMinutes() / 60 - 9) / 24) * 2 * Math.PI);
    let v;
    switch (sensor.deviceClass) {
      case 'temperature': v = sensor.value + day * (sensor.room === 'Balcony' ? 4 : 1.2) + noise() * 0.3; break;
      case 'humidity': v = sensor.value - day * 6 + noise() * 2; break;
      case 'power': v = Math.max(80, sensor.value + day * 180 + noise() * 260); break;
      case 'energy': v = sensor.value - (n - i) * (hours / n) * 0.4; break;
      case 'battery': v = 100 - ((i * 7) % 100) * 0.6; break;
      default: v = sensor.value + day * 120 + noise() * 40;
    }
    out.push([t, v]);
  }
  return out;
}
