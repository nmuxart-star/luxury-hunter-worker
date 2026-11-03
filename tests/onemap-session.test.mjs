import test from 'node:test';
import assert from 'node:assert/strict';
import {isOneMapMemberPage,oneMapMemberId,oneMapOnlyStorageState} from '../scripts/onemap-session.mjs';

test('confirma el área privada y la identidad de One Map',()=>{
  const body='My Account Hello New User Member ID: H12345 Your current rank';
  assert.equal(oneMapMemberId(body),'H12345');
  assert.equal(isOneMapMemberPage('https://www.fromjapan.co.jp/japan/en/member/watch/list/',body),true);
  assert.equal(isOneMapMemberPage('https://www.fromjapan.co.jp/en/member/login',body),false);
  assert.equal(isOneMapMemberPage('https://other.example/japan/en/member/watch/list/',body),false);
});

test('excluye cookies y datos de otros sitios antes de guardar la sesión',()=>{
  const state={cookies:[
    {domain:'.fromjapan.co.jp',name:'session',value:'secret'},
    {domain:'accounts.google.com',name:'google',value:'private'}
  ],origins:[
    {origin:'https://www.fromjapan.co.jp',localStorage:[]},
    {origin:'https://accounts.google.com',localStorage:[{name:'key',value:'private'}]}
  ]};
  assert.deepEqual(oneMapOnlyStorageState(state),{
    cookies:[state.cookies[0]],origins:[state.origins[0]]
  });
  assert.throws(()=>oneMapOnlyStorageState({cookies:[state.cookies[1]]}));
});
