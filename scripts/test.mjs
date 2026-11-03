import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const files=readdirSync(new URL('../tests/',import.meta.url)).filter(n=>n.endsWith('.test.ts')).sort();
let failed=false;
for(const file of files) {
  console.log(`\nSuite: ${file}`);
  const result=spawnSync(process.execPath,['--import','tsx','tests/'+file],{stdio:'inherit',cwd:new URL('../',import.meta.url)});
  if(result.error) console.error(result.error.message);
  if(result.status!==0) failed=true;
}
process.exitCode=failed?1:0;
