'use strict';
/**
 * modules/connectors/edges.js — WHO, THROUGH WHAT MECHANISM, ON WHOSE WORD.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE MOVE THIS MAKES
 *
 * Everything before this counted ROWS. A row is a search result: it says a
 * register matched a string. An EDGE says something happened between two
 * named parties, and names the document that says so.
 *
 *     row    "VANTAGE DATA CENTERS — ALPINE GROUP PARTNERS, LLC"
 *     edge   Vantage Data Centers  --represented_by-->  Alpine Group Partners
 *            asserted · $120,000 · 2026 Q2 · lda.gov/filings/…
 *
 * Once relationships are edges, the interesting commands stop being searches
 * and become QUERIES: what does this desk know about an entity, what path
 * connects two of them, how unusual is this compared with the right
 * denominator, and what CONTRADICTS the thing we think we found.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS DELIBERATELY REFUSES TO EMIT
 *
 * A proposed command list asked for ownership, principals, officers,
 * addresses, banks, property, votes, legislation, enforcement and crypto
 * edges. THIS TOOLKIT HAS NO REGISTER FOR ANY OF THEM. Emitting an empty
 * `owned_by` edge type would put a shape on the graph that the evidence
 * cannot fill, and an empty slot in a diagram reads as a missing fact rather
 * than a missing register. `UNBUILT` below names each one and the register
 * that holds it, and the graph simply does not have those edges.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * AND WHY `confidence` IS NOT A NUMBER
 *
 * A 0-to-1 confidence invites averaging, thresholding and sorting, and every
 * one of those operations turns "a sworn filing" and "two names in one
 * document" into points on the same scale. They are not on one scale. The
 * field is categorical, it matches the assertion type, and it cannot be
 * summed.
 */

const X = require('./crosslink.js');
const NM = require('./namematch.js');

// ── the assertion types, which are the whole epistemology ────────────────
const ASSERTED = 'ASSERTED';       // somebody swore to it, under penalty
const REGISTRY = 'REGISTRY';       // the thing exists as filed
const COOCCURRENCE = 'CO-OCCURRENCE'; // two names in one document. Not a fact.

const RANK = { ASSERTED: 3, REGISTRY: 2, 'CO-OCCURRENCE': 1 };

/**
 * The relationships this toolkit can actually evidence, and the register for
 * each. Nothing outside this table is emitted.
 */
const RELATIONSHIPS = {
  represented_by: {
    label: 'retained this firm to lobby',
    register: 'Senate LDA quarterly filing (LD-2), 2 U.S.C. 1604',
    assertion: ASSERTED,
    authority: 'a sworn filing by the registrant, under penalty',
  },
  received_award_from: {
    label: 'received federal money from',
    register: 'USAspending / FPDS-NG award record',
    assertion: ASSERTED,
    authority: 'an obligation of appropriated money, with an award id',
  },
  registered_in: {
    label: 'is filed as a legal entity in',
    register: 'state or national company registry, via OpenCorporates',
    assertion: REGISTRY,
    authority: 'a filing with a companies registrar',
  },
  party_to: {
    label: 'is a named party on',
    register: 'CourtListener dockets and parties endpoints (RECAP/PACER)',
    assertion: ASSERTED,
    authority: 'the caption and party table as the court keeps them',
  },
  mentioned_in: {
    label: 'appears in the text or index of',
    register: 'Federal Register, Regulations.gov, CourtListener opinion search',
    assertion: COOCCURRENCE,
    authority: 'NONE — a search index matched a string',
  },
};

/**
 * Relationships a serious investigation needs and THIS TOOLKIT CANNOT
 * EVIDENCE. Named here so the absence is a stated gap rather than an empty
 * column somebody fills in from memory.
 */
