// Bloqueo de la cuenta de Xianyu de Nil tras una verificación anti-bot. En
// modo alterno la cuenta no se vuelve a usar (ni se renueva su sesión) hasta
// que la variable XIANYU_ACCOUNT_UNBLOCK tenga una fecha posterior al bloqueo;
// mientras tanto todas las búsquedas van por Just One API.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const XIANYU_ACCOUNT_BLOCK_KEY = 'xianyu_account_blocked';

export function xianyuAccountBlockActive(valueJson, unblock = '') {
  let block = null;
  try { block = valueJson ? JSON.parse(valueJson) : null; } catch { block = null; }
  const at = Date.parse(block?.at || '');
  if (!Number.isFinite(at)) return false;
  const until = Date.parse(String(unblock || '').trim());
  return !(Number.isFinite(until) && until > at);
}

// Workflow: node scripts/xianyu-account-block.mjs data/luxury-hunter.sqlite3
// Sale con 0 si la cuenta está bloqueada y con 1 si se puede usar.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let blocked = false;
  try {
    const db = new DatabaseSync(process.argv[2], { readOnly: true });
    const row = db.prepare('SELECT value_json FROM app_settings WHERE key=?').get(XIANYU_ACCOUNT_BLOCK_KEY);
    blocked = xianyuAccountBlockActive(row?.value_json, process.env.XIANYU_ACCOUNT_UNBLOCK);
  } catch { blocked = false; }
  process.exit(blocked ? 0 : 1);
}
