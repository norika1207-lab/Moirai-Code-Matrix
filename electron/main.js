// Electron shell：把 Moirai 的 server(src/server.js)直接跑進這個 main process 裡，
// 不再另外 spawn 一個獨立的 Python 子行程。少一層跨語言/跨進程的失敗點。
// 穩定性工程參考自 Code Tree(~/.code-tree)的 electron/main.js：uncaught exception 攔截、
// single instance lock、log 檔、keychain 跳過、loadURL 失敗自動重試。
import { app, BrowserWindow, shell, Tray, Menu, nativeImage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.js';

if (process.platform === 'darwin') app.commandLine.appendSwitch('use-mock-keychain');
app.commandLine.appendSwitch('password-store', 'basic');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HERE = path.join(__dirname, '..');
const PORT = parseInt(process.env.DUO_PORT || '8765', 10);

const LOG = path.join(app.getPath('userData'), 'moirai.log');
function logln(...a) {
  const line = '[' + new Date().toISOString() + '] ' + a.join(' ') + '\n';
  try { fs.appendFileSync(LOG, line); } catch {}
  process.stdout.write(line);
}
process.on('uncaughtException', (e) => logln('UNCAUGHT', (e && e.stack) || e));
process.on('unhandledRejection', (e) => logln('UNHANDLED', (e && e.stack) || e));
// server.js 用 console.log 記錄啟動資訊；從 Finder 雙擊啟動時 stdout 沒地方去，導向 log 檔。
const _origLog = console.log.bind(console);
console.log = (...a) => { logln('[server]', ...a.map(String)); };
console.error = (...a) => { logln('[server:err]', ...a.map(String)); };

let win = null;
let tray = null;
let closer = null; // server.close()

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
}

function loadWithRetry(url, tries = 30) {
  win.loadURL(url).catch(() => {
    if (tries > 0) setTimeout(() => loadWithRetry(url, tries - 1), 150);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    backgroundColor: '#F5F5F7',
    title: 'Moirai',
    icon: path.join(HERE, 'logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
    },
  });
  loadWithRetry(`http://127.0.0.1:${PORT}/`);
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => { win = null; });
}

app.whenReady().then(async () => {
  if (!gotLock) return;
  logln('app ready, userData=', app.getPath('userData'));
  try {
    const started = await startServer({ HERE, port: PORT });
    closer = started.close;
    logln('server up on port', started.port);
  } catch (e) {
    logln('SERVER START FAILED', (e && e.stack) || e);
  }
  createWindow();

  if (process.platform === 'darwin') {
    try {
      const dockIcon = nativeImage.createFromPath(path.join(HERE, 'logo.png'));
      if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon);
    } catch {}
  }

  try {
    const icon = nativeImage.createFromPath(path.join(HERE, 'tray-icon.png'));
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  } catch {
    tray = new Tray(nativeImage.createEmpty());
  }
  tray.setToolTip('Moirai');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '開啟視窗', click: () => { if (!win) createWindow(); else win.show(); } },
    { type: 'separator' },
    { label: '結束', click: () => app.quit() },
  ]));
  tray.on('click', () => { if (!win) createWindow(); else win.show(); });
});

app.on('window-all-closed', () => {
  // macOS 慣例：關視窗不代表退出，tray 還留著
});
app.on('activate', () => { if (!win) createWindow(); });
app.on('before-quit', async () => {
  if (closer) { try { await closer(); } catch {} closer = null; }
});
