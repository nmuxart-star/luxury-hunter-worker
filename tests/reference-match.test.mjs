import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {refCandidates,refTable,refValue,priceFromRefs,combinePrices,decideFromNumbers,MATCH_VERSION} from '../scripts/reference-match.mjs';
import {compWeight,compStats,weightedQuantile} from '../scripts/vestiaire-bag-match.mjs';
import {xianyuListingHasVerificationTag} from '../scripts/xianyu-verification.mjs';
import {descTokens,descIndex,descScore,refSheetDoubt} from '../scripts/ref-retrieval.mjs';

const ago=d=>new Date(Date.now()-d*86400e3).toISOString().slice(0,10);
const ref=(id,price,{sold=false,likes=0,published=ago(10),size='Medium',material='Piel',color='Negro'}={})=>({id:String(id),url:`https://es.vestiairecollective.com/x-${id}.shtml`,photo:`https://img.example/${id}.jpg`,model:'Lady Dior',size,material,color,condition:'Muy buen estado',price_eur:price,sold,sold_price_eur:sold?price:null,likes,published});

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
// watch:true → camino de relojes (el de siempre); watch:false → embudo de bolsos.
function harness({screen,photo,extraRows=[],extra={},landed=1000,colour=null,liveOn=true,watch=true,visual=null,audit=null,sheet=null}){
  const sheetRows=sheet||[ref(71,2000,{sold:true,likes:40}),ref(72,2100),ref(73,1900),ref(74,800,{size:'Mini'}),...extraRows];
  const liveRows=[{...ref(81,2200),sold:false},{...ref(82,2300),sold:true}];
  const stored=[],prompts=[];
  const ctx=vm.createContext({console,Number,String,JSON,Math,Date,Array,Object,Set,Map,Promise,Buffer,AbortSignal,process:{env:{}},
    MATCH_VERSION,refCandidates,refTable,refValue,priceFromRefs,combinePrices,decideFromNumbers,compWeight,descTokens,descIndex,descScore,refSheetDoubt,aiTriageModel:()=>'luna',
    db:{prepare:()=>({get:()=>null})},fetch:async()=>{if(watch)throw new Error('sin red');return {ok:true,headers:{get:()=>'image/jpeg'},arrayBuffer:async()=>new ArrayBuffer(10)};},
    vestiaireRefs:()=>({tasks:{'Lady Dior':{source:'sheet',fichas:sheetRows}}}),
    sameModelRows:(tab,rows)=>({key:'lady dior',rows}),isWatchTask:()=>watch,
    vestiaireLiveOn:()=>liveOn,vestiaireTaskQuery:()=>'lady dior',vestiaireLiveQuery:()=>null,
    vestiaireLiveSearchRows:async()=>({status:'ok',model:'Lady Dior',rows:liveRows}),
    importEconomics:()=>({importedTotalEur:landed}),detectMarketplaceVerification:()=>({status:'AVAILABLE'}),
    resalePlatform:()=>({name:'Vestiaire',fee:20}),VESTIAIRE_DEFAULT_REALIZATION:0.92,VESTIAIRE_LIVE_REALIZATION:0.92,
    listingAuction:()=>null,fetchGeminiImageParts:async(it,n)=>watch?[]:Array.from({length:n},()=>({inline_data:{mime_type:'image/jpeg',data:'AA=='}})),aiModel:()=>'m',verifyBudgetLeftUsd:()=>1,
    verifyTierStore:{enterWith(){}},isAiPolicyFlag:()=>false,vestiaireSheetFresh:()=>true,roundMoney:n=>Math.round(n*100)/100,
    geminiJsonRequest:async({parts,purpose})=>{
      const text=parts.filter(p=>typeof p.text==='string').map(p=>p.text).join('\n');
      prompts.push({purpose,text});
      const base={brand:'Dior',model:'Lady Dior',size:'Medium',...(colour?{colour}:{}),target_match:true,condition_grade:'Muy buen estado',quality_score:80,authenticity_risk:'LOW',decision_reasons_es:['Medium negro con tarjeta.']};
      if(/LISTING ALREADY IDENTIFIED/.test(text))return {data:{...base,base_same:[],base_similar:[],...extra}};
      if(/first visual filter/.test(text))return {data:{scores:visual?visual(text):{}}};
      if(/final auditor/.test(text))return {data:{verdicts:audit?audit(text):{}}};
      if(/reference checker/.test(text))return {data:{...base,...photo}};
      return {data:{...base,...screen}};
    },
    storeTaskAnalysis:(...args)=>stored.push(args)});
  vm.runInContext(extract('const VESTIAIRE_SIZE_RE=','// ── FIN DE TALLAS Y COLORES ──'),ctx);
  vm.runInContext(extract('const REF_MAX_BASE=','async function analyzeWithGemini('),ctx);
  const run=()=>ctx.analyzeByReferences({key:'k',item:{id:1,source:'xianyu',title:'Lady Dior medium',description:''},task:{task_name:'Lady Dior',product_query:'Lady Dior',notify_min_profit_eur:200},
    taskId:5,analyzeImages:true,reportProgress:()=>{},negotiated:false});
  return {run,stored,prompts};
}
test('análisis: la IA preselecciona por texto y solo cuentan las comprobadas con foto',async()=>{
  const h=harness({screen:{base_same:['B1','B2'],base_similar:['B3','B4'],vestiaire_same:['V1','V2']},
    photo:{same:['B1','B2','B3','V1','V2'],not_same:{B4:'Es un Mini'}}});
  const a=await h.run();
  assert.equal(h.prompts.length,2);
  assert.equal(h.prompts[1].purpose,'verify');
  assert.match(h.prompts[0].text,/NOT TO PRICE/);
  assert.doesNotMatch(h.prompts[0].text,/B4 \| Lady Dior \| Mini/);   // el título dice medium: la Mini no se compara
  assert.match(h.prompts[1].text,/reference checker/);
  assert.match(h.prompts[1].text,/\(NO PHOTO\)/);
  assert.ok(['BUY','STRONG BUY'].includes(a.decision),a.decision);
  const v=h.stored[0][4];
  assert.equal(v.market.match_version,MATCH_VERSION);
  assert.equal(v.market.sheet_comps.n,3);                 // B4 (Mini) fuera por la foto
  assert.equal(v.market.candidates.vestiaire,0);           // Vestiaire en directo eliminado
  assert.equal(JSON.stringify(v.market.photo_check.not_same),JSON.stringify({B4:'Es un Mini'}));
  assert.equal(a.resale_estimate_market_verified,true);
});
test('análisis: si la foto no confirma ninguna, no hay precio ni referencias (nada orientativo)',async()=>{
  const h=harness({screen:{base_same:['B1'],base_similar:['B2','B3'],vestiaire_same:[]},photo:{same:[],not_same:{B1:'Otra talla'}}});
  const a=await h.run();
  assert.equal(h.prompts.length,2);
  assert.equal(a.decision,'REVIEW');
  const v=h.stored[0][4];
  assert.equal(v.market.sheet_comps,null);
  assert.equal(v.market.vestiaire_blend,null);
  assert.equal(a.resale_mean_eur,null);
});
test('análisis: lo que solo coincide por texto no cuenta si la comprobación con fotos falla',async()=>{
  const h=harness({screen:{base_same:['B1','B2','B3'],vestiaire_same:['V1']},photo:{}});
  const ctxFail=h; // la segunda llamada devuelve sin "same"
  const a=await ctxFail.run();
  assert.equal(a.resale_mean_eur,null);
  assert.notEqual(a.decision,'BUY');
});
test('hoja: foto y enlace de las fórmulas; "Eliminado (sin precio)" no es una venta; "Referencia errónea" fuera',()=>{
  const ctx=vm.createContext({Number,String,Math,Object,Array,RegExp});
  vm.runInContext(extract('function sheetNumber(','async function loadVestiaireSheet('),ctx);
  const head=['Foto','Marca','Likes','Referencia','Talla / tipo','Medidas (cm)','Material','Color','Estado','Precio €','Precio antes €','Rebaja %','País','Vintage','We Love','Publicado','Notas','Vendedor','Perfil vendedor','Enlace','Estado anuncio','Comprobado el','Precio venta €'];
  const row=(id,status,sold='')=>{const r=Array(23).fill('');r[1]='Saint Laurent';r[3]=id;r[4]='Le 5 à 7';r[9]=1200;r[19]='Ver anuncio';r[20]=status;r[22]=sold;return r;};
  const values=[head,row('73042958','Vendido','Eliminado (sin precio)'),row('73066885','Operativo'),row('72301813','Referencia errónea'),row('73078626','Vendido',1100),row('49547258','Vendido','')];
  const f=r=>{const x=Array(23).fill('');x[0]=`=IMAGE("https://drive.google.com/uc?export=view&id=F${r}";4;108;144)`;x[19]=`=HYPERLINK("https://es.vestiairecollective.com/${r}.shtml";"Ver anuncio")`;return x;};
  const formulas=[head,f('73042958'),f('73066885'),f('72301813'),f('73078626'),f('49547258')];
  const t=ctx.vestiaireSheetTab(values,'2026-11-07',formulas);
  const by=Object.fromEntries(t.fichas.map(x=>[x.id,x]));
  assert.equal(by['72301813'],undefined);
  assert.equal(by['73042958'].sold,false);
  assert.equal(by['73042958'].removed,true);
  assert.equal(by['73078626'].sold,true);
  assert.equal(by['73078626'].sold_price_eur,1100);
  assert.equal(by['49547258'].sold,false);               // vendido sin precio: no es venta confirmada
  assert.equal(by['49547258'].removed,true);
  assert.equal(by['73066885'].photo,'https://drive.google.com/uc?export=view&id=F73066885');
  assert.equal(by['73066885'].url,'https://es.vestiairecollective.com/73066885.shtml');
});
test('precio realista: la media o la mediana, la más baja; el beneficio sale de ahí',()=>{
  const cands=refCandidates([ref(1,1000),ref(2,1050),ref(3,1100),ref(4,3000)]);
  const p=priceFromRefs(cands,cands.map(r=>r._code),{ratio:1});
  assert.ok(p.mean>p.mid,`${p.mean} ${p.mid}`);           // la de 3000 sube la media
  assert.equal(p.realistic,p.mid);
  const d=decideFromNumbers({price:p,landed:500,feePct:20,quality:80});
  assert.equal(d.clean,Math.round(p.mid*0.8-500));
});
test('oferta al vendedor de Xianyu: abre por debajo y nunca pasa del máximo rentable',()=>{
  const ctx=vm.createContext({Number,String,Math,process:{env:{}},resalePlatform:()=>({fee:20}),
    importEconomics:it=>({importedTotalEur:1.3*it.price_eur+65}),eur0:n=>`${Math.round(n)} €`,htmlEsc:s=>String(s)});
  vm.runInContext(extract('function sellerOfferPlan(','function instantAlertText('),ctx);
  const x={source:'xianyu',price_eur:800,original_price:6400,model:'Lady Dior'};
  const v={final:{resale_mean_eur:2000,flaws_zh:'四角轻微磨损'}};
  const o=ctx.sellerOfferPlan(x,v);
  assert.equal(o.maxCny,6400);                       // rentable incluso a lo que pide
  assert.equal(o.openCny,5400);                      // 15 % menos, redondeado a 50
  assert.match(o.msg,/5400元可以吗/);
  assert.match(o.msg,/四角轻微磨损/);
  const tight=ctx.sellerOfferPlan({...x,price_eur:1100,original_price:8800},v);
  assert.ok(tight.maxCny<8800&&tight.profitMax>=200,JSON.stringify(tight));
  assert.ok(tight.openCny<tight.maxCny);
  assert.equal(ctx.sellerOfferPlan({...x,source:'mercari-jp'},v),null);
});

