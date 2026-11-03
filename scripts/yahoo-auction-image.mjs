const MIRROR='https://cdnyauction.buyee.jp';
const YAHOO_PREFIX='/images.auctions.yahoo.co.jp';
const RESIZED_PREFIX='/i/auctions.c.yimg.jp/images.auctions.yahoo.co.jp';
const IMAGE_PATH=/^\/image\/[A-Za-z0-9/_%.\-]+\.(?:jpe?g|png|webp)$/i;

// Yahoo's image hosts are unavailable to viewers in Europe. Buyee publishes
// the same auction image paths on its own CDN, including the original size.
export function yahooAuctionImageUrl(raw){
  if(!raw)return null;
  let url;
  try{url=new URL(String(raw).trim());}catch{return null;}
  if(url.protocol!=='https:')return null;

  if(url.hostname==='image.fromjapan.co.jp'&&url.pathname==='/image.php'){
    return yahooAuctionImageUrl(url.searchParams.get('path'));
  }

  let imagePath=null;
  if(url.hostname==='auctions.c.yimg.jp'&&url.pathname.startsWith(`${YAHOO_PREFIX}/image/`)){
    imagePath=url.pathname.slice(YAHOO_PREFIX.length);
  }else if(url.hostname==='auc-pctr.c.yimg.jp'&&url.pathname.startsWith(`${RESIZED_PREFIX}/image/`)){
    imagePath=url.pathname.slice(RESIZED_PREFIX.length);
  }else if(url.hostname==='cdnyauction.buyee.jp'){
    imagePath=url.pathname;
  }

  if(imagePath){
    return IMAGE_PATH.test(imagePath)?`${MIRROR}${imagePath}`:null;
  }
  if(['auctions.c.yimg.jp','auc-pctr.c.yimg.jp','image.fromjapan.co.jp'].includes(url.hostname)){
    return null;
  }
  return url.href;
}
