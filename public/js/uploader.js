/* TransferX — moteur d'envoi Cloud
 * - morceaux de 16 Mo envoyés en parallèle directement vers R2 (URLs présignées)
 * - reprise automatique : coupure réseau, onglet en arrière-plan, rechargement de page
 * - aucun fichier chargé en mémoire : le navigateur lit chaque morceau depuis le disque
 */
import { api, isMobile, lowMemory } from './core.js';

const MAX_RETRY_DELAY = 30000;

export class Uploader extends EventTarget {
  /**
   * @param {object} o
   * @param {string} o.id        identifiant du transfert
   * @param {string} o.key       clé de gestion
   * @param {Array}  o.items     [{ file: File, meta: {id, partSize, partCount, done} }]
   * @param {boolean} o.resume   interroger le serveur pour sauter les morceaux déjà reçus
   */
  constructor({ id, key, items, resume = false, concurrency }) {
    super();
    this.id = id; this.key = key; this.items = items; this.resume = resume;
    this.concurrency = concurrency || (lowMemory ? 2 : isMobile ? 3 : 5);
    this.total = items.reduce((s, it) => s + it.file.size, 0);
    this.state = 'idle';               // idle | running | paused | offline | done | error | cancelled
    this.queue = [];
    this.inflight = new Map();         // taskKey -> { xhr, loaded }
    this.doneBytes = 0;
    this.urlCache = new Map();         // fileId -> Map(part -> {url, exp})
    this.samples = [];                 // pour la vitesse
    this.speed = 0;
    this.speedHistory = [];
    this.fileState = new Map();        // fileId -> { done: Set, completing: bool, completed: bool, bytes }
    this._onOnline = () => { if (this.state === 'offline') { this._emit('state'); this._run(); } };
    this._onOffline = () => { if (this.state === 'running') { this.state = 'offline'; this._abortAll(); this._emit('state'); } };
  }

  _emit(type, detail = {}) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  get loaded() {
    let l = this.doneBytes;
    this.inflight.forEach(x => { l += x.loaded || 0; });
    return Math.min(l, this.total);
  }

  fileProgress() {
    return this.items.map(({ file, meta }) => {
      const st = this.fileState.get(meta.id);
      let b = st ? st.bytes : 0;
      this.inflight.forEach((x, k) => { if (k.startsWith(meta.id + ':')) b += x.loaded || 0; });
      return { id: meta.id, name: file.name, size: file.size, loaded: Math.min(b, file.size), done: !!(st && st.completed) };
    });
  }

  async start() {
    if (this.state === 'running') return;
    this.state = 'running';
    this._emit('state');
    window.addEventListener('online', this._onOnline);
    window.addEventListener('offline', this._onOffline);
    // Préparation de la file d'attente
    for (const { file, meta } of this.items) {
      const st = { done: new Set(), completing: false, completed: !!meta.done, bytes: 0 };
      this.fileState.set(meta.id, st);
      if (meta.done) { st.bytes = file.size; this.doneBytes += file.size; continue; }
      if (this.resume) {
        try {
          const r = await api(`/api/transfers/${this.id}/files/${meta.id}/parts`, { key: this.key });
          if (r.done) { st.completed = true; st.bytes = file.size; this.doneBytes += file.size; continue; }
          (r.parts || []).forEach(n => { st.done.add(n); const sz = this._partBytes(meta, file, n); st.bytes += sz; this.doneBytes += sz; });
        } catch (e) { if (e.status === 404 || e.status === 403) return this._fail(e); }
      }
      for (let n = 1; n <= meta.partCount; n++) if (!st.done.has(n)) this.queue.push({ meta, file, n });
    }
    this._ticker = setInterval(() => this._tick(), 1000);
    this._run();
    // Fichiers déjà entièrement envoyés (reprise) → finalisation
    for (const { file, meta } of this.items) this._maybeComplete(meta, file);
  }

  _partBytes(meta, file, n) {
    const off = (n - 1) * meta.partSize;
    return Math.max(0, Math.min(meta.partSize, file.size - off));
  }

  _tick() {
    const now = Date.now();
    this.samples.push({ t: now, b: this.loaded });
    while (this.samples.length && now - this.samples[0].t > 6000) this.samples.shift();
    if (this.samples.length > 1) {
      const a = this.samples[0], z = this.samples[this.samples.length - 1];
      const inst = (z.b - a.b) / Math.max(0.5, (z.t - a.t) / 1000);
      this.speed = this.speed ? this.speed * 0.6 + inst * 0.4 : inst;
    }
    if (this.state === 'running') { this.speedHistory.push(this.speed); if (this.speedHistory.length > 60) this.speedHistory.shift(); }
    this._progress();
  }

  _progress() {
    const loaded = this.loaded;
    const eta = this.speed > 0 ? (this.total - loaded) / this.speed : Infinity;
    this._emit('progress', { loaded, total: this.total, speed: this.state === 'running' ? this.speed : 0, eta, history: this.speedHistory });
  }

  _run() {
    if (this.state === 'offline' && navigator.onLine !== false) this.state = 'running';
    if (this.state !== 'running') return;
    while (this.inflight.size < this.concurrency && this.queue.length) {
      const task = this.queue.shift();
      this._upload(task);
    }
    if (!this.queue.length && !this.inflight.size) this._checkAllDone();
  }