const UNBUILT = {
  owned_by: 'Beneficial ownership. SEC filings for public issuers; FinCEN '
    + 'beneficial-ownership reporting, whose scope has changed repeatedly — '
    + 'check its CURRENT status. For a private LLC there is frequently no '
    + 'public register at all.',
  officer_of: 'Directors and officers. OpenCorporates has an officers '
    + 'endpoint this toolkit does not call; state registries carry it '
    + 'directly, one jurisdiction at a time.',
  registered_agent: 'Registered agent. State registry, per jurisdiction. '
    + 'A SHARED AGENT IS ROUTINELY MEANINGLESS — CT and CSC serve hundreds '
    + 'of thousands of companies as a commercial service.',
  address_of: 'Addresses. Same registries. A shared address is weak evidence '
    + 'and often a mail-forwarding suite.',
  banks_with: 'NO PUBLIC REGISTER LINKS A US COMPANY TO ITS BANK. There is '
    + 'nothing to build against. Do not put this on a chart.',
  owns_property: 'County recorder and auditor. Ohio: Licking and Franklin. '
    + 'Free, online, ungranted — and the single largest gap in this desk.',
  voted_on: 'Roll-call votes. Congress.gov and GovInfo have real APIs. '
    + 'BUILDABLE, and not built.',
  sponsored: 'Bill sponsorship and cosponsorship. Congress.gov API. '
    + 'BUILDABLE, and not built.',
  enforced_against: 'Agency enforcement. Each agency publishes separately — '
    + 'SEC ALJ and litigation releases, FTC cases, EPA ECHO, OSHA. No single '
    + 'register.',
  foreign_principal_of: 'FARA. justice.gov/nsd-fara. THE HIGHEST-VALUE '
    + 'MISSING CONNECTOR IN THIS REPOSITORY — it is the register that answers '
    + 'the foreign-lobbying question and it is the one absent.',
  crypto_counterparty: 'A blockchain is a public ledger of ADDRESSES, not of '
    + 'people. Attributing an address to a named entity is the same '
    + 'unfalsifiable shape THESIS.md warns about: it cannot be checked from '
    + 'public data, so it never dies. Chain analysis belongs in its own '
    + 'subsystem with its own vocabulary, never merged into this graph.',
};

function edge(o) {
  const rel = RELATIONSHIPS[o.relationship] || {};
  return {
    entity_a: o.entity_a,
    relationship: o.relationship,
    entity_b: o.entity_b,
    key_a: X.normalise(o.entity_a),
    key_b: X.normalise(o.entity_b),
    // WHAT KIND OF RECORD THIS IS. Not a score — a category, so it cannot be
    // averaged with a different kind of record.
    assertion_type: rel.assertion || COOCCURRENCE,
    confidence: rel.assertion || COOCCURRENCE,
    authority: rel.authority || '',
    register: rel.register || '',
    amount: o.amount || '',
    jurisdiction: o.jurisdiction || '',
    // THREE DATES, NEVER ONE. When the thing happened, when the record was
    // filed, and when we pulled it are three different facts, and the gap
    // between the first two is sometimes the story.
    effective_date: o.effective_date || '',
    record_date: o.record_date || '',
    source_date: o.source_date || '',
    document_id: o.document_id || '',
    source: o.source || '',
    source_url: o.source_url || '',
    subject: o.subject || '',
    status: o.status || 'LEAD',
  };
}

/**
 * Derive every edge the capture library can currently support.
 *
 * One capture can carry several edges or none. A row that names nobody
 * carries none, and is not turned into an edge to somewhere just to have one.
 */
function build(captures) {
  const out = [];
  for (const c of captures || []) {
    if (c.unparsed) continue;
    const stamp = (c.file.match(/_(\d{4}-\d{2}-\d{2})T/) || [])[1] || '';
    for (const r of c.results || []) {
      const name = r.name || r.title || '';
      if (!name) continue;
      const base = {
        subject: c.subject, source: c.connector, source_date: stamp,
        source_url: r.url || '', document_id: r.external_id || '',
      };

      // ── a sworn lobbying filing: CLIENT — REGISTRANT ──────────────────
      if (c.connector === 'senatelda' && / — /.test(name)) {
        const [client, registrant] = name.split(' — ').map((s) => s.trim());
        if (client && registrant) {
          out.push(edge({ ...base,
            entity_a: client, relationship: 'represented_by', entity_b: registrant,
            amount: r.amount || '', record_date: r.date || '',
            effective_date: r.period || r.date || '' }));
        }
        continue;
      }

      // ── federal money, with the agency on the other end ───────────────
      if (c.connector === 'usaspending' && r.agency) {
        out.push(edge({ ...base,
          entity_a: name, relationship: 'received_award_from', entity_b: r.agency,
          amount: r.amount || '', effective_date: r.period || '',
          document_id: r.award_id || r.external_id || '' }));
        continue;
      }

      // ── an entity exists, in a jurisdiction, from a date ──────────────
      if (c.connector === 'opencorporates' && r.jurisdiction) {
        out.push(edge({ ...base,
          entity_a: name, relationship: 'registered_in', entity_b: r.jurisdiction,
          jurisdiction: r.jurisdiction, effective_date: r.incorporated || '' }));
        continue;
      }

      // ── a named party on a docket, as the COURT keeps it ──────────────
      if (c.connector === 'cldocket' || c.connector === 'clparties') {
        out.push(edge({ ...base,
          entity_a: name, relationship: 'party_to',
          entity_b: r.docket || r.external_id || '(docket)',
          jurisdiction: r.court || '', effective_date: r.filed || '',
          record_date: r.terminated || '' }));
        continue;
      }

      // ── everything else is a string in an index, and says so ──────────
      //
      // THE WEAKEST EDGE IN THE FILE, and it is kept rather than dropped
      // because you cannot audit what you never saw. Its authority field
      // literally reads NONE.
      out.push(edge({ ...base,
        entity_a: c.subject, relationship: 'mentioned_in', entity_b: name,
        record_date: r.date || r.published || '' }));
    }
  }
  return out;
}

