/* The Sentinel Report: site behaviour. No dependencies. Everything here enhances a page that is
   already complete without it. */
(function () {
  "use strict";
  var doc = document.documentElement;

  function store(k, v) {
    try { if (v === undefined) return window.localStorage.getItem(k); window.localStorage.setItem(k, v); } catch (e) { return null; }
    return null;
  }
  function tok(name) { return getComputedStyle(doc).getPropertyValue("--" + name).trim(); }

  /* theme: system → light → dark */
  var btn = document.querySelector(".theme-btn");
  var saved = store("tsr-theme");
  if (saved === "light" || saved === "dark") doc.setAttribute("data-theme", saved);
  function label() {
    var t = doc.getAttribute("data-theme");
    if (btn) btn.textContent = t ? (t === "light" ? "Light" : "Dark") : "Auto";
  }
  label();
  if (btn) btn.addEventListener("click", function () {
    var t = doc.getAttribute("data-theme");
    var next = !t ? "light" : (t === "light" ? "dark" : null);
    if (next) doc.setAttribute("data-theme", next); else doc.removeAttribute("data-theme");
    store("tsr-theme", next || "auto");
    label();
    paintArt(false);
  });

  /* the ledger signature */
  function artSpec(extra) {
    var el = document.getElementById("art-data");
    if (!el || !window.LedgerArt) return null;
    var spec = JSON.parse(el.textContent);
    spec.palette = { bg: tok("art-bg"), ink: tok("art-ink"), wire: tok("art-wire"), counter: tok("art-counter"), families: {} };
    ["contracts", "electoral", "lobbying", "spending", "settlements", "alleged", "onchain"].forEach(function (f) { spec.palette.families[f] = tok("f-" + f); });
    return spec;
  }
  function paintArt(animate) {
    var c = document.getElementById("sig-canvas");
    var spec = artSpec();
    if (!c || !spec) return;
    window.LedgerArt.draw(c, spec, { animate: animate, onDone: function (s) { c.setAttribute("data-drawn", s.particles + " particles, " + s.postings + " postings"); } });
  }
  if (document.getElementById("sig-canvas")) {
    var start = function () { paintArt(true); };
    if (document.readyState === "complete") start(); else window.addEventListener("load", start);
    var rt;
    window.addEventListener("resize", function () { clearTimeout(rt); rt = setTimeout(function () { paintArt(false); }, 250); });
    try { window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () { paintArt(false); }); } catch (e) { /* old browsers */ }
  }

  /* finding filters */
  var bar = document.querySelector(".filters");
  if (bar) {
    var cards = Array.prototype.slice.call(document.querySelectorAll("[data-lane]"));
    var count = document.getElementById("shown-count");
    bar.addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (!b) return;
      Array.prototype.forEach.call(bar.querySelectorAll("button"), function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
      var f = b.getAttribute("data-filter"), n = 0;
      cards.forEach(function (c) {
        var show = f === "all" || c.getAttribute("data-lane") === f || c.getAttribute("data-tier") === f || c.getAttribute("data-pub") === f;
        c.hidden = !show;
        if (show) n++;
      });
      if (count) count.textContent = n;
    });
  }

  /* copy buttons */
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-copy]");
    if (!b) return;
    var text = b.getAttribute("data-copy");
    if (text === "@url") text = window.location.href.split("#")[0];
    var done = function () { var o = b.textContent; b.textContent = "Copied"; setTimeout(function () { b.textContent = o; }, 1400); };
    var fallback = function () {
      var t = document.createElement("textarea");
      t.value = text; document.body.appendChild(t); t.select();
      try { document.execCommand("copy"); done(); } catch (err) { b.textContent = "Select and copy"; }
      document.body.removeChild(t);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
  });

  /* relationship map: hover to focus, click to inspect */
  var net = document.querySelector(".net");
  var netData = document.getElementById("net-data");
  if (net && netData) {
    var data = JSON.parse(netData.textContent);
    var insp = document.getElementById("inspector");
    var nodes = net.querySelectorAll(".node"), edges = net.querySelectorAll(".edge");
    function focusOn(id) {
      net.classList.add("focus");
      Array.prototype.forEach.call(edges, function (e) {
        var hot = e.getAttribute("data-from") === id || e.getAttribute("data-to") === id;
        e.classList.toggle("hot", hot);
      });
      Array.prototype.forEach.call(nodes, function (n) {
        var nid = n.getAttribute("data-id");
        var hot = nid === id || Array.prototype.some.call(edges, function (e) {
          return (e.getAttribute("data-from") === id && e.getAttribute("data-to") === nid) || (e.getAttribute("data-to") === id && e.getAttribute("data-from") === nid);
        });
        n.classList.toggle("hot", hot);
      });
    }
    function clear() { net.classList.remove("focus"); }
    function inspect(id) {
      var n = data.nodes[id];
      if (!n || !insp) return;
      var rows = data.edges.filter(function (e) { return e.from === id || e.to === id; });
      var h = "<h3></h3><p class=\"muted\"></p><ul></ul>";
      insp.innerHTML = h;
      insp.querySelector("h3").textContent = n.name;
      insp.querySelector("p").textContent = n.type + " · " + rows.length + " record" + (rows.length === 1 ? "" : "s");
      var ul = insp.querySelector("ul");
      rows.forEach(function (e) {
        var li = document.createElement("li");
        var other = e.from === id ? data.nodes[e.to].name : data.nodes[e.from].name;
        li.textContent = (e.from === id ? "→ " : "← ") + other + ": " + e.label;
        ul.appendChild(li);
      });
    }
    Array.prototype.forEach.call(nodes, function (n) {
      var id = n.getAttribute("data-id");
      n.addEventListener("mouseenter", function () { focusOn(id); });
      n.addEventListener("mouseleave", clear);
      n.addEventListener("click", function () { inspect(id); focusOn(id); });
      n.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); inspect(id); focusOn(id); } });
    });
  }

  /* verify this site in the browser: re-hash every file in the manifest */
  var vbtn = document.getElementById("verify-run");
  if (vbtn) {
    vbtn.addEventListener("click", function () {
      var out = document.getElementById("verify-out"), barEl = document.querySelector(".bar > i");
      var root = vbtn.getAttribute("data-root") || "";
      out.textContent = "Fetching manifest…";
      if (!(window.crypto && crypto.subtle)) { out.textContent = "This browser has no Web Crypto; use the command-line check below."; return; }
      fetch(root + "manifest.json", { cache: "no-store" }).then(function (r) { return r.arrayBuffer(); }).then(function (mbuf) {
        var man = JSON.parse(new TextDecoder().decode(mbuf));
        var files = man.files, i = 0, okN = 0, bad = [], skipped = [], entry = false;
        function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""); }
        function next() {
          if (i >= files.length) return finish();
          var f = files[i++];
          fetch(root + f.path, { cache: "no-store" }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.arrayBuffer(); })
            .then(function (b) { return crypto.subtle.digest("SHA-256", b); })
            .then(function (d) { if (hex(d) === f.sha256) okN++; else if (f.path === man.entry) entry = true; else bad.push(f.path); })
            .catch(function () { skipped.push(f.path); })
            .then(function () { if (barEl) barEl.style.width = (100 * i / files.length).toFixed(1) + "%"; out.textContent = "Checked " + i + " of " + files.length + "…"; next(); });
        }
        function finish() {
          var lines = [okN + " of " + files.length + " files match the manifest byte for byte."];
          if (bad.length) lines.push("CHANGED: " + bad.join(", "));
          if (entry) lines.push(man.entry + " differs from the manifest. A host that wraps the entry page (such as a preview frame) causes this; on a plain mirror it means the page was changed. Check the downloaded copy with SHA256SUMS.");
          if (skipped.length) lines.push("Could not fetch here: " + skipped.join(", ") + " (the host may serve these differently; check the downloaded copy).");
          lines.push("Manifest SHA-256: …computing");
          out.textContent = lines.join("\n");
          crypto.subtle.digest("SHA-256", mbuf).then(function (d) {
            lines[lines.length - 1] = "Manifest SHA-256: " + hex(d);
            out.textContent = lines.join("\n");
            return checkSig(mbuf, root, man);
          }).then(function (s) { if (s) { lines.push(s); out.textContent = lines.join("\n"); } });
        }
        next();
      }).catch(function (e) { out.textContent = "Could not read the manifest: " + e.message; });
    });
  }

  function checkSig(mbuf, root, man) {
    if (!man.signed) return Promise.resolve("Signature: this build is not signed yet (the publisher signs on their own machine).");
    return Promise.all([fetch(root + "manifest.sig").then(function (r) { return r.text(); }), fetch(root + "publisher.json").then(function (r) { return r.json(); })])
      .then(function (a) {
        var sig = hexToBytes(a[0].trim()), pk = hexToBytes(a[1].public_key);
        return crypto.subtle.importKey("raw", pk, { name: "Ed25519" }, false, ["verify"]).then(function (key) {
          return crypto.subtle.verify({ name: "Ed25519" }, key, sig, mbuf);
        }).then(function (ok) {
          return ok ? "Signature: VALID. Ed25519, publisher key " + a[1].fingerprint + "." : "Signature: INVALID. The manifest was not signed by the published key.";
        });
      }).catch(function () { return "Signature: this browser cannot check Ed25519; run the command-line check below."; });
  }
  function hexToBytes(h) { var b = new Uint8Array(h.length / 2); for (var i = 0; i < b.length; i++) b[i] = parseInt(h.substr(i * 2, 2), 16); return b; }
})();