test('análisis: el bot elige las de la misma talla en toda la base (aunque estén más allá de las 80 que más pesan) y la foto confirma',async()=>{
  const many=Array.from({length:100},(_,i)=>ref(200+i,3000,{likes:0,size:i===95?'Medium':'Large'}));
  const h=harness({extraRows:many,screen:{base_same:[],base_similar:[]},photo:{same:['B100']}});
  const a=await h.run();
  assert.ok(!h.prompts.some(p=>/LISTING ALREADY IDENTIFIED/.test(p.text)),'sin tandas extra de texto');
  const v=h.stored[0][4];
  assert.ok(v.market.photo_check.checked.includes('B100'));
  assert.ok(v.market.photo_check.checked.length<=12);
  const check=h.prompts.find(p=>/reference checker/.test(p.text)).text;
  assert.doesNotMatch(check,/\| Large \|/);            // ninguna de otra talla
  assert.ok(a.resale_mean_eur>0);
});
test('selección: las del mismo color van delante y entran en la comprobación aunque pesen menos',async()=>{
  const blacks=Array.from({length:20},(_,i)=>ref(300+i,2000,{likes:50,sold:true}));
  const h=harness({colour:'Rojo',extraRows:[...blacks,ref(399,2100,{likes:0,color:'Rojo'})],screen:{base_same:[],base_similar:[]},photo:{same:[]}});
  await h.run();
  const v=h.stored[0][4];
  const checked=v.market.photo_check.checked;
  const check=h.prompts.find(p=>/reference checker/.test(p.text)).text;
  const firstRef=check.split('REFERENCES')[1].match(/\n?(B\d+) \|[^\n]*\| Rojo \|/);
  assert.ok(firstRef,'la roja está en la comprobación');
  assert.equal(checked[0],firstRef[1]);                   // y va la primera
  assert.ok(checked.length<=12);
});
test('precio orientativo de la IA: se usa, pero nunca fuera de lo que dicen las referencias iguales',async()=>{
  const h=harness({screen:{base_same:['B1','B2'],base_similar:[]},photo:{same:['B1','B2','B3'],price_eur:99999,price_reason_es:'Como las vendidas'}});
  const a=await h.run();
  assert.ok(a.resale_mean_eur<=2100,a.resale_mean_eur);   // tope: la referencia más cara
  const low=harness({screen:{base_same:['B1'],base_similar:[]},photo:{same:['B1','B2','B3'],price_eur:1600,price_reason_es:'Peor estado'}});
  const b=await low.run();
  assert.equal(b.resale_mean_eur,1600);                    // dentro del rango: el de la IA
  assert.match(b.decision_reasons_es.join(' '),/Peor estado/);
});
test('Vestiaire en directo apagado: solo la base, sin buscar en Vestiaire ni nombrarlo',async()=>{
  const h=harness({liveOn:false,screen:{base_same:[],base_similar:[],vestiaire_same:[]},photo:{same:[]}});
  const a=await h.run();
  const v=h.stored[0][4];
  assert.equal(v.market.candidates.vestiaire,0);
  assert.ok(!h.prompts.some(p=>/\nV1 \|/.test(p.text)));
  assert.doesNotMatch(a.decision_reasons_es[0],/Vestiaire/);
});
test('análisis: sin ninguna igual y buen anuncio → interesante sin pronóstico',async()=>{
  const h=harness({screen:{base_same:[],base_similar:[],vestiaire_same:[]},photo:{}});
  const a=await h.run();
  assert.equal(a.decision,'REVIEW');
  assert.equal(a.resale_mean_eur,null);
  assert.equal(a.no_refs_interesting,true);
  assert.match(a.decision_reasons_es[0],/sin pronóstico/);
});
test('análisis: aunque la primera lectura no elija ninguna, las más parecidas de la base pasan por la foto y se usa la igual',async()=>{
  const h=harness({screen:{base_same:[],base_similar:[],vestiaire_same:[]},photo:{same:['B2']}});
  const a=await h.run();
  const checks=h.prompts.filter(p=>/reference checker/.test(p.text));
  assert.equal(checks.length,1);
  assert.equal(checks[0].purpose,'verify');                 // siempre con el modelo bueno
  assert.match(checks[0].text,/B2 \| Lady Dior/);
  const v=h.stored[0][4];
  assert.equal(JSON.stringify(v.market.photo_check.same),JSON.stringify(['B2']));
  assert.ok(a.resale_mean_eur>0);
  assert.equal(a.no_refs_interesting,false);
});
test('análisis: con posibles iguales pero sin beneficio ni contándolas todas → descartado, no "sin referencias"',async()=>{
  const h=harness({landed:3000,screen:{base_same:['B1'],base_similar:['B2','B3'],vestiaire_same:['V1']},photo:{same:['B1']}});
  const a=await h.run();
  assert.equal(a.decision,'REJECT');
  assert.equal(a.no_refs_interesting,false);
  assert.match(a.decision_reasons_es[0],/Ni contando/);
  assert.equal(h.prompts.filter(p=>/reference checker/.test(p.text)).length,0);
});
test('One Map: la lista interna da id, puja, pujas y fin (hora de Japón)',async()=>{
  const {oneMapJsonCards}=await import('../scripts/onemap-auctions.mjs');
  const c=oneMapJsonCards([{id:'h1230300848',title:'CHANEL bag',price:79700,bids:2,endTime:'2026/11/07 21:28:40',buyItNowPrice:0,imageUrl:'x'},{id:'bad',title:'',price:0,endTime:'x'}],Date.parse('2026-11-07T11:00:00Z'));
  assert.equal(c.length,1);
  assert.equal(c[0].endsAt,'2026-11-07T12:28:40.000Z');
  assert.equal(c[0].timeLeftMs,88*60e3+40e3);
  assert.equal(c[0].url,'https://www.fromjapan.co.jp/japan/en/auction/yahoo/input/h1230300848');
});

