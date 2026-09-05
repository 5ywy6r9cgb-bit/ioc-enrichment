#!/usr/bin/env node
'use strict';
/**
 * entity.js — read the record behind a candidate.
 *
 * `connect screen` produces CANDIDATES: a FARA principal, a matched
 * OpenSanctions entity, a score, and a URL. That is where the first live
 * run stopped, and stopping there is the problem. A candidate you cannot
 * open is not a lead, it is a rumour with a link on it.
 *
 * The single most important field is not the topic. It is WHICH DATASET
 * the entity came from. "sanction" spans the OFAC SDN list, an EU
 * consolidated listing, a national debarment register and a
 * research-grade watchlist, and those carry wildly different legal
 * weight. A row that says `sanction` without naming its source has told
 * you almost nothing.
 *
 * So this prints, in order: the datasets, then the topics, then the
 * source URLs the publisher itself gives, then the properties that say
 * what the listing is ABOUT. Nothing is summarised into a verdict.
 */

const R = require('./registry.js');

const API = 'https://api.opensanctions.org/entities/';

/**
 * Topic weight, stated rather than computed.
 *
 * DESIGNATED means a government named this entity in an instrument with
 * legal effect. RISK means somebody flagged it. They are not the same
 * fact and the difference decides whether a sentence is publishable.
 */
const TOPIC_WEIGHT = {
  sanction: 'DESIGNATED — a government named this entity in a sanctions instrument',
  'sanction.linked': 'LINKED — associated with a designated entity, not itself designated',
  'sanction.counter': 'COUNTER-SANCTION — listed by a state sanctioning others',
  'sanction.control': 'CONTROL — flagged as controlled by a designated entity',
  debarment: 'DEBARRED — excluded from public contracting',
  'export.control': 'EXPORT CONTROL — restricted from receiving controlled goods',
  'export.risk': 'EXPORT RISK — flagged as a diversion risk, NOT a designation',
  'crime.terror': 'TERRORISM — alleged or designated',
  wanted: 'WANTED — subject of a warrant or notice',
  'role.pep': 'POLITICALLY EXPOSED — holds or held public office',
  poi: 'PERSON OF INTEREST — a catch-all; on its own it designates nothing',
  'gov.soe': 'STATE-OWNED ENTERPRISE — ownership, not wrongdoing',
};

function entityUrl(id) {
  return `${API}${encodeURIComponent(String(id))}`;
}

/** Values of one property, as plain strings. */
function prop(entity, name) {
  const p = (entity && entity.properties) || {};
  const v = p[name];
  if (!Array.isArray(v)) return [];
  return v.map((x) => (x && typeof x === 'object' ? (x.caption || x.id || '') : String(x)))
    .filter(Boolean);
}

/**
 * The fields that say WHY, separated from the fields that say WHO.
 *
 * `sourceUrl` is the publisher's own link to the instrument. It is the
 * only field here that leads to a primary source, so it is surfaced
 * first and never merged into the rest.
 */
function reading(entity) {
  const e = entity || {};
  const topics = prop(e, 'topics');
  return {
    id: e.id || '',
    caption: e.caption || '',
    schema: e.schema || '',
    // WHICH LIST. The most load-bearing fact in the record.
    datasets: Array.isArray(e.datasets) ? e.datasets : [],
    topics,
    weights: topics.map((t) => ({ topic: t, means: TOPIC_WEIGHT[t] || '(weight not stated here)' })),
    sourceUrl: prop(e, 'sourceUrl'),
    program: prop(e, 'program'),
    notes: prop(e, 'notes'),
    country: prop(e, 'country'),
    aliases: prop(e, 'alias'),
    // WHEN. A listing that postdates every FARA filing is a different
    // story from one that predates them, and neither can be told without
    // both dates.
    firstSeen: e.first_seen || '',
    lastSeen: e.last_seen || '',
    // Whether OpenSanctions considers this a "target" of a listing at all,
    // rather than a person merely mentioned inside someone else's record.
    target: e.target === true,
  };
}

async function fetchEntity(id, opts = {}) {
  const req = opts.request || R.request;
  const url = entityUrl(id);
  const res = await req('GET', url,
    opts.key ? { Authorization: `ApiKey ${opts.key}` } : {});
  if (!res || res.status !== 200) {
    return {
      ok: false,
      // A failed fetch is never "the record says nothing".
      error: res && res.status ? `HTTP ${res.status}` : 'no answer',
      url,
    };
  }
  let body;
  try { body = JSON.parse(R.decodeBody(res.body)); }
  catch (e) { return { ok: false, error: `unparseable: ${e.message}`, url }; }
  return { ok: true, url, entity: body, reading: reading(body) };
}

module.exports = { API, TOPIC_WEIGHT, entityUrl, prop, reading, fetchEntity };
