'use strict';
/* Public Records Atlas — static Records Door. Reads only /data/atlas.json. */
(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const humanize = (t) => String(t || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '');
  const toast = (msg) => { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 2400); };

  const CATEGORIES = [
    { id: 'water', label: 'Water & utilities', color: '#3b9eff', types: ['water_sewer_stormwater', 'public_utilities'] },
    { id: 'gov', label: 'Government', color: '#a0a7b4', types: ['city_government', 'township_government', 'legislative_body'] },
    { id: 'fiscal', label: 'Fiscal offices', color: '#f5b83d', types: ['county_auditor', 'county_treasurer', 'finance_auditor'] },
    { id: 'records', label: 'Records & courts', color: '#e8590c', types: ['public_records_office', 'state_public_records_office', 'county_recorder', 'clerk_of_courts', 'municipal_court', 'common_pleas_court'] },
    { id: 'schools', label: 'Schools', color: '#b07cff', types: ['school_district'] },
    { id: 'community', label: 'Libraries', color: '#2fbf71', types: ['library_community_access'] },
    { id: 'safety', label: 'Safety & health', color: '#ff5d6c', types: ['police_fire_public_safety', 'public_health'] },
    { id: 'other', label: 'Other', color: '#6c7686', types: ['gis_open_data', 'other'] },
  ];
  const catOf = (t) => CATEGORIES.find((c) => c.types.includes(t)) || CATEGORIES[CATEGORIES.length - 1];

  const SCOPES = [
    ['aggregate_totals', 'Aggregate totals', 'Records showing aggregate, summary-level totals related to {TOPIC}, for example counts, dollar totals, or annual summaries, rather than individual records.'],
    ['policy_records', 'Policy records', 'Copies of current policies, rules, directives, or written procedures governing {TOPIC}.'],
    ['contracts_agreements', 'Contracts / agreements', 'Copies of contracts, service agreements, or memoranda of understanding related to {TOPIC}, including any attached rate schedules or amendments.'],
    ['meeting_minutes_agendas', 'Meeting minutes / agendas', 'Copies of meeting agendas, agenda packets, and approved minutes related to {TOPIC}.'],
    ['budgets_finance', 'Budgets / finance', 'Copies of adopted budgets, financial reports, fund or account classifications, or related fiscal records concerning {TOPIC}.'],
    ['gis_map_records', 'GIS / map records', 'Publicly releasable GIS data layers, maps, or related documentation concerning {TOPIC}.'],
    ['court_records', 'Court records', 'Copies of publicly available court records, dockets, or case-index information concerning {TOPIC}, excluding any records sealed or restricted by law.'],
    ['property_records', 'Property records', 'Publicly available property, parcel, or ownership records concerning {TOPIC}.'],
  ];
  // Operator follow-up cadence (not law — R.C. 149.43 sets no day count).
  const CADENCE = { submitted: [7, 'No acknowledgement after 7 days — follow up'], acknowledged: [30, 'Acknowledged but nothing produced after 30 days'], denied: [3, 'Denial received — ask for the legal authority in writing'], partial: [7, 'Partial production — review within 7 days'] };
  const STATUSES = ['planned', 'submitted', 'acknowledged', 'pending', 'received', 'partial', 'denied', 'appealed', 'reviewed', 'published'];
  const STORE_KEY = 'records-door.requests.v1';

  let DATA = null, map = null, markers = [];
  const state = { q: '', cats: new Set(CATEGORIES.map((c) => c.id)) };
  const loadReqs = () => { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; } catch (e) { return []; } };
  const saveReqs = (r) => { localStorage.setItem(STORE_KEY, JSON.stringify(r)); renderCount(); };

  /* ---------- routing ---------- */
  function route() {
    const tab = (location.hash.replace(/^#\//, '') || 'atlas').split('?')[0];
    const valid = ['atlas', 'directory', 'request', 'tracker', 'escalate', 'learn'].includes(tab) ? tab : 'atlas';
    document.querySelectorAll('[data-view]').forEach((v) => { v.hidden = v.dataset.view !== valid; });
    document.querySelectorAll('[data-tab]').forEach((a) => a.classList.toggle('active', a.dataset.tab === valid));
    if (valid === 'atlas' && map) setTimeout(() => map.invalidateSize(), 0);
    if (valid === 'tracker') renderTracker();
  }

  /* ---------- atlas ---------- */
  const matches = (a) => {
    if (!state.cats.has(catOf(a.agency_type).id)) return false;
    if (!state.q) return true;
    return [a.name, a.city, a.system_role, a.agency_type, a.jurisdiction_name].join(' ').toLowerCase().includes(state.q);
  };

  function agencyCard(a) {
    const c = catOf(a.agency_type);
    const link = (u, t) => (safeUrl(u) ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${t} ↗</a>` : '');
    return `<article class="card">
      <div class="card-top"><span class="dot dot-${c.id}"></span><span class="eyebrow">${esc(humanize(a.agency_type))}</span><span class="badge b-warn">${esc(a.verified_status)}</span></div>
      <h3>${esc(a.name)}</h3>
      <p class="muted">${esc(a.system_role)}</p>
      <p class="addr">${esc([a.address, a.city, a.state, a.zip].filter(Boolean).join(', '))}</p>
      <div class="links">${a.phone ? `<a href="tel:${esc(a.phone)}">${esc(a.phone)}</a>` : ''}${a.public_records_email ? `<a href="mailto:${esc(a.public_records_email)}">${esc(a.public_records_email)}</a>` : ''}${link(a.public_records_url, 'Records page')}${link(a.source_url, 'Source')}</div>
      <div class="card-actions"><a class="btn btn-sm btn-primary" href="#/request" data-draft="${esc(a.id)}">Draft request</a>${a.latitude != null ? `<button class="btn btn-sm" data-fly="${esc(a.id)}">On map</button>` : ''}</div>
    </article>`;
  }

  function renderAtlas() {
    const list = DATA.agencies.filter(matches);
    const mapped = list.filter((a) => a.latitude != null);
    $('#atlasStats').innerHTML = [[DATA.counts.agencies, 'offices'], [mapped.length, 'on map'], [DATA.counts.portals, 'portals']].map(([n, l]) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`).join('');
    $('#atlasList').innerHTML = list.map((a) => `<li><button data-fly="${esc(a.id)}" ${a.latitude == null ? 'disabled title="No coordinates yet"' : ''}><span class="dot dot-${catOf(a.agency_type).id}"></span><span><b>${esc(a.name)}</b><small>${esc(a.city)} · ${esc(humanize(a.agency_type))}</small></span></button></li>`).join('') || '<li class="empty">No matches.</li>';
    if (!map) return;
    markers.forEach((m) => m.remove());
    markers = mapped.map((a) => {
      const m = L.circleMarker([a.latitude, a.longitude], { radius: 8, color: '#0b0d10', weight: 2, fillColor: catOf(a.agency_type).color, fillOpacity: 0.95 });
      m.bindPopup(`<div class="pop"><b>${esc(a.name)}</b><br><span>${esc(a.system_role)}</span><br><a href="#/request" data-draft="${esc(a.id)}">Draft request →</a></div>`);
      m.agencyId = a.id; m.addTo(map); return m;
    });
    if (markers.length && !renderAtlas.fitted) { map.fitBounds(L.featureGroup(markers).getBounds().pad(0.2)); renderAtlas.fitted = true; }
  }

  function fly(id) {
    const a = DATA.agencies.find((x) => x.id === id);
    if (!a || a.latitude == null || !map) return;
    if (location.hash !== '#/atlas') location.hash = '#/atlas';
    setTimeout(() => { map.invalidateSize(); map.flyTo([a.latitude, a.longitude], 15); const m = markers.find((x) => x.agencyId === id); if (m) m.openPopup(); }, 60);
  }

  function initMap() {
    if (typeof L === 'undefined') { $('#mapFallback').hidden = false; return; }
    map = L.map('map', { zoomControl: true }).setView([39.96, -82.99], 9);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 19, subdomains: 'abcd', attribution: '&copy; OpenStreetMap contributors &copy; CARTO' }).addTo(map);
    $('#mapLegend').innerHTML = CATEGORIES.map((c) => `<span><i class="dot dot-${c.id}"></i>${c.label}</span>`).join('');
  }

  /* ---------- directory ---------- */
  function renderDirectory() {
    const q = $('#dirSearch').value.trim().toLowerCase(), cat = $('#dirCategory').value, city = $('#dirCity').value;
    const list = DATA.agencies.filter((a) => (!cat || catOf(a.agency_type).id === cat) && (!city || a.city === city) && (!q || [a.name, a.system_role, a.city].join(' ').toLowerCase().includes(q)));
    $('#dirMeta').textContent = `${list.length} of ${DATA.agencies.length} offices`;
    $('#dirGrid').innerHTML = list.map(agencyCard).join('') || '<p class="empty">No matches.</p>';
  }

  /* ---------- request builder ---------- */
  const PII = [[/\b\d{3}-\d{2}-\d{4}\b/, 'a Social Security number'], [/\b(?:acct|account)\s*#?\s*\d{4,}/i, 'an account number'], [/\b\d{9,}\b/, 'a long ID number'], [/\b(?:Mr|Mrs|Ms|Dr)\.?\s+[A-Z][a-z]+/, 'a person’s name']];
  function buildLetter() {
    const a = DATA.agencies.find((x) => x.id === $('#rbAgency').value);
    const scope = SCOPES.find((s) => s[0] === $('#rbScope').value) || SCOPES[0];
    const topic = $('#rbTopic').value.trim() || '[describe the subject]';
    const ranged = document.querySelector('input[name=rbRange]:checked').value === 'range';
    const s = $('#rbStart').value, e = $('#rbEnd').value;
    const date = ranged && s && e ? ` The time period for this request is ${s} through ${e}.` : ' Please include all responsive records regardless of date.';
    const elec = $('#rbElectronic').checked ? '\n\nI request these records in electronic format where they are kept electronically, delivered by email.' : '';
    const contact = $('#rbContact').value.trim() || '[Your name and preferred contact — optional]';
    const hits = PII.filter(([re]) => re.test($('#rbTopic').value)).map(([, w]) => w);
    $('#rbPii').hidden = !hits.length;
    $('#rbPii').textContent = hits.length ? `Your subject looks like it contains ${hits.join(', ')}. Ask for aggregate records instead of anything that identifies a person.` : '';
    const to = a ? a.name : '[agency]';
    const letter = `Date: ${new Date().toISOString().slice(0, 10)}\nTo: ${to}${a && a.public_records_email ? ' <' + a.public_records_email + '>' : ''}\nRe: Public records request — O.R.C. § 149.43\n\nPursuant to Ohio's Public Records Act (O.R.C. § 149.43), I am requesting to inspect or obtain copies of the following public records from ${to}:\n\n${scope[2].replace('{TOPIC}', topic)}${date}${elec}\n\nI am not requesting private customer names, account numbers, Social Security numbers, bank information, private addresses, private utility bills, or other personally identifying information. If responsive records contain exempt personal information, please redact only the exempt portions and provide the remainder. If any portion is denied, please cite the specific legal authority for the denial as required by O.R.C. § 149.43(B)(3).\n\nI am not required to state a purpose for this request. I am providing contact information below solely to facilitate delivery of the response. If any fees apply, please notify me before processing. Thank you for your time and assistance.\n\n${contact}`;
    $('#rbPreview').textContent = letter;
    $('#rbTo').textContent = a ? `${a.city} · ${humanize(a.records_portal_type)}` : '';
    $('#rbAgencyHint').textContent = a ? a.system_role : '';
    const mail = $('#rbMail'), portal = $('#rbPortal');
    mail.hidden = !(a && a.public_records_email);
    if (!mail.hidden) mail.href = `mailto:${encodeURIComponent(a.public_records_email)}?subject=${encodeURIComponent('Public records request — O.R.C. 149.43')}&body=${encodeURIComponent(letter)}`;
    portal.hidden = !(a && safeUrl(a.public_records_url));
    if (!portal.hidden) portal.href = a.public_records_url;
    return { a, letter, topic, scope };
  }

  function initBuilder() {
    $('#rbAgency').innerHTML = '<option value="">Choose an office…</option>' + CATEGORIES.map((c) => {
      const opts = DATA.agencies.filter((a) => catOf(a.agency_type).id === c.id).map((a) => `<option value="${esc(a.id)}">${esc(a.name)} — ${esc(a.city)}</option>`).join('');
      return opts ? `<optgroup label="${esc(c.label)}">${opts}</optgroup>` : '';
    }).join('');
    $('#rbRecordType').innerHTML = '<option value="">—</option>' + DATA.record_types.map((r, i) => `<option value="${i}">${esc(r.name)}</option>`).join('');
    $('#rbScope').innerHTML = SCOPES.map((s) => `<option value="${s[0]}">${s[1]}</option>`).join('');
    $('#rbRecordType').addEventListener('change', (e) => { const r = DATA.record_types[e.target.value]; if (r) $('#rbTopic').value = r.template_language || r.description; buildLetter(); });
    document.querySelectorAll('input[name=rbRange]').forEach((r) => r.addEventListener('change', () => { $('#rbDates').hidden = r.value !== 'range' || !r.checked; buildLetter(); }));
    $('#rbForm').addEventListener('input', buildLetter);
    $('#rbForm').addEventListener('change', buildLetter);
    $('#rbCopy').addEventListener('click', () => navigator.clipboard.writeText(buildLetter().letter).then(() => toast('Copied to clipboard'), () => toast('Copy failed — select the text manually')));
    $('#rbDownload').addEventListener('click', () => {
      const { a, letter } = buildLetter();
      const url = URL.createObjectURL(new Blob([letter], { type: 'text/plain' }));
      const link = Object.assign(document.createElement('a'), { href: url, download: `records_request_${(a ? a.name : 'draft').replace(/[^A-Za-z0-9]+/g, '_')}.txt` });
      link.click(); URL.revokeObjectURL(url);
    });
    $('#rbSave').addEventListener('click', () => {
      const { a, topic, scope } = buildLetter();
      if (!a) return toast('Choose an office first');
      const reqs = loadReqs();
      const now = new Date().toISOString();
      reqs.unshift({ id: 'rq-' + Date.now().toString(36), agency_id: a.id, agency: a.name, subject: topic, scope: scope[1], status: 'planned', created: now, status_at: now, history: [{ status: 'planned', at: now }], notes: '' });
      saveReqs(reqs); toast('Saved to My Requests');
    });
    buildLetter();
  }

  /* ---------- tracker ---------- */
  const daysSince = (iso) => Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  function renderCount() { const n = loadReqs().length; const el = $('#trackerCount'); el.hidden = !n; el.textContent = n; }
  function renderTracker() {
    const reqs = loadReqs();
    const by = {}; STATUSES.forEach((s) => { by[s] = 0; }); reqs.forEach((r) => { by[r.status] = (by[r.status] || 0) + 1; });
    $('#trPipeline').innerHTML = STATUSES.map((s) => `<div class="stage st-${s}${by[s] ? ' on' : ''}"><b>${by[s]}</b><span>${s}</span></div>`).join('');
    $('#trList').innerHTML = reqs.length ? reqs.map((r) => {
      const c = CADENCE[r.status], age = daysSince(r.status_at);
      const due = c && age >= c[0] ? `<p class="due">⏰ ${esc(c[1])} <span class="muted">(your follow-up schedule, not a legal deadline)</span></p>` : '';
      return `<article class="req"><div class="req-main"><span class="badge st-${esc(r.status)}">${esc(r.status)}</span><h3>${esc(r.agency)}</h3><p>${esc(r.subject)}</p><p class="muted">${esc(r.scope)} · created ${esc(r.created.slice(0, 10))} · ${age}d in this status</p>${due}</div>
        <div class="req-side"><select data-status="${esc(r.id)}" aria-label="Status">${STATUSES.map((s) => `<option ${s === r.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
        <textarea data-notes="${esc(r.id)}" rows="2" placeholder="Notes (stay in this browser)">${esc(r.notes)}</textarea>
        <button class="btn btn-sm btn-danger" data-del="${esc(r.id)}">Delete</button></div></article>`;
    }).join('') : '<div class="empty-state"><h3>No requests yet</h3><p>Draft one in the <a href="#/request">Request Builder</a> and save it here.</p></div>';
  }
  function initTracker() {
    const list = $('#trList');
    list.addEventListener('change', (e) => {
      const reqs = loadReqs();
      const r = reqs.find((x) => x.id === (e.target.dataset.status || e.target.dataset.notes));
      if (!r) return;
      if (e.target.dataset.status) { const now = new Date().toISOString(); r.status = e.target.value; r.status_at = now; r.history.push({ status: r.status, at: now }); }
      else r.notes = e.target.value;
      saveReqs(reqs); renderTracker();
    });
    list.addEventListener('click', (e) => { const id = e.target.dataset.del; if (id && confirm('Delete this request?')) { saveReqs(loadReqs().filter((r) => r.id !== id)); renderTracker(); } });
    $('#trExport').addEventListener('click', () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify({ contract: 'records-door/requests@1', exported_utc: new Date().toISOString(), requests: loadReqs() }, null, 2)], { type: 'application/json' }));
      Object.assign(document.createElement('a'), { href: url, download: `my_requests_${new Date().toISOString().slice(0, 10)}.json` }).click(); URL.revokeObjectURL(url);
    });
    $('#trImport').addEventListener('change', (e) => {
      const f = e.target.files[0]; if (!f) return;
      f.text().then((t) => {
        const d = JSON.parse(t); const incoming = (d.requests || []).filter((r) => r && r.id && STATUSES.includes(r.status));
        const keep = ['id', 'agency_id', 'agency', 'subject', 'scope', 'status', 'created', 'status_at', 'history', 'notes'];
        const clean = incoming.map((r) => Object.fromEntries(keep.map((k) => [k, r[k] == null ? (k === 'history' ? [] : '') : r[k]])));
        const ids = new Set(loadReqs().map((r) => r.id));
        saveReqs(loadReqs().concat(clean.filter((r) => !ids.has(r.id)))); renderTracker(); toast(`Imported ${clean.length} request(s)`);
      }).catch(() => toast('That file is not a valid export')).finally(() => { e.target.value = ''; });
    });
    $('#trClear').addEventListener('click', () => { if (confirm('Delete every saved request in this browser?')) { saveReqs([]); renderTracker(); } });
    renderCount();
  }

  /* ---------- portals ---------- */
  function renderPortals() {
    const kind = $('#esKind').value;
    const coc = DATA.portals.find((p) => p.portal_kind === 'court_appeal');
    $('#esCallout').innerHTML = coc ? `<strong>Denied or ignored?</strong> ${esc(coc.covers)} <span class="muted">${esc(coc.typical_fees)} · ${esc(coc.statute_ref)}</span> ${safeUrl(coc.url) ? `<a href="${esc(coc.url)}" target="_blank" rel="noopener noreferrer">File a complaint ↗</a>` : ''}` : '';
    $('#esGrid').innerHTML = DATA.portals.filter((p) => !kind || p.portal_kind === kind).map((p) => `<article class="card">
      <div class="card-top"><span class="eyebrow">${esc(humanize(p.portal_kind))}</span>${p.verified_status === 'verified' ? '<span class="badge b-ok">verified</span>' : '<span class="badge b-warn">unverified</span>'}</div>
      <h3>${esc(p.name)}</h3><p class="muted">${esc(p.covers)}</p>
      ${p.submission_notes ? `<p class="small">${esc(p.submission_notes)}</p>` : ''}
      <div class="tags">${p.login_required ? '<span class="tag">login required</span>' : '<span class="tag">no login</span>'}${p.typical_fees ? `<span class="tag">${esc(p.typical_fees)}</span>` : ''}${p.statute_ref ? `<span class="tag">${esc(p.statute_ref)}</span>` : ''}</div>
      ${safeUrl(p.url) ? `<div class="card-actions"><a class="btn btn-sm" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">Open ↗</a></div>` : ''}
    </article>`).join('');
  }

  /* ---------- boot ---------- */
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-fly],[data-draft]'); if (!t) return;
    if (t.dataset.fly) { e.preventDefault(); fly(t.dataset.fly); }
    if (t.dataset.draft) { setTimeout(() => { $('#rbAgency').value = t.dataset.draft; buildLetter(); }, 0); }
  });
  document.addEventListener('keydown', (e) => { if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); location.hash = '#/atlas'; $('#atlasSearch').focus(); } });
  window.addEventListener('hashchange', route);

  fetch('/data/atlas.json').then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }).then((d) => {
    DATA = d;
    initMap();
    $('#atlasChips').innerHTML = CATEGORIES.map((c) => `<button class="chip on" data-cat="${c.id}" aria-pressed="true"><i class="dot dot-${c.id}"></i>${c.label}</button>`).join('');
    $('#atlasChips').addEventListener('click', (e) => { const b = e.target.closest('[data-cat]'); if (!b) return; const on = !state.cats.has(b.dataset.cat); on ? state.cats.add(b.dataset.cat) : state.cats.delete(b.dataset.cat); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); renderAtlas(); });
    $('#atlasSearch').addEventListener('input', (e) => { state.q = e.target.value.trim().toLowerCase(); renderAtlas(); });
    $('#dirCategory').innerHTML = '<option value="">All categories</option>' + CATEGORIES.map((c) => `<option value="${c.id}">${c.label}</option>`).join('');
    $('#dirCity').innerHTML = '<option value="">All cities</option>' + [...new Set(d.agencies.map((a) => a.city).filter(Boolean))].sort().map((c) => `<option>${esc(c)}</option>`).join('');
    ['#dirSearch', '#dirCategory', '#dirCity'].forEach((s) => $(s).addEventListener('input', renderDirectory));
    $('#esKind').innerHTML = '<option value="">All kinds</option>' + [...new Set(d.portals.map((p) => p.portal_kind))].map((k) => `<option value="${esc(k)}">${esc(humanize(k))}</option>`).join('');
    $('#esKind').addEventListener('input', renderPortals);
    $('#footerMeta').textContent = `Data compiled ${d.generated_utc.slice(0, 10)} · ${d.counts.agencies} offices · ${d.counts.portals} portals · ${d.counts.record_types} record types`;
    renderAtlas(); renderDirectory(); renderPortals(); initBuilder(); initTracker(); route();
  }).catch(() => { document.querySelector('main').innerHTML = '<div class="empty-state"><h3>Atlas data failed to load</h3><p>Try reloading the page.</p></div>'; });
})();
