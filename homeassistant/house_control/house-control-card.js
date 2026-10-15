// A dashboard card that shows the House Control add-on in place.
//
// Ingress pages only open with an Ingress session cookie, which Home Assistant's own add-on
// panel creates. This card does the same (and keeps the session alive), then frames the
// add-on's Ingress address. Copy this file to /config/www/ and add it as a dashboard
// resource: /local/house-control-card.js (JavaScript module).
//
//   type: custom:house-control-card
//   height: 560px        # optional
//   mode: panel          # optional: panel (3D view), charts or editor
//   addon: local_house_control   # optional: the add-on's slug

class HouseControlCard extends HTMLElement {
  setConfig(config) {
    this.config = { height: '560px', mode: 'panel', addon: 'local_house_control', ...config };
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `
      <style>
        ha-card { overflow: hidden; height: ${this.config.height}; display: flex; flex-direction: column; }
        iframe { flex: 1; width: 100%; border: 0; display: block; background: #0b0f17; }
        .note { padding: 16px; color: var(--secondary-text-color); }
      </style>
      <ha-card><div class="note">Opening House Control…</div></ha-card>`;
    this.started = false;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this.started && this.isConnected) this.start();
  }

  connectedCallback() {
    if (this._hass && !this.started) this.start();
  }

  disconnectedCallback() {
    clearInterval(this.keepAlive);
    this.started = false;
  }

  async start() {
    this.started = true;
    const card = this.shadowRoot.querySelector('ha-card');
    try {
      const info = await this.supervisor(`/addons/${this.config.addon}/info`, 'get');
      if (!info?.ingress_url) throw new Error('This add-on has no Ingress address. Is it installed and started?');
      await this.session();
      clearInterval(this.keepAlive);
      this.keepAlive = setInterval(() => this.validate(), 60000);
      const query = this.config.mode && this.config.mode !== 'panel' ? `?mode=${encodeURIComponent(this.config.mode)}` : '';
      const frame = document.createElement('iframe');
      frame.src = `${info.ingress_url}${query}`;
      frame.allow = 'fullscreen';
      card.replaceChildren(frame);
    } catch (error) {
      this.started = false;
      card.innerHTML = '';
      const note = document.createElement('div');
      note.className = 'note';
      note.textContent = `House Control could not be opened: ${error.message || error}`;
      card.append(note);
    }
  }

  supervisor(endpoint, method, data) {
    return this._hass.callWS({ type: 'supervisor/api', endpoint, method, ...(data ? { data } : {}) });
  }

  // What Home Assistant's own Ingress panel does: a session, kept in a cookie for the Ingress path.
  async session() {
    const { session } = await this.supervisor('/ingress/session', 'post');
    this.ingressSession = session;
    const secure = location.protocol === 'https:' ? ';Secure' : '';
    document.cookie = `ingress_session=${session};path=/api/hassio_ingress/;SameSite=Strict${secure}`;
  }

  async validate() {
    try {
      await this.supervisor('/ingress/validate_session', 'post', { session: this.ingressSession });
    } catch {
      try { await this.session(); } catch { /* the next round tries again */ }
    }
  }

  getCardSize() {
    return Math.ceil(parseInt(this.config?.height, 10) / 50) || 10;
  }

  static getStubConfig() {
    return { height: '560px', mode: 'panel' };
  }
}

customElements.define('house-control-card', HouseControlCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'house-control-card',
  name: 'House Control',
  description: 'The House Control add-on (3D home, charts or editor) on a dashboard.',
});
