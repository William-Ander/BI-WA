const { app, BrowserWindow, shell, dialog } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

let serverProcess = null;
const rootDir = path.join(__dirname, '..');
const port = process.env.PORT || '3000';
const appMode = process.env.APP_MODE || 'desktop';
const serverEngine = String(process.env.BIWA_SERVER_ENGINE || 'node').toLowerCase();
const appUrl = `http://127.0.0.1:${port}`;

function waitForServer(url, timeoutMs = 20000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const req = http.get(`${url}/api/health`, (res) => {
        res.resume();
        if (res.statusCode >= 200 && res.statusCode < 500) return resolve(true);
        retry();
      });
      req.on('error', retry);
      req.setTimeout(1500, () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - startedAt > timeoutMs) return reject(new Error('O servidor local do BI WA nao respondeu a tempo.'));
      setTimeout(check, 600);
    };
    check();
  });
}

function startServer() {
  const env = { ...process.env, APP_MODE: appMode, PORT: port };
  try {
    if (serverEngine === 'python' || serverEngine === 'fastapi') {
      const pythonCommand = process.env.PYTHON_COMMAND || (process.platform === 'win32' ? 'python.exe' : 'python3');
      env.API_PORT = port;
      serverProcess = spawn(pythonCommand, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', port], {
        cwd: path.join(rootDir, 'python_backend'),
        env,
        stdio: 'inherit',
        windowsHide: true
      });
    } else {
      const nodeCommand = process.execPath || (process.platform === 'win32' ? 'node.exe' : 'node');
      serverProcess = spawn(nodeCommand, ['server.js'], {
        cwd: rootDir,
        env,
        stdio: 'inherit',
        windowsHide: true
      });
    }
  } catch (err) {
    serverProcess = null;
    dialog.showErrorBox('Erro ao iniciar o BI WA', 'Nao foi possivel iniciar o servidor: ' + (err.message || String(err)));
    return;
  }
  if (!serverProcess) {
    dialog.showErrorBox('Erro ao iniciar o BI WA', 'O servidor local nao pode ser iniciado. Verifique se node ou python estao instalados e no PATH.');
    return;
  }
  serverProcess.on('error', (err) => {
    dialog.showErrorBox('Erro ao iniciar o BI WA', err.message || String(err));
  });
  serverProcess.on('exit', (code) => {
    if (code && code !== 0) {
      console.error(`Servidor BI WA encerrado com codigo ${code}`);
    }
  });
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 760,
    title: appMode === 'online' ? 'BI WA Online' : `BI WA Desktop/Admin${serverEngine === 'python' ? ' - Python' : ''}`,
    icon: path.join(rootDir, 'public', 'app-icon.ico'),
    show: false,
    backgroundColor: '#0f172a',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });

  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  try {
    await waitForServer(appUrl);
    await win.loadURL(appUrl);
  } catch (err) {
    dialog.showErrorBox('BI WA nao iniciou', err.message || String(err));
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
      <html><body style="font-family:Segoe UI,Arial;background:#0f172a;color:#fff;padding:32px">
        <h1>BI WA</h1><p>Nao foi possivel iniciar o servidor local.</p>
        <p>Verifique se as dependencias do Node.js ou Python/FastAPI foram instaladas e tente novamente.</p>
      </body></html>`));
    win.show();
  }
}

app.setAppUserModelId('br.com.rlhortifruti.biwa');
app.whenReady().then(() => {
  startServer();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill('SIGTERM');
    setTimeout(() => {
      if (serverProcess && !serverProcess.killed) serverProcess.kill('SIGKILL');
    }, 5000);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
