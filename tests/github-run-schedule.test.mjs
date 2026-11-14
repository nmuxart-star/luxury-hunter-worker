import test from 'node:test';
import assert from 'node:assert/strict';
import {shouldRunAllTasks,isDue,nextDueTask,planCycle,isWatchTaskName} from '../scripts/github-run-schedule.mjs';

test('automatic chained dispatch respects each model interval',()=>{
  assert.equal(shouldRunAllTasks({eventName:'workflow_dispatch',autoChain:true}),false);
  assert.equal(shouldRunAllTasks({eventName:'schedule'}),false);
});

test('a manual dispatch can still force all models',()=>{
  assert.equal(shouldRunAllTasks({eventName:'workflow_dispatch',autoChain:false}),true);
  assert.equal(shouldRunAllTasks({eventName:'workflow_dispatch',autoChain:true,loopMinutes:20}),true);
});

const now=Date.parse('2026-10-31T05:30:00Z');
const ago=min=>new Date(now-min*60000).toISOString();

test('a model is due once its interval has passed (2 min slack)',()=>{
  assert.equal(isDue({enabled:1,interval_minutes:60,last_run_at:ago(57)},now),false);
  assert.equal(isDue({enabled:1,interval_minutes:60,last_run_at:ago(58)},now),true);
  assert.equal(isDue({enabled:1,interval_minutes:60,last_run_at:null},now),true);
  assert.equal(isDue({enabled:0,interval_minutes:60,last_run_at:ago(500)},now),false);
});

test('an idle run knows which model comes next and how long to wait',()=>{
  const next=nextDueTask([
    {task_name:'Lady Dior',enabled:1,interval_minutes:60,last_run_at:ago(40)},
    {task_name:'Celine Luggage',enabled:1,interval_minutes:180,last_run_at:ago(170)},
    {task_name:'Off',enabled:0,interval_minutes:60,last_run_at:ago(59)}
  ],now);
  assert.equal(next.task.task_name,'Celine Luggage');
  assert.equal(next.ms,8*60000);
  assert.equal(nextDueTask([{task_name:'Nunca',enabled:1,interval_minutes:60,last_run_at:null}],now).ms,0);
  assert.equal(nextDueTask([],now),null);
});

test('watches never take the place of bags: bags first, at most one watch per run',()=>{
  const runnable=[
    {task_name:'Omega Speedmaster',interval_minutes:240,last_run_at:ago(300)},
    {task_name:'Lady Dior',interval_minutes:60,last_run_at:ago(70)},
    {task_name:'Rolex Datejust',interval_minutes:240,last_run_at:ago(500)},
    {task_name:'Celine Luggage',interval_minutes:180,last_run_at:ago(200)},
    {task_name:'Chanel Classic Flap',interval_minutes:60,last_run_at:ago(90)}
  ];
  const plan=planCycle(runnable,{maxWatches:1});
  assert.deepEqual(plan.tasks.map(t=>t.task_name),['Chanel Classic Flap','Lady Dior','Rolex Datejust','Celine Luggage']);
  assert.deepEqual(plan.deferred.map(t=>t.task_name),['Omega Speedmaster']);
  assert.equal(planCycle(runnable,{maxWatches:0}).tasks.some(t=>isWatchTaskName(t.task_name)),false);
});

test('watch task names are recognised, bag names are not',()=>{
  for(const n of ['Omega Speedmaster','Rolex Datejust','Tudor Black Bay','Grand Seiko SBGA','Cartier Santos','Reloj radar'])assert.equal(isWatchTaskName(n),true,n);
  for(const n of ['Lady Dior','Chanel Classic Flap','Radar oportunidades','Celine Triomphe','Saint Laurent Loulou Puffer','Hermes Evelyne'])assert.equal(isWatchTaskName(n),false,n);
});

