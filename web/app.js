/* ═══════════════════════════════════════════════════════════════════════
   Les biens — client.

   Everything the app needs arrives in one GET /api/data call, which the
   service worker serves network-first, and which is fetched again whenever
   the app comes back to the foreground and every minute while it is on
   screen — see "staying current". Writes go through an
   IndexedDB outbox: the UI updates immediately and the request replays
   whenever the connection comes back. That is what makes the app usable
   on a phone with one bar outside a house.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  /* Alex and Sam keep the record: they score, they edit, they delete.
     Any other account reads all of it and can say things — comments, photos,
     documents — but changes nothing. The API enforces this; everything here
     is only about not offering what would be refused. */
  var USERS = { alex: 'Alex', sam: 'Sam', guest: 'Invité' };
  var RATERS = ['alex', 'sam'];
  var GUEST = false;

  var euro = new Intl.NumberFormat('fr-FR', { style:'currency', currency:'EUR', maximumFractionDigits:0 });
  var num  = new Intl.NumberFormat('fr-FR');
  var when = new Intl.DateTimeFormat('fr-FR', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    });
  }
  function fmtPrice(p) { return p == null ? null : euro.format(p); }
  function fmtShort(p) {
    if (p == null) return '';
    return p >= 1000000 ? (p / 1000000).toFixed(p % 1000000 ? 2 : 1).replace('.', ',') + ' M'
                        : Math.round(p / 1000) + ' k';
  }
  function ppm(d) { return (d.price != null && d.surface) ? Math.round(d.price / d.surface) : null; }
  // A point someone placed by hand on the map is exact — more trustworthy than
  // a geocode, and on a par with an imported dropped pin.
  function approx(d) { return !!d.geo && d.geo !== 'dms' && d.geo !== 'manual'; }

  /* ─────────────────────── la note automatique ───────────────────────
     The note the data already holds, beside the two we give by hand.
     Four marks out of 10, averaged into stars out of 5 (half allowed):

       Emplacement  the one mark we set by hand (0–5), doubled
       Surface      terrain band (0–5) + house band (0–5)
       Énergie      DPE (0–5) + GES (0–5)
       Valeur       price per m² band (0–5), doubled

     A block whose inputs are all missing is dropped from the average
     rather than scored zero — a blank DPE is an unknown, not an F. The
     same goes inside a block, so a terrain with no house still scores. */
  var ENERGY_MARK = { A:5, B:4, C:3, D:2, E:1, F:0, G:0 };

  function bandMark(v, cuts, marks) {
    for (var i = 0; i < cuts.length; i++) if (v <= cuts[i]) return marks[i];
    return marks[marks.length - 1];
  }
  function landMark(t)  { return bandMark(t, [600, 800, 1000, 1500],      [1, 2, 3, 4, 5]); }
  function houseMark(s) { return bandMark(s, [130, 140, 150, 160, 200, 220], [1, 2, 3, 4, 5, 4, 3]); }
  function priceMark(m) { return bandMark(m, [3000, 3500, 4000, 4500, 5000], [5, 4, 3, 2, 1, 0]); }
  function energyMark(l) {
    var k = String(l == null ? '' : l).trim().toUpperCase().charAt(0);
    return ENERGY_MARK[k] != null ? ENERGY_MARK[k] : null;
  }

  // the sub-marks we do have, meaned and put back on the block's 0–10 scale
  function blockMark(parts) {
    var have = parts.filter(function (x) { return x != null; });
    if (!have.length) return null;
    return have.reduce(function (a, b) { return a + b; }, 0) / have.length * 2;
  }

  /* The listing's one mark. The two of us count double — what we think of a
     house outweighs what its label says — so with every field filled in it is

       (Alex + Sam) × 2 + Emplacement + Surface + Énergie + Valeur

     out of 80, brought back to 10 (and to 5 stars). Each term is already on
     its own 0–10 scale, ours being the score doubled. Anything missing drops
     out of the weighting rather than scoring zero, so the mark is always out
     of 10 and a half-filled listing is not punished for it. */
  var WEIGHTS = [['alex', 2], ['sam', 2], ['spot', 1], ['surface', 1], ['energy', 1], ['value', 1]];

  function ten(v) { return v == null ? null : v * 2; }

  function overall(d) {
    var a = autoScore(d) || {};
    var marks = {
      alex: ten(scoreOf(d.id, 'alex')),
      sam:  ten(scoreOf(d.id, 'sam')),
      spot: a.spot, surface: a.surface, energy: a.energy, value: a.value
    };
    var sum = 0, weight = 0, parts = 0;
    WEIGHTS.forEach(function (x) {
      if (marks[x[0]] == null) return;
      sum += marks[x[0]] * x[1]; weight += x[1]; parts++;
    });
    if (!weight) return null;
    var o = { marks: marks, parts: parts, weight: weight, sum: sum, mark: sum / weight };
    o.stars = Math.round(o.mark / 2 * 2) / 2;   // out of 5, half steps
    return o;
  }

  function autoScore(d) {
    var m2 = ppm(d);
    var a = {
      spot:    blockMark([d.spot == null ? null : d.spot]),
      surface: blockMark([d.terrain ? landMark(d.terrain) : null,
                          d.surface ? houseMark(d.surface) : null]),
      energy:  blockMark([energyMark(d.dpe), energyMark(d.ges)]),
      value:   blockMark([m2 != null ? priceMark(m2) : null])
    };
    var have = [a.spot, a.surface, a.energy, a.value].filter(function (x) { return x != null; });
    if (!have.length) return null;
    a.parts = have.length;
    a.total = have.reduce(function (x, y) { return x + y; }, 0) / have.length;  // out of 10
    a.stars = Math.round(a.total / 2 * 2) / 2;                                 // out of 5, half steps
    return a;
  }

  /* ───────────────────────── outbox ─────────────────────────
     A tiny IndexedDB queue. Every mutating call lands here first; the
     network attempt is best-effort and retried on reconnect. */
  var Outbox = (function () {
    var DB = 'pm', STORE = 'outbox', dbp = null;

    function open() {
      if (dbp) return dbp;
      dbp = new Promise(function (res, rej) {
        var r = indexedDB.open(DB, 1);
        r.onupgradeneeded = function () {
          r.result.createObjectStore(STORE, { keyPath:'id', autoIncrement:true });
        };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      }).catch(function () { return null; });
      return dbp;
    }
    function tx(mode, fn) {
      return open().then(function (db) {
        if (!db) return null;
        return new Promise(function (res, rej) {
          var t = db.transaction(STORE, mode), s = t.objectStore(STORE), out = fn(s);
          t.oncomplete = function () { res(out && out.result !== undefined ? out.result : out); };
          t.onerror = function () { rej(t.error); };
        });
      }).catch(function () { return null; });
    }
    return {
      add:  function (job) { return tx('readwrite', function (s) { return s.add(job); }); },
      all:  function ()    { return tx('readonly',  function (s) { return s.getAll(); }); },
      del:  function (id)  { return tx('readwrite', function (s) { return s.delete(id); }); },
      count:function ()    { return tx('readonly',  function (s) { return s.count(); }); }
    };
  })();

  /* ───────────────────────── transport ───────────────────────── */
  var LOCAL = false;   // set when there is no API (file://, or API unreachable)

  function api(method, path, body) {
    return fetch('/api' + path, {
      method: method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin'
    }).then(function (r) {
      if (r.status === 401) { throw Object.assign(new Error('unauthorised'), { code:401 }); }
      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) {
        throw Object.assign(new Error(j.error || ('HTTP ' + r.status)), { code:r.status });
      });
      return r.json();
    });
  }

  /* A write: apply locally, queue, then try to send. */
  function write(method, path, body) {
    if (LOCAL) { saveLocal(); return Promise.resolve(); }
    return Outbox.add({ method:method, path:path, body:body, at:Date.now() })
      .then(flush)
      .catch(function () {});
  }

  var flushing = false;
  function flush() {
    if (flushing || LOCAL || !navigator.onLine) return Promise.resolve();
    flushing = true;
    return Outbox.all().then(function (jobs) {
      if (!jobs || !jobs.length) return;
      // strictly in order: a note delete must not overtake its create
      return jobs.reduce(function (chain, job) {
        return chain.then(function () {
          return api(job.method, job.path, job.body)
            .then(function () { return Outbox.del(job.id); })
            .catch(function (e) {
              // 4xx means it will never succeed — drop it rather than wedge the queue
              if (e.code && e.code >= 400 && e.code < 500 && e.code !== 401) return Outbox.del(job.id);
              throw e;
            });
        });
      }, Promise.resolve());
    }).catch(function () {}).then(function () {
      flushing = false;
      return wire();
    });
  }
  addEventListener('online', function () { flush(); wire(); });
  addEventListener('offline', wire);

  function wire() {
    return Outbox.count().then(function (n) {
      var el = $('wire');
      if (!navigator.onLine) {
        el.hidden = false;
        $('wireTxt').textContent = n ? 'Hors ligne · ' + n + ' modification' + (n > 1 ? 's' : '') + ' en attente'
                                     : 'Hors ligne · les modifications seront envoyées';
      } else if (n) {
        el.hidden = false;
        $('wireTxt').textContent = 'Synchronisation de ' + n + ' modification' + (n > 1 ? 's' : '') + '…';
      } else {
        el.hidden = true;
      }
    });
  }

  /* ───────────────────────── local fallback ─────────────────────────
     Lets the app run from properties.js with no backend at all, which is
     how it is developed and what it degrades to if the API is unreachable. */
  function loadLocal() {
    LOCAL = true;
    return new Promise(function (res) {
      var s = document.createElement('script');
      s.src = 'properties.js';
      s.onload = res; s.onerror = res;
      document.head.appendChild(s);
    }).then(function () {
      var stored = {};
      try { stored = JSON.parse(localStorage.getItem('pm-local') || '{}'); } catch (e) {}
      return {
        properties: (window.PROPERTIES || []).slice(),
        scores: stored.scores || {},
        notes:  stored.notes  || {},
        photos: stored.photos || {},
        files:  stored.files  || {}
      };
    });
  }
  function saveLocal() {
    if (!LOCAL) return;
    try {
      localStorage.setItem('pm-local', JSON.stringify({
        scores: D.scores, notes: D.notes, photos: D.photos, files: D.files
      }));
    } catch (e) {}
  }

  /* ───────────────────────── state ───────────────────────── */
  var D = { properties: [], scores: {}, notes: {}, photos: {}, files: {} };
  var ME = null, OTHER = null;
  var state = { kind:'all', view:'all', towns:[], q:'', maxPrice:Infinity, minSurface:0,
                sort:'score', flip:false, shade:'ppm', table:false };
  try {
    // checked against the literal, not SHADES: that is declared further down
    // and would still be undefined here
    var savedShade = localStorage.getItem('pm-shade');
    if (savedShade === 'ppm' || savedShade === 'dpe' || savedShade === 'total') {
      state.shade = savedShade;
    }
  } catch (e) {}
  var map, markers = {}, anchors = {}, activeId = null, CUTS = [], priced = [], PMAX = 0, SMAX = 0;

  function scoreOf(id, u) { var s = D.scores[id]; return s && s[u] != null ? s[u] : null; }
  function combined(id) {
    var a = scoreOf(id, 'alex'), b = scoreOf(id, 'sam'), n = 0, t = 0;
    if (a != null) { t += a; n++; }
    if (b != null) { t += b; n++; }
    return n ? t / n : null;
  }

  /* The podium: the three best-loved properties, by the average of both
     scores. Only properties you have BOTH rated qualify — one person's 5
     is an opinion, not a shortlist. Ties go to the one you disagree on
     least. RANK maps id → 1, 2 or 3. */
  var RANK = {};
  function rankTop() {
    var prev = RANK, next = {}, changed = [];
    D.properties.filter(function (d) {
      return !d.hidden && scoreOf(d.id, 'alex') != null && scoreOf(d.id, 'sam') != null;
    }).sort(function (a, b) {
      var ca = combined(a.id), cb = combined(b.id);
      if (cb !== ca) return cb - ca;
      var ga = Math.abs(scoreOf(a.id,'alex') - scoreOf(a.id,'sam')),
          gb = Math.abs(scoreOf(b.id,'alex') - scoreOf(b.id,'sam'));
      return ga - gb || a.id.localeCompare(b.id);
    }).slice(0, 3).forEach(function (d, i) { next[d.id] = i + 1; });
    Object.keys(prev).concat(Object.keys(next)).forEach(function (id) {
      if (prev[id] !== next[id] && changed.indexOf(id) < 0) changed.push(id);
    });
    RANK = next;
    return changed;
  }
  function rankHTML(id) {
    return RANK[id] ? '<i class="rank rank--' + RANK[id] + '" aria-label="' +
      (RANK[id] === 1 ? 'Meilleure note' : RANK[id] + 'e meilleure note') + '">' + RANK[id] + '</i>' : '';
  }

  /* ───────────────────────── login ───────────────────────── */
  var pending = null;
  $('who').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    pending = b.dataset.user;
    Array.prototype.forEach.call(this.querySelectorAll('button'), function (x) {
      x.setAttribute('aria-pressed', String(x === b));
    });
    $('gateGo').disabled = !$('pw').value.trim();
    $('pw').focus();
  });
  $('pw').addEventListener('input', function () {
    $('gateGo').disabled = !(pending && this.value.trim());
  });
  $('gateForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var pw = $('pw').value.trim();
    if (!pending || !pw) return;
    $('gateGo').disabled = true; $('gateErr').textContent = '';
    api('POST', '/login', { user: pending, password: pw })
      .then(function (r) { start(r.user); })
      .catch(function (err) {
        $('gateGo').disabled = false;
        $('gateErr').textContent = err.code === 401 ? 'Code incorrect.'
          : err.code === 429 ? 'Trop d\u2019essais. ' + err.message.replace(/^.*— /, '').replace(/^./, function (c) { return c.toUpperCase(); }) + '.'
          : 'Connexion impossible. Réessaie.';
        $('pw').select();
      });
  });

  function showGate() { $('gate').hidden = false; $('app').hidden = true; }

  /* ───────────────────────── boot ───────────────────────── */
  api('GET', '/me')
    .then(function (r) { start(r.user); })
    .catch(function (err) {
      if (err.code === 401) { showGate(); return; }
      // no API at all — run against the bundled data so the map still works
      loadLocal().then(function (d) {
        D = d;
        var u = null;
        try { u = localStorage.getItem('pm-user'); } catch (e) {}
        if (u) start(u); else showGate();
      });
    });

  // in local mode any code gets you in; the real check lives in the Lambda
  var realSubmit = $('gateForm').onsubmit;
  $('gateForm').addEventListener('submit', function () {
    if (LOCAL && pending && $('pw').value.trim()) {
      try { localStorage.setItem('pm-user', pending); } catch (e) {}
      start(pending);
    }
  });

  function start(user) {
    ME = String(user).toLowerCase();
    GUEST = RATERS.indexOf(ME) < 0;
    OTHER = ME === 'sam' ? 'alex' : 'sam';
    $('gate').hidden = true; $('app').hidden = false;
    if (GUEST) {
      document.body.classList.add('guest');
      // the two shortlists belong to the two of them, not to whoever is looking
      $('view').querySelector('[value="mine"]').textContent = 'Liste de ' + USERS.alex;
    }

    $('me').textContent = USERS[ME] || ME;
    $('me').style.setProperty('--who', 'var(--' + ME + ')');

    (LOCAL ? Promise.resolve(D) : api('GET', '/data')).then(function (d) {
      if (!LOCAL) lastData = JSON.stringify(d);
      D.properties = d.properties || [];
      D.properties.forEach(deriveVisit);
      D.scores = d.scores || {}; D.notes = d.notes || {}; D.photos = d.photos || {};
      D.files = d.files || {};
      D.pois = d.pois || [];
      init();
    }).catch(function () { init(); });
  }

  $('me').addEventListener('click', function () {
    if (LOCAL) { try { localStorage.removeItem('pm-user'); } catch (e) {} location.reload(); return; }
    api('POST', '/logout').catch(function () {}).then(function () { location.reload(); });
  });

  /* ───────────────────────── staying current ─────────────────────────
     A phone keeps the app alive in the background for days, so the data it
     loaded at launch goes stale while the other one comments and edits.
     Fetch again on the way back to the foreground and once a minute while
     on screen, and repaint only when something actually changed. */
  var lastData = null, REFRESH_MS = 60 * 1000;

  // Anything a repaint would trample: a half-typed comment, a dialog, a
  // pin being placed, an upload under way. A refresh that finds the app
  // busy simply waits for the next one.
  function busy() {
    var a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return true;
    if ($('noteText') && $('noteText').value.trim()) return true;
    if (placing || draft || repositioning || placingPoi || cal.el) return true;
    if (!$('lightbox').hidden || !$('poidlg').hidden || !$('deck').hidden) return true;
    return Object.keys(uploadTally).length > 0;
  }

  function refreshData() {
    if (LOCAL || !ready || document.hidden || !navigator.onLine) return;
    // our own queued writes go first; until they land, the server's copy is
    // older than what is on screen and would briefly undo them
    flush().then(Outbox.count).then(function (n) {
      if (n) return;
      return api('GET', '/data').then(function (d) {
        var snap = JSON.stringify(d);
        if (snap === lastData || busy()) return;
        lastData = snap;
        applyData(d);
      });
    }).catch(function () {});
  }

  function applyData(d) {
    D.properties = d.properties || [];
    D.properties.forEach(deriveVisit);
    D.scores = d.scores || {}; D.notes = d.notes || {}; D.photos = d.photos || {};
    D.files = d.files || {};
    D.pois = d.pois || [];

    // markers: new houses get one, deleted ones lose theirs, moved ones move
    var seen = {};
    D.properties.forEach(function (p) {
      seen[p.id] = true;
      if (!markers[p.id]) markers[p.id] = makeMarker(p);
      else markers[p.id].setLatLng([p.lat, p.lng]);
    });
    Object.keys(markers).forEach(function (id) {
      if (seen[id]) return;
      map.removeLayer(markers[id]); delete markers[id]; delete anchors[id];
    });
    Object.keys(poiMarkers).forEach(function (id) {
      map.removeLayer(poiMarkers[id]); delete poiMarkers[id];
    });
    drawPois();

    buildTowns();
    init2();

    // the open panel is rebuilt in place, at the same scroll position
    if (activeId && $('sheet').classList.contains('open')) {
      var cur = D.properties.find(function (x) { return x.id === activeId; });
      if (!cur) { select(null, false); return; }
      var sc = $('sheet').querySelector('.sheet__scroll'), top = sc ? sc.scrollTop : 0;
      openSheet(cur);
      sc = $('sheet').querySelector('.sheet__scroll');
      if (sc) sc.scrollTop = top;
    }
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { if (newVersion) location.reload(); return; }
    refreshData();
    if (swReg) swReg.update().catch(function () {});
  });
  addEventListener('online', refreshData);
  setInterval(refreshData, REFRESH_MS);

  // A new service worker means a new app.js. The shell is cache-first, so
  // without this the new version only showed up on the launch after next.
  // Reload straight away when nothing is in progress — the hash brings the
  // open bien back — otherwise as soon as the app goes to the background.
  var swReg = null, newVersion = false;
  if ('serviceWorker' in navigator) {
    var hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadController) { hadController = true; return; }   // first install, not an update
      newVersion = true;
      if (!busy()) location.reload();
    });
  }

  /* ───────────────────────── init ───────────────────────── */
  function init() {
    recompute();

    buildMap();
    buildTowns();
    buildControls();
    buildKey();
    drawPois();
    poiControls();
    wireAdd();
    wireTable();
    wireDash();
    render();
    wire();
    flush();
    ready = true;
    var savedView = null;
    try { savedView = localStorage.getItem('pm-view'); } catch (e) {}
    if (savedView === 'table' || savedView === 'dash') setView(savedView);
    consumeHash();
  }

  // Colour encodes EUR per m2, not the total: two houses at 600k are not
  // comparable, 3 000 EUR/m2 against 4 500 EUR/m2 is. Anything without a
  // surface has no comparable and stays unbanded.
  function band(d) {
    var v = ppm(d);
    if (v == null) return 0;
    var i = 0; while (i < CUTS.length && v >= CUTS[i]) i++;
    return i + 1;
  }

  var PPMS = [], MARKS = [], NCUTS = [];
  function active() { return D.properties.filter(function (d) { return !d.hidden; }); }

  function recompute() {
    var A = active();
    priced = A.map(function (d) { return d.price; })
              .filter(function (p) { return p != null; })
              .sort(function (a, b) { return a - b; });
    PMAX = priced.length ? priced[priced.length - 1] : 0;
    if (state.maxPrice === Infinity || state.maxPrice > PMAX) state.maxPrice = PMAX || Infinity;
    SMAX = Math.max.apply(null, A.map(function (d) { return d.surface || 0; }).concat([0]));
    PPMS = A.map(ppm).filter(function (v) { return v != null; })
            .sort(function (a, b) { return a - b; });
    CUTS = [];
    if (PPMS.length >= 5) {
      for (var k = 1; k <= 4; k++) CUTS.push(PPMS[Math.floor(PPMS.length * k / 5)]);
    }
    MARKS = A.map(function (d) { var o = overall(d); return o ? o.mark : null; })
             .filter(function (v) { return v != null; })
             .sort(function (a, b) { return a - b; });
    NCUTS = [];
    if (MARKS.length >= 5) {
      for (var j = 1; j <= 4; j++) NCUTS.push(MARKS[Math.floor(MARKS.length * j / 5)]);
    }
  }

  /* ───────────────────────── photos ───────────────────────── */
  function placeholder(d) {
    var seed = 0, id = d.id || d.name || '';
    for (var i = 0; i < id.length; i++) seed = (seed * 31 + id.charCodeAt(i)) | 0;
    var l = 88 - (Math.abs(seed) % 7);
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">' +
      '<rect width="400" height="300" fill="hsl(28,12%,' + l + '%)"/>' +
      '<g fill="none" stroke="hsl(28,10%,' + (l - 26) + '%)" stroke-width="5" stroke-linejoin="round">' +
      '<path d="M156 168 L200 128 L244 168 V200 H156 Z"/></g>' +
      '<text x="200" y="232" text-anchor="middle" font-family="Georgia,serif" font-size="13" ' +
      'font-style="italic" fill="hsl(28,10%,' + (l - 30) + '%)">photo a ajouter</text></svg>');
  }
  // The listing's own pictures stand for the property: its gallery, then
  // whatever hero is stored, then the Street View fallback. Photos we upload
  // ourselves are a note to each other, not the face of the house — but when
  // the only alternative is the empty placeholder, ours are better than none.
  function standIns(d) {
    if ((d.gallery && d.gallery.length) || d.photo || d.street) return [];
    return uploads(d).filter(function (p) { return !isVideo(p); }).map(function (p) { return p.url; });
  }
  function photoOf(d, big) {
    var gal = (d.gallery && d.gallery.length) ? d.gallery[0] : null;
    var src = gal || d.photo || d.street || standIns(d)[0];
    if (!src) return placeholder(d);
    if (src.indexOf('streetviewpixels') !== -1) {
      var w = big ? 592 : 216, h = big ? 444 : 162;
      return src.replace(/([?&])w=\d+/, '$1w=' + w).replace(/([?&])h=\d+/, '$1h=' + h);
    }
    return src;
  }
  function fallbackOf(d) {
    if (d.photo && d.street) return d.street.replace(/([?&])w=\d+/, '$1w=216').replace(/([?&])h=\d+/, '$1h=162');
    return placeholder(d);
  }

  /* ───────────────────────── map ───────────────────────── */
  function buildMap() {
    map = L.map('map', { zoomControl:true, attributionControl:true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>', maxZoom: 19
    }).addTo(map);

    rankTop();
    D.properties.forEach(function (d) { markers[d.id] = makeMarker(d); });

    if (D.properties.length) {
      var lats = D.properties.map(function (d) { return d.lat; }).sort(function (a,b) { return a-b; });
      var lngs = D.properties.map(function (d) { return d.lng; }).sort(function (a,b) { return a-b; });
      var q = function (a, x) { return a[Math.min(a.length - 1, Math.floor(a.length * x))]; }, s = 0.06;
      map.fitBounds(L.latLngBounds([q(lats,0.04)-s, q(lngs,0.04)-s], [q(lats,0.96)+s, q(lngs,0.96)+s]),
                    { padding:[24,24] });
    } else { map.setView([44.84, -0.58], 12); }

    map.on('zoomend', function () {
      var want = map.getZoom() >= THUMB_ZOOM;
      if (want === showThumbs) return;
      showThumbs = want;
      D.properties.forEach(function (d) {
        var m = markers[d.id];
        if (m) m.setIcon(L.divIcon({ className:'', iconSize:[0,0], iconAnchor:[0,0], html: markerHTML(d) }));
      });
      refreshMarkers();
    });
    map.on('zoomend moveend', refreshMarkers);
  }

  var THUMB_ZOOM = 15;          // below this, thumbnails become a jumble
  var showThumbs = false;

  /* ── how the map is coloured ──
     'ppm' shades by price per m², the default; 'dpe' shades by the energy
     letter. Both reduce to one CSS class so markers, chips and thumbnails all
     stay in step, and both have an "unknown" state that renders the same
     hollow grey — a house with no surface and one with no rating are both
     simply uncomparable on that axis. */
  var SHADES = ['ppm', 'dpe', 'total'];

  /* The total mark, five steps. Cut on the quintiles of the marks we actually
     hold rather than on 0–10: everything we look at lands between 5 and 7,
     and a ramp that spends four of its five colours on marks nobody has is
     no ramp at all. The best shine; the weak go dark and dull. */
  function noteBand(d) {
    var o = overall(d);
    if (!o) return null;
    if (!NCUTS.length) return 'n' + Math.max(1, Math.min(5, Math.ceil(o.mark / 2) || 1));
    var i = 0; while (i < NCUTS.length && o.mark >= NCUTS[i]) i++;
    return 'n' + (i + 1);
  }

  // null means "not comparable on this axis" — each caller has its own way of
  // drawing that, so it must not be baked in here
  function shadeOf(d) {
    if (state.shade === 'dpe') {
      return /^[A-G]$/.test(d.dpe || '') ? 'dpe-' + d.dpe.toLowerCase() : null;
    }
    if (state.shade === 'total') return noteBand(d);
    return d.price == null ? null : 'b' + band(d);
  }

  function chipClass(d) {
    return 'chip ' + (shadeOf(d) || 'chip--none') +
           (approx(d) ? ' chip--approx' : '') + (d.sold ? ' sold' : '') +
           (RANK[d.id] ? ' top' : combined(d.id) >= 4 ? ' starred' : '');
  }

  function markerHTML(d) {
    if (showThumbs && (d.price != null || d.gallery || d.photo || d.street)) {
      return '<div class="anchor"><span class="thumbpin ' + (shadeOf(d) || 'b0') +
        (RANK[d.id] ? ' top' : '') + (d.sold ? ' sold' : '') + (d.visit ? ' visit' : '') + '">' +
        rankHTML(d.id) + visitHTML(d) +
        // two layers: the listing photo, with the drawn tile showing through if it 404s
        '<span class="thumbpin__ph" style="background-image:url(&quot;' + esc(photoOf(d)) +
          '&quot;),url(&quot;' + fallbackOf(d) + '&quot;)"></span>' +
        '<b>' + (d.price == null ? 'prix&nbsp;?' : esc(fmtShort(d.price))) + '</b></span></div>';
    }
    return '<div class="anchor"><span class="' + chipClass(d) + '">' +
           (d.price == null ? '?' : esc(fmtShort(d.price))) + rankHTML(d.id) + visitHTML(d) + '</span></div>';
  }

  // a visit is booked: a calendar on the opposite shoulder from the podium
  // medal — and once it has happened, a tick in its place
  function visitHTML(d) {
    if (!d.visit) return '';
    if (visitDone(d)) {
      return '<span class="vis" title="Visité ' + esc(fmtVisit(d.visit) + visitorText(d)) + '">' +
        '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.6 6.3l2.3 2.3 4.5-5"/></svg></span>';
    }
    return '<span class="vis" title="Visite ' + esc(fmtVisit(d.visit) + visitorText(d)) + '">' +
      '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="2.5" width="9" height="8" rx="1.5"/>' +
      '<path d="M1.5 5h9M4 1.2v2.4M8 1.2v2.4"/></svg></span>';
  }

  // Past its hour if it has one; a visit with only a day is done the day after.
  // Both sides are local wall-clock strings, so they compare as text.
  function visitDone(d) {
    var v = String(d.visit || ''), now = new Date();
    if (!v) return false;
    if (v.length <= 10) return v < ymd(now);
    return v <= ymd(now) + 'T' + ('0' + now.getHours()).slice(-2) + ':' + ('0' + now.getMinutes()).slice(-2);
  }

  function makeMarker(d) {
    var m = L.marker([d.lat, d.lng], {
      icon: L.divIcon({ className:'', iconSize:[0,0], iconAnchor:[0,0], html: markerHTML(d) }),
      riseOnHover: true, keyboard: false,
      title: d.name + (d.price != null ? ' — ' + euro.format(d.price) : '')
    });
    m.bindTooltip(tipHTML(d), { direction:'top', offset:[0,-20], opacity:1, className:'tip' });
    m.on('click', function () { select(d.id, false); });
    return m;
  }

  function tipHTML(d) {
    var c = combined(d.id);
    return '<img src="' + esc(photoOf(d)) + '" alt="" onerror="this.onerror=null;this.src=\'' + fallbackOf(d) + '\'">' +
      '<b>' + esc(d.name) + '</b><span>' +
      (d.price != null ? esc(fmtPrice(d.price)) : 'prix à renseigner') +
      (d.surface ? ' · ' + num.format(d.surface) + ' m²' : '') +
      (c != null ? ' · ' + c.toFixed(c % 1 ? 1 : 0) + '/5' : '') +
      (d.sold ? ' · vendu' : '') +
      (d.visit ? ' · visite ' + esc(fmtVisit(d.visit) + visitorText(d)) : '') + '</span>';
  }

  function redrawMarker(d) {
    // a score change can move someone else on or off the podium too
    var ids = rankTop();
    if (ids.indexOf(d.id) < 0) ids.push(d.id);
    ids.forEach(function (id) {
      var x = D.properties.find(function (p) { return p.id === id; }), m = markers[id];
      if (!x || !m) return;
      m.setIcon(L.divIcon({ className:'', iconSize:[0,0], iconAnchor:[0,0], html: markerHTML(x) }));
      m.setTooltipContent(tipHTML(x));
    });
    refreshMarkers();
  }

  function cacheAnchors() {
    anchors = {};
    D.properties.forEach(function (d) {
      var m = markers[d.id], el = m && m.getElement && m.getElement();
      if (!el) return;
      var a = el.querySelector('.anchor');
      anchors[d.id] = a;
      // a redraw rebuilds the icon's HTML, so the selection has to be put back
      if (d.id === activeId) { a.classList.add('sel', 'on'); }
    });
  }

  /* Show a price only where it can actually be read: walk dearest-first and
     collapse any label that would collide with one already placed. */
  function declutter() {
    var placed = [], size = map.getSize();
    D.properties.filter(function (d) { return map.hasLayer(markers[d.id]); })
      .sort(function (a, b) {
        if (a.id === activeId) return -1;
        if (b.id === activeId) return 1;
        // the podium keeps its label whatever the zoom
        if (!!RANK[a.id] !== !!RANK[b.id]) return RANK[a.id] ? -1 : 1;
        // priced ones claim their label first; unpriced fill the gaps
        if ((a.price == null) !== (b.price == null)) return a.price == null ? 1 : -1;
        return (b.price || 0) - (a.price || 0);
      })
      .forEach(function (d) {
        var a = anchors[d.id]; if (!a) return;
        var chip = a.firstElementChild, p = map.latLngToContainerPoint([d.lat, d.lng]);
        if (p.x < -60 || p.y < -40 || p.x > size.x + 60 || p.y > size.y + 40) { chip.classList.add('mini'); return; }
        var w, h, g = 3;
        if (showThumbs) { w = 60; h = 66; }
        else { w = (d.price == null ? 1 : fmtShort(d.price).length) * 6.4 + 24; h = 23; }
        var box = [p.x - w/2 - g, p.y - h - 8 - g, p.x + w/2 + g, p.y - 8 + g];
        var hit = placed.some(function (o) {
          return !(box[2] < o[0] || box[0] > o[2] || box[3] < o[1] || box[1] > o[3]);
        });
        if (hit) chip.classList.add('mini');
        else { chip.classList.remove('mini'); placed.push(box); }
      });
  }
  function refreshMarkers() {
    cacheAnchors();
    declutter();
    map.getContainer().classList.toggle('compact-poi', map.getZoom() < 14);
  }

  /* ───────────────────────── filters ───────────────────────── */
  function buildTowns() {
    var counts = {};
    D.properties.forEach(function (d) {
      if (d.hidden) return;
      var t = d.town || 'Inconnu';
      counts[t] = (counts[t] || 0) + 1;
    });
    var towns = Object.keys(counts).sort(function (a, b) {
      return counts[b] - counts[a] || a.localeCompare(b, 'fr');
    });
    var sel = $('town');
    var keep = sel.value;
    sel.innerHTML = '<option value="">Toutes les communes</option>' +
      towns.map(function (t) {
        return '<option value="' + esc(t) + '">' + esc(t) + ' (' + counts[t] + ')</option>';
      }).join('');
    if (keep) sel.value = keep;
  }

  function buildControls() {
    $('kind').addEventListener('change', function () { state.kind = this.value; render(); });
    $('view').addEventListener('change', function () { state.view = this.value; render(); });
    $('town').addEventListener('change', function () {
      state.towns = this.value ? [this.value] : [];
      render();
    });
    $('view').querySelector('[value="theirs"]').textContent =
      'Liste de ' + USERS[GUEST ? 'sam' : OTHER];

    $('q').addEventListener('input', function () { state.q = this.value; render(); });

    var mp = $('maxPrice');
    mp.min = priced.length ? priced[0] : 0; mp.max = PMAX || 1;
    mp.step = Math.max(1000, Math.round((PMAX || 1000) / 300)); mp.value = PMAX;
    mp.addEventListener('input', function () {
      state.maxPrice = +this.value; $('maxPriceOut').textContent = euro.format(state.maxPrice); render();
    });
    $('maxPriceOut').textContent = PMAX ? euro.format(PMAX) : '—';

    var ms = $('minSurface');
    ms.min = 0; ms.max = SMAX || 1; ms.value = 0;
    ms.addEventListener('input', function () {
      state.minSurface = +this.value;
      $('minSurfaceOut').textContent = state.minSurface ? num.format(state.minSurface) + ' m²' : 'indifférente';
      render();
    });
    $('minSurfaceOut').textContent = 'indifférente';

    $('sorts').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      state.sort = b.dataset.sort; state.flip = false;
      Array.prototype.forEach.call(this.querySelectorAll('button'), function (x) {
        x.setAttribute('aria-pressed', String(x === b));
      });
      render();
    });

    function theme(t) {
      document.documentElement.setAttribute('data-theme', t);
      try { localStorage.setItem('pm-theme', t); } catch (e) {}
    }
    var saved = null;
    try { saved = localStorage.getItem('pm-theme'); } catch (e) {}
    theme(saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
    $('theme').addEventListener('click', function () {
      theme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    });

    sheetDrag();
    railToggle();
    deckControls();
  }

  // Collapse the list so the map gets the whole window. Leaflet caches the
  // container size, so it must be told to re-measure once the fold finishes.
  function railToggle() {
    var btn = $('railToggle'), app = $('app');
    if (!btn) return;

    function apply(collapsed, animate) {
      app.classList.toggle('railed', collapsed);
      btn.textContent = collapsed ? '\u203A' : '\u2039';
      btn.setAttribute('aria-expanded', String(!collapsed));
      btn.title = (collapsed ? 'D\u00e9plier' : 'Replier') + ' le panneau (touche \\)';
      try { localStorage.setItem('pm-rail', collapsed ? '1' : '0'); } catch (e) {}
      // Measure when the fold has actually finished. A fixed timer raced the
      // transition and left Leaflet sized to an intermediate width, so the
      // newly exposed strip never fetched its tiles.
      if (!animate) { remeasure(); return; }
    }

    var settleTimer = null;
    function remeasure() {
      clearTimeout(settleTimer);
      map.invalidateSize({ pan: false });
      refreshMarkers();
    }
    app.addEventListener('transitionend', function (e) {
      if (e.target === app && e.propertyName === 'grid-template-columns') remeasure();
    });
    // belt and braces: some engines skip the event when tracks differ in type
    function scheduleSettle() { clearTimeout(settleTimer); settleTimer = setTimeout(remeasure, 420); }

    var saved = '0';
    try { saved = localStorage.getItem('pm-rail') || '0'; } catch (e) {}
    if (saved === '1') apply(true, false);

    btn.addEventListener('click', function () {
      apply(!app.classList.contains('railed'), true);
      scheduleSettle();
    });

    addEventListener('keydown', function (e) {
      if (e.key !== '\\' || e.metaKey || e.ctrlKey || e.altKey) return;
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (matchMedia('(max-width:860px)').matches) return;
      e.preventDefault();
      apply(!app.classList.contains('railed'), true);
      scheduleSettle();
    });
  }

  var DPE_LETTERS = ['A','B','C','D','E','F','G'];

  function buildKey() {
    var key = $('key'), mode = state.shade;
    // nothing to explain until there is something to shade
    if (mode === 'ppm' && !CUTS.length) { key.hidden = true; return; }
    if (mode === 'total' && !MARKS.length) { key.hidden = true; return; }
    key.hidden = false;

    var body;
    if (mode === 'dpe') {
      body = '<div class="key__ramp key__ramp--dpe">' +
          DPE_LETTERS.map(function (L) {
            return '<i class="dpe-' + L.toLowerCase() + '">' + L + '</i>';
          }).join('') +
        '</div>' +
        '<div class="key__ends"><span>économe</span><span>énergivore</span></div>' +
        '<p class="key__none"><i></i> DPE inconnu</p>';
    } else if (mode === 'total') {
      body = '<div class="key__ramp">' +
          [1,2,3,4,5].map(function (i) { return '<i class="n' + i + '"></i>'; }).join('') +
        '</div>' +
        '<div class="key__ends"><span>' + mark10(MARKS[0]) + '</span><span>' +
          mark10(MARKS[MARKS.length - 1]) + ' / 10</span></div>' +
        '<p class="key__none"><i></i> pas encore de note</p>';
    } else {
      body = '<div class="key__ramp">' +
          [1,2,3,4,5].map(function (i) { return '<i style="background:var(--b' + i + ')"></i>'; }).join('') +
        '</div>' +
        '<div class="key__ends"><span>' + num.format(PPMS[0]) + ' €</span><span>' +
          num.format(PPMS[PPMS.length - 1]) + ' €</span></div>' +
        '<p class="key__none"><i></i> surface inconnue</p>';
    }

    key.innerHTML =
      '<div class="key__switch" role="group" aria-label="Couleur des pastilles">' +
        [['ppm','Prix'], ['dpe','DPE'], ['total','Total']].map(function (x) {
          return '<button type="button" data-shade="' + x[0] + '"' +
                 (mode === x[0] ? ' aria-current="true"' : '') + '>' + x[1] + '</button>';
        }).join('') +
      '</div>' + body;
  }

  function setShade(v) {
    if (state.shade === v) return;
    state.shade = v;
    try { localStorage.setItem('pm-shade', v); } catch (e) {}
    D.properties.forEach(redrawMarker);
    buildKey();
    render();
  }

  // delegated: buildKey replaces the key's contents whenever anything changes
  $('key').addEventListener('click', function (e) {
    var b = e.target.closest('[data-shade]');
    if (b) setShade(b.dataset.shade);
  });

  function visible() {
    var q = state.q.trim().toLowerCase();
    var out = D.properties.filter(function (d) {
      // hidden properties leave every list until you deliberately go looking
      if (state.view === 'hidden') { if (!d.hidden) return false; }
      else if (d.hidden) return false;

      if (state.kind !== 'all' && (d.kind || 'property') !== state.kind) return false;
      if (state.towns.length && state.towns.indexOf(d.town || 'Inconnu') === -1) return false;

      if (state.view === 'mine'   && !(scoreOf(d.id, GUEST ? 'alex' : ME) >= 4)) return false;
      if (state.view === 'theirs' && !(scoreOf(d.id, GUEST ? 'sam' : OTHER) >= 4)) return false;
      if (state.view === 'both') {
        var a = scoreOf(d.id, 'alex'), b = scoreOf(d.id, 'sam');
        if (a == null || b == null || Math.min(a, b) < 3) return false;
      }

      if (q) {
        var hay = (d.name + ' ' + (d.address||'') + ' ' + (d.town||'') + ' ' + (d.note||'') + ' ' + (d.type||'')).toLowerCase();
        var mine = (D.notes[d.id] || []).map(function (n) { return n.text; }).join(' ').toLowerCase();
        if (hay.indexOf(q) === -1 && mine.indexOf(q) === -1) return false;
      }
      if (d.price != null && d.price > state.maxPrice) return false;
      if (state.minSurface && (!d.surface || d.surface < state.minSurface)) return false;
      return true;
    });

    out.sort(comparator(state.sort, state.flip));
    return out;
  }

  /* Every column the list or the table can be ordered by, with the direction
     that reads as "best first" for that column: cheapest price, biggest
     surface, highest mark. Clicking a column header again flips it. A blank
     always sinks to the bottom, whichever way round it is — an unknown price
     is not a cheap one. */
  function letterRank(l) {
    var k = String(l == null ? '' : l).trim().toUpperCase().charCodeAt(0) - 64;
    return k >= 1 && k <= 7 ? k : null;
  }
  function autoPart(d, k) { var a = autoScore(d); return a ? a[k] : null; }

  var SORTS = {
    name:     { dir: 1,  get: function (d) { return (d.name || '').toLowerCase(); } },
    town:     { dir: 1,  get: function (d) { return (d.town || '').toLowerCase(); } },
    price:    { dir: 1,  get: function (d) { return d.price; } },
    surface:  { dir: -1, get: function (d) { return d.surface; } },
    terrain:  { dir: -1, get: function (d) { return d.terrain; } },
    rooms:    { dir: -1, get: function (d) { return d.rooms; } },
    ppm:      { dir: 1,  get: ppm },
    dpe:      { dir: 1,  get: function (d) { return letterRank(d.dpe); } },
    ges:      { dir: 1,  get: function (d) { return letterRank(d.ges); } },
    score:    { dir: -1, get: function (d) { return combined(d.id); } },
    alex:   { dir: -1, get: function (d) { return scoreOf(d.id, 'alex'); } },
    sam:    { dir: -1, get: function (d) { return scoreOf(d.id, 'sam'); } },
    spot:     { dir: -1, get: function (d) { return d.spot; } },
    msurface: { dir: -1, get: function (d) { return autoPart(d, 'surface'); } },
    menergy:  { dir: -1, get: function (d) { return autoPart(d, 'energy'); } },
    mvalue:   { dir: -1, get: function (d) { return autoPart(d, 'value'); } },
    total:    { dir: -1, get: function (d) { var o = overall(d); return o ? o.mark : null; } },
    notes:    { dir: -1, get: function (d) { return (D.notes[d.id] || []).length || null; } },
    visit:    { dir: 1,  get: function (d) { return d.visit || null; } }
  };

  function comparator(key, flip) {
    var S = SORTS[key] || SORTS.price, dir = S.dir * (flip ? -1 : 1);
    return function (a, b) {
      var x = S.get(a), y = S.get(b);
      if (x === '' ) x = null;
      if (y === '' ) y = null;
      if (x == null && y == null) return a.name.localeCompare(b.name, 'fr');
      if (x == null) return 1;
      if (y == null) return -1;
      if (typeof x === 'string') return dir * x.localeCompare(y, 'fr');
      return dir * (x - y) || a.name.localeCompare(b.name, 'fr');
    };
  }

  /* ───────────────────────── render ───────────────────────── */
  function pips(id, u) {
    var v = scoreOf(id, u);
    if (v == null) return '';
    return '<span class="mark" style="--who:var(--' + u + ')"><u>' + USERS[u][0] +
           '</u><span class="val">' + num.format(v) + '</span></span>';
  }
  // the whole mark on a card: same gold pip, a ⌁ instead of an initial
  function autoPip(d) {
    var o = overall(d);
    if (!o) return '';
    return '<span class="mark mark--auto" title="Total — nos notes, emplacement, surface, énergie, valeur">' +
      '<u>⌁</u><span class="val">' + num.format(o.stars) + '</span></span>';
  }

  function render() {
    var rows = visible(), shown = {};
    rows.forEach(function (d) { shown[d.id] = true; });

    D.properties.forEach(function (d) {
      var m = markers[d.id]; if (!m) return;
      if (shown[d.id]) { if (!map.hasLayer(m)) m.addTo(map); }
      else if (map.hasLayer(m)) map.removeLayer(m);
    });
    refreshMarkers();

    var list = $('list');
    list.innerHTML = '';
    if (!rows.length) {
      var li = document.createElement('li');
      li.className = 'empty';
      li.innerHTML = '<h2>Rien à afficher</h2><p>' + emptyWhy() + '</p>' +
        '<button type="button" id="reset">Réinitialiser les filtres</button>';
      list.appendChild(li);
      $('reset').addEventListener('click', resetFilters);
    } else {
      var frag = document.createDocumentFragment();
      rows.forEach(function (d) {
        var m2 = ppm(d), li = document.createElement('li');
        var el = document.createElement('button');
        el.className = 'card' + (d.hidden ? ' card--hidden' : ''); el.type = 'button'; el.dataset.id = d.id;
        el.setAttribute('aria-current', d.id === activeId ? 'true' : 'false');
        var notes = (D.notes[d.id] || []).length;
        var facts = [
          d.surface ? num.format(d.surface) + ' m²' : null,
          d.terrain ? num.format(d.terrain) + ' m² terrain' : null,
          m2 ? num.format(m2) + ' €/m²' : null,
          notes ? notes + ' note' + (notes > 1 ? 's' : '') : null
        ].filter(Boolean);

        el.innerHTML =
          '<span class="card__ph">' +
            '<img class="thumb" src="' + esc(photoOf(d, true)) + '" alt="" loading="lazy"' +
              ' onerror="this.onerror=null;this.src=\'' + fallbackOf(d) + '\'">' +
            (RANK[d.id] ? '<i class="rank rank--' + RANK[d.id] + '" aria-label="' +
              (RANK[d.id] === 1 ? 'Meilleure note' : RANK[d.id] + 'e meilleure note') + '">' +
              RANK[d.id] + '</i>' : '') +
            (d.sold ? '<span class="tag tag--sold">vendu</span>'
              : d.kind === 'land' ? '<span class="tag tag--land">terrain</span>'
              : (d.listing === 'gone' ? '<span class="tag tag--gone">retirée</span>' : '')) +
          '</span>' +
          '<span class="card__text">' +
            '<span class="card__top">' +
              (d.price != null ? '<span class="price">' + esc(fmtPrice(d.price)) + '</span>'
                               : '<span class="price price--none">prix à renseigner</span>') +
              ((scoreOf(d.id,'alex') != null || scoreOf(d.id,'sam') != null || overall(d))
                ? '<span class="marks">' + pips(d.id,'alex') + pips(d.id,'sam') +
                  autoPip(d) + '</span>' : '') +
            '</span>' +
            '<span class="name">' + esc(d.name) + '</span>' +
            '<span class="where">' + esc(d.town || d.address || '') +
              (d.type ? ' · ' + esc(d.type.toLowerCase()) : '') + '</span>' +
            (facts.length ? '<span class="card__facts">' + facts.join(' · ') + '</span>' : '') +
          '</span>';
        el.addEventListener('click', function () { select(d.id, true); });
        el.addEventListener('mouseenter', function () { hover(d.id, true); });
        el.addEventListener('mouseleave', function () { hover(d.id, false); });
        li.appendChild(el); frag.appendChild(li);
      });
      list.appendChild(frag);
    }
    if (state.table) renderTable(rows);
    if (state.dash) renderDash();
    standfirst(rows);
    histogram(rows);
  }

  /* ───────────────────────── tableau ─────────────────────────
     The same rows as the list and the same filters, laid out so the two of
     you can compare fifteen houses at once instead of one at a time: every
     figure we hold, then the six marks and the total, each column sortable
     both ways. The map is the product; this is the spreadsheet you reach for
     the evening before a visit. */
  var TGROUPS = [
    { h:'', cols:[
      { k:'name', h:'Bien' } ] },
    { h:'Le bien', cols:[
      { k:'price',   h:'Prix',    n:1 },
      { k:'surface', h:'Surface', n:1 },
      { k:'terrain', h:'Terrain', n:1 },
      { k:'dpe',     h:'DPE' },
      { k:'ges',     h:'GES' } ] },
    { h:'Nos notes', cols:[
      { k:'alex', h:'Alex',      n:1 },
      { k:'sam',  h:'Sam',       n:1 },
      { k:'spot',   h:'Emplacement', n:1 } ] },
    { h:'Calculé', cols:[
      { k:'msurface', h:'Surface', n:1 },
      { k:'menergy',  h:'Énergie', n:1 },
      { k:'mvalue',   h:'Valeur',  n:1 } ] },
    { h:'', cols:[
      { k:'total', h:'Total', n:1 },
      { k:'notes', h:'Commentaires' },
      { k:'visit', h:'Date visite' },
      { k:null,    h:'' } ] }
  ];
  var TCOLS = TGROUPS.reduce(function (a, g) { return a.concat(g.cols); }, []);
  var tableSorted = false;   // until you pick a column, the table ranks by Total

  function tmark(v, colour) {
    if (v == null) return '<i>—</i>';
    return '<b class="t-mark" style="--c:var(--' + colour + ')">' + mark10(v) + '</b>';
  }
  function tletter(l) {
    return /^[A-G]$/.test(l || '')
      ? '<span class="dpebadge dpe-' + l.toLowerCase() + '">' + esc(l) + '</span>' : '<i>—</i>';
  }

  function tcell(d, k) {
    var a = autoScore(d) || {}, m2 = ppm(d), o;
    switch (k) {
      case 'name':
        // three of the listing's photos, fanned; hovering one blows it up
        var pics = shotsOf(d).slice(0, 3);
        return '<span class="t-bien">' +
          '<span class="t-shots">' + pics.map(function (u) {
            // the wrapper carries the photo again as a background, which is
            // what the hover preview enlarges — the thumbnails never move
            // under the pointer and never cover each other
            return '<span class="t-shot" style="--u:url(&quot;' + esc(u) + '&quot;)">' +
              '<img src="' + esc(u) + '" alt="" loading="lazy"' +
              ' onerror="this.onerror=null;this.src=\'' + fallbackOf(d) + '\'">' +
              '</span>';
          }).join('') + '</span>' +
          '<span><b>' + esc(d.name) +
            (d.sold ? ' <span class="tag tag--sold tag--inline">vendu</span>' : '') + '</b>' +
            '<em>' + esc(d.address || d.town ||
              (d.kind === 'land' ? 'Terrain' : 'Adresse à renseigner')) +
            (d.listing === 'gone' ? ' · annonce retirée' : '') + '</em></span>' +
          (RANK[d.id] ? '<i class="rank rank--' + RANK[d.id] + '">' + RANK[d.id] + '</i>' : '') +
          '</span>';
      case 'price':   return d.price == null ? '<i>—</i>' : '<b>' + esc(fmtPrice(d.price)) + '</b>';
      case 'surface': return d.surface ? num.format(d.surface) + ' m²' : '<i>—</i>';
      case 'terrain': return d.terrain ? num.format(d.terrain) + ' m²' : '<i>—</i>';
      case 'rooms':   return d.rooms || '<i>—</i>';
      case 'ppm':     return m2 ? num.format(m2) : '<i>—</i>';
      case 'dpe':     return tletter(d.dpe);
      case 'ges':     return tletter(d.ges);
      case 'alex':  return tmark(ten(scoreOf(d.id, 'alex')), 'alex');
      case 'sam':   return tmark(ten(scoreOf(d.id, 'sam')), 'sam');
      case 'spot':    return tmark(a.spot, 'accent');
      case 'msurface':return tmark(a.surface, 'accent-2');
      case 'menergy': return tmark(a.energy, 'accent-2');
      case 'mvalue':  return tmark(a.value, 'accent-2');
      case 'notes':
        var ns = (D.notes[d.id] || []).slice().sort(function (x, y) { return y.ts - x.ts; });
        if (!ns.length) return '<i>—</i>';
        return '<span class="t-notes">' + ns.slice(0, 2).map(function (n) {
          return '<span class="t-note" style="--who:var(--' + esc(n.user) + ')">' +
            '<b>' + esc((USERS[n.user] || n.user).charAt(0)) + '</b>' + esc(n.text) + '</span>';
        }).join('') +
        (ns.length > 2 ? '<em>+ ' + (ns.length - 2) + '</em>' : '') + '</span>';
      case 'visit':
        if (GUEST) {
          return d.visit ? '<span class="t-visit t-visit--set t-visit--ro">' +
            fmtVisit(d.visit) + visitorHTML(d) + moreVisits(d) + '</span>' : '<i>—</i>';
        }
        return '<button type="button" class="t-visit' + (d.visit ? ' t-visit--set' : '') +
          '" data-visit="1">' + (d.visit ? fmtVisit(d.visit) + visitorHTML(d) + moreVisits(d) : 'fixer…') + '</button>';
      case 'total':
        o = overall(d);
        if (!o) return '<i>—</i>';
        return '<span class="t-total" title="' + num.format(o.sum) + ' / ' + (o.weight * 10) + '">' +
          '<b>' + mark10(o.mark) + '</b>' +
          '<i class="' + (noteBand(d) || '') + '" style="--p:' + (o.mark * 10) + '%"></i></span>';
      default:
        return '<button type="button" class="t-go" data-go="1" ' +
               'title="Voir sur la carte" aria-label="Voir sur la carte">' + TARGET + '</button>';
    }
  }

  /* ───────────────────────── date de visite ─────────────────────────
     A property holds one: when we are going round. Stored as local
     wall-clock — "2026-10-12T14:30" — because a visit is at three o'clock
     wherever the phone happens to think it is, and a timezone on a house
     viewing is a bug waiting to happen.

     The picker is a month grid that opens over the cell: tap a day, set the
     time, save. It lives on <body> so the table's own scrolling never clips
     it. */
  var dayFmt   = new Intl.DateTimeFormat('fr-FR', { day:'numeric', month:'short' });
  var monthFmt = new Intl.DateTimeFormat('fr-FR', { month:'long', year:'numeric' });
  var DOW = ['L','M','M','J','V','S','D'];

  /* Visits. A house is often seen more than once — Sam one week, Alex the
     next — so a bien keeps a list, `visits: [{at, by}]`, oldest first. The
     pin, the table and the sort read `d.visit` / `d.visitBy`: the next one
     coming, or else the latest, derived here after every load and edit. */
  function visitPast(at) {
    at = String(at);
    var now = new Date().toLocaleString('sv').replace(' ', 'T');
    return at.length <= 10 ? at < now.slice(0, 10) : at <= now.slice(0, 16);
  }
  function deriveVisit(d) {
    var vs = Array.isArray(d.visits) ? d.visits.filter(function (v) { return v && v.at; }) : [];
    if (!vs.length && d.visit) vs = [{ at: d.visit, by: d.visitBy || 'sam' }];   // not yet migrated
    vs.sort(function (a, b) { return String(a.at).localeCompare(String(b.at)); });
    d.visits = vs;
    var cur = vs.find(function (v) { return !visitPast(v.at); }) || vs[vs.length - 1] || null;
    d.visit = cur ? cur.at : null;
    d.visitBy = cur ? cur.by || null : null;
  }
  function currentVisitIdx(d) {
    var vs = d.visits || [];
    for (var i = 0; i < vs.length; i++) if (vs[i].at === d.visit) return i;
    return null;
  }

  // Who goes round, as a name in their own colour.
  function whoHTML(by) {
    if (!by || !USERS[by]) return '';
    return '<span class="vby" style="--who:var(--' + esc(by) + ')">' + esc(USERS[by]) + '</span>';
  }
  function visitorHTML(d) { return whoHTML(d.visitBy); }
  function moreVisits(d) {
    var n = (d.visits || []).length;
    return n > 1 ? '<small class="vmore">+' + (n - 1) + '</small>' : '';
  }
  function visitorText(d) {
    var n = (d.visits || []).length;
    return (d.visitBy && USERS[d.visitBy] ? ' — ' + USERS[d.visitBy] : '') +
      (n > 1 ? ' (' + n + ' visites)' : '');
  }

  function fmtVisit(v) {
    if (!v) return null;
    var p = String(v).split('T'), dt = new Date(p[0] + 'T12:00');
    if (isNaN(dt.getTime())) return null;
    return dayFmt.format(dt).replace('.', '') + (p[1] ? ' · ' + p[1].replace(':', 'h') : '');
  }
  function ymd(dt) {
    return dt.getFullYear() + '-' + ('0' + (dt.getMonth() + 1)).slice(-2) +
           '-' + ('0' + dt.getDate()).slice(-2);
  }

  var cal = { el:null, d:null, month:null, day:null };

  function calHTML() {
    var first = new Date(cal.month.getFullYear(), cal.month.getMonth(), 1);
    var lead = (first.getDay() + 6) % 7;                       // Monday first
    var days = new Date(cal.month.getFullYear(), cal.month.getMonth() + 1, 0).getDate();
    var today = ymd(new Date()), cells = '';
    for (var i = 0; i < lead; i++) cells += '<i></i>';
    for (var n = 1; n <= days; n++) {
      var key = ymd(new Date(cal.month.getFullYear(), cal.month.getMonth(), n));
      cells += '<button type="button" data-day="' + key + '"' +
        (key === today ? ' class="is-today"' : '') +
        (key === cal.day ? ' aria-pressed="true"' : '') + '>' + n + '</button>';
    }
    return '<header class="cal__head">' +
        '<button type="button" data-mv="-1" aria-label="Mois précédent">‹</button>' +
        '<b>' + esc(monthFmt.format(cal.month)) + '</b>' +
        '<button type="button" data-mv="1" aria-label="Mois suivant">›</button>' +
      '</header>' +
      '<div class="cal__dow">' + DOW.map(function (x) { return '<i>' + x + '</i>'; }).join('') + '</div>' +
      '<div class="cal__grid">' + cells + '</div>' +
      '<footer class="cal__foot">' +
        '<label>à<input type="time" id="calTime" value="' + esc(cal.time || '14:00') + '" step="900"></label>' +
        '<span class="cal__who" role="group" aria-label="Qui visite">' +
          RATERS.map(function (u) {
            return '<button type="button" data-who="' + u + '" style="--who:var(--' + u + ')"' +
              (cal.who === u ? ' aria-pressed="true"' : '') + '>' + esc(USERS[u]) + '</button>';
          }).join('') + '</span>' +
        '<button type="button" class="btn btn--go" data-act="ok"' + (cal.day ? '' : ' disabled') + '>Enregistrer</button>' +
        (cal.idx != null ? '<button type="button" class="btn" data-act="clear">Supprimer</button>' : '') +
      '</footer>';
  }

  function calPaint() {
    cal.el.innerHTML = calHTML();
  }

  function calPlace(anchorEl) {
    var r = anchorEl.getBoundingClientRect(), el = cal.el;
    var w = el.offsetWidth, h = el.offsetHeight;
    var left = Math.min(Math.max(8, r.left), innerWidth - w - 8);
    var top = r.bottom + 6 + h > innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6;
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }

  // idx: which of the bien's visits to edit; null to add one
  function openCal(d, anchorEl, idx) {
    closeCal();
    var v = idx != null ? d.visits[idx] : null;
    var parts = String(v ? v.at : '').split('T');
    cal.d = d;
    cal.idx = v ? idx : null;
    cal.day = parts[0] || null;
    cal.time = parts[1] || '14:00';
    cal.who = v ? v.by : (RATERS.indexOf(ME) >= 0 ? ME : 'sam');
    cal.month = cal.day ? new Date(cal.day + 'T12:00') : new Date();
    cal.month = new Date(cal.month.getFullYear(), cal.month.getMonth(), 1);

    var el = document.createElement('div');
    el.className = 'cal';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Date de visite');
    cal.el = el;
    calPaint();
    document.body.appendChild(el);
    calPlace(anchorEl);

    el.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.dataset.mv) {
        cal.month = new Date(cal.month.getFullYear(), cal.month.getMonth() + (+b.dataset.mv), 1);
        cal.time = $('calTime').value || cal.time;
        calPaint(); calPlace(anchorEl); return;
      }
      if (b.dataset.who) {
        cal.who = b.dataset.who;
        cal.time = $('calTime').value || cal.time;
        calPaint(); return;
      }
      if (b.dataset.day) {
        cal.day = b.dataset.day;
        cal.time = $('calTime').value || cal.time;
        calPaint(); return;
      }
      if (b.dataset.act === 'clear') { setVisit(cal.d, cal.idx, null); closeCal(); return; }
      if (b.dataset.act === 'ok' && cal.day) {
        var t = $('calTime').value;
        setVisit(cal.d, cal.idx, cal.day + (t ? 'T' + t : ''), cal.who);
        closeCal();
      }
    });
  }

  function closeCal() {
    if (cal.el && cal.el.parentNode) cal.el.parentNode.removeChild(cal.el);
    cal.el = null; cal.d = null;
  }

  // at null removes visit idx; otherwise it is changed, or added when idx is null
  function setVisit(d, idx, at, who) {
    var vs = (d.visits || []).slice();
    if (at == null) { if (idx != null) vs.splice(idx, 1); }
    else if (idx != null) vs[idx] = { at: at, by: who };
    else vs.push({ at: at, by: who });
    d.visits = vs;
    deriveVisit(d);
    write('PUT', '/property/' + encodeURIComponent(d.id), { visits: d.visits });
    redrawMarker(d);
    render();
    // the panel, if it is open on this one, is not part of render()
    var sv = $('sheetVisit');
    if (sv && sv.dataset.id === d.id) sv.outerHTML = sheetVisitHTML(d);
  }

  // in the table it is a quiet pill among many; alone in the panel it has to
  // look like the button it is
  // Other agencies' adverts for the same house, by site name.
  function otherLinksHTML(d) {
    var links = d.links || [];
    if (!links.length) return '';
    return '<p class="sheet__also">Aussi chez ' + links.map(function (u) {
      var host = (String(u).match(/^https?:\/\/(?:www\.)?([^\/?#]+)/i) || [])[1] || u;
      return '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(host) + '</a>';
    }).join(' · ') + '</p>';
  }

  // The textarea's lines as clean, distinct links, leaving out the main one.
  function parseLinks(raw, main) {
    var out = [];
    String(raw || '').split(/\s+/).forEach(function (u) {
      if (!/^https?:\/\//i.test(u) || u.length >= 2048) return;
      if (main && sameListing(u, main)) return;
      if (out.some(function (x) { return sameListing(x, u); })) return;
      out.push(u);
    });
    return out.slice(0, 10);
  }

  var CAL_ICON = '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="2.5" width="9" height="8" rx="1.5"/>' +
    '<path d="M1.5 5h9M4 1.2v2.4M8 1.2v2.4"/></svg>';

  function sheetVisitHTML(d) {
    var vs = d.visits || [];
    if (GUEST) {
      return '<span id="sheetVisit" class="svs" data-id="' + esc(d.id) + '">' + (vs.length
        ? vs.map(function (v) {
            return '<span class="t-visit t-visit--set t-visit--ro' + (visitPast(v.at) ? ' sv--past' : '') + '">' +
              esc(fmtVisit(v.at)) + whoHTML(v.by) + '</span>';
          }).join('')
        : '<i>—</i>') + '</span>';
    }
    return '<span id="sheetVisit" class="svs" data-id="' + esc(d.id) + '">' +
      vs.map(function (v, i) {
        return '<button type="button" data-visit="1" data-idx="' + i + '" class="btn sv sv--set' +
          (visitPast(v.at) ? ' sv--past' : '') + '" title="Modifier cette visite">' +
          (visitPast(v.at) ? '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.6 6.3l2.3 2.3 4.5-5"/></svg>' : CAL_ICON) +
          esc(fmtVisit(v.at)) + whoHTML(v.by) + '</button>';
      }).join('') +
      '<button type="button" data-visit="1" data-idx="new" class="btn sv">' +
        (vs.length ? '+ visite' : CAL_ICON + 'Planifier une visite') + '</button>' +
    '</span>';
  }

  addEventListener('pointerdown', function (e) {
    if (!cal.el) return;
    if (cal.el.contains(e.target) || e.target.closest('[data-visit]')) return;
    closeCal();
  });
  addEventListener('keydown', function (e) { if (e.key === 'Escape') closeCal(); });
  // the panel's own pill; delegated, since the panel is rebuilt on every open
  addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('#sheetVisit [data-visit]');
    if (!b) return;
    var d = D.properties.find(function (x) { return x.id === b.parentNode.dataset.id; });
    if (d) openCal(d, b, b.dataset.idx === 'new' ? null : +b.dataset.idx);
  });

  function renderTable(rows) {
    var head1 = TGROUPS.map(function (g) {
      return '<th colspan="' + g.cols.length + '" class="t-grp">' + esc(g.h) + '</th>';
    }).join('');
    var head2 = TCOLS.map(function (c) {
      if (!c.k) return '<th></th>';
      var on = state.sort === c.k;
      return '<th' + (c.n ? ' class="n"' : '') + (on ? ' aria-sort="' +
        ((SORTS[c.k].dir * (state.flip ? -1 : 1)) < 0 ? 'descending' : 'ascending') + '"' : '') + '>' +
        '<button type="button" data-sort="' + c.k + '">' + esc(c.h) +
        '<i>' + (on ? ((SORTS[c.k].dir * (state.flip ? -1 : 1)) < 0 ? '▾' : '▴') : '') + '</i>' +
        '</button></th>';
    }).join('');

    var body = rows.map(function (d) {
      return '<tr class="trow' + (d.hidden ? ' trow--hidden' : '') +
        (d.sold ? ' trow--sold' : '') + '" data-id="' + esc(d.id) + '"' +
        ' aria-current="' + (d.id === activeId ? 'true' : 'false') + '" tabindex="0">' +
        TCOLS.map(function (c) {
          return '<td' + (c.n ? ' class="n"' : (c.k ? '' : ' class="t-act"')) + '>' + tcell(d, c.k) + '</td>';
        }).join('') + '</tr>';
    }).join('');

    $('tablewrap').innerHTML = rows.length
      ? '<div class="tablewrap__scroll"><table class="tbl">' +
          '<thead><tr class="tbl__grp">' + head1 + '</tr><tr>' + head2 + '</tr></thead>' +
          '<tbody>' + body + '</tbody>' +
        '</table></div>'
      : '<div class="tbl__empty"><h2>Rien à afficher</h2><p>' + emptyWhy() + '</p></div>';
  }

  function wireTable() {
    var host = $('tablewrap');
    host.addEventListener('click', function (e) {
      var th = e.target.closest('thead button');
      if (th) {
        var k = th.dataset.sort;
        tableSorted = true;
        state.flip = state.sort === k ? !state.flip : false;
        state.sort = k;
        // the rail's own sort buttons follow, where they have the same key
        Array.prototype.forEach.call($('sorts').children, function (x) {
          x.setAttribute('aria-pressed', String(x.dataset.sort === k));
        });
        render();
        return;
      }
      var tr = e.target.closest('.trow');
      if (!tr) return;
      var row = D.properties.find(function (x) { return x.id === tr.dataset.id; });
      var vis = e.target.closest('[data-visit]');
      if (vis) { e.stopPropagation(); if (row) openCal(row, vis, currentVisitIdx(row)); return; }
      if (e.target.closest('[data-go]')) { setView('map'); select(tr.dataset.id, true); return; }
      select(tr.dataset.id, false);
    });
    host.addEventListener('keydown', function (e) {
      var tr = e.target.closest && e.target.closest('.trow');
      if (!tr || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault(); select(tr.dataset.id, false);
    });
    $('viewtog').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      setView(b.dataset.v);
    });
  }

  function setView(v) {
    if (v !== 'dash' && v !== 'table') v = 'map';
    var table = v === 'table', dash = v === 'dash';
    if (state.table === table && !!state.dash === dash && ready) return;
    state.table = table; state.dash = dash;
    $('app').classList.toggle('view-table', table);
    $('app').classList.toggle('view-dash', dash);
    $('tablewrap').hidden = !table;
    $('dashwrap').hidden = !dash;
    Array.prototype.forEach.call($('viewtog').children, function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.v === v));
    });
    try { localStorage.setItem('pm-view', v); } catch (e) {}
    // the table is for ranking, so it opens on the mark that ranks them
    if (table && !tableSorted) {
      state.sort = 'total'; state.flip = false;
      Array.prototype.forEach.call($('sorts').children, function (x) {
        x.setAttribute('aria-pressed', String(x.dataset.sort === 'total'));
      });
    }
    if (table) renderTable(visible());
    else if (dash) renderDash();
    // Leaflet measures nothing while it is hidden, so it needs telling
    else requestAnimationFrame(function () { map.invalidateSize(); refreshMarkers(); });
  }

  /* ─────────────── dash ───────────────
     The morning-coffee view: what is coming up, what changed, what is
     winning. It reads the whole record rather than the rail's filters —
     it is an overview, and a filter left on from yesterday would make it
     quietly wrong. Every row opens its bien. */
  var dashDay = new Intl.DateTimeFormat('fr-FR', { weekday:'short', day:'numeric', month:'short' });

  function visitParts(v) {
    var p = String(v).split('T'), dt = new Date(p[0] + 'T12:00');
    return { day: p[0], time: p[1] ? p[1].replace(':', 'h') : '', date: dt };
  }
  function daysTo(day) {
    return Math.round((new Date(day + 'T12:00') - new Date(ymd(new Date()) + 'T12:00')) / 864e5);
  }
  function inDays(day) {
    var n = daysTo(day);
    return n === 0 ? 'aujourd’hui' : n === 1 ? 'demain' : 'dans ' + n + ' jours';
  }

  function renderDash() {
    var today = ymd(new Date());
    var live = active().filter(function (d) { return !d.sold; });
    var upcoming = [];
    live.forEach(function (d) {
      (d.visits || []).forEach(function (v) {
        if (String(v.at).slice(0, 10) >= today) upcoming.push({ d: d, v: v });
      });
    });
    upcoming.sort(function (a, b) { return String(a.v.at).localeCompare(String(b.v.at)); });
    function lastPast(d) {
      var p = (d.visits || []).filter(function (v) { return String(v.at).slice(0, 10) < today; });
      return p.length ? p[p.length - 1].at : null;
    }
    var both = live.filter(function (d) {
      var a = scoreOf(d.id, 'alex'), b = scoreOf(d.id, 'sam');
      return a != null && b != null && Math.min(a, b) >= 3;
    });
    var rater = GUEST ? null : ME;
    var toRate = rater ? live.filter(function (d) {
      return lastPast(d) && scoreOf(d.id, rater) == null;
    }).sort(function (a, b) { return String(lastPast(b)).localeCompare(String(lastPast(a))); }) : [];
    var top = live.map(function (d) { return { d: d, o: overall(d) }; })
                  .filter(function (x) { return x.o; })
                  .sort(function (a, b) { return b.o.mark - a.o.mark; }).slice(0, 5);
    var byId = {};
    D.properties.forEach(function (d) { byId[d.id] = d; });
    var weekAgo = Date.now() - 7 * 864e5, recentN = 0, recent = [];
    Object.keys(D.notes).forEach(function (id) {
      if (!byId[id]) return;
      (D.notes[id] || []).forEach(function (n) {
        if (n.ts >= weekAgo) recentN++;
        recent.push({ d: byId[id], n: n });
      });
    });
    recent.sort(function (a, b) { return b.n.ts - a.n.ts; });
    recent = recent.slice(0, 6);

    function line(d) {
      return [d.town, d.price != null ? fmtPrice(d.price) : null,
              d.surface ? num.format(d.surface) + ' m²' : null].filter(Boolean).map(esc).join(' · ');
    }
    function tile(n, label, sub, go) {
      return '<button type="button" class="dtile" data-go="' + go + '">' +
        '<b>' + n + '</b><span>' + label + '</span><small>' + sub + '</small></button>';
    }

    var visits = upcoming.length
      ? upcoming.map(function (x) {
          var d = x.d, v = visitParts(x.v.at), n = daysTo(v.day);
          // the hour is what you need in the car, so it leads; the day sits under it
          return '<li><button type="button" class="drow" data-id="' + esc(d.id) + '">' +
            '<span class="drow__when"><b>' + esc(v.time || '—') + '</b>' +
              '<span>' + esc(dashDay.format(v.date).replace('.', '')) + '</span></span>' +
            '<span class="drow__what"><b>' + esc(d.name) + '</b><span>' + whoHTML(x.v.by) + line(d) + '</span></span>' +
            '<span class="dchip' + (n === 0 ? ' dchip--now' : n === 1 ? ' dchip--soon' : '') + '">' +
              inDays(v.day) + '</span></button></li>';
        }).join('')
      : '<li class="dempty">Aucune visite prévue. Fixe une date depuis la fiche d’un bien.</li>';

    var ranked = top.length
      ? top.map(function (x, i) {
          return '<li><button type="button" class="drow" data-id="' + esc(x.d.id) + '">' +
            '<span class="drow__rank">' + (i + 1) + '</span>' +
            '<span class="drow__what"><b>' + esc(x.d.name) + '</b><span>' + line(x.d) + '</span></span>' +
            '<span class="drow__mark">' + num.format(Math.round(x.o.mark * 10) / 10) + '<small>/10</small></span>' +
            '</button></li>';
        }).join('')
      : '<li class="dempty">Rien de noté pour l’instant.</li>';

    var said = recent.length
      ? recent.map(function (r) {
          var t = r.n.text.length > 140 ? r.n.text.slice(0, 140) + '…' : r.n.text;
          return '<li><button type="button" class="drow drow--note" data-id="' + esc(r.d.id) + '" style="--who:var(--' + esc(r.n.user) + ')">' +
            '<span class="drow__what"><span class="drow__by"><b>' + esc(USERS[r.n.user] || r.n.user) + '</b>' +
              '<em>' + esc(r.d.name) + '</em><time>' + esc(when.format(new Date(r.n.ts))) + '</time></span>' +
              '<span class="drow__quote">' + esc(t) + '</span></span></button></li>';
        }).join('')
      : '<li class="dempty">Pas encore de commentaire.</li>';

    $('dashwrap').innerHTML = '<div class="dash">' +
      '<section class="dpanel dpanel--visits"><h2>Prochaines visites' +
        (upcoming.length ? ' <small>' + upcoming.length + '</small>' : '') + '</h2><ol class="dlist">' + visits + '</ol></section>' +
      '<div class="dtiles">' +
        tile(live.length, 'Biens suivis', 'hors masqués et vendus', 'all') +
        tile(upcoming.length, 'Visites à venir', upcoming.length ? 'la prochaine ' + inDays(String(upcoming[0].v.at).slice(0, 10)) : 'rien de prévu', 'visits') +
        tile(both.length, 'Coups de cœur communs', 'notés 3+ par vous deux', 'both') +
        tile(recentN, 'Commentaires', 'ces 7 derniers jours', 'notes') +
      '</div>' +
      (toRate.length ? '<section class="dpanel dpanel--todo"><h2>Visités, à noter <small>' +
        'pas encore notés par toi</small></h2><ol class="dlist">' +
        toRate.slice(0, 5).map(function (d) {
          var v = visitParts(lastPast(d));
          return '<li><button type="button" class="drow" data-id="' + esc(d.id) + '">' +
            '<span class="drow__what"><b>' + esc(d.name) + '</b><span>visité ' +
              esc(dashDay.format(v.date).replace('.', '')) + (line(d) ? ' · ' + line(d) : '') + '</span></span>' +
            '<span class="dchip dchip--todo">à noter</span></button></li>';
        }).join('') + '</ol></section>' : '') +
      '<div class="dcols">' +
        '<section class="dpanel"><h2>En tête <small>par note totale</small></h2><ol class="dlist">' + ranked + '</ol></section>' +
        '<section class="dpanel"><h2>Derniers commentaires</h2><ol class="dlist">' + said + '</ol></section>' +
      '</div>' +
    '</div>';
  }

  function wireDash() {
    $('dashwrap').addEventListener('click', function (e) {
      var row = e.target.closest('.drow');
      if (row) { select(row.dataset.id, false); return; }
      var t = e.target.closest('.dtile'); if (!t) return;
      // each tile lands on the table, filtered to what it counted
      var go = t.dataset.go;
      if (go === 'both' || go === 'all') { $('view').value = go; state.view = go; }
      if (go === 'visits') { state.sort = 'visit'; state.flip = false; tableSorted = true; }
      if (go === 'notes') { state.sort = 'notes'; state.flip = false; tableSorted = true; }
      Array.prototype.forEach.call($('sorts').children, function (x) {
        x.setAttribute('aria-pressed', String(x.dataset.sort === state.sort));
      });
      setView('table');
      render();
    });
  }

  function emptyWhy() {
    if (state.view === 'hidden') return 'Aucun bien masqué.';
    if (state.view === 'both')   return 'Aucun bien noté au moins 3 par vous deux.';
    if (state.view === 'mine')
      return (GUEST ? USERS.alex + ' n’a' : 'Tu n’as') + ' encore rien noté 4 ou plus.';
    if (state.view === 'theirs')
      return USERS[GUEST ? 'sam' : OTHER] + ' n’a encore rien noté 4 ou plus.';
    if (state.towns.length)      return 'Aucun bien dans les communes choisies.';
    return 'Les filtres excluent tout le monde.';
  }

  function standfirst(rows) {
    var withPrice = rows.filter(function (d) { return d.price != null; });
    var avg = withPrice.length
      ? Math.round(withPrice.reduce(function (a,d) { return a + d.price; }, 0) / withPrice.length / 1000) * 1000 : null;
    var m2s = rows.map(ppm).filter(Boolean);
    var avgM2 = m2s.length ? Math.round(m2s.reduce(function (a,b) { return a+b; }, 0) / m2s.length) : null;
    var total = active().length;
    var parts = ['<b>' + rows.length + '</b> bien' + (rows.length > 1 ? 's' : '') +
                 (state.view === 'hidden' ? ' masqué' + (rows.length > 1 ? 's' : '')
                                          : (rows.length !== total ? ' sur ' + total : ''))];
    if (avg) parts.push('<b>' + euro.format(avg) + '</b> en moyenne');
    if (avgM2) parts.push('<b>' + num.format(avgM2) + ' €/m²</b>');
    var missing = rows.length - withPrice.length;
    $('standfirst').innerHTML = parts.join(', ') + '.' +
      (missing ? ' ' + missing + (missing > 1 ? ' sans prix.' : ' sans prix.') : '');
  }

  var BUCKETS = 22;
  function histogram(rows) {
    var el = $('hist');
    if (!priced.length) { el.innerHTML = ''; return; }
    var lo = priced[0], span = (PMAX - lo) || 1, counts = new Array(BUCKETS).fill(0);
    rows.forEach(function (d) {
      if (d.price == null) return;
      counts[Math.min(BUCKETS-1, Math.floor((d.price - lo) / span * BUCKETS))]++;
    });
    var peak = Math.max.apply(null, counts) || 1;
    var cut = Math.min(BUCKETS-1, Math.floor((state.maxPrice - lo) / span * BUCKETS));
    el.innerHTML = counts.map(function (c, i) {
      return '<i class="' + (c ? (i <= cut ? 'on' : 'off') : '') + '" style="height:' +
             (c ? Math.max(8, Math.round(c/peak*100)) : 4) + '%"></i>';
    }).join('');
  }

  function resetFilters() {
    state.kind='all'; state.view='all'; state.towns=[]; state.q=''; state.maxPrice=PMAX||Infinity; state.minSurface=0;
    $('q').value=''; $('maxPrice').value=PMAX; $('minSurface').value=0;
    $('maxPriceOut').textContent = PMAX ? euro.format(PMAX) : '—';
    $('minSurfaceOut').textContent = 'indifférente';
    $('kind').value = 'all'; $('view').value = 'all'; $('town').value = '';
    render();
  }

  function hover(id, on) { var a = anchors[id]; if (a) a.classList.toggle('on', on || id === activeId); }

  function select(id, fly) {
    activeId = id;
    Object.keys(anchors).forEach(function (k) {
      anchors[k].classList.toggle('on', k === id);
      anchors[k].classList.toggle('sel', k === id);
    });
    // the chosen pin rides above every other one, and the map steps back
    D.properties.forEach(function (x) {
      var m = markers[x.id];
      if (m && m.setZIndexOffset) m.setZIndexOffset(x.id === id ? 1000 : 0);
    });
    map.getContainer().classList.toggle('map--sel', !!id);
    Array.prototype.forEach.call(document.querySelectorAll('.card, .trow'), function (c) {
      c.setAttribute('aria-current', c.dataset.id === id ? 'true' : 'false');
    });
    if (!id) {
      $('sheet').classList.remove('open'); syncHash(null);
      if (sheetMap) { sheetMap.remove(); sheetMap = null; }
      return;
    }
    syncHash(id);
    var d = D.properties.find(function (x) { return x.id === id; });
    if (fly) map.flyTo([d.lat, d.lng], Math.max(map.getZoom(), 16), { duration:.7 });
    collapseForDetail();
    openSheet(d);
  }


  /* ───────────────────────── documents ─────────────────────────
     Floorplans, the DPE, a surveyor's report — anything that is about the
     property but is not a picture of it. The upload path is the photo path
     generalised: ask the API for a presigned PUT, send the bytes straight to
     S3, and never stream a 20 MB plan through the Lambda.

     A file dropped here that turns out to be an image is sent down the photo
     route instead. Dropping a photo on the wrong box should add the photo,
     not refuse it. */

  var FILE_TYPES = {
    'application/pdf': 'PDF',
    'application/msword': 'DOC',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOC',
    'application/vnd.ms-excel': 'XLS',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLS',
    'text/csv': 'CSV',
    'text/plain': 'TXT',
    'image/jpeg': 'IMG', 'image/png': 'IMG', 'image/webp': 'IMG',
    'image/heic': 'IMG', 'image/heif': 'IMG'
  };
  var FILE_ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.jpg,.jpeg,.png,.webp,.heic,.mp4,.mov,.webm';
  var MAX_FILE = 25 * 1024 * 1024;
  // Videos ride the photo route and land in the Photos section, never the
  // listing's carousel. Same limits as the API.
  var VIDEO_TYPES = { 'video/mp4': 1, 'video/quicktime': 1, 'video/webm': 1 };
  var MEDIA_ACCEPT = 'image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm,.mov';
  var MAX_VIDEO = 500 * 1024 * 1024;

  // Uploads in flight, per property, so the list can show a row before the
  // bytes have landed. Keyed by property id; cleared as each one settles.
  var pendingFiles = {};
  // How far through the current batch we are, per property. Counted separately
  // from pendingFiles because rows leave that list as they land, which would
  // otherwise shrink the denominator: "2 sur 2" followed by "1 sur 1".
  var uploadTally = {};

  function isImageFile(f) { return /^image\//.test(f.type || ''); }
  // A file from the picker, or one of D.photos — both carry a type somewhere.
  // Rows from before videos existed have no contentType, and are all photos.
  function isVideoFile(f) { return /^video\//.test(f.type || '') || /\.mov$/i.test(f.name || ''); }
  function isVideo(p) { return /^video\//.test(p.contentType || '') || /\.(mp4|mov|webm)$/i.test(p.url || ''); }
  function isMediaFile(f) { return isImageFile(f) || isVideoFile(f); }

  function fmtBytes(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' o';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' Ko';
    return (n / 1024 / 1024).toFixed(1).replace('.', ',') + ' Mo';
  }

  // A PDF or a picture is worth previewing in a tab; a spreadsheet is not, and
  // since the key is a uuid it needs `download` to arrive under its real name.
  function inlineType(ct) { return ct === 'application/pdf' || /^image\//.test(ct || ''); }

  function docsHTML(d) {
    var rows = (D.files[d.id] || []).slice().sort(function (a, b) { return b.ts - a.ts; });
    var queued = pendingFiles[d.id] || [];
    if (!rows.length && !queued.length) {
      return '<li class="docs__none">Aucun document pour l’instant.</li>';
    }
    return queued.map(function (q, i) {
      var pct = Math.round((q.progress || 0) * 100);
      return '<li class="doc doc--' + (q.error ? 'err' : 'busy') + '">' +
        '<span class="doc__ico">' + (q.error ? '!' : (q.video ? 'VID' : q.photo ? 'IMG' : 'PDF')) + '</span>' +
        '<span class="doc__txt"><b>' + esc(q.name) + '</b>' +
          '<span class="doc__meta">' +
            (q.error ? esc(q.error)
                     : (q.photo ? 'vers les photos · ' : '') +
                       (q.progress == null ? 'en attente' : pct + ' %')) +
          '</span>' +
          (q.error ? '' :
            '<span class="doc__bar"><span class="doc__barfill" style="width:' + pct + '%"></span></span>') +
        '</span>' +
        (q.error ? '<button class="doc__x" type="button" data-fdrop="' + i +
          '" aria-label="Retirer ' + esc(q.name) + '">✕</button>' : '') +
        '</li>';
    }).join('') + rows.map(function (f) {
      return '<li class="doc">' +
        '<a class="doc__a" href="' + esc(f.url) + '" target="_blank" rel="noopener"' +
          (inlineType(f.contentType) ? '' : ' download="' + esc(f.name || '') + '"') + '>' +
          '<span class="doc__ico">' + esc(FILE_TYPES[f.contentType] || 'FIC') + '</span>' +
          '<span class="doc__txt"><b>' + esc(f.name || 'document') + '</b>' +
            '<span class="doc__meta">' + [
              fmtBytes(f.size),
              USERS[f.user] || f.user,
              f.ts ? when.format(new Date(f.ts)) : null
            ].filter(Boolean).map(esc).join(' · ') + '</span></span>' +
        '</a>' +
        (GUEST ? '' : '<button class="doc__x" type="button" data-fdel="' + f.ts +
          '" aria-label="Supprimer ' + esc(f.name || 'ce document') + '">✕</button>') +
        '</li>';
    }).join('');
  }

  // Repaint only the list: re-opening the whole sheet on every settled upload
  // would scroll you back to the top mid-send.
  function renderDocs(d) {
    var el = $('docList');
    if (el) { el.innerHTML = docsHTML(d); wireDocRows(d); }
    var count = $('docCount');
    if (count) {
      var t = uploadTally[d.id];
      count.textContent = t && t.total > 1
        ? ' · ' + Math.min(t.done + 1, t.total) + ' sur ' + t.total : '';
    }
  }

  function wireDocRows(d) {
    // a failed upload stays on screen until it is read and dismissed
    Array.prototype.forEach.call(document.querySelectorAll('#docList [data-fdrop]'), function (b) {
      b.addEventListener('click', function () {
        (pendingFiles[d.id] || []).splice(+b.dataset.fdrop, 1);
        renderDocs(d);
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('#docList [data-fdel]'), function (b) {
      b.addEventListener('click', function () {
        var ts = +b.dataset.fdel;
        var f = (D.files[d.id] || []).find(function (x) { return x.ts === ts; });
        if (f && !confirm('Supprimer « ' + (f.name || 'ce document') + ' » ?')) return;
        D.files[d.id] = (D.files[d.id] || []).filter(function (x) { return x.ts !== ts; });
        if (LOCAL) saveLocal();
        else write('DELETE', '/file/' + encodeURIComponent(d.id) + '/' + ts);
        renderDocs(d);
      });
    });
  }

  // fetch() reports nothing until a request finishes, and a 4 MB plan over a
  // village connection is a long silence. XHR still has upload.onprogress.
  function putWithProgress(url, file, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('PUT', url, true);
      xhr.setRequestHeader('content-type', file.type);
      xhr.upload.addEventListener('progress', function (e) {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      });
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) { onProgress(1); resolve(); }
        else reject(new Error('S3 ' + xhr.status));
      };
      xhr.onerror = function () { reject(new Error('réseau')); };
      xhr.onabort = function () { reject(new Error('interrompu')); };
      xhr.send(file);
    });
  }

  function uploadPhoto(d, file, onProgress) {
    if (LOCAL) {
      return new Promise(function (res) {
        var fr = new FileReader();
        fr.onload = function () {
          D.photos[d.id] = (D.photos[d.id] || []).concat([{ url: fr.result, user: ME, ts: Date.now() }]);
          saveLocal(); res();
        };
        fr.onerror = function () { res(); };
        fr.readAsDataURL(file);
      });
    }
    return api('POST', '/upload/' + encodeURIComponent(d.id), { contentType: mediaType(file), size: file.size })
      .then(function (r) {
        return putWithProgress(r.putUrl, file, onProgress).then(function () {
          // r.ts is the row's key on the server; a locally invented one would
          // not match, and deleting this photo later would silently do nothing
          D.photos[d.id] = (D.photos[d.id] || []).concat([
            { url:r.url, key:r.key, user:ME, ts:r.ts, contentType:r.contentType }
          ]);
        }).catch(function (e) {
          // the row exists before the bytes do; a video that never arrived
          // would otherwise sit in the grid as a black square
          write('DELETE', '/photo/' + encodeURIComponent(d.id) + '/' + r.ts);
          throw e;
        });
      });
  }

  // Some browsers hand a .mov over with no type at all.
  function mediaType(f) { return f.type || (/\.mov$/i.test(f.name || '') ? 'video/quicktime' : ''); }

  function uploadDoc(d, file, onProgress) {
    return api('POST', '/file/' + encodeURIComponent(d.id),
               { name: file.name, contentType: file.type, size: file.size })
      .then(function (r) {
        return putWithProgress(r.putUrl, file, onProgress).then(function () {
          D.files[d.id] = (D.files[d.id] || []).concat([{
            ts: r.ts, user: ME, url: r.url, key: r.key,
            name: r.name, size: r.size, contentType: r.contentType
          }]);
        }).catch(function (e) {
          // The row is written before the bytes are sent, so a failed upload
          // would otherwise leave a name in the list linking to nothing.
          write('DELETE', '/file/' + encodeURIComponent(d.id) + '/' + r.ts);
          throw e;
        });
      });
  }

  // One queue for whatever arrived, photos and documents alike, sent one at a
  // time: a phone on a village connection does far better with four sequential
  // PUTs than four competing ones.
  function takeFiles(d, list) {
    var files = Array.prototype.slice.call(list || []);
    if (!files.length) return;

    var imgs = files.filter(isImageFile);
    var vids = files.filter(isVideoFile);
    var docs = files.filter(function (f) { return !isMediaFile(f); });

    // With no API there is nowhere to put a 20 MB plan: a photo fits in local
    // storage as a data URL, a scanned floorplan does not, and queueing one
    // we cannot store would be a lie. Say so instead.
    if (LOCAL || !navigator.onLine) {
      if (imgs.length && LOCAL) {
        imgs.reduce(function (c, f) { return c.then(function () { return uploadPhoto(d, f); }); },
                    Promise.resolve())
            .then(function () { openSheet(d); redrawMarker(d); render(); });
      } else if (imgs.length) {
        alert('Envoi impossible hors ligne. Réessaie quand la connexion revient.');
      }
      // a video is no more storable as a data URL than a floorplan is
      docs = docs.concat(vids);
      if (docs.length) {
        pendingFiles[d.id] = (pendingFiles[d.id] || []).concat(docs.map(function (f) {
          return { name: f.name || 'document',
                   error: LOCAL ? 'envoi impossible sans le serveur' : 'envoi impossible hors ligne' };
        }));
        renderDocs(d);
      }
      return;
    }

    // Check type and size here rather than letting the API say no: the answer
    // is instant, and it comes back in French.
    var queue = files.map(function (f) {
      var row = { name: f.name || 'document', file: f, photo: isMediaFile(f), video: isVideoFile(f) };
      if (row.video) {
        if (!VIDEO_TYPES[mediaType(f)]) row.error = 'format vidéo non accepté (MP4, MOV, WebM)';
        else if (f.size > MAX_VIDEO) row.error = 'vidéo trop volumineuse (' + fmtBytes(f.size) + ', 500 Mo max)';
        return row;
      }
      if (row.photo) return row;
      if (!FILE_TYPES[f.type]) row.error = 'type de fichier non accepté';
      else if (f.size > MAX_FILE) row.error = 'trop volumineux (' + fmtBytes(f.size) + ')';
      return row;
    });
    // Photos queue visibly too. A button that does nothing for ten seconds is
    // the thing people click again, so everything in flight is on screen.
    pendingFiles[d.id] = (pendingFiles[d.id] || []).concat(queue);
    var tally = uploadTally[d.id] = uploadTally[d.id] || { done: 0, total: 0 };
    tally.total += queue.length;
    renderDocs(d);

    var touchedPhotos = false, landed = 0;
    queue.reduce(function (chain, q) {
      return chain.then(function () {
        if (q.error) { tally.done++; renderDocs(d); return; }
        var paint = throttle(function () { renderDocs(d); }, 120);
        var onProgress = function (p) { q.progress = p; paint(); };
        q.progress = 0;
        renderDocs(d);   // "en attente" is for files still queued behind this one
        var job = q.photo ? uploadPhoto(d, q.file, onProgress)
                          : uploadDoc(d, q.file, onProgress);
        return job.then(function () {
          if (q.photo) touchedPhotos = true;
          landed++;
          tally.done++;
          pendingFiles[d.id] = (pendingFiles[d.id] || []).filter(function (x) { return x !== q; });
          renderDocs(d);
        }).catch(function (e) {
          tally.done++;
          // the API speaks English; the row does not, so keep the detail in
          // the console and show something you can act on
          console.warn('upload failed', q.name, e);
          q.error = 'envoi impossible — réessaie';
          q.progress = null;
          renderDocs(d);
        });
      });
    }, Promise.resolve()).then(function () {
      delete uploadTally[d.id];
      renderDocs(d);
      // One mail for the whole batch, sent once the queue has drained rather
      // than per file. Through the outbox, so a connection that drops between
      // the last upload and this call retries instead of losing the alert.
      if (landed && !LOCAL) write('POST', '/notify-files/' + encodeURIComponent(d.id));
      // A new photo changes the hero and the marker thumbnail, so that one does
      // need the full repaint the document list is careful to avoid.
      if (touchedPhotos) { openSheet(d); redrawMarker(d); render(); }
    });
  }

  // Progress events arrive far faster than anyone can read, so repaint at most
  // every `ms`. Deliberately NOT requestAnimationFrame: a background tab never
  // runs those, which froze the bar at 0 % for the whole upload. setTimeout is
  // clamped when hidden but still fires, so the count keeps moving either way.
  function throttle(fn, ms) {
    var last = 0, timer = null;
    return function () {
      var wait = ms - (Date.now() - last);
      if (wait <= 0) { last = Date.now(); fn(); return; }
      if (timer) return;
      timer = setTimeout(function () { timer = null; last = Date.now(); fn(); }, wait);
    };
  }

  // A file dropped anywhere but the panel would navigate the tab away from the
  // app — losing the sheet, the queue and everything not yet sent. Swallow it.
  addEventListener('dragover', function (e) { if (hasFiles(e)) e.preventDefault(); });
  addEventListener('drop', function (e) { if (hasFiles(e)) e.preventDefault(); });

  /* The whole panel is the drop target, not the little dashed box: aiming at a
     60-pixel strip is how a drop lands outside it and gets swallowed by the
     guard above, which reads as "drag and drop doesn't work".

     Wired ONCE, here. #sheet is a static element that outlives every openSheet,
     so wiring it per-open stacked a listener each time and uploaded the same
     file once per sheet you had opened. The property is resolved at drop time
     instead of being closed over. */
  (function wirePanelDrop() {
    var sheetEl = $('sheet'), depth = 0;
    function current() { return D.properties.find(function (x) { return x.id === activeId; }); }
    function show(on) {
      var veil = $('sheetDrop'), zone = $('drop');
      if (veil) veil.hidden = !on;
      if (zone) zone.classList.toggle('drop--over', on);
    }
    sheetEl.addEventListener('dragenter', function (e) {
      if (!hasFiles(e) || !current()) return;
      e.preventDefault(); depth++; show(true);
    });
    sheetEl.addEventListener('dragover', function (e) {
      if (!hasFiles(e) || !current()) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      show(true);
    });
    sheetEl.addEventListener('dragleave', function () {
      if (--depth <= 0) { depth = 0; show(false); }
    });
    sheetEl.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0; show(false);
      var d = current();
      if (d) takeFiles(d, e.dataTransfer && e.dataTransfer.files);
    });
  })();

  /* ───────────────────────── detail sheet ───────────────────────── */
  var sheetMap = null;
  function openSheet(d) {
    var sheet = $('sheet'), m2 = ppm(d);
    var notes = (D.notes[d.id] || []).slice().sort(function (a,b) { return b.ts - a.ts; });
    var mine = uploads(d);

    sheet.innerHTML =
      '<button class="sheet__close" id="sx" aria-label="Fermer">✕</button>' +
      '<div class="sheet__scroll">' + galleryHTML(d) +
      '<div class="sheet__body">' +
        (d.type || d.kind ? '<div class="sheet__kind">' + esc(d.type || (d.kind === 'land' ? 'Terrain' : 'Bien')) + '</div>' : '') +
        '<h2 class="sheet__name">' + esc(d.name) + '</h2>' +
        '<button class="sharebtn" type="button" id="share" data-link="' + esc(linkFor(d.id)) + '">' +
          'Copier le lien' +
        '</button>' +
        '<div class="sheet__where">' + esc(d.address || d.town || '') +
          ((d.address || d.town) ? '<span class="sheet__where__acts">' +
            '<button type="button" class="linkbtn" id="copyAddr">Copier l’adresse</button>' +
            '<a class="linkbtn" href="' + esc(mapsLink(d)) + '" target="_blank" rel="noopener">Google Maps ↗</a>' +
          '</span>' : '') +
        '</div>' +
        '<div class="sheet__priceline">' +
          (d.price != null ? '<div class="sheet__price">' + esc(fmtPrice(d.price)) + '</div>'
                           : '<div class="sheet__price sheet__price--none">prix à renseigner</div>') +
          (d.sold ? '<span class="tag tag--sold tag--inline">vendu</span>' : '') +
        '</div>' +
        (m2 ? '<div class="sheet__ppm">' + num.format(m2) + ' €/m²</div>' : '') +
        '<dl class="stats">' +
          '<div><dt>Surface</dt><dd>' + (d.surface ? num.format(d.surface) + ' m²' : '—') + '</dd></div>' +
          (d.terrain ? '<div><dt>Terrain</dt><dd>' + num.format(d.terrain) + ' m²</dd></div>' : '') +
          '<div><dt>Pièces</dt><dd>' + (d.rooms || '—') + '</dd></div>' +
          '<div><dt>€ / m²</dt><dd>' + (m2 ? num.format(m2) : '—') + '</dd></div>' +
        '</dl>' +
        (d.dpe || d.ges
          ? '<div class="dpe-row">' +
              (d.dpe ? '<span class="dpebadge dpe-' + d.dpe.toLowerCase() + '">' +
                 '<b>DPE</b>' + esc(d.dpe) + '</span>' : '') +
              (d.ges ? '<span class="dpebadge dpe-' + d.ges.toLowerCase() + '">' +
                 '<b>GES</b>' + esc(d.ges) + '</span>' : '') +
            '</div>'
          : '') +
        '<div class="sheet__visit"><span>Visites</span>' + sheetVisitHTML(d) + '</div>' +
        (d.chambres ? '<p class="sheet__approx">' + esc(d.chambres) + ' chambres</p>' : '') +
        (d.url ? '<a class="sheet__link' + (d.listing === 'gone' ? ' sheet__link--gone' : '') + '" href="' +
          esc(d.url) + '" target="_blank" rel="noopener">' +
          (d.listing === 'gone' ? 'Annonce retirée' : 'Voir l’annonce') + ' →</a>' : '') +
        otherLinksHTML(d) +
        '<div class="sheet__map" id="smap"></div>' +
        '<p class="sheet__pos">' +
          (approx(d) ? 'Position approximative, géocodée depuis l’adresse. ' : 'Position placée à la main. ') +
          (GUEST ? '' : '<button type="button" class="linkbtn" id="repos">Corriger la position</button>') +
        '</p>' +

        '<section class="sec"><h3>Nos notes</h3>' +
          autoRow(d, !GUEST, (GUEST ? RATERS : [ME, OTHER]).map(function (u) {
            return scoreRow(d, u, !GUEST && u === ME);
          }).join('')) + '</section>' +

        '<section class="sec"><h3>Commentaires</h3>' +
          '<div class="notes" id="noteList">' + notes.map(noteHTML).join('') + '</div>' +
          '<form class="note-form" id="noteForm">' +
            '<textarea id="noteText" rows="1" placeholder="Ajouter un commentaire…" maxlength="2000"></textarea>' +
            '<button class="btn btn--go" type="submit">Ajouter</button>' +
          '</form>' +
        '</section>' +

        nearbyHTML(d) +

        '<section class="sec"><h3>Photos et vidéos</h3>' +
          ((!d.gallery || !d.gallery.length) && d.url
            ? '<p class="hidden-note" id="mergeMsg">Pas encore de photos. Ouvre ' +
              '<a href="' + esc(d.url) + '" target="_blank" rel="noopener">l’annonce</a> ' +
              'et clique « Ajouter à Property Map » : les photos viendront se greffer ici.</p>'
            : '') +
          (mine.length ? '<div class="gallery">' + mine.map(function (p, i) {
            var vid = isVideo(p);
            return '<figure class="shot' + (vid ? ' shot--vid' : '') + '" data-shot="' + i + '">' +
              (vid
                // #t= makes Safari paint a first frame instead of a black tile
                ? '<video src="' + esc(p.url) + '#t=0.1" muted playsinline preload="metadata"></video>' +
                  '<span class="shot__play" aria-hidden="true">▶</span>'
                : '<img src="' + esc(p.url) + '" alt="" loading="lazy">') +
              (GUEST ? '' : '<button class="shot__x" type="button" data-pdel="' + p.ts +
                '" aria-label="Supprimer cette ' + (vid ? 'vidéo' : 'photo') + '">✕</button>') +
              '</figure>'; }).join('') + '</div>' : '') +
          '<label class="btn up" style="margin-top:8px">Ajouter une photo ou une vidéo' +
            '<input type="file" id="photoIn" multiple accept="' + MEDIA_ACCEPT + '"></label>' +
        '</section>' +

        '<section class="sec"><h3>Documents<span class="sec__count" id="docCount"></span></h3>' +
          '<div class="drop" id="drop">' +
            '<span class="drop__arw" aria-hidden="true">⬆</span>' +
            '<p class="drop__lead">Glisse des fichiers ici</p>' +
            '<label class="btn up">Choisir un fichier' +
              '<input type="file" id="fileIn" multiple accept="' + FILE_ACCEPT + '"></label>' +
            '<p class="drop__hint">Plans, DPE, diagnostics\u2026 25 Mo par fichier</p>' +
          '</div>' +
          '<ul class="docs" id="docList">' + docsHTML(d) + '</ul>' +
        '</section>' +

        // folded by default: the form is long and most visits are not edits
        (GUEST ? '' :
        '<details class="sec sec--fold"><summary><h3>Compléter la fiche</h3></summary>' +
          editHTML(d) + '</details>' +
        '<section class="sec">' +
          (d.sold
            ? '<div class="hide-row">' +
              '<button class="btn" type="button" id="unsold">Plus vendu</button>' +
              '<span style="font-size:.6875rem;color:var(--ink-3)">ce bien est marqué vendu</span>' +
              '</div>'
            : '<div class="hide-row">' +
              '<button class="btn btn--warn" type="button" id="sold">Marquer comme vendu</button>' +
              '<span style="font-size:.6875rem;color:var(--ink-3)">il reste dans les listes, signalé</span>' +
              '</div>') +
          (d.hidden
            ? '<p class="hidden-note">Ce bien est masqué. Il n’apparaît dans aucune liste, ' +
              'pour toi comme pour ' + esc(USERS[OTHER]) + '.</p>' +
              '<div class="hide-row"><button class="btn" type="button" id="unhide">Réafficher ce bien</button></div>'
            : '<div class="hide-row">' +
              '<button class="btn btn--warn" type="button" id="hide">Masquer ce bien</button>' +
              '<span style="font-size:.6875rem;color:var(--ink-3)">le retire des listes pour vous deux</span>' +
              '</div>') +
        '</section>') +
      '</div></div>' +
      // sibling of the scroller, so it covers the whole panel however far down
      // you have scrolled
      '<div class="sheet__drop" id="sheetDrop" hidden>' +
        '<div class="sheet__drop__in">' +
          '<span class="sheet__drop__arw">⬇</span>' +
          '<b>Déposer ici</b>' +
          '<span>photos et vidéos d’un côté, le reste dans les documents</span>' +
        '</div>' +
      '</div>';

    sheet.classList.add('open');
    // On a phone the panel covers the map, so it carries its own. On a
    // desktop the real map is right there beside it; the slot stays empty.
    if (sheetMap) { sheetMap.remove(); sheetMap = null; }
    if (matchMedia('(max-width:860px)').matches) sheetMap = locator($('smap'), d);
    $('sx').addEventListener('click', function () { select(null, false); });
    var share = $('share');
    if (share) share.addEventListener('click', function () {
      copyText(share, share.dataset.link, 'Lien copié', 'Copier le lien', 'Lien à partager :');
    });
    var copyAddr = $('copyAddr');
    if (copyAddr) copyAddr.addEventListener('click', function () {
      copyText(copyAddr, d.address || d.town, 'Adresse copiée', 'Copier l’adresse', 'Adresse :');
    });
    wireGallery(d);
    wireSheet(d);
  }

  // Copy to the clipboard and say so on the button itself; where the
  // clipboard is unavailable (http, old WebView) fall back to a prompt the
  // text can be copied out of.
  function copyText(btn, text, said, label, ask) {
    var done = function () {
      btn.textContent = said;
      setTimeout(function () { btn.textContent = label; }, 1800);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { prompt(ask, text); });
    } else { prompt(ask, text); }
  }

  // A pin placed by hand or read off the listing is the truth; one geocoded
  // from the address is a guess, so there Maps gets the address instead.
  function mapsLink(d) {
    var q = (!approx(d) && d.lat != null) ? d.lat + ',' + d.lng : (d.address || d.town);
    return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q);
  }

  var TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12' +
    'M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';

  // a pin dropped in a reticle: "find this one on the map"
  var TARGET = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'stroke-linecap="round" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/>' +
    '<path d="M12 1.6v3.2M12 19.2v3.2M1.6 12h3.2M19.2 12h3.2"/></svg>';

  var STAR = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path d="M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3.1-5.8 3.1 1.1-6.5L2.6 9.4l6.5-.9z"/></svg>';

  // Every photo from the listing, swipeable; falls back to the single hero,
  // or to our own uploads when there is nothing else — see photoOf.
  function galleryHTML(d) {
    var own = !!(d.gallery && d.gallery.length);   // the Street View still is not ours to delete
    var shots = shotsOf(d);
    // A listing's gallery is half agency logos and watermarked floorplans. The
    // bin lives on the frame itself, at every width — it used to be reachable
    // only from the full-screen view, which you had to know was there.
    var del = own && !GUEST
      ? '<button class="gal__del" id="galDel" title="Supprimer cette photo" ' +
        'aria-label="Supprimer cette photo">' + TRASH + '</button>' : '';
    if (shots.length === 1) {
      return '<div class="gal gal--one" id="gal">' +
        '<img class="sheet__img" src="' + esc(shots[0]) + '" alt="" data-i="0"' +
          (own || standIns(d).length ? ' role="button" tabindex="0"' : '') +
          ' onerror="this.onerror=null;this.src=\'' + fallbackOf(d) + '\'">' + del + '</div>';
    }
    return '<div class="gal" id="gal">' +
      '<div class="gal__strip" id="galStrip">' +
        shots.map(function (u, i) {
          return '<img src="' + esc(u) + '" alt="" data-i="' + i + '" ' + (i ? 'loading="lazy" ' : '') +
                 'onerror="this.onerror=null;this.src=\'' + fallbackOf(d) + '\'">';
        }).join('') +
      '</div>' +
      '<button class="gal__nav gal__nav--prev" id="galPrev" aria-label="Photo précédente">‹</button>' +
      '<button class="gal__nav gal__nav--next" id="galNext" aria-label="Photo suivante">›</button>' +
      '<span class="gal__n" id="galN">1 / ' + shots.length + '</span>' + del +
    '</div>';
  }

  function wireGallery(d) {
    var gal = $('gal'); if (!gal) return;
    var strip = $('galStrip');
    function idx() { return strip ? Math.round(strip.scrollLeft / strip.clientWidth) : 0; }

    // tapping the photo opens it full screen, where it can also be deleted
    gal.addEventListener('click', function (e) {
      var img = e.target.closest('img'); if (!img) return;
      if ((d.gallery && d.gallery.length) || standIns(d).length) openLightbox(d, +img.dataset.i || 0);
    });

    var del = $('galDel');
    if (del) del.addEventListener('click', function (e) {
      e.stopPropagation();
      if (deletePhotoAt(d, idx())) { openSheet(d); render(); }
    });

    if (!strip) return;
    var n = strip.children.length;
    function show() { $('galN').textContent = Math.min(n, idx() + 1) + ' / ' + n; }
    strip.addEventListener('scroll', show, { passive:true });
    function go(step) {
      strip.scrollTo({ left: (idx() + step) * strip.clientWidth, behavior:'smooth' });
    }
    $('galPrev').addEventListener('click', function () { go(-1); });
    $('galNext').addEventListener('click', function () { go(1); });
  }

  function scoreRow(d, u, live) {
    var v = scoreOf(d.id, u);
    return '<div class="auto-row auto-row--user' + (live ? '' : ' readonly') +
           '" style="--who:var(--' + u + ')">' +
           '<b>' + USERS[u] + '</b>' +
           starsHTML(v, '', live) +
           '<span class="auto-row__val">' +
             (v == null ? '<i>à noter</i>' : num.format(v * 2) + '<i> / 10</i>') +
             (v != null && live ? '<button type="button" class="score-clear">effacer</button>' : '') +
           '</span></div>';
  }

  /* Every rating in the app — the two of ours, Emplacement, the deck's big
     stars, the computed marks — is this: five grey stars with a gold layer
     clipped to the value, so a half star costs no extra glyph. A live one
     adds five transparent buttons on top; which half of a button you hit
     decides the half star. */
  function autoStars(stars, cls, extra) {
    var five = STAR + STAR + STAR + STAR + STAR;
    return '<span class="autostars' + (cls ? ' ' + cls : '') +
      '" style="--fill:' + (stars / 5 * 100) + '%">' +
      '<span class="autostars__base">' + five + '</span>' +
      '<span class="autostars__on">' + five + '</span>' + (extra || '') + '</span>';
  }

  function starsHTML(v, cls, live) {
    if (!live) return autoStars(v || 0, cls);
    var hit = '';
    for (var i = 1; i <= 5; i++) {
      hit += '<button type="button" data-v="' + i + '" aria-label="' + i + ' sur 5"></button>';
    }
    return autoStars(v || 0, cls + ' autostars--live',
                     '<span class="autostars__hit">' + hit + '</span>');
  }

  /* `get` reads the current value, `set` writes it. The pointer's half of a
     star is the half mark; a keyboard press carries no x and so means the
     whole star. The fill follows the pointer, so you see the mark before you
     commit it, and the same value again clears it. */
  function wireStars(wrap, get, set) {
    var hit = wrap && wrap.querySelector('.autostars__hit');
    if (!hit) return;
    function valAt(b, x) {
      var r = b.getBoundingClientRect();
      return +b.dataset.v - (x > 0 && x - r.left < r.width / 2 ? 0.5 : 0);
    }
    function fill(v) { wrap.style.setProperty('--fill', (v || 0) / 5 * 100 + '%'); }
    hit.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      var v = valAt(b, e.clientX);
      set(get() === v ? null : v);
    });
    hit.addEventListener('mousemove', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      fill(valAt(b, e.clientX));
    });
    wrap.addEventListener('mouseleave', function () { fill(get()); });
  }
  function mark10(v) { return v == null ? '—' : num.format(Math.round(v * 10) / 10); }

  // Each block on its own line — the three things the data can judge, named.
  // A block with nothing to go on says so rather than drawing zero stars.
  var AUTO_BLOCKS = [
    ['surface', 'Surface', 'surface et terrain'],
    ['energy',  'Énergie', 'DPE et GES'],
    ['value',   'Valeur',  'prix au m²']
  ];

  function autoRow(d, live, before) {
    var a = autoScore(d) || {};
    return '<div class="auto-marks">' + (before || '') + spotRow(d, a, live) +
      AUTO_BLOCKS.map(function (b) {
      var v = a[b[0]];
      if (v == null) {
        return '<div class="auto-row auto-row--none"><b>' + b[1] + '</b>' +
               '<span class="auto-row__todo">' + b[2] + ' à renseigner</span></div>';
      }
      var stars = Math.round(v / 2 * 2) / 2;
      return '<div class="auto-row"><b>' + b[1] + '</b>' +
        '<span role="img" aria-label="' + num.format(stars) + ' sur 5">' + autoStars(stars) + '</span>' +
        '<span class="auto-row__val">' + mark10(v) + '<i> / 10</i></span>' +
        '</div>';
    }).join('') + totalRow(d) + '</div>';
  }

  // Everything above it, weighted and brought back to 10. The title carries
  // the raw sum, because /80 is the number the formula is written in.
  function totalRow(d) {
    var o = overall(d);
    if (!o) return '';
    return '<div class="auto-row auto-row--total" title="' +
      num.format(o.sum) + ' / ' + (o.weight * 10) +
      (o.parts < 6 ? ' — ' + (6 - o.parts) + ' marque(s) manquante(s)' : '') + '">' +
      '<b>Total</b>' +
      '<span role="img" aria-label="' + num.format(o.stars) + ' sur 5">' +
        autoStars(o.stars, 'autostars--total') + '</span>' +
      '<span class="auto-row__val">' + mark10(o.mark) + '<i> / 10</i></span>' +
      '</div>';
  }

  /* Emplacement — the only one of the four we judge ourselves, and the only
     mark in the app that is not per person: the spot is the spot, so either
     of us sets it and it stands for both. */
  function spotRow(d, a, live) {
    var v = d.spot == null ? null : d.spot;
    return '<div class="auto-row auto-row--spot' + (live ? '' : ' readonly') + '">' +
      '<b>Emplacement</b>' +
      starsHTML(v, '', live) +
      '<span class="auto-row__val">' +
        (v != null ? mark10(a.spot) + '<i> / 10</i>' : '<i>à noter</i>') +
      '</span></div>';
  }

  function setSpot(d, v) {
    d.spot = v;
    write('PUT', '/property/' + encodeURIComponent(d.id), { spot: v });
  }

  /* The spot row behaves like a score row — hover lights the run of stars, the
     same star again clears it — but it writes one shared field. `paint` lets
     the deck repaint in place instead of rebuilding its slide. */
  function wireSpot(root, d, paint) {
    var row = root.querySelector('.auto-row--spot:not(.readonly)');
    if (!row) return;
    wireStars(row.querySelector('.autostars'),
      function () { return d.spot; },
      function (v) { setSpot(d, v); paint(); });
  }

  // Same palette as the API's allowlist — anything else is refused there.
  var REACTIONS = ['👍', '❤️', '😂', '😮', '🤔', '👎'];

  // Runs on text already escaped, so a URL can't smuggle in markup; trailing
  // punctuation stays outside the link, as people write "voir https://….".
  function linkify(html) {
    return html.replace(/\b(?:https?:\/\/|www\.)[^\s<]+/gi, function (url) {
      var tail = (url.match(/[.,;:!?)\]]+$/) || [''])[0];
      url = url.slice(0, url.length - tail.length);
      var href = /^www\./i.test(url) ? 'https://' + url : url;
      return '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + url + '</a>' + tail;
    });
  }

  function noteHTML(n) {
    return '<div class="note" data-ts="' + n.ts + '" style="--who:var(--' + esc(n.user) + ')">' +
      '<header><b>' + esc(USERS[n.user] || n.user) + '</b>' +
        '<time>' + esc(when.format(new Date(n.ts))) + '</time></header>' +
      linkify(esc(n.text)).replace(/\n/g, '<br>') +
      reactHTML(n) +
      '</div>';
  }

  // The chips that exist, then a button that opens the full palette. Tapping
  // a chip toggles your own reaction on it, as in any chat app.
  function reactHTML(n) {
    var r = n.reactions || {};
    var chips = REACTIONS.filter(function (e) { return r[e] && r[e].length; }).map(function (e) {
      var who = r[e], mine = who.indexOf(ME) >= 0;
      return '<button type="button" class="react' + (mine ? ' react--mine' : '') + '" data-react="' + e + '"' +
        ' aria-pressed="' + mine + '" title="' + esc(who.map(function (u) { return USERS[u] || u; }).join(', ')) + '">' +
        e + (who.length > 1 ? '<span>' + who.length + '</span>' : '') + '</button>';
    }).join('');
    return '<div class="note__foot">' + chips +
      '<button type="button" class="react react--add" data-pick aria-label="Réagir" aria-expanded="false">' +
        '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">' +
          '<circle cx="9" cy="10" r="6.5"/><path d="M6.5 11.8c1.3 1.3 3.7 1.3 5 0"/><path d="M7 8h.01M11 8h.01"/>' +
          '<path d="M16.5 2v4M14.5 4h4"/></svg></button>' +
      '<span class="react-pick" hidden>' + REACTIONS.map(function (e) {
        return '<button type="button" data-react="' + e + '">' + e + '</button>';
      }).join('') + '</span>' +
      (n.user === ME && !GUEST ? '<button type="button" class="note__del" data-del="' + n.ts + '">supprimer</button>' : '') +
      '</div>';
  }

  // Repaints only the one note, so reacting doesn't reflow the sheet or lose
  // its scroll. The listener sits on the list, which openSheet rebuilds.
  function wireReactions(list, d) {
    if (!list) return;
    list.addEventListener('click', function (e) {
      var pick = e.target.closest('[data-pick]');
      var btn = e.target.closest('[data-react]');
      var el = e.target.closest('.note');
      if (!el || (!pick && !btn)) return;
      if (pick) {
        var pal = el.querySelector('.react-pick');
        pal.hidden = !pal.hidden;
        pick.setAttribute('aria-expanded', String(!pal.hidden));
        return;
      }
      var ts = +el.dataset.ts, emoji = btn.dataset.react;
      var n = (D.notes[d.id] || []).filter(function (x) { return x.ts === ts; })[0];
      if (!n) return;
      var r = n.reactions = Object.assign({}, n.reactions);
      var who = (r[emoji] || []).filter(function (u) { return u !== ME; });
      var on = who.length === (r[emoji] || []).length;
      if (on) who.push(ME);
      if (who.length) r[emoji] = who; else delete r[emoji];
      var foot = el.querySelector('.note__foot');
      foot.outerHTML = reactHTML(n);
      write('PUT', '/note/' + encodeURIComponent(d.id) + '/' + ts + '/react', { emoji: emoji, on: on });
    });
  }

  // Half the properties have no live listing to read a rating off, so both
  // letters have to be fillable by hand.
  function letterSelect(name, label, val) {
    return '<div><label for="e_' + name + '">' + label + '</label>' +
      '<select id="e_' + name + '" name="' + name + '">' +
        '<option value="">—</option>' +
        ['A','B','C','D','E','F','G'].map(function (L) {
          return '<option value="' + L + '"' + (val === L ? ' selected' : '') + '>' + L + '</option>';
        }).join('') +
      '</select></div>';
  }

  function editHTML(d) {
    function f(name, label, val, type) {
      return '<div><label for="e_' + name + '">' + label + '</label>' +
        '<input id="e_' + name + '" name="' + name + '" type="' + (type||'text') + '" value="' +
        esc(val == null ? '' : val) + '"></div>';
    }
    return '<form class="edit" id="editForm">' +
      '<div><label for="e_address">Adresse</label><input id="e_address" name="address" value="' + esc(d.address||'') + '"></div>' +
      '<div class="edit__grid">' +
        f('price','Prix (€)', d.price, 'number') +
        f('surface','Surface (m²)', d.surface, 'number') +
        f('rooms','Pièces', d.rooms, 'number') +
        f('terrain','Terrain (m²)', d.terrain, 'number') +
        '<div><label for="e_town">Commune</label><input id="e_town" name="town" value="' + esc(d.town||'') + '"></div>' +
        '<div><label for="e_kind">Type</label><select id="e_kind" name="kind">' +
          '<option value="property"' + (d.kind !== 'land' ? ' selected' : '') + '>Maison / appartement</option>' +
          '<option value="land"' + (d.kind === 'land' ? ' selected' : '') + '>Terrain</option>' +
        '</select></div>' +
        letterSelect('dpe', 'DPE', d.dpe) +
        letterSelect('ges', 'GES', d.ges) +
      '</div>' +
      '<div><label for="e_url">Lien de l’annonce</label>' +
        '<input id="e_url" name="url" value="' + esc(d.url||'') + '">' +
        (d.listing === 'gone'
          ? '<span style="display:block;margin-top:4px;font-size:.6875rem;color:var(--ink-3)">' +
            'Annonce retirée. Colle le lien de la nouvelle mise en vente pour la réactiver.</span>'
          : '') +
      '</div>' +
      '<div><label for="e_links">Autres annonces du même bien <span style="font-weight:400">— une par ligne</span></label>' +
        '<textarea id="e_links" name="links" rows="2" placeholder="https://…">' + esc((d.links || []).join('\n')) + '</textarea>' +
      '</div>' +
      '<div class="edit__actions"><button class="btn btn--go" type="submit">Enregistrer</button>' +
      '<span id="editMsg" style="font-size:.6875rem;color:var(--ink-3);align-self:center"></span></div>' +
      '</form>';
  }

  function wireSheet(d) {
    // scores — only the signed-in user's row is interactive
    function setScore(v) {
      D.scores[d.id] = D.scores[d.id] || {};
      if (v == null) delete D.scores[d.id][ME]; else D.scores[d.id][ME] = v;
      write('PUT', '/score/' + encodeURIComponent(d.id), { value: v });
      redrawMarker(d);
      openSheet(d);        // repaint the row (and the clear link appearing/going)
      render();
    }
    wireStars($('sheet').querySelector('.auto-row--user:not(.readonly) .autostars'),
      function () { return scoreOf(d.id, ME); }, setScore);
    var clear = $('sheet').querySelector('.auto-row--user:not(.readonly) .score-clear');
    if (clear) clear.addEventListener('click', function () { setScore(null); });

    // the shared Emplacement mark
    wireSpot($('sheet'), d, function () { openSheet(d); render(); });

    // notes
    $('noteForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var t = $('noteText').value.trim();
      if (!t) return;
      var n = { ts: Date.now(), user: ME, text: t };
      D.notes[d.id] = (D.notes[d.id] || []).concat([n]);
      $('noteText').value = '';
      write('POST', '/note/' + encodeURIComponent(d.id), { text: t });
      openSheet(d); render();
    });
    wireReactions($('noteList'), d);
    var all = $('sheet').querySelector('.nearby__all');
    if (all) all.addEventListener('click', function () {
      var open = all.getAttribute('aria-expanded') !== 'true';
      Array.prototype.forEach.call($('sheet').querySelectorAll('.nearby__more'), function (li) { li.hidden = !open; });
      all.setAttribute('aria-expanded', String(open));
      all.textContent = open ? 'n’afficher que le plus proche de chaque type' : 'voir les ' + all.dataset.more + ' autres';
    });
    Array.prototype.forEach.call($('sheet').querySelectorAll('[data-del]'), function (b) {
      b.addEventListener('click', function () {
        var ts = +b.dataset.del;
        D.notes[d.id] = (D.notes[d.id] || []).filter(function (n) { return n.ts !== ts; });
        write('DELETE', '/note/' + encodeURIComponent(d.id) + '/' + ts);
        openSheet(d); render();
      });
    });

    // contribute missing facts
    $('editForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var fd = new FormData(this), patch = {};
      ['address','town','kind','url'].forEach(function (k) {
        var v = (fd.get(k) || '').toString().trim();
        if (v !== (d[k] == null ? '' : String(d[k]))) patch[k] = v;
      });
      ['price','surface','rooms','terrain'].forEach(function (k) {
        var raw = (fd.get(k) || '').toString().trim().replace(/\s/g, '').replace(',', '.');
        var v = raw === '' ? null : Math.round(Number(raw));
        if (raw !== '' && !isFinite(v)) return;
        if (v !== (d[k] == null ? null : d[k])) patch[k] = v;
      });
      // the energy letters: empty means "clear it", which the API takes as null
      ['dpe','ges'].forEach(function (k) {
        var v = (fd.get(k) || '').toString().trim().toUpperCase() || null;
        if (v !== (d[k] || null)) patch[k] = v;
      });
      var links = parseLinks(fd.get('links'), patch.url != null ? patch.url : d.url);
      if (links.join('\n') !== (d.links || []).join('\n')) patch.links = links.length ? links : null;
      if (patch.url && patch.url !== d.url && d.listing === 'gone') {
        patch.listing = 'live';
      }
      var newName = maybeRename(d, patch.address || d.address);
      if (newName) patch.name = newName;
      if (!Object.keys(patch).length) { $('editMsg').textContent = 'Rien à enregistrer.'; return; }
      Object.assign(d, patch);
      d.editedBy = ME; d.editedAt = Date.now();
      write('PUT', '/property/' + encodeURIComponent(d.id), patch);
      $('editMsg').textContent = 'Enregistré.';
      init2();
    });

    function setHidden(v) {
      d.hidden = v;
      write('PUT', '/property/' + encodeURIComponent(d.id), { hidden: v });
      buildTowns();
      init2();          // bands, budget range and averages all shift
      if (v) { select(null, false); }        // it just left the list you're looking at
      else { openSheet(d); }
      render();
    }
    // Sold does not leave the lists, so nothing to re-select and no bands to
    // shift — just the flag, the panel and the pin.
    function setSold(v) {
      d.sold = v;
      write('PUT', '/property/' + encodeURIComponent(d.id), { sold: v });
      openSheet(d);
      redrawMarker(d);
      render();
    }
    var repos = $('repos');
    if (repos) repos.addEventListener('click', function () { armReposition(d); });

    var hideBtn = $('hide'), unhideBtn = $('unhide');
    if (hideBtn) hideBtn.addEventListener('click', function () { setHidden(true); });
    if (unhideBtn) unhideBtn.addEventListener('click', function () { setHidden(false); });

    var soldBtn = $('sold'), unsoldBtn = $('unsold');
    if (soldBtn) soldBtn.addEventListener('click', function () { setSold(true); });
    if (unsoldBtn) unsoldBtn.addEventListener('click', function () { setSold(false); });

    // the Photos grid: tap to view full screen, ✕ to remove
    Array.prototype.forEach.call($('sheet').querySelectorAll('.gallery [data-shot]'), function (fig) {
      fig.addEventListener('click', function () { openLightbox(d, +fig.dataset.shot, 'uploads'); });
    });
    Array.prototype.forEach.call($('sheet').querySelectorAll('.gallery [data-pdel]'), function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        var ts = +b.dataset.pdel;
        var p = uploads(d).find(function (x) { return x.ts === ts; });
        if (!confirm('Supprimer cette ' + (p && isVideo(p) ? 'vidéo' : 'photo') + ' ?\n\n' +
                     'Elle disparaîtra pour toi et pour ' + USERS[OTHER] + '.')) return;
        removeUpload(d, ts);
        openSheet(d);
      });
    });

    // photo upload — same queue as the documents below, which routes by type
    $('photoIn').addEventListener('change', function () {
      takeFiles(d, this.files);
      this.value = '';
    });

    // documents: a button and a drop zone, both feeding takeFiles
    var fileIn = $('fileIn'), drop = $('drop');
    if (fileIn) fileIn.addEventListener('change', function () {
      takeFiles(d, this.files);
      this.value = '';   // so the same file can be picked twice running
    });
    wireDocRows(d);
  }

  function hasFiles(e) {
    var t = e.dataTransfer && e.dataTransfer.types;
    return !!t && Array.prototype.indexOf.call(t, 'Files') !== -1;
  }

  // a field edit can change price bands and facets, so rebuild what depends on them
  function init2() {
    recompute();
    D.properties.forEach(redrawMarker);
    buildKey(); render();
  }

  /* ───────────────────────── adding a property ─────────────────────────
     Two ways in, one form:
       · the + button arms the map, and the next click drops the pin;
       · the bookmarklet opens the app with #add=<json> scraped from a
         listing page, which we geocode from the address.
     Either way the pin stays draggable until you save, because a geocoded
     address is a guess and the map is the place to correct it. */
  var placing = false, newMarker = null, draft = null, repositioning = null;

  function armPlacement(label) {
    placing = true;
    document.body.classList.add('placing');
    $('hintTxt').textContent = label || 'Clique sur la carte à l’emplacement du bien';
    $('hint').hidden = false;
    collapseForDetail();
  }

  // Repositioning an existing property: click the map, the pin moves and saves.
  function armReposition(d) {
    repositioning = d;
    armPlacement('Clique sur la carte à la bonne position de « ' + d.name + ' »');
    map.setView([d.lat, d.lng], Math.max(map.getZoom(), 17));
  }

  function applyReposition(lat, lng) {
    var d = repositioning;
    repositioning = null;
    disarm();
    d.lat = lat; d.lng = lng; d.geo = 'manual';
    write('PUT', '/property/' + encodeURIComponent(d.id), { lat: lat, lng: lng, geo: 'manual' });
    var m = markers[d.id];
    if (m) m.setLatLng([lat, lng]);
    redrawMarker(d);
    map.flyTo([lat, lng], Math.max(map.getZoom(), 17), { duration:.5 });
    openSheet(d);
    var note = $('sheet').querySelector('.sheet__approx');
    if (note) note.insertAdjacentHTML('beforeend', ' <b>Position enregistrée.</b>');
  }
  function disarm() {
    placing = false;
    document.body.classList.remove('placing');
    $('hint').hidden = true;
    setTimeout(function () { map.invalidateSize(); }, 360);
  }
  function clearDraft() {
    disarm();
    if (newMarker) { map.removeLayer(newMarker); newMarker = null; }
    draft = null;
    $('sheet').classList.remove('open');
  }

  function dropPin(lat, lng) {
    if (newMarker) map.removeLayer(newMarker);
    newMarker = L.marker([lat, lng], {
      draggable: true,
      icon: L.divIcon({ className:'', iconSize:[15,15], iconAnchor:[7,14], html:'<div class="pin-new"></div>' })
    }).addTo(map);
    newMarker.on('dragend', function () {
      var p = newMarker.getLatLng();
      draft.lat = p.lat; draft.lng = p.lng;
      var el = $('a_coords');
      if (el) el.textContent = p.lat.toFixed(5) + ', ' + p.lng.toFixed(5);
      fillFromPoint(p.lat, p.lng);
    });
  }

  function openAdd(seed) {
    draft = Object.assign({ kind:'property' }, seed || {});
    disarm();

    if (draft.lat != null && draft.lng != null) {
      dropPin(draft.lat, draft.lng);
      map.flyTo([draft.lat, draft.lng], Math.max(map.getZoom(), 16), { duration:.6 });
    }

    function fld(name, label, val, type) {
      return '<div><label for="a_' + name + '">' + label + '</label>' +
        '<input id="a_' + name + '" name="' + name + '" type="' + (type || 'text') +
        '" value="' + esc(val == null ? '' : val) + '"></div>';
    }

    $('sheet').innerHTML =
      '<button class="sheet__close" id="ax" aria-label="Fermer">✕</button>' +
      '<div class="sheet__scroll"><div class="sheet__body">' +
        '<div class="sheet__kind">Nouveau bien</div>' +
        '<h2 class="sheet__name">Ajouter</h2>' +
        lookalikesHTML(draft) +
        '<form class="edit" id="addForm" style="margin-top:12px">' +
          '<div><label for="a_name">Nom / adresse affichée *</label>' +
            '<input id="a_name" name="name" required value="' + esc(draft.name || '') + '"></div>' +
          '<div><label for="a_address">Adresse complète</label>' +
            '<input id="a_address" name="address" value="' + esc(draft.address || '') + '"></div>' +
          '<div class="edit__grid">' +
            '<div><label for="a_town">Commune</label>' +
              '<input id="a_town" name="town" value="' + esc(draft.town || '') + '"></div>' +
            '<div><label for="a_kind">Type</label><select id="a_kind" name="kind">' +
              '<option value="property"' + (draft.kind !== 'land' ? ' selected' : '') + '>Maison / appartement</option>' +
              '<option value="land"' + (draft.kind === 'land' ? ' selected' : '') + '>Terrain</option>' +
            '</select></div>' +
            fld('price', 'Prix (€)', draft.price, 'number') +
            fld('surface', 'Surface (m²)', draft.surface, 'number') +
            fld('rooms', 'Pièces', draft.rooms, 'number') +
            fld('terrain', 'Terrain (m²)', draft.terrain, 'number') +
          '</div>' +
          '<div><label for="a_url">Lien de l’annonce</label>' +
            '<input id="a_url" name="url" value="' + esc(draft.url || '') + '"></div>' +
          // A re-listed property has a new URL, so it can never match by link.
          // Let the scrape be attached to whichever property you say it is.
          '<div><label for="a_existing">Ou compléter un bien déjà dans la liste</label>' +
            '<select id="a_existing"><option value="">— créer un nouveau bien —</option>' +
            // closest asking price first when the advert has one, so the
            // same house under another agency sits at the top
            D.properties.slice().sort(function (a, b) {
              if (draft.price) {
                var da = a.price ? Math.abs(a.price - draft.price) : Infinity;
                var db = b.price ? Math.abs(b.price - draft.price) : Infinity;
                if (da !== db) return da - db;
              }
              return (a.name || '').localeCompare(b.name || '', 'fr');
            }).map(function (x) {
              return '<option value="' + esc(x.id) + '">' + esc(x.name) +
                     (x.price != null ? ' · ' + esc(fmtShort(x.price)) + '€' : '') +
                     (x.town ? ' · ' + esc(x.town) : '') +
                     (x.hidden ? ' (masqué)' : '') + '</option>';
            }).join('') + '</select></div>' +
          '<div><label for="a_photo">Photo (URL)</label>' +
            '<input id="a_photo" name="photo" value="' + esc(draft.photo || '') + '"></div>' +
          (draft.gallery && draft.gallery.length
            ? '<p style="font-size:.6875rem;color:var(--ink-3);margin:0">' +
              draft.gallery.length + ' photos récupérées depuis l’annonce.</p>' : '') +
          '<div style="font-size:.6875rem;color:var(--ink-3)">' +
            'Position : <span id="a_coords">' +
            (draft.lat != null ? draft.lat.toFixed(5) + ', ' + draft.lng.toFixed(5) : 'à placer') +
            '</span> · <button type="button" class="btn" id="a_place" style="padding:3px 7px">placer sur la carte</button>' +
            (draft.lat == null ? ' <button type="button" class="btn" id="a_geo" style="padding:3px 7px">trouver depuis l’adresse</button>' : '') +
          '</div>' +
          '<div class="edit__actions">' +
            '<button class="btn btn--go" type="submit">Ajouter</button>' +
            '<button class="btn" type="button" id="a_cancel">Annuler</button>' +
            '<span id="a_msg" style="font-size:.6875rem;color:var(--ink-3);align-self:center"></span>' +
          '</div>' +
        '</form>' +
        '<p class="addlink">Depuis une annonce SeLoger ou Leboncoin, utilise le ' +
          '<a href="bookmarklet.html" target="_blank" rel="noopener">bouton « Ajouter à Property Map »</a>.</p>' +
      '</div></div>';

    $('sheet').classList.add('open');
    $('ax').addEventListener('click', clearDraft);
    $('a_cancel').addEventListener('click', clearDraft);
    $('a_place').addEventListener('click', function () {
      armPlacement();
      // give the map a moment to become visible, then centre it on the draft
      setTimeout(function () {
        map.invalidateSize();
        if (draft && draft.lat != null) map.setView([draft.lat, draft.lng], Math.max(map.getZoom(), 16));
      }, 360);
    });

    Array.prototype.forEach.call($('sheet').querySelectorAll('[data-same]'), function (b) {
      b.addEventListener('click', function () { attachTo(b.dataset.same); });
    });

    var pick = $('a_existing');
    if (pick) pick.addEventListener('change', function () {
      var btn = $('addForm').querySelector('button[type=submit]');
      var chosen = this.options[this.selectedIndex];
      btn.textContent = this.value ? 'Compléter ce bien' : 'Ajouter';
      $('a_msg').textContent = this.value
        ? 'Les infos et photos iront dans « ' + chosen.textContent.split(' · ')[0] +' ».'
        : '';
    });

    var geo = $('a_geo');
    if (geo) geo.addEventListener('click', function () {
      var q = geocodeQuery($('a_name').value, $('a_address').value);
      if (!q) { $('a_msg').textContent = 'Renseigne une adresse d’abord.'; return; }
      $('a_msg').textContent = 'Recherche…';
      geocode(q).then(function (pt) {
        if (!pt) { $('a_msg').textContent = 'Adresse introuvable — place le point à la main.'; return; }
        draft.lat = pt[0]; draft.lng = pt[1];
        $('a_coords').textContent = pt[0].toFixed(5) + ', ' + pt[1].toFixed(5);
        $('a_msg').textContent = 'Point placé — déplace-le si besoin.';
        dropPin(pt[0], pt[1]);
        map.flyTo(pt, 16, { duration:.6 });
      });
    });

    $('addForm').addEventListener('submit', function (e) {
      e.preventDefault();
      if ($('a_existing') && $('a_existing').value) { attachTo($('a_existing').value); return; }
      if (draft.lat == null || draft.lng == null) {
        $('a_msg').textContent = 'Place le point sur la carte avant d’enregistrer.';
        return;
      }
      var fd = new FormData(this), body = { lat: draft.lat, lng: draft.lng, geo: 'manual' };
      ['name','address','town','kind','url','photo'].forEach(function (k) {
        var v = (fd.get(k) || '').toString().trim();
        if (v) body[k] = v;
      });
      ['price','surface','rooms','terrain'].forEach(function (k) {
        var raw = (fd.get(k) || '').toString().trim();
        if (raw !== '' && isFinite(Number(raw))) body[k] = Number(raw);
      });
      var into = $('a_existing') ? $('a_existing').value : '';
      if (into) { attachTo(into); return; }
      if (!body.name) { $('a_msg').textContent = 'Le nom est obligatoire.'; return; }
      // the energy letters ride along from the scrape like the photos do
      ['dpe','ges'].forEach(function (k) {
        if (/^[A-G]$/.test(draft[k] || '')) body[k] = draft[k];
      });
      // photos come from the scrape, not the form, so carry them across
      if (draft.gallery && draft.gallery.length) {
        body.gallery = draft.gallery.slice(0, 60);
        if (!body.photo) body.photo = body.gallery[0];
      }
      if (!body.town && body.address) {
        var m = body.address.match(/\b\d{5}\s+(.+)$/);
        if (m) body.town = m[1].trim();
      }
      saveNew(body);
    });
  }

  /* Déjà dans la liste ? The same house sold by a second agency arrives with
     a link we have never seen, so it cannot match by URL. It still has the
     same town, price, surface and land, give or take an agent's rounding:
     score every bien on those and offer the few that come close. */
  function lookalikes(seed) {
    function near(a, b, steps) {
      if (a == null || b == null || !a || !b) return 0;
      var r = Math.abs(a - b) / Math.max(a, b);
      for (var i = 0; i < steps.length; i++) if (r <= steps[i][0]) return steps[i][1];
      return 0;
    }
    var town = String(seed.town || '').toLowerCase().trim();
    return D.properties.map(function (d) {
      var s = 0;
      if (town && String(d.town || '').toLowerCase().trim() === town) s += 2;
      s += near(seed.price, d.price, [[0.02, 4], [0.06, 2.5], [0.12, 1]]);
      s += near(seed.surface, d.surface, [[0.02, 3], [0.06, 2], [0.12, 0.5]]);
      s += near(seed.terrain, d.terrain, [[0.03, 2], [0.12, 1]]);
      if (seed.rooms && d.rooms === seed.rooms) s += 1;
      if (seed.lat != null && d.lat != null) {
        var m = metresBetween({ lat: seed.lat, lng: seed.lng }, d);
        s += m < 300 ? 3 : m < 1000 ? 1 : 0;
      }
      return { d: d, s: s };
    }).filter(function (x) { return x.s >= 5; })
      .sort(function (a, b) { return b.s - a.s; })
      .slice(0, 3).map(function (x) { return x.d; });
  }

  function lookalikesHTML(seed) {
    if (!seed || (!seed.price && !seed.surface)) return '';
    var list = lookalikes(seed);
    if (!list.length) return '';
    return '<div class="same">' +
      '<div class="same__hd">Déjà dans la liste ?</div>' +
      '<p class="same__sub">Ces biens y ressemblent. Si c’en est un, l’annonce y sera rattachée — pas de doublon.</p>' +
      list.map(function (d) {
        return '<button type="button" class="same__row" data-same="' + esc(d.id) + '">' +
          '<img src="' + esc(photoOf(d)) + '" alt="" onerror="this.onerror=null;this.src=\'' + fallbackOf(d) + '\'">' +
          '<span class="same__txt"><b>' + esc(d.name) + '</b><span>' +
            [d.price != null ? fmtPrice(d.price) : null, d.surface ? d.surface + ' m²' : null,
             d.terrain ? d.terrain + ' m² terrain' : null, d.town || null]
              .filter(Boolean).map(esc).join(' · ') +
            (d.sold ? ' · vendu' : '') + (d.hidden ? ' · écarté' : '') +
          '</span></span>' +
          '<span class="same__go">C’est lui</span>' +
        '</button>';
      }).join('') +
    '</div>';
  }

  // Fold the scraped data into an existing property. Empty fields get filled;
  // a dead advert's link is replaced by the live one it was re-listed under.
  function attachTo(id) {
    var d = D.properties.find(function (x) { return x.id === id; });
    if (!d) { $('a_msg').textContent = 'Bien introuvable.'; return; }

    var patch = {}, notes = [];
    ['price','surface','rooms','terrain','dpe','ges','address','town','kind','photo','gallery'].forEach(function (k) {
      var v = draft[k];
      if (v == null || v === '' || (Array.isArray(v) && !v.length)) return;
      var cur = d[k], empty = cur == null || cur === '' || (Array.isArray(cur) && !cur.length);
      if (k === 'gallery' && (!d.gallery || !d.gallery.length)) { patch.gallery = v; notes.push(v.length + ' photos'); return; }
      if (empty) { patch[k] = v; notes.push(k); }
    });
    var rename = maybeRename(d, patch.address || draft.address || d.address);
    if (rename) { patch.name = rename; notes.push('nom'); }
    // a re-listing supersedes a dead link
    if (draft.url && (!d.url || d.listing === 'gone')) {
      patch.url = draft.url; patch.listing = 'live'; notes.push('nouveau lien');
    } else if (draft.url && !sameListing(draft.url, d.url) &&
               !(d.links || []).some(function (u) { return sameListing(u, draft.url); })) {
      // the same house through another agency: keep its advert alongside
      patch.links = (d.links || []).concat([draft.url]).slice(0, 10);
      notes.push('autre annonce');
    }
    if (!notes.length) { $('a_msg').textContent = 'Rien de nouveau à ajouter à ce bien.'; return; }

    $('a_msg').textContent = 'Mise à jour…';
    Object.assign(d, patch);
    write('PUT', '/property/' + encodeURIComponent(d.id), patch);
    clearDraft();
    init2();
    select(d.id, true);
  }

  // 'geo' is not in the API allowlist, so strip it before sending and keep it
  // locally — it only drives the dashed "approximate" outline.
  function saveNew(body) {
    var geoFlag = body.geo; delete body.geo;
    $('a_msg').textContent = 'Enregistrement…';

    function land(id) {
      var d = Object.assign({ id: id, geo: geoFlag }, body);
      D.properties.push(d);
      markers[d.id] = makeMarker(d);
      clearDraft();
      init2();
      select(d.id, true);
    }

    if (LOCAL) { land('loc' + Date.now()); saveLocal(); return; }

    api('POST', '/property', body)
      .then(function (r) { land(r.id); })
      .catch(function (err) {
        $('a_msg').textContent = err.code === 400
          ? ('Refusé : ' + err.message)
          : 'Échec — réessaie quand la connexion revient.';
      });
  }

  // Listings often expose only "33000 Bordeaux" as the address, which geocodes to
  // the town hall, kilometres from the actual house. The street usually sits in
  // the title, so fold it in when the address carries no street of its own.
  var STREET_RE = /\d+\s*\w|rue|avenue|chemin|impasse|all[\u00e9e]e|boulevard|route|place|passage|pass\./i;

  function hasStreet(address) {
    return STREET_RE.test(String(address || '').replace(/^\d{5}\s*/, ''));
  }

  // "43°35'57.9\"N 1°29'59.8\"E" and "Dropped pin" are placeholders from the
  // Google Maps import, not names anyone chose. Once a real street turns up,
  // it should take over — but never overwrite a name someone actually wrote.
  var DMS_NAME = /^\s*\d{1,3}[°º]\s*\d{1,2}['\u2032]/;

  function isPlaceholderName(n) {
    n = (n || '').trim();
    return !n || DMS_NAME.test(n) || /^dropped pin/i.test(n) || /^nouveau bien$/i.test(n);
  }

  // the street part of "12 Rue du Vivier, 33000 Bordeaux"
  function streetOf(address) {
    var a = (address || '').trim();
    if (!a) return '';
    var head = a.split(',')[0].trim();
    if (/^\d{5}\b/.test(head)) return '';          // just a postcode line
    return hasStreet(head) ? head : '';
  }

  function maybeRename(d, address) {
    if (!isPlaceholderName(d.name)) return null;
    var street = streetOf(address);
    return street && street !== d.name ? street : null;
  }

  function geocodeQuery(name, address) {
    name = (name || '').trim();
    address = (address || '').trim();
    if (address && hasStreet(address)) return address;
    if (name && address) return name + ', ' + address;
    return name || address;
  }

  // Dropping a pin is the most precise statement of where a property is, so
  // let it name itself: ask OSM what is at that point and fill the address in.
  function reverseGeocode(lat, lng) {
    return fetch('https://nominatim.openstreetmap.org/reverse?' + new URLSearchParams({
      lat: lat, lon: lng, format: 'json', zoom: '18', addressdetails: '1'
    })).then(function (r) { return r.json(); }).then(function (j) {
      var a = (j && j.address) || {};
      var street = [a.house_number, a.road].filter(Boolean).join(' ');
      var town = a.village || a.town || a.municipality || a.city || '';
      var post = a.postcode || '';
      if (!street && !town) return null;
      return {
        address: [street, [post, town].filter(Boolean).join(' ')].filter(Boolean).join(', '),
        town: town
      };
    }).catch(function () { return null; });
  }

  function fillFromPoint(lat, lng) {
    var addrEl = $('a_address'), townEl = $('a_town'), msg = $('a_msg');
    if (!addrEl) return;
    if (msg) msg.textContent = 'Recherche de l\u2019adresse\u2026';
    reverseGeocode(lat, lng).then(function (r) {
      if (!r) { if (msg) msg.textContent = 'Point plac\u00e9 \u2014 adresse introuvable, \u00e0 saisir.'; return; }
      // only replace an address that has no street of its own
      if (!hasStreet(addrEl.value)) addrEl.value = r.address;
      if (townEl && !townEl.value.trim()) townEl.value = r.town;
      var nameEl = $('a_name');
      if (r.address && isPlaceholderName(nameEl.value)) {
        var st = streetOf(r.address);
        if (st) nameEl.value = st;
      }
      if (msg) msg.textContent = 'Point plac\u00e9 \u2014 adresse renseign\u00e9e.';
    });
  }

  function geocode(q) {
    return fetch('https://nominatim.openstreetmap.org/search?' +
      new URLSearchParams({ q:q, format:'json', limit:'1', countrycodes:'fr' }))
      .then(function (r) { return r.json(); })
      .then(function (j) { return j && j[0] ? [ +j[0].lat, +j[0].lon ] : null; })
      .catch(function () { return null; });
  }

  function wireAdd() {
    $('add').addEventListener('click', function () { openAdd({}); armPlacement(); });
    $('hintCancel').addEventListener('click', function () {
      var was = repositioning;
      repositioning = null; placingPoi = false;
      disarm();
      if (was) openSheet(was);
    });
    map.on('click', function (e) {
      if (!placing) return;
      if (placingPoi) {
        placingPoi = false;
        disarm();
        openPoiDialog({ lat: e.latlng.lat, lng: e.latlng.lng, icon: 'school' }, false);
        return;
      }
      if (repositioning) { applyReposition(e.latlng.lat, e.latlng.lng); return; }
      disarm();
      if (!draft) { openAdd({ lat:e.latlng.lat, lng:e.latlng.lng }); return; }
      draft.lat = e.latlng.lat; draft.lng = e.latlng.lng;
      dropPin(draft.lat, draft.lng);
      var el = $('a_coords');
      if (el) el.textContent = draft.lat.toFixed(5) + ', ' + draft.lng.toFixed(5);
      fillFromPoint(draft.lat, draft.lng);
    });
  }

  /* The bookmarklet lands here: #add=<url-encoded json> from a listing page. */
  var ready = false, suppressHash = false;
  addEventListener('hashchange', function () {
    if (!ready || suppressHash) { suppressHash = false; return; }
    consumeHash();
  });

  var BOOKMARKLET_VERSION = 6;

  function staleBookmarklet(seed) {
    return !seed.v || seed.v < BOOKMARKLET_VERSION;
  }

  function linkFor(id) {
    return location.origin + location.pathname + '#bien/' + encodeURIComponent(id);
  }

  // Keep the address bar in step with the open panel, but replace rather than
  // push: Back should leave the app, not walk back through forty panels.
  function syncHash(id) {
    var want = id ? '#bien/' + encodeURIComponent(id) : '';
    if ((location.hash || '') === want) return;
    suppressHash = true;
    history.replaceState(null, '', want || (location.pathname + location.search));
  }

  // A shared link has to open even if the recipient's filters would hide it.
  function openShared(id) {
    var d = D.properties.find(function (x) { return x.id === id; });
    if (!d) return false;
    if (d.hidden && state.view !== 'hidden') {
      state.view = 'hidden'; $('view').value = 'hidden'; render();
    } else if (visible().indexOf(d) === -1) {
      resetFilters();
    }
    select(id, true);
    return true;
  }

  function sameListing(a, b) {
    if (!a || !b) return false;
    var norm = function (u) {
      return String(u).replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
    };
    return norm(a) === norm(b);
  }

  function consumeHash() {
    var h = location.hash || '';
    if (h.indexOf('#bien/') === 0) { openShared(decodeURIComponent(h.slice(6))); return; }
    if (h.indexOf('#add=') !== 0) return;
    var seed = {};
    try { seed = JSON.parse(decodeURIComponent(h.slice(5))); } catch (e) { return; }
    history.replaceState(null, '', location.pathname);

    // Same listing as one we already have? Offer to enrich it — that is how a
    // hand-added property gets its photos, since the sites 403 any server fetch.
    if (staleBookmarklet(seed)) {
      alert('Le bouton « Ajouter à Property Map » de ton navigateur est une ancienne version — ' +
            'il risque d’importer des doublons de photos.\n\n' +
            'Réinstalle-le depuis ' + location.host + '/bookmarklet.html (fais reglisser le bouton), ' +
            'puis réessaie.');
    }
    var known = seed.url && D.properties.find(function (d) {
      return sameListing(d.url, seed.url) || (d.links || []).some(function (u) { return sameListing(u, seed.url); });
    });
    if (known) { mergeInto(known, seed); return; }

    openAdd(seed);
    if (seed.lat == null && (seed.address || seed.name)) {
      var g = $('a_geo'); if (g) g.click();
    }
  }

  function mergeInto(d, seed) {
    var fields = ['price','surface','rooms','terrain','dpe','ges','address','town','kind','photo','gallery'];
    var patch = {}, added = [];
    fields.forEach(function (k) {
      var v = seed[k];
      if (v == null || v === '' || (Array.isArray(v) && !v.length)) return;
      var cur = d[k];
      var empty = cur == null || cur === '' || (Array.isArray(cur) && !cur.length);
      if (!empty) return;                       // never overwrite what you already decided
      patch[k] = v;
      added.push(k === 'gallery' ? v.length + ' photos' : k);
    });

    var ren = maybeRename(d, patch.address || seed.address || d.address);
    if (ren) { patch.name = ren; added.push('nom'); }
    select(d.id, true);
    setTimeout(function () {
      var msg = $('mergeMsg');
      if (!added.length) {
        if (msg) msg.textContent = 'Cette annonce est déjà complète ici.';
        return;
      }
      if (!confirm('Compléter « ' + d.name +' » avec : ' + added.join(', ') + ' ?')) return;
      Object.assign(d, patch);
      write('PUT', '/property/' + encodeURIComponent(d.id), patch);
      init2();
      select(d.id, false);
      openSheet(d);
    }, 500);
  }

  /* ═══════════════ Browse ═══════════════
     One property per screen, swipe or arrow between them. The whole point of
     the view is to get a score out of you, so the stars are the only bright
     thing on it and sit within thumb reach. It browses whatever the filters
     currently show, so "Ma liste" turns it into a review of your shortlist. */
  var deckRows = [], deckAt = 0, deckMaps = {}, deckShot = {};

  function openDeck(startId) {
    deckRows = visible();
    if (!deckRows.length) return;
    deckAt = 0;
    if (startId) {
      var i = deckRows.findIndex(function (d) { return d.id === startId; });
      if (i >= 0) deckAt = i;
    }
    $('deck').hidden = false;
    document.body.style.overflow = 'hidden';
    renderDeck();
  }

  function closeDeck() {
    $('deck').hidden = true;
    document.body.style.overflow = '';
    Object.keys(deckMaps).forEach(function (k) { deckMaps[k].remove(); delete deckMaps[k]; });
    var st = $('deckStage');
    Array.prototype.forEach.call(st.querySelectorAll('.slide__gal'), function (g) {
      if (g._io) g._io.disconnect();
    });
    st.innerHTML = '';
    render();
  }

  // Only three slides exist at a time: the one you are on and its neighbours.
  // Fifty full-bleed photo slides would cost a great deal for no benefit.
  function renderDeck() {
    var stage = $('deckStage');
    stage.classList.remove('glide');
    stage.innerHTML = '';
    deckMaps = {};

    var from = Math.max(0, deckAt - 1), to = Math.min(deckRows.length - 1, deckAt + 1);
    for (var i = from; i <= to; i++) stage.appendChild(slideFor(deckRows[i], i));
    stage.style.transform = 'translateX(' + (-(deckAt - from) * 100) + '%)';
    stage.dataset.from = from;

    wireSlide(deckRows[deckAt]);
    preload(deckAt + 1); preload(deckAt - 1);
  }

  function preload(i) {
    var d = deckRows[i]; if (!d) return;
    var im = new Image(); im.src = photoOf(d, true);
  }

  function shotsOf(d) {
    var out = (d.gallery && d.gallery.length) ? d.gallery.slice() : standIns(d);
    return out.length ? out : [photoOf(d, true)];
  }

  // What we uploaded ourselves, newest last, for the Photos grid and its viewer.
  function uploads(d) {
    return (D.photos[d.id] || []).filter(function (p) { return p && p.url; });
  }

  function slideFor(d, idx) {
    var el = document.createElement('article');
    el.className = 'slide';
    el.dataset.id = d.id;
    var pics = shotsOf(d), n = pics.length, at = deckShot[d.id] || 0;
    if (at >= n) at = deckShot[d.id] = 0;
    var m2 = ppm(d), other = scoreOf(d.id, OTHER);
    var notes = (D.notes[d.id] || []).slice().sort(function (a, b) { return b.ts - a.ts; });

    el.innerHTML =
      '<div class="slide__inner">' +
        '<div class="slide__shot">' +
          (n > 1 ? '<div class="slide__segs">' +
            pics.map(function (_, i) { return '<i class="' + (i === at ? 'on' : '') + '"></i>'; }).join('') +
            '</div>' : '') +
          '<div class="slide__gal">' +
            pics.map(function (u, i) {
              return '<figure style="background-image:url(&quot;' + esc(u) + '&quot;)">' +
                '<img src="' + esc(u) + '" alt="" data-i="' + i + '"' +
                (i > 1 ? ' loading="lazy"' : '') +
                ' onerror="this.onerror=null;this.src=\'' + fallbackOf(d) + '\'">' +
              '</figure>';
            }).join('') +
          '</div>' +
          '<div class="slide__grad"></div>' +
          (n > 1 ? '<span class="slide__count">' + (at + 1) + ' / ' + n + '</span>' +
            '<button class="slide__arw slide__arw--p" data-step="-1" aria-label="Photo précédente">‹</button>' +
            '<button class="slide__arw slide__arw--n" data-step="1" aria-label="Photo suivante">›</button>' : '') +
          (n > 1 ? '<div class="slide__thumbs">' +
            pics.map(function (u, i) {
              return '<button type="button" data-go="' + i + '" class="' + (i === at ? 'on' : '') + '"' +
                ' aria-label="Photo ' + (i + 1) + '"><img src="' + esc(u) + '" alt=""' +
                ' onerror="this.onerror=null;this.src=\'' + fallbackOf(d) + '\'"></button>';
            }).join('') + '</div>' : '') +
        '</div>' +

        '<div class="slide__body">' +
          (d.type || d.kind ? '<div class="slide__kind">' +
            esc(d.type || (d.kind === 'land' ? 'Terrain' : 'Bien')) +
            ' · ' + (idx + 1) + ' / ' + deckRows.length + '</div>' : '') +
          '<h2 class="slide__name">' + esc(d.name) + '</h2>' +
          '<div class="slide__where">' + esc(d.town || d.address || '') + '</div>' +
          (d.price != null
            ? '<div class="slide__price">' + esc(fmtPrice(d.price)) + '</div>'
            : '<div class="slide__price slide__price--none">prix à renseigner</div>') +
          (m2 ? '<div class="slide__ppm">' + num.format(m2) + ' €/m²</div>' : '') +

          '<dl class="slide__stats">' +
            '<div><dt>Surface</dt><dd>' + (d.surface ? num.format(d.surface) + ' m²' : '—') + '</dd></div>' +
            '<div><dt>Pièces</dt><dd>' + (d.rooms || '—') + '</dd></div>' +
            '<div><dt>Terrain</dt><dd>' + (d.terrain ? num.format(d.terrain) + ' m²' : '—') + '</dd></div>' +
          '</dl>' +

          '<div class="slide__rate">' +
            (GUEST ? '' :
              '<h3>Ta note</h3>' +
              '<div class="bigstars" id="bigstars">' +
                starsHTML(scoreOf(d.id, ME), 'autostars--big', true) +
              '</div>' +
              '<p class="slide__mine" id="mineMsg">' + mineMsg(scoreOf(d.id, ME)) + '</p>') +
            (GUEST ? RATERS : [OTHER]).map(function (u) {
              var v = scoreOf(d.id, u);
              return v != null
                ? '<p class="slide__theirs">' + esc(USERS[u]) + ' :' +
                  '<span class="pips">' + [1,2,3,4,5].map(function (i) {
                    return '<i class="' + (i <= v ? 'f' : (i - 0.5 === v ? 'h' : '')) + '"></i>';
                  }).join('') + '</span>' + num.format(v) + '/5</p>'
                : '<p class="slide__theirs">' + esc(USERS[u]) + ' n’a pas encore noté</p>';
            }).join('') +
            autoRow(d, !GUEST) +
          '</div>' +

          '<div class="slide__map" id="dmap-' + esc(d.id) + '"></div>' +
          '<p class="slide__meta">' +
            esc(d.address || d.town || '') +
            (d.chambres ? ' · ' + d.chambres + ' chambres' : '') +
            (d.url ? ' · <a href="' + esc(d.url) + '" target="_blank" rel="noopener">' +
              (d.listing === 'gone' ? 'annonce retirée' : 'voir l’annonce') + '</a>' : '') +
          '</p>' +

          notes.slice(0, 3).map(function (nt) {
            return '<div class="slide__note" style="--who:var(--' + esc(nt.user) + ')">' +
              '<b>' + esc(USERS[nt.user] || nt.user) + '</b>' + esc(nt.text) + '</div>';
          }).join('') +

          '<div class="slide__acts">' +
            '<button type="button" data-act="open">Ouvrir la fiche</button>' +
            '<button type="button" data-act="hide">' + (d.hidden ? 'Réafficher' : 'Masquer') + '</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    return el;
  }

  // The locator is a second Leaflet instance. Pan and pinch work so you can
  // check what is around the house; the repères are drawn as context. The
  // wheel and keyboard stay off, because the deck already uses both to move
  // between slides and the mouse wheel is how you scroll the slide itself.
  function miniMap(d) {
    var host = document.getElementById('dmap-' + d.id);
    if (!host || deckMaps[d.id]) return;
    deckMaps[d.id] = locator(host, d);
  }

  function mineMsg(v) {
    return v == null ? '' : 'Noté ' + num.format(v) + '/5 · touche pour changer';
  }

  function wireSlide(d) {
    miniMap(d);
    var slide = $('deckStage').querySelector('.slide[data-id="' + d.id + '"]');
    if (!slide) return;

    var big = slide.querySelector('.bigstars .autostars');
    wireStars(big, function () { return scoreOf(d.id, ME); }, function (v) {
      D.scores[d.id] = D.scores[d.id] || {};
      if (v == null) delete D.scores[d.id][ME]; else D.scores[d.id][ME] = v;
      write('PUT', '/score/' + encodeURIComponent(d.id), { value: v });
      big.style.setProperty('--fill', (v || 0) / 5 * 100 + '%');
      var msg = slide.querySelector('#mineMsg');
      if (msg) msg.textContent = mineMsg(v);
      redrawMarker(d);
      // scoring is the job here, so move on once it is done
      if (v != null) setTimeout(function () { step(1); }, 420);
    });

    wireSpot(slide, d, function () {
      var row = slide.querySelector('.auto-row--spot');
      row.querySelector('.autostars').style.setProperty('--fill', (d.spot || 0) / 5 * 100 + '%');
      row.querySelector('.auto-row__val').innerHTML =
        d.spot != null ? mark10(d.spot * 2) + '<i> / 10</i>' : '<i>à noter</i>';
      render();
    });

    var gal = slide.querySelector('.slide__gal'), pics = shotsOf(d), n = pics.length;
    if (gal) {
      // restore whichever photo you were on for this property
      var start = deckShot[d.id] || 0;
      if (start) requestAnimationFrame(function () { gal.scrollLeft = start * gal.clientWidth; });

      var segs = slide.querySelectorAll('.slide__segs i');
      var counter = slide.querySelector('.slide__count');
      // Track by intersection rather than scroll events: it reports the photo
      // that is actually in view regardless of how it got there — finger,
      // trackpad, arrow key or a programmatic jump.
      var thumbs = slide.querySelectorAll('.slide__thumbs button');
      trackStrip(gal, function (i) {
        deckShot[d.id] = i;
        Array.prototype.forEach.call(segs, function (x, k) { x.classList.toggle('on', k === i); });
        Array.prototype.forEach.call(thumbs, function (x, k) { x.classList.toggle('on', k === i); });
        if (counter) counter.textContent = (i + 1) + ' / ' + n;
        var active = thumbs[i];
        if (active && active.scrollIntoView) {
          active.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
        }
      });

      Array.prototype.forEach.call(thumbs, function (b) {
        b.addEventListener('click', function () {
          var i = +b.dataset.go;
          gal.scrollTo({ left: i * gal.clientWidth, behavior: 'smooth' });
          setTimeout(function () { if (gal._sync) gal._sync(); }, 380);
        });
      });

      // a tap opens the photo; a drag scrolls it — tell them apart by distance
      var px = 0, py = 0;
      gal.addEventListener('pointerdown', function (e) { px = e.clientX; py = e.clientY; });
      gal.addEventListener('click', function (e) {
        var img = e.target.closest('img'); if (!img) return;
        if (Math.abs(e.clientX - px) > 8 || Math.abs(e.clientY - py) > 8) return;
        openLightbox(d, +img.dataset.i || 0);
      });

      Array.prototype.forEach.call(slide.querySelectorAll('[data-step]'), function (b) {
        b.addEventListener('click', function () {
          var i = Math.min(n - 1, Math.max(0, (deckShot[d.id] || 0) + (+b.dataset.step)));
          gal.scrollTo({ left: i * gal.clientWidth, behavior: 'smooth' });
          setTimeout(function () { if (gal._sync) gal._sync(); }, 380);
        });
      });
    }

    Array.prototype.forEach.call(slide.querySelectorAll('[data-act]'), function (b) {
      b.addEventListener('click', function () {
        if (b.dataset.act === 'open') { closeDeck(); select(d.id, true); return; }
        d.hidden = !d.hidden;
        write('PUT', '/property/' + encodeURIComponent(d.id), { hidden: d.hidden });
        b.textContent = d.hidden ? 'Réafficher' : 'Masquer';
        buildTowns(); init2();
        if (d.hidden) step(1);
      });
    });
  }

  /* ─── full-screen photo ───
     Same snapping strip, so the gesture is identical to the one in the card;
     only the fit changes, from cover to contain, because here you want the
     whole frame rather than a crop. */
  // Report which child of a snapping strip is centred. Returns a disconnect fn.
  function trackStrip(strip, onChange) {
    var last = -1;

    function sync() {
      if (!strip.clientWidth) return;
      var i = Math.round(strip.scrollLeft / strip.clientWidth);
      if (i === last || i < 0 || i >= strip.children.length) return;
      last = i;
      onChange(i);
    }
    strip._sync = sync;

    // whichever of these the browser gives us, the position stays honest
    strip.addEventListener('scroll', sync, { passive: true });
    strip.addEventListener('scrollend', sync);
    strip.addEventListener('pointerup', function () { setTimeout(sync, 60); });
    strip.addEventListener('touchend', function () { setTimeout(sync, 60); });

    if (!('IntersectionObserver' in window)) return function () {};
    var io = new IntersectionObserver(function (entries) {
      var best = null;
      entries.forEach(function (e) {
        if (!best || e.intersectionRatio > best.intersectionRatio) best = e;
      });
      if (!best || best.intersectionRatio < 0.5) return;
      var i = Array.prototype.indexOf.call(strip.children, best.target);
      if (i < 0 || i === last) return;
      last = i;
      onChange(i);
    }, { root: strip, threshold: [0.5, 0.75, 1] });
    Array.prototype.forEach.call(strip.children, function (c) { io.observe(c); });
    strip._io = io;
    return function () { io.disconnect(); };
  }

  // 'listing' shows the imported gallery, 'uploads' what we added ourselves.
  // Same viewer, same gesture; only the source and what delete means differ.
  var lbFor = null, lbAt = 0, lbMode = 'listing';

  function openLightbox(d, at, mode) {
    lbMode = mode || 'listing';
    var pics = lbMode === 'uploads'
      ? uploads(d)
      : shotsOf(d).map(function (u) { return { url: u }; });
    if (!pics.length) return;
    var strip = $('lbStrip');
    lbFor = d; lbAt = at;
    strip.innerHTML = pics.map(function (p) {
      if (isVideo(p)) return '<video src="' + esc(p.url) + '" controls playsinline preload="metadata"></video>';
      return '<img src="' + esc(p.url) + '" alt="" onerror="this.onerror=null;this.src=\'' + fallbackOf(d) + '\'">';
    }).join('');
    $('lbCaption').textContent = d.name;
    $('lbCount').textContent = (at + 1) + ' / ' + pics.length;
    $('lightbox').hidden = false;
    requestAnimationFrame(function () { strip.scrollLeft = at * strip.clientWidth; });

    if (strip._io) strip._io.disconnect();
    // An uploaded photo is always ours to remove. A listing one only when the
    // gallery actually holds something — the Street View fallback is not ours.
    $('lbDel').hidden = GUEST || (lbMode === 'uploads' ? false : !(d.gallery && d.gallery.length));

    trackStrip(strip, function (i) {
      lbAt = i;
      // a walk-through keeps talking after you have swiped past it otherwise
      Array.prototype.forEach.call(strip.querySelectorAll('video'), function (v) {
        if (v !== strip.children[i]) v.pause();
      });
      $('lbCount').textContent = (i + 1) + ' / ' + pics.length;
      // the card deck follows the listing gallery, not our own photos
      if (lbMode === 'listing') deckShot[d.id] = i;
    });
  }

  // Remove one photo we uploaded: the row, the S3 object, and it goes for both
  // of you — the same trade-off documents and notes already make.
  function removeUpload(d, ts) {
    D.photos[d.id] = (D.photos[d.id] || []).filter(function (p) { return p.ts !== ts; });
    if (LOCAL) saveLocal();
    else write('DELETE', '/photo/' + encodeURIComponent(d.id) + '/' + ts);
    // it may have been standing in for the missing listing photo
    redrawMarker(d); render();
  }

  function deleteUpload() {
    var d = lbFor;
    if (!d) return;
    var list = uploads(d), idx = Math.min(lbAt, list.length - 1), p = list[idx];
    if (!p) return;
    if (!confirm('Supprimer cette ' + (isVideo(p) ? 'vidéo' : 'photo') + ' ?\n\n' +
                 'Elle disparaîtra pour toi et pour ' + USERS[OTHER] + '.')) return;

    removeUpload(d, p.ts);
    var left = uploads(d);
    closeLightbox();
    openSheet(d);
    if (left.length) openLightbox(d, Math.min(idx, left.length - 1), 'uploads');
  }

  // Remove one photo from a property's gallery. Shared, like everything else
  // here: it goes for both of you. The file itself stays in S3, so a mistake
  // is recoverable until the orphan sweep runs.
  function deletePhoto() {
    var d = lbFor;
    if (!deletePhotoAt(d, lbAt)) return;
    if (!d.gallery.length) { closeLightbox(); return; }
    openLightbox(d, Math.min(lbAt, d.gallery.length - 1));
  }

  // Drop one of the listing's own photos. Returns false if there was nothing
  // to drop or the confirmation was declined.
  function deletePhotoAt(d, at) {
    if (!d || !d.gallery || !d.gallery.length) return false;
    var i = Math.min(at, d.gallery.length - 1), total = d.gallery.length;

    if (!confirm('Supprimer la photo ' + (i + 1) + ' sur ' + total + ' de « ' + d.name + ' » ?\n\n' +
                 'Elle disparaîtra pour toi et pour ' + USERS[OTHER] + '.')) return false;

    var next = d.gallery.slice();
    next.splice(i, 1);
    d.gallery = next;

    var patch = { gallery: next };
    // the hero follows the gallery, and an empty gallery falls back to
    // the Street View still rather than leaving a dead reference
    patch.photo = next.length ? next[0] : (d.street || null);
    d.photo = patch.photo;
    write('PUT', '/property/' + encodeURIComponent(d.id), patch);

    redrawMarker(d);
    render();
    return true;
  }

  function closeLightbox() {
    $('lightbox').hidden = true;
    $('lbStrip').innerHTML = '';
    lbFor = null;
    // keep the card in step with whatever photo you left on
    var d = deckRows[deckAt];
    if (d) {
      var gal = $('deckStage').querySelector('.slide[data-id="' + d.id + '"] .slide__gal');
      if (gal) gal.scrollLeft = (deckShot[d.id] || 0) * gal.clientWidth;
    }
  }

  function step(dir) {
    var next = deckAt + dir;
    if (next < 0 || next >= deckRows.length) return;
    var stage = $('deckStage'), from = +stage.dataset.from;
    stage.classList.add('glide');
    stage.style.transform = 'translateX(' + (-((next - from)) * 100) + '%)';
    deckAt = next;
    setTimeout(renderDeck, 330);
  }

  function deckControls() {
    $('browse').addEventListener('click', function () { openDeck(activeId); });
    $('deckX').addEventListener('click', closeDeck);
    $('lbX').addEventListener('click', closeLightbox);
    $('lbDel').addEventListener('click', function () {
      if (lbMode === 'uploads') deleteUpload(); else deletePhoto();
    });
    $('lbStrip').addEventListener('click', function (e) {
      if (e.target.tagName === 'IMG') closeLightbox();
    });
    $('deckPrev').addEventListener('click', function () { step(-1); });
    $('deckNext').addEventListener('click', function () { step(1); });

    addEventListener('keydown', function (e) {
      if (!$('lightbox').hidden) {
        var strip = $('lbStrip');
        if (e.key === 'Escape') { closeLightbox(); e.preventDefault(); }
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          strip.scrollBy({ left: (e.key === 'ArrowRight' ? 1 : -1) * strip.clientWidth, behavior:'smooth' });
          setTimeout(function () { if (strip._sync) strip._sync(); }, 380);
          e.preventDefault();
        }
        return;
      }
      if ($('deck').hidden) return;
      if (e.key === 'Escape') { closeDeck(); e.preventDefault(); }
      if (e.key === 'ArrowRight') { step(1); e.preventDefault(); }
      if (e.key === 'ArrowLeft') { step(-1); e.preventDefault(); }
      if (/^[1-5]$/.test(e.key)) {
        var b = $('deckStage').querySelector('.slide[data-id="' + deckRows[deckAt].id + '"] .bigstars button[data-v="' + e.key + '"]');
        if (b) b.click();
      }
    });

    // horizontal drag moves between properties; vertical is left to scrolling
    var stage = $('deckStage'), x0 = 0, y0 = 0, dragging = false, locked = null;
    stage.addEventListener('pointerdown', function (e) {
      // a horizontal drag on the photograph belongs to the photograph, and
      // one on the locator pans the map
      if (e.target.closest('.slide__gal, .slide__thumbs, .slide__map, button, a')) return;
      dragging = true; locked = null; x0 = e.clientX; y0 = e.clientY;
      stage.classList.remove('glide');
    });
    addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - x0, dy = e.clientY - y0;
      if (!locked) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        locked = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      }
      if (locked !== 'x') return;
      var from = +stage.dataset.from;
      stage.style.transform = 'translateX(calc(' + (-((deckAt - from)) * 100) + '% + ' + dx + 'px))';
      e.preventDefault();
    }, { passive:false });
    function release(e) {
      if (!dragging) return;
      dragging = false;
      if (locked !== 'x') return;
      var dx = e.clientX - x0, from = +stage.dataset.from;
      stage.classList.add('glide');
      if (Math.abs(dx) > 70) { step(dx < 0 ? 1 : -1); }
      else { stage.style.transform = 'translateX(' + (-((deckAt - from)) * 100) + '%)'; }
    }
    addEventListener('pointerup', release);
    addEventListener('pointercancel', release);
  }

  /* ─────────────── points of interest ───────────────
     The things that decide whether a street works: the school run, the
     bakery, the office. They sit on the map as a quieter layer than the
     properties, because they are context rather than candidates. */
  var POI_ICONS = [
    ['school',  '🏫', 'École'],
    ['shop',    '🛒', 'Commerces'],
    ['bakery',  '🥖', 'Boulangerie'],
    ['train',   '🚉', 'Gare'],
    ['bus',     '🚌', 'Bus'],
    ['park',    '🌳', 'Parc'],
    ['work',    '💼', 'Travail'],
    ['health',  '🏥', 'Santé'],
    ['sport',   '⚽', 'Sport'],
    ['food',    '🍽️', 'Restaurant'],
    ['family',  '👪', 'Famille'],
    ['star',    '⭐', 'Autre']
  ];
  var poiMarkers = {}, poiDraft = null, placingPoi = false;

  function iconGlyph(key) {
    var f = POI_ICONS.find(function (x) { return x[0] === key; });
    return f ? f[1] : '⭐';
  }

  // Straight-line metres between two points — good to a few metres at this
  // scale, and honest about being a crow's distance, not a road one.
  function metresBetween(a, b) {
    var R = 6371000, rad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function fmtDist(m) {
    if (m < 1000) return (Math.round(m / 10) * 10) + ' m';
    return (m < 10000 ? (m / 1000).toFixed(1).replace('.', ',') : Math.round(m / 1000)) + ' km';
  }

  // Repères group by the first word of their name — "Ecole …", "College …",
  // "Access …" — because that is how they get named, and the icons are not
  // reliable enough to group on. Accents and case don't split a group.
  function poiKind(p) {
    return String(p.name || '').trim().split(/\s+/)[0]
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  }

  // The nearest repère of each kind, nearest first; the rest fold away. The
  // road distance is what matters for a school run, so each row hands off
  // to Google Maps for the real route.
  function nearbyHTML(d) {
    var pois = (D.pois || []).filter(function (p) { return p.lat != null && p.lng != null; });
    if (!pois.length) {
      return GUEST ? '' : '<section class="sec"><h3>À proximité</h3>' +
        '<p class="hidden-note">Place des repères sur la carte (◎ — école, travail, commerces…) ' +
        'pour voir leur distance à chaque bien.</p></section>';
    }
    var rows = pois.map(function (p) { return { p: p, m: metresBetween(d, p) }; })
                   .sort(function (a, b) { return a.m - b.m; });
    var seen = {}, more = 0;
    rows.forEach(function (r) {
      var k = poiKind(r.p);
      r.extra = !!seen[k]; seen[k] = true;
      if (r.extra) more++;
    });
    var about = approx(d) ? '≈ ' : '';
    return '<section class="sec"><h3>À proximité <span class="nearby__how">· à vol d’oiseau</span></h3>' +
      '<ul class="nearby">' + rows.map(function (r) {
        var route = 'https://www.google.com/maps/dir/?api=1&origin=' + d.lat + ',' + d.lng +
                    '&destination=' + r.p.lat + ',' + r.p.lng;
        return '<li' + (r.extra ? ' class="nearby__more" hidden' : '') + '>' +
          '<span class="nearby__ic" aria-hidden="true">' + iconGlyph(r.p.icon) + '</span>' +
          '<span class="nearby__name">' + esc(r.p.name) + '</span>' +
          '<b class="nearby__d">' + about + fmtDist(r.m) + '</b>' +
          '<a class="nearby__go" href="' + esc(route) + '" target="_blank" rel="noopener" ' +
            'title="Itinéraire dans Google Maps">trajet ↗</a></li>';
      }).join('') + '</ul>' +
      (more ? '<button type="button" class="linkbtn nearby__all" data-more="' + more + '">' +
        'voir les ' + more + ' autres</button>' : '') +
      '</section>';
  }

  function poiHTML(p) {
    return '<div class="anchor"><span class="poi">' +
      '<b>' + iconGlyph(p.icon) + '</b><span>' + esc(p.name) + '</span>' +
    '</span></div>';
  }

  // A small live map centred on one property, with the repères for context.
  // Used by the deck and, on a phone, by the detail panel — both places
  // where the main map is covered. Wheel and keyboard stay off: the wheel
  // scrolls the page around it and the deck owns the arrow keys.
  function locator(host, d) {
    var mm = L.map(host, {
      zoomControl:true, attributionControl:false, scrollWheelZoom:false,
      keyboard:false, boxZoom:false
    }).setView([d.lat, d.lng], 14);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:19 }).addTo(mm);
    (D.pois || []).forEach(function (p) {
      L.marker([p.lat, p.lng], {
        icon: L.divIcon({ className:'', iconSize:[0,0], iconAnchor:[0,0], html: poiHTML(p) }),
        keyboard:false, title: p.name, interactive:false
      }).addTo(mm);
    });
    L.marker([d.lat, d.lng], {
      icon: L.divIcon({ className:'', iconSize:[0,0], iconAnchor:[0,0],
        html:'<div class="anchor"><span class="' + chipClass(d) + '">' +
             (d.price == null ? '?' : esc(fmtShort(d.price))) + rankHTML(d.id) + '</span></div>' }),
      zIndexOffset: 1000
    }).addTo(mm);
    setTimeout(function () { mm.invalidateSize(); }, 60);
    return mm;
  }

  function drawPois() {
    (D.pois || []).forEach(function (p) {
      if (poiMarkers[p.id]) { map.removeLayer(poiMarkers[p.id]); delete poiMarkers[p.id]; }
      var m = L.marker([p.lat, p.lng], {
        icon: L.divIcon({ className:'', iconSize:[0,0], iconAnchor:[0,0], html: poiHTML(p) }),
        keyboard:false, title: p.name
      });
      m.on('click', function (e) {
        L.DomEvent.stopPropagation(e);
        if (!GUEST) editPoi(p);
      });
      m.addTo(map);
      poiMarkers[p.id] = m;
    });
  }

  function armPoi() {
    placingPoi = true;
    // armPlacement owns the `placing` flag the map click handler gates on —
    // setting the class alone left the handler returning on its first line.
    armPlacement('Clique sur la carte pour placer le repère');
  }

  function openPoiDialog(draft, existing) {
    poiDraft = draft;
    $('poiTitle').textContent = existing ? 'Modifier le repère' : 'Nouveau repère';
    $('poiName').value = draft.name || '';
    $('poiIcons').innerHTML = POI_ICONS.map(function (ic) {
      return '<button type="button" data-icon="' + ic[0] + '" title="' + esc(ic[2]) + '" ' +
             'aria-pressed="' + (draft.icon === ic[0] ? 'true' : 'false') + '">' + ic[1] + '</button>';
    }).join('');
    $('poiDelete').hidden = !existing;
    $('poidlg').hidden = false;
    setTimeout(function () { $('poiName').focus(); }, 30);
  }

  function editPoi(p) {
    openPoiDialog({ id: p.id, name: p.name, icon: p.icon, lat: p.lat, lng: p.lng }, true);
  }

  function closePoiDialog() {
    $('poidlg').hidden = true;
    poiDraft = null;
  }

  function poiControls() {
    $('addPoi').addEventListener('click', function () { armPoi(); });

    $('poiIcons').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      poiDraft.icon = b.dataset.icon;
      Array.prototype.forEach.call(this.querySelectorAll('button'), function (x) {
        x.setAttribute('aria-pressed', String(x === b));
      });
    });

    $('poiCancel').addEventListener('click', closePoiDialog);

    $('poiForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var name = $('poiName').value.trim();
      if (!name) { $('poiName').focus(); return; }
      var body = { name: name, icon: poiDraft.icon || 'star', lat: poiDraft.lat, lng: poiDraft.lng };

      if (poiDraft.id) {
        var p = (D.pois || []).find(function (x) { return x.id === poiDraft.id; });
        if (p) Object.assign(p, body);
        write('PUT', '/poi/' + encodeURIComponent(poiDraft.id), { name: body.name, icon: body.icon });
        closePoiDialog(); drawPois();
        return;
      }

      D.pois = D.pois || [];
      if (LOCAL) {
        D.pois.push(Object.assign({ id: 'poi' + Date.now() }, body));
        saveLocal(); closePoiDialog(); drawPois();
        return;
      }
      api('POST', '/poi', body).then(function (r) {
        D.pois.push(Object.assign({ id: r.id }, body));
        closePoiDialog(); drawPois();
      }).catch(function () {
        alert('Enregistrement impossible. Réessaie quand la connexion revient.');
      });
    });

    $('poiDelete').addEventListener('click', function () {
      var p = poiDraft;
      if (!p || !p.id) return;
      if (!confirm('Supprimer le repère « ' + p.name + ' » ?')) return;
      D.pois = (D.pois || []).filter(function (x) { return x.id !== p.id; });
      if (poiMarkers[p.id]) { map.removeLayer(poiMarkers[p.id]); delete poiMarkers[p.id]; }
      write('DELETE', '/poi/' + encodeURIComponent(p.id));
      closePoiDialog();
    });

    addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('poidlg').hidden) { closePoiDialog(); e.preventDefault(); }
    });
  }

  /* ───────────────────────── phone drawer ─────────────────────────
     Four stops, measured in pixels off the drawer's own height so the
     bottom one leaves exactly the grab handle showing. Anything less and
     the drawer permanently eats a third of a small screen. */
  var HANDLE = 46, sheetPx = null, sheetStop = 'peek';

  function isPhone() { return matchMedia('(max-width:860px)').matches; }

  function stops() {
    var h = $('rail').offsetHeight || innerHeight * 0.88;
    return { full:0, half:Math.round(h * 0.45), peek:Math.round(h * 0.72), closed:Math.max(0, h - HANDLE) };
  }

  function snap(stop) {
    var rail = $('rail');
    if (!isPhone()) { rail.style.transform = ''; return; }
    var s = stops();
    if (typeof stop === 'string') { sheetStop = stop; sheetPx = s[stop]; }
    else {
      sheetPx = stop;
      // land on whichever stop is nearest
      sheetStop = Object.keys(s).reduce(function (a, b) {
        return Math.abs(s[b] - stop) < Math.abs(s[a] - stop) ? b : a;
      });
      sheetPx = s[sheetStop];
    }
    rail.style.transform = 'translateY(' + sheetPx + 'px)';
  }

  // opening a property should get the drawer out of the way entirely
  function collapseForDetail() { if (isPhone()) snap('closed'); }

  function sheetDrag() {
    var grip = $('grip'), rail = $('rail');
    var startY = 0, startPx = 0, dragging = false, moved = false;

    snap('peek');

    grip.addEventListener('pointerdown', function (e) {
      if (!isPhone()) return;
      dragging = true; moved = false;
      startY = e.clientY;
      startPx = sheetPx != null ? sheetPx : stops().peek;
      rail.classList.add('dragging');
      try { grip.setPointerCapture(e.pointerId); } catch (err) {}
    });

    addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dy = e.clientY - startY;
      if (Math.abs(dy) > 8) moved = true;   // tap slop: fingers are not styluses
      var s = stops();
      var v = Math.max(0, Math.min(s.closed, startPx + dy));
      sheetPx = v;
      rail.style.transform = 'translateY(' + v + 'px)';
      e.preventDefault();
    }, { passive:false });

    function release() {
      if (!dragging) return;
      dragging = false;
      rail.classList.remove('dragging');
      snap(sheetPx);
    }
    addEventListener('pointerup', release);
    addEventListener('pointercancel', release);

    // a tap (not a drag) cycles: closed -> half -> full -> closed.
    // `moved` is read-and-cleared so a stray drag can never latch taps off.
    grip.addEventListener('click', function () {
      var wasDrag = moved; moved = false;
      if (!isPhone() || wasDrag) return;
      snap(sheetStop === 'closed' ? 'half' : (sheetStop === 'half' ? 'full' : 'closed'));
    });

    addEventListener('resize', function () {
      if (!isPhone()) { rail.style.transform = ''; return; }
      snap(sheetStop);
    });
  }

  /* ───────────────────────── service worker ───────────────────────── */
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').then(function (r) { swReg = r; }).catch(function () {});
    });
  }

  addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && activeId && !cal.el) select(null, false);
  });
})();
