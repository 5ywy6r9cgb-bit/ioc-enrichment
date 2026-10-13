'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const M=require('./context_metrics');
const context={dataset:'acs/acs5',vintage:2024,period_start:2020,period_end:2024,geography:'county',summary_level:'050',geoid:'39049',name:'Fixture County'};
function fixture(values={}) {
  const row={NAME:'Fixture County',state:'39',county:'049'};
  for(const id of Object.keys(M.CATALOG))for(const base of M.variableBases(id))Object.assign(row,{[base+'E']:'100',[base+'M']:'5',[base+'EA']:null,[base+'MA']:null});
  for(const d of Object.values(M.BASELINES))Object.assign(row,{[d.base+'E']:'100',[d.base+'M']:'5',[d.base+'EA']:null,[d.base+'MA']:null});
  return Object.assign(row,values);
}
test('fixed recipes use the appropriate population universes and stay immutable',()=>{
  assert.equal(M.CATALOG.renter_share.denominator[0].base,'B25003_001');
  assert.equal(M.CATALOG.poverty.denominator[0].base,'B17001_001');
  assert.equal(M.CATALOG.bachelors_or_higher.denominator[0].base,'B15003_001');
  assert.equal(M.CATALOG.internet_subscription.denominator[0].base,'B28002_001');
  assert.match(M.CATALOG.renter_share.universe,/Occupied housing units/);
  assert.match(M.CATALOG.bachelors_or_higher.universe,/25 years/);
  assert.throws(()=>{M.CATALOG.poverty.numerator[0].base='B01003_001';});
  assert.throws(()=>M.fieldsFor('arbitrary'));assert.throws(()=>M.deriveMetric('__proto__',{},context));
});
test('requests contain complete annotation families with no duplicates and remain bounded',()=>{
  for(const group of M.requestGroups()) {
    assert.equal(group.fields[0],'NAME');assert.equal(new Set(group.fields).size,group.fields.length);assert.ok(group.fields.length<=49);
    for(const base of M.variableBases(group.metric_id))for(const suffix of ['E','M','EA','MA'])assert.ok(group.fields.includes(base+suffix));
  }
  assert.equal(M.baselineFields().length,17);
});
test('poverty returns percentage points for the subset approximation',()=>{
  const r=M.deriveMetric('poverty',fixture({B17001_001E:'1000',B17001_001M:'20',B17001_002E:'200',B17001_002M:'10'}),context);
  assert.equal(r.percent,20);assert.ok(Math.abs(r.margin_of_error_percentage_points-Math.sqrt(84)/10)<1e-12);
  assert.equal(r.method,'subset_proportion_approximation');assert.equal(r.publication_approved,false);assert.equal(r.provenance_verified,false);
});
test('renter share uses occupied units instead of all housing units',()=>{
  const row=fixture({B25003_001E:'100',B25003_003E:'40',B25001_001E:'200'});
  assert.equal(M.deriveMetric('renter_share',row,context).percent,40);
});
test('rent burden combines disjoint categories, excludes not-computed and propagates both sums',()=>{
  const row=fixture({B25070_001E:'120',B25070_001M:'6',B25070_011E:'20',B25070_011M:'8',B25070_007E:'20',B25070_007M:'6',B25070_008E:'15',B25070_008M:'8',B25070_009E:'10',B25070_009M:'0',B25070_010E:'5',B25070_010M:'0'});
  const r=M.deriveMetric('rent_burden',row,context);
  assert.equal(r.numerator.estimate,50);assert.equal(r.denominator.estimate,100);assert.equal(r.percent,50);
  assert.equal(r.numerator.margin_of_error,10);assert.equal(r.denominator.margin_of_error,10);
  assert.ok(Math.abs(r.margin_of_error_percentage_points-Math.sqrt(75))<1e-12);
  assert.equal(r.excluded_not_computed.estimate,20);assert.match(r.uncertainty_note,/omit covariance/);
});
test('rent burden blocks missing category, invalid subtraction and zero computed universe',()=>{
  for(const values of [{B25070_007E:null},{B25070_011E:'101'},{B25070_011E:'100'}])assert.equal(M.deriveMetric('rent_burden',fixture(values),context).status,'BLOCKED');
});
test('education combines bachelor, master, professional and doctorate without adding associate degree',()=>{
  const r=M.deriveMetric('bachelors_or_higher',fixture({B15003_001E:'1000',B15003_022E:'100',B15003_022M:'3',B15003_023E:'50',B15003_023M:'4',B15003_024E:'30',B15003_024M:'12',B15003_025E:'20',B15003_025M:'0',B15003_021E:'800'}),context);
  assert.equal(r.percent,20);assert.equal(r.numerator.margin_of_error,13);assert.equal(r.numerator.terms.length,4);
});
test('internet subscription never substitutes access or overlapping technology categories',()=>{
  const r=M.deriveMetric('internet_subscription',fixture({B28002_001E:'100',B28002_002E:'70',B28002_012E:'20',B28002_004E:'60',B28002_005E:'50'}),context);
  assert.equal(r.percent,70);assert.equal(r.numerator.terms.length,1);assert.match(r.caution,/not broadband infrastructure/);
});
test('negative radicand uses ratio fallback and does not erase uncertainty',()=>{
  const r=M.deriveMetric('poverty',fixture({B17001_001E:'100',B17001_001M:'20',B17001_002E:'20',B17001_002M:'1'}),context);
  assert.equal(r.method,'ratio_approximation_fallback');assert.ok(Math.abs(r.margin_of_error_percentage_points-Math.sqrt(17))<1e-12);
});
test('zero numerator has a rate and nonzero uncertainty; zero denominator blocks',()=>{
  const r=M.deriveMetric('poverty',fixture({B17001_002E:'0'}),context);
  assert.equal(r.percent,0);assert.equal(r.margin_of_error_percentage_points,5);
  assert.equal(M.deriveMetric('poverty',fixture({B17001_001E:'0',B17001_002E:'0'}),context).status,'BLOCKED');
});
test('unavailable MOEs, suppressed counts, positive bounded estimates and missing annotation fields block',()=>{
  for(const v of [{B17001_002M:null},{B17001_002M:'-222222222',B17001_002MA:'**'},{B17001_002E:'-666666666',B17001_002EA:'-'},{B17001_002E:'100',B17001_002EA:'100+'}]) {
    const r=M.deriveMetric('poverty',fixture(v),context);assert.equal(r.status,'BLOCKED');assert.equal(r.percent,null);
  }
  const row=fixture();delete row.B17001_002EA;assert.equal(M.deriveMetric('poverty',row,context).status,'BLOCKED');
});
test('controlled MOE can be used as zero only with the matched explicit annotation',()=>{
  const row=fixture({B17001_002E:'50',B17001_001M:'-555555555',B17001_001MA:'*****'});
  const r=M.deriveMetric('poverty',row,context);assert.equal(r.denominator.margin_of_error,0);
  assert.equal(r.components.B17001_001.raw.margin_of_error,'-555555555');
  row.B17001_001MA=null;assert.equal(M.deriveMetric('poverty',row,context).status,'BLOCKED');
});
test('wrong vintage, period, dataset or geography fails instead of mixing populations',()=>{
  for(const change of [{vintage:2023},{period_start:2019},{dataset:'acs/acs1'},{geoid:'39129'},{geography:'place'},{geoid:'390490'}]) {
    assert.equal(M.deriveMetric('poverty',fixture(),{...context,...change}).status,'BLOCKED');
  }
  assert.equal(M.deriveMetric('poverty',fixture({county:'129'}),context).status,'BLOCKED');
});
test('invalid numerator above its universe and numeric overflow block',()=>{
  for(const value of ['101','999999999999999999999','NaN','2.3','-1'])assert.equal(M.deriveMetric('poverty',fixture({B17001_002E:value}),context).status,'BLOCKED');
});
test('single-response parser refuses duplicate columns or extra geography rows',()=>{
  const row=fixture({B17001_002E:'50'}),headers=Object.keys(row),values=Object.values(row);
  assert.equal(M.parseAndDerive(Buffer.from(JSON.stringify([headers,values])),'poverty',context).percent,50);
  assert.throws(()=>M.parseAndDerive(JSON.stringify([headers,values,values]),'poverty',context));
  assert.throws(()=>M.parseAndDerive(JSON.stringify([['NAME','NAME'],['x','y']]),'poverty',context));
});
test('profile results stay separate by universe and disclose blocked missing variables',()=>{
  const row=fixture({B17001_002E:'20',B25003_003E:'30',B28002_002E:'80',B15003_022E:'10',B15003_023E:'10',B15003_024E:'10',B15003_025E:'10'});
  const profile=M.deriveProfile(row,context);assert.equal(profile.length,5);
  assert.equal(profile.find(r=>r.metric_id==='poverty').percent,20);
  assert.equal(profile.find(r=>r.metric_id==='bachelors_or_higher').percent,40);
  const sparse=M.deriveProfile({NAME:'Fixture County',state:'39',county:'049'},context);assert.ok(sparse.every(r=>r.status==='BLOCKED'));
});
test('baseline medians retain dollar units and positive annotations block exact values',()=>{
  const row=fixture({B19013_001E:'70000',B19013_001M:'3000'}),income=M.deriveBaselines(row,context).find(r=>r.metric_id==='income');
  assert.equal(income.estimate,70000);assert.equal(income.margin_of_error,3000);assert.equal(income.unit,'2024 inflation-adjusted dollars');assert.match(income.caution,/never sum medians/);
  row.B19013_001EA='250,000+';assert.equal(M.deriveBaselines(row,context).find(r=>r.metric_id==='income').status,'BLOCKED');
});
