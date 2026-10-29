import test from 'node:test';
import assert from 'node:assert/strict';
import {nextXianyuSearchUsage,xianyuBudgetMonth,xianyuBudgetDay,xianyuPaidSearchIntervalMs,
  XIANYU_MONTHLY_SEARCH_LIMIT,XIANYU_DAILY_SEARCH_LIMIT} from '../scripts/xianyu-search-budget.mjs';

test('uses the Madrid calendar month around its boundary',()=>{
  assert.equal(xianyuBudgetMonth(new Date('2026-10-31T22:59:00Z')),'2026-10');
  assert.equal(xianyuBudgetMonth(new Date('2026-10-31T23:01:00Z')),'2026-11');
  assert.equal(xianyuBudgetDay(new Date('2026-10-28T22:59:00Z')),'2026-10-28');
  assert.equal(xianyuBudgetDay(new Date('2026-10-28T23:01:00Z')),'2026-10-29');
});

test('counts attempts, blocks the 651st, and never accepts a higher configured limit',()=>{
  const month='2026-10';
  const day='2026-10-29';
  const before=JSON.stringify({month,attempts:649,day,dayAttempts:0});
  const last=nextXianyuSearchUsage(before,month,9999,day);
  assert.equal(last.allowed,true);
  assert.deepEqual(last.usage,{month,attempts:650,day,dayAttempts:1});
  assert.equal(last.limit,XIANYU_MONTHLY_SEARCH_LIMIT);
  const blocked=nextXianyuSearchUsage(JSON.stringify(last.usage),month,9999,day);
  assert.equal(blocked.allowed,false);
  assert.equal(blocked.reason,'monthly_limit');
  assert.equal(blocked.usage.attempts,650);
});

test('resets with a new Madrid month and supports a lower budget',()=>{
  const old=JSON.stringify({month:'2026-10',attempts:650,day:'2026-10-31',dayAttempts:20});
  const next=nextXianyuSearchUsage(old,'2026-11',100,'2026-11-01');
  assert.equal(next.allowed,true);
  assert.deepEqual(next.usage,{month:'2026-11',attempts:1,day:'2026-11-01',dayAttempts:1});
  assert.equal(next.limit,100);
});

test('caps paid requests at 20 each day and resumes on the next day',()=>{
  const usage={month:'2026-10',attempts:50,day:'2026-10-29',dayAttempts:19};
  const last=nextXianyuSearchUsage(usage,'2026-10',650,'2026-10-29',9999);
  assert.equal(last.allowed,true);
  assert.equal(last.usage.dayAttempts,XIANYU_DAILY_SEARCH_LIMIT);
  assert.equal(last.dailyLimit,XIANYU_DAILY_SEARCH_LIMIT);
  const stopped=nextXianyuSearchUsage(last.usage,'2026-10',650,'2026-10-29');
  assert.equal(stopped.allowed,false);
  assert.equal(stopped.reason,'daily_limit');
  const resumed=nextXianyuSearchUsage(stopped.usage,'2026-10',650,'2026-10-30');
  assert.equal(resumed.allowed,true);
  assert.equal(resumed.usage.dayAttempts,1);
});

test('holds legacy monthly state for the migration day so prior paid calls cannot be forgotten',()=>{
  const old={month:'2026-10',attempts:163};
  const stopped=nextXianyuSearchUsage(old,'2026-10',650,'2026-10-29');
  assert.equal(stopped.allowed,false);
  assert.equal(stopped.reason,'daily_limit');
  assert.equal(stopped.usage.attempts,163);
  const resumed=nextXianyuSearchUsage(stopped.usage,'2026-10',650,'2026-10-30');
  assert.equal(resumed.allowed,true);
  assert.equal(resumed.usage.attempts,164);
});

test('spaces paid searches according to the number of billable pages',()=>{
  assert.equal(xianyuPaidSearchIntervalMs(1),72*60_000);
  assert.equal(xianyuPaidSearchIntervalMs(2),144*60_000);
  assert.equal(xianyuPaidSearchIntervalMs(5),360*60_000);
});

test('fails closed for corrupt usage state',()=>{
  assert.throws(()=>nextXianyuSearchUsage('{bad','2026-10'),/ilegible/);
  assert.throws(()=>nextXianyuSearchUsage('{"month":"2026-10","attempts":-1}','2026-10'),/inválido/);
  assert.throws(()=>nextXianyuSearchUsage({month:'2026-10',attempts:1,day:'2026-10-29'},'2026-10'),/inválido/);
});
