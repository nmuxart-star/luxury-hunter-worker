const BASE='http://127.0.0.1:8210';
let polling=false;

async function bridge(path,token,method='GET',body){
  const response=await fetch(BASE+path,{method,headers:{authorization:`Bearer ${token}`,
    ...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  if(!response.ok)throw new Error(`Puente HTTP ${response.status}`);
  return response.json();
}

async function snapshot(tabId,search){
  const [injection]=await chrome.scripting.executeScript({target:{tabId},func:(isSearch)=>{
    const html=document.implementation.createHTMLDocument(document.title);
    const copy=(selector,limit,parent)=>{
      for(const el of [...document.querySelectorAll(selector)].slice(0,limit))parent.append(el.cloneNode(true));
    };
    if(isSearch){
      copy('.shop-item',100,html.body);
    }else{
      copy('meta[property^="og:"]',20,html.head);
      copy('script[type="application/ld+json"]',5,html.head);
      copy('h1',2,html.body);
      copy('.vx-row',30,html.body);
    }
    return {status:200,finalUrl:location.href,title:document.title,
      body:document.body?.innerText?.slice(0,30000)||'',html:html.documentElement.outerHTML};
  },args:[search]});
  return injection.result;
}

async function waitForPage(tabId,search){
  const until=Date.now()+(search?25_000:18_000);
  let last=null;
  while(Date.now()<until){
    try{
      last=await snapshot(tabId,search);
      if(search){
        if(/Search Results:\s*\d[\d,]*\s*Items?/i.test(last.body))return last;
      }else if(last.body.length>200&&(/Current Price|Item condition|Seller|現在価格/i.test(last.body))){
        return last;
      }
    }catch{}
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  return last||{status:502,finalUrl:'',title:'',body:'La página no se cargó',html:''};
}

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// UNA sola ventana minimizada con UNA sola pestaña, para siempre: todas las
// consultas reutilizan esa pestaña (se navega a la URL nueva) y nunca se cierra
// ni se crean más. El id se guarda para reencontrarla si Chrome reinicia el
// service worker. Si Nil la cierra, se crea una nueva y vuelve a ser la única.
let jobWindow=null;
async function openHidden(url){
  if(!jobWindow){
    const {lhJobWindow}=await chrome.storage.local.get('lhJobWindow');
    if(lhJobWindow)jobWindow=lhJobWindow;
  }
  if(jobWindow){
    try{
      await chrome.windows.get(jobWindow.id);
      await chrome.tabs.update(jobWindow.firstTab,{url,active:false});
      await sleep(400);
      return {windowId:jobWindow.id,tabId:jobWindow.firstTab};
    }catch{jobWindow=null;}
  }
  const win=await chrome.windows.create({url,focused:false,state:'minimized'});
  jobWindow={id:win.id,firstTab:win.tabs[0].id};
  await chrome.storage.local.set({lhJobWindow:jobWindow});
  return {windowId:win.id,tabId:win.tabs[0].id};
}
// La pestaña se queda abierta (en blanco) hasta la siguiente consulta.
async function closeHidden(opened){
  if(!opened?.tabId)return;
  await chrome.tabs.update(opened.tabId,{url:'about:blank'}).catch(()=>{});
}
async function closeJobWindow(){}

async function waitLoaded(tabId,ms=30_000){
  const until=Date.now()+ms;
  let tab=null;
  while(Date.now()<until){
    tab=await chrome.tabs.get(tabId).catch(()=>null);
    if(tab?.status==='complete')return tab;
    await sleep(500);
  }
  return tab;
}

// Se ejecuta dentro de la página de Vestiaire: su propio buscador. Primero el
// modelo exacto (el nombre de modelo de Vestiaire más largo contenido en la
// búsqueda) y luego sus anuncios vendidos y en venta. Si Vestiaire responde
// con una verificación, se para: no se reintenta ni se resuelve nada.
async function vestiaireSearchInPage(q){
  const call=async(query,filters,{facets=[],limit=48,sortBy='relevance'}={})=>{
    const body={pagination:{offset:0,limit},fields:['name','description','model','brand','price','sold','likes','colors','condition','createdAt','link','pictures'],
      facets:{fields:facets,stats:[]},sortBy,filters,q:query,locale:{country:'ES',currency:'EUR',language:'es',sizeType:'FR'},mySizes:null};
    const r=await fetch('https://search.vestiairecollective.com/v1/product/search',{method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    if(r.status===403||r.status===429)throw Object.assign(new Error(`Vestiaire HTTP ${r.status}`),{blocked:true});
    if(!r.ok)throw new Error(`Vestiaire HTTP ${r.status}`);
    return r.json();
  };
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const norm=t=>String(t||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  try{
    const nq=` ${norm(q)} `;
    const first=await call(q,{},{facets:['model'],limit:1});
    const models=(first.facets?.fields?.model||[]).filter(m=>norm(m.name)&&nq.includes(` ${norm(m.name)} `))
      .sort((a,b)=>norm(b.name).length-norm(a.name).length||b.count-a.count);
    const pick=models[0];
    if(!pick)return {status:200,body:JSON.stringify({query:q,model:null,items:[]})};
    // Vestiaire repite el mismo nombre de modelo con varios ids: todos cuentan.
    const ids=models.filter(m=>norm(m.name)===norm(pick.name)).map(m=>String(m.id));
    const filters={'model.id':ids};
    await wait(1200);
    const sold=await call('',{...filters,sold:['1']},{sortBy:'recency'});
    await wait(1200);
    // En venta, los más recientes primero (para las ofertas nuevas).
    const active=await call('',{...filters,sold:['0']},{sortBy:'recency'});
    const items=[...(sold.items||[]),...(active.items||[])];
    // Miniatura de la primera foto de cada anuncio (las mismas que muestra la
    // web), para que la IA compare cada referencia con el anuncio.
    const thumbs={};
    const toB64=async blob=>{const b=new Uint8Array(await blob.arrayBuffer());let s='';for(let i=0;i<b.length;i+=8192)s+=String.fromCharCode(...b.subarray(i,i+8192));return btoa(s);};
    const queue=items.filter(x=>x?.id&&Array.isArray(x.pictures)&&x.pictures[0]).slice(0,96);
    await Promise.all([0,1,2,3].map(async k=>{
      for(let i=k;i<queue.length;i+=4){
        try{
          const x=queue[i];
          const r=await fetch(`https://images.vestiairecollective.com/images/resized/w=256,q=60,f=jpg,${x.pictures[0]}`);
          if(!r.ok)continue;
          const blob=await r.blob();
          if(blob.size>0&&blob.size<60000)thumbs[x.id]=await toB64(blob);
        }catch{}
      }
    }));
    return {status:200,body:JSON.stringify({query:q,model:{id:pick.id,name:pick.name,count:pick.count},
      sold_total:sold.paginationStats?.totalHits??null,active_total:active.paginationStats?.totalHits??null,
      items,thumbs})};
  }catch(error){
    return {status:error.blocked?403:502,body:String(error.message||error)};
  }
}

async function handleVestiaire(job,token){
  let opened;
  const reply=payload=>bridge(`/result/${job.id}`,token,'POST',{url:job.url,finalUrl:job.url,title:'',html:'',...payload});
  try{
    opened=await openHidden(job.url);
    const tab=await waitLoaded(opened.tabId);
    await sleep(1500);
    const title=tab?.title||'';
    if(/just a moment|attention required|un momento|access denied|verify|verific/i.test(title)){
      return await reply({status:403,title,body:'Vestiaire pide una verificación en el navegador'});
    }
    const [injection]=await chrome.scripting.executeScript({target:{tabId:opened.tabId},world:'MAIN',
      func:vestiaireSearchInPage,args:[job.query]});
    await reply({...injection.result,title});
  }catch(error){
    await reply({status:502,body:String(error)}).catch(()=>{});
  }finally{
    await closeHidden(opened);
  }
}

async function handle(job,token){
  if(job.kind==='vestiaire')return handleVestiaire(job,token);
  const search=job.url.includes('/yahoo-auctions/search/');
  let opened;
  try{
    opened=await openHidden(job.url);
    const result=await waitForPage(opened.tabId,search);
    await bridge(`/result/${job.id}`,token,'POST',{...result,url:job.url});
  }catch(error){
    await bridge(`/result/${job.id}`,token,'POST',{url:job.url,status:502,
      finalUrl:job.url,title:'',body:String(error),html:''}).catch(()=>{});
  }finally{
    await closeHidden(opened);
  }
}

async function poll(){
  if(polling)return;
  polling=true;
  try{
    const {bridgeToken}=await chrome.storage.local.get('bridgeToken');
    if(!bridgeToken)return;
    await bridge('/heartbeat',bridgeToken,'POST');
    for(let i=0;i<30;i++){
      const {job}=await bridge('/next',bridgeToken);
      if(!job)break;
      await handle(job,bridgeToken);
    }
  }catch(error){
    console.warn('Luxury Hunter One Map:',error.message);
  }finally{
    await closeJobWindow();
    polling=false;
  }
}

async function start(){
  await chrome.alarms.create('onemap-poll',{periodInMinutes:0.5});
  await poll();
}
chrome.runtime.onInstalled.addListener(start);
chrome.runtime.onStartup.addListener(start);
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='onemap-poll')void poll();});
void start();