  async _getUrl(meta, n) {
    let cache = this.urlCache.get(meta.id);
    if (!cache) { cache = new Map(); this.urlCache.set(meta.id, cache); }
    const hit = cache.get(n);
    if (hit && hit.exp > Date.now()) return hit.url;
    // On demande un lot : ce morceau + les suivants de la file pour ce fichier
    const wanted = [n];
    for (const q of this.queue) { if (q.meta.id === meta.id && wanted.length < 24) wanted.push(q.n); }
    const r = await api(`/api/transfers/${this.id}/files/${meta.id}/urls`, { method: 'POST', key: this.key, body: { parts: wanted } });
    const exp = Date.now() + 2 * 3600 * 1000;
    Object.entries(r.urls || {}).forEach(([k, url]) => cache.set(Number(k), { url, exp }));
    const got = cache.get(n);
    if (!got) throw new Error('URL d\'envoi indisponible');
    return got.url;
  }

  async _upload(task) {
    const { meta, file, n } = task;
    const k = meta.id + ':' + n;
    const slot = { xhr: null, loaded: 0 };
    this.inflight.set(k, slot);
    try {
      const url = await this._getUrl(meta, n);
      if (this.state !== 'running') throw Object.assign(new Error('stopped'), { stopped: true });
      const off = (n - 1) * meta.partSize;
      const blob = file.slice(off, Math.min(off + meta.partSize, file.size));
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        slot.xhr = xhr;
        xhr.open('PUT', url, true);
        xhr.upload.onprogress = (e) => { slot.loaded = e.loaded; };
        xhr.onload = () => (xhr.status >= 200 && xhr.status < 300) ? resolve() : reject(Object.assign(new Error('HTTP ' + xhr.status), { status: xhr.status }));
        xhr.onerror = () => reject(Object.assign(new Error('Réseau'), { network: true }));
        xhr.ontimeout = () => reject(Object.assign(new Error('Délai dépassé'), { network: true }));
        xhr.onabort = () => reject(Object.assign(new Error('stopped'), { stopped: true }));
        xhr.timeout = 10 * 60 * 1000;
        xhr.send(blob);
      });
      this.inflight.delete(k);
      const st = this.fileState.get(meta.id);
      st.done.add(n);
      st.bytes += blob.size;
      this.doneBytes += blob.size;
      task.tries = 0;
      this._maybeComplete(meta, file);
    } catch (e) {
      this.inflight.delete(k);
      if (this.state === 'cancelled') return;
      this.queue.unshift(task);                  // on remet le morceau en tête de file
      if (e.stopped) return;
      if (e.status === 403 || e.status === 400) { const c = this.urlCache.get(meta.id); if (c) c.delete(n); } // URL expirée
      if (e.status === 404 && !e.network) {
        // transfert supprimé ?
        try { await api(`/api/transfers/${this.id}`, { key: this.key }); } catch (e2) { if (e2.status === 404 || e2.status === 403) return this._fail(e2); }
      }
      if (navigator.onLine === false) { this._onOffline(); return; }
      task.tries = (task.tries || 0) + 1;
      const delay = Math.min(MAX_RETRY_DELAY, 800 * Math.pow(2, task.tries - 1)) + Math.random() * 400;
      this._emit('retry', { attempt: task.tries, delay, message: e.message });
      await new Promise(r => setTimeout(r, delay));
    }
    this._run();
  }

  async _maybeComplete(meta, file) {
    const st = this.fileState.get(meta.id);
    if (!st || st.completed || st.completing || st.done.size < meta.partCount) return;
    st.completing = true;
    try {
      await api(`/api/transfers/${this.id}/files/${meta.id}/complete`, { method: 'POST', key: this.key, body: {} });
      st.completed = true;
      this._emit('filecomplete', { id: meta.id, name: file.name });
    } catch (e) {
      if (e.status === 409 && e.data && Array.isArray(e.data.missing) && e.data.missing.length) {
        // Le serveur signale des morceaux manquants → on les renvoie
        e.data.missing.forEach(n => {
          if (st.done.delete(n)) { const sz = this._partBytes(meta, file, n); st.bytes -= sz; this.doneBytes -= sz; }
          this.queue.push({ meta, file, n });
        });
      } else if (e.status === 404 || e.status === 403) {
        st.completing = false;
        return this._fail(e);
      } else {
        await new Promise(r => setTimeout(r, 3000));
        st.completing = false;
        return this._maybeComplete(meta, file);
      }
    }
    st.completing = false;
    this._run();
  }

  async _checkAllDone() {
    if (this._finishing || this.state !== 'running') return;
    const all = this.items.every(({ meta }) => this.fileState.get(meta.id)?.completed);
    if (!all) return;
    this._finishing = true;
    this.state = 'done';
    clearInterval(this._ticker);
    this._progress();
    this._cleanup();
    this._emit('done');
  }

  _abortAll() { this.inflight.forEach(x => { try { x.xhr && x.xhr.abort(); } catch (e) { /* ignore */ } }); }

  pause() {
    if (this.state !== 'running' && this.state !== 'offline') return;
    this.state = 'paused';
    this._abortAll();
    this.speed = 0;
    this._emit('state');
    this._progress();
  }

  resumeUpload() {
    if (this.state !== 'paused' && this.state !== 'offline') return;
    this.state = 'running';
    this._emit('state');
    this._run();
  }

  async cancel({ deleteRemote = true } = {}) {
    this.state = 'cancelled';
    this._abortAll();
    clearInterval(this._ticker);
    this._cleanup();
    this._emit('state');
    if (deleteRemote) { try { await api(`/api/transfers/${this.id}`, { method: 'DELETE', key: this.key }); } catch (e) { /* ignore */ } }
  }

  _fail(e) {
    this.state = 'error';
    this._abortAll();
    clearInterval(this._ticker);
    this._cleanup();
    this._emit('state');
    this._emit('error', { message: e.message || 'Erreur' });
  }

  _cleanup() {
    window.removeEventListener('online', this._onOnline);
    window.removeEventListener('offline', this._onOffline);
  }
}
