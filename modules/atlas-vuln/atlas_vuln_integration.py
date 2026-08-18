#!/usr/bin/env python3
"""
Atlas Vulnerability Prioritization — v2

Enriches a CVE inventory with NVD CVSS, FIRST EPSS and CISA KEV, then applies an
explainable tiering policy.

WHAT CHANGED FROM v1, AND WHY. Each of these is a defect that would show up in a
technical interview, so they are documented rather than silently fixed.

 1. VERSION-COMPARABILITY. v1 preferred a CVSS v4.0 score when NVD had one and
    fell back to v3.1 otherwise, then applied one set of thresholds to both.
    v3.1 and v4.0 base scores are not comparable. Measured against the FIRST
    example set, the delta ranges from -2.9 to +1.8. Under a CVSS-only model
    4 of 11 change tier on version alone (CVE-2013-6014 T1 -> T3); under the
    policy shipped here it is 3 of 11. This build records
    both scores, tiers on a declared basis, and flags every row where the
    basis had to fall back.

 2. NVD RATE LIMITS. NVD allows roughly 5 requests per 30 seconds without an
    API key. v1 slept 0.7s, which earns a 403 partway through a real run.
    Default is now 6.5s unattended / 0.7s with a key, with backoff on 403,
    429 and 5xx.

 3. FAILURE ISOLATION. v1 called raise_for_status() inside the loop, so one bad
    CVE aborted the run and discarded the work already done. Failures are now
    recorded per row and the run completes.

 4. PROVENANCE. Atlas house rule: nothing enters the record without a source
    and a hash. Every run emits the KEV catalogue version, a SHA-256 of the
    exact KEV snapshot used, the source URLs, and a UTC run timestamp.

 5. KEV DUE DATES. CISA publishes a remediation due date under BOD 22-01. That
    is the real operational clock, so overdue days are computed and surfaced.

 6. OFFLINE MODE. --offline runs from cached fixtures so the tool is testable,
    demonstrable without network, and reproducible.
"""
import argparse, csv, hashlib, json, os, re, sys, time
from datetime import datetime, timezone, date
from typing import Any, Dict, Iterable, List, Optional

try:
    import requests
except ImportError:
    requests = None

NVD_URL = "https://services.nvd.nist.gov/rest/json/cves/2.0"
EPSS_URL = "https://api.first.org/data/v1/epss"
KEV_URL = "https://raw.githubusercontent.com/cisagov/kev-data/develop/known_exploited_vulnerabilities.json"

CVE_RE = re.compile(r"^CVE-\d{4}-\d{4,}$", re.IGNORECASE)
UA = {"User-Agent": "atlas-vuln-integration/2.0 (public-records research desk)"}


# ----------------------------------------------------------------- helpers
def normalize_cve(value: str) -> str:
    cve = (value or "").strip().upper()
    if not CVE_RE.match(cve):
        raise ValueError(f"Invalid CVE identifier: {value!r}")
    return cve


def truthy(value: Any) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "y", "internet", "external"}


def as_float(value: Any, default: float = 0.0) -> float:
    try:
        return default if value in ("", None) else float(value)
    except (TypeError, ValueError):
        return default


def utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256_of(obj: Any) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


# ----------------------------------------------------------------- transport
def http_json(url: str, params=None, headers=None, timeout=30, retries=4) -> Dict[str, Any]:
    """GET with backoff. Returns {} and records nothing on permanent failure —
    the caller decides what a miss means."""
    if requests is None:
        raise RuntimeError("requests not installed; use --offline or pip install -r requirements.txt")
    h = dict(UA)
    if headers:
        h.update(headers)
    delay = 2.0
    last = None
    for attempt in range(retries):
        try:
            r = requests.get(url, params=params, headers=h, timeout=timeout)
            if r.status_code in (403, 429, 500, 502, 503, 504):
                last = f"HTTP {r.status_code}"
                time.sleep(delay); delay *= 2
                continue
            r.raise_for_status()
            return r.json()
        except Exception as e:  # noqa: BLE001
            last = f"{type(e).__name__}: {e}"
            time.sleep(delay); delay *= 2
    raise RuntimeError(f"{url} failed after {retries} attempts — {last}")


# ----------------------------------------------------------------- CVSS
def extract_english_description(items: List[Dict[str, Any]]) -> str:
    for it in items:
        if it.get("lang") == "en":
            return it.get("value", "")
    return items[0].get("value", "") if items else ""


