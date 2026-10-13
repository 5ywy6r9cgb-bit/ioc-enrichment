'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const C = require('./census');
const D = require('./census_desk');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
function scalar(o, overrides = {}) {
  const code = C.METRICS[o.metric].code;
  const data = { NAME: 'Test geography', [code+'E']: '1000', [code+'M']: '10', [code+'EA']: null, [code+'MA']: null };
  for (const [field, key] of C.geography(o).parts) data[field] = o[key];
  Object.assign(data, overrides);
  return Buffer.from(JSON.stringify([Object.keys(data), Object.values(data)]));
}
function poverty(overrides = {}, opt = {}) {
  const o = { ...C.options([]), product: 'poverty', ...opt };
  const data = { NAME: 'Fixture County', B17001_001E: '1000', B17001_001M: '20', B17001_001EA: null, B17001_001MA: null, B17001_002E: '200', B17001_002M: '10', B17001_002EA: null, B17001_002MA: null, state: '39', county: '049', ...overrides };
  const body = Buffer.from(JSON.stringify([Object.keys(data), Object.values(data)]));
  return { o, body, result: C.parsePoverty(body, o) };
}
for (const spec of [
  { args: ['--subdivision','12345'], type: 'county subdivision', for: 'county subdivision:12345', in: 'state:39 county:049', id: '3904912345', level: '060' },
  { args: ['--county','129','--tract','000100','--block-group','2'], type: 'block group', for: 'block group:2', in: 'state:39 county:129 tract:000100', id: '391290001002', level: '150' },
  { args: ['--school-district','00123','--school-type','unified'], type: 'school district (unified)', for: 'school district (unified):00123', in: 'state:39', id: '3900123', level: '970' },
  { args: ['--school-district','00123','--school-type','elementary'], type: 'school district (elementary)', for: 'school district (elementary):00123', in: 'state:39', id: '3900123', level: '950' },
  { args: ['--school-district','00123','--school-type','secondary'], type: 'school district (secondary)', for: 'school district (secondary):00123', in: 'state:39', id: '3900123', level: '960' }
]) test(`${spec.type} query, geography identity and evidence check agree`, () => {
  const o = C.options(spec.args), url = C.urlFor(o);
  assert.equal(url.searchParams.get('for'), spec.for);
  assert.equal(url.searchParams.get('in'), spec.in);
  const bytes = scalar(o), obs = { ...C.parse(bytes,o), capture_sha256:hash(bytes), capture_path:'fixture', source_url:url.toString() };
  assert.equal(obs.geoid,spec.id); assert.equal(obs.geography,spec.type); assert.equal(obs.summary_level,spec.level);
  assert.equal(obs.geography_reference_date,'2024-01-01');
  assert.equal(C.urlFor(C.optionsFromObservation(obs)).toString(),url.toString());
  const contract=D.template();for(const k of Object.keys(contract.expected))contract.expected[k]=obs[k];
  Object.assign(contract,{intended_use:'fixture only',comparability_note:'matching fixture boundary',boundary_reviewed:true});
  assert.equal(D.checkObservation(obs,contract,()=>bytes).ok,true);
  obs.summary_level='999';assert.equal(D.checkObservation(obs,contract,()=>bytes).ok,false);
});
test('new selectors reject wildcard, wrong length, missing parents and conflicting types', () => {
  for(const args of [ ['--subdivision','*'],['--block-group','*','--tract','000100'],['--block-group','2'],['--school-district','00123'],['--school-type','unified'],['--school-district','123','--school-type','unified'],['--school-district','00123','--school-type','other'],['--subdivision','12345','--place','18000'],['--school-district','00123','--school-type','unified','--tract','000100'] ]) assert.throws(()=>C.options(args));
});
test('geography parser rejects wrong returned county and corrupted GEOID lengths', () => {
  const o=C.options(['--tract','000100','--block-group','2']);
  assert.throws(()=>C.parse(scalar(o,{county:'001'}),o));
  const obs=C.parse(scalar(o),o);obs.geoid+='0';assert.throws(()=>C.optionsFromObservation(obs));
});
test('paired poverty query requests both complete estimate/MOE/annotation families', () => {
  const o={...C.options([]),product:'poverty'};
  assert.equal(C.urlFor(o).searchParams.get('get'),'NAME,B17001_001E,B17001_001M,B17001_001EA,B17001_001MA,B17001_002E,B17001_002M,B17001_002EA,B17001_002MA');
  const x=poverty().result.calculation;
  assert.equal(x.percent,20);assert.equal(x.method,'subset_proportion_approximation');
  assert.ok(Math.abs(x.margin_of_error_percentage_points-Math.sqrt(84)/10)<1e-12);
  assert.equal(x.publication_approved,false);assert.equal(x.confidence_level,0.9);
});
test('negative radicand uses addition and names fallback; it does not clamp MOE to zero', () => {
  const x=poverty({B17001_001E:'100',B17001_002E:'20',B17001_002M:'1'}).result.calculation;
  assert.equal(x.method,'ratio_approximation_fallback');
  assert.ok(Math.abs(x.margin_of_error_percentage_points-Math.sqrt(17))<1e-12);
});
test('zero numerator retains nonzero uncertainty while zero denominator blocks', () => {
  const x=poverty({B17001_002E:'0'}).result.calculation;
  assert.equal(x.percent,0);assert.equal(x.margin_of_error_percentage_points,1);
  assert.equal(poverty({B17001_001E:'0',B17001_002E:'0'}).result.calculation.status,'BLOCKED');
});
test('missing uncertainty, suppressed counts, positive annotated bounds and non-subsets block', () => {
  for(const overrides of [{B17001_002M:null},{B17001_002E:'-666666666',B17001_002EA:'-'},{B17001_002E:'200',B17001_002EA:'200+'},{B17001_002E:'1001'},{B17001_001M:'-222222222',B17001_001MA:'**'}]) {
    const x=poverty(overrides).result.calculation;
    assert.equal(x.status,'BLOCKED');assert.equal(x.percent,null);assert.equal(x.margin_of_error_percentage_points,null);
  }
});
test('only explicit controlled MOE pair becomes zero for calculation; raw sentinel stays intact', () => {
  const x=poverty({B17001_001M:'-555555555',B17001_001MA:'*****'}).result;
  assert.equal(x.denominator.margin_of_error,null);assert.equal(x.denominator.margin_of_error_raw,'-555555555');
  assert.equal(x.calculation.denominator_moe_used,0);assert.equal(x.calculation.denominator_uncertainty_status,'controlled_no_sampling_error');
  assert.equal(poverty({B17001_001M:'-555555555',B17001_001MA:null}).result.calculation.status,'BLOCKED');
});
test('rate helper refuses mixed periods, geography, universes and arbitrary numerator variables', () => {
  for(const [key,value] of [['vintage',2023],['geoid','39001'],['universe','Total population'],['variable','B01003_001E'],['period_start',2019]]) {
    const x=poverty().result;x.numerator[key]=value;
    assert.equal(C.povertyProportion(x.numerator,x.denominator).status,'BLOCKED');
  }
  const x=poverty().result;delete x.numerator.geography;delete x.denominator.geography;
  assert.equal(C.povertyProportion(x.numerator,x.denominator).status,'BLOCKED');
});
test('top-coded median remains raw and is not used as exact number', () => {
  const o=C.options(['--metric','income']);const x=C.parse(scalar(o,{B19013_001E:'250000',B19013_001EA:'250,000+'}),o);
  assert.equal(x.estimate,null);assert.equal(x.estimate_raw,'250000');
});
test('paired malformed responses reject missing fields, duplicate rows and wrong geography', () => {
  const {o,body}=poverty();const rows=JSON.parse(body);rows[0].splice(2,1);rows[1].splice(2,1);
  assert.throws(()=>C.parsePoverty(Buffer.from(JSON.stringify(rows)),o));
  assert.throws(()=>C.parsePoverty(Buffer.from(JSON.stringify([...JSON.parse(body),JSON.parse(body)[1]])),o));
  assert.throws(()=>poverty({state:'38'}));
});
test('programmatic collection returns private file paths and credential-free receipt without logging', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sentinel-census-test-'));
  const {o,body}=poverty();o.output=root;
  const fakeKey='OFFLINE_TEST_ONLY';let receiptInput, calledURL, logCalls=0;
  const oldLog=console.log;console.log=()=>{logCalls++;};
  try {
    const registry={loadEnv:()=>({CENSUS_API_KEY:fakeKey}),recordCapture:r=>{
      receiptInput=r;const capturePath=path.join(root,'fixture.json');fs.writeFileSync(capturePath,r.body);return {capturePath,sha256:hash(r.body)};
    }};
    const result=await C.collect(o,{registry,fetchBody:async url=>{calledURL=url;return body;}});
    assert.equal(calledURL.searchParams.get('key'),fakeKey);
    assert.equal(new URL(receiptInput.url).searchParams.has('key'),false);
    assert.equal(receiptInput.evidenceRoot,root);assert.match(receiptInput.subject,/2024-050-39049-poverty/);
    assert.equal(result.ok,true);assert.equal(result.observation.capture_sha256,hash(body));
    assert.equal(JSON.stringify(result).includes(fakeKey),false);assert.equal(logCalls,0);
    assert.equal(fs.statSync(result.observation_path).mode&0o777,0o600);
    assert.equal(JSON.parse(fs.readFileSync(result.observation_path)).calculation.percent,20);
  } finally {console.log=oldLog;fs.rmSync(root,{recursive:true,force:true});}
});
test('credential-bearing mock response is rejected before any capture', async () => {
  let captures=0;const registry={loadEnv:()=>({CENSUS_API_KEY:'TEST_SECRET'}),recordCapture:()=>{captures++;}};
  await assert.rejects(()=>C.collect(C.options([]),{registry,fetchBody:async()=>Buffer.from('TEST_SECRET')}));
  assert.equal(captures,0);
});
