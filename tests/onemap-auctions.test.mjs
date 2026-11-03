import test from 'node:test';
import assert from 'node:assert/strict';
import {oneMapSearchUrl,oneMapTimeLeftMs,parseOneMapAuctions,parseOneMapDetail} from '../scripts/onemap-auctions.mjs';

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

test('lee la puja en JPY cuando One Map muestra EUR como moneda principal',()=>{
  const html=`<div class="shop-item">
    <div class="item-box"><a href="/japan/en/auction/yahoo/input/s1250673988/"><img src="https://auctions.c.yimg.jp/images.auctions.yahoo.co.jp/image/dr000/auc0205/user/abc123/i-img740x740-123abc.jpg"></a></div>
    <a href="/japan/en/auction/yahoo/input/s1250673988/"><span class="title-height">Lady Dior</span></a>
    <div class="leading-tight mb-2"><p>≈ 755.20 EUR</p><span>( 128,000 JPY)</span></div>
    <div>Buy It Now price <p>≈ 790.00 EUR</p><span>( 134,000 JPY)</span></div>
    <span><div class="bidrealtime"></div>1</span><span><svg class="feather-clock"></svg>01:15:00</span>
  </div>`;
  const [item]=parseOneMapAuctions(html,NOW);
  assert.equal(item.currentBid,128000);
  assert.equal(item.buyNow,134000);
  assert.equal(item.image,
    'https://cdnyauction.buyee.jp/image/dr000/auc0205/user/abc123/i-img740x740-123abc.jpg');
});

test('reads condition and seller reputation from an auction page',()=>{
  const row=(label,value)=>`<div class="vx-row"><div class="vx-col">${label}</div><div class="vx-col">${value}</div></div>`;
  const html=row('Item condition','Visibly Used')+
    row('Seller','<a>ヒトトキネット</a>')+
    row('Seller type','Personal')+
    row('Overall rating','<a><span>510</span></a> (<span class="pl-1 font-medium">510</span><span class="pl-1 font-medium">0</span>)');
  assert.deepEqual(parseOneMapDetail(html),{
    seller:'ヒトトキネット',sellerType:'Personal',condition:'Visibly Used',
    positiveRatings:510,negativeRatings:0
  });
});
