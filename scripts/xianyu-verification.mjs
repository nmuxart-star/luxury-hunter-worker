export const XIANYU_VERIFICATION_TAG = '验货宝';

function tagLabel(tag) {
  if (typeof tag === 'string') return tag.trim();
  if (!tag || typeof tag !== 'object') return '';
  return String(tag.data?.content ?? tag.content ?? tag.valueName ?? '').trim();
}

export function extractXianyuTags(item) {
  if (!item || typeof item !== 'object') return [];
  const labels = [];
  for (const field of [item.tags, item['商品标签']]) {
    for (const tag of Array.isArray(field) ? field : field == null ? [] : [field]) {
      const label = tagLabel(tag);
      if (label) labels.push(label);
    }
  }
  const groups = item.fishTags;
  if (groups && typeof groups === 'object') {
    for (const group of Object.values(groups)) {
      for (const tag of Array.isArray(group?.tagList) ? group.tagList : []) {
        const label = tagLabel(tag);
        if (label) labels.push(label);
      }
    }
  }
  return [...new Set(labels)];
}

export function hasXianyuVerificationTag(tags) {
  return (Array.isArray(tags) ? tags : tags == null ? [] : [tags])
    .some(tag => tagLabel(tag) === XIANYU_VERIFICATION_TAG);
}

export function xianyuListingHasVerificationTag(listing) {
  if (String(listing?.source || '').toLowerCase() !== 'xianyu') return true;
  let raw = listing?.raw;
  if (!raw) {
    try { raw = JSON.parse(listing?.raw_json || '{}'); }
    catch { return false; }
  }
  return hasXianyuVerificationTag(raw?.['商品信息']?.['商品标签']);
}
