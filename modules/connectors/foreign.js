#!/usr/bin/env node
'use strict';
/**
 * foreign.js — who owns the companies that lobby Congress.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A SEPARATE MODULE AND NOT A SEARCH
 * ─────────────────────────────────────────────────────────────────────────
 * 22 U.S.C. 613(h) exempts an agent from FARA registration when the agent has
 * registered under the Lobbying Disclosure Act for a foreign principal that is
 * not a foreign government or foreign political party. A foreign CORPORATION
 * lobbying on commercial matters therefore discloses in the LDA and not in
 * FARA — lawfully, by design, since 1995.
 *
 * That was measured on this desk rather than assumed. A sweep of the entire
 * active FARA register — 536 of 536 registrants, 58,287 documents, no gaps —
 * found ONE of eight foreign-linked names taken off a single firm's LDA client
 * list. Reading FARA to learn which foreign interests lobby Washington misses
 * the commercial majority.
 *
 * The disclosure is not missing. LD-1/LD-2 filings carry a `foreign_entities`
 * array: the foreign owner's name, country, address and ownership percentage,
 * written by the filer under the same penalties as the rest of the form. It is
 * mandatory, it is public, and almost nobody reads it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES NOT ESTABLISH
 * ─────────────────────────────────────────────────────────────────────────
 * A declared foreign owner is a fact about CORPORATE OWNERSHIP. It says
 * nothing about who directed the lobbying, what position was taken, or whether
 * a foreign government was involved. Ownership is not control and it is not
 * agency. Reporting "foreign-owned company lobbied Congress" as though the
 * ownership were the story would be the easiest false claim available here,
 * because the disclosure exists precisely so that it is not a secret.
 *
 * Everything below is drawn from captures already on disk. No network call.
 */

const fs = require('fs');
const path = require('path');
const R = require('./registry.js');
const { normalise } = require('./crosslink.js');

/**
 * "BYTEDANCE LTD. (OWNS 100% OF BYTEDANCE INC.; 100% OF TIKTOK LTD.)"
 *
 * Filers write the ownership CHAIN into the name field, in prose. Left glued
 * on, every parenthetical variant is a different entity and the same owner
 * splits into four. Split off, the note is the most valuable text in the
 * record — it is the filer describing the structure in their own words.
 */
// A parenthetical is only a NOTE when it describes the structure. Splitting on
// the first "(" unconditionally cut legal names in half:
//
//   "MANSFIELD (MAURITIUS) LIMITED"        -> "MANSFIELD"          + note
//   "SUFFOLK (MAURITIUS) LIMITED"          -> "SUFFOLK"            + note
//   "TENOR SPECIAL SITUATIONS I LP (CAYMAN)" -> "TENOR ... I LP"   + note
//   "AAL GROUP LTD (BVI)"                  -> "AAL GROUP LTD"      + note
//   "CPP INVESTMENT BOARD PRIVATE HOLDING (5) INC." -> lost "INC."
//
// The jurisdiction inside the parentheses is part of what distinguishes a
// Mauritius vehicle from its parent, and dropping it renamed the entity.
const NOTE_LIKE = /\bOWNS\b|\bTHROUGH\b|\bINTEREST IN\b|\bFORMERLY\b|%/i;

function splitNote(raw) {
  const s = String(raw || '').trim();

  // Some filers write the chain after a dash instead of in brackets:
  // "TOPSOE HOLDING A/S - OWNS 69.41% OF TOPSOE A/S (THUS 69.41% OF ...)".
  const dash = /\s[-\u2013\u2014]\s+(?=OWNS\b|THROUGH\b)/i.exec(s);
  if (dash) {
    return { name: s.slice(0, dash.index).trim(), note: s.slice(dash.index + dash[0].length).trim() };
  }

  const open = s.indexOf('(');
  if (open <= 0) return { name: s, note: '' };
  const tail = s.slice(open);
  if (!NOTE_LIKE.test(tail)) return { name: s, note: '' };
  return {
    name: s.slice(0, open).trim().replace(/[,;]$/, ''),
    note: tail.trim(),
  };
}

