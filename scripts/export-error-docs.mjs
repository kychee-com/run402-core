import {readFileSync,writeFileSync,readdirSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'..');
const hash=s=>createHash('sha256').update(s).digest('hex');
const read=p=>readFileSync(resolve(root,p),'utf8');
const check=process.argv.includes('--check');
const out=resolve(root,'docs/generated/error-codes.json');
let previous;try{previous=JSON.parse(readFileSync(out,'utf8'))}catch{}
const revision=check?previous?.revision:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
function walk(dir){return readdirSync(resolve(root,dir),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(e=>e.isDirectory()?walk(dir+'/'+e.name):e.name.endsWith('.ts')&&!e.name.includes('.test.')?[dir+'/'+e.name]:[]);}
const sources=[];
for(const source of ['packages/functions/src','packages/runtime-kernel/src','packages/release/src'].flatMap(walk)){const text=read(source);const codes=[...new Set([...text.matchAll(/"(R402_[A-Z0-9_]+)"|(?:super\(|readonly code = )"([a-z][a-z0-9_]+)"/g)].map(m=>m[1]??m[2]))].sort();if(codes.length)sources.push({source,sourceDigest:hash(text),codes});}
const result={owner:'core',repository:'kychee-com/run402-core',revision,sources};
const bytes=JSON.stringify(result,null,2)+'\n';
if(check){if(!previous||readFileSync(out,'utf8')!==bytes)throw Error('Error contribution is stale; run node scripts/export-error-docs.mjs');}else{mkdirSync(dirname(out),{recursive:true});writeFileSync(out,bytes);}console.log('Safe error contribution '+(check?'verified':'written'));
