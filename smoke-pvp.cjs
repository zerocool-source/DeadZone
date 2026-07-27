// Runtime smoke test for pvp/ — drives the real client against the real
// GameServer via tools/local-net.mjs. Dev-only harness script.
const puppeteer = require('puppeteer');
const fs = require('fs');

const PORT = process.env.SMOKE_PORT || '8951';
const ROOM = 'smoke' + Date.now().toString(36);
const URL = `http://localhost:${PORT}/index.html?room=${ROOM}&dev`;

const pageErrors = [];
const consoleErrors = [];
const consoleAll = [];
const results = [];
const pass = (n, ok, detail) => { results.push({ n, ok, detail }); console.log(`[${ok ? 'PASS' : 'FAIL'}] ${n}${detail ? ' :: ' + detail : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 640 });

  page.on('pageerror', e => { pageErrors.push(String(e && e.stack || e)); });
  page.on('error', e => { pageErrors.push('PAGE CRASH: ' + String(e && e.stack || e)); });
  page.on('requestfailed', r => { consoleErrors.push('REQUEST FAILED: ' + r.url() + ' :: ' + (r.failure() && r.failure().errorText)); });
  page.on('console', m => {
    const txt = `${m.type()}: ${m.text()}`;
    consoleAll.push(txt);
    if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(txt);
  });
  page.on('response', r => { if (r.status() >= 400) consoleErrors.push(`HTTP ${r.status()} ${r.url()}`); });

  console.log('--- loading', URL);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(5000);

  // ---- 1. load with zero pageerrors -------------------------------------
  pass('page loads with zero pageerror events (pre-join)', pageErrors.length === 0,
    pageErrors.join('\n---\n'));

  // ---- 2. join ----------------------------------------------------------
  const hasJoin = await page.$('#join-btn');
  pass('#join-btn present', !!hasJoin);
  await page.evaluate(() => { document.getElementById('name-input').value = 'SMOKER'; });
  await page.click('#join-btn');
  await sleep(3000);

  // ---- 3. __dzpvp + snapshots ------------------------------------------
  const dbg = await page.evaluate(() => {
    const d = window.__dzpvp;
    if (!d) return { exists: false };
    return {
      exists: true,
      hasSnap: !!d.snap,
      wsState: d.ws ? d.ws.readyState : -1,
      players: d.snap ? d.snap.m.p.length : 0,
      phase: d.snap ? d.snap.m.ph : null,
      names: d.snap ? d.snap.m.p.map(r => r[12] + (r[14] & 4 ? '(bot)' : '')) : [],
      worldSize: d.world ? d.world.size : null,
    };
  });
  pass('window.__dzpvp exists', dbg.exists, JSON.stringify(dbg));
  pass('snapshots arriving', !!dbg.hasSnap, 'ws readyState=' + dbg.wsState);
  const botCount = dbg.names ? dbg.names.filter(n => n.includes('(bot)')).length : 0;
  pass('bots joined the room', botCount >= 1, `players=${dbg.players} names=${JSON.stringify(dbg.names)}`);

  // ---- 4. combat: kills rise over ~30s + bot movement over first 20s ----
  console.log('--- observing combat for 32s');
  const samples = await page.evaluate(async () => {
    const d = window.__dzpvp;
    const out = { ticks: [], phases: [], err: null };
    // track each player's kill count; matches can reset (kills go to 0) so we
    // accumulate deltas rather than reading the final total.
    const lastKills = new Map();
    const gained = new Map();
    const trail = new Map(); // id -> [{t,x,z}]
    const t0 = performance.now();
    for (let i = 0; i < 32; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const s = d.snap;
      if (!s) { out.ticks.push(null); continue; }
      out.phases.push(s.m.ph);
      for (const row of s.m.p) {
        const id = row[0], k = row[7];
        const prev = lastKills.has(id) ? lastKills.get(id) : 0;
        if (k > prev) gained.set(id, (gained.get(id) || 0) + (k - prev));
        lastKills.set(id, k);
        if (row[14] & 4) {
          if (!trail.has(id)) trail.set(id, []);
          trail.get(id).push({ t: (performance.now() - t0) / 1000, x: row[1], z: row[3], name: row[12], hp: row[6] });
        }
      }
      out.ticks.push({ t: i + 1, total: [...gained.values()].reduce((a, b) => a + b, 0), np: s.m.p.length });
    }
    out.gained = [...gained.entries()];
    out.trails = [...trail.entries()].map(([id, pts]) => {
      let dist = 0, maxD = 0;
      for (let i = 1; i < pts.length; i++) {
        const dx = pts[i].x - pts[i - 1].x, dz = pts[i].z - pts[i - 1].z;
        dist += Math.hypot(dx, dz);
      }
      // net displacement from start, plus per-second path length over the
      // first 20 samples (the "does it move" window)
      const w = pts.slice(0, 21);
      let d20 = 0;
      for (let i = 1; i < w.length; i++) d20 += Math.hypot(w[i].x - w[i - 1].x, w[i].z - w[i - 1].z);
      return { id, name: pts[0] && pts[0].name, samples: pts.length, pathLen: +dist.toFixed(2), path20: +d20.toFixed(2) };
    });
    const s = d.snap;
    out.finalRows = s ? s.m.p.map(r => ({ id: r[0], name: r[12], k: r[7], d: r[8], hp: r[6], bot: !!(r[14] & 4), x: +r[1].toFixed(1), z: +r[3].toFixed(1) })) : [];
    return out;
  });

  const totalKills = samples.ticks.filter(Boolean).slice(-1)[0];
  pass('bots fight (total kills rise over ~30s)', !!(totalKills && totalKills.total > 0),
    'cumulative kills=' + (totalKills ? totalKills.total : 0) + ' | per-player gained=' + JSON.stringify(samples.gained));

  const stuck = samples.trails.filter(t => t.path20 < 5);
  pass('bots not stuck (>5m travelled in first 20s)', samples.trails.length > 0 && stuck.length === 0,
    JSON.stringify(samples.trails));

  // ---- 5. screenshot ----------------------------------------------------
  await page.screenshot({ path: '/tmp/smoke_shot.png' });
  pass('screenshot written', fs.existsSync('/tmp/smoke_shot.png'),
    '/tmp/smoke_shot.png ' + (fs.existsSync('/tmp/smoke_shot.png') ? fs.statSync('/tmp/smoke_shot.png').size + ' bytes' : ''));

  // ---- 6. local player input -------------------------------------------
  const errBefore = pageErrors.length;
  const move = await page.evaluate(async () => {
    const d = window.__dzpvp;
    const a = { x: d.me.x, z: d.me.z, y: d.me.y };
    d.hold('fwd', true);
    await new Promise(r => setTimeout(r, 1500));
    d.hold('fwd', false);
    const b = { x: d.me.x, z: d.me.z };
    return { a, b, dist: Math.hypot(b.x - a.x, b.z - a.z), alive: d.me.alive, hp: d.me.hp };
  });
  pass('local player can move (hold fwd)', move.dist > 0.5, JSON.stringify(move));

  const crouch = await page.evaluate(async () => {
    const d = window.__dzpvp;
    const eye0 = d.camera.position.y;
    d.hold('crouch', true);
    await new Promise(r => setTimeout(r, 900));
    const eye1 = d.camera.position.y;
    d.hold('crouch', false);
    await new Promise(r => setTimeout(r, 900));
    return { eye0: +eye0.toFixed(3), crouched: +eye1.toFixed(3), eye2: +d.camera.position.y.toFixed(3) };
  });
  pass('crouch changes eye height', crouch.crouched < crouch.eye0 - 0.15, JSON.stringify(crouch));

  const fire = await page.evaluate(async () => {
    const d = window.__dzpvp;
    const mag0 = d.me.mag;
    d.setFiring(true);
    await new Promise(r => setTimeout(r, 1600));
    d.setFiring(false);
    await new Promise(r => setTimeout(r, 400));
    return { mag0, mag1: d.me.mag, reloading: d.me.reloading, decals: d.decals };
  });
  pass('firing consumes ammo', fire.mag1 !== fire.mag0 || fire.reloading, JSON.stringify(fire));

  const nadeBefore = await page.evaluate(() => (window.__dzpvp.snap && window.__dzpvp.snap.m.g || []).length);
  await page.keyboard.press('KeyG');
  await sleep(600);
  const nadeAfter = await page.evaluate(() => (window.__dzpvp.snap && window.__dzpvp.snap.m.g || []).length);
  pass('grenade throw (KeyG) registers on server', nadeAfter > nadeBefore || nadeBefore > 0,
    `grenades before=${nadeBefore} after=${nadeAfter}`);

  // ads + reload + jump for good measure
  await page.evaluate(async () => {
    const d = window.__dzpvp;
    d.setAds(true); await new Promise(r => setTimeout(r, 500)); d.setAds(false);
    d.hold('jump', true); await new Promise(r => setTimeout(r, 300)); d.hold('jump', false);
  });
  await page.keyboard.press('KeyR');
  await sleep(1200);
  pass('no new pageerrors during input exercise', pageErrors.length === errBefore,
    pageErrors.slice(errBefore).join('\n---\n'));

  // final snapshot state
  const finalState = await page.evaluate(() => {
    const d = window.__dzpvp;
    const s = d.snap;
    return {
      phase: s ? s.m.ph : null, win: s ? s.m.win : null,
      rows: s ? s.m.p.map(r => ({ name: r[12], k: r[7], d: r[8], hp: r[6], bot: !!(r[14] & 4) })) : [],
      meAlive: d.me.alive, meHp: d.me.hp, meKills: d.me.kills, meDeaths: d.me.deaths,
      fov: d.fov, decals: d.decals,
      canvasOk: !!document.querySelector('#c').width,
    };
  });

  pass('page loads with zero pageerror events (whole run)', pageErrors.length === 0,
    pageErrors.join('\n---\n'));

  console.log('\n===== SUMMARY =====');
  console.log(JSON.stringify({
    results, finalState,
    trails: samples.trails,
    killTicks: samples.ticks.filter(Boolean).map(t => t.total),
    phases: [...new Set(samples.phases)],
    finalRows: samples.finalRows,
    pageErrors, consoleErrors,
  }, null, 2));

  await browser.close();
  process.exit(0);
})().catch(async e => {
  console.error('HARNESS ERROR:', e && e.stack || e);
  console.log('pageErrors so far:', JSON.stringify(pageErrors, null, 2));
  console.log('consoleErrors so far:', JSON.stringify(consoleErrors, null, 2));
  process.exit(1);
});
