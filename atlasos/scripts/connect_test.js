#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const ENV = path.join(__dirname, '.env');
const env = {};
if (fs.existsSync(ENV)) {
  for (const line of fs.readFileSync(ENV, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}
function mask(k){ return k ? `${k.slice(0,3)}…${k.slice(-2)} (${k.length} chars)` : null; }
function ping(url, headers){
  return new Promise((resolve)=>{
    let u; try { u = new URL(url); } catch { return resolve({status:0,error:'bad url'}); }
    const req = https.request({method:'GET',hostname:u.hostname,path:u.pathname+u.search,
      headers:Object.assign({'User-Agent':'sentinel-connect-test/1.0',Accept:'application/json'},headers||{}),timeout:20000},
      (res)=>{ res.on('data',()=>{}); res.on('end',()=>resolve({status:res.statusCode})); });
    req.on('timeout',()=>{req.destroy();resolve({status:0,error:'timed out'});});
    req.on('error',(e)=>resolve({status:0,error:e.code||e.message}));
    req.end();
  });
}
function verdict(name,keyPresent,res){
  const ok = res.status>=200 && res.status<300;
  let line;
  if (ok) line = `\x1b[32mCONNECTED (HTTP ${res.status})\x1b[0m`;
  else if (res.status===401||res.status===403) line = `\x1b[31mKEY REJECTED (HTTP ${res.status}) — check for a typo or stray quote\x1b[0m`;
  else if (res.status===0) line = `\x1b[31mno network / ${res.error}\x1b[0m`;
  else line = `\x1b[33mHTTP ${res.status}\x1b[0m`;
  console.log(`  ${name.padEnd(15)} key: ${keyPresent?'\x1b[32mset\x1b[0m':'\x1b[31mMISSING\x1b[0m'}   → ${line}`);
}
(async()=>{
  console.log('\n\x1b[1mConnector key check\x1b[0m');
  console.log(`  reading keys from: ${ENV}\n`);
  const osKey = env.OPENSANCTIONS_API_KEY || '';
  const clKey = env.COURTLISTENER_API_TOKEN || '';
  const osRes = await ping('https://api.opensanctions.org/search/default?q=test&limit=1', osKey?{Authorization:`ApiKey ${osKey}`}:{});
  verdict('OpenSanctions', !!osKey, osRes);
  if (osKey) console.log(`                  (${mask(osKey)})`);
  const clRes = await ping('https://www.courtlistener.com/api/rest/v4/search/?q=test&type=o', clKey?{Authorization:`Token ${clKey}`}:{});
  verdict('CourtListener', !!clKey, clRes);
  if (clKey) console.log(`                  (${mask(clKey)})`);
  console.log('\n  Keys stay in .env on this Mac. Nothing printed but presence.\n');
  if (!osKey && !clKey) console.log('  No keys found in .env. Add OPENSANCTIONS_API_KEY and COURTLISTENER_API_TOKEN lines.\n');
})();
