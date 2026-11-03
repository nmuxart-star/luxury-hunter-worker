import {load as loadHtml} from 'cheerio';

const BASE='https://www.fromjapan.co.jp';
const ITEM_RE=/^\/japan\/en\/auction\/yahoo\/input\/([a-z0-9]+)\/?$/i;

export function oneMapSearchUrl(query){
  return `${BASE}/japan/en/yahoo-auctions/search/${encodeURIComponent(String(query).trim()).replace(/%20/g,'+')}/-/?sort_order=end`;
}

export function oneMapTimeLeftMs(value){
  const s=String(value||'').trim();
  const m=s.match(/^(?:(\d+)\s*days?\s*)?(\d{1,2}):(\d{2}):(\d{2})$/i);
  if(!m)return null;
  const days=Number(m[1]||0),hours=Number(m[2]),minutes=Number(m[3]),seconds=Number(m[4]);
  if(hours>23||minutes>59||seconds>59)return null;
  return ((days*24+hours)*60*60+minutes*60+seconds)*1000;
}

export function parseOneMapAuctions(html,now=Date.now()){
  const $=loadHtml(html);
  const items=[];
  const seen=new Set();
  $('.shop-item').each((_,el)=>{
    const card=$(el);
    const titleLink=card.find('a[href*="/auction/yahoo/input/"] .title-height').first().closest('a');
    const href=titleLink.attr('href')||'';
    let url;
    try{url=new URL(href,BASE);}catch{return;}
    const id=url.pathname.match(ITEM_RE)?.[1];
    if(!id||seen.has(id))return;
    const title=titleLink.find('.title-height').first().text().replace(/\s+/g,' ').trim();
    const priceText=card.find('.leading-tight.mb-2 p').first().text();
    const priceMatch=priceText.match(/([\d,]+)\s*JPY/i);
    const currentBid=priceMatch?Number(priceMatch[1].replaceAll(',','')):NaN;
    const clock=card.find('.feather-clock').first().parent().text().replace(/\s+/g,' ').trim();
    const leftMs=oneMapTimeLeftMs(clock);
    if(!title||!Number.isFinite(currentBid)||currentBid<=0||leftMs==null||leftMs<=0)return;
    const bidsText=card.find('.bidrealtime').first().parent().text().trim();
    const bidsMatch=bidsText.match(/\d+/);
    const bids=bidsMatch?Number(bidsMatch[0]):0;
    const image=card.find('.item-box img').first().attr('src')||'';
    const buyNowText=card.text().match(/Buy It Now price\s*([\d,]+)\s*JPY/i);
    seen.add(id);
    items.push({
      id,url:url.href,title,currentBid,currency:'JPY',
      bids,
      endsAt:new Date(now+leftMs).toISOString(),
      timeLeftMs:leftMs,
      buyNow:buyNowText?Number(buyNowText[1].replaceAll(',','')):null,
      image:/^https?:\/\//i.test(image)?image:null
    });
  });
  return items;
}

export function parseOneMapDetail(html){
  const $=loadHtml(html);
  const field=label=>$('.vx-row').filter((_,el)=>
    $(el).children('.vx-col').first().text().replace(/\s+/g,' ').trim()===label
  ).first().children('.vx-col').eq(1);
  const ratings=field('Overall rating').find('span.pl-1.font-medium').map((_,el)=>
    Number($(el).text().replaceAll(',',''))
  ).get();
  return {
    seller:field('Seller').find('a').first().text().replace(/\s+/g,' ').trim()||null,
    sellerType:field('Seller type').text().replace(/\s+/g,' ').trim()||null,
    condition:field('Item condition').text().replace(/\s+/g,' ').trim()||null,
    positiveRatings:Number.isFinite(ratings[0])?ratings[0]:null,
    negativeRatings:Number.isFinite(ratings[1])?ratings[1]:null
  };
}