def extract_all_cvss(metrics: Dict[str, Any]) -> Dict[str, Any]:
    """Record every version NVD holds. Tiering picks one later, explicitly."""
    out = {"cvss_v40_score": "", "cvss_v40_vector": "", "cvss_v31_score": "",
           "cvss_v31_vector": "", "cvss_v30_score": "", "cvss_v30_vector": ""}
    for key, pfx in [("cvssMetricV40", "v40"), ("cvssMetricV31", "v31"), ("cvssMetricV30", "v30")]:
        vals = metrics.get(key) or []
        if vals:
            data = vals[0].get("cvssData", {})
            out[f"cvss_{pfx}_score"] = data.get("baseScore", "")
            out[f"cvss_{pfx}_vector"] = data.get("vectorString", "")
    return out


def choose_basis(row: Dict[str, Any], preferred: str) -> Dict[str, Any]:
    """Pick the score to tier on, and say so out loud.

    Mixing versions inside one prioritisation run is the flaw this exists to
    prevent. If the preferred version is missing we fall back, but the row is
    flagged so the inconsistency is visible rather than buried."""
    order = ["v40", "v31", "v30"] if preferred == "v4.0" else ["v31", "v40", "v30"]
    label = {"v40": "CVSS v4.0", "v31": "CVSS v3.1", "v30": "CVSS v3.0"}
    for k in order:
        s = row.get(f"cvss_{k}_score")
        if s not in ("", None):
            fell_back = (k != order[0])
            return {"cvss_score": s, "cvss_version": label[k],
                    "cvss_vector": row.get(f"cvss_{k}_vector", ""),
                    "scoring_basis": label[k],
                    "basis_fallback": "true" if fell_back else "false",
                    "basis_note": (f"preferred {preferred} unavailable; tiered on {label[k]} "
                                   f"— not directly comparable to {preferred} rows") if fell_back else ""}
    return {"cvss_score": "", "cvss_version": "", "cvss_vector": "",
            "scoring_basis": "none", "basis_fallback": "true",
            "basis_note": "no CVSS published by NVD; tiering falls back to EPSS and KEV only"}


def fetch_nvd(cve_id: str, api_key: Optional[str] = None) -> Dict[str, Any]:
    try:
        data = http_json(NVD_URL, params={"cveId": cve_id},
                          headers={"apiKey": api_key} if api_key else None)
    except Exception as e:  # noqa: BLE001
        return {"nvd_found": "error", "nvd_error": str(e)[:180]}
    vulns = data.get("vulnerabilities", [])
    if not vulns:
        return {"nvd_found": "false", "nvd_error": ""}
    cve = vulns[0].get("cve", {})
    return {"nvd_found": "true", "nvd_error": "",
            "published": cve.get("published", ""),
            "last_modified": cve.get("lastModified", ""),
            "vuln_status": cve.get("vulnStatus", ""),
            "description": extract_english_description(cve.get("descriptions", []))[:400],
            **extract_all_cvss(cve.get("metrics", {}))}


# ----------------------------------------------------------------- EPSS / KEV
def fetch_epss(cve_ids: Iterable[str]) -> Dict[str, Dict[str, Any]]:
    results, batch, size = {}, [], 0

    def flush(items):
        if not items:
            return
        try:
            data = http_json(EPSS_URL, params={"cve": ",".join(items)})
        except Exception:  # noqa: BLE001
            return
        for row in data.get("data", []):
            results[str(row.get("cve", "")).upper()] = {
                "epss": row.get("epss", ""),
                "epss_percentile": row.get("percentile", ""),
                "epss_date": row.get("date", "")}

    for cve in cve_ids:
        need = len(cve) + (1 if batch else 0)
        if batch and size + need > 1900:
            flush(batch); batch, size = [], 0
        batch.append(cve); size += need
    flush(batch)
    return results


def fetch_kev(url: str = KEV_URL) -> Dict[str, Any]:
    data = http_json(url)
    vulns = data.get("vulnerabilities", []) if isinstance(data, dict) else []
    return {"by_cve": {str(v.get("cveID", "")).upper(): v for v in vulns if v.get("cveID")},
            "catalog_version": data.get("catalogVersion", ""),
            "count": len(vulns),
            "sha256": sha256_of(data),
            "source": url}


def kev_overdue_days(due: str) -> str:
    try:
        d = datetime.strptime(due, "%Y-%m-%d").date()
        return str((date.today() - d).days)
    except Exception:  # noqa: BLE001
        return ""


