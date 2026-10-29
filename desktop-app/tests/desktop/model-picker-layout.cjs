// Run with Electron: verifies Chromium flex sizing with long model descriptions.
const { app, BrowserWindow } = require('electron');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
app.whenReady().then(async () => {
  let window;
  try {
    const css = readFileSync(path.join(__dirname, '../../desktop/surface.css'), 'utf8').replace(/^@import.*$/gm, '');
    const choices = [
      ['Default (recommended)', 'Opus 5.5 · Best for everyday, complex tasks · claude-opus-5-5'],
      ['Opus 5.5', 'For complex work and everyday tasks · claude-opus-5-5'],
      ['Sonnet 5.5', 'Most efficient for simpler tasks · claude-sonnet-5-5'],
      ['Fable 5.1', 'For your toughest challenges · claude-fable-5-1'],
      ['Haiku 5.5', 'Fastest for quick answers · claude-haiku-5-5'],
      ['Opus 4.8', 'Best for everyday, complex tasks'],
    ];
    window = new BrowserWindow({ show: false, width: 400, height: 400, webPreferences: { sandbox: true } });
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<style>${css}
      body { font-family: Arial; font-size: 13px; }
      .handwork-model-choice { width: 230px; margin: 10px; }
    </style>${choices.map(([name, description]) => `<div class="handwork-model-choice"><span class="handwork-option-name">${name}</span><span class="handwork-option-description">${description}</span></div>`).join('')}`));
    for (const zoom of [1, 2]) {
      window.webContents.setZoomFactor(zoom);
      const rows = await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.handwork-model-choice')).map(row => {
        const name = row.querySelector('.handwork-option-name'), description = row.querySelector('.handwork-option-description');
        return { name: name.textContent, nameWidth: name.clientWidth, nameContent: name.scrollWidth, descriptionWidth: description.clientWidth, rowWidth: row.clientWidth, descriptionRight: description.getBoundingClientRect().right, rowRight: row.getBoundingClientRect().right, overflow: getComputedStyle(description).overflow, ellipsis: getComputedStyle(description).textOverflow };
      })`);
      for (const row of rows) {
        assert.ok(row.nameWidth > 45, `${row.name} must remain visible at zoom ${zoom}`);
        if (row.name !== 'Default (recommended)') assert.ok(row.nameWidth >= row.nameContent - 1, `${row.name} should fit`);
        assert.ok(row.descriptionRight <= row.rowRight + 1, 'description stays inside the row');
        assert.equal(row.overflow, 'hidden');
        assert.equal(row.ellipsis, 'ellipsis');
      }
    }
    console.log('Model names remain visible and descriptions truncate at 100% and 200% zoom.');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { window?.destroy(); app.quit(); }
});
