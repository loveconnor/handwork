import { readFileSync, writeFileSync } from 'node:fs';
const base = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(base);
const sequence = Number(process.env.GITHUB_RUN_NUMBER);
if (!match || !Number.isSafeInteger(sequence) || sequence < 1) throw new Error('A stable base version and GitHub run number are required');
const version = `${match[1]}.${match[2]}.${Number(match[3]) + sequence}`;
writeFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`, { flag: 'a' });
console.log(`Desktop release version: ${version}`);
