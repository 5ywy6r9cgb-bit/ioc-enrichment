'use strict';
// Local, bounded county context. Credentials stay in the existing private loader.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const M = require('./context_metrics');
const C = require('./census');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const DEFAULT_COUNTIES = ['041','049','089','129','131','145'];
const SCHEMA = 'sentinel.county-context/1';
const EXPORT_FILES = ['context.json','index.html','BRIEF.md','metrics.csv'];
function options(args) {
  const o = {state:'39',year:'2024',counties:[...DEFAULT_COUNTIES]};
  const seen = new Set();
  for(let i=0;i<args.length;i++) {
    const k=args[i];
    if(!['--state','--year','--counties','--output'].includes(k)||seen.has(k)||!args[i+1]||args[i+1].startsWith('--'))throw Error('Invalid or duplicate option');
    seen.add(k);o[k.slice(2)]=args[++i];
  }
  if(typeof o.counties==='string')o.counties=o.counties.split(',');
  if(o.year!=='2024'||!/^\d{2}$/.test(o.state)||!o.counties.length||o.counties.length>20||o.counties.some(c=>!/^\d{3}$/.test(c))||new Set(o.counties).size!==o.counties.length)throw Error('Use vetted year 2024 and 1–20 unique county FIPS codes');
  o.counties.sort();return o;
}
function requestedFields() {
  return [...new Set([...Object.keys(M.CATALOG).flatMap(id=>M.fieldsFor(id)),...M.baselineFields()])].filter(f=>f!=='NAME');
}
function metadataTables() { return [...new Set([...Object.values(M.CATALOG).map(m=>m.table),...Object.values(M.BASELINES).map(m=>m.table)])]; }
function checkedOptions(o) {
  if(!o||typeof o!=='object')throw Error('Missing options');
  return options(['--state',o.state,'--year',o.year,'--counties',Array.isArray(o.counties)?o.counties.join(','):o.counties,...(o.output?['--output',o.output]:[])]);
}
function validateMetadata(body,table) {
  const variables=JSON.parse(body.toString('utf8')).variables;
  if(!variables||typeof variables!=='object'||Array.isArray(variables)||requestedFields().filter(f=>f.startsWith(table+'_')).some(f=>!variables[f]||typeof variables[f].label!=='string'||!variables[f].label.trim()))throw Error('Requested variables not in official metadata');
}
function queries(o) {
  o=checkedOptions(o);
  const fields=requestedFields(),out=[];
  for(let i=0;i<fields.length;i+=48) {
    const get=['NAME',...fields.slice(i,i+48)];
    const url=new URL('https://api.census.gov/data/2024/acs/acs5');
    url.searchParams.set('get',get.join(','));url.searchParams.set('for','county:'+o.counties.join(','));url.searchParams.set('in','state:'+o.state);
    out.push({fields:get,source_url:url.toString()});
  }
  return out;
}
function parseChunk(body,q,o) {
  const rows=JSON.parse(body.toString('utf8'));
  if(!Array.isArray(rows)||rows.length!==o.counties.length+1||!Array.isArray(rows[0]))throw Error('Incomplete county response');
  const head=rows[0], expected=[...q.fields,'state','county'];
  if(head.some(x=>typeof x!=='string')||new Set(head).size!==head.length||head.length!==expected.length||expected.some(f=>!head.includes(f)))throw Error('Unexpected response columns');
  const out={};
  for(const row of rows.slice(1)) {
    if(!Array.isArray(row)||row.length!==head.length)throw Error('Invalid county row');
    const v=Object.fromEntries(head.map((f,i)=>[f,row[i]]));
    if(v.state!==o.state||!o.counties.includes(v.county)||out[v.county]||typeof v.NAME!=='string'||!v.NAME.trim())throw Error('Geography mismatch or duplicate');
    out[v.county]=v;
  }
  return out;
}
function combine(chunks,o) {
  if(chunks.length!==queries(o).length)throw Error('Missing query batch');
  const out={};
  for(const c of o.counties) {
    out[c]={};
    for(const chunk of chunks) {
      if(!chunk[c])throw Error('Missing county');
      for(const [key,value] of Object.entries(chunk[c])) {
        if(Object.hasOwn(out[c],key)&&out[c][key]!==value)throw Error('Conflicting response identity');
        out[c][key]=value;
      }
    }
  }
  return out;
}
function derive(chunks,o,receipts) {
  const rows=combine(chunks,o);
  return o.counties.map(c=>{
    const row=rows[c], context={dataset:'acs/acs5',vintage:2024,period_start:2020,period_end:2024,geography:'county',summary_level:'050',geoid:o.state+c,name:row.NAME};
    const attach=(metric,fields)=>({...metric,source_receipts:receipts.filter(r=>fields.filter(f=>f!=='NAME').some(f=>r.fields.includes(f))).map(r=>r.capture_file)});
    return {...context,metrics:M.deriveProfile(row,context).map(m=>attach(m,M.fieldsFor(m.metric_id))),baselines:M.deriveBaselines(row,context).map(m=>attach(m,['E','M','EA','MA'].map(s=>M.BASELINES[m.metric_id].base+s)))};
  });
}
function privateWrite(file,value) { fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600}); }
function safeRead(root,relative) {
  if(typeof relative!=='string'||path.isAbsolute(relative)||relative.split(/[\\/]/).includes('..'))throw Error('Invalid receipt path');
  const realRoot=fs.realpathSync(root),file=fs.realpathSync(path.join(root,relative));
  const stat=fs.statSync(file);
  if(!file.startsWith(realRoot+path.sep)||!stat.isFile()||stat.size>2*1024*1024)throw Error('Receipt outside output, not a regular file or too large');
  return fs.readFileSync(file);
}
function verify(root) {
  // A later export failure invalidates earlier successful calculation checks.
  // lstat also catches a dangling failure-marker symlink.
  try { fs.lstatSync(path.join(root,'failure.json')); throw Error('Incomplete collection'); }
  catch(error) { if(error.code!=='ENOENT')throw error; }
  const saved=JSON.parse(safeRead(root,'context.json'));
  if(saved.schema!==SCHEMA||saved.collection_status!=='COMPLETE'||saved.publication_approved!==false||saved.dataset!=='acs/acs5'||saved.vintage!==2024||saved.period_start!==2020||saved.period_end!==2024||saved.review_status!=='unreviewed')throw Error('Invalid context bundle');
  const o=options(['--state',saved.state,'--year',String(saved.vintage),'--counties',saved.counties.join(',')]);
  const qs=queries(o);
  if(!Array.isArray(saved.receipts)||saved.receipts.length!==qs.length)throw Error('Missing receipts');
  const chunks=saved.receipts.map((r,i)=>{
    if(r.source_url!==qs[i].source_url||JSON.stringify(r.fields)!==JSON.stringify(qs[i].fields))throw Error('Receipt query mismatch');
    const body=safeRead(root,r.capture_file);
    if(hash(body)!==r.sha256)throw Error('Capture hash mismatch');
    return parseChunk(body,qs[i],o);
  });
  const profiles=derive(chunks,o,saved.receipts);
  if(JSON.stringify(profiles)!==JSON.stringify(saved.profiles))throw Error('Derived data differs from captures');
  const tables=metadataTables();
  if(!Array.isArray(saved.metadata_receipts)||saved.metadata_receipts.length!==tables.length)throw Error('Missing metadata receipts');
  for(const [i,r] of saved.metadata_receipts.entries()) {
    if(r.source_url!==`https://api.census.gov/data/2024/acs/acs5/groups/${tables[i]}.json`)throw Error('Metadata query mismatch');
    const body=safeRead(root,r.capture_file);
    if(hash(body)!==r.sha256)throw Error('Metadata receipt mismatch');
    validateMetadata(body,tables[i]);
  }
  let exportsVerified=false;
  if(Object.hasOwn(saved,'export_manifest')) {
    if(saved.export_manifest!=='exports.json')throw Error('Unsupported export manifest');
    const manifest=JSON.parse(safeRead(root,saved.export_manifest));
    if(manifest.schema!=='sentinel.context-exports/1'||!Array.isArray(manifest.files)||manifest.files.length!==EXPORT_FILES.length)throw Error('Invalid export manifest');
    for(const [i,entry] of manifest.files.entries()) {
      if(entry.file!==EXPORT_FILES[i]||entry.sha256!==hash(safeRead(root,entry.file)))throw Error('Export integrity mismatch');
    }
    exportsVerified=true;
  }
  return {ok:true,status:'RECOMPUTED_FROM_CAPTURE',counties:profiles.length,metrics:profiles.reduce((n,p)=>n+p.metrics.length,0),exports_verified:exportsVerified,verification_scope:exportsVerified?'data_and_export_hashes':'legacy_data_only',publication_approved:false,note:exportsVerified?'Recomputes captured data and checks export hashes; does not authenticate a rewritten bundle or approve publication.':'Legacy bundle: captured data recomputed; HTML, CSV and brief integrity not verified. Does not approve publication.'};
}
async function collect(o,deps={}) {
  o=checkedOptions(o);
  const registry=deps.registry||require('./registry'), fetchBody=deps.fetchBody||C.fetchBody;
  const key=registry.loadEnv().CENSUS_API_KEY;
  if(typeof key!=='string'||!key||/\s|PASTE_|REPLACE_/i.test(key))throw Error('Census key unavailable');
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const root=path.resolve(o.output||path.join(__dirname,'../../evidence/context',stamp));
  fs.mkdirSync(root,{recursive:false,mode:0o700});
  const evidence=path.join(root,'evidence');fs.mkdirSync(evidence,{mode:0o700});
  const qs=queries(o),receipts=[],chunks=[],metadata=[];
  let phase='data';
  try {
    const record=(q,body,subject)=>{
      if(body.includes(Buffer.from(key)))throw Error('Credential-bearing response refused');
      const rec=registry.recordCapture({connector:'census_context',subject,url:q.source_url,body,evidenceRoot:evidence,ledgerPath:path.join(evidence,'manifests/provenance.jsonl'),tool:'sentinel connect census context collect',extra:{dataset:'acs/acs5',vintage:2024,coverage:'exact requested county set'}});
      fs.chmodSync(rec.capturePath,0o600);
      return {source_url:q.source_url,capture_file:path.relative(root,rec.capturePath),sha256:rec.sha256,fields:q.fields||[],retrieved_at:new Date().toISOString()};
    };
    for(let i=0;i<qs.length;i++) {
      const u=new URL(qs[i].source_url);u.searchParams.set('key',key);
      const body=await fetchBody(u);const receipt=record(qs[i],body,'2024-'+o.state+'-batch-'+i);
      receipts.push(receipt);chunks.push(parseChunk(body,qs[i],o));
    }
    phase='metadata';
    const tables=metadataTables();
    for(const table of tables) {
      const source_url=`https://api.census.gov/data/2024/acs/acs5/groups/${table}.json`;
      const u=new URL(source_url);u.searchParams.set('key',key);
      const body=await fetchBody(u);const receipt=record({source_url},body,table+'-metadata');metadata.push(receipt);
      validateMetadata(body,table);
    }
    phase='derive';
    const profiles=derive(chunks,o,receipts);
    const bundle={schema:SCHEMA,export_manifest:'exports.json',created_at:new Date().toISOString(),dataset:'acs/acs5',vintage:2024,period_start:2020,period_end:2024,state:o.state,counties:o.counties,collection_status:'COMPLETE',coverage:'Only the requested counties and vetted variables. No crime, school administrative outcomes or environmental measurements collected.',publication_approved:false,review_status:'unreviewed',receipts,metadata_receipts:metadata,profiles};
    phase='render';
    const R=deps.report||require('./context_report');
    const exports=[['index.html',R.render(bundle)],['BRIEF.md',R.brief(bundle)],['metrics.csv',R.csv(bundle)]];
    phase='export';
    privateWrite(path.join(root,'context.json'),bundle);
    for(const [name,content] of exports)privateWrite(path.join(root,name),content);
    privateWrite(path.join(root,'exports.json'),{schema:'sentinel.context-exports/1',files:EXPORT_FILES.map(file=>({file,sha256:hash(safeRead(root,file))}))});
    phase='verify';
    const check=verify(root);
    privateWrite(path.join(root,'verification.json'),check);
    return {ok:true,output:root,report:path.join(root,'index.html'),counties:profiles.length,source_captures:receipts.length+metadata.length,verification:check};
  } catch(_) {
    privateWrite(path.join(root,'failure.json'),{ok:false,phase,collection_status:'INCOMPLETE',receipts,metadata_receipts:metadata,message:'Collection or validation failed; no complete report produced. Credentials and upstream error text hidden.'});
    return {ok:false,output:root,phase,collection_status:'INCOMPLETE',message:'Inspect failure.json; credentials hidden. No complete report produced.'};
  }
}
async function main(args) {
  const [action='help',...rest]=args;
  if(action==='help'){console.log('census context list | plan [--counties 041,049,089,129,131,145] | collect --output NEW_DIRECTORY | verify DIRECTORY\nVetted ACS 2020–2024 only; default state Ohio (39). plan/list are offline. collect uses your private Census key.');return;}
  if(action==='list'){if(rest.length)throw Error('Unexpected arguments');console.log(JSON.stringify({dataset:'ACS 2020–2024',baselines:M.BASELINES,metrics:M.CATALOG},null,2));return;}
  if(action==='verify'){if(rest.length!==1)throw Error('Expected output directory');console.log(JSON.stringify(verify(path.resolve(rest[0])),null,2));return;}
  if(!['plan','collect'].includes(action))throw Error('Unknown context command');
  const o=options(rest);
  if(action==='plan'){console.log(JSON.stringify({mode:'plan',state:o.state,counties:o.counties,queries:queries(o),metadata_tables:metadataTables(),network_calls:0,writes:0},null,2));return;}
  if(!o.output)fs.mkdirSync(path.join(__dirname,'../../evidence/context'),{recursive:true,mode:0o700});
  const result=await collect(o);console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;
}
module.exports={options,queries,parseChunk,combine,derive,verify,collect,main,requestedFields,metadataTables,validateMetadata};
if(require.main===module)main(process.argv.slice(2)).catch(()=>{console.error('Context operation failed. Check arguments, output directory and local configuration; credentials hidden.');process.exitCode=1;});
