'use strict';
/**
 * app.js — Sentinel mobile shell logic.
 *
 * A thin client for server/local_service.js's REAL routes only:
 *   GET  /health                  — reachability + db status
 *   GET  /dashboard               — repo.dashboardCounts() + needsAttention()
 *   GET  /clock                   — deadline_engine.triage()
 *   GET  /push/vapid-public-key   — { configured, key? }
 *   POST /push/subscribe          — register this device
 *   POST /push/unsubscribe        — remove this device
 * Nothing here is invented — every field rendered below is a real field
 * server/metadata_repository.js already returns.
 */

const API_BASE = (window.SENTINEL_CONFIG && window.SENTINEL_CONFIG.SENTINEL_API_BASE) || '';
const $ = (sel) => document.querySelector(sel);

function setStatus(text, ok) {
  const el = $('#status');
  el.textContent = text;
  el.className = ok ? 'ok' : 'down';
}

async function api(path, opts) {
  const res = await fetch(`${API_BASE}${path}`, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

async function checkHealth() {
  try {
    const j = await api('/health');
    setStatus(`Connected — ${j.database || 'db'} @ ${j.host} (${j.db_available ? 'db up' : 'db DOWN'})`, j.db_available);
    return j.db_available;
  } catch (e) {
    setStatus(`Not reachable at ${API_BASE || '(edit config.js)'} — ${e.message}`, false);
    return false;
  }
}

async function loadDashboard() {
  const list = $('#summary-list');
  list.innerHTML = '<li class="muted">Loading…</li>';
  try {
    const j = await api('/dashboard');
    const c = j.counts || {};
    const rows = [
      ['Open requests', c.open_requests],
      ['Needs attention', c.needs_attention],
      ['Received records', c.received_records],
      ['Unverified sources', c.unverified_sources],
      ['Unverified portals', c.unverified_portals],
      ['Agencies', c.agencies],
    ];
    list.innerHTML = '';
    for (const [label, value] of rows) {
      const li = document.createElement('li');
      li.innerHTML = `<span>${label}</span><strong>${value ?? '—'}</strong>`;
      list.appendChild(li);
    }
    const attn = $('#attention-list');
    attn.innerHTML = '';
    if (!j.needs_attention || !j.needs_attention.length) {
      attn.innerHTML = '<li class="muted">Nothing needs attention right now.</li>';
    } else {
      for (const row of j.needs_attention.slice(0, 10)) {
        const li = document.createElement('li');
        li.innerHTML = `<span>${row.subject || row.request_id || 'request'}</span><strong>${row.status || ''}</strong>`;
        attn.appendChild(li);
      }
    }
  } catch (e) {
    list.innerHTML = `<li class="muted">/dashboard failed: ${e.message}</li>`;
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

function setPushStatus(text, ok) {
  const el = $('#push-status');
  el.textContent = text;
  el.className = ok ? 'ok' : 'down';
}

async function refreshPushState() {
  try {
    const j = await api('/push/vapid-public-key');
    if (!j.configured) {
      setPushStatus('Server has no VAPID keys set (PRA_VAPID_PUBLIC_KEY / PRA_VAPID_PRIVATE_KEY). See mobile/README.md.', false);
      $('#enable-push').disabled = true;
      return null;
    }
    return j.key;
  } catch (e) {
    setPushStatus(`Could not reach server: ${e.message}`, false);
    $('#enable-push').disabled = true;
    return null;
  }
}

async function enableNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    setPushStatus('Push is not supported in this browser.', false);
    return;
  }
  const key = await refreshPushState();
  if (!key) return;

  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { setPushStatus('Notification permission denied.', false); return; }

    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });

    await api('/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON(), label: navigator.userAgent.slice(0, 60) }),
    });
    setPushStatus('Notifications enabled on this device.', true);
    $('#enable-push').disabled = true;
  } catch (e) {
    setPushStatus(`Could not enable notifications: ${e.message}`, false);
  }
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try { await navigator.serviceWorker.register('./sw.js'); }
  catch (e) { console.warn('service worker registration failed', e); }
}

document.addEventListener('DOMContentLoaded', () => {
  registerServiceWorker();
  checkHealth().then((ok) => { if (ok) loadDashboard(); });
  refreshPushState();
  $('#refresh').addEventListener('click', () => {
    checkHealth().then((ok) => { if (ok) loadDashboard(); });
  });
  $('#enable-push').addEventListener('click', enableNotifications);
});
