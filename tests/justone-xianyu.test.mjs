import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getJustOneXianyuDetail,
  normalizeJustOneXianyuItems,
  JustOneApiError,
  searchJustOneXianyu
} from '../scripts/justone-xianyu.mjs';

const env={JUSTONEAPI_TOKEN:'test-key'};

test('normalizes nested listing data and deduplicates repeated item IDs',()=>{
  const items=normalizeJustOneXianyuItems({code:0,data:{items:[
    {itemId:'123',title:'Bolso preloved',price:'¥1,200',seller:{nickName:'Seller'},images:[{url:'//img.example/a.jpg'}],publishTime:1700000000},
    {item:{itemId:'123',title:'Bolso preloved',price:1200},seller:{nickName:'Seller'}}
  ]}});
  assert.equal(items.length,1);
  assert.equal(items[0].id,'123');
  assert.equal(items[0].price,1200);
  assert.equal(items[0].seller,'Seller');
  assert.equal(items[0].image,'https://img.example/a.jpg');
  assert.equal(items[0].url,'https://www.goofish.com/item?id=123');
  assert.equal(items[0].publishedAt,'2023-11-14T22:13:20.000Z');
});

test('search uses the documented Just One API host, route, and parameters',async()=>{
  let requested;
  const fetchImpl=async(url,options)=>{
    requested={url:new URL(url),options};
    return new Response(JSON.stringify({code:0,requestId:'req-1',data:{items:[{itemId:'45',title:'Chaqueta vintage',price:'2.5万'}]}}),{status:200,headers:{'content-type':'application/json'}});
  };
  const result=await searchJustOneXianyu({keyword:'Chanel bag',page:2,env,fetchImpl});
  assert.equal(requested.url.origin,'https://api.justoneapi.com');
  assert.equal(requested.url.pathname,'/api/xianyu/search-item-list/v1');
  assert.equal(requested.url.searchParams.get('token'),'test-key');
  assert.equal(requested.url.searchParams.get('keyword'),'Chanel bag');
  assert.equal(requested.url.searchParams.get('page'),'2');
  assert.equal(requested.url.searchParams.get('sort'),'active');
  assert.equal(requested.options.method,'GET');
  assert.equal(result.items[0].price,25000);
  assert.equal(result.requestId,'req-1');
});

test('detail lookup uses the documented v1 route and itemId parameter',async()=>{
  let requested;
  const fetchImpl=async(url,options)=>{
    requested={url:new URL(url),options};
    return new Response(JSON.stringify({code:0,data:{itemId:'abc',title:'Reloj usado',price:300,description:'En buen estado'}}),{status:200});
  };
  const result=await getJustOneXianyuDetail({itemId:'abc',env,fetchImpl});
  assert.equal(requested.url.pathname,'/api/xianyu/get-item-detail/v1');
  assert.equal(requested.url.searchParams.get('token'),'test-key');
  assert.equal(requested.url.searchParams.get('itemId'),'abc');
  assert.equal(result.item.title,'Reloj usado');
  assert.equal(result.item.description,'En buen estado');
});

test('provider business errors are rejected without exposing the API key',async()=>{
  const fetchImpl=async()=>new Response(JSON.stringify({code:303,message:'quota exceeded'}),{status:200});
  await assert.rejects(
    searchJustOneXianyu({keyword:'bag',env,fetchImpl}),
    error=>error instanceof JustOneApiError&&error.code===303&&/cuota diaria agotada/.test(error.message)&&!error.message.includes('test-key')
  );
});

test('requires an API key without making a request',async()=>{
  let calls=0;
  await assert.rejects(
    searchJustOneXianyu({keyword:'bag',env:{},fetchImpl:async()=>{calls++;}}),
    /JUSTONEAPI_TOKEN/
  );
  assert.equal(calls,0);
});
