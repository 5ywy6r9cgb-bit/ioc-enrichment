'use strict';
/**
 * pra_persistence_client.js — front-end adapter for the v0.6.1 local service.
 *
 * Design goal: ZERO regression to v0.5. If the local service is unreachable or
 * reports the database unavailable, the app uses its existing v0.5 session +
 * JSON behavior (the fallback). Persistence is strictly additive and optional.
 *
 * This client is metadata-only: it never reads or sends raw file contents.
 */
(function (global) {
  var SERVICE_BASE = (global.PRA_SERVICE_BASE) || 'http://127.0.0.1:4317';

  var state = { mode: 'session-json', dbAvailable: false, checked: false };

  function timeout(ms, p) {
    return Promise.race([
      p,
      new Promise(function (_res, rej) { setTimeout(function () { rej(new Error('timeout')); }, ms); })
    ]);
  }

  /** Health-check the local service. Resolves to a mode string. */
  function detect() {
    if (typeof fetch !== 'function') {
      state.mode = 'session-json'; state.checked = true; return Promise.resolve(state.mode);
    }
    return timeout(800, fetch(SERVICE_BASE + '/health', { method: 'GET' }))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j && j.ok && j.db_available) { state.mode = 'local-postgres'; state.dbAvailable = true; }
        else { state.mode = 'session-json'; state.dbAvailable = false; }
        state.checked = true;
        return state.mode;
      })
      .catch(function () {
        // Service down or unreachable -> fall back. No error surfaced to user.
        state.mode = 'session-json'; state.dbAvailable = false; state.checked = true;
        return state.mode;
      });
  }

  /** True only when the local service + DB are confirmed available. */
  function isAvailable() { return state.checked && state.mode === 'local-postgres'; }

  /** Persist received-record metadata IF available; otherwise no-op (caller keeps v0.5 path). */
  function persistReceivedRecord(meta) {
    if (!isAvailable()) return Promise.resolve({ persisted: false, fallback: true });
    return fetch(SERVICE_BASE + '/received_records', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(meta)
    }).then(function (r) {
      if (r.status === 503) return { persisted: false, fallback: true };
      return r.json().then(function (j) { return { persisted: r.ok, id: j && j.id }; });
    }).catch(function () { return { persisted: false, fallback: true }; });
  }

  /** Mirror an export through the service ledger IF available; else no-op. */
  function mirrorExport() {
    if (!isAvailable()) return Promise.resolve({ mirrored: false, fallback: true });
    return fetch(SERVICE_BASE + '/export', { method: 'GET' })
      .then(function (r) { return r.ok ? { mirrored: true } : { mirrored: false, fallback: true }; })
      .catch(function () { return { mirrored: false, fallback: true }; });
  }

  global.PRA_PERSISTENCE = {
    detect: detect,
    isAvailable: isAvailable,
    getMode: function () { return state.mode; },
    persistReceivedRecord: persistReceivedRecord,
    mirrorExport: mirrorExport
  };

  // Auto-detect on load; the app continues with v0.5 behavior regardless.
  if (typeof window !== 'undefined') {
    try { detect(); } catch (e) { /* fallback stays active */ }
  }
})(typeof window !== 'undefined' ? window : globalThis);
