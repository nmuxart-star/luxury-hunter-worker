import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, execFile } from 'node:child_process';
import { randomUUID, createSign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { load as loadHtml } from 'cheerio';
import nodemailer from 'nodemailer';
import {xianyuAccountFiles,availableXianyuAccounts,accountLabel,tryXianyuAccounts} from './scripts/xianyu-account-pool.mjs';
import {searchJustOneXianyu} from './scripts/justone-xianyu.mjs';
import {nextXianyuSearchUsage,xianyuBudgetMonth,xianyuBudgetDay,xianyuPaidSearchIntervalMs,
  XIANYU_MONTHLY_SEARCH_LIMIT,XIANYU_DAILY_SEARCH_LIMIT} from './scripts/xianyu-search-budget.mjs';
import {extractXianyuTags,hasXianyuVerificationTag,xianyuListingHasVerificationTag} from './scripts/xianyu-verification.mjs';
import {oneMapSearchUrl,parseOneMapAuctions,parseOneMapDetail,oneMapJsonCards} from './scripts/onemap-auctions.mjs';
import {sameModelRows,sameMaterialRows} from './scripts/vestiaire-model.mjs';
import {strictBagComparables,applyBagSheetPolicy,BAG_SHEET_RULE_VERSION,compWeight,compStats,refAgeDays,weightedQuantile} from './scripts/vestiaire-bag-match.mjs';
import {MATCH_VERSION,refCandidates,refTable,refValue,priceFromRefs,combinePrices,decideFromNumbers} from './scripts/reference-match.mjs';
import {yahooAuctionImageUrl} from './scripts/yahoo-auction-image.mjs';
import {macOneMapReady,macOneMapSnapshot,macVestiaireSearch} from './scripts/onemap-mac-client.mjs';
import {vestiaireLiveQuery,vestiaireLiveRows,vestiaireLiveComparables,blendComparables,vestiaireTaskQuery,VESTIAIRE_LIVE_REALIZATION} from './scripts/vestiaire-live.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (v.includes('$HOME')) v = v.replaceAll('$HOME', process.env.HOME || '');
    if (!(k in process.env)) process.env[k] = v;
  }
}

const PORT = Number(process.env.PORT || 8200);
let oneMapAccountStatus=process.env.ONEMAP_SESSION_STATUS||
  (process.env.ONEMAP_STORAGE_STATE_FILE?'configured':'public');
const XIANYU_BASE_URL = String(process.env.XIANYU_BASE_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
const DB_PATH = path.join(__dirname, 'data', 'luxury-hunter.sqlite3');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// AUTO CLOUD STATE SYNC V1
const cloudStateSyncDisabled=
  ['1','true','yes','on'].includes(
    String(process.env.DISABLE_CLOUD_STATE_SYNC||'').toLowerCase()
  );

const cloudStateSyncInGithubActions=
  String(process.env.GITHUB_ACTIONS||'').toLowerCase()==='true';

if(!cloudStateSyncDisabled&&!cloudStateSyncInGithubActions){
  try{
    const output=execFileSync(
      process.execPath,
      [
        path.join(__dirname,'scripts','sync-cloud-state.mjs'),
        '--local-db',
        DB_PATH
      ],
      {
        cwd:__dirname,
        encoding:'utf8',
        timeout:120000,
        maxBuffer:20*1024*1024,
        env:{...process.env}
      }
    );
    const message=String(output||'').trim();
    if(message){
      console.log('[Cloud state sync]\n'+message);
    }
  }catch(e){
    const stdout=String(e?.stdout||'').trim();
    const stderr=String(e?.stderr||'').trim();
    console.error(
      '[Cloud state sync skipped]',
      stderr||stdout||e?.message||e
    );
  }
}

const db = new DatabaseSync(DB_PATH);

db.exec(`
CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  url TEXT,
  title TEXT,
  description TEXT,
  original_price REAL,
  currency TEXT,
  price_eur REAL,
  seller_name TEXT,
  seller_items INTEGER,
  seller_sales INTEGER,
  seller_reviews INTEGER,
  image_url TEXT,
  status TEXT,
  raw_json TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  UNIQUE(source, source_id)
);
CREATE TABLE IF NOT EXISTS analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL UNIQUE,
  brand TEXT,
  model TEXT,
  authenticity_risk TEXT,
  liquidity TEXT,
  decision TEXT,
  opportunity_score REAL,
  resale_low_eur REAL,
  resale_high_eur REAL,
  landed_cost_eur REAL,
  net_profit_low_eur REAL,
  net_profit_high_eur REAL,
  notes TEXT,
  raw_json TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fx_rates (
  currency TEXT PRIMARY KEY,
  per_eur REAL NOT NULL,
  source TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT,
  kind TEXT,
  summary TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS search_sessions (
  id TEXT PRIMARY KEY,
  product_query TEXT NOT NULL,
  query_plan_json TEXT,
  source_status_json TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS search_session_items (
  session_id TEXT NOT NULL,
  listing_id INTEGER NOT NULL,
  source_query TEXT,
  PRIMARY KEY(session_id, listing_id)
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_name TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  product_query TEXT NOT NULL,
  sources_json TEXT NOT NULL DEFAULT '["xianyu","bunjang","buyee"]',
  description TEXT NOT NULL DEFAULT '',
  analyze_images INTEGER NOT NULL DEFAULT 1,
  max_pages INTEGER NOT NULL DEFAULT 1,
  max_items INTEGER NOT NULL DEFAULT 20,
  min_eur REAL,
  max_eur REAL,
  personal_only INTEGER NOT NULL DEFAULT 0,
  free_shipping INTEGER NOT NULL DEFAULT 0,
  new_publish_option TEXT,
  region TEXT,
  cron TEXT,
  account_state_file TEXT,
  account_strategy TEXT NOT NULL DEFAULT 'auto',
  decision_mode TEXT NOT NULL DEFAULT 'ai',
  keyword_rules_json TEXT NOT NULL DEFAULT '[]',
  xianyu_queries_json TEXT NOT NULL DEFAULT '[]',
  bunjang_queries_json TEXT NOT NULL DEFAULT '[]',
  japan_queries_json TEXT NOT NULL DEFAULT '[]',
  interval_minutes INTEGER,
  run_if_missed INTEGER NOT NULL DEFAULT 1,
  email_enabled INTEGER NOT NULL DEFAULT 0,
  email_to TEXT,
  notify_decisions_json TEXT NOT NULL DEFAULT '["STRONG BUY","BUY"]',
  notify_min_score REAL,
  notify_min_profit_eur REAL,
  notify_max_items INTEGER NOT NULL DEFAULT 8,
  notify_only_new INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_run_at TEXT
);
CREATE TABLE IF NOT EXISTS task_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL,
  source_status_json TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS task_analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  listing_id INTEGER NOT NULL,
  brand TEXT,
  model TEXT,
  authenticity_risk TEXT,
  liquidity TEXT,
  decision TEXT,
  opportunity_score REAL,
  resale_low_eur REAL,
  resale_high_eur REAL,
  landed_cost_eur REAL,
  net_profit_low_eur REAL,
  net_profit_high_eur REAL,
  notes TEXT,
  raw_json TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(task_id, listing_id)
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  listing_id INTEGER NOT NULL,
  run_id INTEGER,
  kind TEXT NOT NULL DEFAULT 'email',
  sent_to TEXT,
  sent_at TEXT NOT NULL,
  UNIQUE(task_id, listing_id, kind)
);
CREATE TABLE IF NOT EXISTS listing_feedback (
  listing_id INTEGER PRIMARY KEY,
  action TEXT NOT NULL,
  source TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Miniaturas de los anuncios de Vestiaire en directo (las trae el Chrome del
-- Mac); se borran a los 3 días.
CREATE TABLE IF NOT EXISTS ref_thumbs (
  id TEXT PRIMARY KEY,
  jpeg BLOB NOT NULL,
  saved_at TEXT NOT NULL
);
`);

function ensureColumn(table, name, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(x => x.name);
  if (!cols.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}
ensureColumn('listings', 'purchase_via', 'TEXT');
const updateYahooImage=db.prepare('UPDATE listings SET image_url=? WHERE id=?');
for(const row of db.prepare("SELECT id,image_url FROM listings WHERE source='yahoo-auctions-jp' AND image_url<>''").all()){
  const image=yahooAuctionImageUrl(row.image_url);
  if(image!==row.image_url)updateYahooImage.run(image||'',row.id);
}
ensureColumn('search_sessions', 'task_id', 'INTEGER');
ensureColumn('tasks', 'interval_minutes', 'INTEGER');
ensureColumn('tasks', 'run_if_missed', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('tasks', 'email_enabled', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('tasks', 'email_to', 'TEXT');
ensureColumn('tasks', 'notify_decisions_json', "TEXT NOT NULL DEFAULT '[\"STRONG BUY\",\"BUY\"]'");
ensureColumn('tasks', 'notify_min_score', 'REAL');
ensureColumn('tasks', 'notify_min_profit_eur', 'REAL');
ensureColumn('tasks', 'notify_max_items', 'INTEGER NOT NULL DEFAULT 8');
ensureColumn('tasks', 'notify_only_new', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('task_runs', 'debug_json', 'TEXT');
ensureColumn('analyses', 'decision_reasons_es_json', "TEXT NOT NULL DEFAULT '[]'");
ensureColumn('task_analyses', 'decision_reasons_es_json', "TEXT NOT NULL DEFAULT '[]'");
ensureColumn('analyses', 'preliminary_decision', 'TEXT');
ensureColumn('analyses', 'verification_json', "TEXT NOT NULL DEFAULT '{}'");
ensureColumn('task_analyses', 'preliminary_decision', 'TEXT');
ensureColumn('task_analyses', 'verification_json', "TEXT NOT NULL DEFAULT '{}'");
ensureColumn('task_runs', 'progress_pct', 'REAL NOT NULL DEFAULT 0');
ensureColumn('task_runs', 'progress_stage', 'TEXT');
ensureColumn('task_runs', 'progress_detail', 'TEXT');
ensureColumn('task_runs', 'progress_updated_at', 'TEXT');
ensureColumn('task_runs', 'progress_eta_seconds', 'INTEGER');
ensureColumn('task_runs', 'progress_current', 'INTEGER');
ensureColumn('task_runs', 'progress_total', 'INTEGER');

db.prepare(`
  UPDATE task_analyses
  SET preliminary_decision=COALESCE(NULLIF(preliminary_decision,''),decision),
      decision='REVIEW',
      verification_json='{"status":"legacy_pending","reason":"positive_analysis_predates_market_verification_v1_6"}'
  WHERE decision IN ('WATCH','BUY','STRONG BUY')
    AND (verification_json IS NULL OR TRIM(verification_json)='' OR TRIM(verification_json)='{}')
`).run();


function normalizeDecisionReasonsEs(value) {
  const source = Array.isArray(value) ? value : [];
  const out=[];
  for (const x of source) {
    const t=String(x||'').trim().replace(/^[-•*\s]+/,'');
    if(!t) continue;
    if(!out.includes(t)) out.push(t);
    if(out.length>=4) break;
  }
  return out;
}
function fallbackRejectReasonsEs(a={}) {
  const reasons=[];
  const model=String(a.model||'').toLowerCase();
  if(/le cagole|neo cagole/.test(model)) reasons.push('El modelo identificado no es City / Le City: parece un Le Cagole.');
  else if(/mini|nano|\bxs\b/.test(model)) reasons.push('El tamaño identificado no cumple el objetivo Medium / Standard de la tarea.');
  if(String(a.authenticity_risk||'').toUpperCase()==='HIGH') reasons.push('El riesgo de autenticidad es alto con la evidencia disponible.');
  const low=Number(a.net_profit_low_eur), high=Number(a.net_profit_high_eur);
  if(Number.isFinite(high) && high < 200) reasons.push('El beneficio neto estimado queda por debajo del mínimo de 200 € definido para una oportunidad viable.');
  else if(Number.isFinite(low) && low < 200) reasons.push('El margen conservador queda por debajo del objetivo de rentabilidad.');
  if(String(a.liquidity||'').toUpperCase()==='LOW') reasons.push('La liquidez estimada de reventa en Europa es baja.');
  const score=Number(a.opportunity_score);
  if(Number.isFinite(score) && score < 60) reasons.push(`El Opportunity Score es bajo (${Math.round(score)}/100).`);
  if(!reasons.length) reasons.push('No cumple suficientemente los criterios de modelo, riesgo, condición o rentabilidad definidos para esta tarea.');
  return reasons.slice(0,4);
}
function reasonsForStorage(a={}) {
  const aiReasons=normalizeDecisionReasonsEs(a.decision_reasons_es);
  if(aiReasons.length) return aiReasons;
  return String(a.decision||'').toUpperCase()==='REJECT' ? fallbackRejectReasonsEs(a) : [];
}
function backfillRejectReasonsEs() {
  for (const table of ['analyses','task_analyses']) {
    const rows=db.prepare(`SELECT id,model,authenticity_risk,liquidity,decision,opportunity_score,net_profit_low_eur,net_profit_high_eur,decision_reasons_es_json FROM ${table} WHERE decision='REJECT'`).all();
    const upd=db.prepare(`UPDATE ${table} SET decision_reasons_es_json=? WHERE id=?`);
    for(const row of rows){
      let current=[]; try{current=JSON.parse(row.decision_reasons_es_json||'[]')}catch{}
      if(Array.isArray(current)&&current.length) continue;
      upd.run(JSON.stringify(fallbackRejectReasonsEs(row)),row.id);
    }
  }
}
backfillRejectReasonsEs();

const DEFAULT_ECONOMICS = {
  destination: 'ES',
  vatPercent: 21,
  lowValueThresholdEur: 150,
  lowValueDutyFlatEur: 3,
  sources: {
    xianyu: { label:'Xianyu / China', domesticShippingEur:5, agentFeePercent:5, agentFeeFixedEur:0, internationalShippingEur:30, customsDutyPercent:3, clearanceFeeEur:8, authenticationFeeEur:0, otherEur:0, paymentFeePercent:3, verificationFeeCny:80 },
    bunjang: { label:'Bunjang / Corea', domesticShippingEur:4, agentFeePercent:5, agentFeeFixedEur:0, internationalShippingEur:30, customsDutyPercent:3, clearanceFeeEur:8, authenticationFeeEur:0, otherEur:0 },
    buyee: { label:'Japón', domesticShippingEur:8, agentFeePercent:0, agentFeeFixedEur:5, internationalShippingEur:30, customsDutyPercent:3, clearanceFeeEur:8, authenticationFeeEur:0, otherEur:0 },
    // One Map: ¥500 de servicio, envío nacional/internacional estimado,
    // autenticación opcional y tasa UE de 2 € por código HS desde 2026-11-01.
    onemap: { label:'One Map / Yahoo Auctions', domesticShippingEur:8, agentFeePercent:0, agentFeeFixedEur:4, internationalShippingEur:35, customsDutyPercent:3, clearanceFeeEur:10, authenticationFeeEur:15, otherEur:2 },
    rakuten: { label:'Rakuten / Japón', domesticShippingEur:6, agentFeePercent:0, agentFeeFixedEur:5, internationalShippingEur:35, customsDutyPercent:3, clearanceFeeEur:8, authenticationFeeEur:0, otherEur:0 },
    // Dentro de la UE no hay aduana ni IVA de importación; sí conviene autenticar.
    ebay_eu: { label:'eBay / UE', euInternal:true, domesticShippingEur:0, agentFeePercent:0, agentFeeFixedEur:0, internationalShippingEur:15, customsDutyPercent:0, clearanceFeeEur:0, authenticationFeeEur:30, otherEur:0 },
    // Vestiaire (dentro de la UE): gastos de servicio del comprador (%) y envío
    // con autenticación. Estimación prudente: ajústala con un pago real.
    vestiaire: { label:'Vestiaire Collective', euInternal:true, domesticShippingEur:0, agentFeePercent:15, agentFeeFixedEur:0, internationalShippingEur:25, customsDutyPercent:0, clearanceFeeEur:0, authenticationFeeEur:0, otherEur:0 },
    ebay_gb: { label:'eBay / Reino Unido', domesticShippingEur:0, agentFeePercent:0, agentFeeFixedEur:0, internationalShippingEur:25, customsDutyPercent:3, clearanceFeeEur:15, authenticationFeeEur:30, otherEur:0 },
    ebay_us: { label:'eBay / EE. UU. y resto', domesticShippingEur:0, agentFeePercent:0, agentFeeFixedEur:0, internationalShippingEur:45, customsDutyPercent:3, clearanceFeeEur:15, authenticationFeeEur:30, otherEur:0 }
  },
  // Arancel UE partida 4202: piel 3 %; exterior textil/plástico (lona, nailon) 3,7 %.
  textileDutyPercent: 3.7,
  // 'cost': el IVA de importación se suma al coste (prudente).
  // 'deductible': empresa en régimen general que lo deduce; se informa pero no se suma.
  importVatMode: 'cost'
};
const TEXTILE_BAG_RE=/canvas|monogram|damier|nylon|tessuto|pvc|coated|キャンバス|モノグラム|ダミエ|ナイロン|テスート|캔버스|나일론|모노그램|帆布|尼龙|老花/i;
function finiteOr(v, fallback=0){ const n=Number(v); return Number.isFinite(n)?n:fallback; }
function getSetting(key, fallback){
  const row=db.prepare('SELECT value_json FROM app_settings WHERE key=?').get(key);
  if(!row) return JSON.parse(JSON.stringify(fallback));
  try{return JSON.parse(row.value_json)}catch{return JSON.parse(JSON.stringify(fallback))}
}
function mergeEconomics(input={}){
  const out=JSON.parse(JSON.stringify(DEFAULT_ECONOMICS));
  out.destination=String(input.destination||out.destination);
  out.vatPercent=finiteOr(input.vatPercent,out.vatPercent);
  out.lowValueThresholdEur=finiteOr(input.lowValueThresholdEur,out.lowValueThresholdEur);
  out.lowValueDutyFlatEur=finiteOr(input.lowValueDutyFlatEur,out.lowValueDutyFlatEur);
  out.textileDutyPercent=finiteOr(input.textileDutyPercent,out.textileDutyPercent);
  out.importVatMode=['cost','deductible'].includes(input.importVatMode)?input.importVatMode:out.importVatMode;
  for(const source of Object.keys(DEFAULT_ECONOMICS.sources)){
    const src=input.sources?.[source]||{};
    for(const key of ['domesticShippingEur','agentFeePercent','agentFeeFixedEur','internationalShippingEur','customsDutyPercent','clearanceFeeEur','authenticationFeeEur','otherEur','paymentFeePercent','verificationFeeCny']){
      out.sources[source][key]=finiteOr(src[key],out.sources[source][key]);
    }
  }
  return out;
}
function getEconomics(){ return mergeEconomics(getSetting('economics', DEFAULT_ECONOMICS)); }
function saveEconomics(value){
  const clean=mergeEconomics(value);
  const now=new Date().toISOString();
  db.prepare(`INSERT INTO app_settings(key,value_json,updated_at) VALUES('economics',?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`).run(JSON.stringify(clean),now);
  return clean;
}
function roundMoney(n){ return Math.round((Number(n)+Number.EPSILON)*100)/100; }
// Relojes (arancel propio): palabras genéricas de reloj en cada idioma y las
// marcas/modelos que se buscan. Los bolsos de estas marcas no las llevan.
const WATCH_ITEM_RE=/腕時計|ウォッチ|手表|腕表|機械表|机械表|시계|\bwristwatch|\bwatch\b|クロノグラフ|chronograph|speedmaster|seamaster|スピードマスター|シーマスター|超霸|海马表|스피드마스터|rolex|ロレックス|劳力士|롤렉스|tudor|チューダー|チュードル|帝舵|튜더|grand seiko|グランドセイコー|冠蓝狮|그랜드세이코|santos de cartier|cartier (santos|tank|ballon|panth)|tag heuer|タグホイヤー|泰格豪雅|태그호이어|サントス|タンク(フランセーズ|マスト|ソロ)|山度士|坦克|蓝气球|오메가|オメガ|欧米茄/i;
function importEconomics(item, settings=getEconomics()){
  const product=finiteOr(item?.price_eur,0);
  const rawSource=String(item?.source||'').toLowerCase();
  const japanEconomicSources=new Set([
    'buyee',
    'buyee-jp',
    'mercari-jp',
    'rakuma-jp',
    'jdirectitems-fleamarket',
    'yahoo-fleamarket-jp',
    '2ndstreet-jp',
    'komehyo-jp'
  ]);
  let sourceKey='xianyu';
  if(['xianyu','bunjang'].includes(rawSource))sourceKey=rawSource;
  else if(['yahoo-auctions-jp','jdirectitems-auction'].includes(rawSource))sourceKey='onemap';
  else if(japanEconomicSources.has(rawSource))sourceKey='buyee';
  else if(rawSource==='rakuten-jp')sourceKey='rakuten';
  else if(rawSource==='vestiaire')sourceKey='vestiaire';
  else if(rawSource.startsWith('ebay-')){
    const cc=rawSource.slice(5).toUpperCase();
    sourceKey=EU_COUNTRIES.has(cc)?'ebay_eu':cc==='GB'?'ebay_gb':'ebay_us';
  }
  const cfg=settings.sources[sourceKey]||settings.sources.xianyu;
  const euInternal=cfg.euInternal===true;
  const textile=TEXTILE_BAG_RE.test(`${item?.title||''} ${item?.description||''}`);
  // Relojes de pulsera (CN 9102): arancel propio, 4,5 % por defecto (WATCH_DUTY_PCT).
  // Solo el título: en descripciones coreanas "시계" sale en textos de la tienda.
  const titleText=String(item?.title||'');
  // Títulos de bolsos con listas de marcas de relleno ("劳力士" sin ser reloj) no cuentan.
  const watchItem=WATCH_ITEM_RE.test(titleText)&&!(/包|バッグ|가방|\bbags?\b|鞋|打火机/i.test(titleText)&&!/腕時計|手表|腕表|ウォッチ|시계|\bwatch/i.test(titleText));
  const dutyPercent=euInternal
    ? 0
    : watchItem
      ? finiteOr(Number(process.env.WATCH_DUTY_PCT),4.5)
    : textile
      ? Math.max(finiteOr(cfg.customsDutyPercent,0),finiteOr(settings.textileDutyPercent,3.7))
      : finiteOr(cfg.customsDutyPercent,0);
  const vatMode=String(process.env.IMPORT_VAT_MODE||settings.importVatMode||'cost').toLowerCase();
  const domestic=finiteOr(cfg.domesticShippingEur,0);
  const agent=product*(finiteOr(cfg.agentFeePercent,0)/100)+finiteOr(cfg.agentFeeFixedEur,0);
  const intl=finiteOr(cfg.internationalShippingEur,0);
  const customsBase=product+domestic+intl;
  const lowValue=!euInternal && customsBase>0 && customsBase<=finiteOr(settings.lowValueThresholdEur,150);
  const duty=euInternal?0:lowValue?finiteOr(settings.lowValueDutyFlatEur,3):customsBase*(dutyPercent/100);
  const vatBase=customsBase+duty;
  const vat=euInternal?0:vatBase*(finiteOr(settings.vatPercent,21)/100);
  const vatCounted=vatMode==='deductible'?0:vat;
  const clearance=finiteOr(cfg.clearanceFeeEur,0);
  const auth=finiteOr(cfg.authenticationFeeEur,0);
  const other=finiteOr(cfg.otherEur,0);
  // Pago con Alipay: se cobra sobre lo que se paga en origen (producto + envío interno).
  const paymentFee=(product+domestic)*(finiteOr(cfg.paymentFeePercent,0)/100);
  // Verificación 验货宝: cuota fija en yuanes, convertida al cambio del BCE.
  const verifCny=finiteOr(cfg.verificationFeeCny,0);
  const verificationFee=verifCny>0?(toEur(verifCny,'CNY')??verifCny/7.5):0;
  const imported=product+domestic+agent+intl+duty+vatCounted+clearance+auth+other+paymentFee+verificationFee;
  return {
    source:sourceKey,
    productPriceEur:roundMoney(product),
    domesticShippingEur:roundMoney(domestic),
    agentFeePercent:finiteOr(cfg.agentFeePercent,0),
    agentFeeFixedEur:roundMoney(finiteOr(cfg.agentFeeFixedEur,0)),
    agentFeeEur:roundMoney(agent),
    internationalShippingEur:roundMoney(intl),
    customsValueEur:roundMoney(customsBase),
    customsDutyPercent:dutyPercent,
    textileDutyApplied:textile&&!euInternal,
    euInternal,
    importVatMode:vatMode,
    lowValueDutyApplied:lowValue,
    customsDutyEur:roundMoney(duty),
    vatPercent:finiteOr(settings.vatPercent,21),
    importVatEur:roundMoney(vat),
    clearanceFeeEur:roundMoney(clearance),
    authenticationFeeEur:roundMoney(auth),
    paymentFeePercent:finiteOr(cfg.paymentFeePercent,0),
    paymentFeeEur:roundMoney(paymentFee),
    verificationFeeCny:verifCny,
    verificationFeeEur:roundMoney(verificationFee),
    otherEur:roundMoney(other),
    importedTotalEur:roundMoney(imported),
    estimate:true
  };
}
function enrichCosts(rows){ return (rows||[]).map(r=>({...r, import_costs:importEconomics(r)})); }

const bunjangCli = path.join(__dirname, 'node_modules', '.bin', 'bunjang-cli');

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function text(res, status, body, type='text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', c => s += c);
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function clampInt(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
function parseJsonArray(v, fallback=[]) {
  if (Array.isArray(v)) return v;
  if (v == null || v === '') return fallback;
  try { const a = JSON.parse(v); return Array.isArray(a) ? a : fallback; } catch { return fallback; }
}
function normalizeLines(v) {
  const raw = Array.isArray(v) ? v : String(v || '').split(/\r?\n|,/);
  const out=[]; const seen=new Set();
  for (const x of raw) { const t=String(x||'').trim(); if(!t) continue; const k=t.toLowerCase(); if(seen.has(k)) continue; seen.add(k); out.push(t); }
  return out;
}
function boolInt(v) { return v ? 1 : 0; }
function taskPublic(row) {
  if (!row) return null;
  return {
    ...row,
    enabled:!!row.enabled, analyze_images:!!row.analyze_images, personal_only:!!row.personal_only, free_shipping:!!row.free_shipping,
    run_if_missed:row.run_if_missed===undefined?true:!!row.run_if_missed,
    email_enabled:!!row.email_enabled,
    notify_only_new:row.notify_only_new===undefined?true:!!row.notify_only_new,
    sources:parseJsonArray(row.sources_json,['xianyu','bunjang','buyee']),
    keyword_rules:parseJsonArray(row.keyword_rules_json,[]),
    xianyu_queries:parseJsonArray(row.xianyu_queries_json,[]),
    bunjang_queries:parseJsonArray(row.bunjang_queries_json,[]),
    japan_queries:parseJsonArray(row.japan_queries_json,[]),
    notify_decisions:parseJsonArray(row.notify_decisions_json,['STRONG BUY','BUY'])
  };
}
function validateTaskInput(body, existing=null) {
  const b={...(existing||{}),...(body||{})};
  const taskName=String(b.task_name||'').trim();
  const productQuery=String(b.product_query||b.product||'').trim();
  if(!taskName) throw new Error('El nombre de la tarea es obligatorio.');
  if(!productQuery) throw new Error('El producto / búsqueda es obligatorio.');
  const sources=normalizeLines(b.sources||parseJsonArray(b.sources_json,[])).filter(x=>['xianyu','bunjang','buyee'].includes(x));
  if(!sources.length) throw new Error('Selecciona al menos una fuente.');
  const decisionMode=String(b.decision_mode||'ai').toLowerCase()==='keyword'?'keyword':'ai';
  const description=String(b.description||'').trim();
  const keywordRules=normalizeLines(b.keyword_rules||parseJsonArray(b.keyword_rules_json,[]));
  if(decisionMode==='ai' && !description) throw new Error('En modo AI, añade una descripción / criterios para el análisis.');
  if(decisionMode==='keyword' && !keywordRules.length) throw new Error('En modo palabras clave, añade al menos una regla.');
  const accountStrategy=['auto','fixed','rotate'].includes(String(b.account_strategy))?String(b.account_strategy):'auto';
  const accountStateFile=String(b.account_state_file||'').trim()||null;
  if(accountStrategy==='fixed' && !accountStateFile) throw new Error('Con cuenta fija de Xianyu debes seleccionar una cuenta.');
  let cron=String(b.cron||'').trim()||null;
  if(cron && cron.split(/\s+/).length!==5) throw new Error('El cron debe tener 5 campos, por ejemplo: 0 9 * * *.');
  let intervalMinutes=(b.interval_minutes===null||b.interval_minutes===''||b.intervalMinutes===null||b.intervalMinutes==='')?null:Number(b.interval_minutes??b.intervalMinutes);
  if(intervalMinutes!=null){ if(!Number.isFinite(intervalMinutes)||intervalMinutes<15) throw new Error('El intervalo mínimo es de 15 minutos.'); intervalMinutes=Math.floor(intervalMinutes); cron=null; }
  const emailEnabled=!!b.email_enabled;
  const emailTo=String(b.email_to||'').trim()||null;
  if(emailEnabled && !emailTo) throw new Error('Añade un email destinatario para activar las notificaciones.');
  const allowedDecisions=['STRONG BUY','BUY','WATCH','REJECT'];
  const notifyDecisions=normalizeLines(b.notify_decisions||parseJsonArray(b.notify_decisions_json,[])).filter(x=>allowedDecisions.includes(x));
  if(emailEnabled && !notifyDecisions.length) throw new Error('Selecciona al menos una decisión para las alertas por correo.');
  const notifyMinScore=(b.notify_min_score===null||b.notify_min_score==='')?null:Number(b.notify_min_score);
  const notifyMinProfit=(b.notify_min_profit_eur===null||b.notify_min_profit_eur==='')?null:Number(b.notify_min_profit_eur);
  return {
    task_name:taskName, enabled:b.enabled===undefined?true:!!b.enabled, product_query:productQuery, sources, description,
    analyze_images:b.analyze_images===undefined?true:!!b.analyze_images, max_pages:clampInt(b.max_pages??b.pages,1,1,5),
    max_items:clampInt(b.max_items??b.maxItems,20,5,100),
    min_eur:(b.min_eur===null||b.min_eur===''||b.minEur===null||b.minEur==='')?null:Number(b.min_eur??b.minEur),
    max_eur:(b.max_eur===null||b.max_eur===''||b.maxEur===null||b.maxEur==='')?null:Number(b.max_eur??b.maxEur),
    personal_only:!!b.personal_only, free_shipping:!!b.free_shipping, new_publish_option:String(b.new_publish_option||'').trim()||null,
    region:String(b.region||'').trim()||null, cron, interval_minutes:intervalMinutes, run_if_missed:b.run_if_missed===undefined?true:!!b.run_if_missed,
    account_state_file:accountStateFile, account_strategy:accountStrategy,
    decision_mode:decisionMode, keyword_rules:keywordRules,
    email_enabled:emailEnabled,email_to:emailTo,notify_decisions:notifyDecisions,
    notify_min_score:Number.isFinite(notifyMinScore)?notifyMinScore:null,notify_min_profit_eur:Number.isFinite(notifyMinProfit)?notifyMinProfit:null,
    notify_max_items:clampInt(b.notify_max_items,8,1,25),notify_only_new:b.notify_only_new===undefined?true:!!b.notify_only_new,
    xianyu_queries:normalizeLines(b.xianyu_queries||parseJsonArray(b.xianyu_queries_json,[])),
    bunjang_queries:normalizeLines(b.bunjang_queries||parseJsonArray(b.bunjang_queries_json,[])),
    japan_queries:normalizeLines(b.japan_queries||parseJsonArray(b.japan_queries_json,[]))
  };
}
function cronPartMatches(part, value, min, max) {
  const atoms=String(part).split(',');
  return atoms.some(atom=>{
    atom=atom.trim(); if(atom==='*') return true;
    const stepMatch=atom.match(/^\*\/(\d+)$/); if(stepMatch) return value%Number(stepMatch[1])===0;
    const range=atom.match(/^(\d+)-(\d+)$/); if(range) return value>=Number(range[1])&&value<=Number(range[2]);
    const n=Number(atom); return Number.isInteger(n)&&n>=min&&n<=max&&n===value;
  });
}
function cronMatches(expr,date=new Date()) {
  if(!expr) return false; const p=String(expr).trim().split(/\s+/); if(p.length!==5) return false;
  return cronPartMatches(p[0],date.getMinutes(),0,59)&&cronPartMatches(p[1],date.getHours(),0,23)&&cronPartMatches(p[2],date.getDate(),1,31)&&cronPartMatches(p[3],date.getMonth()+1,1,12)&&cronPartMatches(p[4],date.getDay(),0,6);
}
function pick(obj, names) {
  for (const n of names) if (obj?.[n] !== undefined && obj?.[n] !== null && obj?.[n] !== '') return obj[n];
  return null;
}
function deepPick(obj, names, depth=0) {
  if (depth > 8 || !obj || typeof obj !== 'object') return null;
  const direct = pick(obj, names); if (direct != null) return direct;
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') { const found = deepPick(v, names, depth+1); if (found != null) return found; }
  }
  return null;
}
function parseMoney(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const m = String(v).replaceAll(',', '').match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}
function normalizeUrl(url, base='') {
  try { return new URL(url, base || undefined).toString(); } catch { return String(url || ''); }
}

function upsertListing(x, sessionId=null, sourceQuery='') {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO listings (
      source, source_id, url, title, description, original_price, currency, price_eur,
      seller_name, seller_items, seller_sales, seller_reviews, image_url, status, raw_json,
      first_seen, last_seen, purchase_via
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, source_id) DO UPDATE SET
      url=excluded.url, title=excluded.title, description=excluded.description,
      original_price=excluded.original_price, currency=excluded.currency, price_eur=excluded.price_eur,
      seller_name=excluded.seller_name, seller_items=excluded.seller_items,
      seller_sales=excluded.seller_sales, seller_reviews=excluded.seller_reviews,
      image_url=excluded.image_url, status=excluded.status, raw_json=excluded.raw_json,
      last_seen=excluded.last_seen, purchase_via=excluded.purchase_via
  `).run(
    x.source, String(x.source_id), x.url || '', x.title || '', x.description || '',
    Number.isFinite(Number(x.original_price)) ? Number(x.original_price) : null,
    x.currency || '', Number.isFinite(Number(x.price_eur)) ? Number(x.price_eur) : null,
    x.seller_name || '', x.seller_items ?? null, x.seller_sales ?? null, x.seller_reviews ?? null,
    x.source==='yahoo-auctions-jp'?yahooAuctionImageUrl(x.image_url)||'':x.image_url||'',
    x.status || '', JSON.stringify(x.raw || {}), now, now, x.purchase_via || ''
  );
  const row = db.prepare('SELECT id FROM listings WHERE source=? AND source_id=?').get(x.source, String(x.source_id));
  if (sessionId && row?.id) {
    db.prepare(`INSERT INTO search_session_items(session_id,listing_id,source_query) VALUES(?,?,?)
      ON CONFLICT(session_id,listing_id) DO UPDATE SET source_query=excluded.source_query`).run(sessionId, row.id, sourceQuery || '');
  }
  return row?.id || null;
}

async function updateFx() {
  const r = await fetch('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml');
  if (!r.ok) throw new Error(`ECB HTTP ${r.status}`);
  const xml = await r.text();
  const now = new Date().toISOString();
  const wanted = ['KRW', 'CNY', 'JPY', 'USD', 'GBP'];
  let count = 0;
  for (const currency of wanted) {
    const m = xml.match(new RegExp(`currency=['"]${currency}['"]\\s+rate=['"]([^'"]+)['"]`));
    if (!m) continue;
    db.prepare(`INSERT INTO fx_rates(currency, per_eur, source, updated_at) VALUES(?,?,?,?)
      ON CONFLICT(currency) DO UPDATE SET per_eur=excluded.per_eur, source=excluded.source, updated_at=excluded.updated_at`)
      .run(currency, Number(m[1]), 'ECB', now);
    count++;
  }
  return count;
}
function toEur(amount, currency) {
  if (!Number.isFinite(Number(amount))) return null;
  if (currency === 'EUR') return Number(amount);
  const row = db.prepare('SELECT per_eur FROM fx_rates WHERE currency=?').get(currency);
  if (!row?.per_eur) return null;
  return Number(amount) / Number(row.per_eur);
}
function eurTo(amountEur, currency) {
  if (!Number.isFinite(Number(amountEur))) return null;
  if (currency === 'EUR') return Number(amountEur);
  const row = db.prepare('SELECT per_eur FROM fx_rates WHERE currency=?').get(currency);
  if (!row?.per_eur) return null;
  return Number(amountEur) * Number(row.per_eur);
}

const CATALOG = [
  {
    test: /balenciaga.*(?:le\s*city|city)|(?:le\s*city|city).*balenciaga/i,
    xianyu: ['巴黎世家 Le City', 'Balenciaga Le City'],
    bunjang: ['발렌시아가 르시티', 'Balenciaga Le City'],
    japan: ['バレンシアガ ル シティ', 'Balenciaga Le City']
  },
  {
    test: /fendi.*spy|spy.*fendi/i,
    xianyu: ['芬迪 Spy 包', 'Fendi Spy'], bunjang: ['펜디 스파이백', 'Fendi Spy'], japan: ['フェンディ スパイバッグ', 'Fendi Spy']
  },
  {
    test: /fendi.*baguette|baguette.*fendi/i,
    xianyu: ['芬迪 Baguette 法棍包', 'Fendi Baguette'], bunjang: ['펜디 바게트', 'Fendi Baguette'], japan: ['フェンディ バゲット', 'Fendi Baguette']
  },
  {
    test: /chlo[eé].*paddington|paddington.*chlo[eé]/i,
    xianyu: ['蔻依 Paddington 锁头包', 'Chloe Paddington'], bunjang: ['끌로에 패딩턴', 'Chloe Paddington'], japan: ['クロエ パディントン', 'Chloe Paddington']
  },
  {
    test: /(?:ysl|saint\s*laurent).*mombasa|mombasa.*(?:ysl|saint\s*laurent)/i,
    xianyu: ['圣罗兰 Mombasa 蒙巴萨', 'YSL Mombasa'], bunjang: ['생로랑 몸바사', 'YSL Mombasa'], japan: ['イヴサンローラン モンバサ', 'YSL Mombasa']
  },
  {
    test: /dior.*gaucho|gaucho.*dior/i,
    xianyu: ['迪奥 Gaucho 高卓包', 'Dior Gaucho'], bunjang: ['디올 가우초', 'Dior Gaucho'], japan: ['ディオール ガウチョ', 'Dior Gaucho']
  },
  {
    test: /miu\s*miu.*coffer|coffer.*miu\s*miu/i,
    xianyu: ['缪缪 Coffer 包', 'Miu Miu Coffer'], bunjang: ['미우미우 코퍼', 'Miu Miu Coffer'], japan: ['ミュウミュウ コファー', 'Miu Miu Coffer']
  },
  {
    test: /prada.*vintage|vintage.*prada/i,
    xianyu: ['普拉达 复古 包', 'Prada vintage bag'], bunjang: ['프라다 빈티지 가방', 'Prada vintage bag'], japan: ['プラダ ヴィンテージ バッグ', 'Prada vintage bag']
  },
  {
    test: /gucci.*vintage|vintage.*gucci/i,
    xianyu: ['古驰 复古 包', 'Gucci vintage bag'], bunjang: ['구찌 빈티지 가방', 'Gucci vintage bag'], japan: ['グッチ ヴィンテージ バッグ', 'Gucci vintage bag']
  },
  {
    test: /c[eé]line.*luggage|luggage.*c[eé]line/i,
    xianyu: ['思琳 Luggage 笑脸包', 'Celine Luggage'],
    bunjang: ['셀린느 러기지백', 'Celine Luggage'],
    japan: ['セリーヌ ラゲージ', 'Celine Luggage']
  },

  {
    test: /celine.*vintage|vintage.*celine/i,
    xianyu: ['思琳 复古 包', 'Celine vintage bag'], bunjang: ['셀린느 빈티지 가방', 'Celine vintage bag'], japan: ['セリーヌ ヴィンテージ バッグ', 'Celine vintage bag']
  },
  {
    test: /bottega.*vintage|vintage.*bottega/i,
    xianyu: ['葆蝶家 复古 包', 'Bottega vintage bag'], bunjang: ['보테가 빈티지 가방', 'Bottega vintage bag'], japan: ['ボッテガ ヴィンテージ バッグ', 'Bottega vintage bag']
  },
  {
    test: /(?:louis\s*vuitton|lv).*vintage|vintage.*(?:louis\s*vuitton|lv)/i,
    xianyu: ['路易威登 复古 包', 'Louis Vuitton vintage bag'], bunjang: ['루이비통 빈티지 가방', 'Louis Vuitton vintage bag'], japan: ['ルイヴィトン ヴィンテージ バッグ', 'Louis Vuitton vintage bag']
  }
];

function normalizeMarketplaceQueries(queries, westernProduct, marketplace) {
  const western = String(westernProduct || '').trim();
  const unique = [...new Set(
    (queries || []).map(q => String(q || '').trim()).filter(Boolean)
  )];
  const local = unique.find(q => q.toLowerCase() !== western.toLowerCase());
  if (!local) {
    throw new Error(`No se pudo generar la query local de ${marketplace} para "${western}".`);
  }
  return [local, western];
}

// GEMINI REQUEST GUARD V1
const GEMINI_HTTP_TIMEOUT_MS=(()=>{
  const raw=String(process.env.GEMINI_HTTP_TIMEOUT_MS||'').trim();
  if(!raw)return 0;

  const n=Number(raw);

  return Number.isFinite(n) && n>0
    ? Math.max(5000,Math.trunc(n))
    : 0;
})();

function geminiErrorMessage(body,status){
  return String(
    body?.error?.message||
    body?.message||
    `Gemini HTTP ${status}`
  );
}

function geminiCapacityError(body,status){
  const msg=geminiErrorMessage(body,status).toLowerCase();
  return Number(status)===429 ||
    /spending cap|quota|resource[_ -]?exhausted|rate limit|billing|exceeded.*cap/.test(msg);
}

function geminiHttpError(body,status){
  const err=new Error(geminiErrorMessage(body,status));
  err.geminiCapacity=geminiCapacityError(body,status);
  err.httpStatus=Number(status)||null;
  return err;
}

async function geminiFetchJson(url,payload,timeoutMs=GEMINI_HTTP_TIMEOUT_MS){
  const controller=timeoutMs>0
    ? new AbortController()
    : null;

  const timer=controller
    ? setTimeout(()=>controller.abort(),timeoutMs)
    : null;

  try{
    const r=await fetch(url,{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify(payload),
      ...(controller?{signal:controller.signal}:{})
    });

    const text=await r.text();
    let body={};

    if(text){
      try{
        body=JSON.parse(text);
      }catch{
        body={message:text.slice(0,2000)};
      }
    }

    return {r,body};
  }catch(e){
    if(e?.name==='AbortError'){
      const err=new Error(`Gemini timeout after ${timeoutMs}ms`);
      err.code='GEMINI_TIMEOUT';
      throw err;
    }
    throw e;
  }finally{
    if(timer)clearTimeout(timer);
  }
}

// ── AI PROVIDER V2 (OpenAI / Gemini) ─────────────────────────────────────
// Toda la IA pasa por geminiJsonRequest()/repairGeminiJson(); aquí se decide
// si la petición va a OpenAI (Responses API) o a Gemini. Google Lens (SerpApi)
// y Google Cloud Vision son independientes del proveedor y no cambian.
function aiProvider(){
  const forced=String(process.env.AI_PROVIDER||'').trim().toLowerCase();
  if(forced==='openai'||forced==='gemini')return forced;
  if(process.env.OPENAI_API_KEY)return 'openai';
  return 'gemini';
}
function aiApiKey(){
  return aiProvider()==='openai'
    ? process.env.OPENAI_API_KEY||''
    : process.env.GEMINI_API_KEY||'';
}
function aiConfigured(){ return !!aiApiKey(); }
function aiModel(){
  return aiProvider()==='openai'
    ? process.env.OPENAI_MODEL||'gpt-6.1-sol'
    : process.env.GEMINI_MODEL||'gemini-3.8-flash';
}
function aiTriageModel(){
  return aiProvider()==='openai'
    ? process.env.OPENAI_TRIAGE_MODEL||'gpt-6-luna'
    : process.env.GEMINI_TRIAGE_MODEL||process.env.GEMINI_MODEL||'gemini-3.8-flash';
}
function aiProviderLabel(){
  return aiProvider()==='openai'?'OpenAI':'Gemini';
}
function aiBillingHint(){
  return aiProvider()==='openai'
    ? 'saldo, límites o facturación en platform.openai.com'
    : 'créditos, cuota o facturación en Google AI Studio';
}

const OPENAI_BASE_URL=String(process.env.OPENAI_BASE_URL||'https://api.openai.com/v1').replace(/\/$/,'');
// OpenAI acepta jpeg/png/webp/gif; HEIC se descarta.
const OPENAI_IMAGE_TYPES=new Set(['image/jpeg','image/png','image/webp','image/gif']);

// Coste: cada propósito usa el modelo y el nivel de razonamiento mínimo
// suficiente. Solo la verificación de candidatos serios usa el modelo caro.
// Verificación "ligera": los WATCH se verifican con el modelo barato y solo
// los BUY / STRONG BUY (posible compra real) con el modelo potente.
const verifyTierStore=new AsyncLocalStorage();
// Análisis que Nil pide a mano por Telegram (enlace + precio negociado).
const manualAiStore=new AsyncLocalStorage();
// Subastas en curso: acaban a una hora fija, así que su análisis no espera al
// reparto por horas del presupuesto (puede adelantar hasta un 25 % del día).
const auctionAiStore=new AsyncLocalStorage();
// REPARTO BOLSOS / RELOJES (regla de Nil, 07-11-2026): el presupuesto de IA
// del día se divide AI_WATCH_SHARE (25 %) para relojes y el resto (75 %) para
// bolsos (Nil, 07-11-2026).
const aiCategoryStore=new AsyncLocalStorage();
function aiCategoryShare(cat){
  const w=Math.max(0,Math.min(1,Number(process.env.AI_WATCH_SHARE??0.25)));
  return cat==='watch'?w:1-w;
}

function openaiPurposeConfig(purpose,requestedModel){
  const cheap=process.env.OPENAI_TRIAGE_MODEL||'gpt-6-luna';
  const strong=process.env.OPENAI_MODEL||'gpt-6.1-sol';
  if(purpose==='verify'&&verifyTierStore.getStore()==='lite'){
    return {model:process.env.OPENAI_VERIFY_LITE_MODEL||cheap,effort:'low',detail:'low'};
  }
  const cfg={
    triage:{model:cheap,effort:process.env.OPENAI_TRIAGE_EFFORT||'none',detail:'low'},
    repair:{model:cheap,effort:'none',detail:'low'},
    telegram:{model:cheap,effort:'low',detail:'high'},
    screen:{model:process.env.OPENAI_SCREEN_MODEL||cheap,effort:process.env.OPENAI_SCREEN_EFFORT||'low',detail:'low'},
    verify:{model:strong,effort:process.env.OPENAI_VERIFY_EFFORT||'low',detail:process.env.OPENAI_IMAGE_DETAIL||'auto'}
  }[purpose]||{model:requestedModel||strong,effort:'low',detail:'auto'};
  // Los modelos sol/astra no admiten 'none'.
  if(cfg.effort==='none'&&!/luna/i.test(cfg.model))cfg.effort='low';
  return cfg;
}

// Precios por millón de tokens (entrada, salida, entrada en caché), según
// la página oficial de precios de OpenAI. El razonamiento cuenta como salida.
const OPENAI_PRICES={
  'gpt-6-astra':[10,50,1],
  'gpt-6.1-sol':[2,10,0.10],
  'gpt-6-sol':[2,10,0.20],
  'gpt-6-luna':[0.10,0.50,0.01],
  'gpt-5.6-luna':[0.20,1.20,0.02]
};
const OPENAI_WEB_SEARCH_USD=0.01;

function aiSpendDay(){
  return new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
}
// Tope mensual (factura de OpenAI, mes en UTC): cada día puede gastar hasta
// AI_DAILY_BUDGET_USD, pero nunca más de lo que queda del mes. AI_MONTH_SPENT_RESET="AAAA-MM:usd" ajusta lo gastado
// en el mes al valor real del panel de OpenAI (una vez por valor).
function aiMonthKey(){return new Date().toISOString().slice(0,7);}
function getAiMonthSpend(){
  const st=getSetting('ai_spend_month',{})||{};
  return st.month===aiMonthKey()?st:{month:aiMonthKey(),usd:0};
}
function addAiMonthSpend(usd){
  const st=getAiMonthSpend();
  st.usd=Number((Number(st.usd||0)+usd).toFixed(6));
  db.prepare(`INSERT INTO app_settings(key,value_json,updated_at) VALUES('ai_spend_month',?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`).run(JSON.stringify(st),new Date().toISOString());
}
function applyAiMonthSpendReset(){
  const raw=String(process.env.AI_MONTH_SPENT_RESET||'').trim();
  const m=raw.match(/^(\d{4}-\d{2}):(\d+(?:\.\d+)?)$/);
  if(!m||m[1]!==aiMonthKey())return;
  if(getSetting('ai_month_reset_applied',null)===raw)return;
  // El valor del panel ya incluye lo de hoy hasta ahora: se suma solo lo que
  // se gaste a partir de este momento.
  const now=new Date().toISOString();
  const put=db.prepare(`INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`);
  put.run('ai_spend_month',JSON.stringify({month:m[1],usd:Number(m[2]),todayAtReset:getAiSpend().usd}),now);
  put.run('ai_month_reset_applied',JSON.stringify(raw),now);
  console.log(`Gasto de IA del mes ajustado a ${m[2]} $.`);
}
function aiMonthlyAllowanceTodayUsd(){
  const cap=Number(process.env.AI_MONTHLY_BUDGET_USD||0);
  if(!Number.isFinite(cap)||cap<=0)return Infinity;
  const month=getAiMonthSpend();
  // Lo gastado antes de hoy = mes - hoy (lo de hoy ya contado en el mes).
  const todaySinceReset=Math.max(0,getAiSpend().usd-Number(month.todayAtReset||0));
  const beforeToday=Math.max(0,Number(month.usd||0)-todaySinceReset);
  // Lo que queda del mes antes de hoy; aiMonthSpreadTodayUsd lo reparte por días.
  return Math.max(0,cap-beforeToday);
}
// Reparto del mes: lo que queda del tope mensual se divide entre los días que
// faltan (hoy incluido). Un día que gasta poco deja más para los siguientes y
// uno que gasta mucho deja menos, así el bot no se queda sin IA a mitad de mes.
// AI_MONTH_SPREAD=off vuelve al modo anterior (hasta el tope diario sin repartir).
function aiMonthSpreadTodayUsd(){
  const left=aiMonthlyAllowanceTodayUsd();
  if(!Number.isFinite(left)||String(process.env.AI_MONTH_SPREAD||'').toLowerCase()==='off')return left;
  const now=new Date();
  const daysInMonth=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,0)).getUTCDate();
  const daysLeft=Math.max(1,daysInMonth-now.getUTCDate()+1);
  return left/daysLeft;
}
function aiDailyBudgetUsd(){
  const n=Number(process.env.AI_DAILY_BUDGET_USD??1);
  const daily=Number.isFinite(n)&&n>0?n:Infinity;
  return Math.min(daily,aiMonthSpreadTodayUsd());
}
// Ajuste manual del gasto de hoy (una sola vez por valor): variable
// AI_SPEND_RESET="AAAA-MM-DD:usd" → el contador de ese día pasa a "usd".
function applyAiSpendReset(){
  const raw=String(process.env.AI_SPEND_RESET||'').trim();
  const m=raw.match(/^(\d{4}-\d{2}-\d{2}):(\d+(?:\.\d+)?)$/);
  if(!m||m[1]!==aiSpendDay())return;
  if(getSetting('ai_spend_reset_applied',null)===raw)return;
  const state=getSetting('ai_spend',{})||{};
  const next={...(state.day===m[1]?state:{day:m[1],calls:0,webSearches:0,byPurpose:{}}),usd:Number(m[2]),byPurpose:{},resetFrom:state.day===m[1]?state.usd:0};
  const now=new Date().toISOString();
  const put=db.prepare(`INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`);
  put.run('ai_spend',JSON.stringify(next),now);
  put.run('ai_spend_reset_applied',JSON.stringify(raw),now);
  console.log(`Gasto de IA de hoy ajustado a ${m[2]} $ (antes ${next.resetFrom} $).`);
}

function getAiSpend(){
  const state=getSetting('ai_spend',{})||{};
  return state.day===aiSpendDay()?state:{day:aiSpendDay(),usd:0,calls:0,webSearches:0,byPurpose:{}};
}
function recordAiSpend(model,purpose,body){
  const u=body?.usage||{};
  const [pin,pout,pcached]=OPENAI_PRICES[model]||OPENAI_PRICES['gpt-6.1-sol'];
  const input=Number(u.input_tokens)||0;
  const cached=Number(u.input_tokens_details?.cached_tokens)||0;
  const output=Number(u.output_tokens)||0;
  const searches=(body?.output||[]).filter(x=>x?.type==='web_search_call').length;
  // Margen de seguridad: la factura real de OpenAI sale ~15-20 % por encima
  // de lo calculado con tokens (imágenes, búsquedas...). Mejor pasarse.
  const safety=Number(process.env.AI_COST_SAFETY_FACTOR||1.25);
  const usd=(((input-cached)*pin+cached*pcached+output*pout)/1e6+searches*OPENAI_WEB_SEARCH_USD)*(Number.isFinite(safety)&&safety>=1?safety:1.25);
  const state=getAiSpend();
  state.usd=Number((state.usd+usd).toFixed(6));
  state.calls=(state.calls||0)+1;
  state.webSearches=(state.webSearches||0)+searches;
  state.byPurpose=state.byPurpose||{};
  const bp=state.byPurpose[purpose]||{usd:0,calls:0};
  bp.usd=Number((bp.usd+usd).toFixed(6));
  bp.calls++;
  state.byPurpose[purpose]=bp;
  const cat=aiCategoryStore.getStore();
  if(cat){
    state.byCategory=state.byCategory||{};
    const bc=state.byCategory[cat]||{usd:0,calls:0};
    bc.usd=Number((bc.usd+usd).toFixed(6));bc.calls++;
    state.byCategory[cat]=bc;
  }
  addAiMonthSpend(usd);
  db.prepare(`INSERT INTO app_settings(key,value_json,updated_at) VALUES('ai_spend',?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
    .run(JSON.stringify(state),new Date().toISOString());
  return usd;
}
// Reparto del presupuesto a lo largo del día: a las 00:00 solo se puede usar
// un 15 % y el resto se va liberando por horas (lo no gastado se acumula).
// Así el arranque del día no se come todo el importe. AI_PACE=off lo desactiva.
function aiPaceShare(){
  // Sin reparto por horas salvo AI_PACE=on (regla de Nil, 07-11-2026: que no
  // se limite lo que se enseña por hora; el tope es el del día).
  if(!['on','1','true','yes'].includes(String(process.env.AI_PACE||'').toLowerCase()))return 1;
  const start=Math.min(1,Math.max(0,Number(process.env.AI_PACE_START_SHARE??0.15)));
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Madrid',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date()).map(x=>[x.type,x.value]));
  const hours=Number(p.hour)+Number(p.minute)/60;
  return Math.min(1,start+(1-start)*hours/24);
}
function assertAiBudget(purpose=''){
  const budget=aiDailyBudgetUsd();
  const spend=getAiSpend();
  // TRIAJE SIEMPRE (Nil, 07-11-2026): el triaje barato sigue aunque se acabe
  // el presupuesto del día, con una reserva aparte (AI_TRIAGE_RESERVE_USD).
  if(purpose==='triage'&&!manualAiStore.getStore()){
    const reserve=Math.max(0,Number(process.env.AI_TRIAGE_RESERVE_USD??0.4));
    if(spend.usd<budget+reserve&&spend.usd<aiMonthlyAllowanceTodayUsd())return;
  }
  // Lo que Nil pide a mano no espera al reparto por horas ni al tope diario:
  // cuenta en el gasto y solo se para con el tope mensual.
  if(manualAiStore.getStore()){
    if(spend.usd>=aiMonthlyAllowanceTodayUsd()){
      const err=new Error('Presupuesto mensual de IA alcanzado.');
      err.geminiCapacity=true;
      err.aiBudget=true;
      throw err;
    }
    return;
  }
  const advanceShare=auctionAiStore.getStore()?Math.max(0,Math.min(1,Number(process.env.AUCTION_AI_ADVANCE_SHARE??0.25))):0;
  const cat=aiCategoryStore.getStore();
  if(cat){
    const label=cat==='watch'?'relojes':'bolsos';
    const catBudget=budget*aiCategoryShare(cat);
    const catSpent=Number(spend.byCategory?.[cat]?.usd||0);
    if(catSpent>=catBudget){
      const err=new Error(`Presupuesto de IA de ${label} de hoy alcanzado (${catSpent.toFixed(2)} $ de ${catBudget.toFixed(2)} $). Se reanuda mañana.`);
      err.geminiCapacity=true;err.aiBudget=true;err.aiPace=true;
      throw err;
    }
    const catPaced=catBudget*aiPaceShare()+catBudget*advanceShare;
    if(catSpent>=catPaced){
      const err=new Error(`Ritmo de gasto de IA de ${label}: ${catSpent.toFixed(2)} $ usados de ${catPaced.toFixed(2)} $ disponibles a esta hora (${catBudget.toFixed(2)} $ en todo el día). Los anuncios pendientes se analizan más tarde.`);
      err.geminiCapacity=true;err.aiBudget=true;err.aiPace=true;
      throw err;
    }
  }
  const advance=budget*advanceShare;
  const paced=budget*aiPaceShare()+advance;
  if(spend.usd<budget&&spend.usd>=paced){
    const err=new Error(`Ritmo de gasto de IA: ${spend.usd.toFixed(2)} $ usados de ${paced.toFixed(2)} $ disponibles a esta hora (${budget.toFixed(2)} $ en todo el día). Los anuncios pendientes se analizan más tarde.`);
    err.geminiCapacity=true;
    err.aiBudget=true;
    err.aiPace=true;
    throw err;
  }
  if(spend.usd>=budget){
    const err=new Error(`Presupuesto diario de IA alcanzado (${spend.usd.toFixed(2)} $ de ${budget.toFixed(2)} $). Se reanuda mañana.`);
    err.geminiCapacity=true;
    err.aiBudget=true;
    throw err;
  }
}

// Las verificaciones (búsqueda web + modelo potente, ~0,05-0,09 $ cada una)
// tienen su propio tope diario para que nunca dejen sin presupuesto al
// triaje y al análisis, que son los que encuentran oportunidades nuevas.
function watchTaskIds(){return db.prepare('SELECT id,task_name FROM tasks').all().filter(t=>isWatchTask(t.task_name)).map(t=>Number(t.id));}
// Análisis IA de hoy en tareas de relojes (sin contar los descartes del pre-filtro, que no gastan IA).
function verifyBudgetLeftUsd(){
  if(manualAiStore.getStore())return Infinity;
  let budget=Number(process.env.AI_VERIFY_DAILY_BUDGET_USD||0.8);
  if(!Number.isFinite(budget)||budget<=0)return Infinity;
  // Con tope mensual, la verificación nunca pasa de la mitad del día.
  budget=Math.min(budget,aiDailyBudgetUsd()*0.5);
  const spent=Number(getAiSpend()?.byPurpose?.verify?.usd||0);
  return budget*aiPaceShare()-spent;
}

function openaiInputFromParts(parts,detail='auto'){
  const content=[];
  for(const p of parts||[]){
    if(typeof p?.text==='string'){
      content.push({type:'input_text',text:p.text});
    }else if(p?.inline_data?.data){
      const type=String(p.inline_data.mime_type||'image/jpeg').toLowerCase();
      if(!OPENAI_IMAGE_TYPES.has(type))continue;
      content.push({
        type:'input_image',
        image_url:`data:${type};base64,${p.inline_data.data}`,
        detail
      });
    }
  }
  return [{role:'user',content}];
}

function openaiOutputText(body){
  if(typeof body?.output_text==='string')return body.output_text;
  return (body?.output||[])
    .filter(x=>x?.type==='message')
    .flatMap(x=>x.content||[])
    .filter(c=>c?.type==='output_text')
    .map(c=>c.text||'')
    .join('');
}

function openaiWebEvidence(body){
  const sources=[];
  const queries=[];
  for(const item of body?.output||[]){
    if(item?.type==='web_search_call'){
      const action=item.action||{};
      if(action.query)queries.push(action.query);
      if(Array.isArray(action.queries))queries.push(...action.queries);
      for(const s of action.sources||[]){
        if(s?.url)sources.push({title:s.title||'',url:s.url});
      }
    }
    if(item?.type==='message'){
      for(const c of item.content||[]){
        for(const a of c?.annotations||[]){
          if(a?.type==='url_citation'&&a.url)sources.push({title:a.title||'',url:a.url});
        }
      }
    }
  }
  const seen=new Set();
  return {
    groundingSources:sources.filter(s=>!seen.has(s.url)&&seen.add(s.url)),
    webSearchQueries:[...new Set(queries.filter(Boolean))]
  };
}

function openaiMarketSearchDomains(){
  return [...new Set([
    ...TRUSTED_LUXURY_MARKET_DOMAINS,
    ...SECONDARY_LUXURY_MARKET_DOMAINS,
    ...EUROPE_PRIORITY_LUXURY_MARKET_DOMAINS
  ])].slice(0,100);
}

async function openaiResponsesRequest({key,model,parts,webSearch=false,json=true,purpose='verify'}){
  assertAiBudget(purpose);
  const pc=openaiPurposeConfig(purpose,model);
  const payload={
    model:pc.model,
    reasoning:{effort:pc.effort},
    input:openaiInputFromParts(parts,pc.detail)
  };
  if(webSearch){
    // Mismo papel que el Google Search de Gemini, pero limitado desde el
    // origen a las webs de reventa de lujo de confianza.
    const ctx=String(process.env.OPENAI_SEARCH_CONTEXT||'low');
    payload.tools=[{
      type:'web_search',
      filters:{allowed_domains:openaiMarketSearchDomains()},
      ...(ctx&&ctx!=='default'?{search_context_size:ctx}:{})
    }];
    payload.tool_choice='required';
    payload.include=['web_search_call.action.sources'];
  }else if(json){
    payload.text={format:{type:'json_object'}};
  }
  const timeoutMs=GEMINI_HTTP_TIMEOUT_MS;
  const controller=timeoutMs>0?new AbortController():null;
  const timer=controller?setTimeout(()=>controller.abort(),timeoutMs):null;
  try{
    const r=await fetch(`${OPENAI_BASE_URL}/responses`,{
      method:'POST',
      headers:{
        'content-type':'application/json',
        authorization:`Bearer ${key}`
      },
      body:JSON.stringify(payload),
      ...(controller?{signal:controller.signal}:{})
    });
    const text=await r.text();
    let body={};
    if(text){
      try{body=JSON.parse(text);}catch{body={message:text.slice(0,2000)};}
    }
    if(!r.ok&&webSearch&&/search_context_size/i.test(JSON.stringify(body?.error||''))&&!process.env.__LH_NO_SEARCH_CTX){
      // El modelo no admite ese parámetro: se repite sin él.
      process.env.OPENAI_SEARCH_CONTEXT='default';
      return openaiResponsesRequest({key,model,parts,webSearch,json,purpose});
    }
    if(!r.ok){
      const err=geminiHttpError(body,r.status);
      const code=String(body?.error?.code||body?.error?.type||'');
      if(/insufficient_quota|billing|rate_limit/i.test(code))err.geminiCapacity=true;
      // Filtro de seguridad de OpenAI: el problema es el contenido de un
      // anuncio concreto, no la cuenta ni el presupuesto.
      if(isAiPolicyFlag(err)||/invalid_prompt|content_policy|content_filter/i.test(code)){
        err.policyFlag=true;
        err.geminiCapacity=false;
      }
      throw err;
    }
    recordAiSpend(pc.model,purpose,body);
    return body;
  }catch(e){
    if(e?.name==='AbortError'){
      const err=new Error(`OpenAI timeout after ${timeoutMs}ms`);
      err.code='AI_TIMEOUT';
      throw err;
    }
    throw e;
  }finally{
    if(timer)clearTimeout(timer);
  }
}

async function generateQueryPlanWithGemini(product) {
  const key = aiApiKey();
  if (!key) return null;
  const model = aiModel();
  if(aiProvider()==='openai'){
    const prompt=`You generate marketplace search queries for second-hand luxury goods. Return ONLY JSON with keys xianyu, bunjang, japan. Each value MUST contain exactly 2 concise search strings. Query 1 MUST be the natural local-language marketplace query: Simplified Chinese for Xianyu, Korean for Bunjang, Japanese for Japan. Query 2 MUST be the Western/original product name. Keep the exact product family; do not broaden to unrelated models. Product: ${product}`;
    try{
      const body=await openaiResponsesRequest({key,model:aiTriageModel(),parts:[{text:prompt}],purpose:'triage'});
      return JSON.parse(openaiOutputText(body));
    }catch{return null;}
  }
  const prompt = `You generate marketplace search queries for second-hand luxury goods. Return ONLY JSON with keys xianyu, bunjang, japan. Each value MUST contain exactly 2 concise search strings. Query 1 MUST be the natural local-language marketplace query: Simplified Chinese for Xianyu, Korean for Bunjang, Japanese for Japan. Query 2 MUST be the Western/original product name. Keep the exact product family; do not broaden to unrelated models. Product: ${product}`;
  const u = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const {r,body}=await geminiFetchJson(
    u,
    {
      contents:[{role:'user',parts:[{text:prompt}]}],
      generationConfig:{responseMimeType:'application/json'}
    }
  );
  if(!r.ok)return null;
  const raw = body?.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('') || '';
  try { return JSON.parse(raw); } catch { return null; }
}

async function buildQueryPlan(product) {
  const text = String(product || '').trim();
  if (!text) throw new Error('Escribe un producto para buscar.');
  const found = CATALOG.find(x => x.test.test(text));
  if (found) return {
    product:text,
    xianyu:normalizeMarketplaceQueries(found.xianyu, text, 'Xianyu'),
    bunjang:normalizeMarketplaceQueries(found.bunjang, text, 'Bunjang'),
    japan:normalizeMarketplaceQueries(found.japan, text, 'Japan'),
    generatedBy:'catalog'
  };
  try {
    const ai = await generateQueryPlanWithGemini(text);
    if (ai?.xianyu?.length || ai?.bunjang?.length || ai?.japan?.length) {
      return {
        product:text,
        xianyu:normalizeMarketplaceQueries(ai.xianyu, text, 'Xianyu'),
        bunjang:normalizeMarketplaceQueries(ai.bunjang, text, 'Bunjang'),
        japan:normalizeMarketplaceQueries(ai.japan, text, 'Japan'),
        generatedBy:'gemini'
      };
    }
  } catch {}
  throw new Error(`No se pudo generar un plan localizado de 2 queries para "${text}".`);
}

// Asíncrono: la versión con execFileSync bloqueaba el servidor entero
// mientras Bunjang buscaba, y con tareas en paralelo las demás fallaban.
function runBunjangCli(args) {
  if (!fs.existsSync(bunjangCli)) return Promise.reject(new Error('bunjang-cli no está instalado. Ejecuta npm install.'));
  return new Promise((resolve, reject) => {
    execFile(bunjangCli, args, { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(String(stdout).trim())); } catch (e) { reject(e); }
    });
  });
}
function chunks(arr, n) { const out=[]; for(let i=0;i<arr.length;i+=n) out.push(arr.slice(i,i+n)); return out; }

// BUNJANG PUBLICATION PAGE AGE V2
// Para cada anuncio Bunjang:
// 1. Intentar fecha real de publicación en la propia página.
// 2. Si no existe, leer la antigüedad visible del anuncio.
// 3. Nunca usar updatedAt como sustituto de publication time.

function bunjangRelativeAgeToMs(text, nowMs=Date.now()){
  const s=String(text||'')
    .replace(/\s+/g,' ')
    .trim()
    .toLowerCase();

  if(!s)return null;

  if(
    /^(방금\s*전|방금전|just\s*now|ahora|hace\s+un\s+momento)$/i.test(s)
  ){
    return nowMs;
  }

  const rules=[
    {
      patterns:[
        /^(\d+)\s*초\s*전$/i,
        /^hace\s+(\d+)\s*(?:segundo|segundos|s)$/i,
        /^(\d+)\s*(?:second|seconds|sec|secs)\s*ago$/i
      ],
      unit:1000
    },
    {
      patterns:[
        /^(\d+)\s*분\s*전$/i,
        /^hace\s+(\d+)\s*(?:minuto|minutos|min)$/i,
        /^(\d+)\s*(?:minute|minutes|min|mins)\s*ago$/i
      ],
      unit:60*1000
    },
    {
      patterns:[
        /^(\d+)\s*시간\s*전$/i,
        /^hace\s+(\d+)\s*(?:hora|horas|h)$/i,
        /^(\d+)\s*(?:hour|hours|hr|hrs)\s*ago$/i
      ],
      unit:60*60*1000
    },
    {
      patterns:[
        /^(\d+)\s*일\s*전$/i,
        /^hace\s+(\d+)\s*(?:día|días|dia|dias)$/i,
        /^(\d+)\s*(?:day|days)\s*ago$/i
      ],
      unit:24*60*60*1000,
      forceOlder:true
    },
    {
      patterns:[
        /^(\d+)\s*주\s*전$/i,
        /^hace\s+(\d+)\s*(?:semana|semanas)$/i,
        /^(\d+)\s*(?:week|weeks)\s*ago$/i
      ],
      unit:7*24*60*60*1000,
      forceOlder:true
    },
    {
      patterns:[
        /^(\d+)\s*개월\s*전$/i,
        /^hace\s+(\d+)\s*(?:mes|meses)$/i,
        /^(\d+)\s*(?:month|months)\s*ago$/i
      ],
      unit:30*24*60*60*1000,
      forceOlder:true
    },
    {
      patterns:[
        /^(\d+)\s*년\s*전$/i,
        /^hace\s+(\d+)\s*(?:año|años|ano|anos)$/i,
        /^(\d+)\s*(?:year|years)\s*ago$/i
      ],
      unit:365*24*60*60*1000,
      forceOlder:true
    }
  ];

  for(const rule of rules){
    for(const pattern of rule.patterns){
      const m=s.match(pattern);
      if(!m)continue;

      const amount=Number(m[1]);
      if(!Number.isFinite(amount))continue;

      let publishedMs=nowMs-(amount*rule.unit);

      // "1 día" ya no es "menos de 24 horas".
      if(rule.forceOlder){
        publishedMs-=1000;
      }

      return publishedMs;
    }
  }

  return null;
}

function bunjangFindStructuredPublication(html){
  const patterns=[
    /"datePublished"\s*:\s*"([^"]+)"/ig,
    /"publishedAt"\s*:\s*"([^"]+)"/ig,
    /"published_at"\s*:\s*"([^"]+)"/ig,
    /"postedAt"\s*:\s*"([^"]+)"/ig,
    /"posted_at"\s*:\s*"([^"]+)"/ig,
    /"registeredAt"\s*:\s*"([^"]+)"/ig,
    /"registered_at"\s*:\s*"([^"]+)"/ig
  ];

  for(const pattern of patterns){
    let m;

    while((m=pattern.exec(html))!==null){
      const value=String(m[1]||'').trim();
      const ms=parseMarketplacePublishedMs(value,'+09:00');

      if(ms!==null){
        return {
          publishedMs:ms,
          raw:value,
          source:'structured_publication_timestamp'
        };
      }
    }
  }

  return null;
}

function bunjangVisibleAgeFromText(text){
  const normalized=String(text||'')
    .replace(/\s+/g,' ')
    .trim();

  const patterns=[
    /방금\s*전/i,
    /\d+\s*초\s*전/i,
    /\d+\s*분\s*전/i,
    /\d+\s*시간\s*전/i,
    /\d+\s*일\s*전/i,
    /\d+\s*주\s*전/i,
    /\d+\s*개월\s*전/i,
    /\d+\s*년\s*전/i,

    /hace\s+\d+\s*(?:segundo|segundos|s)\b/i,
    /hace\s+\d+\s*(?:minuto|minutos|min)\b/i,
    /hace\s+\d+\s*(?:hora|horas|h)\b/i,
    /hace\s+\d+\s*(?:día|días|dia|dias)\b/i,
    /hace\s+\d+\s*(?:semana|semanas)\b/i,
    /hace\s+\d+\s*(?:mes|meses)\b/i,
    /hace\s+\d+\s*(?:año|años|ano|anos)\b/i,

    /\d+\s*(?:second|seconds|sec|secs)\s*ago/i,
    /\d+\s*(?:minute|minutes|min|mins)\s*ago/i,
    /\d+\s*(?:hour|hours|hr|hrs)\s*ago/i,
    /\d+\s*(?:day|days)\s*ago/i,
    /\d+\s*(?:week|weeks)\s*ago/i,
    /\d+\s*(?:month|months)\s*ago/i,
    /\d+\s*(?:year|years)\s*ago/i
  ];

  for(const pattern of patterns){
    const m=normalized.match(pattern);
    if(m)return String(m[0]).trim();
  }

  return null;
}

// BUNJANG RECENCY ROBUSTNESS V1
// BUNJANG PLAYWRIGHT PUBLICATION FALLBACK V1

let bunjangPublicationBrowserPromise=null;

async function getBunjangPublicationBrowser(){
  if(!bunjangPublicationBrowserPromise){
    bunjangPublicationBrowserPromise=(async()=>{
      const {chromium}=await import('playwright');

      return chromium.launch({
        headless:true,
        args:[
          '--disable-dev-shm-usage',
          '--no-sandbox'
        ]
      });
    })().catch(e=>{
      bunjangPublicationBrowserPromise=null;
      throw e;
    });
  }

  return bunjangPublicationBrowserPromise;
}

async function fetchBunjangPublicationRendered(item){
  const id=String(item?.id||'').trim();

  if(!id){
    return {
      publishedAt:null,
      ageText:null,
      source:'rendered_missing_product_id',
      status:'UNKNOWN'
    };
  }

  let page=null;

  try{
    const browser=await getBunjangPublicationBrowser();

    page=await browser.newPage({
      locale:'ko-KR',
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '+
        'AppleWebKit/537.36 Chrome/150 Safari/537.36'
    });

    const url=
      `https://m.bunjang.co.kr/products/${encodeURIComponent(id)}`;

    await page.goto(url,{
      waitUntil:'domcontentloaded',
      timeout:25000
    });

    try{
      await page.waitForFunction(
        () => {
          const t=(document.body?.innerText||'')
            .replace(/\s+/g,' ');

          return (
            /방금\s*전/.test(t) ||
            /\d+\s*초\s*전/.test(t) ||
            /\d+\s*분\s*전/.test(t) ||
            /\d+\s*시간\s*전/.test(t) ||
            /\d+\s*일\s*전/.test(t) ||
            /\d+\s*주\s*전/.test(t) ||
            /\d+\s*개월\s*전/.test(t) ||
            /\d+\s*년\s*전/.test(t) ||
            /hace\s+\d+\s*(?:segundos?|minutos?|horas?|d[ií]as?|semanas?|mes(?:es)?|años?)/i.test(t) ||
            /\d+\s*(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s*ago/i.test(t)
          );
        },
        null,
        {timeout:10000}
      );
    }catch{}

    await page.waitForTimeout(700);

    const renderedHtml=await page.content();

    const structured=bunjangFindStructuredPublication(
      renderedHtml
    );

    if(structured){
      const ageMs=Date.now()-structured.publishedMs;

      return {
        publishedAt:
          new Date(structured.publishedMs).toISOString(),
        ageText:null,
        source:'rendered_'+structured.source,
        sourceValue:structured.raw,
        status:
          ageMs>=-10*60*1000 &&
          ageMs<24*60*60*1000
            ? 'FRESH'
            : 'STALE'
      };
    }

    let bodyText='';

    try{
      bodyText=await page.locator('body').innerText({
        timeout:5000
      });
    }catch{}

    bodyText=String(bodyText||'')
      .replace(/\s+/g,' ')
      .trim();

    let relevantText=bodyText;

    const title=String(item?.title||'')
      .replace(/\s+/g,' ')
      .trim();

    if(title){
      const index=bodyText.indexOf(title);

      if(index>=0){
        relevantText=bodyText.slice(
          index,
          index+3000
        );
      }
    }

    let ageText=bunjangVisibleAgeFromText(
      relevantText
    );

    if(!ageText && relevantText!==bodyText){
      ageText=bunjangVisibleAgeFromText(
        bodyText.slice(0,7000)
      );
    }

    if(!ageText){
      return {
        publishedAt:null,
        ageText:null,
        source:'rendered_visible_age_not_found',
        status:'UNKNOWN'
      };
    }

    const publishedMs=bunjangRelativeAgeToMs(
      ageText
    );

    if(publishedMs===null){
      return {
        publishedAt:null,
        ageText,
        source:'rendered_visible_age_unparseable',
        status:'UNKNOWN'
      };
    }

    const ageMs=Date.now()-publishedMs;

    return {
      publishedAt:
        new Date(publishedMs).toISOString(),
      ageText,
      source:'rendered_visible_listing_age',
      status:
        ageMs>=-10*60*1000 &&
        ageMs<24*60*60*1000
          ? 'FRESH'
          : 'STALE'
    };

  }catch(e){
    return {
      publishedAt:null,
      ageText:null,
      source:
        e?.name==='TimeoutError'
          ? 'rendered_timeout'
          : `rendered_error:${String(e?.message||e)}`,
      status:'UNKNOWN'
    };
  }finally{
    if(page){
      try{
        await page.close();
      }catch{}
    }
  }
}

async function fetchBunjangPublication(item){
  const id=String(item?.id||'').trim();

  if(!id){
    return {
      publishedAt:null,
      ageText:null,
      source:'missing_product_id',
      status:'UNKNOWN'
    };
  }

  const url=
    String(item?.url||'').trim()
    ||
    `https://m.bunjang.co.kr/products/${encodeURIComponent(id)}`;

  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),15000);

  try{
    const r=await fetch(url,{
      signal:controller.signal,
      redirect:'follow',
      headers:{
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '+
          'AppleWebKit/537.36 Chrome/150 Safari/537.36',
        'accept-language':'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        'accept':'text/html,application/xhtml+xml'
      }
    });

    if(!r.ok){
      return {
        publishedAt:null,
        ageText:null,
        source:`http_${r.status}`,
        status:'UNKNOWN'
      };
    }

    const html=await r.text();

    const structured=bunjangFindStructuredPublication(html);

    if(structured){
      const ageMs=Date.now()-structured.publishedMs;

      return {
        publishedAt:new Date(structured.publishedMs).toISOString(),
        ageText:null,
        source:structured.source,
        sourceValue:structured.raw,
        status:
          ageMs>=-10*60*1000 &&
          ageMs<24*60*60*1000
            ? 'FRESH'
            : 'STALE'
      };
    }

    const $=loadHtml(html);

    const bodyText=$('body')
      .text()
      .replace(/\s+/g,' ')
      .trim();

    // La antigüedad del producto suele aparecer justo después
    // de título/precio. Si podemos localizar el título,
    // reducimos la búsqueda a esa zona para evitar edades
    // correspondientes a otros productos o al vendedor.
    let relevantText=bodyText;

    const title=String(item?.title||'')
      .replace(/\s+/g,' ')
      .trim();

    if(title){
      const titleIndex=bodyText.indexOf(title);

      if(titleIndex>=0){
        relevantText=bodyText.slice(
          titleIndex,
          titleIndex+2500
        );
      }
    }

    let ageText=bunjangVisibleAgeFromText(relevantText);

    if(!ageText && relevantText!==bodyText){
      ageText=bunjangVisibleAgeFromText(
        bodyText.slice(0,5000)
      );
    }

    if(!ageText){
      let rendered=
        await fetchBunjangPublicationRendered(item);

      if(
        rendered?.status==='UNKNOWN' &&
        String(rendered?.source||'').includes('timeout')
      ){
        await sleep(500);

        rendered=
          await fetchBunjangPublicationRendered(item);
      }

      if(
        rendered?.publishedAt ||
        rendered?.ageText ||
        rendered?.status==='FRESH' ||
        rendered?.status==='STALE'
      ){
        return rendered;
      }

      return {
        publishedAt:null,
        ageText:null,
        source:
          rendered?.source ||
          'visible_age_not_found',
        status:'UNKNOWN'
      };
    }

    const publishedMs=bunjangRelativeAgeToMs(ageText);

    if(publishedMs===null){
      return {
        publishedAt:null,
        ageText,
        source:'visible_age_unparseable',
        status:'UNKNOWN'
      };
    }

    const ageMs=Date.now()-publishedMs;

    return {
      publishedAt:new Date(publishedMs).toISOString(),
      ageText,
      source:'visible_listing_age',
      status:
        ageMs>=-10*60*1000 &&
        ageMs<24*60*60*1000
          ? 'FRESH'
          : 'STALE'
    };

  }catch(e){
    return {
      publishedAt:null,
      ageText:null,
      source:
        e?.name==='AbortError'
          ? 'timeout'
          : String(e?.message||e),
      status:'UNKNOWN'
    };
  }finally{
    clearTimeout(timeout);
  }
}


// ── BUNJANG: WEB COREANA ─────────────────────────────────────────────────
// m.bunjang.co.kr manda a Bunjang Global (globalbunjang.com) a quien entra
// desde fuera de Corea, y allí hay menos anuncios y otro formato. Por eso se
// usan directamente las APIs de la web coreana: el buscador ordenado por
// "más recientes" y la ficha de cada anuncio. El envío lo gestiona Nil.
const BUNJANG_API='https://api.bunjang.co.kr';
const BUNJANG_HEADERS={'user-agent':'Mozilla/5.0','accept':'application/json','origin':'https://m.bunjang.co.kr','referer':'https://m.bunjang.co.kr/'};

// Primera página del buscador coreano (unos 60 anuncios, los más recientes).
async function bunjangKoreaSearch(q){
  const params=new URLSearchParams({q,sort:'latest'});
  const r=await fetch(`${BUNJANG_API}/api/search/v8/pw/product/specs/keyword?${params}`,{headers:BUNJANG_HEADERS,signal:AbortSignal.timeout(20000)});
  if(!r.ok)throw new Error(`buscador de Bunjang HTTP ${r.status}`);
  const j=await r.json();
  const grid=(j?.data?.searchSpec?.uiBlockList||[]).find(b=>b?.id==='mainGrid'||b?.blockType==='productList.grid.main')?.searchResponse;
  // Fuera los anuncios patrocinados de otras webs (EXT_AD) y los de pago.
  return {items:(grid?.data||[]).filter(x=>x?.type==='PRODUCT'&&x?.pid&&x?.ad!==true),total:Number(grid?.totalCount)||null};
}

// Ficha de la web coreana: descripción, fotos, 번개케어 y la nota, reseñas y
// ventas de la tienda. No se guarda el nombre del vendedor.
async function fetchBunjangDetail(id){
  try{
    const r=await fetch(`${BUNJANG_API}/api/pms/v3/products-detail/${encodeURIComponent(id)}?viewerUid=-1`,{headers:BUNJANG_HEADERS,signal:AbortSignal.timeout(15000)});
    if(!r.ok)return null;
    const d=(await r.json())?.data||{};
    const p=d.product||{}, sh=d.shop||{};
    const tpl=String(p.imageUrl||'');
    const count=Math.min(10,Math.max(1,Number(p.imageCount)||1));
    const images=tpl?Array.from({length:count},(_,i)=>tpl.replace('{cnt}',String(i+1)).replace('{res}','900')):[];
    const num=v=>Number.isFinite(Number(v))?Number(v):null;
    return {
      name:String(p.name||''),
      price:num(p.price),
      description:String(p.description||'').slice(0,4000),
      images,
      saleStatus:p.saleStatus||null,
      condition:p.condition||null,
      updatedAt:p.updatedAt||null,
      trust:{
        care:p.care===true,
        inspectionStatus:p.inspectionStatus||null,
        rating:num(sh.reviewRating),
        reviewCount:num(sh.reviewCount),
        salesCount:num(sh.salesCount),
        proshop:sh.proshop?.isProshop===true,
        checkedAt:new Date().toISOString()
      }
    };
  }catch{return null;}
}
async function fetchBunjangTrust(id){
  const d=await fetchBunjangDetail(id);
  return d?{...d.trust,description:d.description}:null;
}

async function searchBunjangLive({ queries, maxItems=60, minEur=null, maxEur=null, sessionId }) {
  const maxQueries = clampInt(process.env.BUNJANG_MAX_QUERIES || 2, 2, 1, 5);
  const selectedQueries = (queries || []).slice(0, maxQueries);
  const unique = new Map();
  const perQuery = [];
  for (const q0 of selectedQueries) {
    const q = String(q0).trim(); if (!q) continue;
    try{
      const res=await bunjangKoreaSearch(q);
      const found=res.items.slice(0,Math.max(1,Number(maxItems)||60));
      for(const it of found)if(!unique.has(String(it.pid)))unique.set(String(it.pid),{it,q});
      perQuery.push({ query:q, count:found.length, total:res.total });
    }catch(e){
      perQuery.push({ query:q, count:0, error:e.message });
    }
    await sleep(700);
  }
  let kept=0, detailed=0;
  for (const [pid,{it,q}] of unique) {
    const p = Number(it.price);
    const pe = toEur(p, 'KRW');
    if (!Number.isFinite(p) || p<=0) continue;
    if (Number.isFinite(Number(minEur)) && pe != null && pe < Number(minEur)) continue;
    if (Number.isFinite(Number(maxEur)) && pe != null && pe > Number(maxEur)) continue;

    // La ficha (descripción, fotos, Care y valoraciones) se reutiliza 3 días.
    let prev=null, prevRaw={};
    try{
      prev=db.prepare("SELECT description,raw_json FROM listings WHERE source='bunjang' AND source_id=?").get(pid);
      prevRaw=prev?JSON.parse(prev.raw_json||'{}'):{};
    }catch{}
    let detail=null;
    const cached=prevRaw?.koreaDetail, pt=prevRaw?.luxuryHunterTrust;
    if(cached&&pt?.checkedAt&&Date.now()-Date.parse(pt.checkedAt)<3*86400e3){
      detail={...cached,description:prev?.description||'',trust:pt};
    }else{
      detail=await fetchBunjangDetail(pid);
      detailed++;
      await sleep(250);
    }

    // Antigüedad que muestra Bunjang ("hace 3 horas"): la del anuncio o su
    // última subida al principio de la lista.
    const updatedAt=it.updatedAt||detail?.updatedAt||null;
    const updatedMs=Date.parse(updatedAt||'');
    const ageMs=Date.now()-updatedMs;
    const status=Number.isFinite(updatedMs)?(ageMs>=-10*60e3&&ageMs<24*3600e3?'FRESH':'STALE'):'UNKNOWN';
    const images=detail?.images?.length?detail.images:[String(it.productImage||'').replace('{res}','900')].filter(Boolean);
    const trust=detail?.trust||(it.care===true?{care:true,checkedAt:new Date().toISOString()}:null);

    upsertListing({
      source:'bunjang', source_id:pid, url:`https://m.bunjang.co.kr/products/${pid}`,
      title:it.name||detail?.name||'', description:detail?.description||'',
      original_price:p, currency:'KRW', price_eur:pe, seller_name:null,
      seller_items:null, seller_sales:trust?.salesCount??null, seller_reviews:trust?.reviewCount??null,
      image_url:images[0]||'', status:String(it.status||detail?.saleStatus||'').toUpperCase()==='SELLING'?'':String(it.status||detail?.saleStatus||'').toLowerCase(),
      purchase_via:'Korea proxy',
      raw:{
        pid, name:it.name||null, price:p, care:it.care===true, favoriteCount:it.favoriteCount??null,
        images,
        koreaDetail:detail?{name:detail.name,images:detail.images,saleStatus:detail.saleStatus,condition:detail.condition,updatedAt:detail.updatedAt}:null,
        luxuryHunterTrust:trust,
        publishedAt:Number.isFinite(updatedMs)?new Date(updatedMs).toISOString():null,
        luxuryHunterPublication:{
          marketplace:'bunjang',
          ageText:it.updatedBefore||null,
          source:'korea_search_api',
          sourceValue:updatedAt,
          status,
          checkedAt:new Date().toISOString()
        }
      }
    }, sessionId, q);
    kept++;
  }
  db.prepare('INSERT INTO runs(source,kind,summary,created_at) VALUES(?,?,?,?)').run('bunjang','live-search',`Web coreana · consultas ${perQuery.length}; anuncios ${unique.size}; fichas ${detailed}; kept ${kept}`,new Date().toISOString());
  const failed=perQuery.length&&perQuery.every(x=>x.error);
  return { ok:!failed, mode:'korea', perQuery, uniqueIds:unique.size, detailed, kept, ...(failed?{error:perQuery[0].error}:{}) };
}

async function xianyuFetch(pathname, options={}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 30000);
  try {
    const r = await fetch(`${XIANYU_BASE_URL}${pathname}`, { ...options, signal:controller.signal, headers:{ ...(options.headers||{}) } });
    let body = null;
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('application/json')) body = await r.json(); else body = await r.text();
    if (!r.ok) throw new Error(typeof body === 'object' ? (body.detail || body.error || `HTTP ${r.status}`) : `HTTP ${r.status}: ${String(body).slice(0,200)}`);
    return body;
  } finally { clearTimeout(timeout); }
}
function xianyuResultFilename(keyword) { return `${String(keyword || '').replaceAll(' ', '_')}_full_data.jsonl`; }
function xianyuImage(raw) {
  const info = raw?.['商品信息'] || {};
  const direct = info['商品主图'] || info['主图'] || info['商品图片'] || info['图片'];
  const list = info['商品图片列表'] || info['图片列表'];
  const v = direct || list || deepPick(raw, ['image_url','main_image','pic_url','image','cover','imageUrl','product_image_urls','images','商品主图','主图','商品图片','商品图片列表','图片列表']);
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : (v[0]?.url || v[0]?.src || '');
  if (v && typeof v === 'object') return v.url || v.src || '';
  return typeof v === 'string' ? v : '';
}
// ── RAKUTEN ICHIBA (API oficial) ────────────────────────────────────────
// Muchas tiendas japonesas de lujo de segunda mano (Brand Off, Komehyo,
// Daikokuya, 2nd Street, Kindal...) venden también en Rakuten Ichiba.
// Requiere RAKUTEN_APP_ID y RAKUTEN_ACCESS_KEY (webservice.rakuten.co.jp).
const RAKUTEN_ENDPOINT='https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701';

function rakutenConfigured(){
  return !!(process.env.RAKUTEN_APP_ID&&process.env.RAKUTEN_ACCESS_KEY);
}

// Turno global: varias tareas en paralelo no deben superar 1 petición/s.
let rakutenNextSlot=0;
async function rakutenThrottle(){
  const now=Date.now();
  const wait=Math.max(0,rakutenNextSlot-now);
  rakutenNextSlot=Math.max(now,rakutenNextSlot)+1200;
  if(wait)await sleep(wait);
}

function rakutenFullImage(url){
  // Las miniaturas llevan ?_ex=128x128; sin el parámetro es la imagen original.
  return String(url||'').replace(/\?_ex=\d+x\d+$/,'');
}

// Exclusiones en la propia búsqueda: así las 30 plazas por página son para
// bolsos y no para carteras o calzado de la misma línea. "ウォレット" no va
// aquí porque excluiría los "chain wallet" (bolso pequeño).
const RAKUTEN_NG_KEYWORDS='財布 コインケース カードケース 名刺入れ 小銭入れ キーケース キーホルダー 腕時計 靴 シューズ ローファー パンプス サンダル スニーカー ネックレス ピアス イヤリング ブレスレット 指輪 スカーフ 保存袋 ストラップのみ チャーム'; // la API admite menos de 128 caracteres
const RAKUTEN_NG_KEYWORDS_LEGACY='保存袋 ストラップのみ チャーム';

async function rakutenFetchPage(params){
  // La API nueva valida el Origin contra los "Allowed websites" de la app
  // (el Referer solo no basta) y admite ~1 petición por segundo.
  const site=process.env.RAKUTEN_ORIGIN||'https://nmuxart-star.github.io';
  let body={},ok=false,status=0;
  try{
    await rakutenThrottle();
    const r=await fetch(`${RAKUTEN_ENDPOINT}?${params}`,{
      headers:{origin:site,referer:`${site}/`},
      signal:AbortSignal.timeout(20000)
    });
    status=r.status;
    body=await r.json().catch(()=>({}));
    ok=r.ok;
  }catch(e){
    body={error:e.message};
  }
  return {ok,status,body};
}

async function searchRakutenLive({queries,minEur=null,maxEur=null,sessionId}){
  if(!rakutenConfigured())return {ok:false,state:'not_configured',error:'Faltan RAKUTEN_APP_ID / RAKUTEN_ACCESS_KEY'};
  const maxQueries=clampInt(process.env.RAKUTEN_MAX_QUERIES||3,3,1,5);
  const maxPages=clampInt(process.env.RAKUTEN_PAGES||2,2,1,5);
  const perQuery=[];
  let kept=0;
  let ngKeywords=RAKUTEN_NG_KEYWORDS;
  for(const q0 of (queries||[]).slice(0,maxQueries)){
    const q=String(q0||'').trim();
    if(!q)continue;
    let count=0,total=null,error=null;
    for(let page=1;page<=maxPages;page++){
      const params=new URLSearchParams({
        applicationId:process.env.RAKUTEN_APP_ID,
        accessKey:process.env.RAKUTEN_ACCESS_KEY,
        keyword:q,
        sort:'-updateTimestamp',
        hits:'30',
        page:String(page),
        availability:'1',
        formatVersion:'2',
        format:'json',
        NGKeyword:ngKeywords
      });
      const minJpy=Number.isFinite(Number(minEur))?Math.floor(eurTo(Number(minEur),'JPY')||0):0;
      const maxJpy=Number.isFinite(Number(maxEur))?Math.ceil(eurTo(Number(maxEur),'JPY')||0):0;
      if(minJpy>0)params.set('minPrice',String(minJpy));
      if(maxJpy>minJpy)params.set('maxPrice',String(maxJpy));
      let {ok,status,body}=await rakutenFetchPage(params);
      // Si la API no acepta la lista larga de exclusiones, se vuelve a la
      // corta de siempre (el pre-filtro por título descarta el resto gratis).
      if(!ok&&status===400&&ngKeywords!==RAKUTEN_NG_KEYWORDS_LEGACY){
        console.warn(`Rakuten: exclusiones rechazadas (${body?.error_description||body?.error||status}); uso la lista corta.`);
        ngKeywords=RAKUTEN_NG_KEYWORDS_LEGACY;
        params.set('NGKeyword',ngKeywords);
        ({ok,status,body}=await rakutenFetchPage(params));
      }
      if(!ok){
        error=body?.error_description||body?.error||`HTTP ${status}`;
        break;
      }
      total=body?.count??total;
      const items=Array.isArray(body?.Items)?body.Items:[];
      for(const raw of items){
        const it=raw?.Item||raw;
        const price=Number(it.itemPrice);
        const pe=toEur(price,'JPY');
        if(!Number.isFinite(price)||pe==null)continue;
        if(Number.isFinite(Number(minEur))&&pe<Number(minEur))continue;
        if(Number.isFinite(Number(maxEur))&&pe>Number(maxEur))continue;
        const images=(it.mediumImageUrls||[]).map(x=>rakutenFullImage(typeof x==='string'?x:x?.imageUrl)).filter(Boolean);
        upsertListing({
          source:'rakuten-jp',
          source_id:it.itemCode,
          url:it.itemUrl,
          title:it.itemName,
          description:String(it.itemCaption||'').slice(0,4000),
          original_price:price,
          currency:'JPY',
          price_eur:pe,
          seller_name:it.shopName||'',
          image_url:images[0]||'',
          status:'available',
          purchase_via:'Rakuten (proxy/forwarder)',
          // Sin las miniaturas originales: si no, se analizarían fotos duplicadas.
          raw:{...it,mediumImageUrls:undefined,smallImageUrls:undefined,images,luxuryHunterSource:'rakuten-api'}
        },sessionId,q);
        count++;
        kept++;
      }
      const pageCount=Number(body?.pageCount||0);
      if(items.length<30||(pageCount&&page>=pageCount))break;
    }
    perQuery.push(error&&!count?{query:q,count:0,error}:{query:q,count,total,...(error?{error}:{})});
  }
  db.prepare('INSERT INTO runs(source,kind,summary,created_at) VALUES(?,?,?,?)').run('rakuten','live-search',`Queries ${perQuery.length}; kept ${kept}`,new Date().toISOString());
  const failed=perQuery.length>0&&perQuery.every(x=>x.error);
  return failed
    ? {ok:false,state:'error',error:perQuery[0].error,perQuery}
    : {ok:true,perQuery,kept};
}

// ── EBAY (Browse API oficial) ───────────────────────────────────────────
// Requiere EBAY_CLIENT_ID y EBAY_CLIENT_SECRET (developer.ebay.com).
// EBAY_MARKETPLACES: marketplaces a consultar (por defecto UE + UK + US).
const EU_COUNTRIES=new Set(['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE']);
const EBAY_MARKETPLACE_CURRENCY={
  EBAY_DE:'EUR',EBAY_FR:'EUR',EBAY_IT:'EUR',EBAY_ES:'EUR',EBAY_NL:'EUR',EBAY_BE:'EUR',EBAY_AT:'EUR',EBAY_IE:'EUR',
  EBAY_GB:'GBP',EBAY_US:'USD'
};
let ebayToken=null;

function ebayConfigured(){
  return !!(process.env.EBAY_CLIENT_ID&&process.env.EBAY_CLIENT_SECRET);
}

async function getEbayToken(){
  if(ebayToken&&ebayToken.expiresAt>Date.now()+60000)return ebayToken.value;
  const basic=Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64');
  const r=await fetch('https://api.ebay.com/identity/v1/oauth2/token',{
    method:'POST',
    headers:{'content-type':'application/x-www-form-urlencoded',authorization:`Basic ${basic}`},
    body:new URLSearchParams({grant_type:'client_credentials',scope:'https://api.ebay.com/oauth/api_scope'}),
    signal:AbortSignal.timeout(20000)
  });
  const body=await r.json().catch(()=>({}));
  if(!r.ok||!body.access_token)throw new Error(`eBay token: ${body.error_description||body.error||r.status}`);
  ebayToken={value:body.access_token,expiresAt:Date.now()+Number(body.expires_in||7200)*1000};
  return ebayToken.value;
}

function ebayLargeImage(url){
  return String(url||'').replace(/s-l\d+\.(jpg|jpeg|png|webp)/i,'s-l1600.$1');
}

const AUCTION_MAX_HOURS=Math.max(1,Number(process.env.AUCTION_MAX_HOURS||72));
// SUBASTAS QUE SE ENSEÑAN (regla de Nil, 07-11-2026): como mucho
// AUCTION_SHOW_HOURS (2 h) para terminar y AUCTION_MIN_BIDS (1) puja o más.
const AUCTION_SHOW_HOURS=Math.max(0.5,Number(process.env.AUCTION_SHOW_HOURS||2));
const AUCTION_MIN_BIDS=Math.max(0,Number(process.env.AUCTION_MIN_BIDS??1));
function auctionInWindow(x){
  const a=listingAuction(x);
  if(!a?.live)return false;
  return a.endMs-Date.now()<=AUCTION_SHOW_HOURS*3600e3&&(Number(a.bids)||0)>=AUCTION_MIN_BIDS;
}
// Datos de subasta de un anuncio (de su raw_json), con live=true si aún no ha terminado.
// ── SUBASTAS: PUJA MÁXIMA ───────────────────────────────────────────────
// La puja máxima es el precio más alto que aún deja AUCTION_MIN_PROFIT_EUR
// (300 € por defecto) limpios vendiendo a la reventa conservadora (la de los
// anuncios parecidos de la base de Nil si los hay): con todos los costes de
// importación, la comisión de la plataforma y el IVA del margen (REBU), como
// en la hoja de oportunidades.
const AUCTION_MIN_PROFIT_EUR=Math.max(0,Number(process.env.AUCTION_MIN_PROFIT_EUR??300));
function auctionNetProfit(item,priceEur,resaleEur,taskName){
  const landed=Number(importEconomics({...item,price_eur:priceEur}).importedTotalEur);
  const fee=resalePlatform(taskName).fee/100;
  return {landed,net:resaleEur-landed-resaleEur*fee-Math.max(0,resaleEur-landed)*21/121};
}
function auctionMaxBidEur(item,resaleEur,taskName){
  if(!(resaleEur>0)||auctionNetProfit(item,0,resaleEur,taskName).net<AUCTION_MIN_PROFIT_EUR)return null;
  let lo=0,hi=resaleEur;
  for(let i=0;i<40;i++){const mid=(lo+hi)/2;if(auctionNetProfit(item,mid,resaleEur,taskName).net>=AUCTION_MIN_PROFIT_EUR)lo=mid;else hi=mid;}
  return lo;
}
// Puja máxima en la moneda de la subasta, redondeada hacia abajo.
function auctionLocalBid(eur,currency){
  const v=eurTo(eur,currency);
  if(!Number.isFinite(v))return null;
  const step=currency==='JPY'?1000:currency==='KRW'?10000:5;
  return Math.floor(v/step)*step;
}
function listingAuction(row){
  let raw=row?.raw;
  if(!raw){try{raw=JSON.parse(row?.raw_json||'{}');}catch{raw={};}}
  const a=raw?.auction;
  if(!a?.endsAt)return null;
  const end=Date.parse(a.endsAt);
  return {...a,endMs:end,live:Number.isFinite(end)&&end>Date.now()};
}
// Guarda un anuncio de la búsqueda de eBay. En las subastas el precio es la
// puja actual (no el precio final) y se guardan el fin y el número de pujas.
function ebayUpsertItem(it,mp,currency,sessionId,product){
  const auction=(it?.buyingOptions||[]).includes('AUCTION')&&!!it?.itemEndDate;
  const money=auction&&it?.currentBidPrice?.value!=null?it.currentBidPrice:(it?.price||it?.currentBidPrice||{});
  const cur=money.currency||currency;
  const price=Number(money.value);
  const pe=toEur(price,cur);
  if(!Number.isFinite(price)||pe==null)return false;
  const country=String(it?.itemLocation?.country||'').toUpperCase();
  // Lo que decide la aduana es desde dónde se envía, no el marketplace.
  const source=`ebay-${(country||mp.slice(5)).toLowerCase()}`;
  const images=[it?.image?.imageUrl,...(it?.additionalImages||[]).map(x=>x?.imageUrl)].filter(Boolean).map(ebayLargeImage);
  upsertListing({
    source,
    source_id:it.itemId,
    url:it.itemWebUrl,
    title:it.title,
    description:[it.condition,it.shortDescription].filter(Boolean).join(' · '),
    original_price:price,
    currency:cur,
    price_eur:pe,
    // Sin nombre de usuario del vendedor: no guardamos datos personales
    // de usuarios de eBay (exención de Marketplace Account Deletion).
    seller_name:'',
    seller_sales:it?.seller?.feedbackScore??null,
    seller_reviews:it?.seller?.feedbackPercentage!=null?Number(it.seller.feedbackPercentage):null,
    image_url:images[0]||'',
    status:(it.buyingOptions||[]).join('+'),
    purchase_via:EU_COUNTRIES.has(country)?'eBay (UE, sin aduana)':`eBay (${country||mp})`,
    raw:{
      ...it,
      image:undefined,
      additionalImages:undefined,
      seller:it?.seller?{feedbackScore:it.seller.feedbackScore,feedbackPercentage:it.seller.feedbackPercentage,sellerAccountType:it.seller.sellerAccountType}:undefined,
      thumbnailImages:undefined,
      images,
      publishedAt:it.itemCreationDate||null,
      marketplace:mp,
      authenticityGuarantee:(it.qualifiedPrograms||[]).includes('AUTHENTICITY_GUARANTEE'),
      auction:auction?{endsAt:it.itemEndDate,bids:Number(it.bidCount)||0,currentBid:price,currency:cur}:undefined
    }
  },sessionId,product);
  return true;
}
async function searchEbayLive({product,minEur=null,maxEur=null,sessionId}){
  if(!ebayConfigured())return {ok:false,state:'not_configured',error:'Faltan EBAY_CLIENT_ID / EBAY_CLIENT_SECRET'};
  const marketplaces=String(process.env.EBAY_MARKETPLACES||'EBAY_DE,EBAY_FR,EBAY_IT,EBAY_ES,EBAY_GB,EBAY_US')
    .split(',').map(s=>s.trim().toUpperCase()).filter(m=>EBAY_MARKETPLACE_CURRENCY[m]);
  const token=await getEbayToken();
  const perMarketplace=[];
  let kept=0;
  for(const mp of marketplaces){
    const currency=EBAY_MARKETPLACE_CURRENCY[mp];
    // 2990/3000/3010 = segunda mano (excelente / bueno / aceptable).
    const filters=['conditionIds:{2990|3000|3010}'];
    const lo=Number.isFinite(Number(minEur))?Math.floor(eurTo(Number(minEur),currency)||0):null;
    const hi=Number.isFinite(Number(maxEur))?Math.ceil(eurTo(Number(maxEur),currency)||0):null;
    if(lo!=null||hi!=null)filters.push(`price:[${lo??''}..${hi??''}]`,`priceCurrency:${currency}`);
    const params=new URLSearchParams({
      q:String(product||'').slice(0,100),
      sort:'newlyListed',
      limit:'40',
      filter:filters.join(',')
    });
    let body={};
    let ok=false;
    let status=0;
    try{
      const r=await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`,{
        headers:{authorization:`Bearer ${token}`,'X-EBAY-C-MARKETPLACE-ID':mp},
        signal:AbortSignal.timeout(25000)
      });
      status=r.status;
      body=await r.json().catch(()=>({}));
      ok=r.ok;
    }catch(e){
      body={errors:[{message:e.message}]};
    }
    if(!ok){
      perMarketplace.push({marketplace:mp,count:0,error:body?.errors?.[0]?.message||`HTTP ${status}`});
      continue;
    }
    let count=0;
    for(const it of body.itemSummaries||[]){
      if(ebayUpsertItem(it,mp,currency,sessionId,product))count++;
    }
    kept+=count;
    perMarketplace.push({marketplace:mp,count,total:body.total??null});
    await sleep(400);
  }
  // Subastas: la búsqueda normal de eBay solo devuelve anuncios con "Cómpralo
  // ya". Aparte se piden las subastas de vendedores de los países de
  // EBAY_AUCTION_LOCATIONS (por defecto Japón) que terminan en los próximos
  // días; el bot calcula después la puja máxima con la base de Vestiaire.
  const auctionLocations=String(process.env.EBAY_AUCTION_LOCATIONS??'JP').split(',').map(s=>s.trim().toUpperCase()).filter(c=>/^[A-Z]{2}$/.test(c));
  for(const cc of auctionLocations){
    const params=new URLSearchParams({
      q:String(product||'').slice(0,100),
      sort:'endingSoonest',
      limit:'40',
      filter:`buyingOptions:{AUCTION},conditionIds:{2990|3000|3010},itemLocationCountry:${cc}`
    });
    try{
      const r=await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`,{
        headers:{authorization:`Bearer ${token}`,'X-EBAY-C-MARKETPLACE-ID':'EBAY_US'},
        signal:AbortSignal.timeout(25000)
      });
      const body=await r.json().catch(()=>({}));
      if(!r.ok){perMarketplace.push({marketplace:`AUCTION_${cc}`,count:0,error:body?.errors?.[0]?.message||`HTTP ${r.status}`});continue;}
      const maxMs=Date.now()+AUCTION_MAX_HOURS*3600e3;
      let count=0;
      for(const it of body.itemSummaries||[]){
        const end=Date.parse(it?.itemEndDate||'');
        // Solo las que acaban dentro del horizonte y con margen para pujar.
        if(!Number.isFinite(end)||end>maxMs||end<Date.now()+30*60e3)continue;
        if(ebayUpsertItem(it,'EBAY_US','USD',sessionId,product))count++;
      }
      kept+=count;
      console.log(`eBay subastas ${cc}: ${count} terminan en las próximas ${AUCTION_MAX_HOURS} h (de ${body.total??0}).`);
      perMarketplace.push({marketplace:`AUCTION_${cc}`,count,total:body.total??null});
    }catch(e){
      perMarketplace.push({marketplace:`AUCTION_${cc}`,count:0,error:e.message});
    }
    await sleep(400);
  }
  db.prepare('INSERT INTO runs(source,kind,summary,created_at) VALUES(?,?,?,?)').run('ebay','live-search',`Marketplaces ${perMarketplace.length}; kept ${kept}`,new Date().toISOString());
  const failed=perMarketplace.length>0&&perMarketplace.every(x=>x.error);
  return failed
    ? {ok:false,state:'error',error:perMarketplace[0].error,perMarketplace}
    : {ok:true,perMarketplace,kept};
}

// ── XIANYU DIRECT V1 ────────────────────────────────────────────────────
// Lee solo la página de resultados de búsqueda (como un usuario que busca),
// sin abrir la ficha de cada anuncio. Abrir 30 fichas seguidas desde un
// servidor es lo que hacía saltar la verificación anti-bot de Xianyu
// (FAIL_SYS_USER_VALIDATE). Si aun así Xianyu pide verificación, se pausa
// Xianyu el resto de la ejecución: nunca se intenta resolver ni esquivar.
const XIANYU_SEARCH_API='h5api.m.goofish.com/h5/mtop.taobao.idlemtopsearch.pc.search/'; // con '/' final: excluye .shade y .activate
const XIANYU_RISK_RE=/FAIL_SYS_USER_VALIDATE|RGV587|FAIL_SYS_ILLEGAL_ACCESS|punish|baxia|_____tmd_____/i;
const XIANYU_AUTH_RE=/FAIL_SYS_SESSION_EXPIRED|SESSION_EXPIRED|FAIL_SYS_TOKEN_EMPTY|未登录/i;
let xianyuDirectPromise=null;
let xianyuContextFile=null;
let xianyuContextMtime=null;
let xianyuActiveAccount=null;
let xianyuPauseCode=null;
const xianyuFailedAccounts=new Map();
let xianyuPausedReason=null;
let xianyuPausedAt=0;
// En un servidor que no se reinicia (Mac), la pausa caduca sola.
const XIANYU_PAUSE_MS=2*3600e3;
// Tras una verificación anti-bot no se reintenta hasta pasadas 4 h: insistir
// en cada ejecución es lo que mantiene la cuenta marcada.
const XIANYU_RISK_PAUSE_MS=4*3600e3;
let xianyuPauseLen=XIANYU_PAUSE_MS;

function xianyuKnownAccounts(){
  const primary=String(process.env.XIANYU_STATE_FILE||'').trim();
  const dir=String(process.env.XIANYU_STATE_DIR||'').trim()||
    (primary?path.dirname(primary):path.join(process.env.HOME||'', 'ai-goofish-monitor-wangdaguo','state'));
  return xianyuAccountFiles({primaryFile:primary,accountDir:dir});
}
function xianyuDirectMode(){
  // Por defecto: búsqueda directa. La sesión es opcional (la búsqueda de
  // Goofish es pública); XIANYU_MODE=connector vuelve al conector Docker.
  return String(process.env.XIANYU_MODE||'direct').toLowerCase()!=='connector';
}
function xianyuProvider(){
  // alternate: una búsqueda con Just One API y la siguiente con la cuenta de
  // Nil (modo directo), y así sucesivamente.
  const p=String(process.env.XIANYU_PROVIDER||'justoneapi').trim().toLowerCase();
  return p==='direct'||p==='alternate'?p:'justoneapi';
}

async function getXianyuDirect(file=xianyuActiveAccount){
  const mtime=file?fs.statSync(file).mtimeMs:null;
  if(xianyuDirectPromise&&(xianyuContextFile!==file||xianyuContextMtime!==mtime)){
    const previous=await xianyuDirectPromise.catch(()=>null);
    await previous?.context.close().catch(()=>{});
    xianyuDirectPromise=null;
  }
  xianyuContextFile=file;
  xianyuContextMtime=mtime;
  if(!xianyuDirectPromise){
    xianyuDirectPromise=(async()=>{
      let state={};
      try{state=file?JSON.parse(fs.readFileSync(file,'utf8')):{};}catch{state={};}
      const browser=await getBunjangPublicationBrowser();
      // Mismo navegador que el del login (user-agent, idioma, pantalla) para
      // que la sesión sea coherente con la que creó Nil.
      const h=state?.headers||{};
      const nav=state?.env?.navigator||{};
      const scr=state?.env?.screen||{};
      const lang=String(h['Accept-Language']||h['accept-language']||nav.language||'zh-CN').split(',')[0].trim();
      const context=await browser.newContext({
        storageState:{cookies:state.cookies||[],origins:state.origins||[]},
        userAgent:h['User-Agent']||h['user-agent']||nav.userAgent||undefined,
        locale:lang||'zh-CN',
        timezoneId:state?.env?.intl?.timeZone||'Asia/Shanghai',
        viewport:{width:Math.min(Number(scr.width)||1440,1600),height:Math.min(Number(scr.height)||900,1000)},
        deviceScaleFactor:Number(scr.devicePixelRatio)||1
      });
      return {context,warmed:false};
    })().catch(e=>{xianyuDirectPromise=null;xianyuContextFile=null;xianyuContextMtime=null;throw e;});
  }
  return xianyuDirectPromise;
}

function xianyuRiskIn(json){
  return XIANYU_RISK_RE.test(JSON.stringify(json?.ret||''));
}
function xianyuAuthIn(json){
  return XIANYU_AUTH_RE.test(JSON.stringify(json?.ret||''));
}

function parseXianyuSearchJson(json){
  const out=[];
  for(const item of json?.data?.resultList||[]){
    const main=item?.data?.item?.main||{};
    const ex=main.exContent||{};
    const click=main.clickParam?.args||{};
    const priceText=Array.isArray(ex.price)
      ? ex.price.map(p=>String(p?.text??'')).join('').replace('当前价','').trim()
      : '';
    let price=parseMoney(priceText);
    if(/万/.test(priceText)){
      const n=Number(priceText.replace(/[^\d.]/g,''));
      if(Number.isFinite(n))price=Math.round(n*10000);
    }
    const id=String(ex.itemId||click.item_id||click.id||'').trim();
    const link=String(main.targetUrl||'').replace('fleamarket://','https://www.goofish.com/');
    const pub=Number(click.publishTime);
    const tags=extractXianyuTags(ex);
    if(click.tag==='freeship'&&!tags.includes('包邮'))tags.push('包邮');
    out.push({
      tags,
      // Mismo formato que el conector: hora de China "YYYY-MM-DD HH:mm".
      publishedLocal:Number.isFinite(pub)&&pub>0?new Date(pub+8*3600e3).toISOString().slice(0,16).replace('T',' '):null,
      id,
      title:String(ex.title||'').trim(),
      price,
      url:link||(id?`https://www.goofish.com/item?id=${id}`:''),
      image:ex.picUrl?String(ex.picUrl).replace(/^\/\//,'https://'):'',
      area:ex.area||'',
      seller:ex.userNickName||'',
      wants:click.wantNum??null,
      publishedAt:Number.isFinite(pub)&&pub>0?new Date(pub).toISOString():null
    });
  }
  return out;
}

async function xianyuDirectSearchOnce(keyword,{minCny=null,maxCny=null,stateFile=null}={}){
  const x=await getXianyuDirect(stateFile);
  const page=await x.context.newPage();
  try{
    if(!x.warmed){
      await page.goto('https://www.goofish.com/',{waitUntil:'domcontentloaded',timeout:40000});
      await sleep(1500+Math.random()*1500);
      x.warmed=true;
    }
    const first=page.waitForResponse(r=>r.url().includes(XIANYU_SEARCH_API)&&r.request().method()==='POST',{timeout:40000});
    await page.goto(`https://www.goofish.com/search?q=${encodeURIComponent(keyword)}`,{waitUntil:'domcontentloaded',timeout:40000});
    let resp;
    try{
      resp=await first;
    }catch{
      const where=`${page.url()} · "${(await page.title().catch(()=>''))||''}"`;
      if(XIANYU_RISK_RE.test(page.url()))return {risk:true};
      if(/login|passport/i.test(page.url()))return {login:true,where};
      return {noResponse:true,where};
    }
    let json=await resp.json().catch(()=>null);
    if(xianyuAuthIn(json))return {login:true,where:'sesión caducada'};
    if(XIANYU_RISK_RE.test(page.url())||xianyuRiskIn(json))return {risk:true};
    // Ordenar por "más nuevos" para enterarse antes. Si la web cambia y no
    // se puede, se usan los resultados por relevancia.
    let sorted=false;
    if(String(process.env.XIANYU_SORT_NEWEST||'1')!=='0'){
      try{
        await sleep(1000+Math.random()*1000);
        // Sin sesión Goofish muestra la ventana "iniciar sesión" encima;
        // se cierra como haría cualquier visitante.
        for(let i=0;i<3&&await page.locator('[class*="login-modal-wrap"]').first().isVisible().catch(()=>false);i++){
          const close=page.locator('[class*="login-modal-wrap"] [class*="close"], [class*="login-modal-wrap"] .ant-modal-close').first();
          if(await close.count())await close.click({timeout:3000}).catch(()=>{});
          else await page.keyboard.press('Escape');
          await sleep(600);
        }
        await page.getByText('新发布',{exact:true}).first().click({timeout:6000});
        await sleep(800+Math.random()*700);
        const next=page.waitForResponse(r=>r.url().includes(XIANYU_SEARCH_API)&&r.request().method()==='POST',{timeout:15000});
        await page.getByText('最新',{exact:true}).first().click({timeout:6000});
        const j2=await (await next).json().catch(()=>null);
        if(xianyuAuthIn(j2))return {login:true,where:'sesión caducada'};
        if(xianyuRiskIn(j2))return {risk:true};
        if(j2?.data?.resultList?.length){json=j2;sorted=true;}
      }catch{}
    }
    // Rango de precio de la tarea en la propia web (como un usuario): así los
    // 30 resultados son del rango útil y no baratijas o artículos de lujo fuera de presupuesto.
    let priced=false;
    if((minCny||maxCny)&&String(process.env.XIANYU_PRICE_FILTER||'1')!=='0'){
      try{
        const box=page.locator('div[class*="search-price-input-container"]').first();
        if(await box.isVisible({timeout:3000}).catch(()=>false)){
          const inputs=box.getByPlaceholder('¥');
          if(minCny){await inputs.nth(0).fill(String(minCny));await sleep(700+Math.random()*800);}
          if(maxCny){await inputs.nth(1).fill(String(maxCny));await sleep(700+Math.random()*800);}
          const next=page.waitForResponse(r=>r.url().includes(XIANYU_SEARCH_API)&&r.request().method()==='POST',{timeout:15000});
          await page.keyboard.press('Tab');
          const j3=await (await next).json().catch(()=>null);
          if(xianyuAuthIn(j3))return {login:true,where:'sesión caducada'};
          if(xianyuRiskIn(j3))return {risk:true};
          if(j3?.data?.resultList){json=j3;priced=true;}
        }
      }catch{}
    }
    return {risk:false,sorted,priced,items:parseXianyuSearchJson(json),ret:json?.ret||null};
  }finally{
    await page.close().catch(()=>{});
  }
}

function xianyuLastSearchAt(){
  const row=db.prepare("SELECT value_json FROM app_settings WHERE key='xianyu_last_search'").get();
  return Number(row?.value_json||0)||0;
}
function xianyuMarkSearch(){
  db.prepare(`INSERT INTO app_settings(key,value_json,updated_at) VALUES('xianyu_last_search',?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`).run(String(Date.now()),new Date().toISOString());
}
function xianyuLastPaidSearchAt(){
  const row=db.prepare("SELECT value_json FROM app_settings WHERE key='xianyu_last_paid_search'").get();
  return Number(row?.value_json||0)||0;
}
function xianyuMarkPaidSearch(){
  db.prepare(`INSERT INTO app_settings(key,value_json,updated_at) VALUES('xianyu_last_paid_search',?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`).run(String(Date.now()),new Date().toISOString());
}
function xianyuLastProvider(){
  const row=db.prepare("SELECT value_json FROM app_settings WHERE key='xianyu_last_provider'").get();
  return row?.value_json==='direct'?'direct':row?.value_json==='justoneapi'?'justoneapi':null;
}
function xianyuMarkProvider(provider){
  db.prepare(`INSERT INTO app_settings(key,value_json,updated_at) VALUES('xianyu_last_provider',?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`).run(provider,new Date().toISOString());
}
// La cuenta de Nil está pidiendo verificación (captcha o de identidad).
function xianyuAccountBlocked(){
  return !!db.prepare("SELECT 1 FROM app_settings WHERE key='xianyu_account_blocked'").get();
}
function xianyuBlockAccount(reason){
  db.prepare(`INSERT INTO app_settings(key,value_json,updated_at) VALUES('xianyu_account_blocked',?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
    .run(JSON.stringify({at:new Date().toISOString(),reason}),new Date().toISOString());
}
function xianyuUnblockAccount(){
  db.prepare("DELETE FROM app_settings WHERE key='xianyu_account_blocked'").run();
}
function reserveXianyuSearch(){
  const key='xianyu_search_usage';
  const row=db.prepare('SELECT value_json FROM app_settings WHERE key=?').get(key);
  const limit=clampInt(process.env.XIANYU_MONTHLY_SEARCH_LIMIT??XIANYU_MONTHLY_SEARCH_LIMIT,
    XIANYU_MONTHLY_SEARCH_LIMIT,0,XIANYU_MONTHLY_SEARCH_LIMIT);
  const dailyLimit=clampInt(process.env.XIANYU_DAILY_SEARCH_LIMIT??XIANYU_DAILY_SEARCH_LIMIT,
    XIANYU_DAILY_SEARCH_LIMIT,0,XIANYU_DAILY_SEARCH_LIMIT);
  const now=new Date();
  const next=nextXianyuSearchUsage(row?.value_json??null,xianyuBudgetMonth(now),limit,xianyuBudgetDay(now),dailyLimit);
  const value=JSON.stringify(next.usage);
  if(row?.value_json!==value){
    db.prepare(`INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
      .run(key,value,new Date().toISOString());
  }
  if(next.allowed)console.log(`Xianyu Just One API: llamada reservada; hoy ${next.usage.dayAttempts}/${next.dailyLimit}, mes ${next.usage.attempts}/${next.limit}.`);
  return next;
}
function xianyuBudgetWarning(budget){
  return budget.reason==='daily_limit'
    ?`Just One API pausado hoy: ${budget.usage.dayAttempts}/${budget.dailyLimit} llamadas usadas el ${budget.usage.day}. La cuenta de Xianyu conserva sus turnos.`
    :`Just One API pausado este mes: ${budget.usage.attempts}/${budget.limit} llamadas usadas en ${budget.usage.month}. La cuenta de Xianyu conserva sus turnos.`;
}

function saveXianyuCandidate(it,{sessionId,sourceQuery,minEur,maxEur}={}){
  if(!it?.id||!it?.title)return {kept:false,reason:'missingCoreFields'};
  if(!hasXianyuVerificationTag(it.tags))return {kept:false,reason:'noVerificationTag'};
  if(!Number.isFinite(Number(it.price))||Number(it.price)<=0)return {kept:false,reason:'invalidPrice'};

  const prev=db.prepare('SELECT description,raw_json,seller_sales,seller_items,seller_reviews,seller_name,image_url FROM listings WHERE source=? AND source_id=?').get('xianyu',it.id);
  let prevRaw={};
  try{prevRaw=prev?JSON.parse(prev.raw_json||'{}'):{};}catch{}
  const oldInfo=prevRaw?.['商品信息']||{};
  const oldSeller=prevRaw?.['卖家信息']||{};

  const searchImages=Array.isArray(it.images)?it.images.filter(Boolean):[];
  if(it.image&&!searchImages.includes(it.image))searchImages.unshift(it.image);
  const hasImage=searchImages.length>0||!!prev?.image_url||!!oldInfo['商品主图链接'];
  if(!hasImage)return {kept:false,reason:'missingImage'};

  const sellerValues=[it.seller,it.sellerId,it.sellerSales,it.sellerItems,it.sellerRegDays,it.sellerCredit,it.sellerReviews,it.sellerReviewCount,it.sellerReviewRate,
    prev?.seller_name,prev?.seller_sales,prev?.seller_items,oldSeller['卖家ID'],oldSeller['芝麻信用'],oldSeller['卖家注册天数']];
  if(!sellerValues.some(value=>value!==null&&value!==undefined&&String(value).trim()!==''))return {kept:false,reason:'missingSellerInfo'};

  const publishValue=it.publishedAt||prevRaw.publishedAt||it.publishedLocal||oldInfo['发布时间'];
  const publishedMs=parseMarketplacePublishedMs(publishValue,'+08:00');
  if(publishedMs===null)return {kept:false,reason:'missingPublicationTime'};
  const maxAgeHours=clampInt(process.env.XIANYU_SEARCH_MAX_AGE_HOURS??24,24,1,720);
  const ageMs=Date.now()-publishedMs;
  if(ageMs>maxAgeHours*3600e3)return {kept:false,reason:'listingTooOld'};
  if(ageMs< -10*60e3)return {kept:false,reason:'futurePublication'};

  const pe=toEur(it.price,'CNY');
  const lo=minEur===null||minEur===undefined||minEur===''?NaN:Number(minEur);
  const hi=maxEur===null||maxEur===undefined||maxEur===''?NaN:Number(maxEur);
  if(Number.isFinite(lo)&&pe!=null&&pe<lo)return {kept:false,reason:'belowMin'};
  if(Number.isFinite(hi)&&hi>0&&pe!=null&&pe>hi)return {kept:false,reason:'aboveMax'};

  // Aprovecha todos los campos que llegaron en la búsqueda y conserva datos
  // completos de registros anteriores sin volver a consultar la ficha.
  const detail=prevRaw?.detailFetched?prevRaw:null;
  const oldImages=Array.isArray(oldInfo['商品图片列表'])?oldInfo['商品图片列表']:
    (oldInfo['商品主图链接']?[oldInfo['商品主图链接']]:[]);
  const images=searchImages.length?searchImages:oldImages;
  const numericOrOld=(value,oldValue)=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value))?Number(value):oldValue??null;
  const publishedAt=new Date(publishedMs).toISOString();
  const publishedLocal=it.publishedLocal||new Date(publishedMs+8*3600e3).toISOString().slice(0,16).replace('T',' ');
  const currentInfo={
    ...(detail?.['商品信息']||{}),
    '商品ID':it.id,
    '商品标题':it.title,
    '当前售价':it.price,
    '商品链接':it.url,
    '商品主图链接':it.image||images[0]||oldInfo['商品主图链接']||'',
    '商品图片列表':images,
    '商品描述':it.description||oldInfo['商品描述']||'',
    '发货地区':it.area,
    '“想要”人数':it.wants,
    '商品标签':it.tags,
    '浏览量':it.browseCount??oldInfo['浏览量']??null,
    '发布时间':publishedLocal
  };
  const sellerInfo={
    ...(detail?.['卖家信息']||oldSeller),
    '卖家昵称':it.seller||prev?.seller_name||oldSeller['卖家昵称']||null,
    '卖家ID':it.sellerId||oldSeller['卖家ID']||null,
    '卖家头像':it.sellerAvatar||oldSeller['卖家头像']||null,
    '卖家注册天数':it.sellerRegDays??oldSeller['卖家注册天数']??null,
    '芝麻信用':it.sellerCredit??oldSeller['芝麻信用']??null,
    '卖家已售':numericOrOld(it.sellerSales,prev?.seller_sales??oldSeller['卖家已售']),
    '卖家在售':numericOrOld(it.sellerItems,prev?.seller_items??oldSeller['卖家在售']),
    '卖家评价数':it.sellerReviewCount??oldSeller['卖家评价数']??null,
    '卖家好评率':it.sellerReviewRate??oldSeller['卖家好评率']??null,
    '卖家评价原始字段':it.sellerReviews??oldSeller['卖家评价原始字段']??null,
    '卖家标签':it.sellerBadges?.length?it.sellerBadges:oldSeller['卖家标签']||[],
    'camposDisponiblesEnBusqueda':{
      name:!!(it.seller||prev?.seller_name),
      id:!!(it.sellerId||oldSeller['卖家ID']),
      avatar:!!it.sellerAvatar,
      accountAgeDays:it.sellerRegDays!==null&&it.sellerRegDays!==undefined,
      credit:it.sellerCredit!==null&&it.sellerCredit!==undefined,
      sales:it.sellerSales!==null&&it.sellerSales!==undefined,
      activeListings:it.sellerItems!==null&&it.sellerItems!==undefined,
      reviewCount:it.sellerReviewCount!==null&&it.sellerReviewCount!==undefined,
      reviewRate:it.sellerReviewRate!==null&&it.sellerReviewRate!==undefined,
      badges:!!it.sellerBadges?.length
    }
  };
  const raw={
    ...(detail||{}),
    '商品信息':currentInfo,
    '卖家信息':sellerInfo,
    publishedAt,
    searchOnly:!detail,
    ...(it.provider?{dataProvider:it.provider}:prevRaw.dataProvider?{dataProvider:prevRaw.dataProvider}:{})
  };
  upsertListing({
    source:'xianyu',source_id:it.id,url:it.url,title:it.title,description:it.description||prev?.description||'',
    original_price:it.price,currency:'CNY',price_eur:pe,seller_name:it.seller||prev?.seller_name||'',
    image_url:it.image||images[0]||oldInfo['商品主图链接']||'',
    seller_sales:detail?prev.seller_sales:numericOrOld(it.sellerSales,prev?.seller_sales),
    seller_items:detail?prev.seller_items:numericOrOld(it.sellerItems,prev?.seller_items),
    seller_reviews:numericOrOld(it.sellerReviewCount,prev?.seller_reviews),
    status:'',purchase_via:'China agent',raw
  },sessionId,sourceQuery);
  return {kept:true};
}

async function searchXianyuJustOneApi({queries,maxItems=30,minEur=null,maxEur=null,sessionId,slotReserved=false,justOnePages=null}){
  const token=String(process.env.JUSTONEAPI_TOKEN||'').trim();
  if(!token){
    const warning='Just One API está seleccionado, pero falta configurar el secreto JUSTONEAPI_TOKEN.';
    await reportHealthIssue('xianyu-search',warning+' Las demás plataformas continúan funcionando.').catch(()=>{});
    return {ok:false,state:'unconfigured',warning,perQuery:[],kept:0};
  }
  // Si se perdió el artefacto de estado de GitHub, no se puede saber cuánto se
  // gastó este mes. Pausar evita reiniciar por accidente el contador a cero.
  if(String(process.env.GITHUB_ACTIONS||'').toLowerCase()==='true'&&process.env.LH_STATE_RESTORED!=='1'){
    const warning='No se pudo recuperar el estado persistente; Xianyu queda pausado para proteger el presupuesto mensual.';
    await reportHealthIssue('xianyu-budget',warning).catch(()=>{});
    return {ok:false,state:'state_missing',mode:'justoneapi',warning,perQuery:[],kept:0};
  }
  const pages=clampInt(justOnePages??process.env.XIANYU_JUSTONE_PAGES??1,1,1,5);
  const dailyLimit=clampInt(process.env.XIANYU_DAILY_SEARCH_LIMIT??XIANYU_DAILY_SEARCH_LIMIT,
    XIANYU_DAILY_SEARCH_LIMIT,0,XIANYU_DAILY_SEARCH_LIMIT);
  const paidInterval=xianyuPaidSearchIntervalMs(pages,dailyLimit);
  const sincePaid=Date.now()-xianyuLastPaidSearchAt();
  if(Number.isFinite(paidInterval)&&sincePaid<paidInterval){
    console.log(`Xianyu Just One API: turno omitido; próxima búsqueda pagada en ~${Math.ceil((paidInterval-sincePaid)/60_000)} min.`);
    return {ok:true,state:'paid_throttled',mode:'justoneapi',perQuery:[],kept:0};
  }
  const minInterval=clampInt(process.env.XIANYU_MIN_INTERVAL_MIN??60,60,60,1440);
  if(!slotReserved&&minInterval>0&&Date.now()-xianyuLastSearchAt()<minInterval*60e3){
    return {ok:true,state:'throttled',mode:'justoneapi',perQuery:[],kept:0};
  }
  // Una sola búsqueda por ventana de tiempo, incluso si una variable antigua
  // XIANYU_MAX_QUERIES=2 sigue presente en GitHub.
  const maxQueries=1;
  const selected=(queries||[]).map(q=>String(q||'').trim()).filter(Boolean).slice(0,maxQueries);
  if(selected.length){
    let budget;
    try{budget=reserveXianyuSearch();}
    catch(error){
      const warning=String(error?.message||'Presupuesto mensual de Xianyu no disponible.');
      await reportHealthIssue('xianyu-budget',warning).catch(()=>{});
      return {ok:false,state:'budget_error',mode:'justoneapi',warning,perQuery:[],kept:0};
    }
    if(!budget.allowed){
      const warning=xianyuBudgetWarning(budget);
      console.log(warning);
      await reportHealthIssue('xianyu-budget',warning).catch(()=>{});
      return {ok:true,state:'budget_exhausted',mode:'justoneapi',warning,perQuery:[],kept:0};
    }
    clearHealthIssue('xianyu-budget');
    xianyuMarkPaidSearch();
    xianyuMarkSearch();
  }
  const perQuery=[];
  let kept=0;
  const min=Number.isFinite(Number(minEur))&&Number(minEur)>0?Number(minEur):null;
  const max=Number.isFinite(Number(maxEur))&&Number(maxEur)>0?Number(maxEur):null;
  // Páginas por búsqueda (10 anuncios cada una). Cada página es una llamada y
  // cuenta en el cupo mensual; la primera ya se ha reservado arriba.
  for(const keyword of selected){
    try{
      const items=[];
      const seen=new Set();
      let found=0,missingTag=0,requestId=null,pagesRead=0;
      for(let page=1;page<=pages;page++){
        if(page>1){
          const extra=reserveXianyuSearch();
          if(!extra.allowed){
            await reportHealthIssue('xianyu-budget',xianyuBudgetWarning(extra)).catch(()=>{});
            break;
          }
          await sleep(1200);
        }
        const result=await searchJustOneXianyu({keyword,page,sort:'newest'});
        pagesRead++;
        requestId=requestId||result.requestId;
        found+=result.totalFound;
        missingTag+=result.missingVerificationTag;
        for(const it of result.items){
          if(it?.id&&seen.has(it.id))continue;
          if(it?.id)seen.add(it.id);
          items.push(it);
        }
        if(!result.totalFound)break;
      }
      const rejected={noVerificationTag:missingTag,missingCoreFields:0,invalidPrice:0,missingImage:0,missingSellerInfo:0,missingPublicationTime:0,listingTooOld:0,futurePublication:0,belowMin:0,aboveMax:0};
      let localKept=0;
      for(const it of items.slice(0,Math.max(1,Number(maxItems)))){
        const saved=saveXianyuCandidate({...it,provider:'justoneapi'},{sessionId,sourceQuery:keyword,minEur:min,maxEur:max});
        if(saved.kept){localKept++;kept++;}
        else if(rejected[saved.reason]!==undefined)rejected[saved.reason]++;
      }
      perQuery.push({query:keyword,provider:'Just One API',requestId,pages:pagesRead,found,kept:localKept,rejected});
      await sleep(1200);
    }catch(error){
      const message=String(error?.message||'Error de proveedor').slice(0,240);
      perQuery.push({query:keyword,provider:'Just One API',errorCode:error?.code??null,error:message});
      await reportHealthIssue('xianyu-search',`Just One API no pudo completar la búsqueda de Xianyu: ${message}. Las demás plataformas continúan funcionando.`).catch(()=>{});
      break;
    }
  }
  db.prepare('INSERT INTO runs(source,kind,summary,created_at) VALUES(?,?,?,?)').run('xianyu','live-search-justoneapi',`Queries ${perQuery.length}; kept ${kept}`,new Date().toISOString());
  if(perQuery.length&&perQuery.every(query=>!query.error))clearHealthIssue('xianyu-search');
  return {ok:!perQuery.some(query=>query.error),mode:'justoneapi',perQuery,kept};
}

async function searchXianyuDirect({queries,maxItems=30,minEur=null,maxEur=null,sessionId,product,accountStateFile=null,accountStrategy='auto',slotReserved=false}){
  // Como mucho una búsqueda de Xianyu cada XIANYU_MIN_INTERVAL_MIN minutos
  // (entre todas las tareas y ejecuciones). Menos peticiones = menos verificaciones.
  const minInterval=Number(process.env.XIANYU_MIN_INTERVAL_MIN??360);
  const files=xianyuKnownAccounts();
  if(xianyuPausedReason&&xianyuPauseCode==='login'&&
    availableXianyuAccounts(files,{failed:xianyuFailedAccounts}).length){
    xianyuPausedReason=null;
  }
  if(xianyuPausedReason&&Date.now()-xianyuPausedAt>xianyuPauseLen){xianyuPausedReason=null;xianyuPauseCode=null;xianyuPauseLen=XIANYU_PAUSE_MS;}
  if(xianyuPausedReason){
    return {ok:true,state:'paused',warning:xianyuPausedReason,perQuery:[],kept:0};
  }
  if(!slotReserved&&minInterval>0&&Date.now()-xianyuLastSearchAt()<minInterval*60e3){
    return {ok:true,state:'throttled',perQuery:[],kept:0};
  }
  const maxQueries=clampInt(process.env.XIANYU_MAX_QUERIES||1,1,1,2);
  const perQuery=[];
  let kept=0;
  const all=(queries||[]).map(q=>String(q||'').trim()).filter(Boolean);
  let done=0;
  for(const keyword of all.slice(0,2)){
    // La 2ª búsqueda solo si XIANYU_MAX_QUERIES=2 o si la 1ª salió vacía.
    if(done>=maxQueries&&kept>0)break;
    done++;
    let res;
    const minCny=Number.isFinite(Number(minEur))&&Number(minEur)>0?Math.floor(eurTo(Number(minEur),'CNY')||0)||null:null;
    const maxCny=Number.isFinite(Number(maxEur))&&Number(maxEur)>0?Math.ceil(eurTo(Number(maxEur),'CNY')||0)||null:null;
    const fixed=accountStrategy==='fixed'
      ?files.find(file=>path.basename(file)===path.basename(String(accountStateFile||'')))||null
      :null;
    const attempt=await tryXianyuAccounts({
      files,preferred:xianyuActiveAccount,failed:xianyuFailedAccounts,
      fixed:accountStrategy==='fixed'?fixed||'missing':null,
      search:async stateFile=>{
        try{return await xianyuDirectSearchOnce(keyword,{minCny,maxCny,stateFile});}
        catch(e){return {noResponse:true,where:e.message};}
      }
    });
    res=attempt.result;
    const failedLabels=attempt.expired;
    for(const label of failedLabels)console.log(`Xianyu: sesión ${label} caducada; probando la siguiente cuenta.`);
    let publicFallback=false;
    if(res.login&&files.length&&accountStrategy!=='fixed'){
      console.log('Xianyu: todas las sesiones disponibles caducaron; probando resultados públicos sin sesión.');
      try{
        res=await xianyuDirectSearchOnce(keyword,{minCny,maxCny,stateFile:null});
        if(!res.login&&!res.noResponse&&!res.risk){
          publicFallback=true;
          xianyuActiveAccount=null;
        }
      }catch(e){res={noResponse:true,where:e.message};}
    }
    if(!res.login&&!res.noResponse&&!res.risk)xianyuActiveAccount=attempt.usedFile;
    if(res.login&&accountStrategy==='fixed'){
      const warning=`La cuenta fija ${accountLabel(fixed||accountStateFile)} necesita renovar su sesión.`;
      perQuery.push({query:keyword,login:true,account:accountLabel(fixed||accountStateFile),accountsExpired:failedLabels});
      return {ok:true,state:'paused',warning,perQuery,kept};
    }
    if(res.login||res.noResponse){
      // Un fallo de carga no debe generar un error por cada tarea: se pausa
      // Xianyu en esta ejecución y se avisa una sola vez (con detalle).
      xianyuPausedAt=Date.now();
      xianyuPauseCode=res.login?'login':'search';
      xianyuPausedReason=res.login
        ? 'Todas las cuentas de Xianyu necesitan renovar la sesión; Xianyu queda en pausa.'
        : 'Xianyu no ha devuelto resultados de búsqueda; Xianyu queda en pausa en esta ejecución.';
      console.log(`Xianyu direct: ${xianyuPausedReason} (${res.where||''})`);
      // Señal para el workflow: al terminar, pedir a Nil un QR por Telegram.
      if(res.login){try{fs.writeFileSync(path.join(__dirname,'.xianyu-needs-login'),xianyuPausedReason);}catch{}}
      await reportHealthIssue(res.login?'xianyu-login':'xianyu-search',xianyuPausedReason+' Las demás plataformas siguen funcionando con normalidad.').catch(()=>{});
      perQuery.push({query:keyword,login:!!res.login,noResponse:!!res.noResponse,where:res.where||null,accountsExpired:failedLabels});
      break;
    }
    if(res.risk){
      xianyuPausedAt=Date.now();
      xianyuPauseCode='risk';
      xianyuPauseLen=XIANYU_RISK_PAUSE_MS;
      xianyuPausedReason='Xianyu ha pedido una verificación anti-bot; Xianyu queda en pausa el resto de esta ejecución para proteger tu cuenta.';
      await reportHealthIssue('xianyu-risk',xianyuPausedReason+' Las demás plataformas siguen funcionando con normalidad. Se reintentará en la próxima ejecución.').catch(()=>{});
      perQuery.push({query:keyword,risk:true});
      break;
    }
    const rejected={noVerificationTag:0,missingCoreFields:0,invalidPrice:0,missingImage:0,missingSellerInfo:0,missingPublicationTime:0,listingTooOld:0,futurePublication:0,belowMin:0,aboveMax:0};
    let localKept=0;
    for(const it of res.items.slice(0,Math.max(1,Number(maxItems)))){
      const result=saveXianyuCandidate(it,{sessionId,sourceQuery:keyword,minEur,maxEur});
      if(result.kept){localKept++;kept++;}
      else if(rejected[result.reason]!==undefined)rejected[result.reason]++;
    }
    perQuery.push({query:keyword,account:accountLabel(xianyuActiveAccount),accountsExpired:failedLabels,publicFallback,sortedNewest:res.sorted,priceFiltered:!!res.priced,found:res.items.length,kept:localKept,rejected,...(res.items.length?{}:{ret:res.ret})});
    await sleep(2500+Math.random()*2500);
  }
  if(perQuery.length)xianyuMarkSearch();
  db.prepare('INSERT INTO runs(source,kind,summary,created_at) VALUES(?,?,?,?)').run('xianyu','live-search-direct',`Queries ${perQuery.length}; kept ${kept}`,new Date().toISOString());
  if(xianyuPausedReason&&!kept)return {ok:true,state:'paused',warning:xianyuPausedReason,perQuery,kept};
  clearHealthIssue('xianyu-risk');
  clearHealthIssue('xianyu-search');
  return {ok:true,mode:'direct',perQuery,kept};
}

let xianyuQueue=Promise.resolve();
function searchXianyuLive(opts){
  // Una búsqueda de Xianyu a la vez (misma sesión, ritmo humano).
  // Si la sesión no es válida ya se avisa una vez (xianyu-login); no repetir
  // un error por cada tarea.
  if(xianyuProvider()==='alternate'){
    const run=xianyuQueue.then(()=>searchXianyuAlternate(opts));
    xianyuQueue=run.catch(()=>{});
    return run;
  }
  if(xianyuProvider()==='justoneapi'){
    const run=xianyuQueue.then(()=>searchXianyuJustOneApi(opts));
    xianyuQueue=run.catch(()=>{});
    return run;
  }
  const blocked=xianyuDirectSessionBlock();
  if(blocked)return Promise.resolve(blocked);
  const fn=xianyuDirectMode()?searchXianyuDirect:searchXianyuLiveExclusive;
  const run=xianyuQueue.then(()=>fn(opts));
  xianyuQueue=run.catch(()=>{});
  return run;
}
function xianyuDirectSessionBlock(){
  const ss=String(process.env.XIANYU_SESSION_STATUS||'').trim();
  if(xianyuDirectMode()&&['risk_control','error'].includes(ss)){
    const warning=ss==='risk_control'
      ?'Xianyu ha pedido verificación de seguridad. Se espera a que la cuenta se revise manualmente.'
      :'No hay ninguna sesión válida de Xianyu. Renueva una de las cuentas.';
    return {ok:true,state:'paused',warning,perQuery:[],kept:0};
  }
  if(ss&&ss!=='ok'&&!xianyuDirectMode()){
    return {ok:true,state:'paused',warning:`Sesión de Xianyu no disponible (${ss}).`,perQuery:[],kept:0};
  }
  return null;
}
// Cada tarea con Xianyu alterna entre Just One API y la cuenta de Nil.
// Los turnos de pago se espacian y se detienen al alcanzar el cupo diario.
// El turno se gasta aunque la búsqueda no salga (sesión caducada, cupo
// agotado...): así el siguiente siempre toca al otro proveedor.
// Si la cuenta pide verificación (captcha o de identidad), ese turno pasa a
// Just One API y, mientras siga así, Just One API usa una sola página (10
// anuncios) cuando el presupuesto lo permita. Cada turno de la cuenta comprueba
// si ya vuelve a funcionar; entonces se vuelve a alternar con normalidad.
// Si Just One API se queda sin saldo (error 601) o sin cupo (diario o mensual),
// su turno lo hace la cuenta (30 anuncios, como en sus propios turnos). Cada turno de Just One API comprueba si ya puede volver a buscar.
function xianyuJustOneNoCredit(){
  return !!db.prepare("SELECT 1 FROM app_settings WHERE key='xianyu_justone_no_credit'").get();
}
function xianyuJustOneOutOfCredit(res){
  return res?.state==='budget_exhausted'||
    (res?.perQuery||[]).some(q=>Number(q?.errorCode)===601);
}
async function searchXianyuAlternate(opts){
  const queries=(opts.queries||[]).map(q=>String(q||'').trim()).filter(Boolean);
  if(!queries.length)return {ok:true,mode:'alternate',perQuery:[],kept:0};
  const accountBlocked=xianyuAccountBlocked();

  const runAccount=async()=>{
    const fn=xianyuDirectMode()?searchXianyuDirect:searchXianyuLiveExclusive;
    // La cuenta revisa siempre sus 30 anuncios (también cuando hace los
    // turnos de Just One API por falta de saldo): la página ya trae 30, así
    // que no hay más peticiones a Xianyu.
    const accountOpts={...opts,slotReserved:true,maxItems:30};
    const res=xianyuDirectSessionBlock()||await fn(accountOpts);
    const verification=String(process.env.XIANYU_SESSION_STATUS||'').trim()==='risk_control'||
      (res.perQuery||[]).some(q=>q?.risk)||(res.state==='paused'&&xianyuPauseCode==='risk');
    if(verification){
      if(!accountBlocked){
        xianyuBlockAccount('verificación anti-bot');
        await reportHealthIssue('xianyu-account-blocked','Tu cuenta de Xianyu ha pedido verificación. Mientras siga así, Xianyu usa Just One API cuando el presupuesto diario lo permite; en cada turno de tu cuenta se comprueba si ya funciona.').catch(()=>{});
      }
      return {res,verification:true};
    }
    const worked=!res.state&&(res.perQuery||[]).some(q=>Number.isFinite(q?.found));
    if(accountBlocked&&worked){
      xianyuUnblockAccount();
      clearHealthIssue('xianyu-account-blocked');
      console.log('Xianyu (alterno): la cuenta vuelve a funcionar; se vuelve a alternar con normalidad.');
    }
    return {res,verification:false};
  };

  const runJustOne=async pages=>{
    const noCredit=xianyuJustOneNoCredit();
    const res=await searchXianyuJustOneApi({...opts,slotReserved:true,...(pages?{justOnePages:pages}:{})});
    const searched=!res.state&&(res.perQuery||[]).some(q=>!q?.error&&Number.isFinite(q?.found));
    if(xianyuJustOneOutOfCredit(res)){
      if(!noCredit){
        db.prepare(`INSERT INTO app_settings(key,value_json,updated_at) VALUES('xianyu_justone_no_credit',?,?)
          ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
          .run(JSON.stringify({at:new Date().toISOString()}),new Date().toISOString());
        await reportHealthIssue('xianyu-justone-credit','Just One API se ha quedado sin saldo o sin cupo. Mientras tanto sus turnos los hace tu cuenta de Xianyu y revisa 30 anuncios en cada tarea; cuando Just One API vuelva a poder buscar, se vuelve a alternar solo.').catch(()=>{});
      }
    }else if(noCredit&&searched){
      db.prepare("DELETE FROM app_settings WHERE key='xianyu_justone_no_credit'").run();
      clearHealthIssue('xianyu-justone-credit');
      console.log('Xianyu (alterno): Just One API vuelve a poder buscar; se vuelve a alternar con normalidad.');
    }
    return {res,searched};
  };

  // XIANYU_JUSTONE_DISABLED=1: Just One API queda apagada hasta nuevo aviso
  // de Nil. Todas las tareas buscan con su cuenta y no se avisa de su saldo.
  if(['1','true','yes','on'].includes(String(process.env.XIANYU_JUSTONE_DISABLED||'').toLowerCase())){
    xianyuMarkProvider('direct');
    console.log(`Xianyu: Just One API desactivada; esta tarea busca con la cuenta${accountBlocked?' (comprobando si ya funciona)':''}.`);
    const acc=await runAccount();
    return {...acc.res,provider:'direct',accountBlocked:acc.verification,justOneDisabled:true};
  }
  if(xianyuLastProvider()!=='justoneapi'){
    xianyuMarkProvider('justoneapi');
    console.log(`Xianyu (alterno): turno de Just One API${accountBlocked?' (la cuenta de Xianyu pide verificación: 1 página)':''}.`);
    const jo=await runJustOne(accountBlocked?1:null);
    if(jo.searched||accountBlocked||!xianyuJustOneNoCredit()){
      return {...jo.res,provider:'justoneapi',accountBlocked,justOneNoCredit:xianyuJustOneNoCredit()};
    }
    console.log('Xianyu (alterno): Just One API sin saldo o sin cupo; esta tarea busca con la cuenta (30 anuncios).');
    const acc=await runAccount();
    return {...acc.res,provider:'direct',accountBlocked:acc.verification,justOneNoCredit:true};
  }
  xianyuMarkProvider('direct');
  console.log(`Xianyu (alterno): turno de la cuenta de Xianyu${accountBlocked?' (comprobando si ya funciona)':''}.`);
  const acc=await runAccount();
  if(!acc.verification)return {...acc.res,provider:'direct'};
  console.log('Xianyu (alterno): la cuenta pide verificación; este turno pasa a Just One API (1 página).');
  const jo=await runJustOne(1);
  return {...jo.res,provider:'justoneapi',accountBlocked:true,justOneNoCredit:xianyuJustOneNoCredit()};
}
async function searchXianyuLiveExclusive({ queries, pages=1, maxItems=30, minEur=null, maxEur=null, sessionId, product, personalOnly=false, freeShipping=false, newPublishOption=null, region=null, accountStateFile=null, accountStrategy='auto' }) {
  // Xianyu es lento (visita el perfil de cada vendedor): 1 búsqueda por tarea por defecto.
  const maxQueries = clampInt(process.env.XIANYU_MAX_QUERIES || 1, 1, 1, 2);
  const selectedQueries = (queries || []).slice(0, maxQueries);
  const health = await xianyuFetch('/health', { timeoutMs:7000 });
  if (!health) throw new Error('No se pudo conectar con Xianyu Hunter.');
  const perQuery=[];
  let kept=0;
  for (const keyword0 of selectedQueries) {
    const keyword = String(keyword0).trim(); if (!keyword) continue;
    const minLocal = Number.isFinite(Number(minEur)) ? Math.floor(eurTo(Number(minEur), 'CNY') || 0) : null;
    const maxLocal = Number.isFinite(Number(maxEur)) ? Math.ceil(eurTo(Number(maxEur), 'CNY') || 0) : null;
    const brandRule = keyword.split(/\s+/)[0] || keyword;
    const payload = {
      task_name:`LH ${String(product).slice(0,40)} ${Date.now()}`,
      enabled:true,
      keyword,
      description:'Temporary live search created by Luxury Hunter. Central AI analysis is performed in Luxury Hunter.',
      analyze_images:false,
      max_pages:clampInt(pages,1,1,5),
      personal_only:!!personalOnly,
      min_price:minLocal ? String(minLocal) : null,
      max_price:maxLocal ? String(maxLocal) : null,
      cron:null,
      account_state_file:accountStateFile || null,
      account_strategy:accountStrategy || 'auto',
      free_shipping:!!freeShipping,
      new_publish_option:newPublishOption || null,
      region:region || null,
      decision_mode:'keyword',
      keyword_rules:[brandRule]
    };
    let taskId=null;
    const startedAt = Date.now();
    try {
      const created = await xianyuFetch('/api/tasks/', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(payload), timeoutMs:15000 });
      taskId = created?.task?.id;
      // La primera tarea del conector tiene id 0: comprobar null, no falsy.
      if (taskId === undefined || taskId === null) throw new Error('Xianyu no devolvió el ID de la tarea temporal.');
      await xianyuFetch(`/api/tasks/start/${taskId}`, { method:'POST', timeoutMs:15000 });
      let seenRunning=false;
      const deadline = Date.now() + clampInt(process.env.XIANYU_QUERY_TIMEOUT_SEC || 180, 180, 60, 600) * 1000;
      while (Date.now() < deadline) {
        await sleep(2000);
        const t = await xianyuFetch(`/api/tasks/${taskId}`, { timeoutMs:10000 });
        if (t?.is_running) seenRunning=true;
        if (seenRunning && !t?.is_running) break;
        if (!seenRunning && Date.now() - startedAt > 15000 && !t?.is_running) break;
      }
      const filename = xianyuResultFilename(keyword);
      let result = { items:[], total_items:0 };
      try {
        result = await xianyuFetch(`/api/results/${encodeURIComponent(filename)}?page=1&limit=100&include_hidden=true&sort_by=crawl_time&sort_order=desc`, { timeoutMs:20000 });
      } catch (e) {
        if (!String(e.message).includes('404')) throw e;
      }
      let localKept=0;
      const rejected={ staleTask:0, missingCoreFields:0, invalidPrice:0, belowMin:0, aboveMax:0 };
      const allRecords = result.items || [];
      const currentRecords = allRecords.filter(raw => {
        const recordTask = String(raw?.['任务名称'] || '').trim();
        if (
          recordTask &&
          recordTask !== payload.task_name &&
          recordTask !== String(keyword || '').trim()
        ) {
          rejected.staleTask++;
          return false;
        }
        return true;
      });
      for (const raw of currentRecords.slice(0, Math.max(1, Number(maxItems)))) {
        // Current Xianyu result records use Chinese nested keys under 商品信息 / 卖家信息.
        // Keep English fallbacks for older forks and legacy records.
        const info = raw?.['商品信息'] || {};
        const sellerInfo = raw?.['卖家信息'] || {};
        const sourceId = info['商品ID'] ?? pick(raw, ['product_id','item_id','id']) ?? deepPick(raw, ['product_id','item_id','id','商品ID']);
        const title = info['商品标题'] ?? pick(raw, ['title','name']) ?? deepPick(raw, ['title','name','商品标题']);
        const url = info['商品链接'] ?? pick(raw, ['link','url','item_url']) ?? deepPick(raw, ['link','url','item_url','商品链接']);
        const rawPrice = info['当前售价'] ?? info['价格'] ?? pick(raw, ['price','current_price']) ?? deepPick(raw, ['price','current_price','sold_price','当前售价']);
        const price = parseMoney(rawPrice);
        if (!sourceId || (!title && !url)) { rejected.missingCoreFields++; continue; }
        if (!Number.isFinite(Number(price))) { rejected.invalidPrice++; continue; }
        const pe = toEur(price, 'CNY');
        if (Number.isFinite(Number(minEur)) && pe != null && pe < Number(minEur)) { rejected.belowMin++; continue; }
        if (Number.isFinite(Number(maxEur)) && pe != null && pe > Number(maxEur)) { rejected.aboveMax++; continue; }
        const seller = sellerInfo['卖家昵称'] ?? info['卖家昵称'] ?? pick(raw, ['seller_nick','seller_name']) ?? deepPick(raw, ['seller_nick','seller_name','nick','卖家昵称']);
        const description = (info['商品描述'] ?? raw?.['商品描述'] ?? deepPick(raw, ['description','desc','detail','商品描述'])) || '';
        upsertListing({
          source:'xianyu', source_id:sourceId, url, title, description,
          original_price:price, currency:'CNY', price_eur:pe, seller_name:seller, image_url:xianyuImage(raw),
          status:raw?._status || pick(raw,['status','detail_fetch_status']) || '', purchase_via:'China agent', raw
        }, sessionId, keyword);
        localKept++; kept++;
      }
      perQuery.push({
        query:keyword,
        rawTotal:result.total_items || allRecords.length || 0,
        currentTaskRecords:currentRecords.length,
        kept:localKept,
        rejected
      });
    } finally {
      if (taskId !== null && taskId !== undefined) { try { await xianyuFetch(`/api/tasks/${taskId}`, { method:'DELETE', timeoutMs:10000 }); } catch {} }
    }
    // Keep Xianyu conservative. Do not hammer searches back-to-back.
    await sleep(1200);
  }
  db.prepare('INSERT INTO runs(source,kind,summary,created_at) VALUES(?,?,?,?)').run('xianyu','live-search',`Queries ${perQuery.length}; kept ${kept}`,new Date().toISOString());
  return { ok:true, perQuery, kept };
}

// JAPAN MULTI-SOURCE RADAR V2

const JAPAN_HTTP_HEADERS={
  'user-agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/150 Safari/537.36',
  'accept-language':'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7'
};

const JAPAN_RADAR_SPECS=[
  {
    id:'mercari-jp',
    label:'Mercari Japan',
    purchaseVia:'Direct',
    mode:'browser',
    base:'https://jp.mercari.com',
    scrollSteps:10,
    cap:100,
    searchWaitMs:3500,
    detailWaitMs:4000,
    searchUrl:q=>`https://jp.mercari.com/search?keyword=${encodeURIComponent(q)}&sort=created_time&order=desc`,
    // Fuera de Japón Mercari enseña los precios en euros: el precio en yenes
    // se lee de su API (buscador y ficha).
    searchApi:/api\.mercari\.jp\/v2\/entities:search/,
    detailApi:/api\.mercari\.jp\/items\/get(\?|$)/,
    accepts:u=>/^\/item\/m\d+/i.test(u.pathname)||/^\/shops\/product\/[^/]+/i.test(u.pathname)
  },
  {
    id:'rakuma-jp',
    label:'Rakuma',
    purchaseVia:'Direct',
    mode:'http',
    base:'https://fril.jp',
    cap:60,
    searchUrl:q=>`https://fril.jp/s?query=${encodeURIComponent(q)}`,
    accepts:u=>u.hostname==='item.fril.jp'&&/^\/[a-f0-9]+\/?$/i.test(u.pathname)
  },
  {
    id:'yahoo-fleamarket-jp',
    label:'Yahoo! Flea Market',
    purchaseVia:'Direct',
    mode:'browser',
    base:'https://paypayfleamarket.yahoo.co.jp',
    cap:60,
    searchWaitMs:3000,
    detailWaitMs:1000,
    searchUrl:q=>`https://paypayfleamarket.yahoo.co.jp/search/${encodeURIComponent(q)}?withSpeller=0`,
    accepts:u=>/^\/item\/[^/]+/i.test(u.pathname)
  },
  {
    id:'2ndstreet-jp',
    label:'2nd STREET Japan',
    purchaseVia:'Direct',
    mode:'browser',
    base:'https://www.2ndstreet.jp',
    cap:30,
    searchWaitMs:3000,
    detailWaitMs:1000,
    searchUrl:q=>`https://www.2ndstreet.jp/search?keyword=${encodeURIComponent(q)}`,
    accepts:u=>/\/goods\//i.test(u.pathname)
  },
  {
    id:'komehyo-jp',
    label:'KOMEHYO',
    purchaseVia:'Direct',
    mode:'http',
    base:'https://komehyo.jp',
    cap:30,
    searchUrl:q=>`https://komehyo.jp/search/?q=${encodeURIComponent(q)}`,
    accepts:u=>/^\/product\/[^/]+\/?/i.test(u.pathname)
  }
];

// Fuentes de Japón que se buscan (JAPAN_SOURCES, por defecto solo Mercari).
// Rakuma, Yahoo Flea Market, 2nd STREET y KOMEHYO casi no daban
// oportunidades y alargaban cada búsqueda; sus fichas se siguen pudiendo
// importar a mano por enlace.
function japanSearchSpecs(){
  const ids=String(process.env.JAPAN_SOURCES||'mercari-jp').split(',').map(x=>x.trim()).filter(Boolean);
  return JAPAN_RADAR_SPECS.filter(spec=>ids.includes(spec.id));
}

// One Map muestra las subastas de Yahoo Japón sin iniciar sesión. Una cuenta
// personal sirve para pujar manualmente; el radar solo lee y recomienda.
async function searchOneMapAuctions({queries,maxItems=30,minEur=null,maxEur=null,sessionId},browserContext){
  if(!browserContext)return {ok:false,kept:0,error:'Playwright browser unavailable'};
  const selected=normalizeLines(queries||[]).slice(0,clampInt(process.env.ONEMAP_MAX_QUERIES||2,2,1,4));
  const detailLimit=clampInt(process.env.ONEMAP_DETAIL_LIMIT||12,12,1,30);
  // Lista de One Map: hasta 2 páginas de 100 (las que acaban antes) y se
  // guardan todas las que dejan tiempo para pujar (≥30 min), no solo 8.
  const listPages=clampInt(process.env.ONEMAP_LIST_PAGES||2,2,1,3);
  const listMax=clampInt(process.env.ONEMAP_LIST_MAX||80,80,10,200);
  const minLeftMs=Math.max(5,Number(process.env.ONEMAP_MIN_LEFT_MIN||30))*60e3;
  const perQueryLimit=Math.max(1,Math.ceil(detailLimit/Math.max(1,selected.length)));
  const perQuery=[];
  const seen=new Set();
  let kept=0,listedOnly=0,detailErrors=0;
  const spec={id:'yahoo-auctions-jp',label:'Yahoo! Auctions Japan',purchaseVia:'One Map / FROM JAPAN',mode:'browser',detailWaitMs:1000};
  for(const q of selected){
    const searchUrl=oneMapSearchUrl(q);
    try{
      const snap=await japanBrowserSnapshot(browserContext,`${searchUrl}#lh-json-pages=${listPages}`,4000);
      let listed=null;
      try{const j=JSON.parse(snap.body);if(Array.isArray(j?.items))listed=oneMapJsonCards(j.items);}catch{}
      // Extensión antigua: devuelve la pantalla con las tarjetas de siempre.
      if(!listed&&(snap.status>=400||!/JDirectItems Auction/i.test(snap.title)||!/Search Results:/i.test(snap.body))){
        throw new Error(`One Map no devolvió resultados accesibles (HTTP ${snap.status}${snap.body&&snap.status>=400?`: ${String(snap.body).slice(0,80)}`:''})`);
      }
      const parsed=listed||parseOneMapAuctions(snap.html);
      const cards=parsed
        .filter(c=>c.timeLeftMs>=minLeftMs&&c.timeLeftMs<=AUCTION_SHOW_HOURS*3600e3&&(Number(c.bids)||0)>=AUCTION_MIN_BIDS)
        .filter(c=>{
          const eur=toEur(c.currentBid,'JPY');
          return eur!=null&&
            (minEur==null||eur>=Number(minEur))&&
            (maxEur==null||eur<=Number(maxEur));
        })
        // Primero las que tienen más pujas (más interesados) y, a igualdad,
        // las que acaban antes: son las que se abren con ficha completa.
        .sort((a,b)=>(Number(b.bids)||0)-(Number(a.bids)||0)||a.timeLeftMs-b.timeLeftMs);
      if(!parsed.length&&!listed&&/Search Results:\s*([1-9][\d,]*)\s*Items?/i.test(snap.body)){
        throw new Error('One Map muestra anuncios pero no se pudieron leer las tarjetas');
      }
      console.log(`One Map "${q}": ${parsed.length} leídas${listed?' (lista)':' (pantalla)'}, ${cards.length} con tiempo para pujar y en tu rango de precio.`);
      let local=0;
      let queryDetailErrors=0;
      let detailed=0;
      for(const card of cards){
        if(local>=listMax)break;
        if(seen.has(card.id))continue;
        seen.add(card.id);
        // Más allá del tope de fichas: se guarda con lo que da la lista
        // (título, foto, puja, fin) y el análisis lo valora igual.
        if(detailed>=perQueryLimit||kept>=detailLimit){
          const bid=card.currentBid;
          upsertListing({source:spec.id,source_id:card.id,url:card.url,title:card.title,description:'',original_price:bid,currency:'JPY',
            price_eur:toEur(bid,'JPY'),seller_name:'',image_url:card.image||'',status:'',purchase_via:'One Map / FROM JAPAN',
            raw:{query:q,searchUrl,searchMode:'list',sourceLabel:spec.label,purchaseVia:'One Map / FROM JAPAN',
              auction:{endsAt:card.endsAt,bids:card.bids,currentBid:bid,currency:'JPY',buyNow:card.buyNow,provider:'One Map',requiresDatabase:true}}},sessionId,q);
          local++;listedOnly++;
          continue;
        }
        detailed++;
        try{
          const item=await japanEnrichCandidate(spec,{
            href:card.url,title:card.title,blob:card.title,price:card.currentBid,img:card.image||''
          },{query:q,searchUrl},browserContext);
          if(item.status==='sold')continue;
          const bid=Math.max(Number(item.original_price)||0,card.currentBid);
          const end=card.endsAt;
          item.source_id=card.id;
          item.original_price=bid;
          item.price_eur=toEur(bid,'JPY');
          item.purchase_via='One Map / FROM JAPAN';
          item.raw={...item.raw,auction:{endsAt:end,bids:card.bids,currentBid:bid,currency:'JPY',buyNow:card.buyNow,provider:'One Map',requiresDatabase:true}};
          upsertListing(item,sessionId,q);
          kept++;local++;
        }catch(e){detailErrors++;queryDetailErrors++;console.warn(`One Map ${card.id}: ${e.message}`);}
      }
      perQuery.push({query:q,count:local,detailed,read:parsed.length,candidates:cards.length,searchUrl,
        ...(local===0&&queryDetailErrors>0?{error:`Fallaron ${queryDetailErrors} fichas de One Map`}:{})});
    }catch(e){perQuery.push({query:q,count:0,error:e.message,searchUrl});}
  }
  const ok=perQuery.length>0&&perQuery.some(x=>!x.error);
  db.prepare('INSERT INTO runs(source,kind,summary,created_at) VALUES(?,?,?,?)')
    .run('onemap','live-search',`Queries ${perQuery.length}; kept ${kept+listedOnly} (${kept} con ficha); detail errors ${detailErrors}`,new Date().toISOString());
  return {ok,source:'yahoo-auctions-jp',label:'Yahoo! Auctions Japan',purchaseVia:'One Map / FROM JAPAN',mode:'browser',kept:kept+listedOnly,detailed:kept,detailErrors,perQuery,...(!ok?{error:perQuery[0]?.error||'No se pudo leer One Map'}:{})};
}



function parseYen(text){
  const s=String(text||'').replace(/\s+/g,' ');
  const patterns=[
    /[¥￥]\s*([0-9][0-9,]*)/,
    /([0-9][0-9,]*)\s*(?:JPY|円|yen)/i
  ];
  for(const p of patterns){
    const m=s.match(p);
    if(m)return Number(m[1].replaceAll(',',''));
  }
  return null;
}

function japanNormalizeHref(raw,base){
  try{
    return new URL(String(raw||''),base).href;
  }catch{
    return '';
  }
}

function japanCandidateRoot($,el){
  let root=$(el).closest('li,article');
  if(root.length)return root;

  let current=$(el);
  for(let i=0;i<4;i++){
    current=current.parent();
    if(!current.length)break;
    const text=current.text().replace(/\s+/g,' ').trim();
    if(text.length>=25)return current;
  }

  return $(el);
}

function japanCardImage($,el,root,base){
  const candidates=[
    $(el).find('img').first().attr('src'),
    $(el).find('img').first().attr('data-src'),
    root.find('img').first().attr('src'),
    root.find('img').first().attr('data-src')
  ];

  for(const value of candidates){
    if(value){
      const url=japanNormalizeHref(value,base);
      if(url)return url;
    }
  }

  return '';
}

function japanSourceId(source,href){
  try{
    const u=new URL(href);
    let m=null;

    if(source==='yahoo-auctions-jp'){
      m=u.pathname.match(/\/auction\/yahoo\/input\/([^/?#]+)/i)
        ||u.pathname.match(/\/auction\/([^/?#]+)/i);
      if(m)return m[1];
    }

    if(source==='mercari-jp'){
      m=u.pathname.match(/\/item\/(m\d+)/i);
      if(m)return m[1];

      m=u.pathname.match(/\/shops\/product\/([^/?#]+)/i);
      if(m)return `shops-${m[1]}`;
    }

    if(source==='rakuma-jp'){
      m=u.pathname.match(/^\/([a-f0-9]+)\/?$/i);
      if(m)return m[1];
    }

    if(source==='yahoo-fleamarket-jp'){
      m=u.pathname.match(/\/item\/([^/?#]+)/i);
      if(m)return m[1];
    }

    if(source==='2ndstreet-jp'){
      m=u.pathname.match(/\/goods\/([^/?#]+)/i);
      if(m)return m[1];
    }

    if(source==='komehyo-jp'){
      m=u.pathname.match(/\/product\/([^/?#]+)/i);
      if(m)return m[1];
    }

    return u.pathname.replace(/^\/+|\/+$/g,'')||href;
  }catch{
    return href;
  }
}

function japanFindJsonLdProduct($){
  let found=null;

  const walk=value=>{
    if(found||value==null)return;

    if(Array.isArray(value)){
      for(const x of value)walk(x);
      return;
    }

    if(typeof value!=='object')return;

    const type=value['@type'];

    if(
      type==='Product'||
      (Array.isArray(type)&&type.includes('Product'))
    ){
      found=value;
      return;
    }

    if(value['@graph'])walk(value['@graph']);
  };

  $('script[type="application/ld+json"]').each((_,el)=>{
    if(found)return;

    try{
      const raw=$(el).html();
      if(!raw)return;
      walk(JSON.parse(raw));
    }catch{}
  });

  return found;
}

function japanOffer(product){
  const offers=product?.offers;
  if(Array.isArray(offers))return offers[0]||null;
  return offers&&typeof offers==='object'?offers:null;
}

function japanProductImage(product){
  const image=product?.image;

  if(Array.isArray(image)){
    for(const x of image){
      if(typeof x==='string'&&/^https?:\/\//i.test(x))return x;
      if(x&&typeof x==='object'&&/^https?:\/\//i.test(String(x.url||'')))return x.url;
    }
  }

  if(typeof image==='string'&&/^https?:\/\//i.test(image))return image;
  if(image&&typeof image==='object'&&/^https?:\/\//i.test(String(image.url||'')))return image.url;

  return '';
}

function japanRelativePublication(text){
  const s=String(text||'').replace(/\s+/g,' ');
  const now=Date.now();

  let m=s.match(/(?:たった今|数秒前)/);
  if(m){
    return {
      raw:m[0],
      publishedAt:new Date(now).toISOString(),
      provenance:'marketplace-relative-age'
    };
  }

  m=s.match(/(?:約\s*)?(\d+)\s*秒前/);
  if(m){
    const seconds=Number(m[1]);
    return {
      raw:m[0],
      publishedAt:new Date(now-seconds*1000).toISOString(),
      provenance:'marketplace-relative-age'
    };
  }

  m=s.match(/(?:約\s*)?(\d+)\s*分前/);
  if(m){
    const minutes=Number(m[1]);
    return {
      raw:m[0],
      publishedAt:new Date(now-minutes*60*1000).toISOString(),
      provenance:'marketplace-relative-age'
    };
  }

  m=s.match(/(?:約\s*)?(\d+)\s*時間前/);
  if(m){
    const hours=Number(m[1]);

    if(hours>=24)return null;

    return {
      raw:m[0],
      publishedAt:new Date(now-hours*60*60*1000).toISOString(),
      provenance:'marketplace-relative-age'
    };
  }

  return null;
}

function japanExactPublishedAt(year,month,day,hour,minute,second=0){
  const pad=n=>String(n).padStart(2,'0');
  const iso=`${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}+09:00`;
  const ms=Date.parse(iso);
  return Number.isFinite(ms)?new Date(ms).toISOString():null;
}

function japanYahooFleaPublication(text){
  const s=String(text||'').replace(/\s+/g,' ');
  const m=s.match(
    /出品日時\s*[:：]?\s*(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2})[:時](\d{2})(?:[:分](\d{2}))?/
  );

  if(!m)return null;

  const publishedAt=japanExactPublishedAt(
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]||0)
  );

  return publishedAt?{
    raw:m[0],
    publishedAt,
    provenance:'marketplace-exact-published-time'
  }:null;
}

function japanAuctionPublication(text){
  const s=String(text||'').replace(/\s+/g,' ');

  let m=s.match(
    /開始日時\s*[:：]?\s*(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2})[:時](\d{2})(?:[:分](\d{2}))?/
  );

  if(m){
    const publishedAt=japanExactPublishedAt(
      Number(m[1]),
      Number(m[2]),
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6]||0)
    );

    if(publishedAt){
      return {
        raw:m[0],
        publishedAt,
        provenance:'auction-start-time'
      };
    }
  }

  m=s.match(
    /(?:Start Time|Start Date)\s*[:：]?\s*([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}\s+\d{1,2}:\d{2}(?::\d{2})?)/i
  );

  if(m){
    const ms=Date.parse(`${m[1]} GMT+0900`);

    if(Number.isFinite(ms)){
      return {
        raw:m[0],
        publishedAt:new Date(ms).toISOString(),
        provenance:'auction-start-time'
      };
    }
  }

  return null;
}

function japanInventoryArrival(text){
  const s=String(text||'').replace(/\s+/g,' ');
  const m=s.match(/(\d{1,2})月(\d{1,2})日入荷/);

  if(!m)return null;

  return {
    raw:m[0],
    month:Number(m[1]),
    day:Number(m[2]),
    provenance:'inventory-arrival-not-publication'
  };
}

function japanPublicationFor(source,text){
  if(source==='mercari-jp'||source==='rakuma-jp'){
    return japanRelativePublication(text);
  }

  if(source==='yahoo-fleamarket-jp'){
    return japanYahooFleaPublication(text);
  }

  if(source==='yahoo-auctions-jp'){
    return japanAuctionPublication(text);
  }

  return null;
}

function japanYenPrice(source,product,body,candidate){
  const offer=japanOffer(product);
  const offerCurrency=String(offer?.priceCurrency||'').toUpperCase();
  const offerPrice=Number(offer?.price??offer?.lowPrice);

  if(
    Number.isFinite(offerPrice)&&
    offerPrice>0&&
    (!offerCurrency||offerCurrency==='JPY')
  ){
    return offerPrice;
  }

  const text=String(body||'').replace(/\s+/g,' ');
  let m=null;

  if(source==='komehyo-jp'){
    m=text.match(/販売価格(?:\(税込\))?\s*[¥￥]\s*([0-9][0-9,]*)/);
    if(m)return Number(m[1].replaceAll(',',''));
  }

  if(source==='yahoo-auctions-jp'){
    m=text.match(
      /(?:Current Price|Current Bid|現在価格|現在の価格)[^0-9¥￥]{0,50}[¥￥]?\s*([0-9][0-9,]*)/i
    );

    if(m)return Number(m[1].replaceAll(',',''));

    return null;
  }

  const direct=parseYen(text);
  if(Number.isFinite(direct)&&direct>0)return direct;

  if(Number.isFinite(Number(candidate?.price))&&Number(candidate.price)>0){
    return Number(candidate.price);
  }

  return null;
}

async function japanHttpSnapshot(url){
  const r=await fetch(url,{
    headers:JAPAN_HTTP_HEADERS,
    redirect:'follow',
    signal:AbortSignal.timeout(20000)
  });

  const html=await r.text();
  const $=loadHtml(html);
  const body=$('body').text().replace(/\s+/g,' ').trim();

  return {
    status:r.status,
    finalUrl:r.url||url,
    html,
    body,
    title:$('title').first().text().replace(/\s+/g,' ').trim()
  };
}

async function japanBrowserSnapshot(context,url,waitMs=1000,scrollSteps=0,apiPattern=null){
  if(context?.macBridgeToken)return macOneMapSnapshot(url,context.macBridgeToken);
  const page=await context.newPage();
  // Respuestas JSON de la propia web que cumplen apiPattern (Mercari: precio
  // en yenes aunque fuera de Japón la página lo enseñe convertido a euros).
  const apiReads=[];
  if(apiPattern){
    page.on('response',r=>{
      if(apiPattern.test(r.url()))apiReads.push(r.json().catch(()=>null));
    });
  }

  try{
    const response=await page.goto(url,{
      waitUntil:'domcontentloaded',
      timeout:45000
    });

    await page.waitForTimeout(waitMs);
    // Páginas que cargan más anuncios al bajar (Mercari): se baja por la
    // lista de resultados para leer más que los primeros.
    for(let i=0;i<scrollSteps;i++){
      await page.mouse.wheel(0,2400).catch(()=>{});
      await page.waitForTimeout(900);
    }

    const html=await page.content();

    const body=await page.locator('body')
      .innerText()
      .catch(()=>'');

    const api=(await Promise.all(apiReads.map(p=>Promise.race([
      p,
      new Promise(resolve=>setTimeout(()=>resolve(null),5000))
    ])))).filter(Boolean);

    return {
      status:response?.status()??0,
      finalUrl:page.url(),
      html,
      body:String(body||'').replace(/\s+/g,' ').trim(),
      title:await page.title().catch(()=>''),
      api
    };
  }finally{
    await page.close();
  }
}

function japanCollectCandidates(spec,html){
  const $=loadHtml(html);
  const out=[];
  const seen=new Set();

  $('a[href]').each((_,el)=>{
    const raw=$(el).attr('href')||'';
    const href=japanNormalizeHref(raw,spec.base);

    if(!href)return;

    let u=null;
    try{
      u=new URL(href);
    }catch{
      return;
    }

    if(!spec.accepts(u))return;
    if(seen.has(href))return;
    seen.add(href);

    const root=japanCandidateRoot($,el);

    const alt=$(el).find('img').first().attr('alt')||'';

    const text=$(el)
      .text()
      .replace(/\s+/g,' ')
      .trim();

    const blob=root
      .text()
      .replace(/\s+/g,' ')
      .trim();

    const title=(
      alt||
      $(el).attr('title')||
      text||
      blob
    ).replace(/\s+/g,' ').trim();

    if(!title||title.length<2)return;

    out.push({
      href,
      title,
      blob,
      price:parseYen(blob),
      img:japanCardImage($,el,root,spec.base)
    });
  });

  return out;
}

// Precios en yenes de las respuestas del buscador de Mercari, por anuncio.
function mercariSearchApiPrices(apiResponses){
  const prices=new Map();
  for(const json of apiResponses||[]){
    for(const it of Array.isArray(json?.items)?json.items:[]){
      const id=String(it?.id||'').trim();
      const price=Number(it?.price);
      if(!id||!Number.isFinite(price)||price<=0)continue;
      prices.set(/^m\d+$/i.test(id)?id:`shops-${id}`,price);
    }
  }
  return prices;
}

async function japanEnrichCandidate(spec,candidate,searchMeta,browserContext){
  const snap=spec.mode==='browser'
    ? await japanBrowserSnapshot(
        browserContext,
        candidate.href,
        spec.detailWaitMs||900,
        0,
        spec.detailApi||null
      )
    : await japanHttpSnapshot(candidate.href);

  if(snap.status>=400){
    throw new Error(`HTTP ${snap.status}`);
  }

  const $=loadHtml(snap.html);
  const oneMap=spec.id==='yahoo-auctions-jp'?parseOneMapDetail(snap.html):null;
  const product=japanFindJsonLdProduct($);
  const offer=japanOffer(product);

  const ogTitle=$('meta[property="og:title"]').attr('content')||'';
  const h1=$('h1').first().text().replace(/\s+/g,' ').trim();

  // El aviso antibots de la página ("Confirme que es humano") no es el título.
  const botText=BOT_CHECK_TEXT;
  let title=String(
    [product?.name,ogTitle,h1,candidate.title,snap.title].map(x=>String(x||'').trim()).find(x=>x&&!botText.test(x))||''
  ).replace(/\s+/g,' ').trim();

  title=title
    .replace(/\s+\|\s+フリマアプリ\s+ラクマ.*$/i,'')
    .replace(/\s+-\s+メルカリ.*$/i,'')
    .trim();

  const description=String(
    product?.description||
    $('meta[property="og:description"]').attr('content')||
    candidate.blob||
    snap.body||
    ''
  ).trim();

  // Mercari: primero el precio en yenes de su API (ficha y buscador); el
  // texto de la página puede venir convertido a euros.
  const detailApiPrice=(snap.api||[])
    .map(json=>Number(json?.data?.price))
    .find(value=>Number.isFinite(value)&&value>0);
  const price=detailApiPrice??candidate.apiPrice??japanYenPrice(
    spec.id,
    product,
    snap.body,
    candidate
  );

  const image=
    japanProductImage(product)||
    $('meta[property="og:image"]').attr('content')||
    candidate.img||
    '';

  const publication=japanPublicationFor(
    spec.id,
    snap.body
  );

  const arrival=spec.id==='komehyo-jp'
    ? japanInventoryArrival(
        `${candidate.blob||''} ${snap.body||''}`
      )
    : null;

  const seller=
    String(
      offer?.seller?.name||
      ''
    ).trim();

  const sourceId=japanSourceId(
    spec.id,
    candidate.href
  );

  const status=/SOLD OUT|売り切れ|売切れ/i.test(snap.body)
    ? 'sold'
    : '';

  return {
    source:spec.id,
    source_id:sourceId,
    url:candidate.href,
    title,
    description:oneMap?.condition?`${description}\nItem condition: ${oneMap.condition}`:description,
    original_price:price,
    currency:'JPY',
    price_eur:price==null?null:toEur(price,'JPY'),
    seller_name:seller||oneMap?.seller||'',
    seller_reviews:oneMap?.positiveRatings!=null||oneMap?.negativeRatings!=null
      ? Number(oneMap.positiveRatings||0)+Number(oneMap.negativeRatings||0):null,
    image_url:image,
    status,
    purchase_via:spec.purchaseVia,
    publishedAt:publication?.publishedAt||null,
    raw:{
      query:searchMeta.query,
      searchUrl:searchMeta.searchUrl,
      searchMode:spec.mode,
      sourceLabel:spec.label,
      oneMapSeller:oneMap?{type:oneMap.sellerType,positiveRatings:oneMap.positiveRatings,negativeRatings:oneMap.negativeRatings}:null,
      images:oneMap?.images?.length?oneMap.images:undefined,
      purchaseVia:spec.purchaseVia,
      detailHttpStatus:snap.status,
      finalUrl:snap.finalUrl,
      cardText:candidate.blob,
      publishedAt:publication?.publishedAt||null,
      publicationRaw:publication?.raw||null,
      publicationProvenance:publication?.provenance||null,
      inventoryArrival:arrival,
      inventoryArrivalIsPublication:false,
      newlyPosted:Boolean(
        publication?.publishedAt&&
        Date.now()-Date.parse(publication.publishedAt)<24*60*60*1000
      )
    }
  };
}

async function searchJapanSource(
  spec,
  {
    queries,
    maxItems=30,
    minEur=null,
    maxEur=null,
    sessionId,
    personalOnly=false
  },
  browserContext
){
  const maxQueries=clampInt(
    process.env.BUYEE_MAX_QUERIES||2,
    2,
    1,
    4
  );

  const selected=(queries||[])
    .map(x=>String(x||'').trim())
    .filter(Boolean)
    .slice(0,maxQueries);

  const sourceLimit=Math.min(
    Number(maxItems)||30,
    spec.cap
  );

  const seen=new Set();
  const perQuery=[];

  let kept=0;
  let withPublicationDate=0;
  let knownSkipped=0;
  let detailErrors=0;
  let successfulQueries=0;
  let noPrice=0;

  if(spec.mode==='browser'&&!browserContext){
    return {
      ok:false,
      source:spec.id,
      label:spec.label,
      purchaseVia:spec.purchaseVia,
      mode:spec.mode,
      kept:0,
      withPublicationDate:0,
      detailErrors:0,
      perQuery:[],
      error:'Playwright browser unavailable'
    };
  }

  for(const q of selected){
    const searchUrl=spec.searchUrl(q);

    let snap=null;
    let candidates=[];

    try{
      snap=spec.mode==='browser'
        ? await japanBrowserSnapshot(
            browserContext,
            searchUrl,
            spec.searchWaitMs||2500,
            spec.scrollSteps||0,
            spec.searchApi||null
          )
        : await japanHttpSnapshot(searchUrl);

      if(snap.status>=400){
        throw new Error(`HTTP ${snap.status}`);
      }

      successfulQueries++;

      candidates=japanCollectCandidates(
        spec,
        snap.html
      );

      if(spec.searchApi){
        const apiPrices=mercariSearchApiPrices(snap.api);
        for(const candidate of candidates){
          const apiPrice=apiPrices.get(japanSourceId(spec.id,candidate.href));
          if(apiPrice)candidate.apiPrice=apiPrice;
        }
      }

      if(spec.id==='mercari-jp'&&personalOnly){
        candidates=candidates.filter(
          x=>/^https:\/\/jp\.mercari\.com\/item\/m/i.test(x.href)
        );
      }

      let local=0;
      // Ya visto hace poco y con el mismo precio: no se vuelve a abrir la
      // ficha (Mercari tardaba 11-19 min por modelo abriéndolas todas); solo
      // se marca como visto. Las nuevas se abren de JAPAN_DETAIL_CONCURRENCY en
      // JAPAN_DETAIL_CONCURRENCY (3) a la vez.
      const knownStmt=db.prepare('SELECT id,original_price,price_eur,status,description,last_seen FROM listings WHERE source=? AND source_id=?');
      const knownHours=Number(process.env.JAPAN_KNOWN_HOURS||48);
      const inRange=pe=>{
        if(!Number.isFinite(pe))return true;
        if(minEur!==null&&minEur!==undefined&&minEur!==''&&Number.isFinite(Number(minEur))&&pe<Number(minEur))return false;
        if(maxEur!==null&&maxEur!==undefined&&maxEur!==''&&Number.isFinite(Number(maxEur))&&pe>Number(maxEur))return false;
        return true;
      };
      const toDetail=[];
      for(const candidate of candidates){
        if(kept+toDetail.length>=sourceLimit)break;
        const sourceId=japanSourceId(spec.id,candidate.href);
        const dedupeKey=`${spec.id}:${sourceId}`;
        if(seen.has(dedupeKey))continue;
        seen.add(dedupeKey);
        const known=spec.mode==='browser'?knownStmt.get(spec.id,String(sourceId)):null;
        const recent=known&&Date.now()-Date.parse(known.last_seen||0)<=knownHours*3600e3;
        const samePrice=!candidate.apiPrice||Number(known?.original_price)===Number(candidate.apiPrice);
        if(recent&&samePrice&&known.status!=='sold'&&String(known.description||'').trim()&&Number(known.original_price)>0){
          if(!inRange(Number(known.price_eur)))continue;
          db.prepare('UPDATE listings SET last_seen=? WHERE id=?').run(new Date().toISOString(),known.id);
          if(sessionId)db.prepare(`INSERT INTO search_session_items(session_id,listing_id,source_query) VALUES(?,?,?)
            ON CONFLICT(session_id,listing_id) DO UPDATE SET source_query=excluded.source_query`).run(sessionId,known.id,q);
          local++;kept++;knownSkipped++;
          continue;
        }
        toDetail.push(candidate);
      }
      const conc=spec.mode==='browser'?clampInt(process.env.JAPAN_DETAIL_CONCURRENCY||3,3,1,6):1;
      let next=0;
      const worker=async()=>{
        while(next<toDetail.length){
          const candidate=toDetail[next++];
          let item=null;
          try{
            item=await japanEnrichCandidate(spec,candidate,{query:q,searchUrl},browserContext);
          }catch{
            detailErrors++;
            continue;
          }
          if(item.status==='sold')continue;
          // Sin precio fiable no se guarda: un anuncio a 0 € daría un
          // beneficio falso y avisos que no lo son.
          if(!(Number(item.original_price)>0)){
            noPrice++;
            continue;
          }
          const pe=item.price_eur==null?null:Number(item.price_eur);
          if(!inRange(pe))continue;
          upsertListing(item,sessionId,q);
          local++;
          kept++;
          if(item.publishedAt)withPublicationDate++;
        }
      };
      await Promise.all(Array.from({length:Math.min(conc,toDetail.length)},worker));

      perQuery.push({
        query:q,
        count:local,
        candidateAnchors:candidates.length,
        searchUrl,
        httpStatus:snap.status,
        finalUrl:snap.finalUrl
      });
    }catch(e){
      perQuery.push({
        query:q,
        count:0,
        candidateAnchors:0,
        searchUrl,
        httpStatus:snap?.status??null,
        finalUrl:snap?.finalUrl??searchUrl,
        error:e.message
      });
    }
  }

  const ok=successfulQueries>0;

  return {
    ok,
    source:spec.id,
    label:spec.label,
    purchaseVia:spec.purchaseVia,
    mode:spec.mode,
    kept,
    knownSkipped,
    withPublicationDate,
    detailErrors,
    noPrice,
    perQuery,
    error:ok?null:'No accessible search query succeeded'
  };
}

async function searchJapanRadarLive(opts){
  const perSource={};
  let kept=0;
  let withPublicationDate=0;

  let browser=null;
  let browserContext=null;
  let browserError=null;
  const contextOptions={locale:'ja-JP',userAgent:JAPAN_HTTP_HEADERS['user-agent']};

  // Mercari necesita un navegador para cargar los anuncios con JavaScript.
  const activeSpecs=japanSearchSpecs();
  if(!opts.auctionLane&&activeSpecs.some(spec=>spec.mode==='browser'))try{
    const {chromium}=await import('playwright');

    browser=await chromium.launch({
      headless:process.env.ONEMAP_HEADED!=='1'
    });
    browserContext=await browser.newContext(contextOptions);
  }catch(e){
    browserError=e.message;
  }

  try{
    if(!opts.fastLane)try{
      // Yahoo Subastas solo por One Map (FROM JAPAN) desde el Chrome del Mac.
      // Sin el Mac no se busca: ni ReefAPI ni One Map desde la nube (vacía).
      const bridgeToken=String(process.env.ONEMAP_MAC_BRIDGE_TOKEN||'').trim();
      const macReady=bridgeToken&&await macOneMapReady(bridgeToken);
      let result;
      if(macReady){
        result=await searchOneMapAuctions(opts,{macBridgeToken:bridgeToken});
        result.mode='mac-chrome';
      }else result={ok:false,kept:0,perQuery:[],error:bridgeToken?'el Chrome del Mac no está disponible':'puente del Mac sin configurar'};
      if(!result.ok)console.warn(`Yahoo Auctions search failed: ${result.error||'unknown error'}`);
      perSource['yahoo-auctions-jp']={
        ...result,
        accountStatus:macReady?'mac-chrome':'off'
      };
      kept+=Number(result.kept||0);
    }catch(e){
      perSource['yahoo-auctions-jp']={ok:false,kept:0,error:e.message};
    }
    for(const spec of (opts.auctionLane?[]:activeSpecs)){
      try{
        const result=await searchJapanSource(
          spec,
          opts,
          browserContext
        );

        if(
          spec.mode==='browser'&&
          !browserContext&&
          browserError
        ){
          result.error=browserError;
        }

        perSource[spec.id]=result;
        kept+=Number(result.kept||0);
        withPublicationDate+=Number(
          result.withPublicationDate||0
        );
      }catch(e){
        perSource[spec.id]={
          ok:false,
          source:spec.id,
          label:spec.label,
          purchaseVia:spec.purchaseVia,
          mode:spec.mode,
          kept:0,
          withPublicationDate:0,
          detailErrors:0,
          perQuery:[],
          error:e.message
        };
      }
    }
  }finally{
    if(browserContext){
      await browserContext.close().catch(()=>{});
    }

    if(browser){
      await browser.close().catch(()=>{});
    }
  }

  db.prepare(
    'INSERT INTO runs(source,kind,summary,created_at) VALUES(?,?,?,?)'
  ).run(
    'buyee',
    'japan-multisource-search',
    `Sources ${Object.keys(perSource).length}; kept ${kept}; dated ${withPublicationDate}`,
    new Date().toISOString()
  );

  return {
    ok:Object.values(perSource).some(x=>x.ok),
    radar:'japan-multisource-v2',
    kept,
    withPublicationDate,
    perSource
  };
}

// POSITIVE MARKET VERIFICATION V1.6
const CENTRAL_AI_INSTRUCTION = `You are the first-pass central AI screening engine for Luxury Hunter. Analyze this second-hand luxury handbag listing conservatively for resale in Europe. First verify that the listing appears to match the target product family; search-query similarity is not proof. The user's task requirements below are mandatory evaluation context. Never certify authenticity from photos alone.

RESALE REFERENCE: when estimating the European resale price, use Vestiaire Collective prices as the primary reference (Nil resells against Vestiaire). Other resellers (Collector Square, The RealReal, Fashionphile, eBay...) are secondary evidence used to confirm or adjust. WATCHES are the exception: for watch tasks Nil resells on Chrono24 as a private seller, so Chrono24 prices for the exact reference (same reference number, similar year, condition and box/papers) are the primary resale reference; Watchfinder and similar dealers are secondary.

EXOTIC SKIN POLICY (mandatory): if the title, description or photos indicate genuine exotic leather (crocodile, alligator, caiman, python or other snake, ostrich, lizard, stingray/galuchat, eel), decision MUST be REJECT with the reason "piel exótica (CITES)". Embossed/printed calf leather imitating these is NOT exotic.

AUTHENTICITY RISK STABILITY RULES:
- An implausibly low price is an authenticity RISK SIGNAL, but price alone is NOT sufficient evidence for HIGH authenticity risk or REJECT.
- Missing seller sales, reviews or public history is a risk signal, but is NOT sufficient by itself, or combined only with a low price, to justify HIGH authenticity risk.
- The fact that a model is frequently counterfeited is contextual risk only and is NOT sufficient evidence for HIGH authenticity risk.
- When the product appears to match the target and the authenticity concerns are circumstantial or uncertain, use at most MEDIUM authenticity risk and prefer WATCH so that the exact-model and live-market verification stages can investigate it.
- Use HIGH authenticity risk at the preliminary stage only when there is concrete listing-specific evidence of a serious authenticity problem, such as explicit replica/fake/counterfeit language, a failed marketplace verification, a seller explicitly refusing verification while disclaiming authenticity, clear visual/product inconsistencies strongly incompatible with the claimed item, or similarly strong grounded evidence.
- A clearly wrong product, explicit counterfeit/replica listing, failed marketplace verification, or other objective disqualifier may be REJECT immediately.
- Marketplace verification AVAILABLE is a positive risk-reduction signal only, never proof of authenticity. PASSED is stronger positive evidence. FAILED is disqualifying.
- Do not invent authenticity defects that are not visible or grounded in the listing evidence.

Luxury Hunter calculates import/shipping/tax costs deterministically and supplies the IMPORTED TOTAL; use that supplied total as landed_cost_eur and DO NOT invent a different import-cost figure. This is ONLY the preliminary screen. Any preliminary WATCH, BUY or STRONG BUY will be blocked from final publication until a second visual exact-model check and a live market-comparable check are completed.

Return ONLY valid JSON with keys: brand, model, authenticity_risk (LOW|MEDIUM|HIGH), liquidity (LOW|MEDIUM|HIGH), decision (STRONG BUY|BUY|WATCH|REJECT), opportunity_score (0-100), resale_low_eur, resale_high_eur, landed_cost_eur, net_profit_low_eur, net_profit_high_eur, decision_reasons_es, notes.

decision_reasons_es MUST be an array of 1 to 4 short bullet-style reasons written in Spanish. For REJECT, make the reasons specific, practical and grounded in concrete evidence. If the item plausibly matches the target but evidence is insufficient mainly because authenticity, exact variant or market value still requires verification, prefer WATCH rather than REJECT. Never invent facts.`

const POSITIVE_DECISIONS = new Set(['WATCH','BUY','STRONG BUY']);

function clampNum(v,min=0,max=100){
  const n=Number(v);
  if(!Number.isFinite(n)) return min;
  return Math.max(min,Math.min(max,n));
}
// GEMINI JSON RESILIENCE V1.7.1
function firstBalancedJsonObject(raw){
  const s=String(raw||'');
  let start=-1,depth=0,inString=false,escape=false;
  for(let i=0;i<s.length;i++){
    const ch=s[i];
    if(start<0){
      if(ch==='{'){start=i;depth=1}
      continue;
    }
    if(inString){
      if(escape){escape=false;continue}
      if(ch==='\\'){escape=true;continue}
      if(ch==='"'){inString=false}
      continue;
    }
    if(ch==='"'){inString=true;continue}
    if(ch==='{')depth++;
    else if(ch==='}'){
      depth--;
      if(depth===0)return s.slice(start,i+1);
    }
  }
  return '';
}
function parseJsonLoose(raw){
  const s=String(raw||'').replace(/^\uFEFF/,'').trim();
  if(!s)throw new Error('Gemini returned an empty response.');

  const candidates=[s];
  const fenced=s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if(fenced?.[1])candidates.push(fenced[1].trim());

  const balanced=firstBalancedJsonObject(s);
  if(balanced)candidates.push(balanced);

  const a=s.indexOf('{'),b=s.lastIndexOf('}');
  if(a>=0&&b>a)candidates.push(s.slice(a,b+1));

  const seen=new Set();
  for(const candidate0 of candidates){
    const candidate=String(candidate0||'').trim();
    if(!candidate||seen.has(candidate))continue;
    seen.add(candidate);
    try{return JSON.parse(candidate)}catch{}

    const noTrailingComma=candidate.replace(/,\s*([}\]])/g,'$1');
    if(noTrailingComma!==candidate){
      try{return JSON.parse(noTrailingComma)}catch{}
    }
  }
  throw new Error('Gemini did not return valid JSON.');
}
function numberOrNull(value){
  if(value===null||value===undefined||value==='')return null;
  const n=Number(value);
  return Number.isFinite(n)?n:null;
}
function percentile(values,p){
  const a=(values||[]).map(Number).filter(Number.isFinite).sort((x,y)=>x-y);
  if(!a.length) return null;
  if(a.length===1) return a[0];
  const i=(a.length-1)*p, lo=Math.floor(i), hi=Math.ceil(i);
  if(lo===hi)return a[lo];
  return a[lo]+(a[hi]-a[lo])*(i-lo);
}
function weightedMean(entries){
  const rows=(entries||[])
    .map(x=>({
      value:Number(x?.value),
      weight:Number(x?.weight)
    }))
    .filter(x=>
      Number.isFinite(x.value) &&
      Number.isFinite(x.weight) &&
      x.weight>0
    );

  if(!rows.length)return null;

  const totalWeight=rows.reduce(
    (sum,x)=>sum+x.weight,
    0
  );

  if(!(totalWeight>0))return null;

  return rows.reduce(
    (sum,x)=>sum+(x.value*x.weight),
    0
  )/totalWeight;
}

function weightedPercentile(entries,p){
  const rows=(entries||[])
    .map(x=>({
      value:Number(x?.value),
      weight:Number(x?.weight)
    }))
    .filter(x=>
      Number.isFinite(x.value) &&
      Number.isFinite(x.weight) &&
      x.weight>0
    )
    .sort((a,b)=>a.value-b.value);

  if(!rows.length)return null;

  const q=Math.max(
    0,
    Math.min(1,Number(p)||0)
  );

  const totalWeight=rows.reduce(
    (sum,x)=>sum+x.weight,
    0
  );

  const target=totalWeight*q;
  let cumulative=0;

  for(const row of rows){
    cumulative+=row.weight;
    if(cumulative>=target){
      return row.value;
    }
  }

  return rows[rows.length-1].value;
}

// VESTIAIRE SNAPSHOT V1: precios pedidos en Vestiaire que Nil captura a mano
// (data/vestiaire-refs.json en local; en la nube viaja cifrado dentro de
// cloud/config.json). Se da a la IA como referencia de mercado de Vestiaire.
let vestiaireRefsCache=null;
function vestiaireFileRefs(){
  const base=path.dirname(fileURLToPath(import.meta.url));
  for(const [file,pick] of [[path.join(base,'data','vestiaire-refs.json'),j=>j],[path.join(base,'cloud','config.json'),j=>j.vestiaire_refs]]){
    try{const j=pick(JSON.parse(fs.readFileSync(file,'utf8')));if(j?.tasks)return j;}catch{}
  }
  return {tasks:{}};
}
// La hoja de Nil manda: cada pestaña que se puede leer sustituye a la copia
// fija de esa tarea; las tareas sin pestaña siguen con la copia fija.
function vestiaireRefs(){
  if(vestiaireRefsCache)return vestiaireRefsCache;
  // La base es la hoja de Google Drive (decisión de Nil): con ella leída no se
  // mezcla la copia fija del repositorio, que solo sirve si nunca se leyó.
  const file=vestiaireFileRefs();
  vestiaireRefsCache=vestiaireSheetCache?.tasks
    ? {...file,tasks:{...vestiaireSheetCache.tasks}}
    : file;
  return vestiaireRefsCache;
}

// ── VESTIAIRE SHEET V1 ───────────────────────────────────────────────────
// Base de datos propia de Nil en Google Sheets ("Vestiaire – Base de datos").
// Se lee con la API de Google Sheets (cuenta de servicio con permiso de
// lectura en la hoja) y se refresca cada VESTIAIRE_SHEET_REFRESH_MIN minutos.
// Si falla, se sigue con la última lectura buena o con la copia fija.
const VESTIAIRE_SHEET_TAB_TASK={'balenciaga fotos':'Balenciaga Le City','balenciaga le city':'Balenciaga Le City'};
const sheetKey=t=>String(t||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase();
const VESTIAIRE_SHEET_REFRESH_MS=Math.max(5,Number(process.env.VESTIAIRE_SHEET_REFRESH_MIN||30))*60e3;
let vestiaireSheetCache=null;
let vestiaireSheetPromise=null;
let vestiaireSheetReadFailed=false;
function vestiaireSheetFresh(){
  return !vestiaireSheetReadFailed&&!!vestiaireSheetCache&&Date.now()-vestiaireSheetCache.loadedAt<VESTIAIRE_SHEET_REFRESH_MS;
}
// Recheck cached positive decisions without new AI/API searches. Historical
// analyses must not keep a BUY obtained with another size or an old snapshot.
function revalidateStoredBagBuys(){
  for(const table of ['task_analyses','analyses']){
    const tasks=table==='task_analyses';
    const rows=db.prepare(`SELECT a.*,l.title,l.description,${tasks?'t.task_name':"'' AS task_name"}
      FROM ${table} a JOIN listings l ON l.id=a.listing_id
      ${tasks?'LEFT JOIN tasks t ON t.id=a.task_id':''}
      WHERE a.decision IN ('BUY','STRONG BUY','WATCH')`).all();
    const update=db.prepare(`UPDATE ${table} SET decision=?,opportunity_score=?,resale_low_eur=?,resale_high_eur=?,net_profit_low_eur=?,net_profit_high_eur=?,decision_reasons_es_json=?,raw_json=?,verification_json=? WHERE id=?`);
    for(const row of rows){
      if(isWatchTask(row.task_name))continue;
      let v={},raw={};try{v=JSON.parse(row.verification_json||'{}');raw=JSON.parse(row.raw_json||'{}');}catch{}
      // Los análisis nuevos (referencias elegidas por la IA) ya llevan su precio: no se tocan.
      if(v.match_version)continue;
      const comps=vestiaireComparables({task_name:row.task_name},row,v.exact||{brand:row.brand,family:row.model});
      let a={...raw,decision:row.decision,opportunity_score:row.opportunity_score,
        resale_low_eur:row.resale_low_eur,resale_high_eur:row.resale_high_eur,
        net_profit_low_eur:row.net_profit_low_eur,net_profit_high_eur:row.net_profit_high_eur,
        decision_reasons_es:parseJsonArray(row.decision_reasons_es_json,[])};
      delete a.market_verification;
      if(v.final)delete v.final.market_verification;
      if(v.status==='verified'&&v.exact&&v.market){
        v.market={...v.market,sheet_comps:comps,sheet_anchor:comps,bag_sheet_required:true,sheet_fresh:vestiaireSheetFresh()};
        const revised=finalizeVerifiedOpportunity({...a,authenticity_risk:row.authenticity_risk,liquidity:row.liquidity},v.exact,v.market,{importedTotalEur:row.landed_cost_eur},v.marketplace_verification);
        // A cache refresh may downgrade, never issue a new purchase recommendation.
        const rank={'REJECT':0,'REVIEW':1,'WATCH':2,'BUY':3,'STRONG BUY':4};
        if(rank[revised.decision]>rank[row.decision])revised.decision=row.decision;
        a={...a,...revised};
      }
      a=applyBagSheetPolicy(a,comps,{fresh:vestiaireSheetFresh()&&v.status==='verified'});
      if(v.auction){
        // Recomputing a live bid requires fresh auction data. Invalidate an old
        // cap when its valuation/evidence changed, instead of retaining it.
        if(!comps?.buy_eligible||!vestiaireSheetFresh()||a.resale_low_eur!==row.resale_low_eur){
          v.auction={...v.auction,max_bid_eur:null,max_bid_local:null,resale_from_db:false};
          if(['BUY','STRONG BUY'].includes(a.decision))a.decision='WATCH';
          a.decision_reasons_es=['CONSULTAR PRECIO: revisar la puja máxima con la nueva valoración de Sheets.',...(a.decision_reasons_es||[])].slice(0,5);
        }
      }
      v.bag_sheet_rule_version=BAG_SHEET_RULE_VERSION;
      v.market={...(v.market||{}),sheet_comps:comps,sheet_fresh:vestiaireSheetFresh(),bag_sheet_required:true};
      if(v.final)v.final={...v.final,...a};
      a.market_verification=v;
      update.run(a.decision,numberOrNull(a.opportunity_score),numberOrNull(a.resale_low_eur),numberOrNull(a.resale_high_eur),numberOrNull(a.net_profit_low_eur),numberOrNull(a.net_profit_high_eur),JSON.stringify(a.decision_reasons_es||[]),JSON.stringify(a),JSON.stringify(v),row.id);
    }
  }
}
let googleSheetsToken=null;
let googleSheetsWriteToken=null;

// Clave de la cuenta de servicio: en la nube va en el secreto; en el Mac, en
// un archivo (GOOGLE_SHEETS_SA_FILE, carpeta private/ que no se sube a git).
function googleSheetsSaRaw(){
  const inline=String(process.env.GOOGLE_SHEETS_SA_JSON||'').trim();
  if(inline)return inline;
  const file=String(process.env.GOOGLE_SHEETS_SA_FILE||'').trim();
  if(file){try{return fs.readFileSync(file,'utf8').trim();}catch{}}
  return '';
}
function vestiaireSheetConfigured(){
  return !!(String(process.env.VESTIAIRE_SHEET_ID||'').trim()&&(googleSheetsSaRaw()||String(process.env.GOOGLE_SHEETS_API_KEY||'').trim()));
}
// write=true pide permiso de escritura (solo para la hoja de oportunidades).
async function googleSheetsAuth(write=false){
  const raw=googleSheetsSaRaw();
  if(!raw)return {query:`key=${encodeURIComponent(String(process.env.GOOGLE_SHEETS_API_KEY||'').trim())}`,headers:{}};
  const cached=write?googleSheetsWriteToken:googleSheetsToken;
  if(cached&&cached.exp>Date.now()+60e3)return {query:'',headers:{authorization:`Bearer ${cached.token}`}};
  const sa=JSON.parse(raw);
  const now=Math.floor(Date.now()/1000);
  const b64=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
  const scope=write?'https://www.googleapis.com/auth/spreadsheets':'https://www.googleapis.com/auth/spreadsheets.readonly';
  const unsigned=`${b64({alg:'RS256',typ:'JWT'})}.${b64({iss:sa.client_email,scope,aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600})}`;
  const sig=createSign('RSA-SHA256').update(unsigned).sign(sa.private_key,'base64url');
  const r=await fetch('https://oauth2.googleapis.com/token',{
    method:'POST',
    headers:{'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:`${unsigned}.${sig}`}),
    signal:AbortSignal.timeout(20000)
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok||!j.access_token)throw new Error(`Google token: ${j.error_description||j.error||r.status}`);
  const token={token:j.access_token,exp:Date.now()+Number(j.expires_in||3600)*1000};
  if(write)googleSheetsWriteToken=token;else googleSheetsToken=token;
  return {query:'',headers:{authorization:`Bearer ${j.access_token}`}};
}

// OPORTUNIDADES EN GOOGLE SHEETS
// Cada anuncio con nota de IA > 60 y precio válido se añade una sola vez a la
// hoja "Oportunidades Luxury Hunter" (OPPORTUNITIES_SHEET_ID) con el coste
// real puesto en España y la reventa. Cálculo de autónomo en el régimen de
// bienes usados (REBU): el IVA de importación se paga y forma parte del coste,
// y al vender se paga el 21 % sobre el margen (IVA incluido: margen × 21/121).
// Las columnas de venta son fórmulas: si cambias el precio de venta sugerido,
// la comisión, el IVA y el beneficio se recalculan.
const OPPORTUNITY_SHEET_MIN_SCORE=60;
const OPPORTUNITY_SOURCE_LABELS={
  'xianyu':'Xianyu','bunjang':'Bunjang','mercari-jp':'Mercari','rakuma-jp':'Rakuma','vestiaire':'Vestiaire Collective',
  'yahoo-auctions-jp':'Yahoo! Auctions','yahoo-fleamarket-jp':'Yahoo! Flea Market',
  '2ndstreet-jp':'2nd Street','komehyo-jp':'Komehyo','rakuten-jp':'Rakuten'
};
// En las subastas, el título lleva delante la puja máxima y cuándo termina.
function opportunityAuctionPrefix(r){
  let plan=null;try{plan=JSON.parse(r.verification_json||'{}')?.auction||null;}catch{}
  if(!plan)return '';
  const ends=Date.parse(plan.ends_at||'');
  const when=Number.isFinite(ends)?new Date(ends).toLocaleString('es-ES',{timeZone:'Europe/Madrid',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'';
  return plan.max_bid_eur>0
    ? `🔨 SUBASTA · puja máx. ${plan.max_bid_local!=null?`${plan.max_bid_local} ${plan.currency}`:''} (≈${Math.round(plan.max_bid_eur)} €)${when?` · termina ${when}`:''} · `
    : '🔨 SUBASTA (sin puja rentable) · ';
}
function opportunitySheetRow(r){
  const c=importEconomics(r);
  const text=v=>{const s=String(v??'').replace(/\s+/g,' ').trim();return /^[=+\-@]/.test(s)?`'${s}`:s;};
  const money=v=>Number.isFinite(Number(v))?roundMoney(Number(v)):'';
  const d=new Date(r.analyzed_at||Date.now());
  const p=Object.fromEntries(new Intl.DateTimeFormat('es-ES',{timeZone:'Europe/Madrid',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(d).map(x=>[x.type,x.value]));
  const source=String(r.source||'');
  const web=OPPORTUNITY_SOURCE_LABELS[source]||(source.startsWith('ebay-')?`eBay ${source.slice(5).toUpperCase()}`:source);
  const low=Number(r.resale_low_eur), high=Number(r.resale_high_eur);
  const mid=[low,high].filter(v=>Number.isFinite(v)&&v>0);
  const suggested=mid.length?Math.round(mid.reduce((a,b)=>a+b,0)/mid.length/10)*10:'';
  const col=letter=>`INDIRECT("${letter}"&ROW())`;
  const origin=Number(r.original_price);
  return [
    `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`,
    text(r.task_name), text(web), String(r.url||''), text(`${opportunityAuctionPrefix(r)}${String(r.title||'')}`.slice(0,160)),
    Number(r.opportunity_score)||'', text(r.decision), text(r.authenticity_risk),
    Number.isFinite(origin)&&origin>0?text(`${origin.toLocaleString('es-ES')} ${r.currency||''}`):'',
    money(c.productPriceEur), money(c.domesticShippingEur), money(c.agentFeeEur),
    money(c.paymentFeeEur+c.verificationFeeEur), money(c.internationalShippingEur),
    money(c.customsValueEur), c.customsDutyPercent, money(c.customsDutyEur), money(c.importVatEur),
    money(c.clearanceFeeEur), money(c.authenticationFeeEur), money(c.otherEur), money(c.importedTotalEur),
    Number.isFinite(low)&&low>0?Math.round(low):'', Number.isFinite(high)&&high>0?Math.round(high):'', suggested,
    `=${col('Y')}*${resalePlatform(r.task_name).fee}/100`,
    `=(${col('Y')}-${col('V')}+ABS(${col('Y')}-${col('V')}))/2*21/121`,
    `=${col('Y')}-${col('V')}-${col('Z')}-${col('AA')}`,
    `=ROUND(${col('AB')}/${col('V')}*100)`
  ];
}
async function syncOpportunitiesSheet(){
  const id=String(process.env.OPPORTUNITIES_SHEET_ID||'').trim();
  if(!id||!googleSheetsSaRaw())return {added:0,reason:'not_configured'};
  const since=new Date(Date.now()-72*3600e3).toISOString();
  const rows=db.prepare(`SELECT l.*,a.task_id,t.task_name,a.decision,a.opportunity_score,a.authenticity_risk,
      a.resale_low_eur,a.resale_high_eur,a.updated_at AS analyzed_at,a.verification_json
    FROM task_analyses a JOIN listings l ON l.id=a.listing_id JOIN tasks t ON t.id=a.task_id
    WHERE a.opportunity_score>? AND a.updated_at>=? AND COALESCE(l.price_eur,0)>0
      AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.listing_id=l.id AND n.kind='sheet')
    ORDER BY a.updated_at LIMIT 200`).all(OPPORTUNITY_SHEET_MIN_SCORE,since);
  const seen=new Set();
  const picks=rows.filter(r=>{
    if(seen.has(r.id))return false;
    if(r.source==='yahoo-auctions-jp'){
      const auction=listingAuction(r);
      let plan=null;
      try{plan=JSON.parse(r.verification_json||'{}')?.auction||null;}catch{}
      if(!auction?.live||!plan?.resale_from_db||
        !(Number(plan.max_bid_local)>Number(auction.currentBid))||
        !['STRONG BUY','BUY','WATCH'].includes(String(r.decision||'').toUpperCase()))return false;
    }
    seen.add(r.id);
    return true;
  });
  if(!picks.length)return {ok:true,added:0};
  const auth=await googleSheetsAuth(true);
  const url=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent('Oportunidades!A1')}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const r=await fetch(url,{method:'POST',headers:{...auth.headers,'content-type':'application/json'},
    body:JSON.stringify({values:picks.map(opportunitySheetRow)}),signal:AbortSignal.timeout(30000)});
  if(!r.ok)throw new Error(`Hoja de oportunidades HTTP ${r.status}: ${(await r.text()).slice(0,200)}`);
  const mark=db.prepare(`INSERT OR IGNORE INTO notifications(task_id,listing_id,run_id,kind,sent_to,sent_at) VALUES(?,?,NULL,'sheet','google-sheets',?)`);
  const now=new Date().toISOString();
  for(const x of picks)mark.run(Number(x.task_id),Number(x.id),now);
  console.log(`Hoja de oportunidades: ${picks.length} anuncio(s) añadidos.`);
  return {ok:true,added:picks.length};
}
function sheetNumber(v){
  if(typeof v==='number')return Number.isFinite(v)?v:null;
  const s=String(v??'').replace(/[€\s]/g,'');
  if(!s)return null;
  // Formato español: "1.155" = 1155; "1352,09" = 1352.09.
  const n=Number(/,/.test(s)?s.replace(/\./g,'').replace(',','.'):/^\d{1,3}(\.\d{3})+$/.test(s)?s.replace(/\./g,''):s);
  return Number.isFinite(n)?n:null;
}
function priceStats(list){
  const a=list.filter(Number.isFinite).sort((x,y)=>x-y);
  if(!a.length)return {n:0};
  const q=p=>a[Math.min(a.length-1,Math.max(0,Math.round((a.length-1)*p)))];
  return {n:a.length,min:Math.round(a[0]),p25:Math.round(q(0.25)),median:Math.round(q(0.5)),p75:Math.round(q(0.75)),max:Math.round(a[a.length-1])};
}
// Convierte una pestaña (fila 1 = cabecera) en fichas con el mismo formato
// que data/vestiaire-refs.json, más el estado de venta y el precio vendido.
// formulas: la misma pestaña leída como fórmulas, para sacar la foto
// (=IMAGE de Drive) y el enlace (=HYPERLINK) de cada fila.
const sheetFormulaUrl=v=>String(v||'').match(/^=\s*(?:IMAGE|HYPERLINK)\(\s*"(https?:\/\/[^"]+)"/i)?.[1]||null;
function vestiaireSheetTab(values,today,formulas=null){
  const head=(values[0]||[]).map(h=>String(h||'').trim().toLowerCase());
  const col=name=>head.indexOf(name);
  const c={photo:col('foto'),link:col('enlace'),brand:col('marca'),model:col('modelo'),likes:col('likes'),ref:col('referencia'),size:col('talla / tipo'),dims:col('medidas (cm)'),material:col('material'),color:col('color'),condition:col('estado'),price:col('precio €'),before:col('precio antes €'),country:col('país'),vintage:col('vintage'),welove:col('we love'),published:col('publicado'),notes:col('notas'),desc:col('descripción')>=0?col('descripción'):col('descripcion'),status:col('estado anuncio'),checked:col('comprobado el'),sold:col('precio venta €'),url:col('url')};
  if(c.ref<0||c.price<0)return null;
  const get=(row,i)=>i>=0?row[i]:'';
  const yes=v=>/^s[ií]|^yes|^true/i.test(String(v||'').trim());
  const fichas=[];
  values.slice(1).forEach((row,i)=>{
    const id=String(get(row,c.ref)||'').trim();
    if(!/^\d{5,10}$/.test(id))return;
    // "Referencia errónea": el número no lleva a ese bolso; no se usa.
    if(/err[oó]ne|incorrect/i.test(String(get(row,c.status)||'')))return;
    const fRow=formulas?.[i+1]||[];
    const link=sheetFormulaUrl(get(fRow,c.link));
    const sold=/vendido/i.test(String(get(row,c.status)||''));
    // "Eliminado (sin precio)": desapareció sin precio de venta; no es una
    // venta confirmada, cuenta como lo que pedía.
    // Lo mismo si figura vendido sin precio de venta (Chrono24 retira el
    // anuncio y no se sabe a cuánto se vendió).
    const removed=sold&&(/eliminad/i.test(String(get(row,c.sold)||''))||!Number.isFinite(sheetNumber(get(row,c.sold))));
    const askPrice=sheetNumber(get(row,c.price));
    let soldPrice=sheetNumber(get(row,c.sold));
    // Un precio de venta muy lejos del precio pedido suele ser una referencia
    // que apunta a otro artículo: no se usa como prueba de reventa.
    const soldSuspect=Number.isFinite(soldPrice)&&Number.isFinite(askPrice)&&askPrice>0&&(soldPrice<askPrice*0.3||soldPrice>askPrice*3);
    if(soldSuspect)soldPrice=null;
    fichas.push({
      id,
      brand:String(get(row,c.brand)||'').trim(),
      model:String(get(row,c.model)||'').trim(),
      size:String(get(row,c.size)||'').trim(),
      dims:String(get(row,c.dims)||'').trim(),
      material:String(get(row,c.material)||'').trim(),
      color:String(get(row,c.color)||'').trim(),
      condition:String(get(row,c.condition)||'').trim(),
      price_eur:askPrice,
      original_eur:sheetNumber(get(row,c.before)),
      country:String(get(row,c.country)||'').trim(),
      vintage:yes(get(row,c.vintage)),
      we_love:yes(get(row,c.welove)),
      published:String(get(row,c.published)||'').trim(),
      likes:sheetNumber(get(row,c.likes)),
      notes:String(get(row,c.notes)||'').trim().slice(0,200),
      desc:c.desc>=0?String(get(row,c.desc)||'').replace(/\s+/g,' ').trim().slice(0,400):'',
      checked:String(get(row,c.checked)||'').trim(),
      url:/^https?:\/\//.test(String(get(row,c.url)||''))?String(get(row,c.url)).trim():link&&link.includes(id)?link:`https://es.vestiairecollective.com/${id}.shtml`,
      photo:sheetFormulaUrl(get(fRow,c.photo)),
      sold:sold&&!removed,
      removed:removed||undefined,
      sold_price_eur:sold&&!removed?soldPrice:null,
      sold_price_suspect:soldSuspect||undefined,
      // Los vendidos no son anuncios a la venta: fuera de las comparables actuales.
      excluded:sold&&!removed
    });
  });
  const active=fichas.filter(f=>!f.excluded&&Number.isFinite(f.price_eur));
  const groups={};
  for(const f of active){
    const k=(f.size||'Sin talla').trim();
    (groups[k]||=[]).push(f.price_eur);
  }
  return {
    source:'sheet',
    captured_on:today,
    fichas,
    all:priceStats(active.map(f=>f.price_eur)),
    vintage:priceStats(active.filter(f=>f.vintage).map(f=>f.price_eur)),
    groups:Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,{label:k,...priceStats(v)}])),
    discounted_share:active.length?Math.round(active.filter(f=>Number.isFinite(f.original_eur)&&f.original_eur>f.price_eur).length/active.length*100):0,
    sold_stats:priceStats(fichas.filter(f=>f.sold&&Number.isFinite(f.sold_price_eur)).map(f=>f.sold_price_eur))
  };
}
function vestiaireSheetTaskName(tab){
  const key=sheetKey(tab);
  if(VESTIAIRE_SHEET_TAB_TASK[key])return VESTIAIRE_SHEET_TAB_TASK[key];
  const names=db.prepare('SELECT task_name FROM tasks').all().map(t=>t.task_name);
  return names.find(n=>sheetKey(n)===key)||names.find(n=>sheetKey(n).includes(key)||key.includes(sheetKey(n)))||null;
}
async function loadVestiaireSheet(){
  const id=String(process.env.VESTIAIRE_SHEET_ID||'').trim();
  const auth=await googleSheetsAuth();
  const q=extra=>[auth.query,extra].filter(Boolean).join('&');
  const base=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}`;
  const meta=await fetch(`${base}?${q('fields=sheets.properties(title,gridProperties)')}`,{headers:auth.headers,signal:AbortSignal.timeout(20000)});
  const mj=await meta.json().catch(()=>({}));
  if(!meta.ok)throw new Error(`Sheets: ${mj?.error?.message||meta.status}`);
  const properties=(mj.sheets||[]).map(s=>s.properties).filter(s=>s?.title);
  const titles=properties.map(s=>s.title);
  // Read every database tab, including models without a scheduled task.
  const tabs=titles.map(t=>({t,task:vestiaireSheetTaskName(t)||t}));
  if(!tabs.length)return {loadedAt:Date.now(),tasks:{},tabs:[]};
  const ranges=tabs.map(x=>{
    const grid=properties.find(p=>p.title===x.t)?.gridProperties||{};
    const n=Math.min(39,grid.columnCount||39);
    const endColumn=n<=26?String.fromCharCode(64+n):`A${String.fromCharCode(64+n-26)}`;
    return `ranges=${encodeURIComponent(`'${x.t.replace(/'/g,"''")}'!A1:${endColumn}${grid.rowCount||2000}`)}`;
  }).join('&');
  const r=await fetch(`${base}/values:batchGet?${q(`${ranges}&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`)}`,{headers:auth.headers,signal:AbortSignal.timeout(30000)});
  const j=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(`Sheets: ${j?.error?.message||r.status}`);
  // Las fórmulas, para la foto de cada fila (la IA la compara con el anuncio).
  let fj={};
  try{
    const fr=await fetch(`${base}/values:batchGet?${q(`${ranges}&valueRenderOption=FORMULA`)}`,{headers:auth.headers,signal:AbortSignal.timeout(30000)});
    if(fr.ok)fj=await fr.json();
  }catch(e){console.warn('Hoja de Vestiaire: sin fotos',e.message);}
  const today=new Date().toISOString().slice(0,10);
  const tasks={};
  (j.valueRanges||[]).forEach((vr,i)=>{
    const parsed=vestiaireSheetTab(vr.values||[],today,fj.valueRanges?.[i]?.values||null);
    if(parsed?.fichas?.length){
      // Preserve both tabs if several names map to the same task.
      const name=tasks[tabs[i].task]?(tasks[tabs[i].t]?`${tabs[i].task} · ${tabs[i].t}`:tabs[i].t):tabs[i].task;
      tasks[name]={...parsed,tab:tabs[i].t};
    }
  });
  return {loadedAt:Date.now(),tasks,tabs:tabs.map(x=>x.t)};
}
async function refreshVestiaireSheet({force=false}={}){
  if(!vestiaireSheetConfigured())return vestiaireSheetCache;
  if(!force&&vestiaireSheetCache&&Date.now()-vestiaireSheetCache.loadedAt<VESTIAIRE_SHEET_REFRESH_MS)return vestiaireSheetCache;
  if(vestiaireSheetPromise)return vestiaireSheetPromise;
  vestiaireSheetPromise=(async()=>{
    try{
      const fresh=await loadVestiaireSheet();
      vestiaireSheetCache=fresh;
      vestiaireSheetReadFailed=false;
      vestiaireRefsCache=null;
      const counts=Object.entries(fresh.tasks).map(([k,v])=>`${k} ${v.fichas.length}`).join(', ');
      console.log(`Hoja de Vestiaire leída: ${counts||'sin pestañas de tareas'}.`);
      clearHealthIssue?.('vestiaire-sheet');
    }catch(e){
      vestiaireSheetReadFailed=true;
      console.error('Hoja de Vestiaire no disponible, se usa la última lectura:',e.message);
      reportHealthIssue?.('vestiaire-sheet',`No se pudo leer la hoja de Vestiaire (${e.message}). El bot sigue con la última copia.`).catch?.(()=>{});
    }finally{
      vestiaireSheetPromise=null;
    }
    revalidateStoredBagBuys();
    return vestiaireSheetCache;
  })();
  return vestiaireSheetPromise;
}
const VESTIAIRE_SIZE_RE=[['Nano',/\bnano\b/i],['Part Time',/part\s?time/i],['Mini',/\bmini\b|\bmicro\b/i],['Small',/\bsmall\b|\bpetit\b|\bpetite\b|\bpeque/i],['Medium',/\bmedium\b|\bmediano\b|\bmoyen\b|中号/i],['Large',/\blarge\b|\bgrande\b|\bgrand\b|大号/i],['Bandolera',/bandolera|crossbody|messenger|shoulder strap/i]];
const VESTIAIRE_COLOR_RE=[['negro',/negro|black|noir|schwarz|黑/i],['blanco',/blanc|white|bianco|weiss|白/i],['marron',/marr[oó]n|brown|marron|braun|棕|咖/i],['azul',/azul|blue|bleu|blu|蓝/i],['rosa',/rosa|pink|rose|粉/i],['rojo',/rojo|red|rouge|rosso|红/i],['amarillo',/amarillo|yellow|jaune|giallo|黄/i],['verde',/verde|green|vert|verde|绿/i],['gris',/gris|grey|gray|grigio|灰/i],['plateado',/plateado|silver|argent|argento|银/i],['dorado',/dorado|gold|or\b|oro|金/i],['beige',/beige|crudo|nude|taupe|ecru|khaki|caqui/i]];
// Anchura (la medida mayor) en cm a partir de "28*6*18cm", "25x15x6", "23,5x16x8,5"...
function vestiaireWidthCm(text){
  const m=String(text||'').match(/(\d{1,2}(?:[.,]\d)?)\s*(?:cm)?\s*[x×*✕]\s*(\d{1,2}(?:[.,]\d)?)(?:\s*(?:cm)?\s*[x×*✕]\s*(\d{1,2}(?:[.,]\d)?))?/i);
  if(!m)return null;
  const nums=[m[1],m[2],m[3]].filter(Boolean).map(v=>Number(v.replace(',','.'))).filter(n=>n>0&&n<80);
  const w=nums.length?Math.max(...nums):null;
  return w&&w>=8?w:null;
}
function vestiaireSizeLabel(text){
  return (VESTIAIRE_SIZE_RE.find(([,re])=>re.test(String(text||'')))||[])[0]||null;
}
const sheetNorm=t=>String(t||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase();
function vestiaireMatchFichas(fichas,item,taskName=''){
  const text=`${item?.title||''} ${item?.description||''}`;
  const size=vestiaireSizeLabel(text);
  const width=vestiaireWidthCm(text);
  const colorOf=t=>(VESTIAIRE_COLOR_RE.find(([,re])=>re.test(t))||[])[0];
  const itemColor=colorOf(text);
  // Solo el mismo modelo que el anuncio; si no se sabe cuál es, ninguno.
  const pool=vestiaireSameModel(taskName,fichas.filter(f=>!f.excluded),item,null)?.rows||[];
  // Antes se ordenaba por cercanía al precio de COMPRA, que no dice nada del
  // precio de reventa: ahora cuentan la talla (medidas o etiqueta) y el color.
  const scored=pool.map(f=>{
    let score=0;
    const fw=vestiaireWidthCm(f.dims);
    if(width&&fw&&Math.abs(fw-width)/width<=0.12)score+=4;
    else if(size&&vestiaireSizeLabel(`${f.size} ${f.notes}`)===size)score+=3;
    if(itemColor&&colorOf(String(f.color||''))===itemColor)score+=2;
    if(f.vintage&&/vintage|vintag|古着|빈티지/i.test(text))score+=1;
    const dist=width&&fw?Math.abs(fw-width)/width:1;
    return {f,score,dist};
  });
  scored.sort((a,b)=>b.score-a.score||a.dist-b.dist||(b.f.likes||0)-(a.f.likes||0));
  const strong=scored.filter(x=>x.score>0).slice(0,12);
  return strong.length?strong:scored.slice(0,8);
}
// PRECIO DE REVENTA ANCLADO EN LA BASE DE DATOS DE NIL
// Con los anuncios de la misma talla (por medidas o etiqueta) y modelo de su
// hoja de Vestiaire, y el % al que se venden de verdad frente al precio pedido
// (ventas registradas en la hoja; 0,92 de media), sale una franja realista de
// venta. Sirve de techo para que la reventa sugerida no se dispare.
const VESTIAIRE_DEFAULT_REALIZATION=0.90; // vendido ≈ 90 % de lo pedido en la hoja de Nil (07-11-2026)
// Anchura (cm) de cada talla en los modelos principales, para cuando el
// anuncio dice la talla ("中号", "ミニ", "Medium"...) pero no las medidas.
const VESTIAIRE_FAMILY_SIZES=[
  [/chanel|classic flap/i,[['Mini',/\bmini\b|ミニ|迷你/i,17,21],['Small',/\bsmall\b|小号|スモール/i,22,24],['Jumbo',/jumbo|ジャンボ|大号/i,29,31],['Maxi',/maxi|マキシ/i,32,35],['Medium',/medium|中号|ミディアム/i,25,27]]],
  [/lady dior/i,[['Micro',/micro|マイクロ/i,11,13],['Mini',/\bmini\b|ミニ|迷你/i,16,18],['Small',/\bsmall\b|小号|スモール/i,19,21],['Medium',/medium|中号|ミディアム/i,23,25],['Large',/large|大号|ラージ/i,30,33]]],
  [/evelyne/i,[['TPM',/tpm|\b1[67]\b|mini|ミニ/i,15,19],['PM',/\bpm\b|\b29\b/i,27,30],['GM',/\bgm\b|\b33\b/i,32,35]]],
  [/saddle/i,[['Mini',/\bmini\b|ミニ|迷你/i,18,21],['Medium',/medium|中号|ミディアム|classic/i,24,27]]]
];
function vestiaireSheetAnchor(task,item,exact){
  if(!isWatchTask(task?.task_name))return vestiaireComparables(task,item,exact);
  const r=task?.task_name?vestiaireRefs().tasks?.[task.task_name]:null;
  if(!r||r.source!=='sheet'||!Array.isArray(r.fichas))return null;
  // Solo el mismo modelo que el anuncio; si no se sabe cuál es, no hay ancla.
  const m=vestiaireSameModel(task.task_name,r.fichas.filter(f=>Number.isFinite(f.price_eur)&&f.price_eur>0),item,exact);
  if(!m)return null;
  const pool=m.rows;
  const width=vestiaireWidthCm(`${item?.title||''} ${item?.description||''}`);
  const size=vestiaireSizeLabel(`${exact?.size||''} ${item?.title||''}`);
  let basis='';
  let matched=[];
  if(width){
    matched=pool.filter(f=>{const fw=vestiaireWidthCm(f.dims);return fw&&Math.abs(fw-width)/width<=0.12;});
    basis=`medidas ~${Math.round(width)} cm`;
  }
  const fam=(VESTIAIRE_FAMILY_SIZES.find(([re])=>re.test(task.task_name))||[])[1];
  const famSize=!width&&fam?fam.find(([,re])=>re.test(`${exact?.size||''} ${item?.title||''}`)):null;
  if(matched.length<4&&famSize){
    const [name,re,lo,hi]=famSize;
    matched=pool.filter(f=>{const fw=vestiaireWidthCm(f.dims);return fw?fw>=lo&&fw<=hi:re.test(`${f.size} ${f.notes}`);});
    basis=`talla ${name} (${lo}-${hi} cm)`;
  }
  if(matched.length<4&&size){
    matched=pool.filter(f=>vestiaireSizeLabel(`${f.size} ${f.notes}`)===size);
    basis=`talla ${size}`;
  }
  if(matched.length<4)return null;
  const ratios=r.fichas.filter(f=>f.sold&&Number.isFinite(f.sold_price_eur)&&f.price_eur>0).map(f=>f.sold_price_eur/f.price_eur).filter(x=>x>0.4&&x<1.6).sort((a,b)=>a-b);
  const ratio=ratios.length>=5?clampNum(ratios[Math.floor(ratios.length/2)],0.75,1):VESTIAIRE_DEFAULT_REALIZATION;
  const values=[
    ...matched.filter(f=>!f.excluded).map(f=>f.price_eur*ratio),
    ...matched.filter(f=>f.sold&&Number.isFinite(f.sold_price_eur)).map(f=>f.sold_price_eur)
  ].sort((a,b)=>a-b);
  if(values.length<4)return null;
  const q=p=>values[Math.min(values.length-1,Math.max(0,Math.round((values.length-1)*p)))];
  return {n:values.length,basis,ratio:Math.round(ratio*100)/100,low:Math.round(q(0.25)),mid:Math.round(q(0.5)),high:Math.round(q(0.75))};
}
// Ajusta una franja de reventa al ancla de la hoja: nunca por encima de lo que
// se vende de verdad (la baja no pasa de la mediana realista y la alta no pasa
// del p75 realista). Si la evidencia propia es más baja, se respeta.
function clampResaleToAnchor(low,high,anchor){
  if(!anchor)return {low,high,changed:false};
  const l=Number.isFinite(low)?Math.min(low,anchor.mid):anchor.low;
  let h=Number.isFinite(high)?Math.min(high,anchor.high):anchor.high;
  if(h<l)h=l;
  return {low:roundMoney(l),high:roundMoney(h),changed:l!==low||h!==high};
}
// COMPARABLES DE LA BASE DE NIL, POR NIVELES DE PARECIDO
// El precio de reventa sale de los anuncios más parecidos de la hoja:
//   1. "iguales": mismo modelo, talla, color y material (≥3 precios);
//   2. "misma talla" (o misma referencia en relojes) (≥4 precios);
//   3. "mismo modelo" en otras tallas: solo orientativo (≥6 precios).
// Si la pestaña de la tarea no tiene el modelo (p. ej. Radar con un modelo
// nuevo), se busca el modelo nombrado en las demás pestañas del mismo tipo.
// Precios: pedidos × % al que se venden de verdad + ventas registradas.
const VESTIAIRE_MATERIAL_RE=[['exotica',/croc|cocodril|python|pit[oó]n|ostrich|avestruz|lizard|lagarto|鳄鱼|蟒/i],['charol',/charol|patent|vernis|verniz|漆皮/i],['ante',/\bante\b|suede|daim|scamosciato|麂皮|翻毛/i],['tweed',/tweed|粗花呢/i],['seda',/\bseda\b|silk|satin|raso|丝绸/i],['lona',/lona|canvas|toile|\btela\b|fabric|nylon|nailon|monogram|jacquard|denim|raf+ia|帆布|老花|尼龙/i],['piel',/piel|cuero|leather|cuir|pelle|leder|lambskin|calfskin|caviar|cordero|becerro|ternera|vachetta|羊皮|牛皮|小牛皮/i]];
const vestiaireMaterialOf=t=>(VESTIAIRE_MATERIAL_RE.find(([,re])=>re.test(String(t||'')))||[])[0]||null;
const vestiaireColorOf=t=>(VESTIAIRE_COLOR_RE.find(([,re])=>re.test(String(t||'')))||[])[0]||null;
// Textos con los que se reconoce el modelo del anuncio: el título y lo que
// identificaron la verificación y el análisis (marca, modelo, variante).
function vestiaireItemTexts(item,exact){
  return {
    title:String(item?.title||''),
    label:[exact?.brand,exact?.family,exact?.exact_variant_label,item?.model].filter(Boolean).join(' '),
    description:String(item?.description||'')
  };
}
// Filas del mismo modelo y, en bolsos, del mismo tipo de material que el
// anuncio: piel, tela/sintético o piel exótica no se mezclan (regla de Nil).
function vestiaireSameModel(tab,rows,item,exact,opts){
  const m=sameModelRows(tab,rows,vestiaireItemTexts(item,exact),opts);
  if(!m||isWatchTask(tab))return m;
  const known=v=>v&&!/unknown|desconocid/i.test(String(v));
  const mat=sameMaterialRows(m.rows,known(exact?.material)?exact.material:item?.title);
  return mat.rows.length?{...m,rows:mat.rows,material:mat.material}:null;
}
function vestiaireComparables(task,item,exact){
  if(!isWatchTask(task?.task_name)){
    const entries=Object.entries(vestiaireSheetCache?.tasks||{})
      .filter(([tab,r])=>!isWatchTask(tab)&&r.source==='sheet')
      .map(([tab,r])=>({tab,rows:r.fichas||[]}));
    const c=strictBagComparables(entries,item,exact||{});
    if(c)c.cross=c.tab!==task?.task_name;
    return c;
  }
  const refs=vestiaireRefs().tasks||{};
  const taskName=task?.task_name||'';
  const watch=isWatchTask(taskName);
  const raw=`${item?.title||''} ${item?.description||''}`;
  const label=[exact?.brand,exact?.family,exact?.exact_variant_label,exact?.size].filter(Boolean).join(' ');
  const usable=f=>Number.isFinite(f.price_eur)&&f.price_eur>0;
  // Solo anuncios del MISMO modelo (regla de Nil): otro color, material o
  // talla valen; otro modelo de la misma pestaña, no.
  const own=refs[taskName];
  let pool=[],tab=taskName,model=null,matClass=null;
  if(own?.source==='sheet'&&Array.isArray(own.fichas)){
    const m=vestiaireSameModel(taskName,own.fichas.filter(usable),item,exact);
    if(m){pool=m.rows;model=m.key;matClass=m.material||null;}
  }
  // Si la pestaña de la tarea no tiene ese modelo, se busca en las demás del
  // mismo tipo, solo si el anuncio lo nombra.
  if(!pool.length){
    let best=null;
    for(const [name,r] of Object.entries(refs)){
      if(name===taskName||r?.source!=='sheet'||!Array.isArray(r.fichas)||isWatchTask(name)!==watch)continue;
      const m=vestiaireSameModel(name,r.fichas.filter(usable),item,exact,{requireNamed:true});
      // Gana el modelo más concreto ("pochette accessoires" antes que "pochette"); a igualdad, más filas.
      const spec=k=>String(k||'').split(' · ').pop().length;
      if(m&&(!best||spec(m.key)>spec(best.key)||(spec(m.key)===spec(best.key)&&m.rows.length>best.rows.length)))best={name,...m};
    }
    if(best){pool=best.rows;model=best.key;tab=best.name;matClass=best.material||null;}
  }
  if(!pool.length)return null;
  const ratios=(refs[tab]?.fichas||[]).filter(f=>f.sold&&Number.isFinite(f.sold_price_eur)&&f.price_eur>0).map(f=>f.sold_price_eur/f.price_eur).filter(x=>x>0.4&&x<1.6).sort((a,b)=>a-b);
  const ratio=ratios.length>=5?clampNum(ratios[Math.floor(ratios.length/2)],0.75,1):VESTIAIRE_DEFAULT_REALIZATION;
  const realistic=f=>f.sold&&Number.isFinite(f.sold_price_eur)?f.sold_price_eur:(!f.excluded?f.price_eur*ratio:null);
  // Vendidas, recientes y con más likes pesan más (compWeight).
  const band=list=>{
    const w=list.map(f=>({v:realistic(f),w:compWeight(f)})).filter(x=>Number.isFinite(x.v));
    const q=p=>Math.round(weightedQuantile(w,p));
    return w.length?{n:w.length,low:q(0.25),mid:q(0.5),high:q(0.75)}:{n:0};
  };
  // Talla: medidas del anuncio, talla de la familia o etiqueta (Mini, Medium...).
  const width=vestiaireWidthCm(raw);
  const sizeText=`${exact?.size||''} ${item?.title||''}`;
  const fam=(VESTIAIRE_FAMILY_SIZES.find(([re])=>re.test(tab))||[])[1];
  const famSize=!width&&fam?fam.find(([,re])=>re.test(sizeText)):null;
  const sizeLbl=vestiaireSizeLabel(sizeText);
  let sized=null,basis='';
  // Relojes: la "talla" es la referencia; si el anuncio la da, solo valen esas filas.
  const flatRef=v=>sheetNorm(v).replace(/[.\-\s\/]/g,'');
  const rawFlat=flatRef(`${raw} ${label}`);
  const refRows=watch?pool.filter(f=>{const r=flatRef(f.size);return /\d{3}/.test(r)&&r.length>=5&&rawFlat.includes(r);}):[];
  if(refRows.length){sized=refRows;basis='misma referencia';}
  if(!sized&&width){sized=pool.filter(f=>{const fw=vestiaireWidthCm(f.dims);return fw&&Math.abs(fw-width)/width<=0.12;});basis=`medidas ~${Math.round(width)} cm`;}
  if((!sized||band(sized).n<4)&&famSize){const [name,re,lo,hi]=famSize;sized=pool.filter(f=>{const fw=vestiaireWidthCm(f.dims);return fw?fw>=lo&&fw<=hi:re.test(`${f.size} ${f.notes}`);});basis=`talla ${name}`;}
  if((!sized||band(sized).n<4)&&sizeLbl){sized=pool.filter(f=>vestiaireSizeLabel(`${f.size} ${f.notes}`)===sizeLbl);basis=`talla ${sizeLbl}`;}
  // Color y material: primero lo que identificó la verificación visual.
  const known=v=>v&&!/unknown|desconocid/i.test(String(v));
  const itemColor=vestiaireColorOf(known(exact?.main_color)?exact.main_color:raw);
  const itemMat=vestiaireMaterialOf(known(exact?.material)?exact.material:raw);
  const same=sized&&itemColor&&itemMat?sized.filter(f=>vestiaireColorOf(f.color)===itemColor&&vestiaireMaterialOf(`${f.material} ${f.notes}`)===itemMat):[];
  let tier=null,set=null;
  if(band(same).n>=3){tier='iguales';set=same;}
  else if(sized&&band(sized).n>=4){tier='misma_talla';set=sized;}
  else if(band(pool).n>=6){tier='mismo_modelo';set=pool;basis='otras tallas';}
  if(!tier)return null;
  const b=band(set);
  // Primero las que más pesan: vendidas, recientes y con más likes.
  const usableSet=set.filter(f=>Number.isFinite(realistic(f)));
  const picks=usableSet.slice().sort((x,y)=>compWeight(y)-compWeight(x))
    .slice(0,5)
    .map(f=>({url:f.url,size:f.size,dims:f.dims,material:f.material,color:f.color,condition:f.condition,price_eur:f.price_eur,sold:!!f.sold,sold_price_eur:f.sold_price_eur??null,likes:Number.isFinite(f.likes)?f.likes:null,published:f.published||null}));
  const st=compStats(usableSet);
  return {tier,tab,model,materialClass:matClass,cross:tab!==taskName,basis,colour:itemColor,material:itemMat,ratio:Math.round(ratio*100)/100,...b,
    sold_n:st.sold_n,recent_n:st.recent_n,likes_max:st.likes_max,price_basis:st.sold_n?(st.sold_n===usableSet.length?'sold':'mixed'):'asking',picks};
}
function vestiaireComparablesNote(c){
  if(!c)return '';
  if(c.rule_version===BAG_SHEET_RULE_VERSION){
    return `Sheets: ${c.n} referencia(s) del modelo ${c.model}, ${c.basis}, material ${c.material}${c.tier==='iguales'?`, color ${c.colour}`:', otro color'}${c.condition?`, estado ${c.condition}`:''}. Reventa estimada ${c.low}-${c.high} EUR; ${c.sold_n} ventas registradas. ${c.price_basis==='sold'?'Valoración basada en los precios de venta registrados, sin descuento adicional.':c.price_basis==='mixed'?'Vendidos y en venta; los vendidos, los recientes y los de más likes pesan más.':c.ratio_source==='assumption'?'Precios pedidos ajustados al 90 % como hipótesis, no ventas confirmadas.':'Ajuste basado en ventas registradas de estas referencias.'}`;
  }
  const what=c.tier==='iguales'?`iguales (${c.basis}, ${c.colour}, ${c.material})`:c.tier==='misma_talla'?`de la ${c.basis}`:'en otras tallas';
  return `Reventa según tu base de Vestiaire: ${c.n} anuncios del modelo ${c.model||'del anuncio'}${c.materialClass?` en ${c.materialClass}`:''} ${what}${c.cross?` (pestaña ${c.tab})`:''}; se venden al ${Math.round(c.ratio*100)} % del precio pedido → venta realista ${c.low}-${c.high} EUR.`;
}
// ── VESTIAIRE EN DIRECTO (sin referencia en la base) ────────────────────
// Si la base de Nil no tiene nada del modelo, se busca ese modelo en
// Vestiaire desde el Chrome del Mac (mismo puente que One Map). Cada búsqueda
// (marca + modelo) se guarda VESTIAIRE_LIVE_CACHE_HOURS (12 h) y como mucho se
// hacen VESTIAIRE_LIVE_DAILY_MAX (40) al día. Si Vestiaire pide verificación,
// se deja de buscar 6 h: nunca se resuelve ni se esquiva.
let vestiaireLiveMacReady={at:0,ok:false};
function saveSetting(key,value){
  db.prepare(`INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
    .run(key,JSON.stringify(value),new Date().toISOString());
}
async function vestiaireLiveSearchRows(query,{maxAgeHours=null}={}){
  if(['0','false','off','no'].includes(String(process.env.VESTIAIRE_LIVE||'').toLowerCase()))return {status:'disabled'};
  const token=String(process.env.ONEMAP_MAC_BRIDGE_TOKEN||'').trim();
  if(!token)return {status:'no_mac'};
  const now=Date.now();
  const ttl=Number(process.env.VESTIAIRE_LIVE_CACHE_HOURS||12)*3600e3;
  const cache=getSetting('vestiaire_live_cache',{})||{};
  const hit=cache[query];
  if(hit&&now-Date.parse(hit.at)<(maxAgeHours!=null?maxAgeHours*3600e3:ttl))return {status:'ok',cached:true,rows:hit.rows||[],model:hit.model||null};
  const usage=getSetting('vestiaire_live_usage',{})||{};
  if(Date.parse(usage.blocked_until||'')>now)return {status:'blocked'};
  const day=new Date().toISOString().slice(0,10);
  const used=usage.day===day?Number(usage.n)||0:0;
  if(used>=Number(process.env.VESTIAIRE_LIVE_DAILY_MAX||200))return {status:'daily_limit'};
  if(now-vestiaireLiveMacReady.at>120e3)vestiaireLiveMacReady={at:now,ok:await macOneMapReady(token)};
  if(!vestiaireLiveMacReady.ok)return {status:'mac_offline'};
  saveSetting('vestiaire_live_usage',{...usage,day,n:used+1});
  const payload=await macVestiaireSearch(query,token);
  if(payload?.blocked){
    saveSetting('vestiaire_live_usage',{...usage,day,n:used+1,blocked_until:new Date(now+6*3600e3).toISOString()});
    await reportHealthIssue('vestiaire-live','Vestiaire ha pedido una verificación en el Chrome del Mac; la búsqueda en directo queda en pausa 6 h (no se resuelve ni se esquiva). Los avisos siguen, con la reventa estimada sin Vestiaire.').catch(()=>{});
    return {status:'blocked'};
  }
  const rows=vestiaireLiveRows(payload);
  const model=payload?.model?.name||null;
  saveRefThumbs(payload?.thumbs);
  const fresh=Object.fromEntries(Object.entries(cache).filter(([,v])=>now-Date.parse(v.at)<ttl).slice(-59));
  fresh[query]={at:new Date(now).toISOString(),model,rows};
  saveSetting('vestiaire_live_cache',fresh);
  console.log(`Vestiaire en directo: "${query}" → ${model||'sin modelo'} · ${rows.length} anuncios (${rows.filter(r=>r.sold).length} vendidos).`);
  return {status:'ok',rows,model};
}
function saveRefThumbs(thumbs){
  if(!thumbs||typeof thumbs!=='object')return;
  const at=new Date().toISOString();
  const put=db.prepare('INSERT OR REPLACE INTO ref_thumbs(id,jpeg,saved_at) VALUES(?,?,?)');
  db.transaction(()=>{
    for(const [id,b64] of Object.entries(thumbs)){
      if(!/^\d{5,10}$/.test(id)||typeof b64!=='string'||b64.length>100000)continue;
      put.run(id,Buffer.from(b64,'base64'),at);
    }
    db.prepare('DELETE FROM ref_thumbs WHERE saved_at<?').run(new Date(Date.now()-3*864e5).toISOString());
  })();
}
async function vestiaireLiveFor(task,item,exact){
  if(isWatchTask(task?.task_name))return null;
  const query=vestiaireLiveQuery(item,exact||{});
  if(!query)return {status:'no_query'};
  const r=await vestiaireLiveSearchRows(query);
  if(r.status!=='ok')return {status:r.status,query};
  const c=vestiaireLiveComparables(r.rows,item,exact||{},{query,model:r.model});
  return c?{...c,status:'ok'}:{status:'no_match',query,model:r.model,found:r.rows.length};
}
function vestiaireLiveNote(c){
  if(c?.status!=='ok')return '';
  return `Sin referencia en tu base: reventa según ${c.n} anuncios de Vestiaire en directo del modelo ${c.model}${c.material?` en ${c.material}`:''} (${c.basis}; ${c.sold_n} vendidos y ${c.active_n} en venta × 90 %; vendidos, recientes y con más likes pesan más) → ${c.low}-${c.high} EUR.`;
}
// ── VESTIAIRE COMO FUENTE ───────────────────────────────────────────────
// En cada tarea de bolsos, los anuncios más nuevos de ese modelo en
// Vestiaire (desde el Chrome del Mac) entran como un anuncio más: la IA los
// revisa y el bot los valora igual que los de Asia, con los gastos de
// comprador de Vestiaire en el coste. La búsqueda se repite como mucho cada
// VESTIAIRE_SOURCE_REFRESH_HOURS (1 h) por modelo.
async function searchVestiaireSource({sessionId,minEur=null,maxEur=null},taskName){
  const query=vestiaireTaskQuery(taskName);
  if(!query)return {ok:false,kept:0,error:'tarea sin modelo de Vestiaire'};
  const r=await vestiaireLiveSearchRows(query,{maxAgeHours:Number(process.env.VESTIAIRE_SOURCE_REFRESH_HOURS||1)});
  if(r.status!=='ok')return {ok:false,kept:0,query,error:VESTIAIRE_LIVE_WHY[r.status]||r.status};
  let kept=0;
  for(const x of (r.rows||[]).filter(x=>!x.sold&&x.price_eur>0)){
    if(minEur!=null&&Number(x.price_eur)<Number(minEur))continue;
    if(maxEur!=null&&Number(x.price_eur)>Number(maxEur))continue;
    upsertListing({source:'vestiaire',source_id:String(x.id),url:x.url,title:x.title||x.model,
      description:[x.model,x.size,x.dims?`${x.dims} cm`:'',x.color,x.condition,x.material,x.notes].filter(Boolean).join(' · '),
      original_price:x.price_eur,currency:'EUR',price_eur:x.price_eur,image_url:x.picture,status:'active',
      raw:{...x,publishedAt:x.created_at},purchase_via:'Vestiaire Collective'},sessionId,query);
    kept++;
  }
  return {ok:true,kept,query,model:r.model,cached:!!r.cached};
}

function vestiaireFichasBlock(r,item,taskName=''){
  const picked=vestiaireMatchFichas(r?.fichas||[],item,taskName);
  if(!picked.length)return vestiaireSoldBlock(r,item,taskName);
  const rows=picked.map(({f:x})=>`- ${x.size} ${x.dims} cm | ${x.material} ${x.color} | ${x.condition} | ${x.price_eur} EUR${x.original_eur?` (was ${x.original_eur})`:''} | ${x.country}${x.vintage?' | vintage':''}${Number.isFinite(x.likes)?` | ${x.likes} likes`:''}${x.notes?` | ${x.notes}`:''} | ${x.url}`).join('\n');
  return `\n\nNIL'S VESTIAIRE DATABASE — LISTINGS FOR SALE (PRIMARY EVIDENCE: Nil's own database of real Vestiaire Collective listings, kept up to date daily (status, likes); more likes = more demand; CURRENT asking prices; size inferred from the listed measurements). These are the closest matches to THIS listing by size, colour and price:
${rows}
These ARE real comparables: when one matches the target's size, material, colour family and condition, include it in your comparables (source "Vestiaire Collective", status CURRENT, its URL) with the proper match_level, even if your own search did not surface it. Size matters a lot for City: Nano/Mini/Small/Part Time/Medium/Large are different price levels. All of them are the SAME MODEL as the target; never use listings of another model of the same brand as comparables.`+vestiaireSoldBlock(r,item,taskName);
}
// Ventas reales de la base de datos de Nil: el precio "Vendido a X €" de
// Vestiaire. Es la mejor prueba de precio de reventa que tenemos.
function vestiaireSoldBlock(r,item,taskName=''){
  const sold=(r?.fichas||[]).filter(f=>f.sold&&Number.isFinite(f.sold_price_eur)).map(f=>({...f,price_eur:f.sold_price_eur,excluded:false}));
  if(!sold.length)return '';
  const picked=vestiaireMatchFichas(sold,item,taskName).slice(0,10);
  const rows=picked.map(({f:x})=>`- ${x.size} ${x.dims} cm | ${x.material} ${x.color} | ${x.condition} | SOLD for ${x.sold_price_eur} EUR | ${x.country}${x.vintage?' | vintage':''}${Number.isFinite(x.likes)?` | ${x.likes} likes`:''} | ${x.url}`).join('\n');
  const st=r.sold_stats?.n?` (all recorded sales for this model: n=${r.sold_stats.n}, median ${r.sold_stats.median} €, range ${r.sold_stats.min}-${r.sold_stats.max} €)`:'';
  return `\n\nNIL'S VESTIAIRE DATABASE — CONFIRMED SALES (real Vestiaire Collective sales recorded by Nil: the listing page shows "Vendido a X €")${st}. Closest matches to THIS listing:
${rows}
These are the STRONGEST resale evidence available. When one matches the target's size, material, colour family and condition, include it in your comparables with source "Vestiaire Collective", listing_status SOLD, its URL and the sold price, and anchor resale_low_eur on these sold prices rather than on asking prices.`;
}
function vestiaireSnapshotBlock(task,item,exact=null){
  if(!isWatchTask(task?.task_name)){
    const c=vestiaireComparables(task,item,exact);
    if(!c)return '\n\nNIL SHEETS: no matching model + all declared dimensions + material + known colour. Do not use other sizes or invent missing dimensions. Any valuation is provisional: WATCH / CONSULTAR PRECIO, never BUY or STRONG BUY. Identify the variant first; the database will be checked again after identification.';
    return `\n\nNIL SHEETS — PRIMARY EVIDENCE (only these matching rows; never substitute a broader model/size average):\n${vestiaireComparablesNote(c)}\n${JSON.stringify(c.picks)}\nUse these rows first. Asking prices are not completed sales. A matching row alone does not prove a good deal; retain condition, authenticity and market confidence checks.`;
  }
  const r=task?.task_name?vestiaireRefs().tasks?.[task.task_name]:null;
  if(!r)return '';
  const fmt=s=>`n=${s.n}, p25 ${s.p25} €, median ${s.median} €, p75 ${s.p75} €, range ${s.min}-${s.max} €`;
  let out='';
  // Solo el mismo modelo que el anuncio: la pestaña mezcla variantes y formatos.
  const active=Array.isArray(r.fichas)?r.fichas.filter(f=>!f.excluded&&Number.isFinite(f.price_eur)):[];
  const same=r.source==='sheet'?vestiaireSameModel(task.task_name,active,item,null):null;
  const list=same?.rows||(r.source==='sheet'?[]:null);
  const all=list?priceStats(list.map(f=>f.price_eur)):r.all;
  if(all?.n>=3){
    const by={};if(list)for(const f of list)(by[(f.size||'Sin talla').trim()]||=[]).push(f.price_eur);
    const groupList=list?Object.entries(by).map(([k,v])=>({label:k,...priceStats(v)})):Object.values(r.groups||{});
    const groups=groupList.filter(g=>g.n>=2).map(g=>`  - ${g.label}: ${fmt(g)}`).join('\n');
    const vintage=list?priceStats(list.filter(f=>f.vintage).map(f=>f.price_eur)):r.vintage;
    const disc=list?(list.length?Math.round(list.filter(f=>Number.isFinite(f.original_eur)&&f.original_eur>f.price_eur).length/list.length*100):0):r.discounted_share;
    out+=`\n\nVESTIAIRE MARKET SNAPSHOT${same?` — MODEL ${same.key} ONLY`:''} (${r.source==='sheet'?`computed live from Nil's own Vestiaire database on ${r.captured_on}, listings still for sale`:`captured manually by Nil from a full Vestiaire search on ${r.captured_on||'unknown date'}`}; CURRENT ASKING prices in EUR, not sold prices; covers listings not indexed by Google):
- All listings${same?` of this model`:''}: ${fmt(all)}
${vintage?.n>=3?`- Tagged vintage: ${fmt(vintage)}\n`:''}${groups?`- By format:\n${groups}\n`:''}- ${disc}% of listings already show a price reduction, so real sale prices are usually below asking.
Use this snapshot to judge the realistic Vestiaire price level for THIS variant (size, format, material, condition) and whether individual comparables you find are representative. It is not a comparable itself and has no URLs; never cite it as one. Asking prices overstate achievable resale: treat the lower half (p25 to median) as the realistic resale zone unless the target is clearly superior.`;
  }
  return out+vestiaireFichasBlock(r,item,task.task_name);
}
const VESTIAIRE_VALUATION_WEIGHT=Math.max(1,Number(process.env.VESTIAIRE_VALUATION_WEIGHT||2));
function hostOf(url){
  try{return new URL(url).hostname.toLowerCase();}catch{return '';}
}

function luxuryComparableValuationWeight(c){
  const url=String(c?.url||'').trim();
  const tier=luxuryMarketTier(url);
  const europe=europeanLuxuryMarketUrl(url);
  const status=String(
    c?.listing_status||'UNKNOWN'
  ).toUpperCase();

  let weight=1;

  // eBay sigue siendo evidencia complementaria.
  if(tier==='TIER_2'){
    weight*=0.70;
  }

  // Mayor relevancia para el mercado europeo.
  if(europe){
    weight*=1.35;
  }

  // Vestiaire Collective es la referencia principal de Nil para revender:
  // sus anuncios pesan el doble que los de otras webs (que siguen contando).
  if(/(^|\.)(vestiairecollective\.com|chrono24\.[a-z.]+)$/i.test(hostOf(url))){
    weight*=VESTIAIRE_VALUATION_WEIGHT;
  }

  // Una venta confirmada tiene más valor que un asking price.
  if(status==='SOLD'){
    weight*=1.50;
  }else if(status==='UNKNOWN'){
    weight*=0.75;
  }

  return weight;
}

function normalizeCurrency(v){
  const s=String(v||'EUR').trim().toUpperCase();
  if(s==='EURO'||s==='EUROS')return'EUR';
  if(s==='US$')return'USD';
  return s;
}
function comparableToEur(c){
  const price=Number(c?.price);
  if(!Number.isFinite(price)||price<=0)return null;
  const currency=normalizeCurrency(c?.currency);
  if(currency==='EUR')return roundMoney(price);
  const converted=toEur(price,currency);
  return Number.isFinite(Number(converted))?roundMoney(converted):null;
}
function sourceKey(c){
  const url=String(
    c?.url||
    c?.link||
    c?.uri||
    ''
  ).trim();

  const approved=
    approvedLuxuryMarketSourceName(url);

  if(approved){
    return approved.toLowerCase();
  }

  const source=String(
    c?.source||''
  ).trim();

  if(source){
    return source.toLowerCase();
  }

  try{
    return new URL(url)
      .hostname
      .replace(/^www\./,'')
      .toLowerCase();
  }catch{
    return '';
  }
}
function collectListingImageUrls(item,max=4){
  const out=[];
  const add=v=>{
    if(Array.isArray(v)){for(const x of v)add(x);return}
    if(v&&typeof v==='object'){add(v.url||v.src||v.imageUrl||v.image_url);return}
    const s=String(v||'').trim();
    if(/^https?:\/\//i.test(s)&&!out.includes(s))out.push(s);
  };
  add(item?.image_url);
  let raw={};
  try{raw=JSON.parse(item?.raw_json||'{}')}catch{}
  const info=raw?.['\u5546\u54c1\u4fe1\u606f']||{};
  for(const k of ['\u5546\u54c1\u56fe\u7247\u5217\u8868','\u56fe\u7247\u5217\u8868','\u5546\u54c1\u4e3b\u56fe\u94fe\u63a5','\u5546\u54c1\u4e3b\u56fe','\u4e3b\u56fe','images','imageUrls','image_urls','product_image_urls','photos']){
    add(info?.[k]); add(raw?.[k]);
  }
  const walk=(v,key='',depth=0)=>{
    if(depth>5||out.length>=max*3||v==null)return;
    if(typeof v==='string'){
      if(/image|img|pic|photo|\u56fe\u7247|\u4e3b\u56fe/i.test(key))add(v);
      return;
    }
    if(Array.isArray(v)){for(const x of v)walk(x,key,depth+1);return}
    if(typeof v==='object'){
      for(const [k,x] of Object.entries(v)){
        if(/avatar|\u5934\u50cf/i.test(k))continue;
        walk(x,k,depth+1);
      }
    }
  };
  walk(raw);
  return out.slice(0,max);
}
async function fetchGeminiImageParts(item,max=4){
  const parts=[];
  let total=0;
  for(const url of collectListingImageUrls(item,max)){
    try{
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),12000);
      const r=await fetch(url,{signal:controller.signal});
      clearTimeout(timer);
      if(!r.ok)continue;
      let type=(r.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
      if(!type||type==='application/octet-stream'){
        const clean=url.split('?')[0].toLowerCase();
        type=clean.endsWith('.heic')?'image/heic':clean.endsWith('.heif')?'image/heif':clean.endsWith('.png')?'image/png':clean.endsWith('.webp')?'image/webp':'image/jpeg';
      }
      if(!['image/jpeg','image/jpg','image/png','image/webp','image/heic','image/heif'].includes(type))continue;
      const buf=Buffer.from(await r.arrayBuffer());
      if(!buf.length||buf.length>7*1024*1024)continue;
      if(total+buf.length>20*1024*1024)break;
      total+=buf.length;
      parts.push({inline_data:{mime_type:type==='image/jpg'?'image/jpeg':type,data:buf.toString('base64')}});
    }catch{}
  }
  return parts;
}
async function repairGeminiJson({key,model,rawText,parseError}){
  if(aiProvider()==='openai'){
    const body=await openaiResponsesRequest({
      key,
      model:aiTriageModel(),
      purpose:'repair',
      parts:[{text:`Convert the model response below into ONE valid JSON object. Return JSON only. Preserve the meaning and values already present. Do not invent new facts, prices, URLs, model details or market evidence. Repair JSON syntax only.\n\nORIGINAL PARSE ERROR:\n${parseError||'invalid JSON'}\n\nMODEL RESPONSE:\n${String(rawText||'').slice(0,60000)}`}]
    });
    return parseJsonLoose(openaiOutputText(body));
  }
  const u=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const repairPrompt=`Convert the model response below into ONE valid JSON object.

Rules:
- Return JSON only. No markdown fences and no commentary.
- Preserve the meaning and values already present.
- Do not invent new facts, prices, URLs, model details or market evidence.
- If a field is malformed, repair JSON syntax only.
- The output must be parseable with JSON.parse.

ORIGINAL PARSE ERROR:
${parseError||'invalid JSON'}

MODEL RESPONSE:
${String(rawText||'').slice(0,60000)}`;

  let payload={
    contents:[{role:'user',parts:[{text:repairPrompt}]}],
    generationConfig:{responseMimeType:'application/json'}
  };
  let {r,body}=await geminiFetchJson(u,payload);

  if(!r.ok){
    if(geminiCapacityError(body,r.status)){
      throw geminiHttpError(body,r.status);
    }

    payload={
      contents:[{role:'user',parts:[{text:repairPrompt}]}]
    };

    ({r,body}=await geminiFetchJson(u,payload));
  }

  if(!r.ok){
    throw geminiHttpError(body,r.status);
  }

  const repairedText=body?.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('')||'';
  return parseJsonLoose(repairedText);
}

async function geminiJsonRequest({key,model,parts,googleSearch=false,purpose='verify'}){
  if(aiProvider()==='openai'){
    let body=await openaiResponsesRequest({key,model,parts,webSearch:googleSearch,purpose});
    let rawText=openaiOutputText(body);
    if(googleSearch&&!rawText.trim()){
      body=await openaiResponsesRequest({key,model,parts,webSearch:true,purpose});
      rawText=openaiOutputText(body);
    }
    if(googleSearch&&!rawText.trim())throw new Error('OpenAI web search devolvió una respuesta vacía');
    const {groundingSources,webSearchQueries}=openaiWebEvidence(body);
    let data;
    let jsonRepairUsed=false;
    try{
      data=parseJsonLoose(rawText);
    }catch(e){
      data=await repairGeminiJson({key,model,rawText,parseError:e?.message||String(e)});
      jsonRepairUsed=true;
    }
    return {data,groundingSources,webSearchQueries,jsonRepairUsed,usage:body?.usage||null};
  }
  const u=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const payload={contents:[{role:'user',parts}]};

  if(googleSearch){
    payload.tools=[{google_search:{}}];
  }else{
    payload.generationConfig={responseMimeType:'application/json'};
  }

  let {r,body}=await geminiFetchJson(u,payload);

  let rawText=
    body?.candidates?.[0]?.content?.parts
      ?.map(p=>p.text||'')
      .join('')||'';

  if(!r.ok){
    throw geminiHttpError(body,r.status);
  }

  if(googleSearch&&!rawText.trim()){
    const retry={
      contents:[{role:'user',parts}],
      tools:[{google_search:{}}]
    };

    ({r,body}=await geminiFetchJson(u,retry));

    if(!r.ok){
      throw geminiHttpError(body,r.status);
    }

    rawText=
      body?.candidates?.[0]?.content?.parts
        ?.map(p=>p.text||'')
        .join('')||'';
  }
  if(googleSearch&&!rawText.trim())throw new Error('Gemini Google Search devolvió una respuesta vacía');
  const gm=body?.candidates?.[0]?.groundingMetadata||{};
  const groundingSources=(gm.groundingChunks||[])
    .map(x=>x?.web)
    .filter(Boolean)
    .map(x=>({title:x.title||'',url:x.uri||''}))
    .filter(x=>x.url);
  const webSearchQueries=Array.isArray(gm.webSearchQueries)?gm.webSearchQueries:[];

  let data;
  let jsonRepairUsed=false;
  try{
    data=parseJsonLoose(rawText);
  }catch(e){
    data=await repairGeminiJson({
      key,
      model,
      rawText,
      parseError:e?.message||String(e)
    });
    jsonRepairUsed=true;
  }

  return {data,groundingSources,webSearchQueries,jsonRepairUsed};
}
async function exactModelVerification({key,model,item,task,imageParts,preliminary}){
  const visualPrompt=`You are the SECOND-STAGE exact handbag identification specialist for Luxury Hunter.

IMPORTANT:
- The seller title and search query are untrusted hints.
- Base the identification primarily on the supplied product images.
- Distinguish family vs exact variant. For example, Fendi Baguette is not enough: distinguish standard Baguette vs Mamma/mini/nano/chain/1997 and identify material, pattern, colour, hardware and likely era where evidence permits.
- Do not invent a reference number or edition.
- If images are insufficient, explicitly lower confidence.
- This is model/variant identification, NOT an authenticity certificate.

CONDITION ASSESSMENT:
- In the SAME visual pass, assess the actual physical condition of THIS specific unit.
- Inspect only what is genuinely visible in the supplied listing images.
- Check, when visible: corners, edges, handles, straps, leather/canvas/textile surface, stains, scratches, cracking, discoloration, hardware wear, oxidation, shape loss, structure, base, interior, lining, closures, repairs, missing pieces and included accessories.
- Never assume a hidden area is in good condition.
- If important views are missing, lower condition confidence and list them in missing_views_es.
- condition.score MUST use a 0-100 scale, where 100 means the best visible condition and 0 the worst. Do not return a 0-1 or 0-10 score.
- condition.score is only a visual condition indicator. It MUST NEVER map to a fixed resale percentage or price adjustment.
- Do not estimate resale value in this visual stage.

TARGET TASK: ${task?.product_query||''}
TASK CRITERIA:
${task?.description||''}

LISTING TITLE: ${item.title||''}
LISTING DESCRIPTION: ${item.description||''}
PRELIMINARY AI RESULT:
${JSON.stringify(preliminary)}

Return ONLY JSON:
{
  "target_match": true,
  "brand": "string",
  "family": "string",
  "exact_variant_label": "string",
  "size": "string or unknown",
  "material": "string or unknown",
  "main_color": "string or unknown",
  "pattern": "string or unknown",
  "hardware": "string or unknown",
  "era": "string or unknown",
  "reference_code": null,
  "special_edition": null,
  "confidence": 0.0,
  "visual_evidence_es": ["1-4 short Spanish points"],
  "uncertainties_es": [],
  "condition": {
    "grade": "EXCELLENT|VERY_GOOD|GOOD|FAIR|POOR|UNKNOWN",
    "score": null,
    "confidence": 0.0,
    "visible_areas_es": [],
    "defects_es": [],
    "positive_signals_es": [],
    "missing_views_es": [],
    "notes_es": []
  }
}`;
  const {data}=await geminiJsonRequest({key,model,parts:[{text:visualPrompt},...imageParts],googleSearch:false});
  return {
    target_match:data.target_match!==false,
    brand:String(data.brand||preliminary.brand||'').trim(),
    family:String(data.family||preliminary.model||'').trim(),
    exact_variant_label:String(data.exact_variant_label||data.family||preliminary.model||'').trim(),
    size:String(data.size||'unknown').trim(),
    material:String(data.material||'unknown').trim(),
    main_color:String(data.main_color||'unknown').trim(),
    pattern:String(data.pattern||'unknown').trim(),
    hardware:String(data.hardware||'unknown').trim(),
    era:String(data.era||'unknown').trim(),
    reference_code:data.reference_code?String(data.reference_code).trim():null,
    special_edition:typeof data.special_edition==='boolean'?data.special_edition:null,
    confidence:clampNum(data.confidence,0,1),
    visual_evidence_es:Array.isArray(data.visual_evidence_es)?data.visual_evidence_es.slice(0,4):[],
    uncertainties_es:Array.isArray(data.uncertainties_es)?data.uncertainties_es.slice(0,4):[],
    condition:(()=>{
      const c=data?.condition&&typeof data.condition==='object'?data.condition:{};

      let grade=String(c.grade||'UNKNOWN')
        .trim()
        .toUpperCase()
        .replace(/[ -]+/g,'_');

      if(!['EXCELLENT','VERY_GOOD','GOOD','FAIR','POOR','UNKNOWN'].includes(grade)){
        grade='UNKNOWN';
      }

      const scoreRaw=Number(c.score);

      let conditionScore=null;

      if(Number.isFinite(scoreRaw)){
        if(scoreRaw>=0 && scoreRaw<=1){
          conditionScore=clampNum(
            scoreRaw*100,
            0,
            100
          );
        }else if(scoreRaw>1 && scoreRaw<=10){
          conditionScore=clampNum(
            scoreRaw*10,
            0,
            100
          );
        }else{
          conditionScore=clampNum(
            scoreRaw,
            0,
            100
          );
        }
      }

      return {
        grade,
        score:conditionScore,
        confidence:clampNum(c.confidence,0,1),
        visible_areas_es:Array.isArray(c.visible_areas_es)?c.visible_areas_es.slice(0,12):[],
        defects_es:Array.isArray(c.defects_es)?c.defects_es.slice(0,12):[],
        positive_signals_es:Array.isArray(c.positive_signals_es)?c.positive_signals_es.slice(0,12):[],
        missing_views_es:Array.isArray(c.missing_views_es)?c.missing_views_es.slice(0,12):[],
        notes_es:Array.isArray(c.notes_es)?c.notes_es.slice(0,6):[]
      };
    })()
  };
}

function visionSourceName(url){
  try{
    return new URL(String(url||'')).hostname
      .replace(/^www\./,'')
      .trim() || 'Google Vision';
  }catch{
    return 'Google Vision';
  }
}

// TRUSTED LUXURY MARKET SOURCES V1
// Google / Vision se utiliza para DESCUBRIR.
// Solo estas fuentes pueden convertirse en evidencia de mercado.

const TRUSTED_LUXURY_MARKET_DOMAINS=Object.freeze([
  'vestiairecollective.com',
  'collectorsquare.com',
  'therealreal.com',
  'fashionphile.com',
  'rebag.com',
  '1stdibs.com',
  'yoogiscloset.com',
  'whatgoesaroundnyc.com',
  'annsfabulousfinds.com',
  'hardlyeverwornit.com',
  'sothebys.com',
  'christies.com',
  'saclab.com',
  'sellierknightsbridge.com',
  'luxurypromise.com',
  'handbagclinic.co.uk',
  'resee.com',
  // Relojes: Chrono24 es el mercado de reventa de Nil para relojes.
  'chrono24.com','chrono24.es','chrono24.de','chrono24.fr','chrono24.it','chrono24.co.uk','chrono24.ch','chrono24.at','chrono24.nl',
  'watchfinder.co.uk','watchfinder.com','bobswatches.com','crownandcaliber.com','wristcheck.com','the1916company.com'
]);

const SECONDARY_LUXURY_MARKET_DOMAINS=Object.freeze([
  'ebay.com',
  'ebay.co.uk',
  'ebay.de',
  'ebay.fr',
  'ebay.it',
  'ebay.es'
]);

const EUROPE_PRIORITY_LUXURY_MARKET_DOMAINS=Object.freeze([
  'vestiairecollective.com',
  'chrono24.com','chrono24.es','chrono24.de','chrono24.fr','chrono24.it','chrono24.co.uk','chrono24.ch','chrono24.at','chrono24.nl','watchfinder.co.uk',
  'collectorsquare.com',
  'hardlyeverwornit.com',
  'saclab.com',
  'sellierknightsbridge.com',
  'luxurypromise.com',
  'handbagclinic.co.uk',
  'resee.com',
  'ebay.co.uk',
  'ebay.de',
  'ebay.fr',
  'ebay.it',
  'ebay.es'
]);

function europeanLuxuryMarketUrl(value){
  const host=luxuryMarketHostname(value);
  if(!host)return false;
  return EUROPE_PRIORITY_LUXURY_MARKET_DOMAINS.some(
    domain=>
      host===domain ||
      host.endsWith(`.${domain}`)
  );
}

function luxuryMarketPriorityRank(value){
  const tier=luxuryMarketTier(value);
  const europe=europeanLuxuryMarketUrl(value);

  if(tier==='TIER_1' && europe)return 0;
  if(tier==='TIER_1')return 1;
  if(tier==='TIER_2' && europe)return 2;
  if(tier==='TIER_2')return 3;
  return 9;
}

function luxuryMarketHostname(value){
  try{
    return new URL(String(value||'').trim())
      .hostname
      .toLowerCase()
      .replace(/^www\./,'');
  }catch{
    return '';
  }
}

function trustedLuxuryMarketUrl(value){
  const host=luxuryMarketHostname(value);

  if(!host)return false;

  return TRUSTED_LUXURY_MARKET_DOMAINS.some(
    domain=>
      host===domain ||
      host.endsWith(`.${domain}`)
  );
}

function trustedLuxuryMarketEntry(entry){
  const url=String(
    entry?.url ||
    entry?.link ||
    entry?.uri ||
    ''
  ).trim();

  return trustedLuxuryMarketUrl(url);
}

function secondaryLuxuryMarketUrl(value){
  const host=luxuryMarketHostname(value);
  if(!host)return false;
  return SECONDARY_LUXURY_MARKET_DOMAINS.some(
    domain=>
      host===domain ||
      host.endsWith(`.${domain}`)
  );
}

function approvedLuxuryMarketUrl(value){
  return (
    trustedLuxuryMarketUrl(value) ||
    secondaryLuxuryMarketUrl(value)
  );
}

function approvedLuxuryMarketEntry(entry){
  const url=String(
    entry?.url ||
    entry?.link ||
    entry?.uri ||
    ''
  ).trim();
  return approvedLuxuryMarketUrl(url);
}

function luxuryMarketTier(value){
  if(trustedLuxuryMarketUrl(value))return 'TIER_1';
  if(secondaryLuxuryMarketUrl(value))return 'TIER_2';
  return 'UNAPPROVED';
}

function trustedLuxuryMarketSourceName(value){
  const host=luxuryMarketHostname(value);

  const labels={
    'vestiairecollective.com':'Vestiaire Collective',
    'collectorsquare.com':'Collector Square',
    'therealreal.com':'The RealReal',
    'fashionphile.com':'Fashionphile',
    'rebag.com':'Rebag',
    '1stdibs.com':'1stDibs',
    'yoogiscloset.com':"Yoogi's Closet",
    'whatgoesaroundnyc.com':'What Goes Around Comes Around',
    'annsfabulousfinds.com':"Ann's Fabulous Finds",
    'hardlyeverwornit.com':'HEWI',
    'sothebys.com':"Sotheby's",
    'christies.com':"Christie's",
    'saclab.com':'SACLÀB',
    'sellierknightsbridge.com':'Sellier Knightsbridge',
    'luxurypromise.com':'Luxury Promise',
    'handbagclinic.co.uk':'Handbag Clinic',
    'resee.com':'ReSee',
    'chrono24.com':'Chrono24','chrono24.es':'Chrono24','chrono24.de':'Chrono24','chrono24.fr':'Chrono24','chrono24.it':'Chrono24',
    'chrono24.co.uk':'Chrono24','chrono24.ch':'Chrono24','chrono24.at':'Chrono24','chrono24.nl':'Chrono24',
    'watchfinder.co.uk':'Watchfinder','watchfinder.com':'Watchfinder','bobswatches.com':"Bob's Watches",
    'crownandcaliber.com':'Crown & Caliber','wristcheck.com':'Wristcheck','the1916company.com':'The 1916 Company'
  };

  for(const [domain,label] of Object.entries(labels)){
    if(
      host===domain ||
      host.endsWith(`.${domain}`)
    ){
      return label;
    }
  }

  return '';
}

function approvedLuxuryMarketSourceName(value){
  if(secondaryLuxuryMarketUrl(value))return 'eBay';
  return trustedLuxuryMarketSourceName(value);
}

async function googleVisionWebDetection(item){
  const apiKey=String(
    process.env.GOOGLE_CLOUD_VISION_API_KEY||''
  ).trim();

  const imageUrl=String(item?.image_url||'').trim();

  const base={
    enabled:!!apiKey,
    ok:false,
    checked_at:new Date().toISOString(),
    image_url:imageUrl||null,
    best_guess_labels:[],
    pages_with_matching_images:[],
    full_matching_images:[],
    partial_matching_images:[],
    visually_similar_images:[],
    error:null
  };

  if(!apiKey){
    return {
      ...base,
      error:'GOOGLE_CLOUD_VISION_API_KEY no configurada'
    };
  }

  if(!imageUrl){
    return {
      ...base,
      error:'El anuncio no tiene image_url'
    };
  }

  // Intentamos enviar a Vision los bytes reales de la imagen.
  // Si el marketplace bloquea la descarga, usamos imageUri.
  let visionImage=null;

  try{
    const controller=new AbortController();

    const timer=setTimeout(
      ()=>controller.abort(),
      15000
    );

    try{
      const imageResponse=await fetch(
        imageUrl,
        {
          headers:{
            'user-agent':
              'Mozilla/5.0 LuxuryHunter/1.7',
            'accept':
              'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
          },
          signal:controller.signal
        }
      );

      if(imageResponse.ok){
        const ab=await imageResponse.arrayBuffer();
        const buffer=Buffer.from(ab);

        if(
          buffer.length>0 &&
          buffer.length<=15*1024*1024
        ){
          visionImage={
            content:buffer.toString('base64')
          };
        }
      }
    }finally{
      clearTimeout(timer);
    }

  }catch{
    // Fallback a URL pública.
  }

  if(!visionImage){
    visionImage={
      source:{
        imageUri:imageUrl
      }
    };
  }

  const endpoint=
    `https://vision.googleapis.com/v1/images:annotate?key=${
      encodeURIComponent(apiKey)
    }`;

  const payload={
    requests:[
      {
        image:visionImage,
        features:[
          {
            type:'WEB_DETECTION',
            maxResults:50
          }
        ]
      }
    ]
  };

  try{
    const response=await fetch(
      endpoint,
      {
        method:'POST',
        headers:{
          'content-type':'application/json'
        },
        body:JSON.stringify(payload)
      }
    );

    let body={};

    try{
      body=await response.json();
    }catch{}

    if(!response.ok){
      return {
        ...base,
        error:
          body?.error?.message ||
          `Vision HTTP ${response.status}`
      };
    }

    const annotation=body?.responses?.[0]||{};

    if(annotation?.error?.message){
      return {
        ...base,
        error:annotation.error.message
      };
    }

    const web=annotation.webDetection||{};

    const imageRef=x=>({
      url:String(x?.url||'').trim(),
      score:Number.isFinite(Number(x?.score))
        ? Number(x.score)
        : null
    });

    const pages=(
      Array.isArray(web.pagesWithMatchingImages)
        ? web.pagesWithMatchingImages
        : []
    ).map(p=>({
      url:String(p?.url||'').trim(),
      page_title:String(p?.pageTitle||'').trim(),

      score:Number.isFinite(Number(p?.score))
        ? Number(p.score)
        : null,

      full_matching_images:
        Array.isArray(p?.fullMatchingImages)
          ? p.fullMatchingImages.map(imageRef)
          : [],

      partial_matching_images:
        Array.isArray(p?.partialMatchingImages)
          ? p.partialMatchingImages.map(imageRef)
          : []
    })).filter(
      p=>
        p.url &&
        trustedLuxuryMarketUrl(p.url)
    );

    return {
      enabled:true,
      ok:true,
      checked_at:new Date().toISOString(),
      image_url:imageUrl,

      best_guess_labels:(
        Array.isArray(web.bestGuessLabels)
          ? web.bestGuessLabels
          : []
      ).map(x=>({
        label:String(x?.label||'').trim(),
        language_code:String(
          x?.languageCode||''
        ).trim()
      })).filter(x=>x.label),

      pages_with_matching_images:pages,

      full_matching_images:(
        Array.isArray(web.fullMatchingImages)
          ? web.fullMatchingImages
          : []
      ).map(imageRef).filter(x=>x.url),

      partial_matching_images:(
        Array.isArray(web.partialMatchingImages)
          ? web.partialMatchingImages
          : []
      ).map(imageRef).filter(x=>x.url),

      visually_similar_images:(
        Array.isArray(web.visuallySimilarImages)
          ? web.visuallySimilarImages
          : []
      ).map(imageRef).filter(x=>x.url),

      error:null
    };

  }catch(e){
    return {
      ...base,
      error:e?.message||String(e)
    };
  }
}


async function googleLensSerpApiSearch(item){

  const apiKey=String(
    process.env.SERPAPI_API_KEY||''
  ).trim();

  const imageUrl=String(
    item?.image_url||''
  ).trim();

  const base={
    enabled:!!apiKey,
    ok:false,
    checked_at:new Date().toISOString(),
    image_url:imageUrl||null,
    input_mode:null,
    visual_matches:[],
    exact_matches:[],
    error:null
  };

  if(!apiKey){
    return {
      ...base,
      error:'SERPAPI_API_KEY no configurada'
    };
  }

  if(!imageUrl){
    return {
      ...base,
      error:'El anuncio no tiene image_url'
    };
  }

  const runLens=async params=>{

    const qs=new URLSearchParams({
      engine:'google_lens',
      type:'all',
      hl:'en',
      api_key:apiKey,
      ...params
    });

    const response=await fetch(
      `https://serpapi.com/search.json?${qs.toString()}`,
      {
        headers:{
          accept:'application/json'
        },
        signal:AbortSignal.timeout(45000)
      }
    );

    let body={};

    try{
      body=await response.json();
    }catch{}

    if(!response.ok || body?.error){
      throw new Error(
        String(
          body?.error ||
          `SerpApi HTTP ${response.status}`
        )
      );
    }

    return body;
  };

  const normalizeMatches=body=>{

    const visual=(
      Array.isArray(body?.visual_matches)
        ? body.visual_matches
        : []
    ).map((x,idx)=>({

      position:
        x?.position==null
          ? idx+1
          : Number.isFinite(Number(x.position))
            ? Number(x.position)
            : idx+1,

      title:String(x?.title||'').trim(),

      source:String(x?.source||'').trim(),

      url:String(x?.link||'').trim(),

      image_url:String(
        x?.image ||
        x?.thumbnail ||
        ''
      ).trim(),

      exact_match:x?.exact_matches===true,

      price:
        x?.price?.extracted_value==null
          ? null
          : Number.isFinite(
              Number(x.price.extracted_value)
            )
            ? Number(x.price.extracted_value)
            : null,

      currency:String(
        x?.price?.currency||''
      ).trim()||null,

      condition:String(
        x?.condition||''
      ).trim()||null,

      in_stock:
        typeof x?.in_stock==='boolean'
          ? x.in_stock
          : null

    })).filter(x=>x.url);

    return {
      visual,
      exact:visual.filter(x=>x.exact_match)
    };
  };

  try{

    let body=null;
    let inputMode='url';

    try{

      body=await runLens({
        url:imageUrl
      });

      if(
        !Array.isArray(body?.visual_matches) ||
        body.visual_matches.length===0
      ){
        throw new Error(
          'Lens por URL no devolvió coincidencias'
        );
      }

    }catch(urlError){

      const imageResponse=await fetch(
        imageUrl,
        {
          headers:{
            'user-agent':
              'Mozilla/5.0 LuxuryHunter/1.7',
            accept:
              'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
          },
          signal:AbortSignal.timeout(20000)
        }
      );

      if(!imageResponse.ok){
        throw urlError;
      }

      const contentType=String(
        imageResponse.headers.get('content-type')||''
      ).toLowerCase();

      const buffer=Buffer.from(
        await imageResponse.arrayBuffer()
      );

      if(
        !buffer.length ||
        buffer.length>500*1024
      ){
        throw urlError;
      }

      if(
        !(
          contentType.includes('jpeg') ||
          contentType.includes('jpg') ||
          contentType.includes('png') ||
          contentType.includes('webp')
        )
      ){
        throw urlError;
      }

      const form=new FormData();

      form.append(
        'api_key',
        apiKey
      );

      form.append(
        'image',
        new Blob(
          [buffer],
          {type:contentType}
        ),
        contentType.includes('png')
          ? 'listing.png'
          : contentType.includes('webp')
            ? 'listing.webp'
            : 'listing.jpg'
      );

      const uploadResponse=await fetch(
        'https://serpapi.com/image',
        {
          method:'POST',
          body:form,
          signal:AbortSignal.timeout(30000)
        }
      );

      let uploadBody={};

      try{
        uploadBody=await uploadResponse.json();
      }catch{}

      const imageId=String(
        uploadBody?.image_id||''
      ).trim();

      if(
        !uploadResponse.ok ||
        !imageId
      ){
        throw new Error(
          String(
            uploadBody?.error ||
            'No se pudo subir la imagen a SerpApi'
          )
        );
      }

      body=await runLens({
        image_id:imageId
      });

      inputMode='upload';
    }

    const matches=normalizeMatches(body);

    return {
      enabled:true,
      ok:true,
      checked_at:new Date().toISOString(),
      image_url:imageUrl,
      input_mode:inputMode,
      visual_matches:matches.visual,
      exact_matches:matches.exact,
      search_metadata:{
        id:String(
          body?.search_metadata?.id||''
        ).trim()||null,
        status:String(
          body?.search_metadata?.status||''
        ).trim()||null
      },
      error:null
    };

  }catch(e){

    return {
      ...base,
      error:e?.message||String(e)
    };
  }
}


// LENS TIER 1 BROWSER ENRICHMENT V1
// Lens descubre candidatos visuales. Para Tier 1 intentamos abrir
// la ficha real con navegador renderizado y obtener evidencia visible.
// Esto NO convierte el candidato en comparable automaticamente:
// Gemini sigue validando identidad, precio, estado y condicion.

async function enrichLuxuryLensCandidatesRendered(
  candidates,
  {maxCandidates=8}={}
){
  const pool=(
    Array.isArray(candidates)
      ? candidates
      : []
  ).filter(
    p=>
      p?.url &&
      trustedLuxuryMarketUrl(p.url)
  );

  if(!pool.length)return [];

  const selected=[];
  const selectedUrls=new Set();
  const seenSources=new Set();

  const pushCandidate=p=>{
    const url=String(p?.url||'').trim();

    if(
      !url ||
      selectedUrls.has(url) ||
      selected.length>=maxCandidates
    ){
      return;
    }

    selected.push(p);
    selectedUrls.add(url);
  };

  // Primero diversidad de fuentes Tier 1.
  for(const candidate of pool){
    const source=
      approvedLuxuryMarketSourceName(candidate.url) ||
      luxuryMarketHostname(candidate.url);

    if(seenSources.has(source))continue;

    seenSources.add(source);
    pushCandidate(candidate);

    if(selected.length>=maxCandidates)break;
  }

  // Luego completar con segundos resultados de las mismas fuentes.
  if(selected.length<maxCandidates){
    for(const candidate of pool){
      pushCandidate(candidate);

      if(selected.length>=maxCandidates)break;
    }
  }

  let browser=null;
  let context=null;

  const results=[];

  try{
    const {chromium}=await import('playwright');

    browser=await chromium.launch({
      headless:true,
      args:[
        '--disable-dev-shm-usage',
        '--no-sandbox'
      ]
    });

    context=await browser.newContext({
      locale:'es-ES',
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '+
        'AppleWebKit/537.36 Chrome/152 Safari/537.36'
    });

    await context.route('**/*',route=>{
      const type=route.request().resourceType();

      if(
        type==='image' ||
        type==='media' ||
        type==='font'
      ){
        return route.abort();
      }

      return route.continue();
    });

    for(const candidate of selected){
      const originalUrl=String(
        candidate?.url||''
      ).trim();

      let page=null;

      try{
        page=await context.newPage();

        const response=await page.goto(
          originalUrl,
          {
            waitUntil:'domcontentloaded',
            timeout:25000
          }
        );

        await page.waitForTimeout(2500);

        const bodyText=String(
          await page
            .locator('body')
            .innerText({timeout:5000})
            .catch(()=>'')
        ).trim();

        const finalUrl=String(
          page.url()||originalUrl
        ).trim();

        const httpStatus=
          response?.status?.()??null;

        const finalUrlTrusted=
          trustedLuxuryMarketUrl(finalUrl);

        const httpOk=
          httpStatus==null ||
          (
            httpStatus>=200 &&
            httpStatus<400
          );

        const pageOk=
          !!bodyText &&
          finalUrlTrusted &&
          httpOk;

        results.push({
          url:originalUrl,
          ok:pageOk,
          final_url:finalUrl,
          http_status:httpStatus,
          title:String(
            await page.title().catch(()=>'')
          ).trim(),
          text:pageOk
            ? bodyText.slice(0,6000)
            : '',
          error:pageOk
            ? null
            : (
                !finalUrlTrusted
                  ? 'Redirect fuera de Tier 1'
                  : !httpOk
                    ? `HTTP ${httpStatus}`
                    : 'Pagina sin texto util'
              )
        });

      }catch(e){
        results.push({
          url:originalUrl,
          ok:false,
          final_url:page
            ? String(page.url()||originalUrl)
            : originalUrl,
          http_status:null,
          title:'',
          text:'',
          error:e?.message||String(e)
        });

      }finally{
        if(page){
          await page.close().catch(()=>{});
        }
      }
    }

  }catch(e){
    return selected.map(candidate=>({
      url:String(candidate?.url||'').trim(),
      ok:false,
      final_url:null,
      http_status:null,
      title:'',
      text:'',
      error:e?.message||String(e)
    }));

  }finally{
    if(context){
      await context.close().catch(()=>{});
    }

    if(browser){
      await browser.close().catch(()=>{});
    }
  }

  return results;
}


async function liveMarketResearch({key,model,item,task,exact,onProgress=null}){
  const reportMarket=(pct,stage,detail='')=>{
    try{
      if(typeof onProgress==='function'){
        onProgress(pct,stage,detail);
      }
    }catch{}
  };

  reportMarket(
    68,
    'Buscando comparables de mercado',
    'Ronda 1 de búsqueda con Google'
  );

  if(typeof onProgress==='function'){
    onProgress(
      65,
      'Búsqueda visual',
      'Buscando coincidencias de la imagen en Google Vision'
    );
  }

  const visionWeb=
    await googleVisionWebDetection(item);

  if(typeof onProgress==='function'){
    onProgress(
      67,
      'Búsqueda visual',
      'Buscando coincidencias de la imagen en Google Lens'
    );
  }

  const lensWeb=
    await googleLensSerpApiSearch(item);

  const visionCandidates=(
    Array.isArray(
      visionWeb?.pages_with_matching_images
    )
      ? visionWeb.pages_with_matching_images
      : []
  ).slice(0,25);

  const visionContext=visionCandidates.length
    ? visionCandidates.map((p,idx)=>({
        candidate:idx+1,
        source:visionSourceName(p.url),
        page_title:p.page_title||'',
        url:p.url,
        vision_score:p.score,

        full_match_count:
          Array.isArray(p.full_matching_images)
            ? p.full_matching_images.length
            : 0,

        partial_match_count:
          Array.isArray(p.partial_matching_images)
            ? p.partial_matching_images.length
            : 0
      }))
    : [];

  const lensRawCandidates=(
    Array.isArray(lensWeb?.visual_matches)
      ? lensWeb.visual_matches
      : []
  );

  const lensCandidates=lensRawCandidates
    .filter(p=>approvedLuxuryMarketUrl(p?.url))
    .sort((a,b)=>{
      const priorityDiff=
        luxuryMarketPriorityRank(a?.url)-
        luxuryMarketPriorityRank(b?.url);

      if(priorityDiff!==0)return priorityDiff;

      const ap=
        a?.position==null
          ? 9999
          : Number.isFinite(Number(a.position))
            ? Number(a.position)
            : 9999;

      const bp=
        b?.position==null
          ? 9999
          : Number.isFinite(Number(b.position))
            ? Number(b.position)
            : 9999;

      return ap-bp;
    })
    .slice(0,30);

  const lensContext=lensCandidates.map((p,idx)=>({
    candidate:idx+1,
    source:
      approvedLuxuryMarketSourceName(p.url) ||
      p.source ||
      visionSourceName(p.url),
    title:p.title||'',
    url:p.url,
    image_url:p.image_url||'',
    position:p.position,
    exact_match:p.exact_match===true,
    price:p.price,
    currency:p.currency,
    condition:p.condition,
    in_stock:p.in_stock,
    market_tier:luxuryMarketTier(p.url)
  }));

  reportMarket(
    70,
    'Verificando candidatos Tier 1',
    'Abriendo fichas directas encontradas por Google Lens'
  );

  const lensRenderedEvidence=
    await enrichLuxuryLensCandidatesRendered(
      lensCandidates,
      {maxCandidates:6}
    );

  const lensRenderedContext=
    lensRenderedEvidence.map((entry,idx)=>({
      candidate:idx+1,
      source:
        approvedLuxuryMarketSourceName(
          entry.final_url||entry.url
        ) ||
        approvedLuxuryMarketSourceName(entry.url),
      original_url:entry.url,
      final_url:entry.final_url,
      http_status:entry.http_status,
      ok:entry.ok===true,
      page_title:entry.title||'',
      visible_page_text:entry.text||'',
      error:entry.error||null
    }));

  const prompt=`You are the LIVE MARKET COMPARABLES researcher for Luxury Hunter.
Current date: ${new Date().toISOString().slice(0,10)}.

You MUST use live web search grounding. Research the exact visually identified handbag variant below, not merely the broad model family.

EXACT VISUAL IDENTIFICATION:
${JSON.stringify(exact)}

TARGET:
${task?.product_query||''}

CURRENT LISTING TO EXCLUDE:
${item.url||''}

GOOGLE CLOUD VISION WEB-DETECTION CANDIDATES:
${JSON.stringify(visionContext)}

GOOGLE LENS / SERPAPI VISUAL CANDIDATES:

${JSON.stringify(lensContext)}

RENDERED DIRECT-PAGE EVIDENCE FROM APPROVED TIER 1 LENS CANDIDATES:

${JSON.stringify(lensRenderedContext)}

RENDERED-EVIDENCE RULES:

- This browser-rendered evidence comes from direct Tier 1 reseller pages that Google Lens discovered from the target image.
- Treat visible_page_text as direct-page evidence for that specific URL when ok=true.
- Use it to verify model wording, collaboration/edition, material, colour, condition, SOLD/CURRENT status and visible price when explicitly present.
- A rendered candidate is still NOT automatically a valid comparable.
- You must still classify product identity as EXACT, NEAR or ORIENTATIVE against EXACT VISUAL IDENTIFICATION.
- Do not invent any field that is absent from the rendered page.
- If the rendered page explicitly says sold, you may classify listing_status as SOLD.
- If the rendered page explicitly shows a price, use that observed price and its visible currency.
- Prefer this direct rendered evidence over an unverified Lens snippet when they conflict.
- A redirect to a localized version of the same approved Tier 1 domain is acceptable.
- Never promote a rendered page into valuation when its product match is only ORIENTATIVE.

VISUAL-CANDIDATE RULES:
- The URLs above were discovered from the LISTING IMAGE itself using Google Cloud Vision Web Detection and Google Lens via SerpApi.
- They are research leads, NOT automatically valid comparables.
- You MUST investigate these visual candidates before concluding that no market references exist.
- A visual candidate may be old, archived or sold. Do not discard it merely because of age.
- Historical exact-model references remain useful evidence of model identity and historic market activity.
- For each grounded candidate classify it as EXACT, NEAR or ORIENTATIVE.
- Extract the real source, title, URL, observed price, currency, SOLD/CURRENT status, publication/sale date when genuinely available and condition evidence.

- A price supplied by Google Lens / SerpApi is a DISCOVERY HINT only. Do not treat it as validated market evidence by itself.

- For every Lens candidate, verify the price against the final/direct approved reseller page or grounded Google evidence for that exact listing.

- If Lens returns price=null, actively inspect the final/direct approved page and extract a price only when it is genuinely grounded.

- Never invent, infer or silently reuse a stale snippet price when the direct listing evidence does not support it.
- Different reseller terminology is NOT a reason to reject an otherwise matching product.
- If the candidate is visually relevant but pricing/date evidence cannot be validated, preserve it as research evidence rather than inventing information.
- Do not return zero research results without considering the visual candidates above when they exist.

SOURCE POLICY — APPROVED LUXURY RESALE SOURCES:

Google Search, Google Cloud Vision and Google Lens via SerpApi are DISCOVERY mechanisms only.

A result becomes market evidence ONLY when its final/direct URL belongs to one of the approved Tier 1 or Tier 2 domains below.

TIER 1 — PRIMARY VALUATION EVIDENCE:

EUROPE-PRIORITY TIER 1:
1. vestiairecollective.com — Vestiaire Collective
2. collectorsquare.com — Collector Square
3. hardlyeverwornit.com — HEWI
4. saclab.com — SACLÀB
5. sellierknightsbridge.com — Sellier Knightsbridge
6. luxurypromise.com — Luxury Promise
7. handbagclinic.co.uk — Handbag Clinic
8. resee.com — ReSee

OTHER TIER 1:
9. therealreal.com — The RealReal
10. fashionphile.com — Fashionphile
11. rebag.com — Rebag
12. 1stdibs.com — 1stDibs
13. yoogiscloset.com — Yoogi's Closet
14. whatgoesaroundnyc.com — What Goes Around Comes Around
15. annsfabulousfinds.com — Ann's Fabulous Finds
16. sothebys.com — Sotheby's
17. christies.com — Christie's

TIER 2 — COMPLEMENTARY EVIDENCE ONLY:
- ebay.com
- ebay.co.uk
- ebay.de
- ebay.fr
- ebay.it
- ebay.es

EUROPEAN MARKET PRIORITY:

- The resale target is Europe.
- When product match quality and condition evidence are comparable, prioritize European or Europe-active Tier 1 evidence.
- European preference must NEVER override product mismatch. EXACT/NEAR identity and condition similarity remain more important than geography.
- Non-European Tier 1 evidence remains useful supporting market context when European evidence is insufficient.

TIER RULES:

- Tier 1 is the primary valuation evidence.
- eBay is Tier 2 complementary evidence only.
- eBay alone must never be treated as sufficient primary evidence for a strong market conclusion.
- Treat all localized eBay domains as ONE independent market source.
- Prefer genuinely SOLD / completed eBay evidence over active asking prices when available.
- A SOLD label is valid only when the final/direct page or grounded evidence genuinely supports that the item sold.

HARD SOURCE RULES:
- Do NOT use or return YouTube.
- Do NOT use or return Reddit, Pinterest, Instagram, TikTok or Facebook.
- Do NOT use ShopMy.
- Do NOT use blogs, SEO pages, generic shops, affiliate pages or unknown domains.
- Do NOT use a Google search-result page itself as a comparable.
- Do NOT treat an image-match host as market evidence unless the final/direct landing page belongs to an approved Tier 1 or Tier 2 domain above.
- Brand-new retail MSRP pages are not resale comparables.
- If the approved Tier 1 and Tier 2 sources do not provide enough evidence, report insufficient market evidence. Never relax the approved-source policy.

COMPARABLE RULES:
- Same exact variant/size/material/pattern/edition = EXACT.
- Same variant and size/material but another ordinary colour = NEAR.
- Same family but meaningfully different size/material/edition = ORIENTATIVE and must not drive valuation.
- A sequined or special-edition Baguette is not an exact comparable for an ordinary Zucca canvas Baguette.
- Prefer sold prices when genuinely visible. SOLD / completed transactions are stronger price evidence than active asking prices. Otherwise label CURRENT.
- Do not use new-retail MSRP.
- Do not fabricate a listing, price, URL, sold status or source.
- Historical sold/archive listings are valid research references when they genuinely correspond to the identified model.
- Do NOT discard a genuine exact/near reference only because it is old.
- Historical references may provide product/model evidence, but do not pretend an old price is automatically today's market price.
- For every comparable, extract listing/sale date ONLY when grounded evidence supports it.
- Never invent a date.
- If an exact YYYY-MM-DD date is unavailable, return null and optionally preserve the visible date wording in date_text.
- SOLD means sold only when the source/search evidence genuinely indicates sold.
- CURRENT means currently offered only when that is genuinely supported.
- Return 5-12 evidence-backed comparables when possible.
- Do NOT depend on one exact commercial name. Luxury handbags are frequently listed under incomplete, translated, reseller-created or alternative model names.
- Search multiple naming variants automatically.
- Build search queries from BRAND + MODEL FAMILY + SIZE + MATERIAL/CONSTRUCTION + COLOUR.
- Also try common synonyms and reseller terminology. Examples: woven / intrecciato / intreccio / braided / nappa woven; multicolor / multicolore; shoulder bag / baguette bag.
- Progressively remove over-specific wording if an exact query has weak recall.
- A different listing title does NOT make a result irrelevant if the photographed object and defining visual attributes correspond to the same variant.
- Use image-derived attributes from the exact visual identification as the primary matching criteria.
- Search Europe-first across the approved Tier 1 sources above, then use other approved Tier 1 sources as supporting evidence and eBay only as Tier 2 complementary evidence.
- Use ONLY these match_level values: EXACT, NEAR, ORIENTATIVE.
- EXACT = same model variant with matching size, material/construction, pattern/edition and materially equivalent characteristics.
- NEAR = same genuine model/variant and broadly equivalent size/material, with only ordinary colour, season or minor specification differences that still make it useful for resale valuation.
- ORIENTATIVE = same family but meaningfully different size, material, construction, edition or other characteristics that make it unsuitable for direct valuation.
- Never output CLOSE, CLOSE COMP, IRRELEVANT or any other match_level label.
- A listing title does not need to contain every attribute. If the page clearly corresponds to the same product despite abbreviated reseller naming, classify it from the available evidence rather than rejecting it merely because words are missing.
- Do not count a broad family match as an exact comparable.
- If the first wording produces few results, actively reformulate the search instead of concluding that no market exists.
- Price must be numeric in its listing currency.

CONDITION-BASED VALUATION RULES:
- The target unit condition is included inside EXACT VISUAL IDENTIFICATION.
- For every EXACT or NEAR comparable, research its condition using only grounded evidence available from the reseller page, listing description, platform condition label or other directly supported information.
- Never invent the condition of a comparable.
- If its condition cannot be established, use condition_grade UNKNOWN, condition_relation_to_target UNKNOWN and low/zero confidence.
- condition_relation_to_target MUST be one of SIMILAR, BETTER, WORSE, UNKNOWN.
- SIMILAR means sufficiently comparable physical condition to value THIS target unit.
- Different condition levels may remain useful as general model-market evidence, but MUST NOT be mathematically converted into the target resale price using a fixed percentage.
- Do NOT apply fixed discounts or premiums for EXCELLENT, VERY_GOOD, GOOD, FAIR or POOR.
- Do NOT apply an automatic discount to CURRENT asking prices.
- The final condition-adjusted resale must come from observed prices of condition-SIMILAR comparables.
- If there is insufficient condition-matched evidence, report insufficient evidence instead of inventing a resale adjustment.

SOURCE ORDER (mandatory): (1) NIL'S VESTIAIRE DATABASE blocks below are the PRIMARY evidence: start from them, use its confirmed sales and current listings first. (2) Then your FIRST web search must target Vestiaire Collective (vestiairecollective.com, e.g. "site:vestiairecollective.com <brand> <model> <variant>") and list Vestiaire comparables first. (3) Only after that, use the other approved sources and image-search (Google Lens) results to complete the evidence.${vestiaireSnapshotBlock(task,item,exact)}

Return ONLY JSON:
{
  "comparables": [
    {
      "source": "Vestiaire Collective",
      "title": "listing title",
      "url": "https://...",
      "price": 850,
      "currency": "EUR",
      "listing_status": "SOLD|CURRENT|UNKNOWN",
      "country_or_market": "EU/France/US/etc",
      "match_level": "EXACT|NEAR|ORIENTATIVE",
      "match_reason_es": "short Spanish reason",
      "condition_grade": "EXCELLENT|VERY_GOOD|GOOD|FAIR|POOR|UNKNOWN",
      "condition_confidence": 0.0,
      "condition_relation_to_target": "SIMILAR|BETTER|WORSE|UNKNOWN",
      "condition_evidence_es": ["grounded evidence only"],
      "listing_date": null,
      "sold_date": null,
      "date_text": null,
      "date_type": "LISTED|SOLD|UPDATED|UNKNOWN",
      "date_evidence_es": "grounded date evidence or empty string"
    }
  ],
  "research_notes_es": []
}`;
  const result=await geminiJsonRequest({key,model,parts:[{text:prompt}],googleSearch:true});

  reportMarket(
    76,
    'Primera búsqueda completada',
    'Evaluando relevancia de las referencias encontradas'
  );

  const rawFirstPassComps=
    Array.isArray(result.data?.comparables)
      ? result.data.comparables
      : [];

  let comps=
    rawFirstPassComps.filter(
      approvedLuxuryMarketEntry
    );

  let rejectedUntrustedReferenceCount=
    rawFirstPassComps.length-comps.length;

  const rawFirstPassGrounding=
    Array.isArray(result.groundingSources)
      ? result.groundingSources
      : [];

  let marketGroundingSources=
    rawFirstPassGrounding.filter(
      approvedLuxuryMarketEntry
    );
  let marketWebSearchQueries=Array.isArray(result.webSearchQueries)
    ? result.webSearchQueries
    : [];

  // Recall fallback:
  // La calidad de la primera ronda se mide por comparables realmente
  // utilizables, no por el numero bruto de resultados devueltos.
  const firstPassRelevant=comps.filter(c=>
    ['EXACT','NEAR'].includes(
      String(c?.match_level||'').toUpperCase()
    )
  );

  const firstPassSources=new Set(
    firstPassRelevant
      .map(sourceKey)
      .filter(Boolean)
  );

  const targetConditionGrade=String(
    exact?.condition?.grade||'UNKNOWN'
  ).toUpperCase();

  const targetConditionConfidence=clampNum(
    exact?.condition?.confidence,
    0,
    1
  );

  const targetConditionUsable=
    targetConditionGrade!=='UNKNOWN' &&
    targetConditionConfidence>=0.50;

  const firstPassConditionMatched=firstPassRelevant.filter(c=>
    String(c?.condition_relation_to_target||'').toUpperCase()==='SIMILAR'
  );

  const firstPassConditionSources=new Set(
    firstPassConditionMatched
      .map(sourceKey)
      .filter(Boolean)
  );

  const needsConditionRecall=
    targetConditionUsable &&
    (
      firstPassConditionMatched.length<3 ||
      firstPassConditionSources.size<2
    );

  const needsRecallFallback=
    firstPassRelevant.length<3 ||
    firstPassSources.size<2 ||
    marketGroundingSources.length<2 ||
    needsConditionRecall;

  let recallFallbackUsed=false;

  if(needsRecallFallback){
    recallFallbackUsed=true;

    reportMarket(
      80,
      'Ampliando búsqueda de mercado',
      'Ronda 2 de 2 · nombres alternativos y referencias históricas'
    );
    const fallbackPrompt=`${prompt}

SECOND-PASS MARKET RECALL SEARCH

The first search returned too little usable evidence.

Do a fresh Google-grounded search using BROADER ALTERNATIVE NOMENCLATURE.

Requirements:
1. Keep the visually identified handbag as the target.
2. Generate AND EXECUTE multiple alternative Google search formulations. Do not stop after one wording.
3. Use at least these search strategies when applicable:
   - brand + exact variant/model label
   - brand + model family + material/construction
   - brand + model family + pattern/monogram
   - brand + model family + colour
   - brand + model family + size
   - reference code when a reliable reference is available
4. Progressively remove attributes that resellers commonly omit from titles.
5. Try reseller vocabulary, translations, abbreviations and naming synonyms.
6. Do not require the seller title to equal exact_variant_label.
7. Missing words in the title are not enough to reject a comparable if the remaining evidence identifies the same product.
8. Use ONLY match_level EXACT, NEAR or ORIENTATIVE.
9. For each EXACT/NEAR result, actively look for grounded condition information.
10. Prioritize finding comparables whose physical condition is SIMILAR to the target condition.
11. Do not infer a condition from price alone.
12. Do not convert better/worse condition listings into the target value using a fixed discount or premium.
9. Search specifically for additional results ONLY on the approved Tier 1 sources above plus eBay as Tier 2 complementary evidence. Prioritize European Tier 1 sources. Do not use any other reseller domain, even when Google surfaces it.
10. Continue broadening until you either obtain at least 3 useful EXACT/NEAR comparables from at least 2 independent sources, or the available grounded evidence is genuinely exhausted.
11. Return real URLs and evidence-backed prices whenever available.
12. Do not invent comparables if a page cannot be grounded.

SOURCE ORDER (mandatory): (1) NIL'S VESTIAIRE DATABASE blocks below are the PRIMARY evidence: start from them, use its confirmed sales and current listings first. (2) Then your FIRST web search must target Vestiaire Collective (vestiairecollective.com, e.g. "site:vestiairecollective.com <brand> <model> <variant>") and list Vestiaire comparables first. (3) Only after that, use the other approved sources and image-search (Google Lens) results to complete the evidence.${vestiaireSnapshotBlock(task,item,exact)}

This is a RECALL fallback. The goal is to find genuine listings that a visual Google search would reasonably surface even when their titles use different terminology.`;

    const fallback=await geminiJsonRequest({
      key,
      model,
      parts:[{text:fallbackPrompt}],
      googleSearch:true
    });

    marketWebSearchQueries=[
      ...new Set([
        ...marketWebSearchQueries,
        ...(Array.isArray(fallback.webSearchQueries)?fallback.webSearchQueries:[])
      ].filter(Boolean))
    ];

    reportMarket(
      88,
      'Segunda búsqueda completada',
      'Uniendo y deduplicando referencias'
    );

    const extra=Array.isArray(fallback.data?.comparables)
      ? fallback.data.comparables
      : [];

    // Deduplicar por URL; si no hay URL, usar source/title/price.
    const seen=new Set();

    comps=[...comps,...extra].filter(c=>{
      const keyPart=String(
        c?.url ||
        c?.link ||
        `${c?.source||''}|${c?.title||''}|${c?.price_eur||c?.price||''}`
      ).trim().toLowerCase();

      if(!keyPart) return true;
      if(seen.has(keyPart)) return false;

      seen.add(keyPart);
      return true;
    });

    const sourceSeen=new Set();

    marketGroundingSources=[
      ...marketGroundingSources,
      ...(Array.isArray(fallback.groundingSources)?fallback.groundingSources:[])
    ].filter(s=>{
      const keyPart=String(
        s?.uri ||
        s?.url ||
        s?.title ||
        ''
      ).trim().toLowerCase();

      if(!keyPart) return true;
      if(sourceSeen.has(keyPart)) return false;

      sourceSeen.add(keyPart);
      return true;
    });
  }
  // BACKEND HARD GATE:
  // Ninguna fuente fuera de la whitelist puede llegar a
  // valoración, confidence, referencias o UI.
  const preFinalTrustFilterCount=comps.length;

  comps=comps.filter(
    approvedLuxuryMarketEntry
  );

  rejectedUntrustedReferenceCount+=
    preFinalTrustFilterCount-comps.length;

  marketGroundingSources=
    marketGroundingSources.filter(
      approvedLuxuryMarketEntry
    );

  const structuredResearchReferences=
    comps.slice(0,40).map(c=>({
      source:String(c?.source||'').trim()||sourceKey(c),
      title:String(c?.title||'').trim(),
      url:String(c?.url||c?.link||'').trim(),

      price:
        c?.price==null
          ? null
          : Number.isFinite(Number(c.price))
            ? Number(c.price)
            : null,

      currency:normalizeCurrency(c?.currency),
      price_eur:comparableToEur(c),

      listing_status:String(
        c?.listing_status||'UNKNOWN'
      ).toUpperCase(),

      country_or_market:String(
        c?.country_or_market||''
      ).trim(),

      match_level:String(
        c?.match_level||'ORIENTATIVE'
      ).toUpperCase(),

      match_reason_es:String(
        c?.match_reason_es||''
      ).trim(),

      condition_grade:String(
        c?.condition_grade||'UNKNOWN'
      ).toUpperCase(),

      condition_confidence:
        Number.isFinite(
          Number(c?.condition_confidence)
        )
          ? clampNum(
              Number(c.condition_confidence),
              0,
              1
            )
          : 0,

      condition_relation_to_target:String(
        c?.condition_relation_to_target||
        'UNKNOWN'
      ).toUpperCase(),

      condition_evidence_es:
        Array.isArray(c?.condition_evidence_es)
          ? c.condition_evidence_es.slice(0,6)
          : [],

      listing_date:
        c?.listing_date
          ? String(c.listing_date)
          : null,

      sold_date:
        c?.sold_date
          ? String(c.sold_date)
          : null,

      date_text:
        c?.date_text
          ? String(c.date_text)
          : null,

      date_type:String(
        c?.date_type||'UNKNOWN'
      ).toUpperCase(),

      date_evidence_es:String(
        c?.date_evidence_es||''
      ).trim(),
      market_tier:luxuryMarketTier(
        c?.url||c?.link||''
      )
    })).filter(r=>
      r.source||
      r.title||
      r.url
    );

  const visionResearchReferences=
    visionCandidates.map(p=>({
      source:visionSourceName(p.url),

      title:
        p.page_title ||
        `Coincidencia visual en ${
          visionSourceName(p.url)
        }`,

      url:p.url,

      price:null,
      currency:'',
      price_eur:null,

      listing_status:'UNKNOWN',
      country_or_market:'',

      match_level:'VISUAL_CANDIDATE',

      match_reason_es:
        'Página localizada directamente a partir de la imagen mediante Google Cloud Vision Web Detection. Pendiente de validación como EXACT, NEAR u ORIENTATIVE.',

      condition_grade:'UNKNOWN',
      condition_confidence:0,
      condition_relation_to_target:'UNKNOWN',
      condition_evidence_es:[],

      listing_date:null,
      sold_date:null,
      date_text:null,
      date_type:'UNKNOWN',
      date_evidence_es:'',

      vision_score:
        Number.isFinite(Number(p.score))
          ? Number(p.score)
          : null,

      full_match_count:
        Array.isArray(p.full_matching_images)
          ? p.full_matching_images.length
          : 0,

      partial_match_count:
        Array.isArray(p.partial_matching_images)
          ? p.partial_matching_images.length
          : 0
    }));

  const researchSeen=new Set();

  const researchReferences=[
    ...structuredResearchReferences,
    ...visionResearchReferences
  ].filter(r=>{
    const key=String(
      r.url ||
      `${r.source}|${r.title}`
    ).trim().toLowerCase();

    if(!key)return false;

    if(researchSeen.has(key)){
      return false;
    }

    researchSeen.add(key);
    return true;
  });

  const normalized=[];
  const seen=new Set();

  const compRank={
    EXACT:0,
    NEAR:1,
    ORIENTATIVE:2
  };

  const rankedComps=[...comps].sort((a,b)=>{
    const al=String(a?.match_level||'').toUpperCase();
    const bl=String(b?.match_level||'').toUpperCase();

    const matchDiff=
      (compRank[al]??3)-
      (compRank[bl]??3);

    if(matchDiff!==0)return matchDiff;

    const aUrl=String(
      a?.url||a?.link||''
    ).trim();

    const bUrl=String(
      b?.url||b?.link||''
    ).trim();

    return (
      luxuryMarketPriorityRank(aUrl)-
      luxuryMarketPriorityRank(bUrl)
    );
  });

  for(const c of rankedComps.slice(0,24)){
    const eur=comparableToEur(c);
    const url=String(
      c?.url||c?.link||''
    ).trim();
    const source=
      approvedLuxuryMarketSourceName(url) ||
      String(c?.source||'').trim() ||
      sourceKey(c);
    if(!eur||!source)continue;
    const level=['EXACT','NEAR','ORIENTATIVE'].includes(String(c?.match_level||'').toUpperCase())?String(c.match_level).toUpperCase():'ORIENTATIVE';
    const status=['SOLD','CURRENT','UNKNOWN'].includes(String(c?.listing_status||'').toUpperCase())?String(c.listing_status).toUpperCase():'UNKNOWN';
    const keyId=`${source.toLowerCase()}|${url}|${Math.round(eur)}`;
    if(seen.has(keyId))continue;
    seen.add(keyId);
    let conditionGrade=String(c?.condition_grade||'UNKNOWN')
      .trim()
      .toUpperCase()
      .replace(/[ -]+/g,'_');

    if(!['EXCELLENT','VERY_GOOD','GOOD','FAIR','POOR','UNKNOWN'].includes(conditionGrade)){
      conditionGrade='UNKNOWN';
    }

    let conditionRelation=String(c?.condition_relation_to_target||'UNKNOWN')
      .trim()
      .toUpperCase();

    if(!['SIMILAR','BETTER','WORSE','UNKNOWN'].includes(conditionRelation)){
      conditionRelation='UNKNOWN';
    }

    const conditionConfidenceRaw=Number(c?.condition_confidence);
    const conditionConfidence=Number.isFinite(conditionConfidenceRaw)
      ? clampNum(conditionConfidenceRaw,0,1)
      : 0;

    normalized.push({
      source,
      title:String(c?.title||'').trim(),
      url,
      price:Number(c.price),
      currency:normalizeCurrency(c.currency),
      price_eur:eur,
      listing_status:status,
      country_or_market:String(c?.country_or_market||'').trim(),
      match_level:level,
      match_reason_es:String(c?.match_reason_es||'').trim(),
      condition_grade:conditionGrade,
      condition_confidence:conditionConfidence,
      condition_relation_to_target:conditionRelation,
      condition_evidence_es:Array.isArray(c?.condition_evidence_es)
        ? c.condition_evidence_es.slice(0,6)
        : [],
      market_tier:luxuryMarketTier(url)
    });
  }
  const relevant=normalized.filter(
    c=>c.match_level==='EXACT'||c.match_level==='NEAR'
  );

  const exactOnly=relevant.filter(
    c=>c.match_level==='EXACT'
  );

  const primaryRelevant=relevant.filter(
    c=>c.market_tier==='TIER_1'
  );

  const secondaryRelevant=relevant.filter(
    c=>c.market_tier==='TIER_2'
  );

  // ---------------------------------------------------------
  // MODEL MARKET:
  // precios observados reales, SIN aplicar 0.90 a CURRENT.
  // ---------------------------------------------------------

  const modelPrices=relevant
    .map(c=>roundMoney(c.price_eur))
    .filter(v=>Number.isFinite(v)&&v>0);

  const modelSources=[
    ...new Set(relevant.map(sourceKey).filter(Boolean))
  ];

  const primaryModelSources=[
    ...new Set(
      primaryRelevant.map(sourceKey).filter(Boolean)
    )
  ];

  let modelMarketConfidence='LOW';

  if(
    relevant.length>=3 &&
    primaryRelevant.length>=2 &&
    primaryModelSources.length>=2 &&
    exact.confidence>=0.85
  ){
    modelMarketConfidence='HIGH';
  }else if(
    relevant.length>=2 &&
    primaryRelevant.length>=1 &&
    exact.confidence>=0.70
  ){
    modelMarketConfidence='MEDIUM';
  }

  // ---------------------------------------------------------
  // CONDITION MARKET:
  // SOLO comparables cuyo estado se haya podido contrastar
  // como SIMILAR al bolso que estamos comprando.
  // ---------------------------------------------------------

  const targetCondition=exact?.condition||{
    grade:'UNKNOWN',
    score:null,
    confidence:0
  };

  const targetConditionConfidenceFinal=clampNum(
    targetCondition.confidence,
    0,
    1
  );

  const targetConditionKnown=
    String(targetCondition.grade||'UNKNOWN').toUpperCase()!=='UNKNOWN' &&
    targetConditionConfidenceFinal>=0.50;

  const conditionMatched=relevant.filter(c=>
    c.condition_relation_to_target==='SIMILAR' &&
    c.condition_confidence>=0.50
  );

  const conditionExact=conditionMatched.filter(
    c=>c.match_level==='EXACT'
  );

  const primaryConditionMatched=
    conditionMatched.filter(
      c=>c.market_tier==='TIER_1'
    );

  const secondaryConditionMatched=
    conditionMatched.filter(
      c=>c.market_tier==='TIER_2'
    );

  const conditionSources=[
    ...new Set(conditionMatched.map(sourceKey).filter(Boolean))
  ];

  const conditionPrices=conditionMatched
    .map(c=>roundMoney(c.price_eur))
    .filter(v=>Number.isFinite(v)&&v>0);

  const primaryConditionSources=[
    ...new Set(
      primaryConditionMatched
        .map(sourceKey)
        .filter(Boolean)
    )
  ];

  let conditionMarketConfidence='LOW';

  if(
    targetConditionKnown &&
    targetConditionConfidenceFinal>=0.70 &&
    conditionMatched.length>=3 &&
    primaryConditionMatched.length>=2 &&
    primaryConditionSources.length>=2
  ){
    conditionMarketConfidence='HIGH';
  }else if(
    targetConditionKnown &&
    targetConditionConfidenceFinal>=0.50 &&
    conditionMatched.length>=2 &&
    primaryConditionMatched.length>=1
  ){
    conditionMarketConfidence='MEDIUM';
  }

  // Con un solo comparable o condition incierta NO publicamos
  // un precio de reventa "ajustado". Eso sería inventarlo.
  const conditionValuationUsable=
    conditionMarketConfidence==='HIGH' ||
    conditionMarketConfidence==='MEDIUM';

  const valuationEntries=conditionValuationUsable
    ? conditionMatched
        .map(c=>({
          value:roundMoney(c.price_eur),
          weight:luxuryComparableValuationWeight(c),
          source:c.source,
          url:c.url,
          listing_status:c.listing_status,
          market_tier:c.market_tier,
          europe:europeanLuxuryMarketUrl(c.url)
        }))
        .filter(x=>
          Number.isFinite(x.value) &&
          x.value>0 &&
          Number.isFinite(x.weight) &&
          x.weight>0
        )
    : [];

  const conditionWeightedMean=valuationEntries.length
    ? roundMoney(weightedMean(valuationEntries)??0)||null
    : null;

  const conditionLow=valuationEntries.length
    ? roundMoney(weightedPercentile(valuationEntries,0.10)??0)||null
    : null;

  const conditionMedian=valuationEntries.length
    ? roundMoney(weightedPercentile(valuationEntries,0.50)??0)||null
    : null;

  const conditionHigh=valuationEntries.length
    ? roundMoney(weightedPercentile(valuationEntries,0.75)??0)||null
    : null;

  const conditionConservative=valuationEntries.length
    ? roundMoney(weightedPercentile(valuationEntries,0.25)??0)||null
    : null;

  const conditionQuick=valuationEntries.length
    ? roundMoney(weightedPercentile(valuationEntries,0.15)??0)||null
    : null;

  return {
    comparables:normalized,
    research_references:researchReferences,

    vision_web_detection:visionWeb,
    lens_serpapi:lensWeb,

    lens_rendered_evidence:lensRenderedEvidence,
    lens_rendered_candidate_count:lensRenderedEvidence.length,
    lens_rendered_success_count:
      lensRenderedEvidence.filter(x=>x?.ok===true).length,

    visual_candidate_count:visionCandidates.length,
    lens_candidate_count:lensCandidates.length,
    total_visual_candidate_count:
      visionCandidates.length+
      lensCandidates.length,

    research_candidate_count:researchReferences.length,

    trusted_market_source_policy:'strict_allowlist',

    trusted_market_domains:[
      ...TRUSTED_LUXURY_MARKET_DOMAINS
    ],

    rejected_untrusted_reference_count:
      rejectedUntrustedReferenceCount,

    checked_at:new Date().toISOString(),

    search_passes:recallFallbackUsed?2:1,
    raw_comparable_count:comps.length,

    first_pass_relevant_count:firstPassRelevant.length,
    first_pass_independent_source_count:firstPassSources.size,
    first_pass_condition_matched_count:firstPassConditionMatched.length,
    first_pass_condition_source_count:firstPassConditionSources.size,

    grounding_sources:marketGroundingSources,
    web_search_queries:marketWebSearchQueries,

    research_notes_es:Array.isArray(result.data?.research_notes_es)
      ? result.data.research_notes_es.slice(0,4)
      : [],

    // Mercado general del modelo.
    model_relevant_comparable_count:relevant.length,
    model_exact_comparable_count:exactOnly.length,
    model_independent_source_count:modelSources.length,
    model_market_confidence:modelMarketConfidence,

    model_market_low_eur:modelPrices.length
      ? roundMoney(percentile(modelPrices,0.10)??0)||null
      : null,

    model_market_median_eur:modelPrices.length
      ? roundMoney(percentile(modelPrices,0.50)??0)||null
      : null,

    model_market_high_eur:modelPrices.length
      ? roundMoney(percentile(modelPrices,0.90)??0)||null
      : null,

    // Estado de la unidad que estamos comprando.
    target_condition:targetCondition,

    // Mercado realmente comparable por ESTADO.
    condition_matched_comparable_count:conditionMatched.length,
    condition_exact_comparable_count:conditionExact.length,
    condition_independent_source_count:conditionSources.length,
    condition_market_confidence:conditionMarketConfidence,

    valuation_method:
      'weighted_condition_similar_comparables',

    condition_weighted_mean_eur:
      conditionWeightedMean,

    valuation_weight_policy:{
      tier_1_base:1.00,
      tier_2_ebay_base:0.70,
      europe_multiplier:1.35,
      vestiaire_multiplier:VESTIAIRE_VALUATION_WEIGHT,
      sold_multiplier:1.50,
      current_multiplier:1.00,
      unknown_status_multiplier:0.75
    },

    valuation_entries:
      valuationEntries.map(x=>({
        source:x.source,
        url:x.url,
        price_eur:x.value,
        listing_status:x.listing_status,
        market_tier:x.market_tier,
        europe:x.europe,
        weight:x.weight
      })),

    condition_market_low_eur:conditionLow,
    condition_market_median_eur:conditionMedian,
    condition_market_high_eur:conditionHigh,
    condition_conservative_resale_eur:conditionConservative,
    condition_quick_sale_eur:conditionQuick,

    pricing_method:
      'Observed prices from condition-SIMILAR EXACT/NEAR comparables; no fixed condition or asking-price discount.',

    // -------------------------------------------------------
    // COMPATIBILIDAD:
    // finalizeVerifiedOpportunity ya consume estos nombres.
    // Desde ahora representan CONDITION-ADJUSTED MARKET.
    // -------------------------------------------------------

    relevant_comparable_count:conditionMatched.length,
    exact_comparable_count:conditionExact.length,
    independent_source_count:conditionSources.length,
    market_confidence:conditionMarketConfidence,

    market_low_eur:conditionLow,
    market_median_eur:conditionMedian,
    market_high_eur:conditionHigh,
    conservative_resale_eur:conditionConservative,
    quick_sale_eur:conditionQuick,

    // Se mantiene la propiedad solo por compatibilidad histórica,
    // pero ya NO se aplica ningún factor automático.
    asking_realization_factor:null
  };
}

// MARKETPLACE AUTHENTICITY SIGNAL V1.7
function flattenMarketplaceVerificationValue(value){
  if(value===null||value===undefined)return '';
  if(Array.isArray(value))return value.map(flattenMarketplaceVerificationValue).filter(Boolean).join(' ');
  if(typeof value==='object'){
    return Object.entries(value)
      .filter(([k])=>/care|verify|verification|inspect|inspection|auth|검수|케어|验货|鉴定|认证/i.test(String(k)))
      .map(([k,v])=>`${k}:${flattenMarketplaceVerificationValue(v)}`)
      .filter(Boolean)
      .join(' ');
  }
  return String(value).trim();
}
function marketplaceVerificationBool(value){
  if(value===true||value===1)return true;
  const s=String(value??'').trim().toLowerCase();
  return ['true','1','yes','available','eligible','enabled','supported'].includes(s);
}
function detectMarketplaceVerification(item){
  const source=String(item?.source||'').toLowerCase();
  if(!['xianyu','bunjang'].includes(source)){
    return {status:'NOT_APPLICABLE',service:null,score_bonus:0,confidence:'HIGH',evidence_source:'source_not_supported',evidence_es:[]};
  }

  let raw={};
  try{raw=JSON.parse(item?.raw_json||'{}')}catch{}

  const result=(status,service,evidence_es=[],confidence='HIGH',evidence_source='structured_listing')=>({
    status,
    service,
    score_bonus:status==='PASSED'?8:status==='AVAILABLE'?4:0,
    confidence,
    evidence_source,
    evidence_es
  });

  if(source==='xianyu'){
    const service='Xianyu Verification';
    const info=raw?.['商品信息']&&typeof raw['商品信息']==='object'?raw['商品信息']:{};
    const tagsRaw=info['商品标签']??info['标签']??raw['商品标签']??raw['标签']??[];
    const tags=Array.isArray(tagsRaw)?tagsRaw.map(x=>String(x||'').trim()).filter(Boolean):[String(tagsRaw||'').trim()].filter(Boolean);
    const tagText=tags.join(' ');

    const structuredValues=[
      info['验货宝'],info['验货服务'],info['验货结果'],info['验货状态'],
      info['鉴定结果'],info['鉴定状态'],info['认证结果'],info['服务保障'],info['服务标签'],
      raw['inspectionAvailable'],raw['inspection_available'],raw['verificationAvailable'],
      raw['verification_available'],raw['authCheckAvailable'],raw['verificationStatus'],raw['inspectionStatus']
    ];
    const structuredText=structuredValues.map(flattenMarketplaceVerificationValue).filter(Boolean).join(' ');
    const listingText=[item?.title,item?.description,tagText].filter(Boolean).join(' ').replace(/\s+/g,' ');

    const explicitFailed=/(?:验货宝|验货|鉴定|认证)[^。；;\n]{0,24}(?:未通过|不通过|失败|假货判定|鉴定为假|判定为假)|(?:验货失败|鉴定失败|鉴定为假|假货判定)/i;
    if(explicitFailed.test(structuredText)){
      return result('FAILED',service,['Un campo estructurado del anuncio indica que la verificacion de Xianyu no fue superada.'],'HIGH','structured_verification_result');
    }

    const explicitPassed=/(?:验货宝|验货|鉴定|认证)[^。；;\n]{0,24}(?:已通过|通过|检验通过|验货通过|鉴定通过|认证通过|鉴定真品)|(?:验货通过|鉴定通过|认证通过)/i;
    if(explicitPassed.test(structuredText)){
      return result('PASSED',service,['Un campo estructurado del anuncio indica que la verificacion de Xianyu fue superada.'],'HIGH','structured_verification_result');
    }

    const explicitUnavailable=/(?:不支持|无法|不可|不能)[^。；;\n]{0,12}(?:验货宝|验货|鉴定)|(?:验货宝|验货)[^。；;\n]{0,12}(?:不可用|不支持)/i;
    if(explicitUnavailable.test(structuredText)||explicitUnavailable.test(tagText)){
      return result('UNAVAILABLE',service,['El anuncio indica que Xianyu Verification no esta disponible.'],'HIGH','structured_listing');
    }

    const boolAvailable=[
      info['inspectionAvailable'],info['verificationAvailable'],info['authCheckAvailable'],
      raw['inspectionAvailable'],raw['inspection_available'],raw['verificationAvailable'],
      raw['verification_available'],raw['authCheckAvailable']
    ].some(marketplaceVerificationBool);

    if(tags.some(t=>t==='验货宝'||t.includes('闲鱼验货')||t.includes('官方验货'))||boolAvailable){
      return result('AVAILABLE',service,['El anuncio actual incluye la etiqueta/campo de Xianyu que permite usar su servicio de verificacion.'],'HIGH','structured_listing_tag');
    }

    if(/支持验货宝|可走验货宝|可验货|支持官方验货|验货服务/i.test(listingText)){
      return result('AVAILABLE',service,['El texto del anuncio indica que puede utilizarse Xianyu Verification.'],'MEDIUM','listing_text');
    }

    return result('UNKNOWN',service,['No se ha podido confirmar si este anuncio admite Xianyu Verification.'],'LOW','no_signal');
  }

  const service='Bunjang Care';
  const tags=Array.isArray(raw?.tags)?raw.tags.map(x=>String(x||'').trim()).filter(Boolean):[];
  const metadata=raw?.metadata&&typeof raw.metadata==='object'?raw.metadata:{};

  const directValues=[
    raw?.careEligible,raw?.careAvailable,raw?.isCare,raw?.care_enabled,raw?.bunjangCare,
    raw?.careStatus,raw?.inspectionStatus,raw?.verificationStatus,
    metadata?.careEligible,metadata?.careAvailable,metadata?.isCare,metadata?.care_enabled,
    metadata?.bunjangCare,metadata?.careStatus,metadata?.inspectionStatus,metadata?.verificationStatus
  ];

  const structuredText=[
    tags.join(' '),
    flattenMarketplaceVerificationValue(metadata),
    ...directValues.map(flattenMarketplaceVerificationValue)
  ].filter(Boolean).join(' ');

  const listingText=[item?.title,item?.description,tags.join(' ')].filter(Boolean).join(' ').replace(/\s+/g,' ');

  const explicitFailed=/(?:번개케어|정품\s*검수|검수)[^.;\n]{0,32}(?:불합격|실패|가품\s*판정|위조\s*판정)|(?:검수\s*불합격|검수\s*실패|가품\s*판정)/i;
  if(explicitFailed.test(structuredText)){
    return result('FAILED',service,['Un campo estructurado del anuncio indica que Bunjang Care/inspeccion no fue superada.'],'HIGH','structured_verification_result');
  }

  const explicitPassed=/(?:번개케어|정품\s*검수|검수)[^.;\n]{0,32}(?:검수\s*완료|완료|통과|정품\s*판정)|(?:검수\s*완료|검수\s*통과|정품\s*검수\s*완료)/i;
  if(explicitPassed.test(structuredText)){
    return result('PASSED',service,['Un campo estructurado del anuncio indica que Bunjang Care/inspeccion fue superada.'],'HIGH','structured_verification_result');
  }

  const explicitUnavailable=/(?:번개케어|케어|검수)[^.;\n]{0,20}(?:불가|미지원|안됨|불가능)/i;
  if(explicitUnavailable.test(structuredText)){
    return result('UNAVAILABLE',service,['El anuncio indica que Bunjang Care no esta disponible.'],'HIGH','structured_listing');
  }

  const boolAvailable=[
    raw?.careEligible,raw?.careAvailable,raw?.isCare,raw?.care_enabled,raw?.bunjangCare,
    metadata?.careEligible,metadata?.careAvailable,metadata?.isCare,metadata?.care_enabled,metadata?.bunjangCare
  ].some(marketplaceVerificationBool);

  if(boolAvailable||/(?:^|\s|#)번개케어(?:$|\s|#)/i.test(tags.join(' '))||/번개케어|careEligible:true|careAvailable:true|bunjangCare:true/i.test(structuredText)){
    return result('AVAILABLE',service,['Los campos/tags del anuncio indican que Bunjang Care esta disponible.'],'HIGH','structured_listing_tag');
  }

  if(/번개케어|검수\s*가능|케어\s*가능/i.test(listingText)){
    return result('AVAILABLE',service,['El texto del anuncio indica que Bunjang Care o una inspeccion de plataforma puede utilizarse.'],'MEDIUM','listing_text');
  }

  return result('UNKNOWN',service,['No se ha podido confirmar si este anuncio admite Bunjang Care.'],'LOW','no_signal');
}

// AI WESTERN RESALE FALLBACK V2
async function aiWesternResaleEstimate({
  key,
  model,
  task,
  exact,
  market
}){
  const exactConfidence=clampNum(
    exact?.confidence,
    0,
    1
  );

  const context={
    target_product:
      task?.product_query||'',

    identified_product:{
      brand:
        exact?.brand||'',

      family:
        exact?.family||'',

      exact_variant:
        exact?.exact_variant_label||'',

      size:
        exact?.size||'unknown',

      material:
        exact?.material||'unknown',

      color:
        exact?.main_color||'unknown',

      pattern:
        exact?.pattern||'unknown',

      special_edition:
        exact?.special_edition===true,

      likely_era:
        exact?.likely_era||'unknown',

      identification_confidence:
        exactConfidence
    },

    visible_condition:
      exact?.condition||null,

    live_market_result:{
      relevant_comparables:
        Number(
          market?.relevant_comparable_count||0
        ),

      independent_sources:
        Number(
          market?.independent_source_count||0
        ),

      market_confidence:
        String(
          market?.market_confidence||'LOW'
        )
    }
  };

  const prompt=`You are the FALLBACK WESTERN RESALE VALUATION specialist for Luxury Hunter.

The normal live-market research did not produce enough reliable evidence to publish a market-backed resale valuation.

Estimate the CURRENT plausible Western second-hand resale range of the identified luxury item.

THIS IS AN AI APPROXIMATION, NOT A LIVE MARKET OBSERVATION.

STRICT RULES:
- Do NOT use Google Search.
- Do NOT claim that you found listings, sales or comparables.
- Do NOT invent URLs, sources, listings or sold prices.
- The purchase price is intentionally not supplied. Do NOT try to infer or anchor to it.
- Base the estimate on brand, exact model/variant, size, material, colour, pattern/edition, likely era and visible physical condition.
- Think primarily about the European and US luxury resale markets.
- Estimate what a genuine example in THIS observed condition could plausibly resell for.
- Use your learned understanding of luxury resale pricing only.
- Do not apply a fixed percentage formula for condition.
- If identification, rarity, era or condition is uncertain, widen the range.
- Avoid false precision.
- Round prices to sensible EUR increments.
- confidence may ONLY be LOW or MEDIUM. Never HIGH.
- This estimate must NEVER be described as market verified.
- If a meaningful approximation is genuinely impossible, return estimate_available false.

INPUT:
${JSON.stringify(context)}

Return ONLY JSON:
{
  "estimate_available": true,
  "low_eur": 800,
  "high_eur": 1100,
  "confidence": "LOW|MEDIUM",
  "rationale_es": "Explicación breve en español.",
  "assumptions_es": [
    "Supuesto relevante"
  ]
}`;

  const result=await geminiJsonRequest({
    key,
    model,
    parts:[{text:prompt}],
    googleSearch:false
  });

  const data=result?.data||{};

  if(data?.estimate_available===false){
    return {
      available:false,
      source:'AI_ESTIMATE',
      confidence:'LOW',
      low_eur:null,
      high_eur:null,
      midpoint_eur:null,
      rationale_es:
        String(
          data?.rationale_es||''
        ).trim(),
      assumptions_es:
        Array.isArray(data?.assumptions_es)
          ? data.assumptions_es
              .map(x=>String(x||'').trim())
              .filter(Boolean)
              .slice(0,6)
          : [],
      generated_at:
        new Date().toISOString()
    };
  }

  let low=Number(data?.low_eur);
  let high=Number(data?.high_eur);

  if(
    !Number.isFinite(low) ||
    !Number.isFinite(high) ||
    low<=0 ||
    high<=0
  ){
    return {
      available:false,
      source:'AI_ESTIMATE',
      confidence:'LOW',
      low_eur:null,
      high_eur:null,
      midpoint_eur:null,
      rationale_es:
        'La IA no produjo un rango de precio utilizable.',
      assumptions_es:[],
      generated_at:
        new Date().toISOString()
    };
  }

  if(low>high){
    const temp=low;
    low=high;
    high=temp;
  }

  low=Math.max(
    25,
    Math.round(low/25)*25
  );

  high=Math.max(
    low,
    Math.round(high/25)*25
  );

  let confidence=
    String(
      data?.confidence||'LOW'
    ).toUpperCase();

  if(
    confidence!=='MEDIUM' ||
    exactConfidence<0.80
  ){
    confidence='LOW';
  }

  return {
    available:true,
    source:'AI_ESTIMATE',
    confidence,
    low_eur:low,
    high_eur:high,
    midpoint_eur:
      Math.round(
        ((low+high)/2)/25
      )*25,
    rationale_es:
      String(
        data?.rationale_es||''
      ).trim(),
    assumptions_es:
      Array.isArray(data?.assumptions_es)
        ? data.assumptions_es
            .map(x=>String(x||'').trim())
            .filter(Boolean)
            .slice(0,6)
        : [],
    generated_at:
      new Date().toISOString(),
    method:
      'Gemini learned market knowledge; no Google Search; no live comparables'
  };
}

function finalizeVerifiedOpportunity(preliminary,exact,market,economics,marketplaceVerification={}){
  const landed=Number(economics.importedTotalEur)||0;
  const marketNumber=v=>{
    if(v===null||v===undefined||v==='')return null;
    const n=Number(v);
    return Number.isFinite(n)?n:null;
  };

  const marketConservative=
    marketNumber(
      market.conservative_resale_eur
    );

  const marketHigh=
    marketNumber(
      market.market_high_eur
    );

  const marketLow=
    marketNumber(
      market.market_low_eur
    );

  const aiEstimate=
    market?.ai_resale_estimate &&
    typeof market.ai_resale_estimate==='object'
      ? market.ai_resale_estimate
      : {};

  const aiLow=
    marketNumber(
      aiEstimate?.low_eur
    );

  const aiHigh=
    marketNumber(
      aiEstimate?.high_eur
    );

  const marketEstimateAvailable=
    Number.isFinite(
      marketConservative
    );

  const aiEstimateAvailable=
    aiEstimate?.available===true &&
    Number.isFinite(aiLow) &&
    Number.isFinite(aiHigh);

  let resaleEstimateSource=
    marketEstimateAvailable
      ? 'MARKET_ANALYSIS'
      : aiEstimateAvailable
        ? 'AI_ESTIMATE'
        : 'UNAVAILABLE';

  const resaleEstimateConfidence=
    resaleEstimateSource==='MARKET_ANALYSIS'
      ? String(
          market?.market_confidence||'LOW'
        ).toUpperCase()
      : resaleEstimateSource==='AI_ESTIMATE'
        ? String(
            aiEstimate?.confidence||'LOW'
          ).toUpperCase()
        : 'LOW';

  let conservative=
    resaleEstimateSource==='MARKET_ANALYSIS'
      ? marketConservative
      : resaleEstimateSource==='AI_ESTIMATE'
        ? aiLow
        : null;

  let low=
    resaleEstimateSource==='MARKET_ANALYSIS'
      ? marketConservative
      : resaleEstimateSource==='AI_ESTIMATE'
        ? aiLow
        : null;

  let high=
    resaleEstimateSource==='MARKET_ANALYSIS'
      ? (
          Number.isFinite(marketHigh)
            ? marketHigh
            : marketConservative
        )
      : resaleEstimateSource==='AI_ESTIMATE'
        ? aiHigh
        : null;

  // Con anuncios iguales o de la misma talla en la base de Vestiaire de Nil,
  // la reventa sale de ellos (precio al que de verdad se venden). Sin ellos,
  // la base solo hace de techo y, si no hay nada parecido, queda el pronóstico.
  const comps=market?.sheet_comps||null;
  const dbTier=comps&&(comps.tier==='iguales'||comps.tier==='misma_talla');
  const anchor=market?.sheet_anchor||null;
  let anchorNote='';
  if(dbTier){
    low=comps.low;high=comps.high;conservative=comps.low;
    resaleEstimateSource='VESTIAIRE_DB';
    anchorNote=vestiaireComparablesNote(comps);
  }else if(anchor&&Number.isFinite(low)){
    const c=clampResaleToAnchor(low,high,anchor);
    if(c.changed)anchorNote=`Reventa ajustada con tu base de Vestiaire (${anchor.n} anuncios, ${anchor.basis}; se venden al ${Math.round(anchor.ratio*100)} % del precio pedido): venta realista ${anchor.low}-${anchor.high} EUR.`;
    low=c.low;high=c.high;conservative=c.low;
  }

  const profit=
    Number.isFinite(conservative)
      ? roundMoney(
          conservative-landed
        )
      : null;

  const highProfit=
    Number.isFinite(high)
      ? roundMoney(
          high-landed
        )
      : profit;
  const auth=String(preliminary.authenticity_risk||'').toUpperCase();
  const liquidity=String(preliminary.liquidity||'').toUpperCase();
  const conf=clampNum(exact.confidence,0,1);
  // La base de Nil cuenta como una fuente más con sus anuncios parecidos.
  const dbN=dbTier?Number(comps.n)||0:0;
  const compN=Math.max(Number(market.relevant_comparable_count||0),dbN);
  const exactN=Math.max(Number(market.exact_comparable_count||0),comps?.tier==='iguales'?dbN:0);
  const sourceN=Number(market.independent_source_count||0)+(dbTier?1:0);
  let mconf=String(market.market_confidence||'LOW').toUpperCase();
  if(dbTier&&mconf==='LOW'&&dbN>=(comps.tier==='iguales'?3:6))mconf='MEDIUM';
  const marketplaceStatus=String(marketplaceVerification?.status||'UNKNOWN').toUpperCase();
  const reasons=[];
  let decision='WATCH';
  if(marketplaceStatus==='FAILED'){
    decision='REJECT';
    reasons.push(`La verificacion de ${marketplaceVerification?.service||'marketplace'} figura como no superada y bloquea la oportunidad.`);
  }else if(!exact.target_match){
    decision='REJECT';
    reasons.push(`El chequeo visual exacto indica que no corresponde al target: ${exact.exact_variant_label||exact.family||'variante distinta'}.`);
  }else if(auth==='HIGH'){
    decision='REJECT';
    reasons.push('El riesgo de autenticidad preliminar es alto y bloquea la oportunidad.');
  }else if(resaleEstimateSource==='AI_ESTIMATE'){
    decision='WATCH';

    reasons.push(
      `No hay evidencia de mercado suficiente para verificar la reventa. Se muestra una estimación IA occidental de ${Math.round(low)}-${Math.round(high)} EUR con confianza ${resaleEstimateConfidence}.`
    );

  }else if(!Number.isFinite(conservative)||compN===0){
    decision='WATCH';
    reasons.push('La variante se reviso, pero no hay comparables exactos o suficientemente cercanos ni una estimación IA utilizable para fijar una reventa.');
  }else if(Number.isFinite(profit)&&profit<200){
    decision='REJECT';
    reasons.push(`Tras contrastar comparables, el margen conservador estimado es de ${Math.round(profit)} EUR, por debajo del minimo operativo.`);
  }else if(conf<0.75||mconf==='LOW'||sourceN<2||compN<2||(exact.special_edition===true&&exactN<2)){
    decision='WATCH';
    reasons.push('El chequeo exacto y de mercado se completo, pero la evidencia aun no es suficientemente solida para elevarlo a BUY.');
  }else if(Number.isFinite(profit)&&profit>400&&conf>=0.85&&mconf==='HIGH'&&compN>=3&&sourceN>=2&&liquidity!=='LOW'){
    decision='STRONG BUY';
  }else if(Number.isFinite(profit)&&profit>=300&&conf>=0.75&&mconf!=='LOW'&&compN>=2&&sourceN>=2){
    decision='BUY';
  }else{
    decision='WATCH';
  }
  if(exact.target_match)reasons.push(`Variante visual: ${exact.exact_variant_label||exact.family||'sin etiqueta exacta'} (${Math.round(conf*100)}% de confianza).`);
  if(marketplaceStatus==='PASSED')reasons.push(`${marketplaceVerification.service}: verificacion superada segun evidencia estructurada del marketplace; es una senal positiva adicional, no una garantia absoluta de autenticidad.`);
  else if(marketplaceStatus==='AVAILABLE')reasons.push(`${marketplaceVerification.service}: disponible para este anuncio; reduce el riesgo operativo de compra, pero no demuestra por si sola la autenticidad.`);
  if(compN)reasons.push(`${compN} comparables exactos/cercanos en ${sourceN} fuentes independientes; confianza de mercado ${mconf}.`);
  if(anchorNote)reasons.unshift(anchorNote);
  if(
    Number.isFinite(conservative) &&
    resaleEstimateSource==='MARKET_ANALYSIS'
  ){
    reasons.push(
      `Reventa conservadora contrastada: ${Math.round(conservative)} EUR; margen conservador: ${Math.round(profit)} EUR.`
    );
  }

  if(
    Number.isFinite(conservative) &&
    resaleEstimateSource==='AI_ESTIMATE'
  ){
    reasons.push(
      `Reventa orientativa por IA: ${Math.round(low)}-${Math.round(high)} EUR; margen orientativo desde ${Math.round(profit)} EUR. No es una valoración de mercado verificada.`
    );
  }
  const profitScore=Number.isFinite(profit)?clampNum((profit-150)/4,0,100):20;
  const marketScore=mconf==='HIGH'?95:mconf==='MEDIUM'?68:35;
  const authScore=auth==='LOW'?92:auth==='MEDIUM'?62:10;
  const liquidityScore=liquidity==='HIGH'?90:liquidity==='MEDIUM'?65:35;
  const verificationBonus=marketplaceStatus==='PASSED'?8:marketplaceStatus==='AVAILABLE'?4:0;
  let score=Math.round(0.35*profitScore+0.20*(conf*100)+0.20*marketScore+0.15*authScore+0.10*liquidityScore+verificationBonus);
  score=Math.round(clampNum(score,0,100));
  if(marketplaceStatus==='FAILED')score=0;
  else if(decision==='REJECT')score=Math.min(score,55);
  if(decision==='WATCH')score=Math.min(score,79);

  if(resaleEstimateSource==='AI_ESTIMATE'){
    score=Math.min(score,69);
  }

  const final={
    decision,
    opportunity_score:score,
    resale_low_eur:Number.isFinite(low)?low:null,
    resale_high_eur:Number.isFinite(high)?high:null,

    resale_estimate_source:
      resaleEstimateSource,

    resale_estimate_confidence:
      resaleEstimateConfidence,

    resale_estimate_market_verified:
      resaleEstimateSource==='MARKET_ANALYSIS'||resaleEstimateSource==='VESTIAIRE_DB',

    landed_cost_eur:landed,
    net_profit_low_eur:Number.isFinite(profit)?profit:null,
    net_profit_high_eur:Number.isFinite(highProfit)?highProfit:null,
    decision_reasons_es:reasons.slice(0,4)
  };
  return market.bag_sheet_required===true?applyBagSheetPolicy(final,comps,{fresh:market.sheet_fresh===true}):final;
}
function storeTaskAnalysis(taskId,item,a,preliminaryDecision,verification,now){
  const reasons=reasonsForStorage(a);
  a.decision_reasons_es=reasons;
  db.prepare(`INSERT INTO task_analyses(task_id,listing_id,brand,model,authenticity_risk,liquidity,decision,opportunity_score,resale_low_eur,resale_high_eur,landed_cost_eur,net_profit_low_eur,net_profit_high_eur,notes,decision_reasons_es_json,raw_json,updated_at,preliminary_decision,verification_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(task_id,listing_id) DO UPDATE SET brand=excluded.brand,model=excluded.model,authenticity_risk=excluded.authenticity_risk,liquidity=excluded.liquidity,decision=excluded.decision,opportunity_score=excluded.opportunity_score,resale_low_eur=excluded.resale_low_eur,resale_high_eur=excluded.resale_high_eur,landed_cost_eur=excluded.landed_cost_eur,net_profit_low_eur=excluded.net_profit_low_eur,net_profit_high_eur=excluded.net_profit_high_eur,notes=excluded.notes,decision_reasons_es_json=excluded.decision_reasons_es_json,raw_json=excluded.raw_json,updated_at=excluded.updated_at,preliminary_decision=excluded.preliminary_decision,verification_json=excluded.verification_json`)
    .run(Number(taskId),item.id,a.brand||'',a.model||'',a.authenticity_risk||'',a.liquidity||'',a.decision||'',numberOrNull(a.opportunity_score),numberOrNull(a.resale_low_eur),numberOrNull(a.resale_high_eur),numberOrNull(a.landed_cost_eur),numberOrNull(a.net_profit_low_eur),numberOrNull(a.net_profit_high_eur),a.notes||'',JSON.stringify(reasons),JSON.stringify(a),now,preliminaryDecision||a.decision||'',JSON.stringify(verification||{}));
}
function storeStandaloneAnalysis(item,a,now){
  const reasons=reasonsForStorage(a);
  a.decision_reasons_es=reasons;
  db.prepare(`INSERT INTO analyses(listing_id,brand,model,authenticity_risk,liquidity,decision,opportunity_score,resale_low_eur,resale_high_eur,landed_cost_eur,net_profit_low_eur,net_profit_high_eur,notes,decision_reasons_es_json,raw_json,updated_at,preliminary_decision,verification_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(listing_id) DO UPDATE SET brand=excluded.brand,model=excluded.model,authenticity_risk=excluded.authenticity_risk,liquidity=excluded.liquidity,decision=excluded.decision,opportunity_score=excluded.opportunity_score,resale_low_eur=excluded.resale_low_eur,resale_high_eur=excluded.resale_high_eur,landed_cost_eur=excluded.landed_cost_eur,net_profit_low_eur=excluded.net_profit_low_eur,net_profit_high_eur=excluded.net_profit_high_eur,notes=excluded.notes,decision_reasons_es_json=excluded.decision_reasons_es_json,raw_json=excluded.raw_json,updated_at=excluded.updated_at,preliminary_decision=excluded.preliminary_decision,verification_json=excluded.verification_json`)
    .run(item.id,a.brand||'',a.model||'',a.authenticity_risk||'',a.liquidity||'',a.decision||'',numberOrNull(a.opportunity_score),numberOrNull(a.resale_low_eur),numberOrNull(a.resale_high_eur),numberOrNull(a.landed_cost_eur),numberOrNull(a.net_profit_low_eur),numberOrNull(a.net_profit_high_eur),a.notes||'',JSON.stringify(reasons),JSON.stringify(a),now,a.decision||'',JSON.stringify(a.market_verification||{status:'not_applicable',reason:'no_task_context'}));
}
// ── ANÁLISIS CON REFERENCIAS ELEGIDAS POR LA IA (regla de Nil, 06-11-2026) ─
// 1) Referencias candidatas: las del mismo modelo en la hoja de Nil (Google
//    Drive) y, en bolsos, los anuncios de Vestiaire en directo del modelo.
// 2) La IA NO pone precio: identifica el producto, valora estado y calidad
//    (fotos, accesorios, desgaste) y el riesgo de autenticidad, y dice una a
//    una qué referencias son el MISMO producto con un estado parecido.
// 3) El bot calcula la media de precio de esas (vendidas, recientes y con
//    más likes pesan más), por separado la base y Vestiaire, y decide con el
//    beneficio limpio y el margen; la calidad de la IA cuenta en la nota.
// 4) Si sale rentable, se confirma con el modelo fuerte y más fotos.
// Primera pasada: las 80 que más pesan (con fotos del anuncio). Después se
// revisa el resto de la base del modelo, ordenado por parecido con lo que la
// IA ha identificado (talla, material, color), en tandas de 80 y sin fotos:
// así no se escapan fichas iguales en pestañas grandes (Chanel tiene 750).
const REF_MAX_BASE=Number(process.env.REF_MAX_BASE||80);
const REF_EXTRA_BASE=Number(process.env.REF_EXTRA_BASE||320);
const REF_MAX_LIVE=Number(process.env.REF_MAX_LIVE||96);
const REF_MAT_CLASS=[['exotica',/croco|alligat|python|pit[oó]n|ostrich|avestruz|lizard|lagarto|stingray|exotic/i],['ante',/suede|ante\b|daim|nubuck|绒/i],['tela',/canvas|lona|toile|nylon|nail[oó]n|tela|fabric|denim|tweed|jacquard|cotton|algod[oó]n|raffia|paja|帆布|尼龙/i],['sintetica',/vegana|vegan|sint[eé]tic|faux|imitaci|ecopiel|合成皮革|フェイクレザー/i],['charol',/charol|patent|vernis|エナメル|漆皮/i],['piel',/leather|cuero|piel|calf|lamb|caviar|cordero|becerro|charol|patent|皮/i]];
const refMatClass=t=>(REF_MAT_CLASS.find(([,re])=>re.test(String(t||'')))||[])[0]||null;
const refColour=t=>(typeof VESTIAIRE_COLOR_RE!=='undefined'?VESTIAIRE_COLOR_RE.find(([,re])=>re.test(String(t||''))):null)?.[0]||null;
const refSize=t=>typeof vestiaireSizeLabel==='function'?vestiaireSizeLabel(String(t||'')):null;
function rankByIdentity(rows,ident){
  const size=refSize(`${ident?.size||''} ${ident?.variant||''}`), mat=refMatClass(ident?.material), col=refColour(ident?.colour);
  // Relojes (y bolsos con código): la misma referencia o la misma familia de
  // referencia (mismas 4-5 primeras letras/cifras) van delante.
  const flat=v=>String(v||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
  const idRefs=[...String(`${ident?.model||''} ${ident?.variant||''} ${ident?.size||''}`).toUpperCase().matchAll(/[A-Z0-9][A-Z0-9.\- ]{3,}[0-9][A-Z0-9]*/g)]
    .map(m=>flat(m[0])).filter(x=>x.length>=5&&/\d{3}/.test(x));
  const refScore=r=>{
    if(!idRefs.length)return 0;
    const rr=flat(`${r.size||''}`);if(rr.length<5)return 0;
    if(idRefs.some(x=>x.includes(rr)||rr.includes(x)))return 6;
    return idRefs.some(x=>x.slice(0,5)===rr.slice(0,5))?4:idRefs.some(x=>x.slice(0,4)===rr.slice(0,4))?2:0;
  };
  const score=r=>refScore(r)+(size&&refSize(`${r.size||''} ${r.model||''} ${r.notes||''}`)===size?3:0)+(mat&&refMatClass(`${r.material||''} ${r.notes||''}`)===mat?2:0)+(col&&refColour(r.color)===col?1:0);
  return rows.map((r,i)=>({r,i,s:score(r)})).sort((a,b)=>b.s-a.s||a.i-b.i).map(x=>x.r);
}
function baseReferenceRows(task,item){
  const tabs=vestiaireRefs().tasks||{};
  const watch=isWatchTask(task?.task_name);
  const texts={title:item?.title||'',label:'',description:item?.description||''};
  const usable=rows=>(rows||[]).filter(f=>Number(f.price_eur)>0||Number(f.sold_price_eur)>0);
  const own=tabs[task?.task_name];
  if(own&&Array.isArray(own.fichas)&&own.fichas.length){
    const m=sameModelRows(task.task_name,usable(own.fichas),texts);
    return {tab:task.task_name,model:m?.key||null,rows:m?.rows?.length?m.rows:usable(own.fichas)};
  }
  // Tareas sin pestaña propia (Radar): el modelo que nombre el anuncio, en cualquier pestaña del mismo tipo.
  let best=null;
  for(const [name,r] of Object.entries(tabs)){
    if(isWatchTask(name)!==watch||!Array.isArray(r?.fichas))continue;
    const m=sameModelRows(name,usable(r.fichas),texts,{requireNamed:true});
    if(m&&(!best||m.rows.length>best.rows.length))best={tab:name,model:m.key,rows:m.rows};
  }
  return best||{tab:null,model:null,rows:[]};
}
async function liveReferenceRows(task,item,baseModel=null,baseBrand=''){
  // Todos los anuncios se comparan también con Vestiaire en directo, relojes
  // incluidos (regla de Nil, 07-11-2026).
  const watch=isWatchTask(task?.task_name);
  // El modelo que la base reconoce en el anuncio ("saint laurent · le 5 a 7",
  // "black bay 58"), con la marca delante si no la lleva.
  let fromBase=baseModel?String(baseModel).replace(/\s*·\s*/g,' ').trim():'';
  const b=String(baseBrand||'').trim();
  if(fromBase&&b&&!fromBase.toLowerCase().includes(b.toLowerCase()))fromBase=`${b} ${fromBase}`;
  fromBase=fromBase.toLowerCase().slice(0,70);
  // Relojes: primero el modelo concreto (en la tarea caben varios: Santos y Tank).
  const query=(watch&&fromBase.length>=3?fromBase:'')||vestiaireTaskQuery(task?.task_name)||(fromBase.length>=3?fromBase:'')||vestiaireLiveQuery(item,{});
  if(!query)return {status:'no_query',rows:[]};
  try{
    const r=await vestiaireLiveSearchRows(query);
    return r.status==='ok'?{status:'ok',query,model:r.model,rows:(r.rows||[]).map(x=>({...x,sold_price_eur:x.sold?x.price_eur:null}))}:{status:r.status,query,rows:[]};
  }catch(e){return {status:'error',query,rows:[],error:String(e.message||e).slice(0,160)};}
}
const LISTING_AI_INSTRUCTION=`You are the listing inspector of Luxury Hunter (second-hand luxury bags and watches bought in Asia/Japan/eBay and resold in Europe).
YOUR JOB IS NOT TO PRICE THE ITEM. Luxury Hunter computes the price from the references you select. Never estimate resale prices, never judge whether the price is good.

Do three things:
1. IDENTIFY the item from title, description and photos: brand, model, exact variant, size (name and/or measurements), material, colour, hardware. Say whether it matches the TARGET of the task (target_match). Accessories only, wallets/pouches when the target is a bag, other models, replicas → target_match false.
2. JUDGE THE LISTING: condition grade, visible wear or damage, completeness (box, dust bag, card, strap, papers for watches), photo quality and how much can be checked, and authenticity risk. quality_score 0-100 = how good the item and the listing are (100 = like new, complete, many clear photos; 50 = normal used item with average photos; below 30 = damaged, incomplete or impossible to check). authenticity_risk HIGH only with concrete evidence (replica wording, failed verification, clear defects of a fake); suspicion alone is MEDIUM.
3. PRE-SELECT REFERENCES ONE BY ONE. Below are reference listings from Nil's database (codes B…) and from Vestiaire Collective right now (codes V…). For EVERY reference decide if it can be the SAME PRODUCT as the listing: same model AND same version/size/format (Mini ≠ Small ≠ regular ≠ Large; different measurements = different product), same material family (colour may differ), and a SIMILAR CONDITION (at most one grade apart). Put the ones the text confirms in *_same. Put in *_similar the ones of the same model whose size/version or condition the text does not make clear (they will be checked with photos). Leave out everything that is clearly another model, size, material or format. Use only what the reference text says; do not guess.

WATCHES: the same product means the same reference family (2541.80 ≠ 2531.80), the same movement type (quartz ≠ automatic ≠ chronograph), the same case size and material. Check the reference number, "quartz/quarzo/クオーツ/石英" and "automatic/automatico/自動巻き/自动" words in titles and notes.

EXOTIC SKIN POLICY: genuine crocodile, alligator, python/snake, ostrich, lizard or stingray → exotic_skin true.

Return ONLY JSON:
{"brand":"","model":"","variant":"","size":"","material":"","colour":"","hardware":"","target_match":true,"condition_grade":"Nuevo|Como nuevo|Muy buen estado|Buen estado|Correcto|Malo","completeness_es":"","quality_score":0,"authenticity_risk":"LOW|MEDIUM|HIGH","exotic_skin":false,"confidence":0.0,"base_same":["B1"],"base_similar":[],"vestiaire_same":["V3"],"vestiaire_similar":[],"decision_reasons_es":["1 a 4 motivos breves en español sobre identificación, estado, calidad y autenticidad; nada de precios"]}`;
function referencePrompt(task,item,base,live,economics){
  const ctx=`TASK: ${task.task_name}\nTARGET PRODUCT: ${task.product_query}\nTASK CRITERIA:\n${String(task.description||'').slice(0,1500)}`;
  return `${LISTING_AI_INSTRUCTION}\n\n${ctx}\n\nLISTING\nSOURCE: ${item.source}\nTITLE: ${item.title}\nDESCRIPTION: ${String(item.description||'').slice(0,2500)}\nMARKETPLACE VERIFICATION: ${JSON.stringify(detectMarketplaceVerification(item))}\n\n`+
    `REFERENCES FROM NIL'S DATABASE (code | model | size | measurements | material | colour | condition | sold? | published | notes):\n${refTable(base)||'(none)'}\n\n`+
    `REFERENCES FROM VESTIAIRE NOW (same columns; material comes from the listing URL):\n${refTable(live)||'(none)'}`;
}
function referenceCompsForAlert(price,{tab,model,source}){
  if(!price)return null;
  return {rule_version:MATCH_VERSION,tier:'ia_iguales',source,tab,model,basis:'iguales, comprobadas con foto',n:price.n,low:price.low,mid:price.mid,mean:price.mean,high:price.high,
    sold_n:price.sold_n,recent_n:price.recent_n,likes_max:price.likes_max,price_basis:price.price_basis,ratio:price.ratio,picks:price.picks,weighted:price.weighted};
}
// COMPROBACIÓN CON FOTOS (regla de Nil, 07-11-2026): la media solo sale de
// referencias que la IA ha visto en foto y son el mismo bolso (mismo modelo,
// misma talla/versión, mismo material). Si no hay ninguna, no hay precio ni
// referencias en el aviso.
const REF_PHOTO_MAX=Number(process.env.REF_PHOTO_MAX||12);
// SELECCIÓN DE REFERENCIAS (regla de Nil, 07-11-2026): siempre del mismo
// modelo; las elige el bot, no la IA. Mismo material obligatorio; si el
// anuncio dice su talla o medidas, solo esa talla (±15 %); delante las de
// mismas medidas y mismo color. Solo esas (REF_PHOTO_MAX, 12) se comprueban
// con fotos.
const REF_SIZE_JP=[['Mini',/ミニ|ﾐﾆ|迷你/],['Small',/スモール|小号/],['Medium',/ミディアム|ミディアム|中号/],['Large',/ラージ|大号|ラージュ/]];
// Relojes: el diámetro de la caja en mm (el primer número de "41 x 47 mm").
const caseMm=t=>{const m=String(t||'').match(/(\d{2}(?:[.,]\d)?)\s*(?:mm|ミリ|毫米)|(\d{2}(?:[.,]\d)?)\s*[x×]\s*\d{2}(?:[.,]\d)?\s*mm/i);const n=m?Number(String(m[1]||m[2]).replace(',','.')):NaN;return n>=18&&n<=60?n:null;};
function listingWidthCm(text){
  const t=String(text||'');
  const mm=caseMm(t);
  if(mm)return mm/10;
  const w=vestiaireWidthCm(t);
  if(w)return w;
  const m=t.match(/(?:W|横幅?|幅|width|ancho|largo)\s*[:：]?\s*(?:約|约|approx\.?|aprox\.?)?\s*(\d{1,2}(?:[.,]\d)?)\s*(?:cm|センチ|㎝)/i)
    ||t.match(/(?:マトラッセ|matelass[eé]|classic flap|timeless|クラシック|ラムスキン)\s*(\d{2})(?!\d)/i);
  const n=m?Number(String(m[1]).replace(',','.')):NaN;
  return n>=8&&n<80?n:null;
}
function listingSizeLabel(text){
  const v=vestiaireSizeLabel(text);
  return (v&&v!=='Bandolera'?v:null)||(REF_SIZE_JP.find(([,re])=>re.test(String(text||'')))||[])[0]||null;
}
function pickPhotoRefs(rows,{ident={},item={},boost={},max=REF_PHOTO_MAX}={}){
  const text=`${item.title||''} ${item.description||''}`;
  const unsure=/no (indicad|especificad|confirm)|parece|probabl|desconoc|unknown|not (stated|given)/i.test(String(ident.size||''));
  // Talla dicha en el anuncio (texto): filtro duro. Talla deducida por la IA: solo puntúa.
  const hardW=listingWidthCm(text), hardS=listingSizeLabel(item.title||'');
  const guessW=hardW||(unsure?null:listingWidthCm(ident.size)), guessS=hardS||(unsure?null:listingSizeLabel(`${ident.size||''} ${ident.variant||''}`));
  const lMat=refMatClass(ident.material)||refMatClass(text), lCol=refColour(ident.colour);
  const flat=v=>String(v||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
  const idRefs=[...String(`${ident.model||''} ${ident.variant||''} ${ident.size||''} ${item.title||''}`).toUpperCase().matchAll(/[A-Z0-9][A-Z0-9.\- ]{3,}[0-9][A-Z0-9]*/g)]
    .map(m=>flat(m[0])).filter(x=>x.length>=5&&/\d{3}/.test(x));
  const out=[];
  for(const r of rows||[]){
    const rMat=refMatClass(`${r.material||''} ${r.notes||''}`)||refMatClass(r.desc);
    if(lMat&&rMat&&rMat!==lMat)continue;
    const rW=caseMm(r.dims)?caseMm(r.dims)/10:(vestiaireWidthCm(r.dims)||listingWidthCm(`${r.size||''} ${r.notes||''}`)||listingWidthCm(r.desc));
    const rS=listingSizeLabel(`${r.size||''} ${r.model||''} ${r.notes||''}`)||listingSizeLabel(r.desc);
    if(hardW&&rW&&Math.abs(rW-hardW)/hardW>0.15)continue;
    if(!(hardW&&rW)&&hardS&&rS&&rS!==hardS)continue;
    let s=0;
    if(guessW&&rW){const d=Math.abs(rW-guessW)/guessW;s+=d<=0.07?6:d<=0.15?3:-3;}
    else if(guessS&&rS)s+=rS===guessS?4:-3;
    if(lCol&&refColour(r.color)===lCol)s+=3;
    if(lMat&&rMat===lMat)s+=1;
    const rr=flat(r.size);
    // Relojes: la misma referencia pesa más que nada; después, la misma familia.
    if(idRefs.length&&rr.length>=5)s+=idRefs.some(x=>x.includes(rr)||rr.includes(x))?10:idRefs.some(x=>x.slice(0,5)===rr.slice(0,5))?5:idRefs.some(x=>x.slice(0,4)===rr.slice(0,4))?2:0;
    s+=boost[r._code]||0;
    if(!(/^https:\/\//.test(String(r.photo||''))||String(r._code||'').startsWith('V')))s-=4;
    if(r.sold)s+=0.5;
    out.push({r,s,size:rS||(rW?`${Math.round(rW)}cm`:'?')});
  }
  out.sort((a,b)=>b.s-a.s||compWeight(b.r)-compWeight(a.r));
  // Sin ninguna pista de talla: unas pocas de cada talla, para que la foto decida.
  if(!guessW&&!guessS){
    const by=new Map();for(const x of out){if(!by.has(x.size))by.set(x.size,[]);by.get(x.size).push(x);}
    const lists=[...by.values()];const pick=[];
    for(let i=0;pick.length<max&&lists.some(l=>l[i]);i++)for(const l of lists){if(l[i]&&pick.length<max)pick.push(l[i]);}
    return pick.map(x=>x.r);
  }
  return out.slice(0,max).map(x=>x.r);
}
const refPhotoCache=new Map();
async function refPhotoPart(r){
  const thumb=()=>{
    const t=db.prepare('SELECT jpeg FROM ref_thumbs WHERE id=?').get(String(r?.id||''));
    return t?{inline_data:{mime_type:'image/jpeg',data:Buffer.from(t.jpeg).toString('base64')}}:null;
  };
  if(String(r?._code||'').startsWith('V'))return thumb();
  const url=String(r?.photo||'');
  // Fila de la hoja sin foto: la miniatura de Vestiaire del mismo anuncio, si la trajo el Mac.
  if(!/^https:\/\//.test(url))return thumb();
  if(refPhotoCache.has(url))return refPhotoCache.get(url);
  let part=null;
  try{
    const res=await fetch(url,{signal:AbortSignal.timeout(10000),redirect:'follow'});
    const type=(res.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
    if(res.ok&&/^image\/(jpeg|jpg|png|webp)$/.test(type)){
      const buf=Buffer.from(await res.arrayBuffer());
      if(buf.length&&buf.length<1.5e6)part={inline_data:{mime_type:type==='image/jpg'?'image/jpeg':type,data:buf.toString('base64')}};
    }
  }catch{}
  if(refPhotoCache.size>3000)refPhotoCache.clear();
  refPhotoCache.set(url,part);
  return part||thumb();
}
const REF_PHOTO_INSTRUCTION=`You are the reference checker of Luxury Hunter. Luxury Hunter computes the resale price ONLY from the references you confirm here: one wrong reference means a wrong price. Be strict.
The first images are the LISTING. After them come the REFERENCE photos, each one preceded by its code and its text.
For EACH reference decide if it is the SAME PRODUCT as the listing:
- same brand and model, and the same version/size/format: same silhouette and proportions, same closure, handle/strap type and hardware style; measurements within about 15 % when both are known. Mini, Small, regular and Large are different products.
- ONLY the same model line: never confirm another line of the brand even if it looks alike (Lady Dior ≠ Lady D-Lite/D-Joy, Classic Flap ≠ Boy/19/Coco Handle/WOC, Saddle ≠ Bobby, City ≠ First/Work/Neo Classic, Santos ≠ Santos Galbée/Demoiselle/Octagon).
- same material family (smooth or grained leather, canvas, nylon, suede, exotic...). Colour may differ, but list in "same_colour" the confirmed codes that also have the same colour.
- WATCHES: same reference family (2541.80 ≠ 2531.80), same movement (quartz ≠ automatic), same case size and material; dial colour must match.
- condition at most one grade apart.
SIZE WHEN THE LISTING GIVES NO MEASUREMENTS: do NOT reject a reference only because the listing text has no size. Judge the size from the photos as an expert would: proportions (width/height), number of quilting diamonds or stitched rows across the flap and the front, size of the turn-lock/logo and of the chain relative to the bag, strap length, hand or body for scale. Compare that with the reference photo and its measurements, and confirm it when they agree. Reject for size only when the photos point to a different size/version or are genuinely inconclusive between two sizes that look alike (for example mini vs regular with nothing to tell them apart).
If the reference photo shows another bag or another product, it is NOT the same. A reference without photo can only be confirmed if its text gives the same size or measurements and version.
Missing a reference that IS the same product is also an error: Nil checks your answers and an equal reference left out is as bad as a wrong one.
Also re-judge the LISTING with all its photos: condition, completeness, quality and authenticity risk, as before.
PRICE (orientative): using ONLY the references you put in "same" and their prices (SOLD prices are real sales and weigh more than asking prices; same measurements and same colour weigh more), give price_eur = the realistic price at which THIS listing would sell second-hand in Europe in its condition and completeness. Go down for worse condition, wear, missing box/card/strap/papers; go up only if it is clearly better than those references. Never go above the highest or far below the lowest of the confirmed references. If "same" is empty, price_eur is null.
Return ONLY JSON:
{"same":["B3","V2"],"same_colour":["B3"],"price_eur":0,"price_reason_es":"una frase: con qué referencias y por qué ese precio","not_same":{"B4":"motivo breve en español"},"flaws_zh":"desgaste visible del ANUNCIO en chino, máx. 15 caracteres (p. ej. 四角轻微磨损); vacío si no se ve ninguno","target_match":true,"condition_grade":"Nuevo|Como nuevo|Muy buen estado|Buen estado|Correcto|Malo","completeness_es":"","quality_score":0,"authenticity_risk":"LOW|MEDIUM|HIGH","exotic_skin":false,"decision_reasons_es":["1 a 4 motivos breves en español; nada de precios"]}`;
async function checkReferencePhotos({key,item,task,refs,purpose,analyzeImages,first}){
  const listing=analyzeImages?await fetchGeminiImageParts(item,Number(process.env.REF_LISTING_PHOTOS||6)):[];
  const photos=await Promise.all(refs.map(r=>refPhotoPart(r)));
  const head=`${REF_PHOTO_INSTRUCTION}\n\nTASK: ${task.task_name}\nTARGET PRODUCT: ${task.product_query}\n\nLISTING\nSOURCE: ${item.source}\nTITLE: ${item.title}\nDESCRIPTION: ${String(item.description||'').slice(0,2500)}\nFIRST IDENTIFICATION (text): ${JSON.stringify({brand:first.brand,model:first.model,variant:first.variant,size:first.size,material:first.material,colour:first.colour})}\n\nLISTING PHOTOS:`;
  const parts=[{text:head},...listing,{text:'REFERENCES (code | model | size | measurements | material | colour | condition | sold? | published | notes):'}];
  refs.forEach((r,i)=>{
    const v=refValue(r,1);
    parts.push({text:`${refTable([r])} | ${v?`${Math.round(v)} € ${r.sold?'(SOLD price)':'(asking price)'}`:'no price'}${photos[i]?'':'\n(NO PHOTO)'}`});
    if(photos[i])parts.push(photos[i]);
  });
  const r=await geminiJsonRequest({key,model:aiModel(),parts,googleSearch:false,purpose});
  const d=r.data||{};
  const allowed=new Set(refs.map(x=>x._code));
  const same=(Array.isArray(d.same)?d.same:[]).map(c=>String(c).trim().toUpperCase()).filter(c=>allowed.has(c));
  return {data:d,same,photos:photos.filter(Boolean).length,listingImages:listing.length};
}
async function analyzeByReferences({key,item,task,taskId,analyzeImages,reportProgress,negotiated}){
  const economics=importEconomics(item);
  const landed=Number(economics.importedTotalEur)||0;
  const marketplaceVerification=detectMarketplaceVerification(item);
  const platform=resalePlatform(task.task_name);
  const realization=VESTIAIRE_DEFAULT_REALIZATION;
  reportProgress(8,'Buscando referencias','Tu base y Vestiaire en directo');
  const baseInfo=baseReferenceRows(task,item);
  const liveInfo=await liveReferenceRows(task,item,baseInfo.model,baseInfo.rows?.[0]?.brand||'');
  const excludeId=String(item.source)==='vestiaire'?item.source_id:null;
  // Todas las fichas del modelo con su código (B1… por peso); la primera
  // pasada ve las 80 primeras y el resto se revisa después por parecido.
  const base=refCandidates(baseInfo.rows,{prefix:'B',limit:REF_MAX_BASE+REF_EXTRA_BASE,excludeId});
  // La primera lectura ve solo las 40 más parecidas por el título (misma talla
  // y color primero), no las 80 que más pesan.
  const base0=pickPhotoRefs(base,{item,max:Number(process.env.REF_SCREEN_MAX||40)});
  const live=refCandidates(liveInfo.rows,{prefix:'V',limit:REF_MAX_LIVE,excludeId});
  const prompt=referencePrompt(task,item,base0,pickPhotoRefs(live,{item,max:24}),economics);
  const inspect=async(purpose,images)=>{
    const parts=analyzeImages?await fetchGeminiImageParts(item,images):[];
    const r=await geminiJsonRequest({key,model:aiModel(),parts:[{text:prompt},...parts],googleSearch:false,purpose});
    return {data:r.data||{},images:parts.length};
  };
  // Tandas extra de la base, solo texto, con lo que ya se ha identificado.
  const inspectMoreBase=async(first)=>{
    const rest=rankByIdentity(base.slice(REF_MAX_BASE),first);
    const chunks=[];for(let i=0;i<rest.length;i+=REF_MAX_BASE)chunks.push(rest.slice(i,i+REF_MAX_BASE));
    const ident=`LISTING ALREADY IDENTIFIED AS: ${JSON.stringify({brand:first.brand,model:first.model,variant:first.variant,size:first.size,material:first.material,colour:first.colour,condition_grade:first.condition_grade})}\nOnly fill base_same and base_similar for the references below (the rest of the JSON can repeat the identification).`;
    const out=await Promise.all(chunks.map(async ch=>{
      try{
        const r=await geminiJsonRequest({key,model:aiModel(),parts:[{text:`${referencePrompt(task,item,ch,[],economics)}\n\n${ident}`}],googleSearch:false,purpose:'screen'});
        return r.data||{};
      }catch(e){if(isAiPolicyFlag(e)||e?.aiBudget||e?.geminiCapacity)throw e;console.warn('Tanda extra de referencias:',e.message);return {};}
    }));
    return {same:out.flatMap(d=>Array.isArray(d.base_same)?d.base_same:[]),similar:out.flatMap(d=>Array.isArray(d.base_similar)?d.base_similar:[]),chunks:chunks.length,rows:rest.length};
  };
  const evaluate=data=>{
    const basePrice=priceFromRefs(base,data.base_same,{ratio:realization,prefer:data.same_colour});
    const livePrice=priceFromRefs(live,data.vestiaire_same,{ratio:VESTIAIRE_LIVE_REALIZATION,prefer:data.same_colour});
    let combined=combinePrices(basePrice,livePrice);
    // Precio orientativo de la IA (calidad del anuncio frente a las iguales),
    // dentro de lo que dicen esas referencias.
    const ai=Number(data.ai_price_eur);
    if(combined&&ai>0){
      const vals=[...(basePrice?.weighted||[]),...(livePrice?.weighted||[])].map(x=>Number(x.v)).filter(v=>v>0);
      if(vals.length){
        const clamped=Math.round(Math.max(Math.min(...vals)*0.9,Math.min(Math.max(...vals),ai)));
        combined={...combined,formula:combined.realistic,ai_price:Math.round(ai),realistic:clamped};
      }
    }
    const orientative=false;
    const failed=String(marketplaceVerification.status||'').toUpperCase()==='FAILED';
    const dec=decideFromNumbers({price:combined,landed,feePct:platform.fee,minProfit:Number(task.notify_min_profit_eur)||200,
      minMarginPct:Number(process.env.MIN_CLEAN_MARGIN_PCT||20),quality:data.quality_score,
      risk:failed||data.exotic_skin===true?'HIGH':data.authenticity_risk,targetMatch:data.target_match!==false,orientative});
    return {basePrice,livePrice,combined,orientative,dec,failed};
  };
  reportProgress(25,'Revisando el anuncio','La IA identifica el producto, su estado y las referencias posibles');
  const shot=await inspect('screen',2);
  const codes=(list,cands)=>{const ok=new Set(cands.map(r=>r._code));return [...new Set((Array.isArray(list)?list:[]).map(c=>String(c).trim().toUpperCase()))].filter(c=>ok.has(c));};
  const s1={...shot.data};
  // Ya no se repasan 400 fichas en tandas de texto: el bot elige las
  // referencias (mismo modelo y material, misma talla, mismas medidas y color
  // delante) y la primera lectura solo les da un empujón.
  const extra={chunks:0,rows:0};
  const sameB=codes(s1.base_same,base), simB=codes(s1.base_similar,base).filter(c=>!sameB.includes(c));
  const sameV=codes(s1.vestiaire_same,live), simV=codes(s1.vestiaire_similar,live).filter(c=>!sameV.includes(c));
  // Ninguna referencia cuenta sin pasar por las fotos. Solo se comprueban si,
  // contando todas las elegidas, podría salir rentable.
  const promising=d=>['STRONG BUY','BUY','WATCH'].includes(evaluate(d).dec.decision);
  const boost={};for(const c of [...sameB,...sameV])boost[c]=3;for(const c of [...simB,...simV])boost[c]=boost[c]||1;
  const poolAll=s1.target_match===false?[]:pickPhotoRefs([...base,...live],{ident:s1,item,boost,max:REF_PHOTO_MAX});
  let d={...s1,base_same:[],vestiaire_same:[]};
  let confirmed=false, photoCheck=null, unprofitableAnyway=null;
  const optimistic={...s1,base_same:poolAll.filter(r=>r._code.startsWith('B')).map(r=>r._code),vestiaire_same:poolAll.filter(r=>r._code.startsWith('V')).map(r=>r._code)};
  if(poolAll.length&&(promising(optimistic)||promising({...s1,base_same:sameB,vestiaire_same:sameV}))){
    // Siempre con el modelo bueno: la precisión del precio depende de esto.
    const strong=true;
    verifyTierStore.enterWith('full');
    // Hasta dos rondas de fotos: si en la primera no sale ninguna igual y
    // quedan candidatas, se miran las siguientes.
    const checked=[],same=[],notSame={};let photos=0,pd={};
    try{
      for(let round=0;round<2&&checked.length<poolAll.length;round++){
        const refs=poolAll.slice(checked.length,checked.length+REF_PHOTO_MAX);
        reportProgress(55+round*10,'Comprobando referencias con fotos',`${refs.length} referencias, una a una`);
        const pc=await checkReferencePhotos({key,item,task,refs,purpose:strong?'verify':'screen',analyzeImages,first:s1});
        checked.push(...refs.map(r=>r._code));same.push(...pc.same);photos+=pc.photos;
        if(pc.data?.not_same&&typeof pc.data.not_same==='object')Object.assign(notSame,pc.data.not_same);
        if(round===0)pd=pc.data||{};
        if(same.length)break;
      }
      d={...s1,...Object.fromEntries(['target_match','condition_grade','completeness_es','quality_score','authenticity_risk','exotic_skin','decision_reasons_es','flaws_zh'].filter(k=>pd[k]!=null&&pd[k]!=='').map(k=>[k,pd[k]])),
        base_same:same.filter(c=>c.startsWith('B')),vestiaire_same:same.filter(c=>c.startsWith('V')),
        ai_price_eur:same.length&&Number(pd.price_eur)>0?Number(pd.price_eur):null,price_reason_es:String(pd.price_reason_es||'').slice(0,240),
        same_colour:(Array.isArray(pd.same_colour)?pd.same_colour:[]).map(c=>String(c).trim().toUpperCase()).filter(c=>same.includes(c))};
      confirmed=strong;
      photoCheck={checked,same,not_same:notSame,photos,model:strong?'verify':'screen'};
    }catch(e){
      // Sin presupuesto de IA a esta hora: el anuncio se deja para más tarde
      // (no se guarda como "sin precio").
      if(isAiPolicyFlag(e)||e?.aiBudget||e?.geminiCapacity)throw e;
      console.warn('Comprobación de referencias con fotos:',e.message);
      photoCheck={error:String(e.message||e).slice(0,160)};
    }
  }else if(poolAll.length){
    // Hay referencias posibles, pero ni contándolas todas sale rentable: es
    // un descarte por precio, no un "sin referencias".
    unprofitableAnyway=evaluate(optimistic);
  }
  const ev=unprofitableAnyway||evaluate(d);
  const {basePrice,livePrice,combined,orientative,dec,failed}=ev;
  const fee=platform.fee/100;
  const a={
    brand:d.brand||'',model:[d.model,d.variant].filter(Boolean).join(' ')||task.task_name,
    authenticity_risk:failed?'HIGH':String(d.authenticity_risk||'MEDIUM').toUpperCase(),liquidity:'',
    decision:dec.decision,opportunity_score:dec.score,
    resale_low_eur:combined?.low??null,resale_high_eur:combined?.high??null,resale_mean_eur:combined?.realistic??combined?.mean??null,
    landed_cost_eur:landed||null,import_costs:economics,marketplace_verification:marketplaceVerification,
    net_profit_low_eur:combined&&landed?roundMoney(combined.low-landed):null,
    net_profit_high_eur:combined&&landed?roundMoney(combined.high-landed):null,
    net_profit_clean_eur:dec.clean,clean_margin_pct:dec.margin,quality_score:Number(d.quality_score)||null,
    flaws_zh:String(d.flaws_zh||'').replace(/[<>]/g,'').slice(0,20),
    resale_estimate_source:combined?(orientative?'REFERENCIAS_PARECIDAS':combined.source==='base'?'VESTIAIRE_DB':combined.source==='vestiaire'?'VESTIAIRE_LIVE':'VESTIAIRE_DB+LIVE'):'UNAVAILABLE',
    resale_estimate_market_verified:!!combined&&!orientative&&!unprofitableAnyway,
    notes:[d.completeness_es,d.condition_grade].filter(Boolean).join(' · ')
  };
  const priceNote=unprofitableAnyway
    ?`Ni contando como iguales todas las referencias posibles sale rentable: precio de venta realista ${combined?.realistic??combined?.mean} €, beneficio limpio en ${platform.name} ${dec.clean} € (margen ${dec.margin} %).`
    :combined
    ?`Precio orientativo ${combined.realistic??combined.mean} € con ${combined.n} referencias iguales comprobadas con foto${d.same_colour?.length?` (${d.same_colour.length} del mismo color)`:''} (media ${combined.mean} €, franja ${combined.low}-${combined.high})${d.price_reason_es?`: ${d.price_reason_es}`:''}; beneficio limpio en ${platform.name} ${dec.clean} € · margen ${dec.margin} %.`
    :photoCheck?.error?'No se pudieron comprobar las referencias con fotos: sin precio.'
    :`Sin referencias iguales en tu base (${base.length} fichas del modelo revisadas) ni en Vestiaire (${live.length}${liveInfo.status!=='ok'&&liveInfo.status!=='watch'?`; Vestiaire no respondió: ${liveInfo.status}`:''}): sin pronóstico de precio.`;
  a.decision_reasons_es=[priceNote,...(Array.isArray(d.decision_reasons_es)?d.decision_reasons_es:[]).map(String)].slice(0,5);
  // SIN REFERENCIAS PERO INTERESANTE (regla de Nil, 07-11-2026): revisada la
  // base entera y Vestiaire, si no hay ninguna igual se avisa igualmente,
  // sin pronóstico, cuando el anuncio es el producto buscado, sin riesgo alto
  // y en buen estado.
  a.no_refs_interesting=!combined&&!unprofitableAnyway&&!photoCheck?.error&&!failed&&d.target_match!==false&&d.exotic_skin!==true
    &&String(d.authenticity_risk||'MEDIUM').toUpperCase()!=='HIGH'&&(Number(d.quality_score)||0)>=Number(process.env.NO_REF_MIN_QUALITY||55);
  if(failed)a.decision_reasons_es.unshift(`La verificación de ${marketplaceVerification.service||'la plataforma'} figura como no superada.`);
  if(d.exotic_skin===true)a.decision_reasons_es.unshift('Piel exótica (CITES): descartado por política.');
  const exact={brand:d.brand,family:d.model,exact_variant_label:d.variant,size:d.size,material:d.material,main_color:d.colour,hardware:d.hardware,
    condition:{grade:d.condition_grade||null},target_match:d.target_match!==false,confidence:Number(d.confidence)||null};
  let verification={status:confirmed?'verified':'screen_only',match_version:MATCH_VERSION,preliminary_decision:dec.decision,exact,
    marketplace_verification:marketplaceVerification,
    market:{match_version:MATCH_VERSION,
      sheet_comps:unprofitableAnyway?null:referenceCompsForAlert(basePrice,{tab:baseInfo.tab,model:baseInfo.model,source:'base'}),
      vestiaire_live:livePrice&&!unprofitableAnyway?{status:'ok',tier:'misma_talla',...referenceCompsForAlert(livePrice,{model:liveInfo.model,source:'vestiaire'}),
        active_n:livePrice.n-livePrice.sold_n,material:'',basis:'iguales, comprobados con foto'}:(liveInfo.status==='ok'?{status:'no_match',query:liveInfo.query}:{status:liveInfo.status,query:liveInfo.query,error:liveInfo.error||null}),
      vestiaire_blend:basePrice&&livePrice?combined:null,orientative,
      candidates:{base:base.length,vestiaire:live.length,extra_chunks:extra.chunks},photo_check:photoCheck,no_refs_interesting:a.no_refs_interesting,
      vestiaire_live_error:liveInfo.error||null,sheet_fresh:vestiaireSheetFresh()}};
  // Subastas: puja máxima con la parte baja de las referencias iguales.
  const auc=listingAuction(item);
  if(auc){
    const resale=combined&&!orientative?Number(combined.low):null;
    const rawMax=auc.live&&resale>0?auctionMaxBidEur(item,resale,task.task_name):null;
    const maxLocal=rawMax!=null?auctionLocalBid(rawMax,auc.currency):null;
    const maxEur=maxLocal!=null?toEur(maxLocal,auc.currency):null;
    verification.auction={ends_at:auc.endsAt,bids:auc.bids,currency:auc.currency,current_bid:auc.currentBid,current_bid_eur:roundMoney(Number(item.price_eur)),
      resale_eur:resale>0?roundMoney(resale):null,resale_from_db:resale>0,db_comparables:combined?.n||null,db_basis:'referencias iguales elegidas por la IA',
      min_profit_eur:AUCTION_MIN_PROFIT_EUR,max_bid_eur:maxEur!=null?roundMoney(maxEur):null,max_bid_local:maxLocal};
    if(a.decision!=='REJECT'){
      if(!auc.live){a.decision='REVIEW';a.opportunity_score=null;a.decision_reasons_es.unshift('Subasta finalizada; la puja ya no está disponible.');}
      else if(!(resale>0)){a.decision='REVIEW';a.opportunity_score=null;a.decision_reasons_es.unshift('Subasta: sin referencias iguales para calcular la puja máxima.');}
      else if(maxEur==null||Number(item.price_eur)>=maxEur){a.decision='REJECT';a.decision_reasons_es.unshift(`Subasta: la puja actual ya supera la puja máxima rentable${maxEur!=null?` (${Math.round(maxEur)} €)`:''}.`);}
      else{
        const atMax=auctionNetProfit(item,maxEur,resale,task.task_name);
        a.landed_cost_eur=roundMoney(atMax.landed);a.net_profit_low_eur=roundMoney(atMax.net);
        a.decision_reasons_es.unshift(`Subasta: puja como máximo ${maxLocal} ${auc.currency} (≈ ${Math.round(maxEur)} €) para ganar al menos ${AUCTION_MIN_PROFIT_EUR} € limpios vendiendo a ${Math.round(resale)} €.`);
      }
    }
  }
  a.decision_reasons_es=a.decision_reasons_es.slice(0,5);
  verification.final={...a};
  a.market_verification=verification;
  reportProgress(97,'Guardando resultado','Actualizando Luxury Hunter');
  storeTaskAnalysis(taskId,item,a,dec.decision,verification,new Date().toISOString());
  return a;
}

const BOT_CHECK_TEXT=/confirm(e|a)? que es humano|confirm you are (a )?human|verify you are (a )?human|just a moment|人間であることを確認|are you a robot/i;
async function oneMapEnsureDetail(item){
  let raw={};try{raw=JSON.parse(item.raw_json||'{}');}catch{}
  if(item.source!=='yahoo-auctions-jp'||(raw.searchMode!=='list'&&!BOT_CHECK_TEXT.test(String(item.title||''))))return item;
  const token=String(process.env.ONEMAP_MAC_BRIDGE_TOKEN||'').trim();
  if(!token||!await macOneMapReady(token).catch(()=>false))return item;
  const spec={id:'yahoo-auctions-jp',label:'Yahoo! Auctions Japan',purchaseVia:'One Map / FROM JAPAN',mode:'browser',detailWaitMs:1000};
  try{
    const d=await japanEnrichCandidate(spec,{href:item.url,title:item.title,blob:item.title,price:item.original_price,img:item.image_url||''},
      {query:raw.query,searchUrl:raw.searchUrl},{macBridgeToken:token});
    if(d.status==='sold'||!String(d.description||'').trim())return item;
    const bid=Math.max(Number(d.original_price)||0,Number(item.original_price)||0);
    d.source_id=item.source_id;d.original_price=bid;d.price_eur=toEur(bid,'JPY');d.purchase_via='One Map / FROM JAPAN';
    if(!d.title)d.title=item.title;
    d.raw={...raw,...d.raw,auction:raw.auction,searchMode:'browser',detailAt:new Date().toISOString()};
    upsertListing(d);
    return db.prepare('SELECT * FROM listings WHERE id=?').get(item.id)||item;
  }catch(e){console.warn(`One Map ficha ${item.source_id}: ${e.message}`);return item;}
}

async function analyzeWithGemini(listingId,taskId=null,analyzeImages=true,onProgress=null,opts={}){
  const reportProgress=(pct,stage,detail='')=>{
    try{
      if(typeof onProgress==='function'){
        onProgress(pct,stage,detail);
      }
    }catch{}
  };

  reportProgress(
    3,
    'Preparando análisis',
    'Cargando datos del anuncio'
  );

  const key=aiApiKey();
  if(!key)throw new Error(`${aiProvider()==='openai'?'OPENAI_API_KEY':'GEMINI_API_KEY'} is empty in .env`);
  const model=aiModel();
  let row=db.prepare('SELECT * FROM listings WHERE id=?').get(Number(listingId));
  if(!row)throw new Error('Listing not found');
  // Subasta de One Map guardada solo con la lista (título y 1 foto): antes
  // de analizarla se abre su ficha (descripción con medidas y galería).
  row=await oneMapEnsureDetail(row);
  {
    const veto=row.source==='yahoo-auctions-jp'?fewSellerReviewsVeto('Yahoo! Auctions',row.seller_reviews):null;
    if(veto&&taskId){storePrescreenReject(Number(taskId),row,veto);return {decision:'REJECT',decision_reasons_es:veto.reasons};}
  }
  // Análisis manual por Telegram: todo se calcula con el precio de compra
  // que Nil ha negociado con el vendedor, no con el anunciado.
  const negotiatedEur=Number(opts?.priceEur);
  const negotiated=opts?.priceEur!=null&&Number.isFinite(negotiatedEur)&&negotiatedEur>0;
  const item=negotiated
    ?{...row,price_eur:negotiatedEur,original_price:eurTo(negotiatedEur,row.currency||'EUR')??row.original_price}
    :row;
  const task=taskId?taskPublic(db.prepare('SELECT * FROM tasks WHERE id=?').get(Number(taskId))):null;
  await refreshVestiaireSheet();
  // Análisis de tarea: la IA valora el anuncio y elige las referencias; el
  // precio y la decisión los pone el bot (REF_ANALYSIS=0 vuelve al antiguo).
  if(task&&!['0','off','false','no'].includes(String(process.env.REF_ANALYSIS||'').toLowerCase()))
    return analyzeByReferences({key,item,task,taskId,analyzeImages,reportProgress,negotiated});
  const taskContext=task?`\nTASK NAME: ${task.task_name}\nTARGET PRODUCT: ${task.product_query}\nUSER REQUIREMENTS / AI CRITERIA:\n${task.description||''}\nDECISION MODE: ${task.decision_mode}\nKEYWORD RULES: ${(task.keyword_rules||[]).join(', ')}${vestiaireSnapshotBlock(task,item)}`:'';
  const economics=importEconomics(item);
  const marketplaceVerification=detectMarketplaceVerification(item);
  const prompt=`${CENTRAL_AI_INSTRUCTION}${taskContext}\n\nSOURCE: ${item.source}\nPURCHASE VIA: ${item.purchase_via||''}\nTITLE: ${item.title}\nDESCRIPTION: ${item.description}\nITEM PRICE EUR: ${item.price_eur}${negotiated?`\nPRICE NOTE: ITEM PRICE EUR is the purchase price the reseller has already negotiated with the seller (the listing shows ${row.price_eur} EUR). Use the negotiated price as the purchase price.`:''}${listingAuction(item)?.live?`\nAUCTION NOTE: this is an AUCTION. ITEM PRICE EUR is only the current bid (${listingAuction(item).bids} bids, ends ${listingAuction(item).endsAt}); the final price will be higher. Focus on exact model, authenticity, condition and a realistic European resale; Luxury Hunter computes the maximum profitable bid from your resale estimate.`:''}\nIMPORT COST BREAKDOWN EUR: ${JSON.stringify(economics)}\nIMPORTED TOTAL / LANDED COST EUR: ${economics.importedTotalEur}\nMARKETPLACE VERIFICATION SIGNAL: ${JSON.stringify(marketplaceVerification)}\nMARKETPLACE VERIFICATION RULE: AVAILABLE or PASSED is a positive risk-reduction signal only. It is never proof of authenticity and must never override HIGH authenticity risk, an exact-model mismatch, severe condition issues or weak live-market evidence. UNKNOWN and UNAVAILABLE are neutral. FAILED is disqualifying and must be REJECT. A seller claim such as 正品 or 정품 alone is NOT a passed verification.\nSELLER: ${item.seller_name}\nSELLER SALES: ${item.seller_sales}\nSELLER REVIEWS: ${item.seller_reviews}${(()=>{try{const si=JSON.parse(item.raw_json||'{}')?.['卖家信息'];return si?`\nSELLER PROFILE (Xianyu): ${JSON.stringify(si)}`:'';}catch{return '';}})()}\nURL: ${item.url}`;
  reportProgress(
    8,
    'Cargando imágenes',
    'Preparando primera evaluación visual'
  );

  const initialImageParts=analyzeImages?await fetchGeminiImageParts(item,1):[];
  reportProgress(
    18,
    'Screening inicial',
    'Gemini está evaluando modelo, riesgo y oportunidad'
  );

  const first=await geminiJsonRequest({key,model,parts:[{text:prompt},...initialImageParts],googleSearch:false,purpose:'screen'});
  const a=first.data||{};

  reportProgress(
    30,
    'Screening completado',
    `Decisión preliminar: ${String(a.decision||'pendiente')}`
  );
  a.landed_cost_eur=economics.importedTotalEur;
  a.import_costs=economics;
  a.marketplace_verification=marketplaceVerification;
  a.decision_reasons_es=reasonsForStorage(a);
  const aiPreliminaryDecision=String(a.decision||'').toUpperCase();

  if(String(marketplaceVerification.status||'').toUpperCase()==='FAILED'){
    a.decision='REJECT';
    a.opportunity_score=0;
    a.decision_reasons_es=[
      `La verificacion de ${marketplaceVerification.service||'marketplace'} figura como no superada.`,
      ...a.decision_reasons_es
    ].slice(0,4);
  }

  const preliminaryDecision=String(a.decision||'').toUpperCase();
  let verification={
    status:'not_required',
    preliminary_decision:preliminaryDecision,
    ai_preliminary_decision:aiPreliminaryDecision,
    marketplace_verification:marketplaceVerification
  };
  // Ahorro: la verificación cara (fotos + búsqueda web) solo para candidatos
  // serios. Un WATCH flojo se guarda sin verificar y no se vuelve a pagar.
  const verifyWatchMin=Number(process.env.VERIFY_WATCH_MIN_SCORE||60);
  // Un WATCH con mucho margen también se verifica aunque puntúe poco
  // (caso típico: buen precio pero fotos insuficientes).
  const verifyWatchProfit=Number(process.env.VERIFY_WATCH_MIN_PROFIT_EUR||300);
  const bigMarginWatch=preliminaryDecision==='WATCH'&&
    Number(a.opportunity_score)>=50&&
    Number(a.net_profit_low_eur)>=verifyWatchProfit;
  const worthVerifying=['BUY','STRONG BUY'].includes(preliminaryDecision)||
    (preliminaryDecision==='WATCH'&&Number(a.opportunity_score)>=verifyWatchMin)||
    bigMarginWatch;
  if(taskId&&POSITIVE_DECISIONS.has(preliminaryDecision)&&worthVerifying&&verifyBudgetLeftUsd()<=0){
    // Candidato serio pero sin presupuesto de verificación hoy: se verifica
    // en cuanto haya presupuesto (mañana), en vez de perderlo.
    verification={
      status:'pending_budget',
      preliminary_decision:preliminaryDecision,
      ai_preliminary_decision:aiPreliminaryDecision,
      marketplace_verification:marketplaceVerification
    };
    a.decision_reasons_es=[
      ...reasonsForStorage(a),
      'Verificación de mercado pendiente: el presupuesto de verificación de hoy está agotado; se hará en cuanto se renueve.'
    ].slice(0,4);
  }else if(taskId&&POSITIVE_DECISIONS.has(preliminaryDecision)&&!worthVerifying){
    verification={
      status:'skipped_cost',
      preliminary_decision:preliminaryDecision,
      ai_preliminary_decision:aiPreliminaryDecision,
      marketplace_verification:marketplaceVerification
    };
    a.decision_reasons_es=[
      ...reasonsForStorage(a),
      `Sin verificación de mercado (puntuación ${a.opportunity_score??'—'} < ${verifyWatchMin}) para ahorrar coste.`
    ].slice(0,4);
  }else if(taskId&&POSITIVE_DECISIONS.has(preliminaryDecision)){
    // WATCH → modelo barato; BUY/STRONG BUY → modelo potente.
    verifyTierStore.enterWith(
      ['BUY','STRONG BUY'].includes(preliminaryDecision)||String(process.env.VERIFY_LITE_FOR_WATCH||'1')==='0'?'full':'lite'
    );
    try{
      reportProgress(
        38,
        'Preparando verificación visual',
        'Cargando imágenes adicionales'
      );

      const imageParts=analyzeImages?await fetchGeminiImageParts(item,4):[];
      if(!imageParts.length){
        verification={status:'error',preliminary_decision:preliminaryDecision,ai_preliminary_decision:aiPreliminaryDecision,marketplace_verification:marketplaceVerification,error:'No listing image could be loaded for exact variant verification.'};
        a.decision='REVIEW';
        a.opportunity_score=null;
        a.decision_reasons_es=[`La primera pasada detecto ${preliminaryDecision}, pero no se pudo completar el chequeo visual exacto.`,'No se publica como WATCH/BUY/STRONG BUY hasta completar la verificacion.'];
      }else{
        reportProgress(
          48,
          'Identificando modelo exacto',
          'Chequeando variante, tamaño, material y condición'
        );

        const exact=await exactModelVerification({
          key,model,item,task,imageParts,preliminary:a
        });

        reportProgress(
          62,
          'Modelo y condición identificados',
          `${exact.exact_variant_label||exact.family||'Modelo'} · condition ${exact?.condition?.grade||'UNKNOWN'}`
        );

        const market=await liveMarketResearch({
          key,
          model,
          item,
          task,
          exact,
          onProgress:reportProgress
        });

        const marketResaleAvailable=
          market?.conservative_resale_eur!==null &&
          market?.conservative_resale_eur!==undefined &&
          market?.conservative_resale_eur!=='' &&
          Number.isFinite(
            Number(
              market.conservative_resale_eur
            )
          );

        market.ai_resale_estimate=null;

        market.resale_estimate_source=
          marketResaleAvailable
            ? 'MARKET_ANALYSIS'
            : 'UNAVAILABLE';

        market.resale_estimate_confidence=
          marketResaleAvailable
            ? String(
                market?.market_confidence||'LOW'
              ).toUpperCase()
            : 'LOW';

        if(
          !marketResaleAvailable &&
          exact?.target_match
        ){
          reportProgress(
            91,
            'Estimando reventa con IA',
            'Sin evidencia de mercado suficiente · calculando aproximación occidental'
          );

          try{
            const aiEstimate=
              await aiWesternResaleEstimate({
                key,
                model,
                task,
                exact,
                market
              });

            market.ai_resale_estimate=
              aiEstimate;

            if(aiEstimate?.available===true){
              market.resale_estimate_source=
                'AI_ESTIMATE';

              market.resale_estimate_confidence=
                String(
                  aiEstimate?.confidence||
                  'LOW'
                ).toUpperCase();
            }

          }catch(aiEstimateError){
            if(aiEstimateError?.geminiCapacity===true){
              throw aiEstimateError;
            }

            console.error(
              `AI resale fallback failed for listing ${item.id}:`,
              aiEstimateError?.message||
              aiEstimateError
            );

            market.ai_resale_estimate={
              available:false,
              source:'AI_ESTIMATE',
              confidence:'LOW',
              low_eur:null,
              high_eur:null,
              midpoint_eur:null,
              rationale_es:
                aiEstimateError?.message||
                String(aiEstimateError),
              assumptions_es:[],
              generated_at:
                new Date().toISOString()
            };
          }
        }

        reportProgress(
          94,
          'Calculando oportunidad',
          'Aplicando mercado, condición, costes y beneficio'
        );

        try{market.sheet_anchor=vestiaireSheetAnchor(task,item,exact);}catch(e){market.sheet_anchor=null;}
        try{market.sheet_comps=vestiaireComparables(task,item,exact);}catch(e){market.sheet_comps=null;}
        market.bag_sheet_required=!isWatchTask(task?.task_name);
        market.sheet_fresh=vestiaireSheetFresh();
        const final=finalizeVerifiedOpportunity(
          a,
          exact,
          market,
          economics,
          marketplaceVerification
        );
        verification={status:'verified',verified_at:new Date().toISOString(),preliminary_decision:preliminaryDecision,ai_preliminary_decision:aiPreliminaryDecision,marketplace_verification:marketplaceVerification,exact,market,final};
        a.brand=exact.brand||a.brand;
        a.model=exact.exact_variant_label||exact.family||a.model;
        a.decision=final.decision;
        a.opportunity_score=final.opportunity_score;
        a.resale_low_eur=final.resale_low_eur;
        a.resale_high_eur=final.resale_high_eur;
        a.landed_cost_eur=final.landed_cost_eur;
        a.net_profit_low_eur=final.net_profit_low_eur;
        a.net_profit_high_eur=final.net_profit_high_eur;
        a.resale_estimate_source=final.resale_estimate_source;
        a.resale_estimate_confidence=final.resale_estimate_confidence;
        a.resale_estimate_market_verified=final.resale_estimate_market_verified;
        a.decision_reasons_es=final.decision_reasons_es;
        a.notes=[a.notes,`Exact-model + live-market verification completed. Market confidence: ${market.market_confidence}.`].filter(Boolean).join(' ');
      }
    }catch(e){
      if(e?.geminiCapacity===true){
        throw e;
      }

      verification={status:'error',preliminary_decision:preliminaryDecision,ai_preliminary_decision:aiPreliminaryDecision,marketplace_verification:marketplaceVerification,error:e?.message||String(e),failed_at:new Date().toISOString()};
      a.decision='REVIEW';
      a.opportunity_score=null;
      a.decision_reasons_es=[`La primera pasada detecto ${preliminaryDecision}, pero el chequeo exacto de modelo/mercado fallo.`,'No se publica como WATCH/BUY/STRONG BUY hasta que la verificacion se complete.'];
      a.notes=[a.notes,`Market verification error: ${e?.message||String(e)}`].filter(Boolean).join(' ');
    }
  }
  // Primera pasada sin verificación completa: mismo techo con la base de Vestiaire.
  if(task&&verification?.status!=='verified'&&Number.isFinite(Number(a.resale_low_eur))){
    try{
      const ident={brand:a.brand,family:a.model};
      const comps=vestiaireComparables(task,{...item,model:a.model},ident);
      const anchor=vestiaireSheetAnchor(task,item,ident);
      const landed=Number(a.landed_cost_eur)||Number(economics.importedTotalEur)||0;
      let c=null,note='';
      if(comps&&(comps.tier==='iguales'||comps.tier==='misma_talla')){
        c={low:comps.low,high:comps.high,changed:true};note=vestiaireComparablesNote(comps);
      }else if(anchor){
        c=clampResaleToAnchor(Number(a.resale_low_eur),Number(a.resale_high_eur),anchor);
        note=`Reventa ajustada con tu base de Vestiaire (${anchor.n} anuncios, ${anchor.basis}): venta realista ${anchor.low}-${anchor.high} EUR.`;
      }
      if(c?.changed){
        a.resale_low_eur=c.low;a.resale_high_eur=c.high;
        if(landed){a.net_profit_low_eur=roundMoney(c.low-landed);a.net_profit_high_eur=roundMoney(c.high-landed);}
        a.decision_reasons_es=[...(Array.isArray(a.decision_reasons_es)?a.decision_reasons_es:[]),note].slice(0,5);
      }
    }catch{}
  }
  // Subastas: el precio del anuncio es la puja actual, no lo que acabará
  // costando. Se calcula la puja máxima rentable y el beneficio a esa puja.
  const auc=task?listingAuction(item):null;
  if(auc){
    try{
      const ident=verification?.exact||{brand:a.brand,family:a.model};
      const comparableItem={...item,model:a.model};
      const comps=verification?.market?.sheet_comps??vestiaireComparables(task,comparableItem,ident);
      const anchor=verification?.market?.sheet_anchor??vestiaireSheetAnchor(task,comparableItem,ident);
      const sameSize=comps&&(comps.tier==='iguales'||comps.tier==='misma_talla');
      const dbLow=sameSize?Number(comps.low):anchor?Number(anchor.low):null;
      const fromDb=Number.isFinite(dbLow)&&dbLow>0&&(isWatchTask(task?.task_name)||(vestiaireSheetFresh()&&comps?.buy_eligible===true));
      const estimate=Number(a.resale_low_eur);
      const requiresDatabase=auc.requiresDatabase===true;
      const resale=requiresDatabase
        ? fromDb?(estimate>0?Math.min(dbLow,estimate):dbLow):null
        : sameSize?Number(comps.low):estimate;
      const current=Number(item.price_eur);
      const usable=auc.live&&resale>0&&(!requiresDatabase||fromDb);
      const rawMax=usable?auctionMaxBidEur(item,resale,task.task_name):null;
      const maxLocal=rawMax!=null?auctionLocalBid(rawMax,auc.currency):null;
      const maxEur=maxLocal!=null?toEur(maxLocal,auc.currency):null;
      const plan={ends_at:auc.endsAt,bids:auc.bids,currency:auc.currency,current_bid:auc.currentBid,current_bid_eur:roundMoney(current),
        resale_eur:resale>0?roundMoney(resale):null,resale_from_db:!!fromDb,db_comparables:fromDb?(sameSize?comps.n:anchor.n):null,
        db_basis:fromDb?(sameSize?comps.basis:anchor.basis):null,requires_database:requiresDatabase,
        min_profit_eur:AUCTION_MIN_PROFIT_EUR,max_bid_eur:maxEur!=null?roundMoney(maxEur):null,max_bid_local:maxLocal};
      verification={...(verification||{}),auction:plan};
      if(requiresDatabase&&!fromDb){
        if(String(a.decision||'').toUpperCase()!=='REJECT')a.decision='WATCH';
        a.opportunity_score=null;
        a.decision_reasons_es=['Subasta: no hay comparables suficientes del mismo modelo y talla en la base de Luxury Hunter; no se propone una puja máxima.',
          ...(Array.isArray(a.decision_reasons_es)?a.decision_reasons_es:[])].slice(0,5);
      }else if(!auc.live){
        if(String(a.decision||'').toUpperCase()!=='REJECT')a.decision='REVIEW';
        a.opportunity_score=null;
        a.decision_reasons_es=['Subasta finalizada; la puja ya no está disponible.',
          ...(Array.isArray(a.decision_reasons_es)?a.decision_reasons_es:[])].slice(0,5);
      }else if(!(resale>0)){
        if(String(a.decision||'').toUpperCase()!=='REJECT')a.decision='REVIEW';
        a.opportunity_score=null;
        a.decision_reasons_es=['Subasta: no hay un precio de reventa conservador para calcular una puja máxima.',
          ...(Array.isArray(a.decision_reasons_es)?a.decision_reasons_es:[])].slice(0,5);
      }else if(maxEur==null||maxLocal<=Number(auc.currentBid)||current>=maxEur){
        if(String(a.decision||'').toUpperCase()!=='REJECT')a.decision='REJECT';
        a.decision_reasons_es=[maxEur==null
          ? `Subasta: ni pujando muy bajo deja ${AUCTION_MIN_PROFIT_EUR} € limpios vendiendo a ${Math.round(resale)} €.`
          : `Subasta: la puja actual (${Math.round(current)} €) ya supera la puja máxima rentable (${Math.round(maxEur)} €).`,
          ...(Array.isArray(a.decision_reasons_es)?a.decision_reasons_es:[])].slice(0,5);
      }else{
        const atMax=auctionNetProfit(item,maxEur,resale,task.task_name);
        a.landed_cost_eur=roundMoney(atMax.landed);
        a.net_profit_low_eur=roundMoney(atMax.net);
        if(Number(a.resale_high_eur)>0)a.net_profit_high_eur=roundMoney(auctionNetProfit(item,maxEur,Number(a.resale_high_eur),task.task_name).net);
        a.decision_reasons_es=[`Subasta: puja como máximo ${plan.max_bid_local??Math.round(maxEur)} ${plan.max_bid_local!=null?auc.currency:'€'} (≈ ${Math.round(maxEur)} €) para ganar al menos ${AUCTION_MIN_PROFIT_EUR} € limpios vendiendo a ${Math.round(resale)} €${fromDb?' (anuncios parecidos de tu base)':' (pronóstico)'}.`,
          ...(Array.isArray(a.decision_reasons_es)?a.decision_reasons_es:[])].slice(0,5);
      }
    }catch(e){console.error('Subasta, puja máxima:',e.message);}
  }
  if(!isWatchTask(task?.task_name)){
    const ident=verification?.exact||{brand:a.brand,family:a.model};
    const comps=vestiaireComparables(task,{...item,model:a.model},ident);
    // Sin nada del modelo en la base de Nil: Vestiaire en directo.
    let live=null;
    if(String(a.decision||'').toUpperCase()!=='REJECT'&&!listingAuction(item)){
      try{live=await vestiaireLiveFor(task,{...item,model:a.model},ident);}
      catch(e){live={status:'error',error:String(e.message||e).slice(0,160)};console.warn('Vestiaire en directo:',e.message);}
      if(!comps&&live?.status==='ok'){
        const landed=Number(a.landed_cost_eur)||Number(economics?.importedTotalEur)||0;
        a.resale_low_eur=live.low;a.resale_high_eur=live.high;
        if(landed){a.net_profit_low_eur=roundMoney(live.low-landed);a.net_profit_high_eur=roundMoney(live.high-landed);}
      }
    }
    // Con referencias en la base: contraste con Vestiaire en directo. Precio
    // combinado (la base pesa el doble; vendidos, recientes y con más likes pesan más).
    // Si baja el beneficio, la decisión baja con él; nunca sube por esto.
    let blend=null;
    if(comps&&live?.status==='ok'){
      blend=blendComparables(comps,live);
      if(blend){
        const landed=Number(a.landed_cost_eur)||Number(economics?.importedTotalEur)||0;
        const before=Number(a.net_profit_low_eur);
        a.resale_low_eur=blend.low;a.resale_high_eur=blend.high;
        if(landed){
          a.net_profit_low_eur=roundMoney(blend.low-landed);a.net_profit_high_eur=roundMoney(blend.high-landed);
          const profit=a.net_profit_low_eur;
          const d=String(a.decision||'').toUpperCase();
          if(Number.isFinite(before)&&profit<before){
            if(profit<200&&d!=='REJECT'){a.decision='REJECT';a.opportunity_score=Math.min(Number(a.opportunity_score)||0,55);}
            else if(['BUY','STRONG BUY'].includes(d)&&profit<300){a.decision='WATCH';a.opportunity_score=Math.min(Number(a.opportunity_score)||0,79);}
            else if(d==='STRONG BUY'&&profit<=400)a.decision='BUY';
          }
        }
        a.decision_reasons_es=[`Precio combinado: ${blend.n_sheet} de tu base (pesan el doble) + ${blend.n_live} de Vestiaire en directo de la misma talla; ${blend.sold_n} vendidos; vendidos, recientes y con más likes pesan más → ${blend.low}-${blend.high} EUR.`,
          ...(a.decision_reasons_es||[])].slice(0,5);
      }
    }
    Object.assign(a,applyBagSheetPolicy(a,comps,{fresh:vestiaireSheetFresh()}));
    if(blend&&a.resale_estimate_source!=='UNVERIFIED_ESTIMATE')a.resale_estimate_source='VESTIAIRE_DB+LIVE';
    if(!comps&&live?.status==='ok'){
      a.resale_estimate_source='VESTIAIRE_LIVE';
      a.resale_estimate_confidence=live.tier==='misma_talla'?'MEDIUM':'LOW';
      const note=vestiaireLiveNote(live);
      a.decision_reasons_es=(a.decision_reasons_es||[]).map(r=>String(r).startsWith('CONSULTAR PRECIO:')?`CONSULTAR PRECIO: ${note} Posible oportunidad; la compra solo se recomienda con referencias de tu base.`:r);
      if(!a.decision_reasons_es.some(r=>String(r).includes('Vestiaire en directo')))a.decision_reasons_es=[note,...a.decision_reasons_es].slice(0,5);
    }
    verification={...(verification||{}),bag_sheet_rule_version:BAG_SHEET_RULE_VERSION,
      market:{...(verification?.market||{}),sheet_comps:comps,vestiaire_live:live,vestiaire_blend:blend,sheet_fresh:vestiaireSheetFresh(),bag_sheet_required:true}};
    if(verification.final)verification.final={...verification.final,...a};
  }
  a.market_verification=verification;
  const now=new Date().toISOString();
  reportProgress(
    97,
    'Guardando resultado',
    'Actualizando Luxury Hunter'
  );

  if(taskId)storeTaskAnalysis(taskId,item,a,preliminaryDecision,verification,now);
  else storeStandaloneAnalysis(item,a,now);

  reportProgress(
    100,
    'Análisis finalizado',
    'Resultado guardado'
  );

  return a;
}

function sessionListings(sessionId) {
  const session = db.prepare('SELECT task_id FROM search_sessions WHERE id=?').get(sessionId);
  if (session?.task_id) {
    return enrichCosts(db.prepare(`SELECT l.*, ssi.source_query, a.brand, a.model, a.authenticity_risk, a.liquidity, a.decision, a.opportunity_score,
      a.resale_low_eur,a.resale_high_eur,a.landed_cost_eur,a.net_profit_low_eur,a.net_profit_high_eur,a.notes,a.decision_reasons_es_json,a.preliminary_decision,a.verification_json
      FROM search_session_items ssi
      JOIN listings l ON l.id=ssi.listing_id
      LEFT JOIN task_analyses a ON a.listing_id=l.id AND a.task_id=?
      WHERE ssi.session_id=?
      ORDER BY CASE a.decision WHEN 'STRONG BUY' THEN 1 WHEN 'BUY' THEN 2 WHEN 'WATCH' THEN 3 WHEN 'REVIEW' THEN 4 WHEN 'REJECT' THEN 6 ELSE 5 END,
        COALESCE(a.opportunity_score,-1) DESC, l.price_eur ASC, l.last_seen DESC`).all(session.task_id,sessionId).filter(xianyuListingHasVerificationTag));
  }
  return enrichCosts(db.prepare(`SELECT l.*, ssi.source_query, a.brand, a.model, a.authenticity_risk, a.liquidity, a.decision, a.opportunity_score,
    a.resale_low_eur,a.resale_high_eur,a.landed_cost_eur,a.net_profit_low_eur,a.net_profit_high_eur,a.notes,a.decision_reasons_es_json,a.preliminary_decision,a.verification_json
    FROM search_session_items ssi
    JOIN listings l ON l.id=ssi.listing_id
    LEFT JOIN analyses a ON a.listing_id=l.id
    WHERE ssi.session_id=?
    ORDER BY CASE a.decision WHEN 'STRONG BUY' THEN 1 WHEN 'BUY' THEN 2 WHEN 'WATCH' THEN 3 WHEN 'REVIEW' THEN 4 WHEN 'REJECT' THEN 6 ELSE 5 END,
      COALESCE(a.opportunity_score,-1) DESC, l.price_eur ASC, l.last_seen DESC`).all(sessionId).filter(xianyuListingHasVerificationTag));
}

function safeTaskSnapshot(task) {
  if (!task) return null;
  const copy = JSON.parse(JSON.stringify(task));
  return copy;
}
function effectivePlan(basePlan, taskOrBody={}) {
  const plan={...basePlan};
  const x = taskOrBody.xianyu_queries ?? taskOrBody.xianyuQueries;
  const b = taskOrBody.bunjang_queries ?? taskOrBody.bunjangQueries;
  const j = taskOrBody.japan_queries ?? taskOrBody.japanQueries;
  if(Array.isArray(x)&&x.length) plan.xianyu=normalizeLines(x);
  if(Array.isArray(b)&&b.length) plan.bunjang=normalizeLines(b);
  if(Array.isArray(j)&&j.length) plan.japan=normalizeLines(j);
  return plan;
}
// Tareas "Radar ...": recorren por turnos una lista larga de modelos. Cada
// ejecución empieza la lista por los siguientes modelos de cada web, porque
// solo se usan las primeras búsquedas (1 en Xianyu, 2 en Japón, 2 en Corea).
const RADAR_STEP={xianyu:2,japan:2,bunjang:2};
function radarRotatePlan(plan,taskId){
  if(!taskId)return plan;
  const task=db.prepare('SELECT task_name FROM tasks WHERE id=?').get(taskId);
  if(!/^radar\b/i.test(String(task?.task_name||'')))return plan;
  const turn=db.prepare('SELECT COUNT(*) AS n FROM task_runs WHERE task_id=?').get(taskId).n;
  const out={...plan};
  for(const [key,step] of Object.entries(RADAR_STEP)){
    const list=Array.isArray(plan[key])?plan[key]:[];
    if(list.length<2)continue;
    const off=(turn*step)%list.length;
    out[key]=[...list.slice(off),...list.slice(0,off)];
  }
  return out;
}
function buildExecutionManifest(task, plan, run=null, session=null) {
  const sources = task.sources || ['xianyu','bunjang','buyee'];
  const pages=clampInt(task.max_pages,1,1,5);
  const maxItems=clampInt(task.max_items,20,5,100);
  const minEur=task.min_eur ?? null, maxEur=task.max_eur ?? null;
  const xLimit=clampInt(process.env.XIANYU_MAX_QUERIES || 2,2,2,2);
  const bLimit=clampInt(process.env.BUNJANG_MAX_QUERIES || 2,2,1,5);
  const jLimit=clampInt(process.env.BUYEE_MAX_QUERIES || 2,2,1,4);
  const xQueries=(plan?.xianyu||[]).slice(0,xLimit);
  const bQueries=(plan?.bunjang||[]).slice(0,bLimit);
  const jQueries=(plan?.japan||[]).slice(0,jLimit);
  const minCny=Number.isFinite(Number(minEur))?Math.floor(eurTo(Number(minEur),'CNY')||0):null;
  const maxCny=Number.isFinite(Number(maxEur))?Math.ceil(eurTo(Number(maxEur),'CNY')||0):null;
  const xianyuCalls=xQueries.map((q,idx)=>({
    query:q,
    createTask:{method:'POST',url:`${XIANYU_BASE_URL}/api/tasks/`,body:{
      task_name:`LH ${String(task.product_query||'').slice(0,40)} <timestamp>`,enabled:true,keyword:q,
      description:'Temporary live search created by Luxury Hunter. Central AI analysis is performed in Luxury Hunter.',
      analyze_images:false,max_pages:pages,personal_only:!!task.personal_only,
      min_price:minCny?String(minCny):null,max_price:maxCny?String(maxCny):null,cron:null,
      account_state_file:task.account_state_file||null,account_strategy:task.account_strategy||'auto',
      free_shipping:!!task.free_shipping,new_publish_option:task.new_publish_option||null,region:task.region||null,
      decision_mode:'keyword',keyword_rules:[q.split(/\s+/)[0]||q]
    }},
    then:[
      'POST /api/tasks/start/<temporaryTaskId>',
      'GET /api/tasks/<temporaryTaskId> every 2s until finished',
      `GET /api/results/${xianyuResultFilename(q)}?page=1&limit=100&include_hidden=true&sort_by=crawl_time&sort_order=desc`,
      'DELETE /api/tasks/<temporaryTaskId>'
    ]
  }));
  const bunjangCalls=bQueries.map(q=>({
    query:q,
    searchCommand:`bunjang-cli --json --preferred-transport browser search ${JSON.stringify(q)} --pages ${pages} --max-items ${maxItems}`,
    detailCommand:'bunjang-cli --json item list --ids <IDs encontrados, lotes de 40>'
  }));
  const oneMapCalls=jQueries.slice(0,clampInt(process.env.ONEMAP_MAX_QUERIES||2,2,1,4)).map(q=>({
    source:'yahoo-auctions-jp',label:'Yahoo! Auctions Japan',purchaseVia:'One Map / FROM JAPAN',
    mode:'mac-chrome-or-api',query:q,method:'MAC CHROME GET; REEFAPI POST if offline or failed',
    url:oneMapSearchUrl(q),
    fallbackCreditsPerSearch:2
  }));
  const japanCalls=[...oneMapCalls,...JAPAN_RADAR_SPECS.flatMap(spec=>
    jQueries.map(q=>({
      source:spec.id,
      label:spec.label,
      purchaseVia:spec.purchaseVia,
      mode:spec.mode,
      query:q,
      method:spec.mode==='browser'?'BROWSER GET':'GET',
      url:spec.searchUrl(q)
    }))
  )];
  let liveStatus={};
  try { liveStatus=JSON.parse(session?.source_status_json||run?.source_status_json||'{}'); } catch {}
  return {
    version:'1.7.1',
    task:{id:task.id,task_name:task.task_name,product_query:task.product_query,enabled:task.enabled,sources},
    run:run?{id:run.id,status:run.status,started_at:run.started_at,finished_at:run.finished_at,session_id:run.session_id,error:run.error||null}:null,
    searchSession:session?{id:session.id,status:session.status,started_at:session.started_at,finished_at:session.finished_at}:null,
    queryPlan:{generatedBy:plan?.generatedBy||'unknown',xianyu:plan?.xianyu||[],bunjang:plan?.bunjang||[],japan:plan?.japan||[]},
    effectiveLimits:{xianyuMaxQueries:xLimit,bunjangMaxQueries:bLimit,japanMaxQueries:jLimit,
      oneMapMaxQueries:clampInt(process.env.ONEMAP_MAX_QUERIES||2,2,1,4),
      oneMapDetailsPerRun:clampInt(process.env.ONEMAP_DETAIL_LIMIT||8,8,1,20),pages,maxItemsPerQuery:maxItems},
    filters:{minEur,maxEur,newPublishOption:task.new_publish_option||null,personalOnly:!!task.personal_only,freeShipping:!!task.free_shipping,region:task.region||null,accountStrategy:task.account_strategy||'auto',accountStateFile:task.account_state_file||null},
    connectors:{
      xianyu:{enabled:sources.includes('xianyu'),baseUrl:XIANYU_BASE_URL,queriesExecuted:xQueries,calls:xianyuCalls},
      bunjang:{enabled:sources.includes('bunjang'),binary:bunjangCli,queriesExecuted:bQueries,calls:bunjangCalls},
      japan:{enabled:sources.includes('buyee'),provider:'Japan multi-source radar v2',queriesExecuted:jQueries,calls:japanCalls}
    },
    ai:{enabled:task.decision_mode==='ai',provider:aiProvider(),configured:aiConfigured(),model:aiModel(),triageModel:aiTriageModel(),analyzeImages:!!task.analyze_images,centralInstruction:CENTRAL_AI_INSTRUCTION,userCriteria:task.description||'',keywordRules:task.keyword_rules||[],positiveVerification:{mandatory:true,stages:['preliminary-screen','exact-visual-model-check','live-google-market-comparables','deterministic-final-decision'],prioritySources:['Vestiaire Collective','Collector Square','EU specialist resellers','The RealReal','Fashionphile','Rebag'],strongBuyMinimum:{modelConfidence:0.85,relevantComparables:3,independentSources:2,marketConfidence:'HIGH'},marketplaceAuthenticitySignal:{enabled:true,xianyu:'Xianyu Verification / 验货宝',bunjang:'Bunjang Care / 번개케어',scores:{AVAILABLE:4,PASSED:8,UNKNOWN:0,UNAVAILABLE:0},failed:'REJECT',sellerAuthenticityClaimIsNotPassed:true}}},
    economics:getEconomics(),
    schedule:{mode:task.interval_minutes?'interval':task.cron?'cron':'manual',intervalMinutes:task.interval_minutes||null,cron:task.cron||null,runIfMissed:task.run_if_missed!==false},
    email:{enabled:!!task.email_enabled,to:task.email_to||null,decisions:task.notify_decisions||[],minScore:task.notify_min_score??null,minProfitEur:task.notify_min_profit_eur??null,maxItems:task.notify_max_items??8,onlyNew:task.notify_only_new!==false},
    liveStatus
  };
}

async function globalSearch(body) {
  const product=String(body.product||body.product_query||'').trim();
  if(!product) throw new Error('Escribe el producto que quieres buscar.');
  // Carril rápido: solo Xianyu y Mercari, los anuncios más nuevos primero.
  // Pasada de subastas: solo Yahoo por One Map (las que acaban en ≤2 h).
  const auctionLane=body.fast==='auction';
  const fastLane=!!body.fast&&!auctionLane;
  const sources=auctionLane?['buyee']:fastLane?['xianyu','buyee']:Array.isArray(body.sources)&&body.sources.length?body.sources:['xianyu','bunjang','buyee'];
  const sessionId=randomUUID();
  const startedAt=new Date().toISOString();

  const configuredPlan={
    product,
    xianyu:normalizeLines(
      body.xianyu_queries ??
      body.xianyuQueries ??
      []
    ),
    bunjang:normalizeLines(
      body.bunjang_queries ??
      body.bunjangQueries ??
      []
    ),
    japan:normalizeLines(
      body.japan_queries ??
      body.japanQueries ??
      []
    ),
    generatedBy:'configured'
  };

  const configuredComplete=
    (
      !sources.includes('xianyu') ||
      configuredPlan.xianyu.length>0
    ) &&
    (
      !sources.includes('bunjang') ||
      configuredPlan.bunjang.length>0
    ) &&
    (
      !sources.includes('buyee') ||
      configuredPlan.japan.length>0
    );

  const basePlan=configuredComplete
    ? configuredPlan
    : await buildQueryPlan(product);

  const taskId=body.taskId?Number(body.taskId):null;
  const plan=radarRotatePlan(effectivePlan(basePlan,body),taskId);
  db.prepare('INSERT INTO search_sessions(id,product_query,query_plan_json,status,started_at,task_id) VALUES(?,?,?,?,?,?)').run(sessionId,product,JSON.stringify(plan),'running',startedAt,taskId);
  if(body.runId) db.prepare('UPDATE task_runs SET session_id=? WHERE id=?').run(sessionId,Number(body.runId));
  const status={};
  const persistStatus=()=>db.prepare('UPDATE search_sessions SET source_status_json=? WHERE id=?').run(JSON.stringify(status),sessionId);
  const opts={
    pages:clampInt(body.pages??body.max_pages,1,1,5),maxItems:clampInt(body.maxItems??body.max_items,20,5,100),
    minEur:body.minEur??body.min_eur??null,maxEur:body.maxEur??body.max_eur??null,sessionId,product,
    personalOnly:!!body.personal_only,freeShipping:!!body.free_shipping,newPublishOption:body.new_publish_option||null,region:body.region||null,
    accountStateFile:body.account_state_file||null,accountStrategy:body.account_strategy||'auto',fastLane,auctionLane
  };
  // Todas las fuentes a la vez; cada una guarda cuánto ha tardado (ms).
  const jobs=[];
  const run=(name,fn)=>{
    status[name]={ok:null,state:'running'};persistStatus();
    const t0=Date.now();
    jobs.push((async()=>{
      try{status[name]=await fn();}
      catch(e){status[name]={ok:false,state:'error',error:e.message};}
      finally{status[name]={...(status[name]||{}),ms:Date.now()-t0};persistStatus();}
    })());
  };
  // Canales de compra (regla de Nil, 07-11-2026): Xianyu, Mercari y Yahoo
  // Subastas por One Map. Corea (Bunjang), eBay, Rakuten y Vestiaire como
  // fuente quedan fuera salvo que se activen a mano (BUNJANG_ENABLED=1,
  // EBAY_ENABLED=1, RAKUTEN_ENABLED=1, VESTIAIRE_SOURCE=1). Vestiaire se
  // sigue usando para comparar precios.
  const on=k=>['1','on','true','yes'].includes(String(process.env[k]||'').toLowerCase());
  if(!fastLane&&sources.includes('bunjang')&&on('BUNJANG_ENABLED'))run('bunjang',()=>searchBunjangLive({...opts,queries:plan.bunjang}));
  if(sources.includes('buyee'))run('buyee',()=>searchJapanRadarLive({...opts,queries:plan.japan}));
  const extraOff=['0','off','false','no'].includes(String(process.env.EXTRA_SOURCES||'').toLowerCase());
  if(!fastLane&&!extraOff&&on('RAKUTEN_ENABLED')&&rakutenConfigured())run('rakuten',()=>searchRakutenLive({...opts,queries:plan.japan}));
  if(!fastLane&&!extraOff&&on('EBAY_ENABLED')&&(sources.includes('ebay')||ebayConfigured()))run('ebay',()=>searchEbayLive({...opts,product}));
  if(sources.includes('xianyu'))run('xianyu',()=>searchXianyuLive({...opts,queries:plan.xianyu}));
  // Vestiaire como fuente de compra: apagado (VESTIAIRE_SOURCE=1 lo vuelve a encender).
  const taskName=taskId?db.prepare('SELECT task_name FROM tasks WHERE id=?').get(taskId)?.task_name:null;
  if(!fastLane&&taskName&&!isWatchTask(taskName)&&on('VESTIAIRE_SOURCE'))
    run('vestiaire',()=>searchVestiaireSource(opts,taskName));
  await Promise.all(jobs);
  const finishedAt=new Date().toISOString();
  db.prepare('UPDATE search_sessions SET source_status_json=?,status=?,finished_at=? WHERE id=?').run(JSON.stringify(status),'finished',finishedAt,sessionId);
  const items=sessionListings(sessionId);
  return {sessionId,product,plan,status,count:items.length,items};
}

function matchesKeywordRules(item, rules) {
  const hay=`${item.title||''}\n${item.description||''}`.toLowerCase();
  const rr=normalizeLines(rules).map(x=>x.toLowerCase());
  return !rr.length || rr.some(r=>hay.includes(r));
}
function taskResults(taskId) {
  return enrichCosts(db.prepare(`SELECT l.*, MAX(ss.started_at) AS task_last_seen, a.brand,a.model,a.authenticity_risk,a.liquidity,a.decision,a.opportunity_score,
    a.resale_low_eur,a.resale_high_eur,a.landed_cost_eur,a.net_profit_low_eur,a.net_profit_high_eur,a.notes,a.decision_reasons_es_json,a.preliminary_decision,a.verification_json
    FROM search_sessions ss
    JOIN search_session_items ssi ON ssi.session_id=ss.id
    JOIN listings l ON l.id=ssi.listing_id
    LEFT JOIN task_analyses a ON a.task_id=? AND a.listing_id=l.id
    WHERE ss.task_id=?
    GROUP BY l.id
    ORDER BY CASE a.decision WHEN 'STRONG BUY' THEN 1 WHEN 'BUY' THEN 2 WHEN 'WATCH' THEN 3 WHEN 'REVIEW' THEN 4 WHEN 'REJECT' THEN 6 ELSE 5 END,
      COALESCE(a.opportunity_score,-1) DESC, task_last_seen DESC`).all(Number(taskId),Number(taskId)).filter(xianyuListingHasVerificationTag));
}
function createTaskRecord(body) {
  const t=validateTaskInput(body);
  const now=new Date().toISOString();
  const r=db.prepare(`INSERT INTO tasks(task_name,enabled,product_query,sources_json,description,analyze_images,max_pages,max_items,min_eur,max_eur,personal_only,free_shipping,new_publish_option,region,cron,account_state_file,account_strategy,decision_mode,keyword_rules_json,xianyu_queries_json,bunjang_queries_json,japan_queries_json,interval_minutes,run_if_missed,email_enabled,email_to,notify_decisions_json,notify_min_score,notify_min_profit_eur,notify_max_items,notify_only_new,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      t.task_name,boolInt(t.enabled),t.product_query,JSON.stringify(t.sources),t.description,boolInt(t.analyze_images),t.max_pages,t.max_items,
      Number.isFinite(t.min_eur)?t.min_eur:null,Number.isFinite(t.max_eur)?t.max_eur:null,boolInt(t.personal_only),boolInt(t.free_shipping),t.new_publish_option,t.region,t.cron,t.account_state_file,t.account_strategy,t.decision_mode,JSON.stringify(t.keyword_rules),JSON.stringify(t.xianyu_queries),JSON.stringify(t.bunjang_queries),JSON.stringify(t.japan_queries),t.interval_minutes,boolInt(t.run_if_missed),boolInt(t.email_enabled),t.email_to,JSON.stringify(t.notify_decisions),t.notify_min_score,t.notify_min_profit_eur,t.notify_max_items,boolInt(t.notify_only_new),now,now);
  return taskPublic(db.prepare('SELECT * FROM tasks WHERE id=?').get(Number(r.lastInsertRowid)));
}
function updateTaskRecord(id, body) {
  const old=taskPublic(db.prepare('SELECT * FROM tasks WHERE id=?').get(Number(id))); if(!old) throw new Error('Tarea no encontrada.');
  const t=validateTaskInput(body,old); const now=new Date().toISOString();
  db.prepare(`UPDATE tasks SET task_name=?,enabled=?,product_query=?,sources_json=?,description=?,analyze_images=?,max_pages=?,max_items=?,min_eur=?,max_eur=?,personal_only=?,free_shipping=?,new_publish_option=?,region=?,cron=?,account_state_file=?,account_strategy=?,decision_mode=?,keyword_rules_json=?,xianyu_queries_json=?,bunjang_queries_json=?,japan_queries_json=?,interval_minutes=?,run_if_missed=?,email_enabled=?,email_to=?,notify_decisions_json=?,notify_min_score=?,notify_min_profit_eur=?,notify_max_items=?,notify_only_new=?,updated_at=? WHERE id=?`).run(
    t.task_name,boolInt(t.enabled),t.product_query,JSON.stringify(t.sources),t.description,boolInt(t.analyze_images),t.max_pages,t.max_items,Number.isFinite(t.min_eur)?t.min_eur:null,Number.isFinite(t.max_eur)?t.max_eur:null,boolInt(t.personal_only),boolInt(t.free_shipping),t.new_publish_option,t.region,t.cron,t.account_state_file,t.account_strategy,t.decision_mode,JSON.stringify(t.keyword_rules),JSON.stringify(t.xianyu_queries),JSON.stringify(t.bunjang_queries),JSON.stringify(t.japan_queries),t.interval_minutes,boolInt(t.run_if_missed),boolInt(t.email_enabled),t.email_to,JSON.stringify(t.notify_decisions),t.notify_min_score,t.notify_min_profit_eur,t.notify_max_items,boolInt(t.notify_only_new),now,Number(id));
  return taskPublic(db.prepare('SELECT * FROM tasks WHERE id=?').get(Number(id)));
}


// STRICT AUTO FRESHNESS V2
// La automatización solo acepta una fecha real de publicación.
// updatedAt, first_seen, last_seen y crawl time NO sustituyen
// a la fecha de publicación del marketplace.
function parseMarketplacePublishedMs(value,defaultOffset='+00:00'){
  if(value===null||value===undefined)return null;

  const raw=String(value).trim();
  if(!raw)return null;

  const naive=raw.match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2})(?::(\d{2}))?$/
  );

  let normalized=raw;

  if(naive){
    const hhmm=naive[2].replace(/^(\d):/,'0$1:');
    const ss=naive[3]||'00';
    normalized=`${naive[1]}T${hhmm}:${ss}${defaultOffset}`;
  }

  const ms=Date.parse(normalized);
  return Number.isFinite(ms)?ms:null;
}

function listingPublishedAtMs(item){
  let raw={};

  try{
    raw=JSON.parse(item?.raw_json||'{}');
  }catch{}

  const source=String(item?.source||'').toLowerCase();

  if(source==='xianyu'){
    const value=
      raw?.['商品信息']?.['发布时间']
      ??
      raw?.['发布时间'];

    return parseMarketplacePublishedMs(value,'+08:00');
  }

  if(source==='bunjang'){
    const candidates=[
      raw?.publishedAt,
      raw?.published_at,
      raw?.postedAt,
      raw?.posted_at,
      raw?.createdAt,
      raw?.created_at,
      raw?.registeredAt,
      raw?.registered_at,
      raw?.metadata?.publishedAt,
      raw?.metadata?.published_at,
      raw?.metadata?.postedAt,
      raw?.metadata?.posted_at,
      raw?.metadata?.createdAt,
      raw?.metadata?.created_at,
      raw?.metadata?.registeredAt,
      raw?.metadata?.registered_at
    ];

    for(const value of candidates){
      const ms=parseMarketplacePublishedMs(value,'+09:00');
      if(ms!==null)return ms;
    }

    return null;
  }

  const japanSources=new Set([
    'buyee',
    'buyee-jp',
    'mercari-jp',
    'rakuma-jp',
    'jdirectitems-auction',
    'jdirectitems-fleamarket',
    'yahoo-auctions-jp',
    'yahoo-fleamarket-jp',
    '2ndstreet-jp',
    'komehyo-jp'
  ]);

  if(japanSources.has(source)){
    const candidates=[
      raw?.publishedAt,
      raw?.published_at,
      raw?.postedAt,
      raw?.posted_at,
      raw?.createdAt,
      raw?.created_at,
      raw?.registeredAt,
      raw?.registered_at
    ];

    for(const value of candidates){
      const ms=parseMarketplacePublishedMs(value,'+09:00');
      if(ms!==null)return ms;
    }

    return null;
  }

  if(source.startsWith('ebay-')){
    return parseMarketplacePublishedMs(raw?.publishedAt||raw?.itemCreationDate,'+00:00');
  }
  if(source==='vestiaire'){
    const ms=Date.parse(raw?.publishedAt||raw?.created_at||'');
    return Number.isFinite(ms)?ms:null;
  }

  return null;
}

// TASK PUBLICATION WINDOW V1
// Convierte la configuración temporal de cada tarea
// en una ventana estricta de horas.
//
// Ejemplos actuales:
// 1天内发布 -> 24h
// 7天内发布 -> 168h
//
// También admite variantes futuras en español/inglés.

function publicationWindowHoursFromOption(value){
  const raw=String(value||'').trim();

  if(!raw)return null;

  const normalized=raw
    .toLowerCase()
    .replace(/\s+/g,' ')
    .trim();

  let m=null;

  m=normalized.match(/^(\d+)\s*天内发布$/);
  if(m){
    const days=Number(m[1]);
    return Number.isFinite(days)&&days>0
      ? days*24
      : null;
  }

  m=normalized.match(/^(\d+)\s*天$/);
  if(m){
    const days=Number(m[1]);
    return Number.isFinite(days)&&days>0
      ? days*24
      : null;
  }

  m=normalized.match(
    /^(\d+)\s*(?:d|day|days|día|días|dia|dias)$/
  );
  if(m){
    const days=Number(m[1]);
    return Number.isFinite(days)&&days>0
      ? days*24
      : null;
  }

  m=normalized.match(
    /(?:últimos?|ultimos?|last)\s+(\d+)\s*(?:días|dias|days)/
  );
  if(m){
    const days=Number(m[1]);
    return Number.isFinite(days)&&days>0
      ? days*24
      : null;
  }

  if(
    normalized==='último día' ||
    normalized==='ultimo dia' ||
    normalized==='last day' ||
    normalized==='last 24 hours' ||
    normalized==='24h' ||
    normalized==='24 h'
  ){
    return 24;
  }

  m=normalized.match(/^(\d+)\s*h(?:ours?|oras?)?$/);
  if(m){
    const hours=Number(m[1]);
    return Number.isFinite(hours)&&hours>0
      ? hours
      : null;
  }

  return null;
}

function enforceFreshPublicationWindow(sessionId,hours=24){
  const rows=db.prepare(`
    SELECT
      l.id,
      l.source,
      l.raw_json,
      l.first_seen
    FROM search_session_items ssi
    JOIN listings l
      ON l.id=ssi.listing_id
    WHERE ssi.session_id=?
  `).all(sessionId);

  const remove=db.prepare(
    'DELETE FROM search_session_items '+
    'WHERE session_id=? AND listing_id=?'
  );

  const now=Date.now();
  const maxAge=Math.max(1,Number(hours)||24)*60*60*1000;
  const futureSlack=10*60*1000;

  const stats={
    hours:Number(hours)||24,
    kept:0,
    stale:0,
    unknown:0,
    unknownKeptNew:0,
    future:0,
    removed:0,
    bySource:{}
  };

  for(const row of rows){
    const source=String(row.source||'unknown');

    if(!stats.bySource[source]){
      stats.bySource[source]={
        kept:0,
        stale:0,
        unknown:0,
        unknownKeptNew:0,
        future:0
      };
    }

    const publishedMs=listingPublishedAtMs(row);
    let reason=null;

    // Una subasta sigue siendo actual hasta que termina, aunque se publicara hace días.
    if(listingAuction(row)?.live){
      stats.kept++;
      stats.bySource[source].kept++;
      continue;
    }
    if(publishedMs===null){
      // Sin fecha de publicación (Komehyo, Rakuma...): si Luxury Hunter
      // lo vio por primera vez dentro de la ventana, es nuevo para nosotros.
      const firstSeenMs=Date.parse(row.first_seen||'');
      if(Number.isFinite(firstSeenMs)&&now-firstSeenMs<=maxAge){
        stats.unknownKeptNew++;
        stats.bySource[source].unknownKeptNew++;
      }else{
        reason='unknown';
      }
    }else if(publishedMs>now+futureSlack){
      reason='future';
    }else if(now-publishedMs>maxAge){
      reason='stale';
    }

    if(reason){
      remove.run(sessionId,row.id);
      stats[reason]++;
      stats.removed++;
      stats.bySource[source][reason]++;
    }else{
      stats.kept++;
      stats.bySource[source].kept++;
    }
  }

  return stats;
}

function progressEtaSeconds(startedAt,pct){
  const p=Number(pct);

  if(!startedAt || !Number.isFinite(p) || p<10 || p>=100){
    return p>=100?0:null;
  }

  const startedMs=new Date(startedAt).getTime();

  if(!Number.isFinite(startedMs))return null;

  const elapsed=Math.max(0,(Date.now()-startedMs)/1000);

  if(elapsed<8)return null;

  return Math.max(
    0,
    Math.round(elapsed*((100-p)/p))
  );
}

function setTaskRunProgress(
  runId,
  pct,
  stage,
  detail='',
  current=null,
  total=null
){
  if(!runId)return;

  const p=Math.max(
    0,
    Math.min(100,Math.round(Number(pct)||0))
  );

  const row=db.prepare(
    'SELECT started_at FROM task_runs WHERE id=?'
  ).get(Number(runId));

  const eta=progressEtaSeconds(row?.started_at,p);
  const now=new Date().toISOString();

  db.prepare(`
    UPDATE task_runs
    SET progress_pct=?,
        progress_stage=?,
        progress_detail=?,
        progress_updated_at=?,
        progress_eta_seconds=?,
        progress_current=?,
        progress_total=?
    WHERE id=?
  `).run(
    p,
    String(stage||''),
    String(detail||''),
    now,
    eta,
    current==null?null:Number(current),
    total==null?null:Number(total),
    Number(runId)
  );
}

const analysisJobs=new Map();

function createAnalysisJob(taskId,listingId){
  const id=`analysis-${Date.now()}-${Math.random().toString(36).slice(2,9)}`;
  const startedAt=new Date().toISOString();

  analysisJobs.set(id,{
    id,
    task_id:Number(taskId),
    listing_id:Number(listingId),
    status:'running',
    progress_pct:1,
    progress_stage:'Preparando análisis',
    progress_detail:'',
    progress_eta_seconds:null,
    started_at:startedAt,
    updated_at:startedAt,
    finished_at:null,
    error:null
  });

  return analysisJobs.get(id);
}

function updateAnalysisJob(
  jobId,
  pct,
  stage,
  detail=''
){
  const job=analysisJobs.get(jobId);
  if(!job)return;

  const p=Math.max(
    0,
    Math.min(100,Math.round(Number(pct)||0))
  );

  job.progress_pct=p;
  job.progress_stage=String(stage||'');
  job.progress_detail=String(detail||'');
  job.progress_eta_seconds=progressEtaSeconds(
    job.started_at,
    p
  );
  job.updated_at=new Date().toISOString();
}

function finishAnalysisJob(jobId,status,error=null){
  const job=analysisJobs.get(jobId);
  if(!job)return;

  job.status=status;
  job.finished_at=new Date().toISOString();
  job.updated_at=job.finished_at;
  job.progress_eta_seconds=0;

  if(status==='finished'){
    job.progress_pct=100;
    job.progress_stage='Análisis finalizado';
    job.progress_detail='Resultado guardado';
  }

  if(status==='error'){
    job.progress_stage='Error';
    job.error=String(error||'Error desconocido');
  }

  setTimeout(()=>{
    analysisJobs.delete(jobId);
  },15*60*1000);
}

const runningTaskIds=new Set();

function runIsAborted(runId){
  return db.prepare('SELECT status FROM task_runs WHERE id=?')
    .get(Number(runId))?.status==='aborted';
}

function abortedResult(runId,sessionId=null){
  const finished=new Date().toISOString();
  if(sessionId){
    db.prepare(
      "UPDATE search_sessions SET status='aborted',finished_at=? WHERE id=?"
    ).run(finished,sessionId);
  }
  return {runId:Number(runId),sessionId,status:'aborted'};
}
// ── OPPORTUNITY SPEED V1 ────────────────────────────────────────────────
// Pre-filtro determinista, prioridad por precio relativo, avisos
// instantáneos (email + Telegram) y alertas de salud del sistema.

// Solo se mira el TÍTULO: en las descripciones son habituales garantías
// como "가품시 환불" o "假一赔十" que no indican réplica.
const PRESCREEN_COUNTERFEIT_TERMS=[
  'replica','réplica','super copy','supercopy','mirror quality','fake bag',
  '레플','레플리카','미러급','이미테이션','짝퉁',
  '高仿','复刻','精仿','超a','a货','莆田','一比一','1:1','高版本','原单','尾单','顶配','私货','对版','肉眼无法辨别','同款皮',
  'レプリカ','スーパーコピー','ノベルティ','novelty'
];
const PRESCREEN_ACCESSORY_ONLY_TERMS=[
  'dust bag only','box only','strap only',
  '더스트백만','보증서만','박스만',
  '保存袋のみ','箱のみ','ストラップのみ','空箱',
  '只有防尘袋','仅防尘袋','空盒'
];

// Corea y Japón (no Xianyu): las búsquedas por modelo traen muchas carteras,
// calzado y joyería de la misma línea. Se descartan gratis por el título,
// salvo que el título también diga que es un bolso.
const PRESCREEN_NON_BAG_TERMS=[
  'wallet','card holder','cardholder','card case','coin purse','coin case','key holder','keyring','key ring','keychain','key pouch','bag charm',
  'loafer','sandal','sneaker','pumps','boots','mules','slides','necklace','earring','bracelet','brooch','scarf','twilly','sunglasses','belt','porta carte','portafoglio','cintura',
  '지갑','카드홀더','카드케이스','키링','키홀더','열쇠고리','로퍼','샌들','뮬','슬리퍼','스니커즈','구두','펌프스','부츠',
  '반지','목걸이','귀걸이','팔찌','브로치','시계','스카프','트윌리','머플러','선글라스','벨트','가방박스','뱃지','배지',
  '財布','ウォレット','コインケース','カードケース','名刺入れ','小銭入れ','パスケース','定期入れ','キーケース','キーホルダー','キーリング','チャーム',
  '時計','ローファー','パンプス','サンダル','スニーカー','ブーツ','ミュール','シューズ','指輪','ネックレス','ピアス','イヤリング','ブレスレット','バングル','ブローチ',
  'スカーフ','ストール','マフラー','ツイリー','サングラス','ベルト','手帳','スマホケース','iphoneケース','保存袋'
];
// "Wallet on chain" es un bolso pequeño: no se descarta.
const PRESCREEN_CHAIN_WALLET=/wallet on chain|chain wallet|\bwoc\b|チェーンウォレット|체인\s*지갑|체인\s*월렛/i;
const PRESCREEN_BAG_WORD=/bag|tote|handbag|shoulder|crossbody|clutch|satchel|hobo|pochette|backpack|bolso|bandolera|riñonera|borsa|tasche|\bsac\b|バッグ|ショルダー|トート|クラッチ|ボストン|ポシェット|リュック|가방|숄더|토트|크로스|클러치|호보|(?<!쇼핑|더스트)백(?!화점)/i;
function nonBagTitleTerm(item){
  if(String(item?.source||'').toLowerCase()==='xianyu')return null;
  const title=String(item?.title||'').toLowerCase();
  if(!title||PRESCREEN_CHAIN_WALLET.test(title))return null;
  const term=PRESCREEN_NON_BAG_TERMS.find(t=>title.includes(t));
  if(!term)return null;
  // "más bolso" en el título: lo decide la IA.
  if(PRESCREEN_BAG_WORD.test(title.replaceAll(term,' ')))return null;
  return term;
}

// Pieles exóticas (CITES): sin permiso de importación se requisan en aduana.
// "Grabado/estampado cocodrilo" en piel de vaca sí se puede importar.
const PRESCREEN_EXOTIC_TERMS=[
  'crocodile','croc ','alligator','caiman','porosus','niloticus','python','ostrich','lizard','stingray','galuchat','shagreen','snakeskin','snake skin','eel skin',
  '鳄鱼皮','真鳄鱼','鳄鱼','蟒蛇皮','蟒蛇','真蛇皮','鸵鸟皮','鸵鸟','蜥蜴皮','蜥蜴','珍珠鱼皮','鳗鱼皮',
  'クロコダイル','クロコ','アリゲーター','カイマン','パイソン','オーストリッチ','リザード','スティングレイ','ガルーシャ','ヘビ革','蛇革',
  '크로커다일','악어가죽','악어','파이톤','오스트리치','타조','리자드','도마뱀','가오리'
];
const PRESCREEN_EXOTIC_IMITATION=/embossed|emboss|stamped|print|effect|型押し|型押|エンボス|压纹|压花|印花|纹路|蛇纹|鳄鱼纹|엠보|무늬|패턴/i;

function exoticSkinTerm(item){
  const text=`${item?.title||''} ${item?.description||''}`.toLowerCase();
  const term=PRESCREEN_EXOTIC_TERMS.find(t=>text.includes(t));
  if(!term)return null;
  // "cocodrilo grabado" en el mismo anuncio: piel normal, no se descarta.
  if(PRESCREEN_EXOTIC_IMITATION.test(text))return null;
  return term;
}

// Xianyu sin verificación de autenticidad de la plataforma (验货宝) = descartado
// siempre, sin gastar IA ni avisar. Política de Nil.
function xianyuVerificationVeto(item){
  // eBay: solo anuncios con la Garantía de Autenticidad de eBay (un experto
  // revisa el bolso antes de enviarlo). El resto se descarta sin IA.
  if(String(item?.source||'').toLowerCase().startsWith('ebay-')&&!['0','false','off','no'].includes(String(process.env.EBAY_REQUIRE_AUTHENTICITY||'').toLowerCase())){
    let raw={};try{raw=JSON.parse(item?.raw_json||'{}')}catch{}
    const fb=Number(item?.seller_sales), pct=Number(item?.seller_reviews);
    // Con la garantía también hace falta un vendedor con reseñas (regla de Nil).
    if(raw.authenticityGuarantee===true)return fewSellerReviewsVeto('eBay',fb);
    // Excepción (regla de Nil): vendedores con ≥500 valoraciones y ≥99 %
    // positivas. La garantía es la de autenticidad (programa
    // AUTHENTICITY_GUARANTEE de eBay), no la de devolución.
    if(fb>=Number(process.env.EBAY_TRUSTED_MIN_FEEDBACK||500)&&pct>=Number(process.env.EBAY_TRUSTED_MIN_PCT||99))return null;
    return {
      code:'no_ebay_authenticity_guarantee',
      term:'sin garantía',
      reasons:['El anuncio de eBay no tiene la Garantía de Autenticidad de eBay ni es de un vendedor con al menos 500 valoraciones y un 99 % positivas. Descartado por política.']
    };
  }
  if(String(item?.source||'').toLowerCase()!=='xianyu')return null;
  if(xianyuListingHasVerificationTag(item))return null;
  return {
    code:'no_xianyu_verification',
    term:'etiqueta ausente',
    reasons:['El anuncio de Xianyu no muestra la etiqueta oficial 验货宝. Descartado por política.']
  };
}
// VENDEDORES SIN RESEÑAS O CON POCAS (regla de Nil): fuera aunque el anuncio
// tenga sello de verificación o garantía (eBay, Bunjang Care, Yahoo). Si la
// plataforma no da el número de reseñas, no se puede comprobar.
const SELLER_MIN_REVIEWS=Number(process.env.SELLER_MIN_REVIEWS||20);
function fewSellerReviewsVeto(platform,reviews){
  const n=Number(reviews);
  if(reviews===null||reviews===undefined||reviews===''||!Number.isFinite(n)||n>=SELLER_MIN_REVIEWS)return null;
  return {
    code:'seller_few_reviews',
    term:`${n} reseñas`,
    reasons:[`${platform}: el vendedor tiene ${n} reseñas (mínimo ${SELLER_MIN_REVIEWS}), aunque el anuncio tenga sello o garantía. Descartado por política.`]
  };
}
// Bunjang (regla de Nil): solo anuncios con 번개케어 o de vendedores con buena
// nota y suficientes reseñas. Si no se pudo comprobar, decide la IA.
function bunjangTrustVeto(item){
  if(String(item?.source||'').toLowerCase()!=='bunjang')return null;
  let raw={};try{raw=JSON.parse(item?.raw_json||'{}')}catch{}
  const t=raw.luxuryHunterTrust;
  if(!t)return null;
  if(t.care===true)return fewSellerReviewsVeto('Bunjang',t.reviewCount);
  const minRating=Number(process.env.BUNJANG_MIN_RATING||4.5);
  const minReviews=Number(process.env.BUNJANG_MIN_REVIEWS||20);
  if(Number(t.rating)>=minRating&&Number(t.reviewCount)>=minReviews)return null;
  return {
    code:'bunjang_untrusted',
    term:`care no · nota ${t.rating??'—'} · ${t.reviewCount??0} reseñas`,
    reasons:[`Bunjang sin 번개케어 y vendedor sin buenas valoraciones (nota ${t.rating??'—'}, ${t.reviewCount??0} reseñas; mínimo ${minRating} y ${minReviews}). Descartado por política.`]
  };
}
// ── VENDEDORES DE JAPÓN (regla de Nil) ──────────────────────────────────
// Mercari y Rakuma: solo vendedores con al menos JAPAN_MIN_POSITIVE_PCT % de
// valoraciones positivas y JAPAN_MIN_REVIEWS reseñas. Se comprueba solo en los
// candidatos que pasan el triaje (se abre su ficha una vez y se guarda 3 días).
const JAPAN_SELLER_SOURCES=new Set(['mercari-jp','rakuma-jp']);
async function fetchJapanSeller(item,ctx){
  if(item.source==='rakuma-jp'){
    const r=await fetch(item.url,{headers:{'user-agent':'Mozilla/5.0'},signal:AbortSignal.timeout(20000)});
    if(!r.ok)return null;
    const plain=String(await r.text()).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
    const m=plain.match(/取引の評価\s*(\d+)\s+(\d+)\s+(\d+)/);
    return m?{good:+m[1],normal:+m[2],bad:+m[3]}:null;
  }
  if(item.source==='mercari-jp'&&ctx){
    const page=await ctx.newPage();
    try{
      const respP=page.waitForResponse(r=>r.url().includes('api.mercari.jp/items/get'),{timeout:30000});
      await page.goto(item.url,{waitUntil:'domcontentloaded',timeout:40000});
      const j=await (await respP).json();
      const rt=j?.data?.seller?.ratings;
      return rt?{good:Number(rt.good)||0,normal:Number(rt.normal)||0,bad:Number(rt.bad)||0}:null;
    }finally{await page.close().catch(()=>{});}
  }
  return null;
}
async function checkJapanSellers(items){
  const out=new Map();
  const todo=[];
  for(const it of items){
    let raw={};try{raw=JSON.parse(it.raw_json||'{}')}catch{}
    const prev=raw.luxuryHunterSeller;
    if(prev?.checkedAt&&Date.now()-Date.parse(prev.checkedAt)<3*86400e3)out.set(it.id,prev);
    else todo.push(it);
  }
  let browser=null,ctx=null;
  try{
    if(todo.some(x=>x.source==='mercari-jp')){
      const {chromium}=await import('playwright');
      browser=await chromium.launch();
      ctx=await browser.newContext({locale:'ja-JP'});
    }
    for(const it of todo){
      let seller=null;
      try{seller=await fetchJapanSeller(it,ctx);}catch{}
      if(seller){
        const total=seller.good+seller.normal+seller.bad;
        seller={...seller,total,positivePct:total?Math.round(seller.good/total*1000)/10:null,checkedAt:new Date().toISOString()};
        let raw={};try{raw=JSON.parse(it.raw_json||'{}')}catch{}
        raw.luxuryHunterSeller=seller;
        db.prepare('UPDATE listings SET raw_json=?, seller_reviews=? WHERE id=?').run(JSON.stringify(raw),total,it.id);
        it.raw_json=JSON.stringify(raw);
        out.set(it.id,seller);
      }
      await sleep(1200);
    }
  }finally{
    if(browser)await browser.close().catch(()=>{});
  }
  return out;
}
function japanSellerVeto(seller){
  if(!seller)return null; // no se pudo comprobar: decide la IA
  const minPct=Number(process.env.JAPAN_MIN_POSITIVE_PCT||92);
  const minReviews=Number(process.env.JAPAN_MIN_REVIEWS||20);
  if(seller.total>=minReviews&&Number(seller.positivePct)>=minPct)return null;
  return {
    code:'japan_seller_untrusted',
    term:`${seller.total} reseñas · ${seller.positivePct??'—'} %`,
    reasons:[`Vendedor con pocas reseñas o valoraciones bajas (${seller.total} reseñas, ${seller.positivePct??'—'} % positivas; mínimo ${minReviews} y ${minPct} %). Descartado por política.`]
  };
}

// Sin precio (o a 0 €) no se analiza ni se avisa: el beneficio saldría falso.
function noPriceVeto(item){
  const price=Number(item?.price_eur);
  if(Number.isFinite(price)&&price>0)return null;
  return {
    code:'no_price',
    reasons:['El anuncio no tiene un precio válido (sale a 0 €); no se analiza ni se avisa.']
  };
}

// XIANYU: RÉPLICAS. En Xianyu abundan las réplicas: se descartan sin IA las
// que usan jerga de réplica en el título O en la descripción, y las que cuestan
// menos del 30 % de lo que se vende de verdad ese modelo (hoja de Vestiaire).
const XIANYU_REPLICA_TERMS=[
  '高仿','复刻','精仿','仿品','仿款','a货','超a','m货','莆田','一比一','1:1','高版本','顶配','对版','肉眼无法辨别',
  '同款皮','原厂皮','原版皮','纯原','工厂货','厂家直','代工厂','同厂','微商','顶级天花板','天花板版本','高端店定制','定制款','原单','尾单',
  'replica','super copy','supercopy','mirror quality',
  // Relojes
  '复刻表','超级复刻','clean厂','vs厂','zf厂','n厂','ar厂','noob','3a货','改装表','后配表盘','后配'
];
// Garantías y negaciones que no indican réplica ("假一赔十", "非高仿"...).
const XIANYU_REPLICA_SAFE=/假一赔\S*|假货?(包退|包赔|必究|十倍|赔)\S*|(非|不是|绝非|并非|拒绝|杜绝|不卖|不做|没有|无)\s*(高仿|复刻|精仿|仿品|a货|莆田|假货)/gi;
function xianyuReplicaTerm(item){
  if(String(item?.source||'').toLowerCase()!=='xianyu')return null;
  // Frases de garantía ("如为仿品，全额退款", "假一赔十"...) no cuentan.
  const text=`${item?.title||''} ${item?.description||''}`.toLowerCase().replace(XIANYU_REPLICA_SAFE,' ')
    .split(/[。！!？?；;※\n]/).filter(seg=>!/退款|退货|包退|赔|refund/.test(seg)).join(' ');
  return XIANYU_REPLICA_TERMS.find(t=>text.includes(t))||null;
}
const XIANYU_MIN_PRICE_SHARE=0.30;
function xianyuTooCheapVeto(item,task){
  if(String(item?.source||'').toLowerCase()!=='xianyu'||!task?.task_name)return null;
  const price=Number(item?.price_eur);
  const r=vestiaireRefs().tasks?.[task.task_name];
  if(!Number.isFinite(price)||price<=0||!r)return null;
  // Mínimo según el mismo modelo si se reconoce; si no, el de toda la pestaña.
  const named=Array.isArray(r.fichas)?vestiaireSameModel(task.task_name,r.fichas.filter(f=>!f.excluded&&Number.isFinite(f.price_eur)),item,null)?.rows:null;
  const base=named&&named.length>=4?priceStats(named.map(f=>f.price_eur)).p25:r.all?.p25;
  if(!Number.isFinite(base)||base<=0)return null;
  const floor=Math.round(base*VESTIAIRE_DEFAULT_REALIZATION*XIANYU_MIN_PRICE_SHARE);
  if(price>=floor)return null;
  return {
    code:'xianyu_too_cheap',
    term:`${Math.round(price)}<${floor}`,
    reasons:[`Precio irrealmente bajo para un original: ${Math.round(price)} € frente a un mínimo de ${floor} € (30 % de lo que se vende de verdad este modelo en Vestiaire). En Xianyu suele ser réplica.`]
  };
}


// Sin IA: si ni vendiéndolo al precio de las referencias más caras del
// modelo en la base (p90) deja beneficio, no se analiza.
function overpricedVeto(item,task){
  if(!task?.task_name||listingAuction(item))return null;
  const info=baseReferenceRows(task,item);
  const values=(info.rows||[]).map(r=>refValueForGate(r)).filter(v=>v>0).sort((a,b)=>a-b);
  if(values.length<5)return null;
  const top=values[Math.floor((values.length-1)*0.9)];
  const fee=resalePlatform(task.task_name).fee/100;
  const landed=Number(importEconomics(item).importedTotalEur)||0;
  if(!(landed>0)||landed<top*(1-fee))return null;
  return {code:'overpriced',term:`${Math.round(landed)}≥${Math.round(top*(1-fee))}`,
    reasons:[`Caro: el coste puesto (${Math.round(landed)} €) no deja beneficio ni vendiéndolo al precio de las referencias más caras de tu base (${Math.round(top)} € menos la comisión).`]};
}
const refValueForGate=r=>r?.sold?(Number(r.sold_price_eur)>0?Number(r.sold_price_eur):Number(r.price_eur)):Number(r?.price_eur)*VESTIAIRE_DEFAULT_REALIZATION;
function deterministicPrescreen(item,task=null){
  const noPrice=noPriceVeto(item);
  if(noPrice)return noPrice;
  const veto=xianyuVerificationVeto(item);
  if(veto)return veto;
  if(String(item?.source||'')==='yahoo-auctions-jp'){
    const few=fewSellerReviewsVeto('Yahoo! Auctions',item?.seller_reviews);
    if(few)return few;
  }
  // Relojes en Xianyu: las mismas condiciones que los bolsos (etiqueta
  // 验货宝 obligatoria); el vendedor no cuenta (decisión de Nil, 06-11-2026).
  const replica=xianyuReplicaTerm(item);
  if(replica){
    return {
      code:'counterfeit_title',
      term:replica,
      reasons:[`El anuncio de Xianyu contiene "${replica}", jerga de réplica o artículo no original.`]
    };
  }
  const cheap=xianyuTooCheapVeto(item,task);
  if(cheap)return cheap;
  const dear=overpricedVeto(item,task);
  if(dear)return dear;
  const bj=bunjangTrustVeto(item);
  if(bj)return bj;
  const title=String(item?.title||'').toLowerCase();
  const exotic=exoticSkinTerm(item);
  if(exotic){
    return {
      code:'exotic_skin',
      term:exotic,
      reasons:[`Piel exótica ("${exotic.trim()}"): requiere permiso CITES y se puede requisar en aduana. Descartado por política.`]
    };
  }
  const counterfeit=PRESCREEN_COUNTERFEIT_TERMS.find(t=>title.includes(t));
  if(counterfeit){
    return {
      code:'counterfeit_title',
      term:counterfeit,
      reasons:[`El título contiene "${counterfeit}", término asociado a réplica o artículo no original.`]
    };
  }
  const accessory=PRESCREEN_ACCESSORY_ONLY_TERMS.find(t=>title.includes(t));
  if(accessory){
    return {
      code:'accessory_only',
      term:accessory,
      reasons:[`El título indica que solo se vende un accesorio ("${accessory}"), no el bolso.`]
    };
  }
  // En las tareas de relojes "時計" / "시계" es justo lo que se busca.
  const nonBag=isWatchTask(task?.task_name)?null:nonBagTitleTerm(item);
  if(nonBag){
    return {
      code:'not_a_bag',
      term:nonBag,
      reasons:[`El título indica un artículo que no es un bolso ("${nonBag}").`]
    };
  }
  return null;
}

// Limpieza al arrancar: análisis positivos de Xianyu sin 验货宝 pasan a REJECT
// para que no salgan en avisos, resúmenes ni se vuelvan a verificar.
function vetoUnverifiableXianyuAnalyses(){
  const rows=db.prepare(`SELECT ta.task_id,l.* FROM task_analyses ta JOIN listings l ON l.id=ta.listing_id
    WHERE (l.source='xianyu' OR l.source LIKE 'ebay-%') AND UPPER(COALESCE(ta.decision,''))<>'REJECT'`).all();
  let n=0;
  for(const r of rows){
    const {task_id,...item}=r;
    const veto=xianyuVerificationVeto(item);
    if(veto){storePrescreenReject(task_id,item,veto);n++;}
  }
  if(n)console.log(`Sin verificación de autenticidad (Xianyu/eBay): ${n} análisis pasados a descartados.`);
}
// PRECIO SIN IA (07-11-2026): si ni vendiéndolo al precio alto de la base de
// Nil para ese modelo (el 10 % más caro de sus fichas) queda beneficio, no se
// gasta IA en él. Antes un tercio del gasto se iba en anuncios así.
function priceCeilingVeto(item,task){
  if(['0','off','false','no'].includes(String(process.env.PRICE_PRESCREEN||'').toLowerCase()))return null;
  let info;try{info=baseReferenceRows(task,item);}catch{return null;}
  const vals=(info?.rows||[]).map(r=>refValue(r,VESTIAIRE_DEFAULT_REALIZATION)).filter(v=>v>0).sort((a,b)=>a-b);
  if(vals.length<8)return null;
  const top=vals[Math.min(vals.length-1,Math.floor(vals.length*0.9))];
  const landed=Number(importEconomics(item)?.importedTotalEur)||0;
  if(!(landed>0))return null;
  const fee=resalePlatform(task.task_name).fee/100;
  const minProfit=Number(task.notify_min_profit_eur)||200;
  const clean=top*(1-fee)-landed;
  if(clean>=minProfit*0.6)return null;
  return {code:'price_ceiling',term:'precio alto',
    reasons:[`Precio: ni vendiéndolo al precio alto de tu base (${Math.round(top)} €, el 10 % más caro de ${vals.length} fichas del modelo) queda beneficio (${Math.round(clean)} € limpios con un coste puesto de ${Math.round(landed)} €). Descartado sin usar IA.`]};
}
function storePrescreenReject(taskId,item,pre){
  const now=new Date().toISOString();
  const economics=importEconomics(item);
  const a={
    brand:'',model:'',authenticity_risk:pre.code==='counterfeit_title'?'HIGH':'',liquidity:'',
    decision:'REJECT',opportunity_score:0,
    landed_cost_eur:economics.importedTotalEur,
    decision_reasons_es:pre.reasons,
    notes:`Descartado por pre-filtro determinista (${pre.code}: ${pre.term}) sin llamar a Gemini.`,
    prescreen:pre
  };
  storeTaskAnalysis(taskId,item,a,'REJECT',{status:'not_required',prescreen:pre},now);
}

// Mediana del precio pedido en los anuncios que esta tarea ha visto en los
// últimos 30 días. Sirve para analizar primero lo que está más barato.
function taskMedianAskingEur(taskId){
  const since=new Date(Date.now()-30*24*3600*1000).toISOString();
  const rows=db.prepare(`
    SELECT DISTINCT l.id,l.price_eur
    FROM search_sessions s
    JOIN search_session_items ssi ON ssi.session_id=s.id
    JOIN listings l ON l.id=ssi.listing_id
    WHERE s.task_id=? AND s.started_at>=? AND l.price_eur>0
  `).all(Number(taskId),since);
  if(rows.length<8)return null;
  const values=rows.map(r=>Number(r.price_eur)).sort((a,b)=>a-b);
  return percentile(values,0.5);
}

function prioritizeForAnalysis(taskId,items){
  const median=taskMedianAskingEur(taskId);
  const ranked=items.map(item=>{
    const price=Number(item.price_eur);
    const ratio=median&&price>0?price/median:null;
    return {item,ratio};
  });
  ranked.sort((a,b)=>
    Number(!!b.item._needsVerification)-Number(!!a.item._needsVerification) ||
    (a.ratio??9)-(b.ratio??9)
  );
  return {median,items:ranked.map(r=>{
    r.item._priceVsTaskMedian=r.ratio;
    return r.item;
  })};
}

// Triaje barato: UNA llamada de solo texto con el modelo económico revisa
// todos los anuncios nuevos de la ejecución y elige cuáles merecen el
// análisis completo (fotos + modelo exacto + mercado), que es lo caro.
function isAiPolicyFlag(e){
  return e?.policyFlag===true||/flagged as potentially violating|usage polic|invalid_prompt|content[_ ]policy|content[_ ]filter/i.test(String(e?.message||e||''));
}

function storePolicyReject(taskId,item,stage){
  const now=new Date().toISOString();
  const economics=importEconomics(item);
  const reason='OpenAI no permite analizar el contenido de este anuncio (filtro de seguridad). Se descarta automáticamente.';
  const a={
    brand:'',model:'',authenticity_risk:'',liquidity:'',
    decision:'REJECT',opportunity_score:0,
    landed_cost_eur:economics.importedTotalEur,
    decision_reasons_es:[reason],
    notes:`Descartado: contenido bloqueado por el filtro de seguridad de la IA (${stage}).`,
    policyFlag:true
  };
  storeTaskAnalysis(taskId,item,a,'REJECT',{status:'not_required',policyFlag:true},now);
}

async function triageWithAi(task,items){
  const key=aiApiKey();
  const model=aiTriageModel();
  const minScore=Number(process.env.AI_TRIAGE_MIN_SCORE||50);
  const scores=new Map();
  let calls=0;
  let usage=null;
  let flagged=0;
  const runBatch=async batch=>{
    try{
      await triageBatch(batch);
    }catch(e){
      if(!isAiPolicyFlag(e))throw e;
      // Un título bloquea el lote entero: se parte en dos hasta aislarlo.
      if(batch.length===1){
        flagged++;
        scores.set(batch[0].id,{score:0,reason:'Contenido bloqueado por el filtro de seguridad de la IA.',policyFlag:true});
        return;
      }
      const mid=Math.ceil(batch.length/2);
      await runBatch(batch.slice(0,mid));
      await runBatch(batch.slice(mid));
    }
  };
  const triageBatch=async batch=>{
    const lines=batch.map((x,i)=>({
      i,
      source:x.source,
      title:String(x.title||'').slice(0,180),
      description:String(x.description||'').replace(/\s+/g,' ').slice(0,260),
    }));
    const prompt=`You are the cheap first-pass triage for Luxury Hunter, a buyer of second-hand luxury bags and watches in Asia for resale in Western Europe. Select the listings that are plausibly the authentic target product, so they get the full inspection.

TASK: ${task.task_name}
TARGET PRODUCT: ${task.product_query}
TASK CRITERIA (abridged):
${String(task.description||'').slice(0,1800)}

Prefer recall over precision: a full analysis costs about one cent, a missed bargain costs hundreds of euros. DO NOT JUDGE THE PRICE: Luxury Hunter prices every listing itself from Nil's references. When a listing plausibly is the target product, score it at least 55 even if information is incomplete.

Score each listing 0-100 for "is this plausibly the target product":
- High: clearly the target product family/size, no red flags.
- Low: different model/size/product type (wallets, pouches, charms, straps, other bags), accessories only, replica wording, damaged beyond resale, or too little information to identify the item.
- Score 0: genuine exotic leather (crocodile, alligator, python/snake, ostrich, lizard, stingray) — CITES import risk. Embossed calf is fine.
Never invent facts. Use only the listing text below (titles may be Korean, Japanese or Chinese).

LISTINGS (JSON):
${JSON.stringify(lines)}

Return ONLY JSON: {"items":[{"i":0,"score":0,"reason_es":"motivo breve en español"}]} with one entry per listing.`;
    const {data,usage:u}=await geminiJsonRequest({key,model,parts:[{text:prompt}],googleSearch:false,purpose:'triage'});
    calls++;
    usage=u||usage;
    for(const row of Array.isArray(data?.items)?data.items:[]){
      const item=batch[Number(row?.i)];
      if(!item)continue;
      scores.set(item.id,{
        score:clampNum(row.score),
        reason:String(row.reason_es||'').slice(0,300)
      });
    }
  };
  for(const batch of chunks(items,40))await runBatch(batch);
  return {scores,minScore,calls,model,usage,flagged};
}

function storeTriageReject(taskId,item,t){
  const now=new Date().toISOString();
  const economics=importEconomics(item);
  const a={
    brand:'',model:'',authenticity_risk:'',liquidity:'',
    decision:'REJECT',opportunity_score:t.score,
    landed_cost_eur:economics.importedTotalEur,
    decision_reasons_es:[`Triaje IA (${t.score}/100): ${t.reason||'poco interés para un análisis completo.'}`],
    notes:`Descartado en el triaje barato (${aiTriageModel()}) sin análisis completo.`,
    triage:t
  };
  storeTaskAnalysis(taskId,item,a,'TRIAGE',{status:'not_required',triage:t},now);
}

function envList(name,fallback){
  const raw=String(process.env[name]||'').trim();
  return (raw?raw.split(','):fallback).map(s=>s.trim().toUpperCase()).filter(Boolean);
}

function alertRecipient(){
  return String(
    process.env.GLOBAL_EMAIL_TO||
    globalEmailSetting().to||
    process.env.SMTP_USER||
    ''
  ).trim();
}

function telegramConfigured(){
  return !!(process.env.TELEGRAM_BOT_TOKEN&&process.env.TELEGRAM_CHAT_ID);
}

async function telegramApi(method,body={},timeoutMs=20000){
  const base=String(process.env.TELEGRAM_API_BASE||"https://api.telegram.org").replace(/\/$/,"");
  const r=await fetch(`${base}/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`,{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify(body),
    signal:AbortSignal.timeout(timeoutMs)
  });
  const data=await r.json().catch(()=>({}));
  if(!r.ok||data.ok===false)throw new Error(`Telegram ${method}: ${data.description||r.status}`);
  return data;
}

async function telegramSend(text,photoUrl=null,{buttons=null,previewUrl=null,noPreview=false}={}){
  if(!telegramConfigured())return {sent:false,reason:'telegram-not-configured'};
  const chat_id=process.env.TELEGRAM_CHAT_ID;
  const extra=buttons?{reply_markup:{inline_keyboard:buttons}}:{};
  if(photoUrl&&text.length<=1024){
    try{
      await telegramApi('sendPhoto',{chat_id,photo:photoUrl,caption:text,parse_mode:'HTML',...extra});
      return {sent:true};
    }catch(e){
      console.error('Telegram photo failed, sending text:',e.message);
    }
  }
  // La vista previa, del anuncio (no del primer enlace del texto, que puede ser de Vestiaire).
  const preview=noPreview?{link_preview_options:{is_disabled:true}}
    :previewUrl?{link_preview_options:{url:previewUrl}}
    :{disable_web_page_preview:false};
  await telegramApi('sendMessage',{chat_id,text:text.slice(0,4096),parse_mode:'HTML',...preview,...extra});
  return {sent:true};
}

// ── TELEGRAM BUTTONS V1 ─────────────────────────────────────────────────
// Cada aviso lleva "✅ Me interesa" / "❌ No me interesa". Lo que pulse Nil
// se guarda en listing_feedback: los descartados no vuelven a avisarse ni a
// salir en el resumen, y los marcados se destacan en el resumen.
function alertButtons(listingId){
  const id=Number(listingId);
  return [[
    {text:'✅ Me interesa',callback_data:`ok:${id}`},
    {text:'❌ No me interesa',callback_data:`no:${id}`}
  ]];
}

// Enlace para abrir el anuncio en la app del móvil. Telegram solo admite
// https, así que Xianyu pasa por la página puente docs/open.html (GitHub
// Pages) que salta a fleamarket://. Mercari, Bunjang y eBay abren su app
// solas con su enlace web (enlaces universales).
const APP_BRIDGE_URL=String(process.env.APP_BRIDGE_URL||'https://nmuxart-star.github.io/luxury-hunter-worker/open.html');
function listingAppLink(x){
  const url=String(x?.url||'');
  const id=String(x?.source_id||'').trim()||url.match(/[?&]id=(\d+)/)?.[1]||'';
  if(x?.source==='xianyu'&&id){
    const web=`https://www.goofish.com/item?id=${id}`;
    return `${APP_BRIDGE_URL}?app=${encodeURIComponent(`fleamarket://item?id=${id}`)}&web=${encodeURIComponent(web)}`;
  }
  return url;
}

function telegramImageUrl(u){
  let s=String(u||'').trim();
  if(s.startsWith('//'))s='https:'+s;
  if(/^http:\/\/[^/]*(alicdn\.com|bunjang\.co\.kr|mercdn\.net|rakuten\.co\.jp|ebayimg\.com)/i.test(s))s=s.replace(/^http:/,'https:');
  return /^https:\/\//i.test(s)?s:'';
}

function listingTelegramImages(x,max=4){
  let urls=[];
  try{urls=collectListingImageUrls(x,max);}catch{}
  if(x?.image_url)urls.unshift(x.image_url);
  return [...new Set(urls.map(telegramImageUrl).filter(Boolean))].slice(0,max);
}

// Álbum de fotos (hasta 10). Si Telegram no puede descargar alguna URL
// (protección de la web), se descargan aquí y se suben.
async function telegramSendAlbum(images,caption=''){
  const chat_id=process.env.TELEGRAM_CHAT_ID;
  const list=(images||[]).slice(0,10);
  if(!list.length)return {sent:false};
  if(list.length===1){
    try{
      await telegramApi('sendPhoto',{chat_id,photo:list[0],caption:caption.slice(0,1024),parse_mode:'HTML'});
      return {sent:true};
    }catch{}
  }else{
    const media=list.map((u,i)=>({type:'photo',media:u,...(i===0&&caption?{caption:caption.slice(0,1024),parse_mode:'HTML'}:{})}));
    try{
      await telegramApi('sendMediaGroup',{chat_id,media});
      return {sent:true};
    }catch{}
  }
  const fd=new FormData();
  fd.append('chat_id',String(chat_id));
  const media=[];
  for(const [i,u] of list.entries()){
    try{
      const r=await fetch(u,{signal:AbortSignal.timeout(15000),headers:{'user-agent':'Mozilla/5.0'}});
      if(!r.ok)continue;
      const buf=Buffer.from(await r.arrayBuffer());
      if(!buf.length||buf.length>9e6)continue;
      const name=`p${i}.jpg`;
      fd.append(name,new Blob([buf],{type:r.headers.get('content-type')||'image/jpeg'}),name);
      media.push({type:'photo',media:`attach://${name}`,...(media.length===0&&caption?{caption:caption.slice(0,1024),parse_mode:'HTML'}:{})});
    }catch{}
  }
  if(!media.length)return {sent:false};
  fd.append('media',JSON.stringify(media));
  const base=String(process.env.TELEGRAM_API_BASE||'https://api.telegram.org').replace(/\/$/,'');
  const r=await fetch(`${base}/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMediaGroup`,{method:'POST',body:fd,signal:AbortSignal.timeout(60000)});
  const data=await r.json().catch(()=>({}));
  return {sent:!!data.ok,error:data.ok?null:data.description};
}

// Aviso con fotos: álbum con el texto + mensaje corto con los botones
// (Telegram no permite botones en un álbum).
async function telegramSendListing(text,x){
  if(!telegramConfigured())return {sent:false};
  const images=listingTelegramImages(x,4);
  let album={sent:false};
  // Telegram pliega los pies de foto largos: las fotos llevan solo el
  // titular y el aviso completo va justo después, entero y con los botones.
  const caption=text.split('\n').slice(0,4).join('\n').slice(0,1000);
  if(images.length){
    album=await telegramSendAlbum(images,caption).catch(()=>({sent:false}));
  }
  if(album.sent)await telegramSend(text,null,{buttons:alertButtons(x.id),noPreview:true});
  else await telegramSend(text,null,{buttons:alertButtons(x.id),previewUrl:x.url||null});
  return {sent:true};
}

function listingFeedback(listingId){
  return db.prepare('SELECT action FROM listing_feedback WHERE listing_id=?').get(Number(listingId))?.action||null;
}

// ── TELEGRAM: RECÁLCULO CON PRECIO NEGOCIADO ────────────────────────────
// Nil responde a un aviso (o manda una captura, o un enlace) con el precio
// que ha conseguido con el vendedor y el bot recalcula coste, beneficio y si
// ahora merece la pena, con la reventa que ya estimó para ese anuncio.
const TG_CURRENCY=[
  ['CNY',/¥|￥|元|rmb|cny|yuan|kuai/i],
  ['JPY',/円|jpy|yen/i],
  ['KRW',/₩|원|krw|won/i],
  ['EUR',/€|eur|euro/i],
  ['USD',/\$|usd|dólar|dolar/i]
];
function parseNegotiatedPrice(text){
  const t=String(text||'');
  const re=/(¥|￥|€|₩|\$)?\s*(\d{1,3}(?:[.,\s]\d{3})+|\d+(?:[.,]\d{1,2})?)\s*(k\b|mil\b)?\s*(€|euros?|eur|¥|￥|元|rmb|cny|yuan|円|jpy|yen|₩|원|won|krw|\$|usd)?/gi;
  const found=[];
  for(const m of t.matchAll(re)){
    let raw=m[2];
    if(/[.,\s]\d{3}$/.test(raw)&&!/[.,]\d{1,2}$/.test(raw.replace(/[.,\s]\d{3}$/,'')))raw=raw.replace(/[.,\s]/g,'');
    else raw=raw.replace(',','.');
    let n=Number(raw);
    if(!Number.isFinite(n)||n<=0)continue;
    if(m[3])n*=1000;
    const tag=`${m[1]||''}${m[4]||''}`;
    const cur=(TG_CURRENCY.find(([,r])=>r.test(tag))||[])[0]||null;
    found.push({amount:n,currency:cur});
  }
  return found.find(x=>x.currency)||found.sort((a,b)=>b.amount-a.amount)[0]||null;
}
function listingIdFromTelegramMessage(m){
  if(!m)return null;
  for(const row of m.reply_markup?.inline_keyboard||[])for(const b of row){
    const k=String(b.callback_data||'').match(/^(?:ok|no):(\d+)$/);if(k)return Number(k[1]);
  }
  const urls=[...(m.entities||[]),...(m.caption_entities||[])].map(e=>e.url).filter(Boolean);
  const text=`${m.text||''} ${m.caption||''} ${urls.join(' ')}`;
  const dec=decodeURIComponent(text.replace(/%(?![0-9a-f]{2})/gi,'%25'));
  const ids=[...dec.matchAll(/(?:[?&]id=|item\/|products\/|\/item\?id=)(\d{6,})/gi)].map(x=>x[1]);
  for(const id of ids){
    const row=db.prepare('SELECT id FROM listings WHERE source_id=? ORDER BY last_seen DESC LIMIT 1').get(id);
    if(row)return row.id;
  }
  return null;
}
async function telegramFileBase64(fileId){
  const f=await telegramApi('getFile',{file_id:fileId});
  const base=String(process.env.TELEGRAM_API_BASE||'https://api.telegram.org').replace(/\/$/,'');
  const r=await fetch(`${base}/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${f.result.file_path}`,{signal:AbortSignal.timeout(30000)});
  if(!r.ok)throw new Error(`descarga de la foto: ${r.status}`);
  return Buffer.from(await r.arrayBuffer()).toString('base64');
}
// Captura sin enlace: la IA barata lee la captura y la compara con los
// anuncios avisados recientemente. No se guarda la imagen.
async function identifyListingFromScreenshot(fileId){
  const cands=db.prepare(`SELECT DISTINCT l.id,l.source,l.title,l.original_price,l.currency,ta.model
    FROM notifications n JOIN listings l ON l.id=n.listing_id
    LEFT JOIN task_analyses ta ON ta.listing_id=l.id AND ta.task_id=n.task_id
    WHERE n.sent_at>=? ORDER BY n.sent_at DESC LIMIT 40`).all(new Date(Date.now()-21*86400e3).toISOString());
  const data=await telegramFileBase64(fileId);
  const prompt=`You receive a screenshot shared by a luxury handbag reseller. It shows either a marketplace listing (Xianyu/Goofish, Bunjang, Mercari, Yahoo! Auctions via One Map...) or a chat with the seller where a lower price was agreed.
Candidate listings previously sent to the reseller (JSON): ${JSON.stringify(cands)}
Return ONLY JSON: {"listing_id": <id of the candidate that is clearly the same listing, or null>, "agreed_price": <the negotiated/agreed price if visible, otherwise the listing price shown, number or null>, "currency": "CNY"|"JPY"|"KRW"|"EUR"|"USD"|null, "seen_title": "<short title read from the image>"}
Match only when title, product and price context clearly point to the same listing; otherwise listing_id null.`;
  const {data:out}=await geminiJsonRequest({key:aiApiKey(),model:aiTriageModel(),parts:[{text:prompt},{inline_data:{mime_type:'image/jpeg',data}}],purpose:'telegram'});
  return out||{};
}
function telegramMaxPriceFor(listing,resaleLow,minProfit,minMarginPct){
  let lo=0,hi=Math.max(1,resaleLow);
  const ok=p=>{const landed=importEconomics({...listing,price_eur:p}).importedTotalEur;const prof=resaleLow-landed;return prof>=minProfit&&prof/landed*100>=minMarginPct;};
  if(!ok(0))return null;
  for(let i=0;i<40;i++){const mid=(lo+hi)/2;if(ok(mid))lo=mid;else hi=mid;}
  return lo;
}
function fmtMoney(n,cur){
  if(!Number.isFinite(Number(n)))return '—';
  const sym={CNY:'¥',JPY:'¥',KRW:'₩',EUR:'€',USD:'$'}[cur]||cur;
  return `${Math.round(Number(n)).toLocaleString('es-ES')} ${sym}`;
}
// ── ANÁLISIS MANUAL POR TELEGRAM ─────────────────────────────────────────
// Nil pega el enlace de un anuncio (o el texto de compartir de Xianyu) con el
// precio de compra que ha pactado con el vendedor. Si el bot ya tiene una
// reventa estimada de ese anuncio, solo recalcula; si no, lee el anuncio,
// elige la tarea del modelo y hace el análisis completo con ese precio.
const MANUAL_SOURCES_TEXT='Xianyu, Bunjang, Mercari, Rakuma, Yahoo! Flea Market, 2nd STREET y KOMEHYO';

function telegramMessageUrls(m){
  if(!m)return [];
  const text=`${m.text||''}\n${m.caption||''}`;
  const fromEntities=[...(m.entities||[]),...(m.caption_entities||[])].map(e=>e.url).filter(Boolean);
  const fromText=text.match(/https?:\/\/[^\s<>"'，。、）)】」]+/gi)||[];
  return [...new Set([...fromEntities,...fromText].map(u=>String(u).replace(/[.,;:!?]+$/,'')))];
}
// El precio se busca sin enlaces ni el texto de compartir de Xianyu
// (「…」, 【…】, códigos como CZ3457), para no confundirlo con otros números.
function priceTextOnly(text){
  return String(text||'')
    .replace(/https?:\/\/\S+/gi,' ')
    .replace(/[「【《][^」】》]*[」】》]/g,' ')
    .replace(/\b[A-Z]{2,}\d{3,}\b/g,' ');
}

// Enlace → {source, sourceId}. Japón usa las mismas fichas que el radar.
function manualListingRef(href){
  let u;try{u=new URL(href);}catch{return null;}
  // Enlaces del puente del bot (app=…&web=…): se mira el enlace web de dentro.
  const inner=u.searchParams.get('web');
  if(inner&&inner!==href)return manualListingRef(inner);
  const host=u.hostname.toLowerCase().replace(/^www\./,'');
  const xianyuId=u.href.match(/[?&](?:id|itemId)=(\d{6,})/i)?.[1]||null;
  if(/(^|\.)goofish\.com$/.test(host)||host==='2.taobao.com'||(/(^|\.)taobao\.com$/.test(host)&&/idle|fleamarket|xianyu/i.test(u.href))){
    return xianyuId?{source:'xianyu',sourceId:xianyuId}:null;
  }
  if(/(^|\.)tb\.cn$/.test(host))return {source:'xianyu',shortUrl:u.href};
  if(/(^|\.)bunjang\.co\.kr$/.test(host)){
    const id=u.pathname.match(/\/products\/(\d+)/)?.[1];
    return id?{source:'bunjang',sourceId:id}:null;
  }
  // Mercari: se abre la ficha de jp.mercari.com (Buyee ya no se usa).
  const mercari=['mercari.com','jp.mercari.com'].includes(host)?u.pathname.match(/\/(?:item|jp\/items)\/(m\d+)/i)?.[1]:null;
  if(mercari)u=new URL(`https://jp.mercari.com/item/${mercari}`);
  const h=u.hostname.toLowerCase().replace(/^www\./,'');
  const spec=JAPAN_RADAR_SPECS.find(s=>{
    const b=new URL(s.base).hostname.replace(/^www\./,'');
    return (h===b||h.endsWith(`.${b}`))&&s.accepts(u);
  });
  return spec?{source:spec.id,spec,url:u.href,sourceId:String(japanSourceId(spec.id,u.href))}:null;
}

// m.tb.cn (compartir de Xianyu) redirige al anuncio, a veces por JavaScript.
async function resolveXianyuShortLink(href){
  const idIn=s=>String(s||'').replace(/&amp;/g,'&').match(/[?&](?:id|itemId)=(\d{6,})/)?.[1]||null;
  let url=href;
  for(let hop=0;hop<4;hop++){
    const r=await fetch(url,{
      redirect:'manual',
      headers:{'user-agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'},
      signal:AbortSignal.timeout(15000)
    });
    const loc=r.headers.get('location');
    if(loc){
      const next=new URL(loc,url).href;
      if(idIn(next))return idIn(next);
      url=next;
      continue;
    }
    const body=await r.text().catch(()=>'');
    let decoded=body;try{decoded=decodeURIComponent(body);}catch{}
    const target=[body,decoded].flatMap(s=>s.match(/https?:\/\/[^'"\s<>\\]+/g)||[])
      .find(x=>/goofish|idle|fleamarket|2\.taobao/i.test(x)&&idIn(x));
    return idIn(target);
  }
  return null;
}

async function importManualXianyu(sourceId){
  const existing=db.prepare('SELECT id FROM listings WHERE source=? AND source_id=?').get('xianyu',String(sourceId));
  if(existing?.id)return Number(existing.id);
  throw new Error('No consultaré la ficha de Xianyu. Primero deja que una búsqueda encuentre el anuncio; después podrás abrirlo desde el resultado guardado.');
}

async function importManualBunjang(sourceId){
  const d=await fetchBunjangDetail(sourceId);
  const p=Number(d?.price);
  if(!d?.name||!Number.isFinite(p)||p<=0)throw new Error('No he podido leer ese anuncio de Bunjang (puede que esté vendido o retirado).');
  const updatedMs=Date.parse(d.updatedAt||'');
  return upsertListing({
    source:'bunjang',source_id:String(sourceId),url:`https://m.bunjang.co.kr/products/${sourceId}`,title:d.name,description:d.description||'',
    original_price:p,currency:'KRW',price_eur:toEur(p,'KRW'),seller_name:null,
    seller_items:null,seller_sales:d.trust.salesCount,seller_reviews:d.trust.reviewCount,
    image_url:d.images[0]||'',status:String(d.saleStatus||'').toUpperCase()==='SELLING'?'':String(d.saleStatus||'').toLowerCase(),purchase_via:'Korea proxy',
    raw:{pid:String(sourceId),name:d.name,price:p,care:d.trust.care,images:d.images,
      koreaDetail:{name:d.name,images:d.images,saleStatus:d.saleStatus,condition:d.condition,updatedAt:d.updatedAt},
      luxuryHunterTrust:d.trust,publishedAt:Number.isFinite(updatedMs)?new Date(updatedMs).toISOString():null,addedBy:'telegram'}
  });
}

async function importManualJapan(ref){
  let browser=null;
  try{
    let ctx=null;
    if(ref.spec.mode==='browser'){
      const {chromium}=await import('playwright');
      browser=await chromium.launch({headless:true});
      ctx=await browser.newContext({locale:'ja-JP',userAgent:JAPAN_HTTP_HEADERS['user-agent']});
    }
    let x;
    try{x=await japanEnrichCandidate(ref.spec,{href:ref.url},{query:'telegram',searchUrl:null},ctx);}
    catch(e){throw new Error(`No he podido abrir el anuncio de ${ref.spec.label} (${e.message}).`);}
    if(!x?.title||!(Number(x.original_price)>0))throw new Error(`No he podido leer ese anuncio de ${ref.spec.label} (puede que esté vendido o retirado).`);
    return upsertListing({...x,raw:{...x.raw,addedBy:'telegram'}});
  }finally{
    await browser?.close().catch(()=>{});
  }
}

async function manualListingFromRef(ref){
  if(ref.shortUrl){
    const id=await resolveXianyuShortLink(ref.shortUrl).catch(()=>null);
    if(!id)throw new Error('No he podido abrir el enlace de compartir de Xianyu. Pégame el enlace del anuncio (goofish.com/item?id=…).');
    ref={source:'xianyu',sourceId:id};
  }
  let row=db.prepare('SELECT * FROM listings WHERE source=? AND source_id=?').get(ref.source,String(ref.sourceId));
  if(!row){
    const id=ref.source==='xianyu'?await importManualXianyu(ref.sourceId)
      :ref.source==='bunjang'?await importManualBunjang(ref.sourceId)
      :await importManualJapan(ref);
    row=id?db.prepare('SELECT * FROM listings WHERE id=?').get(id):null;
  }
  // Mercari y Rakuma: valoraciones del vendedor (se guardan 3 días).
  if(row&&JAPAN_SELLER_SOURCES.has(row.source)){
    try{await checkJapanSellers([row]);}catch{}
    row=db.prepare('SELECT * FROM listings WHERE id=?').get(row.id);
  }
  return row||null;
}

// Tarea (modelo) del anuncio: la de un análisis anterior o la que elija la IA barata.
async function manualTaskFor(listing){
  const prev=db.prepare('SELECT task_id FROM task_analyses WHERE listing_id=? ORDER BY updated_at DESC LIMIT 1').get(listing.id);
  if(prev)return Number(prev.task_id);
  const tasks=db.prepare('SELECT id,task_name,product_query,description FROM tasks WHERE enabled=1 ORDER BY id').all();
  if(!tasks.length)return null;
  const list=tasks.map(t=>({id:t.id,name:t.task_name,target:t.product_query,brief:String(t.description||'').replace(/\s+/g,' ').slice(0,260)}));
  const prompt=`A luxury handbag reseller sent one marketplace listing. Decide which ONE of the reseller's tasks (bag models) it belongs to, using the title, description and photo. Answer null if it is none of these models.
TASKS (JSON): ${JSON.stringify(list)}
LISTING (JSON): ${JSON.stringify({source:listing.source,title:listing.title,description:String(listing.description||'').slice(0,1200)})}
Return ONLY JSON: {"task_id": <task id or null>}`;
  const imageParts=await fetchGeminiImageParts(listing,1).catch(()=>[]);
  const {data}=await geminiJsonRequest({key:aiApiKey(),model:aiTriageModel(),parts:[{text:prompt},...imageParts],purpose:'telegram'});
  const id=Number(data?.task_id);
  return tasks.some(t=>Number(t.id)===id)?id:null;
}

// Último análisis con reventa estimada (de una tarea o suelto).
function negotiationAnalysisFor(listingId){
  return db.prepare('SELECT * FROM task_analyses WHERE listing_id=? ORDER BY (resale_low_eur IS NULL), updated_at DESC LIMIT 1').get(listingId)
    ||db.prepare('SELECT * FROM analyses WHERE listing_id=?').get(listingId)
    ||null;
}

// Comprobaciones de confianza del anuncio, en una línea cada una.
function manualTrustLines(listing){
  let raw={};try{raw=JSON.parse(listing.raw_json||'{}');}catch{}
  const lines=[];
  if(listing.source==='xianyu'){
    lines.push(hasXianyuVerificationTag(raw?.['商品信息']?.['商品标签'])
      ?'✅ Admite verificación 验货宝.'
      :'⚠️ No aparece la etiqueta 验货宝 en el anuncio.');
  }
  if(listing.source==='bunjang'){
    const t=raw.luxuryHunterTrust;
    if(t?.care===true)lines.push('✅ Tiene 번개케어 (Care).');
    else if(t)lines.push(`${bunjangTrustVeto(listing)?'⚠️':'✅'} Vendedor: nota ${t.rating??'—'} · ${t.reviewCount??0} reseñas · sin Care.`);
  }
  if(JAPAN_SELLER_SOURCES.has(listing.source)){
    const s=raw.luxuryHunterSeller;
    if(s)lines.push(`${japanSellerVeto(s)?'⚠️':'✅'} Vendedor: ${s.positivePct??'—'} % positivas · ${s.total} valoraciones.`);
  }
  if(/^sold/i.test(String(listing.status||'')))lines.push('⚠️ El anuncio aparece como vendido.');
  return lines;
}

// Respuesta con el precio pactado. null si aún no hay reventa estimada.
function negotiationReplyText({listing,price,fresh=false}){
  const cur=price.currency||listing.currency||'EUR';
  const newEur=toEur(price.amount,cur);
  const a=negotiationAnalysisFor(listing.id);
  const low=Number(a?.resale_low_eur), high=Number(a?.resale_high_eur);
  if(!a||!Number.isFinite(low)||!Number.isFinite(newEur))return null;
  const task=a.task_id?taskPublic(db.prepare('SELECT * FROM tasks WHERE id=?').get(Number(a.task_id))):null;
  const before=importEconomics(listing);
  const after=importEconomics({...listing,price_eur:newEur});
  const landed=after.importedTotalEur;
  const pLow=low-landed, pHigh=Number.isFinite(high)?high-landed:null;
  const margin=landed>0?pLow/landed*100:0;
  const strongProfit=Number(task?.notify_min_profit_eur)||250;
  const strongMargin=Number(process.env.INSTANT_ALERT_MIN_MARGIN_PCT??30);
  const softProfit=Math.max(150,Math.round(strongProfit*0.6)), softMargin=Number(process.env.SOFT_ALERT_MIN_MARGIN_PCT||20);
  const risky=String(a.authenticity_risk||'').toUpperCase()==='HIGH';
  const bagComps=isWatchTask(task?.task_name)?null:vestiaireCompsFor(task?.task_name,{...listing,model:a.model,verification_json:a.verification_json});
  const pendingBagPrice=!isWatchTask(task?.task_name)&&(!vestiaireSheetFresh()||bagComps?.buy_eligible!==true);
  const verdict=risky?'⚠️ Riesgo de autenticidad alto: aunque salgan los números, no lo compraría sin verificación.'
    :pendingBagPrice?'👀 <b>Consultar precio.</b> Sin coincidencia válida y confirmada en Sheets; este margen es orientativo.'
    : pLow>=strongProfit&&margin>=strongMargin?`🔥 <b>${fresh?'Es':'Ahora sí es'} una oportunidad clara.</b>`
    : pLow>=softProfit&&margin>=softMargin?'👀 <b>Interesante, revísalo.</b>'
    : `❌ <b>${fresh?'No compensa':'Sigue sin compensar'}</b> con este precio.`;
  const maxEur=pendingBagPrice?null:telegramMaxPriceFor(listing,low,strongProfit,strongMargin);
  const maxLocal=maxEur!=null?eurTo(maxEur,listing.currency||'EUR'):null;
  let reasons=[];try{reasons=JSON.parse(a.decision_reasons_es_json||'[]');}catch{}
  let verification={};try{verification=JSON.parse(a.verification_json||'{}');}catch{}
  const verificationLine={
    verified:'Verificación de modelo y mercado: hecha.',
    skipped_cost:'Sin verificación de mercado (puntuación baja).',
    error:'⚠️ La verificación de modelo y mercado ha fallado.'
  }[verification.status]||'';
  const lines=fresh?[
    `🧾 <b>Analizado con tu precio pactado</b>${task?` · ${htmlEsc(task.task_name)}`:' · no encaja en ninguna tarea'}`,
    `<b>${htmlEsc(a.model||listing.title||'')}</b>`,
    `Decisión del bot: <b>${htmlEsc(a.decision||'—')}</b>${a.opportunity_score!=null?` · ${Math.round(a.opportunity_score)}/100`:''}`,
    `Precio pactado: <b>${fmtMoney(price.amount,cur)}</b> (≈ ${eur0(newEur)}) · anunciado ${fmtMoney(listing.original_price,listing.currency||'EUR')} (≈ ${eur0(listing.price_eur)})`,
    'Coste puesto en España:',
    ...importCostLines({...listing,price_eur:newEur}),
    `Reventa estimada: ${eur0(low)} – ${eur0(high)}`,
    `Beneficio neto: <b>${eur0(pLow)}${pHigh!=null?` – ${eur0(pHigh)}`:''}</b> · margen ${Math.round(margin)} %`,
    vestiaireProfitLine(low,high,landed,task?.task_name),
    verdict,
    ...manualTrustLines(listing),
    verificationLine,
    ...reasons.slice(0,3).map(r=>`• ${htmlEsc(r)}`),
    maxLocal!=null?`Precio máximo para que sea oportunidad clara: <b>${fmtMoney(maxLocal,listing.currency||'EUR')}</b> (≈ ${eur0(maxEur)})`:'',
    ...vestiaireDbLines(task?.task_name,{...listing,price_eur:newEur,model:a.model,verification_json:a.verification_json}),
    listing.url?`<a href="${htmlEsc(listingAppLink(listing))}">📱 Abrir en la app</a>`:''
  ]:[
    `♻️ <b>Recalculado con el precio negociado</b>${task?` · ${htmlEsc(task.task_name)}`:''}`,
    `<b>${htmlEsc(a.model||listing.title||'')}</b>`,
    `Precio: <b>${fmtMoney(price.amount,cur)}</b> (≈ ${eur0(newEur)}) · antes ${fmtMoney(listing.original_price,listing.currency||'EUR')} (≈ ${eur0(listing.price_eur)})`,
    `Coste puesto en España: ${eur0(landed)} (antes ${eur0(before.importedTotalEur)})`,
    `Reventa estimada: ${eur0(low)} – ${eur0(high)}`,
    `Beneficio neto: <b>${eur0(pLow)}${pHigh!=null?` – ${eur0(pHigh)}`:''}</b> · margen ${Math.round(margin)} % (antes ${eur0(low-before.importedTotalEur)})`,
    vestiaireProfitLine(low,high,landed,task?.task_name),
    verdict,
    maxLocal!=null?`Precio máximo para que sea oportunidad clara: <b>${fmtMoney(maxLocal,listing.currency||'EUR')}</b> (≈ ${eur0(maxEur)})`:'',
    ...vestiaireDbLines(task?.task_name,{...listing,price_eur:newEur,model:a.model,verification_json:a.verification_json}),
    listing.url?`<a href="${htmlEsc(listingAppLink(listing))}">📱 Abrir en la app</a>`:''
  ];
  return lines.filter(Boolean).join('\n');
}

// Cola de análisis manuales: uno detrás de otro y guardados en la base de
// datos, para retomarlos si la ejecución de la nube termina a medias.
let manualQueue=Promise.resolve();
function manualJobs(){
  const jobs=getSetting('telegram_manual_jobs',[]);
  return Array.isArray(jobs)?jobs:[];
}
function saveManualJobs(jobs){
  db.prepare(`INSERT INTO app_settings(key,value_json,updated_at) VALUES('telegram_manual_jobs',?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`).run(JSON.stringify(jobs),new Date().toISOString());
}
function runQueuedManualAnalysis(job){
  const run=manualQueue.then(()=>runManualAnalysis(job));
  manualQueue=run.catch(()=>{});
  return run;
}
function resumeManualAnalyses(){
  const pending=manualJobs().filter(j=>Date.now()-Date.parse(j.createdAt)<12*3600e3);
  saveManualJobs(pending);
  for(const job of pending)runQueuedManualAnalysis(job);
  if(pending.length)console.log(`Telegram: ${pending.length} análisis manual(es) pendiente(s) retomado(s).`);
}
async function runManualAnalysis(job){
  const reply=text=>telegramApi('sendMessage',{chat_id:job.chatId,text,parse_mode:'HTML',reply_to_message_id:job.messageId,allow_sending_without_reply:true,disable_web_page_preview:true}).catch(e=>console.error('Telegram reply failed:',e.message));
  try{
    let listing=db.prepare('SELECT * FROM listings WHERE source=? AND source_id=?').get(job.source,String(job.sourceId));
    if(!listing&&job.url){
      const ref=manualListingRef(job.url);
      if(ref)listing=await manualListingFromRef(ref);
    }
    if(!listing)return await reply('No he podido recuperar el anuncio. Vuelve a enviarme el enlace con el precio.');
    const priceEur=toEur(job.price.amount,job.price.currency||listing.currency||'EUR');
    await manualAiStore.run(true,async()=>{
      const taskId=await manualTaskFor(listing);
      await analyzeWithGemini(listing.id,taskId,true,null,{priceEur});
    });
    const fresh=db.prepare('SELECT * FROM listings WHERE id=?').get(listing.id);
    const text=negotiationReplyText({listing:fresh,price:job.price,fresh:true});
    if(text)return await reply(text);
    const a=negotiationAnalysisFor(listing.id);
    let reasons=[];try{reasons=JSON.parse(a?.decision_reasons_es_json||'[]');}catch{}
    await reply([
      `🧾 <b>Analizado con tu precio pactado</b>`,
      `<b>${htmlEsc(a?.model||listing.title||'')}</b>`,
      `Decisión del bot: <b>${htmlEsc(a?.decision||'—')}</b> · no he podido estimar la reventa.`,
      ...manualTrustLines(fresh),
      ...reasons.slice(0,3).map(r=>`• ${htmlEsc(r)}`)
    ].filter(Boolean).join('\n'));
  }catch(e){
    console.error('Telegram manual analysis failed:',e.message);
    // Nunca se reenvía un mensaje de error que pueda llevar trozos de la clave.
    const why=/api[ _-]?key|401|unauthori[sz]ed/i.test(String(e?.message||''))
      ?'la clave de la IA no es válida en este equipo.'
      :String(e?.message||e).slice(0,300);
    await reply(`No he podido analizar el anuncio: ${htmlEsc(why)}`);
  }finally{
    saveManualJobs(manualJobs().filter(j=>j.key!==job.key));
  }
}

async function handleTelegramNegotiation(msg){
  const chat_id=msg.chat.id;
  const reply=(text)=>telegramApi('sendMessage',{chat_id,text,parse_mode:'HTML',reply_to_message_id:msg.message_id,disable_web_page_preview:true}).catch(e=>console.error('Telegram reply failed:',e.message));
  const text=`${msg.text||''} ${msg.caption||''}`.trim();
  const priceText=priceTextOnly(text);
  const urls=[...telegramMessageUrls(msg),...telegramMessageUrls(msg.reply_to_message)];
  if(/^\/(start|help|ayuda)/i.test(text)||(!msg.photo&&!msg.reply_to_message&&!urls.length&&!parseNegotiatedPrice(priceText)&&!listingIdFromTelegramMessage(msg))){
    return reply(`Mándame el enlace de un anuncio con el precio que has pactado con el vendedor, por ejemplo:\n<code>https://www.goofish.com/item?id=… 3200¥</code>\nLo analizo con ese precio: modelo, autenticidad, reventa y beneficio. Funciona con ${MANUAL_SOURCES_TEXT}.\n\nTambién puedes responder a un aviso mío con el precio, o mandarme una captura del anuncio o del chat con el vendedor.`);
  }
  let listingId=listingIdFromTelegramMessage(msg.reply_to_message)||listingIdFromTelegramMessage(msg);
  let price=parseNegotiatedPrice(priceText);
  // Enlace de un anuncio que el bot no tiene: se lee de la web.
  if(!listingId&&urls.length){
    const ref=urls.map(manualListingRef).find(Boolean);
    if(!ref&&!msg.photo)return reply(`Todavía no sé leer anuncios de esa web. Funciona con ${MANUAL_SOURCES_TEXT}.`);
    if(ref){
      try{listingId=(await manualListingFromRef(ref))?.id||null;}
      catch(e){return reply(`No he podido leer el anuncio: ${htmlEsc(e.message)}`);}
    }
  }
  const photo=(msg.photo||[]).slice(-1)[0];
  if((!listingId||!price)&&photo){
    try{
      const ai=await identifyListingFromScreenshot(photo.file_id);
      if(!listingId&&Number(ai.listing_id))listingId=Number(ai.listing_id);
      if(!price&&Number(ai.agreed_price)>0)price={amount:Number(ai.agreed_price),currency:ai.currency||null};
    }catch(e){
      return reply(`No he podido leer la captura (${htmlEsc(e.message)}). Responde al aviso del anuncio con el precio, por ejemplo <b>3200¥</b>.`);
    }
  }
  if(!listingId)return reply('No sé de qué anuncio se trata. Pégame el enlace del anuncio con el precio pactado, o responde directamente al aviso que te envié (mantén pulsado → Responder).');
  const listing=db.prepare('SELECT * FROM listings WHERE id=?').get(listingId);
  if(!listing)return reply('No encuentro ese anuncio en la base de datos del bot.');
  if(!price)return reply(`Es el anuncio <b>${htmlEsc(String(listing.title||'').slice(0,80))}</b>. ¿A qué precio lo has pactado? Respóndeme a este mensaje con el número y la moneda, por ejemplo <b>3200¥</b> o <b>450€</b>.${listing.url?`\n<a href="${htmlEsc(listing.url)}">Ver anuncio</a>`:''}`);
  // «¥» vale para yuanes y para yenes: en un anuncio de Japón son yenes.
  if(price.currency==='CNY'&&listing.currency==='JPY'&&!/元|rmb|cny|yuan|kuai/i.test(priceText))price={...price,currency:'JPY'};
  const cur=price.currency||listing.currency||'EUR';
  const newEur=toEur(price.amount,cur);
  if(!Number.isFinite(newEur))return reply(`No tengo el cambio de ${cur} a euros ahora mismo.`);
  // Ya tiene reventa estimada: solo se recalcula con el precio (sin gastar IA).
  if(negotiationReplyText({listing,price})){
    await reply(negotiationReplyText({listing,price}));
    return true;
  }
  // Sin reventa estimada: análisis completo con el precio pactado.
  if(!aiConfigured())return reply('La IA no está configurada, así que no puedo analizar el anuncio.');
  await reply(`⏳ Analizando <b>${htmlEsc(String(listing.title||'').slice(0,80))}</b> con ${fmtMoney(price.amount,cur)} (≈ ${eur0(newEur)}). Tardo uno o dos minutos.`);
  const job={key:`${chat_id}:${msg.message_id}`,chatId:chat_id,messageId:msg.message_id,source:listing.source,sourceId:String(listing.source_id),url:listing.url,price,createdAt:new Date().toISOString()};
  saveManualJobs([...manualJobs().filter(j=>j.key!==job.key),job]);
  runQueuedManualAnalysis(job);
  return true;
}

let telegramPolling=false;
async function pollTelegramUpdates(){
  if(!telegramConfigured()||telegramPolling)return {processed:0};
  telegramPolling=true;
  let processed=0;
  try{
    const offset=Number(getSetting('telegram_update_offset',0))||0;
    const data=await telegramApi('getUpdates',{offset,timeout:0,allowed_updates:['callback_query','message']});
    let next=offset;
    for(const u of data.result||[]){
      next=Math.max(next,Number(u.update_id)+1);
      if(u.message&&String(u.message.chat?.id)===String(process.env.TELEGRAM_CHAT_ID)){
        try{await handleTelegramNegotiation(u.message);processed++;}
        catch(e){console.error('Telegram negotiation failed:',e.message);}
        continue;
      }
      const cq=u.callback_query;
      if(!cq)continue;
      // Solo el chat de Nil puede valorar anuncios.
      if(String(cq.message?.chat?.id||cq.from?.id)!==String(process.env.TELEGRAM_CHAT_ID))continue;
      const m=String(cq.data||'').match(/^(ok|no):(\d+)$/);
      if(!m){await telegramApi('answerCallbackQuery',{callback_query_id:cq.id}).catch(()=>{});continue;}
      const action=m[1]==='ok'?'interested':'not_interested';
      db.prepare(`INSERT INTO listing_feedback(listing_id,action,source,created_at) VALUES(?,?,?,?)
        ON CONFLICT(listing_id) DO UPDATE SET action=excluded.action,created_at=excluded.created_at`)
        .run(Number(m[2]),action,'telegram',new Date().toISOString());
      processed++;
      await telegramApi('answerCallbackQuery',{
        callback_query_id:cq.id,
        text:action==='interested'?'Apuntado: te interesa.':'Descartado: no volverá a avisarte.'
      }).catch(()=>{});
      await telegramApi('editMessageReplyMarkup',{
        chat_id:cq.message.chat.id,
        message_id:cq.message.message_id,
        reply_markup:{inline_keyboard:[[{text:action==='interested'?'✅ Te interesa':'❌ Descartado',callback_data:'noop'}]]}
      }).catch(()=>{});
    }
    if(next!==offset){
      db.prepare(`INSERT INTO app_settings(key,value_json,updated_at) VALUES('telegram_update_offset',?,?)
        ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
        .run(JSON.stringify(next),new Date().toISOString());
    }
  }catch(e){
    console.error('Telegram updates failed:',e.message);
  }finally{
    telegramPolling=false;
  }
  return {processed};
}

function eur0(n){
  return n==null||!Number.isFinite(Number(n))?'—':`${Math.round(Number(n))} €`;
}

// Desglose del coste puesto en España, partida a partida (solo las que suman).
function importCostLines(x){
  const c=importEconomics(x);
  const vatShown=c.importVatMode==='deductible'?0:c.importVatEur;
  const rows=[
    ['Producto',c.productPriceEur],
    ['Envío en origen',c.domesticShippingEur],
    [`${c.source==='vestiaire'?'Gastos de servicio de Vestiaire':'Comisión agente'}${c.agentFeePercent?` ${c.agentFeePercent} %`:''}`,c.agentFeeEur],
    [`Pago Alipay ${c.paymentFeePercent} %`,c.paymentFeeEur],
    [c.source==='vestiaire'?'Envío y autenticación de Vestiaire':'Envío internacional',c.internationalShippingEur],
    [`Arancel${c.customsDutyPercent?` ${c.customsDutyPercent} %`:''}${c.lowValueDutyApplied?' (valor bajo)':''}`,c.customsDutyEur],
    [`IVA importación ${c.vatPercent} %${c.importVatMode==='deductible'?' (deducible)':''}`,vatShown],
    ['Despacho aduanero',c.clearanceFeeEur],
    [`Verificación 验货宝${c.verificationFeeCny?` (${c.verificationFeeCny} CNY)`:''}`,c.verificationFeeEur],
    ['Autenticación',c.authenticationFeeEur],
    ['Otros',c.otherEur]
  ].filter(([,v])=>Number(v)>0);
  return rows.map(([k,v])=>`   · ${k}: ${eur0(v)}`).concat([`   = Coste puesto: <b>${eur0(c.importedTotalEur)}</b>`]);
}

// Relojes: se venden en Chrono24 como particular (CHRONO24_COMMISSION_PCT,
// 6,5 % por defecto); los bolsos en Vestiaire (VESTIAIRE_COMMISSION_PCT, 20 %).
// Igual que scripts/github-run-schedule.mjs (WATCH_TASK_RE).
const WATCH_TASK_RE=/speedmaster|seamaster|rolex|tudor|grand seiko|\bseiko\b|cartier (santos|tank|ballon|panth)|\biwc\b|jaeger|breitling|patek|audemars|panerai|tag heuer|\bheuer\b|\breloj|\bwatch/i;
function isWatchTask(name){return WATCH_TASK_RE.test(String(name||''));}
function resalePlatform(taskName){
  return isWatchTask(taskName)
    ?{name:'Chrono24',fee:Number(process.env.CHRONO24_COMMISSION_PCT??6.5)}
    :{name:'Vestiaire',fee:Number(process.env.VESTIAIRE_COMMISSION_PCT??20)};
}
// Beneficio si se revende: la reventa menos la comisión de la plataforma y
// menos el coste puesto.
function vestiaireProfitLine(resaleLow,resaleHigh,landed,taskName=''){
  const platform=resalePlatform(taskName);
  const fee=platform.fee;
  const num=v=>v===null||v===undefined||v===''?NaN:Number(v);
  const net=r=>Number.isFinite(num(r))&&Number.isFinite(num(landed))?num(r)*(1-fee/100)-num(landed):null;
  const lo=net(resaleLow), hi=net(resaleHigh);
  if(lo==null&&hi==null)return '';
  return `Beneficio en ${platform.name} (−${fee} % comisión): <b>${eur0(lo)}${hi!=null?` – ${eur0(hi)}`:''}</b>`;
}
// ── BASE DE VESTIAIRE EN LOS AVISOS ─────────────────────────────────────
// El aviso enseña los mismos anuncios de la base de Nil con los que se ha
// calculado la reventa (vestiaireComparables): iguales, misma talla o, como
// referencia, el mismo modelo en otras tallas. Si no hay ninguno parecido, lo
// dice: la reventa es entonces un pronóstico.
function vestiaireCompsFor(taskName,item){
  let v={};try{v=JSON.parse(item?.verification_json||'{}')||{};}catch{}
  // Análisis nuevo: las referencias que eligió la IA, tal cual se guardaron.
  if(v?.market?.match_version)return v.market.sheet_comps||null;
  if(isWatchTask(taskName)&&v?.market&&'sheet_comps' in v.market)return v.market.sheet_comps;
  try{return vestiaireComparables({task_name:taskName},item,v?.exact&&v.exact.target_match!==false?v.exact:{brand:item?.brand,family:item?.model});}
  catch{return null;}
}
const VESTIAIRE_LIVE_WHY={mac_offline:'el Chrome del Mac no estaba encendido',no_mac:'el puente del Mac no está configurado',
  blocked:'Vestiaire pidió una verificación y la búsqueda está en pausa',daily_limit:'ya se hicieron las búsquedas de hoy',
  no_query:'no se identificó el modelo',no_match:'Vestiaire no tiene 3 anuncios del mismo modelo y material',
  disabled:'está desactivada',error:'falló la búsqueda'};
// ── CON QUÉ SE COMPARA: TU BASE Y VESTIAIRE, POR SEPARADO ───────────────
// Regla de Nil: en cada aviso, el precio de la base y el de Vestiaire en
// directo van en bloques distintos, con fecha de publicación, likes y si se
// vendió. Las vendidas, las recientes y las de más likes pesan más.
function refAgeText(f){
  const d=refAgeDays(f);
  if(d==null)return '';
  const n=Math.floor(d);
  return n<1?'publicado hoy':n===1?'publicado ayer':n<60?`publicado hace ${n} días`:n<730?`publicado hace ${Math.round(n/30)} meses`:`publicado hace ${Math.round(n/365)} años`;
}
function refPickLine(f,{material=true}={}){
  const desc=htmlEsc([f.size,f.dims?`${f.dims} cm`:'',material?f.material:'',f.color,f.condition].filter(Boolean).join(' · ')||f.title||'Anuncio');
  const sold=Number.isFinite(Number(f.sold_price_eur))&&Number(f.sold_price_eur)>0?Number(f.sold_price_eur):Number(f.price_eur);
  const bits=[f.sold?`✅ vendido a ${eur0(sold)}`:f.removed?`retirado sin precio de venta (pedía ${eur0(f.price_eur)})`:`en venta a ${eur0(f.price_eur)}`,refAgeText(f),Number(f.likes)>0?`${f.likes} ❤️`:''].filter(Boolean);
  // Chrono24 borra los anuncios vendidos: el enlace ya no abre el reloj.
  const gone=(f.sold||f.removed)&&/chrono24\./i.test(String(f.url||''))?' · el enlace ya no abre el reloj (Chrono24 borra los vendidos)':'';
  return `   · <a href="${htmlEsc(f.url)}">${desc}</a> · ${bits.join(' · ')}${gone}`;
}
function refSummaryLines(c,askPct){
  const recent=Number.isFinite(Number(c.recent_n))?`${c.recent_n} publicadas en los últimos 30 días`:'';
  return [
    `Precio: <b>${eur0(c.low)} – ${eur0(c.high)}</b>${Number.isFinite(Number(c.mean))?` · media ${eur0(c.mean)}`:Number.isFinite(Number(c.mid))?` · mediana ${eur0(c.mid)}`:''}`,
    `${c.n} referencias: ${Number(c.sold_n)||0} vendidas${recent?` · ${recent}`:''}${Number(c.likes_max)>0?` · hasta ${c.likes_max} ❤️`:''}`,
    `Pesan más las vendidas, las recientes y las de más likes${askPct?`; las que siguen en venta cuentan al ${askPct} % de lo que piden`:''}.`
  ];
}
function vestiaireCompareSections(taskName,item){
  const c=vestiaireCompsFor(taskName,item);
  let v={};try{v=JSON.parse(item?.verification_json||'{}')||{};}catch{}
  const live=v.market?.vestiaire_live||null, blend=v.market?.vestiaire_blend||null;
  const watch=isWatchTask(taskName);
  const base=[];
  if(c){
    const mdl=c.model?` · modelo ${htmlEsc(c.model)}${c.materialClass?` en ${htmlEsc(c.materialClass)}`:''}`:'';
    base.push(c.tier==='ia_iguales'
      ? `Iguales al anuncio (mismo modelo, talla y material), comprobadas una a una con foto${c.tab?` · pestaña ${htmlEsc(c.tab)}`:''}`
      : c.tier==='iguales'
      ? `Iguales al anuncio (${htmlEsc(c.basis)}, ${htmlEsc(c.colour)}, ${htmlEsc(c.material)})${mdl}`
      : c.tier==='misma_talla'
        ? `De la misma talla (${htmlEsc(c.basis)})${mdl}`
        : `No hay de esta talla: mismo modelo en otras tallas${mdl}, solo orientativo`);
    if(c.cross&&c.tier!=='ia_iguales')base.push(`Pestaña ${htmlEsc(c.tab)}`);
    const askPct=c.price_basis==='sold'?null:Math.round((c.ratio||VESTIAIRE_DEFAULT_REALIZATION)*100);
    base.push(...refSummaryLines(c,askPct),...(c.picks||[]).slice(0,4).map(f=>refPickLine(f)));
  }else base.push(v.market?.match_version?'Ninguna referencia de tu base es el mismo bolso (mismo modelo, talla y material): no se usa.':'Tu base no tiene este modelo (mismo modelo, medidas, material y color).');
  const liveLines=[];
  if(watch&&!v.market?.match_version)liveLines.push('No se consultó en relojes.');
  else if(live?.status==='ok'){
    liveLines.push(`${live.n} anuncios de ${htmlEsc(live.model||'este modelo')}${live.material?` en ${htmlEsc(live.material)}`:''} (${htmlEsc(live.basis)})`);
    liveLines.push(...refSummaryLines(live,live.active_n?Math.round(VESTIAIRE_LIVE_REALIZATION*100):null),...(live.picks||[]).slice(0,4).map(f=>refPickLine(f,{material:false})));
    if(live.tier!=='misma_talla')liveLines.push('De otras tallas: solo orientativo.');
  }else if(live?.status==='no_match'&&v.market?.match_version)liveLines.push('Ninguno de los anuncios de Vestiaire es el mismo bolso (comprobado con fotos): no se usa.');
  else if(live)liveLines.push(`Sin datos: ${htmlEsc(VESTIAIRE_LIVE_WHY[live.status]||live.status)}${live.error?` (${htmlEsc(String(live.error).slice(0,120))})`:''}.`);
  else liveLines.push('No se consultó para este anuncio.');
  let used='';
  if(v.market?.match_version){
    used=c&&blend?`⚖️ El precio realista junta las dos: tu base (pesa el doble) + ${blend.n_live} de Vestiaire → <b>${eur0(blend.realistic??blend.mean)}</b>`
      :c?'⚖️ El precio realista sale de tu base (Vestiaire no tiene iguales).'
      :live?.status==='ok'?'⚖️ El precio realista sale de Vestiaire en directo (tu base no tiene iguales).'
      :'⚠️ Sin referencias iguales: no hay precio.';
    return {base,live:liveLines,used};
  }
  if(c&&blend)used=`⚖️ Para los números se juntan las dos: tu base (pesa el doble) + ${blend.n_live} de Vestiaire de la misma talla que no estaban en tu base → <b>${eur0(blend.low)} – ${eur0(blend.high)}</b>`;
  else if(c)used=`⚖️ Para los números se usa tu base${live?.status==='ok'?(live.tier==='misma_talla'?' (los de Vestiaire ya estaban en ella)':' (Vestiaire es de otras tallas)'):''}.`;
  else if(live?.status==='ok')used='⚖️ Para los números se usa Vestiaire en directo. Sin referencia en tu base no se recomienda comprar: revísalo tú.';
  else used='⚠️ Sin referencias: la reventa es una estimación sin verificar; no es compra recomendada.';
  return {base,live:liveLines,used};
}
function vestiaireDbLines(taskName,item){
  const c=vestiaireCompareSections(taskName,item);
  return ['','<b>📚 TU BASE DE DATOS</b>',...c.base,'','<b>🌐 VESTIAIRE EN DIRECTO</b>',...c.live,'',c.used];
}

// ── TEXTO DEL AVISO (Telegram y correo) ─────────────────────────────────
// Ordenado por bloques con título y sin nada plegado: qué es, los números,
// el desglose del coste, con qué se ha comparado, vendedor/autenticidad y
// por qué se avisa.
const ALERT_DECISION_ES={'STRONG BUY':'COMPRA MUY RECOMENDADA','BUY':'COMPRA RECOMENDADA','WATCH':'VIGILAR','REVIEW':'REVISAR','REJECT':'DESCARTADO'};
const RISK_ES={LOW:'bajo',MEDIUM:'medio',HIGH:'alto'};
// Lo que identifica la revisión de fotos llega en inglés: palabras habituales en español.
const ALERT_WORDS_ES=[[/lambskin/gi,'piel de cordero'],[/calfskin/gi,'piel de becerro'],[/caviar leather/gi,'piel caviar'],[/patent leather|patent/gi,'charol'],
  [/leather/gi,'piel'],[/suede/gi,'ante'],[/canvas/gi,'lona'],[/nylon/gi,'nailon'],[/satin/gi,'satén'],[/velvet/gi,'terciopelo'],
  [/black/gi,'negro'],[/white/gi,'blanco'],[/beige/gi,'beige'],[/brown/gi,'marrón'],[/grey|gray/gi,'gris'],[/red/gi,'rojo'],[/pink/gi,'rosa'],
  [/blue/gi,'azul'],[/green/gi,'verde'],[/burgundy/gi,'burdeos'],[/gold/gi,'dorado'],[/silver/gi,'plateado']];
const alertEs=t=>ALERT_WORDS_ES.reduce((a,[re,w])=>a.replace(re,w),String(t||''));
function alertSection(title,lines){
  const list=(lines||[]).filter(Boolean);
  return list.length?['',`<b>${title}</b>`,...list]:[];
}
function alertAgo(ms){
  if(!Number.isFinite(ms))return '';
  const h=(Date.now()-ms)/3600e3;
  if(h<0)return '';
  return h<1?`hace ${Math.max(1,Math.round(h*60))} min`:h<48?`hace ${Math.round(h)} h`:`hace ${Math.round(h/24)} días`;
}
function alertResaleSource(x,v){
  if(vestiaireCompsFor(x._task_name,x))return v?.market?.vestiaire_blend?'según tu base + Vestiaire en directo (ver abajo cada uno)':'según tu base de Vestiaire';
  if(v?.market?.vestiaire_live?.status==='ok')return 'según Vestiaire en directo (no está en tu base)';
  const src=String(v?.final?.resale_estimate_source||'').toUpperCase();
  if(src==='MARKET_ANALYSIS')return 'según anuncios de otras webs de reventa';
  return '🔮 estimación sin verificar';
}
// OFERTA AL VENDEDOR DE XIANYU (regla de Nil, 07-11-2026): el aviso trae el
// mensaje en chino listo para copiar. Precio máximo = el que todavía deja el
// beneficio mínimo de la tarea y el margen mínimo con el precio de venta
// realista; se abre por debajo (≈15 % menos que lo pedido, como es habitual
// en Xianyu) y Nil sigue la negociación. No se envía nada solo.
function sellerOfferPlan(x,v){
  if(String(x?.source||'')!=='xianyu')return null;
  const sale=Number(v?.final?.resale_mean_eur);
  const ask=Number(x.price_eur), askCny=Number(x.original_price);
  if(!(sale>0)||!(ask>0)||!(askCny>0))return null;
  const rate=askCny/ask;
  const fee=resalePlatform(x._task_name).fee/100;
  const minProfit=Number(x.notify_min_profit_eur)||200, minMargin=Number(process.env.MIN_CLEAN_MARGIN_PCT||20);
  const at=p=>{const landed=Number(importEconomics({...x,price_eur:p}).importedTotalEur)||0;const clean=sale*(1-fee)-landed;return {clean,landed,ok:clean>=minProfit&&clean>=landed*minMargin/100};};
  let lo=0,hi=ask;
  if(!at(lo+1).ok)return null;
  if(at(hi).ok)lo=hi;else for(let i=0;i<30;i++){const mid=(lo+hi)/2;if(at(mid).ok)lo=mid;else hi=mid;}
  const down50=c=>Math.max(50,Math.floor(c/50)*50);
  const maxCny=down50(Math.min(askCny,lo*rate));
  const openCny=down50(Math.min(askCny*0.85,maxCny*0.92));
  const model=String(x.model||x._task_name||'').replace(/[<>]/g,'').slice(0,40);
  const flaws=String(v?.final?.flaws_zh||'').trim();
  const msg=`您好，诚心想要这只${model}。${flaws?`看图片${flaws}，`:''}${openCny}元可以吗？走验货宝，同意的话我马上拍下付款，不来回砍价。谢谢！`;
  return {openCny,openEur:Math.round(openCny/rate),maxCny,maxEur:Math.round(maxCny/rate),profitOpen:Math.round(at(openCny/rate).clean),profitMax:Math.round(at(maxCny/rate).clean),msg,minProfit};
}
function sellerOfferLines(x,v){
  const o=sellerOfferPlan(x,v);
  if(!o)return [];
  return [
    `Ofrece <b>¥${o.openCny}</b> (≈ ${eur0(o.openEur)}) → beneficio limpio ${eur0(o.profitOpen)}`,
    `Tu máximo: <b>¥${o.maxCny}</b> (≈ ${eur0(o.maxEur)}) → beneficio limpio ${eur0(o.profitMax)} (mínimo ${eur0(o.minProfit)})`,
    'Mensaje para el vendedor (toca para copiar):',
    `<code>${htmlEsc(o.msg)}</code>`
  ];
}
function instantAlertText(x,{soft=false}={}){
  const cmp=vestiaireCompareSections(x._task_name,x);
  let v={};try{v=JSON.parse(x.verification_json||'{}')||{};}catch{}
  let raw={};try{raw=JSON.parse(x.raw_json||'{}')||{};}catch{}
  const exact=v.exact||{};
  const known=t=>t&&!/unknown|desconocid|sin determinar/i.test(String(t));
  const source=String(x.source||'');
  const platform=OPPORTUNITY_SOURCE_LABELS[source]||(source.startsWith('ebay-')?`eBay ${source.slice(5).toUpperCase()}`:source);
  const orig=Number(x.original_price);
  const price=Number.isFinite(orig)&&orig>0&&x.currency&&x.currency!=='EUR'?`${fmtMoney(orig,x.currency)} (≈ ${eur0(x.price_eur)})`:eur0(x.price_eur);
  const ago=alertAgo(listingPublishedAtMs(x));
  const decision=String(x.decision||'').toUpperCase();
  const norefs=v.final?.no_refs_interesting===true&&!(Number(v.final?.resale_mean_eur)>0);
  const head=norefs?'🔎 <b>INTERESANTE · SIN PRONÓSTICO</b>':soft?'👀 <b>POSIBLE OPORTUNIDAD · revísala</b>':`🔥 <b>${ALERT_DECISION_ES[decision]||htmlEsc(decision)}</b>`;
  const modelText=String(x.model||'').toLowerCase();
  const identified=[known(exact.size)&&!modelText.includes(String(exact.size).toLowerCase())&&exact.size,known(exact.material)&&alertEs(exact.material),known(exact.main_color)&&alertEs(exact.main_color)].filter(Boolean).join(' · ');
  const title=String(x.title||'').trim();
  const landed=Number(x.landed_cost_eur);
  const margin=landed>0&&Number.isFinite(Number(x.net_profit_low_eur))?Math.round(Number(x.net_profit_low_eur)/landed*100):null;
  const pct=Number.isFinite(x._priceVsTaskMedian)?Math.round((1-x._priceVsTaskMedian)*100):null;
  const range=(a,b)=>a==null&&b==null?'—':`${eur0(a)}${b!=null&&Math.round(Number(b))!==Math.round(Number(a))?` – ${eur0(b)}`:''}`;
  const reasons=(()=>{try{return JSON.parse(x.decision_reasons_es_json||'[]');}catch{return [];}})()
    .map(r=>String(r||'').trim()).filter(Boolean)
    // Lo que ya cuenta el bloque de comparación no se repite.
    .filter(r=>!/^(CONSULTAR PRECIO:|Sin referencia en tu base|Reventa según tu base|Reventa ajustada con tu base|Sheets:|Precio combinado:)/.test(r)).slice(0,4);
  const seller=[];
  if(source.startsWith('ebay-'))seller.push(raw.authenticityGuarantee?'✅ Garantía de Autenticidad de eBay':`⭐ Vendedor top de eBay: ${Number(x.seller_sales)||0} valoraciones · ${x.seller_reviews??'—'} % positivas`);
  else{
    if(source==='xianyu'&&xianyuListingHasVerificationTag(x))seller.push('✅ Con verificación de autenticidad de Xianyu (验货宝)');
    const stats=[Number(x.seller_sales)>0?`${Number(x.seller_sales)} ventas`:'',Number(x.seller_reviews)>0?`${Number(x.seller_reviews)} reseñas`:'',Number(x.seller_items)>0?`${Number(x.seller_items)} anuncios`:''].filter(Boolean);
    if(stats.length)seller.push(`Vendedor: ${stats.join(' · ')}`);
  }
  seller.push(`Riesgo de autenticidad: <b>${RISK_ES[String(x.authenticity_risk||'').toUpperCase()]||htmlEsc(x.authenticity_risk||'—')}</b>`);
  if(known(exact.condition?.grade))seller.push(`Estado: ${htmlEsc(exact.condition.grade)}`);
  const links=[x.url?`📱 <a href="${htmlEsc(listingAppLink(x))}">Abrir en la app</a>`:'',x.url&&listingAppLink(x)!==x.url?`🌐 <a href="${htmlEsc(x.url)}">Ver en la web</a>`:''].filter(Boolean).join('  ·  ');
  const header=[
    listingAuction(x)?.live?auctionHotLine(listingAuction(x).bids):'',
    `${head} · ${htmlEsc(x._task_name||'')}`,
    `<b>${htmlEsc(x.model||title)}</b>${identified?` · ${htmlEsc(identified)}`:''}`,
    title&&title!==x.model?`<i>${htmlEsc(title.slice(0,140))}</i>`:'',
    `${htmlEsc(platform)} · <b>${price}</b>${ago?` · publicado ${ago}`:''}`,
    norefs?`Calidad del anuncio ${Number(v.final?.quality_score)||'—'}/100`:`Puntuación ${x.opportunity_score??'—'}/100`
  ].filter(Boolean);
  const auc=listingAuction(x);
  const lines=[
    ...header,
    ...alertSection('💰 NÚMEROS',[
      `Coste puesto en España: <b>${eur0(x.landed_cost_eur)}</b>${auc?.live?' (con la puja actual)':''}`,
      ...(auc?.live?[`🔨 Subasta: ${auc.bids||0} puja${auc.bids===1?'':'s'} · termina ${Number.isFinite(auc.endMs)?new Date(auc.endMs).toLocaleString('es-ES',{timeZone:'Europe/Madrid',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'—'}`]:[]),
      ...(norefs?['<b>Sin pronóstico:</b> no hay ninguna referencia igual en tu base ni en Vestiaire, así que no te doy precio de venta. Te lo envío porque el anuncio es el modelo buscado y está en buen estado: valóralo tú.']
      :v.match_version&&Number(v.final?.resale_mean_eur)>0?[
        // Análisis nuevo: un precio de venta realista (media o mediana de las
        // iguales, la más baja) y el beneficio con ese precio, no con la franja alta.
        `Precio de venta orientativo: <b>${eur0(v.final.resale_mean_eur)}</b> · ${alertResaleSource(x,v)}`,
        `Franja de las referencias iguales: ${range(x.resale_low_eur,x.resale_high_eur)}`,
        `Beneficio limpio vendiendo en ${htmlEsc(resalePlatform(x._task_name).name)} (−${resalePlatform(x._task_name).fee} % comisión): <b>${eur0(v.final.net_profit_clean_eur)}</b>${Number.isFinite(Number(v.final.clean_margin_pct))?` · margen ${v.final.clean_margin_pct} %`:''}`
      ]:[
        `Reventa: <b>${range(x.resale_low_eur,x.resale_high_eur)}</b> · ${alertResaleSource(x,v)}`,
        vestiaireProfitLine(x.resale_low_eur,x.resale_high_eur,x.landed_cost_eur,x._task_name).replace(/^Beneficio en/,'Beneficio limpio vendiendo en'),
        `Margen bruto (reventa − coste): ${range(x.net_profit_low_eur,x.net_profit_high_eur)}${margin!=null?` · ${margin} %`:''}`
      ]),
      pct===null?'':pct>0?`📉 ${pct} % por debajo del precio mediano de este modelo`:`📈 ${Math.abs(pct)} % por encima del precio mediano de este modelo`
    ]),
    ...alertSection('💬 OFERTA AL VENDEDOR',sellerOfferLines(x,v)),
    ...alertSection('🧾 DESGLOSE DEL COSTE',importCostLines(x)),
    ...alertSection('📚 TU BASE DE DATOS',cmp.base),
    ...alertSection('🌐 VESTIAIRE EN DIRECTO',cmp.live),
    ...(cmp.used?['',cmp.used]:[]),
    ...alertSection('🛡️ VENDEDOR Y AUTENTICIDAD',seller),
    ...alertSection('📝 POR QUÉ',reasons.map(r=>`• ${htmlEsc(r.slice(0,300))}`)),
    ...(links?['',links]:[])
  ];
  // Telegram admite 4.096 caracteres: si no cabe, fuera primero los enlaces
  // de anuncios comparables (nunca se corta el texto a medias).
  let text=lines.join('\n');
  while(text.length>4000){
    const i=lines.findLastIndex(l=>/^ {3}· <a /.test(l));
    if(i<0)break;
    lines.splice(i,1);text=lines.join('\n');
  }
  return text;
}

// ── LÍMITE DE AVISOS POR MODELO ─────────────────────────────────────────
// Evita que un modelo con muchos anuncios (p. ej. Lady Dior) llene Telegram:
// tope por tarea cada 24 h, se descartan casi-duplicados (mismo vendedor y
// precio parecido, o mismo título) y, en los avisos suaves, cada nuevo aviso
// tiene que superar al peor que ya se ha enviado hoy de esa tarea.
function recentTaskAlerts(taskId,kinds,hours=24){
  const since=new Date(Date.now()-hours*3600e3).toISOString();
  return db.prepare(`SELECT n.listing_id,n.kind,l.seller_name,l.title,l.price_eur,ta.net_profit_low_eur
    FROM notifications n JOIN listings l ON l.id=n.listing_id
    LEFT JOIN task_analyses ta ON ta.task_id=n.task_id AND ta.listing_id=n.listing_id
    WHERE n.task_id=? AND n.sent_at>=? AND n.kind IN (${kinds.map(()=>'?').join(',')})`).all(Number(taskId),since,...kinds);
}
const normTitle=t=>String(t||'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'');
function isNearDuplicateAlert(x,sent){
  const seller=String(x.seller_name||'').trim();
  const price=Number(x.price_eur)||0;
  const title=normTitle(x.title);
  return sent.some(s=>{
    if(title&&title.length>8&&normTitle(s.title)===title)return true;
    if(seller&&String(s.seller_name||'').trim()===seller){
      const p=Number(s.price_eur)||0;
      if(price>0&&p>0&&Math.abs(price-p)/Math.max(price,p)<=0.1)return true;
    }
    return false;
  });
}
// Sin máximo de avisos por modelo ni por producto (decisión de Nil): solo se
// quitan los casi-duplicados (mismo vendedor y precio parecido).
function limitTaskAlerts(task,picks,{kinds}){
  const sent=recentTaskAlerts(task.id,kinds);
  const out=[];
  for(const x of picks){
    if(isNearDuplicateAlert(x,[...sent,...out]))continue;
    out.push(x);
  }
  return out;
}

async function sendInstantAlerts(task,runId,items){
  if(['0','false','off','no'].includes(String(process.env.INSTANT_ALERTS||'').toLowerCase())){
    return {sent:0,reason:'disabled'};
  }
  // Interesantes sin referencias iguales: aviso sin pronóstico (subastas incluidas).
  await sendNoRefAlerts(task,runId,items).catch(e=>console.error('Avisos sin pronóstico:',e.message));
  // Las subastas en curso van por su propio aviso, con la puja máxima.
  const auctionItems=(items||[]).filter(x=>auctionInWindow(x));
  if(auctionItems.length)await sendAuctionAlerts(task,runId,auctionItems).catch(e=>console.error('Avisos de subasta:',e.message));
  items=(items||[]).filter(x=>!listingAuction(x)?.live);
  const decisions=envList('INSTANT_ALERT_DECISIONS',['STRONG BUY','BUY']);
  const minProfit=process.env.INSTANT_ALERT_MIN_PROFIT_EUR!=null&&process.env.INSTANT_ALERT_MIN_PROFIT_EUR!==''
    ? Number(process.env.INSTANT_ALERT_MIN_PROFIT_EUR)
    : null;
  // Solo ofertas realmente buenas: umbrales del modelo (puntuación y
  // beneficio mínimo), margen mínimo sobre el coste puesto en España y
  // reventa contrastada con anuncios reales (no solo estimada por la IA).
  const minMarginPct=Number(process.env.INSTANT_ALERT_MIN_MARGIN_PCT??30);
  const requireMarket=!['0','false','no','off'].includes(String(process.env.INSTANT_ALERT_REQUIRE_MARKET||'').toLowerCase());
  const alreadyAlerted=db.prepare(`SELECT 1 FROM notifications WHERE listing_id=? AND kind='instant' LIMIT 1`);
  const fresh=(items||[]).filter(x=>{
    if(noPriceVeto(x))return false;
    if(!decisions.includes(String(x.decision||'').toUpperCase()))return false;
    const profitLow=Number(x.net_profit_low_eur);
    if(minProfit!=null&&Number.isFinite(minProfit)&&!(profitLow>=minProfit))return false;
    if(task.notify_min_score!=null&&!(Number(x.opportunity_score)>=Number(task.notify_min_score)))return false;
    if(task.notify_min_profit_eur!=null&&!(profitLow>=Number(task.notify_min_profit_eur)))return false;
    const landed=Number(x.landed_cost_eur);
    if(Number.isFinite(minMarginPct)&&minMarginPct>0&&landed>0&&!(profitLow/landed*100>=minMarginPct))return false;
    if(requireMarket){
      let final={};
      try{final=JSON.parse(x.verification_json||'{}')?.final||{};}catch{}
      if(final.resale_estimate_market_verified!==true)return false;
    }
    if(listingFeedback(x.id)==='not_interested')return false;
    return !alreadyAlerted.get(Number(x.id));
  }).map(x=>({...x,_task_name:task.task_name,_task_id:task.id,_run_id:runId}));
  const rank={'STRONG BUY':0,'BUY':1,'WATCH':2};
  fresh.sort((a,b)=>
    (rank[String(a.decision).toUpperCase()]??9)-(rank[String(b.decision).toUpperCase()]??9) ||
    Number(b.net_profit_low_eur??-1e9)-Number(a.net_profit_low_eur??-1e9)
  );
  const freshAll=fresh.slice();
  fresh.splice(0,fresh.length,...limitTaskAlerts(task,freshAll,{kinds:['instant']}));
  const soft=await sendSoftAlerts(task,runId,items,new Set(freshAll.map(x=>Number(x.id))));
  if(!fresh.length)return {sent:0,soft};
  // Bolsos iguales en la base de Vestiaire de Nil, para el texto del aviso.

  const channels=[];
  const errors=[];
  const recipient=alertRecipient();
  if(smtpConfig().configured&&recipient){
    try{
      const top=fresh[0];
      const subject=`🔥 ${top.decision} · ${top.model||task.task_name} · ${eur0(top.net_profit_low_eur)} beneficio${fresh.length>1?` (+${fresh.length-1} más)`:''}`;
      const html=`
        <div style="font-family:Arial,sans-serif;color:#111827;max-width:1000px;margin:auto">
          <h2 style="margin-bottom:4px">Aviso inmediato · ${htmlEsc(task.task_name)}</h2>
          <p style="color:#6b7280;margin-top:0">Detectado ahora mismo por Luxury Hunter. Revisa el anuncio y la autenticación antes de comprar.</p>
          <table style="width:100%;border-collapse:collapse">
            <tbody>${fresh.map((x,i)=>globalEmailOpportunityRow(x,i+1)).join('')}</tbody>
          </table>
        </div>`;
      const {transport,config:mailConfig}=getMailTransport();
      await transport.sendMail({
        from:mailConfig.from,
        to:recipient,
        subject,
        html,
        text:fresh.map(x=>
          instantAlertText(x)
            .replace(/<a href="([^"]+)">[^<]*<\/a>/g,(m,href)=>href.replace(/&amp;/g,'&'))
            .replace(/<[^>]+>/g,'')
        ).join('\n\n')
      });
      channels.push('email');
    }catch(e){
      errors.push(`email: ${e.message}`);
    }
  }
  if(telegramConfigured()){
    try{
      for(const x of fresh){
        await telegramSendListing(instantAlertText(x),x);
      }
      channels.push('telegram');
    }catch(e){
      errors.push(`telegram: ${e.message}`);
    }
  }
  if(!channels.length){
    if(errors.length)console.error('Instant alerts failed:',errors.join(' | '));
    return {sent:0,errors,reason:errors.length?'error':'no-channel-configured'};
  }

  const now=new Date().toISOString();
  const mark=db.prepare(`
    INSERT OR IGNORE INTO notifications(task_id,listing_id,run_id,kind,sent_to,sent_at)
    VALUES(?,?,?,'instant',?,?)
  `);
  for(const x of fresh)mark.run(Number(task.id),Number(x.id),Number(runId)||null,channels.join('+'),now);
  console.log(`Task ${task.id}: aviso inmediato enviado (${channels.join('+')}) para ${fresh.length} oportunidad(es).`);
  return {sent:fresh.length,channels,errors,soft};
}

// ── AVISOS DE SUBASTA ───────────────────────────────────────────────────
// Una subasta se avisa una vez, con la puja máxima rentable, si el modelo y
// el riesgo son buenos y la puja actual va al menos un 10 % por debajo de ese
// máximo. Como mucho AUCTION_ALERT_TASK_DAILY_MAX (3) por modelo cada 24 h.
function auctionAlertText(x,plan){
  const auc=listingAuction(x)||{};
  const left=Number.isFinite(auc.endMs)?Math.max(0,(auc.endMs-Date.now())/3600e3):null;
  const ends=Number.isFinite(auc.endMs)?new Date(auc.endMs).toLocaleString('es-ES',{timeZone:'Europe/Madrid',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';
  const maxLocal=plan.max_bid_local!=null?fmtMoney(plan.max_bid_local,plan.currency):eur0(plan.max_bid_eur);
  return [
    auctionHotLine(plan.bids),
    `🔨 <b>Subasta · puja como máximo ${maxLocal}</b> · ${htmlEsc(x._task_name||'')}`,
    `<b>${htmlEsc(x.model||x.title||'')}</b>`,
    `${htmlEsc(x.purchase_via||x.source||'')} · puja actual ${fmtMoney(plan.current_bid,plan.currency)} (≈ ${eur0(x.price_eur)}) · ${plan.bids||0} puja${plan.bids===1?'':'s'}`,
    `⏰ Termina el ${ends}${left!=null?` (en ${left<1?`${Math.round(left*60)} min`:`${Math.round(left)} h`})`:''}`,
    `💰 <b>Puja máxima: ${maxLocal}</b> (≈ ${eur0(plan.max_bid_eur)})`,
    `Con esa puja: coste puesto en España ${eur0(x.landed_cost_eur)} · vendiendo a ${eur0(plan.resale_eur)}${plan.resale_from_db?' (anuncios parecidos de tu base)':' (🔮 pronóstico)'} te quedan al menos <b>${eur0(plan.min_profit_eur)}</b> limpios (comisión de ${resalePlatform(x._task_name).name} e IVA del margen incluidos).`,
    `Score ${x.opportunity_score??'—'} · riesgo de autenticidad ${htmlEsc(x.authenticity_risk||'—')}`,
    ...vestiaireDbLines(x._task_name,x),
    x.url?`<a href="${htmlEsc(listingAppLink(x))}">📱 Abrir la subasta</a>`:''
  ].filter(Boolean).join('\n');
}
// Subasta con varios interesados (regla de Nil, 07-11-2026): se destaca
// arriba del aviso. AUCTION_HOT_BIDS (5) pujas o más.
const AUCTION_HOT_BIDS=Math.max(2,Number(process.env.AUCTION_HOT_BIDS||5));
function auctionHotLine(bids){
  const n=Number(bids)||0;
  return n>=AUCTION_HOT_BIDS?`🔥🔥 <b>MUCHOS INTERESADOS · ${n} pujas</b>`:'';
}
async function sendAuctionAlerts(task,runId,items){
  if(!telegramConfigured())return {sent:0,reason:'no-telegram'};
  const already=db.prepare(`SELECT 1 FROM notifications WHERE listing_id=? AND kind='auction' LIMIT 1`);
  const picks=(items||[]).filter(x=>{
    let plan=null;try{plan=JSON.parse(x.verification_json||'{}')?.auction||null;}catch{}
    if(!plan||!(Number(plan.max_bid_eur)>0))return false;
    if(!['STRONG BUY','BUY','WATCH'].includes(String(x.decision||'').toUpperCase()))return false;
    if(String(x.authenticity_risk||'').toUpperCase()==='HIGH')return false;
    if(!(Number(plan.max_bid_eur)>=Number(x.price_eur)*1.1))return false;
    if(listingFeedback(x.id)==='not_interested')return false;
    x._auction=plan;x._task_name=task.task_name;
    return !already.get(Number(x.id));
  }).sort((a,b)=>(Number(b._auction.bids)>=AUCTION_HOT_BIDS)-(Number(a._auction.bids)>=AUCTION_HOT_BIDS)||
    (b._auction.max_bid_eur-Number(b.price_eur))-(a._auction.max_bid_eur-Number(a.price_eur)));
  const limited=limitTaskAlerts(task,picks,{kinds:['auction']});
  const mark=db.prepare(`INSERT OR IGNORE INTO notifications(task_id,listing_id,run_id,kind,sent_to,sent_at) VALUES(?,?,?,'auction','telegram',?)`);
  let sent=0;
  for(const x of limited){
    try{
      await telegramSendListing(auctionAlertText(x,x._auction),x);
      mark.run(Number(task.id),Number(x.id),Number(runId)||null,new Date().toISOString());
      sent++;
    }catch(e){console.error('Aviso de subasta:',e.message);}
  }
  if(sent)console.log(`Task ${task.id}: ${sent} subasta(s) avisada(s) por Telegram con puja máxima.`);
  return {sent};
}

// ── SOFT ALERTS V1 ──────────────────────────────────────────────────────
// "Posible oportunidad, revísala": buen margen pero sin la certeza que
// exige el aviso fuerte (p. ej. fotos insuficientes). Solo por Telegram,
// con botones, y como mucho una vez por anuncio.
async function sendSoftAlerts(task,runId,items,strictIds=new Set()){
  if(['0','false','off','no'].includes(String(process.env.SOFT_ALERTS||'').toLowerCase()))return {sent:0,reason:'disabled'};
  if(!telegramConfigured())return {sent:0,reason:'no-telegram'};
  const minScore=Number(process.env.SOFT_ALERT_MIN_SCORE||50);
  const minMarginPct=Number(process.env.SOFT_ALERT_MIN_MARGIN_PCT||20);
  const taskMin=Number(task.notify_min_profit_eur);
  const minProfit=Number(process.env.SOFT_ALERT_MIN_PROFIT_EUR||0)||Math.max(150,Number.isFinite(taskMin)?Math.round(taskMin*0.6):150);
  const already=db.prepare(`SELECT 1 FROM notifications WHERE listing_id=? AND kind IN ('instant','soft') LIMIT 1`);
  const picks=(items||[]).filter(x=>{
    if(noPriceVeto(x))return false;
    if(strictIds.has(Number(x.id)))return false;
    if(!['STRONG BUY','BUY','WATCH'].includes(String(x.decision||'').toUpperCase()))return false;
    if(String(x.authenticity_risk||'').toUpperCase()==='HIGH')return false;
    if(!(Number(x.opportunity_score)>=minScore))return false;
    const profitLow=Number(x.net_profit_low_eur);
    if(!(profitLow>=minProfit))return false;
    const landed=Number(x.landed_cost_eur);
    if(landed>0&&!(profitLow/landed*100>=minMarginPct))return false;
    if(listingFeedback(x.id)==='not_interested')return false;
    return !already.get(Number(x.id));
  }).sort((a,b)=>Number(b.net_profit_low_eur)-Number(a.net_profit_low_eur));
  const picksLimited=limitTaskAlerts(task,picks,{kinds:['instant','soft']});
  picks.splice(0,picks.length,...picksLimited);
  if(!picks.length)return {sent:0};
  const mark=db.prepare(`INSERT OR IGNORE INTO notifications(task_id,listing_id,run_id,kind,sent_to,sent_at) VALUES(?,?,?,'soft','telegram',?)`);
  let sent=0;
  for(const x of picks){
    const text=instantAlertText({...x,_task_name:task.task_name},{soft:true});
    try{
      await telegramSendListing(text,x);
      mark.run(Number(task.id),Number(x.id),Number(runId)||null,new Date().toISOString());
      sent++;
    }catch(e){
      console.error('Soft alert failed:',e.message);
    }
  }
  if(sent)console.log(`Task ${task.id}: ${sent} posible(s) oportunidad(es) enviada(s) por Telegram.`);
  return {sent};
}

// ── SOLO TRIAJE (presupuesto de IA agotado) ────────────────────────────
// Pasa el triaje barato pero ya no queda IA para compararlo con la base:
// se enseña tal cual (compras y subastas en ventana), una vez por anuncio.
function triageOnlyText(x){
  const auc=listingAuction(x);
  const eco=(()=>{try{return importEconomics(x);}catch{return null;}})();
  const ends=auc?.live&&Number.isFinite(auc.endMs)?new Date(auc.endMs).toLocaleString('es-ES',{timeZone:'Europe/Madrid',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):null;
  return [
    auc?.live?auctionHotLine(auc.bids):'',
    `🟡 <b>PASA EL TRIAJE · sin analizar</b> · ${htmlEsc(x._task_name||'')}`,
    `<b>${htmlEsc(String(x.title||'').slice(0,160))}</b>`,
    `${htmlEsc(x.purchase_via||x.source||'')} · <b>${fmtMoney(x.original_price,x.currency)}</b> (≈ ${eur0(x.price_eur)})`,
    auc?.live?`🔨 Subasta: ${auc.bids||0} puja${auc.bids===1?'':'s'} · termina ${ends} (en ${Math.max(0,Math.round((auc.endMs-Date.now())/60e3))} min)`:'',
    eco?.importedTotalEur?`Coste puesto en España${auc?.live?' con la puja actual':''}: ${eur0(eco.importedTotalEur)}`:'',
    `Triaje: ${x._triageScore}/100${x._triageReason?` · ${htmlEsc(String(x._triageReason).slice(0,200))}`:''}`,
    '⚠️ Presupuesto de IA de hoy agotado: no se ha comparado con tu base ni con fotos.',
    x.url?`📱 <a href="${htmlEsc(listingAppLink(x))}">Abrir el anuncio</a>`:''
  ].filter(Boolean).join('\n');
}
async function sendTriageOnlyAlerts(task,runId,items){
  if(['0','false','off','no'].includes(String(process.env.TRIAGE_ONLY_ALERTS||'').toLowerCase()))return {sent:0,reason:'disabled'};
  if(!telegramConfigured())return {sent:0,reason:'no-telegram'};
  const already=db.prepare('SELECT 1 FROM notifications WHERE listing_id=? LIMIT 1');
  const picks=(items||[]).filter(x=>{
    const auc=listingAuction(x);
    if(auc&&!auctionInWindow(x))return false;
    if(noPriceVeto(x))return false;
    if(listingFeedback(x.id)==='not_interested')return false;
    return !already.get(Number(x.id));
  }).sort((a,b)=>(b._triageScore??0)-(a._triageScore??0)).map(x=>({...x,_task_name:task.task_name}));
  const mark=db.prepare(`INSERT OR IGNORE INTO notifications(task_id,listing_id,run_id,kind,sent_to,sent_at) VALUES(?,?,?,'triage','telegram',?)`);
  let sent=0;
  for(const x of picks){
    try{
      await telegramSendListing(triageOnlyText(x),x);
      mark.run(Number(task.id),Number(x.id),Number(runId)||null,new Date().toISOString());
      sent++;
      await sleep(800);
    }catch(e){console.error('Aviso del triaje:',e.message);}
  }
  if(sent)console.log(`Task ${task.id}: ${sent} anuncio(s) que pasan el triaje enviados sin analizar (presupuesto de IA agotado).`);
  return {sent};
}

// ── SIN PRONÓSTICO ─────────────────────────────────────────────────────
// Revisada la base entera y Vestiaire sin encontrar ninguna igual: si el
// anuncio es el producto buscado y está bien, se avisa sin precio de venta.
async function sendNoRefAlerts(task,runId,items){
  if(['0','false','off','no'].includes(String(process.env.NO_REF_ALERTS||'').toLowerCase()))return {sent:0,reason:'disabled'};
  if(!telegramConfigured())return {sent:0,reason:'no-telegram'};
  const already=db.prepare(`SELECT 1 FROM notifications WHERE listing_id=? AND kind IN ('instant','soft','auction','norefs') LIMIT 1`);
  const picks=(items||[]).filter(x=>{
    let v={};try{v=JSON.parse(x.verification_json||'{}')||{};}catch{}
    if(v.final?.no_refs_interesting!==true||Number(v.final?.resale_mean_eur)>0)return false;
    if(String(x.decision||'').toUpperCase()==='REJECT')return false;
    const auc=listingAuction(x);
    if(auc&&!auctionInWindow(x))return false;
    if(noPriceVeto(x))return false;
    if(listingFeedback(x.id)==='not_interested')return false;
    return !already.get(Number(x.id));
  }).map(x=>({...x,_task_name:task.task_name}));
  const limited=limitTaskAlerts(task,picks,{kinds:['norefs']});
  const mark=db.prepare(`INSERT OR IGNORE INTO notifications(task_id,listing_id,run_id,kind,sent_to,sent_at) VALUES(?,?,?,'norefs','telegram',?)`);
  let sent=0;
  for(const x of limited){
    try{
      await telegramSendListing(instantAlertText(x),x);
      mark.run(Number(task.id),Number(x.id),Number(runId)||null,new Date().toISOString());
      sent++;
    }catch(e){console.error('Aviso sin pronóstico:',e.message);}
  }
  if(sent)console.log(`Task ${task.id}: ${sent} anuncio(s) interesante(s) sin pronóstico enviado(s) por Telegram.`);
  return {sent};
}

const HEALTH_ALERT_COOLDOWN_HOURS={
  'gemini-capacity':6,
  'ai-budget':20,
  default:24
};

async function reportHealthIssue(key,message){
  const state=getSetting('health_alerts',{})||{};
  const now=new Date();
  const entry=state[key]||{first_at:now.toISOString(),count:0,last_sent_at:null};
  entry.count=Number(entry.count||0)+1;
  entry.last_seen_at=now.toISOString();
  entry.message=String(message||'').slice(0,500);
  const cooldownMs=(HEALTH_ALERT_COOLDOWN_HOURS[key]??HEALTH_ALERT_COOLDOWN_HOURS.default)*3600*1000;
  const lastSent=Date.parse(entry.last_sent_at||'');
  const due=!Number.isFinite(lastSent)||now.getTime()-lastSent>=cooldownMs;
  if(due){
    const since=new Date(entry.first_at).toLocaleString('es-ES',{timeZone:'Europe/Madrid'});
    const text=`⚠️ Luxury Hunter: problema "${key}"\nDesde: ${since} · ${entry.count} fallo(s)\n${entry.message}`;
    let sent=false;
    const recipient=alertRecipient();
    if(smtpConfig().configured&&recipient){
      try{
        const {transport,config:mailConfig}=getMailTransport();
        await transport.sendMail({
          from:mailConfig.from,
          to:recipient,
          subject:`⚠️ Luxury Hunter necesita atención: ${key}`,
          text,
          html:`<div style="font-family:Arial,sans-serif"><h2 style="color:#b91c1c">Luxury Hunter necesita atención</h2>
            <p><b>Problema:</b> ${htmlEsc(key)}<br><b>Desde:</b> ${htmlEsc(since)}<br><b>Fallos acumulados:</b> ${entry.count}</p>
            <pre style="white-space:pre-wrap;background:#fef2f2;padding:12px;border-radius:6px">${htmlEsc(entry.message)}</pre>
            <p style="color:#6b7280">Mientras esto no se resuelva, el bot puede no estar detectando oportunidades.</p></div>`
        });
        sent=true;
      }catch(e){console.error('Health alert email failed:',e.message);}
    }
    if(telegramConfigured()){
      try{await telegramSend(htmlEsc(text));sent=true;}catch(e){console.error('Health alert telegram failed:',e.message);}
    }
    if(sent)entry.last_sent_at=now.toISOString();
  }
  state[key]=entry;
  db.prepare(`INSERT INTO app_settings(key,value_json,updated_at) VALUES('health_alerts',?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
    .run(JSON.stringify(state),now.toISOString());
}

function clearHealthIssue(key){
  const state=getSetting('health_alerts',{})||{};
  if(!state[key])return;
  delete state[key];
  db.prepare(`UPDATE app_settings SET value_json=?,updated_at=? WHERE key='health_alerts'`)
    .run(JSON.stringify(state),new Date().toISOString());
}

async function reportRunHealth(status){
  for(const [src,s] of Object.entries(status||{})){
    // triage no es una fuente: si falla se usa la prioridad por precio y los
    // fallos reales de IA ya se avisan aparte (gemini-errors / ai-budget).
    if(['freshness','aiAnalysis','email','instantAlerts','prescreen','triage','xianyuDetail'].includes(src))continue;
    // Un fallo suelto (p. ej. Bunjang tarda en responder una vez) no avisa:
    // solo a partir de 3 fallos seguidos de la misma fuente.
    const streaks=getSetting('source_fail_streak',{})||{};
    if(s&&s.ok===false){
      streaks[src]=Number(streaks[src]||0)+1;
      if(streaks[src]>=Number(process.env.SOURCE_ALERT_MIN_STREAK||3)){
        await reportHealthIssue(`source-${src}`,`La fuente ${src} falla (${streaks[src]} veces seguidas): ${s.error||s.warning||'sin detalle'}`);
      }
    }else if(s&&s.ok===true){
      streaks[src]=0;
      clearHealthIssue(`source-${src}`);
    }
    db.prepare(`INSERT INTO app_settings(key,value_json,updated_at) VALUES('source_fail_streak',?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`).run(JSON.stringify(streaks),new Date().toISOString());
  }
}

// Cada tarea gasta de su mitad del presupuesto de IA (bolsos o relojes).
async function executeTask(taskId, runId=null, opts={}) {
  const t=db.prepare('SELECT task_name FROM tasks WHERE id=?').get(Number(taskId));
  return aiCategoryStore.run(isWatchTask(t?.task_name)?'watch':'bag',()=>executeTaskInner(taskId,runId,opts));
}
async function executeTaskInner(taskId, runId=null, {fast=false}={}) {
  // Base de datos de Vestiaire de Nil al día antes de analizar (máx. 25 s).
  await Promise.race([refreshVestiaireSheet().catch(()=>{}),sleep(25000)]);
  if(runId && runIsAborted(runId)){
    return abortedResult(runId);
  }
  taskId=Number(taskId); if(runningTaskIds.has(taskId)) throw new Error('La tarea ya está ejecutándose.');
  const task=taskPublic(db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId)); if(!task) throw new Error('Tarea no encontrada.');
  // El carril rápido también busca modelos desactivados (solo Xianyu y Mercari).
  if(!task.enabled&&!fast) throw new Error('La tarea está desactivada.');
  runningTaskIds.add(taskId);
  const started=new Date().toISOString();
  if(!runId){const rr=db.prepare('INSERT INTO task_runs(task_id,status,started_at) VALUES(?,?,?)').run(taskId,'running',started);runId=Number(rr.lastInsertRowid);}
  else db.prepare('UPDATE task_runs SET status=?,started_at=? WHERE id=?').run('running',started,Number(runId));
  db.prepare('UPDATE task_runs SET debug_json=? WHERE id=?').run(JSON.stringify({version:'1.7.1',taskSnapshot:safeTaskSnapshot(task),startedAt:started}),Number(runId));

  setTaskRunProgress(
    runId,
    2,
    'Iniciando tarea',
    'Preparando fuentes y consultas'
  );

  try{
    setTaskRunProgress(
      runId,
      8,
      'Buscando en marketplaces',
      'Xianyu · Bunjang · Japón'
    );

    const result=await globalSearch({
      taskId,runId:Number(runId),product:task.product_query,sources:task.sources,pages:task.max_pages,maxItems:task.max_items,minEur:task.min_eur,maxEur:task.max_eur,fast,
      personal_only:task.personal_only,free_shipping:task.free_shipping,new_publish_option:task.new_publish_option,region:task.region,
      account_state_file:task.account_state_file,account_strategy:task.account_strategy,
      xianyuQueries:task.xianyu_queries,bunjangQueries:task.bunjang_queries,japanQueries:task.japan_queries
    });

    if(runIsAborted(runId)){
      return abortedResult(runId,result.sessionId);
    }

    setTaskRunProgress(
      runId,
      30,
      'Búsqueda completada',
      'Preparando anuncios para análisis'
    );

    const publicationWindowHours=
      publicationWindowHoursFromOption(
        task.new_publish_option
      );

    result.status=result.status||{};

    if(publicationWindowHours!==null){
      const freshnessWindow=
        enforceFreshPublicationWindow(
          result.sessionId,
          publicationWindowHours
        );

      result.status.freshness={
        ok:true,
        state:'finished',
        configuredOption:
          task.new_publish_option||null,
        ...freshnessWindow
      };

      console.log(
        `Task ${taskId}: publicación ${publicationWindowHours}h -> `+
        `kept=${freshnessWindow.kept}, `+
        `stale=${freshnessWindow.stale}, `+
        `unknown=${freshnessWindow.unknown}, `+
        `unknownKeptNew=${freshnessWindow.unknownKeptNew}, `+
        `future=${freshnessWindow.future}`
      );
    }else{
      result.status.freshness={
        ok:true,
        state:'skipped',
        configuredOption:
          task.new_publish_option||null,
        hours:null,
        reason:'no_publication_window'
      };

      console.log(
        `Task ${taskId}: sin filtro temporal de publicación`
      );
    }

    const previousAnalyzedAnywhere=db.prepare(`
      DELETE FROM search_session_items
      WHERE session_id=?
        AND listing_id IN (
          SELECT listing_id FROM task_analyses
          UNION
          SELECT listing_id FROM analyses
        )
    `).run(result.sessionId);

    if(previousAnalyzedAnywhere.changes){
      console.log(
        `Task ${taskId}: `+
        `${previousAnalyzedAnywhere.changes} anuncios con análisis previo `+
        `apartados globalmente de esta ejecución.`
      );
    }

    if(typeof setTaskRunProgress==='function'){
      setTaskRunProgress(
        runId,
        34,
        'Filtrando anuncios',
        'Solo publicación real <=24h y listings nunca analizados'
      );
    }

    // Apartar de esta ejecución los anuncios que esta misma tarea ya analizó.
    // El listing y su análisis permanecen guardados en el histórico.
    const previousAnalyzed = db.prepare(`
      DELETE FROM search_session_items
      WHERE session_id=?
        AND listing_id IN (
          SELECT listing_id
          FROM task_analyses
          WHERE task_id=?
            AND (
              decision='REJECT'
              OR verification_json LIKE '%"status":"verified"%'
              OR verification_json LIKE '%"status":"not_required"%'
              OR verification_json LIKE '%"status":"skipped_cost"%'
            )
        )
    `).run(result.sessionId, taskId);

    if(previousAnalyzed.changes){
      console.log(
        `Task ${taskId}: ${previousAnalyzed.changes} anuncios ya analizados apartados de esta ejecución.`
      );
    }

    if(task.decision_mode==='keyword'){
      const items=sessionListings(result.sessionId);
      for(const item of items){
        if(runIsAborted(runId)){
          return abortedResult(runId,result.sessionId);
        }if(!matchesKeywordRules(item,task.keyword_rules)) db.prepare('DELETE FROM search_session_items WHERE session_id=? AND listing_id=?').run(result.sessionId,item.id);}
    } else if(aiConfigured()){
      const items=sessionListings(result.sessionId);
      let pendingItems=[];
      let capacityErrorFromTriage=null;
      const prescreenStats={rejected:0,byCode:{}};

      for(const item of items){
        const existingAnalysis=db.prepare(
          'SELECT decision,verification_json FROM task_analyses WHERE task_id=? AND listing_id=?'
        ).get(taskId,item.id);

        if(!existingAnalysis){
          const pre=deterministicPrescreen(item,task)||priceCeilingVeto(item,task);
          if(pre){
            storePrescreenReject(taskId,item,pre);
            prescreenStats.rejected++;
            prescreenStats.byCode[pre.code]=(prescreenStats.byCode[pre.code]||0)+1;
            continue;
          }
        }else{
          // Ya analizado antes: sin precio o de Xianyu sin 验货宝 se descarta y no se toca más.
          const veto=noPriceVeto(item)||xianyuVerificationVeto(item);
          if(veto){
            if(String(existingAnalysis.decision||'').toUpperCase()!=='REJECT')storePrescreenReject(taskId,item,veto);
            continue;
          }
        }

        if(existingAnalysis){
          let verificationStatus='';

          try{
            verificationStatus=
              JSON.parse(existingAnalysis.verification_json||'{}')?.status||'';
          }catch{}

          const needsVerification=
            existingAnalysis.decision==='REVIEW' ||
            (
              POSITIVE_DECISIONS.has(
                String(existingAnalysis.decision||'').toUpperCase()
              ) &&
              !['verified','skipped_cost'].includes(verificationStatus)
            );

          if(!needsVerification)continue;
          // Pendiente de presupuesto: solo se reintenta cuando lo hay.
          if(verificationStatus==='pending_budget'&&verifyBudgetLeftUsd()<=0)continue;
          item._needsVerification=true;
        }

        pendingItems.push(item);
      }

      result.status.prescreen={ok:true,...prescreenStats};
      if(prescreenStats.rejected){
        console.log(`Task ${taskId}: pre-filtro descartó ${prescreenStats.rejected} anuncios sin usar Gemini.`);
      }

      // Lo más barato respecto a la mediana de la tarea se analiza primero,
      // así una buena oferta no espera detrás de anuncios caros.
      const prioritized=prioritizeForAnalysis(taskId,pendingItems);
      pendingItems=prioritized.items.filter(x=>{
        const auc=listingAuction(x);
        if(!auc?.live||auctionInWindow(x))return true;
        db.prepare('DELETE FROM search_session_items WHERE session_id=? AND listing_id=?').run(result.sessionId,x.id);
        return false;
      });

      // Triaje barato antes del análisis completo (desactivable con AI_TRIAGE=0).
      const triageEnabled=!['0','false','off','no'].includes(String(process.env.AI_TRIAGE||'').toLowerCase());
      const toTriage=pendingItems.filter(x=>!x._needsVerification);
      if(triageEnabled&&toTriage.length){
        setTaskRunProgress(runId,32,'Triaje IA',`${toTriage.length} anuncios nuevos · ${aiTriageModel()}`);
        try{
          const triage=await auctionAiStore.run(toTriage.some(x=>listingAuction(x)?.live),()=>triageWithAi(task,toTriage));
          let kept=0,rejected=0,unscored=0;
          const keep=new Set();
          for(const item of toTriage){
            const t=triage.scores.get(item.id);
            if(!t){unscored++;keep.add(item.id);continue;}
            item._triageScore=t.score;item._triageReason=t.reason;
            if(t.score>=triage.minScore){kept++;keep.add(item.id);}
            else{
              rejected++;
              storeTriageReject(taskId,item,t);
              db.prepare('DELETE FROM search_session_items WHERE session_id=? AND listing_id=?').run(result.sessionId,item.id);
            }
          }
          pendingItems=pendingItems.filter(x=>x._needsVerification||keep.has(x.id));
          // Dentro de lo que pasa el triaje, primero la mejor puntuación.
          pendingItems.sort((a,b)=>
            Number(!!b._needsVerification)-Number(!!a._needsVerification) ||
            (b._triageScore??-1)-(a._triageScore??-1) ||
            (a._priceVsTaskMedian??9)-(b._priceVsTaskMedian??9)
          );
          result.status.triage={ok:true,model:triage.model,calls:triage.calls,minScore:triage.minScore,kept,rejected,unscored,flagged:triage.flagged,usage:triage.usage};
          console.log(`Task ${taskId}: triaje ${triage.model} -> ${kept} pasan, ${rejected} descartados, ${unscored} sin puntuar.`);
        }catch(e){
          if(e?.geminiCapacity===true){
            capacityErrorFromTriage=e;
          }
          result.status.triage={ok:false,error:e.message};
          console.error(`Task ${taskId}: triaje falló, se usa solo la prioridad por precio:`,e.message);
        }
      }

      // Subastas en curso primero (no esperan): antes las que tienen más
      // pujas (más interesados, donde más se puede rascar) y, a igualdad, las
      // que acaban antes. El resto mantiene su orden.
      {
        const live=pendingItems.filter(x=>!x._needsVerification&&listingAuction(x)?.live);
        if(live.length){
          const ids=new Set(live.map(x=>x.id));
          live.sort((a,b)=>(Number(listingAuction(b).bids)||0)-(Number(listingAuction(a).bids)||0)||listingAuction(a).endMs-listingAuction(b).endMs);
          // Solo las que interesan ya (regla de Nil): acaban en 2 h o menos y
          // tienen al menos una puja. Las demás no gastan IA y vuelven cuando
          // entren en esa ventana.
          const keep=live.filter(auctionInWindow);
          for(const x of live)if(!keep.includes(x))db.prepare('DELETE FROM search_session_items WHERE session_id=? AND listing_id=?').run(result.sessionId,x.id);
          if(live.length>keep.length)console.log(`Task ${taskId}: ${keep.length} subastas con ≤${AUCTION_SHOW_HOURS} h y alguna puja (de ${live.length}); el resto no se analiza.`);
          pendingItems=[...pendingItems.filter(x=>x._needsVerification),...keep,...pendingItems.filter(x=>!x._needsVerification&&!ids.has(x.id))];
        }
      }

      // Japón: vendedor de Mercari/Rakuma con buenas valoraciones (regla de Nil).
      const jpCandidates=pendingItems.filter(x=>!x._needsVerification&&JAPAN_SELLER_SOURCES.has(String(x.source)));
      if(jpCandidates.length){
        try{
          const sellers=await checkJapanSellers(jpCandidates);
          let vetoed=0;
          pendingItems=pendingItems.filter(x=>{
            if(!JAPAN_SELLER_SOURCES.has(String(x.source))||x._needsVerification)return true;
            const veto=japanSellerVeto(sellers.get(x.id));
            if(!veto)return true;
            storePrescreenReject(taskId,x,veto);
            db.prepare('DELETE FROM search_session_items WHERE session_id=? AND listing_id=?').run(result.sessionId,x.id);
            vetoed++;
            return false;
          });
          if(vetoed)console.log(`Task ${taskId}: ${vetoed} anuncios de Japón descartados por valoraciones del vendedor.`);
        }catch(e){
          console.error(`Task ${taskId}: valoraciones de Japón no disponibles:`,e.message);
        }
      }

      // Tope diario de análisis completos por modelo: cuando se llega, solo
      // pasan los que el triaje puntúa muy alto (los mejores).
      const dayCap=Number(process.env.AI_MAX_ANALYSES_PER_TASK_DAY??0); // 0 = sin tope por tarea (el coste se controla por horas y por día)
      const dayKey=aiSpendDay();
      const dayCounts=(()=>{const st=getSetting('ai_task_day',{})||{};return st.day===dayKey?st:{day:dayKey,counts:{}};})();
      if(Number.isFinite(dayCap)&&dayCap>0){
        const used=Number(dayCounts.counts[taskId]||0);
        const room=Math.max(0,dayCap-used);
        const elite=Number(process.env.AI_DAY_CAP_ELITE_SCORE||85);
        const kept=[];let skipped=0;
        for(const it of pendingItems){
          if(it._needsVerification||kept.filter(x=>!x._needsVerification).length<room||(Number(it._triageScore)>=elite))kept.push(it);
          else{skipped++;db.prepare('DELETE FROM search_session_items WHERE session_id=? AND listing_id=?').run(result.sessionId,it.id);}
        }
        if(skipped)console.log(`Task ${taskId}: tope diario de ${dayCap} análisis alcanzado (${used} hoy); ${skipped} anuncios no se analizan.`);
        pendingItems=kept;
      }
      // Sin tope de anuncios: se analizan todos los que dé tiempo. Para no
      // quitar turno a otros modelos, cada tarea analiza como mucho
      // AI_TASK_MAX_MINUTES (15) y lo que quede pasa a la siguiente pasada
      // (primero lo más prometedor, que ya viene ordenado).
      let deferred=0;
      const analysisMaxMs=Math.max(1,Number(process.env.AI_TASK_MAX_MINUTES||15))*60e3;
      // Xianyu funciona en modo búsqueda únicamente para evitar cargos de ficha.
      const xianyuPending=pendingItems.filter(x=>x.source==='xianyu');
      if(xianyuPending.length){
        result.status.xianyuDetail={fetched:0,skipped:xianyuPending.length,mode:'search-only'};
      }
      dayCounts.counts[taskId]=Number(dayCounts.counts[taskId]||0)+pendingItems.filter(x=>!x._needsVerification).length;
      db.prepare(`INSERT INTO app_settings(key,value_json,updated_at) VALUES('ai_task_day',?,?)
        ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`).run(JSON.stringify(dayCounts),new Date().toISOString());
      result.status.prescreen.medianAskingEur=prioritized.median;
      result.status.prescreen.deferred=deferred;

      const total=pendingItems.length;

      if(!total){
        setTaskRunProgress(
          runId,
          90,
          'Sin anuncios nuevos por analizar',
          'Todos los resultados relevantes ya estaban procesados',
          0,
          0
        );
      }

      const requestedConcurrency=
        Number(process.env.AI_ANALYSIS_CONCURRENCY||2);

      const concurrency=Math.max(
        1,
        Math.min(
          4,
          Number.isFinite(requestedConcurrency)
            ? Math.trunc(requestedConcurrency)
            : 2
        )
      );

      let nextIndex=0;
      let processed=0;
      let succeeded=0;
      let failed=0;
      let capacityError=capacityErrorFromTriage;
      let stopRequested=!!capacityError;
      let lastAiError=null;
      let lastReportedProgress=30;

      const analysisStartedAt=Date.now();
      const worker=async()=>{
        while(!stopRequested){
          if(Date.now()-analysisStartedAt>analysisMaxMs)return;
          const idx=nextIndex++;

          if(idx>=total)return;

          if(runIsAborted(runId)){
            stopRequested=true;
            return;
          }

          const item=pendingItems[idx];

          const itemProgress=(pct,stage,detail='')=>{
            const local=Math.max(
              0,
              Math.min(100,Number(pct)||0)
            );

            const fractional=
              Math.min(
                total,
                processed+(local/100)
              );

            const calculated=
              30+
              Math.round(
                60*(fractional/Math.max(total,1))
              );

            lastReportedProgress=Math.max(
              lastReportedProgress,
              Math.min(89,calculated)
            );

            setTaskRunProgress(
              runId,
              lastReportedProgress,
              stage,
              `Anuncio ${idx+1}/${total}${detail?' · '+detail:''}`,
              processed,
              total
            );
          };

          try{
            await auctionAiStore.run(!!listingAuction(item)?.live,()=>analyzeWithGemini(
              item.id,
              taskId,
              task.analyze_images,
              itemProgress
            ));

            succeeded++;
            await sleep(250);
          }catch(e){
            if(isAiPolicyFlag(e)){
              // No es un fallo del bot: se descarta ese anuncio y se sigue.
              storePolicyReject(taskId,item,'análisis');
              console.log(`Task ${taskId}: anuncio ${item.id} descartado (filtro de seguridad de la IA).`);
              processed++;
              continue;
            }
            failed++;
            lastAiError=String(e?.message||e).slice(0,300);

            console.error(
              `AI task ${taskId} listing ${item.id}:`,
              e.message
            );

            if(
              e?.geminiCapacity===true ||
              /spending cap|quota|resource[_ -]?exhausted|rate limit|billing|credits|exceeded.*cap/i
                .test(String(e?.message||''))
            ){
              capacityError=e;
              stopRequested=true;
            }
          }

          processed++;

          lastReportedProgress=Math.max(
            lastReportedProgress,
            30+
            Math.round(
              60*(processed/Math.max(total,1))
            )
          );

          setTaskRunProgress(
            runId,
            Math.min(90,lastReportedProgress),
            `Procesados ${processed}/${total}`,
            processed<total
              ? 'Analizando anuncios restantes'
              : 'Análisis de anuncios completado',
            processed,
            total
          );
        }
      };

      if(total&&!stopRequested){
        const activeWorkers=Math.min(
          concurrency,
          total
        );

        console.log(
          `Task ${taskId}: analizando ${total} anuncios `+
          `con concurrencia ${activeWorkers}.`
        );

        await Promise.all(
          Array.from(
            {length:activeWorkers},
            ()=>worker()
          )
        );
        // Lo que no dio tiempo a analizar vuelve a salir en la siguiente pasada.
        if(nextIndex<total&&!stopRequested){
          for(const item of pendingItems.slice(nextIndex)){
            db.prepare('DELETE FROM search_session_items WHERE session_id=? AND listing_id=?').run(result.sessionId,item.id);
          }
          deferred=total-nextIndex;
          result.status.prescreen.deferred=deferred;
          console.log(`Task ${taskId}: ${deferred} anuncios pasan a la siguiente pasada (límite de ${Math.round(analysisMaxMs/60e3)} min de análisis por modelo).`);
        }
      }

      const allAiFailed=total>0&&succeeded===0&&failed>0;
      if(allAiFailed&&!capacityError){
        await reportHealthIssue(
          'gemini-errors',
          `Ningún análisis de ${aiProviderLabel()} ha funcionado en "${task.task_name}" (${failed}/${total} fallidos). `+
          `Último error: ${lastAiError||'desconocido'}`
        ).catch(e=>console.error('Health alert failed:',e.message));
      }else if(succeeded){
        clearHealthIssue('gemini-errors');
      }

      result.status.aiAnalysis={
        ok:!capacityError&&!allAiFailed,
        state:capacityError?'blocked':'finished',
        processed,
        succeeded,
        failed,
        total,
        concurrency:Math.min(concurrency,total||1),
        error:capacityError
          ? String(capacityError.message||capacityError)
          : null
      };

      // Presupuesto agotado: los que pasaron el triaje y no se han podido
      // analizar se enseñan igual, sin más proceso (regla de Nil).
      if(capacityError?.aiBudget){
        const has=db.prepare('SELECT 1 FROM task_analyses WHERE task_id=? AND listing_id=?');
        const left=pendingItems.filter(x=>!x._needsVerification&&x._triageScore!=null&&!has.get(taskId,x.id));
        if(left.length)await sendTriageOnlyAlerts(task,runId,left).catch(e=>console.error('Avisos del triaje:',e.message));
      }
      if(capacityError?.aiPace){
        console.log(`Task ${taskId}: ${capacityError.message}`);
      }else if(capacityError?.aiBudget){
        console.log(`Task ${taskId}: ${capacityError.message}`);
        await reportHealthIssue('ai-budget',`${capacityError.message} Los anuncios nuevos se siguen descargando pero no se analizan. Puedes subir el límite con la variable AI_DAILY_BUDGET_USD.`)
          .catch(e=>console.error('Health alert failed:',e.message));
      }else if(capacityError){
        console.error(
          `AI task ${taskId}: ${aiProviderLabel()} bloqueado por cuota/capacidad; `+
          `se detiene el análisis restante de esta tarea.`
        );

        db.prepare(
          'UPDATE task_runs SET source_status_json=? WHERE id=?'
        ).run(
          JSON.stringify(result.status),
          Number(runId)
        );

        const blockedError=
          capacityError instanceof Error
            ? capacityError
            : new Error(String(capacityError));

        blockedError.geminiCapacity=true;
        await reportHealthIssue(
          'gemini-capacity',
          `${aiProviderLabel()} no puede analizar anuncios (${blockedError.message}). `+
          `Los anuncios se siguen descargando pero NINGUNO se evalúa ni se avisa hasta que se resuelva (${aiBillingHint()}).`
        ).catch(e=>console.error('Health alert failed:',e.message));
        await reportRunHealth(result.status).catch(()=>{});
        throw blockedError;
      }
      if(succeeded)clearHealthIssue('gemini-capacity');

    }
    if(runIsAborted(runId)){
      return abortedResult(runId,result.sessionId);
    }
    const finalItems=sessionListings(result.sessionId);

    setTaskRunProgress(
      runId,
      94,
      'Preparando resultados',
      `${finalItems.length} anuncios en la ejecución`
    );

    try{
      const median=taskMedianAskingEur(taskId);
      const withRatio=finalItems.map(x=>({
        ...x,
        _priceVsTaskMedian:median&&Number(x.price_eur)>0?Number(x.price_eur)/median:null
      }));
      result.status.instantAlerts=await sendInstantAlerts(task,Number(runId),withRatio);
    }catch(e){
      result.status.instantAlerts={sent:0,error:e.message};
      console.error(`Instant alerts task ${taskId}:`,e.message);
    }
    try{
      result.status.opportunitiesSheet=await syncOpportunitiesSheet();
    }catch(e){
      result.status.opportunitiesSheet={ok:false,added:0,error:e.message};
      console.error(`Opportunities sheet task ${taskId}:`,e.message);
    }
    await reportRunHealth(result.status).catch(e=>console.error('Run health:',e.message));

    let emailResult=null;

    setTaskRunProgress(
      runId,
      96,
      'Procesando notificaciones',
      'Preparando email / digest si corresponde'
    );

    try{
      emailResult=await sendTaskDigest(
        task,
        Number(runId),
        result.sessionId,
        finalItems,
        result.status
      );
    }catch(e){
      emailResult={sent:false,error:e.message};
      console.error(`Email task ${taskId}:`,e.message);
    }

    setTaskRunProgress(
      runId,
      99,
      'Finalizando',
      'Guardando estado de la ejecución'
    );

    if(runIsAborted(runId)){
      return abortedResult(runId,result.sessionId);
    }
    const finished=new Date().toISOString();

    setTaskRunProgress(
      runId,
      100,
      'Finalizado',
      'Ejecución completada'
    );

    db.prepare('UPDATE task_runs SET session_id=?,status=?,source_status_json=?,finished_at=? WHERE id=?').run(result.sessionId,'finished',JSON.stringify({...result.status,email:emailResult}),finished,Number(runId));
    // El carril rápido no cuenta como la revisión completa del modelo.
    if(!fast)db.prepare('UPDATE tasks SET last_run_at=?,updated_at=? WHERE id=?').run(finished,finished,taskId);
    else{const key=fast==='auction'?'auction_lane_last':'fast_lane_last';const m=getSetting(key,{})||{};m[taskId]=finished;saveSetting(key,m);}
    return {runId,sessionId:result.sessionId,count:finalItems.length,status:result.status,email:emailResult,fast};
  }catch(e){
    const finished=new Date().toISOString();

    const pr=db.prepare(
      'SELECT progress_pct FROM task_runs WHERE id=?'
    ).get(Number(runId));

    setTaskRunProgress(
      runId,
      Number(pr?.progress_pct||0),
      'Error',
      e?.message||String(e)
    );

    db.prepare('UPDATE task_runs SET status=?,error=?,finished_at=? WHERE id=?').run('error',e?.message||String(e),finished,Number(runId));
    throw e;
  }finally{runningTaskIds.delete(taskId);}
}


function smtpConfig() {
  const host=String(process.env.SMTP_HOST||'').trim();
  const port=Number(process.env.SMTP_PORT||465);
  const secure=String(process.env.SMTP_SECURE||'true').toLowerCase()!=='false';
  const user=String(process.env.SMTP_USER||'').trim();
  const pass=String(process.env.SMTP_PASS||'').trim();
  const from=String(process.env.EMAIL_FROM||user||'').trim();
  return {host,port,secure,user,pass,from,configured:!!(host&&port&&from&&(user?pass:true))};
}
let mailTransport=null;
function getMailTransport(){
  const c=smtpConfig(); if(!c.configured) throw new Error('SMTP no está configurado en .env');
  if(!mailTransport) mailTransport=nodemailer.createTransport({host:c.host,port:c.port,secure:c.secure,auth:c.user?{user:c.user,pass:c.pass}:undefined});
  return {transport:mailTransport,config:c};
}
function htmlEsc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function moneyEmail(n){return n==null||!Number.isFinite(Number(n))?'—':new Intl.NumberFormat('es-ES',{style:'currency',currency:'EUR',maximumFractionDigits:0}).format(Number(n));}


function emailSafeJson(value){
  if(value && typeof value==='object')return value;

  try{
    const v=JSON.parse(String(value||'{}'));
    return v && typeof v==='object'?v:{};
  }catch{
    return {};
  }
}

function emailNumber(value){
  if(value===null||value===undefined||value===''){
    return null;
  }

  const n=Number(value);
  return Number.isFinite(n)?n:null;
}

function emailMoney(value){
  const n=emailNumber(value);

  if(n===null)return '—';

  return new Intl.NumberFormat(
    'es-ES',
    {
      style:'currency',
      currency:'EUR',
      maximumFractionDigits:2
    }
  ).format(n);
}

function emailPercent(value){
  const n=emailNumber(value);

  if(n===null)return '—';

  return `${Math.round(n<=1?n*100:n)}%`;
}

function emailReportBaseUrl(){
  return String(
    process.env.REPORT_BASE_URL ||
    'https://nmuxart-star.github.io/luxury-hunter-worker/report.html'
  )
    .trim()
    .replace(/#.*$/,'');
}

function emailReportPayload(value){
  return Buffer
    .from(JSON.stringify(value),'utf8')
    .toString('base64url');
}

function globalEmailOpportunityData(x){
  const verification=emailSafeJson(
    x?.verification_json
  );

  const exact=
    verification?.exact &&
    typeof verification.exact==='object'
      ? verification.exact
      : {};

  const market=
    verification?.market &&
    typeof verification.market==='object'
      ? verification.market
      : {};

  const marketplace=
    verification?.marketplace_verification &&
    typeof verification.marketplace_verification==='object'
      ? verification.marketplace_verification
      : {};

  const condition=
    (
      market?.target_condition &&
      typeof market.target_condition==='object'
    )
      ? market.target_condition
      : (
          exact?.condition &&
          typeof exact.condition==='object'
        )
          ? exact.condition
          : {};

  const resaleLow=emailNumber(
    x?.resale_low_eur
  );

  const resaleHigh=emailNumber(
    x?.resale_high_eur
  );

  const resaleVerified=
    (resaleLow!==null && resaleLow>0) ||
    (resaleHigh!==null && resaleHigh>0);

  const profitLow=resaleVerified
    ? emailNumber(x?.net_profit_low_eur)
    : null;

  const profitHigh=resaleVerified
    ? emailNumber(x?.net_profit_high_eur)
    : null;

  const imported=emailNumber(
    x?.landed_cost_eur ??
    x?.import_costs?.importedTotalEur
  );

  const marketConfidence=String(
    market?.model_market_confidence ??
    market?.market_confidence ??
    'LOW'
  ).toUpperCase();

  const relevantComps=Number(
    market?.model_relevant_comparable_count ??
    market?.relevant_comparable_count ??
    0
  );

  const marketSources=Number(
    market?.model_independent_source_count ??
    market?.independent_source_count ??
    0
  );

  const conditionMarketConfidence=String(
    market?.condition_market_confidence ??
    'LOW'
  ).toUpperCase();

  const conditionComps=Number(
    market?.condition_matched_comparable_count ??
    0
  );

  const conditionSources=Number(
    market?.condition_independent_source_count ??
    0
  );

  const conditionGrade=String(
    condition?.grade||'UNKNOWN'
  ).toUpperCase();

  const conditionScore=emailNumber(
    condition?.score
  );

  const conditionConfidence=emailNumber(
    condition?.confidence
  );

  const marketplaceStatus=String(
    marketplace?.status||'UNKNOWN'
  ).toUpperCase();

  let marketplaceService=String(
    marketplace?.service||''
  ).trim();

  if(!marketplaceService){
    const src=String(x?.source||'').toLowerCase();

    if(src==='bunjang'){
      marketplaceService='Bunjang Care';
    }else if(src==='xianyu'){
      marketplaceService='Xianyu Verification';
    }
  }

  const references=(
    Array.isArray(market?.research_references)
      ? market.research_references
      : Array.isArray(market?.comparables)
        ? market.comparables
        : []
  ).slice(0,8).map(r=>({
    source:r?.source||'',
    title:r?.title||'',
    url:r?.url||'',
    price:r?.price??null,
    currency:r?.currency||'',
    price_eur:r?.price_eur??null,
    listing_status:r?.listing_status||'UNKNOWN',
    match_level:r?.match_level||'UNKNOWN',
    match_reason_es:r?.match_reason_es||'',
    condition_grade:r?.condition_grade||'UNKNOWN',
    condition_relation_to_target:
      r?.condition_relation_to_target||'UNKNOWN',
    listing_date:r?.listing_date||null,
    sold_date:r?.sold_date||null,
    date_text:r?.date_text||null
  }));

  const queries=(
    Array.isArray(market?.web_search_queries)
      ? market.web_search_queries
      : []
  ).slice(0,8);

  const payload={
    generated_at:new Date().toISOString(),

    task:{
      name:x?.task_name||''
    },

    listing:{
      id:x?.id??null,
      title:x?.title||'',
      source:x?.source||'',
      purchase_via:x?.purchase_via||'',
      seller_name:x?.seller_name||'',
      url:x?.url||'',
      image_url:x?.image_url||'',
      original_price:x?.original_price??null,
      currency:x?.currency||'',
      price_eur:x?.price_eur??null
    },

    analysis:{
      decision:x?.decision||'',
      score:x?.opportunity_score??null,
      authenticity_risk:x?.authenticity_risk||'',
      liquidity:x?.liquidity||'',
      landed_cost_eur:imported,

      resale_low_eur:
        resaleVerified?resaleLow:null,

      resale_high_eur:
        resaleVerified?resaleHigh:null,

      profit_low_eur:profitLow,
      profit_high_eur:profitHigh
    },

    marketplace:{
      service:marketplaceService,
      status:marketplaceStatus,
      confidence:marketplace?.confidence||'',
      evidence_es:Array.isArray(
        marketplace?.evidence_es
      )
        ? marketplace.evidence_es.slice(0,6)
        : []
    },

    exact:{
      label:
        exact?.exact_variant_label ||
        exact?.family ||
        x?.model ||
        '',

      confidence:exact?.confidence??null,
      size:exact?.size||'',
      material:exact?.material||'',
      color:exact?.main_color||'',
      pattern:exact?.pattern||'',
      hardware:exact?.hardware||'',

      visual_evidence_es:
        Array.isArray(exact?.visual_evidence_es)
          ? exact.visual_evidence_es.slice(0,6)
          : [],

      uncertainties_es:
        Array.isArray(exact?.uncertainties_es)
          ? exact.uncertainties_es.slice(0,6)
          : []
    },

    condition:{
      grade:conditionGrade,
      score:conditionScore,
      confidence:conditionConfidence,

      visible_areas_es:
        Array.isArray(condition?.visible_areas_es)
          ? condition.visible_areas_es.slice(0,8)
          : [],

      defects_es:
        Array.isArray(condition?.defects_es)
          ? condition.defects_es.slice(0,8)
          : [],

      positive_signals_es:
        Array.isArray(condition?.positive_signals_es)
          ? condition.positive_signals_es.slice(0,8)
          : [],

      missing_views_es:
        Array.isArray(condition?.missing_views_es)
          ? condition.missing_views_es.slice(0,8)
          : []
    },

    market:{
      confidence:marketConfidence,
      relevant_comps:relevantComps,
      sources:marketSources,

      condition_confidence:
        conditionMarketConfidence,

      condition_comps:conditionComps,
      condition_sources:conditionSources,

      search_passes:Number(
        market?.search_passes||0
      ),

      results_found:Number(
        market?.research_candidate_count ??
        market?.raw_comparable_count ??
        references.length
      ),

      vision_ok:
        market?.vision_web_detection?.ok===true,

      vision_candidates:Number(
        market?.visual_candidate_count||0
      ),

      vision_error:
        market?.vision_web_detection?.error||'',

      resale_estimate_source:
        verification?.final?.resale_estimate_source ||
        market?.resale_estimate_source ||
        'UNAVAILABLE',

      resale_estimate_confidence:
        verification?.final?.resale_estimate_confidence ||
        market?.resale_estimate_confidence ||
        market?.ai_resale_estimate?.confidence ||
        'LOW',

      ai_resale_estimate:
        market?.ai_resale_estimate||null,

      checked_at:
        market?.checked_at ||
        verification?.verified_at ||
        '',

      queries,
      references
    },

    import_costs:
      x?.import_costs &&
      typeof x.import_costs==='object'
        ? x.import_costs
        : {}
  };

  const reportUrl=
    `${emailReportBaseUrl()}#${
      emailReportPayload(payload)
    }`;

  return {
    ...payload,
    reportUrl,
    resaleVerified
  };
}

function globalEmailMarketplaceText(d){
  const service=d?.marketplace?.service;

  if(!service){
    return 'No aplica';
  }

  const status=String(
    d?.marketplace?.status||'UNKNOWN'
  ).toUpperCase();

  if(status==='PASSED'){
    return `${service}: SUPERADO`;
  }

  if(status==='AVAILABLE'){
    return `${service}: DISPONIBLE`;
  }

  if(status==='FAILED'){
    return `${service}: NO SUPERADO`;
  }

  if(status==='UNAVAILABLE'){
    return `${service}: NO DISPONIBLE`;
  }

  return `${service}: NO DETECTADO`;
}

function globalEmailConditionText(d){
  const c=d?.condition||{};

  if(!c.grade || c.grade==='UNKNOWN'){
    return 'Sin información suficiente';
  }

  const parts=[c.grade];

  if(emailNumber(c.score)!==null){
    parts.push(
      `${Math.round(Number(c.score))}/100`
    );
  }

  if(emailNumber(c.confidence)!==null){
    parts.push(
      `confianza ${emailPercent(c.confidence)}`
    );
  }

  return parts.join(' · ');
}

function globalEmailResaleText(d){
  const low=d?.analysis?.resale_low_eur;
  const high=d?.analysis?.resale_high_eur;

  const lowOk=
    low!==null &&
    low!==undefined &&
    low!=='' &&
    Number.isFinite(Number(low));

  const highOk=
    high!==null &&
    high!==undefined &&
    high!=='' &&
    Number.isFinite(Number(high));

  if(!lowOk&&!highOk){
    return 'Sin estimación disponible';
  }

  const price=
    lowOk&&highOk
      ? `${emailMoney(low)} – ${emailMoney(high)}`
      : lowOk
        ? emailMoney(low)
        : emailMoney(high);

  const source=
    String(
      d?.market?.resale_estimate_source||
      'UNAVAILABLE'
    ).toUpperCase();

  const confidence=
    String(
      d?.market?.resale_estimate_confidence||
      'LOW'
    ).toUpperCase();

  if(source==='MARKET_ANALYSIS'){
    return `${price} · ANÁLISIS DE MERCADO`;
  }

  if(source==='AI_ESTIMATE'){
    return `${price} · ESTIMACIÓN IA · confianza ${confidence}`;
  }

  return `${price} · origen no disponible`;
}

function globalEmailProfitText(d){
  const low=d?.analysis?.profit_low_eur;
  const high=d?.analysis?.profit_high_eur;

  const lowOk=
    low!==null &&
    low!==undefined &&
    low!=='' &&
    Number.isFinite(Number(low));

  const highOk=
    high!==null &&
    high!==undefined &&
    high!=='' &&
    Number.isFinite(Number(high));

  if(!lowOk&&!highOk){
    return 'Sin estimación disponible';
  }

  const price=
    lowOk&&highOk
      ? `${emailMoney(low)} – ${emailMoney(high)}`
      : lowOk
        ? emailMoney(low)
        : emailMoney(high);

  const source=
    String(
      d?.market?.resale_estimate_source||
      ''
    ).toUpperCase();

  if(source==='AI_ESTIMATE'){
    return `${price} · orientativo (estimación IA)`;
  }

  if(source==='MARKET_ANALYSIS'){
    return `${price} · basado en análisis de mercado`;
  }

  return price;
}

function globalEmailOpportunityRow(x,index){
  const d=globalEmailOpportunityData(x);

  const exactLabel=
    d.exact.label||x?.model||'—';

  const exactConfidence=
    emailNumber(d.exact.confidence)!==null
      ? emailPercent(d.exact.confidence)
      : '—';

  const image=d.listing.image_url
    ? `<img
         src="${htmlEsc(d.listing.image_url)}"
         alt=""
         width="120"
         height="120"
         style="
           display:block;
           width:120px;
           height:120px;
           object-fit:cover;
           border-radius:10px;
           border:1px solid #e5e7eb;
           margin-bottom:10px;
         "
       >`
    : '';

  return `
    <tr>
      <td
        valign="top"
        style="
          padding:16px;
          border-bottom:1px solid #e5e7eb;
          width:40%;
        "
      >
        ${image}

        <b style="
          font-size:16px;
          color:#111827;
        ">
          ${index}. ${htmlEsc(x.task_name||'')}
        </b>

        <div style="
          margin-top:5px;
          font-weight:700;
          color:#111827;
        ">
          ${htmlEsc(d.listing.title||'(sin título)')}
        </div>

        <div style="
          margin-top:5px;
          color:#6b7280;
          font-size:13px;
        ">
          ${htmlEsc(d.listing.source||'')}
          ${
            d.listing.price_eur!=null
              ? ` · producto ${
                  emailMoney(d.listing.price_eur)
                }`
              : ''
          }
          ${
            d.analysis.landed_cost_eur!=null
              ? ` · importado ${
                  emailMoney(
                    d.analysis.landed_cost_eur
                  )
                }`
              : ''
          }
        </div>

        <div style="
          margin-top:10px;
          font-size:13px;
          line-height:1.5;
        ">
          <b>Exact model:</b>
          ${htmlEsc(exactLabel)}
          · ${htmlEsc(exactConfidence)}
          <br>

          <b>Market:</b>
          ${htmlEsc(d.market.confidence)}
          · ${d.market.relevant_comps} comparables
          · ${d.market.sources} fuentes
        </div>
      </td>

      <td
        valign="top"
        style="
          padding:16px;
          border-bottom:1px solid #e5e7eb;
          width:22%;
        "
      >
        <b style="
          font-size:16px;
          color:#111827;
        ">
          ${htmlEsc(d.analysis.decision||'—')}
        </b>

        ${
          d.analysis.score!==null &&
          d.analysis.score!==undefined
            ? `<div style="margin-top:4px">
                Score ${htmlEsc(d.analysis.score)}
               </div>`
            : ''
        }

        <div style="
          margin-top:7px;
          color:#6b7280;
          line-height:1.5;
        ">
          Auth:
          ${htmlEsc(
            d.analysis.authenticity_risk||'—'
          )}
          <br>

          Liquidez:
          ${htmlEsc(
            d.analysis.liquidity||'—'
          )}
        </div>

        <div style="
          margin-top:10px;
          font-size:13px;
          line-height:1.55;
        ">
          <b>Control autenticidad:</b><br>
          ${htmlEsc(
            globalEmailMarketplaceText(d)
          )}
        </div>

        <div style="
          margin-top:10px;
          font-size:13px;
          line-height:1.55;
        ">
          <b>Informe de calidad:</b><br>
          ${htmlEsc(
            globalEmailConditionText(d)
          )}
        </div>
      </td>

      <td
        valign="top"
        style="
          padding:16px;
          border-bottom:1px solid #e5e7eb;
          width:23%;
          line-height:1.65;
        "
      >
        <span style="color:#6b7280">
          Final importado
        </span>
        <br>
        <b>
          ${emailMoney(
            d.analysis.landed_cost_eur
          )}
        </b>

        <div style="margin-top:10px">
          <span style="color:#6b7280">
            Reventa estimada
          </span>
          <br>
          <b>
            ${htmlEsc(
              globalEmailResaleText(d)
            )}
          </b>
        </div>

        <div style="margin-top:10px">
          <span style="color:#6b7280">
            Beneficio tras reventa
          </span>
          <br>
          <b>
            ${htmlEsc(
              globalEmailProfitText(d)
            )}
          </b>
        </div>
      </td>

      <td
        valign="top"
        style="
          padding:16px;
          border-bottom:1px solid #e5e7eb;
          width:15%;
        "
      >
        ${
          d.listing.url
            ? `<a
                 href="${htmlEsc(d.listing.url)}"
                 target="_blank"
                 style="
                   display:block;
                   padding:9px 11px;
                   border-radius:8px;
                   background:#111827;
                   color:#ffffff;
                   text-decoration:none;
                   font-weight:700;
                   text-align:center;
                   margin-bottom:8px;
                 "
               >
                 Abrir anuncio
               </a>`
            : ''
        }

        <a
          href="${htmlEsc(d.reportUrl)}"
          target="_blank"
          style="
            display:block;
            padding:9px 11px;
            border-radius:8px;
            background:#6d4aff;
            color:#ffffff;
            text-decoration:none;
            font-weight:700;
            text-align:center;
          "
        >
          Abrir informe
        </a>
      </td>
    </tr>
  `;
}

// GLOBAL EMAIL DEDUPE V1
function listingWasEverEmailed(listingId){
  return !!db.prepare(`
    SELECT 1
    FROM notifications
    WHERE listing_id=?
      AND kind IN ('email','global-digest')
    LIMIT 1
  `).get(Number(listingId));
}

function qualifiesForEmail(task,item){
  if(noPriceVeto(item))return false;
  if(task.decision_mode==='ai'){
    if(!item.decision || !(task.notify_decisions||[]).includes(item.decision)) return false;
    if(task.notify_min_score!=null && Number(item.opportunity_score||0)<Number(task.notify_min_score)) return false;
    if(task.notify_min_profit_eur!=null && Number(item.net_profit_low_eur??-Infinity)<Number(task.notify_min_profit_eur)) return false;
  }
  if(listingWasEverEmailed(item.id)) return false;
  return true;
}
async function sendTaskDigest(task,runId,sessionId,items,sourceStatus){
  if(!task.email_enabled) return {sent:false,reason:'disabled'};

  const c=smtpConfig();
  if(!c.configured) return {sent:false,reason:'smtp-not-configured'};

  const allItems=[...(items||[])];

  allItems.sort((a,b)=>
    Number(b.opportunity_score||0)-Number(a.opportunity_score||0) ||
    Number(b.net_profit_low_eur||-1)-Number(a.net_profit_low_eur||-1)
  );

  // Mantener aparte las oportunidades que cumplen los criterios de alerta.
  // Solo estas se registran en notifications para no romper "solo nuevos".
  let alertSelected=allItems.filter(x=>qualifiesForEmail(task,x));

  const decisionCounts={
    'STRONG BUY':0,
    'BUY':0,
    'WATCH':0,
    'REVIEW':0,
    'REJECT':0
  };

  const sourceCounts={};

  for(const x of allItems){
    const decision=String(x.decision||'').toUpperCase();
    if(decisionCounts[decision]!==undefined) decisionCounts[decision]++;

    const source=String(x.source||'unknown');
    sourceCounts[source]=(sourceCounts[source]||0)+1;
  }

  function verificationForEmail(x){
    let v={};
    try{v=JSON.parse(x.verification_json||'{}')}catch{}
    const mv=v.marketplace_verification||{};
    const mvStatus=String(mv.status||'').toUpperCase();
    const mvHtml=['AVAILABLE','PASSED','FAILED','UNAVAILABLE'].includes(mvStatus)
      ? `<div style="margin-top:8px;padding:7px 8px;border:1px solid #e5e7eb;border-radius:6px"><b>${htmlEsc(mv.service||'Marketplace verification')}:</b> ${htmlEsc(mvStatus)}${mvStatus==='AVAILABLE'?'<br><span style="color:#6b7280">Servicio disponible; no equivale a autenticidad confirmada.</span>':''}${mvStatus==='PASSED'?'<br><span style="color:#6b7280">Resultado explicito superado; sigue siendo una senal adicional, no una garantia absoluta.</span>':''}</div>`
      : '';
    if(v.status==='verified'){
      const exact=v.exact||{},market=v.market||{};
      const comps=Array.isArray(market.comparables)?market.comparables:[];
      const links=comps.slice(0,4).map(c=>{const label=`${c.source||'Source'} - ${moneyEmail(c.price_eur)} - ${c.match_level||''}`;return c.url?`<a href="${htmlEsc(c.url)}">${htmlEsc(label)}</a>`:htmlEsc(label)}).join('<br>');
      return `${mvHtml}<div style="margin-top:8px;padding:8px;border:1px solid #e5e7eb;border-radius:6px"><b>Exact model:</b> ${htmlEsc(exact.exact_variant_label||exact.family||'-')} - ${Math.round(Number(exact.confidence||0)*100)}%<br><b>Market confidence:</b> ${htmlEsc(market.market_confidence||'LOW')} - ${Number(market.relevant_comparable_count||0)} comparables${links?`<br>${links}`:''}</div>`;
    }
    if(v.status==='error'||v.status==='legacy_pending')return `${mvHtml}<div style="margin-top:8px"><b>Verification:</b> pending/incomplete</div>`;
    return mvHtml;
  }
  function reasonsForEmail(x){
    let reasons=
      x.reject_reasons ??
      x.reasons ??
      x.analysis?.reject_reasons ??
      x.analysis?.reasons ??
      [];

    if(!Array.isArray(reasons)) reasons=[];

    if(!reasons.length && x.notes){
      reasons=[String(x.notes)];
    }

    return reasons
      .filter(Boolean)
      .slice(0,4)
      .map(r=>`<li>${htmlEsc(r)}</li>`)
      .join('');
  }

  const rows=allItems.length
    ? allItems.map((x,index)=>{
        const reasons=reasonsForEmail(x);
        const imported=
          x.import_costs?.importedTotalEur ??
          x.landed_cost_eur ??
          null;

        const resaleLow=x.resale_low_eur;
        const resaleHigh=x.resale_high_eur;

        return `
          <tr>
            <td style="padding:14px;border-bottom:1px solid #e5e7eb;vertical-align:top">
              <b>${index+1}. ${htmlEsc(x.brand||'')} ${htmlEsc(x.model||x.title||'')}</b>
              <br>
              <span style="color:#6b7280">
                ${htmlEsc(x.source||'—')} · producto ${moneyEmail(x.price_eur)} · importado ${moneyEmail(imported)}
              </span>
              ${reasons ? `<ul style="margin:8px 0 0 18px;padding:0;color:#4b5563">${reasons}</ul>` : ''}
              ${verificationForEmail(x)}
            </td>

            <td style="padding:14px;border-bottom:1px solid #e5e7eb;vertical-align:top">
              <b>${htmlEsc(x.decision||'MATCH')}</b>
              <br>Score ${htmlEsc(x.opportunity_score??'—')}
              <br><span style="color:#6b7280">Auth: ${htmlEsc(x.authenticity_risk||'—')}</span>
              <br><span style="color:#6b7280">Liquidez: ${htmlEsc(x.liquidity||'—')}</span>
            </td>

            <td style="padding:14px;border-bottom:1px solid #e5e7eb;vertical-align:top">
              Reventa: ${moneyEmail(resaleLow)} – ${moneyEmail(resaleHigh)}
              <br>
              <b>Beneficio: ${moneyEmail(x.net_profit_low_eur)} – ${moneyEmail(x.net_profit_high_eur)}</b>
            </td>

            <td style="padding:14px;border-bottom:1px solid #e5e7eb;vertical-align:top">
              <a href="${htmlEsc(x.url||'#')}">Abrir anuncio</a>
            </td>
          </tr>
        `;
      }).join('')
    : `
      <tr>
        <td colspan="4" style="padding:18px;text-align:center;color:#6b7280">
          No se encontraron productos en esta ejecución.
        </td>
      </tr>
    `;

  const sourceKeys=[
    ...new Set([
      ...Object.keys(sourceStatus||{}),
      ...Object.keys(sourceCounts)
    ])
  ];

  const sourceRows=sourceKeys.length
    ? sourceKeys.map(source=>{
        const status=(sourceStatus||{})[source]||{};
        const ok=status?.ok!==false;

        const message=
          status?.warning ||
          status?.error ||
          status?.message ||
          '';

        return `
          <tr>
            <td style="padding:8px;border-bottom:1px solid #e5e7eb">
              <b>${htmlEsc(source)}</b>
            </td>
            <td style="padding:8px;border-bottom:1px solid #e5e7eb">
              ${sourceCounts[source]||0} productos
            </td>
            <td style="padding:8px;border-bottom:1px solid #e5e7eb">
              ${ok?'✅ OK':'⚠️ Error'}
              ${message?`<br><span style="color:#6b7280">${htmlEsc(message)}</span>`:''}
            </td>
          </tr>
        `;
      }).join('')
    : `
      <tr>
        <td colspan="3" style="padding:8px;color:#6b7280">Sin datos de fuentes.</td>
      </tr>
    `;

  const subject=
    `Luxury Hunter · ${task.task_name} · ${allItems.length} productos · ` +
    `${decisionCounts['STRONG BUY']} SB · ${decisionCounts['BUY']} BUY`;

  const html=`
    <div style="font-family:Arial,sans-serif;color:#111827;max-width:1000px;margin:auto">

      <h2 style="margin-bottom:4px">${htmlEsc(task.task_name)}</h2>

      <p style="color:#6b7280;margin-top:0">
        Informe completo de la ejecución automática de Luxury Hunter.
      </p>

      <div style="background:#f3f4f6;padding:16px;border-radius:8px;margin:18px 0">
        <b>Total analizados: ${allItems.length}</b>
        <br><br>
        STRONG BUY: <b>${decisionCounts['STRONG BUY']}</b><br>
        BUY: <b>${decisionCounts['BUY']}</b><br>
        WATCH: <b>${decisionCounts['WATCH']}</b><br>
        REVIEW: <b>${decisionCounts['REVIEW']}</b><br>
        REJECT: <b>${decisionCounts['REJECT']}</b><br>
        <br>
        Oportunidades que cumplen los criterios de alerta: <b>${alertSelected.length}</b>
      </div>

      <h3>Fuentes</h3>

      <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
        <thead>
          <tr>
            <th align="left" style="padding:8px;background:#f3f4f6">Marketplace</th>
            <th align="left" style="padding:8px;background:#f3f4f6">Resultados</th>
            <th align="left" style="padding:8px;background:#f3f4f6">Estado</th>
          </tr>
        </thead>
        <tbody>
          ${sourceRows}
        </tbody>
      </table>

      <h3>Todos los productos analizados</h3>

      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr>
            <th align="left" style="padding:10px;background:#f3f4f6">Producto</th>
            <th align="left" style="padding:10px;background:#f3f4f6">Análisis</th>
            <th align="left" style="padding:10px;background:#f3f4f6">Economía</th>
            <th align="left" style="padding:10px;background:#f3f4f6">Link</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>

      <p style="margin-top:20px;color:#6b7280;font-size:12px">
        Las estimaciones de autenticidad, reventa y beneficio son orientativas.
        Revisa siempre el anuncio y la autenticación antes de realizar una compra.
      </p>

    </div>
  `;

  const {transport,config}=getMailTransport();

  await transport.sendMail({
    from:config.from,
    to:task.email_to,
    subject,
    html,
    text:
      `${task.task_name}\n` +
      `Total analizados: ${allItems.length}\n` +
      `STRONG BUY: ${decisionCounts['STRONG BUY']}\n` +
      `BUY: ${decisionCounts['BUY']}\n` +
      `WATCH: ${decisionCounts['WATCH']}\n` +
      `REJECT: ${decisionCounts['REJECT']}\n`
  });

  // Solo registrar como "notificados" los productos que realmente
  // cumplen los criterios de oportunidad.
  const now=new Date().toISOString();

  const ins=db.prepare(
    "INSERT OR IGNORE INTO notifications(task_id,listing_id,run_id,kind,sent_to,sent_at) VALUES(?,?,?,'email',?,?)"
  );

  for(const x of alertSelected){
    ins.run(task.id,x.id,runId,task.email_to,now);
  }

  db.prepare(
    'INSERT INTO runs(source,kind,summary,created_at) VALUES(?,?,?,?)'
  ).run(
    'email',
    'full-report',
    `Task ${task.id}; report ${allItems.length} items; ${alertSelected.length} alerts; sent to ${task.email_to}`,
    now
  );

  return {
    sent:true,
    count:allItems.length,
    alerts:alertSelected.length,
    to:task.email_to
  };
}


// GLOBAL DIGEST HOURLY V3
function globalEmailSetting(override={}){
  const fallback={
    enabled:true,
    to:null,
    decisions:['STRONG BUY','BUY','WATCH'],
    always_send:true,
    task_interval_minutes:60,
    digest_interval_minutes:180,
    timezone:'Europe/Madrid',
    subject_prefix:'Resumen',
    started_at:null,
    scope:'all_task_runs_since_previous_digest',
    cloud_only:true
  };
  const stored=getSetting('global_email',fallback)||fallback;
  return {
    ...fallback,
    ...stored,
    ...(override&&typeof override==='object'?override:{}),
    decisions:Array.isArray(override?.decisions)&&override.decisions.length
      ? override.decisions
      : Array.isArray(stored?.decisions)&&stored.decisions.length
        ? stored.decisions
        : fallback.decisions
  };
}
function saveGlobalDigestState(value){
  const now=new Date().toISOString();
  db.prepare(`INSERT INTO app_settings(key,value_json,updated_at)
    VALUES('global_digest_state',?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
    .run(JSON.stringify(value||{}),now);
}
function globalDigestMadridLabel(date=new Date(),timezone='Europe/Madrid'){
  return new Intl.DateTimeFormat('es-ES',{
    timeZone:timezone,
    hour:'2-digit',
    minute:'2-digit',
    hour12:false
  }).format(date);
}
function globalDigestMadridFullLabel(date=new Date(),timezone='Europe/Madrid'){
  return new Intl.DateTimeFormat('es-ES',{
    timeZone:timezone,
    day:'2-digit',
    month:'2-digit',
    year:'numeric',
    hour:'2-digit',
    minute:'2-digit',
    hour12:false
  }).format(date);
}
function globalDigestVerificationHtml(x){
  let v={};
  try{v=JSON.parse(x.verification_json||'{}')}catch{}
  const mv=v.marketplace_verification||{};
  const mvStatus=String(mv.status||'').toUpperCase();
  const mvHtml=['AVAILABLE','PASSED','FAILED'].includes(mvStatus)
    ? `<div style="margin-top:7px"><b>${htmlEsc(mv.service||'Marketplace verification')}:</b> ${htmlEsc(mvStatus)}</div>`
    : '';
  if(v.status==='verified'){
    const exact=v.exact||{},market=v.market||{};
    const comps=Array.isArray(market.comparables)?market.comparables:[];
    const links=comps.slice(0,3).map(c=>{
      const label=`${c.source||'Source'} - ${moneyEmail(c.price_eur)} - ${c.match_level||''}`;
      return c.url?`<a href="${htmlEsc(c.url)}">${htmlEsc(label)}</a>`:htmlEsc(label);
    }).join('<br>');
    return `${mvHtml}<div style="margin-top:7px;color:#4b5563"><b>Exact model:</b> ${htmlEsc(exact.exact_variant_label||exact.family||'-')} - ${Math.round(Number(exact.confidence||0)*100)}%<br><b>Market confidence:</b> ${htmlEsc(market.market_confidence||'LOW')} - ${Number(market.relevant_comparable_count||0)} comparables${links?`<br>${links}`:''}</div>`;
  }
  return mvHtml;
}
async function sendGlobalDigest({to=null,force=false,config={}}={}){
  const setting=globalEmailSetting(config);
  if(setting.enabled===false)return {sent:false,reason:'disabled'};

  const smtp=smtpConfig();
  if(!smtp.configured)return {sent:false,reason:'smtp-not-configured'};

  const recipient=String(to||setting.to||process.env.GLOBAL_EMAIL_TO||process.env.SMTP_USER||'').trim();
  if(!recipient)return {sent:false,reason:'missing-recipient'};

  const now=new Date();
  // Por defecto un informe al día (DIGEST_SCHEDULE=daily) a partir de
  // DIGEST_DAILY_HOUR en la zona horaria configurada. DIGEST_SCHEDULE=interval
  // recupera el comportamiento anterior (cada digest_interval_minutes).
  const daily=String(process.env.DIGEST_SCHEDULE||setting.schedule||'daily').toLowerCase()!=='interval';
  const timezone=setting.timezone||'Europe/Madrid';
  const intervalMinutes=daily?1440:Math.max(60,Number(setting.digest_interval_minutes||180));
  const intervalMs=intervalMinutes*60000;
  const state=getSetting('global_digest_state',{last_sent_at:null});
  const anchorRaw=state?.last_sent_at||setting.started_at||new Date(now.getTime()-intervalMs).toISOString();
  const anchorDate=new Date(anchorRaw);
  const anchor=Number.isFinite(anchorDate.getTime())?anchorDate:new Date(now.getTime()-intervalMs);
  const elapsedMs=now.getTime()-anchor.getTime();

  if(daily&&!force){
    const dayKey=d=>new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
    const hourOf=d=>Number(new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',hourCycle:'h23'}).format(d));
    const dailyHour=Number(process.env.DIGEST_DAILY_HOUR??setting.daily_hour??9);
    const sentToday=!!state?.last_sent_at&&dayKey(new Date(state.last_sent_at))===dayKey(now);
    if(sentToday||hourOf(now)<dailyHour){
      return {
        sent:false,
        reason:'not-due',
        schedule:'daily',
        daily_hour:dailyHour,
        already_sent_today:sentToday,
        window_start:anchor.toISOString()
      };
    }
  }else if(!force && elapsedMs < intervalMs-120000){
    return {
      sent:false,
      reason:'not-due',
      minutes_until_due:Math.max(0,Math.ceil((intervalMs-elapsedMs)/60000)),
      window_start:anchor.toISOString()
    };
  }

  const runs=db.prepare(`
    SELECT r.*,t.task_name
    FROM task_runs r
    JOIN tasks t ON t.id=r.task_id
    WHERE r.started_at>=?
      AND r.started_at<=?
    ORDER BY r.started_at ASC,r.id ASC
  `).all(anchor.toISOString(),now.toISOString());

  const summariesByTask=new Map();
  const opportunityMap=new Map();
  let totalAnalyzed=0;
  let previouslyEmailedSkipped=0;

  for(const run of runs){
    const taskName=run.task_name||`Task ${run.task_id}`;
    if(!summariesByTask.has(taskName)){
      summariesByTask.set(taskName,{
        task_name:taskName,
        runs:0,
        analyzed:0,
        status_ok:0,
        status_error:0,
        'STRONG BUY':0,
        'BUY':0,
        'WATCH':0
      });
    }
    const summary=summariesByTask.get(taskName);
    summary.runs++;
    if(run.status==='finished')summary.status_ok++;
    else if(run.status==='error')summary.status_error++;

    const items=run.session_id?sessionListings(run.session_id):[];
    summary.analyzed+=items.length;
    totalAnalyzed+=items.length;

    for(const x of items){
      const decision=String(x.decision||'').toUpperCase();
      if(!['STRONG BUY','BUY','WATCH'].includes(decision))continue;
      if(noPriceVeto(x))continue;

      if(listingFeedback(x.id)==='not_interested')continue;
      if(listingWasEverEmailed(x.id)){
        previouslyEmailedSkipped++;
        continue;
      }

      const key=String(x.id);
      opportunityMap.set(key,{
        ...x,
        _task_name:taskName,
        _task_id:run.task_id,
        _run_id:run.id,
        _run_started_at:run.started_at
      });
    }
  }

  const opportunities=[...opportunityMap.values()];
  const rank={'STRONG BUY':0,'BUY':1,'WATCH':2};
  opportunities.sort((a,b)=>
    (rank[String(a.decision||'').toUpperCase()]??9)-(rank[String(b.decision||'').toUpperCase()]??9) ||
    Number(b.opportunity_score??-1)-Number(a.opportunity_score??-1) ||
    Number(b.net_profit_low_eur??-1)-Number(a.net_profit_low_eur??-1)
  );

  const counts={'STRONG BUY':0,'BUY':0,'WATCH':0};
  for(const x of opportunities){
    const d=String(x.decision||'').toUpperCase();
    counts[d]++;
    const s=summariesByTask.get(x._task_name);
    if(s)s[d]++;
  }

  const windowHours=Math.max(1,Math.round(elapsedMs/3600000));
  const windowLabel=windowHours>=20&&windowHours<=30
    ? 'las ultimas 24 horas'
    : `las ultimas ${windowHours} horas`;
  const summaries=[...summariesByTask.values()];
  const taskRows=summaries.length?summaries.map(s=>`
    <tr>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb"><b>${htmlEsc(s.task_name)}</b></td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb">${Number(s.runs||0)}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb">${Number(s.analyzed||0)}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb">${Number(s['STRONG BUY']||0)} / ${Number(s.BUY||0)} / ${Number(s.WATCH||0)}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb">${Number(s.status_error||0)?`${s.status_error} error(es)`:'OK'}</td>
    </tr>`).join(''):`<tr><td colspan="5" style="padding:12px;color:#6b7280">No hubo ejecuciones registradas en esta ventana.</td></tr>`;

  const rows=opportunities.length
    ? opportunities.map(
        (x,i)=>globalEmailOpportunityRow(x,i+1)
      ).join('')
    : `<tr>
        <td
          colspan="4"
          style="
            padding:22px;
            text-align:center;
            color:#6b7280;
          "
        >
          <b>No ha habido novedades.</b><br>
          No se detectaron STRONG BUY, BUY ni WATCH
          durante ${htmlEsc(windowLabel)}.
        </td>
      </tr>`;

  const failedRuns=runs.filter(r=>r.status==='error');
  const errorCounts=new Map();
  for(const r of failedRuns){
    const msg=String(r.error||'Error desconocido').slice(0,220);
    errorCounts.set(msg,(errorCounts.get(msg)||0)+1);
  }
  const healthBanner=failedRuns.length
    ? `<div style="background:#fef2f2;border:1px solid #fecaca;color:#991b1b;padding:16px;border-radius:8px;margin:18px 0">
        <b>⚠️ ${failedRuns.length} de ${runs.length} ejecuciones han fallado en esta ventana.</b>
        El bot puede no estar evaluando anuncios, así que "0 oportunidades" no significa que no las haya.<br><br>
        ${[...errorCounts.entries()].slice(0,3).map(([m,n])=>`• ${htmlEsc(m)} <b>(${n}×)</b>`).join('<br>')}
      </div>`
    : '';

  const sendTime=globalDigestMadridLabel(now,setting.timezone||'Europe/Madrid');
  const sendFull=globalDigestMadridFullLabel(now,setting.timezone||'Europe/Madrid');
  const subject=`${failedRuns.length?'⚠️ ':''}${setting.subject_prefix||'Resumen'}${daily?` diario - ${new Intl.DateTimeFormat('es-ES',{timeZone:timezone,day:'numeric',month:'long'}).format(now)}`:` - ${sendTime}`}${failedRuns.length?` (${failedRuns.length} fallos)`:''}`;
  const headline=opportunities.length
    ? `${opportunities.length} anuncio${opportunities.length===1?'':'s'} interesante${opportunities.length===1?'':'s'} en ${windowLabel}`
    : 'No ha habido novedades';

  const html=`
    <div style="font-family:Arial,sans-serif;color:#111827;max-width:1000px;margin:auto">
      <h2 style="margin-bottom:4px">Resumen Luxury Hunter</h2>
      <p style="color:#6b7280;margin-top:0">Enviado: ${htmlEsc(sendFull)} - Ventana resumida: ${htmlEsc(windowLabel)}.</p>
      ${healthBanner}
      <div style="background:#f3f4f6;padding:16px;border-radius:8px;margin:18px 0">
        <b>${htmlEsc(headline)}</b><br><br>
        STRONG BUY: <b>${counts['STRONG BUY']}</b><br>
        BUY: <b>${counts.BUY}</b><br>
        WATCH: <b>${counts.WATCH}</b><br>
        Tareas con ejecuciones: <b>${summaries.length}</b><br>
        Productos analizados: <b>${totalAnalyzed}</b><br>
        ${aiProvider()==='openai'?`Gasto IA hoy: <b>${getAiSpend().usd.toFixed(2)} $</b> de ${Number.isFinite(aiDailyBudgetUsd())?aiDailyBudgetUsd().toFixed(2)+' $':'sin límite'} (${getAiSpend().calls||0} llamadas)`:''}
      </div>
      <h3>Resumen por modelo / tarea</h3>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
        <thead><tr>
          <th align="left" style="padding:8px;background:#f3f4f6">Tarea</th>
          <th align="left" style="padding:8px;background:#f3f4f6">Runs</th>
          <th align="left" style="padding:8px;background:#f3f4f6">Analizados</th>
          <th align="left" style="padding:8px;background:#f3f4f6">SB / BUY / WATCH</th>
          <th align="left" style="padding:8px;background:#f3f4f6">Estado</th>
        </tr></thead>
        <tbody>${taskRows}</tbody>
      </table>
      <h3>Anuncios interesantes</h3>
      <table style="width:100%;border-collapse:collapse">
        <thead><tr>
          <th align="left" style="padding:10px;background:#f3f4f6">Producto</th>
          <th align="left" style="padding:10px;background:#f3f4f6">Decision</th>
          <th align="left" style="padding:10px;background:#f3f4f6">Economia</th>
          <th align="left" style="padding:10px;background:#f3f4f6">Link</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin-top:20px;color:#6b7280;font-size:12px">Solo se muestran STRONG BUY, BUY y WATCH. REJECT y REVIEW se omiten. Revisa siempre el anuncio y la autenticacion antes de comprar.</p>
    </div>`;

  const {transport,config:mailConfig}=getMailTransport();
  await transport.sendMail({
    from:mailConfig.from,
    to:recipient,
    subject,
    html,
    text:`${failedRuns.length?`⚠️ ${failedRuns.length}/${runs.length} ejecuciones fallidas: ${[...errorCounts.keys()][0]}\n`:''}Resumen ${sendTime}\nSTRONG BUY: ${counts['STRONG BUY']}\nBUY: ${counts.BUY}\nWATCH: ${counts.WATCH}\n${opportunities.length?'':'No ha habido novedades.'}`
  });

  const sentAt=now.toISOString();

  // El mismo resumen, corto, por Telegram (si está configurado).
  let telegram=null;
  if(telegramConfigured()){
    try{
      const lines=[
        `<b>📊 ${htmlEsc(subject)}</b>`,
        failedRuns.length?`⚠️ ${failedRuns.length}/${runs.length} ejecuciones fallidas: ${htmlEsc([...errorCounts.keys()][0]||'')}`:null,
        `${htmlEsc(headline)}`,
        `STRONG BUY: <b>${counts['STRONG BUY']}</b> · BUY: <b>${counts.BUY}</b> · WATCH: <b>${counts.WATCH}</b>`,
        `Productos analizados: ${totalAnalyzed} · Tareas: ${summaries.length}`,
        aiProvider()==='openai'?`Gasto IA hoy: ${getAiSpend().usd.toFixed(2)} $`:null
      ].filter(Boolean);
      const top=opportunities.slice(0,8).map((x,i)=>{
        const title=htmlEsc(String(x.title||'').slice(0,70));
        const url=listingAppLink(x);
        const link=url?`<a href="${htmlEsc(url)}">${title}</a>`:title;
        const profit=x.net_profit_low_eur!=null||x.net_profit_high_eur!=null?` · beneficio ${eur0(x.net_profit_low_eur)}–${eur0(x.net_profit_high_eur)}`:'';
        return `${i+1}. <b>${htmlEsc(String(x.decision||''))} ${x.opportunity_score??'—'}</b> · ${htmlEsc(x._task_name||'')}\n${link}\n${eur0(x.price_eur)} → coste ${eur0(x.landed_cost_eur)}${profit}`;
      });
      // Máximo 4096 caracteres por mensaje: se quitan anuncios hasta caber
      // (cortar el texto rompería las etiquetas HTML).
      while(top.length&&[...lines,'',...top].join('\n').length>3800)top.pop();
      if(top.length)lines.push('',...top);
      if(opportunities.length>top.length)lines.push(`… y ${opportunities.length-top.length} más en el email.`);
      await telegramSend(lines.join('\n'));
      // Fotos de los mejores anuncios del resumen (una por anuncio, numeradas).
      const shown=opportunities.slice(0,top.length);
      const photos=[];
      for(const [i,x] of shown.entries()){
        const img=listingTelegramImages(x,1)[0];
        if(img)photos.push({img,cap:`${i+1}. ${String(x.title||'').slice(0,60)}`});
      }
      if(photos.length){
        const chat_id=process.env.TELEGRAM_CHAT_ID;
        try{
          await telegramApi('sendMediaGroup',{chat_id,media:photos.slice(0,10).map(p=>({type:'photo',media:p.img,caption:p.cap}))});
        }catch(e){
          // Alguna URL no la puede descargar Telegram: se suben desde aquí.
          const r=await telegramSendAlbum(photos.map(p=>p.img),'Fotos del resumen (mismo orden que la lista)').catch(err=>({sent:false,error:err.message}));
          if(!r.sent)console.error('Telegram digest photos failed:',e.message,r.error||'');
        }
      }
      telegram={sent:true};
    }catch(e){
      telegram={sent:false,error:e.message};
      console.error('Telegram digest failed:',e.message);
    }
  }

  const markGlobalDigestSent=db.prepare(`
    INSERT OR IGNORE INTO notifications(
      task_id,
      listing_id,
      run_id,
      kind,
      sent_to,
      sent_at
    )
    VALUES(0,?,?,'global-digest',?,?)
  `);

  for(const x of opportunities){
    markGlobalDigestSent.run(
      Number(x.id),
      Number.isFinite(Number(x._run_id))
        ? Number(x._run_id)
        : null,
      recipient,
      sentAt
    );
  }

  saveGlobalDigestState({
    last_sent_at:sentAt,
    previous_window_start:anchor.toISOString(),
    digest_interval_minutes:intervalMinutes
  });

  db.prepare('INSERT INTO runs(source,kind,summary,created_at) VALUES(?,?,?,?)').run(
    'email','global-digest',`${daily?'daily':'interval'} digest: ${runs.length} task runs; ${opportunities.length} opportunities; sent to ${recipient}`,sentAt
  );

  return {
    sent:true,
    to:recipient,
    subject,
    window_start:anchor.toISOString(),
    window_end:sentAt,
    task_runs:runs.length,
    tasks:summaries.length,
    analyzed:totalAnalyzed,
    counts,
    opportunities:opportunities.length,
    previously_emailed_skipped:previouslyEmailedSkipped,
    telegram
  };
}

function statusPayload() {
  return {
    app:'Luxury Hunter v1.7.1', port:PORT, xianyuBaseUrl:XIANYU_BASE_URL,
    xianyuProvider:xianyuProvider(),justOneApiConfigured:!!String(process.env.JUSTONEAPI_TOKEN||'').trim(),
    oneMapAccountStatus,
    bunjangCliExists:fs.existsSync(bunjangCli), geminiConfigured:aiConfigured(), aiProvider:aiProvider(), aiModel:aiModel(), emailConfigured:smtpConfig().configured,
    listingCount:db.prepare('SELECT COUNT(*) n FROM listings').get().n,
    taskCount:db.prepare('SELECT COUNT(*) n FROM tasks').get().n,
    runningTasks:[...runningTaskIds],
    bySource:db.prepare('SELECT source, COUNT(*) n FROM listings GROUP BY source ORDER BY source').all(),
    fx:db.prepare('SELECT * FROM fx_rates ORDER BY currency').all(),
    latestSession:db.prepare('SELECT * FROM search_sessions ORDER BY started_at DESC LIMIT 1').get()||null
  };
}

// AUTO CLOUD CONFIG SYNC V1
let cloudConfigSyncTimer=null;
let cloudConfigSyncRunning=false;
let cloudConfigSyncPending=false;

function cloudConfigAutoSyncEnabled(){
  const githubActions=
    String(process.env.GITHUB_ACTIONS||'')
      .toLowerCase()==='true';

  const disabled=
    ['1','true','yes','on'].includes(
      String(
        process.env.DISABLE_CLOUD_CONFIG_SYNC||''
      ).toLowerCase()
    );

  return !githubActions&&!disabled;
}

function scheduleCloudConfigSync(reason='platform-change'){
  if(!cloudConfigAutoSyncEnabled())return;

  cloudConfigSyncPending=true;

  if(cloudConfigSyncTimer){
    clearTimeout(cloudConfigSyncTimer);
  }

  cloudConfigSyncTimer=setTimeout(
    ()=>runCloudConfigSync(reason),
    1200
  );
}

function runCloudConfigSync(reason){
  cloudConfigSyncTimer=null;

  if(cloudConfigSyncRunning){
    cloudConfigSyncPending=true;
    return;
  }

  cloudConfigSyncRunning=true;
  cloudConfigSyncPending=false;

  try{
    const output=execFileSync(
      process.execPath,
      ['scripts/sync-cloud-config.mjs'],
      {
        cwd:process.cwd(),
        encoding:'utf8',
        timeout:90000,
        maxBuffer:10*1024*1024,
        env:{...process.env}
      }
    );

    console.log(
      `[Cloud config sync] ${reason}\n`+
      String(output||'').trim()
    );
  }catch(e){
    const stdout=String(e?.stdout||'').trim();
    const stderr=String(e?.stderr||'').trim();

    console.error(
      `[Cloud config sync ERROR] ${reason}`,
      stderr||stdout||e?.message||e
    );
  }finally{
    cloudConfigSyncRunning=false;

    if(cloudConfigSyncPending){
      scheduleCloudConfigSync(
        'pending-platform-change'
      );
    }
  }
}

const server=http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url,`http://${req.headers.host||'localhost'}`);
    if(req.method==='GET'&&u.pathname==='/api/status') return json(res,200,statusPayload());
    if(req.method==='POST'&&u.pathname==='/api/fx/update') return json(res,200,{updated:await updateFx(),fx:statusPayload().fx});
    if(req.method==='POST'&&u.pathname==='/api/email/global-digest'){
      const b=await readBody(req);
      return json(res,200,await sendGlobalDigest({
        to:b.to||null,
        force:!!b.force,
        config:b.config||{}
      }));
    }
    if(req.method==='POST'&&u.pathname==='/api/email/test'){
      const b=await readBody(req); const to=String(b.to||'').trim(); if(!to)return json(res,400,{error:'Indica un destinatario.'});
      const {transport,config}=getMailTransport(); await transport.sendMail({from:config.from,to,subject:'Luxury Hunter · correo de prueba',text:'El envío de correo de Luxury Hunter funciona correctamente.',html:'<p><b>Luxury Hunter</b>: el envío de correo funciona correctamente.</p>'});
      return json(res,200,{ok:true,to});
    }
    if(req.method==='POST'&&u.pathname==='/api/health/report'){
      const b=await readBody(req);
      const key=String(b.key||'').replace(/[^a-z0-9_-]/gi,'').slice(0,60);
      if(!key)return json(res,400,{error:'key required'});
      if(b.clear){clearHealthIssue(key);return json(res,200,{cleared:true});}
      await reportHealthIssue(key,String(b.message||''));
      return json(res,200,{reported:true});
    }
    if(req.method==='GET'&&u.pathname==='/api/economics') return json(res,200,{economics:getEconomics()});
    if(req.method==='PUT'&&u.pathname==='/api/economics'){
      const b=await readBody(req);
      const economics=saveEconomics(b);
      scheduleCloudConfigSync('economics-update');
      return json(res,200,{economics});
    }
    if(req.method==='GET'&&u.pathname==='/api/xianyu/accounts'){
      if(xianyuDirectMode()){
        const accounts=xianyuKnownAccounts().map(file=>({
          name:accountLabel(file),path:file,
          status:availableXianyuAccounts([file],{failed:xianyuFailedAccounts}).length
            ?(file===xianyuActiveAccount?'activa':'disponible'):'sesión caducada'
        }));
        return json(res,200,{accounts});
      }
      try{return json(res,200,{accounts:await xianyuFetch('/api/accounts',{timeoutMs:7000})});}catch(e){return json(res,200,{accounts:[],error:e.message});}
    }
    if(req.method==='POST'&&u.pathname==='/api/telegram/test-alert'){
      const b=await readBody(req);
      const id=Number(b.listingId)||0;
      const r=await telegramSend(`🧪 <b>Prueba de botones</b>\nPulsa uno: el bot lo guardará en la próxima comprobación.`,null,{buttons:alertButtons(id)});
      return json(res,200,r);
    }
    if(req.method==='POST'&&u.pathname==='/api/telegram/test-listing'){
      const b=await readBody(req);
      const x=db.prepare('SELECT * FROM listings WHERE id=?').get(Number(b.listingId));
      if(!x)return json(res,404,{error:'listing not found'});
      return json(res,200,await telegramSendListing(instantAlertText({...x,decision:'PRUEBA',_task_name:'Prueba de fotos y enlace'}),x));
    }
    if(req.method==='POST'&&u.pathname==='/api/telegram/poll'){
      return json(res,200,{...(await pollTelegramUpdates()),feedback:db.prepare('SELECT * FROM listing_feedback ORDER BY created_at DESC LIMIT 5').all()});
    }
    if(req.method==='POST'&&u.pathname==='/api/xianyu/detail'){
      const b=await readBody(req);
      const ids=(Array.isArray(b.listingIds)?b.listingIds:[b.listingId]).map(Number).filter(Boolean);
      return json(res,200,{fetched:0,skipped:ids.length,mode:'search-only',message:'Las fichas detalladas de Xianyu están desactivadas; el bot usa solo los datos devueltos por búsqueda.'});
    }
    if(req.method==='POST'&&u.pathname==='/api/search/global'){const b=await readBody(req);return json(res,200,await globalSearch(b));}
    if(req.method==='GET'&&u.pathname==='/api/search/latest'){
      const s=db.prepare('SELECT * FROM search_sessions ORDER BY started_at DESC LIMIT 1').get();
      if(!s)return json(res,200,{session:null,items:[]});
      return json(res,200,{session:s,items:sessionListings(s.id)});
    }
    const sm=u.pathname.match(/^\/api\/search\/sessions\/([^/]+)$/);
    if(req.method==='GET'&&sm){const s=db.prepare('SELECT * FROM search_sessions WHERE id=?').get(sm[1]);if(!s)return json(res,404,{error:'Search session not found'});return json(res,200,{session:s,items:sessionListings(s.id)});}

    if(req.method==='GET'&&u.pathname==='/api/tasks'){
      const tasks=db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC,id DESC').all().map(taskPublic);
      return json(res,200,{tasks});
    }
    if(req.method==='POST'&&u.pathname==='/api/tasks'){
      const b=await readBody(req);
      const task=createTaskRecord(b);
      scheduleCloudConfigSync(`task-create:${task.id}`);
      return json(res,201,{task});
    }
    const tm=u.pathname.match(/^\/api\/tasks\/(\d+)$/);
    if(tm&&req.method==='GET'){const t=taskPublic(db.prepare('SELECT * FROM tasks WHERE id=?').get(Number(tm[1])));if(!t)return json(res,404,{error:'Tarea no encontrada'});return json(res,200,{task:t});}
    if(tm&&req.method==='PATCH'){
      const b=await readBody(req);
      const task=updateTaskRecord(Number(tm[1]),b);
      scheduleCloudConfigSync(`task-update:${task.id}`);
      return json(res,200,{task});
    }
    if(tm&&req.method==='DELETE'){
      const id=Number(tm[1]); if(runningTaskIds.has(id))return json(res,409,{error:'No puedes borrar una tarea mientras se está ejecutando.'});
      db.prepare('DELETE FROM task_analyses WHERE task_id=?').run(id);
      db.prepare('DELETE FROM task_runs WHERE task_id=?').run(id);
      db.prepare('DELETE FROM tasks WHERE id=?').run(id);
      scheduleCloudConfigSync(`task-delete:${id}`);
      return json(res,200,{ok:true});
    }
    const tr=u.pathname.match(/^\/api\/tasks\/(\d+)\/run$/);
    if(tr&&req.method==='POST'){
      const taskId=Number(tr[1]); const task=taskPublic(db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId)); if(!task)return json(res,404,{error:'Tarea no encontrada'});
      if(runningTaskIds.has(taskId))return json(res,409,{error:'La tarea ya está ejecutándose.'});
      const rbody=await readBody(req).catch(()=>({}));
      const fast=rbody?.fast==='auction'?'auction':!!rbody?.fast;
      if(fast){
        const key=fast==='auction'?'auction_lane_last':'fast_lane_last';
        const last=Date.parse((getSetting(key,{})||{})[taskId]||'')||0;
        const every=Math.max(5,Number(fast==='auction'?process.env.AUCTION_LANE_MINUTES||30:process.env.FAST_LANE_MINUTES||20));
        if(Date.now()-last<every*60e3)return json(res,200,{skipped:true,next_in_min:Math.ceil((last+every*60e3-Date.now())/60e3)});
      }
      const rr=db.prepare('INSERT INTO task_runs(task_id,status,started_at) VALUES(?,?,?)').run(taskId,'queued',new Date().toISOString());
      const runId=Number(rr.lastInsertRowid); setImmediate(()=>executeTask(taskId,runId,{fast}).catch(e=>console.error('Task run failed',taskId,e.message)));
      return json(res,202,{runId,status:'queued',fast});
    }
    const ti=u.pathname.match(/^\/api\/tasks\/(\d+)\/inspect$/);
    if(ti&&req.method==='GET'){
      const task=taskPublic(db.prepare('SELECT * FROM tasks WHERE id=?').get(Number(ti[1]))); if(!task)return json(res,404,{error:'Tarea no encontrada'});
      const basePlan=await buildQueryPlan(task.product_query); const plan=effectivePlan(basePlan,task);
      const latestRun=db.prepare('SELECT * FROM task_runs WHERE task_id=? ORDER BY id DESC LIMIT 1').get(task.id)||null;
      return json(res,200,{manifest:buildExecutionManifest(task,plan,null,null)});
    }
    const ra=u.pathname.match(/^\/api\/task-runs\/(\d+)\/abort$/);
    if(ra&&req.method==='POST'){
      const runId=Number(ra[1]);
      const run=db.prepare('SELECT * FROM task_runs WHERE id=?').get(runId);

      if(!run)return json(res,404,{error:'Run no encontrado'});

      if(!['queued','running'].includes(String(run.status))){
        return json(res,409,{
          error:`La ejecución ya está en estado ${run.status}.`
        });
      }

      const finished=new Date().toISOString();

      db.prepare(
        "UPDATE task_runs SET status='aborted',error=NULL,finished_at=? WHERE id=?"
      ).run(finished,runId);

      if(run.session_id){
        db.prepare(
          "UPDATE search_sessions SET status='aborted',finished_at=? WHERE id=?"
        ).run(finished,run.session_id);
      }

      db.prepare(
        'UPDATE tasks SET last_run_at=?,updated_at=? WHERE id=?'
      ).run(finished,finished,run.task_id);

      return json(res,200,{ok:true,runId,status:'aborted'});
    }

    const ri=u.pathname.match(/^\/api\/task-runs\/(\d+)\/inspect$/);
    if(ri&&req.method==='GET'){
      const run=db.prepare(`SELECT r.*,t.task_name FROM task_runs r JOIN tasks t ON t.id=r.task_id WHERE r.id=?`).get(Number(ri[1])); if(!run)return json(res,404,{error:'Run no encontrado'});
      let task=null; try{const dbg=JSON.parse(run.debug_json||'{}');task=dbg.taskSnapshot||null;}catch{}
      if(!task) task=taskPublic(db.prepare('SELECT * FROM tasks WHERE id=?').get(run.task_id));
      let session=null,plan=null;
      if(run.session_id){session=db.prepare('SELECT * FROM search_sessions WHERE id=?').get(run.session_id)||null;try{plan=JSON.parse(session?.query_plan_json||'null')}catch{}}
      if(!plan){const base=await buildQueryPlan(task.product_query);plan=effectivePlan(base,task);}
      return json(res,200,{manifest:buildExecutionManifest(task,plan,run,session)});
    }

    const tresults=u.pathname.match(/^\/api\/tasks\/(\d+)\/results$/);
    if(tresults&&req.method==='GET')return json(res,200,{items:taskResults(Number(tresults[1]))});
    const taj=u.pathname.match(
      /^\/api\/tasks\/(\d+)\/listings\/(\d+)\/analyze-job$/
    );

    if(taj&&req.method==='POST'){
      const taskId=Number(taj[1]);
      const listingId=Number(taj[2]);

      const task=taskPublic(
        db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId)
      );

      if(!task){
        return json(res,404,{error:'Tarea no encontrada'});
      }

      const listing=db.prepare(
        'SELECT id FROM listings WHERE id=?'
      ).get(listingId);

      if(!listing){
        return json(res,404,{error:'Anuncio no encontrado'});
      }

      const job=createAnalysisJob(taskId,listingId);

      setImmediate(async()=>{
        try{
          await analyzeWithGemini(
            listingId,
            taskId,
            task.analyze_images,
            (pct,stage,detail)=>{
              updateAnalysisJob(
                job.id,
                pct,
                stage,
                detail
              );
            }
          );

          finishAnalysisJob(job.id,'finished');
        }catch(e){
          finishAnalysisJob(
            job.id,
            'error',
            e?.message||String(e)
          );
        }
      });

      return json(res,202,{
        jobId:job.id,
        status:'running'
      });
    }

    const aj=u.pathname.match(
      /^\/api\/analysis-jobs\/([^/]+)$/
    );

    if(aj&&req.method==='GET'){
      const job=analysisJobs.get(aj[1]);

      if(!job){
        return json(res,404,{
          error:'Análisis no encontrado o ya expirado'
        });
      }

      return json(res,200,{job});
    }

    const ta=u.pathname.match(/^\/api\/tasks\/(\d+)\/listings\/(\d+)\/analyze$/);
    if(ta&&req.method==='POST'){
      const task=taskPublic(db.prepare('SELECT * FROM tasks WHERE id=?').get(Number(ta[1])));if(!task)return json(res,404,{error:'Tarea no encontrada'});
      return json(res,200,{analysis:await analyzeWithGemini(Number(ta[2]),Number(ta[1]),task.analyze_images)});
    }
    if(req.method==='GET'&&u.pathname==='/api/task-runs'){
      const taskId=u.searchParams.get('taskId');
      const rows=taskId?db.prepare(`SELECT r.*,t.task_name FROM task_runs r JOIN tasks t ON t.id=r.task_id WHERE r.task_id=? ORDER BY r.id DESC LIMIT 100`).all(Number(taskId)):db.prepare(`SELECT r.*,t.task_name FROM task_runs r JOIN tasks t ON t.id=r.task_id ORDER BY r.id DESC LIMIT 100`).all();
      return json(res,200,{runs:rows});
    }
    const runm=u.pathname.match(/^\/api\/task-runs\/(\d+)$/);
    if(runm&&req.method==='GET'){const r=db.prepare(`SELECT r.*,t.task_name FROM task_runs r JOIN tasks t ON t.id=r.task_id WHERE r.id=?`).get(Number(runm[1]));if(!r)return json(res,404,{error:'Run no encontrado'});return json(res,200,{run:r,items:r.session_id?sessionListings(r.session_id):[]});}

    if(req.method==='GET'&&u.pathname==='/api/results'){
      const taskId=u.searchParams.get('taskId');
      if(taskId)return json(res,200,{items:taskResults(Number(taskId))});
      const items=enrichCosts(db.prepare(`SELECT l.*,a.brand,a.model,a.authenticity_risk,a.liquidity,a.decision,a.opportunity_score,a.resale_low_eur,a.resale_high_eur,a.landed_cost_eur,a.net_profit_low_eur,a.net_profit_high_eur,a.notes,a.decision_reasons_es_json,a.preliminary_decision,a.verification_json FROM listings l LEFT JOIN analyses a ON a.listing_id=l.id ORDER BY l.last_seen DESC LIMIT 300`).all().filter(xianyuListingHasVerificationTag));
      return json(res,200,{items});
    }
    const am=u.pathname.match(/^\/api\/listings\/(\d+)\/analyze$/);
    if(req.method==='POST'&&am)return json(res,200,{analysis:await analyzeWithGemini(am[1])});
    if(req.method==='GET'&&(u.pathname==='/'||u.pathname==='/index.html'))return text(res,200,fs.readFileSync(path.join(__dirname,'public','index.html'),'utf8'),'text/html; charset=utf-8');
    return json(res,404,{error:'Not found'});
  }catch(e){console.error(e);return json(res,500,{error:e?.message||String(e)});}
});

const cronFireKeys=new Map();
async function schedulerTick(){
  const now=new Date();
  const minuteKey=`${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()} ${now.getHours()}:${now.getMinutes()}`;
  const tasks=db.prepare(`SELECT * FROM tasks WHERE enabled=1 AND ((cron IS NOT NULL AND TRIM(cron)<>'') OR interval_minutes IS NOT NULL)`).all().map(taskPublic);
  for(const task of tasks){
    if(runningTaskIds.has(task.id)) continue;
    let due=false;
    if(task.interval_minutes){
      if(!task.last_run_at) due=true;
      else due=(now.getTime()-new Date(task.last_run_at).getTime()) >= Number(task.interval_minutes)*60000;
    } else if(task.cron){
      due=cronMatches(task.cron,now);
      if(due && cronFireKeys.get(task.id)===minuteKey) due=false;
    }
    if(!due) continue;
    cronFireKeys.set(task.id,minuteKey);
    const rr=db.prepare('INSERT INTO task_runs(task_id,status,started_at) VALUES(?,?,?)').run(task.id,'queued',new Date().toISOString());
    const runId=Number(rr.lastInsertRowid);
    setImmediate(()=>executeTask(task.id,runId).catch(e=>console.error('Scheduled task failed',task.id,e.message)));
  }
}
server.listen(PORT,'127.0.0.1',async()=>{
  console.log(`Luxury Hunter v1.7 -> http://127.0.0.1:${PORT}`);
  try{applyAiSpendReset();}catch(e){console.error('AI spend reset:',e.message);}
  try{applyAiMonthSpendReset();}catch(e){console.error('AI month reset:',e.message);}
  try{vetoUnverifiableXianyuAnalyses();}catch(e){console.error('Xianyu veto:',e.message);}
  try{const n=await updateFx();console.log(`FX updated (${n})`);}catch(e){console.log(`FX update skipped: ${e.message}`);}
  if(vestiaireSheetConfigured())await refreshVestiaireSheet({force:true}).catch(()=>{});
  else console.log('Hoja de Vestiaire no configurada (VESTIAIRE_SHEET_ID + GOOGLE_SHEETS_SA_JSON o GOOGLE_SHEETS_SA_FILE): se usa la copia fija.');
  if(!vestiaireSheetConfigured())revalidateStoredBagBuys();
  const schedulerDisabled=String(process.env.DISABLE_SCHEDULER||'').toLowerCase();
  if(!['1','true','yes','on'].includes(schedulerDisabled)){
    setInterval(()=>schedulerTick().catch(e=>console.error('Scheduler:',e.message)),30000);
  } else {
    console.log('Scheduler disabled for one-shot/cloud execution.');
  }
  // Botones de Telegram: se recogen las pulsaciones cada 20 s mientras el
  // servidor está vivo (en GitHub, durante cada ejecución).
  if(telegramConfigured()&&!['0','off','false','no'].includes(String(process.env.TELEGRAM_POLL||'').toLowerCase())){
    pollTelegramUpdates().catch(()=>{});
    setInterval(()=>pollTelegramUpdates().catch(()=>{}),20000).unref?.();
    // Análisis manuales que quedaron a medias en la ejecución anterior.
    try{resumeManualAnalyses();}catch(e){console.error('Telegram manual resume:',e.message);}
  }
});
