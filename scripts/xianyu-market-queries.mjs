// Additional candidates from the 2025-2026 market evidence documented in
// docs/xianyu-mercado-2026-11.md. They share the existing radar search budget.
export const XIANYU_MARKET_QUERIES=[
  '古驰 Padlock 挂锁包',
  '迪奥 Bow 蝴蝶结 包',
  '香奈儿 Executive Tote 托特包',
  '路易威登 Speedy 手提包',
  '古驰 Dionysus 酒神包'
];

export function addXianyuMarketQueries(queries=[]){
  const values=[...queries,...XIANYU_MARKET_QUERIES].map(x=>String(x||'').trim()).filter(Boolean);
  return [...new Set(values)];
}
