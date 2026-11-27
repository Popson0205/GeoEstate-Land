// Land Registry desktop — a thin native shell around the hosted GeoEstate Land Registry web app. It loads the live
// site (so sign-in via GeoEstate ID and the whole backend work exactly as in a browser), adds a real app window, a
// menu, and a Windows file association so a .landreg register pack opens in the app. No app data lives here; this is
// the "software" wrapper, step one off the web.
const { app, BrowserWindow, Menu, shell, ipcMain, dialog } = require("electron");
const fs = require("fs");
const path = require("path");

// Where the hosted app lives. Override order: LANDREGISTRY_URL env → <userData>/config.json {"url": "..."} → default.
const DEFAULT_URL = "https://land.geoestate.ng";
function appUrl() {
  if (process.env.LANDREGISTRY_URL) return process.env.LANDREGISTRY_URL.replace(/\/$/, "");
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "config.json"), "utf8"));
    if (cfg && typeof cfg.url === "string" && cfg.url) return cfg.url.replace(/\/$/, "");
  } catch { /* no config yet */ }
  return DEFAULT_URL;
}
const APP_URL = appUrl();
const APP_ORIGIN = (() => { try { return new URL(APP_URL).origin; } catch { return null; } })();

let win = null;
let pendingFile = null;   // a .landreg chosen before the window/renderer was ready

/** A .landreg path from the command line (Windows/Linux file association), if any. */
function fileFromArgv(argv) {
  return (argv || []).slice(1).find((a) => a && a.toLowerCase().endsWith(".landreg") && fs.existsSync(a)) || null;
}

/** Read a .landreg file and hand it to the renderer (the hosted app picks it up via the preload bridge). */
function openPackFile(filePath) {
  if (!filePath) return;
  try {
    const data = fs.readFileSync(filePath);
    const payload = { name: path.basename(filePath), base64: data.toString("base64") };
    if (win && !win.webContents.isLoading()) win.webContents.send("landregistry:open-pack", payload);
    else pendingFile = payload;   // deliver once the page has loaded
  } catch (e) {
    dialog.showErrorBox("Land Registry", `Could not read the file:\n${e.message}`);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 900, minWidth: 900, minHeight: 600,
    backgroundColor: "#0a1830", show: false, autoHideMenuBar: false,
    title: "Land Registry",
    icon: path.join(__dirname, "assets", process.platform === "win32" ? "icon.ico" : "icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });

  win.once("ready-to-show", () => win.show());
  win.loadURL(APP_URL);

  // When the hosted page has loaded, flush any file that was waiting.
  win.webContents.on("did-finish-load", () => {
    if (pendingFile) { win.webContents.send("landregistry:open-pack", pendingFile); pendingFile = null; }
  });

  // Keep navigation inside the app; open everything else (docs, external links) in the real browser.
  const external = (url) => { if (APP_ORIGIN && new URL(url).origin !== APP_ORIGIN) { shell.openExternal(url); return true; } return false; };
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (external(url)) e.preventDefault(); });

  win.webContents.on("render-process-gone", () => win && win.reload());
  win.on("closed", () => { win = null; });
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        { label: "Open file…", accelerator: "CmdOrCtrl+O", click: async () => {
            const r = await dialog.showOpenDialog(win, { title: "Open Land Registry file", filters: [{ name: "Land Registry pack", extensions: ["landreg"] }], properties: ["openFile"] });
            if (!r.canceled && r.filePaths[0]) openPackFile(r.filePaths[0]);
          } },
        { label: "New window", accelerator: "CmdOrCtrl+N", click: () => { if (!win) createWindow(); else win.focus(); } },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "View", submenu: [
        { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => win && win.reload() },
        { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" },
      ] },
    { label: "Help", submenu: [
        { label: "Land Registry on the web", click: () => shell.openExternal(APP_URL) },
        { label: "About Land Registry", click: () => dialog.showMessageBox(win, { type: "info", title: "About Land Registry",
            message: `Land Registry ${app.getVersion()}`, detail: `GeoEstate · Parcel fabric and register as desktop software\nConnected to: ${APP_URL}` }) },
      ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Single instance: a second launch (e.g. double-clicking a .landreg) focuses the window and opens the file.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    openPackFile(fileFromArgv(argv));
  });
  app.on("open-file", (e, p) => { e.preventDefault(); if (app.isReady()) openPackFile(p); else pendingFile = { path: p }; });

  app.whenReady().then(() => {
    buildMenu();
    createWindow();
    // macOS may have queued a path object; Windows/Linux pass it on argv.
    if (pendingFile && pendingFile.path) { const p = pendingFile.path; pendingFile = null; openPackFile(p); }
    else openPackFile(fileFromArgv(process.argv));
    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
}

// The renderer asks for the connected URL (for a small "connected to" note) and confirms the bridge is present.
ipcMain.handle("landregistry:info", () => ({ version: app.getVersion(), url: APP_URL, platform: process.platform }));