/** Every edge touching one entity, both directions. */
function forEntity(edges, query) {
  const hits = [];
  for (const e of edges) {
    // A `mentioned_in` edge has the SEARCHED SUBJECT on the a-side by
    // construction, so judging entity_a asks whether the query matches the
    // query. It always does, and every namesake sails through: the live
    // Blackstone run had `Hotel Blackstone, Inc. v. Tax Commission` — a 1980
    // case, five years before The Blackstone Group existed — counted as a
    // clean NAME edge, because the a-side said "Blackstone Inc" verbatim.
    //
    // For that relationship the question is whether the DOCUMENT names the
    // entity, which is the b-side.
    const docSide = e.relationship === 'mentioned_in';
    const a = docSide ? 'OTHER' : NM.bestVerdict(query, e.entity_a);
    const b = NM.bestVerdict(query, e.entity_b);
    const side = a === 'NAME' ? 'a' : (b === 'NAME' ? 'b' : null);
    if (side) { hits.push({ ...e, side, verdict: 'NAME' }); continue; }
    if (a === 'CONTAINS' || b === 'CONTAINS') {
      hits.push({ ...e, side: a === 'CONTAINS' ? 'a' : 'b', verdict: 'CONTAINS' });
      continue;
    }
    // A document that does not name the entity in its title is still a hit —
    // the register returned it for some reason — but it is the weakest thing
    // here and it is not allowed to masquerade as a name match.
    if (docSide) hits.push({ ...e, side: 'b', verdict: 'OTHER' });
  }
  return hits;
}

/** Group an entity's edges by relationship, strongest assertion first. */
function byRelationship(hits) {
  const m = new Map();
  for (const h of hits) {
    if (!m.has(h.relationship)) {
      m.set(h.relationship, {
        relationship: h.relationship,
        label: (RELATIONSHIPS[h.relationship] || {}).label || h.relationship,
        register: h.register, assertion_type: h.assertion_type,
        edges: [],
      });
    }
    m.get(h.relationship).edges.push(h);
  }
  return [...m.values()].sort((x, y) =>
    RANK[y.assertion_type] - RANK[x.assertion_type] || y.edges.length - x.edges.length);
}

/**
 * The counterparty population for a relationship: how many OTHER entities
 * stand in the same relationship to the same other side.
 *
 * This is the denominator. "Blackstone retained Mindset Advocacy" means one
 * thing if Mindset files for two clients and another if it files for eight
 * hundred, and the payment record alone cannot tell you which.
 */
function counterpartyShare(edges, relationship, counterparty) {
  const key = X.normalise(counterparty);
  const others = edges.filter((e) => e.relationship === relationship && e.key_b === key);
  const parties = new Set(others.map((e) => e.key_a));
  return {
    counterparty, relationship,
    entities: parties.size,
    edges: others.length,
    names: [...new Set(others.map((e) => e.entity_a))].sort(),
  };
}

function toCsv(edges) {
  const cols = ['entity_a', 'relationship', 'entity_b', 'assertion_type',
    'confidence', 'amount', 'jurisdiction', 'authority', 'effective_date',
    'record_date', 'source_date', 'source', 'document_id', 'source_url',
    'subject', 'status'];
  const esc = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...edges.map((e) => cols.map((c) => esc(e[c])).join(','))]
    .join('\n') + '\n';
}

module.exports = {
  ASSERTED, REGISTRY, COOCCURRENCE, RANK,
  RELATIONSHIPS, UNBUILT,
  edge, build, forEntity, byRelationship, counterpartyShare, toCsv,
};
