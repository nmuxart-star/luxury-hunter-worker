import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {refCandidates,refTable,priceFromRefs,combinePrices,decideFromNumbers,MATCH_VERSION} from '../scripts/reference-match.mjs';
import {compWeight,compStats,weightedQuantile} from '../scripts/vestiaire-bag-match.mjs';

const ago=d=>new Date(Date.now()-d*86400e3).toISOString().slice(0,10);
const ref=(id,price,{sold=false,likes=0,published=ago(10),size='Medium',material='Piel'}={})=>({id:String(id),url:`https://es.vestiairecollective.com/x-${id}.shtml`,model:'Lady Dior',size,material,color:'Negro',condition:'Muy buen estado',price_eur:price,sold,sold_price_eur:sold?price:null,likes,published});

test('candidatas: las que más pesan primero, con código, sin repetir y sin el propio anuncio',()=>{
  const rows=[ref(1,1000),ref(2,1100,{sold:true,likes:50}),ref(2,1100),ref(3,900,{published:ago(400)}),ref(4,1200)];
  const c=refCandidates(rows,{prefix:'B',limit:3,excludeId:'4'});
  assert.deepEqual(c.map(r=>r._code),['B1','B2','B3']);
  assert.equal(c[0].id,'2');                       // vendida y con likes
  assert.ok(!c.some(r=>r.id==='4'));
  assert.match(refTable(c),/^B1 \| Lady Dior \| Medium/);
  assert.match(refTable(c),/VENDIDO/);
});

test('precio: media ponderada de las elegidas por la IA (vendidas, recientes y con likes pesan más)',()=>{
  const c=refCandidates([ref(1,1000),ref(2,2000,{sold:true,likes:60}),ref(3,500,{published:ago(500)})],{prefix:'B'});
  const p=priceFromRefs(c,['B1','B2','b3','B9']);
  assert.equal(p.n,3);
  assert.equal(p.sold_n,1);
  assert.ok(p.mean>1300&&p.mean<2000,String(p.mean));  // la vendida reciente tira hacia arriba
  assert.equal(priceFromRefs(c,[]),null);
  const only=priceFromRefs(c,[c.find(r=>r.id==='1')._code]);
  assert.equal(only.mean,920);                         // en venta × 92 %
});

test('base + Vestiaire: la base pesa el doble y un anuncio repetido cuenta una vez',()=>{
  const b=priceFromRefs(refCandidates([ref(1,1000),ref(2,1000)],{prefix:'B'}),['B1','B2']);
  const l=priceFromRefs(refCandidates([ref(2,1000),ref(9,3000)],{prefix:'V'}),['V1','V2']);
  const c=combinePrices(b,l);
  assert.equal(c.n_sheet,2);assert.equal(c.n_live,1);
  assert.ok(c.mean<2000);
  assert.equal(combinePrices(b,null).source,'base');
  assert.equal(combinePrices(null,l).source,'vestiaire');
  assert.equal(combinePrices(null,null),null);
});

test('decisión con los números; la calidad de la IA cuenta en la nota',()=>{
  const price={mean:2000,n:4};
  assert.equal(decideFromNumbers({price,landed:900,quality:80,risk:'LOW'}).decision,'STRONG BUY');  // 700 limpios
  assert.equal(decideFromNumbers({price,landed:1300,quality:80,risk:'LOW'}).decision,'BUY');        // 300
  assert.equal(decideFromNumbers({price:{mean:1000,n:4},landed:650,quality:80,risk:'LOW'}).decision,'WATCH');  // 150 limpios, 23 %
  assert.equal(decideFromNumbers({price,landed:1430,quality:80,risk:'LOW'}).decision,'REJECT');     // 170 pero 12 %
  assert.equal(decideFromNumbers({price,landed:1600,quality:80,risk:'LOW'}).decision,'REJECT');
  assert.equal(decideFromNumbers({price,landed:900,quality:80,risk:'HIGH'}).decision,'REJECT');
  assert.equal(decideFromNumbers({price,landed:900,quality:80,targetMatch:false}).decision,'REJECT');
  assert.equal(decideFromNumbers({price:null,landed:900}).decision,'REVIEW');
  assert.equal(decideFromNumbers({price,landed:900,quality:80,orientative:true}).decision,'WATCH');
  const good=decideFromNumbers({price,landed:1000,quality:90,risk:'LOW'}).score, bad=decideFromNumbers({price,landed:1000,quality:30,risk:'LOW'}).score;
  assert.ok(good>bad);
});

