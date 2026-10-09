'use strict';
// Pure, bounded ACS 2020–2024 calculations; no environment, network or filesystem access.
const METHOD_SOURCE = 'https://www2.census.gov/programs-surveys/acs/tech_docs/accuracy/2024_ACS_Accuracy_Document_Worked_Examples.pdf';
const ANNOTATION_SOURCE = 'https://www.census.gov/data/developers/data-sets/acs-1year/notes-on-acs-estimate-and-annotation-values.html';
const term = (base, coefficient = 1) => ({ base, coefficient });
function freeze(o) { for (const v of Object.values(o)) if (v && typeof v === 'object') freeze(v); return Object.freeze(o); }
const CATALOG = freeze({
  poverty: {
    heading: 'People below poverty level', table: 'B17001', unit: 'persons',
    universe: 'Population for whom poverty status is determined',
    denominator_definition: 'People for whom poverty status is determined; not all residents',
    numerator: [term('B17001_002')], denominator: [term('B17001_001')],
    caution: 'Official poverty measure; not a measure of local living costs or a claim about an individual.'
  },
  renter_share: {
    heading: 'Renter-occupied share of occupied housing units', table: 'B25003', unit: 'housing units',
    universe: 'Occupied housing units', denominator_definition: 'All occupied housing units, including owners and renters; excludes vacant units',
    numerator: [term('B25003_003')], denominator: [term('B25003_001')],
    caution: 'A share of housing units, not a share of residents or all housing units.'
  },
  rent_burden: {
    heading: 'Cash-renting units with computed gross-rent burden of 30% or more', table: 'B25070', unit: 'housing units',
    universe: 'Renter-occupied housing units paying cash rent',
    denominator_definition: 'Cash-renting units whose gross rent as a percentage of household income is computed; excludes the not-computed category',
    numerator: [term('B25070_007'), term('B25070_008'), term('B25070_009'), term('B25070_010')],
    denominator: [term('B25070_001'), term('B25070_011', -1)], excluded: 'B25070_011',
    caution: 'Gross rent includes specified utilities. Does not include no-cash-rent households. Not-computed cases are excluded explicitly. Multi-component MOEs are approximations.'
  },
  internet_subscription: {
    heading: 'Households with an internet subscription', table: 'B28002', unit: 'households',
    universe: 'Households', denominator_definition: 'All households',
    numerator: [term('B28002_002')], denominator: [term('B28002_001')],
    caution: 'Subscription adoption, not broadband infrastructure availability, service speed, reliability or every form of internet access. Includes paid cellular-only subscriptions.'
  },
  bachelors_or_higher: {
    heading: 'People age 25 and over with a bachelor’s degree or higher', table: 'B15003', unit: 'persons',
    universe: 'Population 25 years and over', denominator_definition: 'People age 25 and over; not school enrollment or all residents',
    numerator: [term('B15003_022'), term('B15003_023'), term('B15003_024'), term('B15003_025')],
    denominator: [term('B15003_001')],
    caution: 'Educational attainment of residents age 25+, not school quality, student achievement or school-district enrollment.'
  }
});
const BASELINES = freeze({
  population:{base:'B01003_001',heading:'Total population',unit:'persons',universe:'Total population',table:'B01003'},
  households:{base:'B11001_001',heading:'Total households',unit:'households',universe:'Households',table:'B11001'},
  housing:{base:'B25001_001',heading:'Total housing units',unit:'housing units',universe:'Housing units',table:'B25001'},
  income:{base:'B19013_001',heading:'Median household income',unit:'2024 inflation-adjusted dollars',universe:'Households',table:'B19013',caution:'Median, not a total or an arithmetic mean; never sum medians. A charge divided by this median is a contextual comparison, not the share paid by a typical actual household.'}
});
function baselineFields() { return ['NAME',...Object.values(BASELINES).flatMap(d=>['E','M','EA','MA'].map(s=>d.base+s))]; }
function definition(id) { if (!Object.hasOwn(CATALOG, id)) throw Error('Unsupported context metric'); return CATALOG[id]; }
function variableBases(id) { const d = definition(id); return [...new Set([...d.numerator, ...d.denominator].map(t => t.base))]; }
function fieldsFor(id) { return ['NAME', ...variableBases(id).flatMap(v => ['E', 'M', 'EA', 'MA'].map(s => v + s))]; }
function requestGroups(ids = Object.keys(CATALOG)) { return ids.map(id => ({ metric_id: id, fields: fieldsFor(id) })); }
function count(raw) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const n = Number(raw); return Number.isSafeInteger(n) ? n : null;
}
function readComponent(row, base) {
  const raw = { estimate: row[base+'E'], margin_of_error: row[base+'M'], estimate_annotation: row[base+'EA'], moe_annotation: row[base+'MA'] };
  const available = ['E','M','EA','MA'].every(s => Object.hasOwn(row,base+s));
  const cleanEstimate = raw.estimate_annotation === null || raw.estimate_annotation === '';
  const cleanMOE = raw.moe_annotation === null || raw.moe_annotation === '';
  const controlled = raw.margin_of_error === '-555555555' && raw.moe_annotation === '*****';
  const estimate = available && cleanEstimate ? count(raw.estimate) : null;
  const moe = available ? controlled ? 0 : cleanMOE ? count(raw.margin_of_error) : null : null;
  return { variable:base+'E', moe_variable:base+'M', raw, estimate, margin_of_error:moe,
    status: !available ? 'MISSING_FIELDS' : estimate === null ? 'UNUSABLE_ESTIMATE' : moe === null ? 'UNUSABLE_MOE' : 'USABLE',
    uncertainty_status: controlled ? 'controlled_no_sampling_error' : moe === null ? 'unavailable_or_annotated' : 'published_90_percent_moe' };
}
function combine(terms, components) {
  const unusable = terms.some(t => components[t.base].status !== 'USABLE');
  const result = { terms, estimate: null, margin_of_error: null, uncertainty_method: terms.length === 1 ? 'published_component_moe' : 'root_sum_of_squared_component_moes_approximation', status:'BLOCKED' };
  if (unusable) return result;
  const estimate = terms.reduce((n,t) => n + t.coefficient * components[t.base].estimate,0);
  const moe = Math.sqrt(terms.reduce((n,t) => n + (t.coefficient * components[t.base].margin_of_error) ** 2,0));
  if (!Number.isSafeInteger(estimate) || estimate < 0 || !Number.isFinite(moe)) return result;
  return { ...result, estimate, margin_of_error:moe, status:'USABLE' };
}
function geographicFields(context) {
  const id = context.geoid;
  if (typeof id !== 'string' || !/^\d+$/.test(id)) return null;
  let parts;
  switch(context.geography) {
    case 'county': parts=[['state',2],['county',3]];break;
    case 'place': parts=[['state',2],['place',5]];break;
    case 'tract': parts=[['state',2],['county',3],['tract',6]];break;
    case 'county subdivision': parts=[['state',2],['county',3],['county subdivision',5]];break;
    case 'block group': parts=[['state',2],['county',3],['tract',6],['block group',1]];break;
    case 'school district (unified)': case 'school district (elementary)': case 'school district (secondary)': parts=[['state',2],[context.geography,5]];break;
    default:return null;
  }
  if (parts.reduce((n,[,len])=>n+len,0)!==id.length)return null;
  let offset=0;return Object.fromEntries(parts.map(([field,len])=>{const value=id.slice(offset,offset+len);offset+=len;return [field,value];}));
}
function validateContext(row, context) {
  const reasons=[];
  if (!context || context.dataset!=='acs/acs5' || context.vintage!==2024 || context.period_start!==2020 || context.period_end!==2024) reasons.push('This vetted catalog requires ACS five-year 2020–2024; other vintages must be reviewed separately');
  const geo=context && geographicFields(context);
  if(!geo || Object.entries(geo).some(([field,value])=>row[field]!==value))reasons.push('Response geography does not match the typed context and GEOID');
  if(typeof row.NAME!=='string'||!row.NAME.trim())reasons.push('Missing geography name');
  return reasons;
}
function deriveMetric(id, row, context) {
  const d=definition(id);
  if (!row || typeof row!=='object' || Array.isArray(row)) throw Error('Expected Census row map');
  const reasons=validateContext(row,context), components=Object.fromEntries(variableBases(id).map(v=>[v,readComponent(row,v)]));
  const numerator=combine(d.numerator,components),denominator=combine(d.denominator,components);
  if(numerator.status!=='USABLE'||denominator.status!=='USABLE')reasons.push('One or more estimates, annotations or margins of error are unusable');
  if(denominator.estimate!==null&&denominator.estimate<=0)reasons.push('Denominator must be positive');
  if(numerator.estimate!==null&&denominator.estimate!==null&&numerator.estimate>denominator.estimate)reasons.push('Numerator exceeds the defined subset denominator');
  const base={metric_id:id,heading:d.heading,table:d.table,universe:d.universe,denominator_definition:d.denominator_definition,component_unit:d.unit,unit:'percent',
    dataset:context?.dataset,vintage:context?.vintage,period_start:context?.period_start,period_end:context?.period_end,geography:context?.geography,geoid:context?.geoid,name:row.NAME,
    components,numerator,denominator,caution:d.caution,metadata_source:`https://api.census.gov/data/2024/acs/acs5/groups/${d.table}.html`,
    method_source:METHOD_SOURCE,annotation_source:ANNOTATION_SOURCE,assertion_type:'derived',review_status:'unreviewed',publication_approved:false,provenance_verified:false,
    confidence_level:0.90,calculation_version:'context-metrics/1',
    uncertainty_note:'Approximate sampling uncertainty only. Component sum/difference formulas omit covariance and may over- or underestimate MOE. This calculation does not validate source receipts or justify causal or individual-level conclusions.'};
  if(d.excluded)base.excluded_not_computed=components[d.excluded];
  if(reasons.length)return {...base,status:'BLOCKED',reasons,percent:null,margin_of_error_percentage_points:null};
  const p=numerator.estimate/denominator.estimate;
  const radicand=numerator.margin_of_error**2-p**2*denominator.margin_of_error**2;
  const fallback=radicand<0;
  const moe=Math.sqrt(fallback?numerator.margin_of_error**2+p**2*denominator.margin_of_error**2:radicand)/denominator.estimate;
  if(!Number.isFinite(moe))return {...base,status:'BLOCKED',reasons:['Nonfinite uncertainty calculation'],percent:null,margin_of_error_percentage_points:null};
  return {...base,status:'DERIVED_UNREVIEWED',reasons:[],proportion:p,percent:100*p,margin_of_error_percentage_points:100*moe,
    method:fallback?'ratio_approximation_fallback':'subset_proportion_approximation',
    formula:fallback?'100 * sqrt(MOE_N^2 + (N/D)^2 * MOE_D^2) / D':'100 * sqrt(MOE_N^2 - (N/D)^2 * MOE_D^2) / D'};
}
function parseAndDerive(body,id,context) {
  const rows=JSON.parse(Buffer.isBuffer(body)?body.toString('utf8'):body);
  if(!Array.isArray(rows)||rows.length!==2||!Array.isArray(rows[0])||!Array.isArray(rows[1])||rows[0].length!==rows[1].length||rows[0].some(v=>typeof v!=='string')||new Set(rows[0]).size!==rows[0].length)throw Error('Expected one Census geography row and unique headers');
  return deriveMetric(id,Object.fromEntries(rows[0].map((key,i)=>[key,rows[1][i]])),context);
}
function deriveProfile(row,context,ids=Object.keys(CATALOG)) { return ids.map(id=>deriveMetric(id,row,context)); }
function deriveBaselines(row,context) {
  const contextErrors=validateContext(row,context);
  return Object.entries(BASELINES).map(([id,d])=>{
    const component=readComponent(row,d.base),reasons=[...contextErrors];
    if(component.status!=='USABLE')reasons.push('Estimate or sampling uncertainty is unavailable or annotated');
    return {metric_id:id,heading:d.heading,unit:d.unit,universe:d.universe,table:d.table,
      dataset:context?.dataset,vintage:context?.vintage,period_start:context?.period_start,period_end:context?.period_end,geography:context?.geography,geoid:context?.geoid,name:row.NAME,
      estimate:reasons.length?null:component.estimate,margin_of_error:reasons.length?null:component.margin_of_error,component,reasons,
      status:reasons.length?'BLOCKED':'OBSERVED_UNREVIEWED',assertion_type:'documented',review_status:'unreviewed',publication_approved:false,provenance_verified:false,
      confidence_level:0.90,caution:d.caution||'ACS five-year survey estimate; not a current headcount.',metadata_source:`https://api.census.gov/data/2024/acs/acs5/groups/${d.table}.html`};
  });
}
module.exports={CATALOG,BASELINES,baselineFields,deriveBaselines,variableBases,fieldsFor,requestGroups,deriveMetric,deriveProfile,parseAndDerive,readComponent,METHOD_SOURCE,ANNOTATION_SOURCE};
