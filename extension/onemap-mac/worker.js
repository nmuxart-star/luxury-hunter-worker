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

async function handle(job,token){
  const search=job.url.includes('/yahoo-auctions/search/');
  let tab;
  try{
    tab=await chrome.tabs.create({url:job.url,active:false});
    const result=await waitForPage(tab.id,search);
    await bridge(`/result/${job.id}`,token,'POST',{...result,url:job.url});
  }catch(error){
    await bridge(`/result/${job.id}`,token,'POST',{url:job.url,status:502,
      finalUrl:job.url,title:'',body:String(error),html:''}).catch(()=>{});
  }finally{
    if(tab?.id)await chrome.tabs.remove(tab.id).catch(()=>{});
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
  }finally{polling=false;}
}

async function start(){
  await chrome.alarms.create('onemap-poll',{periodInMinutes:0.5});
  await poll();
}
chrome.runtime.onInstalled.addListener(start);
chrome.runtime.onStartup.addListener(start);
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='onemap-poll')void poll();});
void start();
