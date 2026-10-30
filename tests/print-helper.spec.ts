// tests/print-helper.spec.ts
// The Brother QL print helper (print-helper/). The raster bytes are pinned
// to brother_ql 0.9.4's output for the same PNG (QL-820NWB, label 62,
// rotate 90, cut, uncompressed): sha256 4c370431..., the known-working
// open-source driver. The server is run against a fake printer on a local
// TCP port that records what it is sent.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import net from 'net';
import { spawn, ChildProcess } from 'child_process';
import { decodePng, toLines, fitLength, rasterJob, parseStatus, QL } from '../print-helper/brother-raster.mjs';
import { zplLabel, zplText, parseZebraInfo } from '../print-helper/zebra-zpl.mjs';
import { textImage } from '../print-helper/label-text.mjs';

const PNG = readFileSync('tests/fixtures/visa-next-sample.png');

describe('brother raster', () => {
  it('decodes the 898 x 696 sample', () => {
    const img = decodePng(PNG);
    expect([img.w, img.h]).toEqual([898, 696]);
  });
  it('builds exactly the job brother_ql builds for the same image', () => {
    const job = rasterJob([toLines(decodePng(PNG))]);
    expect(createHash('sha256').update(job).digest('hex')).toBe('4c370431b11d6740c9a6e985606053e71a90de9b398a90bb9750e3e6d03554e6');
  });
  it('fits a 76 mm cut: 898 dots less two 35-dot feeds, all ink kept', () => {
    const lines = toLines(decodePng(PNG));
    const fit = fitLength(lines, 76, 35);
    expect(fit).toHaveLength(Math.round(76 * 300 / 25.4) - 70);
    const ink = (ls: Uint8Array[]) => ls.reduce((t, r) => t + r.reduce((a, b) => a + b, 0), 0);
    expect(ink(fit)).toBe(ink(lines));
  });
  it('scales along the feed rather than cut off ink that is longer than the label', () => {
    const full = Array.from({ length: 900 }, () => new Uint8Array(QL.rollDots).fill(1));
    const fit = fitLength(full, 76, 35);
    expect(fit).toHaveLength(828);
    expect(fit.every(r => r[0] === 1)).toBe(true);
  });
  it('pads a short label to the cut length', () => {
    expect(fitLength([new Uint8Array(QL.rollDots)], 76, 35)).toHaveLength(828);
  });
  it('refuses an image that is not 696 px across the roll', () => {
    expect(() => toLines({ w: 800, h: 600, gray: new Uint8Array(800 * 600) })).toThrow(/696/);
  });
  it('reads a status reply: 62 mm continuous, cover open', () => {
    const b = Buffer.alloc(32); b[0] = 0x80; b[1] = 0x20; b[9] = 0x10; b[10] = 62; b[11] = 0x0a;
    expect(parseStatus(b)).toEqual({ errors: ['Cover open'], media: { width_mm: 62, type: 'continuous', length_mm: 0 } });
  });
});

