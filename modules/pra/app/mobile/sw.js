'use strict';
/**
 * sw.js — Sentinel mobile shell service worker.
 *
 * Two jobs:
 *   1. Cache the static shell so the PWA installs and opens instantly.
 *      /health, /dashboard, /clock, /requests etc. are NEVER cached — a
 *      case desk that shows stale counts is worse than one that admits it
 *      cannot see the server right now.
 *   2. Turn a Web Push event into an OS notification, using EXACTLY the
 *      payload shape server/push_notify.js sends: {title, body, path, tag}.
 *      No other fields exist to render, by design — see that file's header.
 */

const SHELL_CACHE = 'sentinel-mobile-shell-v1';
const SHELL_FILES = ['./index.html', './manifest.json', './app.js', './config.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isShellFile = SHELL_FILES.some((f) => url.pathname.endsWith(f.replace('./', '/')));
  if (!isShellFile) return; // everything else (the API) goes straight to network, uncached
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});

self.addEventListener('push', (event) => {
  let data = { title: 'Sentinel', body: 'New activity — open the desk.', path: './index.html', tag: 'sentinel' };
  try {
    if (event.data) data = Object.assign(data, event.data.json());
  } catch (_e) {
    if (event.data) data.body = event.data.text();
  }
  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    tag: data.tag,
    data: { path: data.path },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.path) || './index.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
