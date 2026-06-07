const { app, BrowserWindow, Tray, Menu, nativeImage, systemPreferences } = require('electron');
const path = require('path');

// Simple 16x16 white circle icon for the tray
const iconBase64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAHhJREFUOE+lk8ENwCAIQz+b0b2b0b1T4S21QtoerB/xAxIEQ1oATbLkV8ACXN3D9q17wcQDcHUP27fuBRMPwNU9bN+6F0w8AFf3sH3rXjDxAFzdw/ate8HEAwT3kOS/z1+gB8zAE1jAH/gFkMAmMAA3YAE/gA4wAVyXKRX50zG0AAAAAElFTkSuQmCC';

let tray = null;
let mainWindow = null;

// Hide the application from the macOS dock
if (app.dock) {
  app.dock.hide();
}

// Ensure the application starts when the user logs in
app.setLoginItemSettings({
  openAtLogin: true,
  openAsHidden: true
});

app.whenReady().then(async () => {
  // Request camera access on macOS if not already granted
  if (process.platform === 'darwin') {
    const status = systemPreferences.getMediaAccessStatus('camera');
    if (status !== 'granted') {
      await systemPreferences.askForMediaAccess('camera');
    }
  }

  createWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1060,
    height: 700,
    show: false, // Start hidden!
    center: true,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // Automatically grant camera permissions to the renderer process
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') {
      callback(true);
    } else {
      callback(false);
    }
  });

  // Load the standard index.html
  mainWindow.loadFile('index.html');

  // Prevent window from being fully destroyed on close so it stays in background
  mainWindow.on('close', (event) => {
    if (!app.isQuiting) {
      event.preventDefault();
      mainWindow.hide();
    }
    return false;
  });
}

function createTray() {
  const icon = nativeImage.createFromDataURL(`data:image/png;base64,${iconBase64}`);
  tray = new Tray(icon);
  
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show Dashboard', click: () => {
        mainWindow.show();
        mainWindow.focus();
      }
    },
    { type: 'separator' },
    { label: 'Quit GestureLight', click: () => {
        app.isQuiting = true;
        app.quit();
      }
    }
  ]);
  
  tray.setToolTip('GestureLight is running in the background');
  tray.setContextMenu(contextMenu);

  // Left click toggles window
  tray.on('click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// Keep application running in background when all windows are closed
app.on('window-all-closed', () => {
  // No-op prevents default quit
});
