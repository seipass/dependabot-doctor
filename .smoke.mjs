import { readFileSync } from 'node:fs';
import { analyseText } from './docs/js/check.js';
const dir = process.argv[2];
const files = new Map([
  ['.github/dependabot.yml', readFileSync(dir + '/.github/dependabot.yml', 'utf8')],
  ['package.json', readFileSync(dir + '/package.json', 'utf8')],
  ['package-lock.json', readFileSync(dir + '/package-lock.json', 'utf8')],
]);
const report = analyseText(files.get('.github/dependabot.yml'), files);
console.log('--- verdict'); for (const line of report.verdict) console.log(JSON.stringify(line));
console.log('--- count'); console.log(JSON.stringify(report.count));
console.log('--- findings'); console.log(report.findings);
console.log('--- skips'); console.log(JSON.stringify(report.skips));
