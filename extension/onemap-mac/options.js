const field=document.getElementById('token');
const status=document.getElementById('status');
chrome.storage.local.get('bridgeToken').then(({bridgeToken})=>{field.value=bridgeToken||'';});
document.getElementById('save').addEventListener('click',async()=>{
  const token=field.value.trim();
  if(token.length<32){status.textContent='La clave debe tener al menos 32 caracteres.';return;}
  await chrome.storage.local.set({bridgeToken:token});
  status.textContent='Guardada. La extensión consultará el puente cada 30 segundos.';
});
