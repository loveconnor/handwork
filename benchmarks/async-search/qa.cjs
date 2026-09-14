const { chromium } = require('/Users/connorlove/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const out = path.join(__dirname, 'results');
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('http://127.0.0.1:8765/search-benchmark-results.html');
    assert.equal(await page.locator('#runs tr').count(), 15);
    assert.equal(await page.locator('#matrix tr').count(), 15);
    assert.equal(await page.locator('#controls tr').count(), 3);
    assert.equal(await page.locator('#updated-comparison').count(), 0);
    const expected = {memory:'27.8 MiB',time:'48.6 sec',input:'176,899 tokens',output:'5,223 tokens',tools:'52 calls'};
    for (const metric of ['memory', 'time', 'input', 'output', 'tools']) {
      await page.selectOption('#metric', metric);
      assert.equal(await page.locator('#chart .chart-row').count(), 3);
      assert.equal(await page.locator('#chart .chart-row').first().locator('strong').textContent(), 'Updated Handwork');
      assert.equal(await page.locator('#chart .chart-row').first().locator('.value').textContent(), expected[metric]);
    }
    await page.selectOption('#metric', 'memory');
    const downloadPromise = page.waitForEvent('download');
    await page.click('#download');
    const download = await downloadPromise;
    const payload = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    assert.equal(payload.task, 'async-search');
    assert.equal(payload.runs.length, 15);
    const links = await page.locator('a[href^="benchmarks/"]').evaluateAll(a => a.map(x => x.getAttribute('href')));
    for (const link of links) assert(fs.existsSync(path.resolve(__dirname, '../..', link)), link);
    await page.screenshot({ path: path.join(out, 'report-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false);
    await page.screenshot({ path: path.join(out, 'report-mobile.png'), fullPage: true });
    assert.deepEqual(errors, []);
    const result = { passed: true, rows: 15, checkRows: 15, controls: 3, metrics: 5, evidenceLinks: links.length, downloadValid: true, mobileOverflow: overflow, browserErrors: errors };
    fs.writeFileSync(path.join(out, 'report-qa.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