// EMBUDO DE BOLSOS (regla de Nil, 08-11-2026)
const codesIn=t=>[...t.matchAll(/^(B\d+) \| /gm)].map(m=>m[1]);
const bagRows=n=>Array.from({length:n},(_,i)=>({...ref(1000+i,2000+i),desc:`Dior Lady Dior Medium · cuero · negro · Cannage · ${i<5?'charms rojos':'herrajes dorados'}`}));
const allKeep=t=>Object.fromEntries(codesIn(t).map(c=>[c,90]));
test('descripción: lo raro pesa más y se entienden los sinónimos',()=>{
  const rows=[{desc:'Lady Dior · piel · negro · herrajes dorados'},{desc:'Lady Dior · cuero · negro · charms rojos'},{desc:'Lady Dior · cuero · negro · herrajes dorados'}];
  const idx=descIndex(rows),q=descTokens('Lady Dior · leather · negro · charms rojos');
  assert.ok(descScore(idx,q,rows[1])>descScore(idx,q,rows[0]));
  assert.ok(descTokens('piel de becerro').has('cuero'));
  assert.ok(!descTokens('cuero (tipo sin confirmar)').has('confirmar'));
});
test('la hoja duda del modelo: fuera; si solo duda del color, sigue',()=>{
  assert.equal(refSheetDoubt({desc:'Chanel · negro · modelo a revisar'}),true);
  assert.equal(refSheetDoubt({desc:'Gucci · beige · material a revisar: la foto parece lona'}),true);
  assert.equal(refSheetDoubt({desc:'YSL · azul · color a revisar'}),false);
});
test('bolsos: 100 por descripción, todas pasan por imagen y la primera lectura no ve referencias',async()=>{
  const h=harness({watch:false,sheet:bagRows(140),screen:{description_es:'Dior Lady Dior Medium · cuero · negro · Cannage · charms rojos'},visual:allKeep,
    photo:{same:['B1'],confidence:{B1:99},listing_model_confidence:99,price_eur:2000},audit:t=>Object.fromEntries(codesIn(t).map(c=>[c,{same:true,confidence:99}]))});
  await h.run();
  const vis=h.prompts.filter(p=>/first visual filter/.test(p.text));
  assert.equal(vis.length,4);                                         // tandas de 25
  assert.equal(new Set(vis.flatMap(p=>codesIn(p.text))).size,100);
  assert.doesNotMatch(h.prompts[0].text,/REFERENCES/);
  const v=h.stored[0][4].market.photo_check;
  assert.equal(v.visual.retrieved,100);assert.equal(v.checked.length,20);
});
test('bolsos: las de la descripción más parecida entran las primeras en el check',async()=>{
  const h=harness({watch:false,sheet:bagRows(140),screen:{description_es:'Dior Lady Dior Medium · cuero · negro · Cannage · charms rojos'},visual:allKeep,photo:{same:[]}});
  await h.run();
  const first=h.prompts.find(p=>/first visual filter/.test(p.text));
  assert.equal((first.text.match(/charms rojos/g)||[]).length>=6,true);   // 5 fichas + lo identificado
  assert.match(first.text.split('REFERENCES:')[1].slice(0,200),/charms rojos/);
});
test('bolsos: solo cuenta lo que supera el check estricto y la segunda comprobación',async()=>{
  const sheet=bagRows(8);
  const h=harness({watch:false,sheet,landed:500,screen:{description_es:'Dior Lady Dior Medium'},visual:allKeep,
    photo:{same:['B1','B2','B3','B4'],confidence:{B1:99,B2:99,B3:99,B4:90},listing_model_confidence:99,price_eur:2000},
    audit:()=>({B1:{same:true,confidence:99},B2:{same:false,confidence:99,difference_es:'Otra talla'},B3:{same:true,confidence:80}})});
  await h.run();
  const v=h.stored[0][4].market;
  assert.deepEqual([...v.photo_check.first_same],['B1','B2','B3']);        // B4: 90 % de seguridad
  assert.deepEqual([...v.photo_check.same],['B1']);                        // B2 desmentida; B3 sin seguridad
  assert.equal(v.sheet_comps.n,1);
});
test('bolsos: si la IA no está segura del modelo del anuncio, no hay referencias ni precio',async()=>{
  const h=harness({watch:false,sheet:bagRows(8),landed:500,screen:{description_es:'Dior Lady Dior'},visual:allKeep,
    photo:{same:['B1'],confidence:{B1:99},listing_model_confidence:80,price_eur:2000}});
  const a=await h.run();
  assert.equal(a.resale_mean_eur,null);
  assert.equal(h.prompts.some(p=>/final auditor/.test(p.text)),false);
});
test('bolsos: una ficha que no se pudo mirar con imagen no llega a confirmarse',async()=>{
  const h=harness({watch:false,sheet:bagRows(8),landed:500,screen:{description_es:'Dior Lady Dior'},visual:()=>({}),photo:{same:['B1'],confidence:{B1:99},listing_model_confidence:99}});
  const a=await h.run();
  assert.equal(a.resale_mean_eur,null);
  assert.equal(h.prompts.some(p=>/reference checker/.test(p.text)),false);
});

