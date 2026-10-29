// Just One API lists Xianyu Product Search V1 at ¥0.20 per request.
// Twenty requests per Madrid day cost at most ¥124 in a 31-day month.
// The monthly limit remains a second guard if the daily limit changes.
export const XIANYU_MONTHLY_SEARCH_LIMIT = 650;
export const XIANYU_DAILY_SEARCH_LIMIT = 20;

function madridDateParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const part = type => parts.find(item => item.type === type)?.value;
  return {year:part('year'),month:part('month'),day:part('day')};
}

export function xianyuBudgetMonth(date = new Date()) {
  const {year,month} = madridDateParts(date);
  return `${year}-${month}`;
}

export function xianyuBudgetDay(date = new Date()) {
  const {year,month,day} = madridDateParts(date);
  return `${year}-${month}-${day}`;
}

export function xianyuPaidSearchIntervalMs(pages, dailyLimit = XIANYU_DAILY_SEARCH_LIMIT) {
  const calls = Math.max(1, Math.floor(Number(pages) || 1));
  const limit = Math.min(XIANYU_DAILY_SEARCH_LIMIT, Math.max(0, Math.floor(Number(dailyLimit) || 0)));
  return limit ? Math.ceil(24 * 60 * 60_000 * calls / limit) : Infinity;
}

export function nextXianyuSearchUsage(value, month, limit = XIANYU_MONTHLY_SEARCH_LIMIT,
  day = xianyuBudgetDay(), dailyLimit = XIANYU_DAILY_SEARCH_LIMIT) {
  let previous = null;
  if (value !== null && value !== undefined && value !== '') {
    try { previous = typeof value === 'string' ? JSON.parse(value) : value; }
    catch { throw new Error('Estado mensual de Xianyu ilegible; búsquedas pausadas para proteger el presupuesto.'); }
    if (!previous || typeof previous !== 'object' || typeof previous.month !== 'string' ||
        !Number.isSafeInteger(previous.attempts) || previous.attempts < 0 ||
        ((previous.day !== undefined || previous.dayAttempts !== undefined) &&
          (typeof previous.day !== 'string' || !Number.isSafeInteger(previous.dayAttempts) || previous.dayAttempts < 0))) {
      throw new Error('Estado mensual de Xianyu inválido; búsquedas pausadas para proteger el presupuesto.');
    }
  }
  const safeLimit = Math.min(XIANYU_MONTHLY_SEARCH_LIMIT, Math.max(0, Math.floor(Number(limit) || 0)));
  const safeDailyLimit = Math.min(XIANYU_DAILY_SEARCH_LIMIT, Math.max(0, Math.floor(Number(dailyLimit) || 0)));
  const attempts = previous?.month === month ? previous.attempts : 0;
  // The old state counted monthly requests only. Its current-day usage is
  // unknown, so hold paid requests until the next Madrid day after migration.
  const legacyDayUnknown = previous?.month === month && attempts > 0 && !previous.day;
  const dayAttempts = previous?.month === month && previous?.day === day
    ? previous.dayAttempts : legacyDayUnknown ? safeDailyLimit : 0;
  const reason = attempts >= safeLimit ? 'monthly_limit' :
    dayAttempts >= safeDailyLimit ? 'daily_limit' : null;
  const allowed = reason === null;
  return {
    allowed,
    reason,
    usage: {month,attempts:attempts + (allowed ? 1 : 0),day,dayAttempts:dayAttempts + (allowed ? 1 : 0)},
    limit:safeLimit,
    dailyLimit:safeDailyLimit
  };
}
