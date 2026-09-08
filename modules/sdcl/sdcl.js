/**
 * sdcl.js — the Sentinel Desk Command Language, routed to real commands.
 *
 * WHAT THIS IS
 *   SDCL is a vocabulary for asking investigative questions: FOLLOWMONEY,
 *   FOLLOWLAND, WHOPAYS, DISPROVE. This file turns one of those questions
 *   into the commands this repository can actually run, and — this is the
 *   whole point — says plainly when there are none.
 *
 * WHY IT IS A ROUTER AND NOT FORTY NEW COMMANDS
 *   A command language is the easiest thing in the world to fake. You write
 *   forty verbs, each one prints something confident, and the desk feels
 *   twice as capable while answering exactly as many questions as before.
 *   That is worse than having no verb at all, because now there is a command
 *   you can point at and say "I ran FOLLOWLAND" when nothing read a deed.
 *
 *   So every verb here carries a STATUS:
 *
 *     BACKED    a real connector or reader answers this. Commands follow.
 *     PARTIAL   something runs, but it answers less than the verb promises.
 *               The gap is named. Read it before you believe the output.
 *     UNBACKED  nothing in this system reads that source. There is no API
 *               for a county deed or a board of revision complaint. The
 *               route is a records request and your own eyes, and the verb
 *               says so instead of printing a command that would look busy.
 *
 *   Fourteen of the forty verbs are UNBACKED. That is not a defect in the
 *   spec; it is the map of what this desk cannot yet see, which is the more
 *   useful half of knowing what it can.
 *
 * THE FOUR TIERS
 *   The spec requires output to separate LEAD / EVIDENCE / CLAIM / FINDING.
 *   Every verb declares the HIGHEST tier its own commands can reach:
 *
 *     LEAD      something worth looking at. Nobody has verified it.
 *     EVIDENCE  a primary document, fetched and hashed. It says what it says.
 *     CLAIM     what you assert the evidence shows. Yours, not the source's.
 *     FINDING   a claim that survived a real attempt to disprove it.
 *
 *   No search reaches FINDING. Searches reach EVIDENCE at best; the last two
 *   tiers are work you do, and the desk can only refuse to let you skip them.
 */

'use strict';

const TIERS = ['LEAD', 'EVIDENCE', 'CLAIM', 'FINDING'];

/** Shell-safe double quoting for a target the operator typed. */
function q(t) {
  return `"${String(t).replace(/"/g, '\\"')}"`;
}

/**
 * The one FOIA line every UNBACKED verb ends at.
 *
 * It deliberately does NOT invent a request ID or an agency name. A command
 * with a made-up ID in it gets pasted, works, and quietly creates a request
 * numbered after nothing.
 */
function foiaRoute(what) {
  return {
    run: 'sentinel foia',
    why: `no connector reads this. The route is a records request — ${what}. `
      + 'Open the desk first to see what you have already asked for.',
  };
}

/**
 * VERBS
 *
 * Each entry:
 *   family      the spec's five: MONEY LAND POWER RECORDS LAW (plus CORE)
 *   asks        the question in one plain sentence
 *   status      BACKED | PARTIAL | UNBACKED
 *   ceiling     highest tier these commands can reach on their own
 *   commands    (target) => [{ run, why }]
 *   denominator what you must know before any count here means anything
 *   notThis     what this verb cannot tell you, stated before you assume it can
 *   gap         PARTIAL/UNBACKED only: exactly what is missing
 */
