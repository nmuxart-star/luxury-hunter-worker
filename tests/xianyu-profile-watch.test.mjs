import test from 'node:test';
import assert from 'node:assert/strict';
import {parseXianyuProfilePage,parseXianyuProfileHead,parseXianyuDetail,parseProfilePrice,classifyProfileSnapshot,collectXianyuProfile} from '../scripts/xianyu-profile-watch.mjs';

test('a profile card is accepted only while active, and its verification is local to the card',()=>{
  const result=parseXianyuProfilePage({data:{nextPage:false,cardList:[
    {cardData:{id:'1',title:'Bolso',itemStatus:0,priceInfo:{price:'999'},picInfo:{picUrl:'//img.example/a.jpg'},fishTags:{r1:{tagList:[{data:{content:'验货宝'}}]}}}},
    {cardData:{id:'2',title:'Otro',itemStatus:0}},
    {cardData:{id:'3',title:'Vendido',itemStatus:1}},
    {cardData:{id:'4',title:'Estado desconocido'}}
  ]}});
  assert.equal(result.complete,true);
  assert.deepEqual(result.items.map(x=>[x.id,x.verification]),[['1','available'],['2','unknown']]);
  assert.equal(result.items[0].image,'https://img.example/a.jpg');
});

test('incomplete profile results cannot establish the initial baseline',()=>{
  const items=[{id:'1'},{id:'2'}];
  assert.deepEqual(classifyProfileSnapshot({items,complete:false}),{newItems:[],establishBaseline:false});
  assert.deepEqual(classifyProfileSnapshot({items,complete:true}),{newItems:[],establishBaseline:true});
  assert.deepEqual(classifyProfileSnapshot({items,knownIds:['1'],baselineComplete:true}),{newItems:[{id:'2'}],establishBaseline:false});
  assert.equal(parseXianyuProfilePage({data:{}}).ok,false);
});

test('profile header keeps total ratings separate from seller sales',()=>{
  const head=parseXianyuProfileHead({data:{module:{base:{displayName:'Tienda',ylzTags:[{text:'信用极好',attributes:{role:'seller'}}]},tabs:{item:{number:294},rate:{number:165}}}}});
  assert.deepEqual(head,{name:'Tienda',credit:'信用极好',totalItems:294,totalRatings:165});
});

test('collects all available profile pages without treating the first page as complete',async()=>{
  const reply=(url,data)=>({url:()=>url,ok:()=>true,json:async()=>data});
  const pages=[{data:{nextPage:true,cardList:[{cardData:{id:'1',title:'A',itemStatus:0}}]}},
    {data:{nextPage:false,cardList:[{cardData:{id:'2',title:'B',itemStatus:0}}]}}];
  const page={
    url:()=> 'https://www.goofish.com/personal?userId=7',
    goto:async()=>{},evaluate:async()=>{},
    waitForResponse:async test=>{
      const head=reply('mtop.idle.web.user.page.head',{data:{module:{base:{displayName:'Test'}}}});
      if(test(head))return head;
      return reply('mtop.idle.web.xyh.item.list',pages.shift());
    }
  };
  const result=await collectXianyuProfile(page,'7');
  assert.equal(result.complete,true);
  assert.deepEqual(result.items.map(x=>x.id),['1','2']);
  assert.equal(result.head.name,'Test');
});

test('stops on verification request rather than returning an empty profile',async()=>{
  const page={goto:async()=>{},url:()=> 'https://www.goofish.com/personal?userId=7',
    waitForResponse:async test=>({url:()=> 'mtop.idle.web.xyh.item.list',ok:()=>true,
      json:async()=>({ret:['FAIL_SYS_USER_VALIDATE']})})};
  await assert.rejects(collectXianyuProfile(page,'7'),{kind:'risk'});
});

test('seller identity, date and tag must belong to the requested item',()=>{
  const p={data:{itemDO:{id:'100',title:'Bolso',publishTime:1794172800000,
    fishTags:{r1:{tagList:[{data:{content:'验货宝'}}]}}},sellerDO:{sellerId:'42'}}};
  assert.equal(parseXianyuDetail(p,'100').sellerId,'42');
  assert.equal(parseXianyuDetail(p,'100').verification,'available');
  assert.equal(parseXianyuDetail(p,'101'),null);
  delete p.data.itemDO.publishTime;
  delete p.data.itemDO.fishTags;
  assert.equal(parseXianyuDetail(p,'100').publishedAt,null);
  assert.equal(parseXianyuDetail(p,'100').verification,'unknown');
  p.data.itemDO.createTime='2026-11-08 09:00:00';
  assert.equal(parseXianyuDetail(p,'100').publishedAt,null);
});

test('handles yuan prices in 万 without underestimating the purchase cost',()=>{
  assert.equal(parseProfilePrice('¥ 1.29万'),12900);
  assert.equal(parseProfilePrice('¥3,500'),3500);
  assert.equal(parseProfilePrice('precio desconocido'),null);
});
