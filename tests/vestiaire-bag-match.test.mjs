import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {DatabaseSync} from 'node:sqlite';
import {strictBagComparables,bagDimensions,sameBagDimensions,applyBagSheetPolicy,BAG_SHEET_RULE_VERSION} from '../scripts/vestiaire-bag-match.mjs';

// Representative columns/values read from Nil's live Lady Dior sheet.
const row={id:'71332269',brand:'Dior',size:'Medium',dims:'24x20x11',material:'Piel',color:'Gris',condition:'Buen estado',price_eur:998,sold:false};
const item={title:'Lady Dior medium grey leather 24x20x11 cm',description:''};
const exact={brand:'Dior',family:'Lady Dior',main_color:'grey',material:'leather',size:'Medium',confidence:.95,condition:{grade:'GOOD',confidence:.9},target_match:true};
const match=(rows=[row],target=item,identity=exact)=>strictBagComparables([{tab:'Lady Dior',rows}],target,identity);

test('a single identical row is used before multiple alternative colours',()=>{
  const c=match([row,...Array.from({length:8},(_,i)=>({...row,id:String(i),color:'Negro',price_eur:4000}))]);
  assert.equal(c.n,1);assert.equal(c.tier,'iguales');assert.equal(c.low,918);assert.equal(c.buy_eligible,true);
  assert.equal(c.ratio_source,'assumption');
});
test('only colour may change, never dimensions, material or known condition',()=>{
  const c=match([{...row,color:'Negro'}]);
  assert.equal(c.tier,'misma_talla');assert.equal(c.n,1);
  for(const change of [{dims:'24x16x11'},{dims:'24x20x6'},{dims:'20x17x6',size:'Medium'},{material:'Nailon'},{material:'Charol'},{condition:'Sin usar'}]){
    assert.equal(match([{...row,...change}]),null,JSON.stringify(change));
  }
});
test('all dimensions, unit, ambiguity and missing axes are checked',()=>{
  assert.deepEqual(bagDimensions('23,5 × 16 × 8,5 cm'),[8.5,16,23.5]);
  assert.equal(sameBagDimensions(bagDimensions('24x20x11'),bagDimensions('11x24.5x20')),true);
  assert.equal(match([row],{...item,title:'Lady Dior Medium grey leather'}),null);
  for(const dims of ['24x20','24x20x11 inches','24x20x11 mm','24x20x11 or 20x17x6','125x20x11'])assert.equal(match([row],{...item,title:`Lady Dior ${dims}`}),null,dims);
});
test('same label cannot override incompatible measurements; micro is not mini',()=>{
  assert.equal(match([{...row,size:'Mini'}],item,{...exact,size:'Micro'}),null);
  assert.equal(match([{...row,dims:'25x20x11',size:'Medium'}]),null);
});
test('two-axis references remain usable for research but cannot establish identical full dimensions for BUY',()=>{
  const c=match([{...row,dims:'24x20'}],{...item,title:'Lady Dior medium grey leather 24x20 cm'});
  assert.equal(c.n,1);assert.equal(c.buy_eligible,false);
});
test('unknown colour/material/condition and low visual confidence fail closed',()=>{
  assert.equal(match([row],{title:'Lady Dior 24x20x11'}, {...exact,main_color:'unknown'}),null);
  assert.equal(match([{...row,color:''}]),null);
  assert.equal(match([{...row,material:''}]),null);
  assert.equal(match([row],item,{...exact,condition:{grade:'UNKNOWN',confidence:0}}).buy_eligible,false);
  assert.equal(match([row],item,{...exact,confidence:.4}).buy_eligible,false);
});
test('wrong model, explicit Modelo and brand do not inherit the tab model',()=>{
  assert.equal(match([{...row,model:'Bobby'}]),null);
  assert.equal(match([{...row,size:'Lady D-Joy'}]),null);
  assert.equal(match([{...row,brand:'Chanel'}]),null);
});
test('known finishes, pattern and hardware conflicts are excluded; missing details cannot authorize BUY',()=>{
  assert.equal(match([{...row,notes:'Piel de cordero'}],item,{...exact,material:'caviar leather'}),null);
  assert.equal(match([{...row,notes:'Dior Oblique'}],item,{...exact,pattern:'cannage'}),null);
  assert.equal(match([{...row,notes:'herrajes plateados'}],item,{...exact,hardware:'gold'}),null);
  assert.equal(match([row],item,{...exact,hardware:'gold'}).buy_eligible,false);
  assert.equal(match([row],item,{...exact,special_edition:true}).buy_eligible,false);
});
test('all tabs are searched: a wrong size in the own tab cannot hide an exact row elsewhere',()=>{
  const c=strictBagComparables([{tab:'Lady Dior',rows:[{...row,dims:'20x17x6'}]},
    {tab:'Radar oportunidades',rows:[{...row,model:'Lady Dior',size:'Medium'}]}],item,exact);
  assert.equal(c.n,1);assert.equal(c.tab,'Radar oportunidades');
});
test('a broader model cannot substitute for a named variant in another tab',()=>{
  const entries=[{tab:'Louis Vuitton Murakami Multicolore',rows:[{...row,brand:'Louis Vuitton',size:'Pochette'}]},
    {tab:'Radar oportunidades',rows:[{...row,brand:'Louis Vuitton',size:'Pochette Accessoires',dims:'20x17x6'}]}];
  assert.equal(strictBagComparables(entries,{...item,title:'Louis Vuitton Pochette Accessoires 24x20x11'},
    {...exact,brand:'Louis Vuitton',family:'Pochette Accessoires'}),null);
});
test('confirmed sales win over asking prices; sold rows without a valid sale price never become asks',()=>{
  const c=match([{...row,id:'sold',sold:true,excluded:true,sold_price_eur:800},{...row,id:'active',price_eur:2000}]);
  assert.equal(c.low,800);assert.equal(c.high,800);assert.equal(c.price_basis,'mixed');
  assert.equal(match([{...row,sold:true}]),null);
  assert.equal(match([{...row,sold:true,sold_price_eur:800,sold_price_suspect:true}]),null);
});
test('deterministic gate forbids BUY and STRONG BUY without fresh eligible Sheets evidence, preserves REJECT',()=>{
  for(const decision of ['BUY','STRONG BUY']){
    const a={decision,opportunity_score:95,decision_reasons_es:[]};
    assert.equal(applyBagSheetPolicy(a,null,{fresh:true}).decision,'WATCH');
    assert.equal(applyBagSheetPolicy(a,match(),{fresh:false}).decision,'WATCH');
    assert.equal(applyBagSheetPolicy(a,match(),{fresh:true}).decision,decision);
  }
  assert.equal(applyBagSheetPolicy({decision:'REJECT'},null,{fresh:true}).decision,'REJECT');
});

