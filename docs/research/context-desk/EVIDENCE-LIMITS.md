# Context desk source and denominator review

Reviewed October 8, 2026. This is a source inventory and compatibility specification, not a completed collection or a finding about any person or company. See `source_inventory.json` for eight source families and exact reference URLs.

## Build order

1. **Use existing Census access, then import Ohio's public aggregate workbooks.** Pin ACS to 2020–2024 and preserve geography, universe, MOEs and annotations. Ohio's resource page now links 2025–2026 report cards. Import the download's actual headers and IRNs; do not build an assumed API. [Census API key notice](https://content.govdelivery.com/accounts/USCENSUS/bulletins/41aaf23), [Ohio downloads](https://reportcard.education.ohio.gov/home/download).
2. **Add environmental permits and documented compliance context.** ECHO describes public query-only services and recommends bulk files for large pulls. Validate one facility and its permit IDs before expanding. Preserve data-source refresh dates separately from reporting periods. [ECHO services](https://echo.epa.gov/tools/web-services), [source refresh explanations](https://echo.epa.gov/resources/echo-data/about-the-data).
3. **Join public land records to governing agreements.** Start with Franklin's public GIS extracts and Delaware's official GIS links; then county-specific property records. Request executed development/abatement agreements, annual tax-impact reports, school compensation agreements, service agreements and aggregate measured usage. A parcel-name match is only a lead. [Franklin extracts](https://apps.franklincountyauditor.com/GIS_Shapefiles/CurrentExtracts/), [Delaware GIS](https://gis.co.delaware.oh.us/secondary_nav/main-page-links/).

## Rules that prevent misleading charts

| Proposed comparison | Correct basis | Block this shortcut |
|---|---|---|
| Crime rate | Agency ORI, consistent offense unit, reporting months and corresponding population served | Columbus offenses divided by Franklin County population; missing months treated as zero |
| Chronic absence | Ohio's qualifying students and school-year business rules | ACS children as the denominator |
| Adult education | B15003 population age 25+ | Calling adult attainment a school's graduation performance |
| Housing tenure | B25003 occupied units | Dividing renter-occupied units by all housing units |
| Poverty | B17001 population with determined poverty status | Using total population without checking the universe |
| Pollution | Chemical, medium, year, permitted basis and applicable model | Pounds or distance converted into illness claims |
| Utility costs | Customer class, service territory, tariff period, accounts and measured energy/volume | Equating accounts with households, or capacity with consumption |

For 2025–2026 Ohio chronic absence, the official placement rules include a minimum of 100 hours of possible attendance plus placement exceptions. Use the published measure's denominator. Graduation statistics follow adjusted cohorts and can lag the report-card year. [Ohio accountability rules, printed pages 17 and 43](https://education.ohio.gov/getattachment/Topics/Data/Report-Card-Resources/Student-Accountability.pdf.aspx?lang=en-US).

SAIPE's school-district poor-child count divided by its school-age population is expressly **not a true child poverty rate**: the numerator and denominator differ. Resident-area context also differs from enrolled pupils. [Census methodology](https://www.census.gov/programs-surveys/saipe/technical-documentation/methodology/school-districts/overview-school-district.html).

TRI and RSEI support screening questions. RSEI does not establish personal exposure, excess cancer cases or regulatory compliance. Strong follow-up evidence is a permit, monitoring result, enforcement document or site-specific assessment. [EPA RSEI limits](https://www.epa.gov/rsei/learn-about-rsei).

## Unresolved access and coverage

- FBI's current CDE loaded only a JavaScript shell in this review. The official legacy repository mentions api.data.gov keys, but does not verify today's endpoint. Use official downloads until a current API contract and Ohio agency participation are checked. [CDE](https://cde.ucr.cjis.gov/), [monthly release method](https://www.fbi.gov/news/press-releases/fbi-releases-monthly-crime-and-law-enforcement-data).
- EIA API access requires its own free key; downloadable EIA-861 files provide a no-key path. A statewide retail-price series is context, not a Columbus utility bill. [EIA API documentation](https://www.eia.gov/opendata/documentation.php), [annual files](https://www.eia.gov/electricity/data/eia861/).
- No live data harvest, full pagination audit, school workbook import, countywide title review, customer usage collection or full docket review was performed. Sources were reviewed for methods and access; they must not be marked complete or publishable automatically.
