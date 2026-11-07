import test from 'node:test';
import assert from 'node:assert/strict';
import {photoUrl,enrich,cost} from '../scripts/describe-vestiaire-bags.mjs';

const row={brand:'Chanel',type:'Timeless/Classique',dimensions:'18x9',material:'Cuero',color:'Negro',notes:'Bandolera Timeless/Classique de Cuero',description:'Chanel Timeless/Classique · 18×9 cm · cuero (tipo sin confirmar) · negro · bandolera'};
const blank={variant:'',material:'',material_evidence:'',pattern:'',shape:'',hardware:'',closure:'',strap:''};

test('does not infer internal flap version or lambskin from an exterior photo',()=>{
  assert.equal(enrich(row,{...blank,variant:'Double Flap',material:'piel de cordero',material_evidence:'visual claro'}),row.description);
});

test('replaces generic leather with visually clear patent and inserts verified hardware',()=>{
  const got=enrich({...row,description:'Chanel Timeless/Classique · 18×9 cm · cuero (tipo sin confirmar) · negro'},
    {...blank,material:'charol',material_evidence:'visual claro',hardware:'dorados',closure:'CC giratorio',strap:'cadena con piel entrelazada'});
  assert.equal(got,'Chanel Timeless/Classique · 18×9 cm · charol · negro · herrajes dorados · cierre CC giratorio · cadena con piel entrelazada');
});

test('keeps current extras and only extracts IMAGE URL, with usage cost accounting',()=>{
  const bag={...row,description:'Dior Lady Dior · Mini · 17×15×7 cm · cuero (tipo sin confirmar) · negro · con funda'};
  const got=enrich(bag,{...blank,pattern:'Cannage',hardware:'dorados',strap:'correa desmontable'});
  assert.equal(got,'Dior Lady Dior · Mini · 17×15×7 cm · cuero (tipo sin confirmar) · acolchado Cannage · negro · herrajes dorados · correa desmontable · con funda');
  assert.equal(photoUrl('=IMAGE("https://example.com/a.jpg";4;108;144)'),'https://example.com/a.jpg');
  assert.equal(cost({input_tokens:1000,output_tokens:100}),0.00015);
});
