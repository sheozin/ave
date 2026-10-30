#!/usr/bin/env node
// CueDeck print station: prints CueDeck badges straight to a Brother QL
// label printer on the venue network, with no print dialog, no driver and
// no paper-size setup.
//
// Print station (any desk, any device): pair it once with a code from the
// desk ("Kiosk or scanner", then "Print station"), and it picks up every
// badge sent to it through CueDeck:
//   node cuedeck-print-helper.mjs --printer 192.168.1.50 --pair ABCD-EFGH   (first time)
//   node cuedeck-print-helper.mjs --printer 192.168.1.50                     (after that)
// Find the printer's address: node cuedeck-print-helper.mjs --find   (Mac)
//
// It also listens on 127.0.0.1:7841 for a desk in Chrome on this same
// computer (the older local route). That port takes jobs only from CueDeck
// pages (the Origin check below) and is unreachable from the network.
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { decodePng, toLines, fitLength, rasterJob, parseStatus, STATUS_REQUEST } from './brother-raster.mjs';

const VERSION = '1.1.0';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : (process.env['CUEDECK_' + k.toUpperCase().replace(/-/g, '_')] ?? d); };
const SUPABASE = arg('supabase-url', 'https://sawekpguemzvuvvulfbc.supabase.co');
const PUBLIC_KEY = 'sb_publishable_FJg1ZR0rwYeP3EwQu4xRNA_WqEp4PaB';   // the app's public key, same as the pages
const CONFIG = arg('config', path.join(os.homedir(), '.cuedeck-print-station.json'));
const PRINTER = arg('printer', '');
const PRINTER_PORT = Number(arg('printer-port', 9100));
const PORT = Number(arg('port', 7841));
const CUT_MM = Number(arg('cut-mm', 76));
const MARGIN = Number(arg('margin-dots', 35));
if (process.argv.includes('--find')) await findPrinters();
if (!PRINTER) { console.error('Give the printer address: node cuedeck-print-helper.mjs --printer 192.168.1.50   (or --find to look for it)'); process.exit(2); }

// Brother printers announce themselves over Bonjour. macOS has dns-sd;
// elsewhere, print the printer's network settings page instead.
async function findPrinters() {
  if (process.platform !== 'darwin') { console.log('On this computer, read the address from the printer: hold its Cut button to print the settings page.'); process.exit(0); }
  const run = (args, ms) => new Promise(ok => { const p = execFile('dns-sd', args, { timeout: ms }, () => {}); let out = ''; p.stdout.on('data', d => out += d); setTimeout(() => { p.kill(); ok(out); }, ms); });
  const names = [...(await run(['-B', '_pdl-datastream._tcp', 'local.'], 3000)).matchAll(/_pdl-datastream\._tcp\.\s+(.+)$/gm)].map(m => m[1].trim()).filter(n => /brother/i.test(n));
  if (!names.length) { console.log('No Brother printer found on this network. Is it switched on and on the same Wi-Fi?'); process.exit(1); }
  for (const n of [...new Set(names)]) {
    const host = ((await run(['-L', n, '_pdl-datastream._tcp', 'local.'], 2500)).match(/can be reached at (\S+?)\.?:\d+/) || [])[1];
    const ip = host ? ((await run(['-G', 'v4', host], 2000)).match(/(\d+\.\d+\.\d+\.\d+)/) || [])[1] : null;
    console.log(`${n}: ${ip || 'address not found'}`);
  }
  process.exit(0);
}

const ALLOWED = [/^https:\/\/app\.cuedeck\.io$/, /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/];
const allowed = (o) => !o || ALLOWED.some(r => r.test(o));

// One job on the wire at a time, so two badges never interleave.
let chain = Promise.resolve();
const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

function talk(payload, { reply = 0, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ host: PRINTER, port: PRINTER_PORT });
    const got = [];
    let n = 0;
    const done = (err, v) => { clearTimeout(t); s.destroy(); err ? reject(err) : resolve(v); };
    const t = setTimeout(() => done(new Error(reply ? 'the printer did not answer' : 'timed out sending to the printer')), timeoutMs);
    s.on('error', (e) => done(new Error('cannot reach the printer at ' + PRINTER + ' (' + e.code + ')')));
    s.on('data', (d) => { got.push(d); n += d.length; if (reply && n >= reply) done(null, Buffer.concat(got)); });
    s.on('connect', () => s.write(payload, () => { if (!reply) s.end(); }));
    s.on('close', () => { if (!reply) done(null, null); });
  });
}

// Not every network setup answers the status request; a printer that
// accepts the connection but stays silent is reachable, roll unknown.
const status = () => serial(async () => {
  try { return parseStatus(await talk(STATUS_REQUEST, { reply: 32, timeoutMs: 4000 })); }
  catch (e) { if (/did not answer/.test(e.message)) return { errors: [], media: null }; throw e; }
});

