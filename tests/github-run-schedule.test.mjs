import test from 'node:test';
import assert from 'node:assert/strict';
import {shouldRunAllTasks,isDue,nextDueTask} from '../scripts/github-run-schedule.mjs';

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
