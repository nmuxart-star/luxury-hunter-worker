const BASE_URL = 'https://api.justoneapi.com';
const SEARCH_PATH = '/api/xianyu/search-item-list/v1';
const DETAIL_PATH = '/api/xianyu/get-item-detail/v1';
const DEFAULT_TIMEOUT_MS = 120_000;

const FIELD_KEYS = {
  id: ['itemId', 'item_id', '商品ID', 'id', 'auctionId', 'auction_id', 'productId', 'product_id', 'num_iid'],
  title: ['title', 'itemTitle', 'item_title', 'name', '商品标题', '商品名称'],
  price: ['price', 'currentPrice', 'current_price', 'soldPrice', 'salePrice', '商品价格', '当前售价', '价格'],
  url: ['url', 'itemUrl', 'item_url', 'link', 'shareUrl', '商品链接'],
  image: ['imageUrl', 'image_url', 'picUrl', 'pic_url', 'mainImage', 'main_image', 'cover', 'image', '商品主图链接', '商品主图'],
  images: ['images', 'imageList', 'image_list', 'imageInfos', '商品图片列表', '商品图片'],
  area: ['area', 'location', 'city', 'region', '发货地区'],
  seller: ['sellerName', 'seller_name', 'sellerNick', 'seller_nick', 'nickName', 'userName', '卖家昵称'],
  published: ['publishedAt', 'publishTime', 'publish_time', 'createTime', 'createdAt', '发布时间'],
  wants: ['wantCount', 'wantNum', 'want_num', 'likes', 'favoriteCount', 'wishCount', '“想要”人数'],
  description: ['description', 'desc', 'detail', 'itemDesc', 'productDescription', '商品描述', '宝贝描述'],
  browseCount: ['browseCount', 'browseCnt', 'viewCount', 'views', '浏览量'],
  sellerSales: ['sellerSales', 'seller_sales', 'soldCount', 'hasSoldNumInteger', 'sales', '卖家已售'],
  sellerItems: ['sellerItems', 'seller_items', 'itemCount', 'onSaleCount', '卖家在售'],
  sellerReviews: ['sellerReviews', 'seller_reviews', 'reviewCount', 'reviews', '卖家评价数'],
  sellerCredit: ['sellerCredit', 'creditLevel', 'credit', '芝麻信用'],
  sellerRegDays: ['sellerRegDays', 'userRegDay', 'registeredDays', '卖家注册天数']
};

const BUSINESS_ERRORS = new Map([
  [100, 'token no válido o inactivo'],
  [301, 'falló la recopilación del anuncio'],
  [302, 'límite de peticiones alcanzado'],
  [303, 'cuota diaria agotada'],
  [400, 'parámetros no válidos'],
  [500, 'error interno del proveedor'],
  [600, 'permiso denegado'],
  [601, 'saldo insuficiente'],
  [602, 'presupuesto del token agotado']
]);

export class JustOneApiError extends Error {
  constructor(message, { code = null, status = null } = {}) {
    super(message);
    this.name = 'JustOneApiError';
    this.code = code;
    this.status = status;
  }
}