// Exercise actual production decision and cache paths, without starting the
// server, fetching products, spending API credits or changing the live DB.
const source=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
const extract=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
function harness(extra={}){
  const ctx=vm.createContext({applyBagSheetPolicy,BAG_SHEET_RULE_VERSION,strictBagComparables,
    roundMoney:n=>Math.round(n*100)/100,clampNum:(n,l,h)=>Math.max(l,Math.min(h,Number(n)||0)),
    vestiaireComparablesNote:()=> 'Sheets comparables',clampResaleToAnchor:()=>{throw Error('unexpected loose anchor');},
    isWatchTask:s=>/Tudor/.test(s||''),vestiaireSheetCache:{tasks:{'Lady Dior':{source:'sheet',fichas:[row]}}},
    vestiaireSheetFresh:()=>true,parseJsonArray:(s,f)=>{try{return JSON.parse(s);}catch{return f;}},
    numberOrNull:v=>v==null?null:Number(v),...extra});
  vm.runInContext(extract('function vestiaireComparables(task,','function vestiaireComparablesNote('),ctx);
  vm.runInContext(extract('function finalizeVerifiedOpportunity(','function storeTaskAnalysis('),ctx);
  return ctx;
}
const preliminary={authenticity_risk:'LOW',liquidity:'HIGH'};
const market={conservative_resale_eur:4000,market_high_eur:5000,market_confidence:'HIGH',relevant_comparable_count:8,exact_comparable_count:5,independent_source_count:3,bag_sheet_required:true,sheet_fresh:true};
test('actual finalizer overrides a bullish market estimate with the exact Sheets row, otherwise WATCH',()=>{
  const ctx=harness();
  const calculate=m=>ctx.finalizeVerifiedOpportunity(preliminary,exact,m,{importedTotalEur:600});
  const c=match();
  const a=calculate({...market,sheet_comps:c});
  assert.equal(a.resale_low_eur,918);assert.equal(a.resale_estimate_source,'VESTIAIRE_DB');assert.equal(a.decision,'BUY');
  assert.equal(calculate(market).decision,'WATCH');
  assert.equal(calculate({...market,sheet_comps:c,sheet_fresh:false}).decision,'WATCH');
  assert.equal(calculate({...market,sheet_comps:c,market_confidence:'LOW',independent_source_count:0,relevant_comparable_count:0}).decision,'WATCH');
});
test('static fallback snapshots cannot authorize purchases',()=>{
  const ctx=harness({vestiaireSheetCache:null,vestiaireRefs:()=>({tasks:{'Lady Dior':{source:'sheet',fichas:[row]}}})});
  assert.equal(ctx.vestiaireComparables({task_name:'Lady Dior'},item,exact),null);
});
test('loader reads unknown tabs and all rows without overwriting a shared task mapping',async()=>{
  const seen=[];
  const properties=[{title:'Balenciaga Fotos',gridProperties:{rowCount:100,columnCount:26}},
    {title:'Balenciaga Le City',gridProperties:{rowCount:2505,columnCount:28}},
    {title:'New bag model',gridProperties:{rowCount:120,columnCount:24}}];
  const ctx=vm.createContext({process:{env:{VESTIAIRE_SHEET_ID:'fixture'}},AbortSignal,Date,
    googleSheetsAuth:async()=>({headers:{},query:''}),
    vestiaireSheetTaskName:t=>t.startsWith('Balenciaga')?'Balenciaga Le City':null,
    vestiaireSheetTab:values=>({source:'sheet',fichas:[{id:values[0]}]}),
    fetch:async url=>{
      seen.push(url);
      return {ok:true,json:async()=>seen.length===1?{sheets:properties.map(properties=>({properties}))}:{valueRanges:properties.map((_,i)=>({values:[i]}))}};
    }});
  vm.runInContext(extract('async function loadVestiaireSheet(){','async function refreshVestiaireSheet('),ctx);
  const loaded=await ctx.loadVestiaireSheet();
  assert.equal(Object.keys(loaded.tasks).length,3);
  assert.equal(Object.values(loaded.tasks).flatMap(r=>r.fichas).length,3);
  assert.ok(loaded.tasks['New bag model']);
  assert.match(decodeURIComponent(seen[1]),/AB2505/);
  assert.match(decodeURIComponent(seen[1]),/X120/);
});
test('cached BUY is revised without AI; both tables persist WATCH consistently and repeated refreshes do not nest raw JSON',()=>{
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE listings(id INTEGER,title TEXT,description TEXT);
    CREATE TABLE tasks(id INTEGER,task_name TEXT);
    CREATE TABLE analyses(id INTEGER,listing_id INTEGER,brand TEXT,model TEXT,authenticity_risk TEXT,liquidity TEXT,decision TEXT,opportunity_score REAL,resale_low_eur REAL,resale_high_eur REAL,landed_cost_eur REAL,net_profit_low_eur REAL,net_profit_high_eur REAL,decision_reasons_es_json TEXT,raw_json TEXT,verification_json TEXT);
    CREATE TABLE task_analyses AS SELECT *,0 AS task_id FROM analyses;
    INSERT INTO tasks VALUES(1,'Lady Dior');`);
  db.prepare('INSERT INTO listings VALUES(1,?,?)').run(item.title,item.description);
  const v={status:'verified',exact,market,final:{decision:'STRONG BUY'}};
  for(const table of ['analyses','task_analyses']){
    db.prepare(`INSERT INTO ${table}(id,listing_id,brand,model,authenticity_risk,liquidity,decision,opportunity_score,resale_low_eur,resale_high_eur,landed_cost_eur,net_profit_low_eur,net_profit_high_eur,decision_reasons_es_json,raw_json,verification_json${table==='task_analyses'?',task_id':''}) VALUES(1,1,'Dior','Lady Dior','LOW','HIGH','STRONG BUY',95,4000,5000,600,3400,4400,'[]','{}',?${table==='task_analyses'?',1':''})`).run(JSON.stringify(v));
  }
  const ctx=harness({db,vestiaireSheetCache:{tasks:{}}});
  vm.runInContext(extract('function revalidateStoredBagBuys(){','let googleSheetsToken='),ctx);
  ctx.revalidateStoredBagBuys();ctx.revalidateStoredBagBuys();
  for(const table of ['analyses','task_analyses']){
    const a=db.prepare(`SELECT * FROM ${table}`).get();
    assert.equal(a.decision,'WATCH');
    assert.equal(JSON.parse(a.verification_json).final.decision,'WATCH');
    assert.match(a.decision_reasons_es_json,/CONSULTAR PRECIO/);
    assert.equal(JSON.parse(a.verification_json).final.market_verification,undefined);
    assert.ok(a.raw_json.length<10000);
  }
  db.close();
});

test('las vendidas y las que tienen más likes pesan más en el precio',()=>{
  const rows=[{...row,id:'a',price_eur:1000,likes:0},{...row,id:'b',price_eur:1100,likes:0},{...row,id:'c',price_eur:2000,likes:300},{...row,id:'d',price_eur:2100,likes:250}];
  const c=match(rows);
  // Sin pesos la mediana caería entre 1.012 y 1.840; con likes manda la parte alta.
  assert.equal(c.mid,1840);
  assert.equal(c.picks[0].id,'c');
  const s=match([{...row,id:'s',sold:true,sold_price_eur:900},{...row,id:'x',price_eur:2000},{...row,id:'y',price_eur:2100}]);
  assert.equal(s.mid,900);
  assert.equal(s.weighted.length,3);
});
