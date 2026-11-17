import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSummary,parseTabForSummary,summaryToValues,parseSummaryValues,lookupSummary,priceForMargin,maxPurchaseFromParams,paramsFromList,refValueOf} from '../scripts/sheet-summary.mjs';

const head=['Foto','Marca','Likes','Referencia','Talla / tipo','Medidas (cm)','Material','Color','Estado','Precio €','Precio antes €','Rebaja %','País','Vintage','We Love','Publicado','Notas','Vendedor','Perfil vendedor','Enlace','Estado anuncio','Comprobado el','Precio venta €'];
const fila=(id,brand,size,material,color,price,status='',sold='',likes=5)=>['',brand,likes,id,size,'',material,color,'Muy buen estado',price,'','','','','','','','','','',status,'',sold];
const tab=[head,
  fila('1000001','Dior','Mini Lady Dior','Cuero','Negro',3000),
  fila('1000002','Dior','Mini Lady Dior','Charol','Negro',3200,'Vendido',2900),
  fila('1000003','Dior','Mini Lady Dior','Cuero','Rosa',2800),
  fila('1000004','Dior','Medium','Cuero','Negro',1800),
  fila('1000005','Dior','Medium','Lona','Negro',1500),
  fila('1000006','Dior','Medium','Cuero','Negro',1700),
  fila('abc','Dior','Medium','Cuero','Negro',9999),                     // sin id válido
  fila('1000007','Dior','Medium','Cuero','Negro',1600,'Referencia errónea')];

test('refValueOf: vendida = lo vendido; a la venta = 90 % de lo pedido',()=>{
  assert.equal(refValueOf({sold:true,soldPrice:2900,ask:3200}),2900);
  assert.equal(refValueOf({sold:true,soldPrice:null,ask:3200}),3200);
  assert.equal(Math.round(refValueOf({sold:false,ask:3000})),2700);
});
test('parseTabForSummary + buildSummary: segmentos por variante, material y color con mínimo de fichas',()=>{
  const f=parseTabForSummary(tab,'Lady Dior','bag');
  assert.equal(f.length,6);                                              // sin la fila de id inválido ni la errónea
  assert.equal(f[0].tipo,'Bolso');assert.equal(f[0].model,'Lady Dior');assert.equal(f[0].material,'Piel');
  assert.equal(f.find(x=>x.ask===1500).material,'Tela / sintético');
  const rows=buildSummary(f,{minN:3});
  const total=rows.find(r=>r.level==='Modelo');
  assert.equal(total.n,6);
  const mini=rows.find(r=>r.level==='Modelo + variante'&&r.variant==='Mini Lady Dior');
  assert.equal(mini.n,3);assert.equal(mini.sold,1);
  assert.ok(!rows.some(r=>r.level==='Modelo + variante + material + color'),'con 6 fichas ningún segmento tan fino llega a 3');
  assert.equal(buildSummary(f,{minN:1}).filter(r=>r.level==='Modelo + variante + material + color').length>0,true);
});
test('summaryToValues + parseSummaryValues: ida y vuelta, con la fórmula del máximo de compra',()=>{
  const rows=buildSummary(parseTabForSummary(tab,'Lady Dior','bag'),{minN:3});
  const v=summaryToValues(rows,{updated:'14/11/26 20:00'});
  assert.equal(v[0][0],'Tipo');assert.equal(v[0][18],'Máx. compra con margen €');
  assert.match(v[1][18],/^=IF\(P2="";/);assert.ok(v[1][18].includes(';'),'separadores de la hoja en español');
  assert.equal(v[1][21],0.3);assert.equal(v[13][20],'Actualizado');assert.ok(v.every(r=>Array.isArray(r)),'sin huecos');
  const back=parseSummaryValues(v);
  assert.equal(back.length,rows.length);
  assert.equal(back[0].model,'Lady Dior');assert.ok(back[0].ref>0);
});
test('lookupSummary: el segmento más específico, con respaldo hacia arriba',()=>{
  const rows=buildSummary(parseTabForSummary(tab,'Lady Dior','bag'),{minN:3});
  const base={tipo:'Bolso',model:'Lady Dior'};
  assert.equal(lookupSummary(rows,{...base,variant:'Mini'}).level,'Modelo + variante');                // «Mini» ⊂ «Mini Lady Dior»
  assert.equal(lookupSummary(rows,{...base,variant:'Mini',color:'negro'}).level,'Modelo + variante');  // no hay variante+color con 3 → baja a variante
  assert.equal(lookupSummary(rows,{...base,color:'Negro'}).level,'Modelo + color');
  assert.equal(lookupSummary(rows,base).level,'Modelo');
  assert.equal(lookupSummary(rows,{tipo:'Bolso',model:'Otro modelo'}),null);
  assert.equal(lookupSummary(rows,{tipo:'Reloj',model:'Lady Dior'}),null);
});
test('priceForMargin: precio máximo con margen sobre el coste y coherente con la fórmula de la hoja',()=>{
  const p=paramsFromList();
  const a=1+p.dutyBag+p.vat*(1+p.dutyBag)+p.pay,b=p.intl*(1+p.dutyBag)*(1+p.vat)+p.clearance+p.verifCny/p.fx;
  const landed=x=>a*x+b;
  const t=priceForMargin({resale:1500,feePct:20,marginPct:30,landedFn:landed});
  const l=landed(t);assert.ok((1500*0.8-l)/l>=0.2995&&(1500*0.8-l)/l<0.31,'margen ≈ 30 %');
  assert.ok(Math.abs(t-maxPurchaseFromParams(1500,'Bolso',p))<=5);
  assert.equal(priceForMargin({resale:100,feePct:20,marginPct:30,landedFn:landed}),null);   // no hay precio posible
  assert.equal(priceForMargin({resale:0,landedFn:landed}),null);
});
