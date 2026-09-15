'use strict';

/**
 * awards — federal contracts, past the first page, with what they bought.
 *
 * The `usaspending` connector fetches ONE page of 25, sorted by amount. For
 * NTREPID CORPORATION that returned 25 rows and the run reported 25, which
 * is the page size and not a count. Nobody knows how many awards there are,
 * and nobody can total them, because the first page is a ceiling on what was
 * asked rather than a floor on what exists.
 *
 * This pages. It also keeps the DESCRIPTION, which is the field that says
 * what the money bought, and which the sweep display had been dropping.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY THE TOTAL IS NOT A TOTAL
 * ─────────────────────────────────────────────────────────────────────
 * `Award Amount` on a contract is the CURRENT obligated-plus-potential
 * value of that award as USAspending reports it. Summing a page of awards
 * gives the value of those awards, which is NOT:
 *
 *   - what was actually paid (obligations change, options go unexercised)
 *   - what one company received (subsidiaries file under their own names)
 *   - a career total (this queries one recipient string)
 *
 * So the sum is reported as "the value of the awards listed", and every
 * other reading is refused in the output rather than left to the reader.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE SUBSTRING PROBLEM IS WORSE HERE THAN ANYWHERE
 * ─────────────────────────────────────────────────────────────────────
 * `recipient_search_text` is fuzzy. "Ring LLC" returned LEIDOS ENGINEERING
 * ($107m), and "Ntrepid" returned INTREPID LLC ($441m) — a figure four
 * hundred times the subject's own largest award, sitting at the top of a
 * list sorted by amount. A reader who trusts the sort reads the noise first.
 *
 * Substring hits are separated, never dropped, and never summed.
 */

/**
 * ─────────────────────────────────────────────────────────────────────
 * INSTRUMENTS — AND WHY THE DEFAULT WAS HIDING THE ANSWER
 * ─────────────────────────────────────────────────────────────────────
 * This command filtered to `award_type_codes: ['A','B','C','D']` and said
 * so in its own footer: "Grants and loans are excluded: different
 * instruments, different meaning." That is true and it was still a defect,
 * because the operator was never told what the excluded register CONTAINED.
 *
 * The live run proves the cost. `awards "Intel Corporation"` returned 37
 * awards worth $2,877,287 — NASA software licence renewals — and
 * `awards "Intel Federal"` returned 9 worth $27,667,237 of DoD research.
 * No CHIPS money appeared anywhere, and the reader's only available
 * conclusion was that there is none.
 *
 * CHIPS money is financial assistance. It is award type 06 or 02, not A-D.
 * The filter was not reporting an absence, it was manufacturing one.
 *
 * So the instruments are named, queried separately, and reported
 * separately. They are NEVER summed together, because the amounts do not
 * mean the same thing:
 *
 *   contracts     the government bought something and owes for it
 *   grants        the government gave money toward a purpose
 *   direct        a payment to a recipient (CHIPS incentives sit here)
 *   loans         FACE VALUE of credit extended, not money handed over
 *
 * A $500m loan guarantee and a $500m contract are both "$500m" in this API
 * and are not the same fact. Adding them would produce a number with no
 * referent, which is the thing this desk exists to refuse.
 *
 * THE FIELD NAMES DIFFER BY GROUP, and USAspending validates `fields`
 * against the award types asked for. A contract query must ask for
 * "Contract Award Type"; an assistance query for "Award Type". Loans do not
 * have an Award Amount or a Start Date at all — they have a Loan Value and
 * an Issued Date, because a guarantee is not a purchase and the API does
 * not pretend it is. Sending one list for all of them returns 400, which is
 * why each group is its own request with its own fields and its own sort.
 */
const BASE_FIELDS = ['Award ID', 'Recipient Name', 'Description',
  'Awarding Agency', 'Awarding Sub Agency'];