function firstOwn(object, keys) {
  if (!object || typeof object !== 'object') return null;
  for (const key of keys) {
    const value = object[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function deepValue(object, keys, depth = 0) {
  if (!object || typeof object !== 'object' || depth > 8) return null;
  const direct = firstOwn(object, keys);
  if (direct !== null) return direct;
  for (const value of Object.values(object)) {
    if (value && typeof value === 'object') {
      const found = deepValue(value, keys, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

function scalar(value, keys = ['value', 'amount', 'text', 'name', 'url', 'src']) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (Array.isArray(value)) return scalar(value[0], keys);
  return scalar(firstOwn(value, keys), keys);
}

function parsePrice(value) {
  const raw = scalar(value, ['value', 'amount', 'price', 'text', 'currentPrice']);
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim().replaceAll(',', '');
  const number = Number(text.replace(/[^\d.\-]/g, ''));
  if (!Number.isFinite(number)) return null;
  return /万|萬/.test(text) ? number * 10_000 : number;
}

function normalizedTimestamp(value) {
  const raw = scalar(value, ['value', 'timestamp', 'time', 'text']);
  if (raw === null || raw === undefined || raw === '') return null;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    const millis = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(String(raw));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function imageUrl(value) {
  const raw = scalar(value, ['url', 'src', 'imageUrl', 'image_url', 'picUrl', 'pic_url']);
  if (raw === null || raw === undefined) return '';
  const url = String(raw).trim();
  return url.startsWith('//') ? `https:${url}` : url;
}

function imageList(object) {
  const many = deepValue(object, FIELD_KEYS.images);
  const single = deepValue(object, FIELD_KEYS.image);
  const values = Array.isArray(many) ? [...many] : many ? [many] : [];
  if (single) values.unshift(single);
  return [...new Set(values.map(imageUrl).filter(Boolean))];
}

function normalizeCandidate(object) {
  const id = scalar(deepValue(object, FIELD_KEYS.id));
  const title = scalar(deepValue(object, FIELD_KEYS.title));
  const price = parsePrice(deepValue(object, FIELD_KEYS.price));
  if (id === null || !title || !Number.isFinite(price) || price <= 0) return null;

  const images = imageList(object);
  const publishedAt = normalizedTimestamp(deepValue(object, FIELD_KEYS.published));
  const rawUrl = scalar(firstOwn(object, FIELD_KEYS.url) ?? deepValue(object, FIELD_KEYS.url.filter(key => key !== 'url')));
  const itemId = String(id).trim();
  return {
    id: itemId,
    title: String(title).trim(),
    price,
    url: rawUrl ? String(rawUrl).replace(/^fleamarket:\/\//, 'https://www.goofish.com/') : `https://www.goofish.com/item?id=${encodeURIComponent(itemId)}`,
    image: images[0] || imageUrl(deepValue(object, FIELD_KEYS.image)),
    images,
    area: String(scalar(deepValue(object, FIELD_KEYS.area)) || ''),
    seller: String(scalar(deepValue(object, FIELD_KEYS.seller)) || ''),
    publishedAt,
    publishedLocal: publishedAt ? new Date(new Date(publishedAt).getTime() + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ') : null,
    wants: scalar(deepValue(object, FIELD_KEYS.wants)),
    description: String(scalar(deepValue(object, FIELD_KEYS.description)) || '').trim(),
    browseCount: scalar(deepValue(object, FIELD_KEYS.browseCount)),
    sellerSales: scalar(deepValue(object, FIELD_KEYS.sellerSales)),
    sellerItems: scalar(deepValue(object, FIELD_KEYS.sellerItems)),
    sellerReviews: scalar(deepValue(object, FIELD_KEYS.sellerReviews)),
    sellerCredit: scalar(deepValue(object, FIELD_KEYS.sellerCredit)),
    sellerRegDays: scalar(deepValue(object, FIELD_KEYS.sellerRegDays))
  };
}

function walkObjects(value, visit, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 12) return;
  if (Array.isArray(value)) {
    for (const child of value) walkObjects(child, visit, depth + 1);
    return;
  }
  for (const child of Object.values(value)) walkObjects(child, visit, depth + 1);
  visit(value);
}

export function normalizeJustOneXianyuItems(payload) {
  const byId = new Map();
  walkObjects(payload, object => {
    const item = normalizeCandidate(object);
    if (!item) return;
    const old = byId.get(item.id);
    if (!old) byId.set(item.id, item);
    else {
      for (const [key, value] of Object.entries(item)) {
        if ((old[key] === '' || old[key] === null || old[key] === undefined || (Array.isArray(old[key]) && !old[key].length)) && value !== null && value !== '') old[key] = value;
      }
    }
  });
  return [...byId.values()];
}

async function callJustOne(path, params, { env = process.env, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const token = String(env.JUSTONEAPI_TOKEN || '').trim();
  if (!token) throw new JustOneApiError('Falta configurar el secreto JUSTONEAPI_TOKEN.');
  if (typeof fetchImpl !== 'function') throw new JustOneApiError('No está disponible fetch para Just One API.');

  const url = new URL(path, BASE_URL);
  url.searchParams.set('token', token);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value) !== '') url.searchParams.set(name, String(value));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      signal: controller.signal
    });
  } catch (error) {
    const timedOut = error?.name === 'AbortError' || error?.name === 'TimeoutError';
    throw new JustOneApiError(timedOut ? 'Just One API superó el tiempo de espera.' : 'No se pudo conectar con Just One API.');
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) throw new JustOneApiError(`Just One API respondió HTTP ${response.status}.`, { status: response.status });
  let payload;
  try { payload = await response.json(); }
  catch { throw new JustOneApiError('Just One API no devolvió un JSON válido.'); }

  const rawCode = firstOwn(payload, ['code']);
  const code = Number(rawCode);
  if (rawCode === null || code !== 0) {
    const description = BUSINESS_ERRORS.get(code) || 'respuesta de error no documentada';
    throw new JustOneApiError(`Just One API código ${Number.isFinite(code) && rawCode !== null ? code : 'desconocido'}: ${description}.`, { code: Number.isFinite(code) && rawCode !== null ? code : null });
  }
  return payload;
}

export async function searchJustOneXianyu({ keyword, page = 1, sort = 'active', ...options }) {
  if (!String(keyword || '').trim()) throw new JustOneApiError('La búsqueda de Just One API necesita una palabra clave.');
  const payload = await callJustOne(SEARCH_PATH, { keyword: String(keyword).trim(), page, sort }, options);
  return { items: normalizeJustOneXianyuItems(payload), requestId: payload?.requestId || null };
}

export async function getJustOneXianyuDetail({ itemId, ...options }) {
  if (!String(itemId || '').trim()) throw new JustOneApiError('La ficha de Just One API necesita un itemId.');
  const normalizedId = String(itemId).trim();
  const payload = await callJustOne(DETAIL_PATH, { itemId: normalizedId }, options);
  const items = normalizeJustOneXianyuItems(payload);
  const item = items.find(candidate => candidate.id === normalizedId) || items[0] || null;
  return item ? { item, requestId: payload?.requestId || null } : { item: null, requestId: payload?.requestId || null };
}