describe('print helper server', () => {
  let printer: net.Server, helper: ChildProcess, received: Buffer[] = [];
  const PORT = 17841;
  const url = (p: string) => `http://127.0.0.1:${PORT}${p}`;
  beforeAll(async () => {
    printer = net.createServer(sock => {
      const got: Buffer[] = [];
      sock.on('data', d => {
        got.push(d);
        const all = Buffer.concat(got);
        // A status request ends ESC i S with nothing after it: answer like a QL.
        if (all.length === 205 && all.subarray(-3).equals(Buffer.from([0x1b, 0x69, 0x53]))) {
          const r = Buffer.alloc(32); r[0] = 0x80; r[1] = 0x20; r[10] = 62; r[11] = 0x0a; sock.write(r);
        }
      });
      sock.on('end', () => { received.push(Buffer.concat(got)); sock.end(); });
    });
    await new Promise<void>(r => printer.listen(0, '127.0.0.1', () => r()));
    const pport = (printer.address() as net.AddressInfo).port;
    helper = spawn(process.execPath, ['print-helper/cuedeck-print-helper.mjs', '--printer', '127.0.0.1', '--printer-port', String(pport), '--port', String(PORT), '--config', '/nonexistent/cuedeck-station.json', '--no-station']);
    for (let i = 0; i < 50; i++) { try { await fetch(url('/status'), { headers: { Origin: 'https://app.cuedeck.io' } }); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  });
  afterAll(() => { helper?.kill(); printer?.close(); });

  it('reports the printer and the loaded roll', async () => {
    const r = await (await fetch(url('/status'), { headers: { Origin: 'https://app.cuedeck.io' } })).json();
    expect(r).toMatchObject({ ok: true, version: '1.3.0', status: { media: { width_mm: 62, type: 'continuous' } }, warning: null });
  });
  it('answers Chrome\'s private network preflight for CueDeck only', async () => {
    const ok = await fetch(url('/print'), { method: 'OPTIONS', headers: { Origin: 'https://app.cuedeck.io', 'Access-Control-Request-Private-Network': 'true' } });
    expect(ok.headers.get('access-control-allow-private-network')).toBe('true');
    const bad = await fetch(url('/print'), { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    expect(bad.status).toBe(403);
  });
  it('refuses jobs from other sites and non-JSON bodies', async () => {
    const evil = await fetch(url('/print'), { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
    expect(evil.status).toBe(403);
    const form = await fetch(url('/print'), { method: 'POST', headers: { Origin: 'https://app.cuedeck.io', 'Content-Type': 'text/plain' }, body: '{}' });
    expect(form.status).toBe(415);
  });
  it('prints two copies as one job, each 828 lines, cut, ending in 0x1A', async () => {
    received = [];
    const r = await fetch(url('/print'), { method: 'POST', headers: { Origin: 'https://app.cuedeck.io', 'Content-Type': 'application/json' },
      body: JSON.stringify({ png: 'data:image/png;base64,' + PNG.toString('base64'), copies: 2 }) });
    expect(await r.json()).toEqual({ ok: true, labels: 2, cut_mm: 76 });
    await new Promise(res => setTimeout(res, 200));
    const job = received.find(b => b.length > 1000)!;
    let lines = 0; for (let i = 0; i < job.length - 2; i++) if (job[i] === 0x67 && job[i + 1] === 0 && job[i + 2] === 90) { lines++; i += 92; }
    expect(lines).toBe(828 * 2);
    expect(job[job.length - 1]).toBe(0x1a);
    expect(job.includes(Buffer.from([0x1b, 0x69, 0x4d, 0x40]))).toBe(true);
  });
  it('says so when the printer cannot be reached', async () => {
    const h = spawn(process.execPath, ['print-helper/cuedeck-print-helper.mjs', '--printer', '127.0.0.1', '--printer-port', '1', '--port', '17842', '--config', '/nonexistent/cuedeck-station.json', '--no-station']);
    await new Promise(r => setTimeout(r, 600));
    const r = await fetch('http://127.0.0.1:17842/print', { method: 'POST', headers: { Origin: 'https://app.cuedeck.io', 'Content-Type': 'application/json' }, body: JSON.stringify({ png: PNG.toString('base64') }) });
    h.kill();
    expect(r.status).toBe(502);
    expect((await r.json()).error).toMatch(/cannot reach the printer/);
  });
});

describe('print station (badges through CueDeck)', () => {
  it('pairs, takes a queued badge, prints it and reports it done', async () => {
    const { mkdtempSync, readFileSync: rf } = await import('fs');
    const os = await import('os'); const path = await import('path'); const http = await import('http');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cdps-'));
    const calls: Record<string, unknown>[] = [];
    let served = false;
    const api = http.createServer((req, res) => {
      let b = ''; req.on('data', c => b += c); req.on('end', () => {
        const body = JSON.parse(b || '{}'); calls.push({ path: req.url, ...body, apikey: req.headers.apikey });
        res.setHeader('Content-Type', 'application/json');
        if (req.url!.endsWith('/checkin-kiosk-pair')) return res.end(JSON.stringify({ ok: true, event_id: 'e1', device_id: 'd1', label: 'Desk printer', device_key: 'k'.repeat(64), device_kind: 'printer' }));
        if (body.action === 'next') {
          if (!served) { served = true; return res.end(JSON.stringify({ jobs: [{ id: 'j1', png: 'data:image/png;base64,' + PNG.toString('base64'), cut_mm: 76 }] })); }
          return setTimeout(() => res.end(JSON.stringify({ jobs: [] })), 300);
        }
        res.end(JSON.stringify({ ok: true, recorded: true }));
      });
    });
    await new Promise<void>(r => api.listen(0, '127.0.0.1', () => r()));
    const got: Buffer[] = [];
    const prn = net.createServer(s => { const b: Buffer[] = []; s.on('data', d => b.push(d)); s.on('end', () => { got.push(Buffer.concat(b)); s.end(); }); });
    await new Promise<void>(r => prn.listen(0, '127.0.0.1', () => r()));
    const h = spawn(process.execPath, ['print-helper/cuedeck-print-helper.mjs', '--printer', '127.0.0.1', '--printer-port', String((prn.address() as net.AddressInfo).port),
      '--port', '17843', '--pair', 'ABCD-EFGH', '--config', path.join(dir, 'station.json'), '--supabase-url', `http://127.0.0.1:${(api.address() as net.AddressInfo).port}`]);
    for (let i = 0; i < 60 && !calls.some(c => c.action === 'done'); i++) await new Promise(r => setTimeout(r, 100));
    h.kill(); api.close(); prn.close();
    expect(calls[0]).toMatchObject({ path: '/functions/v1/checkin-kiosk-pair', action: 'claim', code: 'ABCD-EFGH', device_kind: 'printer' });
    expect(JSON.parse(rf(path.join(dir, 'station.json'), 'utf8'))).toMatchObject({ event_id: 'e1', label: 'Desk printer' });
    expect(calls.find(c => c.action === 'next')).toMatchObject({ event_id: 'e1', device_key: 'k'.repeat(64) });
    expect(calls.find(c => c.action === 'done')).toMatchObject({ job_id: 'j1', ok: true });
    expect(got.some(b => b[b.length - 1] === 0x1a && b.length > 50000)).toBe(true);
  });
});

describe('zebra and text labels', () => {
  const field = (zpl: string) => { const m = zpl.match(/\^PW(\d+)\^LL(\d+)\^LH0,0\^FO(\d+),0\^GFA,(\d+),\d+,(\d+),([0-9A-F]+)\^FS/)!; return { pw: +m[1], ll: +m[2], x0: +m[3], total: +m[4], row: +m[5], hex: m[6] }; };
  it('a 300 dpi badge on a 203 dpi Zebra is scaled, kept whole and centred', () => {
    const img = { w: 1205, h: 898, gray: new Uint8Array(1205 * 898).fill(0) };   // 102 x 76 mm at 300 dpi
    const f = field(zplLabel(img, { dpi: 203, widthDots: 832 }));
    expect([f.pw, f.ll, f.row]).toEqual([832, 608, Math.ceil(815 / 8)]);
    expect(f.x0).toBe(Math.floor((832 - 815) / 2));
    expect(f.hex.length).toBe(f.total * 2);
  });
  it('a badge wider than the head is turned a quarter, not cut', () => {
    const img = { w: 1800, h: 1200, gray: new Uint8Array(1800 * 1200).fill(255) };   // 152 x 102 mm at 300 dpi
    const f = field(zplLabel(img, { dpi: 300, widthDots: 1248 }));
    expect([f.ll, f.row]).toEqual([1800, 150]);
  });
  it('refuses a badge that fits neither way', () => {
    expect(() => zplLabel({ w: 2400, h: 2400, gray: new Uint8Array(2400 * 2400) }, { dpi: 300, widthDots: 1248 })).toThrow(/mm wide/);
  });
  it('reads what a Zebra says about itself, and nothing else', () => {
    expect(parseZebraInfo('"300""1248""ZD621-300dpi"')).toEqual({ dpi: 300, widthDots: 1248, name: 'ZD621-300dpi' });
    expect(parseZebraInfo('"?"')).toBe(null);
  });
  it('prints text a printer cannot misread as commands', () => {
    expect(zplText([{ text: 'A^XZ~JR', size: 0.1 }])).toContain('^FDA XZ JR^FS');
  });
  it('draws the pairing code across the 62 mm roll', () => {
    const img = textImage([{ text: 'ABCD-EFGH', scale: 9 }]);
    expect(img.w).toBe(696);
    expect(img.gray.some(v => v === 0)).toBe(true);
    expect(toLines(img)).toHaveLength(img.h);
  });
});

describe('print station pairs by showing its own code', () => {
  it('asks for a code with its key hash, prints the code, waits for approval, then takes badges', async () => {
    const { mkdtempSync, readFileSync: rf } = await import('fs');
    const os = await import('os'); const path = await import('path'); const http = await import('http'); const { createHash } = await import('crypto');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cdps-'));
    const calls: Record<string, unknown>[] = [];
    let polls = 0;
    const api = http.createServer((req, res) => {
      let b = ''; req.on('data', c => b += c); req.on('end', () => {
        const body = JSON.parse(b || '{}'); calls.push(body);
        res.setHeader('Content-Type', 'application/json');
        if (body.action === 'request') return res.end(JSON.stringify({ ok: true, code: 'ABCD-EFGH', expires_at: new Date(Date.now() + 60000).toISOString() }));
        if (body.action === 'request_status') {
          const req0 = calls.find(c => c.action === 'request')!;
          if (createHash('sha256').update(String(body.device_key)).digest('hex') !== req0.key_hash) { res.statusCode = 404; return res.end('{}'); }
          return res.end(JSON.stringify(++polls < 2 ? { approved: false } : { approved: true, event_id: 'e1', device_id: 'd1', label: 'Hall printer' }));
        }
        if (body.action === 'next') return setTimeout(() => res.end(JSON.stringify({ jobs: [] })), 200);
        res.end('{}');
      });
    });
    await new Promise<void>(r => api.listen(0, '127.0.0.1', () => r()));
    const got: Buffer[] = [];
    const prn = net.createServer(s => { const b: Buffer[] = []; s.on('data', d => b.push(d)); s.on('end', () => { got.push(Buffer.concat(b)); s.end(); }); });
    await new Promise<void>(r => prn.listen(0, '127.0.0.1', () => r()));
    const h = spawn(process.execPath, ['print-helper/cuedeck-print-helper.mjs', '--printer', '127.0.0.1', '--printer-port', String((prn.address() as net.AddressInfo).port),
      '--port', '17844', '--config', path.join(dir, 'station.json'), '--supabase-url', `http://127.0.0.1:${(api.address() as net.AddressInfo).port}`]);
    for (let i = 0; i < 150 && !calls.some(c => c.action === 'next'); i++) await new Promise(r => setTimeout(r, 100));
    h.kill(); api.close(); prn.close();
    const req0 = calls.find(c => c.action === 'request')!;
    expect(req0).toMatchObject({ device_kind: 'printer', info: { model: 'brother-ql', dpi: 300, width_mm: 59 } });
    expect(String(req0.key_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(calls)).not.toContain('"key":');
    const saved = JSON.parse(rf(path.join(dir, 'station.json'), 'utf8'));
    expect(saved).toMatchObject({ event_id: 'e1', label: 'Hall printer' });
    expect(createHash('sha256').update(saved.device_key).digest('hex')).toBe(req0.key_hash);
    expect(calls.find(c => c.action === 'next')).toMatchObject({ device_key: saved.device_key, info: { model: 'brother-ql' } });
    expect(got.some(b => b[b.length - 1] === 0x1a)).toBe(true);   // the code label was printed
  }, 20000);

  it('as a Zebra station, asks the printer what it is and sends ZPL', async () => {
    const os = await import('os'); const path = await import('path'); const http = await import('http'); const { mkdtempSync, writeFileSync } = await import('fs');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cdps-'));
    writeFileSync(path.join(dir, 'station.json'), JSON.stringify({ event_id: 'e1', device_id: 'd1', label: 'Zebra', device_key: 'k'.repeat(64) }));
    const calls: Record<string, unknown>[] = []; let served = false;
    const api = http.createServer((req, res) => {
      let b = ''; req.on('data', c => b += c); req.on('end', () => {
        const body = JSON.parse(b || '{}'); calls.push(body); res.setHeader('Content-Type', 'application/json');
        if (body.action === 'next' && !served) { served = true; return res.end(JSON.stringify({ jobs: [{ id: 'j1', png: 'data:image/png;base64,' + PNG.toString('base64'), cut_mm: 76 }] })); }
        if (body.action === 'next') return setTimeout(() => res.end(JSON.stringify({ jobs: [] })), 200);
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>(r => api.listen(0, '127.0.0.1', () => r()));
    const got: string[] = [];
    const prn = net.createServer(s => { let b = ''; s.on('data', d => { b += d.toString('latin1'); if (b.includes('getvar')) { s.write('"300""1248""ZD621-300dpi"'); b = ''; } }); s.on('end', () => { if (b) got.push(b); s.end(); }); });
    await new Promise<void>(r => prn.listen(0, '127.0.0.1', () => r()));
    const h = spawn(process.execPath, ['print-helper/cuedeck-print-helper.mjs', '--printer', '127.0.0.1', '--printer-port', String((prn.address() as net.AddressInfo).port), '--model', 'zebra',
      '--port', '17845', '--config', path.join(dir, 'station.json'), '--supabase-url', `http://127.0.0.1:${(api.address() as net.AddressInfo).port}`]);
    for (let i = 0; i < 120 && !calls.some(c => c.action === 'done'); i++) await new Promise(r => setTimeout(r, 100));
    h.kill(); api.close(); prn.close();
    expect(calls.find(c => c.action === 'next')).toMatchObject({ info: { model: 'zebra', dpi: 300, width_mm: 106, name: 'ZD621-300dpi' } });
    expect(calls.find(c => c.action === 'done')).toMatchObject({ job_id: 'j1', ok: true });
    const zpl = got.find(z => z.startsWith('^XA'))!;
    expect(zpl).toMatch(/^\^XA\^PW1248\^LL\d+\^LH0,0\^FO\d+,0\^GFA,/);
  });
});