const INSTRUMENTS = [
  {
    key: 'contracts',
    codes: ['A', 'B', 'C', 'D'],
    label: 'contracts',
    fields: BASE_FIELDS.concat(['Award Amount', 'Start Date', 'End Date',
      'Contract Award Type']),
    sort: 'Award Amount',
    means: 'The government bought something and owes for it. The amount is '
      + 'obligated-plus-potential value, not cash paid.',
  },
  {
    key: 'grants',
    codes: ['02', '03', '04', '05'],
    label: 'grants and cooperative agreements',
    fields: BASE_FIELDS.concat(['Award Amount', 'Start Date', 'End Date',
      'Award Type']),
    sort: 'Award Amount',
    means: 'Money given toward a stated purpose. A cooperative agreement '
      + 'means the agency is substantially involved in the work.',
  },
  {
    key: 'direct',
    codes: ['06', '10'],
    label: 'direct payments',
    fields: BASE_FIELDS.concat(['Award Amount', 'Start Date', 'End Date',
      'Award Type']),
    sort: 'Award Amount',
    means: 'A payment to a named recipient. CHIPS Act incentive awards are '
      + 'reported in this family, not among contracts.',
  },
  {
    key: 'loans',
    codes: ['07', '08'],
    label: 'loans and loan guarantees',
    // No Award Amount and no Start Date in this family. Asking for them is
    // a 400, and the reason is the finding: the register does not treat a
    // guarantee as a purchase.
    fields: BASE_FIELDS.concat(['Loan Value', 'Subsidy Cost', 'Issued Date']),
    sort: 'Loan Value',
    means: 'FACE VALUE of credit extended or guaranteed — NOT money handed '
      + 'over, and not comparable to a contract of the same size. Subsidy '
      + 'Cost is the government\'s own estimate of what it expects to lose.',
  },
  {
    // THE FAMILY THE FIRST FIX FORGOT, WHICH IS THE SAME MISTAKE AGAIN.
    //
    // §61 said the instrument was now an argument and that `--all` asked
    // the whole register. It did not. Assistance type 09 (insurance) and
    // 11 (other financial assistance) were left out, and `--all` printed
    // four families over a footer claiming completeness.
    //
    // 11 is the catch-all an agency uses when the award fits none of the
    // named forms. If a large, novel industrial-policy payment is going to
    // be filed anywhere unexpected, it is here — so a CHIPS search that
    // skips 11 is not a search that can report an absence.
    key: 'other',
    codes: ['09', '11'],
    label: 'insurance and other financial assistance',
    fields: BASE_FIELDS.concat(['Award Amount', 'Start Date', 'End Date',
      'Award Type']),
    sort: 'Award Amount',
    means: 'The catch-all: 09 is insurance, 11 is assistance that fits none '
      + 'of the named forms. Rare, and the first place to look when a '
      + 'payment you know exists is in none of the other families.',
  },
];

function instrument(key) {
  return INSTRUMENTS.find((i) => i.key === key) || null;
}

/**
 * Which instruments a run asked for.
 *
 * Default is contracts, because that is what every previous run of this
 * command meant and a silent change of denominator between runs is its own
 * kind of lie. `--all` asks the whole register.
 */
function instrumentsFor(opts = {}) {
  if (opts.all) return INSTRUMENTS.slice();
  const picked = INSTRUMENTS.filter((i) => opts[i.key]);
  return picked.length ? picked : [instrument('contracts')];
}

/**
 * RAW FPDS DUMPS IN THE DESCRIPTION FIELD.
 *
 * Some rows carry no description at all — the Description field holds the
 * pipe-delimited FPDS transaction record instead:
 *
 *   200505!000720!5700!FA8104!...
 *
 * That is not prose and it is not a purpose. It was being wrapped into the
 * "What the money bought" block as gibberish, and every numeric-looking
 * token in it was being fed to the word count. It is detected, kept
 * (the capture is the evidence), and reported as what it is.
 */
function isRawFpds(description) {
  return String(description || '').split('!').length >= 5;
}

/**
 * A CORPORATE SUFFIX IS NOT PART OF THE NAME.
 *
 * The first version of `namesMatch` required every query word to appear, and
 * a test caught what that does: asking for "Ntrepid Corporation" classified
 * the real NTREPID, LLC rows as SUBSTRING NOISE and excluded them from every
 * total — because "corporation" is not in "NTREPID, LLC".
 *
 * The operator would have run the command, seen zero clean awards, and had
 * no way to tell that from a company with no contracts. A filter that
 * silently deletes the answer is worse than no filter.
 *
 * Suffixes come off both sides. They carry no identity: the same operation
 * files as Corporation in one state and LLC in another, which is exactly
 * what the OpenCorporates run showed for Ntrepid across fifteen states.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * MOVED OUT, ON PURPOSE.
 *
 * This logic used to live here and ONLY here, which meant `connect awards`
 * could tell INTREPID LLC from Ntrepid and the other ten connectors could
 * not. It now lives in `namematch.js` and is imported by the whole register
 * layer, so the same test governs OpenCorporates, Senate LDA,
 * Regulations.gov, CourtListener and the Federal Register. Re-exported below
 * so every existing caller and test keeps working against one implementation.
 * ─────────────────────────────────────────────────────────────────────────
 */
