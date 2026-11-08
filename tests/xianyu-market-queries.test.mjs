import test from 'node:test';
import assert from 'node:assert/strict';
import {addXianyuMarketQueries,XIANYU_MARKET_QUERIES} from '../scripts/xianyu-market-queries.mjs';

test('market candidates extend the existing radar while preserving queries and avoiding duplicates',()=>{
  const input=['Lady Dior',XIANYU_MARKET_QUERIES[0]];
  const out=addXianyuMarketQueries(input);
  assert.deepEqual(out.slice(0,2),input);
  assert.equal(out.filter(x=>x===XIANYU_MARKET_QUERIES[0]).length,1);
  for(const query of XIANYU_MARKET_QUERIES)assert.ok(out.includes(query));
});
