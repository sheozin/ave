// CueDeck Print Station: the desktop app. A window to choose the printer
// and pair, a menu-bar (tray) icon that says whether it is ready, and the
// same station as the command line (core/station-core.mjs, copied from
// print-helper/ by `npm run sync`). Closing the window keeps it printing;
// Quit is in the menu-bar icon.
import { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Bonjour } from 'bonjour-service';
import { createStation, VERSION } from './core/station-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAIR_URL = 'https://app.cuedeck.io/checkin/pair-printer';
// Tests run against a throwaway settings folder.
if (process.env.CUEDECK_PS_USERDATA) app.setPath('userData', process.env.CUEDECK_PS_USERDATA);
if (!app.requestSingleInstanceLock()) app.quit();

let win = null, tray = null, station = null, server = null;
const ui = { version: VERSION, phase: 'setup', printer: null, code: null, label: null, online: false,
             printedToday: 0, lastPrinted: null, error: null, openAtLogin: false };

const file = (name) => path.join(app.getPath('userData'), name);
const readJson = (name) => { try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch (_) { return null; } };
const writeJson = (name, v) => fs.writeFileSync(file(name), JSON.stringify(v, null, 2), { mode: 0o600 });

function push() {
  if (win && !win.isDestroyed()) win.webContents.send('state', ui);
  if (tray) {
    tray.setToolTip('CueDeck Print Station: ' + statusLine());
    tray.setContextMenu(trayMenu());
  }
}
function statusLine() {
  if (ui.phase === 'setup') return 'choose a printer';
  if (ui.phase === 'code') return 'waiting to be paired (code ' + ui.code + ')';
  if (ui.phase === 'ready') return ui.error ? 'problem: ' + ui.error : ui.online ? 'ready, ' + ui.printedToday + ' printed today' : 'cannot reach CueDeck';
  return 'starting';
}

function onEvent(type, d) {
  if (type === 'code') { ui.phase = 'code'; ui.code = d.code; ui.label = null; }
  else if (type === 'paired') { ui.phase = 'ready'; ui.code = null; ui.label = d.label; ui.error = null; }
  else if (type === 'online') { ui.online = true; ui.error = null; }
  else if (type === 'offline') { ui.online = false; }
  else if (type === 'printed') { ui.printedToday = d.count; ui.lastPrinted = new Date().toISOString(); ui.error = null; }
  else if (type === 'failed') { ui.error = d; }
  else if (type === 'unpaired') { ui.phase = 'code'; ui.label = null; }
  else return;
  push();
}

function startStation() {
  if (station) station.stop();
  if (server) { server.close(); server = null; }
  station = null;
  if (!ui.printer) { ui.phase = 'setup'; push(); return; }
  ui.phase = 'starting'; ui.error = null; push();
  station = createStation({ printer: ui.printer.host, model: ui.printer.model, configPath: file('station.json'), onEvent });
  server = station.listen(7841);
  const mine = station;
  station.detect().then(() => mine.run()).catch(e => { ui.error = e.message; push(); });
}

// Label printers announce themselves on the network (Bonjour/mDNS).
function discover(ms = 4000) {
  return new Promise((resolve) => {
    const bj = new Bonjour();
    const found = new Map();
    const browser = bj.find({ type: 'pdl-datastream' }, (s) => {
      const host = (s.addresses || []).find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a));
      if (!host || !/brother|zebra/i.test(s.name)) return;
      found.set(host, { name: s.name, host, model: /zebra/i.test(s.name) ? 'zebra' : 'brother-ql' });
    });
    setTimeout(() => { browser.stop(); bj.destroy(); resolve([...found.values()]); }, ms);
  });
}

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: 'CueDeck Print Station: ' + statusLine(), enabled: false },
    ...(ui.printer ? [{ label: 'Printer: ' + ui.printer.name + ' (' + ui.printer.host + ')', enabled: false }] : []),
    { type: 'separator' },
    { label: 'Open…', click: showWindow },
    { label: 'Print a test label', enabled: !!station, click: testPrint },
    { label: 'Start when this computer starts', type: 'checkbox', checked: ui.openAtLogin, click: (i) => setLogin(i.checked) },
    { type: 'separator' },
    { label: 'Quit (badges stop printing here)', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
}

function showWindow() {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 460, height: 620, resizable: false, title: 'CueDeck Print Station', show: false, backgroundColor: '#F5F5F7',
    webPreferences: { preload: path.join(HERE, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(HERE, 'ui.html'));
  win.once('ready-to-show', () => win.show());
  // Closing the window keeps the station printing.
  win.on('close', (e) => { if (!app.isQuitting) { e.preventDefault(); win.hide(); } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}

async function testPrint() {
  if (!station) return;
  try { await station.printText([{ text: 'CUEDECK', scale: 6 }, { text: 'TEST PRINT', scale: 6 }, { text: ui.label || 'NOT PAIRED YET', scale: 4 }]); ui.error = null; }
  catch (e) { ui.error = e.message; }
  push();
}
function setLogin(on) {
  app.setLoginItemSettings({ openAtLogin: !!on, openAsHidden: true });
  ui.openAtLogin = !!on; push();
}

ipcMain.handle('state', () => ui);
ipcMain.handle('discover', () => discover());
ipcMain.handle('choose', (_e, p) => {
  if (!p || !/^[0-9a-zA-Z.:-]{1,64}$/.test(String(p.host || ''))) return { error: 'That is not a printer address.' };
  ui.printer = { host: String(p.host), name: String(p.name || p.host).slice(0, 80), model: p.model === 'zebra' ? 'zebra' : 'brother-ql' };
  writeJson('settings.json', { printer: ui.printer });
  startStation();
  return { ok: true };
});
ipcMain.handle('change-printer', () => { if (station) station.stop(); if (server) { server.close(); server = null; } station = null; ui.printer = null; ui.phase = 'setup'; push(); });
ipcMain.handle('test', testPrint);
ipcMain.handle('unpair', () => { if (station) station.forget(); startStation(); });
ipcMain.handle('open-pair', () => {
  if (!ui.code) return;
  shell.openExternal(PAIR_URL + '?code=' + encodeURIComponent(ui.code.replace(/-/g, '')) + '&name=' + encodeURIComponent((ui.printer && ui.printer.name || '').slice(0, 60)));
});
ipcMain.handle('login', (_e, on) => setLogin(on));

// Cmd+Q, the Dock and the tray's Quit all go through here: let the window close.
app.on('before-quit', () => { app.isQuitting = true; if (station) station.stop(); });
app.on('second-instance', showWindow);
app.on('activate', showWindow);
app.on('window-all-closed', () => {});   // keep printing from the menu bar
app.whenReady().then(() => {
  const img = nativeImage.createFromPath(path.join(HERE, 'build', 'trayTemplate.png'));
  img.setTemplateImage(true);
  tray = new Tray(img);
  ui.openAtLogin = app.getLoginItemSettings().openAtLogin;
  const s = readJson('settings.json');
  ui.printer = s && s.printer ? s.printer : null;
  startStation();
  if (!app.getLoginItemSettings().wasOpenedAsHidden) showWindow();
  push();
});
