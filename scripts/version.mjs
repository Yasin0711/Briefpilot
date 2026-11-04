// Vor jedem Commit ausführen: version.json = Anzahl aller Stände (Commits) einschließlich des nächsten.
// Die App zeigt daraus „Version 1.NN“ (ab 100: 2.NN …).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const count = Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim()) + 1;
fs.writeFileSync(new URL('../version.json', import.meta.url), `${JSON.stringify({ build: count }, null, 2)}\n`);
console.log(`version.json: build ${count}`);
