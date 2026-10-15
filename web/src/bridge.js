// Thin bridge to the native shell (the macOS menu bar app) or, inside Home Assistant, to the
// add-on's small server, which answers the same messages over HTTP. In a plain browser
// every call is a no-op, so the same bundle runs under `vite dev` too.

const isAddon = window.__HOUSE_BOOT__?.platform === 'addon';
const handler = window.webkit?.messageHandlers?.house || (isAddon ? addonHandler() : null);

export const isNative = Boolean(handler);
export { isAddon };

// 'ios' inside the iPhone app (or with ?platform=ios in a browser, to work on that layout).
export const platform = window.__HOUSE_BOOT__?.platform
  || new URLSearchParams(location.search).get('platform') || (handler ? 'macos' : 'web');
export const isPhone = platform === 'ios';

export function post(type, payload = {}) {
  handler?.postMessage({ type, ...payload });
}

// A tap you can feel, on the iPhone only: 'tick' for a step of a slider, 'light' /
// 'medium' for a switch or a scene, 'error' when a device refuses a change.
export function haptic(kind = 'light') {
  if (isPhone) post('haptic', { kind });
}

// Native -> JS entry points are attached here by main.js.
export const incoming = (window.house = window.house || {});

// Request/response on top of the one-way message channel.
let nextId = 1;
const pending = new Map();

export function call(type, payload = {}) {
  if (!handler) return Promise.reject(new Error('Only available inside the app'));
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    handler.postMessage({ type, callId: id, ...payload });
  });
}

incoming.reply = (id, result) => {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (result && result.error) p.reject(Object.assign(new Error(result.error), { detail: result }));
  else p.resolve(result);
};

/** Opens another view (panel, editor, charts) in this same page. */
export function openMode(mode) {
  const params = new URLSearchParams(location.search);
  if (mode === 'panel') params.delete('mode'); else params.set('mode', mode);
  const query = params.toString();
  location.search = query ? `?${query}` : '';
}

// The add-on's stand-in for WKScriptMessageHandler: requests go to ./api/call, one-way
// messages to ./api/post, and what the Mac app would push arrives by long polling ./api/events.
// Relative URLs keep it working under Home Assistant's Ingress path.
function addonHandler() {
  const client = Math.random().toString(36).slice(2);
  const json = (url, body) => fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => (r.ok ? r.json() : { error: `House Control answered ${r.status}` }));

  // Things a window or a file dialog does in the Mac app.
  const local = {
    openEditor: () => openMode('editor'),
    openCharts: () => openMode('charts'),
    exportPlan: ({ config }) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' }));
      a.download = `${String(config?.name || 'home').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      return { ok: true };
    },
    importPlan: () => new Promise((resolve) => {
      const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'application/json,.json' });
      input.addEventListener('change', async () => {
        try { resolve({ config: JSON.parse(await input.files[0].text()) }); } catch { resolve({ cancelled: true }); }
      });
      input.addEventListener('cancel', () => resolve({ cancelled: true }));
      input.click();
    }),
  };

  async function listen() {
    let since = 0;
    for (;;) {
      try {
        const r = await fetch(`./api/events?client=${client}&since=${since}`, { cache: 'no-store' });
        if (!r.ok) throw new Error(String(r.status));
        const body = await r.json();
        since = body.seq;
        for (const e of body.events) {
          if (e.name === 'reload') location.reload();
          else incoming[e.name]?.(e.payload);
        }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }
  setTimeout(listen, 0);

  return {
    async postMessage(message) {
      const { callId, ...msg } = message;
      if (callId == null) {
        if (local[msg.type]) local[msg.type](msg);
        else if (msg.type === 'state' || msg.type === 'selectPlan') {
          const sent = json(`./api/post?client=${client}`, msg).catch(() => {});
          if (msg.type === 'selectPlan') sent.then(() => location.reload());
        }
        return;
      }
      let result;
      try {
        result = local[msg.type] ? await local[msg.type](msg) : await json('./api/call', msg);
      } catch (error) {
        result = { error: `House Control did not answer: ${error.message}` };
      }
      incoming.reply(callId, result);
    },
  };
}
