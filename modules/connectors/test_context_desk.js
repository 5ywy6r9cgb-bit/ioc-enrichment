'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const D=require('./context_desk'),M=require('./context_metrics');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const key='OFFLINE_FIXTURE_CENSUS_KEY';
const o=()=>D.options(['--counties','049,129']);
function data(q,opts,mutate) {
  const head=[...q.fields,'state','county'];
  const rows=opts.counties.map(c=>{
    const v={NAME:'Fixture County '+c,state:opts.state,county:c};
    for(const f of q.fields)if(f!=='NAME')v[f]=/EA$|MA$/.test(f)?null:/M$/.test(f)?'5':'100';
    for(const base of ['B17001_002','B25003_003','B25070_007','B25070_008','B25070_009','B25070_010','B25070_011','B15003_022','B15003_023','B15003_024','B15003_025'])if(Object.hasOwn(v,base+'E'))v[base+'E']='10';
    return head.map(f=>v[f]);
  });
  const result=[head,...rows];if(mutate)mutate(result);return Buffer.from(JSON.stringify(result));
}
function metadata(table,mutate) {
  const variables=Object.fromEntries(D.requestedFields().filter(f=>f.startsWith(table+'_')).map(f=>[f,{label:'Fixture label for '+f,group:table,predicateType:/EA$|MA$/.test(f)?'string':'int'}]));
  const result={variables};if(mutate)mutate(result);return Buffer.from(JSON.stringify(result));
}
function mockFixture({dataMutation,metadataMutation,fetchFailure,echo=false}={}) {
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'sentinel-context-test-'));
  const opts={...o(),output:path.join(parent,'bundle')};
  const calls=[],captures=[];let seq=0;
  const registry={loadEnv:()=>({CENSUS_API_KEY:key}),recordCapture:r=>{
    captures.push(r);const dir=path.join(r.evidenceRoot,'captures');fs.mkdirSync(dir,{recursive:true});
    const capturePath=path.join(dir,`${++seq}.json`);fs.writeFileSync(capturePath,r.body);
    return {capturePath,sha256:hash(r.body)};
  }};
  const fetchBody=async u=>{
    calls.push(u.toString());
    if(fetchFailure)throw Error('upstream URL contains key='+key);
    if(echo)return Buffer.from(key);
    const table=/\/groups\/(B\d{5})\.json$/.exec(u.pathname);
    if(table)return metadata(table[1],metadataMutation);
    const q=D.queries(opts).find(q=>new URL(q.source_url).searchParams.get('get')===u.searchParams.get('get'));
    assert.ok(q,'Mock only accepts a planned Census request');return data(q,opts,dataMutation);
  };
  const report={render:()=>'<html>offline fixture</html>',brief:()=> 'fixture',csv:()=> 'fixture\n'};
  const cleanup=()=>fs.rmSync(parent,{recursive:true,force:true});
  return {parent,opts,calls,captures,registry,fetchBody,report,cleanup};
}
function allContents(root) {
  return fs.readdirSync(root,{withFileTypes:true}).map(e=>e.isDirectory()?allContents(path.join(root,e.name)):fs.readFileSync(path.join(root,e.name),'utf8')).join('\n');
}
test('planned queries use at most 49 fields, cover all vetted fields and no credentials',()=>{
  const qs=D.queries(o());assert.equal(qs.length,2);
  assert.deepEqual(new Set(qs.flatMap(q=>q.fields).filter(f=>f!=='NAME')),new Set(D.requestedFields()));
  for(const q of qs){assert.ok(q.fields.length<=49);assert.equal(q.fields[0],'NAME');assert.equal(new URL(q.source_url).searchParams.has('key'),false);}
  assert.equal(D.metadataTables().length,9);assert.ok(D.metadataTables().includes('B19013'));
});
test('malformed options, duplicate counties, other vintages and wildcards are rejected',()=>{
  for(const args of [['--year','2023'],['--counties','049,049'],['--counties','*'],['--counties','49'],['--state','3'],['--year','2024','--year','2024'],['--key','secret']])assert.throws(()=>D.options(args));
  assert.throws(()=>D.queries({...o(),year:'2025'}));
});
test('exact geography response checks incomplete, duplicate, extra, foreign and malformed rows',()=>{
  const opts=o(),q=D.queries(opts)[0];assert.equal(Object.keys(D.parseChunk(data(q,opts),q,opts)).length,2);
  for(const mutate of [r=>r.pop(),r=>r.push(r[1]),r=>{r[2]=r[1];},r=>{r[1][r[0].indexOf('state')]='38';},r=>{r[1][r[0].indexOf('county')]='145';},r=>{r[1].pop();},r=>{r[0][1]='NAME';}])assert.throws(()=>D.parseChunk(data(q,opts,mutate),q,opts));
});
test('batch joins reject identity conflicts and missing batches',()=>{
  const opts=o(),qs=D.queries(opts),chunks=qs.map(q=>D.parseChunk(data(q,opts),q,opts));
  chunks[1]['049'].NAME='Different County';assert.throws(()=>D.combine(chunks,opts));
  assert.throws(()=>D.combine(chunks.slice(0,1),opts));
});
test('receipts attach relevant variable families to baselines and derived metrics',()=>{
  const opts=o(),qs=D.queries(opts),chunks=qs.map(q=>D.parseChunk(data(q,opts),q,opts)),receipts=qs.map((q,i)=>({...q,capture_file:'batch'+i}));
  const profile=D.derive(chunks,opts,receipts)[0];
  assert.deepEqual(profile.baselines.find(m=>m.metric_id==='income').source_receipts,['batch1']);
  assert.deepEqual(profile.metrics.find(m=>m.metric_id==='poverty').source_receipts,['batch0']);
  assert.ok(profile.metrics.every(m=>m.source_receipts.length>0));
});
test('complete mock collection saves private captures and recomputes profiles without leaking credentials',async()=>{
  const f=mockFixture();try{
    const result=await D.collect(f.opts,f);assert.equal(result.ok,true);assert.equal(result.source_captures,11);assert.equal(result.counties,2);
    assert.equal(f.calls.length,11);assert.ok(f.calls.every(u=>new URL(u).searchParams.get('key')===key));
    assert.ok(f.captures.every(r=>!r.url.includes(key)));
    const check=D.verify(f.opts.output);assert.equal(check.ok,true);assert.equal(check.metrics,10);assert.equal(check.publication_approved,false);
    assert.equal(check.exports_verified,true);assert.equal(check.verification_scope,'data_and_export_hashes');
    assert.equal(allContents(f.opts.output).includes(key),false);
    assert.equal(fs.statSync(path.join(f.opts.output,'context.json')).mode&0o777,0o600);
    for(const r of f.captures)assert.equal(fs.statSync(path.join(r.evidenceRoot,'captures',String(f.captures.indexOf(r)+1)+'.json')).mode&0o777,0o600);
  }finally{f.cleanup();}
});
test('saved calculations, capture bytes, top-level periods and metadata deletion are all checked',async()=>{
  const f=mockFixture();try{
    assert.equal((await D.collect(f.opts,f)).ok,true);
    const file=path.join(f.opts.output,'context.json'),original=fs.readFileSync(file,'utf8'),saved=JSON.parse(original);
    for(const mutate of [b=>{b.profiles[0].metrics[0].percent=99;},b=>{b.period_start=2019;},b=>{b.dataset='acs/acs1';},b=>{b.metadata_receipts=[];},b=>{b.receipts[0].source_url+='&key=fixture';},b=>{b.receipts[0].capture_file='../outside.json';}]) {
      const b=JSON.parse(original);mutate(b);fs.writeFileSync(file,JSON.stringify(b));assert.throws(()=>D.verify(f.opts.output));
    }
    fs.writeFileSync(file,original);
    const capture=path.join(f.opts.output,saved.receipts[0].capture_file),bytes=fs.readFileSync(capture);fs.writeFileSync(capture,Buffer.from('altered'));assert.throws(()=>D.verify(f.opts.output));fs.writeFileSync(capture,bytes);
    assert.equal(D.verify(f.opts.output).ok,true);
  }finally{f.cleanup();}
});
test('metadata schemas are verified during collection and recomputation',async()=>{
  const f=mockFixture();try{
    await D.collect(f.opts,f);
    const bundlePath=path.join(f.opts.output,'context.json'),bundle=JSON.parse(fs.readFileSync(bundlePath));
    const r=bundle.metadata_receipts[0],capture=path.join(f.opts.output,r.capture_file),body=Buffer.from('{"variables":{}}');
    fs.writeFileSync(capture,body);r.sha256=hash(body);fs.writeFileSync(bundlePath,JSON.stringify(bundle));
    assert.throws(()=>D.verify(f.opts.output));
  }finally{f.cleanup();}
  const bad=mockFixture({metadataMutation:r=>{r.variables={};}});try{
    const result=await D.collect(bad.opts,bad);assert.equal(result.ok,false);assert.equal(result.phase,'metadata');assert.equal(fs.existsSync(path.join(bad.opts.output,'context.json')),false);
  }finally{bad.cleanup();}
});
test('incomplete data creates an explicit failure with no completed report',async()=>{
  const f=mockFixture({dataMutation:r=>r.pop()});try{
    const result=await D.collect(f.opts,f);assert.equal(result.ok,false);assert.equal(result.phase,'data');
    const failure=JSON.parse(fs.readFileSync(path.join(f.opts.output,'failure.json')));assert.equal(failure.collection_status,'INCOMPLETE');assert.equal(failure.receipts.length,1);
    assert.equal(fs.existsSync(path.join(f.opts.output,'context.json')),false);assert.equal(fs.existsSync(path.join(f.opts.output,'index.html')),false);
  }finally{f.cleanup();}
});
test('credential echo and provider exception text never reach saved artifacts',async()=>{
  for(const scenario of [{echo:true},{fetchFailure:true}]){
    const f=mockFixture(scenario);try{
      const result=await D.collect(f.opts,f);assert.equal(result.ok,false);assert.equal(f.captures.length,0);assert.equal(allContents(f.opts.output).includes(key),false);
      assert.equal(JSON.stringify(result).includes(key),false);
    }finally{f.cleanup();}
  }
});
test('programmatic collection validates options before key load, network or writes',async()=>{
  let calls=0;await assert.rejects(()=>D.collect({...o(),year:'2025'},{registry:{loadEnv:()=>{calls++;return {};}}}));assert.equal(calls,0);
});
test('renderer failure is explicit and cannot leave a complete bundle before rendering finishes',async()=>{
  const f=mockFixture();f.report.render=()=>{throw Error('fixture render failure');};try{
    const r=await D.collect(f.opts,f);assert.equal(r.ok,false);assert.equal(r.phase,'render');
    assert.equal(fs.existsSync(path.join(f.opts.output,'context.json')),false);assert.equal(fs.existsSync(path.join(f.opts.output,'index.html')),false);
  }finally{f.cleanup();}
});

