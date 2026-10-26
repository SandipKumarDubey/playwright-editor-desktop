// Desktop shell: starts the local runner on a free port and shows the editor in a window.
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const { start } = require('./server');

let server = null;
let win = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(async () => {
    try {
      server = await start({
        port: 0,                                                    // any free port
        runsDir: path.join(app.getPath('userData'), 'runs'),         // writable location
        nodePath: path.join(__dirname, 'node_modules'),              // so tests can require('@playwright/test')
        desktop: true,
      });
    } catch (e) {
      require('electron').dialog.showErrorBox('Playwright Editor', 'Could not start the runner: ' + e.message);
      return app.quit();
    }

    const origin = `http://127.0.0.1:${server.port}`;
    win = new BrowserWindow({
      width: 1200, height: 900, minWidth: 820, minHeight: 600,
      title: 'Playwright Editor', autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });

    // Links (e.g. screenshots) open in the normal browser; the window never leaves the editor.
    win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
    win.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith(origin)) { e.preventDefault(); shell.openExternal(url); }
    });

    win.loadURL(origin + '/');
    win.on('closed', () => { win = null; });
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { if (server) server.close(); });
}
