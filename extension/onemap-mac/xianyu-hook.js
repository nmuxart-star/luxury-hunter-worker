// Se ejecuta en la página de Goofish (mundo MAIN, al empezar a cargar): guarda
// lo que responde el buscador de Xianyu para que la extensión lo lea. No cambia
// nada de la página ni de sus peticiones; solo copia la respuesta.
(()=>{
  if(window.__lhXYHook)return;
  window.__lhXYHook=true;
  window.__lhXY=[];
  const API='mtop.taobao.idlemtopsearch.pc.search/';
  const keep=(url,text)=>{if(String(url).includes(API))window.__lhXY.push({at:Date.now(),text:String(text||'').slice(0,1_500_000)});};
  const of=window.fetch;
  window.fetch=async function(...a){
    const r=await of.apply(this,a);
    try{const u=typeof a[0]==='string'?a[0]:a[0]?.url;if(String(u).includes(API))r.clone().text().then(t=>keep(u,t)).catch(()=>{});}catch{}
    return r;
  };
  const oo=XMLHttpRequest.prototype.open,os=XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open=function(m,u,...r){this.__lhu=u;return oo.call(this,m,u,...r);};
  XMLHttpRequest.prototype.send=function(...a){
    this.addEventListener('load',()=>{try{if(String(this.__lhu).includes(API))keep(this.__lhu,this.responseText);}catch{}});
    return os.apply(this,a);
  };
})();