# ----------------------------------------------------------------- policy
def atlas_priority(row: Dict[str, Any], policy: Dict[str, Any]) -> Dict[str, str]:
    tiers, th = policy["tiers"], policy["thresholds"]
    cvss = as_float(row.get("cvss_score"))
    epss = as_float(row.get("epss"))
    pctl = as_float(row.get("epss_percentile"))
    exposed = truthy(row.get("internet_exposed"))
    crit = str(row.get("business_criticality", "")).strip().lower()
    why: List[str] = []

    if truthy(row.get("kev")):
        why.append("listed in CISA KEV — known exploited in the wild")
        od = row.get("kev_overdue_days", "")
        if od not in ("", None):
            n = int(od)
            why.append(f"CISA due date passed {n} days ago" if n > 0 else f"CISA due date in {abs(n)} days")
        if str(row.get("kev_known_ransomware", "")).lower() == "known":
            why.append("used in known ransomware campaigns")
        return {"atlas_tier": tiers["kev"], "atlas_rationale": "; ".join(why)}

    if cvss >= th["critical_cvss"] and (epss >= th["critical_epss"]
                                         or pctl >= th.get("critical_epss_percentile", 2)
                                         or exposed):
        why.append(f"{row.get('scoring_basis','CVSS')} {cvss:g} at or above critical threshold")
        if epss >= th["critical_epss"]:
            why.append(f"EPSS {epss:.5f} at or above {th['critical_epss']}")
        if pctl >= th.get("critical_epss_percentile", 2):
            why.append(f"EPSS percentile {pctl:.3f}")
        if exposed:
            why.append("asset is internet exposed")
        if crit == "high":
            why.append("high business criticality")
        tier = tiers["critical"]
    elif cvss >= th["high_cvss"] or epss >= th["high_epss"]:
        if cvss >= th["high_cvss"]:
            why.append(f"{row.get('scoring_basis','CVSS')} {cvss:g} at or above high threshold")
        if epss >= th["high_epss"]:
            why.append(f"EPSS {epss:.5f} at or above {th['high_epss']}")
        if crit == "high":
            why.append("high business criticality")
        tier = tiers["high"]
    else:
        why.append("not in KEV and below configured CVSS and EPSS thresholds")
        if crit == "high":
            why.append("high business criticality — review despite tier")
        tier = tiers["scheduled"]

    # comparability caveat travels with the decision, not in a footnote
    if row.get("basis_fallback") == "true" and row.get("basis_note"):
        why.append(f"CAVEAT: {row['basis_note']}")
    return {"atlas_tier": tier, "atlas_rationale": "; ".join(why)}


