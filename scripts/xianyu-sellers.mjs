// Seller signals from the search card only. A nickname is never an identity:
// it can be changed or shared by different Xianyu accounts.
const first = (...values) => values.find(v => v !== undefined && v !== null && String(v).trim() !== '');
const str = value => value == null ? '' : String(value).trim();

function count(value) {
  if (typeof value === 'object' && value !== null) value = first(value.value, value.count, value.text);
  const match = str(value).replaceAll(',', '').match(/(\d+(?:\.\d+)?)(万)?/);
  if (!match) return null;
  const n = Number(match[1]) * (match[2] ? 10_000 : 1);
  return Number.isFinite(n) && n >= 0 && n <= 10_000_000 ? Math.round(n) : null;
}

function rate(value) {
  const raw = str(value);
  const n = Number(raw.replace('%', ''));
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return n <= 1 && !raw.includes('%') ? n * 100 : n;
}

export function sellerFromXianyuCard(main = {}, ex = {}) {
  const args = main?.clickParam?.args || {};
  const user = ex.userInfo || ex.sellerInfo || ex.user || {};
  const labels = ex.userFishShopLabel?.tagList || user.userFishShopLabel?.tagList || [];
  const labelText = Array.isArray(labels)
    ? labels.map(x => str(first(x?.data?.content, x?.content, x?.text))).filter(Boolean)
    : [];
  const reviewLabel = labelText.find(x => /条评价/.test(x));
  const rateLabel = labelText.find(x => /好评率/.test(x));
  const creditValue = first(ex.zhimaLevelInfo, user.zhimaLevelInfo, ex.userCreditText,
    user.userCreditText, ex.creditLevel, user.creditLevel);
  const credit = str(typeof creditValue === 'object'
    ? first(creditValue.levelName, creditValue.level, creditValue.text)
    : creditValue);
  return {
    id: str(first(args.seller_id, args.user_id, args.sellerId, ex.sellerId, ex.userId,
      ex.userInfo?.userId, user.id, user.userId, user.sellerId)),
    name: str(first(ex.userNickName, user.userNickName, user.nickName, ex.sellerName)),
    credit,
    sold: count(first(ex.hasSoldNumInteger, ex.soldCount, user.hasSoldNumInteger, user.soldCount)),
    active: count(first(ex.onSaleCount, user.onSaleCount)),
    reviews: count(first(ex.reviewCount, user.reviewCount, reviewLabel)),
    positiveRate: rate(first(ex.newGoodRatioRate, ex.goodRatio, user.newGoodRatioRate,
      user.goodRatio, rateLabel?.match(/(\d+(?:\.\d+)?)\s*%/)?.[1])),
    type: ex.isFishShop === true || /鱼小铺|闲鱼小铺|店铺|商家/.test(labelText.join(' ')) ? 'tienda' : 'sin confirmar',
    badges: labelText
  };
}

export function sellerWatchEligible({observed = 0, verified = 0, credit = '', sold = null,
  reviews = null, positiveRate = null} = {}) {
  if (observed < 2 || verified < 2 || verified / observed < 0.8) return false;
  const goodCredit = /信用极好|信用优秀/.test(str(credit));
  const goodReviews = reviews != null && reviews >= 20 && positiveRate != null && positiveRate >= 98;
  const goodSales = sold != null && sold >= 30 && positiveRate != null && positiveRate >= 97;
  return goodCredit || goodReviews || goodSales;
}

export function sellerRank({observed = 0, verified = 0, credit = '', sold = null,
  reviews = null, positiveRate = null} = {}) {
  const coverage = observed ? verified / observed : 0;
  return Math.round(Math.min(observed, 20) + coverage * 25 +
    (/信用极好/.test(str(credit)) ? 20 : /信用优秀/.test(str(credit)) ? 12 : 0) +
    (sold == null ? 0 : Math.min(15, Math.log10(sold + 1) * 6)) +
    (reviews == null ? 0 : Math.min(10, Math.log10(reviews + 1) * 4)) +
    (positiveRate == null ? 0 : positiveRate >= 98 ? 10 : positiveRate >= 95 ? 5 : 0));
}
