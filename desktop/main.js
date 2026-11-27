// Layover Logbook for Windows.
// Opens the live app in its own window, so crew always get the latest version.
// The app keeps working offline after the first visit (it caches itself).
const { app, BrowserWindow, shell, Menu, session } = require("electron");
const path = require("path");

const SITES = [
  "https://layoverlogbook.github.io/app.html",
  "https://karawene112.github.io/layover/app.html"
];
const OUR_HOSTS = ["layoverlogbook.com", "www.layoverlogbook.com", "layoverlogbook.github.io", "karawene112.github.io"];
// Payment and sign-in pages that must open inside the app window
const INSIDE_HOSTS = ["paddle.com", "paddle.io", "supabase.co"];

let win = null;

function isOurs(url) {
  try {
    const h = new URL(url).hostname;
    return OUR_HOSTS.includes(h) || INSIDE_HOSTS.some(d => h === d || h.endsWith("." + d));
  } catch (e) { return false; }
}

function openOutside(url) {
  if (/^(https?|mailto|tel):/i.test(url)) shell.openExternal(url);
}

function load(i) {
  if (i >= SITES.length) {
    win.loadFile(path.join(__dirname, "offline.html"));
    return;
  }
  win.loadURL(SITES[i]).catch(() => {}); // failures are handled in did-fail-load
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 840,
    minWidth: 380,
    minHeight: 600,
    title: "Layover Logbook",
    icon: path.join(__dirname, "icon.png"),
    backgroundColor: "#13233F",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
  });
  Menu.setApplicationMenu(null);
  win.once("ready-to-show", () => win.show());

  // Links to other websites open in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isOurs(url)) return { action: "allow" };
    openOutside(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url.startsWith("file:") || isOurs(url)) return;
    e.preventDefault();
    openOutside(url);
  });

  // Location for "near me": ask Windows, like a browser would
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(["geolocation", "notifications", "clipboard-sanitized-write", "fullscreen"].includes(permission));
  });

  let tried = 0;
  win.webContents.on("did-fail-load", (e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = navigation replaced, not an error
    tried += 1;
    load(tried);
  });

  load(0);
}

// Only one window at a time: a second launch brings the first back
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.setAppUserModelId("io.github.layoverlogbook.desktop");
  app.whenReady().then(createWindow);
  app.on("window-all-closed", () => app.quit());
}
