'use strict';
// Bounded ACS five-year collection. Responses are estimates, never current headcounts.
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const METRICS = {
  population: { code: 'B01003_001', heading: 'Total population', unit: 'persons', universe: 'Total population' },
  households: { code: 'B11001_001', heading: 'Total households', unit: 'households', universe: 'Households' },
  housing: { code: 'B25001_001', heading: 'Total housing units', unit: 'housing units', universe: 'Housing units' },
  income: { code: 'B19013_001', heading: 'Median household income', unit: 'vintage-year inflation-adjusted dollars', universe: 'Households', caution: 'Median, not total income; never sum medians.' },
  poverty_population: { code: 'B17001_001', heading: 'Population for whom poverty status is determined', unit: 'persons', universe: 'Population for whom poverty status is determined' },
  poverty_below: { code: 'B17001_002', heading: 'People below poverty level', unit: 'persons', universe: 'Population for whom poverty status is determined' }
};
const FORMULA_SOURCE = 'https://www2.census.gov/programs-surveys/acs/tech_docs/accuracy/2024_ACS_Accuracy_Document_Worked_Examples.pdf';
const GEOGRAPHY_SOURCE = 'https://api.census.gov/data/2024/acs/acs5/geography.html';
const SCHOOL_TYPES = ['unified', 'elementary', 'secondary'];
function geography(o) {
  if (!/^\d{2}$/.test(o.state) || !/^\d{3}$/.test(o.county)) throw Error('Invalid state or county');
  if (o.place && !/^\d{5}$/.test(o.place)) throw Error('Invalid place');
  if (o.tract && !/^\d{6}$/.test(o.tract)) throw Error('Invalid tract');
  if (o.subdivision && !/^\d{5}$/.test(o.subdivision)) throw Error('Invalid county subdivision');
  if (o['block-group'] && (!/^\d$/.test(o['block-group']) || !o.tract)) throw Error('Block group requires a tract');
  if (o['school-district'] && (!/^\d{5}$/.test(o['school-district']) || !SCHOOL_TYPES.includes(o['school-type']))) throw Error('School district requires explicit type');
  if (o['school-type'] && !o['school-district']) throw Error('School type requires district');
  if ([o.place, o.subdivision, o['school-district'], o.tract].filter(Boolean).length > 1) throw Error('Conflicting geographies');
  let type = 'county', summary_level = '050', parts = [['state', 'state'], ['county', 'county']];
  if (o.place) { type = 'place'; summary_level = '160'; parts = [['state', 'state'], ['place', 'place']]; }
  else if (o.subdivision) { type = 'county subdivision'; summary_level = '060'; parts.push(['county subdivision', 'subdivision']); }
  else if (o['school-district']) {
    type = `school district (${o['school-type']})`;
    summary_level = { elementary: '950', secondary: '960', unified: '970' }[o['school-type']];
    parts = [['state', 'state'], [type, 'school-district']];
  } else if (o.tract) {
    type = 'tract'; summary_level = '140'; parts.push(['tract', 'tract']);
    if (o['block-group']) { type = 'block group'; summary_level = '150'; parts.push(['block group', 'block-group']); }
  }
  return {
    type, summary_level, parts,
    for: `${parts.at(-1)[0]}:${o[parts.at(-1)[1]]}`,
    in: parts.slice(0, -1).map(([field, key]) => `${field}:${o[key]}`).join(' '),
    geoid: parts.map(([, key]) => o[key]).join('')
  };
}
function options(args) {
  const o = { year: '2024', state: '39', county: '049', metric: 'population', capture: false };
  const values = ['--year', '--state', '--county', '--place', '--tract', '--metric', '--output', '--subdivision', '--block-group', '--school-district', '--school-type'];
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (seen.has(a)) throw Error('Duplicate option');
    seen.add(a);
    if (a === '--capture') o.capture = true;
    else if (values.includes(a)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error('Missing option value');
      o[a.slice(2)] = args[++i];
    } else throw Error('Unknown option');
  }
  if (!/^20\d{2}$/.test(o.year) || Number(o.year) < 2009 || !Object.hasOwn(METRICS,o.metric)) throw Error('Invalid year or metric');
  geography(o);
  return o;
}
function optionsFromObservation(obs) {
  if (!obs || !/^\d+$/.test(obs.geoid || '') || !Number.isInteger(obs.vintage)) throw Error('Invalid observation');
  const metric = Object.keys(METRICS).find(k => METRICS[k].code + 'E' === obs.variable);
  if (!metric) throw Error('Unsupported variable');
  const id = obs.geoid;
  const args = ['--metric', metric, '--year', String(obs.vintage), '--state', id.slice(0, 2)];
  const school = /^school district \((unified|elementary|secondary)\)$/.exec(obs.geography);
  if (obs.geography === 'county' && id.length === 5) args.push('--county', id.slice(2));
  else if (obs.geography === 'place' && id.length === 7) args.push('--place', id.slice(2));
  else if (obs.geography === 'tract' && id.length === 11) args.push('--county', id.slice(2, 5), '--tract', id.slice(5));
  else if (obs.geography === 'county subdivision' && id.length === 10) args.push('--county', id.slice(2, 5), '--subdivision', id.slice(5));
  else if (obs.geography === 'block group' && id.length === 12) args.push('--county', id.slice(2, 5), '--tract', id.slice(5, 11), '--block-group', id.slice(11));
  else if (school && id.length === 7) args.push('--school-type', school[1], '--school-district', id.slice(2));
  else throw Error('Unsupported geography or identifier length');
  return options(args);
}
function fieldsFor(o) {
  const metrics = o.product === 'poverty' ? ['poverty_population', 'poverty_below'] : [o.metric || 'population'];
  return ['NAME', ...metrics.flatMap(k => ['E', 'M', 'EA', 'MA'].map(s => METRICS[k].code + s))];
}
function urlFor(o, key) {
  const g = geography(o);
  const u = new URL(`https://api.census.gov/data/${o.year}/acs/acs5`);
  u.searchParams.set('get', fieldsFor(o).join(','));
  u.searchParams.set('for', g.for);
  u.searchParams.set('in', g.in);
  if (key) u.searchParams.set('key', key);
  return u;
}
function numeric(raw) {
  if (raw === null || raw === '' || !/^\d+$/.test(String(raw))) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}