test('Xianyu: la pausa tras una verificación se guarda y dura 4 h entre ejecuciones',()=>{
  const store={};
  const ctx=vm.createContext({Number,Math,Date,String,process:{env:{}},getSetting:(k,f)=>k in store?store[k]:f,saveSetting:(k,v)=>{store[k]=v;}});
  vm.runInContext(`const XIANYU_RISK_PAUSE_MS=4*3600e3;${extract('function xianyuRiskPauseLeftMs(){','function xianyuKnownAccounts(')}`,ctx);
  assert.equal(ctx.xianyuRiskPauseLeftMs(),0);
  ctx.xianyuStartRiskPause();
  const left=ctx.xianyuRiskPauseLeftMs();
  assert.ok(left>3.99*3600e3&&left<=4*3600e3,String(left));
  store.xianyu_risk_pause.until=Date.now()-1;
  assert.equal(ctx.xianyuRiskPauseLeftMs(),0);
});

test('Xianyu: la pausa sube de 4 a 8 y a 24 h si la verificación vuelve enseguida, y vuelve a 4 h tras un descanso largo',()=>{
  const store={};
  const ctx=vm.createContext({Number,Math,Date,String,process:{env:{XIANYU_RISK_PAUSE_HOURS:'4,8,24'}},getSetting:(k,f)=>k in store?store[k]:f,saveSetting:(k,v)=>{store[k]=v;}});
  vm.runInContext(`const XIANYU_RISK_PAUSE_MS=4*3600e3;${extract('function xianyuRiskPauseLeftMs(){','function xianyuKnownAccounts(')}`,ctx);
  assert.equal(ctx.xianyuStartRiskPause(),4);
  store.xianyu_risk_pause.until=Date.now()-3600e3;           // acabó hace 1 h y vuelve la verificación
  assert.equal(ctx.xianyuStartRiskPause(),8);
  store.xianyu_risk_pause.until=Date.now()-3600e3;
  assert.equal(ctx.xianyuStartRiskPause(),24);
  store.xianyu_risk_pause.until=Date.now()-3600e3;
  assert.equal(ctx.xianyuStartRiskPause(),24);               // tope
  store.xianyu_risk_pause.until=Date.now()-7*3600e3;         // lleva 7 h sin problemas
  assert.equal(ctx.xianyuStartRiskPause(),4);
});

