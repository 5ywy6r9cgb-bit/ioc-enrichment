# IOC Enrichment Tool

A command-line threat intelligence tool for security analysts.

## What It Does

Takes a suspicious IP address and queries multiple threat intelligence 
sources to determine whether it is known malicious infrastructure.

Returns:
- Country, city, ISP, and ASN
- Whether the IP belongs to a datacenter or hosting provider
- Abuse confidence score (0-100)
- Total abuse reports from the global security community
- Last reported date
- Tor exit node status

## Why It Matters

During an incident, analysts need fast, reliable information about 
suspicious IPs. This tool surfaces that data in seconds from the 
command line — no browser required.

## Usage

```bash
python3 ioc_check.py <ip_address>
python3 ioc_check.py <ip_address> <abuseipdb_api_key>
IOC ENRICHMENT REPORT
Generated: 2026-07-06 21:23:48
Indicator: 91.217.137.44

[ GEOLOCATION & NETWORK ]
Country   : Russia
City      : Moscow
ISP       : Meganet
Org       : Meganet-2003 LLC
Hosting   : No
Proxy     : No

[ ABUSE INTELLIGENCE ]
Verdict        : CLEAN - NO REPORTS FOUND
Abuse Score    : 0/100
Total Reports  : 0
Domain         : mega-net.ru
Data Sources

    •    ip-api.com (geolocation, ASN, hosting detection)
    •    AbuseIPDB (abuse reports, confidence scoring)

Author

Mark Rosenburg — The Sentinel Report
