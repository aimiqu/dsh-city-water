/**
 * 城市水智管 · PWA Service Worker。
 * 仅接管 /api/dsh-city-water/workbench/ 作用域内的静态资源：
 *  - HTML（index.html）走 network-first，保证数据快照与鉴权新鲜；
 *  - CSS/JS/图标/manifest 走 cache-first，离线可用。
 */
'use strict';

var CACHE = 'dsh-city-water-v1';
var SCOPE = '/api/dsh-city-water/workbench/';

var PRECACHE = [
  SCOPE,
  SCOPE + 'index.html',
  SCOPE + 'water.css',
  SCOPE + 'water.js',
  SCOPE + 'manifest.json',
  SCOPE + 'icon-192.png',
  SCOPE + 'icon-512.png',
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(PRECACHE); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.pathname.indexOf(SCOPE) !== 0) return;

  var isHtml = req.destination === 'document' || url.pathname.slice(-1) === '/' || url.pathname.slice(-5) === '.html';

  if (isHtml) {
    // network-first：保持服务端注入的快照与鉴权最新，离线时回退缓存
    e.respondWith(
      fetch(req).then(function (resp) {
        var copy = resp.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
        return resp;
      }).catch(function () { return caches.match(req); })
    );
    return;
  }

  // cache-first：静态资源
  e.respondWith(
    caches.match(req).then(function (hit) {
      return hit || fetch(req).then(function (resp) {
        var copy = resp.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
        return resp;
      });
    })
  );
});
