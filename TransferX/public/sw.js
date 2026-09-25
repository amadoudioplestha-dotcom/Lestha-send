/* TransferX — Service Worker
 * - cache de l'interface (démarrage instantané, fonctionne hors ligne)
 * - cible de partage Android ("Partager vers TransferX")
 * - n'intercepte JAMAIS les API, les téléchargements ni socket.io
 */
'use strict';
const VERSION = 'tx-v3.0.0';
const SHELL = ['/', '/style.css', '/js/main.js', '/js/core.js', '/js/router.js', '/js/send.js', '/js/uploader.js', '/js/p2p.js', '/js/receive.js', '/js/dashboard.js', '/js/manage.js', '/js/charts.js', '/js/opfs-worker.js', '/manifest.json', '/icon-192.png', '/icon-512.png', '/icon-192.svg', '/vendor/qrcode.js'];

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

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

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
    event.respondWith(fetch(req).catch(() => caches.match('/')));
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
        return (await cache.match(req)) || Response.error();
      }
    })());
  }
});
