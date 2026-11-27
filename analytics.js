/* Cookieless audience measurement for layoverlogbook.github.io.
   Sends one anonymous record per page view to the site's own Supabase database:
   the page path, the referring website (domain only), the browser language (2 letters),
   the type of device, and whether this view started a visit.
   No cookies, no IP address, no identifier, nothing shared with third parties.
   Also notes whether the page was opened as an installed app, and marks the first open of each install.
   Respects "Do Not Track" and "Global Privacy Control". */
(function () {
  try {
    if (navigator.doNotTrack === "1" || window.doNotTrack === "1" || navigator.globalPrivacyControl) return;
    if (!/(^|\.)(github\.io|layoverlogbook\.com)$/.test(location.hostname)) return; // only the live site, never local tests
    if (/bot|crawl|spider|headless|lighthouse/i.test(navigator.userAgent)) return;

    var entry = false;
    try { if (!sessionStorage.getItem("lv")) { entry = true; sessionStorage.setItem("lv", "1"); } } catch (e) { entry = true; }

    var ref = null;
    try { if (document.referrer) { var h = new URL(document.referrer).hostname; if (h !== location.hostname) ref = h; } } catch (e) {}

    var w = Math.min(screen.width || 0, screen.height || 0) || window.innerWidth;
    var device = w < 600 ? "phone" : w < 1024 && (navigator.maxTouchPoints || 0) > 0 ? "tablet" : "desktop";

    // Opened as an installed app (home screen, Android app or desktop app)? The first open of each install is marked once.
    var app = null;
    try {
      if (/LayoverLogbookAndroid/.test(navigator.userAgent)) app = "android";
      else if (/Electron/.test(navigator.userAgent)) app = "desktop";
      else if (navigator.standalone || matchMedia("(display-mode: standalone)").matches) app = "home_screen";
    } catch (e) {}
    var install = false;
    if (app) { try { if (!localStorage.getItem("lv_inst")) { install = true; localStorage.setItem("lv_inst", "1"); } } catch (e) {} }

    var body = JSON.stringify({
      p_path: location.pathname,
      p_ref: ref,
      p_lang: (navigator.language || "").slice(0, 2).toLowerCase(),
      p_device: device,
      p_entry: entry,
      p_app: app,
      p_install: install
    });
    var url = "https://zzgtxastnmxzffygdkrg.supabase.co/rest/v1/rpc/track_view";
    var key = "sb_publishable_zdlCSLo3OOHr7GdWQmCHng_hpQCiYT-"; // public key, safe in the browser
    fetch(url, {
      method: "POST", keepalive: true, credentials: "omit",
      headers: { "Content-Type": "application/json", apikey: key },
      body: body
    }).catch(function () {});
  } catch (e) {}
})();