const VERBS = {
  // ── CORE ────────────────────────────────────────────────────────────
  INVESTIGATE: {
    family: 'CORE',
    asks: 'Everything every connected source holds on one name.',
    status: 'BACKED',
    ceiling: 'EVIDENCE',
    commands: (t) => [
      { run: `sentinel connect all ${q(t)}`, why: 'every source at once, into the evidence inbox' },
      { run: `sentinel connect brief ${q(t)}`, why: 'what the library already held before this run' },
      { run: 'sentinel connect crosslink', why: 'what this name shares with your other subjects' },
    ],
    denominator: 'How many records each source HAS for this name, not how many it returned. '
      + 'A capped page is not a count.',
    notThis: 'It does not read anything. It captures. Fetching is not reading.',
  },

  WHOIS: {
    family: 'CORE',
    asks: 'What this entity legally is: where registered, under what name, owned by whom.',
    status: 'BACKED',
    ceiling: 'EVIDENCE',
    commands: (t) => [
      { run: `sentinel connect opencorporates ${q(t)}`, why: 'registration, jurisdiction, incorporation date' },
      { run: `sentinel connect sec ${q(t)}`, why: 'if it files: EX-21 lists the subsidiaries' },
      // The two SEC lines answer different questions and the pair is
      // deliberate: the search above finds documents that MENTION the name,
      // this one lists what the entity itself filed. A registrant found by
      // the first is a lead; its filing history is where the dates are.
      { run: 'sentinel sec history CIK', why: 'once you have its CIK: every filing it made, with dates and URLs' },
      { run: `sentinel connect entity ${q(t)}`, why: 'the OpenSanctions record, read in plain words' },
    ],
    denominator: 'A registry hit proves the name exists there. It proves nothing about who controls it.',
    notThis: 'Beneficial ownership. A Delaware LLC names an agent, not an owner.',
  },

  NETWORK: {
    family: 'CORE',
    asks: 'Who connects to whom across everything you have captured.',
    status: 'PARTIAL',
    ceiling: 'LEAD',
    commands: () => [
      { run: 'sentinel connect expand --limit 40', why: 'FIRST. Asks every registrant who ELSE they file for' },
      { run: 'sentinel connect crosslink', why: 'names appearing under more than one subject' },
      { run: 'sentinel connect graph', why: 'preview the same thing as a graph, writes nothing' },
    ],
    denominator: 'Until expand runs, every shared name is shared only among names YOU searched. '
      + 'A firm with 400 clients and 8 of yours is nothing; a firm with 12 and 6 of yours is a story. '
      + 'Crosslink alone cannot tell those apart.',
    notThis: 'Any tie that is not in a filing. Two people at the same dinner leave no record here.',
    gap: 'no denominator until `connect expand` has run against the same registrants',
  },

  TIMELINE: {
    family: 'CORE',
    asks: 'What happened in what order.',
    status: 'PARTIAL',
    ceiling: 'EVIDENCE',
    commands: (t) => [
      { run: `sentinel connect brief ${q(t)}`, why: 'every capture on this name with its date' },
    ],
    denominator: 'Capture date is when YOU found it. Filing date is when it happened. They are different columns.',
    notThis: 'Causation. Two things in order is an order, not a cause.',
    gap: 'no timeline builder. `connect brief` lists dated captures; the ordering is still yours',
  },

  // ── FOLLOW THE MONEY ────────────────────────────────────────────────
  FOLLOWMONEY: {
    family: 'MONEY',
    asks: 'Who paid whom, on the record, and how much.',
    status: 'BACKED',
    ceiling: 'EVIDENCE',
    commands: (t) => [
      { run: `sentinel connect usaspending ${q(t)}`, why: 'federal contracts and grants awarded to this name' },
      { run: `sentinel connect fecspend ${q(t)}`, why: 'what campaign committees spent, and with whom' },
      { run: `sentinel connect fec ${q(t)}`, why: 'contributions received' },
      { run: `sentinel connect senatelda --registrant ${q(t)}`, why: 'lobbying dollars, quarter by quarter' },
      { run: `sentinel moneyflow ${q(t)}`, why: 'then READ all four back as one flow, without summing across kinds' },
    ],
    denominator: 'ZERO IS A RESULT AND IT IS NOT NOTHING. Early Warning Services returned zero '
      + 'USAspending contracts while spending six figures a quarter on lobbying. That contrast '
      + 'is the finding. Do not discard an empty result — record it.',
    notThis: 'State and local money. None of these four cover a county or a school district.',
  },

  MONEYFLOW: {
    family: 'MONEY',
    asks: 'Which direction the money ran, and through how many hands.',
    // Was PARTIAL/LEAD and pointed only at the graph dashboard. `sentinel
    // moneyflow` now reads the dollar figures out of the captures directly,
    // and those rows are filed disclosures rather than co-occurrence -- the
    // same evidentiary weight FOLLOWMONEY already claims.
    status: 'BACKED',
    ceiling: 'EVIDENCE',
    commands: (t) => [
      { run: `sentinel moneyflow ${q(t)}`,
        why: 'every dollar figure on disk touching this name, in and out, by kind' },
      { run: `sentinel moneyflow ${q(t)} --exact`,
        why: 'same, refusing any partial name match -- use when siblings share a prefix' },
      { run: 'sentinel connect graph --dashboard --side-a "ENERGY|POWER|GAS" --side-b "AWS|META|MICROSOFT"',
        why: 'two named sides of your captures, and what sits between them' },
    ],
    denominator: 'It reads only what you captured. An absent figure means nobody searched it. '
      + 'Kinds are never summed: a contract ceiling is not a lobbying fee is not an ad buy.',
    notThis: 'Tracing a payment through an intermediary. FARA layering is visible; bank flow is not.',
    gap: 'no path tracer. The graph shows adjacency, and adjacency is not flow',
  },

  SUBSIDY: {
    family: 'MONEY',
    asks: 'How much tax revenue a government gave up, and to whom.',
    status: 'BACKED',
    ceiling: 'EVIDENCE',
    commands: (t) => [
      { run: `sentinel doc get ${q(t)}`, why: 'STEP 1 — the target here is the URL of the audited ACFR itself' },
      { run: 'sentinel doc abatements THE_TEXT_FILE_doc_get_PRINTED.txt --verbose',
        why: 'STEP 2 — GASB Statement 77 requires every US state and local government to '
          + 'disclose abated revenue annually. This reads that disclosure.' },
    ],
    denominator: 'One ACFR is one government for one year. New Albany, Licking County and the '
      + 'school district are three separate books, and the same abatement appears differently in each.',
    notThis: 'TIF. Tax increment financing DIVERTS revenue rather than forgiving it, so it '
      + 'generally falls outside Statement 77 and will not appear in the abatement note at all.',
  },

  PUBLICBENEFIT: {
    family: 'MONEY',
    asks: 'What the public was promised in return, and whether it arrived.',
    status: 'UNBACKED',
    ceiling: 'LEAD',
    commands: () => [foiaRoute('the development agreement, the job and payroll commitments, and the clawback clause')],
    denominator: 'Promised jobs versus verified jobs are two numbers. Almost every story confuses them.',
    notThis: 'Anything. Nothing here reads a development agreement.',
    gap: 'development agreements are local contracts. No API. Records request only.',
  },

  // ── FOLLOW THE LAND ─────────────────────────────────────────────────
  FOLLOWLAND: {
    family: 'LAND',
    asks: 'Who owned the parcel, when it sold, and to whom.',
    status: 'UNBACKED',
    ceiling: 'LEAD',
    commands: (t) => [
      { run: `sentinel connect opencorporates ${q(t)}`,
        why: 'ONLY if the owner is an entity — it tells you what the LLC is, never what it owns' },
      foiaRoute('the parcel transfer history from the county auditor and the recorder'),
    ],
    denominator: 'The parcel number is the key, not the address. One address can be six parcels.',
    notThis: 'Ownership. This desk has never read a deed.',
    gap: 'county auditor and recorder records are not connected. The dispatcher says so on its own help screen.',
  },

  PROPERTY: {
    family: 'LAND',
    asks: 'What the county says a parcel is worth and who is taxed on it.',
    status: 'UNBACKED',
    ceiling: 'LEAD',
    commands: () => [foiaRoute('the auditor parcel record: valuation, owner of record, and tax status')],
    denominator: 'Market value, assessed value and taxable value are three different numbers in Ohio. '
      + 'Assessed is 35% of market. Quoting the wrong one overstates by nearly three times.',
    notThis: 'Anything. No parcel source is connected.',
    gap: 'no auditor connector',
  },

  APPRECIATION: {
    family: 'LAND',
    asks: 'How much a parcel gained in value, and who captured the gain.',
    status: 'UNBACKED',
    ceiling: 'LEAD',
    commands: () => [foiaRoute('the valuation history for the parcel, every reappraisal year')],
    denominator: 'Ohio reappraises on a six-year cycle with a three-year update. A jump between '
      + 'two years may be a reappraisal, not a sale.',
    notThis: 'Anything. No parcel source is connected.',
    gap: 'no auditor connector',
  },

  REZONING: {
    family: 'LAND',
    asks: 'Who asked for the zoning change, who voted, and what changed.',
    status: 'UNBACKED',
    ceiling: 'LEAD',
    commands: () => [foiaRoute('the rezoning application, staff report, and the minutes of the meeting that approved it')],
    denominator: 'The application date versus the purchase date. Buying before the change is the question.',
    notThis: 'Anything. Municipal zoning files are not connected.',
    gap: 'no municipal records connector. R.C. 121.22 minutes are requestable.',
  },

  // ── FOLLOW THE POWER ────────────────────────────────────────────────
  FOLLOWPOWER: {
    family: 'POWER',
    asks: 'Where the electricity comes from, what it costs, and who agreed to that.',
    status: 'PARTIAL',
    ceiling: 'EVIDENCE',
    commands: () => [
      { run: 'sentinel connect sweep ratepayers --go', why: 'the twelve-subject tariff set, run for real' },
      { run: 'sentinel connect sweep energy --go', why: 'the generation and utility set' },
      { run: 'sentinel connect crosslink', why: 'what the two sets share' },
    ],
    denominator: 'A tariff applies to a CLASS of customer. "A data center pays X" is only true if '
      + 'the data center is in that class. Read the class definition before the rate.',
    notThis: 'PUCO case filings. The commission docket itself is not connected.',
    gap: 'no PUCO docket connector — federal sources only',
  },

  RATEPAYER: {
    family: 'POWER',
    asks: 'Who pays for the power a data center needs.',
    status: 'PARTIAL',
    ceiling: 'EVIDENCE',
    commands: () => [
      { run: 'sentinel connect sweep ratepayers --go', why: 'the whole named set, one run' },
      { run: 'sentinel connect crosslink', why: 'which filings and firms recur across it' },
      { run: 'sentinel connect expand --limit 40', why: 'and whether those firms are yours or everyone\'s' },
    ],
    denominator: 'Residential class versus mercantile class versus a special contract. '
      + 'Three denominators, and the answer changes with each.',
    notThis: 'The actual tariff sheet. That is a PUCO filing.',
    gap: 'no PUCO docket connector',
  },

  PUCO: {
    family: 'POWER',
    asks: 'What was filed at the Public Utilities Commission of Ohio, and by whom.',
    status: 'UNBACKED',
    ceiling: 'LEAD',
    commands: (t) => [
      { run: `sentinel doc get ${q(t)}`,
        why: 'if you have the URL of a specific PUCO filing, this fetches and hashes it' },
      foiaRoute('the case docket and the filings in it'),
    ],
    denominator: 'A case number is the unit. Intervenor lists say who thought it mattered enough to show up.',
    notThis: 'Search. There is no PUCO search here — you must already have the case.',
    gap: 'no PUCO connector. `doc get` fetches one known URL; it does not find one.',
  },

  OPSB: {
    family: 'POWER',
    asks: 'What the Ohio Power Siting Board approved, and over what objection.',
    status: 'UNBACKED',
    ceiling: 'LEAD',
    commands: (t) => [
      { run: `sentinel doc get ${q(t)}`, why: 'one known OPSB filing URL, fetched and hashed' },
      foiaRoute('the siting application and the board order'),
    ],
    denominator: 'Applications filed versus applications approved. A 100% approval rate is a finding.',
    notThis: 'Search.',
    gap: 'no OPSB connector',
  },

  // ── FOLLOW THE DECISION ─────────────────────────────────────────────
  FOLLOWDECISION: {
    family: 'POWER',
    asks: 'Who was in the room before the vote.',
    status: 'PARTIAL',
    ceiling: 'EVIDENCE',
    commands: (t) => [
      { run: `sentinel connect senatelda --registrant ${q(t)}`, why: 'who was paid to be heard, and on what' },
      { run: `sentinel connect regulationsgov ${q(t)}`, why: 'who filed a comment on the rule' },
      { run: `sentinel connect federalregister ${q(t)} --exact`, why: 'the rule itself, as published' },
    ],
    denominator: 'Comments filed is not comments read. The docket count is the denominator, '
      + 'and Regulations.gov returns false positives freely — check that each hit is your subject.',
    notThis: 'A state or local vote. All three sources are federal.',
    gap: 'federal only',
  },

  LOBBY: {
    family: 'POWER',
    asks: 'Who is paid to influence this, how much, and for whom.',
    status: 'BACKED',
    ceiling: 'EVIDENCE',
    commands: (t) => [
      { run: `sentinel connect senatelda --registrant ${q(t)}`, why: 'every client this firm files for' },
      { run: 'sentinel connect lobby --chart', why: 'read every captured filing, charted' },
      { run: `sentinel connect farascan --match ${q(t)}`, why: 'and whether a FOREIGN principal is behind it' },
    ],
    denominator: 'The LDA and FARA are different statutes. 22 U.S.C. 613(h) lets a firm working for '
      + 'a foreign commercial client register under the LDA INSTEAD of FARA. A FARA absence is '
      + 'therefore not an absence of foreign work.',
    notThis: 'Ohio lobbying. JLEC filings are a separate register, not connected.',
  },

  REVOLVINGDOOR: {
    family: 'POWER',
    asks: 'Which lobbyists used to hold the office they now lobby.',
    status: 'PARTIAL',
    ceiling: 'EVIDENCE',
    commands: (t) => [
      { run: `sentinel connect senatelda --registrant ${q(t)} --pages 20`,
        why: 'LDA filings name each lobbyist AND any covered government position they held. '
          + 'That field is the revolving door, self-reported.' },
    ],
    denominator: 'Self-reported. A blank covered-position field means "not disclosed", never "none".',
    notThis: 'State officials, and anyone who left before the filing period you pulled.',
    gap: 'no personnel-history source. You are reading a field the lobbyist filled in.',
  },

  // ── FOLLOW THE LAW ──────────────────────────────────────────────────
  ORC: {
    family: 'LAW',
    asks: 'What the Ohio Revised Code actually says about this.',
    status: 'PARTIAL',
    ceiling: 'EVIDENCE',
    commands: (t) => [
      { run: `sentinel doc get ${q(t)}`, why: 'STEP 1 — fetch the code section from codes.ohio.gov, hashed' },
      { run: 'sentinel doc sections THE_TEXT_FILE_doc_get_PRINTED.txt --mentions exempt',
        why: 'STEP 2 — the exemptions are where the answer usually is' },
    ],
    denominator: 'A section quoted without its exceptions subsection is a section quoted wrong.',
    notThis: 'Case law. The code is not how the code has been read.',
    gap: 'no statute search — you supply the URL of the section',
  },

  SUNSHINE: {
    family: 'LAW',
    asks: 'Whether the meeting or the record was legally required to be open.',
    status: 'PARTIAL',
    ceiling: 'EVIDENCE',
    commands: () => [
      { run: 'sentinel doc get "https://codes.ohio.gov/ohio-revised-code/section-121.22"',
        why: 'the Open Meetings Act, fetched and hashed so you can quote it exactly' },
      { run: 'sentinel doc get "https://codes.ohio.gov/ohio-revised-code/section-149.43"',
        why: 'the Public Records Act — the exemption list is subsection (A)(1)' },
    ],
    denominator: 'An executive session is lawful only for an enumerated purpose, stated in the motion. '
      + 'A motion that does not state one is the violation.',
    notThis: 'Whether it happened. The statute says what is required, not what was done.',
    gap: 'reads the law, not the conduct',
  },

  PUBLICRECORDS: {
    family: 'RECORDS',
    asks: 'What has been requested, from whom, and what is overdue.',
    status: 'BACKED',
    ceiling: 'EVIDENCE',
    commands: () => [
      { run: 'sentinel foia', why: 'every request, most urgent first' },
      { run: 'sentinel foia dash', why: 'all of them on one screen' },
    ],
    denominator: 'Ohio has no statutory deadline — R.C. 149.43 says "reasonable". The clock the '
      + 'desk runs is yours, not the law\'s. Say so if you publish it.',
    notThis: 'Whether the denial was lawful.',
  },

  CONTRACTS: {
    family: 'MONEY',
    asks: 'What this entity was paid to do by a government.',
    status: 'BACKED',
    ceiling: 'EVIDENCE',
    commands: (t) => [
      { run: `sentinel connect usaspending ${q(t)}`, why: 'federal awards, with the competition fields' },
      { run: `sentinel connect federalgrants ${q(t)}`, why: 'grants, which are not contracts and are counted separately' },
    ],
    denominator: 'Obligated is not outlaid. A $40M award may have paid out $2M.',
    notThis: 'State and local contracts. Not federal, not here.',
  },

  NOBID: {
    family: 'MONEY',
    asks: 'Whether anyone else was allowed to compete.',
    status: 'PARTIAL',
    ceiling: 'EVIDENCE',
    commands: (t) => [
      { run: `sentinel connect usaspending ${q(t)}`,
        why: 'federal awards carry the extent-competed and number-of-offers fields' },
      foiaRoute('the local solicitation file, the bid tabulation, and any sole-source justification'),
    ],
    denominator: 'One offer received is not the same as not competed. Both are disclosed, separately.',
    notThis: 'Local procurement, which is where most no-bid awards live.',
    gap: 'federal only',
  },

  // ── SCHOOLS AND VALUATION ───────────────────────────────────────────
  FOLLOWSCHOOLS: {
    family: 'LAND',
    asks: 'What the school district lost or gained, and whether it agreed.',
    status: 'UNBACKED',
    ceiling: 'LEAD',
    commands: () => [
      foiaRoute('the school board resolution consenting to the abatement, and the compensation agreement'),
    ],
    denominator: 'A district usually must CONSENT to an abatement above a threshold. Consent given '
      + 'in exchange for a payment is a different story from consent given for nothing.',
    notThis: 'Anything. School board records are not connected.',
    gap: 'no school district connector. The consent resolution is a public record under R.C. 149.43.',
  },

  BOR: {
    family: 'LAND',
    asks: 'Who contested a valuation at the county board of revision, and what it moved.',
    status: 'UNBACKED',
    ceiling: 'LEAD',
    commands: () => [foiaRoute('the board of revision complaint, the decision, and the hearing record')],
    denominator: 'Complaints filed versus reductions granted. A high grant rate for one filer is the story.',
    notThis: 'Anything. BOR records are county records.',
    gap: 'no BOR connector',
  },

  VALUATION: {
    family: 'LAND',
    asks: 'What a property is valued at and by whose method.',
    status: 'UNBACKED',
    ceiling: 'LEAD',
    commands: () => [foiaRoute('the auditor valuation worksheet and the appraisal method used')],
    denominator: 'Same three-number trap as PROPERTY: market, assessed, taxable.',
    notThis: 'Anything.',
    gap: 'no auditor connector',
  },

  // ── DATA CENTERS ────────────────────────────────────────────────────
  DATACENTER: {
    family: 'POWER',
    asks: 'Everything the desk holds on the build-out.',
    status: 'BACKED',
    ceiling: 'EVIDENCE',
    commands: () => [
      { run: 'sentinel connect sweep datacenters --go', why: 'the twelve-subject set' },
      { run: 'sentinel connect sweep datacenter_policy --go', why: 'the nine-subject policy set' },
      { run: 'sentinel connect sweep shell_entities --go', why: 'the eighteen named holding entities' },
      { run: 'sentinel connect crosslink', why: 'and what all three share' },
    ],
    denominator: 'The named entity is rarely the operator. A parcel bought by an LLC with a '
      + 'law-firm address tells you a lawyer filed it, and nothing else.',
    notThis: 'What is inside the building, or how much power it actually draws.',
  },

  LOAD: {
    family: 'POWER',
    asks: 'How much electricity it draws, and against what capacity.',
    status: 'UNBACKED',
    ceiling: 'LEAD',
    commands: () => [foiaRoute('the interconnection request and the load study filed with the utility')],
    denominator: 'Nameplate capacity, contracted load and actual draw are three numbers and they '
      + 'differ by multiples. Which one a press release quotes is itself informative.',
    notThis: 'Anything. No utility load source is connected.',
    gap: 'no interconnection-queue connector',
  },

  SOCIALIZATION: {
    family: 'POWER',
    asks: 'Whether one customer\'s cost was spread across everyone\'s bill.',
    status: 'PARTIAL',
    ceiling: 'LEAD',
    commands: () => [
      { run: 'sentinel connect sweep ratepayers --go', why: 'the tariff fight, as far as federal sources see it' },
      foiaRoute('the rate case testimony and the cost-allocation study'),
    ],
    denominator: 'Cost causation is the entire argument: who caused the cost decides who should bear it. '
      + 'You need the allocation study, not the bill.',
    notThis: 'The allocation itself, which lives in a PUCO rate case.',
    gap: 'the decisive document is a PUCO filing and PUCO is not connected',
  },

  // ── FOLLOW THE RECORDS ──────────────────────────────────────────────
  FOLLOWRECORDS: {
    family: 'RECORDS',
    asks: 'What you asked for, what came back, and what is late.',
    status: 'BACKED',
    ceiling: 'EVIDENCE',
    commands: () => [
      { run: 'sentinel foia', why: 'the desk, most urgent first' },
      { run: 'sentinel pra mail fetch', why: 'read replies and show what they match' },
    ],
    denominator: 'Requests sent versus requests answered versus requests answered COMPLETELY. Three numbers.',
    notThis: 'Whether what came back is all of it. That is RECORDGAP.',
  },

  RECORDGAP: {
    family: 'RECORDS',
    asks: 'What is missing from what they gave you.',
    status: 'BACKED',
    ceiling: 'EVIDENCE',
    commands: (t) => [
      { run: `sentinel doc gaps ${q(t)} --why`,
        why: 'the target here is a TEXT FILE, not a name — the extracted production. '
          + '--why prints the reasoning, and the tool refuses to conclude below its confidence floor.' },
    ],
    denominator: 'Page numbers, Bates numbers, exhibit letters and date ranges are four separate '
      + 'sequences. A gap in one is not a gap in the others.',
    notThis: 'Why it is missing. A gap is not yet a withholding.',
  },

  FOIASTRATEGY: {
    family: 'RECORDS',
    asks: 'What to ask for next, and how to word it so it cannot be refused on form.',
    status: 'BACKED',
    ceiling: 'CLAIM',
    commands: () => [
      { run: 'sentinel foia', why: 'what is already open — do not re-request what is pending' },
      { run: 'sentinel pra mail review', why: 'letters waiting on your sign-off before anything goes out' },
    ],
    denominator: 'One narrow request answered beats four broad ones denied. Count what you can '
      + 'realistically read, not what you can name.',
    notThis: 'Sending anything. Nothing leaves without `pra mail approve` and then `pra mail send`.',
  },

  // ── THE TWO QUESTIONS ───────────────────────────────────────────────
  WHOBENEFITS: {
    family: 'CORE',
    asks: 'Who is better off because this decision went the way it did.',
    status: 'PARTIAL',
    ceiling: 'CLAIM',
    commands: (t) => [
      { run: `sentinel connect brief ${q(t)}`, why: 'start from what you already hold' },
      { run: 'sentinel connect crosslink', why: 'who recurs on the winning side' },
    ],
    denominator: 'Name the beneficiary from a DOCUMENT. A beneficiary inferred from an outcome is '
      + 'a hypothesis wearing a conclusion\'s clothes.',
    notThis: 'Intent. Benefit is not motive and the difference is the whole libel exposure.',
    gap: 'this is an analytic question. No command answers it; the commands only assemble the record.',
  },

  WHOPAYS: {
    family: 'CORE',
    asks: 'Who bears the cost, and were they in the room.',
    status: 'PARTIAL',
    ceiling: 'CLAIM',
    commands: () => [
      { run: 'sentinel connect sweep ratepayers --go', why: 'the clearest live instance of this question' },
      { run: 'sentinel connect crosslink', why: 'and who appears on both sides of it' },
    ],
    denominator: 'Total cost, and the share. "Ratepayers pay $X" needs the class size to mean anything.',
    notThis: 'Fairness. The desk can show the split. It cannot rule on it.',
    gap: 'analytic. Same as WHOBENEFITS.',
  },

  // ── BUILDING AND BREAKING THE CASE ──────────────────────────────────
  CASEBUILD: {
    family: 'CORE',
    asks: 'Turn captures into a case that can be published or refused.',
    status: 'BACKED',
    ceiling: 'FINDING',
    commands: (t) => [
      { run: `sentinel case new ${q(t)} "what this case asserts, in one sentence"`,
        why: 'the target is the CASE ID you choose, e.g. ratepayers-2026' },
      { run: `sentinel case add ${q(t)} EX-1 path/to/file.pdf --kind financial --pages 44`,
        why: 'every exhibit, with its real page count' },
      { run: `sentinel case status ${q(t)}`,
        why: 'the gate: four rules, no --force, and it will tell you which one blocks you' },
    ],
    denominator: 'Pages read versus pages in the exhibit. R-01 exists because the number that '
      + 'ruins a story is on page 40 of a 44-page filing.',
    notThis: 'Deciding for you. The gate blocks publication; it does not bless it.',
  },

  DOTCONNECT: {
    family: 'CORE',
    asks: 'What shows up in more than one place.',
    status: 'PARTIAL',
    ceiling: 'LEAD',
    commands: () => [
      { run: 'sentinel connect expand --limit 40', why: 'RUN THIS FIRST or the next line has no denominator' },
      { run: 'sentinel connect crosslink --verbose', why: 'the overlaps, with the reasoning' },
    ],
    denominator: 'Crosslink prints NO DENOMINATOR on every row until expand has run. That warning '
      + 'is the honest state of the output, not a formatting quirk.',
    notThis: 'Significance. A shared law firm in a city with four law firms is not a connection.',
    gap: 'coverage of the other side is unknown until expand runs',
  },

  HYPOTHESIS: {
    family: 'CORE',
    asks: 'State the thing you suspect, in a form that could be shown false.',
    status: 'BACKED',
    ceiling: 'LEAD',
    commands: (t) => [
      { run: `sentinel case ask ${q(t)} "the question this hypothesis has to answer"`,
        why: 'the target is the CASE ID. An open question BLOCKS publication under R-03, '
          + 'which is the point — you cannot publish past your own uncertainty.' },
    ],
    denominator: 'A hypothesis with no disproving observation is not a hypothesis. Write down what '
      + 'you would have to see to abandon it, before you look.',
    notThis: 'Evidence. A hypothesis is a LEAD and stays one until a document moves it.',
  },

  DISPROVE: {
    family: 'CORE',
    asks: 'Try to kill your own claim. This is the verb that makes the rest trustworthy.',
    status: 'BACKED',
    ceiling: 'FINDING',
    commands: (t) => [
      { run: `sentinel case conflict ${q(t)} "source A says X, source B says Y"`,
        why: 'log the contradiction. R-04 blocks publication until it is resolved, because two '
          + 'sources disagreeing is the single best predictor that a published claim is wrong.' },
      { run: `sentinel case status ${q(t)}`, why: 'see what is still unresolved' },
    ],
    denominator: 'The innocent explanation, stated as strongly as you can state it. If you cannot '
      + 'argue the other side well, you have not tested anything.',
    notThis: 'Optional. A claim that survived no attempt is a CLAIM, never a FINDING.',
  },

  PUBLICINTEREST: {
    family: 'CORE',
    asks: 'Whether this should be published at all, and in what form.',
    status: 'BACKED',
    ceiling: 'FINDING',
    commands: (t) => [
      { run: `sentinel case status ${q(t)}`, why: 'the four-rule gate, on the record' },
    ],
    denominator: 'Named private individuals are the exposure. Institutions can answer; a person '
      + 'named in passing cannot. Decide who is a subject and who is a bystander before you write.',
    notThis: 'A legal opinion. The gate is an editorial discipline, not counsel.',
  },
};

