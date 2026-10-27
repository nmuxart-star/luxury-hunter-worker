// Just One API currently lists Xianyu Product Search V1 at ¥0.20 per call.
// 650 calls cost at most ¥130 at that tariff, leaving a buffer below €20
// at the October 2026 EUR/CNY reference rate. Count attempts, including errors.
export const XIANYU_MONTHLY_SEARCH_LIMIT = 650;

export function xianyuBudgetMonth(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit'
  }).formatToParts(date);
  const year = parts.find(part => part.type === 'year')?.value;
  const month = parts.find(part => part.type === 'month')?.value;
  return `${year}-${month}`;
}

export function nextXianyuSearchUsage(value, month, limit = XIANYU_MONTHLY_SEARCH_LIMIT) {
  let previous = null;
  if (value !== null && value !== undefined && value !== '') {
    try { previous = typeof value === 'string' ? JSON.parse(value) : value; }
    catch { throw new Error('Estado mensual de Xianyu ilegible; búsquedas pausadas para proteger el presupuesto.'); }
    if (!previous || typeof previous !== 'object' || typeof previous.month !== 'string' ||
        !Number.isSafeInteger(previous.attempts) || previous.attempts < 0) {
      throw new Error('Estado mensual de Xianyu inválido; búsquedas pausadas para proteger el presupuesto.');
    }
  }
  const attempts = previous?.month === month ? previous.attempts : 0;
  const safeLimit = Math.min(XIANYU_MONTHLY_SEARCH_LIMIT, Math.max(0, Math.floor(Number(limit) || 0)));
  return {
    allowed: attempts < safeLimit,
    usage: { month, attempts: attempts < safeLimit ? attempts + 1 : attempts },
    limit: safeLimit
  };
}
