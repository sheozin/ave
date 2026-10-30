#!/usr/bin/env node
// CueDeck print helper: prints CueDeck badges straight to a Brother QL
// label printer on the venue network, with no print dialog, no driver and
// no paper-size setup. Runs on the desk laptop; the desk page in Chrome
// sends it each badge as a PNG.
//
//   node cuedeck-print-helper.mjs --printer 192.168.1.50 [--cut-mm 76] [--margin-dots 35] [--port 7841]
//
// It listens on 127.0.0.1 only, so nothing else on the network can use it,
// and it only takes jobs from CueDeck pages (the Origin check below).
import http from 'node:http';
import net from 'node:net';
import { decodePng, toLines, fitLength, rasterJob, parseStatus, STATUS_REQUEST } from './brother-raster.mjs';

const VERSION = '1.0.0';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : (process.env['CUEDECK_' + k.toUpperCase().replace(/-/g, '_')] ?? d); };
const PRINTER = arg('printer', '');
const PRINTER_PORT = Number(arg('printer-port', 9100));
const PORT = Number(arg('port', 7841));
const CUT_MM = Number(arg('cut-mm', 76));
const MARGIN = Number(arg('margin-dots', 35));
if (!PRINTER) { console.error('Give the printer address: node cuedeck-print-helper.mjs --printer 192.168.1.50'); process.exit(2); }

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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`CueDeck print helper ${VERSION}: http://127.0.0.1:${PORT} -> Brother QL at ${PRINTER}:${PRINTER_PORT}, ${CUT_MM} mm labels`);
  status().then(s => console.log('printer:', s.errors.length ? s.errors.join(', ') : 'ready', s.media ? `(${s.media.width_mm} mm ${s.media.type})` : '(roll not reported)'),
                e => console.log('printer:', e.message));
});
