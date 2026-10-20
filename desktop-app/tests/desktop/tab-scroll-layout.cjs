// Run with Electron: real wheel input against the production CSS and TypeScript handler.
const { app, BrowserWindow } = require('electron');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('typescript');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  let window;
  try {
    const root = path.join(__dirname, '../..');
    const css = readFileSync(path.join(root, 'desktop/desktop.css'), 'utf8').split('\n').filter(line => !line.startsWith('@import')).join('\n');
    const handler = ts.transpileModule(readFileSync(path.join(root, 'lib/horizontal-scroll.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText.replace('export ', '');
    window = new BrowserWindow({ show: true, width: 900, height: 600, titleBarStyle: 'hidden', titleBarOverlay: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const tabs = Array.from({ length: 12 }, (_, i) => '<div class=handwork-tab><button class=handwork-tab-label>Chat ' + i + '</button></div>').join('');
    const html = '<style>*{box-sizing:border-box}button{font:inherit}' + css + '</style><main class=handwork-app><aside style=width:264px;flex-shrink:0></aside><section class=handwork-workspace><header class=handwork-header><div class=handwork-tabs>' + tabs + '</div><button>Details</button></header></section></main><script>' + handler + ';bindHorizontalWheel(document.querySelector(".handwork-tabs"));</script>';
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    window.focus();
    await wait(150);
    for (const platform of ['handwork-windows', 'handwork-mac']) {
      await window.webContents.executeJavaScript('document.querySelector("main").classList.add(' + JSON.stringify(platform) + ')');
      await wait(100);
      for (const gesture of [{ deltaX: 0, deltaY: -120 }, { deltaX: -120, deltaY: 0 }, { deltaX: -2, deltaY: -120 }, { deltaX: 0, deltaY: -120, modifiers: ['shift'] }]) {
        const point = await window.webContents.executeJavaScript('(() => {const e=document.querySelector(".handwork-tabs"); e.scrollLeft=0; const r=e.getBoundingClientRect(); return {x:Math.round(r.x+40),y:Math.round(r.y+r.height/2),max:e.scrollWidth-e.clientWidth};})()');
        assert.ok(point.max > 0);
        window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
        window.webContents.sendInputEvent({ type: 'mouseWheel', x: point.x, y: point.y, ...gesture });
        await wait(200);
        const offset = await window.webContents.executeJavaScript('document.querySelector(".handwork-tabs").scrollLeft');
        assert.ok(offset > 0, platform + ': wheel did not scroll: ' + JSON.stringify(gesture));
      }
      await window.webContents.executeJavaScript('document.querySelector("main").classList.remove(' + JSON.stringify(platform) + ')');
    }
    console.log('PASS: Electron vertical, horizontal, mixed-axis and Shift-wheel input scroll tabs with Windows and Mac toolbar CSS');
  } finally { window?.destroy(); }
}).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