const NM = require('./namematch.js');

const { SUFFIX, normaliseName, namesMatch, tooShortToFilter } = NM;

/**
 * ─────────────────────────────────────────────────────────────────────
 * IS THE COMPANY YOU ASKED FOR ACTUALLY IN THE ANSWER?
 * ─────────────────────────────────────────────────────────────────────
 * `awards "Intel" --all` reported, under DIRECT PAYMENTS:
 *
 *     awards            18
 *     value of those    $198,000
 *
 * and the eighteen names were BLAC INTEL LLC, PALADIN INTEL LLC,
 * BEVERAGE INTEL, INTEL MUSIC GROUP, HUMINT INTEL INVESTIGATION
 * SERVICES — eighteen small businesses collecting COVID disaster aid.
 * **Not one of them was Intel Corporation.**
 *
 * Every one passed `namesMatch` legitimately: "intel" is a whole word in
 * "blac intel". The string test is right and the headline is still a lie,
 * because the reader came looking for a company and the number on screen
 * belongs to eighteen other ones.
 *
 * So: what share of this money sits under a name that IS the query, rather
 * than a name that CONTAINS it? Below a threshold the command says so
 * before showing any total.
 */
/**
 * WHERE IN THE NAME DOES THE QUERY SIT?
 *
 * The first version of this demanded an EXACT match and immediately produced
 * a false positive: `awards "Rescue Agency"` reported "THE NAME YOU ASKED
 * FOR HOLDS 0% OF THIS MONEY" over rows filed as **RESCUE AGENCY PUBLIC
 * BENEFIT, LLC** — which is the company's actual registered name. The
 * warning was louder than the thing it warned about and it was wrong.
 *
 * The real signal is POSITION. Companies extend their name to the RIGHT:
 *
 *     INTEL FEDERAL LLC          AMAZON WEB SERVICES, INC.
 *     RESCUE AGENCY PUBLIC BENEFIT LLC
 *
 * Strangers who merely share a word put it anywhere else, usually last,
 * because they are using it as a common noun:
 *
 *     BLAC INTEL LLC    PALADIN INTEL LLC    BEVERAGE INTEL
 *     INTEL MUSIC GROUP (the head is a person's name, ELIZABETH SCALISE)
 *
 * So this reports the share of money under names that BEGIN with the query.
 * It is a cheap heuristic and it is honest about being one: a head match is
 * CONSISTENT with one operation and does not establish it — AMAZON HOSE &
 * RUBBER CO OF MIAMI begins with "Amazon" and sells hose. What the metric
 * reliably catches is the other direction, where the query is buried in the
 * middle or tail of every name and the total belongs to strangers.
 *
 * "Filed under" is what settles it. This decides whether to make the reader
 * look there.
 */
function sameHead(query, name) {
  const q = normaliseName(query);
  const n = normaliseName(name);
  if (!q || !n) return false;
  return n === q || n.startsWith(`${q} `);
}

function headShare(query, rows) {
  let head = 0;
  let headAmount = 0;
  let total = 0;
  for (const r of rows) {
    const amt = amountOf(r);
    total += amt;
    if (sameHead(query, r.name)) { head += 1; headAmount += amt; }
  }
  return {
    head,
    headAmount,
    of: rows.length,
    share: total > 0 ? headAmount / total : (rows.length ? head / rows.length : 0),
  };
}

/**
 * WHEN THE PAGE BUDGET IS SPENT ON NAMESAKES.
 *
 * `awards "Intel" --all --pages 8` returned FOUR clean contracts against
 * 796 substring hits — INTELSAT at $930m, POLARIS ALPHA, CACI INTELLIGENCE
 * SOLUTIONS, INTELLIDYNE. The list is sorted by amount, so eight pages of
 * budget bought eight pages of namesakes and the real rows never arrived.
 *
 * The run before it, asking "Intel Corporation" and "Intel Federal"
 * separately, found 46. The same register, the same day, eleven times the
 * answer — because the stem was too generic for a sorted, capped query.
 *
 * "4 awards (page cap reached — a FLOOR)" is true and nobody reads it as
 * "your query failed". This says so.
 */
