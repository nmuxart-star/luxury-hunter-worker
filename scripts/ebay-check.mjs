// Prueba de la API de eBay: una búsqueda por marketplace, igual que Luxury Hunter.
// Muestra solo datos públicos de los anuncios (nunca las claves).
const q=process.argv[2]||'Celine Luggage';
const id=process.env.EBAY_CLIENT_ID||'', secret=process.env.EBAY_CLIENT_SECRET||'';
const tok=await fetch('https://api.ebay.com/identity/v1/oauth2/token',{
  method:'POST',
  headers:{'content-type':'application/x-www-form-urlencoded',authorization:'Basic '+Buffer.from(`${id}:${secret}`).toString('base64')},
  body:new URLSearchParams({grant_type:'client_credentials',scope:'https://api.ebay.com/oauth/api_scope'})
});
const t=await tok.json().catch(()=>({}));
console.log('Token HTTP',tok.status,t.access_token?'OK':(t.error_description||t.error||''));
if(!t.access_token)process.exit(1);
for(const mp of ['EBAY_DE','EBAY_FR','EBAY_IT','EBAY_ES','EBAY_GB','EBAY_US']){
  const params=new URLSearchParams({q,sort:'newlyListed',limit:'5',filter:'conditionIds:{2990|3000|3010}'});
  const r=await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`,{headers:{authorization:`Bearer ${t.access_token}`,'X-EBAY-C-MARKETPLACE-ID':mp}});
  const b=await r.json().catch(()=>({}));
  console.log(`\n${mp}: HTTP ${r.status} · total ${b.total??'-'} ${r.ok?'':JSON.stringify(b.errors?.[0]||b).slice(0,200)}`);
  for(const it of (b.itemSummaries||[]).slice(0,3)){
    console.log(`- ${it.price?.value} ${it.price?.currency} · desde ${it.itemLocation?.country||'?'} · ${String(it.title).slice(0,70)}`);
  }
}