/**
 * Commands that are TEMPLATES, not commands.
 *
 * Three of the forty verbs emit a line you are meant to edit before running:
 * a case sentence to write, a file path to supply, a text file that only
 * exists after `doc get` prints its name. Those lines are printed with a
 * marker and are never executed by --run.
 *
 * This exists because the alternative was discovered the expensive way: a
 * literal placeholder pasted into a command reads as a real argument, and
 * the tool that receives it does exactly what it was told with a filename
 * that describes a filename.
 */
const TEMPLATE_TOKENS = [
  'THE_TEXT_FILE_doc_get_PRINTED',
  'path/to/',
  'what this case asserts',
  'the question this hypothesis has to answer',
  'source A says X',
  // Added the same hour it was introduced. `sentinel sec history CIK` was
  // written into WHOIS below and it is a STAND-IN -- a number you look up,
  // not a value to paste -- in the one file whose job is to refuse exactly
  // that. It passed every test because nothing knew the word. The lesson is
  // that this list is not a fixed set: a new stand-in is a new entry, and
  // adding the command without adding the token is how the disease returns.
  ' CIK',
];

/** Can this line be executed as printed, or must you edit it first? */
function runnable(run) {
  return !TEMPLATE_TOKENS.some((t) => String(run).includes(t));
}

