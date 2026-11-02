/* Service worker.
   Shell is cache-first so the app opens instantly and works with no signal.
   /api/data is network-first: a cached copy only stands in when the
   network fails or takes longer than a few seconds. (It used to be
   stale-while-revalidate, which meant every launch painted the data from
   the launch before — the "needs a hard refresh" bug.) Everything else (tiles, listing photos) is
   cache-on-use with a cap, so a property you have already looked at stays
   visible when you are standing outside it with one bar. */
var V = 'pm-v96';
var SHELL = [
  './', './index.html', './app.js', './bookmarklet.html', './manifest.webmanifest',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(V + '-shell').then(function (c) {
    return Promise.allSettled(SHELL.map(function (u) { return c.add(u); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k.indexOf(V) !== 0; })
                         .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function trim(name, max) {
  caches.open(name).then(function (c) {
    c.keys().then(function (ks) {
      for (var i = 0; i < ks.length - max; i++) c.delete(ks[i]);
    });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;                 // writes go through the outbox
  var url = new URL(req.url);

  // never cache auth
  if (url.pathname.indexOf('/api/login') === 0 ||
      url.pathname.indexOf('/api/logout') === 0 ||
      url.pathname.indexOf('/api/me') === 0) return;

  if (url.pathname === '/api/data') {
    e.respondWith(caches.open(V + '-data').then(function (c) {
      return c.match(req).then(function (hit) {
        var net = fetch(req).then(function (r) {
          if (r.ok) c.put(req, r.clone());
          return r;
        });
        if (!hit) return net;
        // one bar outside a house: show what we had rather than a spinner
        var slow = new Promise(function (res) { setTimeout(function () { res(hit); }, 4000); });
        return Promise.race([net.catch(function () { return hit; }), slow]);
      });
    }));
    return;
  }

  // Shell lookups are scoped to THIS version's cache. `caches.match(req)`
  // searches every generation, so mid-update a page could be served last
  // version's index.html alongside this version's app.js — which is exactly
  // how the documents section once rendered with none of its styling.
  if (url.origin === location.origin && (req.mode === 'navigate' || SHELL.indexOf(url.pathname) !== -1)) {
    e.respondWith(caches.open(V + '-shell').then(function (c) {
      return c.match(req).then(function (hit) {
        return hit || fetch(req).then(function (r) {
          var copy = r.clone();
          c.put(req, copy);
          return r;
        }).catch(function () { return c.match('./index.html'); });
      });
    }));
    return;
  }

  // Videos stay on the network. The player asks for byte ranges, which a
  // cached 200 cannot answer (Safari then refuses to play at all), and one
  // walk-through would push hundreds of tiles out of the cap.
  if (/\/photos\/.+\.(mp4|mov|webm)$/i.test(url.pathname)) return;

  // tiles, photos and documents: serve from cache when we have it, fill in
  // when we don't — a floorplan you have opened stays readable at the gate
  if (/tile\.openstreetmap|mms\.seloger|v\.seloger|img\.leboncoin|streetviewpixels|\/photos\/|\/files\//.test(req.url)) {
    e.respondWith(caches.open(V + '-media').then(function (c) {
      return c.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (r) {
          if (r.ok || r.type === 'opaque') { c.put(req, r.clone()); trim(V + '-media', 900); }
          return r;
        }).catch(function () { return hit || Response.error(); });
      });
    }));
  }
});
