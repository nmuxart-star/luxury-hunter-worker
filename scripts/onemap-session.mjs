export const ONEMAP_MEMBER_URL='https://www.fromjapan.co.jp/japan/en/member/watch/list/';

function isOneMapHost(hostname){
  return hostname==='fromjapan.co.jp'||hostname.endsWith('.fromjapan.co.jp');
}

export function oneMapMemberId(body){
  return String(body||'').match(/Member ID\s*:\s*([A-Z][A-Z0-9-]+)/i)?.[1]||null;
}

export function isOneMapMemberPage(url,body){
  try{
    const u=new URL(url);
    return u.protocol==='https:'&&isOneMapHost(u.hostname)&&
      /^\/japan\/en\/member\/watch\/list\/?$/.test(u.pathname)&&
      /\bMy Account\b/i.test(String(body||''))&&
      !!oneMapMemberId(body);
  }catch{return false;}
}

// Playwright's storage state may contain other origins if the login flow
// redirects. Only the One Map domain is permitted in the cloud secret.
export function oneMapOnlyStorageState(state){
  const cookies=(Array.isArray(state?.cookies)?state.cookies:[])
    .filter(cookie=>isOneMapHost(String(cookie.domain||'').replace(/^\./,'')));
  const origins=(Array.isArray(state?.origins)?state.origins:[])
    .filter(origin=>{
      try{
        const u=new URL(origin.origin);
        return u.protocol==='https:'&&isOneMapHost(u.hostname);
      }catch{return false;}
    });
  if(!cookies.length)throw new Error('One Map no devolvió cookies de sesión.');
  return {cookies,origins};
}
