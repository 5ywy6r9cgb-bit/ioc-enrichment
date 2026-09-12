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
 */
const SUFFIX = /\b(corporation|corp|company|co|incorporated|inc|llc|l\.l\.c|lp|llp|plc|ltd|limited|pllc|pc|pa|sa|nv|gmbh|holdings|group)\b/g;

function normaliseName(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(SUFFIX, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whole-word presence of the query inside a recipient name.
 *
 * WORD, not substring. "Ntrepid" is not a word in "intrepid llc" — it is
 * the tail of one, and that namesake holds $441m of Defense awards which
 * sort to the top of a list ordered by amount.
 */
function namesMatch(query, name) {
  const q = normaliseName(query);
  const n = normaliseName(name);
  if (!q || !n) return false;

  // A QUERY THAT SHRINKS TO ALMOST NOTHING MUST NOT MATCH ALMOST ANYTHING.
  //
  // "X Corp" normalises to "x" once the suffix comes off. A one- or
  // two-character token matches on sight, and the live X Corp run shows
  // what the register does with that name: RTX CORPORATION at $8.69bn,
  // $7.91bn, $7.50bn and $4.87bn, XEROX, XERION, and CONDUENT EDUCATION
  // SOLUTIONS at $2.25bn — the last of which the substring guard did not
  // even flag.
  //
  // So a short stem demands the WHOLE normalised name, not a word inside
  // it. "X Corp" then matches "X Corp." and "X CORP (FORMERLY TWITTER,
  // INC.)" and nothing else — and the operator is told the query was too
  // short to filter rather than handed a billion-dollar namesake.
  if (q.length <= 2) return q === n;

  return q.split(/\s+/).every((w) => new RegExp(`(^| )${w}( |$)`).test(n));
}

/** True when a name has no distinguishing stem left after suffix removal. */
function tooShortToFilter(query) {
  return normaliseName(query).length <= 2;
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
  for (const r of rows) {
    const a = (r.agency || '(agency not stated)').trim();
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
};
