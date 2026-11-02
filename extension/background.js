/* The listing sites cannot read Property Map themselves: the API sits behind a
   session cookie on the app's domain. This worker has host permission there,
   so its fetch carries the cookie you already have from logging in to the app,
   and the content script only ever asks "is this page one of ours?". */

// Your deployment's address. Also in manifest.json and content.js.
var APP = 'https://your-app.example.com';
var TTL = 60 * 1000;            // long enough to browse a gallery, short enough to see a new comment
var cache = null;               // { at, data }

function load(fresh) {
  if (!fresh && cache && Date.now() - cache.at < TTL) return Promise.resolve(cache.data);
  return fetch(APP + '/api/data', { credentials: 'include' }).then(function (r) {
    if (r.status === 401) throw Object.assign(new Error('login'), { login: true });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }).then(function (data) {
    cache = { at: Date.now(), data: data };
    return data;
  });
}

// Same rule as sameListing() in web/app.js: scheme, www, query and trailing
// slash do not make a different listing.
function norm(u) {
  return String(u).replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
}

// SeLoger has several URL shapes for the same advert over the years
// (/annonces/achat/…/123456789.htm, /123456789/detail.htm,
// /annonce/achat/…/26S6E45QMW75), so a plain URL compare misses listings saved
// under an older one. The advert's own id, scoped to its site, catches those:
// the last path segment that is a long number or a mixed letters-and-digits code.
function idOf(u) {
  var m = String(u).match(/^https?:\/\/(?:www\.)?([^\/]+)(\/[^?#]*)/i);
  if (!m) return null;
  var segs = m[2].split('/').filter(Boolean).map(function (s) { return s.replace(/\.htm$/, ''); });
  for (var i = segs.length - 1; i >= 0 && i >= segs.length - 2; i--) {
    var s = segs[i];
    if (/^\d{7,}$/.test(s) || (/^[A-Za-z0-9]{10,14}$/.test(s) && /\d/.test(s) && /[A-Za-z]/.test(s))) {
      return m[1].toLowerCase() + ':' + s.toLowerCase();
    }
  }
  return null;
}

function find(data, urls) {
  var wantN = urls.map(norm), wantI = urls.map(idOf).filter(Boolean);
  // A house listed by several agencies carries the others in `links`.
  return (data.properties || []).find(function (d) {
    return [d.url].concat(d.links || []).some(function (u) {
      if (!u) return false;
      if (wantN.indexOf(norm(u)) !== -1) return true;
      var i = idOf(u);
      return !!i && wantI.indexOf(i) !== -1;
    });
  });
}

// Every visit, oldest first — Sam one week, Alex the next. A bien saved
// before the list existed still has a single `visit`.
function visitsOf(d) {
  var vs = Array.isArray(d.visits) ? d.visits.slice() : d.visit ? [{ at: d.visit, by: d.visitBy || 'sam' }] : [];
  return vs.filter(function (v) { return v && v.at; }).sort(function (a, b) { return a.at.localeCompare(b.at); });
}
// The next one coming, or else the latest: same as deriveVisit() in web/app.js.
function currentVisit(d) {
  var now = new Date().toLocaleString('sv').replace(' ', 'T');
  var vs = visitsOf(d);
  var past = function (at) { return at.length <= 10 ? at < now.slice(0, 10) : at <= now.slice(0, 16); };
  var cur = vs.find(function (v) { return !past(v.at); }) || vs[vs.length - 1];
  return cur ? { at: cur.at, by: cur.by || null } : { at: null, by: null };
}

// Only what the card shows leaves the worker. Points of interest go along
// when they are close enough to land on the mini map.
function summary(data, d) {
  var notes = (data.notes && data.notes[d.id]) || [];
  var near = typeof d.lat === 'number' ? (data.pois || []).filter(function (p) {
    return Math.abs(p.lat - d.lat) < 0.03 && Math.abs(p.lng - d.lng) < 0.04;
  }).map(function (p) { return { lat: p.lat, lng: p.lng, icon: p.icon, name: p.name }; }) : [];
  return {
    id: d.id, name: d.name, address: d.address || null, town: d.town || null,
    price: d.price, surface: d.surface, terrain: d.terrain || null,
    lat: d.lat, lng: d.lng, approx: !!d.geo && d.geo !== 'dms' && d.geo !== 'manual',
    visits: visitsOf(d), visit: currentVisit(d).at, visitBy: currentVisit(d).by,
    sold: !!d.sold, hidden: !!d.hidden,
    scores: (data.scores && data.scores[d.id]) || {},
    notes: notes.slice(-3).map(function (n) { return { user: n.user, text: n.text, ts: n.ts }; }),
    noteCount: notes.length,
    pois: near,
    link: APP + '/#bien/' + encodeURIComponent(d.id)
  };
}

/* Déjà dans la liste ? The same house sold by a second agency has a link we
   have never seen, but the same town, price, surface and land, give or take an
   agent's rounding. Same scoring as lookalikes() in web/app.js. */
function near(a, b, steps) {
  if (!a || !b) return 0;
  var r = Math.abs(a - b) / Math.max(a, b);
  for (var i = 0; i < steps.length; i++) if (r <= steps[i][0]) return steps[i][1];
  return 0;
}
function num(v) { return typeof v === 'number' && isFinite(v) && v > 0 ? v : null; }

// Same order as photoOf() in web/app.js. Photos we mirrored are stored as
// "/photos/…", which only means something on the app's own domain; on a
// listing site it would resolve against seloger.com, so make it absolute.
function photoOf(d) {
  var src = (d.gallery && d.gallery[0]) || d.photo || d.street || null;
  if (!src) return null;
  if (src.charAt(0) === '/' && src.charAt(1) !== '/') return APP + src;
  if (src.indexOf('streetviewpixels') !== -1) return src.replace(/([?&])w=\d+/, '$1w=216').replace(/([?&])h=\d+/, '$1h=162');
  return src;
}

function scored(data, f) {
  var town = String(f.town || '').toLowerCase().trim();
  return (data.properties || []).map(function (d) {
    var s = 0;
    if (town && String(d.town || '').toLowerCase().trim() === town) s += 2;
    s += near(num(f.price), d.price, [[0.02, 4], [0.06, 2.5], [0.12, 1]]);
    s += near(num(f.surface), d.surface, [[0.02, 3], [0.06, 2], [0.12, 0.5]]);
    s += near(num(f.terrain), d.terrain, [[0.03, 2], [0.12, 1]]);
    if (num(f.rooms) && d.rooms === f.rooms) s += 1;
    return { d: d, s: s };
  }).sort(function (a, b) { return b.s - a.s; });
}

function lookalikes(data, f) {
  return scored(data, f).filter(function (x) { return x.s >= 5; })
    .slice(0, 3).map(function (x) {
      var d = x.d;
      return {
        id: d.id, name: d.name, town: d.town || null, price: d.price, surface: d.surface,
        terrain: d.terrain || null, sold: !!d.sold, hidden: !!d.hidden,
        photo: photoOf(d),
        delta: num(f.price) && d.price != null ? d.price - f.price : null,
        link: APP + '/#bien/' + encodeURIComponent(d.id),
        advert: d.url && d.listing !== 'gone' ? d.url : null
      };
    });
}

// Same rule as attachTo() in web/app.js: a bien whose own advert is dead takes
// this one as its link; otherwise it joins the others in `links`.
function attach(id, url) {
  return load(true).then(function (data) {
    var d = (data.properties || []).find(function (x) { return x.id === id; });
    if (!d) throw new Error('Bien introuvable');
    var known = [d.url].concat(d.links || []).some(function (u) { return u && norm(u) === norm(url); });
    if (known) return;
    var patch = (!d.url || d.listing === 'gone')
      ? { url: url, listing: 'live' }
      : { links: (d.links || []).concat([url]).slice(0, 10) };
    return fetch(APP + '/api/property/' + encodeURIComponent(id), {
      method: 'PUT', credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch)
    }).then(function (r) {
      if (r.status === 403) throw new Error('Ce compte ne peut pas modifier les biens');
      if (!r.ok) throw new Error('Refusé (' + r.status + ')');
    });
  }).then(function () { cache = null; });
}

function clean(list, max) {
  return (Array.isArray(list) ? list : []).filter(function (u) { return typeof u === 'string'; }).slice(0, max);
}

chrome.runtime.onMessage.addListener(function (msg, sender, reply) {
  if (!msg) return;
  if (msg.type === 'attach') {
    // The link is the page the request came from, never one the message names.
    var url = String((sender.tab && sender.tab.url) || sender.url || '').replace(/[?#].*$/, '');
    if (!/^https:\/\//.test(url) || typeof msg.id !== 'string') { reply({ error: 'Requête invalide' }); return; }
    attach(msg.id, url).then(function () { reply({ ok: true }); },
                             function (e) { reply({ error: String(e.message || e) }); });
    return true;
  }
  if (msg.type === 'similar') {
    load(false).then(function (data) { reply({ list: lookalikes(data, msg.facts || {}) }); },
                     function (e) { reply(e.login ? { login: APP } : { error: String(e.message || e) }); });
    return true;
  }
  // A results page: for each result we could not match by link, the one bien
  // it is very likely to be, if any. Stricter than the advert card, since
  // there is no one looking at a list of choices: price and surface both
  // close, or near enough with the town and land agreeing too. A clear
  // runner-up means it is not clear at all, so nothing is said.
  if (msg.type === 'similarMany') {
    load(false).then(function (data) {
      var out = {};
      (Array.isArray(msg.items) ? msg.items : []).slice(0, 100).forEach(function (it) {
        if (!it || typeof it.key !== 'string') return;
        var r = scored(data, it.facts || {});
        if (!r.length || r[0].s < 7.5 || (r[1] && r[0].s - r[1].s < 2)) return;
        var sum = summary(data, r[0].d);
        sum.maybe = true;
        out[it.key] = sum;
      });
      reply({ found: out });
    }, function () { reply({ found: {} }); });
    return true;
  }
  if (msg.type !== 'lookup' && msg.type !== 'lookupMany') return;
  load(msg.fresh).then(function (data) {
    if (msg.type === 'lookup') {
      var d = find(data, clean(msg.urls, 5));
      return reply(d ? { found: summary(data, d) } : { found: null });
    }
    // A results page: one answer per advert link, keyed by the link as sent.
    var out = {};
    clean(msg.urls, 300).forEach(function (u) {
      var d = find(data, [u]);
      if (d) out[u] = summary(data, d);
    });
    reply({ found: out });
  }, function (e) {
    reply(e.login ? { login: APP } : { error: String(e.message || e) });
  });
  return true;                  // reply arrives after the fetch
});
