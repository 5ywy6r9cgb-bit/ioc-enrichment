#!/usr/bin/env python3
"""Build a self-contained, offline source-sensitive relationship + place + ads explorer.
Stdlib only. Unknown CSV schemas are rejected rather than invented or guessed wildly.
"""
import argparse, csv, hashlib, html, json, math, pathlib, re, sys
from datetime import datetime, timezone

def read_rows(path):
    if not path: return []
    with open(path, encoding='utf-8-sig', newline='') as f:
        return [{str(k or '').strip().lower().replace(' ','_'): (v or '').strip() for k,v in row.items()} for row in csv.DictReader(f)]

def first(row, names):
    for name in names:
        s = row.get(name, '')
        if s: return s
    return ''

def uclean(v):
    v=v.strip()
    if not v: return ''
    if v.startswith('https://') or v.startswith('http://'): return v
    return ''

def identity(v):
    return re.sub(r'\s+', ' ', v.strip())

def parse_edges(rows):
    accepted=[]; errors=[]
    source_keys=('source','from','source_entity','source_name','src','origin','from_entity','entity_a')
    target_keys=('target','to','target_entity','target_name','dst','destination','to_entity','entity_b')
    for i,r in enumerate(rows,2):
        a=identity(first(r,source_keys)); b=identity(first(r,target_keys))
        kind=first(r,('relationship','relation','relationship_type','relation_type','edge_type','type','predicate','verb','label'))
        if not a or not b: errors.append((i,'missing source/target identity')); continue
        if a.casefold()==b.casefold(): errors.append((i,'self-edge excluded')); continue
        if not kind: errors.append((i,'missing relationship type')); continue
        status=first(r,('evidence_tier','evidence_grade','evidence_level','verification','status','grade')) or 'unreviewed'
        url=uclean(first(r,('source_url','document_url','evidence_url','url','filing_url')))
        eid=first(r,('source_id','document_id','evidence_id','filing_id','reference'))
        # Never elevate a co-occurrence to evidence of control or payment.
        accepted.append({'a':a,'b':b,'kind':kind,'grade':status,'url':url,'evidence_id':eid,
                         'as_of':first(r,('as_of','date','filed_at','filing_date')),
                         'amount':first(r,('amount','dollars','total')),
                         'note':first(r,('note','notes','description'))})
    return accepted,errors

def parse_sites(rows):
    accepted=[]; errors=[]
    for i,r in enumerate(rows,2):
        name=identity(first(r,('name','site','place','facility','entity')))
        try:
            lat=float(first(r,('latitude','lat'))); lon=float(first(r,('longitude','lon','lng','long')))
            if not (-90<=lat<=90 and -180<=lon<=180): raise ValueError('out of range')
        except ValueError: errors.append((i,'missing/out-of-range coordinates'));continue
        if not name: errors.append((i,'missing site name'));continue
        accepted.append({'name':name,'lat':lat,'lon':lon,'type':first(r,('site_type','type','category')) or 'site',
                         'url':uclean(first(r,('source_url','document_url','url'))),
                         'evidence_id':first(r,('evidence_id','source_id','parcel_id')),
                         'notes':first(r,('notes','description'))})
    return accepted,errors

def parse_ads(rows):
    accepted=[]; errors=[]
    for i,r in enumerate(rows,2):
        platform=first(r,('platform','source','provider'))
        advertiser=first(r,('advertiser','page_name','committee_name','payer'))
        adid=first(r,('ad_id','id','library_id','file_number'))
        if not platform or not advertiser: errors.append((i,'missing platform or advertiser'));continue
        lo=first(r,('spend_min','spend_lower','spend_low','amount_min'))
        hi=first(r,('spend_max','spend_upper','spend_high','amount_max'))
        accepted.append({'platform':platform,'advertiser':advertiser,'ad_id':adid,
          'spend_min':lo,'spend_max':hi,'currency':first(r,('currency','currency_code')) or 'USD',
          'date_start':first(r,('date_start','ad_delivery_start_time','start_date')),
          'date_end':first(r,('date_end','ad_delivery_stop_time','end_date')),
          'source_url':uclean(first(r,('source_url','ad_snapshot_url','url'))),
          'region':first(r,('region','country','state')),
          'evidence_id':first(r,('evidence_id','source_id')),
          'message':first(r,('message','ad_text','creative_text')),
          'notes':first(r,('notes','disclosure','byline'))})
    return accepted,errors