/** Verb names, in the order they are defined. */
function verbNames() { return Object.keys(VERBS); }

/** Group verbs by the spec's five families. */
function byFamily() {
  const out = {};
  for (const [name, v] of Object.entries(VERBS)) {
    (out[v.family] = out[v.family] || []).push(name);
  }
  return out;
}

/**
 * Parse one SDCL line into a verb and a target.
 *
 * The verb is the first token, case-insensitively. Everything after it is the
 * target verbatim — a name, a URL, a case id, a file path. Flags are left in
 * the target on purpose: this router does not interpret them, and silently
 * eating one would be worse than passing it through.
 */
function parse(line) {
  const raw = String(line == null ? '' : line).trim();
  if (!raw) return { verb: '', target: '', known: false };
  const m = /^(\S+)\s*([\s\S]*)$/.exec(raw);
  const verb = m[1].toUpperCase().replace(/[^A-Z]/g, '');
  const target = m[2].trim().replace(/^["']|["']$/g, '');
  return { verb, target, known: Object.prototype.hasOwnProperty.call(VERBS, verb) };
}

/**
 * Suggest verbs for an unknown one. Substring both ways, then shared prefix —
 * enough to catch FOLLOWDOLLAR for FOLLOWMONEY without pretending to be smart.
 */
function suggest(verb) {
  if (!verb) return [];
  const hits = verbNames().filter((v) => v.includes(verb) || verb.includes(v));
  if (hits.length) return hits;
  return verbNames().filter((v) => v.slice(0, 4) === verb.slice(0, 4));
}

/**
 * Route one SDCL line.
 *
 * Returns { ok, verb, target, spec, commands, needsTarget, suggestions }.
 * `commands` is [] when the verb needs a target and none was given — never a
 * command with a placeholder in it. A placeholder in a printed command is an
 * angle bracket waiting to be pasted into zsh, and this repo has been bitten
 * by that four separate times.
 */
function route(line) {
  const { verb, target, known } = parse(line);
  if (!known) {
    return { ok: false, verb, target, spec: null, commands: [], needsTarget: false,
      suggestions: suggest(verb) };
  }
  const spec = VERBS[verb];
  const built = spec.commands(target || '')
    .map((c) => Object.assign({}, c, { runnable: runnable(c.run) }));
  // A verb needs a target if any command it would emit mentions one.
  const needsTarget = !target && spec.commands('SENTINEL_PROBE')
    .some((c) => c.run.includes('SENTINEL_PROBE'));
  return {
    ok: true,
    verb,
    target,
    spec,
    commands: needsTarget ? [] : built,
    needsTarget,
    suggestions: [],
  };
}

module.exports = {
  VERBS, TIERS, TEMPLATE_TOKENS,
  verbNames, byFamily, parse, route, suggest, runnable,
};
