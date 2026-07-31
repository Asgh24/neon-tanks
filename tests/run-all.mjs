/**
 * Runs every test suite in order against a local `npm run dev` server.
 * The room-server suite needs no browser; the other three drive Chromium.
 *
 * Usage:  npm run dev        (in one terminal)
 *         npm test           (in another)
 */
import { spawn } from 'node:child_process';

const BASE = process.env.BASE || 'http://localhost:8787';
const SUITES = [
  'tests/room-server.test.mjs',
  'tests/coop-basics.test.mjs',
  'tests/coop-flows.test.mjs',
  'tests/solo-and-mobile.test.mjs',
];

const run = (file) => new Promise((resolve) => {
  console.log('\n──────── ' + file + ' ────────');
  const p = spawn(process.execPath, [file], { stdio: 'inherit', env: { ...process.env, BASE } });
  p.on('close', (code) => resolve({ file, code }));
});

const health = await fetch(BASE + '/api/health').then(r => r.ok).catch(() => false);
if (!health) {
  console.error(`No dev server at ${BASE} — start one with \`npm run dev\` first.`);
  process.exit(2);
}

const results = [];
for (const s of SUITES) results.push(await run(s));

const failed = results.filter(r => r.code !== 0);
console.log('\n════════ summary ════════');
for (const r of results) console.log((r.code === 0 ? 'ok    ' : 'FAIL  ') + r.file);
process.exit(failed.length ? 1 : 0);
