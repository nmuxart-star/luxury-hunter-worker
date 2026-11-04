import test from 'node:test';
import assert from 'node:assert/strict';
import {rowModelKey,sameModelRows} from '../scripts/vestiaire-model.mjs';
import * as MAT from '../scripts/vestiaire-model.mjs';

const keyOf=(tab,rows,texts,opts)=>sameModelRows(tab,rows,texts,opts)?.key??null;

test('bolsos: variantes y formatos de la pestaña son modelos distintos',()=>{
  const tab='Fendi Baguette';
  const rows=[{size:'Baguette'},{size:'Mamma Baguette'},{size:'Mini bolso Baguette'},{size:'',notes:'Novedad 24 h Vestiaire: Bolso Mamma Baguette de Cuero'},{size:'Pochette Baguette'}];
  assert.deepEqual(rows.map(f=>rowModelKey(tab,f)),['Baguette','Mamma Baguette','Baguette','Mamma Baguette','Baguette · pochette']);
  const m=sameModelRows(tab,rows,{title:'Fendi Mamma Baguette Zucca vintage'});
  assert.equal(m.key,'Mamma Baguette');
  assert.equal(m.rows.length,2);
  assert.equal(keyOf(tab,rows,{title:'FENDI Baguette mini piel negra'}),'Baguette');
  assert.equal(keyOf(tab,rows,{title:'芬迪 法棍包 中号'}),'Baguette');
});

test('bolsos: el anuncio tiene que nombrar el modelo',()=>{
  const rows=[{size:'Lady Dior'},{size:'Medium'},{size:'Lady D-Joy'}];
  assert.equal(keyOf('Lady Dior',rows,{title:'Dior Bobby East-West'}),null);
  assert.equal(keyOf('Lady Dior',rows,{title:'ディオール レディディオール ミディアム'}),'Lady Dior');
  assert.equal(keyOf('Lady Dior',rows,{title:'Dior bag',label:'Dior Lady D-Joy Medium'}),'Lady D-Joy');
  // La descripción no decide la variante: "with pochette" no la convierte en pochette.
  assert.equal(keyOf('Lady Dior',rows,{title:'Lady Dior Medium black',description:'comes with pochette and dust bag'}),'Lady Dior');
});

test('Gucci Jackie: 1961, vintage y la Jackie sin más no se mezclan',()=>{
  const tab='Gucci Jackie';
  const rows=[{size:'Jackie 1961'},{size:'Jackie Vintage'},{size:'Jackie',vintage:true},{size:'Jackie'},{size:'Cabas Jackie'}];
  assert.deepEqual(rows.map(f=>rowModelKey(tab,f)),['Jackie 1961','Jackie vintage','Jackie vintage','Jackie','Jackie · tote']);
  assert.equal(keyOf(tab,rows,{title:'Gucci Jackie 1961 small'}),'Jackie 1961');
  assert.equal(keyOf(tab,rows,{title:'GUCCI vintage Jackie O bag'}),'Jackie vintage');
  // "vintage" sin nombrar la Jackie no basta.
  assert.equal(keyOf(tab,rows,{title:'Gucci vintage shoulder bag'}),null);
});

test('Radar: mismo modelo y misma marca',()=>{
  const tab='Radar oportunidades';
  const rows=[{brand:'Chanel',size:'Boy'},{brand:'Chanel',size:'Gabrielle'},{brand:'Louis Vuitton',size:'Alma BB'},{brand:'Louis Vuitton',size:'Alma'},{brand:'Celine',size:'Classic'}];
  const m=sameModelRows(tab,rows,{title:'Louis Vuitton Alma BB Epi'});
  assert.equal(m.key,'louis vuitton · alma');
  assert.equal(m.rows.length,2);
  assert.equal(keyOf(tab,rows,{title:'Chanel Classic Flap medium'}),null);
  assert.equal(keyOf(tab,rows,{title:'Celine Classic Box medium'}),'celine · classic');
});

test('relojes: por referencia o por el nombre de modelo más concreto',()=>{
  const tab='Tudor';
  const rows=[{size:'M79000N',model:'Black Bay'},{size:'25600TN',model:'Pelagos'},{size:'79030N',model:'Black Bay Fifty-Eight'},{size:'M25407N',model:'Pelagos'}];
  assert.equal(keyOf(tab,rows,{title:'Tudor Pelagos 42mm titanium'}),'pelagos');
  assert.equal(keyOf(tab,rows,{title:'Tudor 79030N 2021 full set'}),'black bay fifty eight');
  assert.equal(keyOf(tab,rows,{title:'TUDOR Black Bay Fifty-Eight navy'}),'black bay fifty eight');
  assert.equal(keyOf(tab,rows,{title:'Tudor Ranger 36'}),null);
});

test('para buscar en otras pestañas hace falta que el anuncio nombre el modelo',()=>{
  const rows=[{size:'Saddle'},{size:'Mini'}];
  assert.equal(sameModelRows('Dior Saddle',rows,{title:'Dior Saddle mini oblique'},{requireNamed:true}).key,'Saddle');
  assert.equal(sameModelRows('Dior Saddle',rows,{title:'Dior Book Tote'},{requireNamed:true}),null);
});

test('material: tela/sintético, piel y piel exótica no se mezclan',()=>{
  const {materialClass,sameMaterialRows}=MAT;
  assert.equal(materialClass('Cuero'),'piel');
  assert.equal(materialClass('Charol'),'piel');
  assert.equal(materialClass('Lona y cuero'),'tela');
  assert.equal(materialClass('Piel de potro de imitación'),'tela');
  assert.equal(materialClass('Cannage nylon black'),'tela');
  assert.equal(materialClass('レディディオール ナイロン'),'tela');
  assert.equal(materialClass('Avestruz'),'exotica');
  assert.equal(materialClass('lambskin'),'piel');
  assert.equal(materialClass(''),null);
  const rows=[{material:'Cuero'},{material:'Lona'},{material:'Charol'},{material:'',notes:'Bolso Lady Dior de Cuero'},{material:''}];
  assert.equal(sameMaterialRows(rows,'nylon').rows.length,1);
  assert.equal(sameMaterialRows(rows,'lambskin').rows.length,3);
  assert.equal(sameMaterialRows(rows,'').rows.length,5);
});
