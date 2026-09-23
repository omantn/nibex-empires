// Server-rendered pages for the walking skeleton. A real frontend can replace
// these; live updates already flow over socket.io.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
))

// JSON embedded in a script must never contain a literal HTML closing tag.
const scriptJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')

const CSS = `
  * { box-sizing: border-box; margin: 0; }
  body { background: #0d1117; color: #e6edf3; font-family: system-ui, sans-serif; min-height: 100vh; }
  a { color: #58a6ff; }
  .wrap { max-width: 960px; margin: 0 auto; padding: 24px 16px; }
  h1 { font-size: 1.6rem; margin-bottom: 4px; }
  h2 { font-size: 1.1rem; margin: 20px 0 8px; color: #9ec1ff; }
  .muted { color: #8b949e; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 16px; margin-top: 12px; }
  .row { display: flex; gap: 16px; flex-wrap: wrap; }
  .row > .card { flex: 1 1 280px; }
  input, select, button { font: inherit; padding: 8px 10px; border-radius: 6px; border: 1px solid #30363d; background: #0d1117; color: #e6edf3; }
  button { background: #238636; border-color: #2ea043; cursor: pointer; font-weight: 600; }
  button.danger { background: #b62324; border-color: #da3633; }
  label { display: block; margin: 10px 0 4px; font-size: .9rem; color: #8b949e; }
  .dot { display: inline-block; width: 12px; height: 12px; border-radius: 50%; margin-right: 8px; vertical-align: baseline; }
  ul.roster { list-style: none; } ul.roster li { padding: 4px 0; display: flex; align-items: center; gap: 8px; }
  .emblem { width: 28px; height: 28px; border-radius: 6px; object-fit: cover; flex: none; }
  .emblem.lg { width: 56px; height: 56px; border-radius: 10px; }
  .big { font-size: 2.4rem; font-weight: 700; font-variant-numeric: tabular-nums; }
  .banner { text-align: center; padding: 24px; }
  #ticker li { padding: 3px 0; border-bottom: 1px solid #21262d; font-size: .95rem; }
  .qr { background: #fff; padding: 12px; border-radius: 10px; display: inline-block; }
  .err { color: #ff7b72; margin-top: 8px; }
  .stats { display: flex; align-items: center; gap: 16px; font-size: 1.05rem; flex-wrap: wrap; }
  .btnrow { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  button:disabled { opacity: .4; cursor: default; }
  .qitem { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid #21262d; }
  .qitem button { padding: 3px 12px; background: #30363d; border-color: #484f58; }
`

export function layout(title, body, script = '', { css = '', bare = false } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🏰</text></svg>">
<style>${CSS}${css}</style></head>
<body>${bare ? body : `<div class="wrap">${body}</div>`}
<script src="/socket.io/socket.io.js"></script>
<script>${script}</script></body></html>`
}

// Client-side SVG hex map renderer, shared by dashboard and /play.
const MAP_RENDERER = `
  const TERRAIN_FILL = { plains: '#1a2230', ore: '#2c3a4e', food: '#243d2c', relic: '#3a2d52' };
  const TERRAIN_ICON = { ore: '\\u26cf\\ufe0f', food: '\\ud83c\\udf3e', relic: '\\u2728' };
  const _blendCache = {};
  function ownedFill(color) {
    if (!_blendCache[color]) {
      const f = 0.58, b = [26, 34, 48]; // blend 58% owner color over #1a2230
      const c = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
      _blendCache[color] = '#' + c.map((v, i) => Math.round(v * f + b[i] * (1 - f)).toString(16).padStart(2, '0')).join('');
    }
    return _blendCache[color];
  }
  function renderMap(el, map, players, opts) {
    opts = opts || {};
    if (!el || !map || !map.length) return;
    const S = 24, SQ3 = Math.sqrt(3);
    const byId = {}; players.forEach((p) => byId[p.id] = p);
    const px = (t) => ({ x: S * (SQ3 * t.q + SQ3 / 2 * t.r), y: S * 1.5 * t.r });
    const corners = (x, y) => Array.from({ length: 6 }, (_, i) => {
      const a = Math.PI / 180 * (60 * i - 30);
      return (x + S * 0.95 * Math.cos(a)).toFixed(1) + ',' + (y + S * 0.95 * Math.sin(a)).toFixed(1);
    }).join(' ');
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9, hexes = '', overlays = '';
    let defs = '<marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4.5" markerHeight="4.5" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" fill="#ffffff"/></marker>' +
      '<marker id="arrR" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4.5" markerHeight="4.5" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" fill="#f85149"/></marker>';
    for (const t of map) {
      const { x, y } = px(t);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      const owner = t.owner != null ? byId[t.owner] : null;
      const pts = corners(x, y);
      const qr = ' data-qr="' + t.q + ',' + t.r + '"';
      // Owned tiles: owner color blended over one constant dark base — soft,
      // and the SAME shade across an empire regardless of terrain. Unowned
      // tiles: one uniform dark, always. Terrain lives ONLY in the icon, so
      // color speaks ownership and nothing else.
      const fill = owner ? ownedFill(owner.color) : TERRAIN_FILL.plains;
      hexes += '<polygon' + qr + ' points="' + pts + '" fill="' + fill + '" stroke="#0d1117" stroke-width="1.5"/>';
      if (owner && t.warded) {
        hexes += '<polygon pointer-events="none" points="' + pts + '" fill="none" stroke="' + owner.color + '" stroke-width="2" stroke-dasharray="4 3"/>';
      }
      if (!t.warded && TERRAIN_ICON[t.terrain]) {
        hexes += '<text pointer-events="none" x="' + x + '" y="' + (y + 1) + '" text-anchor="middle" dominant-baseline="middle" font-size="' + (S * 0.62) + '" opacity="0.85">' + TERRAIN_ICON[t.terrain] + '</text>';
      }
      if (t.capital && owner) {
        const R = S * 0.66;
        defs += '<clipPath id="cap' + owner.id + '"><circle cx="' + x + '" cy="' + y + '" r="' + R + '"/></clipPath>';
        overlays += '<g pointer-events="none"><circle cx="' + x + '" cy="' + y + '" r="' + (R + 2) + '" fill="#0d1117" stroke="' + owner.color + '" stroke-width="2.5"/>' +
          '<image href="/emblem/' + owner.id + '" x="' + (x - R) + '" y="' + (y - R) + '" width="' + (R * 2) + '" height="' + (R * 2) + '" clip-path="url(#cap' + owner.id + ')" preserveAspectRatio="xMidYMid slice"/></g>';
      }
      if (opts.selected === t.q + ',' + t.r) {
        overlays += '<polygon pointer-events="none" points="' + pts + '" fill="none" stroke="#ffffff" stroke-width="3"/>';
      }
    }
    for (const m of opts.marks || []) {
      const { x, y } = px(m);
      overlays += '<circle pointer-events="none" cx="' + x + '" cy="' + y + '" r="' + (S * 0.45) + '" fill="none" stroke="#ffffff" stroke-width="2" stroke-dasharray="3 3" opacity="0.9"/>';
    }
    // Valid-destination / inspection highlights (blue by default, callers can
    // recolor; pulse: true makes them flash for find-it-on-the-map moments).
    for (const h of opts.highlights || []) {
      const { x, y } = px(h);
      const c = h.color || '#58a6ff';
      const anim = h.pulse
        ? '<animate attributeName="fill-opacity" values="0.45;0.08;0.45" dur="0.8s" repeatCount="indefinite"/>' +
          '<animate attributeName="stroke-width" values="4;2;4" dur="0.8s" repeatCount="indefinite"/>'
        : '';
      overlays += '<polygon pointer-events="none" points="' + corners(x, y) + '" fill="' + c + '" fill-opacity="0.18" stroke="' + c + '" stroke-width="2.5">' + anim + '</polygon>';
    }
    // Arrows: white = queued moves, red = garrisons a queued attack will pull.
    for (const l of opts.lines || []) {
      const a = px({ q: l.fromQ, r: l.fromR }), b = px({ q: l.toQ, r: l.toR });
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
      const ex = b.x - (dx / len) * S * 0.55, ey = b.y - (dy / len) * S * 0.55;
      const red = l.color === '#f85149';
      overlays += '<line pointer-events="none" x1="' + a.x + '" y1="' + a.y + '" x2="' + ex + '" y2="' + ey +
        '" stroke="' + (l.color || '#ffffff') + '" stroke-width="' + (l.hl ? 3.5 : 2) + '" opacity="' + (l.hl ? 1 : 0.7) +
        '" marker-end="url(#' + (red ? 'arrR' : 'arr') + ')"/>';
    }
    // Event-spotlight icons (crossed swords over a battle site, etc.).
    for (const ic of opts.icons || []) {
      const { x, y } = px(ic);
      overlays += '<text pointer-events="none" x="' + x + '" y="' + y + '" text-anchor="middle" dominant-baseline="middle" font-size="' + (S * 1.15) + '">' + ic.emoji +
        '<animate attributeName="opacity" values="1;0.2;1" dur="0.8s" repeatCount="indefinite"/></text>';
    }
    // Garrison badges: green = yours, red = enemy border intel. Enemy tiles in
    // your intel range show even 0 (undefended!); your own 0s stay clean.
    for (const g of opts.garrisons || []) {
      if (g.own && !g.strength) continue;
      const { x, y } = px(g);
      const by = y + S * 0.45;
      overlays += '<g pointer-events="none"><circle cx="' + x + '" cy="' + by + '" r="' + (S * 0.34) + '" fill="#0d1117" stroke="' + (g.own ? '#3fb950' : g.spy ? '#c297ff' : '#f85149') + '" stroke-width="1.5"/>' +
        '<text x="' + x + '" y="' + (by + 0.5) + '" text-anchor="middle" dominant-baseline="middle" font-size="' + (S * 0.44) + '" fill="#e6edf3" font-weight="700">' + g.strength + '</text></g>';
    }
    const pad = S * 1.4;
    el.setAttribute('viewBox', (minX - pad) + ' ' + (minY - pad) + ' ' + (maxX - minX + pad * 2) + ' ' + (maxY - minY + pad * 2));
    el.innerHTML = '<defs>' + defs + '</defs>' + hexes + overlays;
    if (opts.onClick) el.onclick = (e) => {
      const poly = e.target.closest('[data-qr]');
      if (poly) opts.onClick(poly.getAttribute('data-qr'));
    };
  }
`

// Shared client helpers: countdown + state plumbing.
const CLIENT_HELPERS = `
  const socket = io();
  // Turn every "[ABR]" tag in an (escaped) message into a colored empire chip
  // matching the map, so your eye can jump from text to territory.
  function decorate(escText) {
    return escText.replace(/\\[([A-Z0-9]{2,4})\\]/g, function (m, ab) {
      const p = ((typeof state !== 'undefined' && state.players) || []).find((v) => v.abbr === ab);
      if (!p) return m;
      const rgb = [1, 3, 5].map((i) => parseInt(p.color.slice(i, i + 2), 16));
      const tc = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] > 150 ? '#111' : '#fff';
      return '<span style="background:' + p.color + ';color:' + tc + ';border-radius:3px;padding:0 4px;font-weight:700;font-size:.85em">' + ab + '</span>';
    });
  }
  function fmt(ms) {
    if (ms < 0) ms = 0;
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0') + ':' + String(s % 60).padStart(2,'0');
  }
  let state = window.__STATE__;
  let serverOffset = Date.parse(state.serverNow || new Date().toISOString()) - Date.now();
  const serverTime = () => Date.now() + serverOffset;
  const connection = document.getElementById('connection');
  socket.on('connect', () => { if (connection) connection.textContent = 'Connected · orders saved on the server'; });
  socket.on('disconnect', () => { if (connection) connection.textContent = 'Disconnected · reconnecting. Refresh before retrying an uncertain order.'; });
  socket.on('state', (s) => { state = s; serverOffset = Date.parse(s.serverNow) - Date.now(); render(); });
