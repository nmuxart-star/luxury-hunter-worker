import test from 'node:test';
import assert from 'node:assert/strict';
import {nextXianyuSearchUsage,xianyuBudgetMonth,XIANYU_MONTHLY_SEARCH_LIMIT} from '../scripts/xianyu-search-budget.mjs';

test('uses the Madrid calendar month around its boundary',()=>{
  assert.equal(xianyuBudgetMonth(new Date('2026-10-31T22:59:00Z')),'2026-10');
  assert.equal(xianyuBudgetMonth(new Date('2026-10-31T23:01:00Z')),'2026-11');
});

test('counts attempts, blocks the 651st, and never accepts a higher configured limit',()=>{
  const month='2026-10';
  const before=JSON.stringify({month,attempts:649});
  const last=nextXianyuSearchUsage(before,month,9999);
  assert.equal(last.allowed,true);
  assert.deepEqual(last.usage,{month,attempts:650});
  assert.equal(last.limit,XIANYU_MONTHLY_SEARCH_LIMIT);
  const blocked=nextXianyuSearchUsage(JSON.stringify(last.usage),month);
  assert.equal(blocked.allowed,false);
  assert.equal(blocked.usage.attempts,650);
});

test('resets with a new Madrid month and supports a lower budget',()=>{
  const old=JSON.stringify({month:'2026-10',attempts:650});
  const next=nextXianyuSearchUsage(old,'2026-11',100);
  assert.equal(next.allowed,true);
  assert.deepEqual(next.usage,{month:'2026-11',attempts:1});
  assert.equal(next.limit,100);
});

test('fails closed for corrupt usage state',()=>{
  assert.throws(()=>nextXianyuSearchUsage('{bad','2026-10'),/ilegible/);
  assert.throws(()=>nextXianyuSearchUsage('{"month":"2026-10","attempts":-1}','2026-10'),/inválido/);
});
