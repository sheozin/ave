// station-core.mjs: everything a CueDeck print station does, with no UI.
// Used by the command-line station (cuedeck-print-helper.mjs) and the
// desktop app (print-station-app/), so both run the same tested code.
//
//   const st = createStation({ printer: '192.168.1.50', model: 'brother-ql', configPath, onEvent });
//   await st.detect(); st.listen(7841); st.run();
//
// onEvent(type, data) types: log, code (pairing code shown), paired,
// printed, failed, offline, online, unpaired.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { decodePng, toLines, fitLength, rasterJob, parseStatus, STATUS_REQUEST, QL } from './brother-raster.mjs';
import { zplLabel, zplText, ZEBRA_QUERY, parseZebraInfo } from './zebra-zpl.mjs';
import { textImage } from './label-text.mjs';

export const VERSION = '1.3.0';
export const SUPABASE_URL = 'https://sawekpguemzvuvvulfbc.supabase.co';
const PUBLIC_KEY = 'sb_publishable_FJg1ZR0rwYeP3EwQu4xRNA_WqEp4PaB';   // the app's public key, same as the pages
const ALLOWED = [/^https:\/\/app\.cuedeck\.io$/, /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export function createStation(opts) {
  const given = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined));
  const o = { printerPort: 9100, model: 'brother-ql', cutMm: 76, marginDots: 35, supabaseUrl: SUPABASE_URL, dpi: 203, onEvent: () => {}, ...given };
  const emit = (type, data) => { try { o.onEvent(type, data); } catch (_) {} };
  const log = (msg) => emit('log', msg);
  const state = { cfg: null, code: null, stopped: false, printedToday: 0, lastPrinted: null, online: false };

  // One job on the wire at a time, so two badges never interleave.
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

  // reply: bytes to wait for; collectMs: or gather whatever arrives in that time.
  function talk(payload, { reply = 0, collectMs = 0, timeoutMs = 8000 } = {}) {
    return new Promise((resolve, reject) => {
      const s = net.createConnection({ host: o.printer, port: o.printerPort });
      const got = [];
      let n = 0;
      const done = (err, v) => { clearTimeout(t); s.destroy(); err ? reject(err) : resolve(v); };
      const t = setTimeout(() => collectMs ? done(null, Buffer.concat(got)) : done(new Error(reply ? 'the printer did not answer' : 'timed out sending to the printer')), collectMs || timeoutMs);
      s.on('error', (e) => done(new Error('cannot reach the printer at ' + o.printer + ' (' + e.code + ')')));
      s.on('data', (d) => { got.push(d); n += d.length; if (reply && n >= reply) done(null, Buffer.concat(got)); });
      s.on('connect', () => s.write(payload, () => { if (!reply && !collectMs) s.end(); }));
      s.on('close', () => { if (!reply && !collectMs) done(null, null); });
    });
  }

  // ── what this printer is ─────────────────────────────────────────
  // Brother QL: 62 mm roll, 300 dpi. Zebra: asks the printer (SGD); if it
  // does not say, o.dpi (203 by default, the common ZD421/ZD621) and 4 in.
  const zebra = /zebra/i.test(o.model);
  let profile = zebra ? { model: 'zebra', dpi: o.dpi, widthDots: Math.round(4.1 * o.dpi), name: 'Zebra' }
    : { model: 'brother-ql', dpi: 300, widthDots: QL.rollDots, name: 'Brother QL' };
  async function detect() {
    if (!zebra) return profile;
    try {
      const info = parseZebraInfo((await serial(() => talk(ZEBRA_QUERY, { collectMs: 2500 }))).toString('latin1'));
      if (info) profile = { model: 'zebra', ...info };
      else log(`The Zebra did not report its resolution; assuming ${profile.dpi} dpi.`);
    } catch (e) { log('printer: ' + e.message); }
    return profile;
  }
  const info = () => ({ model: profile.model, dpi: profile.dpi, width_mm: Math.round(profile.widthDots / profile.dpi * 25.4), name: profile.name, host: o.printer });

  // PNGs (300 dpi, from checkin-badge.js badgePng) to one job for this printer.
  function jobFor(pngs, cutMm) {
    const imgs = pngs.map(p => decodePng(Buffer.from(String(p).replace(/^data:image\/png;base64,/, ''), 'base64')));
    if (profile.model === 'zebra') return Buffer.from(imgs.map(i => zplLabel(i, profile)).join(''), 'latin1');
    return rasterJob(imgs.map(i => fitLength(toLines(i), cutMm, o.marginDots)), { marginDots: o.marginDots });
  }
  function textJob(lines) {
    if (profile.model === 'zebra') return Buffer.from(zplText(lines.map(l => ({ text: l.text, size: l.scale / 60 })), profile), 'latin1');
    return rasterJob([toLines(textImage(lines))], { marginDots: o.marginDots });
  }
  const printText = (lines) => serial(() => talk(textJob(lines)));
  const printPngs = (pngs, cutMm = o.cutMm) => serial(() => talk(jobFor(pngs, cutMm)));

  // Not every network setup answers the status request; a printer that
  // accepts the connection but stays silent is reachable, roll unknown.
  const status = () => serial(async () => {
    if (profile.model === 'zebra') { await talk(Buffer.alloc(0), { collectMs: 300 }); return { errors: [], media: null }; }
    try { return parseStatus(await talk(STATUS_REQUEST, { reply: 32, timeoutMs: 4000 })); }
    catch (e) { if (/did not answer/.test(e.message)) return { errors: [], media: null }; throw e; }
  });

  // ── local route: a desk in Chrome on this computer ───────────────
  function listen(port) {
    const send = (res, code, body, origin) => {
      res.writeHead(code, { 'Content-Type': 'application/json', ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}) });
      res.end(JSON.stringify(body));
    };
    const server = http.createServer(async (req, res) => {
      const origin = req.headers.origin;
      if (origin && !ALLOWED.some(r => r.test(origin))) return send(res, 403, { error: 'not a CueDeck page' });
      if (req.method === 'OPTIONS') {
        // Chrome asks before a public page may call a local service.
        res.writeHead(204, {
          'Access-Control-Allow-Origin': origin || '*', 'Access-Control-Allow-Methods': 'GET, POST',
          'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Private-Network': 'true', 'Access-Control-Max-Age': '600', Vary: 'Origin',
        });
        return res.end();
      }
      try {
        if (req.method === 'GET' && req.url === '/status') {
          let printer = null, error = null;
          try { printer = await status(); } catch (e) { error = e.message; }
          const media = printer && printer.media;
          const wrongRoll = media && !(media.width_mm === 62 && media.type === 'continuous');
          return send(res, 200, { ok: !error && !wrongRoll && !printer.errors.length, version: VERSION, printer: o.printer, model: profile.model, cut_mm: o.cutMm, status: printer, error,
            warning: wrongRoll ? `Loaded: ${media.width_mm} mm ${media.type}. This label needs the 62 mm continuous roll (DK-22205).`
              : printer && !media ? 'Printer connected; it did not report which roll is loaded.' : null }, origin);
        }
        if (req.method === 'POST' && req.url === '/print') {
          if (!/^application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'send JSON' }, origin);
          const chunks = []; let size = 0;
          for await (const c of req) { size += c.length; if (size > 8e6) return send(res, 413, { error: 'too large' }, origin); chunks.push(c); }
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const pngs = (Array.isArray(body.labels) ? body.labels : [body.png]).filter(Boolean).slice(0, 20);
          if (!pngs.length) return send(res, 400, { error: 'no label' }, origin);
          const copies = Math.min(Math.max(1, Number(body.copies) || 1), 10);
          const cutMm = Number(body.cut_mm) > 20 && Number(body.cut_mm) <= 300 ? Number(body.cut_mm) : o.cutMm;
          const all = pngs.flatMap(p => Array(copies).fill(p));
          await printPngs(all, cutMm);
          log(`printed ${all.length} label(s) at ${cutMm} mm`);
          return send(res, 200, { ok: true, labels: all.length, cut_mm: cutMm }, origin);
        }
        send(res, 404, { error: 'not found' }, origin);
      } catch (e) {
        log(e.message);
        send(res, /reach|answer|timed out/.test(e.message) ? 502 : 400, { error: e.message }, origin);
      }
    });
    server.on('error', (e) => { if (e.code === 'EADDRINUSE') log(`Port ${port} is in use (another station running?); the local route is off, the print station still works.`); else log(e.message); });
    server.listen(port, '127.0.0.1');
    return server;
  }

  // ── print station: badges sent through CueDeck ───────────────────
  async function fn(name, body) {
    const r = await fetch(`${o.supabaseUrl}/functions/v1/${name}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: PUBLIC_KEY, Authorization: `Bearer ${PUBLIC_KEY}` }, body: JSON.stringify(body) });
    let j = {}; try { j = await r.json(); } catch (_) {}
    return { status: r.status, body: j };
  }
  const readConfig = () => { try { return o.configPath && fs.existsSync(o.configPath) ? JSON.parse(fs.readFileSync(o.configPath, 'utf8')) : null; } catch (_) { return null; } };
  const saveConfig = (cfg) => { if (o.configPath) fs.writeFileSync(o.configPath, JSON.stringify(cfg, null, 2), { mode: 0o600 }); return cfg; };
  const forget = () => { try { if (o.configPath) fs.unlinkSync(o.configPath); } catch (_) {} state.cfg = null; };

  // Older route: a code made on the desk, typed here.
  async function pairWithDeskCode(code) {
    const r = await fn('checkin-kiosk-pair', { action: 'claim', code, device_kind: 'printer' });
    if (r.status !== 200 || !r.body.device_key) throw new Error('Pairing failed: ' + (r.body.error || r.status));
    state.cfg = saveConfig({ event_id: r.body.event_id, device_id: r.body.device_id, label: r.body.label, device_key: r.body.device_key });
    emit('paired', { label: state.cfg.label });
    return state.cfg;
  }

  // The station makes its own key and sends only its hash; the code is
  // printed on the printer, so a box with no screen pairs too.
  async function pairWithStationCode({ printCode = true } = {}) {
    const key = crypto.randomBytes(32).toString('hex');
    const keyHash = crypto.createHash('sha256').update(key).digest('hex');
    while (!state.stopped) {
      let r;
      try { r = await fn('checkin-kiosk-pair', { action: 'request', device_kind: 'printer', key_hash: keyHash, info: info() }); }
      catch (e) { emit('offline', e.message); await sleep(5000); continue; }
      if (r.status !== 200) { log('Could not get a pairing code: ' + (r.body.error || r.status)); await sleep(10000); continue; }
      state.code = r.body.code;
      emit('code', { code: state.code, expires_at: r.body.expires_at });
      if (printCode) {
        try { await printText([{ text: 'CUEDECK PRINT STATION', scale: 4 }, { text: 'PAIRING CODE', scale: 4 }, { text: state.code, scale: 9 }, { text: 'TYPE IT IN CUEDECK', scale: 4 }]); }
        catch (e) { log('Could not print the code (' + e.message + ').'); }
      }
      const until = Date.parse(r.body.expires_at) || Date.now() + 30 * 60_000;
      while (Date.now() < until && !state.stopped) {
        await sleep(3000);
        let s;
        try { s = await fn('checkin-kiosk-pair', { action: 'request_status', code: state.code, device_key: key }); } catch (_) { continue; }
        if (s.status === 200 && s.body.approved) {
          state.code = null;
          state.cfg = saveConfig({ event_id: s.body.event_id, device_id: s.body.device_id, label: s.body.label, device_key: key });
          emit('paired', { label: state.cfg.label });
          return state.cfg;
        }
      }
      log('That code ran out; here is a new one.');
    }
    return null;
  }

  async function run({ deskCode = null, printCode = true } = {}) {
    state.stopped = false;
    state.cfg = deskCode ? await pairWithDeskCode(deskCode) : readConfig() || await pairWithStationCode({ printCode });
    if (!state.cfg) return;
    emit('paired', { label: state.cfg.label, resumed: true });
    let quiet = 0;
    while (!state.stopped) {
      const cfg = state.cfg;
      let r;
      try { r = await fn('checkin-print-station', { action: 'next', event_id: cfg.event_id, device_key: cfg.device_key, info: info() }); }
      catch (e) { if (state.online || quiet++ % 10 === 0) emit('offline', e.message); state.online = false; await sleep(3000); continue; }
      if (r.status === 401) {
        emit('unpaired', { label: cfg.label });
        forget();
        state.cfg = await pairWithStationCode({ printCode });
        if (!state.cfg) return;
        continue;
      }
      if (r.status !== 200) { log('CueDeck answered ' + r.status + ' ' + (r.body.error || '')); await sleep(3000); continue; }
      if (!state.online) { state.online = true; emit('online', { label: cfg.label }); }
      quiet = 0;
      for (const job of r.body.jobs || []) {
        let ok = true, error = null;
        try {
          await printPngs([job.png], Number(job.cut_mm) || o.cutMm);
          state.printedToday++; state.lastPrinted = new Date();
          emit('printed', { cut_mm: job.cut_mm, count: state.printedToday });
        } catch (e) { ok = false; error = e.message; emit('failed', e.message); }
        // Reported even when the report itself has to be retried: a job left
        // "printing" is failed by the server after two minutes, never reprinted.
        for (let i = 0; i < 3; i++) { try { await fn('checkin-print-station', { action: 'done', event_id: cfg.event_id, device_key: cfg.device_key, job_id: job.id, ok, error }); break; } catch (_) { await sleep(1000); } }
      }
    }
  }

  const stop = () => { state.stopped = true; };
  return { detect, info, status, listen, run, stop, forget, printText, printPngs, state, profile: () => profile };
}
