/* Conserved Currents: the ledger signature.
 *
 * A deterministic generative drawing of the public ledger. The vector field is built from the
 * SHA-256 digest of data/public-ledger.json, so the picture is a visible checksum: the same file
 * always draws the same image, and one changed fact redraws every current.
 *
 *   LedgerArt.draw(canvas, spec, {animate: true|false, onDone})
 *
 * spec = { digest: "64 hex", nodes: [{id, weight}], flows: [{from, to|null, family, w, verified}],
 *          wires: [{from, to, rung, alleged}], palette: {bg, ink, wire, counter, families: {name: css}} }
 * No dependencies. No unseeded randomness. Reduced motion draws the identical final frame at once.
 */
(function (root) {
  "use strict";

  function sfc32(a, b, c, d) {
    return function () {
      a |= 0; b |= 0; c |= 0; d |= 0;
      var t = (((a + b) | 0) + d) | 0;
      d = (d + 1) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    };
  }

  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  function hexBytes(hex) {
    var out = [];
    for (var i = 0; i < 64; i += 2) out.push(parseInt(hex.substr(i, 2), 16) || 0);
    return out;
  }

  function rngFrom(hex, salt) {
    var s = fnv1a(salt || "");
    var w = [0, 8, 16, 24].map(function (k) { return (parseInt(hex.substr(k, 8), 16) ^ s) >>> 0; });
    var r = sfc32(w[0], w[1], w[2], w[3]);
    for (var i = 0; i < 24; i++) r(); // warm up
    return r;
  }

  /* Seven interfering harmonics whose amplitudes, frequencies, orientations and phases are the
     digest's own bytes. Broad weights keep the rivers legible instead of noisy. */
  function makeField(bytes) {
    var H = [];
    for (var k = 0; k < 7; k++) {
      var b = bytes.slice(k * 4, k * 4 + 4);
      H.push({ a: 0.28 + (b[0] / 255) * 0.62, f: 0.9 + (b[1] / 255) * 2.3 + k * 0.21,
               cx: Math.cos((b[2] / 255) * Math.PI * 2), sy: Math.sin((b[2] / 255) * Math.PI * 2),
               psi: (b[3] / 255) * Math.PI * 2 });
    }
    var rot = (bytes[28] / 255) * Math.PI * 2;
    var swirl = ((bytes[29] / 255) - 0.5) * 1.4;
    return function (x, y) {
      var s = 0;
      for (var k = 0; k < H.length; k++) {
        var h = H[k];
        s += h.a * Math.sin(h.f * Math.PI * (x * h.cx + y * h.sy) + h.psi);
      }
      return s * 0.85 + rot + swirl * Math.atan2(y - 0.5, x - 0.5);
    };
  }

  function layout(spec, W, H, rnd) {
    var nodes = spec.nodes.slice().sort(function (a, b) { return (b.weight - a.weight) || (a.id < b.id ? -1 : 1); });
    var n = nodes.length, pos = {};
    var R = 0.43 * Math.min(W, H), cx = W * 0.5, cy = H * 0.52;
    var ax = W / Math.min(W, H) * 0.92, ay = 0.95;
    var turn = rnd() * Math.PI * 2;
    for (var i = 0; i < n; i++) {
      var r = R * Math.sqrt((i + 0.6) / (n + 0.6));
      var t = i * 2.399963229728653 + turn;
      pos[nodes[i].id] = { x: cx + Math.cos(t) * r * ax + (rnd() - 0.5) * 6, y: cy + Math.sin(t) * r * ay + (rnd() - 0.5) * 6, rank: i };
    }
    return pos;
  }

  function hexToRgb(c) {
    var m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
    if (!m) return [200, 200, 200];
    var v = parseInt(m[1], 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  function rgba(c, a) {
    var r = hexToRgb(c);
    return "rgba(" + r[0] + "," + r[1] + "," + r[2] + "," + a.toFixed(3) + ")";
  }

  function draw(canvas, spec, opts) {
    opts = opts || {};
    var dpr = Math.min(2, (root.devicePixelRatio || 1));
    var cssW = canvas.clientWidth || canvas.width, cssH = canvas.clientHeight || canvas.height;
    if (opts.fixed) { cssW = opts.fixed[0]; cssH = opts.fixed[1]; dpr = opts.fixed[2] || 1; }
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var W = cssW, H = cssH, P = spec.palette;
    var bytes = hexBytes(spec.digest);
    var field = makeField(bytes);
    var rnd = rngFrom(spec.digest, "currents/" + (opts.salt || ""));
    var pos = layout(spec, W, H, rnd);
    var S = Math.min(W, H);
    var aspect = W / H;

    ctx.fillStyle = P.bg;
    ctx.fillRect(0, 0, W, H);

    // topology beneath the flow: relationships as faint arcs (dashed where alleged)
    ctx.lineCap = "round";
    (spec.wires || []).forEach(function (w) {
      var a = pos[w.from], b = pos[w.to];
      if (!a || !b) return;
      var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, dx = b.x - a.x, dy = b.y - a.y;
      var bend = 0.18 * (rnd() < 0.5 ? -1 : 1);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(mx - dy * bend, my + dx * bend, b.x, b.y);
      ctx.setLineDash(w.alleged ? [2, 4] : []);
      ctx.strokeStyle = rgba(P.wire, w.rung >= 4 ? 0.16 : (w.rung >= 2 ? 0.09 : 0.04));
      ctx.lineWidth = 0.7;
      ctx.stroke();
    });
    ctx.setLineDash([]);

    // particles: released at the payer, drawn toward the payee through the ledger's field
    var parts = [], base = opts.density || 30;
    spec.flows.forEach(function (f, fi) {
      var a = pos[f.from];
      if (!a) return;
      var b = f.to ? pos[f.to] : null;
      var count = Math.max(3, Math.round(base * (f.d || 1) * (0.55 + 1.45 * f.w)));
      for (var k = 0; k < count; k++) {
        var g1 = rnd(), g2 = rnd();
        var rr = Math.sqrt(-2 * Math.log(g1 + 1e-9)) * 0.016 * S, th = g2 * Math.PI * 2;
        parts.push({ x: a.x + Math.cos(th) * rr, y: a.y + Math.sin(th) * rr, b: b, fam: f.family, w: f.w,
                     ok: f.verified !== false, speed: (0.55 + rnd() * 0.5) * S / 520, life: 200 + Math.floor(rnd() * 140),
                     alive: true, age: 0, d0: b ? Math.hypot(b.x - a.x, b.y - a.y) + 1 : 1, id: fi });
      }
    });

    var fams = Object.keys(P.families);
    var postings = [];
    var steps = opts.steps || 300;
    var step = 0;

    function advance() {
      var paths = {}, counter = (typeof Path2D !== "undefined") ? new Path2D() : null, dots = {};
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        if (!p.alive) continue;
        p.age++;
        var nx = p.x / W * aspect, ny = p.y / H;
        var ang = field(nx, ny);
        var vx = Math.cos(ang), vy = Math.sin(ang);
        if (p.b) {
          var dx = p.b.x - p.x, dy = p.b.y - p.y, d = Math.hypot(dx, dy);
          if (d < 0.012 * S + 2) {
            p.alive = false;
            postings.push({ x: p.b.x, y: p.b.y, a: Math.atan2(-dy, -dx), fam: p.fam });
            continue;
          }
          var prog = 1 - Math.min(1, d / p.d0);
          var k = 0.22 + 0.78 * Math.pow(Math.max(prog, p.age / p.life), opts.pull || 1.6);
          vx = vx * (1 - k) + (dx / d) * k;
          vy = vy * (1 - k) + (dy / d) * k;
          var vm = Math.hypot(vx, vy) || 1;
          vx /= vm; vy /= vm;
        }
        var ox = p.x, oy = p.y;
        p.x += vx * p.speed * 2.2 * (opts.speed || 1);
        p.y += vy * p.speed * 2.2 * (opts.speed || 1);
        if (p.age > p.life || p.x < -20 || p.y < -20 || p.x > W + 20 || p.y > H + 20) { p.alive = false; continue; }
        var key = p.fam + "|" + (p.w > 0.66 ? 2 : (p.w > 0.33 ? 1 : 0)) + "|" + (p.ok ? 1 : 0);
        if (!p.b) {
          if (p.age % 3 === 0) {
            (dots[p.fam] = dots[p.fam] || []).push([p.x, p.y, 1 - p.age / p.life]);
          }
          continue;
        }
        var path = paths[key] || (paths[key] = new Path2D());
        path.moveTo(ox, oy);
        path.lineTo(p.x, p.y);
        if (counter) {
          counter.moveTo(ox - vy * 1.1, oy + vx * 1.1);
          counter.lineTo(p.x - vy * 1.1, p.y + vx * 1.1);
        }
      }
      if (counter && opts.counter !== false) {
        ctx.strokeStyle = rgba(P.counter, 0.10);
        ctx.lineWidth = 0.8;
        ctx.stroke(counter);
      }
      Object.keys(paths).forEach(function (key) {
        var parts_ = key.split("|"), fam = parts_[0], wb = +parts_[1], ok = parts_[2] === "1";
        ctx.setLineDash(ok ? [] : [1.5, 2.5]);
        ctx.strokeStyle = rgba(P.families[fam] || P.ink, ok ? 0.13 + 0.05 * wb : 0.10);
        ctx.lineWidth = 0.55 + 0.45 * wb;
        ctx.stroke(paths[key]);
      });
      ctx.setLineDash([]);
      Object.keys(dots).forEach(function (fam) {
        ctx.fillStyle = rgba(P.families[fam] || P.ink, 0.22);
        dots[fam].forEach(function (q) {
          ctx.globalAlpha = Math.max(0.08, q[2]);
          ctx.beginPath();
          ctx.arc(q[0], q[1], 0.9, 0, Math.PI * 2);
          ctx.fill();
        });
        ctx.globalAlpha = 1;
      });
      step++;
    }

    function finish() {
      // postings: fine arcs where currents arrive; ring density shows how often a party is named
      postings.forEach(function (q, i) {
        var r = 0.011 * S + ((i * 2654435761) % 7) * 0.35;
        ctx.beginPath();
        ctx.arc(q.x, q.y, r, q.a - 0.35, q.a + 0.35);
        ctx.strokeStyle = rgba(P.families[q.fam] || P.ink, 0.35);
        ctx.lineWidth = 0.7;
        ctx.stroke();
      });
      Object.keys(pos).forEach(function (id) {
        var q = pos[id];
        ctx.beginPath();
        ctx.arc(q.x, q.y, q.rank < 6 ? 2.4 : 1.6, 0, Math.PI * 2);
        ctx.fillStyle = rgba(P.ink, q.rank < 6 ? 0.9 : 0.6);
        ctx.fill();
      });
      // vignette and seeded grain for a printed surface
      var g = ctx.createRadialGradient(W / 2, H / 2, S * 0.25, W / 2, H / 2, Math.max(W, H) * 0.72);
      g.addColorStop(0, rgba(P.bg, 0));
      g.addColorStop(1, rgba(P.bg, 0.55));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      var gr = rngFrom(spec.digest, "grain");
      var tile = document.createElement("canvas");
      tile.width = tile.height = 96;
      var tc = tile.getContext("2d"), img = tc.createImageData(96, 96);
      for (var i = 0; i < img.data.length; i += 4) {
        var v = Math.floor(gr() * 255);
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = opts.grain === undefined ? 14 : Math.round(opts.grain * 255);
      }
      tc.putImageData(img, 0, 0);
      ctx.fillStyle = ctx.createPattern(tile, "repeat");
      ctx.fillRect(0, 0, W, H);
      if (opts.onDone) opts.onDone({ particles: parts.length, postings: postings.length, steps: step });
    }

    var reduce = false;
    try { reduce = root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { reduce = false; }
    if (!opts.animate || reduce) {
      while (step < steps) advance();
      finish();
      return;
    }
    (function loop() {
      for (var j = 0; j < 3 && step < steps; j++) advance();
      if (step < steps) root.requestAnimationFrame(loop); else finish();
    })();
  }

  root.LedgerArt = { draw: draw, fnv1a: fnv1a };
})(typeof window !== "undefined" ? window : this);
