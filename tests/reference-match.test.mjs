import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {refCandidates,refTable,refValue,priceFromRefs,combinePrices,decideFromNumbers,MATCH_VERSION} from '../scripts/reference-match.mjs';
import {compWeight,compStats,weightedQuantile} from '../scripts/vestiaire-bag-match.mjs';
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
  const ctx=vm.createContext({Number,Math,Date,getSetting:(k,f)=>k in store?store[k]:f,saveSetting:(k,v)=>{store[k]=v;}});
  vm.runInContext(`const XIANYU_RISK_PAUSE_MS=4*3600e3;${extract('function xianyuRiskPauseLeftMs(){','function xianyuKnownAccounts(')}`,ctx);
  assert.equal(ctx.xianyuRiskPauseLeftMs(),0);
  ctx.xianyuStartRiskPause();
  const left=ctx.xianyuRiskPauseLeftMs();
  assert.ok(left>3.99*3600e3&&left<=4*3600e3,String(left));
  store.xianyu_risk_pause.until=Date.now()-1;
  assert.equal(ctx.xianyuRiskPauseLeftMs(),0);
});