function noiseVerdict({ clean, substring, truncated }) {
  const c = clean.length;
  const s = substring.length;
  if (!truncated || s + c === 0) return null;
  const ratio = s / (s + c);
  if (ratio < 0.8) return null;
  return { ratio, clean: c, substring: s };
}

function classify(query, rows) {
  const clean = [];
  const substring = [];
  for (const r of rows) {
    (namesMatch(query, r.name) ? clean : substring).push(r);
  }
  return { clean, substring };
}

/** Dollars back out of "$6,919,191". */
function amountOf(row) {
  const n = Number(String(row.amount == null ? '' : row.amount).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Group by awarding agency — the question "who is buying this" is usually
 * more useful than "how much", and it is the one the sweep could not answer.
 */
function byAgency(rows) {
  const m = new Map();
  let total = 0;
  // AWARDS THAT CARRY NO AMOUNT AT ALL.
  //
  // The live Intel Federal run returned DARPA cooperative agreement
  // HR00112120015 with a null Award Amount — and a description stating in
  // words that the value was increased to $9,413,419. It was displayed as
  // "—" and contributed $0 to the family total, so a $23.1m figure was
  // printed over a known, unlisted $9.4m.
  //
  // A blank is not a zero. Counting it as one silently deflates a total the
  // reader is invited to trust, which is worse than the page cap: at least
  // the page cap announces itself.
  let noAmount = 0;
  for (const r of rows) {
    const a = (r.agency || '(agency not stated)').trim();
    const blank = !String(r.amount == null ? '' : r.amount).replace(/[^0-9.]/g, '');
    if (blank) noAmount += 1;
    const amt = amountOf(r);
    total += amt;
    const cur = m.get(a) || { agency: a, amount: 0, count: 0, largest: 0 };
    cur.amount += amt;
    cur.count += 1;
    if (amt > cur.largest) cur.largest = amt;
    m.set(a, cur);
  }
  return {
    agencies: [...m.values()].sort((x, y) => y.amount - x.amount),
    total,
    noAmount,
  };
}

/**
 * Recipient names as filed, because a fuzzy search returns several and they
 * are not necessarily one company. NTREPID CORPORATION was asked for and
 * NTREPID, LLC came back — plausibly the same operation, and not the same
 * string, and this desk does not merge names on plausibility.
 */
function byRecipient(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = (r.name || '(unnamed)').trim();
    const cur = m.get(k) || { name: k, amount: 0, count: 0 };
    cur.amount += amountOf(r);
    cur.count += 1;
    m.set(k, cur);
  }
  return [...m.values()].sort((a, b) => b.amount - a.amount);
}

/**
 * Words that recur across award descriptions.
 *
 * NOT a topic model and not an inference — a frequency count over a field
 * the government wrote. It exists because reading forty descriptions by eye
 * is how a subject gets missed, and because the interesting word in a
 * persona-management contract would be in this list or nowhere.
 */
const STOP = new Set(('the and for of to a in on with by from at or as is are be this that '
  + 'services service support system systems inc llc corp corporation company contract '
  + 'task order idiq option year base new all any per each other equipment supplies '
  + 'shall will providing provide provided including include included requirement '
  + 'requirements program project work performance date amount total not applicable na')
  .split(/\s+/));

function descriptionWords(rows, min = 2) {
  const counts = new Map();
  for (const r of rows) {
    // A raw FPDS transaction dump is not a description. Counting its
    // fragments puts agency codes and PIID stems into a list the reader is
    // told describes subject matter.
    if (isRawFpds(r.description)) continue;
    const seen = new Set();
    for (const w of plainDescription(r.description).toLowerCase().split(/[^a-z0-9]+/)) {
      if (w.length < 4 || STOP.has(w) || /^\d+$/.test(w)) continue;
      if (seen.has(w)) continue;   // count DOCUMENTS, not repetitions
      seen.add(w);
      counts.set(w, (counts.get(w) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= min)
    .map(([word, awards]) => ({ word, awards }))
    .sort((a, b) => b.awards - a.awards || a.word.localeCompare(b.word));
}


/**
 * IGF:: MARKERS — the government's own statement about the work.
 *
 * Ntrepid's DEA descriptions carry `IGF::CL::IGF` and `IGF::OT::IGF`. Those
 * are not noise and not a product code: under OFPP Policy Letter 11-01 and
 * FAR 7.503 the contracting officer must tag a service contract with how
 * close the work sits to an inherently governmental function.
 *
 *   IGF::CT::IGF   a CRITICAL function
 *   IGF::CL::IGF   CLOSELY ASSOCIATED with an inherently governmental function
 *   IGF::OT::IGF   OTHER — neither of the above
 *
 * It is the government classifying its own purchase, in a field it wrote,
 * and this desk had been rendering it as gibberish in the middle of a
 * description. It is decoded, never interpreted: "closely associated" is a
 * procurement category, not a finding about anybody.
 */
const IGF = {
  CT: 'CRITICAL function',
  CL: 'CLOSELY ASSOCIATED with an inherently governmental function',
  OT: 'OTHER — not critical, not closely associated',
};

function igfMarkers(description) {
  const out = [];
  const re = /IGF::([A-Z]{2})::IGF/g;
  let m;
  while ((m = re.exec(String(description || '')))) {
    if (IGF[m[1]] && !out.some((x) => x.code === m[1])) {
      out.push({ code: m[1], means: IGF[m[1]] });
    }
  }
  return out;
}

/** The description with the markers taken out, so the text reads. */
function plainDescription(description) {
  return String(description || '')
    .replace(/IGF::[A-Z]{2}::IGF/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * ─────────────────────────────────────────────────────────────────────
 * A PROGRAM IS NOT A SET OF DECISIONS
 * ─────────────────────────────────────────────────────────────────────
 * `awards "Google LLC" --all` returned 387 direct payments from the FCC.
 * Every one of them carried the SAME 120-word Affordable Connectivity
 * Program boilerplate, so:
 *
 *   - the word list read "obligation 387 · afford 386 · affordable 386 …",
 *     which describes the paragraph and nothing about any award
 *   - the same paragraph was printed twelve times, filling the screen
 *   - "387 awards" invited the reader to see 387 decisions
 *
 * There was ONE decision — a subsidy programme — and 387 monthly
 * obligations under it. Reporting that as 387 findings is inflation by
 * formatting, which is the same failure as a page cap read as a count.
 *
 * Descriptions are grouped by their normalised text. Numbers come out
 * (invoice and obligation ids differ on otherwise identical rows) so the
 * boilerplate collapses to one group and a genuinely distinct description
 * stays its own.
 */
function descriptionKey(description) {
  return plainDescription(description)
    .toLowerCase()
    .replace(/[0-9]+/g, ' ')
    .replace(/[^a-z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function descriptionGroups(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = descriptionKey(r.description);
    if (!k) continue;
    const cur = m.get(k) || { text: plainDescription(r.description), count: 0, amount: 0, rows: [] };
    cur.count += 1;
    cur.amount += amountOf(r);
    cur.rows.push(r);
    m.set(k, cur);
  }
  return [...m.values()].sort((a, b) => b.count - a.count || b.amount - a.amount);
}

/**
 * The one description that covers most of the register, if there is one.
 *
 * Deliberately strict: a single group has to carry at least five awards AND
 * at least 40% of them before this desk will call a set of awards a
 * programme. Below that it is a repeated phrase, not a policy.
 */
function dominantDescription(rows) {
  const withText = rows.filter((r) => descriptionKey(r.description));
  if (withText.length < 5) return null;
  const g = descriptionGroups(rows)[0];
  if (!g || g.count < 5) return null;
  const share = g.count / withText.length;
  return share >= 0.4 ? { text: g.text, count: g.count, of: withText.length, share } : null;
}

/** Earliest and latest dates seen, from the "start → end" period string. */
function span(rows) {
  let first = ''; let last = '';
  for (const r of rows) {
    for (const d of String(r.period || '').split('→')) {
      const t = d.trim().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) continue;
      if (!first || t < first) first = t;
      if (!last || t > last) last = t;
    }
  }
  return { first, last };
}

module.exports = {
  namesMatch, normaliseName, tooShortToFilter, classify, amountOf, byAgency, byRecipient,
  descriptionWords, span, STOP, SUFFIX, igfMarkers, plainDescription, IGF,
  INSTRUMENTS, instrument, instrumentsFor, isRawFpds,
  descriptionKey, descriptionGroups, dominantDescription,
  headShare, sameHead, noiseVerdict,
};
