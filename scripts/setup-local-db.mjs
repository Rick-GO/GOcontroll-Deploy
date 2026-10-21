// Build the two local (wrangler dev) D1 databases Deploy reads, from the pinned schemas in
// test/fixtures: gocontroll-business (Hours: customers, projects) and gocontroll-db (an
// excerpt of GOcontroll-Database's schema.sql). Each file once, remembered in the local-only
// table local_fixtures. Local only: every command passes --local. Never point this at --remote.

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const wrangler = (...args) =>
  execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', shell: process.platform === 'win32' });
const query = (db, sql) => JSON.parse(wrangler('d1', 'execute', db, '--local', '--json', '--command', `"${sql}"`))[0].results;

for (const [db, dir] of [['gocontroll-business', 'test/fixtures/business'], ['gocontroll-db', 'test/fixtures/moduline']]) {
  query(db, 'CREATE TABLE IF NOT EXISTS local_fixtures (name TEXT PRIMARY KEY)');
  const done = new Set(query(db, 'SELECT name FROM local_fixtures').map((r) => r.name));
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const name = `${dir}/${file}`;
    if (done.has(name)) continue;
    console.log(`Applying pinned schema ${name} to local ${db}...`);
    wrangler('d1', 'execute', db, '--local', `--file=${name}`);
    query(db, `INSERT INTO local_fixtures (name) VALUES ('${name}')`);
  }
}
console.log('Local databases ready. Start with: npm run dev');