JS = r'''
const D = window.__ATLAS_DATA__;
const $=id=>document.getElementById(id);const X='http://www.w3.org/2000/svg';
let view='network',term='',kind='all', selected=null, zoom=1;
const trunc=(s,n=72)=>String(s||'').length>n?String(s).slice(0,n-1)+'…':String(s||'');
function el(tag,cls,text){let e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;}
function svg(tag,attrs){let n=document.createElementNS(X,tag);for(let [k,v] of Object.entries(attrs||{})) n.setAttribute(k,String(v));return n;}
function panel(title,body){let p=$('detail');p.replaceChildren(el('h3','',title),el('p','',body));}
function setTab(tab){view=tab; selected=null;document.querySelectorAll('.tab').forEach(e=>e.classList.toggle('active',e.dataset.tab===tab));
 $('network').hidden=tab!=='network';$('sites').hidden=tab!=='sites';$('ads').hidden=tab!=='ads';render();}
function linkLine(parent,label,url){if(!url)return;let a=el('a','',label);a.href=url;a.target='_blank';a.rel='noopener noreferrer';parent.appendChild(a);}
function details(title,items,url){let p=$('detail');p.replaceChildren(el('h3','',title));items.forEach(([a,b])=>{if(!b)return;let t=el('div','field');t.append(el('b','',a),el('span','',String(b)));p.appendChild(t)});linkLine(p,'Open primary reference',url);}
function renderNetwork(){let all=D.edges, q=term.toLowerCase();
 let rows=all.filter(e=>(!q||[e.a,e.b,e.kind,e.grade,e.evidence_id].join(' ').toLowerCase().includes(q)) && (kind==='all'||e.kind===kind));
 let degree={}; rows.forEach(e=>{degree[e.a]=(degree[e.a]||0)+1;degree[e.b]=(degree[e.b]||0)+1});
 let nodes=Object.keys(degree).sort((a,b)=>degree[b]-degree[a]||a.localeCompare(b)).slice(0,160);
 let show=new Set(nodes), edges=rows.filter(e=>show.has(e.a)&&show.has(e.b)).slice(0,350);
 $('stats').textContent=`${rows.length} matching documented rows • ${Object.keys(degree).length} named entities • displaying up to ${nodes.length} nodes and ${edges.length} edges. Counts are source-library counts, not population totals.`;
 let s=$('netcanvas');s.replaceChildren(); let W=1300,H=850; s.setAttribute('viewBox',`0 0 ${W/zoom} ${H/zoom}`);
 let pts={};let N=Math.max(1,nodes.length);
 nodes.forEach((n,i)=>{let a=i*2.399963229728653;let rad=45+Math.sqrt(i/Math.max(N-1,1))*355;pts[n]=[W/2+rad*Math.cos(a),H/2+rad*Math.sin(a)]});
 for(let e of edges){let [x,y]=pts[e.a],[x2,y2]=pts[e.b];let l=svg('line',{x1:x,y1:y,x2:x2,y2:y2,'stroke-width':selected&&(selected===e.a||selected===e.b)?2.2:1,opacity:selected&&(selected!==e.a&&selected!==e.b)?'.1':'.24',stroke:'#8d7e67'});s.appendChild(l);}
 nodes.forEach(n=>{let [x,y]=pts[n],g=svg('g',{'class':'netnode','tabindex':'0'});let near=edges.some(e=>selected&&(e.a===selected&&e.b===n||e.b===selected&&e.a===n));
 let c=svg('circle',{cx:x,cy:y,r:Math.max(4,Math.min(15,3.5+Math.sqrt(degree[n])*1.8)),fill:selected===n?'#bb8440':near?'#8f5e24':'#18263f',opacity:selected&&!near&&selected!==n?'.27':'.85'});
 let txt=svg('text',{x:x+12,y:y-8,'font-size':'12',fill:'#27334b',opacity:selected&&!near&&selected!==n?'.3':'1'});txt.textContent=trunc(n,25);
 g.append(c,txt);g.addEventListener('click',()=>{selected=n;let rowsN=all.filter(e=>e.a===n||e.b===n);
 details(n,[['Relation rows',rowsN.length],['Connections (first 12)',rowsN.slice(0,12).map(e=>`${e.a===n?e.b:e.a}: ${e.kind} [${e.grade}]`).join(' | ')]],rowsN.find(e=>e.url)?.url);renderNetwork()});
 g.addEventListener('keydown',e=>{if(e.key==='Enter'){g.dispatchEvent(new Event('click'))}});s.appendChild(g)});
 if(!selected)panel('Relationship topology','Select a node to review its relationships. A same-name search hit is not a corporate ownership, payment, influence, or conspiracy claim. Each edge retains its original grade and citation.');
}
function renderSites(){let s=$('sitecanvas');s.replaceChildren();let q=term.toLowerCase(), sites=D.sites.filter(e=>[e.name,e.type,e.notes].join(' ').toLowerCase().includes(q));
 $('stats').textContent=`${sites.length} locations with verified coordinates in supplied CSV. Map is a coordinate plot, not elevation/topography or parcel boundaries.`;
 if(!sites.length){panel('Geographic locations','Provide places.csv with latitude/longitude from authoritative sources. No locations have been guessed.');return}
 let lats=sites.map(s=>s.lat),lons=sites.map(s=>s.lon);let amin=Math.min(...lats),amax=Math.max(...lats), bmin=Math.min(...lons),bmax=Math.max(...lons);
 if(amax===amin){amin-=.025;amax+=.025}if(bmax===bmin){bmin-=.025;bmax+=.025}
 let W=1300,H=850,pad=88;
 for(let i=0;i<7;i++){let xx=pad+i*(W-2*pad)/6, yy=pad+i*(H-2*pad)/6;s.append(svg('line',{x1:xx,y1:pad,x2:xx,y2:H-pad,stroke:'#d8d7d2'}),svg('line',{x1:pad,y1:yy,x2:W-pad,y2:yy,stroke:'#d8d7d2'}));}
 sites.forEach(e=>{let x=pad+(e.lon-bmin)/(bmax-bmin)*(W-2*pad),y=H-pad-(e.lat-amin)/(amax-amin)*(H-2*pad);
 let g=svg('g',{class:'netnode',tabindex:'0'});let c=svg('circle',{cx:x,cy:y,r:9,fill:'#b88746',stroke:'#fff','stroke-width':2});let label=svg('text',{x:x+14,y:y-10,'font-size':14,fill:'#18263f'});label.textContent=trunc(e.name,40);g.append(c,label);g.addEventListener('click',()=>details(e.name,[['Type',e.type],['Latitude',e.lat],['Longitude',e.lon],['Evidence ID',e.evidence_id],['Notes',e.notes]],e.url));s.appendChild(g)});
 panel('Geographic topology','Click a site. Only coordinates supplied in your file are plotted. A location does not establish ownership, interconnection, a transmission route, or a shared contractor.');
}
function renderAds(){let t=$('adrows');t.replaceChildren();let q=term.toLowerCase();let ads=D.ads.filter(e=>[e.advertiser,e.platform,e.ad_id,e.region,e.message].join(' ').toLowerCase().includes(q));
 $('stats').textContent=`${ads.length} imported disclosure rows. Meta spend is an interval, not an exact payment. Never add FEC Schedule E and Meta spend as separate dollars without deduplication.`;
 ads.slice(0,400).forEach(e=>{let r=el('tr');[e.platform,e.advertiser,e.ad_id,(e.spend_min||'not reported')+' – '+(e.spend_max||'not reported')+' '+e.currency,e.region,e.date_start].forEach(v=>r.append(el('td','',v)));r.addEventListener('click',()=>details(e.advertiser,[['Source',e.platform],['Ad / file',e.ad_id],['Spend interval',`${e.spend_min}–${e.spend_max} ${e.currency}`],['Delivery',`${e.date_start} to ${e.date_end}`],['Region',e.region],['Message',e.message],['Notes/byline',e.notes],['Evidence ID',e.evidence_id]],e.source_url));t.appendChild(r)});
 if(!ads.length)panel('Advertising sources','Load ads.csv or Meta API normalized output. Keep spend ranges intact; do not infer exact targeted audiences or election coordination.');
}
function render(){if(view==='network')renderNetwork();if(view==='sites')renderSites();if(view==='ads')renderAds();}
document.querySelectorAll('.tab').forEach(t=>t.addEventListener('click',()=>setTab(t.dataset.tab)));
$('search').addEventListener('input',e=>{term=e.target.value.trim();selected=null;render()});
$('reltype').addEventListener('change',e=>{kind=e.target.value;selected=null;render()});
$('zin').addEventListener('click',()=>{zoom=Math.min(2,zoom*1.15);render()});$('zout').addEventListener('click',()=>{zoom=Math.max(.75,zoom/1.15);render()});
Array.from(new Set(D.edges.map(e=>e.kind))).sort().forEach(t=>{let e=el('option','',trunc(t,70));e.value=t;$('reltype').append(e)});
setTab('network');
'''

