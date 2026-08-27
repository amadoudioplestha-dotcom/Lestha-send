/* StreamSaver + Share Target Service Worker */
'use strict';
const map = new Map;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('message', event => {
  if (event.data.action === 'intercept') {
    map.set(event.data.id, event.ports[0]);
  }
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

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
        
        // Retransmettre le fichier à l'interface client
        const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of clients) {
          client.postMessage({ type: 'SHARED_FILE', file: file });
        }
        
        // Rediriger vers la page d'accueil pour que l'app s'affiche proprement
        return Response.redirect('/?shared=true', 303);
      } catch (e) {
        return Response.redirect('/', 303);
      }
    })());
  }
});