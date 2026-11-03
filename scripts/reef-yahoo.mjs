import {yahooAuctionImageUrl} from './yahoo-auction-image.mjs';

const ENDPOINT='https://api.reefapi.com/yahoo-auctions/v1/search';

export function reefAuctionCard(row,now=Date.now()){
  const id=String(row?.auction_id||'').trim();
  const title=String(row?.title||'').replace(/\s+/g,' ').trim();
  const price=Number(row?.price);
  const endMs=Date.parse(String(row?.end_time||''));
  if(!/^[a-z]?[0-9]{8,11}$/i.test(id)||!title||!Number.isFinite(price)||price<=0||
    !Number.isFinite(endMs)||endMs<=now||row?.is_fixed_price===true||
    row?.listing_type==='fleamarket')return null;
  return {
    id,
    url:`https://www.fromjapan.co.jp/japan/en/auction/yahoo/input/${id}/`,
    title,
    currentBid:price,
    currency:'JPY',
    bids:Number(row?.bid_count)||0,
    endsAt:new Date(endMs).toISOString(),
    timeLeftMs:endMs-now,
    buyNow:row?.buy_now_price!=null&&Number.isFinite(Number(row.buy_now_price))
      ?Number(row.buy_now_price):null,
    image:yahooAuctionImageUrl(row?.image),
    condition:String(row?.condition||'').trim()||null,
    sellerId:String(row?.seller?.id||'').trim()||null,
    sellerPositivePercent:row?.seller?.positive_percent!=null&&Number.isFinite(Number(row.seller.positive_percent))
      ? Number(row.seller.positive_percent):null,
    shippingFee:row?.shipping_fee!=null&&Number.isFinite(Number(row.shipping_fee))
      ?Number(row.shipping_fee):null
  };
}

export async function searchReefYahoo(query,{apiKey,limit=50,fetchImpl=fetch,timeoutMs=30000}={}){
  if(!apiKey)throw new Error('REEF_API_KEY no configurada');
  const response=await fetchImpl(ENDPOINT,{
    method:'POST',
    headers:{'x-api-key':apiKey,'content-type':'application/json'},
    body:JSON.stringify({query:String(query||'').trim(),listing_format:'auction',
      seller_type:'individual,store',sort:'ending_soon',limit:Math.min(100,Math.max(1,Number(limit)||50))}),
    signal:AbortSignal.timeout(timeoutMs)
  });
  const json=await response.json().catch(()=>null);
  if(!response.ok||json?.ok!==true||!Array.isArray(json?.data?.items)){
    const code=String(json?.error?.code||json?.error?.message||'respuesta inválida').slice(0,100);
    throw new Error(`ReefAPI HTTP ${response.status}: ${code}`);
  }
  const now=Date.now();
  return {items:json.data.items.map(row=>reefAuctionCard(row,now)).filter(Boolean),
    recordCount:Number(json?.meta?.record_count)||0};
}
