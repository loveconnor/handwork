import { copyFile, mkdir, readFile } from 'node:fs/promises';
const source = new URL('../node_modules/maplibre-gl/', import.meta.url);
const { version } = JSON.parse(await readFile(new URL('package.json', source), 'utf8'));
for (const root of ['../public/', '../desktop/public/']) {
  const target = new URL(`vendor/maplibre-gl/${version}/`, new URL(root, import.meta.url));
  await mkdir(target, { recursive: true });
  for (const file of ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']) {
    await copyFile(new URL(`dist/${file}`, source), new URL(file, target));
  }
}
