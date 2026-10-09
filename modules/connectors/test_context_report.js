'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const crypto=require('node:crypto');
const M=require('./context_metrics');
const R=require('./context_report');
function bundle() {
 const receipts=[];
 const profiles=['049','089','129'].map((county,i)=>{
  const context={dataset:'acs/acs5',vintage:2024,period_start:2020,period_end:2024,geography:'county',summary_level:'050',geoid:'39'+county,name:'Fixture '+i+' County, Ohio'};
  const row={NAME:context.name,state:'39',county};
  for(const id of Object.keys(M.CATALOG))for(const base of M.variableBases(id))Object.assign(row,{[base+'E']:'100',[base+'M']:'5',[base+'EA']:null,[base+'MA']:null});
  for(const d of Object.values(M.BASELINES))Object.assign(row,{[d.base+'E']:'100',[d.base+'M']:'5',[d.base+'EA']:null,[d.base+'MA']:null});
  Object.assign(row,{B17001_001E:'1000',B17001_002E:String(100+i*30),B25070_001E:'1000',B25070_011E:'100',B25003_001E:'1000',B25003_003E:'300',B28002_001E:'1000',B28002_002E:'700',B15003_001E:'1000'});
  const capture_file='captures/fixture_'+county+'.json';
  receipts.push({source_url:'https://api.census.gov/data/2024/acs/acs5?get=NAME&for=county:'+county+'&in=state:39',capture_file,sha256:crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex')});
  const attach=m=>({...m,source_receipts:[capture_file]});
  return {...context,metrics:M.deriveProfile(row,context).map(attach),baselines:M.deriveBaselines(row,context).map(attach)};
 });
 return {created_at:'2026-10-08T21:00:00Z',dataset:'acs/acs5',vintage:2024,period_start:2020,period_end:2024,profiles,receipts,publication_approved:false};
}
function parts(html) {
 const json=html.match(/<script type="application\/json" id="data">([\s\S]*?)<\/script>/);
 const script=html.match(/<script>([\s\S]*?)<\/script>/);
 assert.ok(json);assert.ok(script);return {json:json[1],script:script[1]};
}
function run(b) {
 const html=R.render(b),p=parts(html),nodes={};
 for(const id of ['data','metric','definition','bars','x','y','scatter','association','county','detail'])nodes[id]={value:'',textContent:'',innerHTML:'',style:{},querySelectorAll:()=>[]};
 nodes.data.textContent=p.json;nodes.metric.value='poverty';nodes.county.value=b.profiles[0]?.geoid||'';
 const context=vm.createContext({document:{getElementById:id=>nodes[id],querySelectorAll:()=>[]},URL,console});
 new vm.Script(p.script).runInContext(context,{timeout:1000});
 return {html,nodes,context,script:p.script};
}
function rows(csv) {return csv.trimEnd().split('\r\n').map(r=>r.slice(1,-1).split('","').map(v=>v.replace(/""/g,'"')));}
test('rendered JavaScript compiles and script-closing payload remains inert data',()=>{
 const b=bundle(),payload='</script><script>globalThis.compromised=true</script><img src=x onerror=alert(1)>';
 b.profiles[0].name=payload;b.profiles[0].geoid='39049" onfocus="alert(1)';
 const r=run(b);
 assert.equal((r.html.match(/<script\b/g)||[]).length,2);
 assert.equal(r.context.compromised,undefined);
 assert.equal(JSON.parse(parts(r.html).json).profiles[0].name,payload);
 assert.ok(!r.nodes.detail.innerHTML.includes('<img'));
 assert.ok(!r.html.includes('value="39049" onfocus='));
 assert.match(r.nodes.detail.innerHTML,/&lt;\/script&gt;/);
});
test('dashboard does not fetch external resources or include external scripts',()=>{
 const {html,script}=run(bundle());
 assert.doesNotMatch(html,/<script\b[^>]*\bsrc=/i);
 assert.doesNotMatch(script,/\b(fetch|XMLHttpRequest|WebSocket|EventSource|importScripts)\s*\(/);
 assert.match(html,/connect-src 'none'/);assert.match(html,/default-src 'none'/);
 assert.doesNotMatch(html,/<(?:iframe|img|link)\b[^>]*(?:src|href)="https?:/i);
});
test('source links show only matched receipts and reject unsafe schemes and paths',()=>{
 const b=bundle(),r=run(b),first=b.receipts[0],other=b.receipts[1];
 assert.ok(r.nodes.detail.innerHTML.includes(first.sha256));assert.ok(!r.nodes.detail.innerHTML.includes(other.sha256));
 assert.match(r.nodes.detail.innerHTML,/href="captures\/fixture_049.json"/);
 assert.match(r.nodes.detail.innerHTML,/href="https:\/\/api.census.gov\/data\/2024\/acs\/acs5/);
 b.receipts[0].source_url='javascript:alert(1)';b.receipts[0].capture_file='../private.json';b.profiles[0].metrics[0].source_receipts=['../private.json'];b.profiles[0].metrics[0].metadata_source='data:text/html,<script>alert(1)</script>';
 const bad=run(b).nodes.detail.innerHTML;
 assert.doesNotMatch(bad,/href="(?:javascript:|data:|\.\.\/)/);assert.match(bad,/href="#"/);
 b.receipts[0].source_url='https://api.census.gov/data/2024/acs/acs5?key=fixture-secret';
 assert.doesNotMatch(run(b).nodes.detail.innerHTML,/href="[^"]*fixture-secret/);
});
test('CSV neutralizes formula cells including whitespace prefixes',()=>{
 for(const name of ['=HYPERLINK("https://example.invalid")','+SUM(1,2)','-1+2','@SUM(A1)','  =1+1','\t=1+1']) {
  const b=bundle();b.profiles[0].name=name;
  const out=R.csv(b);assert.ok(out.includes('"\''+name.replace(/"/g,'""')+'"'));
 }
});
test('CSV and details suppress blocked or missing values without converting them to zero',()=>{
 const b=bundle(),metric=b.profiles[0].metrics[0],baseline=b.profiles[0].baselines[0];
 Object.assign(metric,{status:'BLOCKED',percent:78,margin_of_error_percentage_points:2,reasons:['Suppressed component']});
 Object.assign(baseline,{status:'BLOCKED',estimate:812345,margin_of_error:100});
 const exported=rows(R.csv(b));
 for(const id of ['poverty','population']){const r=exported.find(r=>r[0]==='39049'&&r[4]===id);assert.equal(r[5],'');assert.equal(r[6],'');assert.equal(r[10],'BLOCKED');}
 const report=run(b);assert.match(report.nodes.detail.innerHTML,/Unavailable: Suppressed component/);assert.doesNotMatch(report.nodes.detail.innerHTML,/812,345|78%|Numerator/);
 const m=b.profiles[1].metrics[0];Object.assign(m,{status:'DERIVED_UNREVIEWED',percent:0,margin_of_error_percentage_points:1});
 assert.equal(rows(R.csv(b)).find(r=>r[0]==='39089'&&r[4]==='poverty')[5],'0');
});
test('controls update denominators, sources, county detail and same-measure warning',()=>{
 const b=bundle(),r=run(b);
 r.nodes.metric.value='bachelors_or_higher';r.nodes.metric.onchange();
 assert.match(r.nodes.definition.textContent,/25 and over/);assert.match(r.nodes.detail.innerHTML,/not school quality/);
 r.nodes.county.value='39089';r.nodes.county.onchange();assert.match(r.nodes.detail.innerHTML,/Fixture 1 County/);assert.ok(r.nodes.detail.innerHTML.includes(b.receipts[1].sha256));
 r.nodes.x.value='poverty';r.nodes.y.value='poverty';r.nodes.y.onchange();assert.match(r.nodes.association.innerHTML,/Choose different measures/);
 b.profiles[0].metrics=[];assert.doesNotThrow(()=>run(b));
 b.profiles=[];assert.doesNotThrow(()=>run(b));
});
test('exports preserve universe, period, uncertainty, review status and reference linkage',()=>{
 const b=bundle(),html=R.render(b),out=rows(R.csv(b)),brief=R.brief(b),r=out.find(r=>r[0]==='39049'&&r[4]==='rent_burden');
 assert.equal(r[3],'2020–2024');assert.equal(r[7],'percent');assert.match(r[9],/excludes the not-computed/);assert.equal(r[11],b.receipts[0].capture_file);assert.equal(r[12],'false');
 assert.match(html,/does not propagate sampling error/);assert.match(html,/90% sampling uncertainty/);assert.match(html,/Publication approved: no/);
 assert.match(brief,/approximate 90% sampling margins/);assert.ok(brief.includes(b.receipts[0].sha256));assert.match(brief,/No crime rate is produced/);
 b.profiles[0].name='Injected | cell\n<img src=x>';
 const safe=R.brief(b);assert.match(safe,/Injected \\\| cell &lt;img src=x&gt;/);assert.doesNotMatch(safe,/<img/);
});

test('real evidence paths stay clickable and controlled counts avoid false precision',()=>{
 const b=bundle();
 b.receipts[0].capture_file='evidence/captures/fixture_049.json';
 for(const m of [...b.profiles[0].metrics,...b.profiles[0].baselines])m.source_receipts=['evidence/captures/fixture_049.json'];
 const v=b.profiles[0].baselines[0];v.margin_of_error=0;v.component.uncertainty_status='controlled_no_sampling_error';
 const r=run(b);assert.match(r.nodes.detail.innerHTML,/href="evidence\/captures\/fixture_049.json"/);assert.match(r.nodes.detail.innerHTML,/controlled estimate; sampling MOE not applicable/);
 assert.match(r.nodes.scatter.innerHTML,/axes start at zero; ranges adapt/);
});