test('watch tiers: the higher tier goes first even if a lower tier waited longer',()=>{
  const runnable=[
    {task_name:'Rolex vintage',description:'TIER: 3\n...',interval_minutes:240,last_run_at:ago(600)},
    {task_name:'Omega Seamaster 300M',description:'TIER: 1\n...',interval_minutes:240,last_run_at:ago(250)},
    {task_name:'Tudor',description:'TIER: 2\n...',interval_minutes:240,last_run_at:ago(400)},
    {task_name:'Lady Dior',interval_minutes:60,last_run_at:ago(70)}
  ];
  const plan=planCycle(runnable,{maxWatches:1});
  assert.deepEqual(plan.tasks.map(t=>t.task_name),['Lady Dior','Omega Seamaster 300M']);
  assert.deepEqual(plan.deferred.map(t=>t.task_name),['Tudor','Rolex vintage']);
  assert.equal(isWatchTaskName('TAG Heuer Monaco y Carrera'),true);
});

test('watches alternate with non-priority bags; 60-min bags always go first',()=>{
  const runnable=[
    {task_name:'Celine Luggage',interval_minutes:180,last_run_at:ago(400)},
    {task_name:'Radar oportunidades',interval_minutes:360,last_run_at:ago(700)},
    {task_name:'Omega Speedmaster',description:'TIER: 1',interval_minutes:240,last_run_at:ago(300)},
    {task_name:'Tudor',description:'TIER: 2',interval_minutes:240,last_run_at:ago(300)},
    {task_name:'Lady Dior',interval_minutes:60,last_run_at:ago(70)},
    {task_name:'Loewe Puzzle',interval_minutes:180,last_run_at:ago(200)},
    {task_name:'Chanel Classic Flap',interval_minutes:60,last_run_at:ago(90)}
  ];
  const plan=planCycle(runnable,{maxWatches:2});
  assert.deepEqual(plan.tasks.map(t=>t.task_name),['Chanel Classic Flap','Lady Dior','Omega Speedmaster','Celine Luggage','Tudor','Loewe Puzzle','Radar oportunidades']);
  assert.deepEqual(plan.deferred,[]);
});

import {withRadarExtras,isRadarTaskName} from '../scripts/github-run-schedule.mjs';
test('cupo extra del Radar: se añade sin quitar ni reordenar las demás salidas',()=>{
  const radar={id:99,task_name:'Radar oportunidades',enabled:true};
  const mk=n=>({task:{id:n,task_name:'M'+n,enabled:true},mode:'full',urgency:10-n});
  const base=[mk(1),mk(2),mk(3),mk(4),mk(5)];
  const out=withRadarExtras(base,radar,{extra:1,every:3});
  assert.equal(out.length,6);
  assert.deepEqual(out.filter(x=>!x.extra).map(x=>x.task.id),[1,2,3,4,5]);
  assert.equal(out[3].extra,true);                    // tras las tres primeras
  assert.equal(out[3].task.id,99);
  // dos extras: tras la 3ª y tras la 6ª (o al final si no hay tantas)
  const dos=withRadarExtras(base,radar,{extra:2,every:3});
  assert.equal(dos.filter(x=>x.extra).length,2);
  assert.deepEqual(dos.filter(x=>!x.extra).map(x=>x.task.id),[1,2,3,4,5]);
  // cola corta o vacía: el extra sale igualmente
  assert.equal(withRadarExtras([],radar,{extra:1}).length,1);
  assert.equal(withRadarExtras([mk(1)],radar,{extra:1,every:3}).length,2);
});
test('cupo extra del Radar: apagado o sin Radar activo no cambia nada',()=>{
  const base=[{task:{id:1,task_name:'M1',enabled:true},mode:'full',urgency:1}];
  assert.equal(withRadarExtras(base,{id:9,task_name:'Radar oportunidades',enabled:true},{extra:0}),base);
  assert.equal(withRadarExtras(base,null,{extra:1}),base);
  assert.equal(withRadarExtras(base,{id:9,task_name:'Radar oportunidades',enabled:false},{extra:1}),base);
  assert.equal(isRadarTaskName('Radar oportunidades'),true);
  assert.equal(isRadarTaskName('Lady Dior'),false);
  assert.equal(isRadarTaskName('Reloj radar'),false);
});

