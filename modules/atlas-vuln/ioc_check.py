#!/usr/bin/env python3
"""
IOC Enrichment Tool
Author: Mark Rosenburg - The Sentinel Report
Purpose: Check an IP address against threat intelligence sources
Usage: python3 ioc_check.py <ip_address>
       python3 ioc_check.py <ip_address> <abuseipdb_api_key>
"""

import sys
import json
import urllib.request
import urllib.error
from datetime import datetime


def check_ip_geolocation(ip):
    """
    Query ip-api.com for geolocation and ASN data.
    Free, no API key required.
    """
    url = "http://ip-api.com/json/{}?fields=status,message,country,regionName,city,org,as,isp,hosting,proxy,query".format(ip)
    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            data = json.loads(response.read().decode())
            return data
    except urllib.error.URLError as e:
        return {"error": str(e)}


def check_abuseipdb(ip, api_key):
    """
    Query AbuseIPDB for abuse reports.
    Free API key at abuseipdb.com
    """
    url = "https://api.abuseipdb.com/api/v2/check?ipAddress={}&maxAgeInDays=90&verbose".format(ip)
    req = urllib.request.Request(url)
    req.add_header("Key", api_key)
    req.add_header("Accept", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            data = json.loads(response.read().decode())
            return data.get("data", {})
    except urllib.error.URLError as e:
        return {"error": str(e)}


def format_report(ip, geo_data, abuse_data):
    """
    Print a clean, structured report.
    """
    print("")
    print("=" * 60)
    print("  IOC ENRICHMENT REPORT")
    print("  Generated: {}".format(datetime.now().strftime("%Y-%m-%d %H:%M:%S")))
    print("  Indicator: {}".format(ip))
    print("=" * 60)

    print("")
    print("[ GEOLOCATION & NETWORK ]")
    if "error" in geo_data:
        print("  Error: {}".format(geo_data["error"]))
    else:
        print("  Country   : {}".format(geo_data.get("country", "Unknown")))
        print("  Region    : {}".format(geo_data.get("regionName", "Unknown")))
        print("  City      : {}".format(geo_data.get("city", "Unknown")))
        print("  ISP       : {}".format(geo_data.get("isp", "Unknown")))
        print("  Org       : {}".format(geo_data.get("org", "Unknown")))
        print("  ASN       : {}".format(geo_data.get("as", "Unknown")))
        hosting = geo_data.get("hosting", False)
        proxy = geo_data.get("proxy", False)
        print("  Hosting   : {}".format("YES - datacenter/VPS" if hosting else "No"))
        print("  Proxy     : {}".format("YES" if proxy else "No"))

    print("")
    print("[ ABUSE INTELLIGENCE ]")
    if not abuse_data:
        print("  No API key provided - skipping AbuseIPDB check")
        print("  Get a free key at: https://www.abuseipdb.com/register")
    elif "error" in abuse_data:
        print("  Error: {}".format(abuse_data["error"]))
    else:
        score = abuse_data.get("abuseConfidenceScore", 0)
        reports = abuse_data.get("totalReports", 0)
        last_reported = abuse_data.get("lastReportedAt", "Never")
        domain = abuse_data.get("domain", "Unknown")
        used_tor = abuse_data.get("isTor", False)

        if score >= 75:
            verdict = "HIGH RISK - LIKELY MALICIOUS"
        elif score >= 25:
            verdict = "MEDIUM RISK - INVESTIGATE FURTHER"
        elif score > 0:
            verdict = "LOW RISK - SOME REPORTS"
        else:
            verdict = "CLEAN - NO REPORTS FOUND"

        print("  Verdict        : {}".format(verdict))
        print("  Abuse Score    : {}/100".format(score))
        print("  Total Reports  : {}".format(reports))
        print("  Last Reported  : {}".format(last_reported))
        print("  Domain         : {}".format(domain))
        print("  Tor Exit Node  : {}".format("YES" if used_tor else "No"))

    print("")
    print("[ ANALYST NOTES ]")
    print("  - Verify findings against additional sources before acting")
    print("  - A clean score does not confirm an IP is safe")
    print("  - Hosting/datacenter IPs warrant extra scrutiny in IR")
    print("  - Document this check with timestamp in your case notes")
    print("")
    print("=" * 60)
    print("")


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 ioc_check.py <ip_address> [abuseipdb_api_key]")
        print("Example: python3 ioc_check.py 8.8.8.8")
        print("Example: python3 ioc_check.py 8.8.8.8 YOUR_API_KEY_HERE")
        sys.exit(1)

    ip = sys.argv[1]
    api_key = sys.argv[2] if len(sys.argv) > 2 else None

    print("")
    print("Querying threat intelligence for: {}".format(ip))
    print("Please wait...")

    geo_data = check_ip_geolocation(ip)
    abuse_data = check_abuseipdb(ip, api_key) if api_key else {}

    format_report(ip, geo_data, abuse_data)


if __name__ == "__main__":
    main()
