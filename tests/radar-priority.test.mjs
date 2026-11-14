import test from 'node:test';
import assert from 'node:assert/strict';
import {radarQueryKey,radarScoreModels,radarPrioritize,radarAutoQueries,radarModelBase,radarBrandKey,radarYieldFactors,radarRowsFor,radarPriceBand,radarBuildList,radarParseWeights} from '../scripts/radar-priority.mjs';

const fila=(brand,size,likes,sold=false)=>({brand,size,likes,sold});
const muchas=(brand,size,n,likes,sold=0)=>Array.from({length:n},(_,i)=>fila(brand,size,likes,i<sold));

test('radarQueryKey: marca china y modelo latino (igual que antes) y marcas nuevas',()=>{
  assert.deepEqual(radarQueryKey('圣罗兰 niki'),{brand:'saintlaurent',model:'niki'});
  assert.deepEqual(radarQueryKey('LV alma 贝壳包'),{brand:'louisvuitton',model:'alma'});
  assert.deepEqual(radarQueryKey('香奈儿 22bag'),{brand:'chanel',model:'22'});
  assert.deepEqual(radarQueryKey('celine box 豆腐包'),{brand:'celine',model:'classic'});
  assert.deepEqual(radarQueryKey('巴黎世家 city'),{brand:'balenciaga',model:'city'});
});

test('radarModelBase: quita tallas, descarta nombres con números sueltos o genéricos',()=>{
  assert.equal(radarModelBase('Alma BB'),'alma');
  assert.equal(radarModelBase('Alma PM'),'alma');
  assert.equal(radarModelBase('Speedy Bandoulière'),'speedy bandouliere');
  assert.equal(radarModelBase('Loulou Toy'),'loulou');
  assert.equal(radarModelBase('Le 37'),null);
  assert.equal(radarModelBase('Classic'),null);
  assert.equal(radarModelBase('Mini'),null);
  assert.equal(radarModelBase('a b c d'),null);
});

test('radarBrandKey: variantes de nombre de marca',()=>{
  assert.equal(radarBrandKey('Yves Saint Laurent'),'saintlaurent');
  assert.equal(radarBrandKey('Saint Laurent'),'saintlaurent');
  assert.equal(radarBrandKey('Hermès'),'hermes');
  assert.equal(radarBrandKey('Chloé'),'chloe');
  assert.equal(radarBrandKey('Miu Miu'),'miumiu');
  assert.equal(radarBrandKey('Valentino Garavani'),'valentino');
  assert.equal(radarBrandKey('Marca rara'),null);
});

test('radarAutoQueries: añade modelos de la hoja que no estaban, bien puntuados y con fichas suficientes',()=>{
  const fichas=[
    ...muchas('Louis Vuitton','Alma BB',20,5),            // ya cubierto por «LV alma»
    ...muchas('Louis Vuitton','Speedy Bandoulière',20,40,6),
    ...muchas('Fendi','Spy',10,90,3),
    ...muchas('Fendi','Peekaboo',20,5),                    // ya cubierto
    ...muchas('Gucci','Jackie',3,50),                      // pocas fichas
    ...muchas('Marca rara','Modelo',30,50),                // marca desconocida
    ...muchas('Prada','Cleo',10,2)                         // poco interés
  ];
  const cfg=['LV alma 贝壳包','芬迪 peekaboo','普拉达 bonnie'];
  const got=radarAutoQueries(fichas,cfg,{max:5,minFichas:8,minScore:0.45});
  const qs=got.map(x=>x.q);
  assert.ok(qs.includes('lv speedy bandouliere'),qs.join('|'));
  assert.ok(qs.includes('芬迪 spy'),qs.join('|'));
  assert.ok(!qs.some(q=>/alma|peekaboo/.test(q)),'no repite lo cubierto');
  assert.ok(!qs.some(q=>/jackie/.test(q)),'sin fichas suficientes');
  assert.ok(!qs.some(q=>/rara|modelo/i.test(q)),'marca desconocida');
  assert.ok(!qs.some(q=>/cleo/.test(q)),'poco interés');
});

