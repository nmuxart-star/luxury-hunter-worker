// Comprueba en tu Mac si eBay acepta un App ID + Cert ID de Production.
// No guarda nada ni lo envía a ningún sitio salvo al login oficial de eBay.
// Uso: node scripts/ebay-local-test.mjs
import readline from 'node:readline/promises';

const rl=readline.createInterface({input:process.stdin,output:process.stdout});
const clean=v=>String(v||'').trim().replace(/^["']|["']$/g,'');
const id=clean(await rl.question('Pega el App ID (Client ID) de Production y pulsa Enter: '));
const secret=clean(await rl.question('Pega el Cert ID (Client Secret) de Production y pulsa Enter: '));
rl.close();
process.stdout.write('\x1b[2J\x1b[H'); // limpia la pantalla para no dejar las claves a la vista

const r=await fetch('https://api.ebay.com/identity/v1/oauth2/token',{
  method:'POST',
  headers:{'content-type':'application/x-www-form-urlencoded',authorization:'Basic '+Buffer.from(`${id}:${secret}`).toString('base64')},
  body:new URLSearchParams({grant_type:'client_credentials',scope:'https://api.ebay.com/oauth/api_scope'})
});
const j=await r.json().catch(()=>({}));
if(j.access_token){
  console.log('✅ eBay ACEPTA estas claves.');
  console.log('Guárdalas en GitHub con estos dos comandos (pegando cada valor cuando lo pida):');
  console.log('  ~/bin/gh secret set EBAY_CLIENT_ID --repo nmuxart-star/luxury-hunter-worker');
  console.log('  ~/bin/gh secret set EBAY_CLIENT_SECRET --repo nmuxart-star/luxury-hunter-worker');
}else{
  console.log(`❌ eBay rechaza estas claves (HTTP ${r.status}: ${j.error_description||j.error||'sin detalle'}).`);
  console.log('Revisa que App ID y Cert ID sean de la MISMA fila de Production en developer.ebay.com/my/keys.');
}
