# Azure learning pilot — proposal only

The user reports $100 in Azure student credits. No Azure resources are created by this update. Deployment requires the user's later approval. The local research desk continues working without Azure.

## Prepare locally now

Keep raw public records, full Census captures and publication review on the Mac. Learn a small set of KQL operations using synthetic data: filter, project, summarize, join and time binning. Define an export schema before sending data to a cloud table. Preserve retrieval time separately from source date and ACS observation period. Use stable identifiers and source hashes.

## First approved cloud experiment

Use one dedicated resource group, one Log Analytics workspace with Sentinel enabled, one small custom table, one Data Collection Rule and one workbook. Send a finite sanitized dataset for a short learning exercise. Use a scoped ingestion identity; prefer managed identity for a future Azure-hosted collector, avoiding long-lived embedded secrets. No need initially for a separate ADX cluster, Event Hub, Power BI license, Azure Maps, Microsoft Graph or continuously running VMs.

The initial question should be demonstrable: did an imported context record preserve its county, vintage, source and uncertainty, and can KQL reproduce the local result? For a later security exercise, join CISA KEV/NVD metadata to an authorized asset inventory with actual software versions. Demographics and lawful political activity must not become threat scores.

## Cost controls to approve first

Check the exact credit expiry, subscription spending limit and eligible products in the account. Keep the credit spending limit enabled. Set an early budget alert (for example $5), but do not treat it as a hard cap. Estimate ingestion, retention, automation and other services separately; avoid optional paid services. Review costs during the experiment. Export results, delete the pilot resource group and verify remaining billable resources when done.

Microsoft's Sentinel trial currently waives the first 10 GB/day of Analytics-plan ingestion and Sentinel analysis for 31 days; it does not make every attached Azure service free. Disabling Sentinel alone does not delete the Log Analytics workspace. Current prices and eligibility must be rechecked immediately before deployment.

Official references, checked October 8, 2026:

- https://learn.microsoft.com/en-us/azure/azure-monitor/logs/logs-ingestion-api-overview
- https://learn.microsoft.com/en-us/azure/sentinel/billing
- https://azure.microsoft.com/en-us/pricing/offers/ms-azr-0170p/
- https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/tutorial-acm-create-budgets
- https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/spending-limit
