// The only bridge between the native shell and the hosted Land Registry page. It exposes a tiny, safe API: the web
// app can learn it's running in the desktop shell, and receive a .landreg file the user opened from the OS
// (double-click or File → Open). Everything else about the page is unchanged from the browser.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("landRegistryDesktop", {
  isDesktop: true,
  info: () => ipcRenderer.invoke("landregistry:info"),
  // Register a handler for a file opened from the OS. Returns an unsubscribe function.
  onOpenPack: (cb) => {
    const h = (_e, payload) => { try { cb(payload); } catch { /* ignore */ } };
    ipcRenderer.on("landregistry:open-pack", h);
    return () => ipcRenderer.removeListener("landregistry:open-pack", h);
  },
});
