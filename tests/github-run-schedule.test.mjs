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
  assert.deepEqual(plan.tasks.map(t=>t.task_name),['Chanel Classic Flap','Lady Dior','Celine Luggage','Rolex Datejust']);
  assert.deepEqual(plan.deferred.map(t=>t.task_name),['Omega Speedmaster']);
  assert.equal(planCycle(runnable,{maxWatches:0}).tasks.some(t=>isWatchTaskName(t.task_name)),false);
});

test('watch task names are recognised, bag names are not',()=>{
  for(const n of ['Omega Speedmaster','Rolex Datejust','Tudor Black Bay','Grand Seiko SBGA','Cartier Santos','Reloj radar'])assert.equal(isWatchTaskName(n),true,n);
  for(const n of ['Lady Dior','Chanel Classic Flap','Radar oportunidades','Celine Triomphe','Saint Laurent Loulou Puffer','Hermes Evelyne'])assert.equal(isWatchTaskName(n),false,n);
});
