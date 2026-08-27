/* StreamSaver + Share Target Service Worker */
/*
 * Le service worker reste minimal pour préserver le bfcache :
 * aucune interception inutile des navigations ou des requêtes ordinaires.
 */
'use strict';
const map = new Map;

self.addEventListener('install', () => {});
self.addEventListener('activate', event => {
  // Prendre le contrôle des pages ouvertes sans attendre une nouvelle navigation.
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', event => {
  if (event.data.action === 'intercept') {
    map.set(event.data.id, event.ports[0]);
  }
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  if (url.origin !== self.location.origin || url.pathname.includes('/socket.io/')) return;

  // 1️⃣ LOGIQUE EXISTANTE (StreamSaver)
  if (url.pathname.includes('/intercept/')) {
    const id = url.pathname.split('/intercept/')[1];
    const port = map.get(id);
    if (port) {
      event.respondWith(new Response(new ReadableStream({
        start(controller) {
          port.onmessage = event => {
            if (event.data === 'close') controller.close();
            else if (event.data.error) controller.error(new Error(event.data.error));
            else controller.enqueue(event.data);
          };
        }
      })));
      map.delete(id);
    }
    return;
  }

  // 2️⃣ NOUVELLE LOGIQUE (Share Target pour Mobile)
  if (event.request.method === 'POST' && url.pathname.endsWith('/share')) {
    event.respondWith((async () => {
      try {
        const formData = await event.request.formData();
        const file = formData.get('shared_file');
        if (!(file instanceof File)) throw new Error('Fichier partagé introuvable');

        const headers = new Headers({
          'Content-Type': file.type || 'application/octet-stream',
          'X-Filename': file.name || 'shared-file'
        });
        const cache = await caches.open('shared-inbox');
        await cache.put(new Request('/__shared__'), new Response(file, { headers }));

        // Rediriger vers la page d'accueil pour que l'app s'affiche proprement
        return Response.redirect('/?shared=1', 303);
      } catch (e) {
        return Response.redirect('/', 303);
      }
    })());
    return;
  }

  return;
});