function send(res, code, body, origin) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (!allowed(origin)) return send(res, 403, { error: 'not a CueDeck page' });
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
      return send(res, 200, { ok: !error && !wrongRoll && !printer.errors.length, version: VERSION, printer: PRINTER, cut_mm: CUT_MM, status: printer, error,
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
      const cutMm = Number(body.cut_mm) > 20 && Number(body.cut_mm) <= 300 ? Number(body.cut_mm) : CUT_MM;
      const labels = [];
      for (const p of pngs) {
        const lines = fitLength(toLines(decodePng(Buffer.from(String(p).replace(/^data:image\/png;base64,/, ''), 'base64'))), cutMm, MARGIN);
        for (let i = 0; i < copies; i++) labels.push(lines);
      }
      await serial(() => talk(rasterJob(labels, { marginDots: MARGIN })));
      console.log(new Date().toISOString(), 'printed', labels.length, 'label(s) at', cutMm, 'mm');
      return send(res, 200, { ok: true, labels: labels.length, cut_mm: cutMm }, origin);
    }
    send(res, 404, { error: 'not found' }, origin);
  } catch (e) {
    console.error(new Date().toISOString(), e.message);
    send(res, /reach|answer|timed out/.test(e.message) ? 502 : 400, { error: e.message }, origin);
  }
});

// ── print station: badges sent through CueDeck ─────────────────────
async function fn(name, body) {
  const r = await fetch(`${SUPABASE}/functions/v1/${name}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: PUBLIC_KEY, Authorization: `Bearer ${PUBLIC_KEY}` }, body: JSON.stringify(body) });
  let j = {}; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
}

async function pair(code) {
  const r = await fn('checkin-kiosk-pair', { action: 'claim', code, device_kind: 'printer' });
  if (r.status !== 200 || !r.body.device_key) { console.error('Pairing failed:', r.body.error || r.status); process.exit(1); }
  const cfg = { event_id: r.body.event_id, device_id: r.body.device_id, label: r.body.label, device_key: r.body.device_key };
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  console.log(`Paired as "${cfg.label}". Saved to ${CONFIG}; next time just run with --printer.`);
  return cfg;
}

async function station(cfg) {
  console.log(`Print station "${cfg.label}": waiting for badges from CueDeck.`);
  let quiet = 0;
  for (;;) {
    let r;
    try { r = await fn('checkin-print-station', { action: 'next', event_id: cfg.event_id, device_key: cfg.device_key }); }
    catch (e) { if (quiet++ % 10 === 0) console.log('Cannot reach CueDeck (' + e.message + '); retrying.'); await sleep(3000); continue; }
    if (r.status === 401) { console.error('This print station was removed from the event. Pair it again with a new code (--pair).'); return; }
    if (r.status !== 200) { console.log('CueDeck answered', r.status, r.body.error || ''); await sleep(3000); continue; }
    quiet = 0;
    for (const job of r.body.jobs || []) {
      let ok = true, error = null;
      try {
        const lines = fitLength(toLines(decodePng(Buffer.from(String(job.png).replace(/^data:image\/png;base64,/, ''), 'base64'))), Number(job.cut_mm) || CUT_MM, MARGIN);
        await serial(() => talk(rasterJob([lines], { marginDots: MARGIN })));
        console.log(new Date().toISOString(), 'printed a badge from CueDeck at', job.cut_mm, 'mm');
      } catch (e) { ok = false; error = e.message; console.error(new Date().toISOString(), 'badge not printed:', e.message); }
      // Reported even when the report itself has to be retried: a job left
      // "printing" is failed by the server after two minutes, never reprinted.
      for (let i = 0; i < 3; i++) { try { await fn('checkin-print-station', { action: 'done', event_id: cfg.event_id, device_key: cfg.device_key, job_id: job.id, ok, error }); break; } catch (_) { await sleep(1000); } }
    }
  }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const PAIR = arg('pair', '');
let stationCfg = null;
if (PAIR) stationCfg = await pair(PAIR);
else if (fs.existsSync(CONFIG)) { try { stationCfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch (_) { console.error('Could not read', CONFIG, '- pair again with --pair'); } }
if (stationCfg) station(stationCfg);
else console.log('Not paired to an event yet: only this computer\'s desk can print. Pair with --pair CODE (desk: Kiosk or scanner, then Print station).');

server.on('error', (e) => { if (e.code === 'EADDRINUSE') console.log(`Port ${PORT} is in use (another helper running?); the local route is off, the print station still works.`); else throw e; });
server.listen(PORT, '127.0.0.1', () => {
  console.log(`CueDeck print helper ${VERSION}: http://127.0.0.1:${PORT} -> Brother QL at ${PRINTER}:${PRINTER_PORT}, ${CUT_MM} mm labels`);
  status().then(s => console.log('printer:', s.errors.length ? s.errors.join(', ') : 'ready', s.media ? `(${s.media.width_mm} mm ${s.media.type})` : '(roll not reported)'),
                e => console.log('printer:', e.message));
});
