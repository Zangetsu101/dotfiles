import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const cli=resolve('agents/skills/local-issue-tracker/local-issue-tracker.mjs');
const marker='<!-- Issue metadata: manage with the local-issue-tracker skill. -->';
async function repo(){const root=await mkdtemp(join(tmpdir(),'tracker-'));await mkdir(join(root,'.git'));return root}
function run(args,{cwd}={}){return new Promise(done=>{const p=spawn(process.execPath,[cli,...args],{cwd});let stdout='',stderr='';p.stdout.on('data',d=>stdout+=d);p.stderr.on('data',d=>stderr+=d);p.on('close',status=>done({status,stdout,stderr}));p.stdin.end()})}
async function put(root,effort,name,text){const dir=join(root,'.scratch',effort,'issues');await mkdir(dir,{recursive:true});const path=join(dir,name);await writeFile(path,text);return path}
function issue({title='Issue',triage='ready-for-agent',state='open',type,blocked='None',body='',extra=[]}={}){return `# ${title}\n\n${marker}\nTriage: ${triage}\nState: ${state}\n${type===undefined?'':`Type: ${type}\n`}Blocked by: ${blocked}\n${extra.join('\n')}${extra.length?'\n':''}\n${body}`}

test('validate clean effort and whole tracker is non-mutating with stable JSON',async()=>{
 const root=await repo();const path=await put(root,'alpha','01-any-slug.md',issue({title:'A renamed title',extra:['Owner: humans']}));const before=await readFile(path);
 await put(root,'beta','01-b.md',issue({triage:'wontfix',state:'resolved',body:'## Answer\n\nDeclined.'}));
 const effort=await run(['validate','alpha','--json'],{cwd:root});assert.equal(effort.status,0,effort.stderr);
 assert.deepEqual(JSON.parse(effort.stdout),{scope:'effort',effort:'alpha',valid:true,findings:[]});
 const all=await run(['validate','--json'],{cwd:root});assert.equal(all.status,0,all.stderr);
 assert.deepEqual(JSON.parse(all.stdout),{scope:'tracker',valid:true,findings:[]});
 assert.deepEqual(await readFile(path),before);
});

test('validate accumulates schema, identity, lifecycle, and body findings without mutation',async()=>{
 const root=await repo();
 const malformed=await put(root,'demo','bad.md','# Bad\n\nTriage: ready-for-agent\nState: open\nBlocked by: None\n');
 const duplicate=await put(root,'demo','01-first.md',`# First\n\n${marker}\nTriage: nope\nTriage: ready-for-agent\nState: working\nType: mystery\nBlocked by: None\n\nState: open\n`);
 await put(root,'demo','1-second.md',issue({title:'Second'}));
 await put(root,'demo','02-claimed.md',issue({triage:'needs-info',state:'claimed',blocked:'99'}));
 await put(root,'demo','03-resolved.md',issue({state:'resolved',body:'## Answer\n\n   \n'}));
 const before=await Promise.all([malformed,duplicate].map(p=>readFile(p)));
 const r=await run(['validate','demo','--json'],{cwd:root});assert.equal(r.status,2,r.stderr);const out=JSON.parse(r.stdout);
 assert.equal(out.scope,'effort');assert.equal(out.effort,'demo');assert.equal(out.valid,false);
 const codes=out.findings.map(x=>x.code);
 for(const code of ['malformed-filename','missing-marker','duplicate-number','noncanonical-identity','duplicate-metadata','misplaced-metadata','invalid-triage','invalid-state','invalid-type','missing-blocker','claimed-not-actionable','claimed-blocked','resolved-without-answer']) assert.ok(codes.includes(code),`${code}: ${JSON.stringify(out)}`);
 assert.ok(out.findings.every(x=>typeof x.path==='string'&&typeof x.message==='string'));
 assert.deepEqual(await Promise.all([malformed,duplicate].map(p=>readFile(p))),before);
});

test('validate reports every blocker graph problem and readable diagnostics identify files',async()=>{
 const root=await repo();
 await put(root,'graph','01-a.md',issue({blocked:'01, 02, 02, 99, other/01'}));
 await put(root,'graph','02-b.md',issue({blocked:'03'}));
 await put(root,'graph','03-c.md',issue({blocked:'01'}));
 const r=await run(['validate','graph'],{cwd:root});assert.equal(r.status,2,r.stderr);
 for(const text of ['01-a.md','self','duplicate blocker','missing blocker','cross-effort','dependency cycle']) assert.match(r.stdout,new RegExp(text));
});

test('validation setup failures use the command-error exit and no findings JSON',async()=>{
 const root=await repo();const missing=await run(['validate','absent','--json'],{cwd:root});assert.equal(missing.status,1);assert.equal(missing.stdout,'');assert.match(missing.stderr,/effort.*not found/i);
});
