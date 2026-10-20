// Prueba de la API de Rakuten: una búsqueda, igual que Luxury Hunter.
// Muestra solo datos públicos de los anuncios (nunca las claves).
const keyword=process.argv[2]||'セリーヌ ラゲージ';
const params=new URLSearchParams({
  applicationId:process.env.RAKUTEN_APP_ID||'',
  accessKey:process.env.RAKUTEN_ACCESS_KEY||'',
  keyword,
  sort:'-updateTimestamp',
  hits:'10',
  availability:'1',
  formatVersion:'2',
  format:'json'
});
const variants=[
  {name:'referer con ruta',headers:{referer:'https://nmuxart-star.github.io/luxury-hunter-worker/'}},
  {name:'referer raíz',headers:{referer:'https://nmuxart-star.github.io/'}},
  {name:'referer + origin',headers:{referer:'https://nmuxart-star.github.io/',origin:'https://nmuxart-star.github.io'}},
  {name:'solo origin',headers:{origin:'https://nmuxart-star.github.io'}}
];
let ok=null;
for(const v of variants){
  const r=await fetch(`https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701?${params}`,{headers:v.headers});
  const body=await r.json().catch(()=>({}));
  console.log(`[${v.name}] HTTP ${r.status} ${r.ok?'':JSON.stringify(body).slice(0,160)}`);
  if(r.ok&&!ok)ok={v,body};
}
if(!ok)process.exit(1);
console.log(`\nFunciona con: ${ok.v.name}. Resultados totales: ${ok.body.count}`);
for(const it of (ok.body.Items||[]).slice(0,10)){
  const x=it.Item||it;
  console.log(`- ¥${x.itemPrice} · ${x.shopName} · ${String(x.itemName).slice(0,70)}`);
}