// XIANYU DESDE EL CHROME DEL MAC
function macHarness({mode='prefer',ready=true,reply,hold=0}){
  const store={};if(hold)store.xianyu_mac_hold={until:Date.now()+hold};
  const calls=[];
  const ctx=vm.createContext({Number,Math,Date,String,JSON,Promise,process:{env:{XIANYU_VIA_MAC:mode,ONEMAP_MAC_BRIDGE_TOKEN:'t'.repeat(40)}},
    getSetting:(k,f)=>k in store?store[k]:f,saveSetting:(k,v)=>{store[k]=v;},
    macOneMapReady:async()=>ready,macXianyuSearch:async(...a)=>{calls.push(a);if(reply instanceof Error)throw reply;return reply;},
    XIANYU_RISK_RE:/RGV587|punish/i,xianyuRiskIn:j=>/RGV587/.test(JSON.stringify(j||'')),xianyuAuthIn:j=>/SESSION_EXPIRED/.test(JSON.stringify(j||'')),
    parseXianyuSearchJson:j=>j.data.resultList});
  vm.runInContext(extract('const xianyuMacMode=','async function searchXianyuDirect('),ctx);
  return {ctx,store,calls};
}
test('Xianyu en el Mac: una búsqueda buena devuelve los anuncios',async()=>{
  const h=macHarness({reply:{finalUrl:'https://www.goofish.com/search?q=x',text:JSON.stringify({data:{resultList:[1,2,3]}}),sorted:true,priced:true}});
  const r=await h.ctx.xianyuTryMac('迪奥',{minCny:100,maxCny:900});
  assert.equal(r.used,true);assert.deepEqual([...r.res.items],[1,2,3]);assert.equal(r.res.sorted,true);
  assert.equal(h.calls[0][1].maxCny,900);
});
test('Xianyu en el Mac: una verificación frena 10 min y no se cae al servidor',async()=>{
  const h=macHarness({reply:{finalUrl:'https://www.goofish.com/punish?x',blocked:'risk',text:null}});
  const r=await h.ctx.xianyuTryMac('x',{});
  assert.equal(r.used,true);assert.equal(r.res.macRisk,true);
  const again=await h.ctx.xianyuTryMac('x',{});
  assert.equal(again.used,false);assert.equal(again.hold,true);
  assert.equal(h.calls.length,1);                        // la segunda ni llega al Mac
});
test('Xianyu en el Mac: Mac desconectado → no se usa (el bot decide si cae al servidor); modo apagado no toca el Mac',async()=>{
  const off=macHarness({ready:false,reply:{}});
  const r=await off.ctx.xianyuTryMac('x',{});
  assert.equal(r.used,false);assert.match(r.reason,/no está conectado/);
  const apagado=macHarness({mode:'off',reply:{}});
  assert.equal((await apagado.ctx.xianyuTryMac('x',{})).reason,'desactivado');
  const caido=macHarness({reply:new Error('timeout')});
  const c=await caido.ctx.xianyuTryMac('x',{});
  assert.equal(c.used,false);assert.match(c.reason,/no respondió/);
});
test('Xianyu en el Mac: la pausa del servidor no frena al Mac; con el Mac caído o en espera, sí',async()=>{
  assert.equal(await macHarness({reply:{}}).ctx.xianyuMacUsable(),true);
  assert.equal(await macHarness({ready:false,reply:{}}).ctx.xianyuMacUsable(),false);
  assert.equal(await macHarness({mode:'off',reply:{}}).ctx.xianyuMacUsable(),false);
  assert.equal(await macHarness({hold:5*60e3,reply:{}}).ctx.xianyuMacUsable(),false);
});
test('Xianyu en el Mac: sin sesión en su Chrome → no se usa y se avisa',async()=>{
  const h=macHarness({reply:{finalUrl:'https://www.goofish.com/login',login:true,text:null}});
  const r=await h.ctx.xianyuTryMac('x',{});
  assert.equal(r.used,false);assert.equal(r.login,true);
});

