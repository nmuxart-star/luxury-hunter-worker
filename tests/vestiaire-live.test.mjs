import test from 'node:test';
import assert from 'node:assert/strict';
import {vestiaireLiveQuery,vestiaireLiveRows,vestiaireLiveComparables,blendComparables} from '../scripts/vestiaire-live.mjs';

const item=(id,{name='Bolso Lady Dior de Cuero',desc='',cents=200000,sold=false,slug='lady-dior-dior-de-cuero-negro',cat='mujer-bolsos/bolsos-de-mano',brand='Dior'}={})=>
  ({id,name,description:desc,brand:{name:brand},model:{name:'Lady Dior'},price:{cents},sold,likes:3,colors:{all:[{name:'Negro'}]},condition:{label:'Muy buen estado'},link:`/${cat}/dior/bolsos-de-mano-${slug}-${id}.shtml`});

test('texto de búsqueda: marca y modelo, sin repetir la marca ni chino',()=>{
  assert.equal(vestiaireLiveQuery({},{brand:'Dior',family:'Lady Dior'}),'lady dior');
  assert.equal(vestiaireLiveQuery({brand:'Celine',model:'Claude'},{}),'celine claude');
  assert.equal(vestiaireLiveQuery({},{brand:'Dior',family:'戴妃'}),null);
});

test('filas: solo bolsos, material del enlace, talla y medidas de la descripción',()=>{
  const rows=vestiaireLiveRows({items:[item(1,{desc:'Lady Dior Medium 24x20x11 cm'}),item(2,{cat:'mujer-calzado/botas'}),item(1)]});
  assert.equal(rows.length,1);
  assert.equal(rows[0].size,'medium');
  assert.equal(rows[0].dims,'11x20x24');
  assert.match(rows[0].material,/cuero/);
  assert.equal(rows[0].price_eur,2000);
  assert.match(rows[0].url,/^https:\/\/es\.vestiairecollective\.com\//);
});

test('precio: piel con piel, misma talla; vendidos y likes pesan más',()=>{
  const rows=vestiaireLiveRows({items:[
    item(1,{desc:'medium',cents:200000,sold:true}),item(2,{desc:'medium',cents:220000,sold:true}),item(3,{desc:'medium',cents:240000,sold:true}),
    item(4,{desc:'medium',cents:900000}),
    item(5,{desc:'medium',cents:60000,sold:true,slug:'lady-dior-dior-de-sintetico-negro'}),
    item(6,{desc:'mini',cents:100000,sold:true})]});
  const c=vestiaireLiveComparables(rows,{title:'Lady Dior medium lambskin'},{brand:'Dior',family:'Lady Dior',material:'lambskin leather',size:'Medium'});
  assert.equal(c.tier,'misma_talla');
  assert.equal(c.price_basis,'mixed');
  assert.equal(c.n,4);
  // Tres vendidos (×3) frente a uno en venta muy caro (×1): no sube la franja.
  assert.equal(c.low,2000);assert.equal(c.mid,2200);assert.equal(c.high,2400);
  assert.equal(c.picks[0].sold,true);
  assert.equal(c.material,'piel');
});

test('sin 3 de su talla: todas las tallas (orientativo); sin 3 del material: nada',()=>{
  const rows=vestiaireLiveRows({items:[item(1,{desc:'mini'}),item(2,{desc:'small'}),item(3,{desc:'large'})]});
  const c=vestiaireLiveComparables(rows,{title:'Lady Dior medium'},{brand:'Dior',family:'Lady Dior',material:'leather',size:'Medium'});
  assert.equal(c.tier,'mismo_modelo');
  assert.equal(c.price_basis,'asking');
  assert.equal(c.low,1840);
  assert.equal(vestiaireLiveComparables(rows,{title:'Lady Dior canvas'},{brand:'Dior',family:'Lady Dior',material:'canvas'}),null);
});

test('base + Vestiaire: la base pesa el doble y no se cuenta dos veces el mismo anuncio',()=>{
  const sheet={weighted:[{id:'71332269',s:false,v:1000,w:1},{id:'71332270',s:true,v:1100,w:3}]};
  const live={status:'ok',tier:'misma_talla',weighted:[{id:'71332269',s:false,v:1000,w:1},{id:'9',s:true,v:3000,w:3}]};
  const b=blendComparables(sheet,live);
  assert.equal(b.n_sheet,2);assert.equal(b.n_live,1);assert.equal(b.sold_n,2);
  assert.equal(b.mid,1100);assert.equal(b.high,3000);
  assert.equal(blendComparables(sheet,{...live,tier:'mismo_modelo'}),null);
  assert.equal(blendComparables(sheet,{...live,weighted:[live.weighted[0]]}),null);
});