def make_html(data):
    safe=json.dumps(data,ensure_ascii=False).replace('<','\\u003c').replace('>','\\u003e').replace('&','\\u0026')
    markup='''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sentinel — Evidence Terrain</title><style>
:root{--paper:#f8f7f2;--navy:#172033;--brass:#b88746}*{box-sizing:border-box}body{background:var(--paper);color:var(--navy);font-family:system-ui,-apple-system,sans-serif;margin:0}header{padding:22px 26px;background:#172033;color:white}header .small{letter-spacing:.2em;font-size:12px;text-transform:uppercase;color:#dbc59e}h1{font-family:Georgia,serif;font-size:29px;margin:5px 0}p{line-height:1.55}.wrap{max-width:1600px;margin:auto;padding:18px}.bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:15px}.tab,.ctrl{font:inherit;background:#fff;border:1px solid #d9d6ce;border-radius:9px;padding:10px 13px;color:#18263f;cursor:pointer}.tab.active{background:#172033;color:#fff}input{padding:11px;border:1px solid #d9d6ce;border-radius:9px;min-width:270px;flex:1;max-width:480px}select{max-width:200px}.grid{display:grid;grid-template-columns:minmax(400px,1fr) 315px;gap:16px}.canvas,.detail{background:white;border:1px solid #e6e3dc;border-radius:14px;padding:14px;overflow:auto}.detail{min-height:270px}svg{width:100%;height:auto;min-height:560px;background:linear-gradient(130deg,#fff,#f4f1ea);border-radius:9px}.netnode{cursor:pointer}.netnode:hover circle{stroke:#b88746;stroke-width:3}.field{padding:10px 0;border-bottom:1px solid #eceae6;display:grid;gap:4px;overflow-wrap:anywhere}.field b{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#6c6e76}.field span{font-size:13px}#stats{font-size:13px;color:#646d79;margin-bottom:14px}table{border-collapse:collapse;width:100%;font-size:13px}th{text-align:left;background:#f4f2ed;position:sticky;top:0}th,td{border-bottom:1px solid #eceae6;padding:12px}tr{cursor:pointer}tr:hover{background:#f8f7f2}.tablewrap{max-height:680px;overflow:auto}.footer{font-size:12px;color:#697081;margin:20px 0}@media(max-width:930px){.grid{grid-template-columns:1fr}.canvas{padding:6px}svg{min-height:300px}.wrap{padding:10px}}
</style></head><body><header><div class="small">Evidence before inference · Offline investigation workbench</div><h1>Sentinel Evidence Terrain</h1><div>Relationship topology · Confirmed coordinates · Advertising disclosures</div></header><div class="wrap"><div class="bar"><button class="tab active" data-tab="network">Network</button><button class="tab" data-tab="sites">Geographic Sites</button><button class="tab" data-tab="ads">Ad Ledger</button><input id="search" aria-label="Search records" placeholder="Filter entity, relationship, place or ad..."><select class="ctrl" id="reltype" aria-label="Relationship type"><option value="all">All relationships</option></select><button class="ctrl" id="zin">Zoom +</button><button class="ctrl" id="zout">Zoom −</button></div><div id="stats"></div><div class="grid"><main class="canvas"><div id="network"><svg id="netcanvas" role="img" aria-label="Evidence-backed graph" viewBox="0 0 1300 850"></svg></div><div id="sites" hidden><svg id="sitecanvas" role="img" aria-label="Sites plotted by longitude and latitude" viewBox="0 0 1300 850"></svg></div><div id="ads" hidden><div class="tablewrap"><table><thead><tr><th>Source</th><th>Advertiser</th><th>ID</th><th>Reported spend</th><th>Region</th><th>Start</th></tr></thead><tbody id="adrows"></tbody></table></div></div></main><aside id="detail" class="detail"></aside></div><p class="footer">The graph displays a bounded subset for performance. No location is inferred. Metadata and record names must be matched to underlying primary documents. Generated UTC: __CREATED__. This page requires no server, CDN, login or network access.</p></div><script>window.__ATLAS_DATA__=__DATA__;</script><script>__JS__</script></body></html>'''
    return markup.replace('__DATA__',safe).replace('__JS__',JS).replace('__CREATED__',datetime.now(timezone.utc).isoformat())

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--edges', help='Sentinel edges CSV (requires source, target, relationship)')
    p.add_argument('--sites', help='Verified site coordinates CSV')
    p.add_argument('--ads',help='Platform advertising disclosure CSV')
    p.add_argument('--out',default='sentinel_evidence_terrain.html')
    a=p.parse_args()
    e,err=parse_edges(read_rows(a.edges));s,s_err=parse_sites(read_rows(a.sites));ads,a_err=parse_ads(read_rows(a.ads))
    data={'edges':e,'sites':s,'ads':ads,'limitations':['Search/library counts are not population denominators.','A shared vendor is not evidence of coordination.','FEC reported expenditures and Meta spend intervals are not additive.','No site coordinates have been geocoded or inferred.']}
    out=pathlib.Path(a.out);out.parent.mkdir(parents=True,exist_ok=True);out.write_text(make_html(data),encoding='utf-8')
    report=out.with_suffix('.validation.txt')
    report.write_text(f'Accepted evidence edges: {len(e)}\nRejected edge rows: {len(err)}\nAccepted sites: {len(s)}\nRejected sites: {len(s_err)}\nAccepted ads: {len(ads)}\nRejected ads: {len(a_err)}\nEdge errors (first 100): {err[:100]}\nSite errors (first 100): {s_err[:100]}\nAd errors (first 100): {a_err[:100]}\n',encoding='utf8')
    print(f'Created {out} ({out.stat().st_size:,} bytes). Edges {len(e)}, sites {len(s)}, ads {len(ads)}. Rejects: {len(err)+len(s_err)+len(a_err)}. Validation: {report}')
    if (a.edges and not e) or (a.sites and not s) or (a.ads and not ads):
        print('WARNING: One or more supplied files yielded ZERO accepted rows; inspect column names and .validation.txt',file=sys.stderr)
        return 3
    return 0

if __name__=='__main__': raise SystemExit(main())
