import test from 'node:test';
import assert from 'node:assert/strict';
import {shouldRunAllTasks} from '../scripts/github-run-schedule.mjs';

test('automatic chained dispatch respects each model interval',()=>{
  assert.equal(shouldRunAllTasks({eventName:'workflow_dispatch',autoChain:true}),false);
  assert.equal(shouldRunAllTasks({eventName:'schedule'}),false);
});

test('a manual dispatch can still force all models',()=>{
  assert.equal(shouldRunAllTasks({eventName:'workflow_dispatch',autoChain:false}),true);
  assert.equal(shouldRunAllTasks({eventName:'workflow_dispatch',autoChain:true,loopMinutes:20}),true);
});
