import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { load as loadHtml } from 'cheerio';
import nodemailer from 'nodemailer';

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
const XIANYU_BASE_URL = String(process.env.XIANYU_BASE_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
const DB_PATH = path.join(__dirname, 'data', 'luxury-hunter.sqlite3');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
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
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);

function ensureColumn(table, name, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(x => x.name);
  if (!cols.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}
ensureColumn('listings', 'purchase_via', 'TEXT');
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
    xianyu: { label:'Xianyu / China', domesticShippingEur:5, agentFeePercent:5, agentFeeFixedEur:0, internationalShippingEur:30, customsDutyPercent:3, clearanceFeeEur:8, authenticationFeeEur:0, otherEur:0 },
    bunjang: { label:'Bunjang / Corea', domesticShippingEur:4, agentFeePercent:5, agentFeeFixedEur:0, internationalShippingEur:30, customsDutyPercent:3, clearanceFeeEur:8, authenticationFeeEur:0, otherEur:0 },
    buyee: { label:'Japón', domesticShippingEur:8, agentFeePercent:0, agentFeeFixedEur:5, internationalShippingEur:30, customsDutyPercent:3, clearanceFeeEur:8, authenticationFeeEur:0, otherEur:0 }
  }
};
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
  for(const source of ['xianyu','bunjang','buyee']){
    const src=input.sources?.[source]||{};
    for(const key of ['domesticShippingEur','agentFeePercent','agentFeeFixedEur','internationalShippingEur','customsDutyPercent','clearanceFeeEur','authenticationFeeEur','otherEur']){
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
function importEconomics(item, settings=getEconomics()){
  const product=finiteOr(item?.price_eur,0);
  const rawSource=String(item?.source||'').toLowerCase();
  const japanEconomicSources=new Set([
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
  const sourceKey=['xianyu','bunjang'].includes(rawSource)
    ? rawSource
    : japanEconomicSources.has(rawSource)
      ? 'buyee'
      : 'xianyu';
  const cfg=settings.sources[sourceKey]||settings.sources.xianyu;
  const domestic=finiteOr(cfg.domesticShippingEur,0);
  const agent=product*(finiteOr(cfg.agentFeePercent,0)/100)+finiteOr(cfg.agentFeeFixedEur,0);
  const intl=finiteOr(cfg.internationalShippingEur,0);
  const customsBase=product+domestic+intl;
  const lowValue=customsBase>0 && customsBase<=finiteOr(settings.lowValueThresholdEur,150);
  const duty=lowValue?finiteOr(settings.lowValueDutyFlatEur,3):customsBase*(finiteOr(cfg.customsDutyPercent,0)/100);
  const vatBase=customsBase+duty;
  const vat=vatBase*(finiteOr(settings.vatPercent,21)/100);
  const clearance=finiteOr(cfg.clearanceFeeEur,0);
  const auth=finiteOr(cfg.authenticationFeeEur,0);
  const other=finiteOr(cfg.otherEur,0);
  const imported=product+domestic+agent+intl+duty+vat+clearance+auth+other;
  return {
    source:sourceKey,
    productPriceEur:roundMoney(product),
    domesticShippingEur:roundMoney(domestic),
    agentFeePercent:finiteOr(cfg.agentFeePercent,0),
    agentFeeFixedEur:roundMoney(finiteOr(cfg.agentFeeFixedEur,0)),
    agentFeeEur:roundMoney(agent),
    internationalShippingEur:roundMoney(intl),
    customsValueEur:roundMoney(customsBase),
    customsDutyPercent:finiteOr(cfg.customsDutyPercent,0),
    lowValueDutyApplied:lowValue,
    customsDutyEur:roundMoney(duty),
    vatPercent:finiteOr(settings.vatPercent,21),
    importVatEur:roundMoney(vat),
    clearanceFeeEur:roundMoney(clearance),
    authenticationFeeEur:roundMoney(auth),
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
    x.image_url || '', x.status || '', JSON.stringify(x.raw || {}), now, now, x.purchase_via || ''
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

async function generateQueryPlanWithGemini(product) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
  const prompt = `You generate marketplace search queries for second-hand luxury goods. Return ONLY JSON with keys xianyu, bunjang, japan. Each value MUST contain exactly 2 concise search strings. Query 1 MUST be the natural local-language marketplace query: Simplified Chinese for Xianyu, Korean for Bunjang, Japanese for Japan. Query 2 MUST be the Western/original product name. Keep the exact product family; do not broaden to unrelated models. Product: ${product}`;
  const u = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const r = await fetch(u, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ contents:[{role:'user',parts:[{text:prompt}]}], generationConfig:{responseMimeType:'application/json'} }) });
  if (!r.ok) return null;
  const body = await r.json();
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

function runBunjangCli(args) {
  if (!fs.existsSync(bunjangCli)) throw new Error('bunjang-cli no está instalado. Ejecuta npm install.');
  const out = execFileSync(bunjangCli, args, { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });
  return JSON.parse(out.trim());
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


async function searchBunjangLive({ queries, pages=1, maxItems=20, minEur=null, maxEur=null, sessionId }) {
  const maxQueries = clampInt(process.env.BUNJANG_MAX_QUERIES || 2, 2, 1, 5);
  const selectedQueries = (queries || []).slice(0, maxQueries);
  const unique = new Map();
  const perQuery = [];
  for (const q0 of selectedQueries) {
    const q = String(q0).trim(); if (!q) continue;
    const s = runBunjangCli(['--json','--preferred-transport','browser','search',q,'--sort','date','--pages',String(pages),'--max-items',String(maxItems)]);
    const ids = (s.items || []).map(x => x.id).filter(Boolean);
    ids.forEach(id => { if (!unique.has(String(id))) unique.set(String(id), q); });
    perQuery.push({ query:q, count:ids.length });
    await sleep(700);
  }
  let details = [];
  for (const group of chunks([...unique.keys()], 40)) {
    if (!group.length) continue;
    const d = runBunjangCli(['--json','item','list','--ids',group.join(',')]);
    details.push(...(d.items || []));
  }
  let kept=0;
  for (const item of details) {
    const p = Number(item.price);
    const pe = toEur(p, 'KRW');
    if (!Number.isFinite(p)) continue;
    if (Number.isFinite(Number(minEur)) && pe != null && pe < Number(minEur)) continue;
    if (Number.isFinite(Number(maxEur)) && pe != null && pe > Number(maxEur)) continue;
    const sourceQuery = unique.get(String(item.id)) || '';

    const publication=await fetchBunjangPublication(item);

    const rawWithPublication={
      ...item,
      publishedAt:publication.publishedAt,
      luxuryHunterPublication:{
        marketplace:'bunjang',
        ageText:publication.ageText,
        source:publication.source,
        sourceValue:publication.sourceValue||null,
        status:publication.status,
        checkedAt:new Date().toISOString()
      }
    };

    upsertListing({
      source:'bunjang', source_id:item.id, url:item.url, title:item.title, description:item.description,
      original_price:p, currency:'KRW', price_eur:pe, seller_name:item.sellerName,
      seller_items:item.sellerItemCount, seller_sales:item.sellerSalesCount, seller_reviews:item.sellerReviewCount,
      image_url:item.imageUrl, status:item.status, purchase_via:'Korea proxy', raw:rawWithPublication
    }, sessionId, sourceQuery);

    kept++;

    await sleep(120);
  }
  db.prepare('INSERT INTO runs(source,kind,summary,created_at) VALUES(?,?,?,?)').run('bunjang','live-search',`Queries ${perQuery.length}; IDs ${unique.size}; kept ${kept}`,new Date().toISOString());
  return { ok:true, perQuery, uniqueIds:unique.size, detailed:details.length, kept };
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
async function searchXianyuLive({ queries, pages=1, maxItems=30, minEur=null, maxEur=null, sessionId, product, personalOnly=false, freeShipping=false, newPublishOption=null, region=null, accountStateFile=null, accountStrategy='auto' }) {
  const maxQueries = clampInt(process.env.XIANYU_MAX_QUERIES || 2, 2, 2, 2);
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
      if (!taskId) throw new Error('Xianyu no devolvió el ID de la tarea temporal.');
      await xianyuFetch(`/api/tasks/start/${taskId}`, { method:'POST', timeoutMs:15000 });
      let seenRunning=false;
      const deadline = Date.now() + 210000;
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
      if (taskId) { try { await xianyuFetch(`/api/tasks/${taskId}`, { method:'DELETE', timeoutMs:10000 }); } catch {} }
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
    id:'yahoo-auctions-jp',
    label:'Yahoo! Auctions Japan',
    purchaseVia:'Buyee',
    mode:'browser',
    base:'https://buyee.jp',
    cap:10,
    searchWaitMs:5000,
    detailWaitMs:1200,
    searchUrl:q=>`https://buyee.jp/item/search/query/${encodeURIComponent(q)}?lang=en`,
    accepts:u=>/^\/item\/jdirectitems\/auction\/[^/]+/i.test(u.pathname)
  },
  {
    id:'mercari-jp',
    label:'Mercari Japan',
    purchaseVia:'Direct',
    mode:'browser',
    base:'https://jp.mercari.com',
    cap:12,
    searchWaitMs:3500,
    detailWaitMs:4000,
    searchUrl:q=>`https://jp.mercari.com/search?keyword=${encodeURIComponent(q)}&sort=created_time&order=desc`,
    accepts:u=>/^\/item\/m\d+/i.test(u.pathname)||/^\/shops\/product\/[^/]+/i.test(u.pathname)
  },
  {
    id:'rakuma-jp',
    label:'Rakuma',
    purchaseVia:'Direct',
    mode:'http',
    base:'https://fril.jp',
    cap:12,
    searchUrl:q=>`https://fril.jp/s?query=${encodeURIComponent(q)}`,
    accepts:u=>u.hostname==='item.fril.jp'&&/^\/[a-f0-9]+\/?$/i.test(u.pathname)
  },
  {
    id:'yahoo-fleamarket-jp',
    label:'Yahoo! Flea Market',
    purchaseVia:'Direct',
    mode:'browser',
    base:'https://paypayfleamarket.yahoo.co.jp',
    cap:8,
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
    cap:6,
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
    cap:8,
    searchUrl:q=>`https://komehyo.jp/search/?q=${encodeURIComponent(q)}`,
    accepts:u=>/^\/product\/[^/]+\/?/i.test(u.pathname)
  }
];

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
      m=u.pathname.match(/\/auction\/([^/?#]+)/i);
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

async function japanBrowserSnapshot(context,url,waitMs=1000){
  const page=await context.newPage();

  try{
    const response=await page.goto(url,{
      waitUntil:'domcontentloaded',
      timeout:45000
    });

    await page.waitForTimeout(waitMs);

    const html=await page.content();

    const body=await page.locator('body')
      .innerText()
      .catch(()=>'');

    return {
      status:response?.status()??0,
      finalUrl:page.url(),
      html,
      body:String(body||'').replace(/\s+/g,' ').trim(),
      title:await page.title().catch(()=>'')
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

async function japanEnrichCandidate(spec,candidate,searchMeta,browserContext){
  const snap=spec.mode==='browser'
    ? await japanBrowserSnapshot(
        browserContext,
        candidate.href,
        spec.detailWaitMs||900
      )
    : await japanHttpSnapshot(candidate.href);

  if(snap.status>=400){
    throw new Error(`HTTP ${snap.status}`);
  }

  const $=loadHtml(snap.html);
  const product=japanFindJsonLdProduct($);
  const offer=japanOffer(product);

  const ogTitle=$('meta[property="og:title"]').attr('content')||'';
  const h1=$('h1').first().text().replace(/\s+/g,' ').trim();

  let title=String(
    product?.name||
    ogTitle||
    h1||
    candidate.title||
    snap.title||
    ''
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

  const price=japanYenPrice(
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
    description,
    original_price:price,
    currency:'JPY',
    price_eur:price==null?null:toEur(price,'JPY'),
    seller_name:seller,
    image_url:image,
    status,
    purchase_via:spec.purchaseVia,
    publishedAt:publication?.publishedAt||null,
    raw:{
      query:searchMeta.query,
      searchUrl:searchMeta.searchUrl,
      searchMode:spec.mode,
      sourceLabel:spec.label,
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
  let detailErrors=0;
  let successfulQueries=0;

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
            spec.searchWaitMs||2500
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

      if(spec.id==='mercari-jp'&&personalOnly){
        candidates=candidates.filter(
          x=>/^https:\/\/jp\.mercari\.com\/item\/m/i.test(x.href)
        );
      }

      let local=0;

      for(const candidate of candidates){
        if(kept>=sourceLimit)break;

        const sourceId=japanSourceId(
          spec.id,
          candidate.href
        );

        const dedupeKey=`${spec.id}:${sourceId}`;

        if(seen.has(dedupeKey))continue;
        seen.add(dedupeKey);

        let item=null;

        try{
          item=await japanEnrichCandidate(
            spec,
            candidate,
            {query:q,searchUrl},
            browserContext
          );
        }catch{
          detailErrors++;
          continue;
        }

        if(item.status==='sold')continue;

        const pe=item.price_eur==null?null:Number(item.price_eur);
        const hasMinEur=
          minEur!==null&&
          minEur!==undefined&&
          minEur!==''&&
          Number.isFinite(Number(minEur));
        const hasMaxEur=
          maxEur!==null&&
          maxEur!==undefined&&
          maxEur!==''&&
          Number.isFinite(Number(maxEur));

        if(
          hasMinEur&&
          Number.isFinite(pe)&&
          pe<Number(minEur)
        ){
          continue;
        }

        if(
          hasMaxEur&&
          Number.isFinite(pe)&&
          pe>Number(maxEur)
        ){
          continue;
        }

        upsertListing(item,sessionId,q);

        local++;
        kept++;

        if(item.publishedAt){
          withPublicationDate++;
        }
      }

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
    withPublicationDate,
    detailErrors,
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

  const needsBrowser=JAPAN_RADAR_SPECS.some(
    x=>x.mode==='browser'
  );

  if(needsBrowser){
    try{
      const {chromium}=await import('playwright');

      browser=await chromium.launch({
        headless:true
      });

      browserContext=await browser.newContext({
        locale:'ja-JP',
        userAgent:JAPAN_HTTP_HEADERS['user-agent']
      });
    }catch(e){
      browserError=e.message;
    }
  }

  try{
    for(const spec of JAPAN_RADAR_SPECS){
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
const CENTRAL_AI_INSTRUCTION = `You are the first-pass central AI screening engine for Luxury Hunter. Analyze this second-hand luxury handbag listing conservatively for resale in Europe. First verify that the listing appears to match the target product family; search-query similarity is not proof. The user's task requirements below are mandatory evaluation context. Never certify authenticity from photos alone. Treat implausibly cheap current luxury as counterfeit risk.
Luxury Hunter calculates import/shipping/tax costs deterministically and supplies the IMPORTED TOTAL; use that supplied total as landed_cost_eur and DO NOT invent a different import-cost figure. This is ONLY the preliminary screen. Any preliminary WATCH, BUY or STRONG BUY will be blocked from final publication until a second visual exact-model check and a live market-comparable check are completed.
Return ONLY valid JSON with keys: brand, model, authenticity_risk (LOW|MEDIUM|HIGH), liquidity (LOW|MEDIUM|HIGH), decision (STRONG BUY|BUY|WATCH|REJECT), opportunity_score (0-100), resale_low_eur, resale_high_eur, landed_cost_eur, net_profit_low_eur, net_profit_high_eur, decision_reasons_es, notes.
decision_reasons_es MUST be an array of 1 to 4 short bullet-style reasons written in Spanish. For REJECT, make the reasons specific and practical. If evidence is insufficient, prefer WATCH or REJECT rather than inventing facts.`;

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
  const source=String(c?.source||'').trim();
  if(source)return source.toLowerCase();
  try{return new URL(c?.url||'').hostname.replace(/^www\./,'').toLowerCase()}catch{return''}
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
  let r=await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
  let body=await r.json();

  if(!r.ok){
    payload={contents:[{role:'user',parts:[{text:repairPrompt}]}]};
    r=await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
    body=await r.json();
  }
  if(!r.ok)throw new Error(body?.error?.message||`Gemini JSON repair HTTP ${r.status}`);

  const repairedText=body?.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('')||'';
  return parseJsonLoose(repairedText);
}

async function geminiJsonRequest({key,model,parts,googleSearch=false}){
  const u=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const payload={contents:[{role:'user',parts}],generationConfig:{responseMimeType:'application/json'}};
  if(googleSearch)payload.tools=[{google_search:{}}];

  let r=await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
  let body=await r.json();

  if(!r.ok&&googleSearch){
    const retry={contents:[{role:'user',parts}],tools:[{google_search:{}}]};
    r=await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(retry)});
    body=await r.json();
  }

  if(!r.ok)throw new Error(body?.error?.message||`Gemini HTTP ${r.status}`);

  const rawText=body?.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('')||'';
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
  'christies.com'
]);

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
    'christies.com':"Christie's"
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

  const prompt=`You are the LIVE MARKET COMPARABLES researcher for Luxury Hunter.
Current date: ${new Date().toISOString().slice(0,10)}.

You MUST use Google Search grounding. Research the exact visually identified handbag variant below, not merely the broad model family.

EXACT VISUAL IDENTIFICATION:
${JSON.stringify(exact)}

TARGET:
${task?.product_query||''}

CURRENT LISTING TO EXCLUDE:
${item.url||''}

GOOGLE CLOUD VISION WEB-DETECTION CANDIDATES:
${JSON.stringify(visionContext)}

VISUAL-CANDIDATE RULES:
- The URLs above were discovered from the LISTING IMAGE itself using Google Cloud Vision Web Detection.
- They are research leads, NOT automatically valid comparables.
- You MUST investigate these visual candidates before concluding that no market references exist.
- A visual candidate may be old, archived or sold. Do not discard it merely because of age.
- Historical exact-model references remain useful evidence of model identity and historic market activity.
- For each grounded candidate classify it as EXACT, NEAR or ORIENTATIVE.
- Extract the real source, title, URL, observed price, currency, SOLD/CURRENT status, publication/sale date when genuinely available and condition evidence.
- Different reseller terminology is NOT a reason to reject an otherwise matching product.
- If the candidate is visually relevant but pricing/date evidence cannot be validated, preserve it as research evidence rather than inventing information.
- Do not return zero research results without considering the visual candidates above when they exist.

SOURCE POLICY — HARD WHITELIST:
Google Search and Google Cloud Vision are DISCOVERY mechanisms only.
A result becomes market evidence ONLY when its final/direct URL belongs to one of these approved domains:

1. vestiairecollective.com — Vestiaire Collective
2. collectorsquare.com — Collector Square
3. therealreal.com — The RealReal
4. fashionphile.com — Fashionphile
5. rebag.com — Rebag
6. 1stdibs.com — 1stDibs
7. yoogiscloset.com — Yoogi's Closet
8. whatgoesaroundnyc.com — What Goes Around Comes Around
9. annsfabulousfinds.com — Ann's Fabulous Finds
10. hardlyeverwornit.com — HEWI
11. sothebys.com — Sotheby's
12. christies.com — Christie's

HARD SOURCE RULES:
- Do NOT use or return YouTube.
- Do NOT use or return Reddit, Pinterest, Instagram, TikTok or Facebook.
- Do NOT use ShopMy.
- Do NOT use blogs, SEO pages, generic shops, affiliate pages or unknown domains.
- Do NOT use a Google search-result page itself as a comparable.
- Do NOT treat an image-match host as a market source unless the landing page belongs to the whitelist above.
- Brand-new retail MSRP pages are not resale comparables.
- If the whitelist does not provide enough evidence, report insufficient market evidence. Never relax the whitelist.

COMPARABLE RULES:
- Same exact variant/size/material/pattern/edition = EXACT.
- Same variant and size/material but another ordinary colour = NEAR.
- Same family but meaningfully different size/material/edition = ORIENTATIVE and must not drive valuation.
- A sequined or special-edition Baguette is not an exact comparable for an ordinary Zucca canvas Baguette.
- Prefer sold prices when genuinely visible. Otherwise label CURRENT.
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
- Search across Vestiaire Collective, The RealReal, Fashionphile, Rebag, Collector Square, specialist European luxury resellers and other credible second-hand sources surfaced by Google.
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
      trustedLuxuryMarketEntry
    );

  let rejectedUntrustedReferenceCount=
    rawFirstPassComps.length-comps.length;

  const rawFirstPassGrounding=
    Array.isArray(result.groundingSources)
      ? result.groundingSources
      : [];

  let marketGroundingSources=
    rawFirstPassGrounding.filter(
      trustedLuxuryMarketEntry
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
      .map(c=>String(c?.source||'').trim().toLowerCase())
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
      .map(c=>String(c?.source||'').trim().toLowerCase())
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
9. Search specifically for additional results ONLY on the HARD WHITELIST defined above. Do not use specialist resellers outside that whitelist, even when Google surfaces them.
10. Continue broadening until you either obtain at least 3 useful EXACT/NEAR comparables from at least 2 independent sources, or the available grounded evidence is genuinely exhausted.
11. Return real URLs and evidence-backed prices whenever available.
12. Do not invent comparables if a page cannot be grounded.

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
    trustedLuxuryMarketEntry
  );

  rejectedUntrustedReferenceCount+=
    preFinalTrustFilterCount-comps.length;

  marketGroundingSources=
    marketGroundingSources.filter(
      trustedLuxuryMarketEntry
    );

  const structuredResearchReferences=
    comps.slice(0,40).map(c=>({
      source:String(c?.source||'').trim()||sourceKey(c),
      title:String(c?.title||'').trim(),
      url:String(c?.url||c?.link||'').trim(),

      price:Number.isFinite(Number(c?.price))
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
      ).trim()
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
    return (compRank[al]??3)-(compRank[bl]??3);
  });

  for(const c of rankedComps.slice(0,24)){
    const eur=comparableToEur(c);
    const url=String(c?.url||'').trim();
    const source=String(c?.source||'').trim()||sourceKey(c);
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
        : []
    });
  }
  const relevant=normalized.filter(
    c=>c.match_level==='EXACT'||c.match_level==='NEAR'
  );

  const exactOnly=relevant.filter(
    c=>c.match_level==='EXACT'
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

  let modelMarketConfidence='LOW';

  if(
    relevant.length>=3 &&
    modelSources.length>=2 &&
    exact.confidence>=0.85
  ){
    modelMarketConfidence='HIGH';
  }else if(
    relevant.length>=2 &&
    modelSources.length>=1 &&
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

  const conditionSources=[
    ...new Set(conditionMatched.map(sourceKey).filter(Boolean))
  ];

  const conditionPrices=conditionMatched
    .map(c=>roundMoney(c.price_eur))
    .filter(v=>Number.isFinite(v)&&v>0);

  let conditionMarketConfidence='LOW';

  if(
    targetConditionKnown &&
    targetConditionConfidenceFinal>=0.70 &&
    conditionMatched.length>=3 &&
    conditionSources.length>=2
  ){
    conditionMarketConfidence='HIGH';
  }else if(
    targetConditionKnown &&
    targetConditionConfidenceFinal>=0.50 &&
    conditionMatched.length>=2 &&
    conditionSources.length>=1
  ){
    conditionMarketConfidence='MEDIUM';
  }

  // Con un solo comparable o condition incierta NO publicamos
  // un precio de reventa "ajustado". Eso sería inventarlo.
  const conditionValuationUsable=
    conditionMarketConfidence==='HIGH' ||
    conditionMarketConfidence==='MEDIUM';

  const valuationPrices=conditionValuationUsable
    ? conditionPrices
    : [];

  const conditionLow=valuationPrices.length
    ? roundMoney(percentile(valuationPrices,0.10)??0)||null
    : null;

  const conditionMedian=valuationPrices.length
    ? roundMoney(percentile(valuationPrices,0.50)??0)||null
    : null;

  const conditionHigh=valuationPrices.length
    ? roundMoney(percentile(valuationPrices,0.90)??0)||null
    : null;

  const conditionConservative=valuationPrices.length
    ? roundMoney(percentile(valuationPrices,0.25)??0)||null
    : null;

  const conditionQuick=valuationPrices.length
    ? roundMoney(percentile(valuationPrices,0.15)??0)||null
    : null;

  return {
    comparables:normalized,
    research_references:researchReferences,
    vision_web_detection:visionWeb,
    visual_candidate_count:visionCandidates.length,
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

  const resaleEstimateSource=
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

  const conservative=
    resaleEstimateSource==='MARKET_ANALYSIS'
      ? marketConservative
      : resaleEstimateSource==='AI_ESTIMATE'
        ? aiLow
        : null;

  const low=
    resaleEstimateSource==='MARKET_ANALYSIS'
      ? (
          Number.isFinite(marketLow)
            ? marketLow
            : marketConservative
        )
      : resaleEstimateSource==='AI_ESTIMATE'
        ? aiLow
        : null;

  const high=
    resaleEstimateSource==='MARKET_ANALYSIS'
      ? (
          Number.isFinite(marketHigh)
            ? marketHigh
            : marketConservative
        )
      : resaleEstimateSource==='AI_ESTIMATE'
        ? aiHigh
        : null;

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
  const compN=Number(market.relevant_comparable_count||0);
  const exactN=Number(market.exact_comparable_count||0);
  const sourceN=Number(market.independent_source_count||0);
  const mconf=String(market.market_confidence||'LOW').toUpperCase();
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

  return {
    decision,
    opportunity_score:score,
    resale_low_eur:Number.isFinite(low)?low:null,
    resale_high_eur:Number.isFinite(high)?high:null,

    resale_estimate_source:
      resaleEstimateSource,

    resale_estimate_confidence:
      resaleEstimateConfidence,

    resale_estimate_market_verified:
      resaleEstimateSource==='MARKET_ANALYSIS',

    landed_cost_eur:landed,
    net_profit_low_eur:Number.isFinite(profit)?profit:null,
    net_profit_high_eur:Number.isFinite(highProfit)?highProfit:null,
    decision_reasons_es:reasons.slice(0,4)
  };
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
    .run(item.id,a.brand||'',a.model||'',a.authenticity_risk||'',a.liquidity||'',a.decision||'',numberOrNull(a.opportunity_score),numberOrNull(a.resale_low_eur),numberOrNull(a.resale_high_eur),numberOrNull(a.landed_cost_eur),numberOrNull(a.net_profit_low_eur),numberOrNull(a.net_profit_high_eur),a.notes||'',JSON.stringify(reasons),JSON.stringify(a),now,a.decision||'',JSON.stringify({status:'not_applicable',reason:'no_task_context'}));
}
async function analyzeWithGemini(listingId,taskId=null,analyzeImages=true,onProgress=null){
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

  const key=process.env.GEMINI_API_KEY;
  if(!key)throw new Error('GEMINI_API_KEY is empty in .env');
  const model=process.env.GEMINI_MODEL||'gemini-3.8-flash';
  const item=db.prepare('SELECT * FROM listings WHERE id=?').get(Number(listingId));
  if(!item)throw new Error('Listing not found');
  const task=taskId?taskPublic(db.prepare('SELECT * FROM tasks WHERE id=?').get(Number(taskId))):null;
  const taskContext=task?`\nTASK NAME: ${task.task_name}\nTARGET PRODUCT: ${task.product_query}\nUSER REQUIREMENTS / AI CRITERIA:\n${task.description||''}\nDECISION MODE: ${task.decision_mode}\nKEYWORD RULES: ${(task.keyword_rules||[]).join(', ')}`:'';
  const economics=importEconomics(item);
  const marketplaceVerification=detectMarketplaceVerification(item);
  const prompt=`${CENTRAL_AI_INSTRUCTION}${taskContext}\n\nSOURCE: ${item.source}\nPURCHASE VIA: ${item.purchase_via||''}\nTITLE: ${item.title}\nDESCRIPTION: ${item.description}\nITEM PRICE EUR: ${item.price_eur}\nIMPORT COST BREAKDOWN EUR: ${JSON.stringify(economics)}\nIMPORTED TOTAL / LANDED COST EUR: ${economics.importedTotalEur}\nMARKETPLACE VERIFICATION SIGNAL: ${JSON.stringify(marketplaceVerification)}\nMARKETPLACE VERIFICATION RULE: AVAILABLE or PASSED is a positive risk-reduction signal only. It is never proof of authenticity and must never override HIGH authenticity risk, an exact-model mismatch, severe condition issues or weak live-market evidence. UNKNOWN and UNAVAILABLE are neutral. FAILED is disqualifying and must be REJECT. A seller claim such as 正品 or 정품 alone is NOT a passed verification.\nSELLER: ${item.seller_name}\nSELLER SALES: ${item.seller_sales}\nSELLER REVIEWS: ${item.seller_reviews}\nURL: ${item.url}`;
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

  const first=await geminiJsonRequest({key,model,parts:[{text:prompt},...initialImageParts],googleSearch:false});
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
  if(taskId&&POSITIVE_DECISIONS.has(preliminaryDecision)){
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
      verification={status:'error',preliminary_decision:preliminaryDecision,ai_preliminary_decision:aiPreliminaryDecision,marketplace_verification:marketplaceVerification,error:e?.message||String(e),failed_at:new Date().toISOString()};
      a.decision='REVIEW';
      a.opportunity_score=null;
      a.decision_reasons_es=[`La primera pasada detecto ${preliminaryDecision}, pero el chequeo exacto de modelo/mercado fallo.`,'No se publica como WATCH/BUY/STRONG BUY hasta que la verificacion se complete.'];
      a.notes=[a.notes,`Market verification error: ${e?.message||String(e)}`].filter(Boolean).join(' ');
    }
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
        COALESCE(a.opportunity_score,-1) DESC, l.price_eur ASC, l.last_seen DESC`).all(session.task_id,sessionId));
  }
  return enrichCosts(db.prepare(`SELECT l.*, ssi.source_query, a.brand, a.model, a.authenticity_risk, a.liquidity, a.decision, a.opportunity_score,
    a.resale_low_eur,a.resale_high_eur,a.landed_cost_eur,a.net_profit_low_eur,a.net_profit_high_eur,a.notes,a.decision_reasons_es_json,a.preliminary_decision,a.verification_json
    FROM search_session_items ssi
    JOIN listings l ON l.id=ssi.listing_id
    LEFT JOIN analyses a ON a.listing_id=l.id
    WHERE ssi.session_id=?
    ORDER BY CASE a.decision WHEN 'STRONG BUY' THEN 1 WHEN 'BUY' THEN 2 WHEN 'WATCH' THEN 3 WHEN 'REVIEW' THEN 4 WHEN 'REJECT' THEN 6 ELSE 5 END,
      COALESCE(a.opportunity_score,-1) DESC, l.price_eur ASC, l.last_seen DESC`).all(sessionId));
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
  const japanCalls=JAPAN_RADAR_SPECS.flatMap(spec=>
    jQueries.map(q=>({
      source:spec.id,
      label:spec.label,
      purchaseVia:spec.purchaseVia,
      mode:spec.mode,
      query:q,
      method:spec.mode==='browser'?'BROWSER GET':'GET',
      url:spec.searchUrl(q)
    }))
  );
  let liveStatus={};
  try { liveStatus=JSON.parse(session?.source_status_json||run?.source_status_json||'{}'); } catch {}
  return {
    version:'1.7.1',
    task:{id:task.id,task_name:task.task_name,product_query:task.product_query,enabled:task.enabled,sources},
    run:run?{id:run.id,status:run.status,started_at:run.started_at,finished_at:run.finished_at,session_id:run.session_id,error:run.error||null}:null,
    searchSession:session?{id:session.id,status:session.status,started_at:session.started_at,finished_at:session.finished_at}:null,
    queryPlan:{generatedBy:plan?.generatedBy||'unknown',xianyu:plan?.xianyu||[],bunjang:plan?.bunjang||[],japan:plan?.japan||[]},
    effectiveLimits:{xianyuMaxQueries:xLimit,bunjangMaxQueries:bLimit,japanMaxQueries:jLimit,pages,maxItemsPerQuery:maxItems},
    filters:{minEur,maxEur,newPublishOption:task.new_publish_option||null,personalOnly:!!task.personal_only,freeShipping:!!task.free_shipping,region:task.region||null,accountStrategy:task.account_strategy||'auto',accountStateFile:task.account_state_file||null},
    connectors:{
      xianyu:{enabled:sources.includes('xianyu'),baseUrl:XIANYU_BASE_URL,queriesExecuted:xQueries,calls:xianyuCalls},
      bunjang:{enabled:sources.includes('bunjang'),binary:bunjangCli,queriesExecuted:bQueries,calls:bunjangCalls},
      japan:{enabled:sources.includes('buyee'),provider:'Japan multi-source radar v2',queriesExecuted:jQueries,calls:japanCalls}
    },
    ai:{enabled:task.decision_mode==='ai',configured:!!process.env.GEMINI_API_KEY,model:process.env.GEMINI_MODEL||'gemini-3.8-flash',analyzeImages:!!task.analyze_images,centralInstruction:CENTRAL_AI_INSTRUCTION,userCriteria:task.description||'',keywordRules:task.keyword_rules||[],positiveVerification:{mandatory:true,stages:['preliminary-screen','exact-visual-model-check','live-google-market-comparables','deterministic-final-decision'],prioritySources:['Vestiaire Collective','Collector Square','EU specialist resellers','The RealReal','Fashionphile','Rebag'],strongBuyMinimum:{modelConfidence:0.85,relevantComparables:3,independentSources:2,marketConfidence:'HIGH'},marketplaceAuthenticitySignal:{enabled:true,xianyu:'Xianyu Verification / 验货宝',bunjang:'Bunjang Care / 번개케어',scores:{AVAILABLE:4,PASSED:8,UNKNOWN:0,UNAVAILABLE:0},failed:'REJECT',sellerAuthenticityClaimIsNotPassed:true}}},
    economics:getEconomics(),
    schedule:{mode:task.interval_minutes?'interval':task.cron?'cron':'manual',intervalMinutes:task.interval_minutes||null,cron:task.cron||null,runIfMissed:task.run_if_missed!==false},
    email:{enabled:!!task.email_enabled,to:task.email_to||null,decisions:task.notify_decisions||[],minScore:task.notify_min_score??null,minProfitEur:task.notify_min_profit_eur??null,maxItems:task.notify_max_items??8,onlyNew:task.notify_only_new!==false},
    liveStatus
  };
}

async function globalSearch(body) {
  const product=String(body.product||body.product_query||'').trim();
  if(!product) throw new Error('Escribe el producto que quieres buscar.');
  const sources=Array.isArray(body.sources)&&body.sources.length?body.sources:['xianyu','bunjang','buyee'];
  const sessionId=randomUUID();
  const startedAt=new Date().toISOString();
  const basePlan=await buildQueryPlan(product);
  const plan=effectivePlan(basePlan,body);
  const taskId=body.taskId?Number(body.taskId):null;
  db.prepare('INSERT INTO search_sessions(id,product_query,query_plan_json,status,started_at,task_id) VALUES(?,?,?,?,?,?)').run(sessionId,product,JSON.stringify(plan),'running',startedAt,taskId);
  if(body.runId) db.prepare('UPDATE task_runs SET session_id=? WHERE id=?').run(sessionId,Number(body.runId));
  const status={};
  const persistStatus=()=>db.prepare('UPDATE search_sessions SET source_status_json=? WHERE id=?').run(JSON.stringify(status),sessionId);
  const opts={
    pages:clampInt(body.pages??body.max_pages,1,1,5),maxItems:clampInt(body.maxItems??body.max_items,20,5,100),
    minEur:body.minEur??body.min_eur??null,maxEur:body.maxEur??body.max_eur??null,sessionId,product,
    personalOnly:!!body.personal_only,freeShipping:!!body.free_shipping,newPublishOption:body.new_publish_option||null,region:body.region||null,
    accountStateFile:body.account_state_file||null,accountStrategy:body.account_strategy||'auto'
  };
  const jobs=[];
  if(sources.includes('bunjang')) { status.bunjang={ok:null,state:'running'}; persistStatus(); jobs.push((async()=>{try{status.bunjang=await searchBunjangLive({...opts,queries:plan.bunjang});}catch(e){status.bunjang={ok:false,state:'error',error:e.message};} finally{persistStatus();}})()); }
  if(sources.includes('buyee')) { status.buyee={ok:null,state:'running'}; persistStatus(); jobs.push((async()=>{try{status.buyee=await searchJapanRadarLive({...opts,queries:plan.japan});}catch(e){status.buyee={ok:false,state:'error',error:e.message};} finally{persistStatus();}})()); }
  await Promise.all(jobs);
  if(sources.includes('xianyu')) { status.xianyu={ok:null,state:'running'}; persistStatus(); try{status.xianyu=await searchXianyuLive({...opts,queries:plan.xianyu});}catch(e){status.xianyu={ok:false,state:'error',error:e.message};} finally{persistStatus();} }
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
      COALESCE(a.opportunity_score,-1) DESC, task_last_seen DESC`).all(Number(taskId),Number(taskId)));
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
      l.raw_json
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
        future:0
      };
    }

    const publishedMs=listingPublishedAtMs(row);
    let reason=null;

    if(publishedMs===null){
      reason='unknown';
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
async function executeTask(taskId, runId=null) {
  if(runId && runIsAborted(runId)){
    return abortedResult(runId);
  }
  taskId=Number(taskId); if(runningTaskIds.has(taskId)) throw new Error('La tarea ya está ejecutándose.');
  const task=taskPublic(db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId)); if(!task) throw new Error('Tarea no encontrada.');
  if(!task.enabled) throw new Error('La tarea está desactivada.');
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
      taskId,runId:Number(runId),product:task.product_query,sources:task.sources,pages:task.max_pages,maxItems:task.max_items,minEur:task.min_eur,maxEur:task.max_eur,
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
    } else if(process.env.GEMINI_API_KEY){
      const items=sessionListings(result.sessionId);
      const pendingItems=[];

      for(const item of items){
        const existingAnalysis=db.prepare(
          'SELECT decision,verification_json FROM task_analyses WHERE task_id=? AND listing_id=?'
        ).get(taskId,item.id);

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
              verificationStatus!=='verified'
            );

          if(!needsVerification)continue;
        }

        pendingItems.push(item);
      }

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

      for(let idx=0;idx<total;idx++){
        if(runIsAborted(runId)){
          return abortedResult(runId,result.sessionId);
        }

        const item=pendingItems[idx];

        const itemProgress=(pct,stage,detail='')=>{
          const local=Math.max(
            0,
            Math.min(100,Number(pct)||0)
          );

          const overall=
            30 +
            Math.round(
              60*((idx+(local/100))/Math.max(total,1))
            );

          setTaskRunProgress(
            runId,
            Math.min(90,overall),
            stage,
            `Anuncio ${idx+1}/${total}${detail?' · '+detail:''}`,
            idx,
            total
          );
        };

        try{
          await analyzeWithGemini(
            item.id,
            taskId,
            task.analyze_images,
            itemProgress
          );

          await sleep(250);
        }catch(e){
          console.error(
            `AI task ${taskId} listing ${item.id}:`,
            e.message
          );
        }

        const completed=idx+1;

        setTaskRunProgress(
          runId,
          30+Math.round(60*(completed/Math.max(total,1))),
          `Analizados ${completed}/${total}`,
          completed<total
            ? 'Preparando siguiente anuncio'
            : 'Análisis de anuncios completado',
          completed,
          total
        );
      }
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
    db.prepare('UPDATE tasks SET last_run_at=?,updated_at=? WHERE id=?').run(finished,finished,taskId);
    return {runId,sessionId:result.sessionId,count:finalItems.length,status:result.status,email:emailResult};
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
  alertSelected=alertSelected.slice(0,task.notify_max_items||8);

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
  const intervalMinutes=Math.max(60,Number(setting.digest_interval_minutes||180));
  const intervalMs=intervalMinutes*60000;
  const state=getSetting('global_digest_state',{last_sent_at:null});
  const anchorRaw=state?.last_sent_at||setting.started_at||new Date(now.getTime()-intervalMs).toISOString();
  const anchorDate=new Date(anchorRaw);
  const anchor=Number.isFinite(anchorDate.getTime())?anchorDate:new Date(now.getTime()-intervalMs);
  const elapsedMs=now.getTime()-anchor.getTime();

  if(!force && elapsedMs < intervalMs-120000){
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
          durante las ultimas 3 horas.
        </td>
      </tr>`;

  const sendTime=globalDigestMadridLabel(now,setting.timezone||'Europe/Madrid');
  const sendFull=globalDigestMadridFullLabel(now,setting.timezone||'Europe/Madrid');
  const subject=`${setting.subject_prefix||'Resumen'} - ${sendTime}`;
  const headline=opportunities.length
    ? `${opportunities.length} anuncio${opportunities.length===1?'':'s'} interesante${opportunities.length===1?'':'s'} en las ultimas 3 horas`
    : 'No ha habido novedades';

  const html=`
    <div style="font-family:Arial,sans-serif;color:#111827;max-width:1000px;margin:auto">
      <h2 style="margin-bottom:4px">Resumen Luxury Hunter</h2>
      <p style="color:#6b7280;margin-top:0">Enviado: ${htmlEsc(sendFull)} - Ventana resumida: ultimos ${intervalMinutes} min.</p>
      <div style="background:#f3f4f6;padding:16px;border-radius:8px;margin:18px 0">
        <b>${htmlEsc(headline)}</b><br><br>
        STRONG BUY: <b>${counts['STRONG BUY']}</b><br>
        BUY: <b>${counts.BUY}</b><br>
        WATCH: <b>${counts.WATCH}</b><br>
        Tareas con ejecuciones: <b>${summaries.length}</b><br>
        Productos analizados: <b>${totalAnalyzed}</b>
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
    text:`Resumen ${sendTime}\nSTRONG BUY: ${counts['STRONG BUY']}\nBUY: ${counts.BUY}\nWATCH: ${counts.WATCH}\n${opportunities.length?'':'No ha habido novedades.'}`
  });

  const sentAt=now.toISOString();

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
    'email','global-digest',`3h digest: ${runs.length} task runs; ${opportunities.length} opportunities; sent to ${recipient}`,sentAt
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
    previously_emailed_skipped:previouslyEmailedSkipped
  };
}

function statusPayload() {
  return {
    app:'Luxury Hunter v1.7.1', port:PORT, xianyuBaseUrl:XIANYU_BASE_URL,
    bunjangCliExists:fs.existsSync(bunjangCli), geminiConfigured:!!process.env.GEMINI_API_KEY, emailConfigured:smtpConfig().configured,
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
    if(req.method==='GET'&&u.pathname==='/api/economics') return json(res,200,{economics:getEconomics()});
    if(req.method==='PUT'&&u.pathname==='/api/economics'){
      const b=await readBody(req);
      const economics=saveEconomics(b);
      scheduleCloudConfigSync('economics-update');
      return json(res,200,{economics});
    }
    if(req.method==='GET'&&u.pathname==='/api/xianyu/accounts'){
      try{return json(res,200,{accounts:await xianyuFetch('/api/accounts',{timeoutMs:7000})});}catch(e){return json(res,200,{accounts:[],error:e.message});}
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
      const rr=db.prepare('INSERT INTO task_runs(task_id,status,started_at) VALUES(?,?,?)').run(taskId,'queued',new Date().toISOString());
      const runId=Number(rr.lastInsertRowid); setImmediate(()=>executeTask(taskId,runId).catch(e=>console.error('Task run failed',taskId,e.message)));
      return json(res,202,{runId,status:'queued'});
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
      const items=enrichCosts(db.prepare(`SELECT l.*,a.brand,a.model,a.authenticity_risk,a.liquidity,a.decision,a.opportunity_score,a.resale_low_eur,a.resale_high_eur,a.landed_cost_eur,a.net_profit_low_eur,a.net_profit_high_eur,a.notes,a.decision_reasons_es_json,a.preliminary_decision,a.verification_json FROM listings l LEFT JOIN analyses a ON a.listing_id=l.id ORDER BY l.last_seen DESC LIMIT 300`).all());
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
  try{const n=await updateFx();console.log(`FX updated (${n})`);}catch(e){console.log(`FX update skipped: ${e.message}`);}
  const schedulerDisabled=String(process.env.DISABLE_SCHEDULER||'').toLowerCase();
  if(!['1','true','yes','on'].includes(schedulerDisabled)){
    setInterval(()=>schedulerTick().catch(e=>console.error('Scheduler:',e.message)),30000);
  } else {
    console.log('Scheduler disabled for one-shot/cloud execution.');
  }
});
