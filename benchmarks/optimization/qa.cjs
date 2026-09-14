const {chromium}=require('/Users/connorlove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const out=path.join(__dirname,'results-final');
 const b=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 try{
  const p=await b.newPage({viewport:{width:1440,height:1000}}),errors=[];p.on('pageerror',e=>errors.push(e.message));
  await p.goto('http://127.0.0.1:8765/handwork-optimization-results.html');
  assert.equal(await p.locator('#updated-comparison').count(),0);
  assert.equal(await p.locator('table').nth(0).locator('tbody tr').count(),6);
  assert.equal(await p.locator('table').nth(1).locator('tbody tr').count(),15);
  const links=await p.locator('a[href]').evaluateAll(xs=>xs.map(x=>x.getAttribute('href')));
  for(const l of links)assert(fs.existsSync(path.resolve(__dirname,'../..',l)),l);
  await p.screenshot({path:path.join(out,'report-desktop.png'),fullPage:true});
  await p.setViewportSize({width:390,height:844});
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await p.screenshot({path:path.join(out,'report-mobile.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,'report-qa.json'),JSON.stringify({passed:true,evidenceLinks:links.length,attempts:15,metrics:6,errors,mobileOverflow:false},null,2));
  console.log('Report checks passed.');
 }finally{await b.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
