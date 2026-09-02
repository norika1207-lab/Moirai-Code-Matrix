const { app, BrowserWindow, shell, Tray, Menu, nativeImage } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const PORT = 8765;
let win = null;
let tray = null;
let pyProc = null;

// 啟動 Python server
function startPython() {
  const scriptDir = path.join(__dirname, '..');
  pyProc = spawn('python3', ['app.py'], {
    cwd: scriptDir,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pyProc.stdout.on('data', d => process.stdout.write('[py] ' + d));
  pyProc.stderr.on('data', d => process.stderr.write('[py] ' + d));
  pyProc.on('exit', code => {
    if (code !== 0 && code !== null) process.stderr.write(`[py] exited ${code}\n`);
    pyProc = null;
  });
}

// 等 server 起來再開視窗（最多等 8 秒）
function waitReady(cb, tries = 0) {
  const req = http.get(`http://127.0.0.1:${PORT}/`, res => {
    res.resume();
    cb();
  });
  req.on('error', () => {
    if (tries > 40) { cb(); return; }   // 超時強制開
    setTimeout(() => waitReady(cb, tries + 1), 200);
  });
  req.end();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Code-Duo',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });
  win.loadURL(`http://127.0.0.1:${PORT}/`);

  // 外部連結在瀏覽器開,不在 Electron 裡開
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  startPython();
  waitReady(createWindow);

  // Tray icon（用文字當 placeholder，之後可換 logo.svg 轉 png）
  try {
    const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'logo.png'));
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  } catch {
    tray = new Tray(nativeImage.createEmpty());
  }
  tray.setToolTip('Code-Duo');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '開啟視窗', click: () => { if (!win) createWindow(); else win.show(); } },
    { type: 'separator' },
    { label: '結束', click: () => app.quit() },
  ]));
  tray.on('click', () => { if (!win) createWindow(); else win.show(); });
});

app.on('window-all-closed', () => {
  // macOS 慣例:關視窗不代表退出,tray 還留著
  // 如果想改成關視窗就退出,把下面這行取消注釋:
  // app.quit();
});

app.on('activate', () => {
  if (!win) createWindow();
});

app.on('before-quit', () => {
  if (pyProc) {
    pyProc.kill('SIGTERM');
    pyProc = null;
  }
});
