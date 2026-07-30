import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const cli = resolve('agents/skills/local-issue-tracker/local-issue-tracker.mjs');
async function repo() { const root = await mkdtemp(join(tmpdir(), 'tracker-')); await mkdir(join(root,'.git')); return root; }
function run(args, {cwd, input}={}) { return new Promise((done) => { const p=spawn(process.execPath,[cli,...args],{cwd}); let stdout='',stderr=''; p.stdout.on('data',d=>stdout+=d); p.stderr.on('data',d=>stderr+=d); p.on('close',status=>done({status,stdout,stderr})); if(input!==undefined)p.stdin.end(input); else p.stdin.end(); }); }

test('create writes canonical metadata and preserves body verbatim', async()=>{
  const root=await repo(); const body='## What to build\n\nKeep  two spaces.\n';
  const result=await run(['create','demo','--title','A useful issue','--type','task','--blocked-by','3, 01','--body-file','-','--json'],{cwd:root,input:body});
  assert.equal(result.status,0,result.stderr); const output=JSON.parse(result.stdout);
  assert.deepEqual(output,{identity:'demo/01',path:'.scratch/demo/issues/01-a-useful-issue.md'});
  assert.equal(await readFile(join(root,output.path),'utf8'),'# A useful issue\n\n<!-- Issue metadata: manage with the local-issue-tracker skill. -->\nTriage: needs-triage\nState: open\nType: task\nBlocked by: 03, 01\n\n'+body);
});

test('allocates above the highest number and show/list inspect through subprocess',async()=>{
 const root=await repo(); const dir=join(root,'.scratch/demo/issues'); await mkdir(dir,{recursive:true});
 await writeFile(join(dir,'04-old.md'),'# Old\n\nStatus: claimed\nBlocked by: None\n');
 const made=await run(['create','demo','--title','Next','--triage','ready-for-agent','--body','Body'],{cwd:root});
 assert.equal(made.status,0,made.stderr); assert.match(made.stdout,/demo\/05.*\.scratch\/demo\/issues\/05-next\.md/s);
 const shown=await run(['show','demo/05','--json'],{cwd:root}); assert.equal(shown.status,0,shown.stderr);
 assert.deepEqual(JSON.parse(shown.stdout),{identity:'demo/05',number:5,title:'Next',triage:'ready-for-agent',state:'open',type:null,blockers:[],canonical:true,path:'.scratch/demo/issues/05-next.md',body:'Body'});
 const listed=await run(['list','demo','--json'],{cwd:root}); assert.equal(listed.status,0,listed.stderr); assert.deepEqual(JSON.parse(listed.stdout).issues.map(x=>x.number),[4,5]);
});
