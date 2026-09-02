/* =====================================================================
   Sentinel OS Public Records Atlas — Request Tracker (v0.4)
   Session-local tracker with manual JSON export/import + import validation.
   - Requests live in memory while the page is open.
   - Refresh/close clears them unless the user exported a JSON backup.
   - NOTHING is submitted, emailed, uploaded, or synced. Local only.
   - localStorage is NOT used as primary persistence.

   Statuses (11): draft, planned, submitted, acknowledged, pending,
                  received, partial, denied, revised, published, closed

   NOTE: "published" here is LOCAL TRACKER METADATA ONLY. It means the user
   marked the request/record ready or published in their own tracker. It does
   NOT publish anything publicly.
   ===================================================================== */
(function () {
  "use strict";

  var STATUSES = ["draft", "planned", "submitted", "acknowledged", "pending",
    "received", "partial", "denied", "revised", "published", "closed"];

  var STATUS_COLOR = {
    draft: "#6c757d", planned: "#6c757d", submitted: "#1f6feb",
    acknowledged: "#1f77b4", pending: "#d4a017", received: "#d4a017",
    partial: "#e8731c", denied: "#b23b3b", revised: "#7b2cbf",
    published: "#2ca02c", closed: "#495057"
  };

  var FIELDS = ["request_id", "agency_id", "agency_name", "jurisdiction",
    "record_type", "scope", "date_range", "request_text", "status",
    "created_at", "updated_at", "submitted_at", "acknowledged_at",
    "received_at", "notes", "public_records_url", "source_url",
    "privacy_level", "exported_at"];

  var FORBIDDEN_KEYS = ["ssn", "social_security", "account_number", "acct_number",
    "bank_account", "routing_number", "credit_card", "card_number", "dob",
    "date_of_birth", "home_address", "customer_name", "customer_account"];
  var SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/;
  var CARD_RE = /\b(?:\d[ -]*?){13,16}\b/;
  var ACCT_RE = /account\s*(?:number|no|#)\s*[:#]?\s*\d{4,}/i;

  function esc(s) {
    return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function nowIso() { return new Date().toISOString(); }

  var STORE = { requests: [] };
  window.PRA_TRACKER_STORE = STORE;

  function findById(id) {
    for (var i = 0; i < STORE.requests.length; i++) {
      if (STORE.requests[i].request_id === id) return STORE.requests[i];
    }
    return null;
  }

  function newRecord(rec) {
    var r = {};
    FIELDS.forEach(function (f) { r[f] = rec[f] || ""; });
    r.request_id = rec.request_id;
    r.status = (STATUSES.indexOf(rec.status) !== -1) ? rec.status : "draft";
    r.created_at = nowIso();
    r.updated_at = nowIso();
    r.privacy_level = rec.privacy_level || "public";
    r.history = [{ at: nowIso(), event: "created", status: r.status }];
    // v0.5: uploaded-record METADATA (never raw bytes). Sanitized on import.
    r.uploads = sanitizeUploads(rec.uploads);
    return r;
  }

  // Strip anything that isn't recognized upload metadata; drop any stray file bytes.
  function sanitizeUploads(arr) {
    if (!Array.isArray(arr)) return [];
    var allowed = (window.PRA_UPLOAD_FIELDS) || ["upload_id", "request_id",
      "original_filename", "safe_display_name", "file_type", "file_size",
      "uploaded_at", "review_status", "privacy_scan_status", "privacy_scan_flags",
      "user_notes", "source_agency", "related_request_id", "record_date_if_known",
      "public_release_status", "exported_metadata_only", "content_scan_status",
      "recommended_file_folder", "recommended_safe_filename"];
    return arr.map(function (u) {
      var clean = {};
      allowed.forEach(function (k) { if (u[k] !== undefined) clean[k] = u[k]; });
      // hard guarantees: never carry raw bytes/base64/extracted content
      delete clean.file_bytes; delete clean.base64; delete clean.data; delete clean.content;
      clean.exported_metadata_only = true;
      if (!clean.content_scan_status) clean.content_scan_status = "not_performed";
      if (!clean.privacy_scan_status) clean.privacy_scan_status = "metadata_only";
      return clean;
    });
  }
  window.PRA_sanitizeUploads = sanitizeUploads;

  function saveRequest(rec) {
    var existing = findById(rec.request_id);
    if (existing) {
      FIELDS.forEach(function (f) { if (rec[f] !== undefined && rec[f] !== "") existing[f] = rec[f]; });
      existing.updated_at = nowIso();
      existing.history.push({ at: nowIso(), event: "updated" });
      return existing;
    }
    var r = newRecord(rec);
    STORE.requests.push(r);
    return r;
  }
  window.PRA_saveRequest = saveRequest;

  function setStatus(id, status) {
    var r = findById(id);
    if (!r || STATUSES.indexOf(status) === -1) return;
    r.status = status;
    r.updated_at = nowIso();
    if (status === "submitted" && !r.submitted_at) r.submitted_at = nowIso();
    if (status === "acknowledged" && !r.acknowledged_at) r.acknowledged_at = nowIso();
    if ((status === "received" || status === "partial") && !r.received_at) r.received_at = nowIso();
    r.history.push({ at: nowIso(), event: "status_change", status: status });
    renderList();
  }

  function setNotes(id, notes) {
    var r = findById(id);
    if (!r) return;
    r.notes = notes;
    r.updated_at = nowIso();
  }

  function deleteRequest(id) {
    STORE.requests = STORE.requests.filter(function (r) { return r.request_id !== id; });
    renderList();
  }

  function clearSession() {
    STORE.requests = [];
    renderList();
  }

  // ---- Filing-cabinet helpers (v0.4 patch) ----
  function pad2(n) { return String(n).padStart(2, "0"); }
  function slug(s) {
    return (s || "").replace(/&/g, " and ").replace(/[^A-Za-z0-9]+/g, "").trim();
  }
  function slugUnderscore(s) {
    return (s || "").replace(/&/g, " and ").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  }
  var MONTHS = ["01_January", "02_February", "03_March", "04_April", "05_May",
    "06_June", "07_July", "08_August", "09_September", "10_October",
    "11_November", "12_December"];

  function agencyMeta(name) {
    var meta = null;
    (window.AGENCIES || []).forEach(function (a) { if (a.name === name) meta = a; });
    return meta;
  }
  function cityOf(r) {
    var meta = agencyMeta(r.agency_name);
    if (meta && meta.jurisdiction && !/county/i.test(meta.jurisdiction)) return meta.jurisdiction;
    return r.jurisdiction || "";
  }

  function deriveFiling() {
    var reqs = STORE.requests;
    var cities = {};
    reqs.forEach(function (r) { var c = cityOf(r); if (c) cities[c] = (cities[c] || 0) + 1; });
    var cityKeys = Object.keys(cities);
    var multi = cityKeys.length !== 1 || reqs.length === 0;
    return {
      state: "OH",
      county: "Franklin",      // seeded set is Franklin County; generic otherwise
      city: multi ? "AllAgencies" : cityKeys[0],
      multi: multi,
      agency: (reqs.length === 1) ? reqs[0].agency_name : ""
    };
  }

  function buildFilename(filing, d) {
    var date = d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
    var time = pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
    if (filing.multi) {
      return date + "_" + time + "_" + filing.state + "_CentralOhio_AllAgencies_REQUESTTRACKER_v0_4.json";
    }
    return date + "_" + time + "_" + filing.state + "_" + slug(filing.county) + "_" +
      slug(filing.city) + "_" + slug(filing.agency) + "_REQUESTTRACKER_v0_4.json";
  }

  function buildFolderPath(filing, d) {
    var year = "" + d.getFullYear();
    var month = MONTHS[d.getMonth()];
    var cityFolder = filing.multi ? "_AllAgencies" : slugUnderscore(filing.city);
    return "Sentinel_Public_Records_Atlas/Requests/Ohio/" +
      slugUnderscore(filing.county) + "_County/" + cityFolder + "/" + year + "/" + month + "/";
  }

  function sortedRequests() {
    return STORE.requests.slice().sort(function (a, b) {
      var ka = ["OH", "Franklin", cityOf(a), a.agency_name || "", a.created_at || "", a.request_id || ""];
      var kb = ["OH", "Franklin", cityOf(b), b.agency_name || "", b.created_at || "", b.request_id || ""];
      for (var i = 0; i < ka.length; i++) { if (ka[i] < kb[i]) return -1; if (ka[i] > kb[i]) return 1; }
      return 0;
    });
  }
  window.PRA_sortedRequests = sortedRequests;     // QA hook
  window.PRA_buildFilename = function () { return buildFilename(deriveFiling(), new Date()); };
  window.PRA_buildFolderPath = function () { return buildFolderPath(deriveFiling(), new Date()); };

  function refreshSavePanel() {
    var d = new Date();
    var filing = deriveFiling();
    var fname = buildFilename(filing, d);
    var folder = buildFolderPath(filing, d);
    var fEl = document.getElementById("trk-suggest-filename");
    var pEl = document.getElementById("trk-suggest-folder");
    if (fEl) fEl.textContent = fname;
    if (pEl) pEl.textContent = folder;
    return { fname: fname, folder: folder, filing: filing, d: d };
  }
  window.PRA_refreshSavePanel = refreshSavePanel;

  // Per-request folder path (used by the uploads module for Received_Records)
  function buildFolderPathForRequest(req) {
    var d = new Date();
    var city = cityOf(req) || "City";
    var filing = { state: "OH", county: "Franklin", city: city, multi: false, agency: req.agency_name };
    return buildFolderPath(filing, d);
  }
  window.PRA_buildFolderPathForRequest = buildFolderPathForRequest;

  function exportJson() {
    var info = refreshSavePanel();
    var sorted = sortedRequests();
    var stamp = info.d.toISOString();
    sorted.forEach(function (r) { r.exported_at = stamp; });
    STORE.requests.forEach(function (r) { r.exported_at = stamp; });
    // Defensive: ensure exported uploads are metadata-only (no raw bytes ever).
    sorted = sorted.map(function (r) {
      var c = {};
      Object.keys(r).forEach(function (k) { c[k] = r[k]; });
      c.uploads = sanitizeUploads(r.uploads);
      return c;
    });

    var payload = {
      export_manifest: {
        project: "Sentinel Public Records Atlas",
        module: "Request Tracker",
        version: "v0.4",
        exported_at: stamp,
        recommended_folder: info.folder,
        suggested_filename: info.fname,
        record_count: sorted.length,
        sort_order: ["state", "county", "jurisdiction", "agency_name", "created_at", "request_id"],
        uploads_handling: "Uploaded records are stored as METADATA ONLY (exported_metadata_only=true). Raw file bytes, base64, and extracted content are never included. Raw files remain in the user's filing-cabinet Received_Records folder.",
        privacy_notice: "This file is user-controlled and was not automatically submitted, uploaded, emailed, or synced."
      },
      kind: "sentinel_os_public_records_atlas_tracker",
      version: "0.4",
      exported_at: stamp,
      requests: sorted
    };
    var text = JSON.stringify(payload, null, 2);
    try {
      var blob = new Blob([text], { type: "application/json;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = info.fname;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
      setStatusMsg("Exported " + sorted.length + " request(s) as " + info.fname +
        ". Move it into: " + info.folder);
    } catch (e) {
      setStatusMsg("Export not supported here — copy the JSON below. Save it as: " + info.fname);
      showRawJson(
        "// SUGGESTED FILENAME: " + info.fname + "\n" +
        "// RECOMMENDED FOLDER: " + info.folder + "\n" +
        "// Move/save this file into the folder above after copying.\n\n" + text);
    }
  }

  function validateImport(raw) {
    var data;
    try { data = JSON.parse(raw); }
    catch (e) { return { ok: false, error: "Invalid JSON: " + (e && e.message ? e.message : e) }; }

    var requests = null;
    if (data && Array.isArray(data.requests)) requests = data.requests;
    else if (Array.isArray(data)) requests = data;
    if (!requests) return { ok: false, error: "No 'requests' array found in this file." };

    var privacyFlags = [];
    for (var i = 0; i < requests.length; i++) {
      var r = requests[i];
      if (!r || typeof r !== "object") return { ok: false, error: "Entry " + (i + 1) + " is not a valid object." };
      if (!r.request_id) return { ok: false, error: "Entry " + (i + 1) + " is missing a request_id." };
      if (r.status && STATUSES.indexOf(r.status) === -1)
        return { ok: false, error: "Entry " + (i + 1) + " has an unknown status: " + r.status };

      Object.keys(r).forEach(function (k) {
        var lk = k.toLowerCase();
        FORBIDDEN_KEYS.forEach(function (bad) {
          if (lk.indexOf(bad) !== -1) privacyFlags.push("Entry " + (i + 1) + ": suspicious field '" + k + "'");
        });
      });
      var blob = "";
      Object.keys(r).forEach(function (k) { if (typeof r[k] === "string") blob += " " + r[k]; });
      if (SSN_RE.test(blob)) privacyFlags.push("Entry " + (i + 1) + ": looks like an SSN pattern");
      if (ACCT_RE.test(blob)) privacyFlags.push("Entry " + (i + 1) + ": looks like an account number value");
      if (CARD_RE.test(blob.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ""))) privacyFlags.push("Entry " + (i + 1) + ": looks like a card-number pattern");
    }
    return { ok: true, requests: requests, privacyFlags: privacyFlags };
  }
  window.PRA_validateImport = validateImport;

  function importJsonFile(file) {
    var reader = new FileReader();
    reader.onload = function (e) {
      var v = validateImport(e.target.result);
      if (!v.ok) { setStatusMsg("Import rejected — " + v.error); return; }

      if (v.privacyFlags.length) {
        var msg = "This import appears to contain private-data-looking content:\n\n" +
          v.privacyFlags.slice(0, 8).join("\n") +
          (v.privacyFlags.length > 8 ? "\n…and more" : "") +
          "\n\nThis tracker is for public records only. Import anyway?";
        if (!window.confirm(msg)) { setStatusMsg("Import cancelled (privacy flags)."); return; }
      }

      var dups = v.requests.filter(function (r) { return findById(r.request_id); });
      var overwrite = false;
      if (dups.length) {
        overwrite = window.confirm(dups.length + " imported request(s) share an ID with ones already in this session.\n\n" +
          "OK = overwrite those existing requests.\nCancel = keep existing, import only new ones.");
      }

      var added = 0, overwritten = 0, skipped = 0;
      v.requests.forEach(function (r) {
        var existing = findById(r.request_id);
        if (existing) {
          if (overwrite) {
            FIELDS.forEach(function (f) { if (r[f] !== undefined) existing[f] = r[f]; });
            if (r.uploads !== undefined) existing.uploads = sanitizeUploads(r.uploads);
            existing.history = (existing.history || []).concat([{ at: nowIso(), event: "import_overwrite" }]);
            overwritten++;
          } else { skipped++; }
        } else {
          var rec = newRecord(r);
          FIELDS.forEach(function (f) { if (r[f] !== undefined && r[f] !== "") rec[f] = r[f]; });
          rec.uploads = sanitizeUploads(r.uploads);
          rec.history = (r.history && r.history.length) ? r.history : [{ at: nowIso(), event: "imported" }];
          STORE.requests.push(rec); added++;
        }
      });
      var anyUploads = v.requests.some(function (r) { return Array.isArray(r.uploads) && r.uploads.length; });
      var msg = "Imported " + added + " new, overwrote " + overwritten + ", skipped " + skipped + " duplicate(s).";
      if (anyUploads) msg += " Imported metadata does not restore raw files — make sure the raw files are still in the matching filing-cabinet folder.";
      setStatusMsg(msg);
      renderList();
    };
    reader.onerror = function () { setStatusMsg("Couldn't read the selected file."); };
    reader.readAsText(file);
  }

  function setStatusMsg(msg) { var el = document.getElementById("trk-status"); if (el) el.textContent = msg; }
  function showRawJson(text) { var el = document.getElementById("trk-raw"); if (el) { el.style.display = "block"; el.value = text; } }

  function ensureModal() {
    if (document.getElementById("trkModal")) return;
    var wrap = document.createElement("div");
    wrap.className = "trk-backdrop";
    wrap.id = "trkModal";
    wrap.innerHTML = [
      '<div class="trk-modal" role="dialog" aria-modal="true" aria-label="Request tracker">',
      '  <button class="trk-close" id="trkClose" aria-label="Close">Close</button>',
      '  <h2 class="trk-h2">Request tracker</h2>',
      '  <div class="trk-disclaimer" id="trk-disclaimer"></div>',
      '  <div class="trk-note" id="trk-pubnote"></div>',
      '  <div class="trk-hint" id="trk-hint" style="display:none"></div>',
      '  <div class="trk-toolbar">',
      '    <button class="trk-btn" id="trk-export">Export JSON</button>',
      '    <button class="trk-btn" id="trk-import-btn">Import JSON</button>',
      '    <input type="file" id="trk-import-file" accept="application/json,.json" style="display:none" />',
      '    <button class="trk-btn danger" id="trk-clear">Clear session</button>',
      '  </div>',
      '  <div class="trk-savebox" id="trk-savebox">',
      '    <div class="trk-savebox-h">Recommended save location</div>',
      '    <div class="trk-savebox-row"><span class="trk-savebox-lbl">Folder:</span> <code id="trk-suggest-folder"></code> <button class="trk-btn small" id="trk-copy-folder">Copy folder path</button></div>',
      '    <div class="trk-savebox-row"><span class="trk-savebox-lbl">Filename:</span> <code id="trk-suggest-filename"></code> <button class="trk-btn small" id="trk-copy-filename">Copy filename</button></div>',
      '    <div class="trk-savebox-note">This prototype cannot force your browser to save into a specific folder. After exporting, move the downloaded JSON file into the folder above. Browser downloads usually land in your Downloads folder (or you may be prompted to choose a location).</div>',
      '  </div>',
      '  <div class="trk-status" id="trk-status"></div>',
      '  <textarea id="trk-raw" class="trk-raw" readonly style="display:none"></textarea>',
      '  <div id="trk-list"></div>',
      '</div>'
    ].join("");
    document.body.appendChild(wrap);

    document.getElementById("trk-disclaimer").textContent =
      "This tracker is local to your browser session unless you export your JSON file. " +
      "Sentinel OS v0.4 does not submit, store, email, or sync requests automatically.";
    document.getElementById("trk-pubnote").textContent =
      "Note: \"published\" status here is local tracker metadata only. It does not publish records publicly.";

    document.getElementById("trkClose").addEventListener("click", closeModal);
    wrap.addEventListener("click", function (e) { if (e.target === wrap) closeModal(); });
    document.getElementById("trk-export").addEventListener("click", exportJson);
    document.getElementById("trk-import-btn").addEventListener("click", function () {
      document.getElementById("trk-import-file").click();
    });
    document.getElementById("trk-import-file").addEventListener("change", function (e) {
      if (e.target.files && e.target.files[0]) importJsonFile(e.target.files[0]);
      e.target.value = "";
    });
    document.getElementById("trk-clear").addEventListener("click", function () {
      if (!STORE.requests.length) { setStatusMsg("Tracker is already empty."); return; }
      if (window.confirm("Clear all " + STORE.requests.length + " tracked request(s) from this session?\n\n" +
        "Export a JSON backup first if you want to keep them. This cannot be undone.")) {
        clearSession();
        setStatusMsg("Session cleared.");
      }
    });
    // Copy folder path / filename (with manual-copy fallback)
    function copyToClipboard(text, okMsg) {
      function ok() { setStatusMsg(okMsg); }
      function fail() { setStatusMsg("Couldn't auto-copy. Manually copy: " + text); }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(ok, fail);
      } else { fail(); }
    }
    document.getElementById("trk-copy-folder").addEventListener("click", function () {
      var t = document.getElementById("trk-suggest-folder").textContent;
      copyToClipboard(t, "Copied folder path.");
    });
    document.getElementById("trk-copy-filename").addEventListener("click", function () {
      var t = document.getElementById("trk-suggest-filename").textContent;
      copyToClipboard(t, "Copied filename.");
    });
  }

  function statusBadge(s) {
    var c = STATUS_COLOR[s] || "#6c757d";
    return '<span class="trk-badge" style="background:' + c + '">' + esc(s) + '</span>';
  }
  function statusSelect(id, current) {
    var opts = STATUSES.map(function (s) {
      return '<option value="' + s + '"' + (s === current ? " selected" : "") + '>' + s + '</option>';
    }).join("");
    return '<select class="trk-select" data-id="' + esc(id) + '">' + opts + '</select>';
  }

  function renderList() {
    var list = document.getElementById("trk-list");
    if (!list) return;
    if (!STORE.requests.length) {
      list.innerHTML = '<div class="trk-empty">No tracked requests yet. Generate a request and choose ' +
        '"Save to tracker," or import a JSON backup.</div>';
      return;
    }
    var html = "";
    STORE.requests.slice().reverse().forEach(function (r) {
      html += '<div class="trk-card">';
      html += '<div class="trk-card-head"><strong>' + esc(r.agency_name || "(no agency)") + '</strong> ' + statusBadge(r.status) + '</div>';
      html += '<div class="trk-meta">ID: ' + esc(r.request_id) + '</div>';
      if (r.jurisdiction) html += '<div class="trk-meta">Jurisdiction: ' + esc(r.jurisdiction) + '</div>';
      if (r.record_type) html += '<div class="trk-meta">Record type: ' + esc(r.record_type) + '</div>';
      if (r.scope) html += '<div class="trk-meta">Scope: ' + esc(r.scope) + '</div>';
      if (r.date_range) html += '<div class="trk-meta">Date range: ' + esc(r.date_range) + '</div>';
      html += '<div class="trk-meta">Created: ' + esc((r.created_at || "").slice(0, 19).replace("T", " ")) + '</div>';
      if (r.submitted_at) html += '<div class="trk-meta">Submitted: ' + esc((r.submitted_at || "").slice(0, 19).replace("T", " ")) + '</div>';
      if (r.received_at) html += '<div class="trk-meta">Received: ' + esc((r.received_at || "").slice(0, 19).replace("T", " ")) + '</div>';
      html += '<div class="trk-row">Status: ' + statusSelect(r.request_id, r.status) + '</div>';
      html += '<div class="trk-row"><label class="trk-lbl">Notes</label>' +
        '<textarea class="trk-notes" data-id="' + esc(r.request_id) + '" placeholder="Your private notes (session-local)">' + esc(r.notes || "") + '</textarea></div>';
      if (r.public_records_url) html += '<div class="trk-meta">Records: <a href="' + esc(r.public_records_url) + '" target="_blank" rel="noopener noreferrer">portal</a></div>';
      if (r.source_url) html += '<div class="trk-meta">Source: <a href="' + esc(r.source_url) + '" target="_blank" rel="noopener noreferrer">official page</a></div>';
      html += '<details class="trk-details"><summary>View request text</summary><pre class="trk-pre">' + esc(r.request_text || "") + '</pre></details>';
      if (typeof window.PRA_renderUploads === "function") { html += window.PRA_renderUploads(r); }
      html += '<div class="trk-row"><button class="trk-btn small danger" data-del="' + esc(r.request_id) + '">Delete</button></div>';
      html += '</div>';
    });
    list.innerHTML = html;

    Array.prototype.forEach.call(list.querySelectorAll(".trk-select"), function (sel) {
      sel.addEventListener("change", function () { setStatus(this.getAttribute("data-id"), this.value); });
    });
    Array.prototype.forEach.call(list.querySelectorAll(".trk-notes"), function (ta) {
      ta.addEventListener("input", function () { setNotes(this.getAttribute("data-id"), this.value); });
    });
    Array.prototype.forEach.call(list.querySelectorAll("[data-del]"), function (btn) {
      btn.addEventListener("click", function () {
        if (window.confirm("Delete this tracked request? (Export a backup first if you want to keep it.)")) {
          deleteRequest(this.getAttribute("data-del"));
        }
      });
    });
    // v0.5: wire upload controls (metadata-only)
    if (typeof window.PRA_wireUploads === "function") {
      window.PRA_wireUploads(list, findById, renderList);
    }
  }

  function openTracker() {
    ensureModal();
    renderList();
    refreshSavePanel();
    document.getElementById("trkModal").classList.add("show");
  }
  function closeModal() { var m = document.getElementById("trkModal"); if (m) m.classList.remove("show"); }

  window.openTracker = openTracker;
  window.trackRequest = function (agencyName) { openTracker(); };
  window.PRA_setTrackerHint = function (msg) {
    ensureModal();
    var el = document.getElementById("trk-hint");
    if (el) { el.textContent = msg; el.style.display = msg ? "block" : "none"; }
  };
  window.PRA_STATUSES = STATUSES;
  window.PRA_setStatus = setStatus;
  window.PRA_setNotes = setNotes;
  window.PRA_clearSession = clearSession;
})();
