import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APIFY_XIANYU_ACTOR_ID,
  apifyXianyuFeedConfig,
  fetchApifyXianyuFeed,
  normalizeApifyXianyuItem,
  selectRelevantApifyXianyuItems
} from '../scripts/apify-xianyu-feed.mjs';

test('uses conservative defaults and clamps feed settings',()=>{
  const config=apifyXianyuFeedConfig({
    APIFY_API_TOKEN:'token',
    APIFY_XIANYU_FEED_MAX_ITEMS:'5000',
    APIFY_XIANYU_FEED_INTERVAL_MIN:'0',
    APIFY_XIANYU_FEED_MAX_CHARGE_USD:'100'
  });
  assert.equal(config.enabled,false);
  assert.equal(config.configured,true);
  assert.equal(config.maxItems,1000);
  assert.equal(config.intervalMin,1);
  assert.equal(config.maxTotalChargeUsd,25);
  assert.equal(apifyXianyuFeedConfig({APIFY_API_TOKEN:'token',APIFY_XIANYU_FEED_ENABLED:'1'}).enabled,true);
  assert.equal(apifyXianyuFeedConfig({}).enabled,false);
});

test('calls the documented sync endpoint with bearer auth and public-feed input',async()=>{
  let request;
  const items=await fetchApifyXianyuFeed({
    token:'secret-token',
    maxItems:25,
    maxTotalChargeUsd:0.4,
    fetchImpl:async(url,options)=>{
      request={url:new URL(url),options};
      return new Response(JSON.stringify([{itemId:'1'}]),{status:200});
    }
  });
  assert.equal(request.url.pathname,`/v2/acts/${APIFY_XIANYU_ACTOR_ID}/run-sync-get-dataset-items`);
  assert.equal(request.url.searchParams.get('maxItems'),'25');
  assert.equal(request.url.searchParams.get('maxTotalChargeUsd'),'0.4');
  assert.equal(request.url.searchParams.has('token'),false);
  assert.equal(request.options.headers.Authorization,'Bearer secret-token');
  assert.deepEqual(JSON.parse(request.options.body),{mode:'feed',maxItems:25,fetchDetails:false});
  assert.deepEqual(items,[{itemId:'1'}]);
});

test('normalizes feed rows without treating capture time as publication time',()=>{
  const item=normalizeApifyXianyuItem({
    itemId:123,
    title:'Prada vintage bag',
    price:1250,
    city:'Shanghai',
    mainImage:'//img.example/item.jpg',
    scrapedAt:'2026-10-20T12:00:00.000Z'
  });
  assert.equal(item.id,'123');
  assert.equal(item.currency,'CNY');
  assert.equal(item.image,'https://img.example/item.jpg');
  assert.equal(item.publishedAt,null);
  assert.equal(item.scrapedAt,'2026-10-20T12:00:00.000Z');
});

test('keeps only unique feed listings relevant to the task terms',()=>{
  const selected=selectRelevantApifyXianyuItems([
    {itemId:'1',title:'Prada vintage bag',price:1200},
    {itemId:'2',title:'Gucci Marmont leather purse',price:1800},
    {itemId:'1',title:'Prada vintage bag duplicate',price:1100},
    {itemId:'3',title:'Used leather handbag',price:500}
  ],{queries:['Prada vintage bag'],maxItems:10});
  assert.deepEqual(selected.map(item=>item.id),['1']);
});

test('rejects missing credentials and malformed API output',async()=>{
  await assert.rejects(fetchApifyXianyuFeed({}),/Falta APIFY_API_TOKEN/);
  await assert.rejects(fetchApifyXianyuFeed({
    token:'token',
    fetchImpl:async()=>new Response(JSON.stringify({error:{message:'bad'}}),{status:200})
  }),/no es una lista/);
});
