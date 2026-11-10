// Lee la ficha abierta en la pestaña (título, precio, descripción y fotos) para
// enviarla a Luxury Hunter Inbox. Se inyecta solo cuando Nil pulsa el icono de
// la extensión sobre esa pestaña; no lee nada más ni se ejecuta por su cuenta.
// Es una función autocontenida: no puede usar nada de fuera.
function lhExtractListing(){
  const clean=t=>String(t||'').replace(/\s+/g,' ').trim();
  const text=el=>clean(el?.innerText||el?.textContent||'');
  const meta=n=>clean(document.querySelector(`meta[property="${n}"],meta[name="${n}"],meta[itemprop="${n}"]`)?.content);
  const abs=u=>{try{const x=new URL(u,location.href);return /^https?:$/.test(x.protocol)?x.href:'';}catch{return '';}};
  const host=location.hostname;
  const out={url:location.href,title:'',description:'',brand:'',price:null,currency:'',images:[]};
  const images=[];
  const addImage=u=>{const a=abs(u);if(a&&!images.includes(a))images.push(a);};

  if(/goofish\.com|2\.taobao\.com/.test(host)){
    // Xianyu: el título está en el de la pestaña; el texto, en el bloque «desc--»; las fotos, «xy_item».
    out.title=clean(document.title.replace(/[_\-–]?\s*闲鱼\s*$/,''));
    const price=[...document.querySelectorAll('[class*="price--"]')].map(text).find(t=>/^\d[\d,.]*$/.test(t));
    out.price=price?Number(price.replace(/,/g,'')):null;
    const blocks=[...document.querySelectorAll('[class*="desc--"]')].map(text).filter(t=>t.length>12&&!/验货宝低至|人想要$/.test(t)).sort((a,b)=>b.length-a.length);
    out.description=blocks[0]||'';
    const body=clean(document.body?.innerText||'');
    const seller=body.match(/来闲鱼\s*(\d+)\s*年\s*卖出\s*(\d+)\s*件宝贝\s*好评率\s*(\d+)\s*%/);
    if(seller)out.description+=` | Vendedor en Xianyu: ${seller[1]} años, ${seller[2]} vendidos, ${seller[3]} % de valoraciones buenas`;
    if(/验货宝/.test(body))out.description+=' | Con 验货宝 (test de autenticación)';
    out.currency='CNY';
    // Fotos del producto: «xy_item». Las «mtopupload» sin carpeta de usuario son avatares.
    const own=[...document.images].map(i=>i.currentSrc||i.src||'').filter(u=>/xy_item/.test(u));
    const fallback=[...document.images].map(i=>i.currentSrc||i.src||'').filter(u=>/mtopupload/.test(u)&&/\/\d{8,}\//.test(u));
    for(const u of (own.length?own:fallback))addImage(u.replace(/_\d+x\d+[^/]*$/,'').replace(/_\.webp$/,''));
  }else{
    // Resto de plataformas: datos estándar de la página (Open Graph, JSON-LD de producto).
    out.title=meta('og:title')||clean(document.querySelector('h1')?.innerText)||clean(document.title);
    out.description=meta('og:description')||meta('description');
    let product=null;
    for(const block of document.querySelectorAll('script[type="application/ld+json"]')){
      try{
        const stack=[JSON.parse(block.textContent)];
        while(stack.length&&!product){
          const node=stack.pop();
          if(Array.isArray(node)){stack.push(...node);continue;}
          if(node&&typeof node==='object'){
            if(node['@graph'])stack.push(...[].concat(node['@graph']));
            if(/Product/i.test(String(node['@type'])))product=node;
          }
        }
      }catch{}
      if(product)break;
    }
    if(product){
      out.title=clean(product.name)||out.title;
      out.description=clean(product.description)||out.description;
      out.brand=clean(typeof product.brand==='string'?product.brand:product.brand?.name);
      const offer=[].concat(product.offers||[])[0]||{};
      const p=Number(String(offer.price??offer.lowPrice??'').replace(/,/g,''));
      if(Number.isFinite(p)&&p>0)out.price=p;
      out.currency=clean(offer.priceCurrency);
      for(const u of [].concat(product.image||[]))addImage(typeof u==='string'?u:u?.url);
    }
    if(!out.price){
      const p=Number(meta('product:price:amount').replace(/,/g,''));
      if(Number.isFinite(p)&&p>0){out.price=p;out.currency=out.currency||meta('product:price:currency');}
    }
    if(!out.price){
      // Último recurso: el primer precio con símbolo que se ve en la parte alta de la página.
      const m=clean(document.body?.innerText||'').slice(0,3000).match(/(¥|￥|€|\$|£)\s?(\d[\d,]*(?:\.\d+)?)/);
      if(m){out.price=Number(m[2].replace(/,/g,''));out.currency=out.currency||({'¥':'JPY','￥':'JPY','€':'EUR','$':'USD','£':'GBP'})[m[1]];}
    }
    addImage(meta('og:image'));
    for(const img of document.images){
      if((img.naturalWidth||0)>=300&&(img.naturalHeight||0)>=300)addImage(img.currentSrc||img.src);
      if(images.length>=12)break;
    }
  }
  out.title=out.title.slice(0,250);
  out.description=out.description.slice(0,1500);
  out.images=images.slice(0,12);
  return out;
}
