import test from 'node:test';
import assert from 'node:assert/strict';
import {reefAuctionCard,searchReefYahoo} from '../scripts/reef-yahoo.mjs';

test('ReefAPI usa una sola búsqueda y convierte subastas a enlaces de One Map',async()=>{
  let called=0;
  const now=Date.now();
  const fetchImpl=async(url,options)=>{
    called++;
    assert.equal(url,'https://api.reefapi.com/yahoo-auctions/v1/search');
    assert.equal(options.headers['x-api-key'],'test-key');
    assert.deepEqual(JSON.parse(options.body),{query:'レディディオール',
      listing_format:'auction',seller_type:'individual,store',sort:'ending_soon',limit:50});
    return {ok:true,status:200,json:async()=>({ok:true,data:{items:[
      {auction_id:'s1234567890',title:'Lady Dior',price:120000,
        end_time:new Date(now+3600000).toISOString(),bid_count:4,
        listing_type:'individual',is_fixed_price:false,seller:{id:'seller',positive_percent:99}},
      {auction_id:'s1111111111',title:'Precio fijo',price:10000,
        end_time:new Date(now+3600000).toISOString(),is_fixed_price:true},
      {auction_id:'1250462315',title:'Sin prefijo',price:10000,
        end_time:new Date(now+3600000).toISOString(),is_fixed_price:false}
    ]},meta:{record_count:2}})};
  };
  const result=await searchReefYahoo('レディディオール',{apiKey:'test-key',fetchImpl});
  assert.equal(called,1);
  assert.equal(result.items.length,2);
  assert.equal(result.items[0].url,
    'https://www.fromjapan.co.jp/japan/en/auction/yahoo/input/s1234567890/');
  assert.equal(result.items[0].sellerPositivePercent,99);
  assert.equal(result.items[1].sellerPositivePercent,null);
});

test('ReefAPI descarta respuestas fallidas y filas sin puja válida',async()=>{
  assert.equal(reefAuctionCard({auction_id:'s1234567890',title:'X',price:0,end_time:'2099-01-01'}),null);
  await assert.rejects(searchReefYahoo('x',{apiKey:'test-key',fetchImpl:async()=>({
    ok:false,status:429,json:async()=>({error:{code:'RATE_LIMIT'}})
  })}),/HTTP 429: RATE_LIMIT/);
});
