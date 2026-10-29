export function shouldRunAllTasks({eventName,autoChain=false,loopMinutes=0}={}) {
  return Number(loopMinutes)>0 || (eventName==='workflow_dispatch' && !autoChain);
}
