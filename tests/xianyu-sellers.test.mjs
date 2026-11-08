import test from 'node:test';
import assert from 'node:assert/strict';
import {sellerFromXianyuCard,sellerWatchEligible,sellerRank} from '../scripts/xianyu-sellers.mjs';

test('reads a stable seller ID and profile signals from one search card',()=>{
  const seller=sellerFromXianyuCard({clickParam:{args:{seller_id:'u-82'}}},{
    userNickName:'Bolsos 82',zhimaLevelInfo:{levelName:'信用极好'},hasSoldNumInteger:'283',
    userFishShopLabel:{tagList:[{data:{content:'108条评价'}},{data:{content:'好评率 99.5%'}},{data:{content:'鱼小铺'}}]}
  });
  assert.equal(seller.id,'u-82');
  assert.equal(seller.credit,'信用极好');
  assert.equal(seller.sold,283);
  assert.equal(seller.reviews,108);
  assert.equal(seller.positiveRate,99.5);
  assert.equal(seller.type,'tienda');
});

test('requires distinct observed verified listings plus reputation before auto-follow',()=>{
  assert.equal(sellerWatchEligible({observed:2,verified:2,credit:'信用极好'}),true);
  assert.equal(sellerWatchEligible({observed:2,verified:1,credit:'信用极好'}),false);
  assert.equal(sellerWatchEligible({observed:2,verified:2}),false);
  assert.equal(sellerWatchEligible({observed:3,verified:3,reviews:25,positiveRate:99}),true);
  assert.ok(sellerRank({observed:3,verified:3,credit:'信用极好'})>
    sellerRank({observed:3,verified:1,credit:'信用极好'}));
});
