'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const C = require('./census');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const ROOT = path.resolve(__dirname, '../../evidence');
function argumentsFor(args) {
  const o = { year: '2024', refresh: false, terms: [], limit: 20 };
  for (let i=0;i<args.length;i++) {
    const a=args[i];
    if(a==='--refresh') o.refresh=true;
    else if(['--year','--limit','--output'].includes(a)) { if(!args[i+1]||args[i+1].startsWith('--'))throw Error('Missing option'); o[a.slice(2)]=args[++i]; }
    else if(a.startsWith('--'))throw Error('Unknown option');
    else o.terms.push(a);
  }
  if(!/^20\d{2}$/.test(o.year)||Number(o.year)<2009||!/^\d+$/.test(String(o.limit))||+o.limit<1||+o.limit>100)throw Error('Invalid options');
  o.limit=+o.limit;return o;
}
function entries(body, kind) {
  const json=JSON.parse(body.toString('utf8'));
  if(kind==='groups') {
    if(!Array.isArray(json.groups)||!json.groups.length)throw Error('Invalid group catalog');
    return json.groups.map(x=>{if(!/^[BC]\d{5,6}[A-I]?(?:PR)?$/.test(x.name)||typeof x.description!=='string')throw Error('Unexpected group');return {id:x.name,heading:x.description};});
  }
  if(!json.variables||typeof json.variables!=='object'||Array.isArray(json.variables))throw Error('Invalid variable catalog');
  const result=Object.entries(json.variables).filter(([id])=>/^[BC]\d{5,6}[A-I]?(?:PR)?_\d{3}E$/.test(id)).map(([id,v])=>({id,heading:v.label,concept:v.concept,group:v.group,attributes:v.attributes||null,predicate_type:v.predicateType}));
  if(!result.length||result.some(x=>typeof x.heading!=='string'))throw Error('No estimate variables');return result.sort((a,b)=>a.id.localeCompare(b.id));
}
function search(items,query,limit) {
  const words=query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits=items.filter(x=>words.every(w=>JSON.stringify(x).toLowerCase().includes(w))).sort((a,b)=>a.id.localeCompare(b.id));
  return { matched: hits.length, shown: Math.min(limit,hits.length), truncated: hits.length>limit, results:hits.slice(0,limit) };
}
async function catalog(action,args) {
  const o=argumentsFor(args);const root=path.resolve(o.output||ROOT);
  const group=action==='variables'?o.terms.shift():null;
  if(action==='variables'&&!/^[BC]\d{5,6}[A-I]?(?:PR)?$/.test(group||''))throw Error('Expected exact ACS table ID');
  const kind=group?'variables':'groups';
  const source=`https://api.census.gov/data/${o.year}/acs/acs5/${group?'groups/'+group+'.json':'groups.json'}`;
  const cache=path.join(root,'census-catalog',`${o.year}-${group||'groups'}.json`);
  let stored;
  if(o.refresh) {
    const registry=require('./registry');const key=registry.loadEnv().CENSUS_API_KEY;
    if(!key||/\s/.test(key))throw Error('Missing key');
    const u=new URL(source);u.searchParams.set('key',key);
    const body=await C.fetchBody(u);
    if(body.includes(Buffer.from(key)))throw Error('Credential-bearing response');
    entries(body,kind);
    const receipt=registry.recordCapture({connector:'census_metadata',subject:`${o.year}-${group||'groups'}`,url:source,body,evidenceRoot:root,ledgerPath:path.join(root,'manifests/provenance.jsonl'),tool:'sentinel connect census',extra:{dataset:'acs/acs5',vintage:+o.year,metadata_only:true}});
    stored={source_url:source,captured_at:new Date().toISOString(),sha256:receipt.sha256,capture_path:receipt.capturePath};
    fs.mkdirSync(path.dirname(cache),{recursive:true});fs.writeFileSync(cache,JSON.stringify(stored,null,2)+'\n',{mode:0o600});
  } else {
    if(!fs.existsSync(cache)) { console.log(JSON.stringify({ok:false,reason:'No local catalog. Repeat with --refresh to fetch official metadata.',network_calls:0}));process.exitCode=1;return; }
    stored=JSON.parse(fs.readFileSync(cache,'utf8'));
  }
  const capture=fs.realpathSync(stored.capture_path);const allowed=fs.realpathSync(path.join(root,'captures'));
  if(!capture.startsWith(allowed+path.sep))throw Error('Capture outside evidence');
  const body=fs.readFileSync(capture);if(hash(body)!==stored.sha256)throw Error('Metadata hash mismatch');
  console.log(JSON.stringify({dataset:'acs/acs5',vintage:+o.year,group,metadata_only:true,captured_at:stored.captured_at,source_url:stored.source_url,capture_sha256:stored.sha256,...search(entries(body,kind),o.terms.join(' '),o.limit),note:'Discovery metadata only. A matching table does not establish geographic availability or a valid denominator. No automatic variable ingestion.'},null,2));
}
const CONTRACT_FIELDS=['dataset','vintage','period_start','period_end','geography','geoid','variable','unit','universe'];
function template() {
  return {schema:'sentinel.census.denominator/1',expected:Object.fromEntries(CONTRACT_FIELDS.map(k=>[k,null])),intended_use:'',comparability_note:'',boundary_reviewed:false};
}
function checkObservation(obs,contract,readCapture) {
  const errors=[];let derived;
  try {
    if(!obs||obs.dataset!=='acs/acs5'||!Number.isInteger(obs.vintage)||!/^\d+$/.test(obs.geoid))throw Error();
    const metric=Object.keys(C.METRICS).find(k=>C.METRICS[k].code+'E'===obs.variable);
    if(!metric)throw Error();
    const o=C.optionsFromObservation(obs);
    const bytes=readCapture(obs.capture_path);if(hash(bytes)!==obs.capture_sha256)throw Error();
    derived=C.parse(bytes,o);
    for(const k of [...CONTRACT_FIELDS,'estimate','margin_of_error','estimate_raw','margin_of_error_raw','estimate_annotation','moe_annotation'])if(derived[k]!==obs[k])errors.push('observation differs from captured source: '+k);
    // Historical observations predate these fields. When present, they must match.
    for(const k of ['summary_level','geography_reference_date','uncertainty_status'])if(Object.hasOwn(obs,k)&&derived[k]!==obs[k])errors.push('observation differs from captured source: '+k);
    if(obs.source_url!==C.urlFor(o).toString())errors.push('source URL differs from canonical query');
    if(derived.estimate===null||derived.estimate<=0)errors.push('denominator is missing or nonpositive');
    if(metric==='income')errors.push('median income is not an additive population denominator');
  } catch(_){errors.push('capture, schema or geography integrity failed');}
  if(!contract||contract.schema!=='sentinel.census.denominator/1'||!contract.expected)errors.push('missing denominator contract');
  else {
    for(const k of CONTRACT_FIELDS)if(contract.expected[k]===null||contract.expected[k]===undefined||contract.expected[k]===''||!derived||contract.expected[k]!==derived[k])errors.push('required denominator mismatch: '+k);
    for(const k of ['intended_use','comparability_note'])if(typeof contract[k]!=='string'||!contract[k].trim())errors.push('missing '+k);
    if(contract.boundary_reviewed!==true)errors.push('geographic boundary compatibility not reviewed');
  }
  return {ok:errors.length===0,status:errors.length?'BLOCKED':'DECLARED_CONTEXT_MATCH',errors,publication_approved:false,note:'Checks captured values and declared denominator requirements only. Does not validate numerator extraction, statistical uncertainty, geographic boundaries or human review; does not compute or approve a ratio.'};
}
async function main(action,args) {
  if(action==='catalog'||action==='variables')return catalog(action,args);
  if(action==='template'){if(args.length)throw Error('No template arguments');console.log(JSON.stringify(template(),null,2));return;}
  if(args.length!==3||args[1]!=='--against')throw Error('Use check OBSERVATION --against CONTRACT');
  const obs=JSON.parse(fs.readFileSync(args[0],'utf8')),contract=JSON.parse(fs.readFileSync(args[2],'utf8'));
  const allowed=fs.realpathSync(path.join(ROOT,'captures'));
  const result=checkObservation(obs,contract,p=>{const real=fs.realpathSync(p);if(!real.startsWith(allowed+path.sep))throw Error();if(fs.statSync(real).size>1024*1024)throw Error();return fs.readFileSync(real);});
  console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;
}
module.exports={argumentsFor,entries,search,template,checkObservation,main};
