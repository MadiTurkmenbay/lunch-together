import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
async function walk(directory) { const files=[]; for (const entry of await readdir(directory,{withFileTypes:true})) { const path=`${directory}/${entry.name}`; if(entry.isDirectory()) files.push(...await walk(path)); else if(path.endsWith('.mjs')) files.push(path); } return files; }
for (const file of [...await walk('server'),...await walk('scripts')]) { const result=spawnSync(process.execPath,['--check',file],{stdio:'inherit'}); if(result.status) process.exit(result.status); }
console.log('Server and scripts syntax OK.');
