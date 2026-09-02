/* =====================================================================
   Sentinel OS Public Records Atlas — Request Builder (v0.3)
   Standalone module. Works identically from a map popup or the fallback
   list. Generates a DRAFT Ohio public-records request. It NEVER submits
   or emails anything.
   Depends on: window.AGENCIES, window.RECORD_TYPES, window.RB_TEMPLATES
   ===================================================================== */
(function () {
  "use strict";

  function esc(s) {
    return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // Local draft id, e.g. PRA-DRAFT-20260623-0001 (sequential within session)
  var __draftSeq = 0;
  function makeDraftId() {
    __draftSeq += 1;
    var d = new Date();
    var ymd = "" + d.getFullYear() +
      String(d.getMonth() + 1).padStart(2, "0") +
      String(d.getDate()).padStart(2, "0");
    return "PRA-DRAFT-" + ymd + "-" + String(__draftSeq).padStart(4, "0");
  }

  // Build the request text from current selections
  function buildText(opts) {
    var T = window.RB_TEMPLATES;
    var scope = (T.scopes || []).filter(function (s) { return s.key === opts.scopeKey; })[0];
    var agencyName = opts.agencyName || "[Agency]";
    var topic = (opts.topic && opts.topic.trim()) ? opts.topic.trim() : "[describe the records you are requesting]";

    var parts = [];
    parts.push(T.opening.replace("{AGENCY_NAME}", agencyName));
    parts.push("");
    if (scope) parts.push(scope.body.replace("{TOPIC}", topic));
    else parts.push("Copies of public records concerning " + topic + ".");

    // Date range
    if (opts.allDates) {
      parts[parts.length - 1] += T.date_range_all_clause;
    } else if (opts.dateStart || opts.dateEnd) {
      parts[parts.length - 1] += T.date_range_clause
        .replace("{DATE_START}", opts.dateStart || "[start date]")
        .replace("{DATE_END}", opts.dateEnd || "present");
    }

    parts.push("");
    parts.push(T.privacy_exclusion);
    parts.push("");
    parts.push(T.closing);
    parts.push("");
    parts.push(T.contact_placeholder);
    return parts.join("\n");
  }

  function downloadText(filename, text) {
    try {
      var blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
      return true;
    } catch (e) {
      return false;
    }
  }

  function copyText(text, statusEl) {
    function ok() { if (statusEl) statusEl.textContent = "Copied to clipboard."; }
    function fail() { if (statusEl) statusEl.textContent = "Couldn't auto-copy — select the text and copy manually."; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok, fail);
    } else {
      // Fallback for older/in-app browsers
      var ta = document.getElementById("rb-output");
      if (ta) { ta.removeAttribute("readonly"); ta.select();
        try { document.execCommand("copy"); ok(); } catch (e) { fail(); }
        ta.setAttribute("readonly", "readonly");
      } else fail();
    }
  }

  // Ensure a single modal exists in the DOM
  function ensureModal() {
    if (document.getElementById("rbModal")) return;
    var wrap = document.createElement("div");
    wrap.className = "rb-backdrop";
    wrap.id = "rbModal";
    wrap.innerHTML = [
      '<div class="rb-modal" role="dialog" aria-modal="true" aria-label="Generate a public-records request">',
      '  <button class="rb-close" id="rbClose" aria-label="Close">Close</button>',
      '  <h2 class="rb-h2">Generate a public-records request</h2>',
      '  <div class="rb-disclaimer" id="rbDisclaimer"></div>',
      '  <div id="rbDraftId" class="rb-draftid"></div>',
      '  <label class="rb-label">Agency</label>',
      '  <select id="rb-agency" class="rb-input"></select>',
      '  <label class="rb-label">Record type</label>',
      '  <select id="rb-recordtype" class="rb-input"></select>',
      '  <label class="rb-label">Request scope</label>',
      '  <select id="rb-scope" class="rb-input"></select>',
      '  <label class="rb-label">Subject / topic</label>',
      '  <input id="rb-topic" class="rb-input" type="text" placeholder="" />',
      '  <div class="rb-hint" id="rb-topic-hint"></div>',
      '  <label class="rb-label"><input type="checkbox" id="rb-alldates" /> Request all dates (no date range)</label>',
      '  <div id="rb-daterow">',
      '    <div class="rb-daterow">',
      '      <div><label class="rb-label">From</label><input id="rb-datestart" class="rb-input" type="date" /></div>',
      '      <div><label class="rb-label">To</label><input id="rb-dateend" class="rb-input" type="date" /></div>',
      '    </div>',
      '  </div>',
      '  <label class="rb-label">Generated draft request</label>',
      '  <textarea id="rb-output" class="rb-output" readonly></textarea>',
      '  <div class="rb-actions">',
      '    <button class="rb-btn" id="rb-regen">Regenerate</button>',
      '    <button class="rb-btn primary" id="rb-copy">Copy</button>',
      '    <button class="rb-btn" id="rb-dl-txt">Download .txt</button>',
      '    <button class="rb-btn" id="rb-dl-md">Download .md</button>',
      '    <button class="rb-btn" id="rb-save-tracker">Save to tracker</button>',
      '  </div>',
      '  <div class="rb-status" id="rb-status"></div>',
      '</div>'
    ].join("");
    document.body.appendChild(wrap);

    // Populate static selects once
    var T = window.RB_TEMPLATES;
    document.getElementById("rbDisclaimer").textContent = T.disclaimer;
    document.getElementById("rb-topic-hint").textContent = T.scope_topic_hint || "";
    document.getElementById("rb-topic").placeholder = T.scope_topic_hint || "";

    var agSel = document.getElementById("rb-agency");
    (window.AGENCIES || []).slice().sort(function (a, b) {
      return a.name.localeCompare(b.name);
    }).forEach(function (a) {
      var o = document.createElement("option");
      o.value = a.name; o.textContent = a.name;
      agSel.appendChild(o);
    });

    var rtSel = document.getElementById("rb-recordtype");
    (window.RECORD_TYPES || []).forEach(function (rt) {
      var o = document.createElement("option");
      o.value = rt.name; o.textContent = rt.name;
      rtSel.appendChild(o);
    });
    if (!(window.RECORD_TYPES || []).length) {
      var o = document.createElement("option");
      o.value = ""; o.textContent = "(record types unavailable)";
      rtSel.appendChild(o);
    }

    var scSel = document.getElementById("rb-scope");
    (T.scopes || []).forEach(function (s) {
      var o = document.createElement("option");
      o.value = s.key; o.textContent = s.label;
      scSel.appendChild(o);
    });

    // Wire events
    document.getElementById("rbClose").addEventListener("click", closeModal);
    wrap.addEventListener("click", function (e) { if (e.target === wrap) closeModal(); });
    document.getElementById("rb-alldates").addEventListener("change", function () {
      document.getElementById("rb-daterow").style.display = this.checked ? "none" : "block";
      regen();
    });
    ["rb-agency", "rb-recordtype", "rb-scope", "rb-topic", "rb-datestart", "rb-dateend"]
      .forEach(function (id) {
        var el = document.getElementById(id);
        el.addEventListener("change", regen);
        el.addEventListener("keyup", regen);
      });
    document.getElementById("rb-regen").addEventListener("click", regen);
    document.getElementById("rb-copy").addEventListener("click", function () {
      copyText(document.getElementById("rb-output").value, document.getElementById("rb-status"));
    });
    document.getElementById("rb-dl-txt").addEventListener("click", function () {
      var id = currentDraftId || "request";
      var okd = downloadText(id + ".txt", document.getElementById("rb-output").value);
      document.getElementById("rb-status").textContent = okd ? "Downloaded " + id + ".txt" : "Download not supported here — copy instead.";
    });
    document.getElementById("rb-dl-md").addEventListener("click", function () {
      var id = currentDraftId || "request";
      var md = "# Public Records Request (DRAFT)\n\n- Draft ID: " + id + "\n- Status: draft\n- Agency: " +
        document.getElementById("rb-agency").value + "\n\n---\n\n" +
        document.getElementById("rb-output").value + "\n";
      var okd = downloadText(id + ".md", md);
      document.getElementById("rb-status").textContent = okd ? "Downloaded " + id + ".md" : "Download not supported here — copy instead.";
    });
    var saveBtn = document.getElementById("rb-save-tracker");
    if (saveBtn) saveBtn.addEventListener("click", function () {
      if (typeof window.PRA_saveRequest !== "function") {
        document.getElementById("rb-status").textContent = "Tracker module not loaded.";
        return;
      }
      var agencyName = document.getElementById("rb-agency").value;
      // look up the agency's metadata so the tracker record is complete
      var meta = {};
      (window.AGENCIES || []).forEach(function (a) { if (a.name === agencyName) meta = a; });
      var allDates = document.getElementById("rb-alldates").checked;
      var dr = allDates ? "all dates" :
        ((document.getElementById("rb-datestart").value || "[start]") + " to " +
         (document.getElementById("rb-dateend").value || "present"));
      var rec = {
        request_id: currentDraftId,
        agency_name: agencyName,
        jurisdiction: meta.jurisdiction || "",
        record_type: document.getElementById("rb-recordtype").value,
        scope: document.getElementById("rb-scope").value,
        date_range: dr,
        request_text: document.getElementById("rb-output").value,
        public_records_url: meta.public_records_url || "",
        source_url: meta.source_url || "",
        privacy_level: meta.privacy_level || "public",
        status: "draft"
      };
      window.PRA_saveRequest(rec);
      document.getElementById("rb-status").textContent =
        "Saved to tracker as " + currentDraftId + " (status: draft). Open Track request to manage it.";
    });
  }

  var currentDraftId = null;

  function regen() {
    var T = window.RB_TEMPLATES;
    var opts = {
      agencyName: document.getElementById("rb-agency").value,
      scopeKey: document.getElementById("rb-scope").value,
      topic: document.getElementById("rb-topic").value,
      allDates: document.getElementById("rb-alldates").checked,
      dateStart: document.getElementById("rb-datestart").value,
      dateEnd: document.getElementById("rb-dateend").value
    };
    document.getElementById("rb-output").value = buildText(opts);
  }

  function closeModal() {
    var m = document.getElementById("rbModal");
    if (m) m.classList.remove("show");
  }

  // Public entry point — called by popups and fallback cards
  function openRequestBuilder(agencyName) {
    if (!window.RB_TEMPLATES) {
      alert("Request builder templates failed to load.");
      return;
    }
    ensureModal();
    currentDraftId = makeDraftId();
    document.getElementById("rbDraftId").textContent =
      "Draft ID: " + currentDraftId + "  ·  Status: draft";
    // Preselect the agency if provided
    if (agencyName) {
      var sel = document.getElementById("rb-agency");
      for (var i = 0; i < sel.options.length; i++) {
        if (sel.options[i].value === agencyName) { sel.selectedIndex = i; break; }
      }
    }
    regen();
    document.getElementById("rbModal").classList.add("show");
  }

  // Expose globally and override the v0.2 placeholder
  window.openRequestBuilder = openRequestBuilder;
  window.genRequest = openRequestBuilder;  // replaces the v0.2 alert placeholder
})();
