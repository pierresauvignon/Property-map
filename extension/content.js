/* On the listing sites, two things:
   · on an advert already in Property Map, a card in the corner with the map, our
     marks, the visit and the last comments;
   · on a results page, a tab on every result we already have.
   Everything we draw lives in closed shadow roots so the sites' CSS cannot
   reach in or out, and every value goes in as text, never as markup. */
(function () {
  if (window.top !== window) return;

  var USERS = { alex: 'Alex', sam: 'Sam', guest: 'Invité' };
  var POI = { school: '🏫', shop: '🛒', bakery: '🥖', train: '🚉', bus: '🚌', park: '🌳',
              work: '💼', health: '🏥', sport: '⚽', food: '🍽️', family: '👪', star: '⭐' };

  // Same tokens as web/index.html, dark theme: the card should look like a
  // piece of the app that has wandered onto the page.
  var TOKENS = ':host{--n:285;--h:20;' +
    '--paper:oklch(0.165 0.014 var(--n));--surface:oklch(0.215 0.016 var(--n));--raised:oklch(0.268 0.018 var(--n));' +
    '--ink:oklch(0.980 0.004 var(--n));--ink-2:oklch(0.800 0.010 var(--n));--ink-3:oklch(0.650 0.012 var(--n));' +
    '--rule:oklch(0.325 0.018 var(--n));--accent:oklch(0.660 0.225 var(--h));--on-accent:oklch(0.145 0.030 var(--h));' +
    '--gold:oklch(0.820 0.150 85);--alex:oklch(0.730 0.155 250);--sam:oklch(0.780 0.155 155);' +
    '--visit:oklch(0.640 0.165 150);--sold:oklch(0.975 0.004 var(--n));--on-sold:oklch(0.170 0.014 var(--n));' +
    '--ui:"Hanken Grotesk",system-ui,-apple-system,"Segoe UI",sans-serif}' +
    '*{box-sizing:border-box;margin:0}';

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function mark(v) { return v == null ? '–' : String(v).replace('.', ','); }
  var nf = new Intl.NumberFormat('fr-FR');
  function euro(p) { return p == null ? null : nf.format(p) + ' €'; }
  function visitText(v, by) {
    var p = String(v).split('T'), dt = new Date(p[0] + 'T12:00');
    if (isNaN(dt)) return null;
    var day = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' }).format(dt).replace('.', '');
    // both sides local wall-clock text, as visitDone() in web/app.js
    var now = new Date().toLocaleString('sv').replace(' ', 'T');
    var done = p[1] ? v <= now.slice(0, 16) : p[0] < now.slice(0, 10);
    return (done ? 'Visité ' : 'Visite ') + day + (p[1] ? ' · ' + p[1].replace(':', 'h') : '') +
      (by && USERS[by] ? ' · ' + USERS[by] : '');
  }
  var rtf = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });
  function ago(ts) {
    var s = (ts - Date.now()) / 1000, a = Math.abs(s);
    if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
    if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
    if (a < 86400 * 30) return rtf.format(Math.round(s / 86400), 'day');
    return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' }).format(new Date(ts));
  }

  function ask(msg, cb) {
    try {
      chrome.runtime.sendMessage(msg, function (r) {
        if (chrome.runtime.lastError || !r) return;
        cb(r);
      });
    } catch (e) { /* extension reloaded under us: this page's script is orphaned */ }
  }

  // Same rule as idOf() in background.js — the advert's own id, scoped to its
  // site — used here only to tell one result's links from another's.
  function keyOf(u) {
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

  /* ───────────────────────── the mini map ─────────────────────────
     A handful of OpenStreetMap tiles laid side by side, not a map library:
     it only has to show where the house sits and what is around it. */
  var MAP_W = 318, MAP_H = 150;

  function project(lat, lng, z) {
    var n = 256 * Math.pow(2, z), r = lat * Math.PI / 180;
    return [(lng + 180) / 360 * n, (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n];
  }

  function drawMap(box, d, z) {
    box.textContent = '';
    var hi = (window.devicePixelRatio || 1) > 1;
    var tz = hi ? z + 1 : z, ts = hi ? 128 : 256;      // retina: next zoom down, drawn at half size
    var c = project(d.lat, d.lng, z), x0 = c[0] - MAP_W / 2, y0 = c[1] - MAP_H / 2;
    var n = Math.pow(2, tz), tiles = el('div', 'tiles');
    for (var ty = Math.floor(y0 / ts); ty <= Math.floor((y0 + MAP_H) / ts); ty++) {
      if (ty < 0 || ty >= n) continue;
      for (var tx = Math.floor(x0 / ts); tx <= Math.floor((x0 + MAP_W) / ts); tx++) {
        var img = el('img');
        img.alt = ''; img.draggable = false; img.decoding = 'async';
        img.src = 'https://tile.openstreetmap.org/' + tz + '/' + (((tx % n) + n) % n) + '/' + ty + '.png';
        img.style.cssText = 'left:' + (tx * ts - x0) + 'px;top:' + (ty * ts - y0) + 'px;width:' + ts + 'px;height:' + ts + 'px';
        tiles.appendChild(img);
      }
    }
    box.appendChild(tiles);

    d.pois.forEach(function (p) {
      var q = project(p.lat, p.lng, z), x = q[0] - x0, y = q[1] - y0;
      if (x < 8 || y < 8 || x > MAP_W - 8 || y > MAP_H - 8) return;
      var g = el('span', 'poi', POI[p.icon] || POI.star);
      g.title = p.name || '';
      g.style.cssText = 'left:' + x + 'px;top:' + y + 'px';
      box.appendChild(g);
    });

    var pin = el('span', 'pin' + (d.approx ? ' pin--approx' : ''));
    pin.title = d.approx ? 'Position approximative' : '';
    box.appendChild(pin);
    box.appendChild(el('span', 'osm', '© OpenStreetMap'));
  }

  function mapBlock(d) {
    var wrap = el('div', 'map'), box = el('div', 'mapbox'), z = 15;
    drawMap(box, d, z);
    box.title = 'Ouvrir dans Property Map';
    box.onclick = function () { window.open(d.link, 'pm'); };
    wrap.appendChild(box);
    var zoom = el('div', 'zoom');
    [['+', 1, 'Rapprocher'], ['−', -1, 'Éloigner']].forEach(function (b) {
      var btn = el('button', null, b[0]);
      btn.title = b[2];
      btn.onclick = function (e) {
        e.stopPropagation();
        z = Math.max(11, Math.min(18, z + b[1]));
        drawMap(box, d, z);
      };
      zoom.appendChild(btn);
    });
    wrap.appendChild(zoom);
    if (d.approx && !d.sold) wrap.appendChild(el('span', 'approx', 'position approximative'));
    if (d.sold) { wrap.classList.add('sold'); wrap.appendChild(el('div', 'band', 'Vendu')); }
    return wrap;
  }

  /* ───────────────────────── the card, on an advert ───────────────────────── */
  var CARD_CSS = TOKENS +
    '.card{width:320px;max-height:calc(100vh - 32px);display:flex;flex-direction:column;overflow:hidden;' +
      'background:var(--paper);color:var(--ink);border:1px solid var(--rule);border-radius:18px;' +
      'font:400 13px/1.45 var(--ui);-webkit-font-smoothing:antialiased;' +
      'box-shadow:0 1px 2px oklch(0 0 0/.45),0 18px 40px -12px oklch(0 0 0/.6)}' +
    '.scroll{overflow:auto;min-height:0}' +
    '.map{position:relative;height:' + MAP_H + 'px;flex:none;border-bottom:1px solid var(--rule)}' +
    '.mapbox{position:absolute;inset:0;overflow:hidden;cursor:pointer;background:var(--sunk,#1b1b22)}' +
    '.tiles{position:absolute;inset:0;filter:saturate(.12) brightness(.6) contrast(1.06) invert(.93) hue-rotate(180deg)}' +
    '.tiles img{position:absolute;max-width:none;user-select:none}' +
    // Exact: a dot with a halo. Approximate: the same dot inside a shaded
    // area, so it reads as "somewhere around here" rather than a target.
    '.pin{position:absolute;left:50%;top:50%;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;' +
      'background:var(--accent);border:2.5px solid oklch(0.99 0 0);' +
      'box-shadow:0 0 0 5px oklch(0.660 0.225 20/.30),0 2px 6px oklch(0 0 0/.5)}' +
    '.pin--approx{width:10px;height:10px;margin:-5px 0 0 -5px;border-width:2px;' +
      'box-shadow:0 0 0 22px oklch(0.660 0.225 20/.16),0 0 0 23.5px oklch(0.660 0.225 20/.55)}' +
    '.poi{position:absolute;transform:translate(-50%,-50%);font-size:13px;line-height:1;width:22px;height:22px;display:grid;place-items:center;' +
      'border-radius:50%;background:var(--surface);border:1px solid var(--rule);box-shadow:0 1px 3px oklch(0 0 0/.5)}' +
    '.osm{position:absolute;right:6px;bottom:4px;font-size:9.5px;color:var(--ink-3);text-shadow:0 0 3px var(--paper);pointer-events:none}' +
    '.approx{position:absolute;left:10px;bottom:6px;font-size:11px;color:var(--ink-2);background:var(--paper);padding:1px 8px;border-radius:999px;opacity:.9}' +
    '.zoom{position:absolute;right:8px;top:8px;display:grid;border-radius:10px;overflow:hidden;border:1px solid var(--rule);box-shadow:0 1px 3px oklch(0 0 0/.4)}' +
    '.zoom button{width:28px;height:26px;border:0;background:var(--surface);color:var(--ink);font:500 16px/1 var(--ui);cursor:pointer}' +
    '.zoom button+button{border-top:1px solid var(--rule)}' +
    '.zoom button:hover{background:var(--raised)}' +
    '.x{position:absolute;left:8px;top:8px;width:28px;height:28px;border-radius:50%;border:1px solid var(--rule);' +
      'background:var(--surface);color:var(--ink-2);font:400 17px/1 var(--ui);cursor:pointer;box-shadow:0 1px 3px oklch(0 0 0/.4)}' +
    '.x:hover{color:var(--ink);background:var(--raised)}' +
    '.eyebrow .x{position:static;margin-left:auto;width:24px;height:24px;font-size:15px}' +
    '.body{padding:14px 16px 0}' +
    '.eyebrow{display:flex;align-items:center;gap:6px;flex-wrap:wrap}' +
    '.tag{font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);margin-right:2px}' +
    '.chip{font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:var(--raised);color:var(--ink-2)}' +
    '.chip--visit{background:var(--visit);color:oklch(0.99 0.01 150)}' +
    '.chip--done{background:var(--raised);color:var(--ink-2)}' +
    '.chip--sold{background:var(--sold);color:var(--on-sold);font-weight:800;letter-spacing:.08em;text-transform:uppercase}' +
    // Sold: the map goes grey and a band runs across it, the price is struck
    // through as in the app's own list. Not red: red here is Property Map's coral.
    '.map.sold .tiles{filter:grayscale(1) brightness(.45) contrast(1.05) invert(.93)}' +
    '.map.sold .pin{background:oklch(0.985 0 0);border-color:oklch(0.17 0.014 var(--n));box-shadow:0 2px 6px oklch(0 0 0/.5)}' +
    '.map.sold .pin--approx{box-shadow:0 0 0 22px oklch(0.985 0 0/.12),0 0 0 23.5px oklch(0.985 0 0/.45)}' +
    '.band{position:absolute;left:0;right:0;bottom:0;height:34px;display:grid;place-items:center;pointer-events:none;' +
      'background:var(--sold);color:var(--on-sold);font:800 15px/1 var(--ui);letter-spacing:.32em;text-indent:.32em;text-transform:uppercase;' +
      'box-shadow:0 -6px 16px oklch(0 0 0/.35)}' +
    '.card.sold{border-color:var(--sold)}' +
    '.card.sold .facts b{text-decoration:line-through;text-decoration-thickness:1.5px;color:var(--ink-3)}' +
    '.card.sold .osm{bottom:38px}' +
    '.name{font-size:17px;font-weight:650;letter-spacing:-.01em;line-height:1.25;margin-top:8px}' +
    '.where{color:var(--ink-3);font-size:12.5px;margin-top:1px}' +
    '.facts{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:10px;color:var(--ink-2);font-variant-numeric:tabular-nums}' +
    '.facts b{color:var(--ink);font-weight:650}' +
    '.marks{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}' +
    '.m{background:var(--surface);border:1px solid var(--rule);border-radius:12px;padding:8px 10px 9px}' +
    '.m .who{font-size:11px;font-weight:650}.m.alex .who{color:var(--alex)}.m.sam .who{color:var(--sam)}' +
    '.m .v{font-size:22px;font-weight:650;color:var(--gold);font-variant-numeric:tabular-nums;line-height:1.1;margin-top:2px}' +
    '.m .v small{font-size:12px;color:var(--ink-3);font-weight:500;margin-left:2px}' +
    '.m.none .v{color:var(--ink-3)}' +
    '.pips{display:flex;gap:3px;margin-top:6px}' +
    '.pips i{flex:1;height:4px;border-radius:2px;background:var(--raised)}' +
    '.m.alex .pips i.on{background:var(--alex)}.m.sam .pips i.on{background:var(--sam)}' +
    '.m.alex .pips i.half{background:linear-gradient(90deg,var(--alex) 50%,var(--raised) 50%)}' +
    '.m.sam .pips i.half{background:linear-gradient(90deg,var(--sam) 50%,var(--raised) 50%)}' +
    '.notes{margin-top:16px;padding-bottom:4px}' +
    '.notes h3{font-size:11px;font-weight:650;color:var(--ink-3);letter-spacing:.02em;margin-bottom:8px;display:flex;justify-content:space-between}' +
    '.note{border-left:2px solid var(--rule);padding:1px 0 1px 10px;margin-bottom:10px;cursor:pointer}' +
    '.note.alex{border-color:var(--alex)}.note.sam{border-color:var(--sam)}' +
    '.note .hd{font-size:11.5px;color:var(--ink-3)}' +
    '.note .hd b{font-weight:650}.note.alex .hd b{color:var(--alex)}.note.sam .hd b{color:var(--sam)}' +
    '.note p{color:var(--ink-2);white-space:pre-wrap;overflow-wrap:anywhere;margin-top:1px;' +
      'display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}' +
    '.note.open p{display:block}' +
    '.empty{color:var(--ink-3);margin-top:14px}' +
    '.foot{padding:12px 16px 14px;flex:none}' +
    '.go{display:flex;align-items:center;justify-content:center;gap:8px;padding:10px 14px;border-radius:999px;background:var(--accent);' +
      'color:var(--on-accent);font-weight:650;text-decoration:none;font-size:13.5px}' +
    '.go:hover{filter:brightness(1.08)}' +
    '.pill{display:flex;align-items:center;gap:10px;background:var(--paper);color:var(--ink);border:1px solid var(--rule);' +
      'border-radius:999px;padding:8px 14px 8px 10px;font:600 13px/1 var(--ui);text-decoration:none;cursor:pointer;' +
      'box-shadow:0 1px 2px oklch(0 0 0/.5),0 8px 18px -6px oklch(0 0 0/.6)}' +
    '.pill .dot{width:10px;height:10px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 4px oklch(0.660 0.225 20/.25)}' +
    '.pill .p{color:var(--alex)}.pill .mm{color:var(--sam)}.pill .c{color:var(--ink-3);font-weight:500}' +
    '.pill.muted{color:var(--ink-2)}.pill.muted .dot{background:var(--ink-3);box-shadow:none}' +
    '.pill.add .plus{font-size:16px;line-height:0;color:var(--accent);margin:0 -2px 0 2px}' +
    // Not in Property Map yet: the likely twins, and a way in either way.
    '.card.notyet{width:340px}' +
    '.notyet .body{padding-top:14px}' +
    '.notyet .top{display:flex;align-items:center;gap:8px}' +
    '.notyet .top .tag{color:var(--ink-3)}' +
    '.notyet .x{position:static;margin-left:auto;width:26px;height:26px;font-size:15px}' +
    '.notyet h2{font-size:17px;font-weight:650;letter-spacing:-.01em;margin-top:10px}' +
    '.notyet .sub{color:var(--ink-3);font-size:12.5px;margin-top:2px}' +
    '.twins{display:grid;grid-template-columns:minmax(0,1fr);gap:8px;margin-top:12px}' +
    '.twin{display:flex;align-items:center;gap:10px;padding:8px;border-radius:12px;background:var(--surface);border:1px solid var(--rule)}' +
    '.twin img{width:60px;height:46px;flex:none;object-fit:cover;border-radius:8px;background:var(--raised)}' +
    '.twin .t{flex:1;min-width:0}' +
    '.twin .open{flex:none;display:block;border-radius:8px;line-height:0}' +
    '.twin .open:hover img{outline:2px solid var(--accent);outline-offset:1px}' +
    '.twin .nm{display:block;font-weight:650;color:var(--ink);text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.twin .nm:hover{color:var(--accent)}' +
    '.twin .ad{color:var(--ink-2);text-decoration:none;border-bottom:1px solid var(--rule)}' +
    '.twin .ad:hover{color:var(--accent);border-bottom-color:currentColor}' +
    '.twin .t span{display:block;font-size:11.5px;color:var(--ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.twin .t .d{color:var(--ink-2);font-variant-numeric:tabular-nums}.twin .t .d .eq{color:var(--visit)}' +
    '.twin .t .d span{display:inline}' +
    '.twin button{flex:none;border:0;border-radius:999px;padding:7px 12px;background:var(--accent);color:var(--on-accent);' +
      'font:650 12px/1 var(--ui);cursor:pointer}' +
    '.twin button:hover{filter:brightness(1.08)}.twin button:disabled{opacity:.6;cursor:default}' +
    '.err{color:var(--accent);font-size:12px;margin-top:8px}' +
    '.alt{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;padding:9px 14px;border-radius:999px;' +
      'background:none;border:1px solid var(--rule);color:var(--ink);font:600 13px/1 var(--ui);cursor:pointer;text-decoration:none}' +
    '.alt:hover{border-color:var(--ink-3)}';

  var host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647';
  var root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = '<style>' + CARD_CSS + '</style><div id="slot"></div>';
  var slot = root.getElementById('slot');
  var folded = {};                   // per listing id, for this tab only

  function show(node) {
    slot.textContent = '';
    if (!node) { host.remove(); return; }
    slot.appendChild(node);
    if (!host.isConnected) document.documentElement.appendChild(host);
  }

  function pill(d) {
    var a = el('button', 'pill');
    a.appendChild(el('span', 'dot'));
    a.appendChild(el('span', null, 'Property Map'));
    if (d.sold) a.appendChild(el('span', 'chip chip--sold', 'Vendu'));
    a.appendChild(el('span', 'p', mark(d.scores.alex)));
    a.appendChild(el('span', 'mm', mark(d.scores.sam)));
    if (d.noteCount) a.appendChild(el('span', 'c', d.noteCount + ' comm.'));
    a.title = 'Afficher la fiche Property Map';
    a.onclick = function () { folded[d.id] = false; show(card(d)); };
    return a;
  }

  function markBox(u, v) {
    var m = el('div', 'm ' + u + (v == null ? ' none' : ''));
    m.appendChild(el('div', 'who', USERS[u]));
    var val = el('div', 'v', mark(v));
    if (v != null) val.appendChild(el('small', null, '/5'));
    m.appendChild(val);
    var pips = el('div', 'pips');
    for (var i = 1; i <= 5; i++) {
      pips.appendChild(el('i', v == null ? '' : v >= i ? 'on' : v >= i - 0.5 ? 'half' : ''));
    }
    m.appendChild(pips);
    return m;
  }

  function card(d) {
    var c = el('div', 'card' + (d.sold ? ' sold' : ''));
    var hasMap = typeof d.lat === 'number' && typeof d.lng === 'number';

    if (hasMap) c.appendChild(mapBlock(d));
    var x = el('button', 'x', '×');
    x.title = 'Réduire';
    x.onclick = function () { folded[d.id] = true; show(pill(d)); };
    if (c.firstChild) c.firstChild.appendChild(x);

    var scroll = el('div', 'scroll'), b = el('div', 'body');
    var eb = el('div', 'eyebrow');
    eb.appendChild(el('span', 'tag', 'Dans Property Map'));
    // every visit, the latest three
    (d.visits || []).slice(-3).forEach(function (v) {
      var tx = visitText(v.at, v.by);
      if (tx) eb.appendChild(el('span', 'chip chip--visit' + (/^Visité/.test(tx) ? ' chip--done' : ''), tx));
    });
    if (d.sold && !hasMap) eb.appendChild(el('span', 'chip chip--sold', 'Vendu'));
    if (d.hidden) eb.appendChild(el('span', 'chip', 'Écarté'));
    if (!c.firstChild) eb.appendChild(x);
    b.appendChild(eb);

    b.appendChild(el('div', 'name', d.name));
    var where = [d.address, d.town].filter(function (s, i, all) {
      return s && d.name.indexOf(s) === -1 && !(i === 1 && all[0] && all[0].indexOf(s) !== -1);
    }).join(', ');
    if (where) b.appendChild(el('div', 'where', where));

    var facts = el('div', 'facts');
    if (d.price != null) facts.appendChild(el('b', null, euro(d.price)));
    if (d.surface) facts.appendChild(el('span', null, d.surface + ' m²'));
    if (d.price != null && d.surface) facts.appendChild(el('span', null, nf.format(Math.round(d.price / d.surface)) + ' €/m²'));
    if (d.terrain) facts.appendChild(el('span', null, nf.format(d.terrain) + ' m² de terrain'));
    if (facts.childNodes.length) b.appendChild(facts);

    var marks = el('div', 'marks');
    marks.appendChild(markBox('alex', d.scores.alex));
    marks.appendChild(markBox('sam', d.scores.sam));
    b.appendChild(marks);

    if (d.notes.length) {
      var ns = el('div', 'notes'), h = el('h3');
      h.appendChild(el('span', null, 'Commentaires'));
      if (d.noteCount > d.notes.length) h.appendChild(el('span', null, d.notes.length + ' sur ' + d.noteCount));
      ns.appendChild(h);
      d.notes.slice().reverse().forEach(function (n) {
        var w = el('div', 'note ' + n.user), hd = el('div', 'hd');
        hd.appendChild(el('b', null, USERS[n.user] || n.user));
        hd.appendChild(document.createTextNode(' · ' + ago(n.ts)));
        w.appendChild(hd);
        w.appendChild(el('p', null, n.text));
        w.title = 'Afficher tout';
        w.onclick = function () { w.classList.toggle('open'); };
        ns.appendChild(w);
      });
      b.appendChild(ns);
    } else {
      b.appendChild(el('div', 'empty', 'Pas encore de commentaire.'));
    }
    scroll.appendChild(b);
    c.appendChild(scroll);

    var foot = el('div', 'foot'), go = el('a', 'go', 'Voir sur l’app  ↗');
    go.href = d.link; go.target = 'pm'; go.rel = 'noopener';
    foot.appendChild(go);
    c.appendChild(foot);
    return c;
  }

  /* What the advert says about itself. The same reading as the bookmarklet in
     web/bookmarklet.html, so a listing comes out the same whichever way in. */
  function scrape() {
    var H = location.host, D = document, t = D.title || '', o = { v: 6 };
    var body = D.body ? D.body.innerText : '';
    var num = function (s) { s = (s || '').replace(/[  \s.]/g, ''); var m = s.match(/\d+/); return m ? +m[0] : null; };
    var dnum = function (s) {
      s = (s || '').replace(/[  \s]/g, '').replace(',', '.');
      var m = s.match(/\d+(?:\.\d+)?/); return m ? Math.round(parseFloat(m[0])) : null;
    };
    var LET = function (s) { s = (s || '').trim().toUpperCase(); return /^[A-G]$/.test(s) ? s : null; };
    var TERR = function () {
      var m = body.match(/([\d][\d\s  .]{0,12})\s*m²\s*de\s*terrain/i);
      if (!m) return null;
      var n = parseInt(m[1].replace(/[\s  .]/g, ''), 10);
      return isFinite(n) && n > 0 ? n : null;
    };
    o.url = location.href.split('?')[0];
    var og = D.querySelector('meta[property="og:image"]');
    o.photo = og ? og.content.split('?')[0] : '';
    var all = D.documentElement.innerHTML.match(/https:\/\/(?:v\.seloger\.com|mms\.seloger\.com|img\.leboncoin\.fr)\/[A-Za-z0-9\/\-_]+\.(?:jpg|jpeg|webp)/gi) || [];
    var best = {}, order = [];
    all.forEach(function (u) {
      var id = u.split('/').pop(), w = u.match(/\/s\/width\/(\d+)/), c = u.match(/\/s\/crop\/(\d+)x(\d+)/);
      var sc = w ? 100000 + (+w[1]) : (c ? (+c[1]) * (+c[2]) / 1000 : 50000);
      if (!(id in best)) { best[id] = { u: u, sc: sc }; order.push(id); }
      else if (sc > best[id].sc) best[id] = { u: u, sc: sc };
    });
    var list = order.map(function (id) { return best[id].u; });
    var dec = (body.match(/(\d{1,3})\s*photos/i) || [])[1];
    if (dec && +dec > 0 && +dec < list.length) list = list.slice(0, +dec);
    o.gallery = list.slice(0, 60);
    if (/seloger|bellesdemeures/.test(H)) {
      var m1 = t.match(/\b(\d{1,4}(?:[.,]\d+)?)\s*m²/); if (m1) o.surface = dnum(m1[1]);
      var p1 = t.match(/\b(\d[\d\s  .]{3,12})\s*€/); if (p1) o.price = num(p1[1]);
      var r1 = t.match(/T(\d+)/); if (r1) o.rooms = +r1[1];
      o.terrain = TERR();
      var hs = [].slice.call(D.querySelectorAll('h3'));
      var pick = function (rx) {
        var h = hs.filter(function (x) { return rx.test(x.textContent || ''); })[0];
        if (!h) return null;
        var b = (h.parentElement || D).querySelector('[data-testid="cdp-preview-scale-highlighted"]');
        return b ? LET(b.textContent) : null;
      };
      o.dpe = pick(/performance\s+énerg/i);
      o.ges = pick(/gaz\s+à\s+effet/i);
      if (!o.dpe || !o.ges) {
        [].forEach.call(D.querySelectorAll('.diagnosticBoxActive'), function (e) {
          var mm = String(e.className).match(/\b(dpe|ges)([A-G])\b/); if (mm) o[mm[1]] = mm[2];
        });
      }
      o.kind = /terrain/i.test(t) ? 'land' : 'property';
    } else if (/leboncoin/.test(H)) {
      var nd = D.querySelector('script#__NEXT_DATA__');
      if (nd) {
        var s = nd.textContent, g = function (rx) { var m = s.match(rx); return m ? m[1] : null; };
        if (g(/"price":\[(\d+)\]/)) o.price = +g(/"price":\[(\d+)\]/);
        if (g(/"key":"square","value":"(\d+)"/)) o.surface = +g(/"key":"square","value":"(\d+)"/);
        if (g(/"key":"rooms","value":"(\d+)"/)) o.rooms = +g(/"key":"rooms","value":"(\d+)"/);
        if (g(/"key":"land_plot_surface","value":"(\d+)"/)) o.terrain = +g(/"key":"land_plot_surface","value":"(\d+)"/);
        o.dpe = LET(g(/"key":"energy_rate","value":"([a-gA-G])"/));
        o.ges = LET(g(/"key":"ges","value":"([a-gA-G])"/));
      }
      o.kind = /terrain/i.test(t) ? 'land' : 'property';
    } else {
      var p2 = body.match(/([\d\s  .]{6,})\s*€/); if (p2) o.price = num(p2[1]);
    }
    var a = body.match(/\b(\d{5})\s+([A-ZÀ-Ü][A-Za-zÀ-ÿ'\- ]{2,40})/);
    if (a) { o.address = a[0].trim(); o.town = a[2].trim(); }
    // SeLoger titles end "… Quartier Bastide (33100)": the town is the last word.
    // The title is about this house; the first postcode in the page text is
    // as likely the agency's, so the title wins.
    var tt = t.match(/([A-Za-zÀ-ÿ'\-]+)\s*\((\d{5})\)/);
    if (tt) { o.town = tt[1]; if (!a || a[1] !== tt[2]) o.address = tt[2] + ' ' + tt[1]; }
    o.name = (o.address || t).slice(0, 80);
    return o;
  }

  function addLink(o) {
    return 'https://your-app.example.com/#add=' + encodeURIComponent(JSON.stringify(o));
  }

  function addPill(o) {
    var a = el('a', 'pill add');
    a.href = addLink(o); a.target = 'pm'; a.rel = 'noopener';
    a.appendChild(el('span', 'plus', '+'));
    a.appendChild(document.createTextNode('Ajouter à Property Map'));
    a.title = 'Ouvre la fiche pré-remplie dans Property Map';
    return a;
  }

  function notYetCard(o, twins) {
    var c = el('div', 'card notyet'), b = el('div', 'body'), top = el('div', 'top');
    top.appendChild(el('span', 'tag', 'Pas encore dans Property Map'));
    var x = el('button', 'x', '×');
    x.title = 'Réduire';
    x.onclick = function () { folded[o.url] = true; show(addPill(o)); };
    top.appendChild(x);
    b.appendChild(top);
    b.appendChild(el('h2', null, 'Déjà dans la liste ?'));
    b.appendChild(el('div', 'sub', 'Ces biens y ressemblent. Si c’est le même chez une autre agence, rattache cette annonce.'));

    var list = el('div', 'twins'), err = el('div', 'err');
    twins.forEach(function (d) {
      var row = el('div', 'twin');
      var img = el('img'); img.alt = ''; img.loading = 'lazy';
      // a dead link shows as the empty frame, not the browser's broken icon
      img.onerror = function () { img.removeAttribute('src'); };
      if (d.photo) img.src = d.photo;
      // photo and name open the bien in Property Map, in a tab of its own
      var open = el('a', 'open');
      open.href = d.link; open.target = '_blank'; open.rel = 'noopener';
      open.title = 'Ouvrir ce bien dans Property Map (nouvel onglet)';
      open.appendChild(img);
      row.appendChild(open);
      var tx = el('div', 't');
      var nm = el('a', 'nm', d.name);
      nm.href = d.link; nm.target = '_blank'; nm.rel = 'noopener';
      nm.title = open.title;
      tx.appendChild(nm);
      tx.appendChild(el('span', null, [euro(d.price), d.surface ? d.surface + ' m²' : null,
        d.terrain ? nf.format(d.terrain) + ' m² terrain' : null, d.town].filter(Boolean).join(' · ') +
        (d.sold ? ' · vendu' : '') + (d.hidden ? ' · écarté' : '')));
      var foot = el('span', 'd');
      if (d.delta != null) {
        foot.appendChild(el('span', d.delta === 0 ? 'eq' : null, d.delta === 0 ? 'Même prix'
          : (d.delta > 0 ? '+' : '−') + nf.format(Math.abs(d.delta)) + ' € chez nous'));
      }
      if (d.advert) {
        if (foot.childNodes.length) foot.appendChild(document.createTextNode(' · '));
        var ad = el('a', 'ad', 'annonce ↗');
        ad.href = d.advert; ad.target = '_blank'; ad.rel = 'noopener';
        ad.title = 'L’annonce que nous avons pour ce bien';
        foot.appendChild(ad);
      }
      if (foot.childNodes.length) tx.appendChild(foot);
      row.appendChild(tx);
      var go = el('button', null, 'C’est lui');
      go.onclick = function () {
        go.disabled = true; go.textContent = '…'; err.textContent = '';
        ask({ type: 'attach', id: d.id }, function (r) {
          if (r.ok) { lookup(true); return; }
          go.disabled = false; go.textContent = 'C’est lui';
          err.textContent = r.error || 'Échec, réessaie.';
        });
      };
      row.appendChild(go);
      list.appendChild(row);
    });
    b.appendChild(list);
    b.appendChild(err);
    c.appendChild(b);

    var foot = el('div', 'foot'), alt = el('a', 'alt', 'Non, c’est un nouveau bien  ↗');
    alt.href = addLink(o); alt.target = 'pm'; alt.rel = 'noopener';
    foot.appendChild(alt);
    c.appendChild(foot);
    return c;
  }

  // Not one of ours: offer the biens it looks like, or a way to add it.
  function notYet(at) {
    if (!looksLikeAdvert()) { show(null); return; }
    var o = scrape();
    if (!o.price && !o.surface) { show(addPill(o)); return; }
    ask({ type: 'similar', facts: { price: o.price, surface: o.surface, terrain: o.terrain, rooms: o.rooms, town: o.town } }, function (r) {
      if (at !== location.href) return;
      var twins = r.list || [];
      show(twins.length && !folded[o.url] ? notYetCard(o, twins) : addPill(o));
    });
  }

  function loginPill(app) {
    var a = el('a', 'pill muted');
    a.href = app; a.target = 'pm'; a.rel = 'noopener';
    a.appendChild(el('span', 'dot'));
    a.appendChild(document.createTextNode('Property Map : se connecter pour voir nos notes'));
    return a;
  }

  // Only nag about logging in on something that looks like an advert, not on
  // every search page and home page of the site.
  function looksLikeAdvert() {
    return /\/annonce\/|\/ad\/|\d{7,}(\.htm)?\/?$/.test(location.pathname);
  }

  function urls() {
    var out = [location.href];
    var can = document.querySelector('link[rel="canonical"]');
    var og = document.querySelector('meta[property="og:url"]');
    if (can && can.href) out.push(can.href);
    if (og && og.content) out.push(og.content);
    return out;
  }

  function lookup(fresh) {
    var at = location.href;
    ask({ type: 'lookup', urls: urls(), fresh: !!fresh }, function (r) {
      if (at !== location.href) return;
      if (r.found) show(folded[r.found.id] ? pill(r.found) : card(r.found));
      else if (r.login) show(looksLikeAdvert() ? loginPill(r.login) : null);
      else if (!r.error) notYet(at);
    });
  }

  /* ───────────────────────── tabs on a results page ─────────────────────────
     Every link to an advert is grouped by advert id; the result it belongs to
     is the largest box around it that holds no other advert. The tab sits on
     that box's top edge so it covers none of the site's own content; hovering
     it opens the last comments. A sold one also gets its photo greyed out. */
  var TAB_CSS = TOKENS +
    '.layer{position:absolute;inset:0;pointer-events:none;font:500 12px/1 var(--ui);-webkit-font-smoothing:antialiased}' +
    '.wrap{position:absolute;left:14px;top:-15px;pointer-events:auto}' +
    '.tab{display:inline-flex;align-items:stretch;height:30px;padding:0;border-radius:999px;cursor:pointer;overflow:hidden;' +
      'background:var(--paper);color:var(--ink);border:1px solid var(--rule);font:inherit;white-space:nowrap;' +
      'box-shadow:0 1px 2px oklch(0 0 0/.3),0 6px 14px -4px oklch(0 0 0/.45)}' +
    '.seg{display:flex;align-items:center;gap:6px;padding:0 11px}' +
    '.seg+.seg{border-left:1px solid var(--rule)}' +
    '.brand{font-weight:650;padding-left:10px}' +
    '.dot{width:8px;height:8px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 3px oklch(0.660 0.225 20/.25)}' +
    '.sold{background:var(--sold);color:var(--on-sold);font-weight:800;letter-spacing:.14em}' +
    '.m{gap:5px}.m+.m{border-left:0;padding-left:2px}' +
    '.who{font-size:10.5px;font-weight:650}.who.alex{color:var(--alex)}.who.sam{color:var(--sam)}' +
    '.v{font-size:13px;font-weight:700;color:var(--gold);font-variant-numeric:tabular-nums}.v.none{color:var(--ink-3);font-weight:500}' +
    '.c{color:var(--ink-2);font-weight:600}.c svg{width:13px;height:13px;stroke:currentColor;fill:none;stroke-width:1.8}' +
    '.visit{color:oklch(0.80 0.14 150);font-weight:600}' +
    '.out{background:oklch(0.52 0.03 var(--n));color:oklch(0.98 0.004 var(--n));font-weight:800;letter-spacing:.12em}' +
    '.maybe{font-weight:600;color:var(--ink-2);font-style:italic;max-width:260px;overflow:hidden;text-overflow:ellipsis;display:block;line-height:28px}' +
    '.why{font-size:11.5px;color:var(--ink-3);margin:-4px 0 8px}' +
    '.tab.maybe-tab{border-style:dashed;border-color:var(--accent)}' +
    '.tab:hover{border-color:var(--ink-3)}' +
    '.pop{position:absolute;left:0;top:calc(100% + 8px);width:300px;padding:12px 14px;border-radius:14px;' +
      'background:var(--paper);color:var(--ink);border:1px solid var(--rule);font:400 12.5px/1.45 var(--ui);' +
      'box-shadow:0 18px 40px -12px oklch(0 0 0/.6);opacity:0;visibility:hidden;transform:translateY(-4px);' +
      'transition:opacity .15s,transform .15s,visibility 0s .15s}' +
    '.wrap:hover .pop,.wrap:focus-within .pop{opacity:1;visibility:visible;transform:none;transition:opacity .15s,transform .15s}' +
    '.pop .name{font-weight:650;font-size:13.5px;margin-bottom:8px}' +
    '.note{border-left:2px solid var(--rule);padding-left:9px;margin-bottom:9px}' +
    '.note.alex{border-color:var(--alex)}.note.sam{border-color:var(--sam)}' +
    '.note .hd{font-size:11px;color:var(--ink-3)}.note .hd b{font-weight:650}' +
    '.note.alex .hd b{color:var(--alex)}.note.sam .hd b{color:var(--sam)}' +
    '.note p{color:var(--ink-2);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}' +
    '.hint{color:var(--accent);font-weight:600;font-size:12px}' +
    '.empty{color:var(--ink-3);margin-bottom:8px}' +
    '.veil{position:absolute;inset:0;display:grid;place-items:center;pointer-events:none;background:oklch(0.17 0.014 var(--n)/.32)}' +
    '.veil span,.stamp{padding:9px 18px 9px 24px;border:2px solid oklch(0.985 0 0);border-radius:6px;color:oklch(0.985 0 0);' +
      'background:oklch(0.17 0.014 var(--n)/.55);font:800 18px/1 var(--ui);letter-spacing:.42em}' +
    '.stamp{position:absolute;right:16px;bottom:16px}';

  var tagged = new Map();            // result box → { key, hosts }
  var ours = new WeakSet();          // our own hosts, so adding one is not news
  var RING = '0 0 0 2px oklch(0.660 0.225 20)';
  var RING_SOLD = '0 0 0 2px oklch(0.170 0.014 285)';
  var BUBBLE = '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z" stroke-linejoin="round"/></svg>';

  function resultBox(a, key) {
    var box = a, depth = 0;
    while (box.parentElement && box.parentElement !== document.body && depth++ < 12) {
      var up = box.parentElement;
      if (up.offsetHeight > 1000) break;
      var other = [].some.call(up.querySelectorAll('a[href]'), function (b) {
        var k = keyOf(b.href);
        return k && k !== key;
      });
      if (other) break;
      box = up;
    }
    return box === a ? null : box;
  }

  // The result's main photo, as a rectangle inside the result box.
  function photoRect(box) {
    var best = null, area = 0;
    [].forEach.call(box.querySelectorAll('img'), function (img) {
      var r = img.getBoundingClientRect(), a = r.width * r.height;
      if (r.width >= 120 && r.height >= 90 && a > area) { best = r; area = a; }
    });
    if (!best) return null;
    var o = box.getBoundingClientRect();
    var l = Math.max(best.left, o.left), t = Math.max(best.top, o.top);
    var w = Math.min(best.right, o.right) - l, h = Math.min(best.bottom, o.bottom) - t;
    return w > 0 && h > 0 ? { left: l - o.left, top: t - o.top, width: w, height: h } : null;
  }

  // Sold photos go grey through one page stylesheet, so a picture the carousel
  // loads later is grey too. The label sits at the same level as the tab: the
  // sites stack their own layers over the photo, and anything placed inside
  // them is hidden.
  var greyed = false;
  function greySold() {
    if (greyed) return;
    greyed = true;
    var st = document.createElement('style');
    st.textContent = '[data-pm-sold] img{filter:grayscale(1) brightness(.85)!important}';
    (document.head || document.documentElement).appendChild(st);
  }

  function layerHost(css) {
    var h = document.createElement('div');
    h.style.cssText = 'all:initial;position:absolute;inset:0;pointer-events:none;' + css;
    var r = h.attachShadow({ mode: 'closed' });
    r.innerHTML = '<style>' + TAB_CSS + '</style>';
    ours.add(h);
    return { host: h, root: r };
  }

  function seg(cls, text) { return el('span', 'seg' + (cls ? ' ' + cls : ''), text); }

  function tabFor(d) {
    var L = layerHost('z-index:20'), layer = el('div', 'layer'), wrap = el('div', 'wrap');
    var t = el('button', 'tab' + (d.maybe ? ' maybe-tab' : ''));
    var brand = seg('brand');
    brand.appendChild(el('span', 'dot'));
    brand.appendChild(el('span', null, 'Property Map'));
    t.appendChild(brand);
    if (d.maybe) t.appendChild(seg('maybe', 'Peut-être : ' + d.name));
    if (d.sold) t.appendChild(seg('sold', 'VENDU'));
    if (d.hidden) t.appendChild(seg('out', 'ÉCARTÉ'));
    ['alex', 'sam'].forEach(function (u) {
      var m = seg('m'), v = d.scores[u];
      m.appendChild(el('span', 'who ' + u, USERS[u]));
      m.appendChild(el('span', 'v' + (v == null ? ' none' : ''), mark(v)));
      t.appendChild(m);
    });
    if (d.noteCount) {
      var c = seg('c');
      c.innerHTML = BUBBLE;                          // a constant, not data
      c.appendChild(document.createTextNode(String(d.noteCount)));
      t.appendChild(c);
    }
    if (d.visit && !d.sold && visitText(d.visit, d.visitBy)) t.appendChild(seg('visit', visitText(d.visit, d.visitBy)));
    t.onclick = function (e) { e.preventDefault(); e.stopPropagation(); window.open(d.link, 'pm'); };
    wrap.appendChild(t);

    var pop = el('div', 'pop');
    pop.appendChild(el('div', 'name', d.name));
    if (d.maybe) pop.appendChild(el('div', 'why', 'Lien différent, mais même prix, surface et commune à peu de chose près. À vérifier.'));
    if (d.notes.length) {
      d.notes.slice(-2).reverse().forEach(function (n) {
        var w = el('div', 'note ' + n.user), hd = el('div', 'hd');
        hd.appendChild(el('b', null, USERS[n.user] || n.user));
        hd.appendChild(document.createTextNode(' · ' + ago(n.ts)));
        w.appendChild(hd);
        w.appendChild(el('p', null, n.text));
        pop.appendChild(w);
      });
    } else {
      pop.appendChild(el('div', 'empty', 'Pas encore de commentaire.'));
    }
    pop.appendChild(el('div', 'hint', 'Cliquer pour ouvrir dans Property Map ↗'));
    wrap.appendChild(pop);
    layer.appendChild(wrap);
    L.root.appendChild(layer);
    return L.host;
  }

  function soldMark(box) {
    greySold();
    box.setAttribute('data-pm-sold', '');
    var r = photoRect(box), L = layerHost('z-index:19');
    if (r) {
      L.host.style.left = r.left + 'px'; L.host.style.top = r.top + 'px';
      L.host.style.width = r.width + 'px'; L.host.style.height = r.height + 'px';
      L.host.style.right = 'auto'; L.host.style.bottom = 'auto';
      var v = el('div', 'veil');
      v.appendChild(el('span', null, 'VENDU'));
      L.root.appendChild(v);
    } else {
      L.root.appendChild(el('div', 'stamp', 'VENDU'));
    }
    box.appendChild(L.host);
    return L.host;
  }

  // A result's own facts, read off its text: "350 000 €", "147 m²",
  // "696 m² de terrain", "… Bordeaux (33000)".
  function cardFacts(box) {
    var t = (box.innerText || '').replace(/[  ]/g, ' ');
    var f = {}, m;
    if ((m = t.match(/(\d{1,3}(?: \d{3})+|\d{5,})\s*€/))) f.price = +m[1].replace(/ /g, '');
    if ((m = t.match(/(\d[\d ]{0,6})\s*m²\s*de\s*terrain/i))) f.terrain = +m[1].replace(/ /g, '');
    var sm = t.replace(/(\d[\d ]{0,6})\s*m²\s*de\s*terrain/ig, '').match(/(\d{2,4}(?:[.,]\d+)?)\s*m²/);
    if (sm) f.surface = Math.round(parseFloat(sm[1].replace(',', '.')));
    if ((m = t.match(/(\d+)\s*pièces?/i))) f.rooms = +m[1];
    if ((m = t.match(/([A-Za-zÀ-ÿ'\-]+)\s*\((\d{5})\)/))) f.town = m[1];
    return f;
  }

  // A page stylesheet dims what is ours but set aside, leaving our tab sharp.
  var dimmed = false;
  function dimStyle() {
    if (dimmed) return;
    dimmed = true;
    var st = document.createElement('style');
    st.textContent = '[data-pm-out] > :not([data-pm-host]){opacity:.5}';
    (document.head || document.documentElement).appendChild(st);
  }

  function tagBox(box, k, d) {
    var was = tagged.get(box);
    if (was) was.hosts.forEach(function (h) { h.remove(); });
    if (getComputedStyle(box).position === 'static') box.style.position = 'relative';
    // the rounded corners are often a level or three down, not on the box
    if (getComputedStyle(box).borderRadius === '0px') {
      var inner = [].find.call(box.querySelectorAll(':scope > *, :scope > * > *, :scope > * > * > *'), function (e) {
        return e.offsetWidth >= box.offsetWidth - 4 && getComputedStyle(e).borderRadius !== '0px';
      });
      if (inner) box.style.borderRadius = getComputedStyle(inner).borderRadius;
    }
    // a likely match is only drawn, never acted on: dashed, no greying, no dimming
    box.style.boxShadow = d.maybe ? '' : d.sold ? RING_SOLD : RING;
    box.style.outline = d.maybe ? '2px dashed oklch(0.660 0.225 20)' : '';
    box.style.outlineOffset = d.maybe ? '2px' : '';
    if (d.hidden && !d.maybe) { dimStyle(); box.setAttribute('data-pm-out', ''); }
    else box.removeAttribute('data-pm-out');
    if (!d.sold || d.maybe) box.removeAttribute('data-pm-sold');
    var hosts = [tabFor(d)];
    box.appendChild(hosts[0]);
    if (d.sold && !d.maybe) hosts.push(soldMark(box));
    hosts.forEach(function (h) { h.setAttribute('data-pm-host', ''); });
    tagged.set(box, { key: k, hosts: hosts, maybe: !!d.maybe });
  }

  // Already drawn for this result, still on the page, and not asked to refresh.
  function current(box, k, fresh) {
    var was = tagged.get(box);
    return !fresh && !!was && was.key === k && was.hosts.every(function (h) { return h.isConnected; });
  }

  function scanResults(fresh) {
    var here = keyOf(location.href), byKey = {};
    [].forEach.call(document.querySelectorAll('a[href]'), function (a) {
      var k = keyOf(a.href);
      if (k && k !== here) (byKey[k] = byKey[k] || []).push(a);
    });
    var keys = Object.keys(byKey);
    if (!keys.length) return;
    var sample = keys.map(function (k) { return byKey[k][0].href; });
    ask({ type: 'lookupMany', urls: sample, fresh: !!fresh }, function (r) {
      if (!r.found) return;
      var rest = [], boxes = {};
      keys.forEach(function (k, i) {
        var d = r.found[sample[i]];
        var box = resultBox(byKey[k][0], k);
        if (!box) return;
        if (d) {
          if (!current(box, k, fresh) || tagged.get(box).maybe) tagBox(box, k, d);
          return;
        }
        // Not ours by link. It may still be ours under another agency or a
        // re-listing, which is where a bien we set aside tends to resurface.
        if (current(box, k, fresh)) return;
        var f = cardFacts(box);
        if (!f.price && !f.surface) return;
        boxes[k] = box;
        rest.push({ key: k, facts: f });
      });
      if (!rest.length) return;
      ask({ type: 'similarMany', items: rest }, function (r2) {
        Object.keys(r2.found || {}).forEach(function (k) {
          if (boxes[k] && boxes[k].isConnected) tagBox(boxes[k], k, r2.found[k]);
        });
      });
    });
  }

  var pending = null;
  function rescan() {
    clearTimeout(pending);
    pending = setTimeout(function () { scanResults(false); }, 400);
  }

  // SeLoger and Leboncoin change adverts without a page load, and update the
  // canonical tag a beat after the URL, hence the second look.
  var last = location.href;
  lookup(false);
  setTimeout(function () { lookup(false); }, 2000);
  setInterval(function () {
    if (location.href === last) return;
    last = location.href;
    lookup(false);
    setTimeout(function () { lookup(false); }, 1500);
  }, 800);
  // Results arrive by scroll and by page without a reload: watch for them,
  // and ignore our own insertions so tagging a card does not trigger a rescan.
  new MutationObserver(function (list) {
    for (var i = 0; i < list.length; i++) {
      for (var j = 0; j < list[i].addedNodes.length; j++) {
        var n = list[i].addedNodes[j];
        if (n.nodeType === 1 && n !== host && !ours.has(n)) {
          return rescan();
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
  scanResults(false);

  // Back from the app with a new comment or mark: show it without a reload.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    lookup(true);
    scanResults(true);
  });
})();