import {extraKindAt,pickStarvedWatch,withExtraSlots,launchUrgency} from '../scripts/github-run-schedule.mjs';
test('salida extra: patrón watch,radar,watch según el número de ejecución',()=>{
  assert.deepEqual([0,1,2,3,4,5].map(i=>extraKindAt(i)),['watch','radar','watch','watch','radar','watch']);
  assert.equal(extraKindAt(7,'radar'),'radar');
  assert.equal(extraKindAt(0,'tonterías'),'radar');
});
test('pickStarvedWatch: elige el reloj con más retraso, ignora los recientes y los que ya están en cola',()=>{
  const now=Date.parse('2026-11-14T18:00:00Z');
  const w=(id,name,hAgo)=>({id,task_name:name,enabled:true,interval_minutes:240,last_run_at:new Date(now-hAgo*3600e3).toISOString()});
  const lista=[w(1,'Tudor',1),w(2,'Grand Seiko',24),w(3,'Rolex vintage',22),w(4,'Omega Speedmaster',5)];
  assert.equal(pickStarvedWatch(lista,new Set(),{now}).id,2);
  assert.equal(pickStarvedWatch(lista,new Set([2]),{now}).id,3);
  assert.equal(pickStarvedWatch([w(1,'Tudor',1)],new Set(),{now}),null);                 // salió hace 1 h: aún no
  assert.equal(pickStarvedWatch([{...w(5,'Lady Dior',30)}],new Set(),{now}),null);       // no es un reloj
  assert.equal(pickStarvedWatch([{...w(6,'Tudor',30),enabled:false}],new Set(),{now}),null);
});
test('withExtraSlots: el extra es un reloj atrasado o el Radar, sin quitar ni reordenar lo que había',()=>{
  const now=Date.parse('2026-11-14T18:00:00Z');
  const radar={id:99,task_name:'Radar oportunidades',enabled:true,interval_minutes:30};
  const watch={id:20,task_name:'Grand Seiko',enabled:true,interval_minutes:240,last_run_at:new Date(now-24*3600e3).toISOString()};
  const mk=n=>({task:{id:n,task_name:'M'+n,enabled:true},mode:'full',urgency:10-n});
  const base=[mk(1),mk(2),mk(3),mk(4)];
  const conReloj=withExtraSlots(base,{radarTask:radar,watchTasks:[watch],extra:1,runNumber:0,now});     // 0 → watch
  assert.equal(conReloj.find(x=>x.extra).task.id,20);
  assert.deepEqual(conReloj.filter(x=>!x.extra).map(x=>x.task.id),[1,2,3,4]);
  const conRadar=withExtraSlots(base,{radarTask:radar,watchTasks:[watch],extra:1,runNumber:1,now});     // 1 → radar
  assert.equal(conRadar.find(x=>x.extra).task.id,99);
  const sinReloj=withExtraSlots(base,{radarTask:radar,watchTasks:[],extra:1,runNumber:0,now});          // no hay reloj atrasado → Radar
  assert.equal(sinReloj.find(x=>x.extra).task.id,99);
  assert.equal(withExtraSlots(base,{radarTask:radar,watchTasks:[watch],extra:0,now}),base);
  assert.equal(withExtraSlots(base,{radarTask:null,watchTasks:[],extra:1,now}).length,4);               // sin nada que añadir
});
test('urgencia: un reloj muy atrasado supera a un bolso de 60 min con el tope nuevo; sin él, no',()=>{
  const now=Date.parse('2026-11-14T18:00:00Z');
  const reloj={task:{task_name:'Grand Seiko',interval_minutes:240,last_run_at:new Date(now-24*3600e3).toISOString(),description:'TIER: 2'},mode:'full'};
  const bolso={task:{task_name:'Lady Dior',interval_minutes:60,last_run_at:new Date(now-5*3600e3).toISOString(),description:''},mode:'full'};
  const o={now,rand:()=>0.5};
  assert.ok(launchUrgency(reloj,{...o,watchClamp:8})>launchUrgency(bolso,{...o,watchClamp:8}));
  assert.ok(launchUrgency(reloj,{...o,watchClamp:4})<launchUrgency(bolso,{...o,watchClamp:4}));
  const radar={task:{task_name:'Radar oportunidades',interval_minutes:30,last_run_at:new Date(now-3*3600e3).toISOString()},mode:'full'};
  assert.ok(launchUrgency(radar,{...o,radarWeight:1.3})<launchUrgency(radar,{...o,radarWeight:1.8}));
});
