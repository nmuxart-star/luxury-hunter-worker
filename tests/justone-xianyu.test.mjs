import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeJustOneXianyuItems,
  JustOneApiError,
  searchJustOneXianyu
} from '../scripts/justone-xianyu.mjs';
import {
  extractXianyuTags,
  hasXianyuVerificationTag,
  xianyuListingHasVerificationTag
} from '../scripts/xianyu-verification.mjs';

const env={JUSTONEAPI_TOKEN:'test-key'};

test('normalizes nested listing data and deduplicates repeated item IDs',()=>{
  const items=normalizeJustOneXianyuItems({code:0,data:{items:[
    {itemId:'123',title:'Bolso preloved',price:'¥1,200',seller:{nickName:'Seller'},images:[{url:'//img.example/a.jpg'}],publishTime:1700000000},
    {item:{itemId:'123',title:'Bolso preloved',price:1200,tags:['验货宝']},seller:{nickName:'Seller'}}
  ]}});
  assert.equal(items.length,1);
  assert.equal(items[0].id,'123');
  assert.equal(items[0].price,1200);
  assert.equal(items[0].seller,'Seller');
  assert.equal(items[0].image,'https://img.example/a.jpg');
  assert.equal(items[0].url,'https://www.goofish.com/item?id=123');
  assert.equal(items[0].publishedAt,'2023-11-14T22:13:20.000Z');
  assert.deepEqual(items[0].tags,['验货宝']);
});

test('normalizes image, publication time, and seller fields from one search result',()=>{
  const [item]=normalizeJustOneXianyuItems({code:0,data:{items:[{
    itemId:'search-only-1',
    title:'Bolso preloved',
    price:'¥1,200',
    images:[{url:'//img.example/main.jpg'},{url:'https://img.example/second.jpg'}],
    description:'Descripción que llega en búsqueda',
    publishTime:1700000000,
    seller:{
      userNickName:'Vendedora',
      userId:'seller-7',
      sellerRegDays:730,
      sellerCredit:{levelName:'良好'},
      sellerSales:18,
      sellerItems:4,
      sellerReviewCount:12,
      sellerReviewRate:'99%'
    },
    tags:['验货宝']
  }]}});

  assert.equal(item.image,'https://img.example/main.jpg');
  assert.deepEqual(item.images,['https://img.example/main.jpg','https://img.example/second.jpg']);
  assert.equal(item.description,'Descripción que llega en búsqueda');
  assert.equal(item.publishedAt,'2023-11-14T22:13:20.000Z');
  assert.equal(item.seller,'Vendedora');
  assert.equal(item.sellerId,'seller-7');
  assert.equal(item.sellerRegDays,730);
  assert.equal(item.sellerCredit,'良好');
  assert.equal(item.sellerSales,18);
  assert.equal(item.sellerItems,4);
  assert.equal(item.sellerReviewCount,12);
  assert.equal(item.sellerReviewRate,'99%');
  assert.deepEqual(item.tags,['验货宝']);
});

test('search uses the documented Just One API host, route, and parameters',async()=>{
  let requested;
  const fetchImpl=async(url,options)=>{
    requested={url:new URL(url),options};
    return new Response(JSON.stringify({code:0,requestId:'req-1',data:{items:[{itemId:'45',title:'Chaqueta vintage',price:'2.5万',fishTags:{r5:{tagList:[{data:{content:'验货宝'}}]}}}]}}),{status:200,headers:{'content-type':'application/json'}});
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
  assert.deepEqual(result.items[0].tags,['验货宝']);
  assert.equal(result.requestId,'req-1');
});

test('search keeps only listings with their own 验货宝 badge, including the r5 tag group',async()=>{
  const data={
    code:0,
    data:{
      filterPanelDO:[{cardData:{value:[{valueName:'验货宝'}]}}],
      resultList:[
        {data:{item:{main:{exContent:{itemId:'verified',title:'Bolso verificado',price:[{text:'¥'},{text:'1,200'}],fishTags:{r5:{tagList:[{data:{content:'验货宝'}},{data:{content:'包邮'}}]}}}}}}},
        {data:{item:{main:{exContent:{itemId:'unverified',title:'Bolso 验货宝 según vendedor',price:900,description:'支持验货宝',fishTags:{r5:{tagList:[{data:{content:'包邮'}}]}}}}}}}
      ]
    }
  };
  const fetchImpl=async()=>new Response(JSON.stringify(data),{status:200});
  const result=await searchJustOneXianyu({keyword:'bolso',env,fetchImpl});
  assert.deepEqual(result.items.map(item=>item.id),['verified']);
  assert.equal(result.items[0].price,1200);
  assert.deepEqual(result.items[0].tags,['验货宝','包邮']);
  assert.equal(result.totalFound,2);
  assert.equal(result.missingVerificationTag,1);
});

test('verification requires an exact listing tag, not a seller claim or a search filter option',()=>{
  assert.deepEqual(extractXianyuTags({fishTags:{r2:{tagList:[{data:{content:'验货宝'}}]}}}),['验货宝']);
  assert.equal(hasXianyuVerificationTag(['包邮','验货宝']),true);
  assert.equal(hasXianyuVerificationTag(['不支持验货宝']),false);
  assert.equal(xianyuListingHasVerificationTag({source:'xianyu',title:'支持验货宝',raw_json:'{}'}),false);
  assert.equal(xianyuListingHasVerificationTag({source:'xianyu',raw_json:JSON.stringify({'商品信息':{'商品标签':['包邮','验货宝']}})}),true);
  assert.equal(xianyuListingHasVerificationTag({source:'bunjang',raw_json:'{}'}),true);
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
