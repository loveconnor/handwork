// Run with Electron to check scroll placement in Chromium before a frame paints.
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
app.whenReady().then(async () => {
  const root = path.join(__dirname, '../..');
  mkdirSync(path.join(root, 'node_modules/.cache'), { recursive: true });
  const temporary = mkdtempSync(path.join(root, 'node_modules/.cache/handwork-scroll-'));
  let window;
  try {
    const entry = path.join(temporary, 'entry.tsx');
    writeFileSync(entry, `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import { HandworkConversation } from ${JSON.stringify(path.join(root, 'components/site/HandworkConversation.tsx'))};
      const root = createRoot(document.getElementById('root'));
      window.scrollBehaviors = [];
      const originalScrollTo = HTMLElement.prototype.scrollTo;
      HTMLElement.prototype.scrollTo = function(options, ...rest) {
        window.scrollBehaviors.push(options?.behavior);
        return originalScrollTo.call(this, options, ...rest);
      };
      window.renderChat = (session, count, footerHeight = 80) => {
        flushSync(() => root.render(<HandworkConversation landing={false} sessionKey={session} busy={false}
          footer={<div style={{height: footerHeight}}>Composer</div>}>
          {Array.from({length: count}, (_, i) => <div key={i} style={{height: 60, flexShrink: 0}}>Message {i}</div>)}
        </HandworkConversation>));
        return window.position();
      };
      window.position = () => {
        const viewport = document.querySelector('.handwork-message-viewport');
        return { top: viewport.scrollTop, end: viewport.scrollHeight - viewport.clientHeight };
      };
    `);
    const { build } = await import('vite');
    await build({ configFile: false, root, logLevel: 'error', define: { 'process.env.NODE_ENV': '"production"' }, build: {
      outDir: path.join(temporary, 'out'), emptyOutDir: true, lib: { entry, name: 'ScrollTest', formats: ['iife'], fileName: () => 'test.js' },
    }, esbuild: { jsx: 'automatic' } });
    const css = ['desktop/desktop.css', 'desktop/surface.css'].map(file => readFileSync(path.join(root, file), 'utf8').replace(/^@import.*$/gm, '')).join('\n');
    window = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { sandbox: true } });
    window.webContents.on('console-message', event => { if (event.level === 'error') console.error(event.message); });
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<style>${css}
      .h-full{height:100%}.min-h-0{min-height:0}.overflow-hidden{overflow:hidden}#root {display:flex;height:100vh}.handwork-message-scroller{display:flex;flex-direction:column;position:relative}
      .handwork-message-viewport{height:100%;min-height:0;flex:1;overflow-y:auto;overflow-anchor:none}
    </style><div id="root"></div>`));
    await window.webContents.executeJavaScript(readFileSync(path.join(temporary, 'out/test.js'), 'utf8'));
    const run = code => window.webContents.executeJavaScript(code);
    const bottom = (position, label) => {
      assert.ok(position.end > 0, label + ': fixture must overflow: ' + JSON.stringify(position));
      assert.ok(Math.abs(position.top - position.end) <= 1, label + ': ' + JSON.stringify(position));
    };
    bottom(await run('renderChat("first", 80)'), 'initial chat before paint');
    bottom(await run('renderChat("next", 100)'), 'neighbor selected after close before paint');
    await run('renderChat("pending", 0)');
    bottom(await run('renderChat("pending", 120)'), 'history arriving after selection before paint');
    bottom(await run('renderChat("pending", 120, 160)'), 'composer resize before paint');
    await new Promise(resolve => setTimeout(resolve, 80));
    await run(`(() => { const viewport = document.querySelector('.handwork-message-viewport'); viewport.dispatchEvent(new WheelEvent('wheel', {bubbles:true,deltaY:-200})); viewport.scrollTop = 200; viewport.dispatchEvent(new Event('scroll')); })()`);
    assert.equal((await run('renderChat("pending", 121, 160)')).top, 200, 'updates preserve the reader’s position');
    bottom(await run('renderChat("last", 60)'), 'switching resets following before paint');
    await new Promise(resolve => setTimeout(resolve, 80));
    bottom(await run('position()'), 'position stays at bottom after scroller effects');
    assert.ok(!(await run('scrollBehaviors')).includes('smooth'), 'history loading must not animate');
    console.log('PASS: initial chats, tab switches, delayed history and composer resizing start at the bottom before paint; manual reading is preserved; no smooth scroll.');
  } finally { window?.destroy(); rmSync(temporary, { recursive: true, force: true }); }
}).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
