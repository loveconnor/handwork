import fs from 'node:fs';
import path from 'node:path';
const results=path.resolve(process.argv[2]);
const site=path.resolve(process.argv[3]);
const summary=JSON.parse(fs.readFileSync(path.join(results,'summary.json')));
const records=JSON.parse(fs.readFileSync(path.join(results,'attempts.json')));
if(records.length!==45 || Object.values(summary).some(group=>Object.values(group).some(v=>v.attempts!==5))) throw Error('Incomplete series');
const read=p=>fs.readFileSync(path.join(site,p),'utf8');
const write=(p,s)=>fs.writeFileSync(path.join(site,p),s);
const keys=['fixes','time','toolCalls','inputTokens','outputTokens','rss'];
const tasks={search:'search',pagination:'pagination',cache:'tenant-cache'};
const labels={search:'Async search',pagination:'Pagination',cache:'Authorization and cache isolation'};
const datasets=Object.fromEntries(Object.entries(tasks).map(([key,task])=>[key,{label:labels[key],attempts:5,budget:600,build:'ReleaseFast',values:['handwork','opencode','codex'].map(agent=>{
 const v=summary[task][agent];
 if(Object.values(v).some(x=>x===null)) throw Error('Unavailable metric requires explicit display handling');
 return {attempts:v.attempts,fixes:v.successes,time:v.median_success_seconds,toolCalls:v.mean_tool_calls,inputTokens:v.mean_input_tokens,outputTokens:v.mean_output_tokens,rss:v.median_peak_mib};
}),note:'Five fresh attempts per agent under the same model, task, and time limit. These small samples do not establish a general ranking.'}]));
function formatted(a){return {fixes:`${a.fixes} / ${a.attempts}`,time:`${a.time.toFixed(1)} s`,toolCalls:a.toolCalls.toFixed(1),inputTokens:Math.round(a.inputTokens).toLocaleString('en-US'),outputTokens:Math.round(a.outputTokens).toLocaleString('en-US'),rss:`${a.rss.toFixed(1)} MiB`};}
let js=read('public/app.js').replace(/const datasets = \{[\s\S]*?\n\};/,`const datasets = ${JSON.stringify(datasets,null,2)};`);
js=js.replace(/document.querySelector\('#benchmark-budget'\).textContent = [^\n]+/,"document.querySelector('#benchmark-budget').textContent = `${data.attempts} attempts per agent, ${data.budget} second limit per attempt`;");
js=js.replace(/document.querySelector\('#benchmark-source'\).href = .*?;/,"document.querySelector('#benchmark-source').href = '/benchmarks/fair-comparison/REPORT.md';");
write('public/app.js',js);
let html=read('src/index.html');
html=html.replace('Latest Handwork results for three coding tasks, alongside earlier competitor results. Each attempt used a fresh workspace and independent verification.','Five fresh attempts per agent on each of three coding tasks. All three agents used the same model, time limit, task prompts, and independent checks.');
html=html.replace(/(<span id="benchmark-budget">)[^<]+/,(_,prefix)=>prefix+'5 attempts per agent, 600 second limit per attempt');
const data=datasets.search;
html=html.replace(/(<tbody id="benchmark-rows">)([\s\S]*?)(<\/tbody>)/,(_,open,body,close)=>{
 let index=0;
 return open+body.replace(/<tr\b[\s\S]*?<\/tr>/g,row=>{
  const a=data.values[index++],f=formatted(a);
  for(const key of keys){
   const max=Math.max(...data.values.map(v=>v[key]));
   const scale=key==='fixes'?a.fixes/a.attempts:a[key]/max;
   const re=new RegExp('(data-metric="'+key+'"[^\\n]*?--bar-scale:)[^";]+("[^\\n]*?class="metric-value">)[^<]+');
   row=row.replace(re,(_,before,middle)=>before+Number(scale.toFixed(6))+middle+f[key]);
  }
  return row;
 })+close;
});
html=html.replace(/(<p id="benchmark-result"[^>]*>)[^<]+/,(_,p)=>p+data.note);
html=html.replace(/<p>Handwork uses the latest harness-efficiency candidate:[\s\S]*?<\/p>/,'<p>Handwork, OpenCode, and Codex were rerun in the same series: five attempts per agent per task, with a 600 second limit. Agent order rotated across rounds and tasks. Every scored attempt is included; failures are not replaced.</p>');
html=html.replace('Time includes model inference, network requests, and tool execution.', 'Time is the median of successful attempts, including model inference, network requests, and tool execution. Token and tool-call means include every attempt.');
html=html.replace('Tool calls count native invocations, and one shell invocation can run multiple commands.','Tool-call definitions differ between agents; a shell or code-mode call can run multiple operations. Harness instructions and tools differ: Handwork inherits personal context, Codex ignores user rules, and OpenCode runs in pure mode.');
html=html.replace(/(<a id="benchmark-source"[^>]*href=")[^"]+("[^>]*>)[^<]+/,(_,a,b)=>a+'/benchmarks/fair-comparison/REPORT.md'+b+'Read the fresh comparison report ');
html=html.replace(/    <p><a class="text-link" href="\/benchmarks\/harness-efficiency\/REPORT.md">.*?<\/p>/,'    <p><a href="/benchmarks/fair-comparison/summary.json">Download the results for all three tasks</a></p>');
write('src/index.html',html);
const destination=path.join(site,'public/benchmarks/fair-comparison');fs.mkdirSync(destination,{recursive:true});
for(const name of ['REPORT.md','summary.json'])fs.copyFileSync(path.join(results,name),path.join(destination,name));
let test=read('tests/browser.mjs');
const options={pagination:'Pagination',cache:'Authorization and cache',search:'Async search'};
for(const [key,option] of Object.entries(options)){
 const f=formatted(datasets[key].values[0]);
 const row=[option,f.time,f.toolCalls,f.inputTokens,f.outputTokens,f.rss,'5 attempts','fair-comparison'];
 test=test.replace(new RegExp("\\['"+option+"', [^\\n]+\\]"),JSON.stringify(row));
}
test=test.replace("assert.deepEqual(metricScales.fixes, [1, 1, 1], 'All successful attempts show full completion bars regardless of sample count');",`assert.deepEqual(metricScales.fixes, ${JSON.stringify(Object.fromEntries(Object.entries(options).map(([k,v])=>[v,datasets[k].values.map(a=>a.fixes/a.attempts)])))}[option], 'Completion bars show the measured pass rates');`);
test=test.replace(/(staticPage.locator\('table'\).textContent\(\)\)\.includes\(')[^']+(MiB'\)\))/,(_,a)=>a+formatted(data.values[0]).rss+"'))");
write('tests/browser.mjs',test);
let unit=read('tests/site.test.mjs');
unit=unit.replace(/for \(const value of \['44\.2 s', '23\.6 MiB', '79\.9 s', '757\.2 MiB', '32\.9 s', '227\.5 MiB', 'frozen builds', 'do not rank agents'\]/,'for (const value of '+JSON.stringify([...data.values.flatMap(a=>[formatted(a).time,formatted(a).rss]),'frozen builds','do not rank agents']));
write('tests/site.test.mjs',unit);
let readme=read('README.md');
readme=readme.replace(/^Handwork benchmark values come from.*$/m,'Benchmark values come from a fresh five-attempt series for Handwork, OpenCode, and Codex on pagination, async search, and authorization/cache isolation. All agents used the same model and 600-second limit, fresh workspaces, rotated order, and independent scoring. Every scored outcome is retained. The report and summary are served from `public/benchmarks/fair-comparison/`. Update `public/app.js` and the no-JavaScript table in `src/index.html` together.');
write('README.md',readme);
console.log('Updated site from',results);