/**
 * The key two OWNER names are compared on.
 *
 * Deliberately NOT normalise(). That strips corporate suffixes, which is right
 * for a client writing its own name three ways across its filings and wrong
 * here: the suffix is frequently the ONLY thing separating a foreign parent
 * from its US subsidiary, or one vehicle from its sibling.
 *
 *   normalise: TIKTOK LTD.  ==  TIKTOK, INC.   -- two different companies
 *   normalise: TENOR ... LP ==  TENOR ... LLC  -- two different vehicles
 *
 * Punctuation and case are noise and do fold away, which is what actually
 * needed collapsing: "S.A.R.L" and "S.A.R.L." are one entity.
 */
function ownerKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[.,'`\u2019"()]/g, '')
    .replace(/[^a-z0-9&\- ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The intermediate vehicle a filer named inside the parenthetical, if any. */
function chainStep(note) {
  const m = /THROUGH ITS\s+([\d.]+)%\s+INTEREST IN\s+([^)]+)/i.exec(String(note || ''));
  return m ? { pct: m[1], via: m[2].trim().replace(/[,.]$/, '') } : null;
}

/** Every senatelda capture on disk, parsed, deduped by filing uuid. */
function readFilings(captureDir) {
  let files;
  try { files = fs.readdirSync(captureDir); }
  catch { return { filings: [], captures: 0, unparsed: 0 }; }

  const seen = new Set();
  const filings = [];
  let captures = 0;
  let unparsed = 0;

  for (const f of files.sort()) {
    if (!f.startsWith('live_capture_senatelda_') || !f.endsWith('.json')) continue;
    captures++;
    let body;
    try { body = JSON.parse(fs.readFileSync(path.join(captureDir, f), 'utf8')); }
    catch { unparsed++; continue; }
    for (const r of body.results || []) {
      // COUNT FILINGS, NOT ROWS. The same filing comes back under every search
      // that touched it and on every re-run. Counting rows measures how often
      // the operator searched: 25,526 rows on disk are 14,104 filings.
      const id = r.filing_uuid || JSON.stringify(r).slice(0, 120);
      if (seen.has(id)) continue;
      seen.add(id);
      filings.push(r);
    }
  }
  return { filings, captures, unparsed };
}

/**
 * Roll the filings up into clients, their declared foreign owners, and the
 * things about the data that the operator has to know before citing it.
 */
function collect(filings) {
  const clients = new Map();
  const byCountry = new Map();
  const flags = { domesticInForeignField: [], selfReference: [], zeroPercent: [] };
  let withForeign = 0;
  let govClients = 0;
  let foreignPPB = 0;
  let unknownPPB = 0;

  for (const r of filings) {
    const c = r.client || {};
    const clientName = String(c.name || '').trim();
    if (!clientName) continue;

    if (c.client_government_entity) govClients++;
    const dom = R.isDomesticCountry(c.ppb_country, c.ppb_country_display);
    if (dom === false) foreignPPB++;
    else if (dom === null) unknownPPB++;

    const entities = Array.isArray(r.foreign_entities) ? r.foreign_entities : [];
    if (!entities.length) continue;
    withForeign++;

    const ckey = normalise(clientName);
    if (!clients.has(ckey)) {
      clients.set(ckey, {
        display: clientName, key: ckey, owners: new Map(),
        filings: new Set(), government: !!c.client_government_entity,
      });
    }
    const entry = clients.get(ckey);
    entry.filings.add(r.filing_uuid || '');
    // Keep the shortest spelling: "EDGECONNEX" over "EDGECONNEX, INC.".
    if (clientName.length < entry.display.length) entry.display = clientName;

    for (const e of entities) {
      if (!e || typeof e !== 'object') continue;
      const { name, note } = splitNote(e.name);
      if (!name) continue;
      const okey = ownerKey(name);
      const country = e.country_display || e.country || '';
      const pct = e.ownership_percentage;

      if (!entry.owners.has(okey)) {
        entry.owners.set(okey, {
          display: name, note, country,
          pct: pct === null || pct === undefined || pct === '' ? null : String(pct),
          chain: chainStep(note),
          city: e.city || '', address: e.address || '',
        });
        const ck = country || '(no country given)';
        if (!byCountry.has(ck)) byCountry.set(ck, new Set());
        byCountry.get(ck).add(ckey);
      }

      // ── things the operator must know before citing a row ──────────────
      //
      // A DOMESTIC country inside the foreign-entity field. Real rows:
      // "MASDAR TG CORPORATION C/O MASDAR AMERICAS LLC [United States of
      // America]" — Emirati money disclosed through its US arm. The country
      // field UNDERSTATES foreignness here, so a country rollup that silently
      // drops these is wrong in the direction that matters.
      if (R.isDomesticCountry(e.country, e.country_display) === true) {
        flags.domesticInForeignField.push({ client: clientName, owner: name, country });
      }
      // The client naming ITSELF as its foreign owner. "CARL ZEISS, INC. <=
      // CARL ZEISS, INC. [Germany]" and "XINYUAN YU <= XINYUAN YU [United
      // States of America] 100%". Either a filer shortcut for the foreign
      // parent of the same name, or a junk row. Not for this tool to decide.
      // Compared on ownerKey BOTH SIDES, not against the suffix-stripped client
      // key. Against normalise() this fired on TIKTOK, INC. <= TIKTOK LTD.,
      // ACCENTURE, LLP <= ACCENTURE PLC and RWE <= RWE AG -- ordinary
      // parent/subsidiary pairs, and in TikTok's case the best-documented
      // ownership chain in the whole dataset, labelled as possible junk.
      // What is actually anomalous is the name matching EXACTLY, suffix and
      // all: CARL ZEISS, INC. <= CARL ZEISS, INC.
      if (okey && okey === ownerKey(clientName)) {
        flags.selfReference.push({ client: clientName, owner: name, country });
      }
      // 0.00% is a DECLARATION WITH NO EQUITY — a coalition member, a fund
      // with an interest that is not ownership. Counting it as ownership
      // would be false; dropping it would hide a declared foreign interest.
      if (String(pct) === '0.00' || String(pct) === '0') {
        flags.zeroPercent.push({ client: clientName, owner: name, country });
      }
    }
  }

  return {
    clients, byCountry, flags,
    totals: {
      filings: filings.length,
      withForeign,
      clientsWithForeign: clients.size,
      govClients, foreignPPB, unknownPPB,
    },
  };
}

/** Country rollup counted in CLIENTS, not rows — a filer is not a finding. */
function countryRollup(byCountry) {
  return [...byCountry.entries()]
    .map(([country, set]) => ({ country, clients: set.size }))
    .sort((a, b) => b.clients - a.clients || a.country.localeCompare(b.country));
}

/** Clients ordered by how many distinct foreign owners they declared. */
function clientRows(clients, opts = {}) {
  const country = opts.country ? String(opts.country).toLowerCase() : '';
  const only = opts.client ? normalise(opts.client) : '';
  const out = [];
  for (const c of clients.values()) {
    if (only && !c.key.includes(only)) continue;
    const owners = [...c.owners.values()]
      .filter((o) => !country || String(o.country).toLowerCase().includes(country))
      .sort((a, b) => (Number(b.pct) || 0) - (Number(a.pct) || 0)
        || a.display.localeCompare(b.display));
    if (!owners.length) continue;
    out.push({
      client: c.display, key: c.key, government: c.government,
      filings: c.filings.size, owners,
      countries: [...new Set(owners.map((o) => o.country).filter(Boolean))],
    });
  }
  return out.sort((a, b) => b.owners.length - a.owners.length
    || a.client.localeCompare(b.client));
}

module.exports = {
  splitNote, chainStep, ownerKey, readFilings, collect, countryRollup, clientRows,
};
