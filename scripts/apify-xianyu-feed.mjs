export const APIFY_XIANYU_ACTOR_ID = 'luMzRxtusd5YXI5dX';

const clampInt = (value, fallback, min, max) => {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(min, Math.min(max, Math.trunc(number)))
    : fallback;
};

const bool = value => ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());

export function apifyXianyuFeedConfig(env = process.env) {
  const token = String(env.APIFY_API_TOKEN || '').trim();
  const explicitlyEnabled = env.APIFY_XIANYU_FEED_ENABLED;
  const enabled = bool(explicitlyEnabled);
  const maxTotalChargeUsd = Number(env.APIFY_XIANYU_FEED_MAX_CHARGE_USD ?? 0.25);

  return {
    enabled,
    configured: Boolean(token),
    token,
    maxItems: clampInt(env.APIFY_XIANYU_FEED_MAX_ITEMS, 100, 1, 1000),
    intervalMin: clampInt(env.APIFY_XIANYU_FEED_INTERVAL_MIN, 360, 1, 10080),
    maxTotalChargeUsd: Number.isFinite(maxTotalChargeUsd) && maxTotalChargeUsd > 0
      ? Math.min(maxTotalChargeUsd, 25)
      : 0.25
  };
}

export async function fetchApifyXianyuFeed({
  token,
  maxItems = 100,
  maxTotalChargeUsd = 0.25,
  timeoutMs = 180_000,
  fetchImpl = fetch
} = {}) {
  if (!String(token || '').trim()) throw new Error('Falta APIFY_API_TOKEN.');

  const boundedItems = clampInt(maxItems, 100, 1, 1000);
  const boundedCharge = Number.isFinite(Number(maxTotalChargeUsd)) && Number(maxTotalChargeUsd) > 0
    ? Math.min(Number(maxTotalChargeUsd), 25)
    : 0.25;
  const url = new URL(`https://api.apify.com/v2/acts/${APIFY_XIANYU_ACTOR_ID}/run-sync-get-dataset-items`);
  url.searchParams.set('timeout', String(Math.max(1, Math.min(300, Math.ceil(timeoutMs / 1000)))));
  url.searchParams.set('maxItems', String(boundedItems));
  url.searchParams.set('maxTotalChargeUsd', String(boundedCharge));

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${String(token).trim()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({ mode: 'feed', maxItems: boundedItems, fetchDetails: false }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }

  if (!response.ok) {
    const detail = typeof data?.error?.message === 'string'
      ? data.error.message
      : text.slice(0, 300);
    throw new Error(`Apify respondió HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  if (!Array.isArray(data)) {
    throw new Error('Apify devolvió una respuesta que no es una lista de anuncios.');
  }
  return data;
}

function textValue(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function normalizeApifyXianyuItem(item = {}) {
  const id = textValue(item.itemId ?? item.id);
  const price = Number(item.price);
  const title = textValue(item.title);
  if (!id || !title || !Number.isFinite(price) || price <= 0) return null;

  const url = textValue(item.url) || `https://www.goofish.com/item?id=${encodeURIComponent(id)}`;
  const images = Array.isArray(item.images)
    ? item.images.map(value => textValue(value).replace(/^\/\//, 'https://')).filter(Boolean)
    : [];
  const mainImage = textValue(item.mainImage || images[0] || '').replace(/^\/\//, 'https://');
  const tags = [];
  if (item.freeShipping === true) tags.push('包邮');
  if (item.acceptsBargain === true) tags.push('可议价');

  return {
    id,
    title,
    price,
    currency: textValue(item.currency) || 'CNY',
    url,
    image: mainImage,
    images,
    seller: textValue(item.seller),
    area: textValue(item.city),
    wants: item.wantCount ?? null,
    tags,
    // scrapedAt es la hora de captura, no la fecha de publicación del anuncio.
    publishedAt: null,
    scrapedAt: textValue(item.scrapedAt) || null,
    apifyFeed: true,
    rawRecord: item
  };
}

const genericTerms = new Set([
  'bag', 'bags', 'handbag', 'handbags', 'purse', 'purses', 'wallet', 'wallets',
  'vintage', 'preloved', 'secondhand', 'second-hand', 'used', 'women', 'woman',
  'leather', 'authentic', 'authenticity', 'new', 'old', 'style', 'classic',
  '复古', '包', '女包', '真皮', '中古'
]);

function queryTokens(value) {
  return (String(value || '').normalize('NFKC').toLowerCase().match(/[\p{Script=Han}]{2,}|[a-z0-9]{4,}/gu) || [])
    .filter(token => !genericTerms.has(token));
}

export function apifyItemMatchesQueries(item, queries = []) {
  const title = textValue(item?.title).normalize('NFKC').toLowerCase();
  if (!title) return false;
  const normalizedTitle = title.replace(/[^\p{L}\p{N}]/gu, '');

  for (const query of queries || []) {
    const tokens = queryTokens(query);
    if (!tokens.length) continue;
    const hanTokens = tokens.filter(token => /\p{Script=Han}/u.test(token));
    if (hanTokens.some(token => normalizedTitle.includes(token.replace(/[^\p{L}\p{N}]/gu, '')))) return true;

    const latinTokens = tokens.filter(token => !/\p{Script=Han}/u.test(token));
    const matched = latinTokens.filter(token => normalizedTitle.includes(token.replace(/[^\p{L}\p{N}]/gu, '')));
    if (latinTokens.length === 1 && matched.length === 1) return true;
    if (latinTokens.length > 1 && matched.length >= 2) return true;
  }
  return false;
}

export function selectRelevantApifyXianyuItems(items, { queries = [], product = '', maxItems = 100 } = {}) {
  const searchTerms = [...new Set([...(queries || []), product].map(textValue).filter(Boolean))];
  const limit = clampInt(maxItems, 100, 1, 1000);
  const seen = new Set();
  const selected = [];

  for (const raw of items || []) {
    const item = normalizeApifyXianyuItem(raw);
    if (!item || seen.has(item.id) || !apifyItemMatchesQueries(item, searchTerms)) continue;
    seen.add(item.id);
    selected.push(item);
    if (selected.length >= limit) break;
  }
  return selected;
}
