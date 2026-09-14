const {chromium}=require('/Users/connorlove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const out=path.join(__dirname,'results'),b=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 try{
  const p=await b.newPage({viewport:{width:1440,height:1000}}),errors=[];p.on('pageerror',e=>errors.push(e.message));
  await p.goto('http://127.0.0.1:8765/tenant-cache-benchmark-results.html');
  assert.equal(await p.locator('#runs tr').count(),15);assert.equal(await p.locator('#matrix tr').count(),15);assert.equal(await p.locator('#categories tr').count(),3);assert.equal(await p.locator('#controls tr').count(),6);
  const d=JSON.parse(await p.locator('#data').textContent());
  const mapping={memory:'median_peak_mib',time:'matched_median_s',input:'mean_input_tokens',output:'mean_output_tokens',tools:'mean_tool_calls',requests:'mean_model_requests'};
  for(const [m,key] of Object.entries(mapping)){
   await p.selectOption('#metric',m);assert.equal(await p.locator('#chart .chart-row').count(),3);
   for(const [i,h] of ['handwork','opencode','codex'].entries()){
    const v=d.summary[h][key],label=await p.locator('#chart .value').nth(i).textContent();
    assert(label.startsWith(v==null?'Unavailable':Number(v).toLocaleString('en-US',{minimumFractionDigits:1,maximumFractionDigits:1})));
   }
  }
  await p.selectOption('#metric','memory');
  const dl=p.waitForEvent('download');await p.click('#download');const download=await dl;assert.equal(JSON.parse(fs.readFileSync(await download.path())).runs.length,15);
  const links=await p.locator('a[href^="benchmarks/"]').evaluateAll(xs=>xs.map(x=>x.getAttribute('href')));
  for(const link of links)assert(fs.existsSync(path.resolve(__dirname,'../..',link)),link);
  await p.screenshot({path:path.join(out,'report-desktop.png'),fullPage:true});
  await p.setViewportSize({width:390,height:844});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await p.screenshot({path:path.join(out,'report-mobile.png'),fullPage:true});assert.deepEqual(errors,[]);
  const result={passed:true,attempts:15,controls:6,categories:4,metrics:6,evidenceLinks:links.length,mobileOverflow:false,errors};fs.writeFileSync(path.join(out,'report-qa.json'),JSON.stringify(result,null,2));console.log(result);
 }finally{await b.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
