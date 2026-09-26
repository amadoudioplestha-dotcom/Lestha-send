/* Écriture disque ultra-rapide et reprenable (Origin Private File System, accès synchrone).
 * Les données sont écrites en place : rien n'est perdu si la page se ferme,
 * et le transfert P2P peut reprendre à l'octet près. */
const handles = new Map(); // name -> { fh, sync }
let queue = Promise.resolve();

async function open(name) {
  if (handles.has(name)) return handles.get(name);
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle(name, { create: true });
  const sync = await fh.createSyncAccessHandle();
  const h = { fh, sync };
  handles.set(name, h);
  return h;
}

async function handle(msg) {
  const { id, cmd, name } = msg;
  try {
    if (cmd === 'open') {
      const h = await open(name);
      return { id, ok: true, size: h.sync.getSize() };
    }
    if (cmd === 'write') {
      const h = await open(name);
      h.sync.write(new Uint8Array(msg.data), { at: msg.pos });
      h.writes = (h.writes || 0) + 1;
      if (h.writes % 16 === 0) h.sync.flush();
      return { id, ok: true, size: h.sync.getSize(), end: msg.pos + msg.data.byteLength };
    }
    if (cmd === 'truncate') {
      const h = await open(name);
      h.sync.truncate(msg.size);
      h.sync.flush();
      return { id, ok: true, size: h.sync.getSize() };
    }
    if (cmd === 'flush') {
      handles.forEach(h => { try { h.sync.flush(); } catch (e) { /* ignore */ } });
      return { id, ok: true };
    }
    if (cmd === 'close') {
      const h = handles.get(name);
      if (h) { try { h.sync.flush(); h.sync.close(); } catch (e) { /* ignore */ } handles.delete(name); }
      return { id, ok: true };
    }
    if (cmd === 'closeAll') {
      handles.forEach(h => { try { h.sync.flush(); h.sync.close(); } catch (e) { /* ignore */ } });
      handles.clear();
      return { id, ok: true };
    }
    return { id, ok: false, error: 'commande inconnue' };
  } catch (e) {
    return { id, ok: false, error: e.name === 'QuotaExceededError' ? 'Espace de stockage insuffisant sur cet appareil' : (e.message || String(e)) };
  }
}

self.onmessage = (e) => {
  // Traitement strictement séquentiel (ordre des écritures garanti)
  queue = queue.then(() => handle(e.data)).then((res) => self.postMessage(res));
};
