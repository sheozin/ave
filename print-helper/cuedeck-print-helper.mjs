#!/usr/bin/env node
// CueDeck print station, command line. The same station as the desktop app
// (print-station-app/); both run station-core.mjs.
//
//   node cuedeck-print-helper.mjs --printer 192.168.1.50 [--model brother|zebra]
//
// The first time, it shows a pairing code and prints it on the printer;
// type that code in CueDeck (Event admin > Kiosk & scanners > Print
// stations, or the desk's Kiosk or scanner > Print station). After that it
// just starts. Find printers on this network (Mac): --find
// The older route still works: --pair CODE with a code made on the desk.
// --no-station: only the local route for a desk in Chrome on this computer.
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createStation, VERSION } from './station-core.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : (process.env['CUEDECK_' + k.toUpperCase().replace(/-/g, '_')] ?? d); };
const flag = (k) => process.argv.includes('--' + k);
if (flag('find')) await findPrinters();
const PRINTER = arg('printer', '');
if (!PRINTER) { console.error('Give the printer address: node cuedeck-print-helper.mjs --printer 192.168.1.50   (or --find to look for it)'); process.exit(2); }

// Label printers announce themselves over Bonjour. macOS has dns-sd;
// elsewhere, print the printer's network settings page instead.
// Output, one per line: "<name>: <address>" (install.sh reads it).
async function findPrinters() {
  if (process.platform !== 'darwin') { console.log('On this computer, read the address from the printer: print its network settings page.'); process.exit(0); }
  const run = (args, ms) => new Promise(ok => { const p = execFile('dns-sd', args, { timeout: ms }, () => {}); let out = ''; p.stdout.on('data', d => out += d); setTimeout(() => { p.kill(); ok(out); }, ms); });
  const names = [...(await run(['-B', '_pdl-datastream._tcp', 'local.'], 3000)).matchAll(/_pdl-datastream\._tcp\.\s+(.+)$/gm)].map(m => m[1].trim()).filter(n => /brother|zebra/i.test(n));
  if (!names.length) { console.log('No Brother or Zebra printer found on this network. Is it switched on and on the same Wi-Fi?'); process.exit(1); }
  for (const n of [...new Set(names)]) {
    const host = ((await run(['-L', n, '_pdl-datastream._tcp', 'local.'], 2500)).match(/can be reached at (\S+?)\.?:\d+/) || [])[1];
    const ip = host ? ((await run(['-G', 'v4', host], 2000)).match(/(\d+\.\d+\.\d+\.\d+)/) || [])[1] : null;
    console.log(`${n}: ${ip || 'address not found'}`);
  }
  process.exit(0);
}

const st = createStation({
  printer: PRINTER, printerPort: Number(arg('printer-port', 9100)),
  model: /zebra/i.test(arg('model', '')) ? 'zebra' : 'brother-ql', dpi: Number(arg('dpi', 203)),
  cutMm: Number(arg('cut-mm', 76)), marginDots: Number(arg('margin-dots', 35)),
  configPath: arg('config', path.join(os.homedir(), '.cuedeck-print-station.json')),
  supabaseUrl: arg('supabase-url', undefined),
  onEvent: (type, d) => {
    const t = new Date().toISOString();
    if (type === 'code') console.log(`\n  Pairing code:  ${d.code}\n  Type it in CueDeck: Event admin > Kiosk & scanners > Print stations\n  (or on the desk: Kiosk or scanner > Print station).\n`);
    else if (type === 'paired') console.log(d.resumed ? `Print station "${d.label}": waiting for badges from CueDeck.` : `Paired as "${d.label}".`);
    else if (type === 'printed') console.log(t, 'printed a badge from CueDeck at', d.cut_mm, 'mm');
    else if (type === 'failed') console.error(t, 'badge not printed:', d);
    else if (type === 'offline') console.log('Cannot reach CueDeck (' + d + '); retrying.');
    else if (type === 'unpaired') console.error('This print station was removed from the event. Pairing again.');
    else if (type === 'log') console.log(d);
  },
});
if (!st.profile().model) process.exit(1);
st.listen(Number(arg('port', 7841)));
const p = await st.detect();
console.log(`CueDeck print station ${VERSION}: ${p.name} at ${PRINTER} (${p.dpi} dpi${p.model === 'brother-ql' ? ', 62 mm roll' : ', ' + st.info().width_mm + ' mm wide'})`);
st.status().then(s => console.log('printer:', s.errors.length ? s.errors.join(', ') : 'reachable', s.media ? `(${s.media.width_mm} mm ${s.media.type})` : ''),
                 e => console.log('printer:', e.message));

const pairArg = arg('pair', '');
if (flag('no-station')) console.log('Station off (--no-station): only this computer\'s desk prints.');
else if (flag('pair') && pairArg && !pairArg.startsWith('--')) st.run({ deskCode: pairArg }).catch(e => { console.error(e.message); process.exit(1); });
else {
  if (flag('pair')) st.forget();
  st.run();
}
