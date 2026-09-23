import json,sys,urllib.parse,urllib.request,urllib.error,os,time
T=os.environ.get("COURTLISTENER_TOKEN")
if not T: print("NO TOKEN: set -a; source .env; set +a");sys.exit(4)
def g(p,q=None):
    u="https://www.courtlistener.com/api/rest/v4/"+p
    if q: u+="?"+urllib.parse.urlencode(q)
    r=urllib.request.Request(u,headers={"Authorization":"Token "+T,"User-Agent":"TSR/1.0"})
    for a in range(4):
        try:
            with urllib.request.urlopen(r,timeout=60) as x: return json.loads(x.read().decode())
        except urllib.error.HTTPError as e:
            if e.code==429: time.sleep(15*(a+1)); continue
            sys.exit("HTTP %d  %s"%(e.code,u))
        except Exception as e:
            if a==3: sys.exit("%s: %s"%(type(e).__name__,e))
            time.sleep(5)
def show(h):
    ops=h.get("opinions") or []
    print("  %-10s %s"%(h.get("dateFiled") or "?",(h.get("caseName") or "?")[:78]))
    print("     %s | %s | cluster %s | opinions %s"%(
        h.get("court") or "?",h.get("docketNumber") or "?",
        h.get("cluster_id") or h.get("id"),
        ",".join(str(o.get("id")) for o in ops) or "-"))
    print("     https://www.courtlistener.com%s"%(h.get("absolute_url") or ""))
c=sys.argv[1]
if c=="docket":
    q={"q":'docketNumber:"%s"'%sys.argv[2],"type":"o"}
    if len(sys.argv)>3: q["court"]=sys.argv[3]
    d=g("search/",q); hs=d.get("results",[])
    print("DOCKET %s -> %d hit(s)"%(sys.argv[2],len(hs)))
    [show(h) for h in hs]
    if len(hs)!=1: print("  CANNOT VERIFY - need exactly one hit to cite")
elif c=="find":
    q={"q":sys.argv[2],"type":"o","order_by":"dateFiled desc"}
    if len(sys.argv)>3 and sys.argv[3]!="-": q["court"]=sys.argv[3]
    if len(sys.argv)>4: q["filed_after"]=sys.argv[4]
    d=g("search/",q); hs=d.get("results",[])
    print("FIND %s -> %s total, showing %d  [ALL LEADS, NOT FINDINGS]"%(
        sys.argv[2],d.get("count","?"),len(hs)))
    [show(h) for h in hs]
elif c=="cluster":
    d=g("clusters/%s/"%sys.argv[2])
    print("CLUSTER %s"%sys.argv[2])
    print("  %s"%d.get("case_name"))
    print("  filed %s  cites %s"%(d.get("date_filed"),
        ", ".join(x.get("cite","") for x in (d.get("citations") or []))))
    ids=[str(s).rstrip("/").rsplit("/",1)[-1] for s in (d.get("sub_opinions") or [])]
    print("  OPINION IDS (these, not the URL number): %s"%(",".join(ids) or "-"))
elif c=="text":
    d=g("opinions/%s/"%sys.argv[2])
    t=(d.get("plain_text") or d.get("html_with_citations") or
       d.get("html") or d.get("xml_harvard") or "")
    import re; t=re.sub("<[^>]+>","",t)
    need=[a.lower() for a in sys.argv[3:]]
    if not need: print(t[:4000]); sys.exit()
    ls=[l.strip() for l in t.split("\n") if l.strip()]
    hit=0
    for i,l in enumerate(ls):
        if any(n in l.lower() for n in need):
            hit+=1; print("  [%d] %s"%(i," ".join(ls[max(0,i-1):i+2])[:300]))
    print("  %d line(s) mentioning %s"%(hit,need))
else: print("usage: docket|find|cluster|text")
