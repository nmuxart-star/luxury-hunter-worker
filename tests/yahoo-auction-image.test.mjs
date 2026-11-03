import test from 'node:test';
import assert from 'node:assert/strict';
import {yahooAuctionImageUrl} from '../scripts/yahoo-auction-image.mjs';

const path='/image/dr000/auc0205/user/abc123/i-img740x740-123abc.jpg';
const mirror=`https://cdnyauction.buyee.jp${path}`;
const original=`https://auctions.c.yimg.jp/images.auctions.yahoo.co.jp${path}`;

test('converts One Map and ReefAPI Yahoo photos to the accessible auction CDN',()=>{
  assert.equal(yahooAuctionImageUrl(original),mirror);
  assert.equal(yahooAuctionImageUrl(`https://image.fromjapan.co.jp/image.php?path=${encodeURIComponent(original)}`),mirror);
  assert.equal(yahooAuctionImageUrl(`https://auc-pctr.c.yimg.jp/i/auctions.c.yimg.jp/images.auctions.yahoo.co.jp${path}?pri=l&w=300`),mirror);
  assert.equal(yahooAuctionImageUrl(mirror),mirror);
});

test('does not save placeholders, insecure URLs or unrelated Yahoo paths',()=>{
  assert.equal(yahooAuctionImageUrl('data:image/png;base64,AAAA'),null);
  assert.equal(yahooAuctionImageUrl('http://auctions.c.yimg.jp/images.auctions.yahoo.co.jp'+path),null);
  assert.equal(yahooAuctionImageUrl('https://auctions.c.yimg.jp/unrelated.jpg'),null);
  assert.equal(yahooAuctionImageUrl('https://example.com/photo.jpg'),'https://example.com/photo.jpg');
});
