'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const D=require('./census_desk'),C=require('./census');
const bytes=Buffer.from(JSON.stringify([['NAME','B11001_001E','B11001_001M','B11001_001EA','B11001_001MA','state','county'],['Test','123','4',null,null,'39','049']]));
function fixture(){const o=C.options(['--metric','households']);const obs={...C.parse(bytes,o),capture_path:'fixture',capture_sha256:crypto.createHash('sha256').update(bytes).digest('hex'),source_url:C.urlFor(o).toString()};const con=D.template();for(const k of Object.keys(con.expected))con.expected[k]=obs[k];Object.assign(con,{intended_use:'fixture only',comparability_note:'fixture only',boundary_reviewed:true});return {obs,con};}
test('metadata search reports truncation',()=>{const x=D.search([{id:'a',heading:'housing'},{id:'b',heading:'housing'}],'housing',1);assert.equal(x.matched,2);assert.equal(x.truncated,true);});
test('metadata errors rejected and estimate variables filtered',()=>{assert.throws(()=>D.entries(Buffer.from('{}'),'groups'));const b=Buffer.from(JSON.stringify({variables:{B17001_001E:{label:'Total',concept:'Poverty',group:'B17001'},B17001_001M:{label:'MOE'}}}));assert.equal(D.entries(b,'variables').length,1);});
test('limits and unknown options fail',()=>{assert.throws(()=>D.argumentsFor(['--limit','9999']));assert.throws(()=>D.argumentsFor(['--key','private']));});
test('valid declared context never approves publication',()=>{const {obs,con}=fixture();const x=D.checkObservation(obs,con,()=>bytes);assert.equal(x.ok,true);assert.equal(x.publication_approved,false);});
test('changed estimate blocked even when capture hash matches',()=>{const {obs,con}=fixture();obs.estimate=999;assert.equal(D.checkObservation(obs,con,()=>bytes).ok,false);});
test('wrong county and period blocked',()=>{for(const k of ['geoid','period_start','universe']){const {obs,con}=fixture();con.expected[k]='wrong';assert.equal(D.checkObservation(obs,con,()=>bytes).ok,false);}});
test('incomplete contract and tampered raw capture blocked',()=>{const {obs,con}=fixture();assert.equal(D.checkObservation(obs,D.template(),()=>bytes).ok,false);assert.equal(D.checkObservation(obs,con,()=>Buffer.from('bad')).ok,false);});
test('missing boundary review blocked',()=>{const {obs,con}=fixture();con.boundary_reviewed=false;assert.equal(D.checkObservation(obs,con,()=>bytes).ok,false);});

test('official PR and six-digit table IDs retained',()=>{const x=D.entries(Buffer.from(JSON.stringify({groups:[{name:'B07001PR',description:'PR'},{name:'B992516',description:'Quality'}]})),'groups');assert.equal(x.length,2);});

test('displayed identity and review labels cannot diverge from a captured observation',()=>{
 for(const k of ['name','heading','caution','review_status']) {
  const {obs,con}=fixture();obs[k]='changed';assert.equal(D.checkObservation(obs,con,()=>bytes).ok,false,k);
 }
});
test('catalog cache is bound to the requested table and vintage and bounded regular files',()=>{
 const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sentinel-catalog-test-'));
 try {
  const dir=path.join(root,'captures');fs.mkdirSync(dir);
  const file=path.join(dir,'capture.json');fs.writeFileSync(file,bytes);
  const source='https://api.census.gov/data/2024/acs/acs5/groups.json';
  const stored={source_url:source,capture_path:file,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
  assert.deepEqual(D.cachedBody(stored,root,source),bytes);
  assert.throws(()=>D.cachedBody(stored,root,source.replace('2024','2023')),/source/);
  assert.throws(()=>D.readBounded(dir),/regular file/);
  fs.writeFileSync(file,Buffer.alloc(1024*1024+1));assert.throws(()=>D.readBounded(file),/bounded/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('ambiguous duplicate CLI selectors are rejected',()=>{
 assert.throws(()=>D.argumentsFor(['--year','2023','--year','2024']),/Duplicate/);
 assert.throws(()=>C.options(['--county','049','--county','129']),/Duplicate/);
});
