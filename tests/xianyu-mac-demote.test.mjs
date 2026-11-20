import test from 'node:test';import assert from 'node:assert/strict';
import {noteMacVerification,isMacDemoted,tickMacDemote,DEMOTE_DEFAULTS} from '../scripts/xianyu-mac-demote.mjs';
const H=3600e3,M=60e3;
test('3 verificaciones en menos de 3 h degradan el Mac',()=>{
  let s=noteMacVerification(null,0);s=noteMacVerification(s,60*M);assert.equal(isMacDemoted(s),false);
  s=noteMacVerification(s,150*M);assert.equal(isMacDemoted(s),true);
});
test('3 verificaciones repartidas en más de 3 h no degradan',()=>{
  let s=noteMacVerification(null,0);s=noteMacVerification(s,2*H);s=noteMacVerification(s,4*H);
  assert.equal(isMacDemoted(s),false);assert.equal(s.events.length,2);
});
test('la misma verificación en varias búsquedas seguidas cuenta una vez',()=>{
  let s=noteMacVerification(null,0);s=noteMacVerification(s,2*M);s=noteMacVerification(s,5*M);
  assert.equal(s.events.length,1);assert.equal(isMacDemoted(s),false);
});
test('se recupera tras 4 h de bot en la nube con el Mac conectado',()=>{
  let s=noteMacVerification(null,0);s=noteMacVerification(s,30*M);s=noteMacVerification(s,60*M);assert.equal(isMacDemoted(s),true);
  let t=2*H;s=tickMacDemote(s,{now:t,macConnected:true,routeIsCloud:true});
  for(let i=0;i<15;i++){t+=15*M;s=tickMacDemote(s,{now:t,macConnected:true,routeIsCloud:true});}
  assert.equal(isMacDemoted(s),true);          // 3 h 45 min: todavía no
  t+=15*M;s=tickMacDemote(s,{now:t,macConnected:true,routeIsCloud:true});t+=15*M;s=tickMacDemote(s,{now:t,macConnected:true,routeIsCloud:true});
  assert.equal(isMacDemoted(s),false);
});
test('con el Mac apagado o sin buscar en la nube no se cuenta tiempo',()=>{
  let s=noteMacVerification(null,0);s=noteMacVerification(s,30*M);s=noteMacVerification(s,60*M);
  let t=2*H;for(let i=0;i<40;i++){t+=15*M;s=tickMacDemote(s,{now:t,macConnected:false,routeIsCloud:true});}
  assert.equal(isMacDemoted(s),true);assert.equal(s.demote.cloudMs,0);
  for(let i=0;i<40;i++){t+=15*M;s=tickMacDemote(s,{now:t,macConnected:true,routeIsCloud:false});}
  assert.equal(s.demote.cloudMs,0);
});
test('un hueco largo entre llamadas solo suma 15 min',()=>{
  let s=noteMacVerification(null,0);s=noteMacVerification(s,30*M);s=noteMacVerification(s,60*M);
  s=tickMacDemote(s,{now:2*H,macConnected:true,routeIsCloud:true});s=tickMacDemote(s,{now:10*H,macConnected:true,routeIsCloud:true});
  assert.equal(s.demote.cloudMs,DEMOTE_DEFAULTS.tickMaxMs);
});