// REPARTO MAC / NUBE (XIANYU_VIA_MAC=split)
function splitHarness(share='50'){
  const store={};
  const ctx=vm.createContext({Number,Math,Date,String,JSON,Promise,process:{env:{XIANYU_VIA_MAC:'split',XIANYU_MAC_SHARE:share,ONEMAP_MAC_BRIDGE_TOKEN:'t'.repeat(40)}},
    getSetting:(k,f)=>k in store?store[k]:f,saveSetting:(k,v)=>{store[k]=v;},macOneMapReady:async()=>true});
  vm.runInContext(extract('const xianyuMacMode=','async function searchXianyuDirect('),ctx);
  return {ctx,store};
}
test('Reparto Mac/nube: el modo split se acepta y el reparto es exacto (50 %, 100 %, 0 %, 30 %)',()=>{
  const h=splitHarness();
  assert.equal(vm.runInContext('xianyuMacMode()',h.ctx),'split');
  const count=share=>{let mac=0;for(let n=0;n<100;n++)if(h.ctx.xianyuSplitPick(n,share)==='mac')mac++;return mac;};
  assert.equal(count(50),50);assert.equal(count(100),100);assert.equal(count(0),0);assert.equal(count(30),30);
  const seq=[0,1,2,3,4,5].map(n=>h.ctx.xianyuSplitPick(n,50));
  assert.deepEqual(seq,['cloud','mac','cloud','mac','cloud','mac']);         // se turnan, no salen rachas
});
test('Reparto Mac/nube: el contador se guarda entre ejecuciones y respeta XIANYU_MAC_SHARE',()=>{
  const h=splitHarness('50');
  const turns=Array.from({length:6},()=>h.ctx.xianyuSplitTurn());
  assert.deepEqual(turns,['cloud','mac','cloud','mac','cloud','mac']);
  assert.equal(h.store.xianyu_split.n,6);
  const otra=splitHarness('25');
  const t25=Array.from({length:100},()=>otra.ctx.xianyuSplitTurn());
  assert.equal(t25.filter(x=>x==='mac').length,25);
  assert.equal(vm.runInContext('xianyuSplitShare()',splitHarness('abc').ctx),50);                // valor raro → 50 %
  assert.equal(vm.runInContext('xianyuSplitShare()',splitHarness('150').ctx),100);
});
test('Reparto Mac/nube: ordenador apagado → todo a la nube; una vía parada → la otra hace todo; Mac en espera → su turno se salta',()=>{
  const {ctx}=splitHarness();
  let gastados=0;
  const turn=t=>()=>{gastados++;return t;};
  const d=(o,t='mac')=>ctx.xianyuSplitDecide({macReady:true,macHold:false,cloudBlocked:false,...o,turn:turn(t)});
  assert.equal(d({macReady:false},'mac'),'cloud');                            // Mac apagado: 100 % nube
  assert.equal(gastados,0);                                                   // y no se gasta turno
  assert.equal(d({macReady:false,cloudBlocked:true}),'none');                 // todo parado
  assert.equal(d({cloudBlocked:true},'cloud'),'mac');                         // nube parada: todo al Mac
  assert.equal(d({cloudBlocked:true,macReady:false,macHold:true}),'wait');    // nube parada y Mac esperando
  assert.equal(d({},'mac'),'mac');assert.equal(d({},'cloud'),'cloud');        // los dos libres: manda el turno
  assert.equal(d({macReady:false,macHold:true},'mac'),'wait');                // verificación pendiente: se salta
  assert.equal(d({macReady:false,macHold:true},'cloud'),'cloud');            // pero la nube sigue con su turno
});

// TODOS LOS ANUNCIOS NUEVOS DE XIANYU A TELEGRAM
function feedHarness({env={},already=new Set(),feedback={}}={}){
  const sent=[],marks=[];
  const ctx=vm.createContext({JSON,Date,Number,String,Math,Set,Promise,console,process:{env},
    xianyuListingHasVerificationTag,
    htmlEsc:s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;'),
    ALERT_DECISION_ES:{'STRONG BUY':'COMPRA MUY RECOMENDADA',BUY:'COMPRA RECOMENDADA',WATCH:'VIGILAR',REJECT:'DESCARTAR',REVIEW:'REVISAR'},
    alertMoney:x=>`¥${x.original_price} (≈ ${Math.round(x.price_eur)} €)`,alertAgo:()=>'hace 12 min',listingPublishedAtMs:()=>Date.now(),alertLink:x=>`🔗 ${x.url}`,
    instantAlertText:x=>`<b>🔥 COMPRA</b> · ${x._task_name}\nLady Dior · 1.000 €\n🔗 ${x.url}`,
    telegramConfigured:()=>true,telegramSend:async(text,photo,opts)=>{sent.push({text,photo,opts});return {sent:true};},
    listingTelegramImages:x=>x.image_url?[x.image_url]:[],alertButtons:id=>[[{callback_data:`ok:${id}`}]],
    listingFeedback:id=>feedback[id]||null,listingRepeatCount:id=>({10:2})[id]||0,sleep:async()=>{},
    db:{prepare:sql=>/SELECT 1 FROM notifications/.test(sql)?{get:id=>already.has(id)?{1:1}:undefined}:{run:(...a)=>marks.push(a)}}});
  vm.runInContext(extract('const FEED_NO_CODES','async function sendInstantAlerts('),ctx);
  return {ctx,sent,marks};
}
const feedItem=(id,{credit='卖家信用极好',tag='验货宝',decision=null,verification={},price=900,age=0,extra={}}={})=>({
  id,source:'xianyu',url:`https://www.goofish.com/item?id=${id}`,title:`戴妃包 ${id} 感兴趣的话点“我想要”`,price_eur:price,original_price:price*7.8,currency:'CNY',
  first_seen:new Date(Date.now()-age*60e3).toISOString(),decision,opportunity_score:decision?70:null,verification_json:JSON.stringify(verification),
  raw_json:JSON.stringify({'商品信息':{'商品标签':[tag,credit].filter(Boolean)}}),image_url:'https://img.example/a.jpg',...extra});