test('partial export failure cannot retain a successful verification',async()=>{
  const f=mockFixture();f.report.render=()=>{
    fs.mkdirSync(path.join(f.opts.output,'index.html'));return '<html>fixture</html>';
  };
  try {
    const r=await D.collect(f.opts,f);assert.equal(r.ok,false);assert.equal(r.phase,'export');
    assert.equal(fs.existsSync(path.join(f.opts.output,'verification.json')),false);
    assert.throws(()=>D.verify(f.opts.output),/Incomplete collection/);
  }finally{f.cleanup();}
});
test('every export and context metadata are bound to the manifest',async()=>{
  const f=mockFixture();try {
    await D.collect(f.opts,f);
    for(const name of ['index.html','BRIEF.md','metrics.csv','context.json','exports.json']) {
      const file=path.join(f.opts.output,name),bytes=fs.readFileSync(file);
      const changed=name==='context.json'?JSON.stringify({...JSON.parse(bytes),created_at:'2000-01-01T00:00:00Z'}):'altered';
      fs.writeFileSync(file,changed);assert.throws(()=>D.verify(f.opts.output));fs.writeFileSync(file,bytes);
    }
    fs.unlinkSync(path.join(f.opts.output,'index.html'));assert.throws(()=>D.verify(f.opts.output));
  }finally{f.cleanup();}
});
test('legacy data-only verification is explicit and failure markers always block',async()=>{
  const f=mockFixture();try {
    await D.collect(f.opts,f);
    const file=path.join(f.opts.output,'context.json'),b=JSON.parse(fs.readFileSync(file));
    delete b.export_manifest;fs.writeFileSync(file,JSON.stringify(b));
    const result=D.verify(f.opts.output);assert.equal(result.ok,true);assert.equal(result.exports_verified,false);assert.equal(result.verification_scope,'legacy_data_only');
    fs.writeFileSync(path.join(f.opts.output,'failure.json'),'{}');assert.throws(()=>D.verify(f.opts.output),/Incomplete/);
  }finally{f.cleanup();}
});
test('verification rejects nonregular files and symlink escapes',async()=>{
  const f=mockFixture();try {
    await D.collect(f.opts,f);
    const file=path.join(f.opts.output,'index.html');fs.unlinkSync(file);fs.mkdirSync(file);
    assert.throws(()=>D.verify(f.opts.output),/regular file/);fs.rmdirSync(file);
    const outside=path.join(f.parent,'outside.html');fs.writeFileSync(outside,'fixture');fs.symlinkSync(outside,file);
    assert.throws(()=>D.verify(f.opts.output),/outside output/);
  }finally{f.cleanup();}
});