test('radarAutoQueries: respeta el máximo y no mete modelos casi iguales',()=>{
  const fichas=[
    ...muchas('Hermès','Kelly To Go',10,60,4),
    ...muchas('Hermès','Kelly',10,50,3),
    ...muchas('Chanel','Boy',10,10),
    ...muchas('Fendi','Spy',10,90,3),
    ...muchas('Gucci','Indy',10,70,3),
    ...muchas('Bottega Veneta','Loop',10,60,3)
  ];
  const got=radarAutoQueries(fichas,['香奈儿 boy 包'],{max:2,minFichas:8,minScore:0});
  assert.equal(got.length,2);
  const todos=radarAutoQueries(fichas,[],{max:10,minFichas:8,minScore:0});
  assert.ok(!(todos.some(x=>x.model==='kelly')&&todos.some(x=>x.model==='kellytogo')),'kelly y kelly to go no a la vez');
  assert.deepEqual(radarAutoQueries([],['x'],{max:5}),[]);
  assert.deepEqual(radarAutoQueries(fichas,[],{max:0}),[]);
});

test('radarPrioritize: el de más puntuación sale antes; el peso por rendimiento lo baja; ninguno desaparece',()=>{
  const fichas=[...muchas('Fendi','Spy',20,90,8),...muchas('Prada','Cleo',20,1,0)];
  const qs=['芬迪 spy','普拉达 cleo'];
  const ahora=Date.now();
  const sin={ '芬迪 spy':ahora-3600e3,'普拉达 cleo':ahora-3600e3 };
  assert.equal(radarPrioritize(qs,fichas,ahora,sin).order[0],'芬迪 spy');
  const con=radarPrioritize(qs,fichas,ahora,sin,{'芬迪 spy':0.05});
  assert.equal(con.order[0],'普拉达 cleo');
  assert.equal(con.order.length,2);
  // pasadas muchas horas, el de menos puntuación acaba saliendo
  const viejo={ '芬迪 spy':ahora-1*3600e3,'普拉达 cleo':ahora-50*3600e3 };
  assert.equal(radarPrioritize(qs,fichas,ahora,viejo).order[0],'普拉达 cleo');
});

test('radarYieldFactors: solo baja el peso si de verdad no trae nada',()=>{
  assert.deepEqual(radarYieldFactors({a:[0,0,5],b:[0,7],c:[1,1,0],d:[0],e:[10,12,9],f:[]}),{a:0.3,c:0.7});
  assert.deepEqual(radarYieldFactors({}),{});
});

test('radarScoreModels: sin fichas puntúa 0,35 (como antes)',()=>{
  const m=radarScoreModels([],['圣罗兰 niki']);
  assert.equal(m.get('圣罗兰 niki').score,0.35);
});

test('radarRowsFor: fichas del modelo y la marca de la búsqueda',()=>{
  const f=[fila('Louis Vuitton','Alma BB',5),fila('Louis Vuitton','Speedy',5),fila('Gucci','Alma',5)];
  assert.deepEqual(radarRowsFor(f,'LV alma 贝壳包').map(x=>x.size),['Alma BB']);
  assert.deepEqual(radarRowsFor(f,'奢侈品包 二手 正品 验货宝'),[]);          // sin modelo: ninguna
});