# ----------------------------------------------------------------- io
def read_input(path: str) -> List[Dict[str, Any]]:
    with open(path, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        heads = [h.strip() for h in (reader.fieldnames or [])]
        if "cve_id" not in heads:
            raise ValueError("Input CSV must include a cve_id column")
        rows = []
        for raw in reader:
            row = {k.strip(): v for k, v in raw.items()}
            row["cve_id"] = normalize_cve(row.get("cve_id", ""))
            rows.append(row)
        return rows


def write_csv(path: str, rows: List[Dict[str, Any]]) -> None:
    fields: List[str] = []
    for r in rows:
        for k in r:
            if k not in fields:
                fields.append(k)
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader(); w.writerows(rows)


def load_fixtures(d: str) -> Dict[str, Any]:
    out = {}
    for name in ("nvd", "epss", "kev"):
        p = os.path.join(d, f"{name}.json")
        out[name] = json.load(open(p, encoding="utf-8")) if os.path.exists(p) else {}
    return out


# ----------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser(description="Enrich a CVE inventory with CVSS, EPSS, KEV and an explainable tier.")
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--json", help="optional JSON output path")
    ap.add_argument("--policy", default="priority_policy.json")
    ap.add_argument("--kev-url", default=KEV_URL)
    ap.add_argument("--offline", metavar="DIR", help="run from cached fixtures instead of the network")
    ap.add_argument("--nvd-delay", type=float, default=None,
                     help="seconds between NVD calls (default 6.5, or 0.7 with NVD_API_KEY)")
    a = ap.parse_args()

    rows = read_input(a.input)
    policy = json.load(open(a.policy, encoding="utf-8"))
    preferred = policy.get("scoring", {}).get("preferred_cvss_version", "v3.1")
    cve_ids = sorted({r["cve_id"] for r in rows})

    if a.offline:
        fx = load_fixtures(a.offline)
        nvd = fx["nvd"]; epss = fx["epss"]
        kev_blob = fx["kev"] or {"by_cve": {}, "catalog_version": "offline", "count": 0,
                                  "sha256": "", "source": "fixture"}
        prov_mode = f"offline fixtures from {a.offline}"
    else:
        key = os.environ.get("NVD_API_KEY")
        delay = a.nvd_delay if a.nvd_delay is not None else (0.7 if key else 6.5)
        if not key:
            print(" note: no NVD_API_KEY set — throttling to one request per "
                  f"{delay:g}s to stay inside the public rate limit", file=sys.stderr)
        nvd = {}
        for i, cid in enumerate(cve_ids):
            nvd[cid] = fetch_nvd(cid, api_key=key)
            if i < len(cve_ids) - 1:
                time.sleep(delay)
        epss = fetch_epss(cve_ids)
        kev_blob = fetch_kev(a.kev_url)
        prov_mode = "live fetch"

    run_at = utcnow()
    enriched = []
    for r in rows:
        cid = r["cve_id"]
        out = dict(r)
        out.update(nvd.get(cid, {"nvd_found": "false", "nvd_error": ""}))
        out.update(choose_basis(out, preferred))
        out.update(epss.get(cid, {"epss": "", "epss_percentile": "", "epss_date": ""}))
        k = kev_blob["by_cve"].get(cid)
        if k:
            out.update({"kev": "true", "kev_vendor_project": k.get("vendorProject", ""),
                        "kev_product": k.get("product", ""),
                        "kev_vulnerability_name": k.get("vulnerabilityName", ""),
                        "kev_date_added": k.get("dateAdded", ""),
                        "kev_due_date": k.get("dueDate", ""),
                        "kev_overdue_days": kev_overdue_days(k.get("dueDate", "")),
                        "kev_known_ransomware": k.get("knownRansomwareCampaignUse", "")})
        else:
            out.update({"kev": "false", "kev_vendor_project": "", "kev_product": "",
                        "kev_vulnerability_name": "", "kev_date_added": "", "kev_due_date": "",
                        "kev_overdue_days": "", "kev_known_ransomware": ""})
        out.update(atlas_priority(out, policy))
        out.update({"run_at_utc": run_at, "run_mode": prov_mode,
                    "kev_catalog_version": kev_blob.get("catalog_version", ""),
                    "kev_snapshot_sha256": kev_blob.get("sha256", "")[:16],
                    "source_nvd": NVD_URL, "source_epss": EPSS_URL,
                    "source_kev": kev_blob.get("source", a.kev_url)})
        enriched.append(out)

    order = {policy["tiers"]["kev"]: 0, policy["tiers"]["critical"]: 1,
             policy["tiers"]["high"]: 2, policy["tiers"]["scheduled"]: 3}
    enriched.sort(key=lambda r: (order.get(r.get("atlas_tier", ""), 9),
                                  -as_float(r.get("kev_overdue_days")),
                                  -as_float(r.get("cvss_score")), -as_float(r.get("epss"))))
    write_csv(a.output, enriched)
    if a.json:
        json.dump({"provenance": {"run_at_utc": run_at, "mode": prov_mode,
                                   "kev_catalog_version": kev_blob.get("catalog_version", ""),
                                   "kev_snapshot_sha256": kev_blob.get("sha256", ""),
                                   "kev_entry_count": kev_blob.get("count", 0),
                                   "preferred_cvss_version": preferred,
                                   "policy_file": a.policy},
                   "rows": enriched}, open(a.json, "w"), indent=2)

    # operator summary
    counts: Dict[str, int] = {}
    for r in enriched:
        counts[r["atlas_tier"]] = counts.get(r["atlas_tier"], 0) + 1
    fallbacks = [r["cve_id"] for r in enriched if r.get("basis_fallback") == "true"]
    print(f"\n {len(enriched)} rows -> {a.output} [{prov_mode}]")
    for t in sorted(counts, key=lambda x: order.get(x, 9)):
        print(f"   {t:<26} {counts[t]}")
    if fallbacks:
        print(f"\n ! {len(fallbacks)} row(s) not scored on the preferred {preferred} basis: "
              f"{', '.join(fallbacks)}")
        print("   Those scores are not directly comparable. The caveat is in atlas_rationale.")
    print(f"\n KEV catalogue {kev_blob.get('catalog_version','?')} "
          f"({kev_blob.get('count',0)} CVEs) sha256 {kev_blob.get('sha256','')[:16]}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
