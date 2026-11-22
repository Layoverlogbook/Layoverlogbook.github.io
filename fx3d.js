/* Depth and motion: an aurora sky behind the app, cards that tilt toward the pointer,
   and cards that swing up into place as they scroll in. Skipped with reduced motion. */
(function () {
  "use strict";
  var reduce = false, fine = false;
  try { reduce = matchMedia("(prefers-reduced-motion: reduce)").matches; fine = matchMedia("(hover: hover) and (pointer: fine)").matches; } catch (e) {}

  /* aurora sky */
  var sky = document.createElement("div");
  sky.className = "aurora"; sky.setAttribute("aria-hidden", "true");
  sky.innerHTML = "<i></i><i></i><i></i>";
  document.body.insertBefore(sky, document.body.firstChild);
  if (reduce) return;

  /* pointer tilt */
  var SEL = ".pass,.tg-hero,.tile,.tg-today,.card.tilt";
  var cur = null, raf = 0, last = null;
  function apply() {
    raf = 0; if (!cur || !last) return;
    var r = cur.getBoundingClientRect();
    var x = (last.clientX - r.left) / r.width - 0.5, y = (last.clientY - r.top) / r.height - 0.5;
    var max = cur.classList.contains("tile") ? 10 : 5;
    cur.style.setProperty("--ry", (x * max).toFixed(2) + "deg");
    cur.style.setProperty("--rx", (-y * max).toFixed(2) + "deg");
    cur.style.setProperty("--gx", ((x + 0.5) * 100).toFixed(1) + "%");
    cur.style.setProperty("--gy", ((y + 0.5) * 100).toFixed(1) + "%");
  }
  function reset(n) { if (!n) return; n.classList.remove("tilting"); n.style.removeProperty("--rx"); n.style.removeProperty("--ry"); }
  if (fine) {
    document.addEventListener("pointermove", function (e) {
      if (e.buttons) return; /* leave dragging (the globe) alone */
      var t = e.target.closest && e.target.closest(SEL);
      if (t !== cur) { reset(cur); cur = t; if (cur) cur.classList.add("tilting"); }
      last = e; if (cur && !raf) raf = requestAnimationFrame(apply);
    }, { passive: true });
    document.addEventListener("pointerleave", function () { reset(cur); cur = null; });
  }

  /* swing cards into place as they scroll in */
  if (!("IntersectionObserver" in window)) return;
  document.documentElement.classList.add("fx-reveal");
  var io = new IntersectionObserver(function (es) {
    es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("seen"); io.unobserve(e.target); } });
  }, { rootMargin: "0px 0px -6% 0px", threshold: 0.01 });
  function watch() { document.querySelectorAll("main .card:not(.seen),main .tg-hero:not(.seen)").forEach(function (n) { io.observe(n); }); }
  watch();
  new MutationObserver(function () { clearTimeout(watch.t); watch.t = setTimeout(watch, 120); }).observe(document.querySelector("main") || document.body, { childList: true, subtree: true });
  /* never leave anything hidden: show whatever is on screen after a moment */
  setTimeout(function () {
    document.querySelectorAll("main .card:not(.seen),main .tg-hero:not(.seen)").forEach(function (n) {
      var r = n.getBoundingClientRect(); if (r.top < innerHeight && r.bottom > 0) n.classList.add("seen");
    });
  }, 1500);
})();
