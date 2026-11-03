import test from 'node:test';
import assert from 'node:assert/strict';
import {oneMapSearchUrl,oneMapTimeLeftMs,parseOneMapAuctions} from '../scripts/onemap-auctions.mjs';

const NOW=Date.parse('2026-11-03T12:00:00.000Z');

test('One Map search URL and auction countdown',()=>{
  assert.equal(oneMapSearchUrl('Dior Lady'),
    'https://www.fromjapan.co.jp/japan/en/yahoo-auctions/search/Dior+Lady/-/?sort_order=end');
  assert.equal(oneMapTimeLeftMs('4days 23:58:44'),
    ((4*24+23)*3600+58*60+44)*1000);
  assert.equal(oneMapTimeLeftMs('14:08:27'),(14*3600+8*60+27)*1000);
  assert.equal(oneMapTimeLeftMs('25:00:00'),null);
});

test('parses visible auction cards and ignores invalid or duplicated ones',()=>{
  const card=(id,price,clock,extra='')=>`<div class="shop-item">
    <div class="item-box"><a href="/japan/en/auction/yahoo/input/${id}/"><img src="https://example.com/${id}.jpg"></a></div>
    <a href="/japan/en/auction/yahoo/input/${id}/"><span class="title-height">Christian Dior Lady Dior</span></a>
    <div class="leading-tight mb-2"><p>${price} JPY</p></div>
    <span><div class="bidrealtime"><svg></svg></div>7</span>
    <span><svg class="feather-clock"></svg>${clock}</span>${extra}
  </div>`;
  const html=card('s1250673988','57,000','14:08:27','Buy It Now price 80,000 JPY')+
    card('s1250673988','57,000','14:08:27')+
    card('s0000000000','unknown','14:08:27')+
    card('s1111111111','1,000','expired');
  assert.deepEqual(parseOneMapAuctions(html,NOW),[{
    id:'s1250673988',
    url:'https://www.fromjapan.co.jp/japan/en/auction/yahoo/input/s1250673988/',
    title:'Christian Dior Lady Dior',currentBid:57000,currency:'JPY',bids:7,
    endsAt:'2026-11-04T02:08:27.000Z',timeLeftMs:(14*3600+8*60+27)*1000,
    buyNow:80000,image:'https://example.com/s1250673988.jpg'
  }]);
});