test('feed Xianyu: solo vendedor de crédito máximo con 验货宝; sin ellos no sale',()=>{
  const {ctx}=feedHarness();
  assert.equal(ctx.xianyuFeedEligible(feedItem(1)),true);
  assert.equal(ctx.xianyuFeedEligible(feedItem(2,{credit:'卖家信用优秀'})),false);
  assert.equal(ctx.xianyuFeedEligible(feedItem(3,{tag:null})),false);
  assert.equal(ctx.xianyuFeedEligible({...feedItem(4),source:'mercari-jp'}),false);
  assert.equal(ctx.xianyuFeedEligible(feedItem(5,{verification:{prescreen:{code:'counterfeit_title'}}})),false);
  assert.equal(ctx.xianyuFeedEligible(feedItem(6,{verification:{prescreen:{code:'price_ceiling'}}})),true);   // caro, pero se avisa
  assert.equal(ctx.xianyuFeedEligible(feedItem(7,{extra:{authenticity_risk:'HIGH'}})),false);
});
test('feed Xianyu: envía todos los nuevos, marca los interesantes y no repite',async()=>{
  const h=feedHarness({already:new Set([13]),feedback:{14:'not_interested'}});
  const items=[feedItem(10),feedItem(11,{decision:'WATCH'}),feedItem(12,{decision:'REJECT'}),feedItem(13),feedItem(14),feedItem(15,{credit:'卖家信用优秀'}),feedItem(16,{age:600})];
  const r=await h.ctx.sendXianyuFeed({id:1,task_name:'Lady Dior'},5,items);
  assert.equal(r.sent,3);                                   // 10, 11 y 12; 13 ya avisado, 14 descartado, 15 sin crédito, 16 viejo
  const texts=h.sent.map(x=>x.text);
  assert.match(texts[0],/⭐ INTERESANTE · IA: VIGILAR/);       // los interesantes, primero y marcados
  assert.match(texts[1],/🆕 NUEVO/);assert.doesNotMatch(texts[1],/INTERESANTE/);
  assert.match(texts[1],/验货宝 · vendedor 信用极好/);
  assert.match(texts[1],/🔁 Mismo anuncio de 2 vendedores más/);       // el 10 tiene 2 repetidos apartados
  assert.doesNotMatch(texts[1],/感兴趣/);                       // sin la coletilla de Xianyu
  assert.equal(h.sent[0].photo,'https://img.example/a.jpg');
  assert.equal(h.marks.length,3);
});
test('feed Xianyu: apagado, sin Telegram y tope por ejecución',async()=>{
  const off=feedHarness({env:{XIANYU_FEED:'off'}});
  assert.equal((await off.ctx.sendXianyuFeed({id:1,task_name:'x'},1,[feedItem(1)])).reason,'disabled');
  const cap=feedHarness({env:{XIANYU_FEED_MAX_PER_RUN:'2'}});
  const r=await cap.ctx.sendXianyuFeed({id:1,task_name:'x'},1,[feedItem(1),feedItem(2),feedItem(3)]);
  assert.equal(r.sent,2);assert.equal(r.pending,1);
});

