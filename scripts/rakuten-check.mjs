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
const r=await fetch(`https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701?${params}`,{
  headers:{referer:process.env.RAKUTEN_REFERER||'https://nmuxart-star.github.io/luxury-hunter-worker/'}
});
const body=await r.json().catch(()=>({}));
console.log('HTTP',r.status);
if(!r.ok){
  console.log('Error:',body.error||'',body.error_description||JSON.stringify(body).slice(0,300));
  process.exit(1);
}
console.log(`Resultados totales: ${body.count}`);
for(const it of (body.Items||[]).slice(0,10)){
  const x=it.Item||it;
  console.log(`- ¥${x.itemPrice} · ${x.shopName} · ${String(x.itemName).slice(0,70)}`);
}
