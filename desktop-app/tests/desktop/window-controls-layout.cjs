// Run with Electron, not Node: checks real Chromium layout against the production CSS.
const { app, BrowserWindow } = require('electron');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

app.whenReady().then(async () => {
  let window;
  try {
    const css = readFileSync(path.join(__dirname, '../../desktop/desktop.css'), 'utf8');
    const rules = css.match(/[^{}]*handwork-(?:windows|window-controls)[^{}]*\{[^}]*\}/g).join('\n');
    window = new BrowserWindow({ show: false, width: 900, height: 600, titleBarStyle: 'hidden', titleBarOverlay: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const html = '<style>*{box-sizing:border-box}body{margin:0;--hui-color-border-base-primary:#333}.handwork-workspace{display:flex;flex-direction:column;width:100vw}.handwork-header{height:44px}' + rules + '</style><main class=handwork-windows><div class=handwork-workspace><header class=handwork-header>Toolbar</header></div><div class=handwork-window-controls><button aria-label=Minimize><svg width=12 height=12></svg></button><button aria-label=Maximize></button><button aria-label=Close></button></div></main>';
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    for (const width of [800, 1280]) {
      window.setSize(width, 700);
      const result = await window.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => { const header = document.querySelector('header'); const controls = document.querySelector('.handwork-window-controls'); const divider = getComputedStyle(controls, '::after'); resolve({ divider: { height: divider.height, left: divider.left, right: divider.right, bottom: divider.bottom, background: divider.backgroundColor, pointerEvents: divider.pointerEvents }, headerBottom: header.getBoundingClientRect().bottom, controlsBottom: controls.getBoundingClientRect().bottom, controlsRight: controls.getBoundingClientRect().right, viewportWidth: innerWidth, headerRight: header.getBoundingClientRect().right, controlsLeft: controls.getBoundingClientRect().left, drag: getComputedStyle(header).webkitAppRegion, regions: [...controls.querySelectorAll('button, svg')].map(el => getComputedStyle(el).webkitAppRegion), hits: [...controls.querySelectorAll('button')].map(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }) }); }))");
      assert.ok(result.headerRight <= result.controlsLeft, 'Drag region overlaps controls at width ' + width);
      assert.equal(result.headerRight, result.controlsLeft);
      assert.equal(result.headerBottom, result.controlsBottom);
      assert.equal(result.controlsRight, result.viewportWidth);
      assert.deepEqual(result.divider, { height: '1px', left: '0px', right: '0px', bottom: '0px', background: 'rgb(51, 51, 51)', pointerEvents: 'none' });
      assert.equal(result.drag, 'drag');
      assert.ok(result.regions.every(region => region === 'no-drag'));
      assert.deepEqual(result.hits, [true, true, true]);
    }
    console.log('PASS: native-window Chromium layout at 800px and 1280px; all caption buttons hit-testable and outside drag region');
  } finally { window?.destroy(); }
}).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
