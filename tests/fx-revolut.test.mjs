import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRevolutRate,madridParts,msUntilMadrid,madridAfter,fxDailyMessage} from '../scripts/fx-revolut.mjs';

test('parseRevolutRate: lee «€1 = ¥7.2947» y descarta lo absurdo',()=>{
  assert.equal(parseRevolutRate('Our current rate\n€1 = ¥7.2947\nAdditional fees'),7.2947);
  assert.equal(parseRevolutRate('€1 = CN¥7,2947'),7.2947);
  assert.equal(parseRevolutRate('€ 1 = ¥ 1,234.5'),null);          // fuera de rango
  assert.equal(parseRevolutRate('€1 = ¥0.13'),null);
  assert.equal(parseRevolutRate('sin cambio'),null);
  assert.equal(parseRevolutRate(''),null);
});
test('horas de Madrid: horario de invierno y de verano',()=>{
  const inv=Date.parse('2026-11-14T12:30:00Z');          // 13:30 en Madrid (UTC+1)
  assert.deepEqual(madridParts(inv),{date:'2026-11-14',hour:13,minute:30,second:0});
  const ver=Date.parse('2026-07-14T11:30:00Z');          // 13:30 en Madrid (UTC+2)
  assert.equal(madridParts(ver).hour,13);
  assert.equal(msUntilMadrid(13,30,inv),0);
  assert.equal(msUntilMadrid(13,30,Date.parse('2026-11-14T12:00:00Z')),30*60*1000);
  assert.ok(msUntilMadrid(13,30,Date.parse('2026-11-14T13:00:00Z'))<0);
  assert.equal(madridAfter(13,30,Date.parse('2026-11-14T12:31:00Z')),true);
  assert.equal(madridAfter(13,30,Date.parse('2026-11-14T12:29:00Z')),false);
});
test('mensaje diario: sube, baja, igual y primer día',()=>{
  const today={rate:7.2947,date:'2026-11-14',time:'13:30'};
  const baja=fxDailyMessage({today,prev:{rate:7.2000,date:'2026-11-13'}});     // más yuanes por euro → el yuan vale menos
  assert.match(baja,/Ha bajado/);assert.match(baja,/más barato/);assert.match(baja,/1 € = 7,2947 ¥/);assert.match(baja,/0,13709 €/);
  const sube=fxDailyMessage({today,prev:{rate:7.4,date:'2026-11-13'}});
  assert.match(sube,/Ha subido/);assert.match(sube,/más caro/);
  assert.match(fxDailyMessage({today,prev:{rate:7.2947,date:'2026-11-13'}}),/Igual/);
  assert.match(fxDailyMessage({today,prev:null}),/Primer mensaje/);
  assert.match(fxDailyMessage({today,prev:null,source:'BCE',note:'Revolut no respondió'}),/Fuente: BCE · Revolut no respondió/);
});
