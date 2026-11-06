import test from 'node:test';
import assert from 'node:assert/strict';
import {createOneMapMacBridge} from '../scripts/onemap-mac-bridge.mjs';

test('el puente exige clave, acepta solo One Map y entrega la página al bot',async()=>{
  const token='a'.repeat(40);
  const server=createOneMapMacBridge({token,timeoutMs:3000});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
  try{
    const denied=await fetch(base+'/health');
    assert.equal(denied.status,401);
    const blocked=await fetch(base+'/snapshot',{method:'POST',headers,
      body:JSON.stringify({url:'https://example.com/'})});
    assert.equal(blocked.status,400);
    await fetch(base+'/heartbeat',{method:'POST',headers});
    const health=await (await fetch(base+'/health',{headers})).json();
    assert.equal(health.extensionReady,true);
    const url='https://www.fromjapan.co.jp/japan/en/yahoo-auctions/search/Lady+Dior/-/?sort_order=end';
    const pending=fetch(base+'/snapshot',{method:'POST',headers,body:JSON.stringify({url})});
    let job;
    for(let i=0;i<20&&!job;i++){
      job=(await (await fetch(base+'/next',{headers})).json()).job;
      if(!job)await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(job.url,url);
    const posted=await fetch(base+`/result/${job.id}`,{method:'POST',headers,
      body:JSON.stringify({url,status:200,finalUrl:url,title:'JDirectItems Auction',
        body:'Search Results: 1 Items',html:'<div class="shop-item"></div>'})});
    assert.equal(posted.status,200);
    const result=await (await pending).json();
    assert.equal(result.body,'Search Results: 1 Items');
  }finally{
    await new Promise(resolve=>server.close(resolve));
  }
});

test('el puente acepta búsquedas cortas de Vestiaire y nada más',async()=>{
  const token='b'.repeat(40);
  const server=createOneMapMacBridge({token,timeoutMs:3000});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
  try{
    for(const query of ['x','a'.repeat(81),'lady\ndior','<script>']){
      const r=await fetch(base+'/vestiaire',{method:'POST',headers,body:JSON.stringify({query})});
      assert.equal(r.status,400);
    }
    const pending=fetch(base+'/vestiaire',{method:'POST',headers,body:JSON.stringify({query:'lady dior'})});
    let job;
    for(let i=0;i<20&&!job;i++){
      job=(await (await fetch(base+'/next',{headers})).json()).job;
      if(!job)await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(job.kind,'vestiaire');
    assert.equal(job.query,'lady dior');
    assert.equal(job.url,'https://es.vestiairecollective.com/');
    const body=JSON.stringify({model:{id:'7595',name:'Lady Dior'},items:[]});
    await fetch(base+`/result/${job.id}`,{method:'POST',headers,
      body:JSON.stringify({url:job.url,status:200,finalUrl:job.url,title:'Vestiaire',body,html:''})});
    const result=await (await pending).json();
    assert.equal(JSON.parse(result.body).model.name,'Lady Dior');
  }finally{
    await new Promise(resolve=>server.close(resolve));
  }
});