test('radarPriceBand: máximo = el mayor precio con el que, vendiendo a la media, queda el margen',()=>{
  const landed=p=>p*1.5+50;                      // coste puesto simple
  const values=[900,950,1000,1000,1050,1100,1000,980,1020,5000,100];  // outliers que el recorte quita
  const b=radarPriceBand({values,fee:0.15,minProfit:200,landedFn:landed,taskMin:600,taskMax:2200});
  assert.ok(b,'hay banda');
  // media recortada ≈ 1.000 → neto 850; hace falta 850-landed ≥ 120 → landed ≤ 730 → precio ≤ 453
  assert.ok(b.maxEur>=440&&b.maxEur<=460,String(b.maxEur));
  assert.ok(b.minEur<600,'el mínimo baja de 600 porque el máximo es bajo');
  assert.equal(b.minEur,Math.round(b.maxEur*0.4/10)*10);
  assert.ok(b.resale>=980&&b.resale<=1020);
  // con el coste puesto más barato, el máximo sube pero no pasa del tope de la tarea
  const barato=radarPriceBand({values,fee:0.15,minProfit:200,landedFn:p=>p*1.05,taskMax:500});
  assert.equal(barato.maxEur,500);
});
test('radarPriceBand: sin fichas suficientes o sin margen posible no pone banda',()=>{
  const landed=p=>p*1.5+50;
  assert.equal(radarPriceBand({values:[900,950,1000],landedFn:landed}),null);            // < 5 fichas
  assert.equal(radarPriceBand({values:[100,100,100,100,100,100],landedFn:landed}),null); // se vende por menos de lo que cuesta traerlo
  assert.equal(radarPriceBand({values:[1,2,3,4,5,6]}),null);                            // sin función de coste
});

test('radarParseWeights: normaliza a 1 y cae a los de siempre si no es válido',()=>{
  const w=radarParseWeights('1,1,1');
  assert.ok(Math.abs(w.likes-1/3)<1e-9&&Math.abs(w.rotation-1/3)<1e-9&&Math.abs(w.presence-1/3)<1e-9);
  assert.deepEqual(radarParseWeights('2,1,1'),{likes:0.5,rotation:0.25,presence:0.25});
  assert.deepEqual(radarParseWeights('a,b'),{likes:0.4,rotation:0.4,presence:0.2});
  assert.deepEqual(radarParseWeights('0,0,0'),{likes:0.4,rotation:0.4,presence:0.2});
});

test('radarBuildList: el listado son los modelos más presentes, más vendidos y con más likes; los fijos que puntúan poco salen',()=>{
  const fichas=[
    ...muchas('Fendi','Spy',20,90,10),                 // muchas fichas, muy vendido, muchos likes (no está en la lista fija)
    ...muchas('Saint Laurent','Niki',40,20,10),        // fijo, fuerte
    ...muchas('Prada','Galleria',9,1,0),               // fijo, flojo: pocas fichas, sin ventas, sin likes
    ...muchas('Gucci','Indy',20,50,6),
    ...muchas('Chanel','Boy',20,40,5),
    ...muchas('Hermès','Garden Party',20,30,4),
    ...muchas('Goyard','Saint-Louis',20,60,8),
    ...muchas('Marca rara','Modelo',30,90,20),         // marca desconocida: no entra
    ...muchas('Dior','Gaucho',3,90,3)                  // < minFichas: no entra
  ];
  const cfg=['圣罗兰 niki','普拉达 galleria 杀手包','爱马仕 garden party'];
  const L=radarBuildList(fichas,cfg,{size:4,minFichas:8});
  const qs=L.map(x=>x.q);
  assert.equal(L.length,4);
  assert.ok(qs.includes('芬迪 spy'),qs.join('|'));              // entra por la hoja
  assert.ok(qs.includes('圣罗兰 niki'),qs.join('|'));           // se usa la búsqueda fija, no una automática
  assert.ok(!qs.some(q=>/galleria/.test(q)),'el fijo flojo sale: '+qs.join('|'));
  assert.ok(!qs.some(q=>/rara|modelo|gaucho/i.test(q)));
  assert.ok(L.every((x,i)=>i===0||L[i-1].score>=x.score),'ordenado por puntuación');
  assert.equal(L.find(x=>x.q==='圣罗兰 niki').fromConfig,true);
  assert.deepEqual(radarBuildList([],cfg),[]);
});
