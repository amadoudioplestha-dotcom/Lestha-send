/* Lestha Send — Service Worker
 * - cache de l'interface (démarrage instantané, fonctionne hors ligne)
 * - cible de partage Android ("Partager vers Lestha Send")
 * - n'intercepte JAMAIS les API, les téléchargements ni socket.io (sauf le ZIP fabriqué par la page, /__zip__/)
 */
'use strict';
const VERSION = 'tx-v3.26.0';
const SHELL = ['/', '/style.css', '/js/theme.js', '/js/main.js', '/js/ux.js', '/js/core.js', '/js/router.js', '/js/send.js', '/js/uploader.js', '/js/p2p.js', '/js/receive-code.js', '/js/meet.js', '/js/meet-teach.js', '/js/meet-doc.js', '/js/meet-replay.js', '/js/account.js', '/js/ink-draw.js', '/js/replay-player.js', '/replay', '/js/receive.js', '/js/gallery.js', '/js/gallery-previews.js', '/js/doc-viewer.js', '/js/doc-office.js', '/js/doc-thumb.js', '/js/zip-range.js', '/js/zip-stream.js', '/js/dashboard.js', '/js/manage.js', '/js/charts.js', '/js/opfs-worker.js', '/js/nearby.js', '/js/watch.js', '/js/request.js', '/js/review-tools.js', '/js/live.js', '/manifest.json', '/icon-192.png', '/icon-512.png', '/icon-192.svg', '/vendor/qrcode.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('tx-') && k !== VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* ZIP fabriqué dans la page (3.26) : la page envoie les morceaux, le Service Worker les remet au navigateur
   comme un téléchargement ordinaire. Les fichiers viennent du stockage, pas du serveur de l'application. */
const ZIPS = new Map();
self.addEventListener('message', (e) => {
  const d = e.data;
  if (d && d.type === 'zip-stream' && e.ports[0]) {
    ZIPS.set(d.id, { port: e.ports[0], name: d.name, size: d.size });
    setTimeout(() => ZIPS.delete(d.id), 60e3);   // jamais réclamé : oublié
  }
});
function zipResponse(id) {
  const z = ZIPS.get(id);
  if (!z) return new Response('Téléchargement expiré, recommencez.', { status: 404 });
  ZIPS.delete(id);
  const port = z.port;
  const stream = new ReadableStream({
    start(c) {
      port.onmessage = (m) => {
        const d = m.data;
        if (d instanceof Uint8Array) c.enqueue(d);
        else if (d === 'end') { c.close(); port.close(); }
        else if (d && d.error) { c.error(new Error(d.error)); port.close(); }
      };
      port.postMessage('start');
    },
    pull() { port.postMessage('pull'); },
    cancel() { port.postMessage('cancel'); }
  }, new CountQueuingStrategy({ highWaterMark: 8 }));
  const headers = { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(z.name)}`, 'Cache-Control': 'no-store' };
  if (z.size) headers['Content-Length'] = String(z.size);
  return new Response(stream, { headers });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/__zip__/')) { event.respondWith(zipResponse(url.pathname.split('/')[2])); return; }

  // Cible de partage (Android) : on stocke les fichiers puis on ouvre l'appli
  if (req.method === 'POST' && url.pathname === '/share') {
    event.respondWith((async () => {
      try {
        const form = await req.formData();
        const files = form.getAll('shared_file').filter(f => f instanceof File);
        const cache = await caches.open('shared-inbox');
        let i = 0;
        for (const file of files) {
          await cache.put(new Request('/__shared__/' + (i++) + '-' + Date.now()), new Response(file, { headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name || 'fichier') } }));
        }
        return Response.redirect('/?shared=1', 303);
      } catch (e) { return Response.redirect('/', 303); }
    })());
    return;
  }

  if (req.method !== 'GET') return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/') || url.pathname === '/health') return;

  // Navigation : réseau d'abord (toujours à jour), cache si hors ligne
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match(url.pathname === '/replay' ? '/replay' : '/')));
    return;
  }
  // Ressources de l'interface : réseau d'abord (jamais de versions mélangées), cache si hors ligne
  if (SHELL.includes(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(VERSION);
      try {
        const res = await fetch(req, { cache: 'no-cache' });
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch (e) {
        return (await cache.match(req)) || (await cache.match(req, { ignoreSearch: true })) || Response.error();
      }
    })());
  }
});
