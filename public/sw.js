/* StreamSaver Service Worker */
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
  }
});