// El análisis real del bot (analyzeByReferences), con la IA simulada.
const source=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
const extract=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
test('análisis: la IA elige iguales en la base y en Vestiaire; el bot pone precio y decide',async()=>{
  const sheetRows=[ref(71,2000,{sold:true,likes:40}),ref(72,2100),ref(73,1900),ref(74,800,{size:'Mini'})];
  const liveRows=[{...ref(81,2200),sold:false},{...ref(82,2300),sold:true}];
  const stored=[];let prompts=[];
  const ctx=vm.createContext({console,Number,String,JSON,Math,Date,Array,Object,Set,Map,process:{env:{}},
    MATCH_VERSION,refCandidates,refTable,priceFromRefs,combinePrices,decideFromNumbers,compWeight,
    vestiaireRefs:()=>({tasks:{'Lady Dior':{source:'sheet',fichas:sheetRows}}}),
    sameModelRows:(tab,rows)=>({key:'lady dior',rows}),isWatchTask:()=>false,
    vestiaireTaskQuery:()=>'lady dior',vestiaireLiveQuery:()=>null,
    vestiaireLiveSearchRows:async()=>({status:'ok',model:'Lady Dior',rows:liveRows}),
    importEconomics:()=>({importedTotalEur:1000}),detectMarketplaceVerification:()=>({status:'AVAILABLE'}),
    resalePlatform:()=>({name:'Vestiaire',fee:20}),VESTIAIRE_DEFAULT_REALIZATION:0.92,VESTIAIRE_LIVE_REALIZATION:0.92,
    listingAuction:()=>null,fetchGeminiImageParts:async()=>[],aiModel:()=>'m',verifyBudgetLeftUsd:()=>1,
    verifyTierStore:{enterWith(){}},isAiPolicyFlag:()=>false,vestiaireSheetFresh:()=>true,roundMoney:n=>Math.round(n*100)/100,
    geminiJsonRequest:async({parts,purpose})=>{prompts.push({purpose,text:parts[0].text});return {data:{brand:'Dior',model:'Lady Dior',size:'Medium',target_match:true,
      condition_grade:'Muy buen estado',quality_score:80,authenticity_risk:'LOW',base_same:['B1','B2','B3'],vestiaire_same:['V1','V2'],decision_reasons_es:['Medium negro con tarjeta.']}};},
    storeTaskAnalysis:(...args)=>stored.push(args)});
  vm.runInContext(extract('const REF_MAX_BASE=','async function analyzeWithGemini('),ctx);
  const a=await ctx.analyzeByReferences({key:'k',item:{id:1,source:'xianyu',title:'Lady Dior medium',description:''},task:{task_name:'Lady Dior',product_query:'Lady Dior',notify_min_profit_eur:200},
    taskId:5,analyzeImages:true,reportProgress:()=>{},negotiated:false});
  assert.equal(prompts.length,2);                         // revisión + confirmación con el modelo fuerte
  assert.equal(prompts[1].purpose,'verify');
  assert.match(prompts[0].text,/NOT TO PRICE/);
  assert.match(prompts[0].text,/B4 \| Lady Dior \| Mini/);   // le llegan todas, también las de otra talla
  assert.ok(['BUY','STRONG BUY'].includes(a.decision),a.decision);
  assert.ok(a.resale_mean_eur>1800&&a.resale_mean_eur<2300,String(a.resale_mean_eur));
  const v=stored[0][4];
  assert.equal(v.market.match_version,MATCH_VERSION);
  assert.equal(v.market.sheet_comps.n,3);
  assert.equal(v.market.vestiaire_live.n,2);
  assert.equal(v.market.vestiaire_blend.n_live,2);
  assert.equal(a.resale_estimate_market_verified,true);
});