`

// TV layout: fills the screen exactly (16:9, no scrolling), map left,
// countdown + ranked leaderboard right, news-crawl ticker pinned to the bottom.
const TV_CSS = `
  html, body { height: 100%; overflow: hidden; }
  .tv { display: flex; flex-direction: column; height: 100vh; }
  .tv-head { display: flex; align-items: baseline; gap: 18px; padding: 12px 20px 8px; }
  .tv-head h1 { font-size: 1.5rem; letter-spacing: .14em; }
  .tv-lobby { flex: 1; display: none; flex-direction: column; align-items: center; justify-content: center; gap: 16px; text-align: center; }
  .tv-lobby .count { font-size: 1.5rem; color: #9ec1ff; }
  .tv-main { flex: 1; display: none; gap: 14px; padding: 0 20px 14px; min-height: 0; }
  .mapwrap { flex: 1; background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 6px; min-width: 0; }
  .mapwrap svg { width: 100%; height: 100%; display: block; }
  .tv-side { width: 350px; display: flex; flex-direction: column; gap: 12px; min-height: 0; }
  .tv-side .card { margin-top: 0; }
  .lb { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
  .lb ol { list-style: none; margin-top: 8px; overflow: hidden; flex: 1; min-height: 0; display: flex; flex-direction: column; justify-content: flex-start; }
  .lb li { display: flex; align-items: center; gap: 8px; white-space: nowrap; padding: 3px 0; }
  .lb .rank { width: 1.5em; text-align: right; color: #8b949e; font-variant-numeric: tabular-nums; flex: none; }
  .lb .name { overflow: hidden; text-overflow: ellipsis; }
  .lb .score { margin-left: auto; font-weight: 700; font-variant-numeric: tabular-nums; padding-left: 10px; }
  .lb .emblem { width: 1.9em; height: 1.9em; border-radius: .4em; }
  .tickerbar { height: 46px; background: #161b22; border-top: 1px solid #30363d; overflow: hidden; display: flex; align-items: center; }
  .cf { position: fixed; top: -24px; width: 10px; height: 16px; z-index: 50; animation: cffall linear forwards; }
  @keyframes cffall { to { transform: translateY(112vh) rotate(900deg); } }
  #finaleStage { flex: 1; display: none; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 10px; }
  .track { display: inline-block; white-space: nowrap; animation: crawl linear infinite; font-size: 1.05rem; }
  .track span { padding-right: 60px; }
  @keyframes crawl { from { transform: translateX(0); } to { transform: translateX(-50%); } }
`

export function dashboardPage(state, joinUrl, qrDataUrl, events) {
  const body = `
  <div class="tv">
    <div class="tv-head">
      <h1>NIBEX: EMPIRES</h1>
      <div class="muted" id="phaseline"></div>
    </div>
    <div class="tv-lobby" id="lobby">
      <h2 style="font-size:1.6rem">Scan to join the game</h2>
      <div class="qr"><img src="${qrDataUrl}" width="320" height="320" alt="QR"></div>
      <div class="muted">${esc(joinUrl)}</div>
      <div class="count" id="lobbycount"></div>
    </div>
    <div id="finaleStage"></div>
    <div class="tv-main" id="live">
      <section class="mapwrap"><svg id="map"></svg></section>
      <aside class="tv-side">
        <div class="card" style="text-align:center"><div class="muted" id="countlabel"></div><div class="big" id="countdown">--:--:--</div><div class="muted" id="readyline" style="font-size:.85rem"></div></div>
        <div class="card lb"><h2>Leaderboard <small style="font-size:.65em;font-weight:400">rotates every 10s</small></h2><ol id="roster"></ol></div>
      </aside>
    </div>
    <footer class="tickerbar"><div class="track" id="track"></div></footer>
  </div>`
  const script = `
    window.__STATE__ = ${scriptJson(state)};
    ${MAP_RENDERER}
    ${CLIENT_HELPERS}
    const escH = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');
    let tickerEvents = ${scriptJson(events.map(({ id, tick, type, message, data }) => ({ id, tick, type, message, data })).reverse())};
    // Each turn's resolution replaces the crawl — the ticker shows THIS turn's
    // news, not history.
    if (tickerEvents.length) {
      const maxTick = Math.max.apply(null, tickerEvents.map((e) => e.tick || 0));
      const latest = tickerEvents.filter((e) => (e.tick || 0) === maxTick);
      if (latest.length) tickerEvents = latest;
    }
    let curTick = tickerEvents.length ? (tickerEvents[tickerEvents.length - 1].tick || 0) : 0;
    // Spotlight is driven by the crawl itself: whatever ticker item is
    // entering from the RIGHT edge is the live event — it glows gold and its
    // tiles flash on the map, until the next item enters and takes over.
    const locatable = (e) => e && e.data && e.data.tiles && e.data.tiles.length;
    let spot = null;
    function spotOpts() {
      if (!locatable(spot)) return {};
      const emoji = spot.type === 'battle' ? '\\u2694\\ufe0f' : spot.type === 'standoff' ? '\\ud83c\\udff3\\ufe0f' : spot.type === 'support' ? '\\ud83e\\udd1d' : null;
      const pl = spot.data.player != null ? state.players.find((p) => p.id === spot.data.player) : null;
      const color = spot.type === 'expand' ? (pl ? pl.color : '#3fb950') : '#f85149';
      return {
        highlights: spot.data.tiles.map((t) => ({ q: t.q, r: t.r, color: color, pulse: true })),
        icons: emoji ? spot.data.tiles.map((t) => ({ q: t.q, r: t.r, emoji: emoji })) : [],
      };
    }
    function applySpot() {
      document.querySelectorAll('#track span[data-eid]').forEach((s) => {
        const on = spot && Number(s.getAttribute('data-eid')) === spot.id;
        s.style.color = on ? '#ffd700' : '';
        s.style.fontWeight = on ? '700' : '';
      });
    }
    function renderTicker() {
      const seg = tickerEvents.map((e) => '<span data-eid="' + e.id + '">' + decorate(escH(e.message)) + '</span>').join('');
      const track = document.getElementById('track');
      track.innerHTML = seg + seg;
      track.style.animationDuration = Math.max(20, tickerEvents.map((e) => e.message).join('').length * 0.28) + 's';
      applySpot();
    }
    socket.on('event', (e) => {
      if ((e.tick || 0) > curTick) { curTick = e.tick || 0; tickerEvents = []; }
      tickerEvents.push(e);
      while (tickerEvents.length > 40) tickerEvents.shift();
      renderTicker();
    });
    // The rightmost span whose left edge has crossed into the bar is the one
    // currently entering from the right.
    function enteringEid() {
      const bar = document.querySelector('.tickerbar').getBoundingClientRect();
      let best = null, bestLeft = -Infinity;
      document.querySelectorAll('#track span[data-eid]').forEach((s) => {
        const r = s.getBoundingClientRect();
        if (r.left <= bar.right && r.left > bestLeft) { bestLeft = r.left; best = s; }
      });
      return best ? Number(best.getAttribute('data-eid')) : null;
    }
    setInterval(() => {
      const eid = enteringEid();
      if (eid == null || (spot && spot.id === eid)) return;
      const ev = tickerEvents.find((e) => e.id === eid);
      // Dull items (turn markers, joins) don't steal the stage: the last
      // event WITH a map location keeps flashing until the next one enters.
      if (!ev || !locatable(ev)) return;
      spot = ev;
      render();
      applySpot();
    }, 300);
    window.__dbg = () => ({ spotId: spot && spot.id, spotType: spot && spot.type, tickerIds: tickerEvents.map((e) => e.id) });
    function render() {
      document.getElementById('lobby').style.display = state.phase === 'lobby' ? 'flex' : 'none';
      document.getElementById('live').style.display = state.phase === 'lobby' || state.phase === 'finale' ? 'none' : 'flex';
      document.getElementById('finaleStage').style.display = state.phase === 'finale' ? 'flex' : 'none';
      document.getElementById('phaseline').textContent =
        state.phase === 'lobby' ? 'Waiting for launch' :
        state.phase === 'running' ? (state.nightfall.active ? 'NIGHTFALL' : 'Turn ' + state.tick) :
        'FINALE — the relics are revealed!';
      document.getElementById('lobbycount').textContent = state.playerCount + ' player' + (state.playerCount === 1 ? '' : 's') + ' registered';
      const ranked = state.players.slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.id - b.id);
      document.getElementById('roster').innerHTML = ranked.slice(lbPage() * lbSize(), (lbPage()+1) * lbSize()).map((p, i) =>
        '<li><span class="rank">' + (i + 1 + lbPage()*lbSize()) + '</span><img class="emblem" src="/emblem/' + p.id + '" alt="">' +
        '<span class="name">' + escH(p.empire) + ' <span class="muted">[' + escH(p.abbr) + ']</span></span>' +
        '<span class="score">' + (p.score ?? 0) + '</span></li>').join('');
      fitLB();
      renderMap(document.getElementById('map'), state.map, state.players, spotOpts());
    }
    // Shrink leaderboard type until every player fits the panel, whatever the screen.
    function lbSize() { return Math.max(3,Math.floor((document.getElementById('roster').clientHeight || 360)/46)); }
    function lbPage() { return Math.floor(serverTime()/10000) % Math.max(1,Math.ceil(state.players.length/lbSize())); }
    function fitLB() { document.getElementById('roster').style.fontSize = '1.1rem'; }
    setInterval(() => { if (state.phase === 'running') render(); },10000);
    window.addEventListener('resize', fitLB);
    // ------ Finale ceremony: shared-clock playback, last place -> champion.
    const PER_RANK = 13500;
    let lastFinaleKey = '';
    const frow = (label, v) => '<div style="font-size:1.6rem"><span class="muted">' + label + ':</span> <b>' + v + '</b></div>';
    function renderFinale() {
      const st = document.getElementById('finaleStage');
      if (!state.finale) {
        if (lastFinaleKey !== 'wait') {
          lastFinaleKey = 'wait';
          st.innerHTML = '<div style="font-size:3rem;letter-spacing:.18em;font-weight:800">\\ud83c\\udfc1 AWAITING FINAL TALLY</div>' +
            '<div class="muted" style="font-size:1.3rem">The realm is locked. No more moves. The envelope is sealed\\u2026</div>';
        }
        return;
      }
      const data = state.finale.data, n = data.length;
      const elapsed = serverTime() - new Date(state.finale.startedAt).getTime();
      const idx = Math.floor(elapsed / PER_RANK);
      if (idx >= n) { renderChampion(data); return; }
      const p = data[idx], within = elapsed - idx * PER_RANK, rank = n - idx;
      const stageBits = [1500, 3000, 4200, 5400, 6400, 7600, 10000].map((t) => within > t ? 1 : 0).join('');
      const key = idx + ':' + stageBits;
      if (key === lastFinaleKey) return;
      lastFinaleKey = key;
      const lines = ['<div style="font-size:4rem;font-weight:900">' + (rank === 1 ? '\\ud83c\\udfc6 THE CHAMPION' : '#' + rank) + '</div>'];
      if (within > 1500 && p.territory != null) lines.push(frow('\\ud83c\\udf0d Territory', p.territory));
      if (within > 3000 && p.resources != null) lines.push(frow('\\u26cf\\ufe0f\\ud83c\\udf3e Stockpiles', p.resources));
      if (within > 4200 && p.army != null) lines.push(frow('\\u2694\\ufe0f Armies', p.army || 0));
      if (within > 5400 && p.relics != null) lines.push(frow('\\ud83d\\udddd\\ufe0f Relics \\u2014 hidden until now', p.relics));
      if (within > 6400 && p.total != null) lines.push('<div style="font-size:2.6rem;font-weight:800;margin-top:6px">Total: ' + p.total + '</div>');
      if (within > 7600 && p.empire != null) {
        lines.push('<div style="display:flex;align-items:center;gap:16px;margin-top:16px;justify-content:center">' +
          '<img class="emblem lg" src="/emblem/' + p.id + '" alt="">' +
          '<span style="font-size:2.6rem;font-weight:900">' + escH(p.empire) + ' <span class="muted">[' + escH(p.abbr) + ']</span></span></div>');
      }
      if (within > 10000 && p.name != null) {
        lines.push('<div style="font-size:2.2rem;margin-top:12px">played by\\u2026 <span style="color:#ffd700;font-weight:900">' + escH(p.name) + '</span></div>');
        if (rank === 1) boom();
      } else if (within > 7600 && p.empire != null) {
        lines.push('<div class="muted" style="font-size:1.5rem;margin-top:14px">\\u2026but WHO played it?</div>');
      }
      st.innerHTML = '<div>' + lines.join('') + '</div>';
    }
    function renderChampion(data) {
      const page = Math.floor(serverTime()/8000) % Math.max(1,Math.ceil(data.length/6));
      if (lastFinaleKey === 'champ'+page) return;
      lastFinaleKey = 'champ'+page;
      const w = data[data.length - 1];
      const standings = data.slice().reverse().slice(page*6,page*6+6).map((p, i) =>
        '<div style="display:flex;gap:10px;align-items:center;justify-content:center;font-size:1.05rem">' +
        '<span class="muted" style="width:2em;text-align:right">' + (page*6 + i + 1) + '</span>' +
        '<img class="emblem" src="/emblem/' + p.id + '" alt=""><span>' + escH(p.empire) + '</span>' +
        '<span class="muted">\\u2014 ' + escH(p.name) + '</span>' +
        '<b>' + p.total + '</b><span class="muted" style="font-size:.85rem">(' + p.territory + ' + ' + p.resources + ' + \\u2694\\ufe0f' + (p.army || 0) + ' + \\ud83d\\udddd\\ufe0f' + p.relics + ')</span></div>').join('');
      document.getElementById('finaleStage').innerHTML =
        '<div style="font-size:3.4rem;font-weight:900">\\ud83c\\udfc6 CHAMPION OF NIBEX</div>' +
        '<div style="display:flex;align-items:center;gap:18px;justify-content:center;margin:8px 0">' +
        '<img class="emblem lg" src="/emblem/' + w.id + '" style="width:84px;height:84px" alt="">' +
        '<span style="font-size:3rem;font-weight:900">' + escH(w.empire) + '</span></div>' +
        '<div style="font-size:2rem;margin:4px 0">played by\\u2026 <span style="color:#ffd700;font-weight:900">' + escH(w.name) + '</span></div>' +
        '<div style="font-size:1.8rem"><b>' + w.total + '</b> points \\u2014 the cup awaits a new plaque.</div>' +
        '<div style="margin-top:14px;max-height:38vh;overflow:hidden">' + standings + '</div>';
      boom();
    }
    let boomed = false;
    function boom() {
      if (boomed) return;
      boomed = true;
      const colors = ['#e6194b','#ffe119','#4363d8','#3cb44b','#f58231','#911eb4','#42d4f4','#f032e6'];
      for (let i = 0; i < 120; i++) {
        const c = document.createElement('div');
        c.className = 'cf';
        c.style.left = Math.random() * 100 + 'vw';
        c.style.background = colors[i % colors.length];
        c.style.animationDuration = (2.5 + Math.random() * 3) + 's';
        c.style.animationDelay = (Math.random() * 4) + 's';
        document.body.appendChild(c);
        setTimeout(() => c.remove(), 11000);
      }
      setTimeout(() => { boomed = false; }, 13000);
    }
    setInterval(() => {
      // Late layout shifts (emblem images, font loads) can regrow rows — self-heal.
      const ol = document.getElementById('roster');
      if (ol.scrollHeight > ol.clientHeight) fitLB();
      if (state.phase === 'lobby') return;
      const el = document.getElementById('countdown'), lb = document.getElementById('countlabel');
      if (state.phase === 'finale') { renderFinale(); return; }
      const night = state.nightfall.active;
      lb.textContent = state.paused ? 'PAUSED BY HOST' : night ? 'NIGHTFALL — DAYBREAK IN' : 'NEXT TURN IN';
      const target = night ? state.daybreakAt : state.nextTickAt;
      el.textContent = state.paused ? '—' : target ? fmt(new Date(target) - serverTime()) : '--:--:--';
      const rl = document.getElementById('readyline');
      const et = state.endTurn;
      rl.textContent = state.rehearsal && !night && et && et.humans > 0 ? '\\u2705 ' + et.ready + '/' + et.humans + ' ready to end turn' : '';
    }, 250);
    render();
    renderTicker();`
  return layout('Nibex: Empires — Dashboard', body, script, { css: TV_CSS, bare: true })
}

export function joinPage({ error = '', loginError = '', canCreate = true } = {}) {
  const create = canCreate ? `
    <form class="card" method="post" action="/join" enctype="multipart/form-data">
      <h2>Found a new empire</h2>
      <p class="muted">Your real name stays private until the finale reveals who played each empire.</p>
      <label>Your name (revealed at the finale)</label><input aria-label="Your name (revealed at the finale)" name="name" maxlength="60" required maxlength="40" autocomplete="name">
      <label>Empire name</label><input aria-label="Empire name" name="empire" maxlength="40" required maxlength="30" placeholder="The Noodle Empire">
      <label>Abbreviation (2–4 letters)</label><input aria-label="Abbreviation (2–4 letters)" name="abbr" required minlength="2" maxlength="4" style="text-transform:uppercase" placeholder="NDL">
      <label>Create a 4-digit PIN — lets you reconnect from another device</label><input aria-label="Create a 4-digit PIN — lets you reconnect from another device" name="pin" required pattern="[0-9]{4}" inputmode="numeric" maxlength="4" type="password" placeholder="0000">
      <p class="muted" style="margin-top:10px">Your banner is generated automatically — your abbreviation on your empire's color.</p>
      ${error ? `<div class="err">${esc(error)}</div>` : ''}
      <div style="margin-top:16px"><button type="submit">Found my empire</button></div>
    </form>` : `
    <div class="card"><p class="muted">🔒 The empire rolls are closed — no new empires can be founded right now.
    If you already have one, reconnect below.</p>${error ? `<div class="err">${esc(error)}</div>` : ''}</div>`
  const body = `
    <h1>Join Nibex: Empires</h1>
    ${create}
    <form class="card" method="post" action="/login">
      <h2>Reconnect to your empire</h2>
      <p class="muted">Already founded an empire? Enter its abbreviation and your PIN.</p>
      <label>Empire abbreviation</label><input aria-label="Empire abbreviation" name="abbr" required maxlength="4" style="text-transform:uppercase" placeholder="NDL">
      <label>Your 4-digit PIN</label><input aria-label="Your 4-digit PIN" name="pin" required pattern="[0-9]{4}" inputmode="numeric" maxlength="4" type="password">
      ${loginError ? `<div class="err">${esc(loginError)}</div>` : ''}
      <div style="margin-top:16px"><button type="submit">Reconnect</button></div>
    </form>`
  return layout('Join — Nibex: Empires', body)
}

export function playPage(player, state, me) {
  const body = `
    <div style="display:flex;align-items:center;gap:12px">
      <img class="emblem lg" src="/emblem/${player.id}" alt="">
      <div>
        <h1>${esc(player.empire)} <span class="muted">[${esc(player.abbr)}]</span></h1>
        <p class="muted">Sovereign: ${esc(player.name)}</p>
      </div>
      <form method="post" action="/logout" style="margin-left:auto" onsubmit="return confirm('Log out of this device? Reconnect anytime with your abbreviation + PIN.')">
        <button style="background:#30363d;border-color:#484f58;padding:4px 12px">Log out</button>
      </form>
    </div>
    <div class="card stats">
      <span>⚡ <b id="oleft">0</b> orders</span>
      <span>⛏️ <b id="ore">0</b> ore</span>
      <span>🌾 <b id="food">0</b> food</span>
      <span id="msgBadge" style="display:none;cursor:pointer;background:#1f4a7a;border-radius:12px;padding:2px 10px">✉️ <b id="msgBadgeN">0</b></span>
      <span class="muted" style="margin-left:auto" id="countmini">--:--:--</span>
    </div>
    <div class="card stats">
      <button id="btnReady">✅ End turn</button>
      <span class="muted" id="readyinfo"></span>
      <p id="connection" class="muted" role="status">Connecting…</p>
      <p class="muted">Public score: <b id="myScore">0</b> · relic points stay secret</p>
      <span id="oathline" style="color:#f0b72f"></span>
    </div>
    <div class="card">
      <h2>Your map</h2>
      <p class="muted">Tap land to act. Plan a chain of expansions; one frontier advances each turn.</p>
      <div class="btnrow" id="maptools" aria-label="Map controls">
        <button type="button" id="mapHome">My empire</button><button type="button" id="mapWorld">World</button>
        <button type="button" data-zoom="0.75" aria-label="Zoom in">+</button><button type="button" data-zoom="1.333" aria-label="Zoom out">−</button>
      </div>
      <div class="btnrow" aria-label="Pan map"><button type="button" data-pan="-1,0" aria-label="Pan left">←</button><button type="button" data-pan="0,-1" aria-label="Pan up">↑</button><button type="button" data-pan="0,1" aria-label="Pan down">↓</button><button type="button" data-pan="1,0" aria-label="Pan right">→</button></div>
      <svg id="map" role="img" aria-label="Empire map; use map controls to zoom and pan" style="width:100%;height:400px;display:block"></svg>
      <div id="tileinfo" class="muted" style="margin-top:10px">Tap a tile to give an order.</div>
      <div class="btnrow">
        <button id="btnExpand" disabled>🌍 Expand here</button>
        <button id="btnMuster" disabled>🛠️ Muster (⛏️ each)</button>
        <input type="number" id="musterAmt" min="1" value="1" style="width:70px" title="How many to muster">
      </div>
      <div class="btnrow">
        <button id="btnAttack" disabled>⚔️ Attack from here (1 🌾)</button>
        <button id="btnSpy" disabled>🕵️ Spy (1 🌾)</button>
      </div>
      <div id="attackbar" style="display:none;margin-top:8px">
        <div class="muted" id="attackhint"></div>
        <div class="btnrow">
          <input type="number" id="attackAmt" min="1" value="1" style="width:80px" title="How many march">
          <select id="supportSel"><option value="">For your own glory</option></select>
        </div>
        <div class="btnrow"><button id="btnAttackConfirm" disabled>Confirm march (1 🌾)</button><button id="btnAttackCancel" class="danger">Cancel</button></div>
      </div>
      <div class="btnrow">
        <button id="btnMove" disabled>🚚 Move troops from here</button>
        <button id="btnRaid" disabled>🏇 Raid from here</button>
      </div>
      <div id="raidbar" style="display:none;margin-top:8px">
        <div class="muted" id="raidhint"></div>
        <div class="btnrow"><button id="btnRaidConfirm" disabled>Confirm raid (50/50)</button><button id="btnRaidCancel" class="danger">Cancel</button></div>
      </div>
      <div id="movebar" style="display:none;margin-top:8px">
        <div class="muted" id="movehint"></div>
        <div class="btnrow">
          <input type="number" id="moveAmt" min="1" value="1" style="width:90px">
          <button id="btnMoveConfirm" disabled>Confirm move</button>
          <button id="btnMoveCancel" class="danger">Cancel</button>
        </div>
      </div>
      <div id="orderr" class="err"></div>
    </div>
    <div class="card">
      <h2>⚖️ Market</h2>
      <div class="btnrow">
        <input type="number" id="tradeN" min="1" max="100" value="1" style="width:70px" title="How many trades">
        <button id="btnF2O">5 🌾 → 1 ⛏️</button>
        <button id="btnO2F">1 ⛏️ → 5 🌾</button>
      </div>
      <div class="muted" style="margin-top:6px;font-size:.85rem">Instant, any time. Surrounded and starving for ore? Sell the harvest, raise the army.</div>
      <div id="tradeerr" class="err"></div>
    </div>
    <div class="card"><h2>📰 Your news</h2><div id="news" class="muted">Nothing yet — news lands after each turn.</div></div>
    <div class="card"><h2>Queued orders</h2><div id="queue" class="muted">None — they resolve at the next turn.</div></div>
    <div class="card">
      <details>
        <summary style="cursor:pointer"><b>❓ How to play</b></summary>
        <div style="margin-top:10px;display:flex;flex-direction:column;gap:10px" class="help">
          <p><b>Turns.</b> The world advances every ${state.tickIntervalMin} minutes on the host's schedule. Attacks depart together; submitting first provides no combat advantage.</p>
          <p><b>Your orders.</b> You receive ${state.ordersPerDay} orders at launch and each Daybreak. Unused orders expire; queued plans carry forward. Cancelling an older day's plan refunds resources but not today's orders. Spending more time in the app gives no extra orders, though reacting to new information can still help.</p>
          <p><b>Plan ahead.</b> Queue a connected chain of expansions into unclaimed land. Only tiles touching your land at the start of the turn resolve; later steps wait for future turns. If another empire blocks the route, cancel or replan its remaining steps.</p>
          <p><b>🌍 Expand</b> — claim an unclaimed tile touching your territory. Free. If two empires
          grab the same tile on the same turn, it's a standoff: nobody gets it and everyone's order
          is wasted. Coordinate… or don't. You can also <b>Attack</b> an unclaimed tile to take it
          by force — your troops march in and garrison it, and <b>soldiers beat settlers</b>: an
          armed claim wins over any bare expansion on the same turn.</p>
          <p><b>🛠️ Muster</b> — raise garrison strength on one of your tiles (even inside your
          ward: a warded army is a hidden breakout force). Pick the quantity: mustering 4 costs
          4 ⛏️ but only <i>one</i> order. Musters land <i>before</i> battles, so troops mustered
          on a tile under attack secretly join its defense that same turn — but recruits can
          never join a march: attacks only commit strength that existed when you queued them.
          Raise today, defend today, invade tomorrow.</p>
          <p><b>🏇 Raid</b> — pick your garrisoned tile, then an adjacent enemy tile <i>with
          troops on it</i>: you're hitting the supply line that feeds them. 50/50 odds. Win:
          plunder resources straight from their treasury. Lose: 1 of your strength. Raids are
          overt — the victim always knows it was you, and raiding a pact partner breaks the
          pact.</p>
          <p><b>🕵️ Spy</b> — spend 1 🌾 to scout an enemy tile within 3 of your territory. The
          report marks garrisons on that tile and its neighbors right on your map (purple badges)
          — but only for that turn, so act on it. Spies get caught 1 time in 4, and a caught spy
          tells the victim exactly who sent it.</p>
          <p><b>🌙 Heist</b> — send thieves (1 🌾) against another empire's relic vault. Thieves
          work only at night: heists resolve at Daybreak, the victim must have unwarded land
          within 2 of yours, and a vault can lose at most one relic per night — if two crews hit
          the same vault, everyone flees empty-handed. Get caught (it happens) and the whole
          world hears about it. Succeed, and nobody ever knows it was you.</p>
          <p><b>⚔️ Attack</b> — select <b>your</b> garrisoned tile, tap Attack from here, then a
          glowing adjacent target, and choose <b>how many march</b> (1 🌾 per march). Committed
          troops leave home for the whole turn — the rest stay and defend. Want a converging
          assault? Queue attacks from several tiles at the same target: the columns merge into
          one army. Both sides roll fortune (±20%); the defender wins ties; the winner takes the
          tile with the survivors. You can only commit strength that exists when you queue —
          fresh musters defend the turn they're raised, but can't march until the next.</p>
          <p><b>🚚 Move</b> — shift as many or as few troops as you like between your own tiles:
          adjacent, or up to 2 tiles away if the path runs through your territory. Free (just an
          order). Valid destinations glow blue when you're choosing; queued moves draw arrows on
          your map, and tapping any queued order highlights where it will happen.</p>
          <p><b>🤝 In support of.</b> An attack can be declared in support of another empire —
          your force joins <i>their</i> attack on that tile instead of fighting for you. If they
          never march, your army fights alone (you came to help; you might accidentally conquer).
          Support declarations are announced on the ticker after the battle. Promise wisely.</p>
          <p><b>⏱️ How a turn resolves.</b> Fixed order, every turn: <b>production → expansions →
          musters → battles → moves → raids → spies → Daybreak heists</b>. What that means for you: a muster on a tile
          attacked the same turn joins the defense <i>before</i> the battle — the garrison your
          enemy scouted isn't necessarily the garrison they'll fight (and mustered ore is never
          refunded if the tile falls: your troops died fighting). Attacks march only the troops
          you committed; everyone else stays home on the walls. Moves happen <i>after</i> the
          fighting: never swept into a march, able to backfill a border or garrison a tile you
          captured this very turn. Attack survivors hold the tile they take automatically. Event turns run on schedule. Rehearsal mode alone permits early turns.</p>
          <p><b>👁️ Intel &amp; fog.</b> You always see your own garrison numbers (green badges).
          Enemy tiles touching your territory show theirs too (red badges) — border intel. Deeper
          enemy land is fog, and <i>nobody</i> can ever see inside a ward. What no one ever sees:
          orders queued for the next turn.</p>
          <p><b>Resources.</b> Every ⛏️ ore and 🌾 food tile you hold produces +1 per turn,
          automatically — and your capital always provides +1 ⛏️ and +1 🌾 per turn no matter
          what, even if you're surrounded. Ore builds armies; food feeds marches and skulduggery.</p>
          <p><b>⚖️ The Market.</b> Trade instantly, any time: 5 🌾 for 1 ⛏️, or 1 ⛏️ for 5 🌾.
          No order needed. A besieged empire can sell its harvest and raise an army the same
          turn — you're never locked out of war by the wrong treasury.</p>
          <p><b>🛡️ Your ward.</b> Your capital and its ring can never be attacked or taken — you can
          always come back. Warded land produces nothing and scores nothing, but it can garrison:
          a lifeboat with an army in it. Its stipend and armies still contribute to your resource score.</p>
          <p><b>🤝 Diplomacy.</b> Message any empire privately — deals, threats, lies, all fair
          game (and the ONLY way to talk: that's the rules). Propose a <b>pact of non-aggression</b>;
          pacts are public but <i>unenforced</i>. Withdrawing openly is honorable. Attacking a pact
          partner (or getting your thief caught in their vault) brands you <b>⚡ OATHBREAKER</b>:
          the whole world is told, and fortune abandons your attacks for 6 turns — your luck rolls
          lose their upside. Betrayal is legal. It's just expensive.</p>
          <p><b>🗺️ Reading the map.</b> Dark tiles are plains. ⛏️ and 🌾 tiles produce ore and
          food. ✨ tiles are <b>relic sites</b> — strange, valuable ground in the rich center;
          holding one can complete a quest. Colored tiles belong to empires, dashed outlines
          are wards, and the small circled numbers are garrisons (green yours, red enemies).</p>
          <p><b>📜 Quests &amp; relics.</b> The game deals you quests (a few per day) — hold a relic
          site, grow your empire, win a battle, camp on a rival's border… Completing one banks a
          <b>🗝️ relic</b> in your vault. Relics are worth points that <i>nobody</i> knows — not
          even you — and they're added to the tally only at the finale. The leaderboard on the TV
          is not the whole truth. You can abandon a quest you hate, but it counts against the
          day's deals.</p>
          <p><b>Scoring.</b> 1 point per tile you hold outside your ward, +1 extra for tiles in the
          rich center. Pool ore, food, and armies at the market rate: 5 ore = 25 food = 5 strength = 1 point, rounding down once for the whole pool. Trades and resolved musters preserve that value; battle losses reduce it. Relic points reveal at the finale — the leaderboard can lie.</p>
        </div>
      </details>
    </div>
    <div class="card">
      <h2>📜 Quest <span class="muted" style="float:right;font-size:.9rem">🗝️ Relics: <b id="relics">0</b></span></h2>
      <div id="questbox" class="muted">No quest yet — one arrives with the next turn.</div>
    </div>
    <div class="card">
      <h2>🌙 Night operations</h2>
      <p class="muted" style="margin-bottom:8px">Queue thieves any time — heists resolve only at Daybreak. One crew per night; if two crews hit the same vault, everyone flees.</p>
      <div class="btnrow">
        <select id="heistSel"></select>
        <button id="btnHeist">🗝️ Send thieves (1 🌾)</button>
      </div>
      <div id="heisterr" class="err"></div>
    </div>
    <div class="card">
      <h2 id="diploHead">🤝 Diplomacy <span id="diploBadge" style="display:none;color:#58a6ff;font-size:.9rem"></span></h2>
      <div class="btnrow"><select id="diploSel" style="flex:1"><option value="">— choose an empire —</option></select></div>
      <div id="pactline" class="muted" style="margin:8px 0"></div>
      <div id="pactbtns" class="btnrow"></div>
      <div id="pactlist" style="margin-top:8px"></div>
      <div id="thread" style="display:none;max-height:240px;overflow-y:auto;background:#0d1117;border-radius:8px;padding:8px;margin-top:8px"></div>
      <div class="btnrow"><input id="msgBody" maxlength="500" placeholder="Message…" style="flex:1"><button id="btnSend" disabled>Send</button></div>
      <div id="diploerr" class="err"></div>
    </div>`
  const script = `
    window.__STATE__ = ${scriptJson(state)};
    ${MAP_RENDERER}
    ${CLIENT_HELPERS}
    let ME = ${scriptJson(me)};
    let sel = null;
    let mapCenter = null, overview = false, mapWidth = 260;
    const centerOn = (t) => { if (t) mapCenter = {x:24*Math.sqrt(3)*(t.q+t.r/2),y:36*t.r}; };
    function applyMapView() {
      if (overview || !state.map.length) return;
      if (!mapCenter) centerOn(state.map.find(t => t.owner === ME.id && t.capital));
      if (!mapCenter) return;
      const el=document.getElementById('map');
      const h=mapWidth * (el.clientHeight/Math.max(1,el.clientWidth));
      el.setAttribute('viewBox',[mapCenter.x-mapWidth/2,mapCenter.y-h/2,mapWidth,h].join(' '));
    }
    let moveFrom = null;
    let raidFrom = null;
    let attackFrom = null;
    let hl = null;
    let nhl = null;
    const reservedOut = (qr) => {
      const [q0, r0] = qr.split(',').map(Number);
      return ME.orders.filter((o) => (o.type === 'move' || o.type === 'attack') && o.src_q === q0 && o.src_r === r0)
        .reduce((s, o) => s + (o.amount || 0), 0);
    };
    const availableAt = (qr) => {
      const g = ME.garrisons.find((v) => v.own && qr === v.q + ',' + v.r);
      return g ? Math.max(0, g.strength - reservedOut(qr)) : 0;
    };
    const attackTargets = (fromQr) => {
      const [fq, fr] = fromQr.split(',').map(Number);
      return DIRSC.map((d) => state.map.find((v) => v.q === fq + d[0] && v.r === fr + d[1]))
        .filter((t) => t && !t.warded && t.owner !== ME.id)
        .map((t) => ({ q: t.q, r: t.r }));
    };
    const raidTargets = (fromQr) => {
      const [fq, fr] = fromQr.split(',').map(Number);
      return DIRSC.map((d) => {
        const t = state.map.find((v) => v.q === fq + d[0] && v.r === fr + d[1]);
        if (!t || t.owner == null || t.owner === ME.id || t.warded) return null;
        const g = ME.garrisons.find((v) => !v.own && v.q === t.q && v.r === t.r);
        return g && g.strength >= 1 ? { q: t.q, r: t.r } : null;
      }).filter(Boolean);
    };
    const DIRSC = [[1,0],[1,-1],[0,-1],[-1,0],[-1,1],[0,1]];
    const hexDistC = (a, b) => {
      const [q1, r1] = a.split(',').map(Number), [q2, r2] = b.split(',').map(Number);
      return (Math.abs(q1 - q2) + Math.abs(r1 - r2) + Math.abs(q1 + r1 - q2 - r2)) / 2;
    };
    // Own tiles reachable from fromQr: adjacent, or 2 away through an owned middle tile.
    const validMoveDests = (fromQr) => {
      const [fq, fr] = fromQr.split(',').map(Number);
      const own = new Set(state.map.filter((t) => t.owner === ME.id).map((t) => t.q + ',' + t.r));
      return state.map.filter((t) => {
        if (t.owner !== ME.id) return false;
        const key = t.q + ',' + t.r;
        if (key === fromQr) return false;
        const d = hexDistC(fromQr, key);
        if (d === 1) return true;
        if (d !== 2) return false;
        return DIRSC.some((dd) => {
          const mk = (fq + dd[0]) + ',' + (fr + dd[1]);
          return own.has(mk) && hexDistC(mk, key) === 1;
        });
      }).map((t) => ({ q: t.q, r: t.r }));
    };
    const escH = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');
    const TERRAIN_NAME = { plains: 'Plains', ore: 'Ore deposit \\u26cf\\ufe0f', food: 'Farmland \\ud83c\\udf3e', relic: 'Relic site \\u2728' };
    const ORDER_LABEL = { expand: '\\ud83c\\udf0d Expand', muster: '\\ud83d\\udee0\\ufe0f Muster', attack: '\\u2694\\ufe0f Attack', move: '\\ud83d\\ude9a Move', spy: '\\ud83d\\udd75\\ufe0f Spy', heist: '\\ud83c\\udf19 Heist', raid: '\\ud83c\\udfc7 Raid' };
    socket.on('me', (m) => { if (m) { ME = m; nhl = null; render(); } });
    const tileAt = (qr) => { const p = qr.split(','); return state.map.find((t) => t.q == p[0] && t.r == p[1]); };
    function render() {
      document.getElementById('oleft').textContent = ME.orders_left;
      document.getElementById('ore').textContent = ME.ore;
      document.getElementById('food').textContent = ME.food;
      document.getElementById('myScore').textContent = ME.score ?? 0;
      const marks = ME.orders.filter((o) => o.type !== 'move' && o.type !== 'attack').map((o) => ({ q: o.q, r: o.r }));
      for (const f of [moveFrom, raidFrom, attackFrom]) if (f) { const p = f.split(','); marks.push({ q: Number(p[0]), r: Number(p[1]) }); }
      let highlights = [];
      if (attackFrom) highlights = attackTargets(attackFrom).map((v) => ({ ...v, color: '#f85149' }));
      else if (raidFrom) highlights = raidTargets(raidFrom).map((v) => ({ ...v, color: '#f0b72f' }));
      else if (moveFrom) highlights = validMoveDests(moveFrom);
      else if (hl != null) {
        const o = ME.orders.find((v) => v.id === hl);
        if (o) highlights = (o.type === 'move' ? [{ q: o.src_q, r: o.src_r }, { q: o.q, r: o.r }] : [{ q: o.q, r: o.r }])
          .map((v) => ({ ...v, pulse: true }));
      } else if (nhl != null && ME.news[nhl] && ME.news[nhl].q != null) {
        highlights = [{ q: ME.news[nhl].q, r: ME.news[nhl].r, color: '#ffd700', pulse: true }];
      } else if (sel) {
        // Selecting your own garrisoned tile shows what it can strike: red glow
        // on adjacent attackable enemy tiles (attacks are ordered by tapping the TARGET).
        const t = tileAt(sel);
        const g = t && ME.garrisons.find((v) => v.own && v.q === t.q && v.r === t.r);
        if (t && t.owner === ME.id && g && g.strength > 0) {
          highlights = DIRSC.map((d) => state.map.find((v) => v.q === t.q + d[0] && v.r === t.r + d[1]))
            .filter((v) => v && v.owner != null && v.owner !== ME.id && !v.warded)
            .map((v) => ({ q: v.q, r: v.r, color: '#f85149' }));
        }
      }
      renderMap(document.getElementById('map'), state.map, state.players, {
        onClick: (qr) => { sel = (sel === qr ? null : qr); if (overview) { centerOn(tileAt(qr)); overview=false; } render(); },
        selected: sel,
        marks: marks,
        garrisons: ME.garrisons,
        highlights: highlights,
        lines: ME.orders.filter((o) => o.type === 'move')
          .map((o) => ({ fromQ: o.src_q, fromR: o.src_r, toQ: o.q, toR: o.r, hl: o.id === hl }))
          .concat(ME.orders.filter((o) => o.type === 'attack')
            .map((o) => ({ fromQ: o.src_q, fromR: o.src_r, toQ: o.q, toR: o.r, color: '#f85149', hl: o.id === hl }))),
      });
      applyMapView();
      renderPanel();
      renderQueue();
      renderNews();
      renderQuest();
      renderDiplo();
      const oath = document.getElementById('oathline');
      oath.textContent = ME.oathbreakerTurns > 0 ? '\\u26a1 OATHBREAKER \\u2014 fortune frowns for ' + ME.oathbreakerTurns + ' more turn' + (ME.oathbreakerTurns === 1 ? '' : 's') : '';
      const totalUnread = Object.values(ME.unread || {}).reduce((s, v) => s + v, 0);
      const badge = document.getElementById('msgBadge');
      badge.style.display = totalUnread ? '' : 'none';
      document.getElementById('msgBadgeN').textContent = totalUnread;
      const dbadge = document.getElementById('diploBadge');
      dbadge.style.display = totalUnread ? '' : 'none';
      const closed = state.phase !== 'running' || state.paused;
      if (closed) document.querySelectorAll('#btnExpand,#btnMuster,#btnAttack,#btnSpy,#btnMove,#btnRaid,#btnHeist,#btnF2O,#btnO2F,#btnAttackConfirm,#btnMoveConfirm,#btnRaidConfirm,#btnAbandon,#queue button').forEach(b=>b.disabled=true);
      dbadge.textContent = '\\u2709\\ufe0f ' + totalUnread + ' unread';
    }
    let curThread = null;
    let threadMsgs = [];
    function renderDiplo() {
      const sel2 = document.getElementById('diploSel');
      const keep = sel2.value;
      sel2.innerHTML = '<option value="">— choose an empire —</option>' + state.players.filter((p) => p.id !== ME.id)
        .map((p) => '<option value="' + p.id + '"' + (String(p.id) === keep ? ' selected' : '') + '>' +
          escH(p.empire) + ' [' + escH(p.abbr) + ']' + ((ME.unread || {})[p.id] ? ' \\u2709\\ufe0f ' + ME.unread[p.id] + ' new' : '') + '</option>').join('');
      const other = Number(sel2.value) || null;
      const pline = document.getElementById('pactline'), pbtns = document.getElementById('pactbtns');
      const send = document.getElementById('btnSend');
      send.disabled = !other || state.phase !== 'running';
      if (!other) { pline.textContent = 'Pick an empire to message or treat with.'; pbtns.innerHTML = ''; document.getElementById('thread').style.display = 'none'; return; }
      document.getElementById('thread').style.display = '';
      const pact = (ME.pacts || []).find((v) => v.with === other);
      if (!pact) {
        pline.textContent = 'No pact with this empire.';
        pbtns.innerHTML = '<input type="number" id="pactTurns" min="1" max="999" value="10" style="width:80px" title="Duration in turns">' +
          '<button id="pactPropose">\\ud83e\\udd1d Propose pact (turns \\u2192)</button>';
        document.getElementById('pactPropose').onclick = () =>
          api('/api/pacts', { to: other, turns: Number(document.getElementById('pactTurns').value) || 10 }, 'diploerr');
      } else if (pact.status === 'active') {
        pline.innerHTML = '\\ud83e\\udd1d Active pact through turn ' + pact.expiresTick + '. Attacking them brands you <b>OATHBREAKER</b>.';
        pbtns.innerHTML = '';
      } else if (pact.proposedBy === ME.id) {
        pline.textContent = '\\u23f3 ' + pact.duration + '-turn pact proposed \\u2014 awaiting their answer.';
        pbtns.innerHTML = '';
      } else {
        pline.textContent = '\\ud83e\\udd1d They propose a ' + pact.duration + '-turn pact of non-aggression!';
        pbtns.innerHTML = '';
      }
      renderPactList();
      if (curThread !== other) { curThread = other; threadMsgs = []; loadThread(other); }
      renderThread();
    }
    function renderPactList() {
      const pl = document.getElementById('pactlist');
      const items = ME.pacts || [];
      if (!items.length) { pl.innerHTML = ''; return; }
      pl.innerHTML = '<div class="muted" style="font-size:.85rem;margin-bottom:4px">Your pacts</div>' + items.map((pt) => {
        const p = state.players.find((v) => v.id === pt.with);
        const nm = p ? escH(p.empire) + ' [' + escH(p.abbr) + ']' : '?';
        if (pt.status === 'active') {
          return '<div class="qitem"><span style="flex:1;padding:2px 6px">\\ud83e\\udd1d ' + decorate(nm) + ' \\u2014 through turn ' + pt.expiresTick + '</span>' +
            '<button data-pw="' + pt.id + '">Withdraw</button></div>';
        }
        if (pt.proposedBy === ME.id) {
          return '<div class="qitem"><span style="flex:1;padding:2px 6px">\\u23f3 ' + decorate(nm) + ' \\u2014 proposed (' + pt.duration + ' turns), awaiting reply</span></div>';
        }
        return '<div class="qitem"><span style="flex:1;padding:2px 6px">\\ud83e\\udd1d ' + decorate(nm) + ' proposes ' + pt.duration + ' turns</span>' +
          '<button data-pa="' + pt.id + '">Accept</button><button data-pd="' + pt.id + '" class="danger">Decline</button></div>';
      }).join('');
      pl.querySelectorAll('[data-pw]').forEach((b) => b.onclick = () => {
        if (confirm('Withdraw from this pact? The whole world will be told \\u2014 but honor stays intact.'))
          api('/api/pacts/' + b.dataset.pw + '/withdraw', {}, 'diploerr');
      });
      pl.querySelectorAll('[data-pa]').forEach((b) => b.onclick = () => api('/api/pacts/' + b.dataset.pa + '/respond', { accept: true }, 'diploerr'));
      pl.querySelectorAll('[data-pd]').forEach((b) => b.onclick = () => api('/api/pacts/' + b.dataset.pd + '/respond', { accept: false }, 'diploerr'));
    }
    async function loadThread(other) {
      try {
        const res = await fetch('/api/messages/' + other);
        const j = await res.json();
        if (j.messages && curThread === other) { threadMsgs = j.messages; if (j.me) ME = j.me; renderThread(); }
      } catch (e) {}
    }
    function renderThread() {
      const t = document.getElementById('thread');
      if (!threadMsgs.length) { t.innerHTML = '<span class="muted">No messages yet. Diplomacy (or deception) starts here.</span>'; return; }
      t.innerHTML = threadMsgs.map((m) =>
        '<div style="margin:4px 0;display:flex;' + (m.from === ME.id ? 'justify-content:flex-end' : '') + '">' +
        '<span style="background:' + (m.from === ME.id ? '#1f4a7a' : '#21262d') + ';border-radius:8px;padding:4px 10px;max-width:85%">' + escH(m.body) + '</span></div>').join('');
      t.scrollTop = t.scrollHeight;
    }
    socket.on('msg', (m) => {
      if (curThread === m.from) { threadMsgs.push(m); renderThread(); loadThread(m.from); }
    });
    document.getElementById('btnSend').onclick = async () => {
      const body = document.getElementById('msgBody').value.trim();
      if (!body || !curThread) return;
      document.getElementById('msgBody').value = '';
      const res = await fetch('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: curThread, body: body }) });
      const j = await res.json();
      if (j.error) document.getElementById('diploerr').textContent = j.error;
      if (j.message) { threadMsgs.push(j.message); renderThread(); }
      if (j.me) ME = j.me;
    };
    document.getElementById('msgBody').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('btnSend').click(); });
    document.getElementById('msgBadge').onclick = () => document.getElementById('diploHead').scrollIntoView({ behavior: 'smooth' });
    document.getElementById('btnF2O').onclick = () => api('/api/trade', { dir: 'food2ore', times: Number(document.getElementById('tradeN').value) || 1 }, 'tradeerr');
    document.getElementById('btnO2F').onclick = () => api('/api/trade', { dir: 'ore2food', times: Number(document.getElementById('tradeN').value) || 1 }, 'tradeerr');
    document.getElementById('diploSel').addEventListener('change', () => render());
    function renderReady() {
      const b = document.getElementById('btnReady'), info = document.getElementById('readyinfo');
      const et = state.endTurn || { humans: 0, ready: 0 };
      const night = state.phase === 'running' && state.nightfall.active;
      b.disabled = state.phase !== 'running' || night || state.paused;
      b.hidden = !state.rehearsal;
      b.textContent = ME.ready ? '\\u23f3 Waiting for others\\u2026 (tap to cancel)' : '\\u2705 End turn';
      b.style.background = ME.ready ? '#9e6a03' : '';
      info.textContent = state.paused ? 'Paused by the host. Saved orders are safe.' : !state.rehearsal ? state.ordersPerDay + ' orders per day · scheduled turns · plan ahead, then enjoy Nibex.' : night ? 'Nightfall \\u2014 no turns until Daybreak.'
        : (et.humans ? et.ready + '/' + et.humans + ' ready \\u2014 when everyone is, the turn fires early' : '');
    }
    function renderQuest() {
      document.getElementById('relics').textContent = ME.relicCount || 0;
      const box = document.getElementById('questbox');
      if (!ME.quest) { box.className = 'muted'; box.textContent = 'No quest yet — one arrives with the next turn.'; return; }
      box.className = '';
      box.innerHTML = '<div>' + decorate(escH(ME.quest.desc)) + '</div>' +
        '<div class="muted" style="margin-top:6px">Progress: ' + ME.quest.progress + ' / ' + ME.quest.goal + '</div>' +
        '<div class="btnrow"><button id="btnAbandon" class="danger" style="padding:4px 12px">Abandon quest</button></div>';
      document.getElementById('btnAbandon').onclick = () => {
        if (confirm('Abandon this quest? It counts against today\\'s deals.')) api('/api/quests/abandon', {});
      };
    }
    function renderNews() {
      const el = document.getElementById('news');
      if (!ME.news || !ME.news.length) { el.className = 'muted'; el.textContent = 'Nothing yet — news lands after each turn.'; return; }
      el.className = '';
      el.innerHTML = '<div class="muted" style="margin-bottom:4px;font-size:.85rem">Tap a report to flash where it happened.</div>' +
        ME.news.map((nw, i) =>
          '<div class="qitem" data-news="' + i + '" style="cursor:pointer;border-radius:6px' + (i === nhl ? ';background:#1c2a3a' : '') + '">' +
          '<span style="flex:1;padding:2px 6px"><span class="muted">T' + nw.tick + '</span> ' + decorate(escH(nw.message)) + '</span></div>').join('');
      el.querySelectorAll('[data-news]').forEach((row) => row.onclick = () => {
        nhl = nhl === Number(row.dataset.news) ? null : Number(row.dataset.news);
        hl = null;
        render();
      });
    }
    const myAdjacentStrength = (t) => {
      const DIRS = [[1,0],[1,-1],[0,-1],[-1,0],[-1,1],[0,1]];
      return DIRS.reduce((s, d) => {
        const g = ME.garrisons.find((v) => v.own && v.q === t.q + d[0] && v.r === t.r + d[1]);
        return s + (g ? g.strength : 0);
      }, 0);
    };
    function renderPanel() {
      const info = document.getElementById('tileinfo');
      const be = document.getElementById('btnExpand'), bm = document.getElementById('btnMuster'), ba = document.getElementById('btnAttack');
      const sup = document.getElementById('supportSel');
      if (!sup.dataset.filled && state.players.length) {
        sup.innerHTML = '<option value="">For your own glory</option>' + state.players.filter((p) => p.id !== ME.id)
          .map((p) => '<option value="' + p.id + '">In support of ' + escH(p.empire) + '</option>').join('');
        sup.dataset.filled = '1';
      }
      const bmv = document.getElementById('btnMove'), mbar = document.getElementById('movebar');
      const brd = document.getElementById('btnRaid'), rbar = document.getElementById('raidbar');
      const bs = document.getElementById('btnSpy');
      const hs = document.getElementById('heistSel');
      if (!hs.dataset.filled && state.players.length) {
        hs.innerHTML = state.players.filter((p) => p.id !== ME.id)
          .map((p) => '<option value="' + p.id + '">' + escH(p.empire) + ' [' + escH(p.abbr) + ']</option>').join('');
        hs.dataset.filled = '1';
      }
      renderReady();
      const abar = document.getElementById('attackbar');
      be.disabled = bm.disabled = ba.disabled = bmv.disabled = bs.disabled = brd.disabled = true;
      mbar.style.display = moveFrom ? '' : 'none';
      rbar.style.display = raidFrom ? '' : 'none';
      abar.style.display = attackFrom ? '' : 'none';
      if (state.phase !== 'running') { info.textContent = state.phase === 'lobby' ? 'The game has not launched yet.' : 'The game has ended.'; return; }
      if (attackFrom) {
        const ahint = document.getElementById('attackhint');
        const aconfirm = document.getElementById('btnAttackConfirm');
        aconfirm.disabled = true;
        const avail = availableAt(attackFrom);
        if (avail < 1) { attackFrom = null; render(); return; }
        const targets = attackTargets(attackFrom);
        info.textContent = 'Marching from (' + attackFrom + ') — ' + avail + ' available.';
        if (!sel || !targets.some((v) => sel === v.q + ',' + v.r)) {
          ahint.textContent = 'Tap a red-glowing tile to strike. Enemy land or unclaimed ground — the ward excepted.';
          return;
        }
        const amt = document.getElementById('attackAmt');
        amt.max = avail;
        if (Number(amt.value) > avail || Number(amt.value) < 1) amt.value = avail;
        ahint.textContent = 'March on (' + sel + ') with how many of ' + avail + '?';
        aconfirm.disabled = ME.orders_left < 1 || ME.food < 1;
        return;
      }
      if (raidFrom) {
        const rhint = document.getElementById('raidhint');
        const rconfirm = document.getElementById('btnRaidConfirm');
        rconfirm.disabled = true;
        const targets = raidTargets(raidFrom);
        if (!targets.length) { raidFrom = null; render(); return; }
        info.textContent = 'Raiding from (' + raidFrom + ').';
        if (!sel || !targets.some((v) => sel === v.q + ',' + v.r)) {
          rhint.textContent = 'Tap a glowing enemy tile — its supply line is your target. Win: plunder resources. Lose: 1 strength.';
          return;
        }
        rhint.textContent = 'Raid (' + sel + ')? 50/50 odds.';
        rconfirm.disabled = ME.orders_left < 1;
        return;
      }
      if (moveFrom) {
        const srcG = ME.garrisons.find((v) => v.own && moveFrom === v.q + ',' + v.r);
        const hint = document.getElementById('movehint');
        const confirmBtn = document.getElementById('btnMoveConfirm');
        confirmBtn.disabled = true;
        if (!srcG || srcG.strength < 1) { moveFrom = null; render(); return; }
        info.textContent = 'Moving troops from (' + moveFrom + ') — garrison ' + srcG.strength + '.';
        if (!sel || sel === moveFrom) { hint.textContent = 'Tap a destination: any highlighted tile (up to 2 away through your territory).'; return; }
        const ok = validMoveDests(moveFrom).some((v) => sel === v.q + ',' + v.r);
        if (!ok) { hint.textContent = 'Destination must be a highlighted tile — yours, within 2 through your territory.'; return; }
        const amt = document.getElementById('moveAmt');
        amt.max = srcG.strength;
        if (Number(amt.value) > srcG.strength) amt.value = srcG.strength;
        hint.textContent = 'Move how many of ' + srcG.strength + ' to (' + sel + ')?';
        confirmBtn.disabled = ME.orders_left < 1;
        return;
      }
      if (!sel) { info.textContent = 'Tap a tile to give an order.'; return; }
      const t = tileAt(sel);
      if (!t) { info.textContent = 'Tap a tile to give an order.'; return; }
      const owner = state.players.find((p) => p.id === t.owner);
      const g = ME.garrisons.find((v) => v.q === t.q && v.r === t.r);
      const enemy = owner && t.owner !== ME.id;
      const avail = t.owner === ME.id ? availableAt(sel) : 0;
      info.innerHTML = TERRAIN_NAME[t.terrain] +
        (owner ? ' — ' + escH(owner.empire) + (t.warded ? ' \\ud83d\\udee1\\ufe0f warded' : '') : ' — unclaimed') +
        (g ? ' \\u2022 garrison ' + g.strength : (enemy ? ' \\u2022 garrison unknown' : '')) +
        (t.owner === ME.id && g && g.strength !== avail ? ' \\u2022 uncommitted: ' + avail : '');
      if ((enemy || !owner) && !t.warded) {
        info.innerHTML += '<br><span class="muted">To march here: select your adjacent tile, then \\u2694\\ufe0f Attack from here' +
          (!owner ? ' (or Expand claims it free \\u2014 soldiers beat settlers)' : '') + '.</span>';
      }
      if (enemy && !t.warded && (ME.pacts || []).some((v) => v.with === t.owner && v.status === 'active')) {
        info.innerHTML += '<br><span style="color:#f0b72f">⚡ You have a PACT with this empire — attacking brands you OATHBREAKER.</span>';
      }
      be.disabled = !!owner || ME.orders_left < 1;
      bm.disabled = !owner || t.owner !== ME.id || ME.orders_left < 1 || ME.ore < 1;
      ba.disabled = !owner || t.owner !== ME.id || avail < 1 || ME.orders_left < 1 || ME.food < 1 || !attackTargets(sel).length;
      const inSpyRange = state.map.some((v) => v.owner === ME.id && hexDistC(v.q + ',' + v.r, t.q + ',' + t.r) <= 3);
      bs.disabled = !enemy || t.warded || ME.orders_left < 1 || ME.food < 1 || !inSpyRange;
      bmv.disabled = !owner || t.owner !== ME.id || !g || g.strength < 1 || ME.orders_left < 1;
      brd.disabled = !owner || t.owner !== ME.id || !g || g.strength < 1 || ME.orders_left < 1 || !raidTargets(sel).length;
    }
    function renderQueue() {
      const q = document.getElementById('queue');
      if (!ME.orders.length) { q.className = 'muted'; q.textContent = 'None — they resolve at the next turn.'; return; }
      q.className = '';
      const label = (o) => {
        if (o.type === 'heist') {
          const p = state.players.find((v) => v.id === o.target_player);
          return '\\ud83c\\udf19 Heist vs ' + (p ? escH(p.empire) + ' [' + escH(p.abbr) + ']' : '?') + ' — resolves at Daybreak';
        }
        if (o.type === 'move') return '\\ud83d\\ude9a Move ' + o.amount + ' from (' + o.src_q + ', ' + o.src_r + ') to (' + o.q + ', ' + o.r + ')';
        if (o.type === 'raid') return '\\ud83c\\udfc7 Raid (' + o.src_q + ', ' + o.src_r + ') \\u2192 (' + o.q + ', ' + o.r + ')';
        if (o.type === 'muster') return '\\ud83d\\udee0\\ufe0f Muster ' + (o.amount || 1) + ' at (' + o.q + ', ' + o.r + ')';
        if (o.type === 'attack') {
          const who = o.support_for != null ? state.players.find((v) => v.id === o.support_for) : null;
          return (who ? '\\ud83e\\udd1d Support ' + escH(who.empire) + ': ' : '\\u2694\\ufe0f Attack ') +
            o.amount + ' troops (' + o.src_q + ', ' + o.src_r + ') \\u2192 (' + o.q + ', ' + o.r + ')';
        }
        return ORDER_LABEL[o.type] + ' at (' + o.q + ', ' + o.r + ')';
      };
      q.innerHTML = '<div class="muted" style="margin-bottom:4px;font-size:.85rem">Tap an order to flash it on the map.</div>' +
        ME.orders.map((o) =>
        '<div class="qitem" data-hl="' + o.id + '" style="cursor:pointer;border-radius:6px' + (o.id === hl ? ';background:#1c2a3a;color:#58a6ff' : '') + '">' +
        '<span style="flex:1;padding:2px 6px">' + decorate(label(o)) + '</span>' +
        '<button data-cancel="' + o.id + '">Cancel</button></div>').join('');
      q.querySelectorAll('[data-cancel]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); api('/api/orders/' + b.dataset.cancel + '/cancel', {}); });
      q.querySelectorAll('[data-hl]').forEach((row) => row.onclick = () => { hl = hl === Number(row.dataset.hl) ? null : Number(row.dataset.hl); render(); });
    }
    async function api(url, body, errId) {
      const errEl = document.getElementById(errId || 'orderr');
      errEl.textContent = '';
      try {
        if (state.paused || state.phase !== 'running') { errEl.textContent='The game is closed.'; return; }
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const j = await res.json();
        if (j.error) errEl.textContent = j.error;
        if (j.me) ME = j.me;
      } catch (e) { errEl.textContent = 'Connection hiccup — try again.'; }
      render();
    }
    function sendOrder(type) {
      if (!sel) return;
      const p = sel.split(',');
      api('/api/orders', { type: type, q: Number(p[0]), r: Number(p[1]) });
    }
    document.getElementById('mapHome').onclick=()=>{centerOn(state.map.find(t=>t.owner===ME.id && t.capital));overview=false;mapWidth=260;render();};
    document.getElementById('mapWorld').onclick=()=>{overview=true;render();};
    document.querySelectorAll('[data-zoom]').forEach(b=>b.onclick=()=>{mapWidth=Math.max(160,Math.min(1600,mapWidth*Number(b.dataset.zoom)));overview=false;render();});
    document.querySelectorAll('[data-pan]').forEach(b=>b.onclick=()=>{if(!mapCenter)return;const [x,y]=b.dataset.pan.split(',').map(Number);mapCenter.x+=x*mapWidth/3;mapCenter.y+=y*mapWidth/3;overview=false;render();});
    window.addEventListener('resize',applyMapView);
    document.getElementById('btnExpand').onclick = () => sendOrder('expand');
    document.getElementById('btnMuster').onclick = () => {
      if (!sel) return;
      const p = sel.split(',');
      api('/api/orders', { type: 'muster', q: Number(p[0]), r: Number(p[1]), amount: Number(document.getElementById('musterAmt').value) || 1 });
    };
    document.getElementById('btnSpy').onclick = () => sendOrder('spy');
    document.getElementById('btnReady').onclick = () => api('/api/ready', { ready: !ME.ready });
    document.getElementById('btnHeist').onclick = () => {
      const hs = document.getElementById('heistSel');
      if (hs.value) api('/api/orders', { type: 'heist', target_player: Number(hs.value) }, 'heisterr');
    };
    document.getElementById('btnAttack').onclick = () => { attackFrom = sel; moveFrom = null; raidFrom = null; sel = null; render(); };
    document.getElementById('btnAttackCancel').onclick = () => { attackFrom = null; render(); };
    document.getElementById('btnAttackConfirm').onclick = () => {
      if (!attackFrom || !sel) return;
      const s = attackFrom.split(','), d = sel.split(',');
      const sf = document.getElementById('supportSel').value;
      const amt = Number(document.getElementById('attackAmt').value) || 1;
      attackFrom = null;
      api('/api/orders', { type: 'attack', q: Number(d[0]), r: Number(d[1]), src_q: Number(s[0]), src_r: Number(s[1]),
        amount: amt, support_for: sf === '' ? null : Number(sf) });
    };
    document.getElementById('btnMove').onclick = () => { moveFrom = sel; raidFrom = null; attackFrom = null; sel = null; render(); };
    document.getElementById('btnMoveCancel').onclick = () => { moveFrom = null; render(); };
    document.getElementById('btnRaid').onclick = () => { raidFrom = sel; moveFrom = null; attackFrom = null; sel = null; render(); };
    document.getElementById('btnRaidCancel').onclick = () => { raidFrom = null; render(); };
    document.getElementById('btnRaidConfirm').onclick = () => {
      if (!raidFrom || !sel) return;
      const s = raidFrom.split(','), d = sel.split(',');
      raidFrom = null;
      api('/api/orders', { type: 'raid', q: Number(d[0]), r: Number(d[1]), src_q: Number(s[0]), src_r: Number(s[1]) });
    };
    document.getElementById('btnMoveConfirm').onclick = () => {
      if (!moveFrom || !sel) return;
      const s = moveFrom.split(','), d = sel.split(',');
      const amt = Number(document.getElementById('moveAmt').value);
      moveFrom = null;
      api('/api/orders', { type: 'move', q: Number(d[0]), r: Number(d[1]), src_q: Number(s[0]), src_r: Number(s[1]), amount: amt });
    };
    render();
    setInterval(() => {
      const el = document.getElementById('countmini');
      if (state.phase === 'lobby') { el.textContent = 'waiting for launch'; return; }
      if (state.phase === 'finale') { el.textContent = 'FINALE'; return; }
      if (state.paused) { el.textContent = 'PAUSED'; return; }
      const night = state.nightfall.active;
      const target = night ? state.daybreakAt : state.nextTickAt;
      el.textContent = (night ? '\\ud83c\\udf19 daybreak in ' : 'next turn in ') + (target ? fmt(new Date(target) - serverTime()) : '--:--:--');
    }, 250);`
  return layout(player.empire + " — Nibex: Empires", body, script, {css: "button {min-height:44px} .btnrow {gap:8px} #maptools {position:sticky;top:0;background:#161b22;z-index:2;padding:6px 0} .wrap {max-width:780px} #connection {font-size:.85rem}"})
}

export function adminLoginPage(error = '') {
  const body = `
    <h1>Admin</h1>
    <form class="card" method="post" action="/admin/login" style="max-width:360px">
      <label>Password</label><input aria-label="Password" type="password" name="password" required autofocus>
      ${error ? `<div class="err">${esc(error)}</div>` : ''}
      <div style="margin-top:16px"><button type="submit">Enter</button></div>
    </form>`
  return layout('Admin — Nibex: Empires', body)
}

export function adminPage(state, settings, error = '') {
  const endDate = settings.end_at ? new Date(settings.end_at) : null
  const endLocal = endDate ? new Date(endDate.getTime()-endDate.getTimezoneOffset()*60000).toISOString().slice(0,16) : ''
  const body = `
    <h1>Admin</h1>
    <p class="muted">Phase: <b>${esc(state.phase)}</b> · Turn ${state.tick} · ${state.players.length} empires</p>
    ${error ? `<div class="err card">${esc(error)}</div>` : ''}
    <form class="card" method="post" action="/admin/settings">
      <h2>Settings</h2>
      <p class="muted">Times use the server’s local timezone. Cadence is locked after launch. Pausing holds turns but does not extend the trophy deadline.</p>
      <label>Game ends at (required before launch)</label><input aria-label="Game ends at (required before launch)" type="datetime-local" name="end_at" value="${esc(endLocal)}">
      <label>Turn length (minutes)</label><input aria-label="Turn length (minutes)" type="number" name="tick_interval_min" min="1" value="${esc(settings.tick_interval_min)}">
      <label>Daily order budget (resets at Daybreak)</label><input aria-label="Daily order budget (resets at Daybreak)" type="number" name="orders_per_day" min="1" max="100" value="${esc(settings.orders_per_day)}">
      <label>Nightfall start / end (24h local)</label>
      <div style="display:flex;gap:8px">
        <input type="time" name="nightfall_start" value="${esc(settings.nightfall_start)}">
        <input type="time" name="nightfall_end" value="${esc(settings.nightfall_end)}">
      </div>
      <label>Quests dealt per day</label><input aria-label="Quests dealt per day" type="number" name="quests_per_day" min="0" value="${esc(settings.quests_per_day)}">
      <label>🤖 Bot empires created at launch (for playtesting)</label><input aria-label="🤖 Bot empires created at launch (for playtesting)" type="number" name="bot_count" min="0" max="40" value="${esc(settings.bot_count)}">
      <label style="display:flex;gap:8px;align-items:center;margin-top:12px;color:#e6edf3">
        <input type="checkbox" name="allow_late_join" ${settings.allow_late_join === '1' ? 'checked' : ''}>
        Allow new empires to join after launch
      </label>
      <label><input type="checkbox" name="allow_fast_forward" ${settings.allow_fast_forward === '1' ? 'checked' : ''}> Rehearsal mode: allow early turns</label>
      <div style="margin-top:16px"><button type="submit">Save settings</button></div>
    </form>
    <div class="card"><h2>Event controls</h2>
      <p class="err">${esc(settings.scheduler_error || settings.backup_error || '')}</p>
      <p class="muted">Last backup: ${esc(settings.last_backup_at || 'not yet created')}. Automatic snapshots run every five minutes.</p>
      <div class="btnrow"><form method="post" action="/admin/${state.paused ? 'resume' : 'pause'}"><button>${state.paused ? 'Resume game' : 'Pause game'}</button></form>
      <form method="post" action="/admin/backup"><button>Download backup</button></form></div>
    </div>
    <div class="row">
      <form class="card" method="post" action="/admin/launch">
        <h2>Launch</h2>
        <p class="muted">Generates the map, assigns spawns, starts the tick clock. End time must be set first.</p>
        <div style="margin-top:12px"><button ${state.phase !== 'lobby' ? 'disabled' : ''}>🚀 Launch game</button></div>
      </form>
      <form class="card" method="post" action="/admin/tick">
        <h2>Resolve now</h2>
        <p class="muted">Rehearsal only. Event games keep their published turn schedule.</p>
        <div style="margin-top:12px"><button ${state.phase !== 'running' || !state.rehearsal ? 'disabled' : ''}>⏱️ Resolve turn now</button></div>
      </form>
      <form class="card" method="post" action="/admin/end" onsubmit="return confirm('End the game and lock the realm?')">
        <h2>Finale</h2>
        <p class="muted">Ends the game immediately. Unresolved orders expire and paid resources return before the final score is sealed.</p>
        <div style="margin-top:12px"><button class="danger" ${state.phase !== 'running' ? 'disabled' : ''}>End game now</button></div>
      </form>
      <form class="card" method="post" action="/admin/finale">
        <h2>🏆 Ceremony</h2>
        <p class="muted">Begin the Final Tally on the dashboard — last place to champion, relics revealed. Click again to replay.</p>
        <div style="margin-top:12px"><button ${state.phase !== 'finale' ? 'disabled' : ''}>🏆 Start Finale</button></div>
      </form>
      <form class="card" method="post" action="/admin/reset" onsubmit="return confirm('Wipe ALL players and events and return to the lobby? This cannot be undone.')">
        <h2>New game</h2>
        <p class="muted">Wipes players and events, returns to Lobby with the join QR code on the dashboard.</p>
        <div style="margin-top:12px"><button class="danger">Initialize new game</button></div>
      </form>
    </div>
    <div class="card"><h2>Empires</h2><ul class="roster">
      ${state.players.map((p) => `<li><img class="emblem" src="/emblem/${p.id}" alt="">${esc(p.empire)} [${esc(p.abbr)}] — <span class="muted">${esc(p.name)}</span>
        <form method="post" action="/admin/bot/${p.id}" style="margin-left:auto"><button style="padding:2px 10px;background:${p.is_bot ? '#238636' : '#30363d'};border-color:#484f58">🤖 ${p.is_bot ? 'Bot: ON' : 'Bot: off'}</button></form></li>`).join('')}
    </ul></div>`
  return layout('Admin — Nibex: Empires', body)
}