// REPETIDOS DE OTROS VENDEDORES
function dedupeHarness(env={}){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE listing_fingerprints(fp TEXT PRIMARY KEY,listing_id INTEGER NOT NULL,first_seen TEXT NOT NULL,dup_count INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE listing_fingerprint_dups(listing_id INTEGER PRIMARY KEY,fp TEXT NOT NULL);
    CREATE TABLE search_session_items(session_id TEXT,listing_id INTEGER,source_query TEXT,PRIMARY KEY(session_id,listing_id));`);
  const ctx=vm.createContext({String,Number,Math,Date,Set,createHash,db,process:{env}});
  vm.runInContext(extract('function listingFingerprint(','// ── TODOS LOS ANUNCIOS NUEVOS DE XIANYU A TELEGRAM'),ctx);
  const inSession=sid=>db.prepare('SELECT listing_id id FROM search_session_items WHERE session_id=? ORDER BY listing_id').all(sid).map(r=>Number(r.id));
  const add=(sid,items)=>{for(const x of items)db.prepare('INSERT OR IGNORE INTO search_session_items(session_id,listing_id) VALUES(?,?)').run(sid,x.id);};
  return {ctx,db,inSession,add};
}
const ad=(id,title,extra={})=>({id,source:'xianyu',title,description:'',...extra});
test('repetidos: mismo título y descripción de otro vendedor → solo se queda el primero',()=>{
  const h=dedupeHarness();
  const items=[ad(1,'Dior迪奥漆皮戴妃五格黑银 感兴趣的话点“我想要”和我私聊吧～',{seller_name:'a'}),
    ad(2,'Dior迪奥漆皮戴妃五格黑银，感兴趣的话点“我想要”和我私聊吧～',{seller_name:'b'}),   // mismo texto con otra puntuación
    ad(3,'Dior迪奥漆皮戴妃五格黑银 全新',{seller_name:'c'}),                                  // otro texto: se queda
    ad(4,'戴妃包')];                                                                          // demasiado corto: no se compara
  h.add('s1',items);
  assert.equal(h.ctx.dropRepeatedListings('s1',items),1);
  assert.deepEqual(h.inSession('s1'),[1,3,4]);
  assert.equal(h.ctx.listingRepeatCount(1),1);
});
test('repetidos: el original gana aunque llegue después en la lista, y no cuenta dos veces al mismo repetido',()=>{
  const h=dedupeHarness();
  const first=[ad(10,'Lady Dior 三格 黑色 金扣 95新 带防尘袋')];
  h.add('s1',first);h.ctx.dropRepeatedListings('s1',first);
  const next=[ad(20,'Lady Dior 三格 黑色 金扣 95新 带防尘袋'),ad(10,'Lady Dior 三格 黑色 金扣 95新 带防尘袋')];
  h.add('s2',next);
  assert.equal(h.ctx.dropRepeatedListings('s2',next),1);
  assert.deepEqual(h.inSession('s2'),[10]);
  h.add('s3',next);h.ctx.dropRepeatedListings('s3',next);   // el mismo repetido otra vez
  assert.equal(h.ctx.listingRepeatCount(10),1);
});
test('repetidos: solo Xianyu y se puede apagar',()=>{
  const h=dedupeHarness({DEDUPE_LISTINGS:'off'});
  const items=[ad(1,'Lady Dior 三格 黑色 金扣 95新 带防尘袋'),ad(2,'Lady Dior 三格 黑色 金扣 95新 带防尘袋')];
  h.add('s',items);
  assert.equal(h.ctx.dropRepeatedListings('s',items),0);
  const on=dedupeHarness();
  const other=[{...items[0],source:'mercari-jp'},{...items[1],source:'mercari-jp'}];
  on.add('s',other);
  assert.equal(on.ctx.dropRepeatedListings('s',other),0);
});

// LIMPIEZA DE LA MEMORIA DEL BOT: lo que Nil marcó con «me interesa» nunca se borra
test('limpieza: los anuncios con ✅ o con aviso propio se quedan; los de «anuncio nuevo» sin más, se borran',()=>{
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE listings(id INTEGER PRIMARY KEY,last_seen TEXT,first_seen TEXT);
    CREATE TABLE notifications(task_id INT,listing_id INT,kind TEXT,sent_at TEXT);
    CREATE TABLE listing_feedback(listing_id INTEGER PRIMARY KEY,action TEXT);
    CREATE TABLE task_analyses(listing_id INT);CREATE TABLE analyses(listing_id INT);CREATE TABLE search_session_items(session_id TEXT,listing_id INT);
    CREATE TABLE search_sessions(id TEXT,started_at TEXT);CREATE TABLE task_runs(started_at TEXT);CREATE TABLE runs(created_at TEXT);
    CREATE TABLE listing_fingerprints(fp TEXT,first_seen TEXT);CREATE TABLE listing_fingerprint_dups(listing_id INT);`);
  const old='2026-10-01T00:00:00Z';
  for(const id of [1,2,3,4,5,6])db.prepare('INSERT INTO listings VALUES(?,?,?)').run(id,old,old);
  db.prepare('INSERT INTO listing_feedback VALUES(1,?)').run('interested');          // ✅ de Telegram
  db.prepare("INSERT INTO notifications VALUES(1,2,'instant',?)").run(old);          // aviso de compra
  db.prepare("INSERT INTO notifications VALUES(1,3,'feed',?)").run(old);             // solo «anuncio nuevo»
  db.prepare("INSERT INTO notifications VALUES(1,4,'global-digest',?)").run(old);    // solo el resumen
  db.prepare("INSERT INTO notifications VALUES(1,5,'feed',?)").run(old);
  db.prepare('INSERT INTO listing_feedback VALUES(5,?)').run('interested');          // «anuncio nuevo» + ✅
  const ctx=vm.createContext({Number,Date,Math,console:{log(){},warn(){},error(){}},db,fs:{statSync(){throw new Error('x');}},DB_PATH:'x',process:{env:{}},
    getSetting:()=>null,saveSetting(){}});
  vm.runInContext(extract('function pruneOldData(){','\n}\n',source.indexOf('function pruneOldData(){'))+'\n}\n',ctx);
  ctx.pruneOldData();
  const left=db.prepare('SELECT id FROM listings ORDER BY id').all().map(r=>Number(r.id));
  assert.deepEqual(left,[1,2,5]);                                                    // 3, 4 y 6 fuera; 1, 2 y 5 se quedan
  assert.equal(Number(db.prepare("SELECT COUNT(*) c FROM notifications WHERE kind='feed' AND listing_id=3").get().c),0);
  assert.equal(Number(db.prepare("SELECT COUNT(*) c FROM notifications WHERE kind='feed' AND listing_id=5").get().c),1);
});

// Enlace de los avisos: el de Xianyu leído desde el Mac trae cientos de caracteres de seguimiento
test('aviso: el enlace web de Xianyu es el limpio y el aviso no se pasa del límite',()=>{
  const ctx=vm.createContext({String,encodeURIComponent,process:{env:{}}});
  vm.runInContext(`${extract('function htmlEsc(','function moneyEmail(')}\n${extract('const APP_BRIDGE_URL','async function telegramSendListing(')}\n${extract('function alertLink(','function instantAlertText(')}`,ctx);
  const dirty='https://www.goofish.com/item?id=1097939614632&referPageArgs=Loewe+Puzzle&gulSource=search&extra='+encodeURIComponent(JSON.stringify({labelIds:'539,919,472',source:'7',search_id:'x'.repeat(60),q:'Loewe Puzzle'})).repeat(4);
  const link=ctx.alertLink({source:'xianyu',source_id:'1097939614632',url:dirty});
  assert.ok(!/referPageArgs|gulSource/.test(link));
  assert.ok(link.length<420,String(link.length));
  assert.equal((link.match(/<a /g)||[]).length,(link.match(/<\/a>/g)||[]).length);
  assert.match(link,/web=https%3A%2F%2Fwww\.goofish\.com%2Fitem%3Fid%3D1097939614632/);
});
