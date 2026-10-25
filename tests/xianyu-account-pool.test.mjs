import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {xianyuAccountFiles,tryXianyuAccounts} from '../scripts/xianyu-account-pool.mjs';

function fixtures(t){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xianyu-accounts-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const first=path.join(dir,'A.json');
  const second=path.join(dir,'B.json');
  fs.writeFileSync(first,JSON.stringify({cookies:[]}));
  fs.writeFileSync(second,JSON.stringify({cookies:[]}));
  return {dir,first,second};
}

test('uses the backup when the first account session expires',async t=>{
  const {dir,first,second}=fixtures(t);
  const files=xianyuAccountFiles({primaryFile:first,accountDir:dir});
  const calls=[];
  const failed=new Map();
  const result=await tryXianyuAccounts({files,failed,search:async file=>{
    calls.push(file);
    return file===first?{login:true}:{items:[{id:'1'}]};
  }});
  assert.deepEqual(calls,[first,second]);
  assert.equal(result.usedFile,second);
  assert.deepEqual(result.expired,['A']);
  assert.equal(failed.has(first),true);
  const next=await tryXianyuAccounts({files,preferred:second,failed,search:async file=>({file})});
  assert.equal(next.usedFile,second);
});

test('does not switch accounts after a verification challenge',async t=>{
  const {dir,first}=fixtures(t);
  const files=xianyuAccountFiles({primaryFile:first,accountDir:dir});
  const calls=[];
  const result=await tryXianyuAccounts({files,search:async file=>{calls.push(file);return {risk:true};}});
  assert.deepEqual(calls,[first]);
  assert.equal(result.result.risk,true);
});

test('fixed account never switches and a renewed state becomes available',async t=>{
  const {dir,first,second}=fixtures(t);
  const files=xianyuAccountFiles({primaryFile:first,accountDir:dir});
  const failed=new Map();
  const firstTry=await tryXianyuAccounts({files,fixed:first,failed,search:async()=>({login:true})});
  assert.equal(firstTry.result.login,true);
  assert.deepEqual(firstTry.expired,['A']);
  const blocked=await tryXianyuAccounts({files,fixed:first,failed,search:async()=>{throw Error('must not run');}});
  assert.equal(blocked.result.login,true);
  assert.equal(blocked.usedFile,null);
  const later=new Date(Date.now()+2000);
  fs.utimesSync(first,later,later);
  const renewed=await tryXianyuAccounts({files,fixed:first,failed,search:async file=>({file})});
  assert.equal(renewed.usedFile,first);
  assert.notEqual(second,renewed.usedFile);
});