function annotatedNumber(raw, annotation) {
  // Even a positive endpoint of a top/bottom-coded median is not an exact estimate.
  return annotation === null || annotation === '' ? numeric(raw) : null;
}
function calculationMOE(obs) {
  if (obs.margin_of_error_raw === '-555555555' && obs.moe_annotation === '*****') return { value: 0, status: 'controlled_no_sampling_error' };
  const value = annotatedNumber(obs.margin_of_error_raw, obs.moe_annotation);
  return { value, status: value === null ? 'unavailable_or_annotated' : 'published_90_percent_moe' };
}
function parse(body, o) {
  const rows = JSON.parse(body.toString('utf8'));
  if (!Array.isArray(rows) || rows.length !== 2 || !Array.isArray(rows[0]) || !Array.isArray(rows[1])) throw Error('Expected exactly one geography row');
  const [h, r] = rows;
  const metric = METRICS[o.metric || 'population'], g = geography(o);
  if (h.length !== r.length || h.some(k => typeof k !== 'string') || new Set(h).size !== h.length || [...fieldsFor(o), ...g.parts.map(([k]) => k)].some(k => !h.includes(k))) throw Error('Unexpected Census schema');
  const v = Object.fromEntries(h.map((k, i) => [k, r[i]]));
  if (g.parts.some(([field, key]) => v[field] !== o[key]) || typeof v.NAME !== 'string' || !v.NAME.trim()) throw Error('Geography mismatch');
  const result = {
    dataset: 'acs/acs5', vintage: Number(o.year), period_start: Number(o.year) - 4,
    period_end: Number(o.year), geography: g.type, summary_level: g.summary_level, geoid: g.geoid,
    geography_reference_date: `${o.year}-01-01`,
    name: v.NAME, heading: metric.heading, universe: metric.universe, variable: metric.code + 'E', unit: metric.unit, caution: metric.caution || null,
    estimate: annotatedNumber(v[metric.code + 'E'], v[metric.code + 'EA']), margin_of_error: annotatedNumber(v[metric.code + 'M'], v[metric.code + 'MA']),
    estimate_raw: v[metric.code + 'E'], margin_of_error_raw: v[metric.code + 'M'],
    estimate_annotation: v[metric.code + 'EA'], moe_annotation: v[metric.code + 'MA'],
    coverage: 'one requested geography returned; no broader coverage claimed',
    interpretation: 'Five-year survey estimate; not a current population headcount. Annotations and negative sentinels are retained raw; derived calculations use only valid values.',
    review_status: 'unreviewed', parser_version: 'census-bounded/2'
  };
  result.uncertainty_status = calculationMOE(result).status;
  return result;
}
function povertyProportion(numerator, denominator) {
  const common = ['dataset', 'vintage', 'period_start', 'period_end', 'geography', 'geoid', 'universe', 'unit'];
  const reasons = [];
  if (!numerator || !denominator) return { status: 'BLOCKED', reasons: ['Missing components'], publication_approved: false, proportion: null, percent: null, margin_of_error_percentage_points: null };
  if (common.some(k => numerator[k] === undefined || numerator[k] === null || numerator[k] !== denominator[k])) reasons.push('Numerator and denominator context differs');
  if (denominator.dataset !== 'acs/acs5' || denominator.unit !== 'persons' || denominator.universe !== METRICS.poverty_population.universe) reasons.push('Unsupported poverty universe or dataset');
  try { optionsFromObservation(numerator); optionsFromObservation(denominator); } catch (_) { reasons.push('Invalid geography or vintage'); }
  if (denominator.period_start !== denominator.vintage - 4 || denominator.period_end !== denominator.vintage) reasons.push('Invalid survey period');
  if (numerator.variable !== 'B17001_002E' || denominator.variable !== 'B17001_001E') reasons.push('Only the documented B17001 subset pair is supported');
  const n = annotatedNumber(numerator.estimate_raw, numerator.estimate_annotation);
  const d = annotatedNumber(denominator.estimate_raw, denominator.estimate_annotation);
  const mn = calculationMOE(numerator), md = calculationMOE(denominator);
  if (n === null || d === null || d <= 0 || n > d) reasons.push('Invalid subset count or denominator');
  if (mn.value === null || md.value === null) reasons.push('Sampling uncertainty unavailable');
  const base = { assertion_type: 'derived', review_status: 'unreviewed', publication_approved: false, confidence_level: 0.90, formula_source: FORMULA_SOURCE, calculation_version: 'acs-subset-proportion/1' };
  if (reasons.length) return { ...base, status: 'BLOCKED', reasons, proportion: null, percent: null, margin_of_error_percentage_points: null };
  const p = n / d, radicand = mn.value ** 2 - p ** 2 * md.value ** 2;
  const fallback = radicand < 0;
  const moe = Math.sqrt(fallback ? mn.value ** 2 + p ** 2 * md.value ** 2 : radicand) / d;
  if (!Number.isFinite(moe)) return { ...base, status: 'BLOCKED', reasons: ['Nonfinite calculation'], proportion: null, percent: null, margin_of_error_percentage_points: null };
  return { ...base, status: 'DERIVED_UNREVIEWED', reasons: [], proportion: p, percent: 100 * p,
    margin_of_error_proportion: moe, margin_of_error_percentage_points: 100 * moe,
    method: fallback ? 'ratio_approximation_fallback' : 'subset_proportion_approximation',
    numerator_moe_used: mn.value, denominator_moe_used: md.value,
    numerator_uncertainty_status: mn.status, denominator_uncertainty_status: md.status,
    formula: fallback ? '100 * sqrt(MOE_N^2 + (N/D)^2 * MOE_D^2) / D' : '100 * sqrt(MOE_N^2 - (N/D)^2 * MOE_D^2) / D',
    note: 'Approximate 90% sampling MOE in percentage points. Does not measure nonsampling error. This is a poverty proportion for the table universe, not all residents or individual households.' };
}
function parsePoverty(body, o) {
  const denominator = parse(body, { ...o, product: undefined, metric: 'poverty_population' });
  const numerator = parse(body, { ...o, product: undefined, metric: 'poverty_below' });
  return { product: 'poverty_proportion', dataset: denominator.dataset, vintage: denominator.vintage,
    period_start: denominator.period_start, period_end: denominator.period_end,
    geography: denominator.geography, summary_level: denominator.summary_level, geoid: denominator.geoid,
    geography_reference_date: denominator.geography_reference_date, name: denominator.name,
    coverage: denominator.coverage, review_status: 'unreviewed', numerator, denominator,
    calculation: povertyProportion(numerator, denominator), parser_version: 'census-bounded/2' };
}
function fetchBody(url) {
  return new Promise((resolve, reject) => {
    // Host is constructed internally; redirects are deliberately not followed.
    const req = https.get(url, { headers: { 'Accept': 'application/json', 'Accept-Encoding': 'identity' } }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(Error('Census returned non-200 status')); return; }
      if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') { res.resume(); reject(Error('Unexpected content encoding')); return; }
      const chunks = []; let size = 0;
      res.on('data', b => { size += b.length; if (size > 1024 * 1024) req.destroy(Error('Response limit exceeded')); else chunks.push(b); });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', () => reject(Error('Response failed')));
    });
    const deadline = setTimeout(() => req.destroy(Error('Deadline exceeded')), 30000);
    req.on('close', () => clearTimeout(deadline));
    req.on('error', () => reject(Error('Census connection failed')));
  });
}
async function collect(o, dependencies = {}) {
  const safeUrl = urlFor(o).toString();
  // Shared loader reads credentials locally; never print env, URL-with-key or upstream errors.
  const registry = dependencies.registry || require('./registry');
  const key = registry.loadEnv().CENSUS_API_KEY;
  if (!key || /\s/.test(key) || key.includes('PASTE_')) throw Error('Census key missing or malformed');
  const body = await (dependencies.fetchBody || fetchBody)(urlFor(o, key));
  if (body.includes(Buffer.from(key))) throw Error('Refusing credential-bearing response');
  const observation = o.product === 'poverty' ? parsePoverty(body, o) : parse(body, o);
  const root = path.resolve(o.output || path.join(__dirname, '../../evidence'));
  const g = geography(o), product = o.product || o.metric;
  const receipt = registry.recordCapture({ connector: 'census', subject: `${o.year}-${g.summary_level}-${observation.geoid}-${product}`,
    url: safeUrl, body, evidenceRoot: root, ledgerPath: path.join(root, 'manifests/provenance.jsonl'),
    tool: 'node modules/connectors/census.js', extra: { dataset: observation.dataset, vintage: observation.vintage, geoid: observation.geoid, summary_level: g.summary_level, product, coverage: observation.coverage } });
  const result = { ...observation, source_url: safeUrl, retrieved_at: new Date().toISOString(), capture_sha256: receipt.sha256, capture_path: receipt.capturePath };
  const output = receipt.capturePath.replace(/\.json$/, o.product === 'poverty' ? '.poverty.json' : '.observation.json');
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { ok: true, observation: result, observation_path: output };
}
async function main(args) {
  if (args[0] === 'context') return require('./context_desk').main(args.slice(1));
  if (['catalog', 'variables', 'template', 'check'].includes(args[0])) return require('./census_desk').main(args[0], args.slice(1));
  if (args[0] === 'list' || args[0] === 'search') {
    const q = args.slice(1).join(' ').toLowerCase();
    console.log(JSON.stringify(Object.entries(METRICS).filter(([k, v]) => (k + ' ' + JSON.stringify(v)).toLowerCase().includes(q)).map(([id, v]) => ({ id, ...v, dataset: 'acs/acs5' })), null, 2)); return;
  }
  const poverty = args[0] === 'poverty';
  const commandArgs = poverty ? args.slice(1) : args;
  if (poverty && commandArgs.includes('--metric')) throw Error('Poverty has a fixed subset pair');
  const o = options(commandArgs);
  if (poverty) o.product = 'poverty';
  const safeUrl = urlFor(o).toString();
  if (!o.capture) { console.log(JSON.stringify({ mode: 'plan', source_url: safeUrl, network_calls: 0, writes: 0 }, null, 2)); return; }
  console.log(JSON.stringify(await collect(o), null, 2));
}
if (require.main === module) main(process.argv.slice(2)).catch(() => {
  console.error('Census collection failed. No successful baseline reported. Check local configuration, requested dataset and connectivity; credentials hidden.'); process.exitCode = 1;
});
module.exports = { main, collect, METRICS, fieldsFor, options, optionsFromObservation, geography, urlFor, numeric, annotatedNumber, calculationMOE, parse, parsePoverty, povertyProportion, fetchBody, FORMULA_SOURCE, GEOGRAPHY_SOURCE };
