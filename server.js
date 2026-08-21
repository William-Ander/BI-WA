require('dotenv').config();

(function validateEnvPasswords() {
  const keys = ['MYSQL_PASSWORD', 'ONLINE_MYSQL_PASSWORD', 'BIWA_PG_CACHE_PASSWORD'];
  for (const key of keys) {
    const raw = process.env[key];
    if (!raw) continue;
    const cleaned = raw.replace(/^["']|["']$/g, '').trim();
    if (cleaned !== raw) {
      console.warn('[BI WA] ATENCAO: ' + key + ' no .env contem aspas desnecessarias. A senha foi corrigida automaticamente.');
      console.warn('[BI WA]    O valor da senha foi ocultado por seguranca.');
      process.env[key] = cleaned;
    }
  }
})();

const cors = require('cors');
const crypto = require('crypto');
const express = require('express');
const fs = require('fs/promises');
const fsSync = require('fs');
const http = require('http');
const mysql = require('mysql2/promise');
const path = require('path');
const { Server } = require('socket.io');
const packageInfo = require('./package.json');
const logger = require('./lib/logger');
let PgPool = null;
try { PgPool = require('pg').Pool; }
catch (err) { PgPool = null; }
try { var pgTypes = require('pg').types; pgTypes.setTypeParser(1082, function(val) { return val; }); }
catch (err) {}
const { Client: SshClient } = require('ssh2');

const APP_VERSION = packageInfo.version || '0.0.0';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || undefined,
    credentials: true
  }
});

const PORT = Number(process.env.PORT || 3000);
const APP_MODE = ['online', 'viewer', 'view'].includes(String(process.env.APP_MODE || '').toLowerCase())
  ? 'online'
  : 'desktop';
const DATA_DIR = path.join(__dirname, 'data');
const DEBUG_LOG_FILE = path.join(__dirname, 'cascade_debug.log');
const DEBUG_LOG_ARCHIVE_FILE = path.join(__dirname, 'cascade_debug.log.1');
const DEBUG_LOG_ENABLED = ['1', 'true', 'yes', 'sim'].includes(String(process.env.BIWA_FILTER_DEBUG_LOG || '').trim().toLowerCase());
const DEBUG_LOG_MAX_BYTES = Math.max(1024 * 1024, Number(process.env.BIWA_FILTER_DEBUG_LOG_MAX_BYTES || 5 * 1024 * 1024));
const VISUAL_FIELD_DEBUG_ENABLED = ['1', 'true', 'yes', 'sim'].includes(String(process.env.BIWA_VISUAL_FIELD_DEBUG || '').trim().toLowerCase());
let debugLogWriteChain = Promise.resolve();
function debugLog(msg) {
  if (!DEBUG_LOG_ENABLED) return;
  const line = new Date().toISOString() + ' ' + String(msg || '') + '\n';
  debugLogWriteChain = debugLogWriteChain.then(async function writeDebugLine() {
    try {
      const stat = await fs.stat(DEBUG_LOG_FILE).catch(() => null);
      if (stat && stat.size >= DEBUG_LOG_MAX_BYTES) {
        await fs.rm(DEBUG_LOG_ARCHIVE_FILE, { force: true }).catch(() => {});
        await fs.rename(DEBUG_LOG_FILE, DEBUG_LOG_ARCHIVE_FILE).catch(() => {});
      }
      await fs.appendFile(DEBUG_LOG_FILE, line, 'utf8');
    } catch (e) { /* diagnostico nunca deve interromper o app */ }
  }).catch(() => {});
}
function visualFieldDebug(stage, payload) {
  if (!VISUAL_FIELD_DEBUG_ENABLED) return;
  let detail = '';
  try {
    detail = typeof payload === 'string' ? payload : JSON.stringify(payload, function(key, value) {
      if (key === 'sql' && typeof value === 'string' && value.length > 3000) return value.slice(0, 3000) + ' /* ... diagnóstico truncado ... */';
      return value;
    });
  }
  catch (error) { detail = String(payload || ''); }
  console.log('[' + String(stage || 'VISUAL FIELD') + '] ' + detail);
}
const REPORTS_FILE = path.join(DATA_DIR, 'reports.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const MYSQL_AUTH_GUARD_FILE = path.join(DATA_DIR, 'mysql_auth_guard.json');
const MANUAL_TABLES_FILE = path.join(DATA_DIR, 'manual_tables.json');
const COLUMN_FORMATS_FILE = path.join(DATA_DIR, 'column_formats.json');
const MANUAL_TABLE_SYNC_MAX_ROWS_PER_TABLE = 5000;
const MANUAL_TABLE_SYNC_MAX_TOTAL_ROWS = 25000;
const IMPORTED_TABLES_FILE = path.join(DATA_DIR, 'imported_tables.json');
const HIDDEN_TABLES_FILE = path.join(DATA_DIR, 'hidden_tables.json');
const AUDIT_LOG_FILE = path.join(DATA_DIR, 'audit_log.json');
const ERRORS_DIR = path.join(DATA_DIR, 'erros');
const POSTGRES_CACHE_ENABLED = String(process.env.BIWA_PG_CACHE_ENABLED || 'true').toLowerCase() !== 'false';
const POSTGRES_CACHE_SCHEMA = String(process.env.BIWA_PG_CACHE_SCHEMA || 'biwa_cache').trim() || 'biwa_cache';
const POSTGRES_CACHE_DATABASE_URL = String(process.env.BIWA_PG_CACHE_URL || process.env.DATABASE_URL || '').trim();
const POSTGRES_CACHE_HOST = String(process.env.BIWA_PG_CACHE_HOST || '127.0.0.1').trim();
const POSTGRES_CACHE_PORT = Number(process.env.BIWA_PG_CACHE_PORT || 5432);
const POSTGRES_CACHE_DATABASE = String(process.env.BIWA_PG_CACHE_DATABASE || 'bi_wa_cache').trim();
const POSTGRES_CACHE_USER = String(process.env.BIWA_PG_CACHE_USER || 'biwa_cache').trim();
const POSTGRES_CACHE_PASSWORD = String(process.env.BIWA_PG_CACHE_PASSWORD || 'biwa_cache').trim();
const POSTGRES_CACHE_DEFAULT_BATCH_SIZE = Number(process.env.BIWA_PG_CACHE_BATCH_SIZE || 50000);
const POSTGRES_CACHE_DEFAULT_MAX_ROWS = Number(process.env.BIWA_PG_CACHE_MAX_ROWS || Number.MAX_SAFE_INTEGER);
const POSTGRES_CACHE_SYNC_OWNER_RAW = String(process.env.BIWA_PG_CACHE_SYNC_OWNER || 'all').trim().toLowerCase();
const POSTGRES_CACHE_SYNC_OWNER = ['server', 'desktop', 'all', 'disabled'].includes(POSTGRES_CACHE_SYNC_OWNER_RAW)
  ? POSTGRES_CACHE_SYNC_OWNER_RAW
  : 'all';
const RESOURCE_QUERY_TIMEOUT_MS = Number(process.env.RESOURCE_QUERY_TIMEOUT_MS || 8000);
const RESOURCE_TOTAL_TIMEOUT_MS = Number(process.env.RESOURCE_TOTAL_TIMEOUT_MS || 15000);
const RESOURCE_CACHE_TTL_MS = Number(process.env.RESOURCE_CACHE_TTL_MS || 120000);
const TABLE_ROWS_QUERY_TIMEOUT_MS = Number(process.env.TABLE_ROWS_QUERY_TIMEOUT_MS || 90000);
const TABLE_COLUMNS_QUERY_TIMEOUT_MS = Number(process.env.TABLE_COLUMNS_QUERY_TIMEOUT_MS || 20000);
let resourceListCache = { key: '', savedAt: 0, resources: [], diagnostics: [] };
const CALENDAR_TABLE_NAME = 'Calendario';
const SEMANTIC_MODEL_FILE = path.join(DATA_DIR, 'semantic_model.json');
const TRANSFORMS_FILE = path.join(DATA_DIR, 'transform_queries.json');
const DEFAULT_REFRESH_SECONDS = Number(process.env.DEFAULT_REFRESH_SECONDS || 15);
const SERVER_PUSH_INTERVAL_SECONDS = Number(process.env.SERVER_PUSH_INTERVAL_SECONDS || DEFAULT_REFRESH_SECONDS || 15);
const QUERY_CACHE_ENABLED = parseBool(process.env.BIWA_QUERY_CACHE_ENABLED, true);
const QUERY_CACHE_TTL_MS = Number(process.env.BIWA_QUERY_CACHE_TTL_MS || 15000);
const QUERY_CACHE_MAX_ITEMS = Number(process.env.BIWA_QUERY_CACHE_MAX_ITEMS || 250);
const FILTER_OPTIONS_CACHE_TTL_MS = Number(process.env.BIWA_FILTER_OPTIONS_CACHE_TTL_MS || 300000);
const FILTER_OPTIONS_CACHE_MAX_ITEMS = Number(process.env.BIWA_FILTER_OPTIONS_CACHE_MAX_ITEMS || 300);
const FILTER_OPTIONS_QUERY_TIMEOUT_MS = Math.max(2000, Number(process.env.BIWA_FILTER_OPTIONS_QUERY_TIMEOUT_MS || 8000));
const ANALYTIC_PG_QUERY_TIMEOUT_MS = Math.max(5000, Number(process.env.BIWA_ANALYTIC_PG_QUERY_TIMEOUT_MS || 30000));
const REALTIME_EVENT_TABLE = String(process.env.BIWA_REALTIME_EVENT_TABLE || '').trim();
const REALTIME_EVENT_COLUMN = String(process.env.BIWA_REALTIME_EVENT_COLUMN || 'updated_at').trim();
const REALTIME_EVENT_POLL_SECONDS = Number(process.env.BIWA_REALTIME_EVENT_POLL_SECONDS || 5);
const DATA_SOURCE_HEALTH_INTERVAL_MS = Math.max(3000, Number(process.env.BIWA_DATA_SOURCE_HEALTH_INTERVAL_MS) || 5000);
const DATA_SOURCE_HEALTH_TIMEOUT_MS = Math.min(5000, Math.max(1000, Number(process.env.BIWA_DATA_SOURCE_HEALTH_TIMEOUT_MS) || 2500));
const MYSQL_AUTH_MANUAL_RETRY_COOLDOWN_MS = Math.max(60000, Number(process.env.BIWA_MYSQL_AUTH_MANUAL_RETRY_COOLDOWN_MS) || 30 * 60 * 1000);
const BIWA_TIME_ZONE = String(process.env.BIWA_TIME_ZONE || 'America/Bahia');

let pool = null;
let poolSignature = '';
let lastPoolRecreateAt = 0;
let settingsCache = null;
let mysqlAuthGuardLoaded = false;
let mysqlAuthGuard = null;
let mysqlAuthVerifiedSignature = '';
let mysqlAuthProbe = null;
let mysqlAuthGuardWriteChain = Promise.resolve();
const AUTH_TOKEN_TTL_MS = Number(process.env.BIWA_AUTH_TOKEN_TTL_MS || 12 * 60 * 60 * 1000);
const AUTH_SECRET = process.env.BIWA_AUTH_SECRET || process.env.SYNC_TOKEN || 'biwa-local-secret';

const ONLINE_ALLOW_OPEN_ACCESS = parseBool(process.env.BIWA_ALLOW_OPEN_ONLINE || process.env.ALLOW_OPEN_ONLINE, false);
const API_RATE_WINDOW_MS = Number(process.env.API_RATE_WINDOW_MS || 60000);
const API_RATE_MAX_REQUESTS = Number(process.env.API_RATE_MAX_REQUESTS || 90);
const apiRateBuckets = new Map();
const queryCache = new Map();
const inFlightQueryCache = new Map();
const filterOptionsCache = new Map();
let queryCacheGeneration = 0;
let semanticModelMemCache = null;
let semanticModelMemCacheAt = 0;
const SEMANTIC_MODEL_MEM_CACHE_TTL_MS = 30000;
let realtimeEventMarker = null;
let realtimeEventCheckedAt = 0;
let realtimeEventLastChangeAt = 0;
let realtimeEventLastError = '';
let dataSourceHealthProbePromise = null;
let dataSourceHealthTimer = null;
let dataSourceHealthSnapshot = {
  mysqlAvailable: null,
  checkedAt: null,
  statusChangedAt: null,
  lastPgSyncAt: null
};
let pgCacheSchedulerState = {
  owner: POSTGRES_CACHE_SYNC_OWNER,
  appMode: APP_MODE,
  enabled: false,
  running: false,
  intervalMinutes: null,
  lastStartedAt: null,
  lastCompletedAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastTrigger: '',
  lastResult: null,
  lastSkippedReason: ''
};

// Redireciona console para logger em arquivo
const origConsoleLog = console.log.bind(console);
const origConsoleError = console.error.bind(console);
const origConsoleWarn = console.warn.bind(console);
console.log = (...args) => { origConsoleLog(...args); logger.log(...args); };
console.error = (...args) => { origConsoleError(...args); logger.error(...args); };
console.warn = (...args) => { origConsoleWarn(...args); logger.warn(...args); };

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['true', '1', 'yes', 'sim', 's'].includes(String(value).toLowerCase());
}

function envBool(name, fallback = false) {
  return parseBool(process.env[name], fallback);
}

function pgCacheSyncOwnedByCurrentProcess() {
  if (POSTGRES_CACHE_SYNC_OWNER === 'disabled') return false;
  if (POSTGRES_CACHE_SYNC_OWNER === 'server') return APP_MODE === 'online';
  if (POSTGRES_CACHE_SYNC_OWNER === 'desktop') return APP_MODE === 'desktop';
  return true;
}

function publicPgCacheSchedulerState() {
  const lastResult = pgCacheSchedulerState.lastResult;
  return {
    owner: pgCacheSchedulerState.owner,
    appMode: pgCacheSchedulerState.appMode,
    enabled: Boolean(pgCacheSchedulerState.enabled),
    running: Boolean(pgCacheSchedulerState.running),
    intervalMinutes: pgCacheSchedulerState.intervalMinutes,
    lastStartedAt: pgCacheSchedulerState.lastStartedAt,
    lastCompletedAt: pgCacheSchedulerState.lastCompletedAt,
    lastSuccessAt: pgCacheSchedulerState.lastSuccessAt,
    lastFailureAt: pgCacheSchedulerState.lastFailureAt,
    lastTrigger: pgCacheSchedulerState.lastTrigger,
    lastSkippedReason: pgCacheSchedulerState.lastSkippedReason,
    lastResult: lastResult ? {
      total: Number(lastResult.total || 0),
      succeeded: Number(lastResult.succeeded || 0),
      failed: Number(lastResult.failed || 0),
      changedRows: Number(lastResult.changedRows || 0),
      skipped: Boolean(lastResult.skipped),
      authBlocked: Boolean(lastResult.authBlocked),
      failedTables: Array.isArray(lastResult.failedTables) ? lastResult.failedTables.slice(0, 20) : []
    } : null
  };
}


function normalizeOnlineUserDataFilters(filters) {
  if (!Array.isArray(filters)) return [];
  const seen = new Set();
  return filters.slice(0, 20).map((filter, index) => {
    const table = String(filter && (filter.table || filter.source || filter.resource) || '').trim();
    const field = String(filter && filter.field || '').trim();
    const value = String(filter && filter.value !== undefined && filter.value !== null ? filter.value : '').trim();
    if (!table || !field || value === '') return null;
    const key = table.toLocaleLowerCase('pt-BR') + '|' + field.toLocaleLowerCase('pt-BR');
    if (seen.has(key)) return null;
    seen.add(key);
    const idSeed = [table, field, index].join('|');
    const rawType = String(filter && filter.type || 'text').toLowerCase();
    return {
      id: String(filter && filter.id || ('udf_' + crypto.createHash('sha1').update(idSeed).digest('hex').slice(0, 12))).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80),
      table,
      field,
      label: String(filter && filter.label || field).trim().slice(0, 120) || field,
      operator: '=',
      value: value.slice(0, 500),
      type: ['text', 'number', 'date'].includes(rawType) ? rawType : 'text'
    };
  }).filter(Boolean);
}

function onlineUserDataRestrictionRevision(user) {
  const filters = normalizeOnlineUserDataFilters(user && user.dataFilters);
  if (!filters.length) return 'none';
  return crypto.createHash('sha256').update(stableJson(filters)).digest('hex').slice(0, 20);
}

function normalizeOnlineUsers(users) {
  if (!Array.isArray(users)) return [];
  const seen = new Set();
  return users.slice(0, 200).map((user) => {
    const username = String(user && (user.username || user.user || user.login) || '').trim();
    if (!username || seen.has(username.toLowerCase())) return null;
    seen.add(username.toLowerCase());
    const reportPermissionsRaw = user && user.reportPermissions && typeof user.reportPermissions === 'object' ? user.reportPermissions : {};
    const reportPermissions = {};
    for (const [reportIdRaw, permRaw] of Object.entries(reportPermissionsRaw)) {
      const reportId = String(reportIdRaw || '').trim();
      if (!reportId) continue;
      const perm = permRaw && typeof permRaw === 'object' ? permRaw : {};
      reportPermissions[reportId] = {
        allPages: Boolean(perm.allPages),
        pageIds: Array.isArray(perm.pageIds) ? perm.pageIds.map((id) => String(id || '').trim()).filter(Boolean).slice(0, 100) : []
      };
    }
    const allReports = user && Object.prototype.hasOwnProperty.call(user, 'allReports')
      ? Boolean(user.allReports)
      : Object.keys(reportPermissions).length === 0;
    return {
      id: String(user && user.id || crypto.createHash('sha1').update(username).digest('hex').slice(0, 12)),
      username,
      name: String(user && user.name || username).trim().slice(0, 120),
      password: String(user && user.password || ''),
      profileUpdatedAt: String(user && user.profileUpdatedAt || ''),
      active: user && 'active' in user ? Boolean(user.active) : true,
      role: 'viewer',
      allReports,
      reportPermissions,
      dataFilters: normalizeOnlineUserDataFilters(user && user.dataFilters)
    };
  }).filter(Boolean);
}

function sanitizeOnlineUsers(users) {
  return normalizeOnlineUsers(users).map((user) => ({
    id: user.id,
    username: user.username,
    name: user.name,
    profileUpdatedAt: user.profileUpdatedAt || '',
    active: user.active,
    hasPassword: Boolean(user.password),
    allReports: Boolean(user.allReports),
    reportPermissions: user.reportPermissions || {},
    dataFilters: normalizeOnlineUserDataFilters(user.dataFilters)
  }));
}

function effectiveOnlineUsers(settings = getSettings()) {
  const configured = normalizeOnlineUsers(settings.access && settings.access.onlineUsers);
  if (configured.length) return configured;
  if (settings.access && settings.access.viewerUser) {
    return normalizeOnlineUsers([{
      username: settings.access.viewerUser,
      name: 'Visualizador padrão',
      password: settings.access.viewerPassword || '',
      active: true,
      allReports: true,
      reportPermissions: {}
    }]);
  }
  return [];
}

function userCanAccessReport(user, report) {
  if (!user || user.role === 'admin') return true;
  if (user.allReports) return true;
  const permissions = user.reportPermissions || {};
  return Boolean(permissions[report.id]);
}

function allowedPageIdsForReport(user, report) {
  const pages = normalizeReportPages(report.pages);
  if (!user || user.role === 'admin') return pages.map((page) => page.id);
  if (user.allReports) return pages.map((page) => page.id);
  const permissions = user.reportPermissions || {};
  const perm = permissions[report.id];
  if (!perm) return [];
  if (perm.allPages) return pages.map((page) => page.id);
  const allowed = new Set(Array.isArray(perm.pageIds) ? perm.pageIds.map(String) : []);
  return pages.filter((page) => allowed.has(page.id)).map((page) => page.id);
}

function applyUserAccessToReport(report, user) {
  const allowedPages = allowedPageIdsForReport(user, report);
  if (!allowedPages.length) return null;
  const allowedSet = new Set(allowedPages);
  const clone = { ...report };
  clone.pages = normalizeReportPages(report.pages).filter((page) => allowedSet.has(page.id));
  clone.visuals = Array.isArray(report.visuals) ? report.visuals.filter((visual) => allowedSet.has(String(visual.pageId || 'page_1'))) : [];
  clone.onlineFilters = normalizeOnlineFilters(report.onlineFilters).filter((filter) => {
    if (!filter || filter.scope !== 'page') return true;
    return allowedSet.has(String(filter.pageId || filter.target || ''));
  });
  return clone;
}

function reportsForAuthUser(reports, user) {
  if (!Array.isArray(reports)) return [];
  return reports.map((report) => applyUserAccessToReport(report, user)).filter(Boolean);
}

function signAuthPayload(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}

function readAuthToken(token) {
  const raw = String(token || '').trim();
  const parts = raw.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || !payload.exp || Date.now() > Number(payload.exp)) return null;
    return payload;
  } catch (err) {
    return null;
  }
}

function buildAuthToken(user) {
  return signAuthPayload({
    sub: user.username,
    name: user.name || user.username,
    role: user.role || 'viewer',
    exp: Date.now() + AUTH_TOKEN_TTL_MS
  });
}


function onlineUsersFromEnv() {
  let raw = process.env.BIWA_ONLINE_USERS_JSON || '';
  const encoded = String(process.env.BIWA_ONLINE_USERS_BASE64 || '').trim();
  if (encoded) {
    try { raw = Buffer.from(encoded, 'base64').toString('utf8'); } catch (err) { raw = ''; }
  }
  if (!raw) return [];
  try {
    return normalizeOnlineUsers(JSON.parse(raw));
  } catch (err) {
    console.warn('BIWA_ONLINE_USERS_JSON invalido. Ignorando lista de usuarios online do .env.');
    return [];
  }
}

function defaultSettings() {
  const desktop = APP_MODE === 'desktop';
  const generatedToken = desktop ? crypto.randomBytes(24).toString('hex') : '';
  return {
    permissions: {
      tableWrites: envBool('ALLOW_TABLE_WRITES', desktop),
      schemaChanges: envBool('ALLOW_SCHEMA_CHANGES', desktop),
      reportEditing: envBool('ALLOW_REPORT_EDITING', desktop),
      publishOnline: envBool('ALLOW_PUBLISH', desktop)
    },
    access: {
      adminUser: process.env.APP_USER || 'william',
      adminName: process.env.APP_ADMIN_NAME || 'Administrador',
      adminUpdatedAt: process.env.APP_ADMIN_UPDATED_AT || '',
      adminPassword: process.env.APP_PASSWORD || '',
      viewerUser: process.env.VIEWER_USER || 'viewer',
      viewerPassword: process.env.VIEWER_PASSWORD || '',
      onlineUsers: normalizeOnlineUsers(onlineUsersFromEnv().length ? onlineUsersFromEnv() : [{ username: process.env.VIEWER_USER || 'viewer', name: 'Visualizador padrão', password: process.env.VIEWER_PASSWORD || '', active: true, reportPermissions: {} }])
    },
    database: {
      connectionPath: process.env.MYSQL_CONNECTION_PATH || 'direct',
      mysqlHost: process.env.MYSQL_HOST || '127.0.0.1',
      mysqlPort: process.env.MYSQL_PORT || '3306',
      mysqlUser: process.env.MYSQL_USER || 'root',
      mysqlPassword: process.env.MYSQL_PASSWORD || '',
      mysqlDatabase: process.env.MYSQL_DATABASE || '',
      mysqlSsl: process.env.MYSQL_SSL || 'false',
      mysqlCharset: process.env.MYSQL_CHARSET || 'utf8mb4',
      connectionLimit: process.env.DB_CONNECTION_LIMIT || '10'
    },
    publish: {
      onlineUrl: process.env.ONLINE_APP_URL || '',
      syncToken: process.env.SYNC_TOKEN || generatedToken,
      lastPublishedAt: '',
      lastPublishedCount: 0,
      lastPublishedUrl: '',
      lastPublishedVersion: '',
      lastPublishStatus: '',
      lastPublishMessage: '',
      lastOnlineCheckAt: '',
      lastOnlineMode: '',
      lastOnlineReportCount: 0
    },
    pgCache: {
      syncIntervalMinutes: Number(process.env.BIWA_PG_CACHE_SYNC_INTERVAL_MINUTES || 0) || (Number(process.env.BIWA_PG_SYNC_INTERVAL_MS || 300000) / 60000),
      recentWindowDays: Number(process.env.BIWA_PG_CACHE_RECENT_WINDOW_DAYS || 90)
    },
    web: {
      port: process.env.ONLINE_PORT || '3000',
      mysqlHost: process.env.ONLINE_MYSQL_HOST || process.env.MYSQL_HOST || '127.0.0.1',
      mysqlPort: process.env.ONLINE_MYSQL_PORT || process.env.MYSQL_PORT || '3306',
      mysqlUser: process.env.ONLINE_MYSQL_USER || process.env.MYSQL_USER || 'bi_viewer',
      mysqlPassword: process.env.ONLINE_MYSQL_PASSWORD || process.env.MYSQL_PASSWORD || '',
      mysqlDatabase: process.env.ONLINE_MYSQL_DATABASE || process.env.MYSQL_DATABASE || '',
      mysqlSsl: process.env.ONLINE_MYSQL_SSL || process.env.MYSQL_SSL || 'false',
      mysqlCharset: process.env.ONLINE_MYSQL_CHARSET || process.env.MYSQL_CHARSET || 'utf8mb4',
      corsOrigin: process.env.ONLINE_CORS_ORIGIN || process.env.CORS_ORIGIN || '',
      defaultRefreshSeconds: process.env.ONLINE_DEFAULT_REFRESH_SECONDS || process.env.DEFAULT_REFRESH_SECONDS || '15',
      serverPushIntervalSeconds: process.env.ONLINE_SERVER_PUSH_INTERVAL_SECONDS || process.env.SERVER_PUSH_INTERVAL_SECONDS || process.env.DEFAULT_REFRESH_SECONDS || '15'
    },
    vps: {
      host: process.env.VPS_HOST || '',
      port: process.env.VPS_PORT || '22',
      user: process.env.VPS_USER || 'root',
      keyPath: process.env.VPS_KEY_PATH || '',
      domain: process.env.VPS_DOMAIN || '',
      appPath: process.env.VPS_APP_PATH || '/opt/biwa'
    }
  };
}

function mergeSettings(base, saved) {
  const source = saved && typeof saved === 'object' ? saved : {};
  const savedAccess = source.access && typeof source.access === 'object' ? source.access : {};
  const bootstrapOnlineAdmin = APP_MODE === 'online' && !savedAccess.adminPassword && Boolean(base.access.adminPassword);
  const mergedPermissions = {
    ...base.permissions,
    ...(source.permissions && typeof source.permissions === 'object' ? source.permissions : {})
  };
  const mergedAccess = {
    ...base.access,
    ...savedAccess,
    onlineUsers: normalizeOnlineUsers(savedAccess.onlineUsers || base.access.onlineUsers || [])
  };
  if (bootstrapOnlineAdmin) {
    mergedAccess.adminUser = base.access.adminUser;
    mergedAccess.adminName = base.access.adminName;
    mergedAccess.adminPassword = base.access.adminPassword;
    Object.assign(mergedPermissions, base.permissions);
  }
  return {
    permissions: mergedPermissions,
    access: mergedAccess,
    database: {
      ...base.database,
      ...(source.database && typeof source.database === 'object' ? source.database : {})
    },
    publish: {
      ...base.publish,
      ...(source.publish && typeof source.publish === 'object' ? source.publish : {})
    },
    web: {
      ...base.web,
      ...(source.web && typeof source.web === 'object' ? source.web : {})
    },
    pgCache: {
      ...base.pgCache,
      ...(source.pgCache && typeof source.pgCache === 'object' ? source.pgCache : {})
    },
    vps: {
      ...base.vps,
      ...(source.vps && typeof source.vps === 'object' ? source.vps : {})
    },
    onlineCustomization: source.onlineCustomization || base.onlineCustomization || null
  };
}

function getSettings() {
  if (!settingsCache) settingsCache = defaultSettings();
  return settingsCache;
}

function isOnlineViewerRole(role) {
  return APP_MODE === 'online' && String(role || '').toLowerCase() !== 'admin';
}

function effectivePermissions(role = '') {
  if (isOnlineViewerRole(role)) {
    return {
      tableWrites: false,
      schemaChanges: false,
      reportEditing: false,
      publishOnline: false
    };
  }
  const permissions = getSettings().permissions || {};
  return {
    tableWrites: Boolean(permissions.tableWrites),
    schemaChanges: Boolean(permissions.schemaChanges),
    reportEditing: Boolean(permissions.reportEditing),
    publishOnline: Boolean(permissions.publishOnline)
  };
}

function sanitizeSettingsForClient(role = '') {
  const settings = getSettings();
  return {
    permissions: effectivePermissions(role),
    access: {
      adminUser: settings.access.adminUser || '',
      adminName: settings.access.adminName || 'Administrador',
      viewerUser: settings.access.viewerUser || '',
      hasAdminPassword: Boolean(settings.access.adminPassword),
      hasViewerPassword: Boolean(settings.access.viewerPassword),
      onlineUsers: String(role || '').toLowerCase() === 'admin' ? sanitizeOnlineUsers(settings.access.onlineUsers || []) : []
    },
    database: {
      connectionPath: settings.database.connectionPath || 'direct',
      mysqlHost: settings.database.mysqlHost || '',
      mysqlPort: settings.database.mysqlPort || '3306',
      mysqlUser: settings.database.mysqlUser || '',
      mysqlDatabase: settings.database.mysqlDatabase || '',
      mysqlSsl: String(settings.database.mysqlSsl || 'false'),
      mysqlCharset: settings.database.mysqlCharset || 'utf8mb4',
      connectionLimit: settings.database.connectionLimit || '10',
      hasMysqlPassword: Boolean(settings.database.mysqlPassword)
    },
    publish: {
      onlineUrl: settings.publish.onlineUrl || '',
      syncTokenConfigured: Boolean(settings.publish.syncToken),
      lastPublishedAt: settings.publish.lastPublishedAt || '',
      lastPublishedCount: Number(settings.publish.lastPublishedCount || 0),
      lastPublishedUrl: settings.publish.lastPublishedUrl || '',
      lastPublishedVersion: settings.publish.lastPublishedVersion || '',
      lastPublishStatus: settings.publish.lastPublishStatus || '',
      lastPublishMessage: settings.publish.lastPublishMessage || '',
      lastOnlineCheckAt: settings.publish.lastOnlineCheckAt || '',
      lastOnlineMode: settings.publish.lastOnlineMode || '',
      lastOnlineReportCount: Number(settings.publish.lastOnlineReportCount || 0)
    },
    web: {
      port: settings.web.port || '3000',
      mysqlHost: settings.web.mysqlHost || '',
      mysqlPort: settings.web.mysqlPort || '3306',
      mysqlUser: settings.web.mysqlUser || '',
      mysqlDatabase: settings.web.mysqlDatabase || '',
      mysqlSsl: String(settings.web.mysqlSsl || 'false'),
      mysqlCharset: settings.web.mysqlCharset || 'utf8mb4',
      corsOrigin: settings.web.corsOrigin || '',
      defaultRefreshSeconds: settings.web.defaultRefreshSeconds || '15',
      serverPushIntervalSeconds: settings.web.serverPushIntervalSeconds || '15',
      hasMysqlPassword: Boolean(settings.web.mysqlPassword)
    },
    pgCache: {
      syncIntervalMinutes: Number(settings.pgCache && settings.pgCache.syncIntervalMinutes) || 5,
      recentWindowDays: Number(settings.pgCache && settings.pgCache.recentWindowDays) || 90
    },
    onlineCustomization: settings.onlineCustomization || null,
    vps: {
      host: settings.vps && settings.vps.host || '',
      port: settings.vps && settings.vps.port || '22',
      user: settings.vps && settings.vps.user || 'root',
      keyPath: settings.vps && settings.vps.keyPath || '',
      domain: settings.vps && settings.vps.domain || '',
      appPath: settings.vps && settings.vps.appPath || '/opt/biwa'
    }
  };
}

async function loadSettings() {
  const defaults = defaultSettings();
  try {
    const raw = await fs.readFile(SETTINGS_FILE, 'utf8');
    settingsCache = mergeSettings(defaults, JSON.parse(raw || '{}'));
  } catch (err) {
    settingsCache = defaults;
    await writeSettings(settingsCache);
  }
}

async function writeSettings(settings) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = SETTINGS_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, SETTINGS_FILE);
  settingsCache = settings;
}

function activeDbSettings() {
  const settings = getSettings();
  if (APP_MODE !== 'online') return settings.database || {};
  const web = settings.web || {};
  return {
    ...web,
    mysqlHost: process.env.ONLINE_MYSQL_HOST || process.env.MYSQL_HOST || web.mysqlHost || '',
    mysqlPort: process.env.ONLINE_MYSQL_PORT || process.env.MYSQL_PORT || web.mysqlPort || '3306',
    mysqlUser: process.env.ONLINE_MYSQL_USER || process.env.MYSQL_USER || web.mysqlUser || '',
    mysqlPassword: process.env.ONLINE_MYSQL_PASSWORD || process.env.MYSQL_PASSWORD || web.mysqlPassword || '',
    mysqlDatabase: process.env.ONLINE_MYSQL_DATABASE || process.env.MYSQL_DATABASE || web.mysqlDatabase || '',
    mysqlSsl: process.env.ONLINE_MYSQL_SSL || process.env.MYSQL_SSL || web.mysqlSsl || 'false',
    mysqlCharset: process.env.ONLINE_MYSQL_CHARSET || process.env.MYSQL_CHARSET || web.mysqlCharset || 'utf8mb4',
    connectionLimit: process.env.DB_CONNECTION_LIMIT || web.connectionLimit || '10'
  };
}

function onlineDbSettingsForDeployment(settings) {
  const web = settings && settings.web && typeof settings.web === 'object' ? settings.web : {};
  const database = settings && settings.database && typeof settings.database === 'object' ? settings.database : {};
  const webIsComplete = Boolean(web.mysqlHost && web.mysqlUser && web.mysqlDatabase);
  return webIsComplete ? web : database;
}

function buildDbConfig() {
  return buildDbConfigFromSettings(activeDbSettings());
}


function buildDbConfigFromSettings(db) {
  const config = {
    host: db.mysqlHost || '127.0.0.1',
    port: Number(db.mysqlPort || 3306),
    user: db.mysqlUser || 'root',
    password: db.mysqlPassword || '',
    database: db.mysqlDatabase || '',
    charset: db.mysqlCharset || 'utf8mb4',
    waitForConnections: true,
    connectionLimit: Number(db.connectionLimit || process.env.DB_CONNECTION_LIMIT || 10),
    timezone: 'Z',
    dateStrings: false,
    connectTimeout: Number(process.env.MYSQL_CONNECT_TIMEOUT || 8000),
    enableKeepAlive: true,
    keepAliveInitialDelay: 30000,
    ssl: parseBool(db.mysqlSsl) ? { rejectUnauthorized: false } : undefined
  };
  return config;
}

function mysqlCredentialSignature(config) {
  const normalized = {
    host: String(config && config.host || '').trim().toLowerCase(),
    port: Number(config && config.port || 3306),
    user: String(config && config.user || ''),
    password: String(config && config.password || ''),
    database: String(config && config.database || ''),
    ssl: Boolean(config && config.ssl)
  };
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function normalizeMysqlAuthGuard(value) {
  const rawEntries = value && Array.isArray(value.blocked)
    ? value.blocked
    : (value && value.credentialSignature ? [value] : []);
  const seen = new Set();
  const blocked = [];
  for (const item of rawEntries) {
    const signature = String(item && (item.signature || item.credentialSignature) || '').trim();
    if (!/^[a-f0-9]{64}$/i.test(signature) || seen.has(signature)) continue;
    seen.add(signature);
    blocked.push({
      signature,
      blockedAt: normalizeHealthTimestamp(item && item.blockedAt) || new Date().toISOString(),
      code: String(item && item.code || 'ER_ACCESS_DENIED_ERROR').slice(0, 80),
      lastManualRetryAt: normalizeHealthTimestamp(item && item.lastManualRetryAt)
    });
  }
  return { version: 1, blocked: blocked.slice(-10) };
}

async function loadMysqlAuthGuard() {
  if (mysqlAuthGuardLoaded) return mysqlAuthGuard;
  mysqlAuthGuardLoaded = true;
  try {
    const raw = await fs.readFile(MYSQL_AUTH_GUARD_FILE, 'utf8');
    mysqlAuthGuard = normalizeMysqlAuthGuard(JSON.parse(raw || '{}'));
  } catch (err) {
    mysqlAuthGuard = normalizeMysqlAuthGuard(null);
  }
  return mysqlAuthGuard;
}

function persistMysqlAuthGuard() {
  const snapshot = normalizeMysqlAuthGuard(mysqlAuthGuard);
  mysqlAuthGuard = snapshot;
  mysqlAuthGuardWriteChain = mysqlAuthGuardWriteChain.then(async function writeMysqlAuthGuard() {
    await fs.mkdir(DATA_DIR, { recursive: true });
    if (!snapshot.blocked.length) {
      await fs.rm(MYSQL_AUTH_GUARD_FILE, { force: true });
      return;
    }
    const tmp = MYSQL_AUTH_GUARD_FILE + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
    await fs.rename(tmp, MYSQL_AUTH_GUARD_FILE);
  }).catch(function(err) {
    console.error('[MySQL Auth Guard] Nao foi possivel persistir a protecao:', err.message || err);
  });
  return mysqlAuthGuardWriteChain;
}

function mysqlAuthGuardEntryForConfig(config) {
  if (!mysqlAuthGuard || !Array.isArray(mysqlAuthGuard.blocked)) return null;
  const signature = mysqlCredentialSignature(config);
  return mysqlAuthGuard.blocked.find(function(item) { return item.signature === signature; }) || null;
}

async function clearMysqlAuthGuardForConfig(config, reason) {
  await loadMysqlAuthGuard();
  const signature = mysqlCredentialSignature(config);
  const before = mysqlAuthGuard.blocked.length;
  mysqlAuthGuard.blocked = mysqlAuthGuard.blocked.filter(function(item) { return item.signature !== signature; });
  if (mysqlAuthVerifiedSignature === signature) mysqlAuthVerifiedSignature = '';
  if (mysqlAuthGuard.blocked.length !== before) {
    console.log('[MySQL Auth Guard] Protecao liberada' + (reason ? ' (' + String(reason) + ')' : '') + '.');
    await persistMysqlAuthGuard();
  }
}

function isMysqlAuthenticationError(err) {
  const code = String(err && err.code || '').toUpperCase();
  const message = String(err && (err.message || err.sqlMessage) || err || '');
  return [
    'ER_ACCESS_DENIED_ERROR',
    'ER_DBACCESS_DENIED_ERROR',
    'ER_ACCESS_DENIED_NO_PASSWORD_ERROR',
    'ER_ACCOUNT_HAS_BEEN_LOCKED',
    'ER_MUST_CHANGE_PASSWORD_LOGIN',
    'ER_PASSWORD_EXPIRED',
    'ER_HOST_NOT_PRIVILEGED'
  ].includes(code)
    || /access denied for user/i.test(message)
    || /account (?:is )?(?:blocked|locked)/i.test(message)
    || /host .+ is blocked/i.test(message);
}

function mysqlAuthGuardError(entry) {
  const err = new Error('Protecao contra bloqueio ativa: as tentativas automaticas ao MySQL foram interrompidas apos uma falha de autenticacao. Corrija ou salve novamente a credencial antes de testar outra vez.');
  err.code = 'MYSQL_AUTH_GUARD_ACTIVE';
  err.status = 429;
  err.blockedAt = entry && entry.blockedAt || null;
  return err;
}

async function assertMysqlAuthGuardAllows(config) {
  await loadMysqlAuthGuard();
  const entry = mysqlAuthGuardEntryForConfig(config);
  if (entry) throw mysqlAuthGuardError(entry);
}

async function recordMysqlAuthenticationFailure(err, config) {
  if (!isMysqlAuthenticationError(err)) return false;
  await loadMysqlAuthGuard();
  const signature = mysqlCredentialSignature(config);
  const existing = mysqlAuthGuard.blocked.find(function(item) { return item.signature === signature; });
  if (!existing) {
    mysqlAuthGuard.blocked.push({
      signature,
      blockedAt: new Date().toISOString(),
      code: String(err && err.code || 'ER_ACCESS_DENIED_ERROR').slice(0, 80),
      lastManualRetryAt: null
    });
    mysqlAuthGuard.blocked = mysqlAuthGuard.blocked.slice(-10);
    await persistMysqlAuthGuard();
    console.error('[MySQL Auth Guard] Falha de autenticacao detectada. Novas tentativas com a mesma credencial foram bloqueadas.');
  }
  if (mysqlAuthVerifiedSignature === signature) mysqlAuthVerifiedSignature = '';
  await closePool().catch(function() {});
  return true;
}

async function markMysqlAuthManualRetry(config) {
  await loadMysqlAuthGuard();
  const entry = mysqlAuthGuardEntryForConfig(config);
  if (!entry) return;
  entry.lastManualRetryAt = new Date().toISOString();
  await persistMysqlAuthGuard();
}

function mysqlAuthManualRetryWaitMs(entry) {
  if (!entry || !entry.lastManualRetryAt) return 0;
  const attemptedAt = new Date(entry.lastManualRetryAt).getTime();
  if (!Number.isFinite(attemptedAt)) return 0;
  return Math.max(0, attemptedAt + MYSQL_AUTH_MANUAL_RETRY_COOLDOWN_MS - Date.now());
}

async function markMysqlAuthenticationSuccessful(config) {
  const signature = mysqlCredentialSignature(config);
  mysqlAuthVerifiedSignature = signature;
  await clearMysqlAuthGuardForConfig(config, 'autenticacao confirmada');
  mysqlAuthVerifiedSignature = signature;
}

async function ensureMysqlAuthenticationVerified(config) {
  await assertMysqlAuthGuardAllows(config);
  const signature = mysqlCredentialSignature(config);
  if (mysqlAuthVerifiedSignature === signature) return;
  if (mysqlAuthProbe && mysqlAuthProbe.signature === signature) return mysqlAuthProbe.promise;

  const promise = (async function verifyMysqlAuthenticationOnce() {
    let connection = null;
    try {
      connection = await mysql.createConnection({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
        charset: config.charset || 'utf8mb4',
        connectTimeout: config.connectTimeout || 8000,
        ssl: config.ssl
      });
      await connection.query('SELECT 1');
      await markMysqlAuthenticationSuccessful(config);
    } catch (err) {
      await recordMysqlAuthenticationFailure(err, config);
      throw err;
    } finally {
      if (connection) {
        try { await connection.end(); } catch (err) {}
      }
    }
  })();
  mysqlAuthProbe = { signature, promise };
  try {
    return await promise;
  } finally {
    if (mysqlAuthProbe && mysqlAuthProbe.promise === promise) mysqlAuthProbe = null;
  }
}

function publicMysqlAuthGuard(config) {
  const entry = mysqlAuthGuardEntryForConfig(config || buildDbConfig());
  const retryWaitMs = mysqlAuthManualRetryWaitMs(entry);
  return {
    blocked: Boolean(entry),
    blockedAt: entry && entry.blockedAt || null,
    automaticAttemptsBlocked: Boolean(entry),
    lastManualRetryAt: entry && entry.lastManualRetryAt || null,
    manualRetryAvailableAt: retryWaitMs > 0 ? new Date(Date.now() + retryWaitMs).toISOString() : null
  };
}

function mysqlTroubleshootingMessage(err) {
  const code = err && (err.code || err.errno || err.sqlState) ? String(err.code || err.errno || err.sqlState) : '';
  const raw = err && err.message ? String(err.message) : 'Falha ao conectar no MySQL.';
  const prefix = code ? `[${code}] ` : '';
  const lower = raw.toLowerCase();
  let hint = '';
  if (code === 'ER_ACCESS_DENIED_ERROR' || lower.includes('access denied')) {
    hint = ' Verifique usuario, senha e se o usuario tem permissao para acessar essa base a partir deste computador.';
  } else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    hint = ' O host/IP nao foi encontrado. Verifique o endereco do servidor ou DNS.';
  } else if (code === 'ECONNREFUSED') {
    hint = ' A porta recusou a conexao. Verifique se o MySQL esta rodando e se a porta 3306 esta liberada.';
  } else if (code === 'ETIMEDOUT' || lower.includes('timeout')) {
    hint = ' Tempo esgotado. Verifique firewall, liberacao da porta 3306 e se o servidor aceita conexoes externas.';
  } else if (code === 'ER_BAD_DB_ERROR' || lower.includes('unknown database')) {
    hint = ' A base informada nao existe ou o usuario nao tem acesso a ela.';
  } else if (lower.includes('ssl')) {
    hint = ' Tente marcar ou desmarcar a opcao SSL conforme a configuracao do servidor.';
  }
  return prefix + raw + hint;
}

function dbSignature(config) {
  return JSON.stringify({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    charset: config.charset || 'utf8mb4',
    connectionLimit: config.connectionLimit,
    ssl: Boolean(config.ssl)
  });
}

async function closePool() {
  if (pool) {
    const oldPool = pool;
    pool = null;
    poolSignature = '';
    lastPoolRecreateAt = Date.now();
    try { await oldPool.end(); } catch (err) {}
  }
}

async function maybeCloseAndRefreshPool() {
  const elapsed = Date.now() - lastPoolRecreateAt;
  if (elapsed > 5000) {
    console.warn('[MySQL Pool] Conexao perdida detectada, recriando pool... (ultimo refresh ha ' + Math.round(elapsed / 1000) + 's)');
    logger.error('MYSQL_POOL_RECREATE', 'Query inactivity timeout detectado, recriando pool');
    await closePool();
  }
  return getPool();
}

async function checkMysqlAccessible(physicalTable) {
  const config = buildDbConfig();
  if (!config.database) throw new Error('MySQL database nao configurado.');
  await ensureMysqlAuthenticationVerified(config);
  let connection = null;
  try {
    connection = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      charset: config.charset || 'utf8mb4',
      connectTimeout: config.connectTimeout || 8000,
      ssl: config.ssl
    });
    await connection.execute('SELECT 1');
    await connection.execute('SELECT 1 FROM ' + quoteIdent(physicalTable) + ' LIMIT 1');
  } catch (err) {
    await recordMysqlAuthenticationFailure(err, config);
    throw err;
  } finally {
    if (connection) {
      try { await connection.end(); } catch (e) {}
    }
  }
}

let charsetWasAutoDetected = false;

async function autoDetectMysqlCharset() {
  // Se o usuario definiu charset explicitamente no .env, respeita a escolha
  const envCharset = APP_MODE === 'online'
    ? (process.env.ONLINE_MYSQL_CHARSET || process.env.MYSQL_CHARSET)
    : process.env.MYSQL_CHARSET;
  const db = activeDbSettings();
  if (!db.mysqlHost || !db.mysqlDatabase || !db.mysqlUser) return;
  const config = buildDbConfigFromSettings(db);
  try {
    await ensureMysqlAuthenticationVerified(config);
    if (envCharset) return;
    const conn = await mysql.createConnection({
      host: db.mysqlHost,
      port: Number(db.mysqlPort || 3306),
      user: db.mysqlUser,
      password: db.mysqlPassword || '',
      database: db.mysqlDatabase,
      charset: 'utf8mb4',
      connectTimeout: 5000,
      ssl: parseBool(db.mysqlSsl) ? { rejectUnauthorized: false } : undefined
    });
    try {
      const [rows] = await conn.query("SHOW VARIABLES LIKE 'character_set_database'");
      const detected = rows && rows[0] ? String(rows[0].Value || '').toLowerCase() : '';
      if (detected === 'latin1' || detected === 'utf8' || detected === 'utf8mb3' || detected === 'utf8mb4') {
        console.log('[Charset] Detectado charset do MySQL: ' + detected);
        const currentCharset = String(APP_MODE === 'online'
          ? (settingsCache.web && settingsCache.web.mysqlCharset)
          : (settingsCache.database && settingsCache.database.mysqlCharset) || '').toLowerCase();
        if (currentCharset === detected) return;
        if (APP_MODE === 'online') {
          settingsCache.web.mysqlCharset = detected;
        } else {
          settingsCache.database.mysqlCharset = detected;
        }
        charsetWasAutoDetected = true;
        // Fecha pool para forcar recriacao com charset correto
        try { await closePool(); } catch (e) {}
        console.log('[Charset] Pool atualizado; a sincronizacao sequencial aplicara o charset corrigido.');
      } else if (detected) {
        console.log('[Charset] Charset detectado (' + detected + ') - mantendo utf8mb4 como fallback');
      }
    } finally {
      try { conn.end(); } catch (e) {}
    }
  } catch (err) {
    await recordMysqlAuthenticationFailure(err, config);
    console.log('[Charset] Nao foi possivel detectar charset do MySQL: ' + (err.message || err.code || ''));
  }
}

async function connectionQuery(connection, sql, params, timeoutMs) {
  if (String(sql || '').toUpperCase().trim().startsWith('SELECT')) {
    return new Promise(function(resolve, reject) {
      var timer = setTimeout(function() {
        reject(new Error('Query timeout after ' + (timeoutMs || 30000) + 'ms'));
      }, Number(timeoutMs || 30000));
      connection.execute(sql, params || [], function(err, rows) {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }
  return new Promise(function(resolve, reject) {
    var timer = setTimeout(function() {
      reject(new Error('Query timeout after ' + (timeoutMs || 30000) + 'ms'));
    }, Number(timeoutMs || 30000));
    connection.query(sql, params || [], function(err, result) {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(result);
    });
  });
}

// Le linhas via streaming, gravando em lotes (onBatch). Como os pacotes
// chegam continuamente do MySQL, evita o "Query inactivity timeout" em
// tabelas grandes e nao bufferiza a tabela inteira na memoria. Aplica
// contrapressao (pause/resume) enquanto cada lote e gravado no cache.
function streamMysqlRowsInBatches(promiseConnection, sql, options, onBatch) {
  const batchSize = Math.max(1, Number((options && options.batchSize) || 2000));
  const maxRows = Math.max(1, Number((options && options.maxRows) || Number.MAX_SAFE_INTEGER));
  const inactivityTimeoutMs = Math.max(30000, Number((options && options.inactivityTimeoutMs) || process.env.BIWA_MYSQL_STREAM_INACTIVITY_TIMEOUT_MS || 300000));
  const params = (options && options.params) || [];
  const core = promiseConnection && promiseConnection.connection ? promiseConnection.connection : promiseConnection;
  return new Promise(function(resolve, reject) {
    let stream;
    try {
      stream = core.query(sql, params).stream();
    } catch (err) { reject(err); return; }
    let buffer = [];
    let processing = false;
    let streamEnded = false;
    let settled = false;
    let total = 0;
    let lastActivityAt = Date.now();
    let watchdog = null;
    function fail(err) {
      if (settled) return;
      settled = true;
      if (watchdog) clearInterval(watchdog);
      try { stream.destroy(); } catch (e) {}
      reject(err);
    }
    function finish() {
      if (settled) return;
      settled = true;
      if (watchdog) clearInterval(watchdog);
      resolve(total);
    }
    function pump() {
      if (processing || settled) return;
      if (buffer.length === 0) { if (streamEnded) finish(); return; }
      processing = true;
      try { stream.pause(); } catch (e) {}
      let batch = buffer;
      buffer = [];
      const remaining = maxRows - total;
      if (batch.length > remaining) batch = batch.slice(0, remaining);
      Promise.resolve()
        .then(function() { return onBatch(batch); })
        .then(function() {
          total += batch.length;
          processing = false;
          lastActivityAt = Date.now();
          if (settled) return;
          if (total >= maxRows) { try { stream.destroy(); } catch (e) {} finish(); return; }
          if (buffer.length > 0) pump();
          else if (streamEnded) finish();
          else { try { stream.resume(); } catch (e) {} }
        })
        .catch(fail);
    }
    watchdog = setInterval(function() {
      if (settled || processing || Date.now() - lastActivityAt < inactivityTimeoutMs) return;
      const err = new Error('MySQL stream inactivity timeout after ' + inactivityTimeoutMs + 'ms');
      err.code = 'MYSQL_STREAM_INACTIVITY_TIMEOUT';
      fail(err);
    }, Math.min(5000, Math.max(1000, Math.floor(inactivityTimeoutMs / 4))));
    if (watchdog && typeof watchdog.unref === 'function') watchdog.unref();
    stream.on('data', function(row) {
      lastActivityAt = Date.now();
      buffer.push(row);
      if (buffer.length >= batchSize) pump();
    });
    stream.on('end', function() { streamEnded = true; pump(); });
    stream.on('error', fail);
  });
}

// Erros transitorios de rede/MySQL em que vale a pena reconectar e retomar.
function isRetryableStreamError(err) {
  if (isMysqlQueryTimeout(err)) return true;
  const code = String((err && (err.code || err.errno)) || '').toUpperCase();
  const retryCodes = ['MYSQL_STREAM_INACTIVITY_TIMEOUT', 'PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'PROTOCOL_SEQUENCE_TIMEOUT', 'ER_QUERY_INTERRUPTED', 'EHOSTUNREACH', 'ENETRESET', 'ECONNABORTED', 'ECONNREFUSED'];
  if (retryCodes.indexOf(code) !== -1) return true;
  const text = String((err && err.message) || '').toLowerCase();
  return text.includes('connection lost') || text.includes('econnreset') || text.includes('read econnreset') || (text.includes('socket') && text.includes('closed')) || text.includes('fatal error');
}

// Escolhe uma coluna UNICA para retomada por keyset (PK de coluna unica ou
// auto_increment). Nao usa a coluna de sincronizacao (data), que pode ter
// valores repetidos e pularia linhas na retomada.
function pickStreamResumeKey(columns, plan) {
  const cols = Array.isArray(columns) ? columns : [];
  // Chave primaria (suporta composta): retorna array com todas as colunas PK.
  // Com chave composta usa tuple-comparison (pk1,pk2) > (?,?) que e muito mais
  // rapido que OFFSET em tabelas grandes e evita timeout na retomada.
  const pks = cols.filter(function(c) { return String(c.columnKey || '').toUpperCase() === 'PRI'; });
  if (pks.length >= 1) return pks.map(function(c) { return c.name; });
  const auto = cols.find(function(c) { return /auto_increment/i.test(String(c.extra || '')) && isNumericMysqlType(c); });
  if (auto) return [auto.name];
  if (plan && Array.isArray(plan.primaryKeys) && plan.primaryKeys.length >= 1) {
    return plan.primaryKeys.filter(function(name) { return cols.some(function(c) { return c.name === name; }); });
  }
  return [];
}

// Copia uma tabela MySQL via streaming com RECONEXAO AUTOMATICA: se a
// conexao cair no meio, reconecta e retoma de onde parou. Com chave unica,
// retoma por keyset (rapido e exato); sem chave, retoma por OFFSET. Chama
// onBatch(rows, copiedSoFar) para gravar cada lote. Retorna o total copiado.
async function copyMysqlTableViaStream(physicalTable, columns, plan, options, onBatch) {
  const streamConfig = buildDbConfig();
  await ensureMysqlAuthenticationVerified(streamConfig);
  const tableSql = quoteIdent(physicalTable);
  const batchSize = Math.max(1, Number((options && options.batchSize) || 2000));
  const maxRows = Math.max(1, Number((options && options.maxRows) || Number.MAX_SAFE_INTEGER));
  const maxRetries = Math.max(0, Number(options && options.maxRetries != null ? options.maxRetries : 6));
  const inactivityTimeoutMs = Math.max(30000, Number((options && options.inactivityTimeoutMs) || process.env.BIWA_MYSQL_STREAM_INACTIVITY_TIMEOUT_MS || 300000));
  const onRetry = options && typeof options.onRetry === 'function' ? options.onRetry : null;
  const onRestart = options && typeof options.onRestart === 'function' ? options.onRestart : null;
  // Total esperado (COUNT) para detectar "fim prematuro": se a conexao remota
  // fechar no meio, o mysql2 pode emitir 'end' (sem erro) com menos linhas. Se
  // vier menos que o esperado, reconectamos e retomamos de onde parou.
  const expectedTotal = Math.max(0, Number((options && options.expectedTotal) || 0));
  // Filtro opcional aplicado a todas as queries (ex.: janela recente por data).
  const baseWhere = options && options.where ? String(options.where) : '';
  const baseWhereParams = (options && options.whereParams) || [];
  const resumeKeys = pickStreamResumeKey(columns, plan);
  const hasResumeKey = resumeKeys.length > 0;
  const resumeOrderSql = resumeKeys.map(function(k) { return quoteIdent(k) + ' ASC'; }).join(', ');
  const resumeKeysList = resumeKeys.map(quoteIdent).join(', ');
  let copied = 0;
  let lastKey = null;
  let consecutiveFailures = 0;
  let prematureRestarts = 0;
  const wrapped = async function(rows) {
    await onBatch(rows, copied + rows.length);
    copied += rows.length;
    if (hasResumeKey && rows.length) {
      const last = rows[rows.length - 1];
      lastKey = resumeKeys.map(function(k) { return last[k]; });
    }
  };
  while (copied < maxRows) {
    const before = copied;
    let conn = null;
    let cleanEnd = false;
    try {
      conn = await mysql.createConnection(streamConfig);
      const remaining = maxRows - copied;
      let sql;
      let params = [];
      if (hasResumeKey) {
        let cond = baseWhere ? ('(' + baseWhere + ')') : '';
        if (lastKey !== null) {
          const tuplePh = resumeKeys.map(function() { return '?'; }).join(', ');
          const tupleCond = '(' + resumeKeysList + ') > (' + tuplePh + ')';
          cond = cond ? (cond + ' AND ' + tupleCond) : tupleCond;
        }
        const wc = cond ? (' WHERE ' + cond) : '';
        params = lastKey !== null ? baseWhereParams.concat(lastKey) : baseWhereParams.slice();
        sql = 'SELECT * FROM ' + tableSql + wc + ' ORDER BY ' + resumeOrderSql;
      } else {
        const wc = baseWhere ? (' WHERE ' + baseWhere) : '';
        params = baseWhereParams.slice();
        sql = 'SELECT * FROM ' + tableSql + wc + (copied > 0 ? (' LIMIT ' + remaining + ' OFFSET ' + copied) : '');
      }
      await streamMysqlRowsInBatches(conn, sql, { batchSize: batchSize, maxRows: remaining, params: params, inactivityTimeoutMs: inactivityTimeoutMs }, wrapped);
      cleanEnd = true;
    } catch (err) {
      if (await recordMysqlAuthenticationFailure(err, streamConfig)) throw err;
      if (!isRetryableStreamError(err)) throw err;
      const madeProgress = copied > before;
      if (madeProgress) consecutiveFailures = 0; else consecutiveFailures++;
      if (consecutiveFailures > maxRetries) throw err;
      let restarted = false;
      if (!hasResumeKey && copied > 0 && onRestart) {
        prematureRestarts += 1;
        if (prematureRestarts > maxRetries) throw new Error('Stream MySQL falhou apos ' + maxRetries + ' reinicios completos.');
        await onRestart({ copied: copied, error: err });
        copied = 0;
        lastKey = null;
        restarted = true;
      }
      if (onRetry) { try { await onRetry({ copied: copied, attempt: Math.max(consecutiveFailures, prematureRestarts), error: err, restarted: restarted }); } catch (e) {} }
      const waitMs = Math.min(10000, 500 * Math.pow(2, consecutiveFailures));
      await new Promise(function(r) { setTimeout(r, waitMs); });
    } finally {
      if (conn) { try { conn.destroy(); } catch (e) {} }
    }
    if (!cleanEnd) continue; // houve erro recuperavel: ja aguardou, retoma
    // Stream terminou sem erro:
    if (copied >= maxRows) return copied;               // atingiu o teto pedido
    if (!expectedTotal || copied >= expectedTotal) return copied; // realmente completo
    if (copied === before) return copied;               // retomada nao trouxe nada novo => fim real
    // 'end' prematuro com progresso: faltam linhas, reconecta e retoma
    consecutiveFailures = 0;
    var incompleteCopied = copied;
    if (!hasResumeKey && onRestart) {
      prematureRestarts += 1;
      if (prematureRestarts > maxRetries) throw new Error('Stream MySQL terminou incompleto apos ' + maxRetries + ' reinicios (' + copied + '/' + expectedTotal + ').');
      await onRestart({ copied: incompleteCopied, error: new Error('fim prematuro do stream') });
      copied = 0;
      lastKey = null;
    }
    if (onRetry) { try { await onRetry({ copied: copied, attempt: prematureRestarts, error: new Error('fim prematuro do stream (' + incompleteCopied + '/' + expectedTotal + ')'), restarted: !hasResumeKey && Boolean(onRestart) }); } catch (e) {} }
    await new Promise(function(r) { setTimeout(r, 300); });
  }
  return copied;
}

function getPool(configOverride) {
  const config = configOverride || buildDbConfig();
  if (!config.database) {
    throw apiError('MySQL ainda nao configurado. Abra Configuracao > MySQL do Desktop/Admin e informe a base.', 400);
  }
  const blocked = mysqlAuthGuardEntryForConfig(config);
  if (blocked) throw mysqlAuthGuardError(blocked);
  const signature = dbSignature(config);
  if (!pool || poolSignature !== signature) {
    if (pool) pool.end().catch(() => {});
    pool = mysql.createPool(config);
    poolSignature = signature;
  }
  return pool;
}

async function executeMysqlPoolQuery(config, queryOptions) {
  await ensureMysqlAuthenticationVerified(config);
  try {
    return await getPool(config).query(queryOptions);
  } catch (err) {
    await recordMysqlAuthenticationFailure(err, config);
    throw err;
  }
}

async function dbQuery(sql, params) {
  const timeout = Number(process.env.MYSQL_QUERY_TIMEOUT || 12000);
  const config = buildDbConfig();
  try {
    return await executeMysqlPoolQuery(config, { sql, values: params || [], timeout });
  } catch (err) {
    const text = String((err && (err.message || err.sqlMessage || err.code || err.errno)) || '').toLowerCase();
    if (text.includes('query inactivity timeout') || String(err && err.code || '').toLowerCase() === 'protocol_sequence_timeout') {
      await maybeCloseAndRefreshPool();
      return executeMysqlPoolQuery(config, { sql, values: params || [], timeout });
    }
    throw err;
  }
}

async function dbQueryWithTimeout(sql, params = [], timeoutMs = RESOURCE_QUERY_TIMEOUT_MS, retryOnTimeout = true) {
  const config = buildDbConfig();
  const timeout = Number(timeoutMs || RESOURCE_QUERY_TIMEOUT_MS);
  try {
    return await executeMysqlPoolQuery(config, { sql, values: params || [], timeout });
  } catch (err) {
    const text = String((err && (err.message || err.sqlMessage || err.code || err.errno)) || '').toLowerCase();
    if (retryOnTimeout && (text.includes('query inactivity timeout') || String(err && err.code || '').toLowerCase() === 'protocol_sequence_timeout')) {
      await maybeCloseAndRefreshPool();
      return executeMysqlPoolQuery(config, { sql, values: params || [], timeout });
    }
    throw err;
  }
}

function isMysqlQueryTimeout(err) {
  const text = String((err && (err.message || err.sqlMessage || err.code || err.errno)) || '').toLowerCase();
  return text.includes('query inactivity timeout') || text.includes('timeout') || text.includes('timed out') || String(err && err.code || '').toLowerCase() === 'protocol_sequence_timeout';
}

function timeoutTableRowsResponse(table, meta, limit, offset, columns, err) {
  return {
    rows: [],
    total: null,
    totalKnown: false,
    limit,
    offset,
    nextOffset: offset,
    hasMore: false,
    resource: meta,
    columns: columns || [],
    queryTimedOut: true,
    message: 'A consulta da tabela/view ' + table + ' demorou demais para retornar. Tente aplicar filtros, diminuir o limite ou otimizar a view no MySQL.',
    detail: err && err.message ? String(err.message) : ''
  };
}

function promiseTimeout(promise, timeoutMs, label) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(apiError((label || 'Operacao') + ' excedeu o tempo limite de ' + Math.round(Number(timeoutMs || RESOURCE_TOTAL_TIMEOUT_MS) / 1000) + 's.', 504));
    }, Number(timeoutMs || RESOURCE_TOTAL_TIMEOUT_MS));
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

function currentDatabaseName() {
  const db = activeDbSettings();
  return db.mysqlDatabase || null;
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function parseBasicAuthHeader(header) {
  if (!header || !header.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx === -1) return null;
    return {
      user: decoded.slice(0, idx),
      password: decoded.slice(idx + 1)
    };
  } catch (err) {
    return null;
  }
}

function validateBasicAuthHeader(header) {
  const settings = getSettings();
  const pairs = [];
  if (settings.access.adminUser && settings.access.adminPassword) {
    pairs.push({ role: 'admin', username: settings.access.adminUser, name: settings.access.adminName || 'Administrador', password: settings.access.adminPassword, reportPermissions: {} });
  }
  for (const user of effectiveOnlineUsers(settings)) {
    if (user.username && user.password && user.active) pairs.push({ ...user, role: 'viewer' });
  }

  if (!pairs.length) {
    if (APP_MODE === 'online' && !ONLINE_ALLOW_OPEN_ACCESS) {
      return { ok: false, reason: 'missing_online_credentials' };
    }
    return { ok: true, role: APP_MODE === 'online' ? 'viewer' : 'admin', user: { role: APP_MODE === 'online' ? 'viewer' : 'admin', username: 'local', name: 'Acesso local', reportPermissions: {} } };
  }

  const creds = parseBasicAuthHeader(header);
  // Desktop/Admin sem senha: acesso livre mesmo com usuarios online cadastrados
  if (!creds && APP_MODE === 'desktop' && !settings.access.adminPassword) {
    return { ok: true, role: 'admin', user: { role: 'admin', username: settings.access.adminUser || 'admin', name: settings.access.adminName || 'Administrador', reportPermissions: {} } };
  }
  if (!creds) return { ok: false };
  for (const pair of pairs) {
    if (safeEqual(creds.user, pair.username) && safeEqual(creds.password, pair.password)) {
      return { ok: true, role: pair.role, user: pair };
    }
  }
  return { ok: false };
}

function validateAuthFromRequest(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) {
    const payload = readAuthToken(auth.slice(7));
    if (!payload) return { ok: false };
    if (payload.role === 'admin') {
      const settings = getSettings();
      if (settings.access.adminUser && safeEqual(payload.sub, settings.access.adminUser)) {
        return { ok: true, role: 'admin', user: { username: payload.sub, name: payload.name || payload.sub, role: 'admin', reportPermissions: {} } };
      }
      return { ok: false };
    }
    const user = effectiveOnlineUsers().find((item) => item.active && safeEqual(item.username, payload.sub));
    if (!user) return { ok: false };
    return { ok: true, role: 'viewer', user };
  }
  return validateBasicAuthHeader(auth);
}

function basicAuth(req, res, next) {
  const result = validateBasicAuthHeader(req.headers.authorization);
  if (result.ok) {
    req.authRole = result.role;
    req.authUser = result.user || { role: result.role, username: result.role };
    return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="BI WA"');
  return res.status(401).send('Authentication required');
}




function apiAuthRequired(req, res, next) {
  const result = validateAuthFromRequest(req);
  if (result.ok) {
    req.authRole = result.role;
    req.authUser = result.user || { role: result.role, username: result.role };
    return next();
  }
  return res.status(401).json({ error: 'Login obrigatório. Informe usuário e senha para acessar o BI WA Online.' });
}

function rateLimitApi(req, res, next) {
  const now = Date.now();
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'local';
  const key = String(ip).split(',')[0].trim() + ':' + (req.authRole || 'anon');
  let bucket = apiRateBuckets.get(key);
  if (!bucket || now - bucket.startedAt > API_RATE_WINDOW_MS) {
    bucket = { startedAt: now, count: 0 };
  }
  bucket.count += 1;
  apiRateBuckets.set(key, bucket);
  if (apiRateBuckets.size > 2000) {
    for (const [itemKey, item] of apiRateBuckets.entries()) {
      if (now - item.startedAt > API_RATE_WINDOW_MS) apiRateBuckets.delete(itemKey);
    }
  }
  if (bucket.count > API_RATE_MAX_REQUESTS) {
    return res.status(429).json({ error: 'Muitas requisicoes em pouco tempo. Aguarde alguns segundos e tente novamente.' });
  }
  return next();
}


function stableStringify(value) {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function clearQueryCache(reason = 'manual') {
  queryCacheGeneration += 1;
  queryCache.clear();
  inFlightQueryCache.clear();
  filterOptionsCache.clear();
  io.emit('dashboard:cacheInvalidated', { reason, at: new Date().toISOString() });
}

function enforceQueryCacheLimit() {
  if (queryCache.size <= QUERY_CACHE_MAX_ITEMS) return;
  const entries = Array.from(queryCache.entries()).sort((a, b) => a[1].savedAt - b[1].savedAt);
  for (const [key] of entries.slice(0, Math.max(1, queryCache.size - QUERY_CACHE_MAX_ITEMS))) {
    queryCache.delete(key);
  }
}

function buildQueryCacheKey(sql, params, meta = {}) {
  return crypto.createHash('sha1').update(stableStringify({ db: poolSignature || dbSignature(buildDbConfig()), sql, params, meta })).digest('hex');
}

async function cachedDbQuery(sql, params = [], meta = {}) {
  if (!QUERY_CACHE_ENABLED || Number(QUERY_CACHE_TTL_MS) <= 0 || meta.noCache) {
    const [rows, fields] = await dbQuery(sql, params);
    return { rows, fields, cached: false };
  }
  const key = buildQueryCacheKey(sql, params, meta);
  const now = Date.now();
  const hit = queryCache.get(key);
  if (hit && now - hit.savedAt <= QUERY_CACHE_TTL_MS) {
    hit.hits += 1;
    hit.lastHitAt = now;
    return { rows: cloneJson(hit.rows), fields: cloneJson(hit.fields), cached: true, cacheAgeMs: now - hit.savedAt };
  }
  if (inFlightQueryCache.has(key)) {
    const shared = await inFlightQueryCache.get(key);
    return { rows: cloneJson(shared.rows), fields: cloneJson(shared.fields), cached: true, shared: true, cacheAgeMs: 0 };
  }
  const cacheGeneration = queryCacheGeneration;
  const promise = dbQuery(sql, params).then(([rows, fields]) => {
    const stored = {
      rows: serializeRows(rows),
      fields: fields.map((f) => ({ name: f.name, type: f.columnType || f.type })),
      savedAt: Date.now(),
      hits: 0,
      lastHitAt: Date.now()
    };
    if (cacheGeneration === queryCacheGeneration) {
      queryCache.set(key, stored);
      enforceQueryCacheLimit();
    }
    return stored;
  }).finally(() => {
    if (inFlightQueryCache.get(key) === promise) inFlightQueryCache.delete(key);
  });
  inFlightQueryCache.set(key, promise);
  const fresh = await promise;
  return { rows: cloneJson(fresh.rows), fields: cloneJson(fresh.fields), cached: false };
}

async function cachedPgAnalyticsQuery(sql, params = [], meta = {}) {
  if (!QUERY_CACHE_ENABLED || Number(QUERY_CACHE_TTL_MS) <= 0 || meta.noCache) {
    const result = await pgCacheQueryWithTimeout(sql, params, ANALYTIC_PG_QUERY_TIMEOUT_MS);
    return { rows: result.rows || [], fields: result.fields || [], cached: false };
  }
  const key = buildQueryCacheKey(sql, params, { ...meta, engine: 'postgres-analytics' });
  const now = Date.now();
  const hit = queryCache.get(key);
  if (hit && now - hit.savedAt <= QUERY_CACHE_TTL_MS) {
    hit.hits += 1;
    hit.lastHitAt = now;
    return { rows: cloneJson(hit.rows), fields: cloneJson(hit.fields), cached: true, cacheAgeMs: now - hit.savedAt };
  }
  if (inFlightQueryCache.has(key)) {
    const shared = await inFlightQueryCache.get(key);
    return { rows: cloneJson(shared.rows), fields: cloneJson(shared.fields), cached: true, shared: true, cacheAgeMs: 0 };
  }
  const cacheGeneration = queryCacheGeneration;
  const promise = pgCacheQueryWithTimeout(sql, params, ANALYTIC_PG_QUERY_TIMEOUT_MS).then((result) => {
    const stored = {
      rows: serializeRows(result.rows || []),
      fields: (result.fields || []).map((field) => ({ name: field.name, type: field.dataTypeID || field.type })),
      savedAt: Date.now(),
      hits: 0,
      lastHitAt: Date.now()
    };
    if (cacheGeneration === queryCacheGeneration) {
      queryCache.set(key, stored);
      enforceQueryCacheLimit();
    }
    return stored;
  }).finally(() => {
    if (inFlightQueryCache.get(key) === promise) inFlightQueryCache.delete(key);
  });
  inFlightQueryCache.set(key, promise);
  const fresh = await promise;
  return { rows: cloneJson(fresh.rows), fields: cloneJson(fresh.fields), cached: false };
}

async function readRealtimeEventMarker() {
  if (!REALTIME_EVENT_TABLE) return null;
  const now = Date.now();
  if (now - realtimeEventCheckedAt < Math.max(1000, REALTIME_EVENT_POLL_SECONDS * 1000)) return realtimeEventMarker;
  realtimeEventCheckedAt = now;
  const sql = `SELECT MAX(${quoteIdent(REALTIME_EVENT_COLUMN)}) AS marker FROM ${quoteIdent(REALTIME_EVENT_TABLE)}`;
  try {
    const [rows] = await dbQueryWithTimeout(sql, [], Math.min(5000, RESOURCE_QUERY_TIMEOUT_MS));
    const marker = rows && rows[0] ? String(rows[0].marker ?? '') : '';
    realtimeEventLastError = '';
    if (realtimeEventMarker !== null && marker && marker !== realtimeEventMarker) {
      realtimeEventLastChangeAt = Date.now();
      clearQueryCache('mysql-event-marker');
    }
    realtimeEventMarker = marker || realtimeEventMarker;
    return realtimeEventMarker;
  } catch (err) {
    realtimeEventLastError = err && err.message ? err.message : 'Falha ao ler marcador de tempo real.';
    return null;
  }
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function apiError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function quoteIdent(identifier) {
  const value = String(identifier || '').trim();
  if (!value) throw apiError('Identificador SQL vazio.', 400);
  if (/[\0]/.test(value)) throw apiError('Identificador SQL invalido.', 400);
  // MySQL aceita nomes de tabela/coluna com espacos e acentos quando usamos crase.
  // Escape de crase evita injecao e permite colunas como `Descricao Comercial`.
  return '`' + value.replace(/`/g, '``') + '`';
}

function clampLimit(value, fallback = 1000, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value || fallback);
  if (!Number.isFinite(n) || n < 1) return fallback;
  if (n >= Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
  return Math.floor(n);
}

function filterOptionsLimit(value) {
  if (value === undefined || value === null || value === '' || String(value).toLowerCase() === 'all') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.floor(n);
}

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function normalizeFilterOptionsContext(raw) {
  if (!raw) return '';
  try {
    return stableJson(JSON.parse(String(raw)));
  } catch (e) {
    return String(raw);
  }
}

function filterOptionsCacheKey(table, field, limit, contextFilters, securityScope = '', domainTable = '') {
  return [
    currentDatabaseName(),
    'model-data-generation:' + String(queryCacheGeneration),
    String(table || '').trim().toLowerCase(),
    String(field || '').trim().toLowerCase(),
    Number.isFinite(Number(limit)) && Number(limit) > 0 ? String(Math.floor(Number(limit))) : 'all',
    normalizeFilterOptionsContext(contextFilters),
    normalizeFilterOptionsContext(securityScope),
    String(domainTable || '').trim().toLowerCase()
  ].join('|');
}

function getFilterOptionsCache(key) {
  if (!FILTER_OPTIONS_CACHE_TTL_MS || FILTER_OPTIONS_CACHE_TTL_MS < 1) return null;
  const hit = filterOptionsCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.savedAt > FILTER_OPTIONS_CACHE_TTL_MS) {
    filterOptionsCache.delete(key);
    return null;
  }
  return hit.payload ? { ...hit.payload, filterOptionsCached: true } : null;
}

function setFilterOptionsCache(key, payload) {
  if (!FILTER_OPTIONS_CACHE_TTL_MS || FILTER_OPTIONS_CACHE_TTL_MS < 1 || !payload || !Array.isArray(payload.values) || !payload.values.length) return;
  filterOptionsCache.set(key, { savedAt: Date.now(), payload: { ...payload, values: payload.values.slice() } });
  if (filterOptionsCache.size > FILTER_OPTIONS_CACHE_MAX_ITEMS) {
    const entries = Array.from(filterOptionsCache.entries()).sort((a, b) => a[1].savedAt - b[1].savedAt);
    for (const [oldKey] of entries.slice(0, Math.max(1, filterOptionsCache.size - FILTER_OPTIONS_CACHE_MAX_ITEMS))) {
      filterOptionsCache.delete(oldKey);
    }
  }
}

function sqlLimitClause(limit, nextParamIndex) {
  return Number.isFinite(Number(limit)) && Number(limit) > 0 ? ` LIMIT $${nextParamIndex}` : '';
}

function serializeValue(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) {
    return Buffer.from(value.data).toString('base64');
  }
  return value;
}

function serializeRows(rows) {
  return rows.map((row) => {
    const out = {};
    for (const [key, value] of Object.entries(row)) {
      out[key] = serializeValue(value);
    }
    return out;
  });
}

function stripSqlComments(sql) {
  return String(sql || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n\r]*/g, ' ')
    .replace(/#[^\n\r]*/g, ' ');
}

function maskSqlStrings(sql) {
  return String(sql || '')
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""');
}

function assertReadOnlySql(sql) {
  const cleaned = stripSqlComments(sql).trim();
  if (!cleaned) throw apiError('SQL e obrigatorio.', 400);

  const withoutTrailingSemicolon = cleaned.replace(/;\s*$/g, '').trim();
  if (withoutTrailingSemicolon.includes(';')) {
    throw apiError('Apenas uma consulta SQL somente leitura e permitida.', 400);
  }
  if (!/^(select|with)\b/i.test(withoutTrailingSemicolon)) {
    throw apiError('Apenas SELECT ou WITH sao permitidos nos relatorios.', 400);
  }

  const masked = maskSqlStrings(withoutTrailingSemicolon);
  const blocked = /\b(insert|update|delete|drop|alter|truncate|create|replace|grant|revoke|call|load|set|execute|prepare|deallocate|handler|lock|unlock|rename|analyze|optimize|repair|flush|kill)\b/i;
  if (blocked.test(masked)) {
    throw apiError('Este SQL contem comando bloqueado. Use usuario MySQL somente leitura na versao online.', 400);
  }
  return deduplicateSqlWhere(withoutTrailingSemicolon);
}

function deduplicateSqlWhere(sql) {
  if (!sql || typeof sql !== 'string') return sql;
  const markers = [
    { re: /\bGROUP\s+BY\b/i },
    { re: /\bORDER\s+BY\b/i },
    { re: /\bLIMIT\b/i }
  ];
  let boundaryPos = sql.length;
  for (const marker of markers) {
    const match = marker.re.exec(sql);
    if (match && match.index < boundaryPos) {
      boundaryPos = match.index;
    }
  }
  const prefix = sql.slice(0, boundaryPos);
  const suffix = sql.slice(boundaryPos);
  const whereRe = /\bWHERE\b/i;
  const whereMatch = whereRe.exec(prefix);
  if (!whereMatch) return sql;
  const beforeWhere = prefix.slice(0, whereMatch.index).trimEnd();
  const whereSection = prefix.slice(whereMatch.index).replace(/^WHERE\s+/i, '').trimEnd();
  if (!whereSection) return sql;
  const rawClauses = splitWhereAndClauses(whereSection);
  const seenKeys = new Set();
  const deduped = [];
  for (const clause of rawClauses) {
    const key = deduplicateWhereKey(clause);
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    deduped.push(clause);
  }
  const rebuilt = deduped.length ? (beforeWhere + ' WHERE ' + deduped.join(' AND ') + ' ' + suffix) : (beforeWhere + ' ' + suffix);
  return rebuilt.trim();
}

function splitWhereAndClauses(whereText) {
  const parts = [];
  let depth = 0;
  let start = 0;
  const upper = whereText.toUpperCase();
  for (let i = 0; i < whereText.length; i++) {
    const ch = whereText[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && upper.slice(i, i + 5) === ' AND ' && (i === 0 || whereText[i - 1] !== '(' || depth === 0)) {
      parts.push(whereText.slice(start, i).trim());
      start = i + 5;
    }
  }
  parts.push(whereText.slice(start).trim());
  return parts.filter(function(p) { return p.length > 0; });
}

function deduplicateWhereKey(clause) {
  return clause
    .replace(/\s+/g, ' ')
    .replace(/`/g, '')
    .replace(/'[^']*'/g, "'?'")
    .replace(/"([^"]*)"/g, '"?$1"?')
    .replace(/\b\d+(\.\d+)?\b/g, 'N')
    .trim()
    .toLowerCase();
}

async function mergeSeedIncrementalColumns() {
  const seedFile = path.join(__dirname, 'dados-iniciais-publicacao', 'imported_tables.json');
  let seedTables = [];
  try {
    const raw = await fs.readFile(seedFile, 'utf8');
    seedTables = JSON.parse(raw || '[]');
  } catch (err) { return; }
  if (!Array.isArray(seedTables) || !seedTables.length) return;
  const seedBySource = new Map();
  for (const item of seedTables) {
    const key = String(item.sourceTable || item.name || '').trim().toLowerCase();
    if (key && item.incrementalColumn) seedBySource.set(key, String(item.incrementalColumn).trim());
  }
  if (!seedBySource.size) return;
  const tables = await readImportedTables();
  let changed = false;
  for (const item of tables) {
    if (item.incrementalColumn) continue;
    const lookupKey = String(item.sourceTable || item.name || '').trim().toLowerCase();
    const seedColumn = seedBySource.get(lookupKey);
    if (seedColumn) {
      item.incrementalColumn = seedColumn;
      item.updatedAt = new Date().toISOString();
      changed = true;
      console.log('[Seed Merge] Coluna incremental "' + seedColumn + '" aplicada a "' + item.name + '" a partir do seed.');
    }
  }
  if (changed) {
    await writeImportedTables(tables);
    console.log('[Seed Merge] import_tables.json atualizado com colunas incrementais do seed.');
  }
}

function assertReadOnlySqlPreservingRuntimeFilterMarkers(sql) {
  const whereToken = '__BIWA_RUNTIME_FILTER_WHERE_TOKEN__';
  const andToken = '__BIWA_RUNTIME_FILTER_AND_TOKEN__';
  const protectedSql = String(sql || '')
    .replace(/\/\*__BIWA_RUNTIME_FILTER_WHERE__\*\//g, whereToken)
    .replace(/\/\*__BIWA_RUNTIME_FILTER_AND__\*\//g, andToken);
  return assertReadOnlySql(protectedSql)
    .replace(new RegExp(whereToken, 'g'), '/*__BIWA_RUNTIME_FILTER_WHERE__*/')
    .replace(new RegExp(andToken, 'g'), '/*__BIWA_RUNTIME_FILTER_AND__*/');
}

async function mergeSeedConversionKgModeling() {
  const seedFile = path.join(__dirname, 'dados-iniciais-publicacao', 'imported_tables.json');
  let seedTables = [];
  try {
    const raw = await fs.readFile(seedFile, 'utf8');
    seedTables = JSON.parse(raw || '[]');
  } catch (err) { return { changed: false, reason: 'seed_missing' }; }
  if (!Array.isArray(seedTables) || !seedTables.length) return { changed: false, reason: 'seed_empty' };

  const key = (value) => String(value || '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
  const daxStepName = (step) => {
    if (step && step.newName) return step.newName;
    try { return parseDaxColumnDefinition(step && step.expression || '').name; } catch (err) { return ''; }
  };
  const conversionStep = (table) => (table && Array.isArray(table.steps) ? table.steps : []).find((step) => {
    if (!step) return false;
    if (step.kind === 'daxColumn') return key(daxStepName(step)) === 'conversao kg';
    return step.kind === 'fillValues' && key(step.column) === 'conversao kg';
  });
  const desired = new Map();
  for (const seed of seedTables) {
    const tableKey = key(seed && (seed.name || seed.sourceTable));
    if (tableKey !== 'faturamento' && tableKey !== 'recebimento') continue;
    const step = conversionStep(seed);
    if (step && step.kind === 'daxColumn') desired.set(tableKey, normalizeTransformStep(step));
  }
  if (desired.size < 2) return { changed: false, reason: 'seed_rules_missing' };

  const tables = await readImportedTables();
  let changed = false;
  const migrated = [];
  for (const table of tables) {
    const tableKey = key(table && (table.name || table.sourceTable));
    const desiredStep = desired.get(tableKey);
    if (!desiredStep) continue;
    const steps = Array.isArray(table.steps) ? table.steps.slice() : [];
    const existingIndexes = [];
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      const isConversion = step && ((step.kind === 'daxColumn' && key(daxStepName(step)) === 'conversao kg') || (step.kind === 'fillValues' && key(step.column) === 'conversao kg'));
      if (isConversion) existingIndexes.push(index);
    }
    const currentStep = existingIndexes.length ? steps[existingIndexes[0]] : null;
    const currentFormula = String(currentStep && currentStep.expression || '');
    const knownBroken = !currentStep
      || currentStep.kind === 'fillValues'
      || (currentStep.kind === 'daxColumn' && !/\[Unidade\]\s*=\s*"CX"/i.test(currentFormula));
    const alreadyCurrent = currentStep && currentStep.kind === 'daxColumn'
      && JSON.stringify(normalizeTransformStep(currentStep)) === JSON.stringify(desiredStep)
      && existingIndexes.length === 1;
    if (alreadyCurrent || !knownBroken) continue;
    const insertAt = existingIndexes.length ? existingIndexes[0] : steps.length;
    const cleaned = steps.filter((_, index) => !existingIndexes.includes(index));
    cleaned.splice(Math.min(insertAt, cleaned.length), 0, desiredStep);
    table.steps = cleaned;
    table.updatedAt = new Date().toISOString();
    changed = true;
    migrated.push(table.name || table.sourceTable);
  }
  if (changed) {
    await writeImportedTables(tables);
    clearQueryCache('seed-conversion-kg-migration');
    resourceListCache = { key: '', savedAt: 0, resources: [], diagnostics: [] };
    console.log('[Seed Merge] Regra Conversao KG atualizada sem ressincronizar o MySQL: ' + migrated.join(', ') + '.');
  }
  return { changed, migrated };
}

async function mergeSeedCostProductLookupModeling() {
  const seedFile = path.join(__dirname, 'dados-iniciais-publicacao', 'transform_queries.json');
  let seedTransforms = [];
  try {
    const raw = await fs.readFile(seedFile, 'utf8');
    seedTransforms = JSON.parse(raw || '[]');
  } catch (err) { return { changed: false, reason: 'seed_missing' }; }
  if (!Array.isArray(seedTransforms) || !seedTransforms.length) return { changed: false, reason: 'seed_empty' };

  const key = (value) => String(value || '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
  const stepName = (step) => {
    if (step && step.newName) return step.newName;
    try { return parseDaxColumnDefinition(step && step.expression || '').name; } catch (err) { return ''; }
  };
  const costStep = (transform) => (transform && Array.isArray(transform.steps) ? transform.steps : []).find((step) => (
    step && step.kind === 'daxColumn' && key(stepName(step)) === 'custos produtos'
  ));
  const desiredTransform = seedTransforms.find((transform) => key(transform && transform.name) === 'faturamento e recebimento');
  const desiredStep = normalizeTransformStep(costStep(desiredTransform));
  const desiredFormula = String(desiredStep && desiredStep.expression || '');
  const desiredLookupIsSafe = desiredStep
    && /^\s*Custos Produtos\s*=\s*LOOKUPVALUE\s*\(/i.test(desiredFormula)
    && /'Tabela Custos'\s*\[\s*Empresa\s*\]/i.test(desiredFormula)
    && /'Tabela Custos'\s*\[\s*Codigo Produto\s*\]/i.test(desiredFormula)
    && /'Faturamento e Recebimento'\s*\[\s*Empresa\s*\]/i.test(desiredFormula)
    && /'Faturamento e Recebimento'\s*\[\s*C[oó]digo Produto\s*\]/i.test(desiredFormula);
  if (!desiredLookupIsSafe) return { changed: false, reason: 'seed_rule_missing' };

  const transforms = await readTransforms();
  const activeTransform = transforms.find((transform) => key(transform && transform.name) === 'faturamento e recebimento');
  const currentStep = costStep(activeTransform);
  if (!activeTransform || !currentStep) return { changed: false, reason: 'legacy_rule_missing' };
  const currentFormula = String(currentStep.expression || '');
  const alreadyCurrent = JSON.stringify(normalizeTransformStep(currentStep)) === JSON.stringify(desiredStep);
  if (alreadyCurrent) return { changed: false, reason: 'already_current' };

  // Atualiza somente a formula legada conhecida. Qualquer coluna personalizada
  // pelo usuario e preservada. A chave antiga Empresa & Codigo colapsava codigos
  // textuais diferentes apenas pela quantidade de zeros a esquerda, fazendo
  // SELECTEDVALUE virar BLANK quando os custos divergiam. O par Empresa + Codigo textual evita essa
  // ambiguidade para todos os produtos, sem excecoes por nome ou por codigo.
  const knownLegacyLookup = /\bSELECTEDVALUE\s*\(\s*'Tabela Custos'\s*\[\s*Valor Custo\s*\]\s*\)/i.test(currentFormula)
    && /'Tabela Custos'\s*\[\s*Chave\s*\]/i.test(currentFormula)
    && /'Faturamento e Recebimento'\s*\[\s*Chave\s*\]/i.test(currentFormula);
  if (!knownLegacyLookup) return { changed: false, reason: 'custom_rule_preserved' };

  const stepIndex = activeTransform.steps.indexOf(currentStep);
  activeTransform.steps.splice(stepIndex, 1, desiredStep);
  activeTransform.updatedAt = new Date().toISOString();
  await writeTransforms(transforms);
  clearQueryCache('seed-cost-product-lookup-migration');
  resourceListCache = { key: '', savedAt: 0, resources: [], diagnostics: [] };
  console.log('[Seed Merge] Custos Produtos atualizado para lookup por Empresa + Codigo Produto, preservando as demais transformacoes.');
  return { changed: true, migrated: [activeTransform.name] };
}

function publicationSeedKey(value) {
  return String(value || '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
}

async function readPublicationSeed(name, fallback) {
  const seedFile = path.join(__dirname, 'dados-iniciais-publicacao', name);
  try {
    return JSON.parse(await fs.readFile(seedFile, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

// O pacote pode levar novas transformacoes, mas uma atualizacao nunca deve
// substituir transformacoes que ja existem no servidor. A chave preferida e o
// id persistido; o nome canonico cobre arquivos antigos sem id.
async function mergeMissingSeedTransforms() {
  const seedTransforms = await readPublicationSeed('transform_queries.json', []);
  if (!Array.isArray(seedTransforms) || !seedTransforms.length) return { changed: false, reason: 'seed_empty' };

  const current = await readTransforms();
  const existingIds = new Set(current.map((item) => String(item && item.id || '').trim()).filter(Boolean));
  const existingNames = new Set(current.map((item) => publicationSeedKey(item && item.name)).filter(Boolean));
  const missing = seedTransforms
    .map(normalizeTransformQuery)
    .filter(Boolean)
    .filter((item) => !existingIds.has(String(item.id || '').trim()) && !existingNames.has(publicationSeedKey(item.name)));
  if (!missing.length) return { changed: false, reason: 'already_present' };

  await writeTransforms(current.concat(missing));
  clearQueryCache('seed-transforms-added');
  resourceListCache = { key: '', savedAt: 0, resources: [], diagnostics: [] };
  console.log('[Seed Merge] ' + missing.length + ' transformacao(oes) ausente(s) adicionada(s) sem sobrescrever definicoes existentes.');
  return { changed: true, added: missing.map((item) => item.name) };
}

// Snapshots de tabelas manuais existem somente para levar tabelas que ainda
// nao existem no servidor. Uma tabela registrada no destino nunca e alterada
// por este bootstrap; atualizacoes posteriores continuam usando Publicar Online.
async function mergeMissingSeedManualTables() {
  if (!postgresCacheAvailable()) return { changed: false, reason: 'postgres_unavailable' };
  const seed = await readPublicationSeed('manual_tables.snapshot.json', { tables: [] });
  const seedTables = Array.isArray(seed) ? seed : seed && seed.tables;
  if (!Array.isArray(seedTables) || !seedTables.length) return { changed: false, reason: 'seed_empty' };

  const normalized = normalizeManualTableSyncSnapshots(seedTables);
  const registered = await readManualTables();
  const registeredKeys = new Set(registered.map(publicationSeedKey).filter(Boolean));
  const missing = normalized.filter((item) => !registeredKeys.has(publicationSeedKey(item.name)));
  if (!missing.length) return { changed: false, reason: 'already_present' };

  await ensurePgCacheSchema();
  const synced = await syncManualTableSnapshots(missing);
  clearQueryCache('seed-manual-tables-added');
  resourceListCache = { key: '', savedAt: 0, resources: [], diagnostics: [] };
  console.log('[Seed Merge] ' + synced.length + ' tabela(s) manual(is) ausente(s) adicionada(s) sem sobrescrever tabelas existentes.');
  return { changed: true, added: synced.map((item) => item.name) };
}

async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(REPORTS_FILE);
  } catch (err) {
    await fs.writeFile(REPORTS_FILE, '[]\n', 'utf8');
  }
  try {
    await fs.access(SEMANTIC_MODEL_FILE);
  } catch (err) {
    await fs.writeFile(SEMANTIC_MODEL_FILE, JSON.stringify(defaultSemanticModel(), null, 2) + '\n', 'utf8');
  }
  try {
    await fs.access(TRANSFORMS_FILE);
  } catch (err) {
    await fs.writeFile(TRANSFORMS_FILE, '[]\n', 'utf8');
  }
  await loadSettings();
  await loadMysqlAuthGuard();
  await migrateLegacyFaturamento2State().catch((err) => {
    console.error('[Migracao Faturamento2] Nao foi possivel atualizar as referencias persistidas:', err.message || err);
  });
  await mergeSeedIncrementalColumns().catch((err) => {
    console.error('[Seed Merge] Nao foi possivel mesclar colunas incrementais do seed:', err.message || err);
  });
  await mergeSeedConversionKgModeling().catch((err) => {
    console.error('[Seed Merge] Nao foi possivel atualizar a regra Conversao KG:', err.message || err);
  });
  await mergeSeedCostProductLookupModeling().catch((err) => {
    console.error('[Seed Merge] Nao foi possivel atualizar a regra Custos Produtos:', err.message || err);
  });
  await mergeMissingSeedTransforms().catch((err) => {
    console.error('[Seed Merge] Nao foi possivel adicionar transformacoes ausentes:', err.message || err);
  });
  await mergeMissingSeedManualTables().catch((err) => {
    console.error('[Seed Merge] Nao foi possivel adicionar tabelas manuais ausentes:', err.message || err);
  });
  await autoDetectMysqlCharset().catch(() => {});
}

async function readReports() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(REPORTS_FILE, 'utf8');
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

async function writeReports(reports) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = REPORTS_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(reports, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, REPORTS_FILE);
}

async function readManualTables() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(MANUAL_TABLES_FILE, 'utf8');
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.filter(Boolean).map(String) : [];
  } catch (err) {
    return [];
  }
}

async function writeManualTables(tables) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const unique = Array.from(new Set((tables || []).filter(Boolean).map(String))).sort((a, b) => a.localeCompare(b));
  const tmp = MANUAL_TABLES_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(unique, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, MANUAL_TABLES_FILE);
  return unique;
}

async function readManualTableSnapshots() {
  const names = await readManualTables();
  const tables = [];
  let totalRows = 0;
  for (const name of names) {
    const columns = await getColumns(name);
    const pgRef = await resolveManualTablePgRef(name);
    if (!pgRef) throw apiError('Tabela manual nao encontrada no PostgreSQL local: ' + name, 503);
    const countResult = await pgCacheQuery('SELECT COUNT(*)::int AS count FROM ' + pgRef.pgTable);
    const rowCount = Number(countResult.rows[0] && countResult.rows[0].count || 0);
    if (rowCount > MANUAL_TABLE_SYNC_MAX_ROWS_PER_TABLE) {
      throw apiError('A tabela manual "' + name + '" possui ' + rowCount + ' linhas. O limite de publicacao por tabela e ' + MANUAL_TABLE_SYNC_MAX_ROWS_PER_TABLE + '.', 413);
    }
    totalRows += rowCount;
    if (totalRows > MANUAL_TABLE_SYNC_MAX_TOTAL_ROWS) {
      throw apiError('As tabelas manuais possuem mais de ' + MANUAL_TABLE_SYNC_MAX_TOTAL_ROWS + ' linhas no total. Reduza o volume antes de publicar.', 413);
    }
    const rowsResult = await pgCacheQuery('SELECT * FROM ' + pgRef.pgTable + ' ORDER BY 1');
    tables.push({
      name,
      columns: columns.map(function(column) {
        const extra = String(column.extra || '');
        return {
          name: String(column.name || ''),
          type: String(column.columnType || column.dataType || column.type || 'texto'),
          primaryKey: String(column.columnKey || column.key || '').toUpperCase() === 'PRI' || Boolean(column.primaryKey),
          autoIncrement: /auto_increment|serial/i.test(extra) || Boolean(column.autoIncrement),
          allowNull: String(column.nullable || 'YES').toUpperCase() !== 'NO',
          extra
        };
      }),
      rows: rowsResult.rows || []
    });
  }
  return tables;
}

async function addManualTable(tableName) {
  const existing = await readManualTables();
  if (!existing.some(function(name) { return String(name || '').toLowerCase() === String(tableName || '').toLowerCase(); })) {
    existing.push(tableName);
    await writeManualTables(existing);
  }
}

async function readColumnFormats() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(COLUMN_FORMATS_FILE, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    return {};
  }
}

async function writeColumnFormats(formats) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const safe = formats && typeof formats === 'object' && !Array.isArray(formats) ? formats : {};
  const tmp = COLUMN_FORMATS_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(safe, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, COLUMN_FORMATS_FILE);
}

async function saveTableColumnFormats(tableName, columns) {
  const all = await readColumnFormats();
  const tableFormats = {};
  for (const col of columns) {
    if (col.format) {
      tableFormats[col.name] = { format: String(col.format).trim(), type: String(col.type || 'texto') };
    }
  }
  all[tableName] = tableFormats;
  await writeColumnFormats(all);
}



async function readImportedTables() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(IMPORTED_TABLES_FILE, 'utf8');
    const parsed = JSON.parse(raw || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => ({
      name: String(item.name || '').trim(),
      sourceTable: String(item.sourceTable || '').trim(),
      createdAt: item.createdAt || '',
      updatedAt: item.updatedAt || '',
      note: String(item.note || '').trim(),
      rowFilter: item.rowFilter && typeof item.rowFilter === 'object' ? { column: String(item.rowFilter.column || '').trim(), values: Array.isArray(item.rowFilter.values) ? item.rowFilter.values.map(String).filter(Boolean) : [] } : null,
      dateFilter: item.dateFilter && typeof item.dateFilter === 'object' ? { column: String(item.dateFilter.column || '').trim(), start: String(item.dateFilter.start || '').trim(), end: String(item.dateFilter.end || '').trim() } : null,
      steps: Array.isArray(item.steps) ? item.steps.map(normalizeTransformStep).filter(Boolean) : [],
      incrementalColumn: String(item.incrementalColumn || '').trim() || null
    })).filter((item) => item.name && item.sourceTable);
  } catch (err) {
    return [];
  }
}

async function writeImportedTables(tables) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const seen = new Set();
  const clean = [];
  for (const item of (Array.isArray(tables) ? tables : [])) {
    const name = String(item && item.name || '').trim();
    const sourceTable = String(item && item.sourceTable || '').trim();
    if (!name || !sourceTable) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push({ ...item, name, sourceTable });
  }
  clean.sort((a, b) => a.name.localeCompare(b.name));
  const tmp = IMPORTED_TABLES_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(clean, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, IMPORTED_TABLES_FILE);
  return clean;
}

function replaceTableNameReferencesDeep(value, oldName, newName) {
  const oldLower = String(oldName || '').toLowerCase();
  const tableKeys = new Set(['table', 'tableName', 'source', 'sourceTable', 'resource', 'resourceName', 'fromTable', 'toTable', 'targetTable', 'filterTable']);
  const expressionKeys = new Set(['sql', 'storedSql', 'formula', 'expression', 'dax']);
  const escapedOldName = String(oldName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function replaceExpressionReferences(text) {
    var next = String(text || '');
    next = next.replace(new RegExp('`' + escapedOldName + '`', 'gi'), '`' + String(newName || '').replace(/`/g, '``') + '`');
    next = next.replace(new RegExp('"' + escapedOldName + '"', 'gi'), '"' + String(newName || '').replace(/"/g, '""') + '"');
    next = next.replace(new RegExp("'" + escapedOldName + "'(?=\\s*\\[)", 'gi'), "'" + String(newName || '').replace(/'/g, "''") + "'");
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(oldName || ''))) {
      const daxTarget = "'" + String(newName || '').replace(/'/g, "''") + "'";
      next = next.replace(new RegExp('\\b' + escapedOldName + '(?=\\s*\\[)', 'gi'), daxTarget);
    }
    return next;
  }
  function walk(node, key = '') {
    if (typeof node === 'string') {
      if (tableKeys.has(key) && node.toLowerCase() === oldLower) return newName;
      if (expressionKeys.has(key)) return replaceExpressionReferences(node);
      return node;
    }
    if (Array.isArray(node)) return node.map((item) => walk(item, key));
    if (node && typeof node === 'object') {
      const out = {};
      const entries = Object.entries(node).sort(([leftKey], [rightKey]) => {
        const leftLegacy = leftKey.toLowerCase() === oldLower ? 1 : 0;
        const rightLegacy = rightKey.toLowerCase() === oldLower ? 1 : 0;
        return leftLegacy - rightLegacy;
      });
      for (const [childKey, childValue] of entries) {
        const migratedKey = childKey.toLowerCase() === oldLower ? newName : childKey;
        const isSemanticTableName = key === 'tables' && childKey === 'name' && typeof childValue === 'string' && childValue.toLowerCase() === oldLower;
        const migratedValue = isSemanticTableName ? newName : walk(childValue, childKey);
        if (!Object.prototype.hasOwnProperty.call(out, migratedKey)) {
          out[migratedKey] = migratedValue;
          continue;
        }
        const currentValue = out[migratedKey];
        if (Array.isArray(currentValue) && Array.isArray(migratedValue)) {
          const seen = new Set(currentValue.map((item) => stableStringify(item)));
          out[migratedKey] = currentValue.concat(migratedValue.filter((item) => {
            const signature = stableStringify(item);
            if (seen.has(signature)) return false;
            seen.add(signature);
            return true;
          }));
        } else if (currentValue && migratedValue && typeof currentValue === 'object' && typeof migratedValue === 'object') {
          out[migratedKey] = { ...migratedValue, ...currentValue };
        }
      }
      return out;
    }
    return node;
  }
  return walk(value);
}

function dedupeMigratedSemanticModel(model) {
  const next = model && typeof model === 'object' ? model : defaultSemanticModel();
  const uniqueBy = (items, keyFor, preferActive = false) => {
    const indexes = new Map();
    const out = [];
    for (const item of Array.isArray(items) ? items : []) {
      const key = keyFor(item);
      if (!key) continue;
      if (!indexes.has(key)) {
        indexes.set(key, out.length);
        out.push(item);
      } else if (preferActive && out[indexes.get(key)] && out[indexes.get(key)].active === false && item && item.active !== false) {
        out[indexes.get(key)] = item;
      }
    }
    return out;
  };
  const canonical = (value) => String(value || '').trim().toLocaleLowerCase('pt-BR');
  next.tables = uniqueBy(next.tables, (item) => canonical(typeof item === 'string' ? item : item && item.name));
  next.selectedColumns = uniqueBy(next.selectedColumns, (item) => [canonical(item && item.table), canonical(item && item.column), canonical(item && item.alias)].join('|'));
  next.relationships = uniqueBy(next.relationships, (item) => [
    canonical(item && item.fromTable), canonical(item && item.fromColumn),
    canonical(item && item.toTable), canonical(item && item.toColumn)
  ].join('|'), true);
  next.measures = uniqueBy(next.measures, (item) => [canonical(item && item.table), canonical(item && (item.name || item.displayName))].join('|'));
  return next;
}

async function migrateImportedTableAliasReferences(oldName, newName) {
  const oldClean = String(oldName || '').trim();
  const newClean = String(newName || '').trim();
  if (!oldClean || !newClean || oldClean.toLowerCase() === newClean.toLowerCase()) {
    return { reports: 0, model: false, transforms: 0 };
  }
  const reports = await readReports();
  const nextReports = reports.map((report) => replaceTableNameReferencesDeep(report, oldClean, newClean));
  await writeReports(nextReports);

  const model = await readSemanticModel();
  const nextModel = dedupeMigratedSemanticModel(replaceTableNameReferencesDeep(model, oldClean, newClean));
  await writeSemanticModel(nextModel);

  const transforms = await readTransforms();
  const nextTransforms = transforms.map((item) => replaceTableNameReferencesDeep(item, oldClean, newClean));
  await writeTransforms(nextTransforms);
  return { reports: nextReports.length, model: true, transforms: nextTransforms.length };
}

async function migrateLegacyFaturamento2State() {
  const oldName = 'Faturamento2';
  const imported = await readImportedTables();
  const targetImport = imported.find((item) => {
    return String(item && item.name || '').trim().toLowerCase() === 'faturamento'
      || String(item && item.sourceTable || '').trim().toLowerCase() === 'faturamento';
  });
  const legacyImport = imported.find((item) => {
    return String(item && item.name || '').trim().toLowerCase() === 'faturamento2'
      || String(item && item.sourceTable || '').trim().toLowerCase() === 'faturamento2';
  });
  const currentModel = await readSemanticModel();
  const modelTarget = (currentModel.tables || []).find((item) => {
    return String(typeof item === 'string' ? item : item && item.name || '').trim().toLowerCase() === 'faturamento';
  });
  const newName = String(targetImport && targetImport.name || (typeof modelTarget === 'string' ? modelTarget : modelTarget && modelTarget.name) || '').trim();
  if (!newName) return { migrated: false, reason: 'target_missing' };

  let importedChanged = false;
  if (targetImport && legacyImport) {
    if ((!Array.isArray(targetImport.steps) || !targetImport.steps.length) && Array.isArray(legacyImport.steps) && legacyImport.steps.length) {
      targetImport.steps = legacyImport.steps;
      importedChanged = true;
    }
    if (!targetImport.rowFilter && legacyImport.rowFilter) {
      targetImport.rowFilter = legacyImport.rowFilter;
      importedChanged = true;
    }
    if (!targetImport.dateFilter && legacyImport.dateFilter) {
      targetImport.dateFilter = legacyImport.dateFilter;
      importedChanged = true;
    }
    if (!targetImport.incrementalColumn && legacyImport.incrementalColumn) {
      targetImport.incrementalColumn = legacyImport.incrementalColumn;
      importedChanged = true;
    }
    if (importedChanged) {
      targetImport.updatedAt = new Date().toISOString();
      await writeImportedTables(imported);
    }
  }

  const reports = await readReports();
  const transforms = await readTransforms();
  const currentFormats = await readColumnFormats();
  const settings = getSettings();
  const hasFunctionalReferences = /faturamento2/i.test(JSON.stringify({ reports, model: currentModel, transforms }));
  const hasFormatReferences = /faturamento2/i.test(JSON.stringify(currentFormats));
  const hasSettingsReferences = /faturamento2/i.test(JSON.stringify(settings));
  const hasLegacyState = hasFunctionalReferences || hasFormatReferences || hasSettingsReferences;

  if (hasLegacyState && POSTGRES_CACHE_ENABLED) {
    let targetCacheReady = false;
    try {
      const targetCache = await getPgCacheMeta(targetImport && targetImport.sourceTable || newName);
      targetCacheReady = Boolean(targetCache && targetCache.cache_table && Number(targetCache.row_count || 0) > 0);
    } catch (err) {
      targetCacheReady = false;
    }
    if (!targetCacheReady) {
      console.warn('[Migracao Faturamento2] Cache de ' + newName + ' ainda indisponivel; referencias legadas preservadas ate a primeira sincronizacao valida.');
      return { migrated: false, importedChanged, reason: 'target_cache_missing' };
    }
  }

  const migrated = hasFunctionalReferences
    ? await migrateImportedTableAliasReferences(oldName, newName)
    : { reports: 0, model: false, transforms: 0 };

  if (hasFormatReferences) {
    await writeColumnFormats(replaceTableNameReferencesDeep(currentFormats, oldName, newName));
    migrated.columnFormats = true;
  }

  if (hasSettingsReferences) {
    await writeSettings(replaceTableNameReferencesDeep(settings, oldName, newName));
    migrated.settings = true;
  }

  if (hasFunctionalReferences || importedChanged || migrated.columnFormats || migrated.settings) {
    clearQueryCache('legacy-faturamento2-migration');
    resourceListCache = { key: '', savedAt: 0, resources: [], diagnostics: [] };
    console.log('[Migracao Faturamento2] Referencias atualizadas para ' + newName + '.', migrated);
    return { migrated: true, importedChanged, ...migrated };
  }

  // Remove legado do imported_tables e do cache PG sempre, independente da migracao
  if (legacyImport) {
    const cleanedImported = imported.filter((item) => {
      return String(item && item.name || '').trim().toLowerCase() !== 'faturamento2'
        && String(item && item.sourceTable || '').trim().toLowerCase() !== 'faturamento2';
    });
    if (cleanedImported.length < imported.length) {
      await writeImportedTables(cleanedImported);
      console.log('[Migracao Faturamento2] Entrada legada removida do imported_tables.json.');
    }
    try { await clearPostgresCacheForTable(oldName); console.log('[Migracao Faturamento2] Cache PG legado removido.'); } catch (e) { console.error('[Migracao Faturamento2] Erro ao limpar cache PG legado:', e.message); }
  }
  return { migrated: false, legacyCleaned: Boolean(legacyImport), reason: hasLegacyState ? 'target_cache_missing' : 'already_current' };
}


async function readHiddenTables() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(HIDDEN_TABLES_FILE, 'utf8');
    const parsed = JSON.parse(raw || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => ({
      name: String(item.name || '').trim(),
      type: String(item.type || '').trim() || 'table',
      hiddenAt: item.hiddenAt || '',
      note: String(item.note || '').trim()
    })).filter((item) => item.name);
  } catch (err) {
    return [];
  }
}

async function writeHiddenTables(tables) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const seen = new Set();
  const clean = [];
  for (const item of (Array.isArray(tables) ? tables : [])) {
    const name = String(item && item.name || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push({ name, type: String(item.type || 'table'), hiddenAt: item.hiddenAt || new Date().toISOString(), note: String(item.note || '').trim() });
  }
  clean.sort((a, b) => a.name.localeCompare(b.name));
  const tmp = HIDDEN_TABLES_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(clean, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, HIDDEN_TABLES_FILE);
  return clean;
}

async function isHiddenMysqlTable(name) {
  const requested = String(name || '').trim();
  if (!requested || requested === CALENDAR_TABLE_NAME) return false;
  const hidden = await readHiddenTables();
  return hidden.some((item) => item.name.toLowerCase() === requested.toLowerCase());
}

function filterHiddenResources(resources, hiddenTables) {
  const hidden = new Set((hiddenTables || []).map((item) => String(item.name || '').toLowerCase()));
  return (resources || []).filter((item) => {
    if (!item || item.nativeCalendar || item.source === 'native' || item.source === 'transform' || item.source === 'mysql-import' || item.manual) return true;
    const physical = String(item.physicalName || item.name || '').toLowerCase();
    const name = String(item.name || '').toLowerCase();
    return !hidden.has(physical) && !hidden.has(name);
  });
}

function normalizeImportedTableName(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || '';
}

async function findImportedTableByName(name) {
  const requested = String(name || '').trim();
  if (!requested) return null;
  const list = await readImportedTables();
  const requestedLower = requested.toLowerCase();
  return list.find((item) => item.name === requested)
      || list.find((item) => item.name.toLowerCase() === requestedLower)
      || list.find((item) => item.sourceTable === requested)
      || list.find((item) => item.sourceTable.toLowerCase() === requestedLower)
      || null;
}

async function migrateTableNameReferences(oldName, newName) {
  return migrateImportedTableAliasReferences(oldName, newName);
}

async function resolvePgCacheLookup(table) {
  const requested = String(table || '').trim();
  if (!requested) return { table: '', imported: null };
  let imported = null;
  try { imported = await findImportedTableByName(requested); } catch (e) { imported = null; }
  return { table: imported && imported.sourceTable ? imported.sourceTable : requested, imported };
}

function applyRowFilterToRows(rows, rowFilter, dateFilter) {
  let filtered = rows;
  if (rowFilter && rowFilter.column && Array.isArray(rowFilter.values) && rowFilter.values.length) {
    const col = rowFilter.column;
    const allowed = new Set(rowFilter.values.map((v) => String(v).trim()));
    filtered = filtered.filter((row) => allowed.has(String(row[col] ?? '').trim()));
  }
  if (dateFilter && dateFilter.column) {
    const col = dateFilter.column;
    const start = dateFilter.start || '';
    const end = dateFilter.end || '';
    filtered = filtered.filter((row) => {
      const val = String(row[col] ?? '').trim();
      if (!val) return false;
      if (start && val < start) return false;
      if (end && val > end) return false;
      return true;
    });
  }
  return filtered;
}

function buildImportedTableFilterWhere(rowFilter, dateFilter, alias = 'src') {
  const clauses = [];
  const params = [];
  const safeAlias = /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(alias || '')) ? String(alias) : 'src';
  if (rowFilter && rowFilter.column && Array.isArray(rowFilter.values) && rowFilter.values.length) {
    const values = rowFilter.values.filter((value) => value !== '' && value !== null && value !== undefined);
    if (values.length) {
      clauses.push(safeAlias + '.' + quoteIdent(rowFilter.column) + ' IN (' + values.map(() => '?').join(', ') + ')');
      params.push(...values);
    }
  }
  if (dateFilter && dateFilter.column) {
    const columnSql = safeAlias + '.' + quoteIdent(dateFilter.column);
    const start = String(dateFilter.start || '').trim();
    const end = String(dateFilter.end || '').trim();
    if (start && end) {
      clauses.push(columnSql + ' BETWEEN ? AND ?');
      params.push(start, end);
    } else if (start) {
      clauses.push(columnSql + ' >= ?');
      params.push(start);
    } else if (end) {
      clauses.push(columnSql + ' <= ?');
      params.push(end);
    }
  }
  return { whereSql: clauses.join(' AND '), params };
}

function importedResourceMeta(item, physicalMeta) {
  return {
    name: item.name,
    type: physicalMeta && normalizeTableType(physicalMeta.tableType) === 'VIEW' ? 'view' : 'table',
    label: 'Importada',
    source: 'mysql-import',
    sourceTable: item.sourceTable,
    physicalName: physicalMeta && physicalMeta.name ? physicalMeta.name : item.sourceTable,
    imported: true,
    physicalTableType: physicalMeta ? physicalMeta.tableType : '',
    manual: false,
    nativeCalendar: false,
    editable: false,
    readOnly: true,
    createdAt: item.createdAt || '',
    updatedAt: item.updatedAt || ''
  };
}

async function readTransforms() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(TRANSFORMS_FILE, 'utf8');
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.map(normalizeTransformQuery).filter(Boolean) : [];
  } catch (err) {
    return [];
  }
}

async function writeTransforms(items) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const normalized = (items || []).map(normalizeTransformQuery).filter(Boolean);
  const tmp = TRANSFORMS_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, TRANSFORMS_FILE);
  return normalized;
}

function transformResourceName(name) {
  const raw = String(name || '').trim();
  return raw.startsWith('PQ: ') ? raw : 'PQ: ' + raw;
}

function normalizeTransformQuery(input) {
  if (!input || typeof input !== 'object') return null;
  const daxExpression = String(input.daxExpression || '').trim().slice(0, 20000) || undefined;
  let daxDefinition = null;
  if (daxExpression) daxDefinition = parseDaxCalculatedTableDefinition(daxExpression);
  const name = String((daxDefinition && daxDefinition.name) || input.name || '').trim().slice(0, 120);
  const source = daxExpression ? '*dax*' : String(input.source || input.table || '').trim();
  if (!name || !source) return null;
  const steps = Array.isArray(input.steps) ? input.steps.slice(0, 80).map(normalizeTransformStep).filter(Boolean) : [];
  return {
    id: String(input.id || crypto.randomUUID()),
    name: daxExpression ? name : transformResourceName(name.replace(/^PQ:\s*/i, '')),
    source,
    steps,
    sqlExpression: String(input.sqlExpression || '').trim().slice(0, 5000) || undefined,
    daxExpression,
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString()
  };
}

function normalizeTransformStep(step) {
  if (!step || typeof step !== 'object') return null;
  const kind = String(step.kind || '').trim();
  const allowed = new Set(['selectColumns','removeColumns','renameColumn','changeType','filterRows','filterDate','sortRows','replaceValues','removeDuplicates','mergeQueries','appendQueries','customColumn','daxColumn','conditionalColumn','duplicateColumn','splitColumn','formatText','fillValues','groupBy']);
  if (!allowed.has(kind)) return null;
  const out = { kind };
  if (Array.isArray(step.columns)) out.columns = step.columns.map((c) => String(c || '').trim()).filter(Boolean).slice(0, 200);
  if (Array.isArray(step.groupColumns)) out.groupColumns = step.groupColumns.map((c) => String(c || '').trim()).filter(Boolean).slice(0, 20);
  if (Array.isArray(step.aggregations)) out.aggregations = step.aggregations.slice(0, 30).map((a) => ({ column: String((a && a.column) || '').trim(), func: String((a && a.func) || 'SUM').trim().toUpperCase(), newName: String((a && a.newName) || '').trim() })).filter((a) => a.column && a.newName);
  if (step.column !== undefined) out.column = String(step.column || '').trim();
  if (step.newName !== undefined) out.newName = String(step.newName || '').trim();
  if (step.dataType !== undefined) out.dataType = String(step.dataType || '').trim();
  if (step.operator !== undefined) out.operator = String(step.operator || '').trim();
  if (step.value !== undefined) out.value = String(step.value ?? '');
  if (step.value2 !== undefined) out.value2 = String(step.value2 ?? '');
  if (Array.isArray(step.values)) out.values = step.values.map((value) => String(value ?? '').trim()).filter(Boolean).slice(0, 2000);
  if (step.direction !== undefined) out.direction = String(step.direction || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
  if (step.from !== undefined) out.from = String(step.from ?? '');
  if (step.to !== undefined) out.to = String(step.to ?? '');
  if (step.expression !== undefined) out.expression = String(step.expression || '').trim().slice(0, kind === 'daxColumn' ? 5000 : 1000);
  if (step.trueValue !== undefined) out.trueValue = String(step.trueValue ?? '').slice(0, 500);
  if (step.falseValue !== undefined) out.falseValue = String(step.falseValue ?? '').slice(0, 500);
  if (step.delimiter !== undefined) out.delimiter = String(step.delimiter ?? '').slice(0, 50);
  if (step.newName1 !== undefined) out.newName1 = String(step.newName1 || '').trim().slice(0, 120);
  if (step.newName2 !== undefined) out.newName2 = String(step.newName2 || '').trim().slice(0, 120);
  if (step.removeOriginal !== undefined) out.removeOriginal = Boolean(step.removeOriginal);
  if (step.replaceExisting !== undefined) out.replaceExisting = Boolean(step.replaceExisting);
  if (step.format !== undefined) out.format = String(step.format || '').trim().toLowerCase();
  if (step.leftColumn !== undefined) out.leftColumn = String(step.leftColumn || '').trim();
  if (step.rightColumn !== undefined) out.rightColumn = String(step.rightColumn || '').trim();
  if (step.source !== undefined) out.source = String(step.source || '').trim();
  if (step.rightSource !== undefined) out.rightSource = String(step.rightSource || '').trim();
  if (step.appendSource !== undefined) out.appendSource = String(step.appendSource || '').trim();
  if (step.joinType !== undefined) out.joinType = ['LEFT','INNER','RIGHT'].includes(String(step.joinType || '').toUpperCase()) ? String(step.joinType).toUpperCase() : 'LEFT';
  if (step.appliedAt !== undefined) out.appliedAt = String(step.appliedAt || '').trim();
  return out;
}

function transformResourceMeta(item) {
  const calculatedDax = Boolean(item && item.daxExpression);
  return {
    name: item.name,
    type: 'transform',
    label: calculatedDax ? 'Tabela calculada DAX' : 'Consulta transformada',
    source: 'transform',
    manual: false,
    nativeCalendar: false,
    transform: true,
    calculatedDax,
    editable: calculatedDax,
    readOnly: true,
    baseSource: item.source
  };
}

async function findTransformByName(name) {
  const transforms = await readTransforms();
  const requested = String(name || '').trim();
  const requestedKey = requested.toLocaleLowerCase('pt-BR');
  return transforms.find((item) => item.name === requested || item.id === requested)
    || transforms.find((item) => String(item.name || '').toLocaleLowerCase('pt-BR') === requestedKey)
    || null;
}

function parseDaxTableFunctionCall(expression, expectedName) {
  const source = String(expression || '').trim();
  const match = source.match(/^([A-Za-z][A-Za-z0-9_]*)\s*\(/);
  if (!match || String(match[1]).toUpperCase() !== String(expectedName || '').toUpperCase()) {
    throw apiError('A tabela DAX deve usar ' + expectedName + '(...).', 400);
  }
  let depth = 0;
  let single = false;
  let double = false;
  let closingIndex = -1;
  for (let i = match[0].length - 1; i < source.length; i += 1) {
    const ch = source[i];
    const prev = source[i - 1];
    if (ch === "'" && !double && prev !== '\\') single = !single;
    else if (ch === '"' && !single && prev !== '\\') double = !double;
    if (single || double) continue;
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) { closingIndex = i; break; }
    }
  }
  if (closingIndex < 0 || depth !== 0) throw apiError(expectedName + ' possui parenteses incompletos.', 400);
  if (source.slice(closingIndex + 1).trim()) throw apiError('Ha texto inesperado depois de ' + expectedName + '(...).', 400);
  return splitTopLevelDaxOperator(source.slice(match[0].length, closingIndex), ',');
}

function parseDaxCalculatedTableDefinition(formula) {
  const text = String(formula || '').trim();
  if (!text) throw apiError('Digite o codigo da nova tabela DAX.', 400);
  if (text.length > 20000) throw apiError('O codigo DAX excede 20.000 caracteres.', 400);
  const match = text.match(/^([^=\r\n]{1,120}?)\s*=\s*([\s\S]+)$/);
  if (!match) throw apiError('Use o formato Nome da tabela = formula DAX.', 400);
  const name = String(match[1] || '').trim();
  const expression = String(match[2] || '').trim();
  if (!name || !expression) throw apiError('Informe o nome e a formula da tabela DAX.', 400);
  if (/[\u0000-\u001f"`\[\]]/.test(name)) throw apiError('Nome de tabela DAX invalido.', 400);
  const branches = parseDaxTableFunctionCall(expression, 'UNION');
  if (branches.length < 2) throw apiError('UNION precisa de pelo menos duas tabelas SELECTCOLUMNS.', 400);
  return { name, expression, formula: name + ' = ' + expression, branches };
}

function cleanDaxCalculatedSourceName(value) {
  const text = String(value || '').trim();
  const quoted = text.match(/^'([\s\S]+)'$/);
  return String(quoted ? quoted[1].replace(/''/g, "'") : text).trim();
}

function parseDaxSelectColumnsBranch(expression) {
  const args = parseDaxTableFunctionCall(expression, 'SELECTCOLUMNS');
  if (args.length < 3 || (args.length - 1) % 2 !== 0) {
    throw apiError('SELECTCOLUMNS deve conter a tabela e pares "Nome da coluna", expressao.', 400);
  }
  const table = cleanDaxCalculatedSourceName(args[0]);
  if (!table) throw apiError('Informe a tabela de origem no SELECTCOLUMNS.', 400);
  const fields = [];
  for (let i = 1; i < args.length; i += 2) {
    const alias = daxDoubleQuotedLiteral(args[i]);
    if (alias === null || !String(alias).trim()) throw apiError('O nome de cada coluna do SELECTCOLUMNS deve estar entre aspas duplas.', 400);
    fields.push({ name: String(alias).trim(), expression: String(args[i + 1] || '').trim() });
  }
  return { table, fields };
}

function pgDaxCalculatedType(meta) {
  const raw = String(meta && (meta.pgType || meta.dataType || meta.columnType || meta.type) || '').toLowerCase();
  if (/bool/.test(raw)) return 'bool';
  if (/timestamp|datetime/.test(raw)) return 'datetime';
  if (/\bdate\b/.test(raw)) return 'date';
  if (/int|serial/.test(raw)) return 'integer';
  if (/numeric|decimal|real|double|float|money/.test(raw)) return 'decimal';
  return 'text';
}

function commonPgDaxCalculatedType(items) {
  const types = items.map((item) => item.type).filter((type) => type && type !== 'null');
  if (!types.length) return 'text';
  if (types.every((type) => type === 'integer')) return 'integer';
  if (types.every((type) => type === 'integer' || type === 'decimal')) return 'decimal';
  if (types.every((type) => type === 'date')) return 'date';
  if (types.every((type) => type === 'date' || type === 'datetime')) return 'datetime';
  if (types.every((type) => type === 'bool')) return 'bool';
  if (types.every((type) => type === 'text')) return 'text';
  return 'text';
}

function castPgDaxCalculatedExpression(sql, type) {
  const casts = { integer: 'BIGINT', decimal: 'NUMERIC', date: 'DATE', datetime: 'TIMESTAMP', bool: 'BOOLEAN', text: 'TEXT' };
  return 'CAST(' + sql + ' AS ' + (casts[type] || 'TEXT') + ')';
}

function pgDaxCalculatedColumnMeta(name, type) {
  const pgTypes = { integer: 'bigint', decimal: 'numeric', date: 'date', datetime: 'timestamp without time zone', bool: 'boolean', text: 'text' };
  const pgType = pgTypes[type] || 'text';
  return { name, dataType: pgType, columnType: pgType, pgType, columnKey: '', nullable: 'YES', defaultValue: null, extra: '' };
}

function pgDaxConcatenationOperandSql(item) {
  const sql = String(item && item.sql || 'NULL');
  const textSql = 'CAST(' + sql + ' AS TEXT)';
  const meta = item && item.meta;
  const kind = meta ? pgDaxScalarMetaKind(meta) : String(item && item.type || '').toLowerCase();
  // Colunas importadas como texto podem conter codigos numericos preenchidos
  // com zeros (por exemplo, Produto[Codigo Produto] = "000025"). No operador
  // DAX &, o BI WA usa o valor numerico visivel da coluna para formar chaves:
  // 1 & 000025 deve resultar em 125, sem alterar textos ou literais como " - ".
  if (meta && meta.name && kind === 'text') {
    const trimmedSql = 'BTRIM(' + textSql + ')';
    return "COALESCE(CASE WHEN " + trimmedSql + " ~ '^[+-]?[0-9]+$' THEN CAST(CAST(" + trimmedSql + " AS NUMERIC) AS TEXT) ELSE " + textSql + " END, '')";
  }
  return "COALESCE(" + textSql + ", '')";
}

async function daxCalculatedSourceMeta(table, stack) {
  const transform = await findTransformByName(table);
  if (transform && transform.daxExpression) return ensureDaxCalculatedTableView(transform, stack);
  const meta = await getPgEffectiveMeta(table);
  if (!meta || !meta.cache_table) throw apiError('Tabela nao encontrada no cache PostgreSQL: ' + table + '. Sincronize os dados primeiro.', 400);
  return meta;
}

async function ensurePgFreightAllocationSourceMeta(sourceMeta, logicalTable) {
  if (!sourceMeta || !sourceMeta.cache_table) throw apiError('Origem PostgreSQL do rateio de frete nao encontrada.', 400);
  const rawLookup = logicalTable ? await getRawPgMetaForLogicalTable(logicalTable) : null;
  const allocationMeta = rawLookup && rawLookup.meta && rawLookup.meta.cache_table ? rawLookup.meta : sourceMeta;
  const columns = Array.isArray(allocationMeta.columns) ? allocationMeta.columns : [];
  const freightColumn = findPgColumn(columns, 'Valor Frete');
  const quantityColumn = findPgColumn(columns, 'Quantidade Item');
  const keyColumn = findPgColumn(columns, 'Chave NFe');
  const cfopColumn = findPgColumn(columns, 'CFOP');
  const statusColumn = findPgColumn(columns, 'Situacao') || findPgColumn(columns, 'Situação');
  const missing = [
    ['Valor Frete', freightColumn],
    ['Quantidade Item', quantityColumn],
    ['Chave NFe', keyColumn],
    ['CFOP', cfopColumn],
    ['Situacao', statusColumn]
  ].filter((item) => !item[1]).map((item) => item[0]);
  if (missing.length) throw apiError('O Recebimento nao possui as colunas necessarias ao rateio: ' + missing.join(', ') + '.', 400);

  const sourceRef = quotePgQualified(POSTGRES_CACHE_SCHEMA, allocationMeta.cache_table);
  const materializedName = 'freight_totals_' + crypto.createHash('sha1').update(String(allocationMeta.cache_table)).digest('hex').slice(0, 16);
  const materializedRef = quotePgQualified(POSTGRES_CACHE_SCHEMA, materializedName);
  const rateColumn = (column) => 'rate_src.' + quotePgIdent(column.name);
  const rateEligible = 'CAST(' + rateColumn(cfopColumn) + " AS TEXT) IN ('1.102', '2.102') AND CAST(" + rateColumn(statusColumn) + " AS TEXT) = 'Recebido Total'";
  const allocationSql = 'SELECT ' + rateColumn(keyColumn) + ' AS ' + quotePgIdent('__key') +
    ', MAX(' + rateColumn(freightColumn) + ') AS ' + quotePgIdent('__freight') +
    ', SUM(' + rateColumn(quantityColumn) + ') AS ' + quotePgIdent('__quantity') +
    ' FROM ' + sourceRef + ' rate_src WHERE ' + rateEligible + ' GROUP BY ' + rateColumn(keyColumn);
  await pgCacheQuery('CREATE MATERIALIZED VIEW IF NOT EXISTS ' + materializedRef + ' AS ' + allocationSql + ' WITH NO DATA');

  const signature = crypto.createHash('sha1').update(JSON.stringify({
    cacheTable: allocationMeta.cache_table,
    dataUpdatedAt: allocationMeta.last_data_update_at || allocationMeta.lastDataUpdateAt || allocationMeta.synced_at || '',
    rowCount: Number(allocationMeta.row_count || 0),
    marker: allocationMeta.last_marker || allocationMeta.source_marker || '',
    formula: 'freight-totals-v3'
  })).digest('hex');
  const expectedComment = 'biwa-freight:' + signature;
  const commentResult = await pgCacheQuery("SELECT obj_description(to_regclass($1), 'pg_class') AS signature", [POSTGRES_CACHE_SCHEMA + '.' + materializedName]);
  const savedComment = String(commentResult.rows && commentResult.rows[0] && commentResult.rows[0].signature || '');
  if (savedComment !== expectedComment) {
    await pgCacheQuery('REFRESH MATERIALIZED VIEW ' + materializedRef);
    await pgCacheQuery('COMMENT ON MATERIALIZED VIEW ' + materializedRef + ' IS ' + quotePgLiteral(expectedComment));
    await pgCacheQuery('ANALYZE ' + materializedRef);
  }
  await pgCacheQuery('CREATE UNIQUE INDEX IF NOT EXISTS ' + quotePgIdent(materializedName + '_key_idx') + ' ON ' + materializedRef + ' (' + quotePgIdent('__key') + ')');
  return {
    ...sourceMeta,
    freightAllocation: true,
    freightTotalsTable: materializedName
  };
}

async function compileDaxCalculatedField(field, branch, sourceMeta) {
  const expression = String(field.expression || '').trim();
  if (!expression) throw apiError('Expressao vazia para a coluna ' + field.name + '.', 400);
  if (/^BLANK\s*\(\s*\)$/i.test(expression)) return { sql: 'NULL', type: 'null' };
  const freightAllocationMatch = expression.match(/^FRETERATEIO\s*\(([\s\S]*)\)\s*$/i);
  if (freightAllocationMatch) {
    const args = splitTopLevelArgs(freightAllocationMatch[1]);
    if (args.length !== 5) throw apiError('FRETERATEIO exige Valor Frete, Quantidade, Chave NFe, CFOP e Situacao.', 400);
    if (!sourceMeta.freightAllocation || !sourceMeta.freightTotalsTable) throw apiError('O rateio de frete ainda nao foi preparado no PostgreSQL.', 503);
    const compiled = [];
    for (const arg of args) compiled.push(await compileDaxCalculatedField({ name: field.name, expression: arg }, branch, sourceMeta));
    const eligible = 'CAST(' + compiled[3].sql + " AS TEXT) IN ('1.102', '2.102') AND CAST(" + compiled[4].sql + " AS TEXT) = 'Recebido Total'";
    const totalsAlias = 'dax_freight_totals';
    return {
      sql: 'CASE WHEN ' + eligible + ' THEN COALESCE(' + totalsAlias + '.' + quotePgIdent('__freight') + ' * (' + compiled[1].sql + ') / NULLIF(' + totalsAlias + '.' + quotePgIdent('__quantity') + ', 0), 0) ELSE 0 END',
      type: 'decimal',
      meta: pgDaxCalculatedColumnMeta('Frete Rateado Linha', 'decimal'),
      joinSql: 'LEFT JOIN ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, sourceMeta.freightTotalsTable) + ' ' + totalsAlias + ' ON CAST(' + totalsAlias + '.' + quotePgIdent('__key') + ' AS TEXT) = CAST(' + compiled[2].sql + ' AS TEXT)'
    };
  }
  const literal = daxDoubleQuotedLiteral(expression);
  if (literal !== null) return { sql: quotePgLiteral(literal), type: 'text' };
  if (/^-?\d+(?:[.,]\d+)?$/.test(expression)) return { sql: expression.replace(',', '.'), type: expression.includes('.') || expression.includes(',') ? 'decimal' : 'integer' };
  if (/^(TRUE|FALSE)\s*(?:\(\s*\))?$/i.test(expression)) return { sql: /^TRUE/i.test(expression) ? 'TRUE' : 'FALSE', type: 'bool' };
  const concatParts = splitTopLevelDaxOperator(expression, '&');
  if (concatParts.length > 1) {
    const compiledParts = [];
    for (const part of concatParts) compiledParts.push(await compileDaxCalculatedField({ name: field.name, expression: part }, branch, sourceMeta));
    return { sql: 'CONCAT(' + compiledParts.map(pgDaxConcatenationOperandSql).join(', ') + ')', type: 'text' };
  }
  const reference = parseDaxColumnReference(expression);
  if (!reference || !reference.column) throw apiError('Expressao DAX ainda nao suportada em ' + field.name + ': ' + expression, 400);
  if (reference.table && pgModelKey(reference.table) !== pgModelKey(branch.table)) {
    throw apiError('A coluna ' + field.name + ' usa ' + reference.table + ', mas o SELECTCOLUMNS atual usa ' + branch.table + '.', 400);
  }
  const column = findPgColumn(sourceMeta.columns || [], reference.column);
  if (!column) throw apiError('Coluna nao encontrada: ' + branch.table + '[' + reference.column + ']', 400);
  return { sql: 'src.' + quotePgIdent(column.name), type: pgDaxCalculatedType(column), meta: column };
}

async function buildDaxCalculatedTableProjection(transform, stack) {
  if (!postgresCacheAvailable()) throw apiError('O cache PostgreSQL nao esta disponivel para calcular a tabela DAX.', 503);
  const definition = parseDaxCalculatedTableDefinition(transform && transform.daxExpression);
  const currentStack = Array.isArray(stack) ? stack.slice() : [];
  const key = pgModelKey(definition.name);
  if (currentStack.includes(key)) throw apiError('Dependencia circular entre tabelas DAX: ' + definition.name, 400);
  currentStack.push(key);
  const branches = definition.branches.map(parseDaxSelectColumnsBranch);
  const compiledBranches = [];
  const sourceSignatures = [];
  const validationIssues = [];
  for (const branch of branches) {
    if (pgModelKey(branch.table) === key) throw apiError('A tabela DAX nao pode usar a si mesma como origem.', 400);
    let sourceMeta = await daxCalculatedSourceMeta(branch.table, currentStack);
    if (branch.fields.some((field) => /^FRETERATEIO\s*\(/i.test(String(field && field.expression || '').trim()))) {
      sourceMeta = await ensurePgFreightAllocationSourceMeta(sourceMeta, branch.table);
    }
    sourceSignatures.push({ table: branch.table, cacheTable: sourceMeta.cache_table, columns: (sourceMeta.columns || []).map((column) => [column.name, column.dataType || column.columnType || column.pgType || '']) });
    const fields = [];
    for (const field of branch.fields) {
      try { fields.push(await compileDaxCalculatedField(field, branch, sourceMeta)); }
      catch (err) {
        validationIssues.push(err && err.message ? err.message : String(err));
        fields.push({ sql: 'NULL', type: 'null' });
      }
    }
    compiledBranches.push({ branch, sourceMeta, fields });
  }
  if (validationIssues.length) {
    const uniqueIssues = Array.from(new Set(validationIssues));
    throw apiError('Codigo DAX invalido:\n- ' + uniqueIssues.join('\n- '), 400);
  }
  const width = compiledBranches[0].fields.length;
  if (!width) throw apiError('SELECTCOLUMNS nao possui colunas.', 400);
  if (compiledBranches.some((item) => item.fields.length !== width)) throw apiError('Todos os SELECTCOLUMNS do UNION precisam ter a mesma quantidade de colunas.', 400);
  const outputNames = compiledBranches[0].branch.fields.map((field) => field.name);
  const duplicateNames = outputNames.filter((name, index) => outputNames.findIndex((candidate) => pgModelKey(candidate) === pgModelKey(name)) !== index);
  if (duplicateNames.length) throw apiError('Coluna duplicada na tabela DAX: ' + duplicateNames[0], 400);
  const outputTypes = outputNames.map((_, index) => commonPgDaxCalculatedType(compiledBranches.map((item) => item.fields[index])));
  const selects = compiledBranches.map((item) => {
    const fieldsSql = item.fields.map((field, index) => castPgDaxCalculatedExpression(field.sql, outputTypes[index]) + ' AS ' + quotePgIdent(outputNames[index])).join(', ');
    const fieldJoins = Array.from(new Set(item.fields.map((field) => field && field.joinSql).filter(Boolean)));
    return 'SELECT ' + fieldsSql + ' FROM ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, item.sourceMeta.cache_table) + ' src ' + fieldJoins.join(' ');
  });
  const baseSql = selects.join(' UNION ALL ');
  const baseColumns = outputNames.map((name, index) => pgDaxCalculatedColumnMeta(name, outputTypes[index]));
  const effectiveSteps = pgEffectiveTransformSteps(transform && transform.steps);
  let effective;
  if (effectiveSteps.every(function(step) { return ['daxColumn', 'fillValues', 'changeType'].includes(step.kind); })) {
    const fields = new Map();
    baseColumns.forEach(function(meta) {
      fields.set(pgModelKey(meta.name), { expr: 'src.' + quotePgIdent(meta.name), meta: Object.assign({}, meta), derived: false });
    });
    const context = {
      baseTable: definition.name,
      baseNames: [definition.name, transform && transform.name].filter(Boolean),
      fields,
      lookupJoins: []
    };
    const modelingSteps = await applyPgModelingStepsToFields(fields, context, effectiveSteps);
    const ordered = [];
    baseColumns.forEach(function(column) { ordered.push(fields.get(pgModelKey(column.name))); });
    fields.forEach(function(field) { if (field.derived) ordered.push(field); });
    effective = {
      sql: modelingSteps.length
        ? 'SELECT ' + ordered.map(function(field) { return field.expr + ' AS ' + quotePgIdent(field.meta.name); }).join(', ') + ' FROM (' + baseSql + ') src ' + context.lookupJoins.join(' ')
        : baseSql,
      columns: ordered.map(function(field) { return field.meta; }),
      steps: effectiveSteps
    };
  } else {
    effective = await buildPgEffectiveTransformPipeline(baseSql, baseColumns, effectiveSteps, {
      baseTable: definition.name,
      baseNames: [definition.name, transform && transform.name].filter(Boolean)
    });
  }
  const signaturePayload = effectiveSteps.some(function(step) { return !['daxColumn', 'fillValues', 'changeType'].includes(step.kind); })
    ? { effectivePipelineVersion: 2, formula: definition.formula, sources: sourceSignatures, steps: effective.steps }
    : { formula: definition.formula, sources: sourceSignatures, steps: pgModelingSteps(effectiveSteps) };
  return {
    definition,
    sql: effective.sql,
    columns: effective.columns,
    dependencies: branches.map((branch) => branch.table),
    signature: crypto.createHash('sha1').update(JSON.stringify(signaturePayload)).digest('hex')
  };
}

function daxCalculatedTableViewName(transform, projection) {
  return 'dax_' + crypto.createHash('sha1').update(String(transform && transform.name || '') + '|' + String(projection && projection.signature || '')).digest('hex').slice(0, 20);
}

var pgDaxCalculatedViewCache = new Map();

async function ensureDaxCalculatedTableView(transform, stack) {
  const projection = await buildDaxCalculatedTableProjection(transform, stack);
  const viewName = daxCalculatedTableViewName(transform, projection);
  const cacheKey = pgModelKey(transform && transform.name);
  const cached = pgDaxCalculatedViewCache.get(cacheKey);
  if (cached && cached.signature === projection.signature) return cached.meta;
  await pgCacheQuery('CREATE OR REPLACE VIEW ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, viewName) + ' AS ' + projection.sql);
  const meta = {
    source_table: transform.name,
    physical_table: viewName,
    cache_table: viewName,
    columns: projection.columns,
    row_count: 0,
    synced_at: transform.updatedAt || transform.createdAt || new Date().toISOString(),
    sync_mode: 'calculated',
    calculated: true,
    daxExpression: transform.daxExpression,
    dependencies: projection.dependencies,
    projection
  };
  pgDaxCalculatedViewCache.set(cacheKey, { signature: projection.signature, meta: meta });
  return meta;
}

var pgTransformQueryViewCache = new Map();

async function ensurePgTransformQueryView(transform) {
  if (!transform || !transform.source || transform.daxExpression) return null;
  if (transform.sqlExpression) throw apiError('Consulta SQL transformada precisa ser materializada antes de participar do modelo semantico.', 409);
  const sourceMeta = await getPgEffectiveMeta(transform.source);
  if (!sourceMeta || !sourceMeta.cache_table) throw apiError('Origem sem tabela efetiva no PostgreSQL: ' + transform.source, 409);
  const sourceColumns = sourceMeta.columns && sourceMeta.columns.length ? sourceMeta.columns : await pgRelationColumns(sourceMeta.cache_table);
  const effective = await buildPgEffectiveTransformPipeline(
    'SELECT * FROM ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, sourceMeta.cache_table),
    sourceColumns,
    transform.steps,
    { baseTable: transform.name, baseNames: [transform.name, transform.source] }
  );
  const signature = crypto.createHash('sha1').update(JSON.stringify({
    effectivePipelineVersion: 2,
    name: transform.name,
    source: transform.source,
    sourceCache: sourceMeta.cache_table,
    sourceColumns: sourceColumns.map(function(column) { return [column.name, column.dataType || column.pgType || column.columnType || '']; }),
    steps: effective.steps
  })).digest('hex');
  const viewName = 'transform_' + signature.slice(0, 20);
  const cacheKey = pgModelKey(transform && transform.name);
  const cached = pgTransformQueryViewCache.get(cacheKey);
  if (cached && cached.signature === signature) return cached.meta;
  await pgCacheQuery('CREATE OR REPLACE VIEW ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, viewName) + ' AS ' + effective.sql);
  const meta = {
    source_table: transform.name,
    physical_table: viewName,
    cache_table: viewName,
    columns: effective.columns,
    row_count: 0,
    synced_at: transform.updatedAt || transform.createdAt || new Date().toISOString(),
    sync_mode: 'transform',
    transformed: true,
    transformId: transform.id,
    transformVersion: transform.updatedAt || signature,
    sourceMeta: sourceMeta,
    signature: signature
  };
  pgTransformQueryViewCache.set(cacheKey, { signature: signature, meta: meta });
  return meta;
}

function mysqlCastForTransform(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'numero' || t === 'number' || t === 'decimal' || t === 'numeric' || t === 'dec' || t === 'double' || t === 'float' || t === 'real') return 'DECIMAL(18,4)';
  if (t === 'inteiro' || t === 'int' || t === 'integer') return 'SIGNED';
  if (t === 'data' || t === 'date') return 'DATE';
  if (t === 'datetime' || t === 'timestamp') return 'DATETIME';
  if (t === 'hora' || t === 'time') return 'TIME';
  if (t === 'texto' || t === 'text' || t === 'varchar' || t === 'char' || t === 'string') return 'CHAR';
  if (t === 'bool' || t === 'boolean') return 'TINYINT(1)';
  if (t === 'binario' || t === 'binary' || t === 'blob') return 'VARBINARY(255)';
  return '';
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined || value === '') return null;
  var s = String(value).trim();
  var lastDot = s.lastIndexOf('.');
  var lastComma = s.lastIndexOf(',');
  var normalized;
  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      normalized = s.replace(/\./g, '').replace(',', '.');
    } else {
      normalized = s.replace(/,/g, '');
    }
  } else if (lastComma >= 0) {
    var afterComma = s.slice(lastComma + 1);
    if (afterComma.length > 0 && afterComma.length <= 2 && /^\d+$/.test(afterComma)) {
      normalized = s.replace(',', '.');
    } else {
      normalized = s.replace(/,/g, '');
    }
  } else if (lastDot >= 0) {
    var afterDot = s.slice(lastDot + 1);
    var dotsBefore = s.slice(0, lastDot).split('.').length - 1;
    if (dotsBefore > 0 || (afterDot.length === 3 && /^\d{3}$/.test(afterDot))) {
      normalized = s.replace(/\./g, '');
    } else {
      normalized = s;
    }
  } else {
    normalized = s;
  }
  var n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function getChangeTypeStepsFromImported(tableName) {
  try {
    const imported = findImportedTableByNameSync(tableName);
    if (!imported || !Array.isArray(imported.steps) || !imported.steps.length) return [];
    return physicalChangeTypeSteps(imported.steps);
  } catch (e) { return []; }
}

function physicalChangeTypeSteps(steps) {
  const all = Array.isArray(steps) ? steps : [];
  const calculatedNames = new Set(all.filter(function(step) { return step && step.kind === 'daxColumn'; }).map(function(step) { return pgModelKey(step.newName || (parseDaxColumnDefinition(step.expression || '').name)); }));
  return all.filter(function(step) {
    return step && step.kind === 'changeType' && step.column && step.dataType && !calculatedNames.has(pgModelKey(step.column));
  });
}

function getChangeTypeCastMap(tableName) {
  const map = new Map();
  const steps = getChangeTypeStepsFromImported(tableName);
  for (const step of steps) {
    const cast = mysqlCastForTransform(step.dataType);
    if (cast) map.set(step.column, cast);
  }
  return map;
}

function applyChangeTypeOverridesToColumns(columns, tableName) {
  const steps = getChangeTypeStepsFromImported(tableName);
  if (!steps.length) return columns;
  const overrides = new Map();
  for (const step of steps) {
    var mapped = 'texto';
    var dt = String(step.dataType || '').toLowerCase();
    if (dt === 'inteiro' || dt === 'int' || dt === 'integer') mapped = 'inteiro';
    else if (dt === 'decimal' || dt === 'numero' || dt === 'number' || dt === 'numeric') mapped = 'decimal';
    else if (dt === 'datetime' || dt === 'timestamp') mapped = 'datetime';
    else if (dt === 'data' || dt === 'date') mapped = 'data';
    else if (dt === 'hora' || dt === 'time') mapped = 'hora';
    else if (dt === 'texto' || dt === 'text' || dt === 'varchar' || dt === 'char') mapped = 'texto';
    else if (dt === 'bool' || dt === 'boolean') mapped = 'bool';
    else if (dt === 'binario' || dt === 'binary' || dt === 'blob') mapped = 'binario';
    overrides.set(step.column, mapped);
  }
  return (columns || []).map(function(col) {
    var name = (col && col.name) ? col.name : '';
    var override = overrides.get(name);
    if (!override) return col;
    var displayType = DISPLAY_TYPE_MAP_BY_NORMALIZED(override) || override.toUpperCase();
    return { ...col, dataType: override, columnType: displayType };
  });
}

function DISPLAY_TYPE_MAP_BY_NORMALIZED(type) {
  var map = { inteiro: 'INT', decimal: 'DECIMAL', datetime: 'DATETIME', data: 'DATE', hora: 'TIME', texto: 'VARCHAR', bool: 'TINYINT(1)', binario: 'BLOB' };
  return map[type] || '';
}

function normalizeTransformDataType(type) {
  var key = String(type || '').toLowerCase().trim();
  var aliases = {
    int: 'inteiro', integer: 'inteiro', inteiro: 'inteiro', bigint: 'inteiro', smallint: 'inteiro', tinyint: 'inteiro', mediumint: 'inteiro',
    decimal: 'decimal', numeric: 'decimal', double: 'decimal', float: 'decimal', real: 'decimal', numero: 'decimal', number: 'decimal', dec: 'decimal',
    datetime: 'datetime', timestamp: 'datetime', timestamptz: 'datetime',
    date: 'data', data: 'data',
    time: 'hora', hora: 'hora',
    varchar: 'texto', text: 'texto', texto: 'texto', char: 'texto', string: 'texto', enum: 'texto', set: 'texto', longtext: 'texto', mediumtext: 'texto',
    boolean: 'bool', bool: 'bool', 'tinyint(1)': 'bool', bit: 'bool',
    binary: 'binario', binario: 'binario', blob: 'binario', bytea: 'binario', varbinary: 'binario', mediumblob: 'binario', longblob: 'binario'
  };
  return aliases[key] || key || 'texto';
}

function transformColumnMetadata(columnNames, steps) {
  const overrides = new Map();
  for (const step of (Array.isArray(steps) ? steps : [])) {
    if (!step || !step.kind) continue;
    if (step.kind === 'changeType' && step.column && step.dataType) {
      overrides.set(String(step.column), normalizeTransformDataType(step.dataType));
    }
    if ((step.kind === 'customColumn' || step.kind === 'conditionalColumn') && (step.newName || step.column)) {
      overrides.set(String(step.newName || step.column), normalizeTransformDataType(step.dataType));
    }
    if (step.kind === 'splitColumn') {
      if (step.newName1) overrides.set(String(step.newName1), 'texto');
      if (step.newName2) overrides.set(String(step.newName2), 'texto');
    }
    if (step.kind === 'groupBy' && Array.isArray(step.aggregations)) {
      step.aggregations.forEach((agg) => {
        if (agg && agg.newName) overrides.set(String(agg.newName), 'decimal');
      });
    }
  }
  return (columnNames || []).map((name) => {
    const colName = String(name || '').trim();
    const dataType = overrides.get(colName) || 'texto';
    return { name: colName, dataType, columnType: DISPLAY_TYPE_MAP_BY_NORMALIZED(dataType) || 'VARCHAR', columnKey: '', nullable: 'YES', defaultValue: null, extra: '' };
  }).filter((col) => col.name);
}

function castColumnSqlExpr(column, castMap) {
  const cast = castMap.get(column);
  if (!cast) return `src.${quoteIdent(column)}`;
  if (cast === 'DATE') return `CAST(CAST(src.${quoteIdent(column)} AS CHAR) AS DATE)`;
  if (cast === 'DATETIME') return `CAST(CAST(src.${quoteIdent(column)} AS CHAR) AS DATETIME)`;
  return `CAST(src.${quoteIdent(column)} AS ${cast})`;
}

function castColumnSqlExprForAlias(column, castMap, alias = 'src') {
  const safeAlias = /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(alias || '')) ? String(alias) : 'src';
  const cast = castMap.get(column);
  if (!cast) return `${safeAlias}.${quoteIdent(column)}`;
  if (cast === 'DATE') return `CAST(CAST(${safeAlias}.${quoteIdent(column)} AS CHAR) AS DATE)`;
  if (cast === 'DATETIME') return `CAST(CAST(${safeAlias}.${quoteIdent(column)} AS CHAR) AS DATETIME)`;
  return `CAST(${safeAlias}.${quoteIdent(column)} AS ${cast})`;
}

function buildColumnFormatsFromImported(tableName) {
  var steps = getChangeTypeStepsFromImported(tableName);
  if (!steps.length) return {};
  var map = {};
  var normalizeType = function(dt) {
    var key = String(dt || '').toLowerCase().trim();
    var aliases = { 'int': 'inteiro', 'integer': 'inteiro', 'inteiro': 'inteiro', 'bigint': 'inteiro', 'smallint': 'inteiro', 'tinyint': 'inteiro', 'mediumint': 'inteiro', 'decimal': 'decimal', 'numeric': 'decimal', 'double': 'decimal', 'float': 'decimal', 'real': 'decimal', 'numero': 'decimal', 'number': 'decimal', 'dec': 'decimal', 'datetime': 'datetime', 'timestamp': 'datetime', 'timestamptz': 'datetime', 'date': 'data', 'data': 'data', 'time': 'hora', 'hora': 'hora', 'varchar': 'texto', 'text': 'texto', 'texto': 'texto', 'char': 'texto', 'string': 'texto', 'enum': 'texto', 'set': 'texto', 'longtext': 'texto', 'mediumtext': 'texto', 'boolean': 'bool', 'bool': 'bool', 'tinyint(1)': 'bool', 'bit': 'bool', 'binary': 'binario', 'binario': 'binario', 'blob': 'binario', 'bytea': 'binario', 'varbinary': 'binario', 'mediumblob': 'binario', 'longblob': 'binario' };
    return aliases[key] || key;
  };
  steps.forEach(function(step) {
    if (!step.column) return;
    var rawFmt = String(step.format || '').trim();
    var fmt = rawFmt.toLowerCase();
    var type = normalizeType(step.dataType);
    var info = { decimals: 2, prefix: '', suffix: '', type: type };
    if (type === 'inteiro' || type === 'decimal') {
      if (fmt && fmt !== 'geral') {
        var dotMatch = fmt.match(/\.(\d+)/);
        if (dotMatch) {
          info.decimals = dotMatch[1].length;
        } else {
          info.decimals = 0;
        }
        if (fmt.indexOf('r$') >= 0) info.prefix = 'R$ ';
        if (fmt.indexOf('%') >= 0) info.suffix = '%';
        if (/e\+00/i.test(fmt)) info.scientific = true;
      } else {
        info.decimals = type === 'inteiro' ? 0 : 2;
      }
    }
    if (type === 'datetime' || type === 'data' || type === 'hora') {
      info.dateType = type;
      info.dateFormat = rawFmt || (type === 'datetime' ? 'dd/MM/yyyy HH:mm' : type === 'data' ? 'dd/MM/yyyy' : 'HH:mm');
    }
    if (type === 'bool') {
      info.boolType = true;
      info.boolFormat = fmt || 'truefalse';
    }
    if (type === 'texto') info.isText = true;
    if (type === 'binario') info.isBinary = true;
    map[step.column] = info;
  });
  return map;
}

function buildColumnFormatsFromMetadata(columns) {
  var map = {};
  (columns || []).forEach(function(col) {
    var name = String(col && (col.name || col.Field) || '').trim();
    if (!name) return;
    var rawType = String(col && (col.dataType || col.columnType || col.type || col.Type) || '').trim();
    var type = normalizeTransformDataType(rawType.split('(')[0]);
    var info = { type: type, prefix: '', suffix: '' };
    if (type === 'inteiro') {
      info.decimals = 0;
    } else if (type === 'decimal') {
      var scaleMatch = rawType.match(/\(\s*\d+\s*,\s*(\d+)\s*\)/);
      info.decimals = scaleMatch ? Number(scaleMatch[1]) : 2;
    } else if (type === 'datetime' || type === 'data' || type === 'hora') {
      info.dateType = type;
      info.dateFormat = type === 'datetime' ? 'dd/MM/yyyy HH:mm' : (type === 'data' ? 'dd/MM/yyyy' : 'HH:mm');
    } else if (type === 'bool') {
      info.boolType = true;
      info.boolFormat = 'truefalse';
    } else if (type === 'texto') {
      info.isText = true;
    } else if (type === 'binario') {
      info.isBinary = true;
    } else {
      return;
    }
    map[name] = info;
  });
  return map;
}

function buildColumnFormatsForTable(tableName, columns) {
  return {
    ...buildColumnFormatsFromMetadata(columns),
    ...buildColumnFormatsFromImported(tableName)
  };
}

function applyChangeTypeToRows(rows, tableName) {
  const steps = getChangeTypeStepsFromImported(tableName);
  if (!steps.length || !Array.isArray(rows) || !rows.length) return rows;
  var converters = {};
  var parseDate = function(v) {
    if (v instanceof Date) return v;
    if (typeof v === 'number') v = String(v);
    if (typeof v !== 'string') return null;
    var t = v.trim();
    if (!t) return null;
    if (/^\d{8}$/.test(t)) return new Date(Number(t.slice(0,4)), Number(t.slice(4,6))-1, Number(t.slice(6,8)));
    var d = new Date(t);
    return isNaN(d.getTime()) ? null : d;
  };
  var parseDatetime = function(v) {
    if (v instanceof Date) return v;
    if (typeof v === 'number') v = String(v);
    if (typeof v !== 'string') return null;
    var t = v.trim();
    if (!t) return null;
    var d = new Date(t);
    return isNaN(d.getTime()) ? null : d;
  };
  for (var i = 0; i < steps.length; i++) {
    var step = steps[i];
    var col = step.column;
    var dt = String(step.dataType || '').toLowerCase();
    if (dt === 'inteiro' || dt === 'int' || dt === 'integer') {
      converters[col] = function(v) { if (v === null || v === undefined || v === '') return null; var n = typeof v === 'number' ? (Number.isFinite(v) ? v : null) : toNumber(v); return n === null ? null : Math.trunc(n); };
    } else if (dt === 'decimal' || dt === 'numero' || dt === 'number' || dt === 'numeric' || dt === 'double' || dt === 'float') {
      converters[col] = function(v) { if (v === null || v === undefined || v === '') return null; return typeof v === 'number' ? (Number.isFinite(v) ? v : null) : toNumber(v); };
    } else if (dt === 'data' || dt === 'date') {
      converters[col] = function(v) { return parseDate(v); };
    } else if (dt === 'datetime' || dt === 'timestamp') {
      converters[col] = function(v) { return parseDatetime(v); };
    } else if (dt === 'texto' || dt === 'text' || dt === 'varchar' || dt === 'char') {
      converters[col] = function(v) { return v === null || v === undefined ? '' : String(v); };
    } else if (dt === 'bool' || dt === 'boolean') {
      converters[col] = function(v) { if (v === null || v === undefined) return null; if (typeof v === 'boolean') return v; if (v === 1 || v === '1' || v === 'true') return true; if (v === 0 || v === '0' || v === 'false') return false; return null; };
    }
  }
  var cols = Object.keys(converters);
  if (!cols.length) return rows;
  return rows.map(function(row) {
    var copy = Object.assign({}, row);
    for (var j = 0; j < cols.length; j++) {
      var c = cols[j];
      if (row.hasOwnProperty(c)) copy[c] = converters[c](row[c]);
    }
    return copy;
  });
}

function transformFilterSql(expr, step, params) {
  const op = String(step.operator || '=').toLowerCase();
  const value = step.value;
  const value2 = step.value2;
  if (op === 'contains' || op === 'contem') { params.push('%' + String(value || '') + '%'); return `CAST(${expr} AS CHAR) LIKE ?`; }
  if (op === 'starts') { params.push(String(value || '') + '%'); return `CAST(${expr} AS CHAR) LIKE ?`; }
  if (op === 'ends') { params.push('%' + String(value || '')); return `CAST(${expr} AS CHAR) LIKE ?`; }
  if (op === 'blank') return `(${expr} IS NULL OR ${expr} = '')`;
  if (op === 'notblank') return `(${expr} IS NOT NULL AND ${expr} <> '')`;
  if (op === 'between') { params.push(value, value2); return `${expr} BETWEEN ? AND ?`; }
  const sqlOp = ['=','!=','>','>=','<','<='].includes(op) ? op : '=';
  // Suporta multiplos valores separados por virgula (checkbox list)
  if (sqlOp === '=' && String(value || '').includes(',')) {
    const values = String(value || '').split(',').map((v) => v.trim()).filter(Boolean);
    if (!values.length) return '1 = 0';
    const placeholders = values.map(() => '?').join(', ');
    params.push(...values);
    return `${expr} IN (${placeholders})`;
  }
  params.push(value);
  return `${expr} ${sqlOp} ?`;
}


async function getTransformSourceDefinition(source, options = {}) {
  const sourceName = String(source || '').trim();
  if (!sourceName) throw apiError('Origem da transformação não informada.', 400);
  const baseTransform = await findTransformByName(sourceName);
  if (baseTransform) {
    const built = await buildTransformSql(baseTransform, { limit: 0 });
    return {
      sql: built.sql.replace(/\s+LIMIT\s+\d+\s*$/i, ''),
      params: built.params || [],
      columns: built.columns || [],
      sourceType: 'transform'
    };
  }
  // Resolve nome logico (importado) para nome fisico da tabela no MySQL
  let physicalName = sourceName;
  let importedItem = null;
  try {
    importedItem = await findImportedTableByName(sourceName);
    if (importedItem && importedItem.sourceTable) physicalName = importedItem.sourceTable;
  } catch (e) { /* usa o nome original */ }
  // Se a tabela importada tem steps, aplica-os como SQL
  if (importedItem && Array.isArray(importedItem.steps) && importedItem.steps.length && !options.skipImportedSteps) {
    await ensureTableExists(physicalName);
    const transform = { source: physicalName, steps: importedItem.steps };
    const built = await buildTransformSql(transform, { limit: 0, skipImportedSteps: true });
    return {
      sql: built.sql.replace(/\s+LIMIT\s+\d+\s*$/i, ''),
      params: built.params || [],
      columns: built.columns || [],
      sourceType: 'mysql-imported-steps'
    };
  }
  // Calendario: tabela nativa/virtual do BI WA. Nao existe no MySQL.
  // Tenta PG cache primeiro, depois gera dados em memoria como fallback.
  if (physicalName === CALENDAR_TABLE_NAME) {
    // Verifica se PG cache ja tem o Calendario sincronizado
    if (postgresCacheAvailable()) {
      try {
        const pgMeta = await getPgCacheMeta(physicalName);
        if (pgMeta && pgMeta.cache_table) {
          // PG cache disponivel: usar nome 'Calendario' para que
          // resolveSqlTableToPgCache faca o rewrite para a tabela cacheada
          return {
            sql: `SELECT * FROM ${quoteIdent(physicalName)} src`,
            params: [],
            columns: calendarColumnNames(),
            sourceType: 'mysql'
          };
        }
      } catch (e) { /* fallback para dados derivados */ }
    }
    // Fallback: gera dados do Calendario em memoria (nao depende de tabela fisica)
    return {
      sql: calendarDerivedSql(),
      params: [],
      columns: calendarColumnNames(),
      sourceType: 'calendar-derived'
    };
  }
  await ensureTableExists(physicalName);
  return {
    sql: `SELECT * FROM ${quoteIdent(physicalName)} src`,
    params: [],
    columns: (await getColumns(physicalName)).map((col) => col.name),
    sourceType: 'mysql'
  };
}

function buildTransformSelectFromState(baseSql, fields, where, orderBy, distinct) {
  const fieldList = Array.from(fields.entries());
  if (!fieldList.length) throw apiError('A transformação removeu todas as colunas.', 400);
  const selectParts = fieldList.map(([alias, def]) => `${def.expr} AS ${quoteIdent(alias)}`);
  let sql = `SELECT ${distinct ? 'DISTINCT ' : ''}${selectParts.join(', ')} FROM (${baseSql}) q`;
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  if (orderBy) sql += ` ${orderBy}`;
  return { sql, columns: fieldList.map(([name]) => name) };
}

function normalizeTransformColumnList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function prefixedTransformColumn(source, column) {
  const cleanedSource = String(source || 'consulta').replace(/^PQ:\s*/i, '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'consulta';
  return `${cleanedSource}_${column}`;
}


function assertSafeTransformExpression(expression) {
  const text = String(expression || '').trim();
  if (!text) throw apiError('Expressão da coluna personalizada é obrigatória.', 400);
  if (text.length > 1000) throw apiError('Expressão muito longa.', 400);
  const blocked = /(;|--|\/\*|\*\/|\b(select|insert|update|delete|drop|alter|truncate|create|replace|grant|revoke|call|load|set|execute|prepare|deallocate|handler|lock|unlock|rename|flush|kill)\b)/i;
  if (blocked.test(text)) throw apiError('Expressão contém comando ou caractere bloqueado.', 400);
  return text;
}

function quoteTransformStringLiterals(expression, params) {
  return String(expression || '').replace(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'/g, (m, d, s) => {
    const value = (d !== undefined ? d : s).replace(/\\(["'\\])/g, '$1');
    params.push(value);
    return '?';
  });
}

function transformExpressionToSql(expression, fields, params) {
  let expr = assertSafeTransformExpression(expression);
  expr = quoteTransformStringLiterals(expr, params);
  expr = expr.replace(/\[([^\]]+)\]/g, (_, col) => {
    const name = String(col || '').trim();
    if (!fields.has(name)) throw apiError('Coluna não encontrada na expressão personalizada: ' + name, 400);
    return fields.get(name).expr;
  });
  // Operador estilo Power Query para concatenar textos.
  if (expr.includes('&')) {
    const parts = expr.split('&').map((part) => part.trim()).filter(Boolean);
    if (parts.length > 1) return `CONCAT(${parts.map((part) => `CAST(${part} AS CHAR)`).join(', ')})`;
  }
  const allowedFunctions = ['CONCAT','COALESCE','IFNULL','NULLIF','UPPER','LOWER','TRIM','LTRIM','RTRIM','ROUND','ABS','YEAR','MONTH','DAY','DATE','DATE_FORMAT','CAST'];
  const functionCalls = expr.match(/\b[A-Za-z_][A-Za-z0-9_]*\s*\(/g) || [];
  for (const fn of functionCalls) {
    const name = fn.replace(/\s*\($/, '').toUpperCase();
    if (!allowedFunctions.includes(name)) throw apiError('Função não permitida na coluna personalizada: ' + name, 400);
  }
  const withoutWords = expr.replace(/\b(CONCAT|COALESCE|IFNULL|NULLIF|UPPER|LOWER|TRIM|LTRIM|RTRIM|ROUND|ABS|YEAR|MONTH|DAY|DATE|DATE_FORMAT|CAST|AS|SIGNED|DECIMAL|CHAR|DATETIME)\b/gi, '')
    .replace(/q\.`[^`]+`/g, '')
    .replace(/\?/g, '')
    .replace(/[0-9]+(?:\.[0-9]+)?/g, '')
    .replace(/\s+/g, '');
  if (/[^+\-*/(),.]/.test(withoutWords)) throw apiError('Expressão personalizada contém caracteres não permitidos.', 400);
  return expr;
}


function safeTransformOutputName(name, fallback) {
  const text = String(name || '').trim().slice(0, 120);
  if (!text) return fallback;
  if (/[`\u0000-\u001f]/.test(text)) throw apiError('Nome de coluna inválido: ' + text, 400);
  return text;
}

function transformAggregateSql(func, expr) {
  const f = String(func || '').toUpperCase();
  if (f === 'COUNT') return `COUNT(${expr})`;
  if (f === 'COUNTDISTINCT' || f === 'DISTINCTCOUNT') return `COUNT(DISTINCT ${expr})`;
  if (f === 'AVG' || f === 'AVERAGE') return `AVG(${expr})`;
  if (f === 'MIN') return `MIN(${expr})`;
  if (f === 'MAX') return `MAX(${expr})`;
  return `SUM(${expr})`;
}

function transformLiteralOrColumnSql(value, fields, params) {
  const text = String(value ?? '').trim();
  const m = text.match(/^\[([^\]]+)\]$/);
  if (m) {
    const col = m[1].trim();
    if (!fields.has(col)) throw apiError('Coluna não encontrada no resultado condicional: ' + col, 400);
    return fields.get(col).expr;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return text;
  if (/^(null)$/i.test(text)) return 'NULL';
  if (/^(today|hoje)$/i.test(text)) return 'CURRENT_DATE()';
  params.push(text);
  return '?';
}

async function buildTransformSql(transform, options = {}) {
  const source = String(transform.source || '').trim();
  if (!source) throw apiError('Origem da transformação não informada.', 400);
  if (transform.daxExpression) {
    const calculated = await ensureDaxCalculatedTableView(transform);
    const limit = Number(options.limit) === 0 ? 0 : clampLimit(options.limit, 200);
    const baseSql = `SELECT * FROM ${quoteIdent(transform.name)} src`;
    return {
      sql: limit > 0 ? `${baseSql} LIMIT ${limit}` : baseSql,
      params: [],
      columns: (calculated.columns || []).map((column) => column.name),
      columnMetadata: calculated.columns || [],
      sourceType: 'postgres-dax-table',
      cacheTable: calculated.cache_table
    };
  }
  if (transform.sqlExpression) {
    const sql = String(transform.sqlExpression || '').trim();
    if (!sql) throw apiError('Expressão SQL vazia.', 400);
    if (!/^\s*SELECT\b/i.test(sql)) throw apiError('A expressão SQL deve começar com SELECT.', 400);
    const limit = Number(options.limit) === 0 ? 0 : clampLimit(options.limit, 200);
    const wrapped = limit > 0 ? `SELECT * FROM (${sql}) q LIMIT ${limit}` : sql;
    return { sql: wrapped, params: [], columns: [] };
  }
  const sourceDef = await getTransformSourceDefinition(source, { skipImportedSteps: options.skipImportedSteps });
  let baseSql = sourceDef.sql;
  let baseParams = sourceDef.params || [];
  let baseColumns = sourceDef.columns || [];
  let fields = new Map(baseColumns.map((name) => [name, { expr: `q.${quoteIdent(name)}`, name }]));
  let params = [...baseParams];
  let where = [];
  let orderBy = '';
  let distinct = false;
  for (const step of (transform.steps || [])) {
    const kind = step.kind;
    if (kind === 'selectColumns') {
      const keep = new Set((step.columns || []).filter((c) => fields.has(c)));
      if (keep.size) fields = new Map(Array.from(fields.entries()).filter(([name]) => keep.has(name)));
    }
    if (kind === 'removeColumns') {
      for (const c of (step.columns || [])) fields.delete(c);
    }
    if (kind === 'renameColumn' && fields.has(step.column) && step.newName) {
      const current = fields.get(step.column);
      fields.delete(step.column);
      fields.set(step.newName, { expr: current.expr, name: step.newName });
    }
    if (kind === 'changeType' && fields.has(step.column)) {
      const cast = mysqlCastForTransform(step.dataType);
      if (cast) {
        const expr = fields.get(step.column).expr;
        // For DATE/DATETIME targets, cast through CHAR to handle integer YYYYMMDD
        // columns like DataKey (e.g. 20260629 -> '20260629' -> '2026-06-29')
        if (cast === 'DATE') {
          fields.set(step.column, { expr: `CAST(CAST(${expr} AS CHAR) AS DATE)`, name: step.column });
        } else if (cast === 'DATETIME') {
          fields.set(step.column, { expr: `CAST(CAST(${expr} AS CHAR) AS DATETIME)`, name: step.column });
        } else {
          fields.set(step.column, { expr: `CAST(${expr} AS ${cast})`, name: step.column });
        }
      }
    }
    if (kind === 'replaceValues' && fields.has(step.column)) {
      params.push(String(step.from ?? ''), String(step.to ?? ''));
      fields.set(step.column, { expr: `REPLACE(CAST(${fields.get(step.column).expr} AS CHAR), ?, ?)`, name: step.column });
    }
    if (kind === 'filterRows' && fields.has(step.column)) {
      where.push(transformFilterSql(fields.get(step.column).expr, step, params));
    }
    if (kind === 'filterDate' && fields.has(step.column)) {
      const colExpr = fields.get(step.column).expr;
      const start = step.value;
      const end = step.value2;
      if (start && end) {
        where.push(`(${colExpr} >= ? AND ${colExpr} <= ?)`);
        params.push(start, end);
      } else if (start) {
        where.push(`(${colExpr} >= ?)`);
        params.push(start);
      } else if (end) {
        where.push(`(${colExpr} <= ?)`);
        params.push(end);
      }
    }
    if (kind === 'sortRows' && fields.has(step.column)) {
      orderBy = `ORDER BY ${quoteIdent(step.column)} ${step.direction === 'DESC' ? 'DESC' : 'ASC'}`;
    }
    if (kind === 'removeDuplicates') {
      distinct = true;
    }
    if (kind === 'customColumn') {
      const newName = String(step.newName || step.column || '').trim();
      if (!newName) throw apiError('Informe o nome da coluna personalizada.', 400);
      if (fields.has(newName)) throw apiError('Já existe uma coluna com este nome: ' + newName, 400);
      const customExpr = transformExpressionToSql(step.expression || '', fields, params);
      const cast = mysqlCastForTransform(step.dataType);
      fields.set(newName, { expr: cast ? `CAST((${customExpr}) AS ${cast})` : `(${customExpr})`, name: newName });
    }
    if (kind === 'conditionalColumn') {
      const newName = String(step.newName || '').trim();
      const sourceColumn = String(step.column || '').trim();
      if (!newName || !sourceColumn) throw apiError('Informe nome e coluna base da coluna condicional.', 400);
      if (fields.has(newName)) throw apiError('Já existe uma coluna com este nome: ' + newName, 400);
      if (!fields.has(sourceColumn)) throw apiError('Coluna da condição não encontrada: ' + sourceColumn, 400);
      const conditionSql = transformFilterSql(fields.get(sourceColumn).expr, step, params);
      const trueSql = transformLiteralOrColumnSql(step.trueValue, fields, params);
      const falseSql = transformLiteralOrColumnSql(step.falseValue, fields, params);
      const caseExpr = `CASE WHEN ${conditionSql} THEN ${trueSql} ELSE ${falseSql} END`;
      const cast = mysqlCastForTransform(step.dataType);
      fields.set(newName, { expr: cast ? `CAST((${caseExpr}) AS ${cast})` : `(${caseExpr})`, name: newName });
    }
    if (kind === 'duplicateColumn') {
      const sourceColumn = String(step.column || '').trim();
      const newName = safeTransformOutputName(step.newName || (sourceColumn ? sourceColumn + ' Copia' : ''), 'Coluna Copia');
      if (!sourceColumn || !fields.has(sourceColumn)) throw apiError('Coluna para duplicar não encontrada: ' + sourceColumn, 400);
      if (fields.has(newName)) throw apiError('Já existe uma coluna com este nome: ' + newName, 400);
      fields.set(newName, { expr: fields.get(sourceColumn).expr, name: newName });
    }
    if (kind === 'formatText') {
      const sourceColumn = String(step.column || '').trim();
      if (!sourceColumn || !fields.has(sourceColumn)) throw apiError('Coluna para formatar não encontrada: ' + sourceColumn, 400);
      const fmt = String(step.format || 'trim').toLowerCase();
      const currentExpr = fields.get(sourceColumn).expr;
      let nextExpr = `TRIM(CAST(${currentExpr} AS CHAR))`;
      if (fmt === 'upper') nextExpr = `UPPER(CAST(${currentExpr} AS CHAR))`;
      if (fmt === 'lower') nextExpr = `LOWER(CAST(${currentExpr} AS CHAR))`;
      if (fmt === 'trimupper') nextExpr = `UPPER(TRIM(CAST(${currentExpr} AS CHAR)))`;
      if (fmt === 'trimlower') nextExpr = `LOWER(TRIM(CAST(${currentExpr} AS CHAR)))`;
      fields.set(sourceColumn, { expr: nextExpr, name: sourceColumn });
    }
    if (kind === 'fillValues') {
      const sourceColumn = String(step.column || '').trim();
      if (!sourceColumn || !fields.has(sourceColumn)) throw apiError('Coluna para preencher não encontrada: ' + sourceColumn, 400);
      const replacement = transformLiteralOrColumnSql(step.value, fields, params);
      fields.set(sourceColumn, { expr: `COALESCE(NULLIF(${fields.get(sourceColumn).expr}, ''), ${replacement})`, name: sourceColumn });
    }
    if (kind === 'splitColumn') {
      const sourceColumn = String(step.column || '').trim();
      if (!sourceColumn || !fields.has(sourceColumn)) throw apiError('Coluna para dividir não encontrada: ' + sourceColumn, 400);
      const delimiter = String(step.delimiter || '').slice(0, 50);
      if (!delimiter) throw apiError('Informe o delimitador para dividir a coluna.', 400);
      const leftName = safeTransformOutputName(step.newName1 || (sourceColumn + ' 1'), sourceColumn + ' 1');
      const rightName = safeTransformOutputName(step.newName2 || (sourceColumn + ' 2'), sourceColumn + ' 2');
      if (fields.has(leftName) || fields.has(rightName)) throw apiError('Uma das colunas de saída já existe.', 400);
      const expr = fields.get(sourceColumn).expr;
      params.push(delimiter, delimiter);
      fields.set(leftName, { expr: `SUBSTRING_INDEX(CAST(${expr} AS CHAR), ?, 1)`, name: leftName });
      fields.set(rightName, { expr: `NULLIF(SUBSTRING_INDEX(CAST(${expr} AS CHAR), ?, -1), CAST(${expr} AS CHAR))`, name: rightName });
      if (step.removeOriginal) fields.delete(sourceColumn);
    }
    if (kind === 'groupBy') {
      const groupColumns = (step.groupColumns || step.columns || []).filter((col) => fields.has(col)).slice(0, 20);
      const aggregations = Array.isArray(step.aggregations) ? step.aggregations.filter((a) => a && fields.has(a.column) && a.newName).slice(0, 30) : [];
      if (!groupColumns.length) throw apiError('Agrupar por exige pelo menos uma coluna de agrupamento.', 400);
      if (!aggregations.length) throw apiError('Agrupar por exige pelo menos uma agregação.', 400);
      const current = buildTransformSelectFromState(baseSql, fields, where, orderBy, distinct);
      const selectParts = groupColumns.map((col) => `q.${quoteIdent(col)} AS ${quoteIdent(col)}`);
      const groupParts = groupColumns.map((col) => `q.${quoteIdent(col)}`);
      const newColumns = [...groupColumns];
      for (const agg of aggregations) {
        const alias = safeTransformOutputName(agg.newName, agg.func + '_' + agg.column);
        if (newColumns.includes(alias)) throw apiError('Coluna duplicada no agrupamento: ' + alias, 400);
        selectParts.push(`${transformAggregateSql(agg.func, `q.${quoteIdent(agg.column)}`)} AS ${quoteIdent(alias)}`);
        newColumns.push(alias);
      }
      baseSql = `SELECT ${selectParts.join(', ')} FROM (${current.sql}) q GROUP BY ${groupParts.join(', ')}`;
      baseParams = params;
      fields = new Map(newColumns.map((name) => [name, { expr: `q.${quoteIdent(name)}`, name }]));
      where = [];
      orderBy = '';
      distinct = false;
    }
    if (kind === 'appendQueries') {
      const appendSource = String(step.source || step.appendSource || '').trim();
      if (!appendSource) throw apiError('Informe a consulta/tabela para acrescentar.', 400);
      const current = buildTransformSelectFromState(baseSql, fields, where, orderBy, distinct);
      const appendDef = await getTransformSourceDefinition(appendSource, { skipImportedSteps: options.skipImportedSteps });
      const currentColumns = current.columns;
      const appendColumnSet = new Set(appendDef.columns || []);
      const appendSelect = currentColumns.map((col) => appendColumnSet.has(col) ? `a.${quoteIdent(col)} AS ${quoteIdent(col)}` : `NULL AS ${quoteIdent(col)}`).join(', ');
      baseSql = `SELECT * FROM (${current.sql}) u UNION ALL SELECT ${appendSelect} FROM (${appendDef.sql}) a`;
      params = [...params, ...(appendDef.params || [])];
      baseParams = params;
      fields = new Map(currentColumns.map((name) => [name, { expr: `q.${quoteIdent(name)}`, name }]));
      where = [];
      orderBy = '';
      distinct = false;
    }
    if (kind === 'mergeQueries') {
      const rightSource = String(step.source || step.rightSource || '').trim();
      const leftColumn = String(step.leftColumn || '').trim();
      const rightColumn = String(step.rightColumn || '').trim();
      if (!rightSource || !leftColumn || !rightColumn) throw apiError('Informe origem, coluna esquerda e coluna direita para mesclar.', 400);
      if (!fields.has(leftColumn)) throw apiError('Coluna esquerda da mesclagem não encontrada: ' + leftColumn, 400);
      const current = buildTransformSelectFromState(baseSql, fields, where, orderBy, distinct);
      const rightDef = await getTransformSourceDefinition(rightSource, { skipImportedSteps: options.skipImportedSteps });
      if (!(rightDef.columns || []).includes(rightColumn)) throw apiError('Coluna direita da mesclagem não encontrada: ' + rightColumn, 400);
      const joinType = ['INNER','RIGHT','FULL'].includes(String(step.joinType || '').toUpperCase()) ? String(step.joinType).toUpperCase() : 'LEFT';
      const selectedRight = normalizeTransformColumnList(step.columns || step.rightColumns || step.selectedRightColumns).filter((col) => col !== rightColumn && (rightDef.columns || []).includes(col));
      const currentSelect = current.columns.map((col) => `q.${quoteIdent(col)} AS ${quoteIdent(col)}`);
      const newColumns = [...current.columns];
      for (const col of selectedRight) {
        let alias = prefixedTransformColumn(rightSource, col);
        let n = 2;
        while (newColumns.includes(alias)) alias = `${prefixedTransformColumn(rightSource, col)}_${n++}`;
        currentSelect.push(`r.${quoteIdent(col)} AS ${quoteIdent(alias)}`);
        newColumns.push(alias);
      }
      baseSql = `SELECT ${currentSelect.join(', ')} FROM (${current.sql}) q ${joinType} JOIN (${rightDef.sql}) r ON q.${quoteIdent(leftColumn)} = r.${quoteIdent(rightColumn)}`;
      params = [...params, ...(rightDef.params || [])];
      baseParams = params;
      fields = new Map(newColumns.map((name) => [name, { expr: `q.${quoteIdent(name)}`, name }]));
      where = [];
      orderBy = '';
      distinct = false;
    }
  }
  const fieldList = Array.from(fields.entries());
  if (!fieldList.length) throw apiError('A transformação removeu todas as colunas.', 400);
  const selectParts = fieldList.map(([alias, def]) => `${def.expr} AS ${quoteIdent(alias)}`);
  let sql = `SELECT ${distinct ? 'DISTINCT ' : ''}${selectParts.join(', ')} FROM (${baseSql}) q`;
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  if (orderBy) sql += ` ${orderBy}`;
  const limit = Number(options.limit) === 0 ? 0 : clampLimit(options.limit, 200);
  if (limit > 0) sql += ` LIMIT ${limit}`;
  return { sql, params, columns: fieldList.map(([name]) => name) };
}



function defaultSemanticModel() {
  return { tables: [], tablePositions: {}, selectedColumns: [], relationships: [], measures: [] };
}

async function readSemanticModel() {
  const now = Date.now();
  if (semanticModelMemCache && (now - semanticModelMemCacheAt) < SEMANTIC_MODEL_MEM_CACHE_TTL_MS) {
    return semanticModelMemCache;
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(SEMANTIC_MODEL_FILE, 'utf8');
    const parsed = normalizeSemanticModel(JSON.parse(raw || '{}'));
    semanticModelMemCache = parsed;
    semanticModelMemCacheAt = now;
    return parsed;
  } catch (err) {
    const fallback = defaultSemanticModel();
    semanticModelMemCache = fallback;
    semanticModelMemCacheAt = now;
    return fallback;
  }
}

async function writeSemanticModel(model) {
  const normalized = normalizeSemanticModel(model);
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = SEMANTIC_MODEL_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, SEMANTIC_MODEL_FILE);
  semanticModelMemCache = normalized;
  semanticModelMemCacheAt = Date.now();
  return normalized;
}

function sanitizeAlias(value, fallback) {
  const raw = String(value || fallback || '').trim();
  const cleaned = raw.replace(/[^A-Za-z0-9_\u00C0-\u00FF\s-]/g, '').trim();
  return cleaned || String(fallback || 'campo');
}

function normalizeSemanticModel(input) {
  const source = input && typeof input === 'object' ? input : {};
  const tables = Array.isArray(source.tables) ? source.tables.slice(0, 200).map((item) => {
    const name = typeof item === 'string' ? item : String(item.name || '').trim();
    return name ? { name } : null;
  }).filter(Boolean) : [];
  const tablePositions = {};
  if (source.tablePositions && typeof source.tablePositions === 'object') {
    for (const [name, pos] of Object.entries(source.tablePositions)) {
      const safeName = String(name || '').trim();
      if (!safeName || !pos || typeof pos !== 'object') continue;
      const x = Number(pos.x);
      const y = Number(pos.y);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        tablePositions[safeName] = {
          x: Math.max(0, Math.min(3000, Math.round(x))),
          y: Math.max(0, Math.min(3000, Math.round(y)))
        };
      }
    }
  }
  const selectedColumns = Array.isArray(source.selectedColumns) ? source.selectedColumns.slice(0, 500).map((item) => ({
    table: String(item.table || '').trim(),
    column: String(item.column || '').trim(),
    alias: sanitizeAlias(item.alias, item.column || 'campo')
  })).filter((item) => item.table && item.column) : [];
  const relationships = Array.isArray(source.relationships) ? source.relationships.slice(0, 1000).map((item) => ({
    fromTable: (typeof normalizeTableName === 'function' ? normalizeTableName : function(s) { return String(s || '').trim(); })(item.fromTable),
    fromColumn: String(item.fromColumn || '').trim(),
    toTable: (typeof normalizeTableName === 'function' ? normalizeTableName : function(s) { return String(s || '').trim(); })(item.toTable),
    toColumn: String(item.toColumn || '').trim(),
    joinType: String(item.joinType || 'LEFT').toUpperCase() === 'INNER' ? 'INNER' : 'LEFT',
    cardinality: ['many-to-one', 'one-to-one', 'one-to-many', 'many-to-many'].includes(String(item.cardinality || '')) ? String(item.cardinality) : 'many-to-one',
    filterDirection: ['single', 'both'].includes(String(item.filterDirection || '')) ? String(item.filterDirection) : 'single',
    active: item.active === false ? false : true,
    confidence: ['high', 'medium', 'low'].includes(String(item.confidence || '')) ? String(item.confidence) : '',
    source: String(item.source || '').trim()
  })).filter((item) => item.fromTable && item.fromColumn && item.toTable && item.toColumn) : [];
  const measures = Array.isArray(source.measures) ? source.measures.slice(0, 1000).map((item) => {
    const formula = String(item.formula || item.expression || item.dax || '').trim();
    const existingTable = String(item.table || '').trim();
    const autoTable = existingTable || (formula ? (tablesUsedInDaxExpression(formula)[0] || '') : '');
    return {
    table: autoTable,
    name: sanitizeAlias(item.name || item.displayName, 'medida'),
    displayName: sanitizeAlias(item.displayName || item.name, item.name || 'medida'),
    formula,
    format: String(item.format || '').trim(),
    decimals: item.decimals != null ? Number(item.decimals) : 2,
    dataCategory: String(item.dataCategory || '').trim(),
    source: String(item.source || source.source || '').trim(),
    status: String(item.status || '').trim(),
    diagnosticStatus: String(item.diagnosticStatus || '').trim(),
    lastDiagnostic: String(item.lastDiagnostic || '').trim(),
    lastValidatedAt: String(item.lastValidatedAt || '').trim(),
    dependencies: Array.isArray(item.dependencies) ? item.dependencies.slice(0, 100).map(String) : [],
    unsupportedFunctions: Array.isArray(item.unsupportedFunctions) ? item.unsupportedFunctions.slice(0, 100).map(String) : []
    };
  }).filter((item) => item.name) : [];
  const tableDetails = source.tableDetails && typeof source.tableDetails === 'object' ? source.tableDetails : {};
  const meta = {
    source: String(source.source || '').trim(),
    generatedAt: String(source.generatedAt || '').trim(),
    updatedAt: String(source.updatedAt || '').trim(),
    importNotes: Array.isArray(source.importNotes) ? source.importNotes.slice(0, 50).map(String) : []
  };
  return { tables, tableDetails, tablePositions, selectedColumns, relationships, measures, ...meta };
}

async function removeTableFromSemanticModel(tableName) {
  const cleanName = String(tableName || '').trim();
  const key = cleanName.toLowerCase();
  if (!key) return readSemanticModel();
  const model = await readSemanticModel();
  const matches = function(value) { return String(value || '').trim().toLowerCase() === key; };
  const previous = JSON.stringify(model);
  model.tables = (model.tables || []).filter(function(item) {
    return !matches(typeof item === 'string' ? item : item && item.name);
  });
  model.selectedColumns = (model.selectedColumns || []).filter(function(item) { return !matches(item && item.table); });
  model.relationships = (model.relationships || []).filter(function(item) {
    return !matches(item && item.fromTable) && !matches(item && item.toTable);
  });
  model.measures = (model.measures || []).filter(function(item) { return !matches(item && item.table); });
  ['tablePositions', 'tableDetails'].forEach(function(property) {
    if (!model[property] || typeof model[property] !== 'object') return;
    Object.keys(model[property]).forEach(function(name) {
      if (matches(name)) delete model[property][name];
    });
  });
  return JSON.stringify(model) === previous ? model : writeSemanticModel(model);
}

async function validateModelResources(model) {
  const warnings = [];

  // Build resource names from PostgreSQL cache + imported tables + transforms
  const resourceNames = new Set();
  try {
    if (postgresCacheAvailable()) {
      const pgResources = await listPgCacheStatus();
      pgResources.forEach(function(item) { resourceNames.add(item.sourceTable); });
    }
  } catch (e) { /* ignore */ }
  try {
    const imported = await readImportedTables();
    imported.forEach(function(item) { resourceNames.add(item.name); });
    imported.forEach(function(item) { if (item.sourceTable) resourceNames.add(item.sourceTable); });
  } catch (e) { /* ignore */ }
  try {
    const transforms = await readTransforms();
    transforms.forEach(function(item) { if (item.name) resourceNames.add(item.name); });
  } catch (e) { /* ignore */ }

  async function loadPgColumns(table) {
    if (!postgresCacheAvailable()) return null;
    try {
      // Tabelas calculadas DAX e tabelas modeladas existem como views. Usar
      // apenas o metadado do cache fisico fazia Empresa/Data aparecerem como
      // varchar ou sem colunas ao salvar o modelo.
      const pgMeta = await getPgEffectiveMeta(table);
      if (pgMeta && Array.isArray(pgMeta.columns) && pgMeta.columns.length > 0) {
        return pgMeta.columns.map(function(c) { return c.name || ''; });
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  const columnsCache = new Map();
  async function assertColumn(table, column) {
    if (!resourceNames.has(table)) {
      // Try PostgreSQL cache for column info
      const pgCols = await loadPgColumns(table);
      if (pgCols) {
        if (!pgCols.some(function(c) { return String(c || '').toLowerCase() === String(column || '').toLowerCase(); })) {
          return 'Coluna nao encontrada: ' + table + '[' + column + ']';
        }
        return null;
      }
      // Table not found anywhere â€” just warn but do NOT remove (no MySQL dependency)
      warnings.push('Tabela nao encontrada no cache PostgreSQL: ' + table);
      return null;
    }
    if (!columnsCache.has(table)) {
      const pgCols = await loadPgColumns(table);
      if (pgCols) {
        columnsCache.set(table, pgCols);
      } else {
        // Table is in resourceNames but no columns cached â€” warn but do not remove
        warnings.push('Colunas nao encontradas no cache PostgreSQL para: ' + table);
        return null;
      }
    }
    const columns = columnsCache.get(table) || [];
    const columnLower = String(column || '').toLowerCase();
    if (!columns.length || !columns.some(function(c) { return String(c || '').toLowerCase() === columnLower; })) {
      return null; // Skip validation instead of removing
    }
    return null;
  }

  // Clean selectedColumns (warn only, never remove)
  if (Array.isArray(model.selectedColumns)) {
    for (const item of model.selectedColumns) {
      const err = await assertColumn(item.table, item.column);
      if (err) {
        warnings.push('Coluna selecionada: ' + item.table + '[' + item.column + '] - ' + err);
      }
    }
  }

  // Clean relationships (warn only, never remove)
  if (Array.isArray(model.relationships)) {
    for (const rel of model.relationships) {
      const errFrom = await assertColumn(rel.fromTable, rel.fromColumn);
      const errTo = await assertColumn(rel.toTable, rel.toColumn);
      if (errFrom || errTo) {
        warnings.push('Relacionamento: ' + rel.fromTable + '[' + rel.fromColumn + '] -> ' + rel.toTable + '[' + rel.toColumn + '] - ' + (errFrom || errTo));
      }
    }
  }

  // Validate measures (warn only, never remove)
  if (Array.isArray(model.measures)) {
    for (const measure of model.measures) {
      if (!String(measure.formula || '').trim()) continue;
      const cols = columnsUsedInDaxExpression(measure.formula);
      const tabs = tablesUsedByMeasureWithDependencies(measure, model);
      for (const item of cols) {
        const err = await assertColumn(item.table, item.column);
        if (err) {
          warnings.push('Medida ' + measure.name + ': ' + err);
        }
      }
      for (const table of tabs) {
        if (!resourceNames.has(table)) {
          if (postgresCacheAvailable()) {
            const pgCols = await loadPgColumns(table);
            if (pgCols) continue;
          }
          warnings.push('Medida ' + measure.name + ': tabela nao encontrada no cache - ' + table);
        }
      }
      try {
        compileDaxExpression(measure.formula, new Map(tabs.map(function(t, idx) { return [t, 't' + idx]; })), { model, currentMeasure: measure.name });
      } catch (err) {
        measure.diagnosticStatus = 'pendente';
        measure.lastDiagnostic = err.message || 'Formula DAX ainda nao suportada.';
      }
    }
  }

  return warnings;
}

function parseAtomicDaxMeasure(text) {
  const source = String(text || '').trim();
  let m = source.match(/^(SUM|AVERAGE|AVG|MIN|MAX|COUNT|DISTINCTCOUNT)\s*\(\s*(?:'([^']+)'|([^\[]+?))\s*\[\s*([^\]]+)\s*\]\s*\)$/i);
  if (m) {
    const fn = m[1].toUpperCase() === 'AVG' ? 'AVERAGE' : m[1].toUpperCase();
    return { kind: 'column', fn, table: String(m[2] || m[3] || '').trim(), column: m[4].trim() };
  }
  m = source.match(/^COUNTROWS\s*\(\s*(?:'([^']+)'|([^\)]+?))\s*\)$/i);
  if (m) return { kind: 'table', fn: 'COUNTROWS', table: String(m[1] || m[2] || '').trim() };
  return null;
}

function parseDaxMeasure(formula) {
  const parsed = parseAtomicDaxMeasure(formula);
  if (parsed) return parsed;
  throw apiError('Medida invalida. Use agregacoes como SUM(tabela[coluna]), COUNTROWS(tabela) ou expressoes simples com +, -, *, / e DIVIDE().', 400);
}

function daxAliasFor(aliases, tableName) {
  const raw = String(tableName || '').trim();
  const normalized = normalizeTableName(raw);
  const key = normalizeTableKey(raw);
  const direct = aliases.get(raw)
    || aliases.get(normalized)
    || aliases.get(key)
    || aliases.get(String(normalized || '').toLowerCase());
  if (direct) return direct;
  for (const [candidate, alias] of aliases.entries()) {
    if (normalizeTableKey(candidate) === key) return alias;
  }
  return null;
}

function sqlAggForMeasure(parsed, aliases, context = {}) {
  const scalarTables = context && context.scalarSubqueryTables;
  if (scalarTables instanceof Set && scalarTables.has(normalizeTableKey(parsed.table))) {
    const scalarAlias = '__biwa_scalar_' + crypto.createHash('sha1').update(normalizeTableKey(parsed.table)).digest('hex').slice(0, 8);
    const tableSql = quoteIdent(normalizeTableName(parsed.table));
    if (parsed.fn === 'COUNTROWS') return compiledDaxGeneratedSqlToken(`(SELECT COUNT(*) FROM ${tableSql} ${scalarAlias})`, context);
    const scalarExpr = `${scalarAlias}.${quoteIdent(parsed.column)}`;
    const functions = { SUM: 'SUM', AVERAGE: 'AVG', MIN: 'MIN', MAX: 'MAX', COUNT: 'COUNT', DISTINCTCOUNT: 'COUNT' };
    const fn = functions[parsed.fn];
    if (!fn) throw apiError('Agregacao nao suportada: ' + parsed.fn, 400);
    const distinct = parsed.fn === 'DISTINCTCOUNT' ? 'DISTINCT ' : '';
    return compiledDaxGeneratedSqlToken(`(SELECT ${fn}(${distinct}${scalarExpr}) FROM ${tableSql} ${scalarAlias})`, context);
  }
  const alias = daxAliasFor(aliases, parsed.table);
  if (!alias) throw apiError('A tabela da medida precisa estar no modelo ou em relacionamento: ' + parsed.table, 400);
  if (parsed.fn === 'COUNTROWS') return `COUNT(*)`;
  const expr = `${alias}.${quoteIdent(parsed.column)}`;
  if (parsed.fn === 'SUM') return `SUM(${expr})`;
  if (parsed.fn === 'AVERAGE') return `AVG(${expr})`;
  if (parsed.fn === 'MIN') return `MIN(${expr})`;
  if (parsed.fn === 'MAX') return `MAX(${expr})`;
  if (parsed.fn === 'COUNT') return `COUNT(${expr})`;
  if (parsed.fn === 'DISTINCTCOUNT') return `COUNT(DISTINCT ${expr})`;
  throw apiError('Agregacao nao suportada: ' + parsed.fn, 400);
}

function splitTopLevelArgs(text) {
  const args = [];
  let depth = 0;
  let curlyDepth = 0;
  let bracketDepth = 0;
  let quote = '';
  let current = '';
  const source = String(text || '');
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index];
    if (quote) {
      current += ch;
      if (ch === quote) {
        if (source[index + 1] === quote) {
          current += source[index + 1];
          index += 1;
        } else {
          quote = '';
        }
      }
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === '[') bracketDepth += 1;
    if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    if (!bracketDepth && ch === '(') depth += 1;
    if (!bracketDepth && ch === ')') depth -= 1;
    if (!bracketDepth && ch === '{') curlyDepth += 1;
    if (!bracketDepth && ch === '}') curlyDepth -= 1;
    if (depth === 0 && curlyDepth === 0 && bracketDepth === 0 && ch === ',') {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

function stripOuterParentheses(text) {
  let value = String(text || '').trim();
  let changed = true;
  while (changed && value.startsWith('(') && value.endsWith(')')) {
    changed = false;
    let depth = 0;
    let quote = '';
    let wraps = true;
    for (let i = 0; i < value.length; i += 1) {
      const ch = value[i];
      if (quote) {
        if (ch === quote) {
          if (value[i + 1] === quote) { i += 1; continue; }
          quote = '';
        }
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      if (depth === 0 && i < value.length - 1) { wraps = false; break; }
    }
    if (wraps) {
      value = value.slice(1, -1).trim();
      changed = true;
    }
  }
  return value;
}

function daxIdentifierChar(ch) {
  return Boolean(ch && /[A-Za-z0-9_\u00C0-\u00FF]/.test(ch));
}

function findNextTopLevelDaxKeyword(text, start, keywords) {
  const source = String(text || '');
  const wanted = new Set((keywords || []).map(function(keyword) { return String(keyword || '').toUpperCase(); }));
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote = '';
  for (let index = Math.max(0, Number(start) || 0); index < source.length; index += 1) {
    const ch = source[index];
    if (quote) {
      if (ch === quote) {
        if (source[index + 1] === quote) { index += 1; continue; }
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '[') { bracketDepth += 1; continue; }
    if (ch === ']') { bracketDepth = Math.max(0, bracketDepth - 1); continue; }
    if (bracketDepth) continue;
    if (ch === '(') { parenDepth += 1; continue; }
    if (ch === ')') { parenDepth = Math.max(0, parenDepth - 1); continue; }
    if (ch === '{') { braceDepth += 1; continue; }
    if (ch === '}') { braceDepth = Math.max(0, braceDepth - 1); continue; }
    if (parenDepth || braceDepth || !/[A-Za-z_\u00C0-\u00FF]/.test(ch)) continue;
    let end = index + 1;
    while (end < source.length && daxIdentifierChar(source[end])) end += 1;
    const token = source.slice(index, end).toUpperCase();
    if (wanted.has(token) && !daxIdentifierChar(source[index - 1]) && !daxIdentifierChar(source[end])) {
      return { index, end, keyword: token };
    }
    index = end - 1;
  }
  return null;
}

function tokenizeDaxSemantic(text) {
  const source = String(text || '');
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const start = index;
    const ch = source[index];
    if (/\s/.test(ch)) { index += 1; continue; }
    if (ch === '"') {
      index += 1;
      let value = '';
      let closed = false;
      while (index < source.length) {
        if (source[index] === '"') {
          if (source[index + 1] === '"') { value += '"'; index += 2; continue; }
          index += 1;
          closed = true;
          break;
        }
        value += source[index++];
      }
      if (!closed) throw apiError('Texto DAX com aspas duplas incompletas.', 400);
      tokens.push({ type: 'string', value, raw: source.slice(start, index), start, end: index });
      continue;
    }
    if (ch === "'") {
      index += 1;
      let value = '';
      let closed = false;
      while (index < source.length) {
        if (source[index] === "'") {
          if (source[index + 1] === "'") { value += "'"; index += 2; continue; }
          index += 1;
          closed = true;
          break;
        }
        value += source[index++];
      }
      if (!closed) throw apiError('Identificador DAX com aspas simples incompletas.', 400);
      tokens.push({ type: 'quotedIdentifier', value, raw: source.slice(start, index), start, end: index });
      continue;
    }
    if (ch === '[') {
      index += 1;
      let value = '';
      while (index < source.length && source[index] !== ']') value += source[index++];
      if (source[index] !== ']') throw apiError('Referencia DAX com colchete incompleto.', 400);
      index += 1;
      tokens.push({ type: 'bracketIdentifier', value: value.trim(), raw: source.slice(start, index), start, end: index });
      continue;
    }
    if (/[A-Za-z_\u00C0-\u00FF]/.test(ch)) {
      index += 1;
      while (index < source.length && daxIdentifierChar(source[index])) index += 1;
      const raw = source.slice(start, index);
      const upper = raw.toUpperCase();
      tokens.push({ type: ['VAR', 'RETURN', 'IN'].includes(upper) ? 'keyword' : 'identifier', value: raw, upper, raw, start, end: index });
      continue;
    }
    if (/\d/.test(ch) || (ch === '.' && /\d/.test(source[index + 1] || ''))) {
      index += 1;
      while (index < source.length && /[0-9.,eE+-]/.test(source[index])) index += 1;
      const raw = source.slice(start, index);
      tokens.push({ type: 'number', value: raw, raw, start, end: index });
      continue;
    }
    const pair = source.slice(index, index + 2);
    if (['>=', '<=', '<>', '&&', '||'].includes(pair)) index += 2;
    else index += 1;
    tokens.push({ type: 'symbol', value: source.slice(start, index), raw: source.slice(start, index), start, end: index });
  }
  return tokens;
}

function parseDaxScalarAst(expression) {
  const text = String(expression || '').trim();
  const tokens = tokenizeDaxSemantic(text);
  if (tokens.length === 1 && tokens[0].type === 'string') return { type: 'StringLiteral', value: tokens[0].value, text };
  if (/^-?\d+(?:[.,]\d+)?(?:[eE][+-]?\d+)?$/.test(text)) return { type: 'NumericLiteral', value: Number(text.replace(',', '.')), text };
  if (/^(?:TRUE|FALSE)(?:\s*\(\s*\))?$/i.test(text)) return { type: 'BooleanLiteral', value: /^TRUE/i.test(text), text };
  if (/^BLANK\s*\(\s*\)$/i.test(text)) return { type: 'BlankLiteral', value: null, text };
  return { type: 'ScalarExpression', text };
}

function parseDaxTableConstructorExpression(expression) {
  const source = stripOuterParentheses(String(expression || '').trim());
  if (!source.startsWith('{') || !source.endsWith('}')) return null;
  const tokens = tokenizeDaxSemantic(source);
  if (!tokens.length || tokens[0].value !== '{' || tokens[tokens.length - 1].value !== '}') return null;
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.value === '{') depth += 1;
    else if (token.value === '}') depth -= 1;
    if (depth === 0 && index < tokens.length - 1) return null;
    if (depth < 0) throw apiError('TableConstructor DAX com chaves invalidas.', 400);
  }
  if (depth !== 0) throw apiError('TableConstructor DAX com chaves incompletas.', 400);
  const inner = source.slice(1, -1).trim();
  if (!inner) return { type: 'TableConstructor', columns: 1, rows: [], text: source };
  const items = splitTopLevelArgs(inner);
  const rows = items.map((item) => {
    const raw = String(item || '').trim();
    const tuple = raw.startsWith('(') && raw.endsWith(')') ? splitTopLevelArgs(stripOuterParentheses(raw)) : [raw];
    return { type: 'TableRow', values: tuple.map(parseDaxScalarAst), text: raw };
  });
  const columns = rows.length ? rows[0].values.length : 1;
  if (rows.some((row) => row.values.length !== columns)) throw apiError('TableConstructor DAX possui linhas com quantidades diferentes de colunas.', 400);
  return { type: 'TableConstructor', columns, rows, text: source };
}

function parseDaxTopLevelFunctionCall(expression, expectedName) {
  const source = stripOuterParentheses(String(expression || '').trim());
  const tokens = tokenizeDaxSemantic(source);
  if (tokens.length < 3 || !['identifier', 'keyword'].includes(tokens[0].type) || tokens[0].value.toUpperCase() !== String(expectedName || '').toUpperCase()) return null;
  if (tokens[1].value !== '(' || tokens[tokens.length - 1].value !== ')') return null;
  let depth = 0;
  for (let index = 1; index < tokens.length; index += 1) {
    if (tokens[index].value === '(') depth += 1;
    else if (tokens[index].value === ')') depth -= 1;
    if (depth === 0 && index < tokens.length - 1) return null;
  }
  if (depth !== 0) throw apiError(String(expectedName || 'Funcao') + ' com parenteses incompletos.', 400);
  return { type: 'FunctionCall', name: String(expectedName || '').toUpperCase(), args: splitTopLevelArgs(source.slice(tokens[1].end, tokens[tokens.length - 1].start)), text: source };
}

function parseDaxVariableValueAst(expression) {
  const text = String(expression || '').trim();
  const tableConstructor = parseDaxTableConstructorExpression(text);
  if (tableConstructor) return tableConstructor;
  for (const name of ['VALUES', 'DISTINCT', 'FILTER', 'ALL', 'SELECTCOLUMNS', 'SUMMARIZE', 'UNION']) {
    const call = parseDaxTopLevelFunctionCall(text, name);
    if (call) return { type: 'TableExpression', tableFunction: name, expression: call, text };
  }
  return parseDaxScalarAst(text);
}

function parseDaxVariableProgram(formula) {
  const source = String(formula || '').trim();
  const tokens = tokenizeDaxSemantic(source);
  if (!tokens.length || tokens[0].type !== 'keyword' || tokens[0].upper !== 'VAR') return null;
  const declarations = [];
  let cursor = 0;
  while (cursor < tokens.length) {
    const keyword = tokens[cursor];
    if (keyword.type !== 'keyword' || keyword.upper !== 'VAR') throw apiError('Declaracao VAR invalida na formula DAX.', 400);
    const nameToken = tokens[cursor + 1];
    const equalsToken = tokens[cursor + 2];
    if (!nameToken || nameToken.type !== 'identifier' || !equalsToken || equalsToken.value !== '=') throw apiError('VAR precisa de nome e expressao.', 400);
    let parenDepth = 0;
    let braceDepth = 0;
    let boundary = -1;
    for (let index = cursor + 3; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (!parenDepth && !braceDepth && token.type === 'keyword' && (token.upper === 'VAR' || token.upper === 'RETURN')) { boundary = index; break; }
      if (token.value === '(') parenDepth += 1;
      else if (token.value === ')') parenDepth = Math.max(0, parenDepth - 1);
      else if (token.value === '{') braceDepth += 1;
      else if (token.value === '}') braceDepth = Math.max(0, braceDepth - 1);
    }
    if (boundary < 0) throw apiError('Formula DAX com VAR precisa de RETURN.', 400);
    const expression = source.slice(equalsToken.end, tokens[boundary].start).trim();
    if (!expression) throw apiError('VAR ' + nameToken.value + ' precisa de uma expressao.', 400);
    const value = parseDaxVariableValueAst(expression);
    declarations.push({
      type: 'VariableDeclaration',
      name: nameToken.value,
      valueType: ['TableConstructor', 'TableExpression'].includes(value.type) ? 'table' : 'scalar',
      value
    });
    if (tokens[boundary].upper === 'RETURN') {
      const returned = source.slice(tokens[boundary].end).trim();
      if (!returned) throw apiError('RETURN precisa de uma expressao.', 400);
      return {
        type: 'DaxProgram',
        declarations,
        returnExpression: { type: 'ReturnExpression', expression: { type: 'Expression', text: returned } },
        text: source
      };
    }
    cursor = boundary;
  }
  throw apiError('Formula DAX com VAR precisa de RETURN.', 400);
}

function daxVariableKey(name) {
  return String(name || '').trim().toLocaleLowerCase('pt-BR');
}

function bindDaxVariableProgram(program, parentScope) {
  const scope = new Map(parentScope instanceof Map ? parentScope : []);
  const localKeys = new Set();
  for (const declaration of Array.isArray(program && program.declarations) ? program.declarations : []) {
    const key = daxVariableKey(declaration.name);
    if (localKeys.has(key)) throw apiError('Variavel DAX declarada mais de uma vez no mesmo escopo: ' + declaration.name, 400);
    localKeys.add(key);
    const binding = { ...declaration, lexicalScope: new Map(scope) };
    scope.set(key, binding);
  }
  return scope;
}

function resolveDaxVariableBinding(context, name) {
  const scope = context && context.daxVariables;
  return scope instanceof Map ? scope.get(daxVariableKey(name)) || null : null;
}

function compileDaxVariableScalar(binding, aliases, context = {}) {
  if (!binding) throw apiError('Variavel DAX nao encontrada no escopo.', 400);
  if (binding.valueType === 'table') throw apiError('Variavel tabular DAX usada onde era esperado um valor escalar: ' + binding.name, 400);
  const stack = Array.isArray(context.daxVariableStack) ? context.daxVariableStack.slice() : [];
  const key = daxVariableKey(binding.name);
  if (stack.includes(key)) throw apiError('Dependencia circular entre variaveis DAX: ' + [...stack, key].join(' -> '), 400);
  return compileDaxExpression(binding.value.text, aliases, {
    ...context,
    daxVariables: binding.lexicalScope,
    daxVariableStack: [...stack, key]
  });
}

function compileDaxScalarVariableReferences(expression, aliases, context = {}) {
  const source = String(expression || '');
  if (!(context.daxVariables instanceof Map) || !context.daxVariables.size) return source;
  const tokens = tokenizeDaxSemantic(source);
  const replacements = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== 'identifier') continue;
    const binding = resolveDaxVariableBinding(context, token.value);
    if (!binding || binding.valueType === 'table') continue;
    const next = tokens[index + 1];
    if (next && (next.value === '(' || next.type === 'bracketIdentifier')) continue;
    replacements.push({ start: token.start, end: token.end, value: '(' + compileDaxVariableScalar(binding, aliases, context) + ')' });
  }
  let result = source;
  for (let index = replacements.length - 1; index >= 0; index -= 1) {
    const item = replacements[index];
    result = result.slice(0, item.start) + item.value + result.slice(item.end);
  }
  return result;
}

function resolveDaxTableExpression(expression, aliases, context = {}) {
  const source = stripOuterParentheses(String(expression || '').trim());
  const constructor = parseDaxTableConstructorExpression(source);
  if (constructor) return { kind: 'constructor', ast: constructor, scope: context.daxVariables };
  const tokens = tokenizeDaxSemantic(source);
  if (tokens.length === 1 && tokens[0].type === 'identifier') {
    const binding = resolveDaxVariableBinding(context, tokens[0].value);
    if (binding) {
      if (binding.valueType !== 'table') throw apiError('IN/COUNTROWS esperava uma variavel tabular, mas ' + binding.name + ' e escalar.', 400);
      const stack = Array.isArray(context.daxVariableStack) ? context.daxVariableStack.slice() : [];
      const key = daxVariableKey(binding.name);
      if (stack.includes(key)) throw apiError('Dependencia circular entre variaveis DAX: ' + [...stack, key].join(' -> '), 400);
      return resolveDaxTableExpression(binding.value.text, aliases, {
        ...context,
        daxVariables: binding.lexicalScope,
        daxVariableStack: [...stack, key]
      });
    }
  }
  for (const functionName of ['VALUES', 'DISTINCT']) {
    const call = parseDaxTopLevelFunctionCall(source, functionName);
    if (!call) continue;
    if (call.args.length !== 1) throw apiError(functionName + ' precisa de uma coluna.', 400);
    const ref = parseDaxColumnReference(call.args[0]);
    if (!ref) throw apiError(functionName + ' precisa de uma coluna.', 400);
    const alias = daxAliasFor(aliases, ref.table);
    if (!alias) throw apiError('A tabela do ' + functionName + ' precisa estar no modelo ou em relacionamento: ' + ref.table, 400);
    return { kind: 'values', functionName, ref, alias };
  }
  // Preserva tambem a forma historica `IN (valor1, valor2)`. O helper acima
  // remove parenteses externos, portanto a lista e reconhecida pela virgula de
  // nivel superior sem confundir argumentos internos de funcoes DAX.
  const listItems = splitTopLevelArgs(source);
  if (listItems.length > 1) {
    return {
      kind: 'constructor',
      ast: parseDaxTableConstructorExpression('{' + source + '}'),
      scope: context.daxVariables
    };
  }
  return null;
}

function daxScalarAstToSql(node, aliases, context = {}) {
  if (!node) throw apiError('Valor ausente no TableConstructor DAX.', 400);
  if (node.type === 'StringLiteral') return sqlLiteral(node.value);
  if (node.type === 'NumericLiteral') return String(node.value);
  if (node.type === 'BooleanLiteral') return node.value ? '1' : '0';
  if (node.type === 'BlankLiteral') return 'NULL';
  return compileDaxExpression(node.text, aliases, context);
}

function compileDaxTableConstructorSet(descriptor, aliases, context = {}) {
  const ast = descriptor && descriptor.ast;
  if (!ast || ast.type !== 'TableConstructor') throw apiError('Expressao tabular DAX ainda nao suportada neste contexto.', 400);
  if (ast.columns !== 1) throw apiError('IN requer um TableConstructor DAX de uma coluna.', 400);
  return ast.rows.map((row) => daxScalarAstToSql(row.values[0], aliases, { ...context, daxVariables: descriptor.scope instanceof Map ? descriptor.scope : context.daxVariables }));
}

function compileDaxCountRowsTableExpression(expression, aliases, context = {}) {
  const descriptor = resolveDaxTableExpression(expression, aliases, context);
  if (!descriptor) return null;
  if (descriptor.kind === 'constructor') return String(descriptor.ast.rows.length);
  if (descriptor.kind === 'values') return 'COUNT(DISTINCT ' + descriptor.alias + '.' + quoteIdent(descriptor.ref.column) + ')';
  throw apiError('COUNTROWS ainda nao suporta esta expressao tabular DAX.', 400);
}

function findTopLevelDaxInOperator(expression) {
  const source = String(expression || '');
  const tokens = tokenizeDaxSemantic(source);
  let parenDepth = 0;
  let braceDepth = 0;
  for (const token of tokens) {
    if (!parenDepth && !braceDepth && token.type === 'keyword' && token.upper === 'IN') {
      const left = source.slice(0, token.start).trim();
      const right = source.slice(token.end).trim();
      if (left && right) return { left, right };
    }
    if (token.value === '(') parenDepth += 1;
    else if (token.value === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (token.value === '{') braceDepth += 1;
    else if (token.value === '}') braceDepth = Math.max(0, braceDepth - 1);
  }
  return null;
}

function replaceDaxVariableReference(text, name, replacement) {
  const source = String(text || '');
  const variable = String(name || '').trim();
  if (!variable) return source;
  const wanted = variable.toLowerCase();
  let result = '';
  let quote = '';
  let bracketDepth = 0;
  for (let index = 0; index < source.length;) {
    const ch = source[index];
    if (quote) {
      result += ch;
      if (ch === quote) {
        if (source[index + 1] === quote) { result += source[index + 1]; index += 2; continue; }
        quote = '';
      }
      index += 1;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; result += ch; index += 1; continue; }
    if (ch === '[') { bracketDepth += 1; result += ch; index += 1; continue; }
    if (ch === ']') { bracketDepth = Math.max(0, bracketDepth - 1); result += ch; index += 1; continue; }
    if (!bracketDepth && /[A-Za-z_\u00C0-\u00FF]/.test(ch)) {
      let end = index + 1;
      while (end < source.length && daxIdentifierChar(source[end])) end += 1;
      const token = source.slice(index, end);
      result += token.toLowerCase() === wanted ? '(' + replacement + ')' : token;
      index = end;
      continue;
    }
    result += ch;
    index += 1;
  }
  return result;
}

function expandDaxVariables(formula) {
  const source = String(formula || '').trim();
  if (!/^VAR\b/i.test(source)) return source;
  const variables = [];
  let cursor = 0;
  while (cursor < source.length) {
    const keyword = findNextTopLevelDaxKeyword(source, cursor, ['VAR', 'RETURN']);
    if (!keyword) throw apiError('Formula DAX com VAR precisa de RETURN.', 400);
    if (keyword.keyword === 'RETURN') {
      let returned = source.slice(keyword.end).trim();
      if (!returned) throw apiError('RETURN precisa de uma expressao.', 400);
      for (const item of variables) returned = replaceDaxVariableReference(returned, item.name, item.expression);
      return returned;
    }
    if (keyword.index !== cursor && source.slice(cursor, keyword.index).trim()) {
      throw apiError('Declaracao VAR invalida na formula DAX.', 400);
    }
    const declaration = source.slice(keyword.end);
    const nameMatch = declaration.match(/^\s*([A-Za-z_\u00C0-\u00FF][A-Za-z0-9_\u00C0-\u00FF]*)\s*=\s*/);
    if (!nameMatch) throw apiError('VAR precisa de nome e expressao.', 400);
    const expressionStart = keyword.end + nameMatch[0].length;
    const nextKeyword = findNextTopLevelDaxKeyword(source, expressionStart, ['VAR', 'RETURN']);
    if (!nextKeyword) throw apiError('Formula DAX com VAR precisa de RETURN.', 400);
    let expression = source.slice(expressionStart, nextKeyword.index).trim();
    if (!expression) throw apiError('VAR ' + nameMatch[1] + ' precisa de uma expressao.', 400);
    for (const item of variables) expression = replaceDaxVariableReference(expression, item.name, item.expression);
    variables.push({ name: nameMatch[1], expression });
    cursor = nextKeyword.index;
  }
  throw apiError('Formula DAX com VAR precisa de RETURN.', 400);
}

function parseDaxColumnReference(text) {
  const source = String(text || '').trim();
  const m = source.match(/^(?:'([^']+)'|([^\[]+?))\s*\[\s*([^\]]+)\s*\]$/);
  if (!m) return null;
  return { table: String(m[1] || m[2] || '').trim(), column: String(m[3] || '').trim() };
}

function daxFunctionArgumentLists(expression, functionName) {
  const source = String(expression || '');
  const nameRe = new RegExp('\\b' + functionName + '\\s*\\(', 'ig');
  const lists = [];
  let match;
  while ((match = nameRe.exec(source))) {
    let position = match.index + match[0].length;
    let depth = 1;
    let quote = '';
    while (position < source.length && depth > 0) {
      const ch = source[position];
      if (quote) {
        if (ch === quote) {
          if (source[position + 1] === quote) { position += 2; continue; }
          quote = '';
        }
        position += 1;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      position += 1;
    }
    if (depth === 0) lists.push(splitTopLevelArgs(source.slice(match.index + match[0].length, position - 1)));
    nameRe.lastIndex = Math.max(nameRe.lastIndex, position);
  }
  return lists;
}

function daxSelectedValueReference(expression) {
  const source = stripOuterParentheses(expression);
  const match = source.match(/^SELECTEDVALUE\s*\(([\s\S]+)\)$/i);
  if (!match) return null;
  const args = splitTopLevelArgs(match[1]);
  const ref = parseDaxColumnReference(args[0] || '');
  if (!ref) return null;
  return { ...ref, alternate: args[1] || '' };
}

function daxFilteredLookupSpecs(formula) {
  let expanded;
  try { expanded = expandDaxVariables(formula); } catch (err) { return []; }
  const specs = [];
  for (const args of daxFunctionArgumentLists(expanded, 'CALCULATE')) {
    const selected = daxSelectedValueReference(args[0] || '');
    if (!selected) continue;
    for (const rawFilter of args.slice(1)) {
      const filterSource = stripOuterParentheses(rawFilter);
      const filterMatch = filterSource.match(/^FILTER\s*\(([\s\S]+)\)$/i);
      if (!filterMatch) continue;
      const filterArgs = splitTopLevelArgs(filterMatch[1]);
      const filterTable = String(filterArgs[0] || '').replace(/^'|'$/g, '').trim();
      if (normalizeTableKey(filterTable) !== normalizeTableKey(selected.table) || filterArgs.length < 2) continue;
      const condition = stripOuterParentheses(filterArgs.slice(1).join(', '));
      const equality = condition.match(/^([\s\S]+?)\s*=\s*([\s\S]+)$/);
      if (!equality) continue;
      const leftRef = parseDaxColumnReference(stripOuterParentheses(equality[1]));
      const rightRef = parseDaxColumnReference(stripOuterParentheses(equality[2]));
      const leftSelected = daxSelectedValueReference(equality[1]);
      const rightSelected = daxSelectedValueReference(equality[2]);
      let lookupKey = null;
      let sourceRef = null;
      if (leftRef && normalizeTableKey(leftRef.table) === normalizeTableKey(selected.table)) {
        lookupKey = leftRef;
        sourceRef = rightSelected || rightRef;
      } else if (rightRef && normalizeTableKey(rightRef.table) === normalizeTableKey(selected.table)) {
        lookupKey = rightRef;
        sourceRef = leftSelected || leftRef;
      }
      if (!lookupKey || !sourceRef || normalizeTableKey(sourceRef.table) === normalizeTableKey(selected.table)) continue;
      specs.push({
        table: selected.table,
        valueColumn: selected.column,
        alternate: selected.alternate,
        keyColumn: lookupKey.column,
        sourceTable: sourceRef.table,
        sourceColumn: sourceRef.column
      });
    }
  }
  return specs;
}

function daxLiteralToSql(value) {
  const raw = String(value || '').trim();
  if (/^BLANK\s*\(\s*\)$/i.test(raw)) return 'NULL';
  if (/^TRUE\s*\(\s*\)$/i.test(raw) || /^TRUE$/i.test(raw)) return '1';
  if (/^FALSE\s*\(\s*\)$/i.test(raw) || /^FALSE$/i.test(raw)) return '0';
  if (/^-?\d+(?:[\.,]\d+)?$/.test(raw)) return raw.replace(',', '.');
  const quoted = raw.match(/^"([\s\S]*)"$/) || raw.match(/^'([\s\S]*)'$/);
  if (quoted) return sqlLiteral(quoted[1]);
  const col = parseDaxColumnReference(raw);
  if (col) return null;
  throw apiError('Literal DAX nao suportado em medida: ' + raw, 400);
}

function compileDaxRowExpression(expression, aliases) {
  let expr = stripOuterParentheses(expression);
  if (!expr) throw apiError('Expressao DAX vazia.', 400);
  expr = expr.replace(/(?:'([^']+)'|([A-Za-z_\u00C0-\u00FF][A-Za-z0-9_\u00C0-\u00FF .-]*?))\s*\[\s*([^\]]+)\s*\]/g, (full, quotedTable, plainTable, column) => {
    const table = String(quotedTable || plainTable || '').trim();
    const alias = daxAliasFor(aliases, table);
    if (!alias) throw apiError('A tabela da expressao precisa estar no modelo ou em relacionamento: ' + table, 400);
    return `${alias}.${quoteIdent(String(column || '').trim())}`;
  });
  expr = expr.replace(/"([^"]*)"/g, (_, value) => sqlLiteral(value));
  expr = expr.replace(/\bTRUE\s*\(\s*\)/gi, '1').replace(/\bFALSE\s*\(\s*\)/gi, '0').replace(/\bBLANK\s*\(\s*\)/gi, 'NULL');
  if (/(;|--|\/\*|\*\/|#|@|\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bDROP\b|\bALTER\b)/i.test(expr)) {
    throw apiError('Expressao DAX contem caracteres ou comandos nao permitidos.', 400);
  }
  const unsupportedCharacter = expr.match(/[^A-Za-z0-9_`\u00C0-\u00FF\s\.\+\-\*\/\(\),<>=!%'{|&}]/);
  if (unsupportedCharacter) {
    throw apiError('Expressao DAX contem caractere nao suportado: ' + unsupportedCharacter[0] + ' (U+' + unsupportedCharacter[0].codePointAt(0).toString(16).toUpperCase() + ')', 400);
  }
  return expr.replace(/(?<![<>=!])=(?![=])/g, '=').replace(/<>/g, '!=');
}

function unwrapDaxKeepFiltersTableExpression(expression) {
  let source = stripOuterParentheses(String(expression || '').trim());
  let keepFilters = false;
  let depth = 0;
  while (depth++ < 20) {
    const wrapper = source.match(/^KEEPFILTERS\s*\(([\s\S]*)\)$/i);
    if (!wrapper) break;
    const args = splitTopLevelArgs(wrapper[1]);
    if (args.length !== 1) throw apiError('KEEPFILTERS precisa receber uma unica expressao de tabela.', 400);
    keepFilters = true;
    source = stripOuterParentheses(args[0]);
  }
  return { source, keepFilters };
}

function parseDaxValuesIterator(formula) {
  const program = parseDaxVariableProgram(formula);
  let source = stripOuterParentheses(program
    ? program.returnExpression.expression.text
    : String(formula || '').trim());
  const calculate = parseDaxTopLevelFunctionCall(source, 'CALCULATE');
  if (calculate && calculate.args.length === 1) source = stripOuterParentheses(calculate.args[0]);
  const outer = source.match(/^(SUMX)\s*\(([\s\S]*)\)$/i);
  if (!outer) return null;
  const args = splitTopLevelArgs(outer[2]);
  if (args.length < 2) return null;
  const tableSource = unwrapDaxKeepFiltersTableExpression(args[0]);
  const valuesSource = tableSource.source;
  const valuesMatch = valuesSource.match(/^(VALUES|DISTINCT)\s*\(([\s\S]*)\)$/i);
  if (!valuesMatch) return null;
  const column = parseDaxColumnReference(valuesMatch[2]);
  if (!column) throw apiError(valuesMatch[1].toUpperCase() + ' do SUMX precisa receber uma coluna.', 400);
  return {
    functionName: 'SUMX',
    tableFunction: valuesMatch[1].toUpperCase(),
    table: column.table,
    column: column.column,
    expression: args.slice(1).join(', ').trim(),
    keepFilters: tableSource.keepFilters,
    contextTransition: Boolean(calculate),
    program,
    variableScope: program ? bindDaxVariableProgram(program) : new Map()
  };
}

function daxIteratorTableSource(raw, aliases, context = {}) {
  const tableSource = unwrapDaxKeepFiltersTableExpression(raw);
  const source = tableSource.source;
  const valuesMatch = source.match(/^(VALUES|DISTINCT)\s*\(([\s\S]*)\)$/i);
  if (valuesMatch) {
    const column = parseDaxColumnReference(valuesMatch[2]);
    if (!column) throw apiError(valuesMatch[1].toUpperCase() + ' do iterador precisa receber uma coluna.', 400);
    const alias = daxAliasFor(aliases, column.table);
    if (!alias) throw apiError('A tabela do iterador precisa estar no modelo ou em relacionamento: ' + column.table, 400);
    return { type: 'values', table: column.table, alias, column: column.column, condition: '', keepFilters: tableSource.keepFilters };
  }
  const filterMatch = source.match(/^FILTER\s*\(([\s\S]*)\)$/i);
  let tableExpression = source;
  let condition = '';
  if (filterMatch) {
    const filterArgs = splitTopLevelArgs(filterMatch[1]);
    if (filterArgs.length < 2) throw apiError('FILTER do iterador precisa de tabela e condicao.', 400);
    tableExpression = stripOuterParentheses(filterArgs[0]);
    condition = compileDaxCondition(filterArgs.slice(1).join(', '), aliases, context);
  }
  const quoted = tableExpression.match(/^'([^']+)'$/);
  const plain = tableExpression.match(/^([A-Za-z_\u00C0-\u00FF][A-Za-z0-9_\u00C0-\u00FF .-]*)$/);
  const table = String(quoted && quoted[1] || plain && plain[1] || '').trim();
  if (!table) throw apiError('O iterador aceita uma tabela, VALUES/KEEPFILTERS(VALUES(...)) ou FILTER(tabela, condicao) como primeiro argumento.', 400);
  const alias = daxAliasFor(aliases, table);
  if (!alias) throw apiError('A tabela do iterador precisa estar no modelo ou em relacionamento: ' + table, 400);
  return { type: filterMatch ? 'filter' : 'table', table, alias, condition, keepFilters: tableSource.keepFilters };
}

function compileDaxIteratorRowExpression(expression, aliases, iteratorSource) {
  const alias = iteratorSource && iteratorSource.alias;
  let rowExpression = String(expression || '');
  if (alias) {
    rowExpression = rowExpression.replace(/(^|[^A-Za-z0-9_\u00C0-\u00FF\]'])\[\s*([^\]]+)\s*\]/g, function(full, prefix, column) {
      return prefix + alias + '.' + quoteIdent(String(column || '').trim());
    });
  }
  return compileDaxRowExpression(rowExpression, aliases);
}

function compileDaxIteratorAggregate(functionName, args, aliases, context = {}) {
  const iteratorFn = String(functionName || '').toUpperCase();
  if (args.length < 2) throw apiError(iteratorFn + ' precisa de tabela e expressao.', 400);
  const source = daxIteratorTableSource(args[0], aliases, context);
  const rowExpression = compileDaxIteratorRowExpression(args.slice(1).join(', '), aliases, source);
  const condition = source.condition;
  if (iteratorFn === 'SUMX') return condition ? `SUM(CASE WHEN ${condition} THEN ${rowExpression} ELSE 0 END)` : `SUM(${rowExpression})`;
  if (iteratorFn === 'AVERAGEX') return condition ? `AVG(CASE WHEN ${condition} THEN ${rowExpression} ELSE NULL END)` : `AVG(${rowExpression})`;
  if (iteratorFn === 'COUNTX') return condition ? `COUNT(CASE WHEN ${condition} THEN ${rowExpression} ELSE NULL END)` : `COUNT(${rowExpression})`;
  if (iteratorFn === 'MAXX') return condition ? `MAX(CASE WHEN ${condition} THEN ${rowExpression} ELSE NULL END)` : `MAX(${rowExpression})`;
  if (iteratorFn === 'MINX') return condition ? `MIN(CASE WHEN ${condition} THEN ${rowExpression} ELSE NULL END)` : `MIN(${rowExpression})`;
  throw apiError('Iterador DAX ainda nao suportado: ' + iteratorFn, 400);
}

// O rateio de frete usa contexto de linha e contexto por chave da nota ao mesmo
// tempo. A tabela calculada consulta apenas o pequeno cache de totais por chave;
// aqui preservamos a formula DAX salva pelo usuario e soma-se o valor calculado
// por linha quando reconhecemos exatamente esse padrao de SUMX/ALLEXCEPT.
function compileDaxFreightAllocationMeasure(formula, aliases) {
  const source = String(formula || '').trim();
  if (!/^SUMX\s*\(/i.test(source)
      || !/\bALLEXCEPT\s*\(/i.test(source)
      || !/\bVAR\s+QuantItem\b/i.test(source)
      || !/\bVAR\s+FreteTotal\b/i.test(source)
      || !/\bVAR\s+QuantTotal\b/i.test(source)
      || !/\bRETURN\b/i.test(source)
      || !/\[\s*Valor Frete\s*\]/i.test(source)
      || !/\[\s*Quantidade Recebimento\s*\]/i.test(source)
      || !/\[\s*Chave NFe\s*\]/i.test(source)
      || !/Recebido Total/i.test(source)
      || !/1\.102/.test(source)
      || !/2\.102/.test(source)) return null;

  const outer = source.match(/^SUMX\s*\(([\s\S]*)\)\s*$/i);
  if (!outer) return null;
  const args = splitTopLevelArgs(outer[1]);
  if (args.length < 2) return null;
  const filterMatch = stripOuterParentheses(args[0]).match(/^FILTER\s*\(([\s\S]*)\)$/i);
  if (!filterMatch) return null;
  const filterArgs = splitTopLevelArgs(filterMatch[1]);
  const tableExpression = String(filterArgs[0] || '').trim();
  const quotedTable = tableExpression.match(/^'([^']+)'$/);
  const table = String(quotedTable ? quotedTable[1] : tableExpression).trim();
  const alias = daxAliasFor(aliases, table);
  if (!table || !alias) return null;
  return `SUM(${alias}.${quoteIdent('Frete Rateado Linha')})`;
}

function compileDaxConditionValue(value, aliases, context = {}) {
  const source = stripOuterParentheses(value);
  if (resolveDaxVariableBinding(context, source)) return compileDaxExpression(source, aliases, context);
  if (/\b(?:SELECTEDVALUE|COALESCE|IF|DIVIDE|MIN|MAX|SUM|AVERAGE|COUNT|DISTINCTCOUNT)\s*\(/i.test(source)) {
    return compileDaxExpression(source, aliases, context);
  }
  return compileDaxRowExpression(source, aliases);
}

function splitTopLevelDaxLogical(expression, operator) {
  const source = String(expression || '');
  const token = String(operator || '');
  if (!source || !token) return [source];
  const parts = [];
  let current = '';
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote = '';
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index];
    if (quote) {
      current += ch;
      if (ch === quote) {
        if (source[index + 1] === quote) {
          current += source[index + 1];
          index += 1;
        } else {
          quote = '';
        }
      }
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === '[') { bracketDepth += 1; current += ch; continue; }
    if (ch === ']') { bracketDepth = Math.max(0, bracketDepth - 1); current += ch; continue; }
    if (!bracketDepth && ch === '(') { parenDepth += 1; current += ch; continue; }
    if (!bracketDepth && ch === ')') { parenDepth = Math.max(0, parenDepth - 1); current += ch; continue; }
    if (!bracketDepth && ch === '{') { braceDepth += 1; current += ch; continue; }
    if (!bracketDepth && ch === '}') { braceDepth = Math.max(0, braceDepth - 1); current += ch; continue; }
    if (!parenDepth && !bracketDepth && !braceDepth && source.slice(index, index + token.length) === token) {
      parts.push(current.trim());
      current = '';
      index += token.length - 1;
      continue;
    }
    current += ch;
  }
  if (current.trim() || parts.length) parts.push(current.trim());
  return parts.filter(Boolean);
}

function findTopLevelDaxComparison(expression) {
  const source = String(expression || '');
  const tokens = ['NOT LIKE', 'LIKE', '<>', '>=', '<=', '=', '>', '<'];
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote = '';
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index];
    if (quote) {
      if (ch === quote) {
        if (source[index + 1] === quote) { index += 1; continue; }
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(') { parenDepth += 1; continue; }
    if (ch === ')') { parenDepth = Math.max(0, parenDepth - 1); continue; }
    if (ch === '[') { bracketDepth += 1; continue; }
    if (ch === ']') { bracketDepth = Math.max(0, bracketDepth - 1); continue; }
    if (ch === '{') { braceDepth += 1; continue; }
    if (ch === '}') { braceDepth = Math.max(0, braceDepth - 1); continue; }
    if (parenDepth || bracketDepth || braceDepth) continue;
    for (const token of tokens) {
      const candidate = source.slice(index, index + token.length);
      if (candidate.toUpperCase() !== token) continue;
      if (/LIKE/.test(token)) {
        const before = source[index - 1] || ' ';
        const after = source[index + token.length] || ' ';
        if (!/\s/.test(before) || !/\s/.test(after)) continue;
      }
      const left = source.slice(0, index).trim();
      const right = source.slice(index + token.length).trim();
      if (left && right) return { left, operator: token, right };
    }
  }
  return null;
}

function compileDaxCondition(condition, aliases, context = {}) {
  const source = stripOuterParentheses(condition);
  if (!source) throw apiError('Filtro CALCULATE vazio.', 400);

  const orParts = splitTopLevelDaxLogical(source, '||');
  if (orParts.length > 1) {
    return orParts.map((part) => '(' + compileDaxCondition(part, aliases, context) + ')').join(' OR ');
  }
  const andParts = splitTopLevelDaxLogical(source, '&&');
  if (andParts.length > 1) {
    return andParts.map((part) => '(' + compileDaxCondition(part, aliases, context) + ')').join(' AND ');
  }

  // Handle NOT(condition)
  const notMatch = source.match(/^NOT\s*\(\s*(.+)\s*\)\s*$/i);
  if (notMatch) {
    return `NOT(${compileDaxCondition(notMatch[1], aliases, context)})`;
  }

  // IN aceita uma expressao tabular real: TableConstructor direto, VALUES ou
  // uma referencia resolvida primeiro no escopo lexical de VAR.
  const inOperator = findTopLevelDaxInOperator(source);
  if (inOperator) {
    const inExpr = compileDaxConditionValue(inOperator.left, aliases, context);
    const tableExpression = resolveDaxTableExpression(inOperator.right, aliases, context);
    if (!tableExpression) throw apiError('Expressao DAX ainda nao suportada no lado direito de IN: ' + inOperator.right, 400);
    if (tableExpression.kind === 'constructor') {
      const inValues = compileDaxTableConstructorSet(tableExpression, aliases, context);
      return inValues.length ? inExpr + ' IN (' + inValues.join(', ') + ')' : '1 = 0';
    }
    if (tableExpression.kind === 'values') {
      throw apiError('IN com VALUES/DISTINCT tabular ainda exige um plano de subconsulta correlacionada; use uma variavel TableConstructor para este contexto.', 400);
    }
    throw apiError('Expressao tabular DAX ainda nao suportada no lado direito de IN.', 400);
  }

  const comparison = findTopLevelDaxComparison(source);
  if (!comparison) {
    if (/\bIS\s+(?:NOT\s+)?NULL\b/i.test(source)) {
      return compileDaxRowExpression(source, aliases);
    }
    if (/(?:\bCASE\b|\bWHEN\b|\bTHEN\b|\bELSE\b|\bEND\b|\bSUM\s*\(|\bCOUNT\s*\(|\bMIN\s*\(|\bMAX\s*\(|\bAVG\s*\(|\bRANK\s*\(|\bOVER\s*\(|\bCOALESCE\b|\bNULL\b)/i.test(source)) {
      return `(${compileDaxRowExpression(source, aliases)}) <> 0`;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(source)) {
      return compileDaxRowExpression(source, aliases);
    }
    throw apiError('Filtro CALCULATE nao suportado: ' + condition, 400);
  }
  const leftSource = stripOuterParentheses(comparison.left);
  const left = compileDaxConditionValue(leftSource, aliases, context);
  const op = comparison.operator === '<>' ? '!=' : comparison.operator;
  const rightSource = stripOuterParentheses(comparison.right);
  const leftReference = parseDaxColumnReference(leftSource);
  const friendlyCompany = rightSource.match(/^["']\s*Empresa\s+(\d+)\s*["']$/i);
  if (leftReference && String(leftReference.column || '').trim().toLocaleLowerCase('pt-BR') === 'empresa' && friendlyCompany && (op === '=' || op === '!=')) {
    const companyLabel = String(rightSource).slice(1, -1).trim();
    const companyCode = friendlyCompany[1];
    return `CAST(${left} AS CHAR) ${op === '!=' ? 'NOT IN' : 'IN'} (${sqlLiteral(companyLabel)}, ${sqlLiteral(companyCode)})`;
  }
  const rightLiteral = daxLiteralToSql(rightSource);
  const right = rightLiteral === null ? compileDaxConditionValue(rightSource, aliases, context) : rightLiteral;
  if (op === 'LIKE') return `CAST(${left} AS CHAR) LIKE ${right}`;
  if (op === 'NOT LIKE') return `CAST(${left} AS CHAR) NOT LIKE ${right}`;
  return `${left} ${op} ${right}`;
}

function parseCalculateFilterArg(raw, aliases, context = {}) {
  const stripped = stripOuterParentheses(raw);

  // ALL(table) - skip all filters on that table
  const allTable = stripped.match(/^ALL\s*\(\s*(?:'([^']+)'|([^\[,(]+?))\s*\)\s*$/i);
  if (allTable) return { kind: 'all', table: String(allTable[1] || allTable[2] || '').trim() };

  // ALL(table[column]) - skip filter on that column
  const allColumn = stripped.match(/^ALL\s*\(\s*(?:'([^']+)'|([^\[]+?))\s*\[\s*([^\]]+)\s*\]\s*\)\s*$/i);
  if (allColumn) return { kind: 'all_column', table: String(allColumn[1] || allColumn[2] || '').trim(), column: allColumn[3].trim() };

  // ALLEXCEPT(table, col1, col2, ...) - keep filters on specified columns
  const allExcept = stripped.match(/^ALLEXCEPT\s*\(\s*(?:'([^']+)'|([^,]+?))\s*,\s*(.+)\s*\)\s*$/i);
  if (allExcept) return { kind: 'allexcept', table: String(allExcept[1] || allExcept[2] || '').trim(), columns: splitTopLevelArgs(allExcept[3]).map((s) => s.trim()) };

  // ALLSELECTED(table[column]) - like ALL but respects slicers
  const allSelected = stripped.match(/^ALLSELECTED\s*\(\s*(?:'([^']+)'|([^\[,(]+?))\s*\)\s*$/i);
  if (allSelected) return { kind: 'all', table: String(allSelected[1] || allSelected[2] || '').trim() };

  // KEEPFILTERS(condition) - keep existing filters, add new ones
  const keepFilters = stripped.match(/^KEEPFILTERS\s*\(\s*([\s\S]+)\s*\)\s*$/i);
  if (keepFilters) {
    const innerStripped = stripOuterParentheses(keepFilters[1]);
    return { kind: 'condition', sql: compileDaxCondition(innerStripped, aliases, context) };
  }

  // FILTER(table, condition) - arbitrary filter condition
  const filterFn = stripped.match(/^FILTER\s*\(\s*(?:'([^']+)'|([^,]+?))\s*,\s*([\s\S]+)\s*\)\s*$/i);
  if (filterFn) {
    const innerStripped = stripOuterParentheses(filterFn[3]);
    return { kind: 'condition', sql: compileDaxCondition(innerStripped, aliases, context) };
  }

  // Remove cross-filter / table-function references that should not produce extra WHERE
  // VALUES(table[column]), DISTINCT(table[column]), DATESYTD, etc. in CALCULATE change filter context
  const tableFnMatch = stripped.match(/^(VALUES|DISTINCT)\s*\(\s*(?:'([^']+)'|([^\[]+?))\s*\[\s*([^\]]+)\s*\]\s*\)\s*$/i);
  if (tableFnMatch) return { kind: 'none' };

  const dateFnMatch = stripped.match(/^(DATESYTD|DATESMTD|DATESQTD)\s*\(/i);
  if (dateFnMatch) {
    const dateSql = compileDaxDateTableFunction(stripped, aliases);
    return { kind: 'condition', sql: dateSql };
  }

  return { kind: 'condition', sql: compileDaxCondition(raw, aliases, context) };
}

function ensureDaxFilterContext(context = {}) {
  if (!context.filterContext || typeof context.filterContext !== 'object') {
    context.filterContext = { removedTables: [], removedColumns: [] };
  }
  if (!Array.isArray(context.filterContext.removedTables)) context.filterContext.removedTables = [];
  if (!Array.isArray(context.filterContext.removedColumns)) context.filterContext.removedColumns = [];
  return context.filterContext;
}

function addDaxRemovedTable(filterContext, table) {
  const name = String(table || '').trim();
  if (!name) return;
  if (!filterContext.removedTables.some((item) => sameTableName(item, name))) filterContext.removedTables.push(name);
}

function addDaxRemovedColumn(filterContext, table, column) {
  const tableName = String(table || '').trim();
  const columnName = String(column || '').trim();
  if (!tableName || !columnName) return;
  if (!filterContext.removedColumns.some((item) => sameTableName(item.table, tableName) && normalizeColumnNameForMatch(item.column) === normalizeColumnNameForMatch(columnName))) {
    filterContext.removedColumns.push({ table: tableName, column: columnName });
  }
}

function daxFilterContextRemoves(filterContext, table, column) {
  if (!filterContext || typeof filterContext !== 'object') return false;
  const tableName = String(table || '').trim();
  const columnName = String(column || '').trim();
  if (Array.isArray(filterContext.removedTables) && filterContext.removedTables.some((item) => sameTableName(item, tableName))) return true;
  return Array.isArray(filterContext.removedColumns) && filterContext.removedColumns.some((item) => (
    sameTableName(item && item.table, tableName)
    && normalizeColumnNameForMatch(item && item.column) === normalizeColumnNameForMatch(columnName)
  ));
}

function intersectDaxFilterContexts(contexts) {
  const valid = (Array.isArray(contexts) ? contexts : []).filter((item) => item && typeof item === 'object');
  if (!valid.length) return { removedTables: [], removedColumns: [] };
  const first = valid[0];
  return {
    removedTables: (first.removedTables || []).filter((table) => valid.every((item) => (item.removedTables || []).some((candidate) => sameTableName(candidate, table)))),
    removedColumns: (first.removedColumns || []).filter((column) => valid.every((item) => (item.removedColumns || []).some((candidate) => (
      sameTableName(candidate && candidate.table, column && column.table)
      && normalizeColumnNameForMatch(candidate && candidate.column) === normalizeColumnNameForMatch(column && column.column)
    ))))
  };
}

function compileDaxDateTableFunction(expr, aliases) {
  const stripped = stripOuterParentheses(expr);

  // TOTALYTD(expression, dates[, filter][, year_end_date])
  let m = stripped.match(/^TOTALYTD\s*\(\s*(.+?)\s*,\s*(?:'([^']+)'|([^,]+?))\s*(?:,\s*(.+))?\s*\)\s*$/i);
  if (m) {
    const tableExpr = m[1];
    const dateTable = String(m[2] || m[3] || '').trim();
    const alias = daxAliasFor(aliases, dateTable);
    if (!alias) throw apiError('Tabela de datas nao encontrada para TOTALYTD: ' + dateTable, 400);
    return `${alias}.${quoteIdent('data')} >= DATE_FORMAT(CURDATE(), '%Y-01-01') AND ${alias}.${quoteIdent('data')} <= CURDATE()`;
  }

  // DATESYTD(dates[, year_end_date])
  m = stripped.match(/^DATESYTD\s*\(\s*(?:'([^']+)'|([^,]+?))\s*(?:,\s*(.+))?\s*\)\s*$/i);
  if (m) {
    const dateTable = String(m[1] || m[2] || '').trim();
    const alias = daxAliasFor(aliases, dateTable);
    if (!alias) throw apiError('Tabela de datas nao encontrada para DATESYTD: ' + dateTable, 400);
    return `${alias}.${quoteIdent('data')} >= DATE_FORMAT(CURDATE(), '%Y-01-01') AND ${alias}.${quoteIdent('data')} <= CURDATE()`;
  }

  // DATESMTD(dates)
  m = stripped.match(/^DATESMTD\s*\(\s*(?:'([^']+)'|([^)]+?))\s*\)\s*$/i);
  if (m) {
    const dateTable = String(m[1] || m[2] || '').trim();
    const alias = daxAliasFor(aliases, dateTable);
    if (!alias) throw apiError('Tabela de datas nao encontrada para DATESMTD: ' + dateTable, 400);
    return `${alias}.${quoteIdent('data')} >= DATE_FORMAT(CURDATE(), '%Y-%m-01') AND ${alias}.${quoteIdent('data')} <= CURDATE()`;
  }

  // DATESQTD(dates)
  m = stripped.match(/^DATESQTD\s*\(\s*(?:'([^']+)'|([^)]+?))\s*\)\s*$/i);
  if (m) {
    const dateTable = String(m[1] || m[2] || '').trim();
    const alias = daxAliasFor(aliases, dateTable);
    if (!alias) throw apiError('Tabela de datas nao encontrada para DATESQTD: ' + dateTable, 400);
    return `QUARTER(${alias}.${quoteIdent('data')}) = QUARTER(CURDATE()) AND YEAR(${alias}.${quoteIdent('data')}) = YEAR(CURDATE()) AND ${alias}.${quoteIdent('data')} <= CURDATE()`;
  }

  // DATESBETWEEN(dates, start_date, end_date)
  m = stripped.match(/^DATESBETWEEN\s*\(\s*(?:'([^']+)'|([^,]+?))\s*,\s*(.+?)\s*,\s*(.+?)\s*\)\s*$/i);
  if (m) {
    const dateTable = String(m[1] || m[2] || '').trim();
    const alias = daxAliasFor(aliases, dateTable);
    if (!alias) throw apiError('Tabela de datas nao encontrada para DATESBETWEEN: ' + dateTable, 400);
    const startSql = daxDateShiftSql(m[3].trim(), alias);
    const endSql = daxDateShiftSql(m[4].trim(), alias);
    return `${alias}.${quoteIdent('data')} >= ${startSql} AND ${alias}.${quoteIdent('data')} <= ${endSql}`;
  }

  throw apiError('Funcao de tabela de data nao reconhecida: ' + expr, 400);
}

function daxDateShiftSql(daxDateExpr, alias) {
  const stripped = stripOuterParentheses(daxDateExpr);
  if (!stripped) return 'NULL';

  // Literal date "2024-01-01"
  const dateLit = stripped.match(/^"(\d{4}-\d{2}-\d{2})"$/);
  if (dateLit) return sqlLiteral(dateLit[1]);

  // TODAY()
  if (/^TODAY\s*\(\s*\)$/i.test(stripped)) return 'CURDATE()';

  // SAMEPERIODLASTYEAR(dates)
  const splY = stripped.match(/^SAMEPERIODLASTYEAR\s*\(\s*(?:'([^']+)'|([^)]+?))\s*\)\s*$/i);
  if (splY) {
    const dateTable = String(splY[1] || splY[2] || '').trim();
    return `DATE_SUB(${quoteIdent(dateTable)}.${quoteIdent('data')}, INTERVAL 1 YEAR)`;
  }

  // PREVIOUSMONTH()
  if (/^PREVIOUSMONTH\s*\(\s*(?:'([^']+)'|([^)]+?))\s*\)\s*$/i.test(stripped)) {
    return `DATE_SUB(CURDATE(), INTERVAL 1 MONTH)`;
  }

  // PREVIOUSQUARTER()
  if (/^PREVIOUSQUARTER\s*\(\s*(?:'([^']+)'|([^)]+?))\s*\)\s*$/i.test(stripped)) {
    return `DATE_SUB(CURDATE(), INTERVAL 3 MONTH)`;
  }

  // PREVIOUSYEAR()
  if (/^PREVIOUSYEAR\s*\(\s*(?:'([^']+)'|([^)]+?))\s*\)\s*$/i.test(stripped)) {
    return `DATE_SUB(CURDATE(), INTERVAL 1 YEAR)`;
  }

  // NEXTMONTH()
  if (/^NEXTMONTH\s*\(\s*(?:'([^']+)'|([^)]+?))\s*\)\s*$/i.test(stripped)) {
    return `DATE_ADD(CURDATE(), INTERVAL 1 MONTH)`;
  }

  // NEXTQUARTER()
  if (/^NEXTQUARTER\s*\(\s*(?:'([^']+)'|([^)]+?))\s*\)\s*$/i.test(stripped)) {
    return `DATE_ADD(CURDATE(), INTERVAL 3 MONTH)`;
  }

  // NEXTYEAR()
  if (/^NEXTYEAR\s*\(\s*(?:'([^']+)'|([^)]+?))\s*\)\s*$/i.test(stripped)) {
    return `DATE_ADD(CURDATE(), INTERVAL 1 YEAR)`;
  }

  // PARALLELPERIOD(dates, number, interval)
  const pp = stripped.match(/^PARALLELPERIOD\s*\(\s*(?:'([^']+)'|([^,]+?))\s*,\s*(-?\d+)\s*,\s*(YEAR|QUARTER|MONTH|DAY)\s*\)\s*$/i);
  if (pp) {
    const num = pp[3];
    const interval = pp[4].toUpperCase();
    return `DATE_ADD(${alias}.${quoteIdent('data')}, INTERVAL (${num}) ${interval})`;
  }

  // DATEADD(dates, number, interval)
  const da = stripped.match(/^DATEADD\s*\(\s*(?:'([^']+)'|([^,]+?))\s*,\s*(-?\d+)\s*,\s*(YEAR|QUARTER|MONTH|DAY)\s*\)\s*$/i);
  if (da) {
    const num = da[3];
    const interval = da[4].toUpperCase();
    return `DATE_ADD(${alias}.${quoteIdent('data')}, INTERVAL (${num}) ${interval})`;
  }

  // Column reference
  const colRef = parseDaxColumnReference(stripped);
  if (colRef) {
    const refAlias = daxAliasFor(aliases, colRef.table);
    if (refAlias) {
      return `${refAlias}.${quoteIdent(colRef.column)}`;
    }
  }

  // Fallback: try compiling as expression
  try {
    return compileDaxRowExpression(stripped, aliases);
  } catch (err) {
    return sqlLiteral(stripped);
  }
}

function compileCalculateExpression(args, aliases, context = {}) {
  if (!args.length) throw apiError('CALCULATE precisa de uma expressao.', 400);
  const base = stripOuterParentheses(args[0]);

  // LOOKUP escalar no estilo Power BI:
  // CALCULATE(SELECTEDVALUE(Tabela[Valor]), FILTER(Tabela, Tabela[Chave] = SELECTEDVALUE(Origem[Chave])))
  // A igualdade e aplicada pelo JOIN sintetico/relacionamento. Agregamos a tabela de lookup
  // para manter uma linha por chave e preservar a semantica de SELECTEDVALUE.
  const filteredLookup = daxFilteredLookupSpecs('CALCULATE(' + args.join(', ') + ')')[0];
  if (filteredLookup) {
    const lookupAlias = daxAliasFor(aliases, filteredLookup.table);
    if (!lookupAlias) throw apiError('A tabela de conversao precisa estar disponivel no modelo: ' + filteredLookup.table, 400);
    let alternate = 'NULL';
    if (filteredLookup.alternate) {
      const literal = daxLiteralToSql(filteredLookup.alternate);
      alternate = literal === null ? compileDaxExpression(filteredLookup.alternate, aliases, context) : literal;
    }
    const valueSql = lookupAlias + '.' + quoteIdent(filteredLookup.valueColumn);
    return `CASE WHEN COUNT(DISTINCT ${valueSql}) = 1 THEN MIN(${valueSql}) ELSE ${alternate} END`;
  }

  // Parse each filter modifier arg: FILTER, ALL, ALLEXCEPT, KEEPFILTERS, ALLSELECTED, VALUES, etc.
  const parsed = args.slice(1).filter(Boolean).map((arg) => parseCalculateFilterArg(arg, aliases, context));
  const filterContext = ensureDaxFilterContext(context);
  parsed.filter((item) => item.kind === 'all').forEach((item) => addDaxRemovedTable(filterContext, item.table));
  parsed.filter((item) => item.kind === 'all_column').forEach((item) => addDaxRemovedColumn(filterContext, item.table, item.column));
  const hasAll = parsed.some((p) => p.kind === 'all');
  const allTableSet = new Set(parsed.filter((p) => p.kind === 'all').map((p) => p.table));
  const allExceptInfo = parsed.filter((p) => p.kind === 'allexcept');
  const removedColumns = new Set(parsed.filter((p) => p.kind === 'all_column').map((p) => `${p.table}.${p.column}`));
  const conditions = parsed.filter((p) => p.kind === 'condition').map((p) => p.sql);

  // CALCULATE sem condicao SQL ainda provoca transicao de contexto no plano do
  // visual. A expressao base ja teve referencias de medidas trocadas por tokens
  // opacos e deve voltar ao pipeline externo. Recompila-la aqui expande SQL de
  // dependencias cedo demais (COALESCE/SUM/CASE passam a ser relidos como DAX).
  if (hasAll && !conditions.length && !allExceptInfo.length) return base;

  if (allExceptInfo.length) {
    for (const ae of allExceptInfo) {
      const keepCols = new Set(ae.columns || []);
      allTableSet.add(ae.table);
    }
  }

  const effectiveConditions = conditions.filter((cond) => {
    if (!cond) return false;
    if (removedColumns.size) {
      for (const col of removedColumns) {
        if (cond.includes(col)) return false;
      }
    }
    for (const tableName of allTableSet) {
      const alias = daxAliasFor(aliases, tableName);
      if (alias && cond.includes(alias + '.')) return false;
    }
    return true;
  });

  if (!effectiveConditions.length) return base;

  const cond = effectiveConditions.join(' AND ');
  const atomic = parseAtomicDaxMeasure(base);
  if (atomic && atomic.kind === 'column') {
    const alias = daxAliasFor(aliases, atomic.table);
    if (!alias) throw apiError('A tabela da medida precisa estar no modelo ou em relacionamento: ' + atomic.table, 400);
    const col = `${alias}.${quoteIdent(atomic.column)}`;
    if (atomic.fn === 'SUM') return `SUM(CASE WHEN ${cond} THEN ${col} ELSE 0 END)`;
    if (atomic.fn === 'COUNT') return `COUNT(CASE WHEN ${cond} THEN ${col} ELSE NULL END)`;
    if (atomic.fn === 'DISTINCTCOUNT') return `COUNT(DISTINCT CASE WHEN ${cond} THEN ${col} ELSE NULL END)`;
    if (atomic.fn === 'AVERAGE') return `AVG(CASE WHEN ${cond} THEN ${col} ELSE NULL END)`;
    if (atomic.fn === 'MIN') return `MIN(CASE WHEN ${cond} THEN ${col} ELSE NULL END)`;
    if (atomic.fn === 'MAX') return `MAX(CASE WHEN ${cond} THEN ${col} ELSE NULL END)`;
  }
  if (atomic && atomic.kind === 'table' && atomic.fn === 'COUNTROWS') {
    return `SUM(CASE WHEN ${cond} THEN 1 ELSE 0 END)`;
  }

  const iteratorMatch = base.match(/^(SUMX|AVERAGEX|COUNTX|MAXX|MINX)\s*\(([\s\S]+)\)\s*$/i);
  if (iteratorMatch) {
    const iteratorFn = iteratorMatch[1].toUpperCase();
    const iteratorArgs = splitTopLevelArgs(iteratorMatch[2]);
    if (iteratorArgs.length < 2) throw apiError(iteratorFn + ' precisa de tabela e expressao.', 400);
    const iteratorTable = String(iteratorArgs[0] || '').replace(/^'|'$/g, '').trim();
    if (!daxAliasFor(aliases, iteratorTable)) throw apiError('A tabela do ' + iteratorFn + ' precisa estar no modelo ou em relacionamento: ' + iteratorTable, 400);
    const rowExpr = compileDaxRowExpression(iteratorArgs.slice(1).join(', '), aliases);
    if (iteratorFn === 'SUMX') return `SUM(CASE WHEN ${cond} THEN ${rowExpr} ELSE 0 END)`;
    if (iteratorFn === 'AVERAGEX') return `AVG(CASE WHEN ${cond} THEN ${rowExpr} ELSE NULL END)`;
    if (iteratorFn === 'COUNTX') return `COUNT(CASE WHEN ${cond} THEN ${rowExpr} ELSE NULL END)`;
    if (iteratorFn === 'MAXX') return `MAX(CASE WHEN ${cond} THEN ${rowExpr} ELSE NULL END)`;
    if (iteratorFn === 'MINX') return `MIN(CASE WHEN ${cond} THEN ${rowExpr} ELSE NULL END)`;
  }

  const compiled = compileDaxExpression(base, aliases, context);
  const conditionedAggregate = injectDaxCalculateConditionIntoAggregate(compiled, cond);
  if (conditionedAggregate) return conditionedAggregate;
  return `SUM(CASE WHEN ${cond} THEN (${compiled}) ELSE 0 END)`;
}

function injectDaxCalculateConditionIntoAggregate(compiledSql, conditionSql) {
  const compiled = stripOuterParentheses(compiledSql);
  const condition = String(conditionSql || '').trim();
  if (!compiled || !condition) return '';

  let m = compiled.match(/^(SUM|AVG|MIN|MAX|COUNT)\s*\(\s*CASE\s+WHEN\s+([\s\S]+)\s+THEN\s+([\s\S]+)\s+ELSE\s+(0|NULL)\s+END\s*\)$/i);
  if (m) {
    const fn = m[1].toUpperCase();
    return `${fn}(CASE WHEN (${condition}) AND (${m[2].trim()}) THEN ${m[3].trim()} ELSE ${m[4].toUpperCase()} END)`;
  }

  m = compiled.match(/^COUNT\s*\(\s*DISTINCT\s+CASE\s+WHEN\s+([\s\S]+)\s+THEN\s+([\s\S]+)\s+ELSE\s+NULL\s+END\s*\)$/i);
  if (m) {
    return `COUNT(DISTINCT CASE WHEN (${condition}) AND (${m[1].trim()}) THEN ${m[2].trim()} ELSE NULL END)`;
  }

  m = compiled.match(/^(SUM|AVG|MIN|MAX|COUNT)\s*\(([\s\S]+)\)$/i);
  if (m) {
    const fn = m[1].toUpperCase();
    const value = m[2].trim();
    const fallback = fn === 'SUM' ? '0' : 'NULL';
    return `${fn}(CASE WHEN ${condition} THEN ${value} ELSE ${fallback} END)`;
  }

  m = compiled.match(/^COUNT\s*\(\s*DISTINCT\s+([\s\S]+)\)$/i);
  if (m) {
    return `COUNT(DISTINCT CASE WHEN ${condition} THEN ${m[1].trim()} ELSE NULL END)`;
  }

  return '';
}

function replaceFunctionCalls(expr, functionName, handler) {
  let source = String(expr || '');
  const nameRe = new RegExp(functionName + '\\s*\\(', 'i');
  let guard = 0;
  while (guard++ < 50) {
    const m = source.match(nameRe);
    if (!m) break;
    const start = m.index;
    let pos = start + m[0].length;
    let depth = 1;
    let quote = '';
    while (pos < source.length && depth > 0) {
      const ch = source[pos];
      if (quote) {
        if (ch === quote) {
          if (source[pos + 1] === quote) { pos += 2; continue; }
          quote = '';
        }
        pos += 1;
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; pos += 1; continue; }
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      pos += 1;
    }
    if (depth !== 0) throw apiError(functionName + ' com parenteses incompletos.', 400);
    const inner = source.slice(start + m[0].length, pos - 1);
    const replacement = handler(splitTopLevelArgs(inner));
    source = source.slice(0, start) + '(' + replacement + ')' + source.slice(pos);
  }
  return source;
}

function splitTopLevelDaxAdditiveExpression(value) {
  const source = String(value || '').trim();
  if (!source) return null;
  const parts = [];
  const operators = [];
  let start = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (singleQuoted) {
      if (ch === "'" && source[i + 1] === "'") { i += 1; continue; }
      if (ch === "'") singleQuoted = false;
      continue;
    }
    if (doubleQuoted) {
      if (ch === '"' && source[i + 1] === '"') { i += 1; continue; }
      if (ch === '"') doubleQuoted = false;
      continue;
    }
    if (ch === "'") { singleQuoted = true; continue; }
    if (ch === '"') { doubleQuoted = true; continue; }
    if (ch === '(') { parenDepth += 1; continue; }
    if (ch === ')') { parenDepth = Math.max(0, parenDepth - 1); continue; }
    if (ch === '[') { bracketDepth += 1; continue; }
    if (ch === ']') { bracketDepth = Math.max(0, bracketDepth - 1); continue; }
    if (ch === '{') { braceDepth += 1; continue; }
    if (ch === '}') { braceDepth = Math.max(0, braceDepth - 1); continue; }
    if ((ch !== '+' && ch !== '-') || parenDepth || bracketDepth || braceDepth) continue;

    let previousIndex = i - 1;
    while (previousIndex >= 0 && /\s/.test(source[previousIndex])) previousIndex -= 1;
    const previous = previousIndex >= 0 ? source[previousIndex] : '';
    const beforePrevious = previousIndex > 0 ? source[previousIndex - 1] : '';
    const unary = !previous || /[+\-*/^(=<>!,{&|]/.test(previous) || (/[eE]/.test(previous) && /[0-9.]/.test(beforePrevious));
    if (unary) continue;

    const part = source.slice(start, i).trim();
    if (!part) continue;
    parts.push(part);
    operators.push(ch);
    start = i + 1;
  }
  if (!operators.length) return null;
  const tail = source.slice(start).trim();
  if (!tail) return null;
  parts.push(tail);
  return { parts, operators };
}

function daxMeasureCompileState(context = {}) {
  if (!(context.compiledMeasureCache instanceof Map)) context.compiledMeasureCache = new Map();
  if (!(context.measureSqlTokenByKey instanceof Map)) context.measureSqlTokenByKey = new Map();
  if (!(context.measureSqlByToken instanceof Map)) context.measureSqlByToken = new Map();
  if (!(context.generatedSqlByToken instanceof Map)) context.generatedSqlByToken = new Map();
  if (!(context.preAggregatedMeasureRegistry instanceof Map)) context.preAggregatedMeasureRegistry = new Map();
  return context;
}

function compiledDaxGeneratedSqlToken(sql, context = {}) {
  const state = daxMeasureCompileState(context);
  const token = '__BIWA_DAX_SQL_' + state.generatedSqlByToken.size + '__';
  state.generatedSqlByToken.set(token, String(sql || ''));
  return token;
}

function compileReferencedDaxMeasure(measure, aliases, context = {}) {
  const state = daxMeasureCompileState(context);
  const lookup = state.measureLookup || buildMeasureLookup(state.model || {});
  const currentKey = normalizeMeasureNameKey(measure && (measure.name || measure.displayName));
  const stack = Array.isArray(state.stack) ? state.stack.slice() : [];
  if (!currentKey) throw apiError('Medida referenciada sem nome.', 400);
  if (stack.includes(currentKey)) throw apiError('Dependencia circular entre medidas DAX: ' + [...stack, currentKey].join(' -> '), 400);
  if (!String(measure && measure.formula || '').trim()) throw apiError('Medida referenciada sem formula DAX: ' + (measure && (measure.name || measure.displayName) || ''), 400);
  if (state.compiledMeasureCache.has(currentKey)) return state.compiledMeasureCache.get(currentKey);
  const compiled = compileDaxExpression(measure.formula, aliases, {
    ...state,
    measureLookup: lookup,
    currentMeasure: measure.name,
    stack: [...stack, currentKey]
  });
  state.compiledMeasureCache.set(currentKey, compiled);
  return compiled;
}

function projectedDaxMeasureReferenceSql(measure, context = {}) {
  const projected = context && context.projectedMeasureSqlByKey;
  if (!(projected instanceof Map) || !measure) return '';
  const key = normalizeMeasureNameKey(measure.name || measure.displayName);
  return key && projected.has(key) ? String(projected.get(key) || '') : '';
}

function compilePreAggregatedDaxMeasureReference(measure, aliases, context = {}) {
  const allowedTables = context && context.preAggregateMeasureTables;
  if (!(allowedTables instanceof Set) || !measure) return '';
  const measureTables = tablesUsedByMeasureWithDependencies(measure, context.model || {});
  const uniqueTables = [];
  const seen = new Set();
  measureTables.forEach(function(tableName) {
    const key = normalizeTableKey(tableName);
    if (!key || seen.has(key)) return;
    seen.add(key);
    uniqueTables.push(normalizeTableName(tableName));
  });
  if (uniqueTables.length !== 1) return '';
  const table = uniqueTables[0];
  const tableKey = normalizeTableKey(table);
  if (!allowedTables.has(tableKey)) return '';
  const tableAlias = daxAliasFor(aliases, table);
  if (!tableAlias) return '';
  const state = daxMeasureCompileState(context);
  if (!state.preAggregatedMeasureRegistry.has(tableKey)) state.preAggregatedMeasureRegistry.set(tableKey, new Map());
  const tableRegistry = state.preAggregatedMeasureRegistry.get(tableKey);
  const measureKey = normalizeMeasureNameKey(measure.name || measure.displayName);
  if (!tableRegistry.has(measureKey)) {
    tableRegistry.set(measureKey, {
      table,
      measure,
      outputAlias: '__biwa_pre_measure_' + crypto.createHash('sha1').update(tableKey + '|' + measureKey).digest('hex').slice(0, 12)
    });
  }
  const entry = tableRegistry.get(measureKey);
  // The derived table has one row per relationship key (and configured visual
  // dimension). MAX preserves that already-aggregated scalar in the outer group.
  return 'MAX(' + tableAlias + '.' + quoteIdent(entry.outputAlias) + ')';
}

function seedVisualPreAggregatedMeasures(registry, measures, allowedTables, model) {
  if (!(registry instanceof Map) || !(allowedTables instanceof Set)) return;
  (Array.isArray(measures) ? measures : []).forEach(function(measure) {
    const tables = [];
    const seen = new Set();
    tablesUsedByMeasureWithDependencies(measure, model || {}).forEach(function(tableName) {
      const table = normalizeTableName(tableName);
      const key = normalizeTableKey(table);
      if (!key || seen.has(key)) return;
      seen.add(key);
      tables.push({ table, key });
    });
    if (tables.length !== 1 || !allowedTables.has(tables[0].key)) return;
    if (!registry.has(tables[0].key)) registry.set(tables[0].key, new Map());
    const tableRegistry = registry.get(tables[0].key);
    const measureKey = normalizeMeasureNameKey(measure.name || measure.displayName);
    if (!measureKey || tableRegistry.has(measureKey)) return;
    tableRegistry.set(measureKey, {
      table: tables[0].table,
      measure,
      outputAlias: '__biwa_pre_measure_' + crypto.createHash('sha1').update(tables[0].key + '|' + measureKey).digest('hex').slice(0, 12)
    });
  });
}

function compiledDaxMeasureToken(measure, compiledSql, context = {}) {
  const state = daxMeasureCompileState(context);
  const key = normalizeMeasureNameKey(measure && (measure.name || measure.displayName));
  if (state.measureSqlTokenByKey.has(key)) return state.measureSqlTokenByKey.get(key);
  const token = '__BIWA_DAX_MEASURE_' + state.measureSqlTokenByKey.size + '__';
  state.measureSqlTokenByKey.set(key, token);
  state.measureSqlByToken.set(token, String(compiledSql || ''));
  return token;
}

function restoreCompiledDaxMeasureTokens(value, context = {}) {
  const state = context && context.measureSqlByToken instanceof Map ? context : null;
  let source = String(value || '');
  if (!state) return source;
  for (const [token, compiledSql] of state.measureSqlByToken.entries()) {
    source = source.split(token).join('(' + compiledSql + ')');
  }
  return source;
}

function restoreCompiledDaxGeneratedSqlTokens(value, context = {}) {
  const state = context && context.generatedSqlByToken instanceof Map ? context : null;
  let source = String(value || '');
  if (!state) return source;
  for (const [token, compiledSql] of state.generatedSqlByToken.entries()) {
    source = source.split(token).join(compiledSql);
  }
  return source;
}

function compileDaxExpression(formula, aliases, context = {}) {
  daxMeasureCompileState(context);
  const freightAllocationSql = compileDaxFreightAllocationMeasure(formula, aliases);
  if (freightAllocationSql) return freightAllocationSql;
  const variableProgram = parseDaxVariableProgram(formula);
  if (variableProgram) {
    const variableScope = bindDaxVariableProgram(variableProgram, context.daxVariables);
    return compileDaxExpression(variableProgram.returnExpression.expression.text, aliases, {
      ...context,
      daxVariables: variableScope,
      daxProgram: variableProgram
    });
  }
  const rankingMeasure = String(formula || '').trim().match(/^IF\s*\(\s*\[([^\]]+)\]\s*,\s*RANKX\s*\(\s*ALLSELECTED\s*\([^)]*\)\s*,\s*\[([^\]]+)\]\s*(?:,\s*,\s*(ASC|DESC)?\s*,\s*(?:SKIP|DENSE)\s*)?\)\s*\)\s*$/i);
  if (rankingMeasure && normalizeMeasureNameKey(rankingMeasure[1]) === normalizeMeasureNameKey(rankingMeasure[2])) {
    const lookup = context.measureLookup || buildMeasureLookup(context.model || {});
    const dependency = lookup.get(normalizeMeasureNameKey(rankingMeasure[1]));
    if (dependency && String(dependency.formula || '').trim()) {
      const dependencyKey = normalizeMeasureNameKey(dependency.name || dependency.displayName);
      const stack = Array.isArray(context.stack) ? context.stack.slice() : [];
      if (stack.includes(dependencyKey)) throw apiError('Dependencia circular entre medidas DAX: ' + [...stack, dependencyKey].join(' -> '), 400);
      const valueSql = compileDaxExpression(dependency.formula, aliases, { ...context, measureLookup: lookup, currentMeasure: dependency.name, stack: [...stack, dependencyKey] });
      const order = String(rankingMeasure[3] || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
      return `CASE WHEN (${valueSql}) <> 0 THEN RANK() OVER (ORDER BY ${valueSql} ${order}) ELSE NULL END`;
    }
  }
  let expr = stripOuterParentheses(String(formula || '').trim());
  if (!expr) throw apiError('Informe a formula da medida.', 400);
  if (/^__BIWA_DAX_MEASURE_\d+__$/.test(expr)) return expr;

  const directVariableTokens = tokenizeDaxSemantic(expr);
  if (directVariableTokens.length === 1 && directVariableTokens[0].type === 'identifier') {
    const binding = resolveDaxVariableBinding(context, directVariableTokens[0].value);
    if (binding) return compileDaxVariableScalar(binding, aliases, context);
  }
  expr = compileDaxScalarVariableReferences(expr, aliases, context);

  const countRowsCall = parseDaxTopLevelFunctionCall(expr, 'COUNTROWS');
  if (countRowsCall) {
    if (countRowsCall.args.length !== 1) throw apiError('COUNTROWS precisa de uma expressao de tabela.', 400);
    const compiledCountRows = compileDaxCountRowsTableExpression(countRowsCall.args[0], aliases, context);
    if (compiledCountRows !== null) return compiledCountRows;
  }

  // Medidas compostas normalmente referenciam outras medidas diretamente.
  // O SQL da dependencia ja esta compilado; processa-lo novamente faria SUM,
  // COALESCE e CASE serem interpretados como DAX a cada nivel da cadeia.
  const directMeasureReference = expr.match(/^\[\s*([^\]]+)\s*\]$/);
  if (directMeasureReference && context.model && Array.isArray(context.model.measures)) {
    const lookup = context.measureLookup || buildMeasureLookup(context.model);
    const dependency = lookup.get(normalizeMeasureNameKey(directMeasureReference[1]));
    if (dependency) {
      const projected = projectedDaxMeasureReferenceSql(dependency, context);
      if (projected) return projected;
      const preAggregated = compilePreAggregatedDaxMeasureReference(dependency, aliases, { ...context, measureLookup: lookup });
      if (preAggregated) return preAggregated;
      return compileReferencedDaxMeasure(dependency, aliases, { ...context, measureLookup: lookup });
    }
  }

  // Em DAX, BLANK participa de soma/subtração numérica como zero. No SQL,
  // NULL propagaria e apagaria linhas válidas (por exemplo valor + frete em
  // uma linha sem frete). Compile a expressão aditiva antes de substituir as
  // medidas para manter a semântica do Power BI em qualquer medida composta.
  const additive = splitTopLevelDaxAdditiveExpression(expr);
  if (additive) {
    let sql = `COALESCE((${compileDaxExpression(additive.parts[0], aliases, context)}), 0)`;
    for (let i = 0; i < additive.operators.length; i += 1) {
      const rightSql = compileDaxExpression(additive.parts[i + 1], aliases, context);
      sql = `(${sql} ${additive.operators[i]} COALESCE((${rightSql}), 0))`;
    }
    return sql;
  }

  expr = replaceDaxMeasureReferences(expr, aliases, context);

  // ISBLANK testa exclusivamente o BLANK DAX, representado por NULL no SQL.
  // Zero e texto vazio continuam valores validos e retornam FALSE. Tokens de
  // medidas permanecem opacos ate o fim para SQL ja compilado nao ser lido
  // novamente como uma expressao DAX.
  expr = replaceFunctionCalls(expr, 'ISBLANK', (args) => {
    if (args.length !== 1) throw apiError('ISBLANK precisa de exatamente uma expressão.', 400);
    const raw = stripOuterParentheses(args[0]);
    const column = parseDaxColumnReference(raw);
    let valueSql;
    if (/^__BIWA_DAX_MEASURE_\d+__$/.test(raw)) {
      valueSql = raw;
    } else if (column) {
      const alias = daxAliasFor(aliases, column.table);
      if (!alias) throw apiError('A tabela do ISBLANK precisa estar no modelo ou em relacionamento: ' + column.table, 400);
      valueSql = alias + '.' + quoteIdent(column.column);
    } else {
      valueSql = compileDaxExpression(raw, aliases, context);
    }
    return `((${valueSql}) IS NULL)`;
  });

  // ---- Iterator functions (table, expression) ----
  expr = replaceFunctionCalls(expr, 'MAXX', (args) => {
    return compileDaxIteratorAggregate('MAXX', args, aliases, context);
  });
  expr = replaceFunctionCalls(expr, 'MINX', (args) => {
    return compileDaxIteratorAggregate('MINX', args, aliases, context);
  });
  expr = replaceFunctionCalls(expr, 'CONCATENATEX', (args) => {
    if (args.length < 2) throw apiError('CONCATENATEX precisa de tabela e expressao.', 400);
    const delimiter = args[2] ? compileDaxExpression(args[2], aliases, context) : "','";
    return `GROUP_CONCAT(DISTINCT CAST(${compileDaxRowExpression(args.slice(1).join(', '), aliases)} AS CHAR) SEPARATOR ${delimiter})`;
  });

  expr = replaceFunctionCalls(expr, 'CALCULATE', (args) => compileCalculateExpression(args, aliases, context));

  // ---- X-iterators ----
  expr = replaceFunctionCalls(expr, 'SUMX', (args) => {
    return compileDaxIteratorAggregate('SUMX', args, aliases, context);
  });
  expr = replaceFunctionCalls(expr, 'AVERAGEX', (args) => {
    return compileDaxIteratorAggregate('AVERAGEX', args, aliases, context);
  });
  expr = replaceFunctionCalls(expr, 'COUNTX', (args) => {
    return compileDaxIteratorAggregate('COUNTX', args, aliases, context);
  });

  // ---- RANKX ----
  expr = replaceFunctionCalls(expr, 'RANKX', (args) => {
    if (args.length < 2) throw apiError('RANKX precisa de tabela e expressao.', 400);
    const order = args[3] && String(args[3]).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    // O segundo argumento pode ser outra medida (inclusive com CALCULATE/SUMX),
    // nao apenas uma expressao de coluna linha a linha.
    const compiledExpr = compileDaxExpression(args[1], aliases, context);
    return `RANK() OVER (ORDER BY ${compiledExpr} ${order})`;
  });

  // ---- TOPN ----
  expr = replaceFunctionCalls(expr, 'TOPN', (args) => {
    throw apiError('TOPN deve ser usado dentro de CALCULATE como modificador de filtro, nao como expressao isolada.', 400);
  });

  // ---- Conditional ----
  expr = replaceFunctionCalls(expr, 'IF', (args) => {
    if (args.length < 2) throw apiError('IF precisa de condicao e valor verdadeiro.', 400);
    const condition = compileDaxCondition(args[0], aliases, context);
    const whenTrue = compileDaxExpression(args[1], aliases, context);
    const whenFalse = args[2] ? compileDaxExpression(args[2], aliases, context) : 'NULL';
    return `CASE WHEN ${condition} THEN ${whenTrue} ELSE ${whenFalse} END`;
  });
  expr = replaceFunctionCalls(expr, 'SWITCH', (args) => {
    if (args.length < 3) throw apiError('SWITCH precisa de expressao e pares valor/resultado.', 400);
    const base = stripOuterParentheses(args[0]);
    const hasTrueBase = /^TRUE\s*\(\s*\)$/i.test(base) || /^TRUE$/i.test(base);
    const parts = [];
    let idx = 1;
    while (idx + 1 < args.length) {
      const cond = hasTrueBase ? compileDaxCondition(args[idx], aliases, context) : `${compileDaxExpression(base, aliases, context)} = ${compileDaxExpression(args[idx], aliases, context)}`;
      parts.push(`WHEN ${cond} THEN ${compileDaxExpression(args[idx + 1], aliases, context)}`);
      idx += 2;
    }
    const fallback = idx < args.length ? compileDaxExpression(args[idx], aliases, context) : 'NULL';
    return `CASE ${parts.join(' ')} ELSE ${fallback} END`;
  });

  // ---- Table functions (VALUES, DISTINCT, HASONEVALUE, ISFILTERED, ISCROSSFILTERED) ----
  expr = replaceFunctionCalls(expr, 'VALUES', (args) => {
    const ref = parseDaxColumnReference(args[0] || '');
    if (!ref) throw apiError('VALUES precisa de uma coluna.', 400);
    const alias = daxAliasFor(aliases, ref.table);
    if (!alias) throw apiError('A tabela do VALUES precisa estar no modelo: ' + ref.table, 400);
    return `MIN(${alias}.${quoteIdent(ref.column)})`;
  });
  expr = replaceFunctionCalls(expr, 'DISTINCT', (args) => {
    const ref = parseDaxColumnReference(args[0] || '');
    if (!ref) throw apiError('DISTINCT precisa de uma coluna.', 400);
    const alias = daxAliasFor(aliases, ref.table);
    if (!alias) throw apiError('A tabela do DISTINCT precisa estar no modelo: ' + ref.table, 400);
    return `MIN(${alias}.${quoteIdent(ref.column)})`;
  });
  expr = replaceFunctionCalls(expr, 'HASONEVALUE', (args) => {
    const ref = parseDaxColumnReference(args[0] || '');
    if (!ref) throw apiError('HASONEVALUE precisa de uma coluna.', 400);
    return 1;
  });
  expr = replaceFunctionCalls(expr, 'ISFILTERED', (args) => {
    return 1;
  });
  expr = replaceFunctionCalls(expr, 'ISCROSSFILTERED', (args) => {
    return 1;
  });

  // ---- RELATED ----
  expr = replaceFunctionCalls(expr, 'RELATED', (args) => {
    const ref = parseDaxColumnReference(args[0] || '');
    if (!ref) throw apiError('RELATED precisa de uma coluna.', 400);
    const alias = daxAliasFor(aliases, ref.table);
    if (!alias) throw apiError('A tabela do RELATED precisa estar no modelo ou em relacionamento: ' + ref.table, 400);
    return `${alias}.${quoteIdent(ref.column)}`;
  });

  // ---- FORMAT ----
  expr = replaceFunctionCalls(expr, 'FORMAT', (args) => {
    if (args.length < 2) throw apiError('FORMAT precisa de valor e formato.', 400);
    const value = compileDaxExpression(args[0], aliases, context);
    const fmt = String(args[1] || '').replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    if (fmt === 'YYYY-MM-DD' || fmt === 'yyyy-mm-dd') return `DATE_FORMAT(${value}, '%Y-%m-%d')`;
    if (fmt === 'DD/MM/YYYY' || fmt === 'dd/mm/yyyy') return `DATE_FORMAT(${value}, '%d/%m/%Y')`;
    if (fmt === 'YYYY' || fmt === 'yyyy') return `YEAR(${value})`;
    if (fmt === 'MM' || fmt === 'mm') return `MONTH(${value})`;
    if (fmt === 'DD' || fmt === 'dd') return `DAY(${value})`;
    if (/^[#,.\d]+$/.test(fmt)) return `ROUND(${value}, 2)`;
    return `CAST(${value} AS CHAR)`;
  });

  // ---- CONCATENATE ----
  expr = replaceFunctionCalls(expr, 'CONCATENATE', (args) => {
    if (args.length < 2) throw apiError('CONCATENATE precisa de dois valores.', 400);
    const left = compileDaxExpression(args[0], aliases, context);
    const right = compileDaxExpression(args[1], aliases, context);
    return `CONCAT(CAST(${left} AS CHAR), CAST(${right} AS CHAR))`;
  });

  // ---- SELECTEDVALUE ----
  expr = replaceFunctionCalls(expr, 'SELECTEDVALUE', (args) => {
    const ref = parseDaxColumnReference(args[0] || '');
    if (!ref) throw apiError('SELECTEDVALUE precisa de uma coluna.', 400);
    const alias = daxAliasFor(aliases, ref.table);
    if (!alias) throw apiError('A tabela do SELECTEDVALUE precisa estar no modelo ou em relacionamento: ' + ref.table, 400);
    const alternate = args[1] ? daxLiteralToSql(args[1]) : 'NULL';
    const columnSql = `${alias}.${quoteIdent(ref.column)}`;
    return `CASE WHEN COUNT(DISTINCT ${columnSql}) = 1 THEN MIN(${columnSql}) ELSE ${alternate || 'NULL'} END`;
  });

  // ---- COALESCE ----
  expr = replaceFunctionCalls(expr, 'COALESCE', (args) => {
    if (args.length < 2) throw apiError('COALESCE precisa de pelo menos dois argumentos.', 400);
    return 'COALESCE(' + args.map((arg) => {
      try {
        const literal = daxLiteralToSql(arg);
        return literal === null ? compileDaxExpression(arg, aliases, context) : literal;
      } catch (err) {
        // SELECTEDVALUE gera MIN/COALESCE SQL internamente. Esses argumentos ja
        // compilados nao sao literais DAX e devem seguir como expressao SQL valida.
        return compileDaxExpression(arg, aliases, context);
      }
    }).join(', ') + ')';
  });

  // ---- DIVIDE ----
  expr = expr.replace(/DIVIDE\s*\(/gi, 'DIVIDE(');
  expr = replaceFunctionCalls(expr, 'DIVIDE', (args) => {
    if (args.length < 2) throw apiError('DIVIDE precisa de numerador e denominador.', 400);
    const numerator = compileDaxExpression(args[0], aliases, context);
    const denominator = compileDaxExpression(args[1], aliases, context);
    const alternate = args[2] ? compileDaxExpression(args[2], aliases, context) : '0';
    return `CASE WHEN (${denominator}) = 0 OR (${denominator}) IS NULL THEN ${alternate} ELSE (${numerator}) / NULLIF((${denominator}), 0) END`;
  });

  // ---- Time Intelligence (standalone, outside CALCULATE) ----
  // SAMEPERIODLASTYEAR(dates)
  expr = replaceFunctionCalls(expr, 'SAMEPERIODLASTYEAR', (args) => {
    throw apiError('SAMEPERIODLASTYEAR deve ser usado dentro de CALCULATE como modificador de filtro de data.', 400);
  });
  // DATEADD(dates, number, interval)
  expr = replaceFunctionCalls(expr, 'DATEADD', (args) => {
    throw apiError('DATEADD deve ser usado dentro de CALCULATE como modificador de filtro de data.', 400);
  });
  // DATESYTD, DATESMTD, DATESQTD, DATESBETWEEN, PREVIOUSMONTH, etc.
  expr = replaceFunctionCalls(expr, 'DATESYTD', (args) => {
    throw apiError('DATESYTD deve ser usado dentro de CALCULATE como modificador de filtro de data.', 400);
  });
  expr = replaceFunctionCalls(expr, 'DATESMTD', (args) => {
    throw apiError('DATESMTD deve ser usado dentro de CALCULATE como modificador de filtro de data.', 400);
  });
  expr = replaceFunctionCalls(expr, 'DATESQTD', (args) => {
    throw apiError('DATESQTD deve ser usado dentro de CALCULATE como modificador de filtro de data.', 400);
  });
  expr = replaceFunctionCalls(expr, 'DATESBETWEEN', (args) => {
    throw apiError('DATESBETWEEN deve ser usado dentro de CALCULATE como modificador de filtro de data.', 400);
  });
  expr = replaceFunctionCalls(expr, 'PREVIOUSMONTH', (args) => {
    throw apiError('PREVIOUSMONTH deve ser usado dentro de CALCULATE como modificador de filtro de data.', 400);
  });
  expr = replaceFunctionCalls(expr, 'PREVIOUSQUARTER', (args) => {
    throw apiError('PREVIOUSQUARTER deve ser usado dentro de CALCULATE como modificador de filtro de data.', 400);
  });
  expr = replaceFunctionCalls(expr, 'PREVIOUSYEAR', (args) => {
    throw apiError('PREVIOUSYEAR deve ser usado dentro de CALCULATE como modificador de filtro de data.', 400);
  });
  expr = replaceFunctionCalls(expr, 'NEXTMONTH', (args) => {
    throw apiError('NEXTMONTH deve ser usado dentro de CALCULATE como modificador de filtro de data.', 400);
  });
  expr = replaceFunctionCalls(expr, 'NEXTQUARTER', (args) => {
    throw apiError('NEXTQUARTER deve ser usado dentro de CALCULATE como modificador de filtro de data.', 400);
  });
  expr = replaceFunctionCalls(expr, 'NEXTYEAR', (args) => {
    throw apiError('NEXTYEAR deve ser usado dentro de CALCULATE como modificador de filtro de data.', 400);
  });
  expr = replaceFunctionCalls(expr, 'PARALLELPERIOD', (args) => {
    throw apiError('PARALLELPERIOD deve ser usado dentro de CALCULATE como modificador de filtro de data.', 400);
  });
  expr = replaceFunctionCalls(expr, 'TOTALYTD', (args) => {
    throw apiError('TOTALYTD deve ser usado dentro de CALCULATE como modificador de filtro de data.', 400);
  });

  // ---- FILTER / ALL / ALLEXCEPT / ALLSELECTED / KEEPFILTERS outside CALCULATE ----
  expr = replaceFunctionCalls(expr, 'FILTER', (args) => {
    throw apiError('FILTER deve ser usado dentro de CALCULATE como modificador de filtro.', 400);
  });
  expr = replaceFunctionCalls(expr, 'ALL', (args) => {
    throw apiError('ALL deve ser usado dentro de CALCULATE como modificador de filtro.', 400);
  });
  expr = replaceFunctionCalls(expr, 'ALLEXCEPT', (args) => {
    throw apiError('ALLEXCEPT deve ser usado dentro de CALCULATE como modificador de filtro.', 400);
  });
  expr = replaceFunctionCalls(expr, 'ALLSELECTED', (args) => {
    throw apiError('ALLSELECTED deve ser usado dentro de CALCULATE como modificador de filtro.', 400);
  });
  expr = replaceFunctionCalls(expr, 'KEEPFILTERS', (args) => {
    throw apiError('KEEPFILTERS deve ser usado dentro de CALCULATE como modificador de filtro.', 400);
  });
  expr = replaceFunctionCalls(expr, 'TOPN', (args) => {
    throw apiError('TOPN deve ser usado dentro de CALCULATE como modificador de filtro.', 400);
  });

  // ---- Basic aggregations (atomic DAX) ----
  expr = expr.replace(/(SUM|AVERAGE|AVG|MIN|MAX|COUNT|DISTINCTCOUNT)\s*\(\s*(?:'([^']+)'|([^\[]+?))\s*\[\s*([^\]]+)\s*\]\s*\)/gi, (full) => {
    const parsed = parseAtomicDaxMeasure(full);
    if (!parsed) throw apiError('Medida invalida: ' + full, 400);
    return '(' + sqlAggForMeasure(parsed, aliases, context) + ')';
  });
  expr = expr.replace(/COUNTROWS\s*\(\s*(?:'([^']+)'|([^\)]+?))\s*\)/gi, (full) => {
    const parsed = parseAtomicDaxMeasure(full);
    if (!parsed) throw apiError('Medida invalida: ' + full, 400);
    return '(' + sqlAggForMeasure(parsed, aliases, context) + ')';
  });

  // ---- Literals ----
  expr = expr.replace(/"([^"]*)"/g, (_, value) => sqlLiteral(value));
  expr = expr.replace(/\bTRUE\s*\(\s*\)/gi, '1').replace(/\bFALSE\s*\(\s*\)/gi, '0').replace(/\bBLANK\s*\(\s*\)/gi, 'NULL');

  // ---- Security validation ----
  if (/(;|--|\/\*|\*\/|#|@|\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bDROP\b|\bALTER\b)/i.test(expr)) {
    throw apiError('Formula de medida contem caracteres ou comandos nao permitidos.', 400);
  }
  if (/\[[^\]]+\]/.test(expr)) throw apiError('Formula contem referencia de coluna sem agregacao suportada.', 400);
  return restoreCompiledDaxMeasureTokens(expr, context);
}

function tablesUsedInDaxExpression(formula) {
  const text = String(formula || '');
  let variableProgram = null;
  try { variableProgram = parseDaxVariableProgram(text); } catch (err) {}
  const localVariables = new Set((variableProgram && variableProgram.declarations || []).map((item) => daxVariableKey(item.name)));
  const tables = [];
  const add = (table) => {
    const value = (typeof normalizeTableName === 'function' ? normalizeTableName : function(s) { return String(s || '').trim(); })(table);
    if (value && !tables.includes(value)) tables.push(value);
  };
  let m;
  const colRe = /(?:'([^']+)'|([A-Za-z_\u00C0-\u00FF][A-Za-z0-9_\u00C0-\u00FF .-]*?))\s*\[\s*([^\]]+)\s*\]/g;
  while ((m = colRe.exec(text))) add(m[1] || m[2]);
  const rowRe = /COUNTROWS\s*\(\s*(?:'([^']+)'|([^\)]+?))\s*\)/gi;
  while ((m = rowRe.exec(text))) {
    const candidate = String(m[1] || m[2] || '').trim();
    if (!candidate || parseDaxTableConstructorExpression(candidate) || localVariables.has(daxVariableKey(candidate))) continue;
    add(candidate);
  }
  const filteredIteratorRe = /(SUMX|AVERAGEX|COUNTX|MAXX|MINX|CONCATENATEX)\s*\(\s*FILTER\s*\(\s*(?:'([^']+)'|([^,\)]+))/gi;
  while ((m = filteredIteratorRe.exec(text))) add(m[2] || m[3]);
  const iteratorRe = /(SUMX|AVERAGEX|COUNTX|MAXX|MINX|CONCATENATEX)\s*\((?!\s*(?:FILTER|VALUES|DISTINCT|KEEPFILTERS)\s*\()\s*(?:'([^']+)'|([^,\)]+))/gi;
  while ((m = iteratorRe.exec(text))) add(m[2] || m[3]);
  const filterRe = /(FILTER|ALL|ALLEXCEPT|ALLSELECTED)\s*\(\s*(?:'([^']+)'|([^,\[\)]+))/gi;
  while ((m = filterRe.exec(text))) add(m[2] || m[3]);
  const dateRe = /(DATESYTD|DATESMTD|DATESQTD|DATESBETWEEN|TOTALYTD|SAMEPERIODLASTYEAR|DATEADD|PREVIOUSMONTH|PREVIOUSQUARTER|PREVIOUSYEAR|NEXTMONTH|NEXTQUARTER|NEXTYEAR|PARALLELPERIOD)\s*\(\s*(?:'([^']+)'|([^,\[\)]+))/gi;
  while ((m = dateRe.exec(text))) add(m[2] || m[3]);
  return tables;
}

function columnsUsedInDaxExpression(formula) {
  const text = String(formula || '');
  const out = [];
  const seen = new Set();
  let m;
  const colRe = /(?:'([^']+)'|([A-Za-z_\u00C0-\u00FF][A-Za-z0-9_\u00C0-\u00FF .-]*?))\s*\[\s*([^\]]+)\s*\]/g;
  while ((m = colRe.exec(text))) {
    const table = String(m[1] || m[2] || '').trim();
    const column = String(m[3] || '').trim();
    const key = table + '::' + column;
    if (table && column && !seen.has(key)) {
      seen.add(key);
      out.push({ table, column });
    }
  }
  return out;
}


const SUPPORTED_DAX_FUNCTIONS = new Set([
  'SUM', 'AVERAGE', 'AVG', 'MIN', 'MAX', 'COUNT', 'DISTINCTCOUNT', 'COUNTROWS',
  'DIVIDE', 'CALCULATE', 'SUMX', 'AVERAGEX', 'COUNTX', 'SELECTEDVALUE', 'COALESCE',
  'IF', 'SWITCH', 'TRUE', 'FALSE', 'BLANK', 'ISBLANK', 'ALL', 'ALLEXCEPT', 'ALLSELECTED',
  'VALUES', 'DISTINCT', 'HASONEVALUE', 'RELATED', 'FILTER', 'KEEPFILTERS',
  'RANKX', 'TOPN', 'DATESYTD', 'DATESMTD', 'DATESQTD', 'TOTALYTD',
  'SAMEPERIODLASTYEAR', 'DATEADD', 'DATESBETWEEN',
  'PREVIOUSMONTH', 'PREVIOUSQUARTER', 'PREVIOUSYEAR',
  'NEXTMONTH', 'NEXTQUARTER', 'NEXTYEAR', 'PARALLELPERIOD',
  'CONCATENATE', 'CONCATENATEX', 'MAXX', 'MINX',
  'ISFILTERED', 'ISCROSSFILTERED', 'FORMAT'
]);

function daxFunctionNames(formula) {
  const found = [];
  const seen = new Set();
  const re = /\b([A-Z_][A-Z0-9_]*)\s*\(/gi;
  let m;
  while ((m = re.exec(String(formula || '')))) {
    const name = String(m[1] || '').toUpperCase();
    if (!seen.has(name)) { seen.add(name); found.push(name); }
  }
  return found;
}

function unsupportedDaxFunctions(formula) {
  return daxFunctionNames(formula).filter((name) => !SUPPORTED_DAX_FUNCTIONS.has(name));
}

function daxMeasureReferences(formula, model) {
  const text = String(formula || '');
  const iteratorColumns = daxIteratorRowColumnNames(text);
  const measureLookup = model && Array.isArray(model.measures) ? buildMeasureLookup(model) : null;
  const refs = [];
  const seen = new Set();
  const re = /(^|[^A-Za-z0-9_\u00C0-\u00FF\]'\"])[\[]\s*([^\]]+)\s*[\]]/g;
  let m;
  while ((m = re.exec(text))) {
    const name = String(m[2] || '').trim();
    const key = normalizeMeasureNameKey(name);
    if (iteratorColumns.has(key) && !(measureLookup && measureLookup.has(key))) continue;
    if (name && !seen.has(name)) { seen.add(name); refs.push(name); }
  }
  return refs;
}

function daxIteratorRowColumnNames(formula) {
  const text = String(formula || '');
  const names = new Set();
  const callRe = /(SUMX|AVERAGEX|COUNTX|MAXX|MINX|CONCATENATEX)\s*\(/gi;
  let call;
  while ((call = callRe.exec(text))) {
    let pos = callRe.lastIndex;
    let depth = 1;
    let single = false;
    let double = false;
    while (pos < text.length && depth > 0) {
      const ch = text[pos];
      const prev = text[pos - 1];
      if (ch === "'" && !double && prev !== '\\') single = !single;
      else if (ch === '"' && !single && prev !== '\\') double = !double;
      else if (!single && !double && ch === '(') depth += 1;
      else if (!single && !double && ch === ')') depth -= 1;
      pos += 1;
    }
    if (depth !== 0) continue;
    const args = splitTopLevelArgs(text.slice(callRe.lastIndex, pos - 1));
    if (args.length < 2) continue;
    const rowExpression = args.slice(1).join(', ');
    const columnRe = /(^|[^A-Za-z0-9_\u00C0-\u00FF\]'])\[\s*([^\]]+)\s*\]/g;
    let column;
    while ((column = columnRe.exec(rowExpression))) names.add(normalizeMeasureNameKey(column[2]));
    callRe.lastIndex = pos;
  }
  return names;
}

function normalizeMeasureNameKey(name) {
  return sanitizeAlias(name, 'medida').toLowerCase();
}

function buildMeasureLookup(model) {
  const map = new Map();
  for (const measure of Array.isArray(model && model.measures) ? model.measures : []) {
    const names = [measure.name, measure.displayName].filter(Boolean);
    for (const name of names) {
      const key = normalizeMeasureNameKey(name);
      if (key && !map.has(key)) map.set(key, measure);
    }
  }
  return map;
}

function tablesUsedByMeasureWithDependencies(measure, model, stack = []) {
  const out = [];
  const seenTables = new Set();
  const addTable = (table) => {
    const value = String(table || '').trim();
    const key = (typeof normalizeTableKey === 'function' ? normalizeTableKey : function(s) { return String(s || '').trim().toLowerCase(); })(value);
    if (value && !seenTables.has(key)) {
      seenTables.add(key);
      out.push(value);
    }
  };
  const lookup = buildMeasureLookup(model || {});
  const visit = (item, path = stack.slice()) => {
    if (!item) return;
    const key = normalizeMeasureNameKey(item.name || item.displayName);
    if (key && path.includes(key)) return;
    const nextPath = key ? [...path, key] : path;
    const formula = String(item.formula || '').trim();
    tablesUsedInDaxExpression(formula).forEach(addTable);
    daxMeasureReferences(formula, model).forEach((name) => {
      const dep = lookup.get(normalizeMeasureNameKey(name));
      if (dep) visit(dep, nextPath);
    });
  };
  visit(measure);
  return out;
}

function replaceDaxMeasureReferences(expr, aliases, context = {}) {
  const model = context.model;
  if (!model || !Array.isArray(model.measures)) return expr;
  const lookup = context.measureLookup || buildMeasureLookup(model);
  return String(expr || '').replace(/(^|[^A-Za-z0-9_\u00C0-\u00FF\]'\"])[\[]\s*([^\]]+)\s*[\]]/g, (full, prefix, name) => {
    const key = normalizeMeasureNameKey(name);
    const measure = lookup.get(key);
    if (!measure) return full;
    const projected = projectedDaxMeasureReferenceSql(measure, context);
    if (projected) return prefix + compiledDaxMeasureToken(measure, projected, context);
    const preAggregated = compilePreAggregatedDaxMeasureReference(measure, aliases, { ...context, measureLookup: lookup });
    if (preAggregated) return prefix + compiledDaxMeasureToken(measure, preAggregated, context);
    const compiled = compileReferencedDaxMeasure(measure, aliases, { ...context, measureLookup: lookup });
    // O marcador permanece opaco ate a formula externa terminar de compilar.
    // Isso impede crescimento exponencial do SQL em cadeias de medidas.
    return prefix + compiledDaxMeasureToken(measure, compiled, context);
  });
}

function daxSemanticPlanSummary(formula, model, measure = null) {
  const text = String(formula || '').trim();
  const program = parseDaxVariableProgram(text);
  const iterator = parseDaxValuesIterator(text);
  const returnText = program ? program.returnExpression.expression.text : text;
  const declarations = Array.isArray(program && program.declarations) ? program.declarations : [];
  const variableNames = new Map(declarations.map((item) => [daxVariableKey(item.name), item]));
  const variableReferences = [];
  const seenVariableReferences = new Set();
  for (const token of tokenizeDaxSemantic(returnText)) {
    if (token.type !== 'identifier') continue;
    const declaration = variableNames.get(daxVariableKey(token.value));
    if (!declaration || seenVariableReferences.has(declaration.name)) continue;
    seenVariableReferences.add(declaration.name);
    variableReferences.push(declaration.name);
  }
  const nodes = new Set();
  if (program) {
    nodes.add('DaxProgram');
    nodes.add('VariableDeclaration');
    nodes.add('ReturnExpression');
  }
  declarations.forEach((item) => nodes.add(item.value && item.value.type || 'Expression'));
  daxFunctionNames(text).forEach((name) => nodes.add(name));
  if (variableReferences.length) nodes.add('VariableReference');
  if (columnsUsedInDaxExpression(text).length) nodes.add('ColumnReference');
  if (daxMeasureReferences(text, model).length) nodes.add('MeasureReference');
  if (tokenizeDaxSemantic(returnText).some((token) => token.type === 'keyword' && token.upper === 'IN')) nodes.add('IN');
  if (/\*/.test(returnText)) nodes.add('Multiply');
  if (tokenizeDaxSemantic(text).some((token) => token.type === 'number')) nodes.add('NumericLiteral');
  const measureReferences = daxMeasureReferences(text, model).map(function(name) {
    return { type: 'MeasureReference', name, resultType: 'measure-scalar' };
  });
  const aggregationPlan = measure ? daxMeasureAggregationPlan(measure, model || {}) : null;
  return {
    ast: {
      type: program ? program.type : 'Expression',
      declarations: declarations.map((item) => ({
        type: item.type,
        name: item.name,
        valueType: item.valueType,
        nodeType: item.value && item.value.type || 'Expression',
        rows: item.value && Array.isArray(item.value.rows) ? item.value.rows.length : undefined
      })),
      returnType: iterator ? 'IteratorAggregate' : 'ScalarExpression'
    },
    symbols: declarations.map((item) => ({ name: item.name, type: item.valueType, scope: 'measure' })),
    variableReferences,
    measureReferences,
    nodes: Array.from(nodes),
    aggregationPlan,
    logicalPlan: aggregationPlan && aggregationPlan.requiresPostAggregateProjection ? {
      type: 'PostAggregateProjection',
      aggregationLevel: aggregationPlan.aggregationLevel,
      strategy: 'materialized-dependency-dag'
    } : iterator ? {
      type: 'IteratorAggregate',
      iterator: iterator.functionName,
      source: iterator.tableFunction,
      table: iterator.table,
      column: iterator.column,
      contextTransition: iterator.contextTransition,
      strategy: 'grouped-two-level-set-based'
    } : {
      type: 'ScalarExpression',
      strategy: 'single-query'
    }
  };
}

function analyzeDaxMeasure(measure, model) {
  const formula = String(measure && measure.formula || '').trim();
  const references = daxMeasureReferences(formula, model);
  const lookup = buildMeasureLookup(model || {});
  const missingDependencies = references.filter((name) => !lookup.has(normalizeMeasureNameKey(name)));
  const unsupportedFunctions = unsupportedDaxFunctions(formula);
  const tables = tablesUsedInDaxExpression(formula);
  const columns = columnsUsedInDaxExpression(formula);
  const result = {
    table: measure && measure.table || '',
    name: measure && (measure.displayName || measure.name) || '',
    formula: formula ? true : false,
    status: 'pendente',
    dependencies: references,
    missingDependencies,
    unsupportedFunctions,
    tables,
    columns,
    message: ''
  };
  if (!formula) {
    result.status = 'sem_formula';
    result.message = 'Medida importada sem fórmula DAX extraída.';
    return result;
  }
  if (missingDependencies.length) {
    result.status = 'dependencia_ausente';
    result.message = 'Dependência ausente: ' + missingDependencies.join(', ');
    return result;
  }
  if (unsupportedFunctions.length) {
    result.status = 'funcao_nao_suportada';
    result.message = 'Função DAX ainda não suportada: ' + unsupportedFunctions.join(', ');
    return result;
  }
  try {
    const allTables = Array.from(new Set([...tables, ...Array.from(lookup.values()).flatMap((m) => tablesUsedInDaxExpression(m.formula || ''))])).filter(Boolean);
    const aliases = new Map(allTables.map((table, idx) => [table, 't' + idx]));
    const valuesIterator = parseDaxValuesIterator(formula);
    const formulaToCompile = valuesIterator ? valuesIterator.expression : formula;
    compileDaxExpression(formulaToCompile, aliases, {
      model,
      measureLookup: lookup,
      currentMeasure: measure.name,
      stack: [normalizeMeasureNameKey(measure.name || measure.displayName)],
      daxVariables: valuesIterator ? valuesIterator.variableScope : undefined
    });
    result.semanticPlan = daxSemanticPlanSummary(formula, model, measure);
    result.status = references.length ? 'ok_com_dependencia' : 'ok';
    result.message = references.length ? 'Medida válida com dependência entre medidas.' : 'Medida válida para execução.';
  } catch (err) {
    result.status = 'erro_conversao';
    result.message = err.message || 'Erro ao converter medida DAX.';
  }
  return result;
}

function daxMeasureDiagnostics(model) {
  const measures = Array.isArray(model && model.measures) ? model.measures : [];
  const items = measures.map((measure) => analyzeDaxMeasure(measure, model));
  const byStatus = items.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {});
  const functionCount = {};
  const dependencyEdges = [];
  for (const measure of measures) {
    for (const fn of daxFunctionNames(measure.formula || '')) functionCount[fn] = (functionCount[fn] || 0) + 1;
    for (const dep of daxMeasureReferences(measure.formula || '', model)) dependencyEdges.push({ from: measure.displayName || measure.name || '', to: dep });
  }
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    total: measures.length,
    withFormula: measures.filter((m) => String(m.formula || '').trim()).length,
    pendingFormula: measures.filter((m) => !String(m.formula || '').trim()).length,
    byStatus,
    dependencyEdges,
    functions: Object.entries(functionCount).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count, supported: SUPPORTED_DAX_FUNCTIONS.has(name) })),
    items
  };
}

function daxDiagnosticSnippet(formula, diagnostic) {
  const source = String(formula || '');
  const unsupported = diagnostic && Array.isArray(diagnostic.unsupportedFunctions) && diagnostic.unsupportedFunctions[0];
  let index = unsupported ? source.toUpperCase().indexOf(String(unsupported).toUpperCase() + '(') : -1;
  if (index < 0 && diagnostic && diagnostic.message) {
    const functionName = String(diagnostic.message).match(/(?:Função DAX ainda não suportada|Funcao DAX ainda nao suportada):\s*([A-Z0-9_.]+)/i);
    if (functionName) index = source.toUpperCase().indexOf(functionName[1].toUpperCase());
  }
  if (index < 0) return { position: null, snippet: source.slice(0, 180).trim() };
  return {
    position: index + 1,
    snippet: source.slice(Math.max(0, index - 35), Math.min(source.length, index + 145)).trim()
  };
}

function modelTableNameSet(model) {
  const names = new Set([normalizeTableKey(CALENDAR_TABLE_NAME)]);
  (Array.isArray(model && model.tables) ? model.tables : []).forEach((item) => {
    const name = normalizeTableName(typeof item === 'string' ? item : item && item.name);
    if (name) names.add(normalizeTableKey(name));
  });
  (Array.isArray(model && model.relationships) ? model.relationships : []).forEach((rel) => {
    [rel && rel.fromTable, rel && rel.toTable].forEach((name) => {
      const normalized = normalizeTableName(name);
      if (normalized) names.add(normalizeTableKey(normalized));
    });
  });
  return names;
}

async function validateDaxMeasureForModel(measure, model) {
  const diagnostic = analyzeDaxMeasure(measure, model);
  if (['ok', 'ok_com_dependencia'].includes(diagnostic.status)) {
    const knownTables = modelTableNameSet(model);
    const missingTables = (diagnostic.tables || []).filter((table) => !knownTables.has(normalizeTableKey(table)));
    if (missingTables.length) {
      diagnostic.status = 'tabela_ausente';
      diagnostic.message = 'Tabela não encontrada no modelo: ' + missingTables.join(', ');
      diagnostic.missingTables = missingTables;
    }
  }

  if (['ok', 'ok_com_dependencia'].includes(diagnostic.status)) {
    for (const reference of diagnostic.columns || []) {
      let knownColumns = null;
      if (sameTableName(reference.table, CALENDAR_TABLE_NAME)) {
        knownColumns = calendarColumnNames();
      } else {
        try {
          const savedTransform = await findTransformByName(reference.table);
          if (savedTransform && savedTransform.daxExpression) {
            const calculatedMeta = await ensureDaxCalculatedTableView(savedTransform);
            knownColumns = (calculatedMeta.columns || []).map((column) => column && (column.name || column.Field) || column).filter(Boolean);
          } else if (savedTransform) {
            const built = await buildTransformSql(savedTransform, { limit: 0 });
            knownColumns = (built.columns || []).map((column) => column && (column.name || column.Field) || column).filter(Boolean);
          } else {
            const rawLookup = await getRawPgMetaForLogicalTable(reference.table);
            if (rawLookup && rawLookup.meta && Array.isArray(rawLookup.meta.columns)) {
              knownColumns = rawLookup.meta.columns.map((column) => column && (column.name || column.Field) || column).filter(Boolean);
            }
          }
        } catch (err) {
          knownColumns = null;
        }
      }
      if (knownColumns && knownColumns.length && !knownColumns.some((column) => normalizeColumnNameForMatch(column) === normalizeColumnNameForMatch(reference.column))) {
        diagnostic.status = 'coluna_ausente';
        diagnostic.message = 'Coluna não encontrada: ' + reference.table + '[' + reference.column + ']';
        diagnostic.missingColumn = reference;
        break;
      }
    }
  }

  const location = daxDiagnosticSnippet(measure && measure.formula, diagnostic);
  diagnostic.valid = ['ok', 'ok_com_dependencia'].includes(diagnostic.status);
  diagnostic.position = location.position;
  diagnostic.snippet = location.snippet;
  diagnostic.validatedAt = new Date().toISOString();
  diagnostic.displayMessage = diagnostic.valid
    ? 'A medida “' + diagnostic.name + '” foi compilada com sucesso.'
    : 'Não foi possível salvar a medida “' + diagnostic.name + '”.\n\n' + diagnostic.message
      + (diagnostic.position ? '\n\nPosição: ' + diagnostic.position : '')
      + (diagnostic.snippet ? '\n\nTrecho:\n' + diagnostic.snippet : '');
  return diagnostic;
}

function daxMeasureDependencyOrder(model, selectedName = '') {
  const measures = Array.isArray(model && model.measures) ? model.measures : [];
  const lookup = buildMeasureLookup(model || {});
  const selectedKey = String(selectedName || '').trim() ? normalizeMeasureNameKey(selectedName) : '';
  const roots = selectedKey && lookup.has(selectedKey) ? [lookup.get(selectedKey)] : measures;
  const visited = new Set();
  const visiting = new Set();
  const ordered = [];
  function visit(measure) {
    const key = normalizeMeasureNameKey(measure && (measure.name || measure.displayName));
    if (!key || visited.has(key)) return;
    if (visiting.has(key)) return;
    visiting.add(key);
    daxMeasureReferences(measure.formula || '', model).forEach((name) => {
      const dependency = lookup.get(normalizeMeasureNameKey(name));
      if (dependency) visit(dependency);
    });
    visiting.delete(key);
    visited.add(key);
    ordered.push(measure);
  }
  roots.forEach(visit);
  return ordered;
}

function daxMeasureAggregationPlan(measure, model, memo = new Map(), visiting = new Set()) {
  const lookup = buildMeasureLookup(model || {});
  const key = normalizeMeasureNameKey(measure && (measure.name || measure.displayName));
  if (!key) return null;
  if (memo.has(key)) return memo.get(key);
  if (visiting.has(key)) {
    throw apiError('Dependencia circular entre medidas DAX: ' + [...visiting, key].join(' -> '), 400);
  }
  visiting.add(key);
  const dependencyNames = daxMeasureReferences(measure.formula || '', model || {});
  const dependencies = dependencyNames.map(function(name) {
    const dependency = lookup.get(normalizeMeasureNameKey(name));
    if (!dependency) return { name, key: normalizeMeasureNameKey(name), missing: true };
    return daxMeasureAggregationPlan(dependency, model, memo, visiting);
  }).filter(Boolean);
  let valuesIterator = null;
  try { valuesIterator = parseDaxValuesIterator(measure.formula || ''); } catch (error) { valuesIterator = null; }
  const dependsOnMaterializedLevel = !valuesIterator && dependencies.some(function(dependency) {
    return dependency.directValuesIterator || dependency.requiresPostAggregateProjection;
  });
  const dependencyLevel = dependencies.reduce(function(maximum, dependency) {
    return Math.max(maximum, Number(dependency.aggregationLevel) || 0);
  }, 0);
  const aggregateFunctions = daxFunctionNames(measure.formula || '').filter(function(name) {
    return ['SUM', 'AVERAGE', 'AVG', 'MIN', 'MAX', 'COUNT', 'DISTINCTCOUNT', 'COUNTROWS', 'SUMX', 'AVERAGEX', 'COUNTX', 'MAXX', 'MINX'].includes(name);
  });
  const plan = {
    type: 'MeasurePlan',
    name: measure.name || measure.displayName || '',
    key,
    resultType: 'measure-scalar',
    directValuesIterator: Boolean(valuesIterator),
    requiresPostAggregateProjection: Boolean(dependsOnMaterializedLevel),
    aggregationLevel: valuesIterator
      ? Math.max(2, dependencyLevel + 1)
      : (dependsOnMaterializedLevel ? Math.max(2, dependencyLevel + 1) : Math.max(1, dependencyLevel)),
    executionKind: valuesIterator
      ? 'iterator-aggregate'
      : (dependsOnMaterializedLevel ? 'post-aggregate-projection' : (dependencyNames.length ? 'aggregate-expression' : (aggregateFunctions.length ? 'aggregate-scalar' : 'scalar-expression'))),
    aggregateFunctions,
    dependencies: dependencies.map(function(dependency) {
      return { type: 'MeasureReference', name: dependency.name, key: dependency.key, aggregationLevel: dependency.aggregationLevel, executionKind: dependency.executionKind };
    })
  };
  visiting.delete(key);
  memo.set(key, plan);
  return plan;
}

function collectDaxPostAggregateExecutionMeasures(measure, model, output = new Map(), planMemo = new Map()) {
  const lookup = buildMeasureLookup(model || {});
  const plan = daxMeasureAggregationPlan(measure, model, planMemo);
  if (!plan || !plan.requiresPostAggregateProjection) {
    if (measure) output.set(normalizeMeasureNameKey(measure.name || measure.displayName), measure);
    return output;
  }
  daxMeasureReferences(measure.formula || '', model || {}).forEach(function(name) {
    const dependency = lookup.get(normalizeMeasureNameKey(name));
    if (!dependency) return;
    const dependencyPlan = daxMeasureAggregationPlan(dependency, model, planMemo);
    if (dependencyPlan && dependencyPlan.requiresPostAggregateProjection) {
      collectDaxPostAggregateExecutionMeasures(dependency, model, output, planMemo);
    } else {
      output.set(normalizeMeasureNameKey(dependency.name || dependency.displayName), dependency);
    }
  });
  return output;
}

function buildModelSql(model, limit) {
  const selectedColumns = Array.isArray(model.selectedColumns) ? model.selectedColumns : [];
  const relationships = Array.isArray(model.relationships) ? model.relationships.filter((rel) => rel && rel.active !== false) : [];
  const measures = Array.isArray(model.measures) ? model.measures.filter((measure) => String(measure.formula || '').trim()) : [];
  if (!selectedColumns.length && !measures.length) throw apiError('Selecione colunas ou crie pelo menos uma medida para gerar o relatorio.', 400);
  const measureLookup = buildMeasureLookup(model);
  const parsedMeasures = measures.map((measure) => {
    const diag = analyzeDaxMeasure(measure, model);
    if (!['ok', 'ok_com_dependencia'].includes(diag.status)) throw apiError('Medida DAX não compilável: ' + (measure.displayName || measure.name) + ' - ' + diag.message, 400);
    return { ...measure, tables: tablesUsedByMeasureWithDependencies(measure, model) };
  });
  const baseTable = (selectedColumns[0] && selectedColumns[0].table) || (parsedMeasures[0] && parsedMeasures[0].tables[0]) || (relationships[0] && relationships[0].fromTable);
  if (!baseTable) throw apiError('Nao foi possivel identificar a tabela principal do modelo.', 400);

  const tableOrder = [baseTable];
  for (const item of selectedColumns) if (!tableOrder.includes(item.table)) tableOrder.push(item.table);
  for (const rel of relationships) {
    if (!tableOrder.includes(rel.fromTable)) tableOrder.push(rel.fromTable);
    if (!tableOrder.includes(rel.toTable)) tableOrder.push(rel.toTable);
  }
  for (const item of parsedMeasures) for (const table of item.tables || []) if (table && !tableOrder.includes(table)) tableOrder.push(table);

  const aliases = new Map(tableOrder.map((table, idx) => [table, 't' + idx]));
  const selectParts = [];
  const groupParts = [];
  for (const item of selectedColumns) {
    const alias = aliases.get(item.table);
    const expr = `${alias}.${quoteIdent(item.column)}`;
    selectParts.push(`${expr} AS ${quoteIdent(item.alias || item.column)}`);
    groupParts.push(expr);
  }
  for (const item of parsedMeasures) {
    selectParts.push(`${compileDaxExpression(item.formula, aliases, { model, measureLookup, currentMeasure: item.name, stack: [normalizeMeasureNameKey(item.name || item.displayName)] })} AS ${quoteIdent(item.name)}`);
  }
  let sql = `SELECT\n  ${selectParts.join(',\n  ')}\nFROM ${quoteIdent(baseTable)} ${aliases.get(baseTable)}`;
  const joined = new Set([baseTable]);
  const pending = relationships.slice();
  let progressed = true;
  while (pending.length && progressed) {
    progressed = false;
    for (let idx = pending.length - 1; idx >= 0; idx -= 1) {
      const rel = pending[idx];
      const leftJoined = joined.has(rel.fromTable);
      const rightJoined = joined.has(rel.toTable);
      if (!leftJoined && !rightJoined) continue;
      if (leftJoined && rightJoined) { pending.splice(idx, 1); continue; }
      const joinTable = leftJoined ? rel.toTable : rel.fromTable;
      const leftTable = leftJoined ? rel.fromTable : rel.toTable;
      const leftColumn = leftJoined ? rel.fromColumn : rel.toColumn;
      const rightColumn = leftJoined ? rel.toColumn : rel.fromColumn;
      const joinType = rel.joinType === 'INNER' ? 'INNER JOIN' : 'LEFT JOIN';
      sql += `
${joinType} ${quoteIdent(joinTable)} ${aliases.get(joinTable)} ON ${aliases.get(leftTable)}.${quoteIdent(leftColumn)} = ${aliases.get(joinTable)}.${quoteIdent(rightColumn)}`;
      joined.add(joinTable);
      pending.splice(idx, 1);
      progressed = true;
    }
  }
  const requiredTables = Array.from(new Set([
    ...selectedColumns.map((item) => item.table),
    ...parsedMeasures.flatMap((item) => item.tables || [])
  ].filter(Boolean)));
  const missingJoins = requiredTables.filter((table) => !joined.has(table));
  if (missingJoins.length) throw apiError('Modelo incompleto: faltam relacionamentos para ligar ' + missingJoins.join(', ') + ' a ' + baseTable + '.', 400);
  if (groupParts.length && parsedMeasures.length) sql += `\nGROUP BY ${groupParts.join(', ')}`;
  const safeLimit = clampLimit(limit, 200);
  sql += `\nLIMIT ${safeLimit}`;
  return sql;
}


function isPlaceholderSql(sql) {
  const text = String(sql || '').trim();
  if (!text) return true;
  return /^SELECT\s+0\s+AS\s+/i.test(text) || /placeholder/i.test(text);
}

function relationshipGraphSummary(model) {
  const tables = (Array.isArray(model.tables) ? model.tables : []).map((item) => typeof item === 'string' ? item : item && item.name).filter(Boolean);
  const graph = new Map(tables.map((name) => [name, new Set()]));
  for (const rel of model.relationships || []) {
    if (!rel || rel.active === false) continue;
    if (!graph.has(rel.fromTable)) graph.set(rel.fromTable, new Set());
    if (!graph.has(rel.toTable)) graph.set(rel.toTable, new Set());
    graph.get(rel.fromTable).add(rel.toTable);
    graph.get(rel.toTable).add(rel.fromTable);
  }
  const visited = new Set();
  const components = [];
  for (const table of graph.keys()) {
    if (visited.has(table)) continue;
    const stack = [table];
    const component = [];
    visited.add(table);
    while (stack.length) {
      const current = stack.pop();
      component.push(current);
      for (const next of graph.get(current) || []) {
        if (!visited.has(next)) {
          visited.add(next);
          stack.push(next);
        }
      }
    }
    components.push(component.sort());
  }
  components.sort((a, b) => b.length - a.length);
  return {
    components: components.length,
    disconnectedTables: components.length > 1 ? components.slice(1).flat().slice(0, 30) : [],
    largestComponentSize: components[0] ? components[0].length : 0
  };
}

function reportModelDiagnostics(model, reports) {
  const allReports = Array.isArray(reports) ? reports : [];
  const visuals = allReports.flatMap((report) => Array.isArray(report.visuals) ? report.visuals : []);
  const pages = allReports.flatMap((report) => Array.isArray(report.pages) ? report.pages : []);
  const onlineFilters = allReports.flatMap((report) => Array.isArray(report.onlineFilters) ? normalizeOnlineFilters(report.onlineFilters) : []);
  const placeholderReports = allReports.filter((report) => isPlaceholderSql(report.sql)).length;
  const placeholderVisuals = visuals.filter((visual) => isPlaceholderSql(visual.sql)).length;
  const measures = Array.isArray(model.measures) ? model.measures : [];
  const measuresWithFormula = measures.filter((m) => String(m.formula || '').trim()).length;
  const measureDiag = daxMeasureDiagnostics(model);
  const missingFormulaSamples = measures.filter((m) => !String(m.formula || '').trim()).slice(0, 15).map((m) => ({
    table: m.table || '',
    name: m.displayName || m.name || ''
  }));
  const graph = relationshipGraphSummary(model);
  const relationshipWarnings = (model.relationships || []).filter((rel) => rel.fromTable === rel.toTable || rel.fromColumn === rel.toColumn && rel.fromTable === rel.toTable).slice(0, 10);
  const onlineFiltersWithoutTable = onlineFilters.filter((filter) => !filter.table || !filter.field).length;
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    source: model.source || '',
    model: {
      tables: Array.isArray(model.tables) ? model.tables.length : 0,
      selectedColumns: Array.isArray(model.selectedColumns) ? model.selectedColumns.length : 0,
      relationships: Array.isArray(model.relationships) ? model.relationships.length : 0,
      measures: measures.length,
      measuresWithFormula,
      measuresPendingFormula: Math.max(0, measures.length - measuresWithFormula),
      measuresOk: Number(measureDiag.byStatus.ok || 0) + Number(measureDiag.byStatus.ok_com_dependencia || 0),
      measuresWithDependencies: Number(measureDiag.byStatus.ok_com_dependencia || 0),
      measuresUnsupported: Number(measureDiag.byStatus.funcao_nao_suportada || 0),
      measuresConversionErrors: Number(measureDiag.byStatus.erro_conversao || 0),
      relationshipComponents: graph.components,
      largestRelationshipComponent: graph.largestComponentSize,
      disconnectedTables: graph.disconnectedTables
    },
    reports: {
      count: allReports.length,
      pages: pages.length,
      visuals: visuals.length,
      onlineFilters: onlineFilters.length,
      onlineFiltersWithoutTable,
      placeholderReports,
      placeholderVisuals
    },
    warnings: [
      ...(placeholderReports || placeholderVisuals ? ['Ainda existem SQLs placeholder importados do PBIX. Substitua por consultas reais antes de comparar com o Power BI.'] : []),
      ...(measures.length && measuresWithFormula < measures.length ? ['Existem medidas importadas sem fórmula DAX extraída. Elas foram preservadas no modelo, mas não entram na geração SQL até receberem fórmula.'] : []),
      ...(Number(measureDiag.byStatus.funcao_nao_suportada || 0) ? ['Existem medidas com funções DAX ainda não suportadas. Use o diagnóstico de medidas para priorizar a recriação.'] : []),
      ...(Number(measureDiag.byStatus.erro_conversao || 0) ? ['Existem medidas com erro de conversão SQL. Elas ficam preservadas, mas não entram no SQL do modelo até ajuste.'] : []),
      ...(!Array.isArray(model.relationships) || !model.relationships.length ? ['O modelo ainda não possui relacionamentos. Filtros entre tabelas não se comportarão como no Power BI.'] : []),
      ...(graph.components > 1 ? ['O modelo possui tabelas desconectadas. Crie relacionamentos ou remova tabelas que não fazem parte do mesmo modelo analítico.'] : []),
      ...(onlineFiltersWithoutTable ? ['Existem filtros online sem tabela/campo definidos. Eles podem aparecer na tela, mas não conseguem filtrar consultas.'] : []),
      ...(relationshipWarnings.length ? ['Existem relacionamentos suspeitos apontando para a mesma tabela/coluna. Revise antes de publicar.'] : [])
    ],
    missingFormulaSamples,
    measureStatus: measureDiag.byStatus,
    measureFunctionSamples: measureDiag.functions.slice(0, 20),
    relationshipWarningSamples: relationshipWarnings
  };
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value || 0))));
}

function readinessLevel(score) {
  if (score >= 85) return 'pronto';
  if (score >= 65) return 'atencao';
  return 'critico';
}

function summarizePostgresCacheStatus(caches, connected, error) {
  const items = (Array.isArray(caches) ? caches : []).filter((cache) => cache && cache.exists !== false);
  const timestampValues = (field) => items
    .map((cache) => cache && cache[field] ? new Date(cache[field]).getTime() : 0)
    .filter((value) => Number.isFinite(value) && value > 0);
  const syncedTimes = timestampValues('syncedAt');
  const dataUpdateTimes = timestampValues('lastDataUpdateAt');
  return {
    connected: Boolean(connected),
    cacheCount: items.length,
    rowCount: items.reduce((total, cache) => total + Math.max(0, Number(cache.rowCount || 0)), 0),
    lastSyncAt: syncedTimes.length ? new Date(Math.max.apply(null, syncedTimes)).toISOString() : null,
    lastDataUpdateAt: dataUpdateTimes.length ? new Date(Math.max.apply(null, dataUpdateTimes)).toISOString() : null,
    error: String(error || '')
  };
}

async function powerBiReadinessDiagnostics() {
  const model = await readSemanticModel();
  const reports = await readReports();
  const settings = getSettings();
  const modelDiag = reportModelDiagnostics(model, reports);
  const reportsCount = Number(modelDiag.reports.count || 0);
  const visualsTotal = Number(modelDiag.reports.visuals || 0);
  const placeholderTotal = Number(modelDiag.reports.placeholderReports || 0) + Number(modelDiag.reports.placeholderVisuals || 0);
  const measuresTotal = Number(modelDiag.model.measures || 0);
  const measuresPending = Number(modelDiag.model.measuresPendingFormula || 0);
  const relationships = Number(modelDiag.model.relationships || 0);
  const selectedColumns = Number(modelDiag.model.selectedColumns || 0);
  const onlineUsers = effectiveOnlineUsers(settings);
  let pgSummary = { connected: false, cacheCount: 0, rowCount: 0, error: '' };
  if (postgresCacheAvailable()) {
    try {
      await ensurePgCacheSchema();
      const caches = await listPgCacheStatus();
      pgSummary = summarizePostgresCacheStatus(caches, true, '');
    } catch (err) {
      pgSummary = summarizePostgresCacheStatus([], false, err && err.message ? err.message : 'PostgreSQL cache indisponivel');
    }
  }

  const defaultSecret = !process.env.BIWA_AUTH_SECRET && !process.env.SYNC_TOKEN;
  const defaultPasswords = [
    settings.access && settings.access.adminPassword,
    settings.access && settings.access.viewerPassword
  ].some((value) => /TROQUE|CHANGE|senha/i.test(String(value || '')));
  const placeholderRatio = visualsTotal ? placeholderTotal / visualsTotal : (placeholderTotal ? 1 : 0);
  const measurePendingRatio = measuresTotal ? measuresPending / measuresTotal : 0;
  const penalties = {
    placeholders: Math.round(Math.min(35, placeholderRatio * 35)),
    measures: Math.round(Math.min(25, measurePendingRatio * 25)),
    relationships: relationships ? 0 : (selectedColumns > 1 || modelDiag.model.tables > 1 ? 18 : 8),
    realtime: REALTIME_EVENT_TABLE ? 0 : 10,
    security: (defaultSecret ? 8 : 0) + (defaultPasswords ? 8 : 0) + (ONLINE_ALLOW_OPEN_ACCESS ? 10 : 0),
    cache: POSTGRES_CACHE_ENABLED && !pgSummary.connected ? 4 : 0
  };
  const score = clampScore(100 - Object.values(penalties).reduce((sum, value) => sum + value, 0));
  const priorities = [];
  if (placeholderTotal) priorities.push({ severity: 'alta', area: 'Dados reais', action: `Mapear ${placeholderTotal} SQL(s) placeholder para consultas reais ou medidas convertiveis.` });
  if (measuresPending) priorities.push({ severity: 'alta', area: 'Modelo semantico', action: `Preencher formula/SQL equivalente para ${measuresPending} medida(s) pendente(s).` });
  if (!relationships && (selectedColumns > 1 || modelDiag.model.tables > 1)) priorities.push({ severity: 'alta', area: 'Relacionamentos', action: 'Criar relacionamentos entre tabelas para filtros cruzados no padrao Power BI.' });
  if (!REALTIME_EVENT_TABLE) priorities.push({ severity: 'media', area: 'Tempo real', action: 'Configurar BIWA_REALTIME_EVENT_TABLE e BIWA_REALTIME_EVENT_COLUMN para invalidar cache por evento do MySQL.' });
  if (defaultSecret || defaultPasswords) priorities.push({ severity: 'alta', area: 'Seguranca', action: 'Trocar senhas exemplo e definir BIWA_AUTH_SECRET forte antes de publicar online.' });
  if (POSTGRES_CACHE_ENABLED && !pgSummary.connected) priorities.push({ severity: 'media', area: 'Performance', action: 'Corrigir conexao do cache PostgreSQL ou desativar explicitamente ate configurar.' });
  if (!POSTGRES_CACHE_ENABLED) priorities.push({ severity: 'baixa', area: 'Performance', action: 'Habilitar cache PostgreSQL para tabelas grandes quando o modelo real estiver mapeado.' });

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    score,
    level: readinessLevel(score),
    penalties,
    summary: {
      reports: reportsCount,
      pages: Number(modelDiag.reports.pages || 0),
      visuals: visualsTotal,
      placeholders: placeholderTotal,
      modelTables: Number(modelDiag.model.tables || 0),
      selectedColumns,
      relationships,
      measures: measuresTotal,
      measuresPending,
      onlineUsers: onlineUsers.length
    },
    realtime: {
      mode: REALTIME_EVENT_TABLE ? 'mysql_event_marker' : 'interval_polling',
      eventTable: REALTIME_EVENT_TABLE || null,
      eventColumn: REALTIME_EVENT_TABLE ? REALTIME_EVENT_COLUMN : null,
      eventPollSeconds: REALTIME_EVENT_TABLE ? REALTIME_EVENT_POLL_SECONDS : null,
      marker: realtimeEventMarker,
      lastCheckedAt: realtimeEventCheckedAt ? new Date(realtimeEventCheckedAt).toISOString() : null,
      lastChangeAt: realtimeEventLastChangeAt ? new Date(realtimeEventLastChangeAt).toISOString() : null,
      lastError: realtimeEventLastError || '',
      defaultRefreshSeconds: DEFAULT_REFRESH_SECONDS,
      serverPushIntervalSeconds: SERVER_PUSH_INTERVAL_SECONDS,
      cacheEnabled: QUERY_CACHE_ENABLED,
      cacheTtlMs: QUERY_CACHE_TTL_MS
    },
    cache: {
      memoryEnabled: QUERY_CACHE_ENABLED,
      memoryTtlMs: QUERY_CACHE_TTL_MS,
      memoryItems: queryCache.size,
      postgresEnabled: POSTGRES_CACHE_ENABLED,
      postgresConnected: Boolean(pgSummary.connected),
      postgresCacheCount: Number(pgSummary.cacheCount || 0),
      postgresRows: Number(pgSummary.rowCount || 0),
      postgresError: pgSummary.error || ''
    },
    security: {
      mode: APP_MODE,
      defaultSecret,
      defaultPasswords,
      openOnlineAccess: ONLINE_ALLOW_OPEN_ACCESS,
      onlineUsers: onlineUsers.length,
      authTokenTtlMs: AUTH_TOKEN_TTL_MS
    },
    priorities: priorities.slice(0, 20),
    modelDiagnostics: modelDiag
  };
}

function normalizeColumnNameForMatch(name) {
  return String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function relationshipKey(rel) {
  return [rel.fromTable, rel.fromColumn, rel.toTable, rel.toColumn].map((v) => String(v || '').trim()).join('::');
}

function isDateLikeColumn(column) {
  const name = String(column && column.name || '').toLowerCase();
  const type = String(column && (column.dataType || column.columnType) || '').toLowerCase();
  return /date|time|timestamp|datetime/.test(type) || /(^data$|data_|_data|dt_|_dt|emissao|vencimento|pagamento|competencia|movimento)/i.test(name);
}

function isNumericLikeColumn(column) {
  const type = String(column && (column.dataType || column.columnType) || '').toLowerCase();
  return /(int|decimal|numeric|float|double|real|bit|bool)/.test(type);
}

function compatibleRelationshipColumns(left, right) {
  if (!left || !right) return false;
  if (isDateLikeColumn(left) || isDateLikeColumn(right)) return isDateLikeColumn(left) && isDateLikeColumn(right);
  const lnum = isNumericLikeColumn(left);
  const rnum = isNumericLikeColumn(right);
  if (lnum !== rnum) return false;
  return true;
}

function relationshipCandidateScore(leftTable, leftColumn, rightTable, rightColumn) {
  const leftName = normalizeColumnNameForMatch(leftColumn && leftColumn.name);
  const rightName = normalizeColumnNameForMatch(rightColumn && rightColumn.name);
  const leftTableName = normalizeColumnNameForMatch(leftTable);
  const rightTableName = normalizeColumnNameForMatch(rightTable);
  let score = 0;
  if (leftName && leftName === rightName) score += 60;
  if (leftColumn && leftColumn.columnKey === 'PRI') score += 25;
  if (rightColumn && rightColumn.columnKey === 'PRI') score += 25;
  if (leftColumn && leftColumn.columnKey === 'MUL') score += 10;
  if (rightColumn && rightColumn.columnKey === 'MUL') score += 10;
  if (/^id/.test(leftName) || /id$/.test(leftName) || /^cod/.test(leftName) || /cod/.test(leftName)) score += 10;
  if (/^id/.test(rightName) || /id$/.test(rightName) || /^cod/.test(rightName) || /cod/.test(rightName)) score += 10;
  if (leftName.includes(rightTableName) || rightName.includes(leftTableName)) score += 20;
  if (/chave|key|nfe|nf|documento|numero/.test(leftName) && /chave|key|nfe|nf|documento|numero/.test(rightName)) score += 15;
  if (compatibleRelationshipColumns(leftColumn, rightColumn)) score += 10;
  return score;
}

function orientRelationship(leftTable, leftColumn, rightTable, rightColumn) {
  const leftPk = leftColumn && leftColumn.columnKey === 'PRI';
  const rightPk = rightColumn && rightColumn.columnKey === 'PRI';
  if (rightPk && !leftPk) {
    return { fromTable: leftTable, fromColumn: leftColumn.name, toTable: rightTable, toColumn: rightColumn.name, cardinality: 'many-to-one' };
  }
  if (leftPk && !rightPk) {
    return { fromTable: rightTable, fromColumn: rightColumn.name, toTable: leftTable, toColumn: leftColumn.name, cardinality: 'many-to-one' };
  }
  return { fromTable: leftTable, fromColumn: leftColumn.name, toTable: rightTable, toColumn: rightColumn.name, cardinality: leftPk && rightPk ? 'one-to-one' : 'many-to-one' };
}


function relationshipConfidenceFromScore(score) {
  if (score >= 100) return 'high';
  if (score >= 70) return 'medium';
  return 'low';
}

function relationshipPairKey(rel) {
  const a = `${rel.fromTable || ''}.${rel.fromColumn || ''}`;
  const b = `${rel.toTable || ''}.${rel.toColumn || ''}`;
  return [a, b].sort().join('<->');
}

function relationshipDirectedKey(rel) {
  return `${rel.fromTable || ''}.${rel.fromColumn || ''}->${rel.toTable || ''}.${rel.toColumn || ''}`;
}

function columnTypeLabel(column) {
  return String(column && (column.columnType || column.dataType || '') || '').toLowerCase();
}

async function relationshipDiagnostics(model, reports) {
  const resources = await getTables();
  const resourceNames = new Set(resources.map((item) => item.name));
  const columnsByTable = new Map();
  async function columnsFor(table) {
    if (!columnsByTable.has(table)) {
      try { columnsByTable.set(table, await getColumns(table)); } catch (err) { columnsByTable.set(table, []); }
    }
    return columnsByTable.get(table) || [];
  }
  const relationships = Array.isArray(model.relationships) ? model.relationships : [];
  const pairCounts = new Map();
  const directedCounts = new Map();
  for (const rel of relationships) {
    pairCounts.set(relationshipPairKey(rel), (pairCounts.get(relationshipPairKey(rel)) || 0) + 1);
    directedCounts.set(relationshipDirectedKey(rel), (directedCounts.get(relationshipDirectedKey(rel)) || 0) + 1);
  }
  const items = [];
  for (let idx = 0; idx < relationships.length; idx += 1) {
    const rel = relationships[idx];
    const issues = [];
    if (rel.active === false) issues.push('Relacionamento inativo; não participa da geração SQL nem da propagação de filtros.');
    if (!resourceNames.has(rel.fromTable)) issues.push('Tabela de origem não encontrada.');
    if (!resourceNames.has(rel.toTable)) issues.push('Tabela de destino não encontrada.');
    const fromCols = resourceNames.has(rel.fromTable) ? await columnsFor(rel.fromTable) : [];
    const toCols = resourceNames.has(rel.toTable) ? await columnsFor(rel.toTable) : [];
    const fromCol = fromCols.find((c) => c.name === rel.fromColumn);
    const toCol = toCols.find((c) => c.name === rel.toColumn);
    if (!fromCol) issues.push('Coluna de origem não encontrada.');
    if (!toCol) issues.push('Coluna de destino não encontrada.');
    if (fromCol && toCol && !compatibleRelationshipColumns(fromCol, toCol)) issues.push('Tipos de coluna aparentam incompatíveis.');
    if (rel.fromTable === rel.toTable && rel.fromColumn === rel.toColumn) issues.push('Relacionamento aponta para a mesma coluna.');
    if (directedCounts.get(relationshipDirectedKey(rel)) > 1) issues.push('Relacionamento duplicado na mesma direção.');
    if (pairCounts.get(relationshipPairKey(rel)) > 1) issues.push('Existe relacionamento duplicado ou reverso entre as mesmas colunas.');
    if (String(rel.confidence || '') === 'low') issues.push('Baixa confiança; revise antes de publicar.');
    const status = issues.length ? (rel.active === false && issues.length === 1 ? 'inativo' : 'atenção') : 'ok';
    items.push({
      index: idx,
      status,
      issues,
      fromTable: rel.fromTable,
      fromColumn: rel.fromColumn,
      fromType: columnTypeLabel(fromCol),
      toTable: rel.toTable,
      toColumn: rel.toColumn,
      toType: columnTypeLabel(toCol),
      joinType: rel.joinType || 'LEFT',
      cardinality: rel.cardinality || 'many-to-one',
      filterDirection: rel.filterDirection || 'single',
      active: rel.active !== false,
      confidence: rel.confidence || '',
      source: rel.source || ''
    });
  }
  const graph = relationshipGraphSummary(model);
  const allReports = Array.isArray(reports) ? reports : [];
  const visuals = allReports.flatMap((report) => Array.isArray(report.visuals) ? report.visuals.map((visual) => ({ report, visual })) : []);
  const activeTables = new Set((Array.isArray(model.tables) ? model.tables : []).map((item) => typeof item === 'string' ? item : item && item.name).filter(Boolean));
  const disconnectedVisuals = visuals.filter(({ visual }) => visual && visual.table && activeTables.has(visual.table) && graph.disconnectedTables.includes(visual.table)).slice(0, 50).map(({ report, visual }) => ({
    reportId: report.id,
    reportName: report.name || '',
    visualId: visual.id || '',
    visualTitle: visual.title || visual.type || '',
    table: visual.table
  }));
  const byStatus = items.reduce((acc, item) => { acc[item.status] = (acc[item.status] || 0) + 1; return acc; }, {});
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    total: relationships.length,
    active: relationships.filter((rel) => rel.active !== false).length,
    inactive: relationships.filter((rel) => rel.active === false).length,
    byStatus,
    components: graph.components,
    largestComponentSize: graph.largestComponentSize,
    disconnectedTables: graph.disconnectedTables,
    items,
    problemItems: items.filter((item) => item.status !== 'ok').slice(0, 200),
    disconnectedVisuals,
    warnings: [
      ...(!relationships.length ? ['Nenhum relacionamento cadastrado.'] : []),
      ...(graph.components > 1 ? ['Existem tabelas desconectadas no modelo.'] : []),
      ...(items.some((item) => item.issues.some((issue) => /incompatíveis|não encontrada|duplicado|mesma coluna/.test(issue))) ? ['Existem relacionamentos que precisam de revisão antes de publicar.'] : [])
    ]
  };
}

async function suggestRelationshipsForModel(model) {
  const tableNames = Array.from(new Set((Array.isArray(model.tables) ? model.tables : [])
    .map((item) => typeof item === 'string' ? item : item && item.name)
    .filter(Boolean)))
    .filter((name) => name !== CALENDAR_TABLE_NAME)
    .slice(0, 80);
  const existing = new Set((model.relationships || []).map(relationshipPairKey));
  const columnsByTable = new Map();
  for (const table of tableNames) {
    try { columnsByTable.set(table, await getColumns(table)); } catch (err) { columnsByTable.set(table, []); }
  }
  const suggestions = [];
  const pushSuggestion = (rel, score, reason) => {
    if (!rel || !rel.fromTable || !rel.toTable || !rel.fromColumn || !rel.toColumn) return;
    if (existing.has(relationshipPairKey(rel))) return;
    suggestions.push({
      ...rel,
      joinType: 'LEFT',
      filterDirection: 'single',
      active: true,
      confidence: relationshipConfidenceFromScore(score),
      score,
      reason,
      source: 'suggestion'
    });
  };
  for (const table of tableNames) {
    const dateCols = (columnsByTable.get(table) || []).filter(isDateLikeColumn);
    const preferred = dateCols.find((c) => /^data$/i.test(c.name)) || dateCols.find((c) => /emissao|movimento|competencia/i.test(c.name)) || dateCols[0];
    if (preferred) pushSuggestion({ fromTable: CALENDAR_TABLE_NAME, fromColumn: 'Data', toTable: table, toColumn: preferred.name, cardinality: 'one-to-many' }, 110, 'Calendário para coluna de data');
  }
  const idLike = (name) => /(^id$|^id_|_id$|codigo|cod|chave|key|pk|nfe|nf|documento|numero)/i.test(String(name || ''));
  for (let i = 0; i < tableNames.length; i += 1) {
    for (let j = i + 1; j < tableNames.length; j += 1) {
      const left = tableNames[i];
      const right = tableNames[j];
      const leftCols = (columnsByTable.get(left) || []).filter((c) => idLike(c.name));
      const rightCols = (columnsByTable.get(right) || []).filter((c) => idLike(c.name));
      for (const lc of leftCols) {
        for (const rc of rightCols) {
          const ln = normalizeColumnNameForMatch(lc.name);
          const rn = normalizeColumnNameForMatch(rc.name);
          const tableNameHint = ln.includes(normalizeColumnNameForMatch(right)) || rn.includes(normalizeColumnNameForMatch(left));
          if (!(ln && rn && (ln === rn || tableNameHint))) continue;
          if (!compatibleRelationshipColumns(lc, rc)) continue;
          const score = relationshipCandidateScore(left, lc, right, rc);
          if (score < 50) continue;
          const rel = orientRelationship(left, lc, right, rc);
          pushSuggestion(rel, score, ln === rn ? 'Nome de coluna equivalente' : 'Nome indica tabela relacionada');
        }
      }
    }
  }
  suggestions.sort((a, b) => b.score - a.score);
  const seen = new Set();
  const unique = suggestions.filter((item) => {
    const key = relationshipPairKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    ok: true,
    total: unique.length,
    high: unique.filter((item) => item.confidence === 'high').length,
    medium: unique.filter((item) => item.confidence === 'medium').length,
    low: unique.filter((item) => item.confidence === 'low').length,
    suggestions: unique.slice(0, 500)
  };
}

async function autoDetectRelationshipsForModel(model) {
  const tableNames = Array.from(new Set((Array.isArray(model.tables) ? model.tables : [])
    .map((item) => typeof item === 'string' ? item : item && item.name)
    .filter(Boolean)))
    .filter((name) => name !== CALENDAR_TABLE_NAME)
    .slice(0, 80);
  const existing = new Set((model.relationships || []).map(relationshipKey));
  const columnsByTable = new Map();
  for (const table of tableNames) {
    try { columnsByTable.set(table, await getColumns(table)); } catch (err) { columnsByTable.set(table, []); }
  }
  const added = [];
  const addRel = (rel) => {
    const key = relationshipKey(rel);
    const reverseKey = relationshipKey({ fromTable: rel.toTable, fromColumn: rel.toColumn, toTable: rel.fromTable, toColumn: rel.fromColumn });
    if (existing.has(key) || existing.has(reverseKey)) return false;
    existing.add(key);
    added.push({ joinType: 'LEFT', filterDirection: 'single', source: 'auto-detect', confidence: rel.confidence || 'medium', ...rel });
    return true;
  };

  // Relaciona a tabela Calendario com colunas de data das tabelas do modelo.
  for (const table of tableNames) {
    const dateCols = (columnsByTable.get(table) || []).filter(isDateLikeColumn);
    const preferred = dateCols.find((c) => /^data$/i.test(c.name)) || dateCols.find((c) => /emissao|movimento|competencia/i.test(c.name)) || dateCols[0];
    if (preferred) {
      addRel({ fromTable: CALENDAR_TABLE_NAME, fromColumn: 'Data', toTable: table, toColumn: preferred.name, cardinality: 'one-to-many', confidence: 'high' });
    }
  }

  const idLike = (name) => /(^id$|^id_|_id$|codigo|cod|chave|key|pk|nfe|nf|documento|numero)/i.test(String(name || ''));
  for (let i = 0; i < tableNames.length; i += 1) {
    for (let j = i + 1; j < tableNames.length; j += 1) {
      const left = tableNames[i];
      const right = tableNames[j];
      const leftCols = (columnsByTable.get(left) || []).filter((c) => idLike(c.name));
      const rightCols = (columnsByTable.get(right) || []).filter((c) => idLike(c.name));
      const candidates = [];
      for (const lc of leftCols) {
        for (const rc of rightCols) {
          const ln = normalizeColumnNameForMatch(lc.name);
          const rn = normalizeColumnNameForMatch(rc.name);
          const same = ln && rn && ln === rn;
          const tableNameHint = ln.includes(normalizeColumnNameForMatch(right)) || rn.includes(normalizeColumnNameForMatch(left));
          if (!same && !tableNameHint) continue;
          if (!compatibleRelationshipColumns(lc, rc)) continue;
          candidates.push({ lc, rc, score: relationshipCandidateScore(left, lc, right, rc) });
        }
      }
      candidates.sort((a, b) => b.score - a.score);
      const best = candidates[0];
      if (!best || best.score < 70) continue;
      const rel = orientRelationship(left, best.lc, right, best.rc);
      addRel({ ...rel, confidence: best.score >= 100 ? 'high' : 'medium' });
    }
  }
  model.relationships = [...(model.relationships || []), ...added];
  return { model, added };
}


function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return "'" + String(value).replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
}

function inlineSqlParams(sql, params = []) {
  let idx = 0;
  return String(sql || '').replace(/\?/g, () => sqlLiteral(params[idx++]));
}


function normalizeVisualQueryFields(fields) {
  const seen = new Set();
  const out = [];
  (Array.isArray(fields) ? fields : []).forEach((item) => {
    const name = String(typeof item === 'string' ? item : (item && item.name) || '').trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push(name);
  });
  return out.slice(0, 60);
}

function normalizeVisualQueryFieldObjects(fields) {
  const seen = new Set();
  const occurrences = new Map();
  const out = [];
  (Array.isArray(fields) ? fields : []).forEach((item) => {
    const name = String(typeof item === 'string' ? item : (item && item.name) || '').trim();
    if (!name) return;
    const table = normalizeTableName(item && item.table);
    const occurrenceKey = table + '::' + name;
    const occurrence = occurrences.get(occurrenceKey) || 0;
    occurrences.set(occurrenceKey, occurrence + 1);
    const suppliedInstanceId = String(item && item.instanceId || '').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 96);
    const instanceId = suppliedInstanceId || ('field_' + crypto.createHash('sha1').update(occurrenceKey + '::' + occurrence).digest('hex').slice(0, 16));
    if (seen.has(instanceId)) return;
    const displayName = String(item && item.displayName || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
    const aggregation = String(item && item.aggregation || '').trim().toUpperCase().slice(0, 24);
    const showValueAs = String(item && item.showValueAs || '').trim().toUpperCase().slice(0, 40);
    const sourceFormat = item && item.format && typeof item.format === 'object' && !Array.isArray(item.format) ? item.format : {};
    const formatType = ['number', 'decimal', 'integer', 'currency', 'percentage'].includes(String(sourceFormat.type || '').toLowerCase())
      ? String(sourceFormat.type).toLowerCase()
      : '';
    const decimalPlaces = Number.isFinite(Number(sourceFormat.decimalPlaces))
      ? Math.max(0, Math.min(10, Math.round(Number(sourceFormat.decimalPlaces))))
      : null;
    const alignment = ['left', 'center', 'right'].includes(String(item && item.alignment || '').toLowerCase())
      ? String(item.alignment).toLowerCase()
      : null;
    const rawWidth = item && item.width;
    const width = rawWidth !== null && rawWidth !== undefined && String(rawWidth).trim() !== '' && Number.isFinite(Number(rawWidth))
      ? Math.max(32, Math.min(1200, Math.round(Number(rawWidth))))
      : null;
    seen.add(instanceId);
    out.push({
      instanceId,
      measureId: String(item && item.measureId || (String(item && item.type || '').toLowerCase() === 'measure' ? name : '')).trim().slice(0, 160) || null,
      name,
      table,
      type: String(item && item.type || '').trim(),
      displayName: displayName || null,
      aggregation: aggregation || null,
      showValueAs: showValueAs || null,
      format: formatType || decimalPlaces !== null ? {
        type: formatType || 'decimal',
        decimalPlaces,
        prefix: String(sourceFormat.prefix || '').slice(0, 24),
        suffix: String(sourceFormat.suffix || '').slice(0, 24),
        percentOfTotal: Boolean(sourceFormat.percentOfTotal)
      } : null,
      alignment,
      width
    });
  });
  return out.slice(0, 60);
}

// O viewer online nao recebe formulas DAX nem o modelo semantico completo. Ainda
// assim, precisa receber a apresentacao oficial de cada medida. Este contrato
// compacto e separado da formula/consulta: permissoes filtram dados e paginas,
// mas nunca o formato definido no construtor.
function normalizeMeasureDisplayFormat(measure) {
  if (!measure || typeof measure !== 'object') return null;
  const rawType = String(measure.formatType || measure.format || measure.numberFormat || measure.displayFormat || '').trim().toLowerCase();
  const formatString = String(measure.formatString || '').trim();
  let type = '';
  if (['percentage', 'percent', 'porcentagem', 'percentual'].includes(rawType) || /%/.test(formatString)) type = 'percentage';
  else if (['currency', 'moeda', 'monetario', 'monetária'].includes(rawType) || /r\$|\$|€|£/i.test(formatString)) type = 'currency';
  else if (['integer', 'inteiro', 'numero', 'número'].includes(rawType)) type = 'integer';
  else if (['number', 'decimal', 'numero decimal', 'número decimal'].includes(rawType)) type = 'decimal';
  const decimalSource = [measure.decimalPlaces, measure.decimals, measure.scale]
    .find((value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)));
  const decimalPlaces = decimalSource === undefined ? null : Math.max(0, Math.min(10, Math.round(Number(decimalSource))));
  if (!type && decimalPlaces === null) return null;
  return {
    type: type || 'decimal',
    decimalPlaces: type === 'integer' ? 0 : decimalPlaces,
    prefix: String(measure.prefix || (type === 'currency' ? 'R$ ' : '')).slice(0, 24),
    suffix: String(measure.suffix || (type === 'percentage' ? '%' : '')).slice(0, 24),
    percentOfTotal: false
  };
}

function semanticMeasureForVisualField(field, semanticModel) {
  if (!field || String(field.type || '').toLowerCase() !== 'measure') return null;
  const measures = Array.isArray(semanticModel && semanticModel.measures) ? semanticModel.measures : [];
  if (!measures.length) return null;
  const measureId = String(field.measureId || '').trim();
  const nameKey = normalizeMeasureNameKey(field.name || '');
  const tableKey = normalizeTableKey(field.table || '');
  const matchesId = (measure) => measureId && [measure && measure.id, measure && measure.measureId]
    .some((value) => String(value || '').trim() === measureId);
  const matchesName = (measure) => [measure && measure.name, measure && measure.displayName]
    .some((value) => normalizeMeasureNameKey(value || '') === nameKey);
  const matchesTable = (measure) => !tableKey || !String(measure && measure.table || '').trim()
    || normalizeTableKey(measure.table) === tableKey;
  return measures.find((measure) => matchesId(measure) && matchesTable(measure))
    || measures.find((measure) => matchesId(measure))
    || measures.find((measure) => matchesName(measure) && matchesTable(measure))
    || measures.find((measure) => matchesName(measure))
    || null;
}

function publicVisualQueryFieldObjects(fields, semanticModel) {
  return normalizeVisualQueryFieldObjects(fields).map((field) => {
    // O formato no campo do visual tem precedencia sobre o padrao da medida.
    if (field.format) return field;
    const inherited = normalizeMeasureDisplayFormat(semanticMeasureForVisualField(field, semanticModel));
    return inherited ? { ...field, format: inherited } : field;
  });
}

function visualRuntimeFormatFromFieldFormat(format) {
  if (!format || typeof format !== 'object') return null;
  const type = String(format.type || '').toLowerCase();
  if (!['number', 'decimal', 'integer', 'currency', 'percentage'].includes(type)) return null;
  const decimalPlaces = Number.isFinite(Number(format.decimalPlaces))
    ? Math.max(0, Math.min(10, Math.round(Number(format.decimalPlaces))))
    : null;
  return {
    _formatPriority: 'instance',
    type: type === 'integer' ? 'inteiro' : 'decimal',
    formatType: type,
    decimals: type === 'integer' ? 0 : (decimalPlaces === null ? 2 : decimalPlaces),
    prefix: type === 'currency' ? (String(format.prefix || '') || 'R$ ') : String(format.prefix || ''),
    suffix: type === 'percentage' ? (String(format.suffix || '') || '%') : String(format.suffix || ''),
    useGrouping: true
  };
}

function normalizeTableName(str) {
  var s = (String(str || '').normalize ? String(str || '').normalize('NFKC').trim() : String(str || '').trim());
  // Strip surrounding quotes (straight or curly) left after NFKC normalization
  while (s.length > 1 && (s.charCodeAt(0) === 39 || s.charCodeAt(0) === 34 || s.charCodeAt(0) === 0x2018 || s.charCodeAt(0) === 0x2019 || s.charCodeAt(0) === 0x201C || s.charCodeAt(0) === 0x201D) && (s.charCodeAt(s.length - 1) === 39 || s.charCodeAt(s.length - 1) === 34 || s.charCodeAt(s.length - 1) === 0x2018 || s.charCodeAt(s.length - 1) === 0x2019 || s.charCodeAt(s.length - 1) === 0x201C || s.charCodeAt(s.length - 1) === 0x201D)) s = s.slice(1, -1).trim();
  return s;
}
function normalizeTableKey(str) { return normalizeTableName(str).toLowerCase(); }
function sameTableName(left, right) {
  const leftKey = normalizeTableKey(left);
  return Boolean(leftKey) && leftKey === normalizeTableKey(right);
}

async function getVisualTableColumnKeySet(tableName) {
  const table = normalizeTableName(tableName);
  if (!table) return new Set();
  try {
    const resolved = await resolvePgCacheLookup(table);
    const meta = await getPgCacheMeta(resolved.table || table);
    const columns = meta && Array.isArray(meta.columns) ? meta.columns : [];
    return new Set(columns.map((column) => normalizeColumnNameForMatch(column && (column.name || column.Field || column.column_name || column))).filter(Boolean));
  } catch (err) {
    return new Set();
  }
}

function preferredMeasureExecutionBaseTable(currentTable, measure, model) {
  const current = normalizeTableName(currentTable);
  const currentKey = normalizeTableKey(current);
  if (!current || !currentKey || !measure || !model) return '';
  const relationships = Array.isArray(model.relationships)
    ? model.relationships.filter((relationship) => relationship && relationship.active !== false)
    : [];
  const lookup = buildMeasureLookup(model);
  const candidates = [];
  let firstDependencyTable = '';
  function addCandidate(table) {
    const name = normalizeTableName(table);
    const key = normalizeTableKey(name);
    if (name && key && !firstDependencyTable) firstDependencyTable = name;
    if (name && key && key !== currentKey && !candidates.some((item) => normalizeTableKey(item) === key)) candidates.push(name);
  }
  // A tabela inicial de uma medida e apenas sua pasta de exibicao. As tabelas
  // das medidas referenciadas indicam melhor o lado fato necessario para a
  // avaliacao, preservando a ordem semantica das dependencias DAX.
  daxMeasureReferences(measure.formula || '', model).forEach(function(name) {
    const dependency = lookup.get(normalizeMeasureNameKey(name));
    tablesUsedByMeasureWithDependencies(dependency, model).forEach(addCandidate);
  });
  tablesUsedByMeasureWithDependencies(measure, model).forEach(addCandidate);
  if (normalizeTableKey(firstDependencyTable) === currentKey) return current;
  for (const candidate of candidates) {
    const candidateKey = normalizeTableKey(candidate);
    const relationship = relationships.find(function(item) {
      const fromKey = normalizeTableKey(item.fromTable);
      const toKey = normalizeTableKey(item.toTable);
      return (fromKey === currentKey && toKey === candidateKey) || (fromKey === candidateKey && toKey === currentKey);
    });
    if (relationship) {
      const cardinality = String(relationship.cardinality || '').toLowerCase().replace(/\s+/g, '');
      const manyTable = ['one-to-many', '1:*', '1:n'].includes(cardinality)
        ? relationship.toTable
        : (['many-to-one', '*:1', 'n:1'].includes(cardinality) ? relationship.fromTable : '');
      if (normalizeTableKey(manyTable) === candidateKey) return normalizeTableName(manyTable);
      continue;
    }
    // A measure fact can be separated from the visual table by an intermediate
    // dimension. Consider the complete active path and prefer the dependency
    // only when its final relationship places it on the many/fact side.
    const path = findRelationshipPath(model, current, candidate, Math.max(4, Math.min(32, relationships.length + 1)));
    if (!path || !Array.isArray(path.relationships) || !path.relationships.length) continue;
    const finalRelationship = path.relationships[path.relationships.length - 1];
    if (relationshipTargetIsMany(finalRelationship, candidate)) return candidate;
  }
  return '';
}

async function inferVisualBaseTableForFields(currentTable, body, requestedFields) {
  const model = body && body.model && typeof body.model === 'object' ? body.model : {};
  const current = normalizeTableName(currentTable);
  if (!current || !Array.isArray(model.relationships)) return current;
  if (Array.isArray(model.measures) && model.measures.length) {
    const lookup = buildMeasureLookup(model);
    const measureField = String(body && body.value || '').trim()
      || (requestedFields || []).find((field) => lookup.has(normalizeMeasureNameKey(field)));
    const measure = measureField ? lookup.get(normalizeMeasureNameKey(measureField)) : null;
    if (measure) {
      const measureTables = tablesUsedByMeasureWithDependencies(measure, model).map((table) => normalizeTableName(table)).filter(Boolean);
      const measureTableKeys = measureTables.map((table) => normalizeTableKey(table));
      const executionBase = preferredMeasureExecutionBaseTable(current, measure, model);
      if (executionBase) return executionBase;
      if (measureTableKeys.includes(normalizeTableKey(current))) return current;
      const declaredMeasureTable = normalizeTableName(measure.table);
      if (declaredMeasureTable && measureTableKeys.includes(normalizeTableKey(declaredMeasureTable))) return declaredMeasureTable;
      if (measureTables.length) return measureTables[0];
    }
  }
  const measureNames = new Set(
    (Array.isArray(model.measures) ? model.measures : [])
      .filter((measure) => String(measure && measure.formula || '').trim())
      .map((measure) => normalizeMeasureNameKey(measure.name || measure.displayName))
  );
  const fields = [...(requestedFields || []), String(body.dimension || '').trim()]
    .map((field) => String(field || '').trim())
    .filter((field) => field && !measureNames.has(normalizeMeasureNameKey(field)));
  if (!fields.length) return current;
  const currentColumns = await getVisualTableColumnKeySet(current);
  if (!currentColumns.size) return current;
  const missingFields = fields.filter((field) => !currentColumns.has(normalizeColumnNameForMatch(field)));
  if (!missingFields.length) return current;

  const currentKey = normalizeTableKey(current);
  const activeRelationships = model.relationships.filter((rel) => rel && rel.active !== false);
  const candidates = [];
  for (const rel of activeRelationships) {
    const fromKey = normalizeTableKey(rel.fromTable);
    const toKey = normalizeTableKey(rel.toTable);
    if (fromKey === currentKey && rel.toTable) candidates.push(rel.toTable);
    if (toKey === currentKey && rel.fromTable) candidates.push(rel.fromTable);
  }
  for (const table of (Array.isArray(model.tables) ? model.tables : [])) {
    const name = normalizeTableName(table && (table.name || table.table || table));
    if (name) candidates.push(name);
  }
  const seen = new Set();
  for (const candidate of candidates) {
    const name = normalizeTableName(candidate);
    const key = normalizeTableKey(name);
    if (!name || key === currentKey || seen.has(key)) continue;
    seen.add(key);
    const columns = await getVisualTableColumnKeySet(name);
    if (!columns.size) continue;
    if (fields.every((field) => columns.has(normalizeColumnNameForMatch(field)))) return name;
  }
  return current;
}

async function inferVisualFieldTable(currentTable, model, fieldName) {
  const current = normalizeTableName(currentTable);
  const fieldKey = normalizeColumnNameForMatch(fieldName);
  if (!current || !fieldKey) return current;
  const currentColumns = await getVisualTableColumnKeySet(current);
  if (currentColumns.has(fieldKey)) return current;
  const currentKey = normalizeTableKey(current);
  const candidates = [];
  const rels = Array.isArray(model && model.relationships) ? model.relationships.filter((rel) => rel && rel.active !== false) : [];
  for (const rel of rels) {
    const fromKey = normalizeTableKey(rel.fromTable);
    const toKey = normalizeTableKey(rel.toTable);
    if (fromKey === currentKey && rel.toTable) candidates.push(rel.toTable);
    if (toKey === currentKey && rel.fromTable) candidates.push(rel.fromTable);
  }
  for (const table of (Array.isArray(model && model.tables) ? model.tables : [])) {
    const name = normalizeTableName(table && (table.name || table.table || table));
    if (name) candidates.push(name);
  }
  const seen = new Set();
  for (const candidate of candidates) {
    const name = normalizeTableName(candidate);
    const key = normalizeTableKey(name);
    if (!name || key === currentKey || seen.has(key)) continue;
    seen.add(key);
    const columns = await getVisualTableColumnKeySet(name);
    if (columns.has(fieldKey)) return name;
  }
  return current;
}

function preferManySideVisualBaseTable(currentTable, model, fieldObjects) {
  const current = normalizeTableName(currentTable);
  const currentKey = normalizeTableKey(current);
  if (!current || !currentKey) return current;
  const explicitTables = [];
  normalizeVisualQueryFieldObjects(fieldObjects).forEach((field) => {
    const table = normalizeTableName(field && field.table);
    const key = normalizeTableKey(table);
    if (table && key && key !== currentKey && !explicitTables.some((item) => normalizeTableKey(item) === key)) {
      explicitTables.push(table);
    }
  });
  if (!explicitTables.length) return current;
  const relationships = Array.isArray(model && model.relationships) ? model.relationships.filter((rel) => rel && rel.active !== false) : [];
  for (const relatedTable of explicitTables) {
    const relatedKey = normalizeTableKey(relatedTable);
    const relationship = relationships.find((rel) => {
      const fromKey = normalizeTableKey(rel.fromTable);
      const toKey = normalizeTableKey(rel.toTable);
      return (fromKey === currentKey && toKey === relatedKey) || (fromKey === relatedKey && toKey === currentKey);
    });
    if (!relationship) continue;
    const cardinality = String(relationship.cardinality || '').toLowerCase().replace(/\s+/g, '');
    const manyTable = cardinality === 'one-to-many'
      ? relationship.toTable
      : (cardinality === 'many-to-one' ? relationship.fromTable : '');
    if (manyTable && normalizeTableKey(manyTable) === relatedKey) return normalizeTableName(manyTable);
  }
  return current;
}

function calendarJoinColumnsForVisual(relatedTable, body = {}, joinColumn = '') {
  if (normalizeTableName(relatedTable) !== CALENDAR_TABLE_NAME) return [];
  const allowed = new Set(calendarColumnNames());
  const columns = [];
  const add = (column) => {
    const value = String(column || '').trim();
    if (value && allowed.has(value) && !columns.includes(value)) columns.push(value);
  };
  add(joinColumn || 'Data');
  add('Data');

  normalizeVisualQueryFieldObjects(body.fields).forEach((field) => {
    if (normalizeTableName(field.table) === CALENDAR_TABLE_NAME) add(field.name);
  });
  [body.dimension, body.value, body.filterColumn].forEach(add);
  [body.visualFilters, body.pageFilters, body.allPagesFilters].forEach((filters) => {
    (Array.isArray(filters) ? filters : []).forEach((filter) => {
      if (!filter) return;
      if (!filter.table || normalizeTableName(filter.table) === CALENDAR_TABLE_NAME) add(filter.field || filter.column);
    });
  });
  (Array.isArray(body.model && body.model.measures) ? body.model.measures : []).forEach((measure) => {
    columnsUsedInDaxExpression(measure && measure.formula || '').forEach((ref) => {
      if (normalizeTableName(ref.table) === CALENDAR_TABLE_NAME) add(ref.column);
    });
  });
  return columns.length ? columns : ['Data'];
}

async function visualJoinSourceSql(tableName, alias, body = {}, joinColumn = '', options = {}) {
  const relatedTable = normalizeTableName(tableName);
  const joinAlias = String(alias || '').trim();
  if (!relatedTable || !joinAlias) throw apiError('JOIN de visual sem tabela ou alias.', 400);
  if (relatedTable === CALENDAR_TABLE_NAME) {
    return calendarDerivedSql(calendarJoinColumnsForVisual(relatedTable, body, joinColumn)).replace(/\s+AS\s+src\s*$/i, ' ' + joinAlias);
  }
  let joinTableSql = quoteIdent(relatedTable);
  try {
    const resolvedJoin = await resolvePgCacheLookup(relatedTable);
    joinTableSql = quoteIdent(resolvedJoin.table || relatedTable);
  } catch (e) {}
  // A deduplicacao completa era aplicada inclusive a dimensoes cuja chave ja e
  // garantidamente unica. Em tabelas largas isso criava um DISTINCT * caro antes
  // de cada visual. Mantemos o comportamento legado quando nao existe garantia de
  // unicidade e usamos a tabela diretamente somente para chaves primarias.
  try {
    const joinMeta = await visualRelationshipMetadata(relatedTable, body);
    const primaryKeys = Array.isArray(joinMeta && joinMeta.primary_keys) ? joinMeta.primary_keys : [];
    const primaryJoinColumn = primaryKeys.some(function(key) {
      return String(key || '').trim().toLowerCase() === String(joinColumn || '').trim().toLowerCase();
    });
    const relationships = Array.isArray(body && body.model && body.model.relationships) ? body.model.relationships : [];
    const declaredOneSide = relationships.some(function(rel) {
      if (!rel || rel.active === false) return false;
      const cardinality = String(rel.cardinality || '').toLowerCase().replace(/\s+/g, '');
      const tableKey = normalizeTableKey(relatedTable);
      const columnKey = String(joinColumn || '').trim().toLowerCase();
      if (['one-to-many', '1:*', '1:n'].includes(cardinality)) {
        return normalizeTableKey(rel.fromTable) === tableKey && String(rel.fromColumn || '').trim().toLowerCase() === columnKey;
      }
      if (['many-to-one', '*:1', 'n:1'].includes(cardinality)) {
        return normalizeTableKey(rel.toTable) === tableKey && String(rel.toColumn || '').trim().toLowerCase() === columnKey;
      }
      return false;
    });
    // A fact/many-side source must retain every row so its measures aggregate
    // correctly. DISTINCT * here both changed semantics and forced a full wide
    // scan before the JOIN on large imported fact tables.
    if (primaryJoinColumn || declaredOneSide || options.preserveManyRows === true) return joinTableSql + ' ' + joinAlias;
  } catch (e) {}
  return `(SELECT DISTINCT * FROM ${joinTableSql}) ${joinAlias}`;
}

function relationshipTargetIsMany(rel, targetTable) {
  if (!rel) return false;
  const cardinality = String(rel.cardinality || '').toLowerCase().replace(/\s+/g, '');
  const targetKey = normalizeTableKey(targetTable);
  if (['one-to-many', '1:*', '1:n'].includes(cardinality)) return normalizeTableKey(rel.toTable) === targetKey;
  if (['many-to-one', '*:1', 'n:1'].includes(cardinality)) return normalizeTableKey(rel.fromTable) === targetKey;
  if (['many-to-many', '*:*', 'n:n'].includes(cardinality)) return true;
  return false;
}

async function visualFilteredLookupJoinSourceSql(spec, alias) {
  const lookupTable = normalizeTableName(spec && spec.table);
  const joinAlias = String(alias || '').trim();
  if (!lookupTable || !joinAlias || !spec.keyColumn || !spec.valueColumn) {
    throw apiError('Lookup DAX sem tabela, chave ou valor.', 400);
  }
  let lookupTableSql = quoteIdent(lookupTable);
  try {
    const resolved = await resolvePgCacheLookup(lookupTable);
    lookupTableSql = quoteIdent(resolved.table || lookupTable);
  } catch (err) {}
  const sourceAlias = 'lookup_src';
  const keySql = sourceAlias + '.' + quoteIdent(spec.keyColumn);
  const valueSql = sourceAlias + '.' + quoteIdent(spec.valueColumn);
  return `(SELECT ${keySql} AS ${quoteIdent(spec.keyColumn)}, ` +
    `CASE WHEN COUNT(DISTINCT ${valueSql}) = 1 THEN MIN(${valueSql}) ELSE NULL END AS ${quoteIdent(spec.valueColumn)} ` +
    `FROM ${lookupTableSql} ${sourceAlias} GROUP BY ${keySql}) ${joinAlias}`;
}

async function visualPreAggregatedMeasureJoinSourceSql(tableName, alias, body, joinColumn, entries) {
  const table = normalizeTableName(tableName);
  const sourceAlias = '__biwa_pre_src';
  let tableSql = quoteIdent(table);
  try {
    const resolved = await resolvePgCacheLookup(table);
    tableSql = quoteIdent(resolved.table || table);
  } catch (error) {}
  const measureLookup = buildMeasureLookup(body.model || {});
  const groupColumns = [];
  const seenColumns = new Set();
  function addGroupColumn(column) {
    const value = String(column || '').trim();
    const key = normalizeColumnNameForMatch(value);
    if (!value || !key || seenColumns.has(key)) return;
    seenColumns.add(key);
    groupColumns.push(value);
  }
  addGroupColumn(joinColumn);
  normalizeVisualQueryFieldObjects(body.fields).forEach(function(field) {
    if (normalizeTableKey(field.table) !== normalizeTableKey(table)) return;
    if (measureLookup.has(normalizeMeasureNameKey(field.name))) return;
    addGroupColumn(field.name);
  });
  const aliases = new Map([[table, sourceAlias], [normalizeTableKey(table), sourceAlias]]);
  const projections = groupColumns.map(function(column) {
    return sourceAlias + '.' + quoteIdent(column) + ' AS ' + quoteIdent(column);
  });
  for (const entry of entries instanceof Map ? entries.values() : []) {
    const context = {
      model: body.model,
      measureLookup,
      currentMeasure: entry.measure.name,
      stack: [normalizeMeasureNameKey(entry.measure.name || entry.measure.displayName)],
      filterContext: ensureDaxFilterContext({})
    };
    const compiled = restoreCompiledDaxGeneratedSqlTokens(
      compileDaxExpression(entry.measure.formula, aliases, context),
      context
    );
    projections.push(compiled + ' AS ' + quoteIdent(entry.outputAlias));
  }
  if (!projections.length) throw apiError('Inconsistencia do planner SQL: subplano agregado sem projecoes para "' + table + '".', 400);
  const groupBy = groupColumns.map(function(column) { return sourceAlias + '.' + quoteIdent(column); });
  return '(SELECT ' + projections.join(', ') + ' FROM ' + tableSql + ' ' + sourceAlias +
    (groupBy.length ? ' GROUP BY ' + groupBy.join(', ') : '') + ') ' + alias;
}

function buildVisualMeasureJoinPlan(baseTable, measureTables, model, formula) {
  const base = normalizeTableName(baseTable);
  const baseKey = normalizeTableKey(base);
  const lookupSpecs = daxFilteredLookupSpecs(formula || '');
  const activeRelationships = Array.isArray(model && model.relationships)
    ? model.relationships.filter(function(relationship) { return relationship && relationship.active !== false; })
    : [];
  const maxDepth = Math.max(4, Math.min(32, activeRelationships.length + 1));
  const requestedTables = [];
  const requestedKeys = new Set();
  [base, ...(Array.isArray(measureTables) ? measureTables : [])].forEach(function(tableName) {
    const canonical = normalizeTableName(tableName);
    const key = normalizeTableKey(canonical);
    if (!key || requestedKeys.has(key)) return;
    requestedKeys.add(key);
    requestedTables.push(canonical);
  });

  const nodes = [];
  const nodeByKey = new Map();
  const joins = [];
  const unreachable = new Set();
  function addNode(tableName, parentKey, join) {
    const canonical = normalizeTableName(tableName);
    const key = normalizeTableKey(canonical);
    if (!key || nodeByKey.has(key)) return nodeByKey.get(key) || null;
    const node = { table: canonical, key, parentKey: parentKey || '', alias: '' };
    nodes.push(node);
    nodeByKey.set(key, node);
    if (join) joins.push({ ...join, targetTable: canonical, targetKey: key });
    return node;
  }
  addNode(base, '', null);

  for (const requestedTable of requestedTables) {
    const targetKey = normalizeTableKey(requestedTable);
    if (!targetKey || targetKey === baseKey || nodeByKey.has(targetKey)) continue;
    const lookupSpec = lookupSpecs.find(function(spec) {
      return normalizeTableKey(spec.table) === targetKey && normalizeTableKey(spec.sourceTable) === baseKey;
    });
    if (lookupSpec) {
      addNode(requestedTable, baseKey, {
        kind: 'lookup',
        sourceTable: base,
        sourceKey: baseKey,
        lookupSpec
      });
      continue;
    }

    const path = findRelationshipPath(model, base, requestedTable, maxDepth);
    if (!path || !Array.isArray(path.relationships) || !path.relationships.length) {
      unreachable.add(targetKey);
      continue;
    }
    const pathNodes = Array.isArray(path.nodes) ? path.nodes : [];
    let sourceTable = base;
    let sourceKey = baseKey;
    for (let index = 0; index < path.relationships.length; index += 1) {
      const targetTable = normalizeTableName(pathNodes[index + 1]);
      const nextKey = normalizeTableKey(targetTable);
      const existing = nodeByKey.get(nextKey);
      if (!existing) {
        addNode(targetTable, sourceKey, {
          kind: 'relationship',
          sourceTable,
          sourceKey,
          relationship: path.relationships[index]
        });
      }
      sourceTable = nodeByKey.get(nextKey).table;
      sourceKey = nextKey;
    }
  }

  // Aliases are assigned only after the complete logical path is known. This
  // prevents a dependency from retaining an alias that was never materialized.
  const aliases = new Map();
  nodes.forEach(function(node, index) {
    node.alias = index === 0 ? 'src' : 't' + index;
    aliases.set(node.table, node.alias);
    aliases.set(node.key, node.alias);
  });
  for (const requestedTable of requestedTables) {
    const key = normalizeTableKey(requestedTable);
    if (!unreachable.has(key)) continue;
    const alias = 't' + nodes.length;
    const node = { table: requestedTable, key, parentKey: '', alias, unreachable: true };
    nodes.push(node);
    nodeByKey.set(key, node);
    aliases.set(node.table, alias);
    aliases.set(node.key, alias);
  }
  return { baseTable: base, baseKey, aliases, nodes, nodeByKey, joins, unreachable };
}

function disconnectedDaxAggregateTables(baseTable, measureTables, model, formula, existingPlan) {
  const plan = existingPlan || buildVisualMeasureJoinPlan(baseTable, measureTables, model, formula);
  return new Set(plan.unreachable || []);
}

function sqlWithoutQuotedValues(sql) {
  const source = String(sql || '');
  let output = '';
  let quote = '';
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index];
    if (quote) {
      output += ' ';
      if (ch === quote) {
        if (source[index + 1] === quote) {
          output += ' ';
          index += 1;
        } else {
          quote = '';
        }
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      output += ' ';
      continue;
    }
    output += ch;
  }
  return output;
}

function visualJoinPlanReferencedAliases(sqlFragments, plan) {
  const referenced = new Set();
  if (!plan || !Array.isArray(plan.nodes)) return referenced;
  const source = sqlWithoutQuotedValues((Array.isArray(sqlFragments) ? sqlFragments : [sqlFragments]).filter(Boolean).join('\n'));
  plan.nodes.forEach(function(node) {
    const escaped = String(node.alias || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (escaped && new RegExp('(?:^|[^A-Za-z0-9_])' + escaped + '\\s*\\.', 'm').test(source)) referenced.add(node.alias);
  });
  return referenced;
}

function createVisualMeasureJoinState(plan) {
  const baseNode = plan && plan.nodeByKey && plan.nodeByKey.get(plan.baseKey);
  return {
    declaredTableKeys: new Set(baseNode ? [baseNode.key] : []),
    declaredAliases: new Set(baseNode ? [baseNode.alias] : ['src']),
    tableAliases: new Map(baseNode ? [[baseNode.key, baseNode.alias]] : [])
  };
}

async function appendVisualMeasureJoins(fromSql, body, plan, state, sqlFragments, extraAliases) {
  if (!plan || !state) return String(fromSql || '');
  let sql = String(fromSql || '');
  const visualMeasureLookup = buildMeasureLookup(body.model || {});
  const referencedAliases = visualJoinPlanReferencedAliases(sqlFragments, plan);
  (Array.isArray(extraAliases) ? extraAliases : []).forEach(function(alias) {
    if (alias) referencedAliases.add(alias);
  });
  const requiredKeys = new Set();
  for (const alias of referencedAliases) {
    const node = plan.nodes.find(function(candidate) { return candidate.alias === alias; });
    if (!node || node.key === plan.baseKey) continue;
    if (node.unreachable) {
      throw apiError('Inconsistencia do planner SQL: o alias "' + alias + '" da tabela "' + node.table + '" foi referenciado, mas nao existe caminho de relacionamento ativo a partir de "' + plan.baseTable + '".', 400);
    }
    let cursor = node;
    while (cursor && cursor.key !== plan.baseKey) {
      requiredKeys.add(cursor.key);
      cursor = plan.nodeByKey.get(cursor.parentKey);
    }
  }

  for (const join of plan.joins) {
    if (!requiredKeys.has(join.targetKey) || state.declaredTableKeys.has(join.targetKey)) continue;
    if (!state.declaredTableKeys.has(join.sourceKey)) {
      throw apiError('Inconsistencia do planner SQL: a origem "' + join.sourceTable + '" nao foi materializada antes de "' + join.targetTable + '".', 400);
    }
    const sourceNode = plan.nodeByKey.get(join.sourceKey);
    const targetNode = plan.nodeByKey.get(join.targetKey);
    if (!sourceNode || !targetNode) throw apiError('Inconsistencia do planner SQL: no logico ausente no plano de JOIN.', 400);
    const targetHasVisibleColumn = normalizeVisualQueryFieldObjects(body.fields).some(function(field) {
      return normalizeTableKey(field.table) === targetNode.key && !visualMeasureLookup.has(normalizeMeasureNameKey(field.name));
    });
    const joinKeyword = targetHasVisibleColumn ? ' JOIN ' : ' LEFT JOIN ';
    if (join.kind === 'lookup') {
      const joinSourceSql = await visualFilteredLookupJoinSourceSql(join.lookupSpec, targetNode.alias);
      sql += joinKeyword + joinSourceSql +
        ' ON ' + await visualRelationshipJoinCondition(targetNode.alias, targetNode.table, join.lookupSpec.keyColumn, sourceNode.alias, sourceNode.table, join.lookupSpec.sourceColumn, body);
    } else {
      const columns = relationshipColumnForTarget(join.relationship, sourceNode.table, targetNode.table);
      if (!columns) throw apiError('O caminho de relacionamento entre "' + sourceNode.table + '" e "' + targetNode.table + '" esta invalido.', 400);
      const preAggregatedEntries = plan.preAggregatedMeasureRegistry instanceof Map
        ? plan.preAggregatedMeasureRegistry.get(targetNode.key)
        : null;
      const joinSourceSql = preAggregatedEntries instanceof Map && preAggregatedEntries.size
        ? await visualPreAggregatedMeasureJoinSourceSql(targetNode.table, targetNode.alias, body, columns.targetColumn, preAggregatedEntries)
        : await visualJoinSourceSql(targetNode.table, targetNode.alias, body, columns.targetColumn, {
            preserveManyRows: relationshipTargetIsMany(join.relationship, targetNode.table)
          });
      sql += joinKeyword + joinSourceSql +
        ' ON ' + await visualRelationshipJoinCondition(targetNode.alias, targetNode.table, columns.targetColumn, sourceNode.alias, sourceNode.table, columns.sourceColumn, body);
    }
    state.declaredTableKeys.add(targetNode.key);
    state.declaredAliases.add(targetNode.alias);
    state.tableAliases.set(targetNode.key, targetNode.alias);
  }

  const unresolved = [...referencedAliases].filter(function(alias) { return !state.declaredAliases.has(alias); });
  if (unresolved.length) {
    throw apiError('Inconsistencia do planner SQL: alias referenciado sem entrada no FROM/JOIN: ' + unresolved.join(', ') + '.', 400);
  }
  return sql;
}

async function buildVisualQueryFromRequest(body) {
  const visualPerf = body && body._visualPerf && typeof body._visualPerf === 'object' ? body._visualPerf : { daxMs: 0 };
  if (body && !body._visualPerf) body._visualPerf = visualPerf;
  let runtimeFiltersEmbedded = false;
  let runtimeFilterTargetCount = 1;
  let runtimeFilterParamSegments = null;
  function compileVisualDax(formula, aliases, options) {
    const startedAt = performance.now();
    try { return restoreCompiledDaxGeneratedSqlTokens(compileDaxExpression(formula, aliases, options), options); }
    finally { visualPerf.daxMs += performance.now() - startedAt; }
  }
  const compiledVisualMeasureFilterContexts = [];
  let primaryMeasureFilterContext = null;
  function registerVisualMeasureFilterContext(filterContext, primary = false) {
    const normalized = ensureDaxFilterContext({ filterContext });
    compiledVisualMeasureFilterContexts.push(normalized);
    if (primary) primaryMeasureFilterContext = normalized;
  }
  function visualDaxFilterContext() {
    return intersectDaxFilterContexts(compiledVisualMeasureFilterContexts);
  }
  function visualQueryPayload(sql, queryParams, queryTable) {
    const safeParams = Array.isArray(queryParams) ? queryParams : [];
    if (compiledMeasureJoinPlan && compiledMeasureJoinState) {
      const referencedAliases = visualJoinPlanReferencedAliases([sql], compiledMeasureJoinPlan);
      const missingAliases = [...referencedAliases].filter(function(alias) {
        return !compiledMeasureJoinState.declaredAliases.has(alias);
      });
      if (missingAliases.length) {
        visualFieldDebug('SQL PLANNER INCONSISTENCY', {
          visualId: String(body.visualId || ''),
          referencedAliases: [...referencedAliases],
          declaredAliases: [...compiledMeasureJoinState.declaredAliases],
          missingAliases,
          requiredTables: compiledMeasureJoinPlan.nodes.map(function(node) { return node.table; })
        });
        throw apiError('Inconsistencia interna no plano SQL: alias referenciado sem FROM/JOIN (' + missingAliases.join(', ') + ').', 500);
      }
      visualFieldDebug('SQL ALIAS VALIDATION', {
        visualId: String(body.visualId || ''),
        referencedAliases: [...referencedAliases],
        declaredAliases: [...compiledMeasureJoinState.declaredAliases],
        valid: true
      });
    }
    return {
      sql,
      params: safeParams,
      storedSql: inlineSqlParams(sql, safeParams),
      table: queryTable,
      daxFilterContext: visualDaxFilterContext(),
      runtimeFiltersEmbedded,
      runtimeFilterTargetCount,
      runtimeFilterParamSegments
    };
  }
  let table = normalizeTableName(body.table);
  if (!table) throw apiError('Selecione uma tabela, view ou consulta transformada.', 400);
  const dimension = String(body.dimension || '').trim();
  const value = String(body.value || '').trim();
  const secondaryValue = String(body.secondaryValue || '').trim();
  const agg = String(body.aggregation || 'SUM').toUpperCase();
  const order = String(body.order || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  const limit = clampLimit(body.limit, 200);
  const suppressOrderLimit = body._suppressOrderLimit === true;
  const requestedFields = normalizeVisualQueryFields(body.fields);
  const requestedFieldObjects = normalizeVisualQueryFieldObjects(body.fields);
  const visualization = String(body.visualization || 'table').toLowerCase();
  const rawColumnPreview = visualization === 'table' || visualization === 'matrix';
  const requestMeasureLookup = buildMeasureLookup(body.model || {});
  function visualMeasurePlanningInput(primaryMeasure) {
    const measures = [];
    const seenMeasures = new Set();
    function addMeasure(candidate) {
      if (!candidate || !String(candidate.formula || '').trim()) return;
      const key = normalizeMeasureNameKey(candidate.name || candidate.displayName);
      if (!key || seenMeasures.has(key)) return;
      seenMeasures.add(key);
      measures.push(candidate);
    }
    addMeasure(primaryMeasure);
    [value, secondaryValue, dimension, ...requestedFields].forEach(function(name) {
      addMeasure(requestMeasureLookup.get(normalizeMeasureNameKey(name)));
    });
    const tables = [];
    const seenTables = new Set();
    measures.forEach(function(measure) {
      tablesUsedByMeasureWithDependencies(measure, body.model).forEach(function(tableName) {
        const key = normalizeTableKey(tableName);
        if (!key || seenTables.has(key)) return;
        seenTables.add(key);
        tables.push(tableName);
      });
    });
    return { measures, tables, formula: measures.map(function(measure) { return measure.formula; }).join('\n') };
  }
  function valuesIteratorForMeasureName(name) {
    const measure = requestMeasureLookup.get(normalizeMeasureNameKey(name));
    if (!measure || !String(measure.formula || '').trim()) return null;
    try { return parseDaxValuesIterator(measure.formula); }
    catch (error) { return null; }
  }
  async function buildPostAggregateMeasureProjection() {
    if (body._skipPostAggregateMeasurePlan === true || !body.model || !Array.isArray(body.model.measures)) return null;
    const candidateNames = [...requestedFields, value, secondaryValue, dimension].map(function(name) { return String(name || '').trim(); }).filter(Boolean);
    const requestedMeasures = [];
    const requestedMeasureKeys = new Set();
    candidateNames.forEach(function(name) {
      const measure = requestMeasureLookup.get(normalizeMeasureNameKey(name));
      const key = normalizeMeasureNameKey(measure && (measure.name || measure.displayName));
      if (!measure || !key || requestedMeasureKeys.has(key)) return;
      requestedMeasureKeys.add(key);
      requestedMeasures.push(measure);
    });
    // A ordem em que o usuário posiciona colunas no visual deve afetar apenas
    // a projeção final. O plano semântico, especialmente a escolha da âncora
    // de um iterador, precisa ser estável para não mudar a população paginada.
    const compareMeasurePlanOrder = function(left, right) {
      return normalizeMeasureNameKey(left && (left.name || left.displayName))
        .localeCompare(normalizeMeasureNameKey(right && (right.name || right.displayName)), 'pt-BR');
    };
    requestedMeasures.sort(compareMeasurePlanOrder);
    const planMemo = new Map();
    const stagedRoots = requestedMeasures.filter(function(measure) {
      const plan = daxMeasureAggregationPlan(measure, body.model, planMemo);
      return Boolean(plan && plan.requiresPostAggregateProjection);
    });
    if (!stagedRoots.length) return null;

    const executionMeasures = new Map();
    requestedMeasures.forEach(function(measure) {
      const plan = daxMeasureAggregationPlan(measure, body.model, planMemo);
      if (plan && plan.requiresPostAggregateProjection) {
        collectDaxPostAggregateExecutionMeasures(measure, body.model, executionMeasures, planMemo);
      } else {
        executionMeasures.set(normalizeMeasureNameKey(measure.name || measure.displayName), measure);
      }
    });
    const executionList = [...executionMeasures.values()].sort(compareMeasurePlanOrder);
    const iteratorAnchor = executionList.find(function(measure) {
      const plan = daxMeasureAggregationPlan(measure, body.model, planMemo);
      return Boolean(plan && plan.directValuesIterator);
    });
    if (!iteratorAnchor) {
      throw apiError('Inconsistencia do planner DAX: uma projecao pos-agregacao foi solicitada sem uma dependencia materializavel.', 500);
    }

    const rawFields = requestedFieldObjects.filter(function(field) {
      return !requestMeasureLookup.has(normalizeMeasureNameKey(field.name));
    });
    const executionFields = executionList.map(function(measure) {
      const name = measure.name || measure.displayName;
      const configured = requestedFieldObjects.find(function(field) { return normalizeMeasureNameKey(field.name) === normalizeMeasureNameKey(name); });
      return configured || { name, table: measure.table || table, type: 'measure', fieldType: 'measure', semanticType: 'measure', measureId: name };
    });
    const childBody = {
      ...body,
      value: iteratorAnchor.name || iteratorAnchor.displayName,
      dimension: rawFields.some(function(field) { return normalizeMeasureNameKey(field.name) === normalizeMeasureNameKey(dimension); }) ? dimension : (rawFields[0] && rawFields[0].name || ''),
      fields: [...rawFields, ...executionFields],
      _skipPostAggregateMeasurePlan: true,
      _suppressOrderLimit: true,
      _visualPerf: visualPerf
    };
    const child = await buildVisualQueryFromRequest(childBody);
    let stagedSql = child.sql;
    const availableMeasures = new Map(executionList.map(function(measure) {
      return [normalizeMeasureNameKey(measure.name || measure.displayName), measure];
    }));
    const stagedOrder = [];
    const stagedKeys = new Set();
    stagedRoots.forEach(function(root) {
      daxMeasureDependencyOrder(body.model, root.name || root.displayName).forEach(function(measure) {
        const key = normalizeMeasureNameKey(measure && (measure.name || measure.displayName));
        const plan = daxMeasureAggregationPlan(measure, body.model, planMemo);
        if (!key || !plan || !plan.requiresPostAggregateProjection || stagedKeys.has(key)) return;
        stagedKeys.add(key);
        stagedOrder.push(measure);
      });
    });
    const logicalLayers = [];
    stagedOrder.forEach(function(measure, index) {
      const inputAlias = '__biwa_measure_stage_' + index;
      const projectedMeasureSqlByKey = new Map();
      availableMeasures.forEach(function(available, key) {
        projectedMeasureSqlByKey.set(key, inputAlias + '.' + quoteIdent(available.name || available.displayName));
      });
      const unresolved = daxMeasureReferences(measure.formula || '', body.model).filter(function(name) {
        return !projectedMeasureSqlByKey.has(normalizeMeasureNameKey(name));
      });
      if (unresolved.length) {
        throw apiError('Inconsistencia do planner DAX: dependencias nao materializadas antes de "' + (measure.name || measure.displayName) + '": ' + unresolved.join(', ') + '.', 500);
      }
      const measureFilterContext = ensureDaxFilterContext({});
      const expressionSql = compileVisualDax(measure.formula, new Map(), {
        model: body.model,
        measureLookup: requestMeasureLookup,
        currentMeasure: measure.name,
        stack: [normalizeMeasureNameKey(measure.name || measure.displayName)],
        filterContext: measureFilterContext,
        projectedMeasureSqlByKey
      });
      registerVisualMeasureFilterContext(measureFilterContext);
      stagedSql = 'SELECT ' + inputAlias + '.*, ' + expressionSql + ' AS ' + quoteIdent(measure.name || measure.displayName) + ' FROM (' + stagedSql + ') ' + inputAlias;
      availableMeasures.set(normalizeMeasureNameKey(measure.name || measure.displayName), measure);
      const plan = daxMeasureAggregationPlan(measure, body.model, planMemo);
      logicalLayers.push({ name: measure.name || measure.displayName, aggregationLevel: plan.aggregationLevel, executionKind: plan.executionKind });
    });

    const outputFields = [];
    const outputKeys = new Set();
    requestedFieldObjects.forEach(function(field) {
      const name = String(field && field.name || '').trim();
      const key = normalizeMeasureNameKey(name);
      if (!name || outputKeys.has(key)) return;
      outputKeys.add(key);
      outputFields.push(name);
    });
    if (!outputFields.length) candidateNames.forEach(function(name) {
      const key = normalizeMeasureNameKey(name);
      if (!key || outputKeys.has(key)) return;
      outputKeys.add(key);
      outputFields.push(name);
    });
    const finalAlias = '__biwa_measure_projection';
    const projections = outputFields.map(function(name) {
      return finalAlias + '.' + quoteIdent(name) + ' AS ' + quoteIdent(name);
    });
    let sql = 'SELECT ' + projections.join(', ') + ' FROM (' + stagedSql + ') ' + finalAlias;
    if (!suppressOrderLimit) {
      const requestedOrder = outputFields.find(function(name) { return normalizeMeasureNameKey(name) === normalizeMeasureNameKey(value); })
        || outputFields.find(function(name) { return requestMeasureLookup.has(normalizeMeasureNameKey(name)); })
        || outputFields[0];
      // A medida escolhida para ordenar pode empatar em muitas linhas. Sem uma
      // segunda ordenação determinística, a ordem de campos do visual pode mudar
      // quais linhas ficam dentro do LIMIT, embora a semântica seja a mesma.
      // Dimensões só desempatarão a paginação; elas não alteram a projeção nem o
      // contexto usado no cálculo das medidas.
      const stableOrderDimensions = outputFields
        .filter(function(name) {
          const key = normalizeMeasureNameKey(name);
          return key !== normalizeMeasureNameKey(requestedOrder) && !requestMeasureLookup.has(key);
        })
        .sort(function(left, right) {
          return normalizeColumnNameForMatch(left).localeCompare(normalizeColumnNameForMatch(right), 'pt-BR');
        });
      sql += ' ORDER BY ' + quoteIdent(requestedOrder) + ' ' + order +
        stableOrderDimensions.map(function(name) { return ', ' + quoteIdent(name) + ' ASC'; }).join('') +
        ' LIMIT ' + limit;
    }
    visualFieldDebug('POST AGGREGATE MEASURE PLAN', {
      visualId: String(body.visualId || ''),
      roots: stagedRoots.map(function(measure) { return measure.name || measure.displayName; }),
      executionMeasures: executionList.map(function(measure) { return measure.name || measure.displayName; }),
      layers: logicalLayers,
      queryCount: 1
    });
    return {
      ...child,
      sql,
      storedSql: inlineSqlParams(sql, child.params || []),
      stagedMeasurePlan: { roots: stagedRoots.map(function(measure) { return measure.name || measure.displayName; }), executionMeasures: executionList.map(function(measure) { return measure.name || measure.displayName; }), layers: logicalLayers }
    };
  }
  const stagedMeasureQuery = await buildPostAggregateMeasureProjection();
  if (stagedMeasureQuery) return stagedMeasureQuery;
  let measureExecutionAnchorName = value;
  let measureExecutionAnchorReason = 'visual-value';
  if (rawColumnPreview && requestedFields.length) {
    const valueIterator = valuesIteratorForMeasureName(value);
    if (valueIterator) {
      measureExecutionAnchorReason = 'visual-value-values-iterator';
    } else {
      const iteratorFieldName = requestedFields.find(function(field) { return Boolean(valuesIteratorForMeasureName(field)); });
      if (iteratorFieldName) {
        const iteratorMeasure = requestMeasureLookup.get(normalizeMeasureNameKey(iteratorFieldName));
        measureExecutionAnchorName = String(iteratorMeasure && (iteratorMeasure.name || iteratorMeasure.displayName) || iteratorFieldName).trim();
        measureExecutionAnchorReason = 'values-iterator-row-context';
      }
    }
  }
  visualFieldDebug('QUERY REQUEST', {
    visualId: String(body.visualId || ''),
    visualization,
    table,
    dimension,
    value,
    fields: requestedFieldObjects.map(function(field) {
      const measure = requestMeasureLookup.get(normalizeMeasureNameKey(field.name));
      return { name: field.name, table: field.table || '', type: measure ? 'measure' : (field.type || 'column') };
    })
  });
  visualFieldDebug('QUERY PLAN', {
    visualId: String(body.visualId || ''),
    executionAnchor: measureExecutionAnchorName,
    reason: measureExecutionAnchorReason
  });
  table = await inferVisualBaseTableForFields(table, body, requestedFields);
  if (rawColumnPreview) table = preferManySideVisualBaseTable(table, body.model, requestedFieldObjects);

  // Check if value is a model measure — compile DAX to SQL
  let compiledMeasureSql = null;
  let compiledMeasureName = '';
  let compiledMeasureAliases = null;
  let compiledMeasureTables = [];
  let compiledMeasureError = '';
  let compiledMeasureFormula = '';
  let compiledMeasureValuesIterator = null;
  let compiledMeasureScalarTables = new Set();
  let compiledMeasurePreAggregates = new Map();
  let compiledMeasureJoinPlan = null;
  let compiledMeasureJoinState = null;
  if (measureExecutionAnchorName && body.model && Array.isArray(body.model.measures) && body.model.measures.length) {
    const measureLookup = buildMeasureLookup(body.model);
    const measureKey = normalizeMeasureNameKey(measureExecutionAnchorName);
    const measure = measureLookup.get(measureKey);
    if (measure && String(measure.formula || '').trim()) {
      const diag = analyzeDaxMeasure(measure, body.model);
      if (diag.status === 'ok' || diag.status === 'ok_com_dependencia') {
        const planningInput = visualMeasurePlanningInput(measure);
        const measureTables = planningInput.tables;
        console.log('[DAX] Medida "' + measureExecutionAnchorName + '" diagnostic OK. Status=' + diag.status + ', tables=' + JSON.stringify(measureTables || []));
        compiledMeasureJoinPlan = buildVisualMeasureJoinPlan(table, measureTables, body.model, planningInput.formula || measure.formula);
        const aliases = compiledMeasureJoinPlan.aliases;
        compiledMeasureTables = compiledMeasureJoinPlan.nodes.map(function(node) { return node.table; });
        compiledMeasureScalarTables = disconnectedDaxAggregateTables(table, compiledMeasureTables, body.model, measure.formula, compiledMeasureJoinPlan);
        const measureFilterContext = ensureDaxFilterContext({});
        try {
          const valuesIterator = parseDaxValuesIterator(measure.formula);
          const formulaToCompile = valuesIterator ? valuesIterator.expression : measure.formula;
          const preAggregateTables = new Set(compiledMeasureJoinPlan.nodes
            .filter(function(node) { return node.key !== compiledMeasureJoinPlan.baseKey && !node.unreachable; })
            .map(function(node) { return node.key; }));
          const preAggregatedMeasureRegistry = new Map();
          seedVisualPreAggregatedMeasures(preAggregatedMeasureRegistry, planningInput.measures, preAggregateTables, body.model);
          compiledMeasureSql = compileVisualDax(formulaToCompile, aliases, {
            model: body.model,
            measureLookup: buildMeasureLookup(body.model),
            currentMeasure: measure.name,
            stack: [normalizeMeasureNameKey(measure.name || measure.displayName)],
            filterContext: measureFilterContext,
            daxVariables: valuesIterator ? valuesIterator.variableScope : undefined,
            scalarSubqueryTables: compiledMeasureScalarTables,
            preAggregateMeasureTables: preAggregateTables,
            preAggregatedMeasureRegistry
          });
          compiledMeasurePreAggregates = preAggregatedMeasureRegistry;
          compiledMeasureValuesIterator = valuesIterator;
          console.log('[DAX] Medida "' + measureExecutionAnchorName + '" compilada: ' + compiledMeasureSql.substring(0, 200));
          compiledMeasureName = measure.name || measureExecutionAnchorName;
          compiledMeasureAliases = aliases;
          compiledMeasureFormula = measure.formula;
          registerVisualMeasureFilterContext(measureFilterContext, true);
          visualFieldDebug('DAX RESOLVER', {
            visualId: String(body.visualId || ''),
            measure: compiledMeasureName,
            dependencies: Array.isArray(diag.dependencies) ? diag.dependencies : [],
            valuesIterator: valuesIterator ? { table: valuesIterator.table, column: valuesIterator.column } : null
          });
        } catch (err) {
          compiledMeasureError = err.message || 'Erro de compilação DAX.';
        }
      } else {
        console.log('[DAX] Medida "' + measureExecutionAnchorName + '" diagnostic: ' + diag.status + ' - ' + (diag.message || ''));
        compiledMeasureError = diag.message || ('Status: ' + diag.status);
      }
    } else if (measure) {
      compiledMeasureError = 'Medida "' + measureExecutionAnchorName + '" não encontrada ou sem fórmula.';
    } else if (!rawColumnPreview) {
      compiledMeasureError = 'Medida "' + value + '" não encontrada ou sem fórmula.';
    }
  } else if (value && !rawColumnPreview) {
    compiledMeasureError = 'Modelo não enviado pelo frontend. Recarregue a página.';
  }
  // Fallback: quando uma medida aparece nos campos (requestedFields) mas nao foi
  // compilada via value, tente compilar a medida dos campos (ex: arrastada para tabela/matriz)
  if (!compiledMeasureSql && !compiledMeasureError && requestedFields.length && body.model && Array.isArray(body.model.measures) && body.model.measures.length) {
    const fieldsMeasureLookup = buildMeasureLookup(body.model);
    const measureNamesInModelSet = new Set(
      body.model.measures.filter(function(m) { return String(m.formula || '').trim(); })
        .map(function(m) { return normalizeMeasureNameKey(m.name); })
    );
    const fieldMeasureName = requestedFields.find(function(f) { return measureNamesInModelSet.has(normalizeMeasureNameKey(f)); });
    if (fieldMeasureName) {
      const fmKey = normalizeMeasureNameKey(fieldMeasureName);
      const fm = fieldsMeasureLookup.get(fmKey);
      if (fm && String(fm.formula || '').trim()) {
        const fmDiag = analyzeDaxMeasure(fm, body.model);
        if (fmDiag.status === 'ok' || fmDiag.status === 'ok_com_dependencia') {
          const planningInput = visualMeasurePlanningInput(fm);
          compiledMeasureJoinPlan = buildVisualMeasureJoinPlan(table, planningInput.tables, body.model, planningInput.formula || fm.formula);
          const fmAliases = compiledMeasureJoinPlan.aliases;
          compiledMeasureTables = compiledMeasureJoinPlan.nodes.map(function(node) { return node.table; });
          compiledMeasureScalarTables = disconnectedDaxAggregateTables(table, compiledMeasureTables, body.model, fm.formula, compiledMeasureJoinPlan);
          const measureFilterContext = ensureDaxFilterContext({});
          try {
            const valuesIterator = parseDaxValuesIterator(fm.formula);
            const formulaToCompile = valuesIterator ? valuesIterator.expression : fm.formula;
            const preAggregateTables = new Set(compiledMeasureJoinPlan.nodes
              .filter(function(node) { return node.key !== compiledMeasureJoinPlan.baseKey && !node.unreachable; })
              .map(function(node) { return node.key; }));
            const preAggregatedMeasureRegistry = new Map();
            seedVisualPreAggregatedMeasures(preAggregatedMeasureRegistry, planningInput.measures, preAggregateTables, body.model);
            compiledMeasureSql = compileVisualDax(formulaToCompile, fmAliases, {
              model: body.model,
              measureLookup: buildMeasureLookup(body.model),
              currentMeasure: fm.name,
              stack: [normalizeMeasureNameKey(fm.name || fm.displayName)],
              filterContext: measureFilterContext,
              daxVariables: valuesIterator ? valuesIterator.variableScope : undefined,
              scalarSubqueryTables: compiledMeasureScalarTables,
              preAggregateMeasureTables: preAggregateTables,
              preAggregatedMeasureRegistry
            });
            compiledMeasurePreAggregates = preAggregatedMeasureRegistry;
            compiledMeasureValuesIterator = valuesIterator;
            compiledMeasureName = fm.name || fieldMeasureName;
            compiledMeasureAliases = fmAliases;
            compiledMeasureFormula = fm.formula;
            registerVisualMeasureFilterContext(measureFilterContext, true);
          } catch (err) {
            compiledMeasureError = err.message || 'Erro de compilação DAX.';
          }
        } else {
          compiledMeasureError = fmDiag.message || ('Status: ' + fmDiag.status);
        }
      } else {
        compiledMeasureError = 'Medida "' + fieldMeasureName + '" não encontrada ou sem fórmula.';
      }
    }
  }
  // Para tabela e matriz, campos colocados em Eixo/Dimensao e Valores devem aparecer
  // como colunas imediatamente, igual ao Power BI. Se o front mandar apenas os buckets,
  // completamos a lista aqui para evitar SUM() em campo texto e preview vazio.
  if (['table', 'matrix'].includes(visualization)) {
    [dimension, value].forEach((field) => {
      if (field && !requestedFields.includes(field)) requestedFields.push(field);
    });
  }
  // Detecta se algum dos campos solicitados é uma medida (não coluna real)
  const measureNamesInModel = new Set(
    (Array.isArray(body.model && body.model.measures) ? body.model.measures : [])
      .filter(function(m) { return String(m.formula || '').trim(); })
      .map(function(m) { return m.name; })
  );
  const firstMeasureInFields = requestedFields.find(function(f) { return measureNamesInModel.has(f); });
  const hasMeasureInFields = Boolean(firstMeasureInFields);
  const canRawPreview = requestedFields.length && ['table', 'matrix'].includes(visualization) && !compiledMeasureSql && !hasMeasureInFields;
  if (hasMeasureInFields && !compiledMeasureSql) {
    const targetMeasure = value || firstMeasureInFields;
    const reason = compiledMeasureError || 'O modelo não foi enviado ou a fórmula DAX não pôde ser analisada.';
    throw apiError('A medida "' + targetMeasure + '" não pôde ser compilada: ' + reason, 400);
  }
  if (!canRawPreview && !dimension && value && agg !== 'COUNT' && !compiledMeasureSql) {
    // Visuais de valor unico (cartao/KPI/gauge) agregam sem eixo, como no Power BI.
  } else if (!canRawPreview && !dimension && agg !== 'COUNT' && !compiledMeasureSql) throw apiError('Selecione o eixo/dimensão.', 400);
  if (!canRawPreview && !value && agg !== 'COUNT' && !compiledMeasureSql) throw apiError('Selecione o valor.', 400);
  const transform = await findTransformByName(table);
  let fromSql;
  let params = [];
  if (table === CALENDAR_TABLE_NAME) {
    const calendarCols = [...requestedFields, dimension, value, String(body.filterColumn || '').trim(), ...(Array.isArray(body.visualFilters) ? body.visualFilters.map(function(f) { return f && f.column || ''; }) : []), ...(Array.isArray(body.pageFilters) ? body.pageFilters.map(function(f) { return f && f.column || ''; }) : []), ...(Array.isArray(body.allPagesFilters) ? body.allPagesFilters.map(function(f) { return f && f.column || ''; }) : [])].filter(Boolean);
    fromSql = calendarDerivedSql(calendarCols);
  } else if (transform) {
    const built = await buildTransformSql(transform, { limit: 0 });
    fromSql = `(${built.sql}) src`;
    params = built.params || [];
  } else {
    let meta;
    // Try PostgreSQL cache first to avoid slow MySQL calls
    if (postgresCacheAvailable()) {
      try {
        const resolved = await resolvePgCacheLookup(table);
        const pgMeta = await getPgCacheMeta(resolved.table || table);
        if (pgMeta) {
          meta = {
            name: table,
            physicalName: pgMeta.physical_table || table,
            sourceTable: pgMeta.physical_table || table,
            columns: pgMeta.columns || []
          };
        }
      } catch (e) { /* ignore PG cache errors */ }
    }
    if (!meta) {
      try {
        meta = await ensureTableExists(table);
      } catch (err) {
        if (!meta) throw err;
      }
    }
    const physicalTable = meta.physicalName || meta.sourceTable || meta.name || table;
    fromSql = `${quoteIdent(physicalTable)} src`;

  }

  // Resolve the complete relationship path before SQL is emitted. Only aliases
  // referenced by the compiled measure (plus its VALUES iterator) are materialized.
  if (compiledMeasureJoinPlan) {
    compiledMeasureJoinPlan.preAggregatedMeasureRegistry = compiledMeasurePreAggregates;
    compiledMeasureJoinState = createVisualMeasureJoinState(compiledMeasureJoinPlan);
    const iteratorAlias = compiledMeasureValuesIterator
      ? daxAliasFor(compiledMeasureAliases, compiledMeasureValuesIterator.table)
      : '';
    fromSql = await appendVisualMeasureJoins(
      fromSql,
      body,
      compiledMeasureJoinPlan,
      compiledMeasureJoinState,
      [compiledMeasureSql],
      [iteratorAlias]
    );
    visualFieldDebug('RELATIONSHIP PLAN', {
      visualId: String(body.visualId || ''),
      baseTable: compiledMeasureJoinPlan.baseTable,
      requiredTables: compiledMeasureJoinPlan.nodes.map(function(node) { return node.table; }),
      aliases: compiledMeasureJoinPlan.nodes.map(function(node) { return { table: node.table, alias: node.alias, declared: compiledMeasureJoinState.declaredAliases.has(node.alias) }; }),
      joins: compiledMeasureJoinPlan.joins.map(function(join) { return { from: join.sourceTable, to: join.targetTable, kind: join.kind }; })
    });
  }

  // Look up changeType steps from imported table to apply column type casts.
  // Skip for saved transforms and Calendario, which already handle their own type mapping.
  var castMap = transform || table === CALENDAR_TABLE_NAME ? new Map() : getChangeTypeCastMap(table);
  const rawFieldTableAliases = new Map();
  if (compiledMeasureJoinState) {
    compiledMeasureJoinState.tableAliases.forEach(function(alias, tableKey) {
      if (alias && alias !== 'src') rawFieldTableAliases.set(tableKey, alias);
    });
  }
  async function materializeAdditionalMeasureSql(fragment) {
    if (!compiledMeasureJoinPlan || !compiledMeasureJoinState || !fragment) return;
    fromSql = await appendVisualMeasureJoins(
      fromSql,
      body,
      compiledMeasureJoinPlan,
      compiledMeasureJoinState,
      [fragment],
      []
    );
    compiledMeasureJoinState.tableAliases.forEach(function(alias, tableKey) {
      if (alias && alias !== 'src') rawFieldTableAliases.set(tableKey, alias);
    });
  }
  function preAggregatedSelectedMeasureSql(measure) {
    const key = normalizeMeasureNameKey(measure && (measure.name || measure.displayName));
    if (!key || !(compiledMeasurePreAggregates instanceof Map)) return '';
    for (const [tableKey, entries] of compiledMeasurePreAggregates.entries()) {
      if (!(entries instanceof Map) || !entries.has(key)) continue;
      const entry = entries.get(key);
      const alias = compiledMeasureAliases && daxAliasFor(compiledMeasureAliases, entry.table || tableKey);
      if (alias) return 'MAX(' + alias + '.' + quoteIdent(entry.outputAlias) + ')';
    }
    return '';
  }
  let rawFieldAliasIndex = 1;
  const independentAggregateParams = [];
  async function ensureRawFieldTableJoin(fieldTable) {
    const relatedTable = normalizeTableName(fieldTable);
    if (!relatedTable || normalizeTableKey(relatedTable) === normalizeTableKey(table)) return 'src';
    const relatedKey = normalizeTableKey(relatedTable);
    if (rawFieldTableAliases.has(relatedKey)) return rawFieldTableAliases.get(relatedKey);
    const path = findRelationshipPath(body.model, table, relatedTable, 4);
    if (!path || !Array.isArray(path.relationships) || !path.relationships.length) {
      throw apiError('O campo usa a tabela "' + relatedTable + '", mas n\u00e3o existe relacionamento ativo com "' + table + '". Crie o relacionamento no modelo.', 400);
    }
    const nodes = path.nodes || [];
    let currentTable = table;
    let currentAlias = 'src';
    for (let index = 0; index < path.relationships.length; index += 1) {
      const nextTable = normalizeTableName(nodes[index + 1]);
      const nextKey = normalizeTableKey(nextTable);
      const existingAlias = rawFieldTableAliases.get(nextKey);
      if (existingAlias) {
        currentTable = nextTable;
        currentAlias = existingAlias;
        continue;
      }
      const columns = relationshipColumnForTarget(path.relationships[index], currentTable, nextTable);
      if (!columns) {
        throw apiError('O caminho de relacionamento entre "' + table + '" e "' + relatedTable + '" est\u00e1 inv\u00e1lido. Revise as colunas no modelo.', 400);
      }
      const alias = 'r' + rawFieldAliasIndex++;
      const joinSourceSql = await visualJoinSourceSql(nextTable, alias, body, columns.targetColumn);
      fromSql += ' LEFT JOIN ' + joinSourceSql +
        ' ON ' + await visualRelationshipJoinCondition(alias, nextTable, columns.targetColumn, currentAlias, currentTable, columns.sourceColumn, body);
      rawFieldTableAliases.set(nextKey, alias);
      currentTable = nextTable;
      currentAlias = alias;
    }
    return currentAlias;
  }
  function scopedVisualFiltersForTarget(targetTable) {
    const scopedWhere = [];
    const scopedParams = [];
    const semanticModel = body.model && Array.isArray(body.model.relationships) ? body.model : defaultSemanticModel();
    const filters = [
      ...(Array.isArray(body.visualFilters) ? body.visualFilters : []),
      ...(Array.isArray(body.pageFilters) ? body.pageFilters : []),
      ...(Array.isArray(body.allPagesFilters) ? body.allPagesFilters : [])
    ];
    filters.forEach(function(rawFilter) {
      const field = String(rawFilter && (rawFilter.field || rawFilter.column) || '').trim();
      const values = Array.isArray(rawFilter && rawFilter.values)
        ? rawFilter.values.filter(function(value) { return value !== '' && value !== null && value !== undefined; })
        : [];
      if (!field || !values.length) return;
      const filterTable = normalizeTableName(rawFilter && rawFilter.table);
      let condition = { type: 'column', columnSql: 'src.' + quoteIdent(field) };
      if (filterTable && normalizeTableKey(filterTable) !== normalizeTableKey(targetTable)) {
        condition = resolveFilterCondition({ table: filterTable, field: field, operator: '=' }, targetTable, semanticModel);
        if (!condition) return;
      }
      const placeholders = values.map(function() { return '?'; }).join(', ');
      scopedWhere.push(wrapResolvedFilterPredicate(condition, condition.columnSql + ' IN (' + placeholders + ')'));
      scopedParams.push.apply(scopedParams, values);
    });
    return { whereSql: scopedWhere.join(' AND '), params: scopedParams };
  }
  async function independentAggregateFieldSql(field, fieldTable, aggregation) {
    const relatedTable = normalizeTableName(fieldTable);
    if (!relatedTable || normalizeTableKey(relatedTable) === normalizeTableKey(table)) {
      return String(aggregation || 'SUM').toUpperCase() + '(' + castColumnSqlExpr(field, castMap) + ')';
    }
    const path = findRelationshipPath(body.model, table, relatedTable, 4);
    if (!path || !Array.isArray(path.relationships) || !path.relationships.length) {
      throw apiError('O campo usa a tabela "' + relatedTable + '", mas n\u00e3o existe relacionamento ativo com "' + table + '". Crie o relacionamento no modelo.', 400);
    }
    const allowedAggregations = new Set(['SUM', 'AVG', 'MIN', 'MAX', 'COUNT', 'DISTINCTCOUNT']);
    const requestedAggregation = String(aggregation || 'SUM').toUpperCase();
    const aggregate = allowedAggregations.has(requestedAggregation) ? requestedAggregation : 'SUM';
    const aggregateSql = aggregate === 'DISTINCTCOUNT'
      ? 'COUNT(DISTINCT src.' + quoteIdent(field) + ')'
      : aggregate + '(src.' + quoteIdent(field) + ')';
    const sourceSql = await visualJoinSourceSql(relatedTable, 'src', body, field);
    const reportWhere = buildReportFilterWhere(body.onlineFilters || [], body.filters || {}, {
      targetTable: relatedTable,
      semanticModel: body.model || defaultSemanticModel(),
      pageId: body.pageId || '',
      visualId: body.visualId || '',
      activePageId: body.activePageId || ''
    });
    const scopedWhere = scopedVisualFiltersForTarget(relatedTable);
    const clauses = [reportWhere.whereSql, scopedWhere.whereSql].filter(Boolean);
    if (reportWhere.whereSql) runtimeFiltersEmbedded = true;
    independentAggregateParams.push.apply(independentAggregateParams, reportWhere.params || []);
    independentAggregateParams.push.apply(independentAggregateParams, scopedWhere.params || []);
    return '(SELECT ' + aggregateSql + ' FROM ' + sourceSql + (clauses.length ? ' WHERE ' + clauses.join(' AND ') : '') + ')';
  }
  function requestedFieldObjectByName(name) {
    return requestedFieldObjects.find(function(item) { return item.name === name; }) || { name: name, table: '' };
  }

  const filterColumn = String(body.filterColumn || '').trim();
  const filterValue = String(body.filterValue ?? '');
  const whereParts = [];
  const visualSemanticModel = body.model && Array.isArray(body.model.relationships) ? body.model : defaultSemanticModel();
  const visualMeasureLookup = buildMeasureLookup(body.model || {});
  const selectedVisualMeasureKeys = new Set();
  [value, secondaryValue, dimension, ...requestedFields].forEach(function(name) {
    const key = normalizeMeasureNameKey(name);
    if (key && visualMeasureLookup.has(key)) selectedVisualMeasureKeys.add(key);
  });
  function appendBuilderFilterWhere(rawFilter, values) {
    const filterField = String((rawFilter && (rawFilter.field || rawFilter.column)) || '').trim();
    if (!filterField) return;
    const vals = Array.isArray(values) ? values.filter(function(v) { return v !== '' && v !== null && v !== undefined; }) : [];
    if (!vals.length) return;
    const filterTable = String((rawFilter && rawFilter.table) || '').trim();
    if (selectedVisualMeasureKeys.size === 1 && !(rawFilter && rawFilter.mandatory) && daxFilterContextRemoves(primaryMeasureFilterContext, filterTable || table, filterField)) return;
    let condition = { type: 'column', columnSql: castColumnSqlExpr(filterField, castMap) };
    if (filterTable && !sameTableName(filterTable, table)) {
      condition = resolveFilterCondition({ table: filterTable, field: filterField, operator: '=' }, table, visualSemanticModel);
      if (!condition) {
        throw apiError('O filtro usa a tabela "' + filterTable + '", mas nao existe relacionamento ativo com "' + table + '". Verifique o Modelo.', 400);
      }
    }
    const pholders = vals.map(function() { return '?'; }).join(', ');
    whereParts.push(wrapResolvedFilterPredicate(condition, condition.columnSql + ' IN (' + pholders + ')'));
    params.push.apply(params, vals);
  }
  // Novo formato: array de visualFilters
  var visualFilters = Array.isArray(body.visualFilters) ? body.visualFilters : [];
  if (visualFilters.length) {
    for (var fi = 0; fi < visualFilters.length; fi++) {
      var f = visualFilters[fi];
      if (!f || !f.column) continue;
      appendBuilderFilterWhere(f, f.values);
    }
  } else if (filterColumn && filterValue !== '') {
    // Formato antigo: filtro unico (compatibilidade)
    const op = String(body.filterOperator || '=').toUpperCase() === 'LIKE' ? 'LIKE' : (['=', '>=', '<='].includes(String(body.filterOperator || '=')) ? String(body.filterOperator || '=') : '=');
    whereParts.push(`${castColumnSqlExpr(filterColumn, castMap)} ${op} ?`);
    params.push(op === 'LIKE' ? `%${filterValue}%` : filterValue);
  }

  // Filtros da pagina
  var pageFilters = Array.isArray(body.pageFilters) ? body.pageFilters : [];
  for (var pfi = 0; pfi < pageFilters.length; pfi++) {
    var pf = pageFilters[pfi];
    if (!pf || !pf.column) continue;
    appendBuilderFilterWhere(pf, pf.values);
  }

  // Filtros de todas as paginas
  var allPagesFilters = Array.isArray(body.allPagesFilters) ? body.allPagesFilters : [];
  for (var afi = 0; afi < allPagesFilters.length; afi++) {
    var af = allPagesFilters[afi];
    if (!af || !af.column) continue;
    appendBuilderFilterWhere(af, af.values);
  }

  if (canRawPreview) {
    const selectParts = [];
    for (const field of requestedFields) {
      const fieldObj = requestedFieldObjectByName(field);
      const fieldTable = fieldObj.table || await inferVisualFieldTable(table, body.model, field);
      const alias = await ensureRawFieldTableJoin(fieldTable);
      const fieldCastMap = alias === 'src' ? castMap : new Map();
      selectParts.push(`${castColumnSqlExprForAlias(field, fieldCastMap, alias)} AS ${quoteIdent(field)}`);
    }
    let sql = `SELECT ${selectParts.join(', ')} FROM ${fromSql}`;
    if (whereParts.length) sql += ` WHERE ${whereParts.join(' AND ')}`;
    sql += ` LIMIT ${limit}`;
    return visualQueryPayload(sql, params, table);
  }

  // Detect when dimension is a measure (not a category) for donut/pie — treat as secondaryValue
  const dimIsMeasure = dimension && ['donut', 'pie'].includes(visualization) && body.model && Array.isArray(body.model.measures) && body.model.measures.some(function(m) { return m.name === dimension && String(m.formula || '').trim(); });
  const effectiveDim = dimIsMeasure ? '' : dimension;
  const effectiveSecondaryValue = secondaryValue || (dimIsMeasure ? dimension : '');

  // Compile secondaryValue as a measure for donut/pie with two measures (no dimension)
  let secondaryCompiledMeasureSql = null;
  if (!effectiveDim && effectiveSecondaryValue && effectiveSecondaryValue !== value && ['donut', 'pie'].includes(visualization) && body.model && Array.isArray(body.model.measures) && body.model.measures.length) {
    const secMeasureLookup = buildMeasureLookup(body.model);
    const secMeasureKey = normalizeMeasureNameKey(effectiveSecondaryValue);
    const secMeasure = secMeasureLookup.get(secMeasureKey);
    if (secMeasure && String(secMeasure.formula || '').trim()) {
      const secDiag = analyzeDaxMeasure(secMeasure, body.model);
      if (secDiag.status === 'ok' || secDiag.status === 'ok_com_dependencia') {
        const measureFilterContext = ensureDaxFilterContext({});
        try {
          secondaryCompiledMeasureSql = preAggregatedSelectedMeasureSql(secMeasure);
          if (!secondaryCompiledMeasureSql) {
            secondaryCompiledMeasureSql = compileVisualDax(secMeasure.formula, compiledMeasureAliases, {
              model: body.model,
              measureLookup: buildMeasureLookup(body.model),
              currentMeasure: secMeasure.name,
              stack: [normalizeMeasureNameKey(secMeasure.name || secMeasure.displayName)],
              filterContext: measureFilterContext,
              scalarSubqueryTables: disconnectedDaxAggregateTables(table, tablesUsedByMeasureWithDependencies(secMeasure, body.model), body.model, secMeasure.formula, compiledMeasureJoinPlan),
              preAggregateMeasureTables: new Set(compiledMeasureJoinPlan.nodes
                .filter(function(node) { return node.key !== compiledMeasureJoinPlan.baseKey && !node.unreachable; })
                .map(function(node) { return node.key; })),
              preAggregatedMeasureRegistry: compiledMeasurePreAggregates
            });
          }
          await materializeAdditionalMeasureSql(secondaryCompiledMeasureSql);
          registerVisualMeasureFilterContext(measureFilterContext);
        } catch (err) { /* ignore */ }
      }
    }
  }

  const earlyValueSql = value ? castColumnSqlExpr(value, castMap) : (requestedFields.length ? castColumnSqlExpr(requestedFields[0], castMap) : '*');

  // Two-measure donut/pie: no dimension, value + secondaryValue
  if (!effectiveDim && effectiveSecondaryValue && effectiveSecondaryValue !== value && ['donut', 'pie'].includes(visualization)) {
    const secValueSql2 = castColumnSqlExpr(effectiveSecondaryValue, castMap);
    let valAggSql, secAggSql2;
    if (compiledMeasureSql) {
      valAggSql = compiledMeasureSql;
    } else {
      valAggSql = `SUM(${earlyValueSql})`;
    }
    if (secondaryCompiledMeasureSql) {
      secAggSql2 = secondaryCompiledMeasureSql;
    } else {
      secAggSql2 = `SUM(${secValueSql2})`;
    }
    const valMeasureName = sanitizeAlias(value || 'medida_1', 'medida1');
    const secMeasureName2 = sanitizeAlias(effectiveSecondaryValue, 'medida2');
    const dualSelectParts = [
      `${valAggSql} AS ${quoteIdent(valMeasureName)}`,
      `${secAggSql2} AS ${quoteIdent(secMeasureName2)}`
    ];
    let dualSql = `SELECT ${dualSelectParts.join(', ')} FROM ${fromSql}`;
    if (whereParts.length) dualSql += ` WHERE ${whereParts.join(' AND ')}`;
    dualSql += ` LIMIT ${limit}`;
    return visualQueryPayload(dualSql, params, table);
  }

  // Measure aggregation: when value is a compiled DAX measure, all non-measure fields
  // are dimension columns and the measure SQL is the aggregated value (like Power BI).
  if (compiledMeasureSql) {
    const measureKey = normalizeMeasureNameKey(compiledMeasureName || value || firstMeasureInFields || '');
    const dimFields = requestedFields.filter((f) => normalizeMeasureNameKey(f) !== measureKey);
    if (!dimFields.length && dimension && normalizeMeasureNameKey(dimension) !== measureKey) dimFields.push(dimension);
    const dimSelectParts = [];
    const dimGroupParts = [];
    const dimEntries = [];
    for (const f of dimFields) {
      let dimExpr;
      let dimMeasure = null;
      let dimValuesIterator = null;
      const isMeasureField = body.model && Array.isArray(body.model.measures) && body.model.measures.some(function(m) {
        return [m && m.name, m && m.displayName].some(function(name) {
          return normalizeMeasureNameKey(name) === normalizeMeasureNameKey(f);
        }) && String(m && m.formula || '').trim();
      });
      const fieldObj = requestedFieldObjectByName(f);
      const isFunnelAggregateField = visualization === 'funnel'
        && f === dimension
        && !isMeasureField
        && /(int|decimal|double|float|real|numeric|number|inteiro)/i.test(String(fieldObj.type || ''));
      if (isFunnelAggregateField) {
        const fieldTable = fieldObj.table || await inferVisualFieldTable(table, body.model, f);
        dimExpr = await independentAggregateFieldSql(f, fieldTable, fieldObj.aggregation || 'SUM');
        dimSelectParts.push(`${dimExpr} AS ${quoteIdent(f)}`);
        dimEntries.push({ name: f, expr: dimExpr, isMeasure: true });
        continue;
      }
      if (isMeasureField) {
        const measureLookup2 = buildMeasureLookup(body.model);
        const mKey = normalizeMeasureNameKey(f);
        const mObj = measureLookup2.get(mKey);
        if (mObj && String(mObj.formula || '').trim()) {
          dimMeasure = mObj;
          dimValuesIterator = parseDaxValuesIterator(mObj.formula);
          const mDiag = analyzeDaxMeasure(mObj, body.model);
          if (mDiag.status === 'ok' || mDiag.status === 'ok_com_dependencia') {
            const measureFilterContext = ensureDaxFilterContext({});
            try {
              dimExpr = preAggregatedSelectedMeasureSql(mObj);
              if (!dimExpr) {
                dimExpr = compileVisualDax(dimValuesIterator ? dimValuesIterator.expression : mObj.formula, compiledMeasureAliases, {
                  model: body.model,
                  measureLookup: buildMeasureLookup(body.model),
                  currentMeasure: mObj.name,
                  stack: [normalizeMeasureNameKey(mObj.name || mObj.displayName)],
                  filterContext: measureFilterContext,
                  daxVariables: dimValuesIterator ? dimValuesIterator.variableScope : undefined,
                  scalarSubqueryTables: disconnectedDaxAggregateTables(table, tablesUsedByMeasureWithDependencies(mObj, body.model), body.model, mObj.formula, compiledMeasureJoinPlan),
                  // Medidas secundarias precisam compartilhar o mesmo registro de
                  // subplanos agregados da medida ancora. Sem isso, uma referencia
                  // como [Desconto Financeiro] era recompilada como SUM(t2.valor)
                  // sobre as linhas da fato e multiplicava o total pelo numero de
                  // ocorrencias, embora a avaliacao isolada (Card) estivesse correta.
                  preAggregateMeasureTables: new Set(compiledMeasureJoinPlan.nodes
                    .filter(function(node) { return node.key !== compiledMeasureJoinPlan.baseKey && !node.unreachable; })
                    .map(function(node) { return node.key; })),
                  preAggregatedMeasureRegistry: compiledMeasurePreAggregates
                });
              }
              await materializeAdditionalMeasureSql(dimExpr);
              registerVisualMeasureFilterContext(measureFilterContext);
            } catch (err) {
              throw apiError('A medida "' + f + '" nao pode ser compilada: ' + (err.message || 'Erro de compilacao DAX.'), 400);
            }
          } else {
            throw apiError('A medida "' + f + '" nao pode ser compilada: ' + (mDiag.message || ('Status: ' + mDiag.status)), 400);
          }
        } else {
          throw apiError('A medida "' + f + '" nao foi encontrada ou esta sem formula.', 400);
        }
      } else {
        const fieldTable = fieldObj.table || await inferVisualFieldTable(table, body.model, f);
        const alias = await ensureRawFieldTableJoin(fieldTable);
        const fieldCastMap = alias === 'src' ? castMap : new Map();
        dimExpr = castColumnSqlExprForAlias(f, fieldCastMap, alias);
      }
      dimSelectParts.push(`${dimExpr} AS ${quoteIdent(f)}`);
      dimEntries.push({ name: f, expr: dimExpr, isMeasure: isMeasureField, measure: dimMeasure, valuesIterator: dimValuesIterator });
      if (!isMeasureField) dimGroupParts.push(dimExpr);
    }
    const measureName = sanitizeAlias(body.measureName || compiledMeasureName || value || firstMeasureInFields || body.name || 'medida', 'medida');
    if (compiledMeasureValuesIterator) {
      const iteratorAlias = daxAliasFor(compiledMeasureAliases, compiledMeasureValuesIterator.table);
      if (!iteratorAlias) {
        throw apiError('A tabela do VALUES precisa estar no modelo ou em relacionamento: ' + compiledMeasureValuesIterator.table, 400);
      }
      const rawDimensions = dimEntries.filter(function(entry) { return !entry.isMeasure; });
      const otherMeasures = dimEntries.filter(function(entry) { return entry.isMeasure; });
      const iteratorAggregateSql = function(entry, outputName, rowAlias) {
        const valuesIterator = entry.valuesIterator;
        const valuesAlias = valuesIterator && daxAliasFor(compiledMeasureAliases, valuesIterator.table);
        if (!valuesAlias) {
          throw apiError('A tabela do VALUES precisa estar no modelo ou em relacionamento: ' + String(valuesIterator && valuesIterator.table || ''), 400);
        }
        const valuesExpr = valuesAlias + '.' + quoteIdent(valuesIterator.column);
        const targetValueAlias = '__biwa_values_iterator_value';
        const innerSelect = rawDimensions.map(function(dimensionEntry) {
          return dimensionEntry.expr + ' AS ' + quoteIdent(dimensionEntry.name);
        });
        innerSelect.push(valuesExpr + ' AS ' + quoteIdent('__biwa_values_iterator_key'));
        innerSelect.push(entry.expr + ' AS ' + quoteIdent(targetValueAlias));
        let innerSql = 'SELECT ' + innerSelect.join(', ') + ' FROM ' + fromSql;
        innerSql += whereParts.length
          ? ' WHERE ' + whereParts.join(' AND ') + ' /*__BIWA_RUNTIME_FILTER_AND__*/'
          : ' /*__BIWA_RUNTIME_FILTER_WHERE__*/';
        innerSql += ' GROUP BY ' + [...rawDimensions.map(function(dimensionEntry) { return dimensionEntry.expr; }), valuesExpr].join(', ');
        const aggregateSelect = rawDimensions.map(function(dimensionEntry) { return quoteIdent(dimensionEntry.name); });
        aggregateSelect.push('SUM(COALESCE(' + quoteIdent(targetValueAlias) + ', 0)) AS ' + quoteIdent(outputName));
        let aggregateSql = 'SELECT ' + aggregateSelect.join(', ') + ' FROM (' + innerSql + ') ' + rowAlias;
        if (rawDimensions.length) aggregateSql += ' GROUP BY ' + rawDimensions.map(function(dimensionEntry) { return quoteIdent(dimensionEntry.name); }).join(', ');
        return aggregateSql;
      };
      const joinDimensions = function(leftAlias, rightAlias) {
        return rawDimensions.length
          ? rawDimensions.map(function(entry) {
              const left = leftAlias + '.' + quoteIdent(entry.name);
              const right = rightAlias + '.' + quoteIdent(entry.name);
              return '(' + left + ' = ' + right + ' OR (' + left + ' IS NULL AND ' + right + ' IS NULL))';
            }).join(' AND ')
          : '1 = 1';
      };
      const targetAggregateSql = iteratorAggregateSql({ expr: compiledMeasureSql, valuesIterator: compiledMeasureValuesIterator }, measureName, '__biwa_values_rows');
      const iteratorMeasures = otherMeasures.filter(function(entry) { return Boolean(entry.valuesIterator); });
      const scalarMeasures = otherMeasures.filter(function(entry) { return !entry.valuesIterator; });
      const selectParts = [
        ...rawDimensions.map(function(entry) { return '__biwa_target.' + quoteIdent(entry.name) + ' AS ' + quoteIdent(entry.name); }),
        '__biwa_target.' + quoteIdent(measureName) + ' AS ' + quoteIdent(measureName)
      ];
      let compositeFromSql = '(' + targetAggregateSql + ') __biwa_target';
      const sourceParams = params.slice();
      const runtimeSegments = [sourceParams];
      if (scalarMeasures.length) {
        const otherSelect = [
          ...rawDimensions.map(function(entry) { return entry.expr + ' AS ' + quoteIdent(entry.name); }),
          ...scalarMeasures.map(function(entry) { return entry.expr + ' AS ' + quoteIdent(entry.name); })
        ];
        let otherSql = 'SELECT ' + otherSelect.join(', ') + ' FROM ' + fromSql;
        otherSql += whereParts.length
          ? ' WHERE ' + whereParts.join(' AND ') + ' /*__BIWA_RUNTIME_FILTER_AND__*/'
          : ' /*__BIWA_RUNTIME_FILTER_WHERE__*/';
        if (rawDimensions.length) otherSql += ' GROUP BY ' + rawDimensions.map(function(entry) { return entry.expr; }).join(', ');
        compositeFromSql += ' LEFT JOIN (' + otherSql + ') __biwa_other ON ' + joinDimensions('__biwa_target', '__biwa_other');
        scalarMeasures.forEach(function(entry) {
          selectParts.push('__biwa_other.' + quoteIdent(entry.name) + ' AS ' + quoteIdent(entry.name));
        });
        runtimeSegments.push(independentAggregateParams.concat(sourceParams));
      }
      iteratorMeasures.forEach(function(entry, index) {
        const resultAlias = '__biwa_iterator_' + index;
        const rowsAlias = '__biwa_values_rows_' + index;
        const aggregateSql = iteratorAggregateSql(entry, entry.name, rowsAlias);
        compositeFromSql += ' LEFT JOIN (' + aggregateSql + ') ' + resultAlias + ' ON ' + joinDimensions('__biwa_target', resultAlias);
        selectParts.push(resultAlias + '.' + quoteIdent(entry.name) + ' AS ' + quoteIdent(entry.name));
        runtimeSegments.push(independentAggregateParams.concat(sourceParams));
      });
      let sql = 'SELECT ' + selectParts.join(', ') + ' FROM ' + compositeFromSql;
      if (runtimeSegments.length > 1) {
        runtimeFilterTargetCount = runtimeSegments.length;
        runtimeFilterParamSegments = runtimeSegments;
        params = runtimeSegments.flat();
      }
      const requestedOrderMeasure = requestedFields.find(function(field) {
        return normalizeMeasureNameKey(field) === normalizeMeasureNameKey(value) && visualMeasureLookup.has(normalizeMeasureNameKey(field));
      });
      const orderFieldName = requestedOrderMeasure || measureName;
      const stableOrderDimensions = rawDimensions
        .map(function(entry) { return entry.name; })
        .filter(function(name) { return normalizeColumnNameForMatch(name) !== normalizeColumnNameForMatch(orderFieldName); })
        .sort(function(left, right) { return normalizeColumnNameForMatch(left).localeCompare(normalizeColumnNameForMatch(right), 'pt-BR'); });
      if (!suppressOrderLimit) {
        sql += ' ORDER BY ' + quoteIdent(orderFieldName) + ' ' + order +
          stableOrderDimensions.map(function(name) { return ', ' + quoteIdent(name) + ' ASC'; }).join('') +
          ' LIMIT ' + limit;
      }
      if (!otherMeasures.length && independentAggregateParams.length) params = independentAggregateParams.concat(params);
      visualFieldDebug('QUERY GENERATED', {
        visualId: String(body.visualId || ''),
        executionAnchor: measureName,
        orderBy: orderFieldName,
        columns: rawDimensions.map(function(entry) { return entry.name; }).concat(otherMeasures.map(function(entry) { return entry.name; }), [measureName]),
        sql
      });
      if (runtimeSegments.length === 1 && independentAggregateParams.length) params = independentAggregateParams.concat(params);
      return visualQueryPayload(sql, params, table);
    }
    const selectParts = [...dimSelectParts, `${compiledMeasureSql} AS ${quoteIdent(measureName)}`];
    let sql = `SELECT ${selectParts.join(', ')} FROM ${fromSql}`;
    if (whereParts.length) sql += ` WHERE ${whereParts.join(' AND ')}`;
    if (dimGroupParts.length) sql += ` GROUP BY ${dimGroupParts.join(', ')}`;
    if (!suppressOrderLimit) sql += ` ORDER BY ${quoteIdent(measureName)} ${order} LIMIT ${limit}`;
    if (independentAggregateParams.length) params = independentAggregateParams.concat(params);
    visualFieldDebug('QUERY GENERATED', {
      visualId: String(body.visualId || ''),
      executionAnchor: measureName,
      columns: dimEntries.map(function(entry) { return entry.name; }).concat([measureName]),
      sql
    });
    return visualQueryPayload(sql, params, table);
  }

  const dimSql = dimension ? castColumnSqlExpr(dimension, castMap) : '';
  const valueSql = value ? castColumnSqlExpr(value, castMap) : (requestedFields.length ? castColumnSqlExpr(requestedFields[0], castMap) : '*');
  const measureName = sanitizeAlias(body.measureName || body.name || (agg + '_' + (value || 'linhas')), 'medida');
  let aggSql = 'COUNT(*)';
  if (compiledMeasureSql) {
    aggSql = compiledMeasureSql;
  } else if (agg === 'SUM') aggSql = `SUM(${valueSql})`;
  else if (agg === 'AVG' || agg === 'AVERAGE') aggSql = `AVG(${valueSql})`;
  else if (agg === 'MIN') aggSql = `MIN(${valueSql})`;
  else if (agg === 'MAX') aggSql = `MAX(${valueSql})`;
  else if (agg === 'COUNT') aggSql = value ? `COUNT(${valueSql})` : 'COUNT(*)';
  else if (agg === 'DISTINCTCOUNT') aggSql = `COUNT(DISTINCT ${valueSql})`;
  else throw apiError('Agregação inválida: ' + agg, 400);
  if (dimension && secondaryValue && secondaryValue !== value && ['donut', 'pie'].includes(visualization)) {
    const secValueSql = castColumnSqlExpr(secondaryValue, castMap);
    let secAggSql = `SUM(${secValueSql})`;
    if (agg === 'AVG' || agg === 'AVERAGE') secAggSql = `AVG(${secValueSql})`;
    else if (agg === 'MIN') secAggSql = `MIN(${secValueSql})`;
    else if (agg === 'MAX') secAggSql = `MAX(${secValueSql})`;
    else if (agg === 'COUNT') secAggSql = `COUNT(${secValueSql})`;
    else if (agg === 'DISTINCTCOUNT') secAggSql = `COUNT(DISTINCT ${secValueSql})`;
    const secMeasureName = sanitizeAlias(secondaryValue || 'Valor 2', 'medida2');
    const secSelectParts = [`${dimSql} AS ${quoteIdent(dimension)}`, `${aggSql} AS ${quoteIdent(measureName)}`, `${secAggSql} AS ${quoteIdent(secMeasureName)}`];
    let secSql = `SELECT ${secSelectParts.join(', ')} FROM ${fromSql}`;
    if (whereParts.length) secSql += ` WHERE ${whereParts.join(' AND ')}`;
    secSql += ` GROUP BY ${dimSql}`;
    secSql += ` ORDER BY ${quoteIdent(measureName)} ${order} LIMIT ${limit}`;
    return visualQueryPayload(secSql, params, table);
  }
  const selectParts = dimension ? [`${dimSql} AS ${quoteIdent(dimension)}`, `${aggSql} AS ${quoteIdent(measureName)}`] : [`${aggSql} AS ${quoteIdent(measureName)}`];
  let sql = `SELECT ${selectParts.join(', ')} FROM ${fromSql}`;
  if (whereParts.length) sql += ` WHERE ${whereParts.join(' AND ')}`;
  if (dimension) sql += ` GROUP BY ${dimSql}`;
  sql += ` ORDER BY ${quoteIdent(measureName)} ${order} LIMIT ${limit}`;
  return visualQueryPayload(sql, params, table);
}


function visualRawFieldNames(visual) {
  const fields = [];
  const selected = normalizeVisualQueryFieldObjects(visual && visual.selectedFields);
  const selectedByRef = new Map();
  selected.forEach((field) => {
    selectedByRef.set(String(field.instanceId || ''), field);
    const nameKey = normalizeColumnNameForMatch(field.name);
    if (nameKey && !selectedByRef.has(nameKey)) selectedByRef.set(nameKey, field);
  });
  const add = (value) => {
    const raw = String(typeof value === 'string' ? value : (value && (value.instanceId || value.name)) || '').trim();
    const selectedField = selectedByRef.get(raw) || selectedByRef.get(normalizeColumnNameForMatch(raw));
    const name = String(selectedField && selectedField.name || (typeof value === 'string' ? value : (value && value.name) || '')).trim();
    if (name && !fields.includes(name)) fields.push(name);
  };
  if (visual) {
    add(visual.dimension);
    if (['table', 'matrix'].includes(String(visual.visualization || '').toLowerCase())) add(visual.value);
    if (String(visual.visualization || '').toLowerCase() === 'donut') add(visual.secondaryValue);
    (Array.isArray(visual.matrixRows) ? visual.matrixRows : []).forEach(add);
    (Array.isArray(visual.matrixColumns) ? visual.matrixColumns : []).forEach(add);
    (Array.isArray(visual.matrixValues) ? visual.matrixValues : []).forEach(add);
    (Array.isArray(visual.selectedFields) ? visual.selectedFields : []).forEach(add);
    (Array.isArray(visual.fields) ? visual.fields : []).forEach(add);
  }
  return fields.slice(0, 60);
}

function visualRawFieldObjects(visual) {
  const fields = [];
  const seen = new Set();
  const selected = normalizeVisualQueryFieldObjects(visual && visual.selectedFields);
  const selectedByName = new Map(selected.map((field) => [normalizeColumnNameForMatch(field.name), field]));
  const selectedByInstance = new Map(selected.map((field) => [String(field.instanceId || ''), field]));
  const add = (value) => {
    const source = typeof value === 'string'
      ? (selectedByInstance.get(value) || selectedByName.get(normalizeColumnNameForMatch(value)) || { name: value, table: '' })
      : value;
    const field = normalizeVisualQueryFieldObjects([source])[0];
    if (!field || !field.name) return;
    const key = normalizeColumnNameForMatch(field.name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    fields.push(field);
  };
  if (visual) {
    add(visual.dimension);
    if (['table', 'matrix'].includes(String(visual.visualization || '').toLowerCase())) add(visual.value);
    if (String(visual.visualization || '').toLowerCase() === 'donut') add(visual.secondaryValue);
    (Array.isArray(visual.matrixRows) ? visual.matrixRows : []).forEach(add);
    (Array.isArray(visual.matrixColumns) ? visual.matrixColumns : []).forEach(add);
    (Array.isArray(visual.matrixValues) ? visual.matrixValues : []).forEach(add);
    selected.forEach(add);
    (Array.isArray(visual.fields) ? visual.fields : []).forEach(add);
  }
  return fields.slice(0, 60);
}

function shouldRunVisualAsRawTable(visual) {
  const type = String(visual && visual.visualization || 'table').toLowerCase();
  return ['table', 'matrix'].includes(type) && String(visual && visual.table || '').trim() && visualRawFieldNames(visual).length;
}

function shouldRebuildSemanticVisualSql(visual, semanticModel) {
  const type = String(visual && visual.visualization || '').toLowerCase();
  if (['textbox', 'image'].includes(type) || !String(visual && visual.table || '').trim()) return false;

  // O SQL salvo no visual e apenas uma fotografia do preview no momento da edicao.
  // Reutiliza-lo no dashboard conserva os filtros que estavam ativos ao salvar e,
  // ao trocar o filtro online, pode combinar valores incompatíveis (por exemplo,
  // Empresa 1 no SQL salvo + Empresa 3 no filtro atual). Todo visual configurado
  // por campos deve ser recompilado para que os filtros de execucao sejam a unica
  // fonte de contexto.
  return Boolean(
    String(visual && visual.dimension || '').trim()
    || String(visual && visual.value || '').trim()
    || String(visual && visual.secondaryValue || '').trim()
    || visualRawFieldNames(visual).length
  );
}

async function sqlForVisualRunDetails(visual, fallbackLimit, semanticModel, runtimeOptions = {}) {
  const viz = String(visual && visual.visualization || '').toLowerCase();
  if (viz === 'textbox' || viz === 'image') return { sql: 'SELECT 1 AS _dummy WHERE 1=0', table: '' };
  if (!shouldRunVisualAsRawTable(visual) && !shouldRebuildSemanticVisualSql(visual, semanticModel)) {
    return { sql: assertReadOnlySql(visual.sql || 'SELECT 1 AS Valor'), table: normalizeTableName(visual && visual.table) };
  }
  const built = await buildVisualQueryFromRequest({
    table: visual.table,
    visualization: visual.visualization || 'table',
    dimension: visual.dimension || '',
    value: visual.value || '',
    secondaryValue: visual.secondaryValue || '',
    fields: visualRawFieldObjects(visual),
    aggregation: visual.aggregation || 'SUM',
    order: visual.order || 'DESC',
    filterColumn: visual.filterColumn || '',
    filterOperator: visual.filterOperator || '=',
    filterValue: visual.filterValue || '',
    visualFilters: Array.isArray(visual.visualFilters) ? visual.visualFilters : [],
    pageFilters: Array.isArray(runtimeOptions.pageFilters) ? runtimeOptions.pageFilters : [],
    allPagesFilters: Array.isArray(runtimeOptions.allPagesFilters) ? runtimeOptions.allPagesFilters : [],
    onlineFilters: Array.isArray(runtimeOptions.onlineFilters) ? runtimeOptions.onlineFilters : [],
    filters: runtimeOptions.filters && typeof runtimeOptions.filters === 'object' ? runtimeOptions.filters : {},
    pageId: visual.pageId || runtimeOptions.pageId || 'page_1',
    activePageId: runtimeOptions.activePageId || runtimeOptions.pageId || '',
    visualId: visual.id || runtimeOptions.visualId || '',
    limit: fallbackLimit || 200,
    model: semanticModel
  });
  return { sql: built.storedSql || built.sql, table: built.table || normalizeTableName(visual.table), daxFilterContext: built.daxFilterContext || { removedTables: [], removedColumns: [] } };
}

function visualMeasureFieldsForTotals(visual, semanticModel) {
  const lookup = buildMeasureLookup(semanticModel || {});
  const fields = normalizeVisualQueryFieldObjects(visual && visual.selectedFields);
  const seen = new Set(fields.map((field) => normalizeMeasureNameKey(field.name)));
  [visual && visual.value, visual && visual.dimension, visual && visual.secondaryValue].forEach((name) => {
    const fieldName = String(name || '').trim();
    const key = normalizeMeasureNameKey(fieldName);
    if (!fieldName || seen.has(key)) return;
    seen.add(key);
    fields.push({ name: fieldName, table: normalizeTableName(visual && visual.table), type: '', displayName: null, aggregation: null, showValueAs: null });
  });
  const outputSeen = new Set();
  return fields.filter((field) => {
    const measure = lookup.get(normalizeMeasureNameKey(field.name));
    const key = normalizeMeasureNameKey(field.name);
    if (!measure || !String(measure.formula || '').trim() || outputSeen.has(key)) return false;
    outputSeen.add(key);
    return true;
  });
}

async function sqlForVisualMeasureTotalsRunDetails(visual, semanticModel, runtimeOptions = {}) {
  const viz = String(visual && visual.visualization || '').toLowerCase();
  if (!['table', 'matrix'].includes(viz) || !String(visual && visual.table || '').trim()) return null;
  const fields = visualMeasureFieldsForTotals(visual, semanticModel);
  if (!fields.length) return null;
  const preferredValue = String(visual && visual.value || '').trim();
  const primary = fields.find((field) => normalizeMeasureNameKey(field.name) === normalizeMeasureNameKey(preferredValue)) || fields[0];
  const built = await buildVisualQueryFromRequest({
    table: visual.table,
    visualization: 'table',
    dimension: '',
    value: primary.name,
    secondaryValue: '',
    fields,
    aggregation: visual.aggregation || 'SUM',
    order: visual.order || 'DESC',
    filterColumn: visual.filterColumn || '',
    filterOperator: visual.filterOperator || '=',
    filterValue: visual.filterValue || '',
    visualFilters: Array.isArray(visual.visualFilters) ? visual.visualFilters : [],
    pageFilters: Array.isArray(runtimeOptions.pageFilters) ? runtimeOptions.pageFilters : [],
    allPagesFilters: Array.isArray(runtimeOptions.allPagesFilters) ? runtimeOptions.allPagesFilters : [],
    onlineFilters: Array.isArray(runtimeOptions.onlineFilters) ? runtimeOptions.onlineFilters : [],
    filters: runtimeOptions.filters && typeof runtimeOptions.filters === 'object' ? runtimeOptions.filters : {},
    pageId: visual.pageId || runtimeOptions.pageId || 'page_1',
    activePageId: runtimeOptions.activePageId || runtimeOptions.pageId || '',
    visualId: visual.id || runtimeOptions.visualId || '',
    limit: 1,
    model: semanticModel
  });
  return { sql: built.storedSql || built.sql, table: built.table || normalizeTableName(visual.table), fields, daxFilterContext: built.daxFilterContext || { removedTables: [], removedColumns: [] } };
}

async function sqlForVisualRun(visual, fallbackLimit, semanticModel) {
  const details = await sqlForVisualRunDetails(visual, fallbackLimit, semanticModel);
  return details.sql;
}

async function normalizeReportSqlForDashboard(report, fallbackLimit, semanticModel) {
  const visuals = Array.isArray(report && report.visuals) ? report.visuals : [];
  const firstRunnable = visuals.find((visual) => shouldRunVisualAsRawTable(visual) || String(visual && visual.sql || '').trim());
  if (firstRunnable) return sqlForVisualRun(firstRunnable, fallbackLimit || report.limit || 200, semanticModel);
  return assertReadOnlySql(report && report.sql || 'SELECT 1 AS Valor');
}

function normalizeOnlineFilters(filters) {
  if (!Array.isArray(filters)) return [];
  const seen = new Map();
  const out = [];
  const optionalFilters = filters.filter((raw) => !(raw && raw.mandatory === true)).slice(0, 40);
  const mandatoryFilters = filters.filter((raw) => raw && raw.mandatory === true).slice(0, 120);
  for (const raw of [...optionalFilters, ...mandatoryFilters]) {
    const field = String(raw && raw.field || '').trim();
    if (!field) continue;
    const table = String(raw && (raw.table || raw.source || raw.resource) || '').trim();
    const operator = String(raw.operator || '=').toUpperCase();
    const ui = ['dropdown', 'between', 'relativeToday', 'search', 'list'].includes(String(raw.ui || 'dropdown')) ? String(raw.ui || 'dropdown') : 'dropdown';
    const scope = ['global', 'report', 'page', 'visual'].includes(String(raw.scope || 'report')) ? String(raw.scope || 'report') : 'report';
    const pageId = scope === 'page' ? String(raw.pageId || '').trim().slice(0, 80) : '';
    const visualId = scope === 'visual' ? String(raw.visualId || '').trim().slice(0, 80) : '';
    const key = table ? table + '.' + field : field;
    const id = String(raw.id || '').trim().slice(0, 120) || crypto.createHash('sha1').update([key, scope, pageId, visualId].join('|')).digest('hex').slice(0, 18);
    const unique = [key, scope, pageId, visualId].join('|');
    const normalizedFilter = {
      id,
      table,
      field,
      key,
      label: String(raw.label || field).slice(0, 80),
      operator: ['=', 'LIKE', '>=', '<=', 'BETWEEN'].includes(operator) ? operator : '=',
      type: ['text', 'number', 'date'].includes(String(raw.type || 'text')) ? String(raw.type || 'text') : 'text',
      ui,
      multiSelect: ui === 'dropdown' && raw.multiSelect === true,
      defaultValue: String(raw.defaultValue !== undefined && raw.defaultValue !== null ? raw.defaultValue : '').slice(0, 500),
      allowAll: raw.allowAll !== false,
      requiredPageIds: Array.from(new Set((Array.isArray(raw.requiredPageIds) ? raw.requiredPageIds : []).map((value) => String(value || '').trim().slice(0, 80)).filter(Boolean))).slice(0, 80),
      scope,
      pageId,
      visualId,
      mandatory: raw.mandatory === true,
      width: Math.max(70, Math.min(980, Number.isFinite(Number(raw.width)) ? Number(raw.width) : 230)),
      height: Math.max(32, Math.min(480, Number.isFinite(Number(raw.height)) ? Number(raw.height) : (ui === 'list' ? 110 : 62))),
      x: Number.isFinite(Number(raw.x)) ? Math.max(0, Number(raw.x)) : 0,
      y: Number.isFinite(Number(raw.y)) ? Math.max(0, Number(raw.y)) : 0,
      cardColor: /^#[0-9a-f]{6}$/i.test(String(raw.cardColor || '')) ? String(raw.cardColor).toLowerCase() : '#ffffff',
      cardTransparent: raw.cardTransparent === true,
      popupBgColor: /^#[0-9a-f]{6}$/i.test(String(raw.popupBgColor || '')) ? String(raw.popupBgColor).toLowerCase() : '#f3f6fb'
    };
    if (seen.has(unique)) {
      const previousIndex = seen.get(unique);
      // Uma regra obrigatoria do servidor sempre prevalece sobre um filtro
      // opcional equivalente enviado ou configurado no relatorio.
      if (normalizedFilter.mandatory && !out[previousIndex].mandatory) out[previousIndex] = normalizedFilter;
      continue;
    }
    seen.set(unique, out.length);
    out.push(normalizedFilter);
  }
  return out;
}

function normalizedCalendarDefaultField(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
}

function calendarDefaultFilterRole(filter) {
  if (normalizedCalendarDefaultField(filter && filter.table) !== 'calendario') return '';
  const field = normalizedCalendarDefaultField(filter && filter.field);
  if (field === 'data' || field === 'datakey') return 'date';
  if (field === 'ano') return 'year';
  if (field === 'mesnumero') return 'monthNumber';
  if (field === 'mesnome') return 'monthName';
  if (field === 'mesnomecurto') return 'monthShortName';
  if (field === 'anomes') return 'yearMonth';
  if (field === 'anomesnome') return 'yearMonthName';
  if (field === 'dia' || field === 'diadomes') return 'day';
  if (field === 'mes') return String(filter && filter.type || '').toLowerCase() === 'number' ? 'monthNumber' : 'monthName';
  return '';
}

function orderFilterOptionValues(table, field, values) {
  const list = Array.isArray(values) ? values.slice() : [];
  const role = calendarDefaultFilterRole({ table, field });
  if (!role || list.length < 2) return list;
  const monthNames = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  const monthShortNames = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const order = role === 'monthName' ? monthNames : role === 'monthShortName' ? monthShortNames : [];
  if (order.length) {
    return list.sort((left, right) => {
      const leftIndex = order.indexOf(normalizedCalendarDefaultField(left));
      const rightIndex = order.indexOf(normalizedCalendarDefaultField(right));
      return (leftIndex < 0 ? 99 : leftIndex) - (rightIndex < 0 ? 99 : rightIndex);
    });
  }
  if (['year', 'monthNumber', 'day'].includes(role)) {
    return list.sort((left, right) => Number(left) - Number(right));
  }
  return list;
}

function currentCalendarDefaultParts(now = new Date()) {
  let year;
  let month;
  let day;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: BIWA_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    year = Number(values.year);
    month = Number(values.month);
    day = Number(values.day);
  } catch (err) {}
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    year = now.getFullYear();
    month = now.getMonth() + 1;
    day = now.getDate();
  }
  return { year, month, day };
}

function defaultOnlineFilterValue(filter, now = new Date()) {
  const role = calendarDefaultFilterRole(filter);
  const monthNames = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  const monthShortNames = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  const current = currentCalendarDefaultParts(now);
  const monthIndex = current.month - 1;
  if (role === 'year') return String(current.year);
  if (role === 'monthNumber') return String(current.month);
  if (role === 'monthName') return monthNames[monthIndex];
  if (role === 'monthShortName') return monthShortNames[monthIndex];
  if (role === 'yearMonth') return String(current.year) + '-' + String(current.month).padStart(2, '0');
  if (role === 'yearMonthName') return monthShortNames[monthIndex] + '/' + String(current.year);
  if (role === 'day') return filter && (filter.operator === 'BETWEEN' || filter.ui === 'between') ? '1|31' : String(current.day);
  return String(filter && filter.defaultValue !== undefined && filter.defaultValue !== null ? filter.defaultValue : '');
}

function withDefaultOnlineFilterValues(onlineFilters, submittedFilters) {
  const raw = submittedFilters && typeof submittedFilters === 'object' ? { ...submittedFilters } : {};
  const fieldAliasCounts = new Map();
  for (const filter of onlineFilters || []) {
    const field = String(filter && filter.field || '').trim();
    if (field) fieldAliasCounts.set(field, (fieldAliasCounts.get(field) || 0) + 1);
  }
  for (const filter of onlineFilters || []) {
    const aliases = [filter.id, filter.key].filter(Boolean);
    if (fieldAliasCounts.get(filter.field) === 1) aliases.push(filter.field);
    const wasSubmitted = aliases.some((key) => Object.prototype.hasOwnProperty.call(raw, key));
    if (wasSubmitted) continue;
    const value = defaultOnlineFilterValue(filter);
    if (value !== '') raw[filter.id || filter.key || filter.field] = value;
  }
  return raw;
}


function visualCrossFilterFields(visual) {
  const fields = new Set();
  const add = (value) => {
    const name = typeof value === 'string' ? value : String(value && value.name || '').trim();
    if (name) fields.add(name);
  };
  add(visual && visual.dimension);
  add(visual && visual.value);
  (Array.isArray(visual && visual.selectedFields) ? visual.selectedFields : []).forEach(add);
  (Array.isArray(visual && visual.fields) ? visual.fields : []).forEach(add);
  return fields;
}

function normalizeRuntimeCrossFilters(crossFilters, visuals) {
  if (!Array.isArray(crossFilters) || !Array.isArray(visuals)) return { filters: [], values: {} };
  const visualMap = new Map((visuals || []).map((visual) => [String(visual.id || ''), visual]).filter(([id]) => id));
  const filters = [];
  const values = {};
  const seen = new Set();
  for (const raw of crossFilters.slice(0, 12)) {
    const sourceVisualId = String(raw && raw.sourceVisualId || '').trim();
    const visual = visualMap.get(sourceVisualId);
    if (!visual) continue;
    const table = String(raw && raw.table || visual.table || '').trim();
    const field = String(raw && raw.field || '').trim();
    const rawValues = Array.isArray(raw && raw.values) ? raw.values : [raw && raw.value];
    const cleanValues = [...new Set(rawValues.map((value) => String(value ?? '').trim()).filter(Boolean))].slice(0, 30);
    if (!table || !field || !cleanValues.length) continue;
    if (table !== String(visual.table || '').trim()) continue;
    const allowedFields = visualCrossFilterFields(visual);
    if (allowedFields.size && !allowedFields.has(field)) continue;
    const safeKey = [table, field, sourceVisualId].join('|');
    if (seen.has(safeKey)) continue;
    seen.add(safeKey);
    const id = 'xf_' + crypto.createHash('sha1').update(safeKey).digest('hex').slice(0, 18);
    filters.push({
      id,
      table,
      field,
      key: table + '.' + field,
      label: String(raw.label || field).slice(0, 80),
      operator: '=',
      type: 'text',
      ui: cleanValues.length > 1 ? 'list' : 'dropdown',
      scope: 'report',
      pageId: '',
      visualId: '',
      width: 220,
      height: 70,
      runtime: true
    });
    values[id] = cleanValues.length > 1 ? cleanValues.join('||') : cleanValues[0];
  }
  return { filters, values };
}

function normalizeVisualStyle(style = {}) {
  const safeHex = (value, fallback) => /^#[0-9a-fA-F]{6}$/.test(String(value || '')) ? String(value) : fallback;
  const safeNumber = (value, fallback, min, max) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  };
  const safeChoice = (value, allowed, fallback) => allowed.includes(String(value || '')) ? String(value) : fallback;
  const columnWidths = {};
  Object.entries(style.columnWidths && typeof style.columnWidths === 'object' ? style.columnWidths : {}).slice(0, 60).forEach(([column, width]) => {
    if (width === null || width === undefined || String(width).trim() === '') return;
    const numericWidth = Number(width);
    if (column && Number.isFinite(numericWidth)) columnWidths[String(column).slice(0, 120)] = Math.max(32, Math.min(1200, Math.round(numericWidth)));
  });
  const columnAlignments = {};
  Object.entries(style.columnAlignments && typeof style.columnAlignments === 'object' ? style.columnAlignments : {}).slice(0, 60).forEach(([column, alignment]) => {
    const name = String(column || '').trim().slice(0, 120);
    if (!name || !alignment || typeof alignment !== 'object') return;
    const header = safeChoice(alignment.header, ['left', 'center', 'right', ''], '');
    const body = safeChoice(alignment.body, ['left', 'center', 'right', ''], '');
    const headerTextColor = safeHex(alignment.headerTextColor, '');
    const hasBold = typeof alignment.bold === 'boolean';
    if (header || body || headerTextColor || hasBold) {
      columnAlignments[name] = { header, body, ...(hasBold ? { bold: alignment.bold } : {}), ...(headerTextColor ? { headerTextColor } : {}) };
    }
  });
  const conditionalFormat = {};
  Object.entries(style.conditionalFormat && typeof style.conditionalFormat === 'object' ? style.conditionalFormat : {}).slice(0, 60).forEach(([column, rawRule]) => {
    const name = String(column || '').trim().slice(0, 120);
    const rule = rawRule && typeof rawRule === 'object' && !Array.isArray(rawRule) ? rawRule : null;
    if (!name || !rule) return;
    conditionalFormat[name] = {
      enabled: rule.enabled === true,
      defaultColorsEnabled: rule.defaultColorsEnabled === true,
      defaultTextColor: safeHex(rule.defaultTextColor, '#0f172a'),
      defaultBackgroundColor: safeHex(rule.defaultBackgroundColor, '#ffffff'),
      valueColorsEnabled: rule.valueColorsEnabled === true,
      negativeTextColor: safeHex(rule.negativeTextColor || rule.fontColor, '#b91c1c'),
      negativeBackgroundColor: safeHex(rule.negativeBackgroundColor || rule.bgColor, '#fef2f2'),
      zeroTextColor: safeHex(rule.zeroTextColor, '#475569'),
      zeroBackgroundColor: safeHex(rule.zeroBackgroundColor, '#f8fafc'),
      positiveTextColor: safeHex(rule.positiveTextColor, '#166534'),
      positiveBackgroundColor: safeHex(rule.positiveBackgroundColor, '#f0fdf4'),
      iconsEnabled: rule.iconsEnabled === true,
      iconPosition: safeChoice(rule.iconPosition, ['before', 'after', 'only'], 'before'),
      negativeIcon: safeChoice(rule.negativeIcon, ['arrow-down', 'triangle-down', 'minus', 'none'], 'arrow-down'),
      zeroIcon: safeChoice(rule.zeroIcon, ['circle', 'dash', 'none'], 'none'),
      positiveIcon: safeChoice(rule.positiveIcon, ['arrow-up', 'triangle-up', 'plus', 'none'], 'arrow-up'),
      negativeIconColor: safeHex(rule.negativeIconColor, '#dc2626'),
      zeroIconColor: safeHex(rule.zeroIconColor, '#64748b'),
      positiveIconColor: safeHex(rule.positiveIconColor, '#16a34a'),
      dataBarsEnabled: rule.dataBarsEnabled === true || rule.dataBar === true,
      positiveBarColor: safeHex(rule.positiveBarColor || rule.dataBarColor, '#22c55e'),
      negativeBarColor: safeHex(rule.negativeBarColor, '#ef4444'),
      dataBarShowValue: rule.dataBarShowValue !== false
    };
  });
  const textboxSource = style.textbox && typeof style.textbox === 'object' && !Array.isArray(style.textbox) ? style.textbox : {};
  const textboxWeight = String(textboxSource.fontWeight || '').toLowerCase();
  const textbox = {
    textColor: safeHex(textboxSource.textColor, safeHex(style.textColor, '#0f172a')),
    fontSize: safeNumber(textboxSource.fontSize, 16, 8, 120),
    fontFamily: String(textboxSource.fontFamily || style.fontFamily || 'Inter, Segoe UI, Arial, sans-serif').trim().slice(0, 120),
    fontWeight: textboxSource.fontWeight === true || textboxWeight === 'bold' || Number(textboxSource.fontWeight) >= 600 ? 700 : 400,
    fontStyle: safeChoice(textboxSource.fontStyle, ['normal', 'italic'], 'normal'),
    textDecoration: safeChoice(textboxSource.textDecoration, ['none', 'underline'], 'none'),
    verticalAlign: safeChoice(textboxSource.verticalAlign, ['top', 'center', 'bottom'], 'top')
  };
  const cardColorRules = (Array.isArray(style.cardColorRules) ? style.cardColorRules : []).slice(0, 30).map((rule, index) => {
    const operator = safeChoice(rule && rule.operator, ['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'blank', 'notblank'], '');
    const color = safeHex(rule && rule.color, '');
    if (!operator || !color) return null;
    return {
      id: String(rule && rule.id || ('rule_' + index)).replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 96),
      field: String(rule && rule.field || '').trim().slice(0, 160),
      operator,
      value: String(rule && rule.value !== undefined ? rule.value : '').slice(0, 160),
      color,
      priority: Math.max(0, Math.min(999, Number(rule && rule.priority) || index))
    };
  }).filter(Boolean).sort((left, right) => left.priority - right.priority);
  return {
    background: safeHex(style.background, '#ffffff'),
    textColor: safeHex(style.textColor, '#0f172a'),
    accentColor: safeHex(style.accentColor, '#2563eb'),
    showBorder: style.showBorder !== false,
    showShadow: style.showShadow !== false,
    showDataLabels: style.showDataLabels !== false,
    showTitle: style.showTitle !== false,
    titleBgColor: safeHex(style.titleBgColor, '#ffffff'),
    titleTextColor: safeHex(style.titleTextColor || style.textColor, '#0f172a'),
    titleFontSize: safeNumber(style.titleFontSize, 14, 10, 36),
    titleAlign: safeChoice(style.titleAlign, ['left', 'center', 'right'], 'left'),
    tableDensity: safeChoice(style.tableDensity, ['compact', 'comfortable', 'spacious'], 'compact'),
    headerBgColor: safeHex(style.headerBgColor, '#eef4fb'),
    footerBgColor: safeHex(style.footerBgColor, style.headerBgColor || '#eef4fb'),
    headerTextColor: safeHex(style.headerTextColor, '#172033'),
    footerTextColor: safeHex(style.footerTextColor, style.headerTextColor || '#172033'),
    headerFontSize: safeNumber(style.headerFontSize, 12, 9, 24),
    bodyFontSize: safeNumber(style.bodyFontSize, 12, 9, 24),
    textAlign: safeChoice(style.textAlign, ['left', 'center', 'right'], 'left'),
    headerTextAlign: safeChoice(style.headerTextAlign, ['left', 'center', 'right'], 'left'),
    headerBold: style.headerBold !== false,
    columnAlignments,
    conditionalFormat,
    zebraRows: style.zebraRows !== false,
    showGrid: style.showGrid !== false,
    fontFamily: String(style.fontFamily || 'Inter, Segoe UI, Arial, sans-serif').slice(0, 120),
    textbox,
    borderRadius: safeNumber(style.borderRadius, 14, 0, 32),
    innerPadding: safeNumber(style.innerPadding, 8, 0, 32),
    numberDecimals: safeNumber(style.numberDecimals, 2, 0, 8),
    numberPrefix: String(style.numberPrefix || '').slice(0, 20),
    numberSuffix: String(style.numberSuffix || '').slice(0, 20),
    cardAutoFit: style.cardAutoFit !== false,
    cardShowCategory: style.cardShowCategory !== false,
    cardAlign: safeChoice(style.cardAlign, ['left', 'center', 'right'], 'center'),
    cardFontFamily: safeChoice(style.cardFontFamily, ['inherit', 'Inter, Segoe UI, Arial, sans-serif', 'Calibri, Segoe UI, Arial, sans-serif', 'Arial, sans-serif', 'Verdana, Arial, sans-serif', 'Tahoma, Arial, sans-serif', 'Trebuchet MS, Arial, sans-serif', 'Georgia, Times New Roman, serif', 'Times New Roman, Georgia, serif', 'Courier New, Consolas, monospace', 'Impact, Arial Black, sans-serif', 'Comic Sans MS, cursive'], 'inherit'),
    cardValueFontSize: safeNumber(style.cardValueFontSize, 52, 8, 120),
    cardCategoryFontSize: safeNumber(style.cardCategoryFontSize, 12, 6, 32),
    cardValueBold: style.cardValueBold !== false,
    cardValueItalic: style.cardValueItalic === true,
    cardValueUnderline: style.cardValueUnderline === true,
    cardCategoryBold: style.cardCategoryBold !== false,
    cardCategoryItalic: style.cardCategoryItalic === true,
    cardCategoryUnderline: style.cardCategoryUnderline === true,
    cardValueColor: safeHex(style.cardValueColor, style.accentColor || '#2563eb'),
    cardDefaultValueColor: safeHex(style.cardDefaultValueColor, style.cardValueColor || style.accentColor || '#2563eb'),
    cardColorRules,
    cardCategoryColor: safeHex(style.cardCategoryColor, '#64748b'),
    cardAccentColor: safeHex(style.cardAccentColor, style.accentColor || '#2563eb'),
    cardInnerBackground: safeHex(style.cardInnerBackground, '#f8fbff'),
    cardShowAccent: style.cardShowAccent !== false,
    borderColor: safeHex(style.borderColor, style.accentColor || '#2563eb'),
    borderWidth: safeNumber(style.borderWidth, 1, 0, 8),
    cardOpacity: safeNumber(style.cardOpacity, 100, 20, 100),
    showLegend: style.showLegend !== false,
    showPercent: style.showPercent === true,
    secondaryColor: safeHex(style.secondaryColor, '#ef4444'),
    columnOrder: Array.isArray(style.columnOrder) ? style.columnOrder.slice(0, 60).map(function(c) { return String(c || '').slice(0, 120); }).filter(Boolean) : [],
    columnWidths,
    sortColumn: String(style.sortColumn || '').slice(0, 120),
    sortDirection: String(style.sortDirection || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC',
    wordWrap: style.wordWrap !== false,
    hideZeroRows: style.hideZeroRows === true,
    chartPieColors: Array.isArray(style.chartPieColors) && style.chartPieColors.length ? style.chartPieColors.slice(0, 8).map(function(c) { return safeHex(c, '#2563eb'); }) : undefined,
    chartPieLabelPos: safeChoice(style.chartPieLabelPos, ['outside', 'inside'], 'outside'),
    chartPieLegendPos: safeChoice(style.chartPieLegendPos, ['bottom', 'top', 'left', 'right'], 'bottom'),
    chartPieOuterRadius: safeNumber(style.chartPieOuterRadius, 70, 40, 95),
    chartPieInnerRadius: safeNumber(style.chartPieInnerRadius, 45, 0, 80),
    chartPiePadAngle: safeNumber(style.chartPiePadAngle, 1, 0, 8),
    chartFunnelReference: String(style.chartFunnelReference || '').slice(0, 120),
    chartFunnelAxisMode: safeChoice(style.chartFunnelAxisMode, ['currency', 'percent'], style.showPercent === true ? 'percent' : 'currency'),
    chartFunnelLabelMode: safeChoice(style.chartFunnelLabelMode, ['value', 'percent', 'name', 'nameValue', 'namePercent'], style.showPercent === true ? 'percent' : 'value')
  };
}

function normalizeReportPages(pages) {
  const cleaned = Array.isArray(pages) ? pages.slice(0, 20).map((page, index) => ({
    id: String(page && page.id ? page.id : 'page_' + (index + 1)).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'page_' + (index + 1),
    name: String(page && page.name ? page.name : 'Pagina ' + (index + 1)).slice(0, 50)
  })).filter((page) => page.id) : [];
  return cleaned.length ? cleaned : [{ id: 'page_1', name: 'Página 1' }];
}

function normalizeReportTheme(value) {
  return ['light', 'dark', 'executive'].includes(String(value || 'light')) ? String(value || 'light') : 'light';
}


function normalizeReportSecurity(security) {
  const source = security && typeof security === 'object' ? security : {};
  const exportsRaw = source.exports && typeof source.exports === 'object' ? source.exports : {};
  const rowFilters = Array.isArray(source.rowFilters) ? source.rowFilters.slice(0, 80).map((item, index) => {
    const table = String(item && item.table || '').trim();
    const field = String(item && item.field || '').trim();
    const operator = String(item && item.operator || '=').toUpperCase();
    const idSeed = [table, field, index, item && item.value].join('|');
    return {
      id: String(item && item.id || ('rls_' + crypto.createHash('sha1').update(idSeed).digest('hex').slice(0, 12))).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80),
      label: String(item && item.label || field || 'Regra RLS').slice(0, 120),
      table,
      field,
      operator: ['=', 'LIKE', '>=', '<=', 'BETWEEN'].includes(operator) ? operator : '=',
      value: String((item && item.value) ?? '').slice(0, 500),
      type: ['text', 'number', 'date'].includes(String(item && item.type || 'text')) ? String(item && item.type || 'text') : 'text',
      users: Array.isArray(item && item.users) ? item.users.map((v) => String(v || '').trim()).filter(Boolean).slice(0, 200) : [],
      roles: Array.isArray(item && item.roles) ? item.roles.map((v) => String(v || '').trim().toLowerCase()).filter(Boolean).slice(0, 10) : ['viewer']
    };
  }).filter((item) => item.table && item.field && item.value !== '') : [];
  return {
    enabled: Boolean(source.enabled) && rowFilters.length > 0,
    mode: ['online', 'always'].includes(String(source.mode || 'online')) ? String(source.mode || 'online') : 'online',
    exports: {
      csv: exportsRaw.csv !== false,
      xls: exportsRaw.xls !== false,
      json: exportsRaw.json !== false
    },
    rowFilters
  };
}

function reportExportPolicy(report) {
  const security = normalizeReportSecurity(report && report.security);
  return security.exports || { csv: true, xls: true, json: true };
}

function userMatchesRlsRule(rule, user) {
  const username = String(user && user.username || '').toLowerCase();
  const role = String(user && user.role || 'viewer').toLowerCase();
  const users = Array.isArray(rule.users) ? rule.users.map((v) => String(v || '').toLowerCase()) : [];
  const roles = Array.isArray(rule.roles) && rule.roles.length ? rule.roles.map((v) => String(v || '').toLowerCase()) : ['viewer'];
  if (users.length && !users.includes(username)) return false;
  return !roles.length || roles.includes(role);
}

function renderSecurityTemplate(value, user) {
  const replacements = {
    user: String(user && user.username || ''),
    username: String(user && user.username || ''),
    name: String(user && user.name || user && user.username || ''),
    role: String(user && user.role || 'viewer')
  };
  return String(value ?? '').replace(/\{\{\s*(user|username|name|role)\s*\}\}/gi, (_, key) => replacements[String(key).toLowerCase()] || '');
}

function runtimeSecurityFiltersForReport(report, user) {
  const security = normalizeReportSecurity(report && report.security);
  if (user && user.role === 'admin') return { filters: {}, onlineFilters: [], applied: 0 };
  const filters = {};
  const onlineFilters = [];

  const appendRule = (rule, idPrefix, mandatory) => {
    const value = renderSecurityTemplate(rule.value, user || { role: 'viewer' });
    if (value === '') return;
    const id = idPrefix + rule.id;
    onlineFilters.push({
      id,
      table: rule.table,
      field: rule.field,
      key: rule.table + '.' + rule.field,
      label: rule.label || rule.field,
      operator: rule.operator,
      type: rule.type || 'text',
      ui: rule.operator === 'BETWEEN' ? 'between' : 'dropdown',
      scope: 'global',
      pageId: '',
      visualId: '',
      width: 220,
      height: 70,
      mandatory: Boolean(mandatory)
    });
    filters[id] = value;
  };

  for (const rule of normalizeOnlineUserDataFilters(user && user.dataFilters)) {
    appendRule(rule, '__user_data_', true);
  }

  const reportSecurityApplies = security.enabled && !(security.mode === 'online' && APP_MODE !== 'online');
  if (reportSecurityApplies) {
    for (const rule of security.rowFilters) {
      if (!userMatchesRlsRule(rule, user || { role: 'viewer' })) continue;
      appendRule(rule, '__rls_', true);
    }
  }
  return { filters, onlineFilters, applied: onlineFilters.length };
}

function canExportReport(report, format, user) {
  if (user && user.role === 'admin') return true;
  const policy = reportExportPolicy(report);
  const key = String(format || '').toLowerCase();
  return policy[key] !== false;
}

const VISUAL_TYPES = ['table', 'matrix', 'bar', 'stackedbar', 'column', 'stackedcolumn', 'line', 'area', 'pie', 'donut', 'scatter', 'funnel', 'gauge', 'card', 'kpi', 'map', 'slicer', 'textbox', 'image'];

function normalizeVisualBucketNames(fields) {
  const seen = new Set();
  return (Array.isArray(fields) ? fields : [])
    .map((field) => String(typeof field === 'string' ? field : (field && field.name) || '').trim())
    .filter((name) => {
      if (!name || seen.has(name)) return false;
      seen.add(name);
      return true;
    })
    .slice(0, 60);
}

function normalizeReportVisuals(visuals) {
  if (!Array.isArray(visuals)) return [];
  return visuals.slice(0, 300).map((item) => {
    const viz = VISUAL_TYPES.includes(item.visualization) ? item.visualization : 'table';
    const isStatic = viz === 'textbox' || viz === 'image';
    const rawSql = String(item.sql || '').trim();
    const sql = isStatic || !rawSql ? '' : assertReadOnlySql(rawSql);
    const selectedFields = normalizeVisualQueryFieldObjects(item.selectedFields);
    let matrixRows = viz === 'matrix' ? normalizeVisualBucketNames(item.matrixRows) : [];
    let matrixColumns = viz === 'matrix' ? normalizeVisualBucketNames(item.matrixColumns) : [];
    let matrixValues = viz === 'matrix' ? normalizeVisualBucketNames(item.matrixValues) : [];
    if (viz === 'matrix' && !matrixRows.length && !matrixColumns.length && !matrixValues.length && selectedFields.length) {
      const legacyValue = String(item.value || '').trim();
      matrixValues = legacyValue ? selectedFields.filter((field) => field.name === legacyValue).map((field) => field.name) : [];
      matrixRows = selectedFields.filter((field) => !matrixValues.includes(field.name)).map((field) => field.name);
    }
    return {
      id: String(item.id || crypto.randomUUID()).slice(0, 80),
      title: String(item.title || 'Visual').slice(0, 120),
      sql,
      visualization: viz,
      table: isStatic ? '' : String(item.table || '').trim(),
      dimension: isStatic ? '' : String(item.dimension || '').trim(),
      value: isStatic ? '' : String(item.value || '').trim(),
      selectedFields,
      matrixRows,
      matrixColumns,
      matrixValues,
      aggregation: isStatic ? '' : String(item.aggregation || 'SUM').toUpperCase(),
      order: isStatic ? '' : String(item.order || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC',
      filterColumn: isStatic ? '' : String(item.filterColumn || '').trim(),
      filterOperator: isStatic ? '' : String(item.filterOperator || '=').trim(),
      filterValue: isStatic ? '' : String(item.filterValue || '').trim(),
      visualFilters: isStatic || !Array.isArray(item.visualFilters) ? [] : item.visualFilters.filter(function(f) { return f && f.column; }).map(function(f) { return { column: f.column, table: f.table || '', values: Array.isArray(f.values) ? f.values : [], availableValues: Array.isArray(f.availableValues) ? f.availableValues : [], locked: f.locked !== false }; }),
      style: normalizeVisualStyle(item.style),
      layout: item.layout && typeof item.layout === 'object' ? item.layout : { x: 32, y: 32, width: 560, height: 360 },
      pageId: String(item.pageId || 'page_1').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'page_1',
      content: isStatic ? String(item.content || '') : undefined,
      src: viz === 'image' ? String(item.src || '') : undefined,
      fit: viz === 'image' ? (['contain', 'cover', 'fill'].includes(item.fit) ? item.fit : 'contain') : undefined
    };
  });
}

function publicReport(report, semanticModel = null) {
  semanticModel = semanticModel || (report && report.__biwaFormattingModel) || null;

  return {
    id: report.id,
    name: report.name,
    visualization: report.visualization,
    refreshSeconds: report.refreshSeconds,
    limit: report.limit,
    layout: report.layout || { x: 32, y: 32, width: 560, height: 360 },
    pages: normalizeReportPages(report.pages),
    theme: normalizeReportTheme(report.theme),
    exportPolicy: reportExportPolicy(report),
    security: { rowLevelSecurity: normalizeReportSecurity(report.security).enabled },
    visuals: Array.isArray(report.visuals) ? report.visuals.map((v) => {
      const mapped = { id: v.id, title: v.title, visualization: v.visualization, layout: v.layout, pageId: v.pageId || 'page_1', style: normalizeVisualStyle(v.style), selectedFields: publicVisualQueryFieldObjects(v.selectedFields, semanticModel), matrixRows: normalizeVisualBucketNames(v.matrixRows), matrixColumns: normalizeVisualBucketNames(v.matrixColumns), matrixValues: normalizeVisualBucketNames(v.matrixValues) };
      if (v.visualization === 'textbox') mapped.content = v.content || '';
      if (v.visualization === 'image') { mapped.src = v.src || ''; mapped.fit = v.fit || 'contain'; }
      return mapped;
    }) : [],
    onlineFilters: normalizeOnlineFilters(report.onlineFilters),
    createdAt: report.createdAt,
    updatedAt: report.updatedAt
  };
}

function normalizeTableType(type) {
  const value = String(type || '').toUpperCase();
  if (value.includes('VIEW')) return 'VIEW';
  return 'BASE TABLE';
}

function buildResourceMeta(name, tableType, manualTables) {
  const isView = normalizeTableType(tableType) === 'VIEW';
  const nativeCalendar = !isView && String(name || '') === CALENDAR_TABLE_NAME;
  const manual = !isView && !nativeCalendar && manualTables.has(name);
  return {
    name,
    physicalName: name,
    type: isView ? 'view' : 'table',
    label: isView ? 'View' : (nativeCalendar ? 'Calendario nativo' : (manual ? 'Tabela manual' : 'Tabela')),
    source: nativeCalendar ? 'native' : (manual ? 'manual' : 'mysql'),
    manual,
    nativeCalendar,
    editable: manual,
    readOnly: !manual
  };
}

function manualResourceMeta(name, existing = {}) {
  const cleanName = String(name || '').trim();
  return {
    ...existing,
    name: cleanName,
    physicalName: String(existing.physicalName || existing.cacheTable || cleanName),
    sourceTable: cleanName,
    tableType: 'BASE TABLE',
    type: 'table',
    label: 'Tabela manual',
    source: 'manual',
    manual: true,
    nativeCalendar: false,
    editable: true,
    readOnly: false
  };
}

function mergeManualResources(resources, manualTableNames) {
  const merged = [];
  const indexByName = new Map();
  (resources || []).forEach(function(item) {
    const name = String(item && item.name || '').trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (indexByName.has(key)) {
      merged[indexByName.get(key)] = item;
      return;
    }
    indexByName.set(key, merged.length);
    merged.push(item);
  });
  (manualTableNames || []).forEach(function(name) {
    const cleanName = String(name || '').trim();
    if (!cleanName) return;
    const key = cleanName.toLowerCase();
    if (indexByName.has(key)) {
      const index = indexByName.get(key);
      merged[index] = manualResourceMeta(cleanName, merged[index]);
      return;
    }
    indexByName.set(key, merged.length);
    merged.push(manualResourceMeta(cleanName));
  });
  return merged;
}


function calendarResourceMeta() {
  return buildResourceMeta(CALENDAR_TABLE_NAME, 'BASE TABLE', new Set());
}

function calendarColumnMetadata() {
  return [
    ['Data', 'data', 'DATE', 'PRI'],
    ['DataKey', 'inteiro', 'INT', ''],
    ['Ano', 'inteiro', 'INT', ''],
    ['MesNumero', 'inteiro', 'INT', ''],
    ['MesNome', 'texto', 'VARCHAR(20)', ''],
    ['MesNomeCurto', 'texto', 'VARCHAR(10)', ''],
    ['AnoMes', 'texto', 'VARCHAR(7)', ''],
    ['AnoMesNome', 'texto', 'VARCHAR(20)', ''],
    ['Dia', 'inteiro', 'INT', ''],
    ['DiaSemanaNumero', 'inteiro', 'INT', ''],
    ['DiaSemanaNome', 'texto', 'VARCHAR(20)', ''],
    ['DiaDoAno', 'inteiro', 'INT', ''],
    ['SemanaAno', 'inteiro', 'INT', ''],
    ['Trimestre', 'inteiro', 'INT', ''],
    ['TrimestreNome', 'texto', 'VARCHAR(20)', ''],
    ['Semestre', 'inteiro', 'INT', ''],
    ['InicioMes', 'data', 'DATE', ''],
    ['FimMes', 'data', 'DATE', ''],
    ['UltimoDiaMes', 'inteiro', 'INT', ''],
    ['EhFimSemana', 'bool', 'TINYINT(1)', ''],
    ['DiaUtil', 'bool', 'TINYINT(1)', '']
  ].map(([name, dataType, columnType, columnKey]) => ({
    name,
    dataType,
    columnType,
    columnKey,
    nullable: 'NO',
    defaultValue: null,
    extra: ''
  }));
}

function withNativeCalendarFirst(resources, manualTables = new Set()) {
  const map = new Map();
  map.set(CALENDAR_TABLE_NAME, calendarResourceMeta());
  for (const item of resources || []) {
    const meta = item && item.type ? item : buildResourceMeta(item.name, item.tableType || 'BASE TABLE', manualTables);
    map.set(meta.name, meta);
  }
  return Array.from(map.values()).sort((a, b) => {
    if (a.name === CALENDAR_TABLE_NAME) return -1;
    if (b.name === CALENDAR_TABLE_NAME) return 1;
    const aw = a.source === 'native' ? 0 : (a.type === 'table' ? 1 : 2);
    const bw = b.source === 'native' ? 0 : (b.type === 'table' ? 1 : 2);
    if (aw !== bw) return aw - bw;
    return String(a.name).localeCompare(String(b.name));
  });
}

async function getResourcesFromInformationSchema() {
  const [rows] = await dbQueryWithTimeout(
    `SELECT TABLE_NAME AS name,
            TABLE_TYPE AS tableType
       FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_TYPE IN ('BASE TABLE', 'VIEW', 'SYSTEM VIEW')
      ORDER BY CASE WHEN TABLE_TYPE = 'BASE TABLE' THEN 0 ELSE 1 END, TABLE_NAME`
  );
  return rows.map((row) => ({ name: row.name, tableType: normalizeTableType(row.tableType) }));
}

async function getViewsFromInformationSchemaViews() {
  try {
    const [rows] = await dbQueryWithTimeout(
      `SELECT TABLE_NAME AS name
         FROM INFORMATION_SCHEMA.VIEWS
        WHERE TABLE_SCHEMA = DATABASE()
        ORDER BY TABLE_NAME`
    );
    return rows.map((row) => ({ name: row.name, tableType: 'VIEW' }));
  } catch (err) {
    return [];
  }
}

async function getResourcesFromShowFullTables() {
  try {
    const [rows] = await dbQueryWithTimeout('SHOW FULL TABLES');
    const resources = [];
    for (const row of rows) {
      const values = Object.values(row);
      if (!values.length) continue;
      const name = String(values[0] || '').trim();
      const type = String(values[1] || '').trim();
      if (name) resources.push({ name, tableType: normalizeTableType(type) });
    }
    return resources;
  } catch (err) {
    return [];
  }
}

async function getResourcesFromShowTables() {
  try {
    const [rows] = await dbQueryWithTimeout('SHOW TABLES');
    const resources = [];
    for (const row of rows) {
      const values = Object.values(row);
      const name = String(values[0] || '').trim();
      if (name) resources.push({ name, tableType: 'BASE TABLE' });
    }
    return resources;
  } catch (err) {
    return [];
  }
}

async function collectDatabaseResourcesWithDiagnostics(options = {}) {
  const cacheKey = currentDatabaseName();
  const now = Date.now();
  if (!options.force && resourceListCache.key === cacheKey && resourceListCache.resources.length && (now - resourceListCache.savedAt) < RESOURCE_CACHE_TTL_MS) {
    return {
      resources: resourceListCache.resources.slice(),
      diagnostics: [{ method: 'cache', ok: true, count: resourceListCache.resources.length, ageMs: now - resourceListCache.savedAt }, ...(resourceListCache.diagnostics || [])]
    };
  }

  const diagnostics = [];
  const combined = [];

  async function tryLoader(label, loader, timeoutMs = RESOURCE_TOTAL_TIMEOUT_MS) {
    try {
      const items = await promiseTimeout(Promise.resolve().then(loader), timeoutMs, label);
      diagnostics.push({ method: label, ok: true, count: (items || []).length });
      combined.push(...(items || []));
      return items || [];
    } catch (err) {
      diagnostics.push({ method: label, ok: false, error: err.message || String(err) });
      return [];
    }
  }

  // Caminho rapido: SHOW FULL TABLES normalmente retorna tabelas e views sem varrer INFORMATION_SCHEMA pesado.
  let fast = await tryLoader('SHOW FULL TABLES rapido', getResourcesFromShowFullTables, Math.min(8000, RESOURCE_TOTAL_TIMEOUT_MS));
  if (!fast.length) {
    fast = await tryLoader('SHOW TABLES rapido', getResourcesFromShowTables, Math.min(8000, RESOURCE_TOTAL_TIMEOUT_MS));
  }

  // Se o caminho rapido nao identificou views, tenta complementar com INFORMATION_SCHEMA com timeout curto.
  const hasView = combined.some((item) => normalizeTableType(item.tableType) === 'VIEW');
  if (!hasView) {
    await tryLoader('INFORMATION_SCHEMA.VIEWS complemento', getViewsFromInformationSchemaViews, Math.min(6000, RESOURCE_TOTAL_TIMEOUT_MS));
  }

  // INFORMATION_SCHEMA.TABLES fica como complemento, mas nao pode atrasar toda a tela.
  if (!combined.length) {
    await tryLoader('INFORMATION_SCHEMA.TABLES fallback', getResourcesFromInformationSchema, RESOURCE_TOTAL_TIMEOUT_MS);
  }

  const map = new Map();
  for (const item of combined) {
    if (!item || !item.name) continue;
    const currentType = normalizeTableType(item.tableType);
    const existing = map.get(item.name);
    if (!existing || currentType === 'VIEW') {
      map.set(item.name, { name: item.name, tableType: currentType });
    }
  }

  const resources = Array.from(map.values()).sort((a, b) => {
    const aw = a.tableType === 'VIEW' ? 1 : 0;
    const bw = b.tableType === 'VIEW' ? 1 : 0;
    if (aw !== bw) return aw - bw;
    return String(a.name).localeCompare(String(b.name));
  });

  if (resources.length) {
    resourceListCache = { key: cacheKey, savedAt: Date.now(), resources: resources.slice(), diagnostics: diagnostics.slice() };
  }

  return { resources, diagnostics };
}

async function getRawDatabaseResources() {
  const result = await collectDatabaseResourcesWithDiagnostics();
  return result.resources;
}

async function getTables() {
  const manualTableNames = await readManualTables();
  const manualTables = new Set(manualTableNames);
  const manualTableKeys = new Set(manualTableNames.map(function(name) { return String(name || '').toLowerCase(); }));
  let rows = [];
  try { rows = await getRawDatabaseResources(); } catch (err) { rows = []; }
  const base = withNativeCalendarFirst(rows, manualTables);
  const transforms = (await readTransforms()).map(transformResourceMeta);
  const imported = [];
  for (const item of await readImportedTables()) {
    const physical = rows.find((r) => r.name === item.sourceTable);
    imported.push(importedResourceMeta(item, physical || { name: item.sourceTable, tableType: 'BASE TABLE' }));
  }
  const map = new Map();
  [...base, ...transforms, ...imported].forEach((item) => map.set(item.name, item));
  if (postgresCacheAvailable()) {
    try {
      const cached = await listPgCacheStatus();
      cached.forEach(function(item) {
        const name = String(item.sourceTable || item.physicalTable || '').trim();
        if (!name) return;
        const manual = item.syncMode === 'manual' || manualTableKeys.has(name.toLowerCase());
        if (!manual) return;
        map.set(name, {
          name,
          physicalName: item.cacheTable || name,
          sourceTable: name,
          tableType: 'BASE TABLE',
          type: 'table',
          label: 'Tabela manual',
          source: 'manual',
          manual: true,
          editable: true,
          readOnly: false
        });
      });
    } catch (err) {
      manualTableNames.forEach(function(name) {
        if (!map.has(name)) {
          map.set(name, { name, physicalName: name, sourceTable: name, tableType: 'BASE TABLE', type: 'table', label: 'Tabela manual', source: 'manual', manual: true, editable: true, readOnly: false });
        }
      });
    }
  }
  return sortResourcesForApi(mergeManualResources(Array.from(map.values()), manualTableNames));
}

function sortResourcesForApi(resources) {
  return (resources || []).slice().sort((a, b) => {
    if (a.name === CALENDAR_TABLE_NAME) return -1;
    if (b.name === CALENDAR_TABLE_NAME) return 1;
    const weight = (item) => item.source === 'native' ? 0 : (item.source === 'transform' ? 1 : (item.type === 'table' ? 2 : 3));
    const aw = weight(a);
    const bw = weight(b);
    if (aw !== bw) return aw - bw;
    return String(a.name).localeCompare(String(b.name));
  });
}

async function findDatabaseResourceByName(table) {
  const requested = String(table || '').trim();
  if (!requested) return null;

  // v3.2.93: verifica cache PostgreSQL primeiro (app funciona primariamente com PG)
  if (postgresCacheAvailable()) {
    try {
      const pgMeta = await getPgCacheMeta(requested);
      if (pgMeta) {
        return { name: requested, tableType: 'BASE TABLE', source: 'postgres-cache', physicalName: pgMeta.physical_table || requested };
      }
    } catch (e) { /* continua */ }
  }

  // Fallback MySQL: caminho direto via INFORMATION_SCHEMA
  try {
    const [directRows] = await dbQueryWithTimeout(
      `SELECT TABLE_NAME AS name,
              TABLE_TYPE AS tableType
         FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND LOWER(TABLE_NAME) = LOWER(?)
        LIMIT 1`,
      [requested],
      Math.max(30000, Number(process.env.MYSQL_METADATA_TIMEOUT || 30000))
    );
    if (directRows && directRows[0] && directRows[0].name) {
      return { name: directRows[0].name, tableType: normalizeTableType(directRows[0].tableType) };
    }
  } catch (err) {
    /* MySQL indisponivel - ja tentamos PG cache acima */
  }

  // Fallback pesado: varredura completa das tabelas MySQL
  try {
    const rows = await getRawDatabaseResources();
    let found = rows.find((row) => row.name === requested);
    if (found) return found;
    const requestedLower = requested.toLowerCase();
    found = rows.find((row) => String(row.name || '').toLowerCase() === requestedLower);
    if (found) return found;
  } catch (err) {
    /* MySQL indisponivel */
  }

  return null;
}

async function getRelationMeta(table) {
  if (String(table || '') === CALENDAR_TABLE_NAME) {
    return calendarResourceMeta();
  }
  const transform = await findTransformByName(table);
  if (transform) return transformResourceMeta(transform);
  const imported = await findImportedTableByName(table);
  if (imported) {
    let physical = null;
    if (postgresCacheAvailable()) {
      try {
        const pgMeta = await getPgCacheMeta(imported.sourceTable);
        if (pgMeta) physical = { name: imported.sourceTable, tableType: 'BASE TABLE', source: 'postgres-cache' };
      } catch (e2) { /* continua */ }
    }
    if (!physical) physical = { name: imported.sourceTable, tableType: 'BASE TABLE', source: 'postgres-cache' };
    return importedResourceMeta(imported, physical);
  }
  const manualTables = new Set(await readManualTables());
  if (await isHiddenMysqlTable(table)) {
    throw apiError('Tabela/view removida do app. Ela continua no MySQL, mas nao sera carregada pelo BI WA ate ser restaurada em Inserir Dados.', 404);
  }
  // Usa apenas PostgreSQL cache
  if (postgresCacheAvailable()) {
    try {
      const pgMeta = await getPgCacheMeta(table);
      if (pgMeta) {
        const isManual = pgMeta.sync_mode === 'manual' || manualTables.has(table);
        return { name: table, physicalName: pgMeta.physical_table || table, sourceTable: pgMeta.physical_table || table, type: 'table', source: 'postgres-cache', columns: pgMeta.columns || [], readOnly: !isManual, manual: isManual, editable: isManual };
      }
    } catch (e) { /* continua */ }
  }
  throw apiError('Tabela ou view nao encontrada no cache PostgreSQL. Sincronize os dados primeiro.', 404);
}

async function ensureTableExists(table) {
  return getRelationMeta(table);
}

async function ensureManualTable(table, actionLabel = 'Esta acao') {
  const meta = await getRelationMeta(table);
  if (meta.type !== 'table') {
    throw apiError(`${actionLabel} nao pode ser feita em view. Views sao somente leitura no BI WA.`, 400);
  }
  if (meta.nativeCalendar) {
    throw apiError(`${actionLabel} nao pode ser feita na tabela Calendario. Ela e nativa do BI WA e somente leitura.`, 400);
  }
  if (!meta.manual) {
    throw apiError(`${actionLabel} so pode ser feita em tabela manual criada pelo BI WA. Tabelas vindas do MySQL externo sao somente leitura.`, 400);
  }
  await ensureManualTableIdentity(table);
  return meta;
}

async function resolveManualTablePgRef(table) {
  if (!postgresCacheAvailable()) return null;
  try {
    const pgMeta = await getPgCacheMeta(table);
    if (pgMeta && pgMeta.sync_mode === 'manual') {
      var pgCacheTable = pgMeta.cache_table || '';
      var pgSourceTable = pgMeta.source_table || '';
      if (!pgCacheTable || (pgCacheTable !== pgSourceTable && pgCacheTable.startsWith('manual_'))) {
        pgCacheTable = pgSourceTable;
        pgMeta.cache_table = pgCacheTable;
        await pgCacheQuery('UPDATE ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, '__biwa_cache_meta') + ' SET cache_table = $2 WHERE LOWER(source_table) = LOWER($1)', [table, pgCacheTable]);
      }
      return { pgTable: quotePgQualified(POSTGRES_CACHE_SCHEMA, pgCacheTable), meta: pgMeta };
    }
  } catch (e) { /* ignore */ }
  return null;
}

function sanitizePgNumeric(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  var str = String(value).trim();
  if (str === '') return null;
  if (/^-?\d+\.?\d*$/.test(str)) return str;
  var cleaned = str.replace(/\./g, '').replace(/,/g, '.');
  if (/^-?\d+\.?\d*$/.test(cleaned)) return cleaned;
  return str;
}

function sanitizePgDate(value) {
  if (value === null || value === undefined) return null;
  var str = String(value).trim();
  if (str === '') return null;
  var brMatch = str.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (brMatch) return brMatch[3] + '-' + brMatch[2] + '-' + brMatch[1];
  if (/^\d{4}-\d{2}-\d{2}(T| |$)/.test(str)) return str;
  return str;
}

function sanitizePgValue(value, colType) {
  if (value === null || value === undefined) return null;
  var t = (colType || '').toLowerCase();
  if (/int|numeric|decimal|float|double|real|serial/i.test(t)) return sanitizePgNumeric(value);
  if (/date|timestamp|datetime/i.test(t)) return sanitizePgDate(value);
  return value;
}

function normalizePgCacheColumns(columns) {
  return (columns || []).map(function(col) {
    if (typeof col === 'string') {
      return { name: col, dataType: 'text', columnType: 'text', columnKey: '', nullable: 'YES', defaultValue: null, extra: '' };
    }
    const rawType = String(col && (col.dataType || col.Type || col.type || col.columnType) || 'text');
    return {
      ...col,
      name: col.name || col.Field || '',
      dataType: rawType.split('(')[0].toLowerCase(),
      columnType: col.columnType || col.Type || col.type || rawType,
      columnKey: col.columnKey || col.Key || col.key || (col.primaryKey ? 'PRI' : ''),
      nullable: String(col.nullable || col.Null || col.null || 'YES'),
      defaultValue: col.defaultValue ?? col.Default ?? col.default ?? null,
      extra: col.extra || col.Extra || (col.autoIncrement ? 'auto_increment' : '')
    };
  }).filter(function(col) { return col.name; });
}

async function getColumns(table) {
  if (String(table || '') === CALENDAR_TABLE_NAME) return calendarColumnMetadata();
  const transform = await findTransformByName(table);
  if (transform) {
    if (transform.daxExpression && postgresCacheAvailable()) {
      try {
        const effectiveMeta = await getPgEffectiveMeta(transform.name);
        if (effectiveMeta && Array.isArray(effectiveMeta.columns) && effectiveMeta.columns.length) {
          return normalizePgCacheColumns(effectiveMeta.columns);
        }
      } catch (err) { /* usa o fallback da definicao abaixo */ }
    }
    const built = await buildTransformSql(transform, { limit: 1 });
    return transformColumnMetadata(built.columns, transform.steps);
  }
  // Resolve nome logico para nome fisico da tabela importada
  let lookupTable = table;
  try {
    const imported = await findImportedTableByName(table);
    if (imported && imported.sourceTable) lookupTable = imported.sourceTable;
  } catch (e) { /* usa o nome original */ }
  // Usa apenas PostgreSQL cache como fonte de colunas
  if (postgresCacheAvailable()) {
    try {
      const pgMeta = await getPgEffectiveMeta(lookupTable);
      if (pgMeta && Array.isArray(pgMeta.columns) && pgMeta.columns.length) {
        return normalizePgCacheColumns(pgMeta.columns);
      }
    } catch (e) { /* retorna vazio */ }
  }
  return [];
}

async function getMysqlColumnsMetadata(physicalTableName) {
  const tableName = String(physicalTableName || '').trim();
  quoteIdent(tableName);
  const timeoutMs = Math.max(30000, Number(process.env.MYSQL_METADATA_TIMEOUT || 30000));

  // SHOW FULL COLUMNS funciona sem acesso ao INFORMATION_SCHEMA
  try {
    const [showRows] = await dbQueryWithTimeout(`SHOW FULL COLUMNS FROM ${quoteIdent(tableName)}`, [], timeoutMs);
    if (Array.isArray(showRows) && showRows.length) {
      return showRows.map((row) => ({
        name: row.Field,
        dataType: String(row.Type || '').split('(')[0].toLowerCase(),
        columnType: row.Type || '',
        columnKey: row.Key || '',
        nullable: row.Null || '',
        defaultValue: row.Default ?? null,
        extra: row.Extra || ''
      }));
    }
  } catch (err) {
    // fallback abaixo
  }

  const [rows] = await dbQueryWithTimeout(
    `SELECT COLUMN_NAME AS name,
            DATA_TYPE AS dataType,
            COLUMN_TYPE AS columnType,
            COLUMN_KEY AS columnKey,
            IS_NULLABLE AS nullable,
            COLUMN_DEFAULT AS defaultValue,
            EXTRA AS extra
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION`,
    [tableName],
    timeoutMs
  );
  return rows.map((row) => ({
    name: row.name,
    dataType: row.dataType,
    columnType: row.columnType,
    columnKey: row.columnKey,
    nullable: row.nullable,
    defaultValue: row.defaultValue,
    extra: row.extra
  }));
}

function filterKnownColumns(values, columns, options = {}) {
  const known = new Map(columns.map((c) => [c.name, c]));
  const out = {};
  for (const [key, value] of Object.entries(values || {})) {
    const col = known.get(key);
    if (!col) continue;
    if (options.skipAutoIncrement && /auto_increment/i.test(col.extra || '') && (value === '' || value === null || value === undefined)) {
      continue;
    }
    out[key] = value === undefined ? null : value;
  }
  return out;
}

function primaryKeys(columns) {
  return columns.filter((c) => c.columnKey === 'PRI').map((c) => c.name);
}

function buildWhereForPk(pk, pkColumns) {
  if (!pk || typeof pk !== 'object') throw apiError('Valores da chave primaria sao obrigatorios.', 400);
  const where = [];
  const values = [];
  for (const col of pkColumns) {
    if (!(col in pk)) throw apiError('Falta valor da chave primaria: ' + col, 400);
    where.push(quoteIdent(col) + ' = ?');
    values.push(pk[col]);
  }
  return { whereSql: where.join(' AND '), values };
}


function findRelationshipBetween(model, leftTable, rightTable) {
  const relationships = Array.isArray(model && model.relationships) ? model.relationships.filter((rel) => rel && rel.active !== false) : [];
  const leftKey = normalizeTableKey(leftTable);
  const rightKey = normalizeTableKey(rightTable);
  return relationships.find((rel) =>
    (normalizeTableKey(rel.fromTable) === leftKey && normalizeTableKey(rel.toTable) === rightKey) ||
    (normalizeTableKey(rel.fromTable) === rightKey && normalizeTableKey(rel.toTable) === leftKey)
  ) || null;
}

function relationshipAllowsFilterPropagation(rel, sourceTable, targetTable) {
  if (!rel || rel.active === false) return false;
  const sourceKey = normalizeTableKey(sourceTable);
  const targetKey = normalizeTableKey(targetTable);
  const fromKey = normalizeTableKey(rel.fromTable);
  const toKey = normalizeTableKey(rel.toTable);
  if (!sourceKey || !targetKey || !fromKey || !toKey) return false;
  if (fromKey === sourceKey && toKey === targetKey) return true;
  return String(rel.filterDirection || 'single').trim().toLowerCase() === 'both'
    && toKey === sourceKey
    && fromKey === targetKey;
}

function findFilterPropagationRelationship(model, sourceTable, targetTable) {
  const relationships = Array.isArray(model && model.relationships) ? model.relationships : [];
  return relationships.find((rel) => relationshipAllowsFilterPropagation(rel, sourceTable, targetTable)) || null;
}

function findFilterPropagationPath(model, sourceTable, targetTable, maxDepth = 8) {
  const source = String(sourceTable || '').trim();
  const target = String(targetTable || '').trim();
  const sourceKey = normalizeTableKey(source);
  const targetKey = normalizeTableKey(target);
  if (!source || !target) return null;
  if (sourceKey === targetKey) return { relationships: [], nodes: [source], ambiguous: false };
  const relationships = Array.isArray(model && model.relationships)
    ? model.relationships.filter((rel) => rel && rel.active !== false && rel.fromTable && rel.toTable && rel.fromColumn && rel.toColumn)
    : [];
  const adjacency = new Map();
  for (const rel of relationships) {
    const fromKey = normalizeTableKey(rel.fromTable);
    const toKey = normalizeTableKey(rel.toTable);
    if (!adjacency.has(fromKey)) adjacency.set(fromKey, []);
    adjacency.get(fromKey).push({ rel, next: rel.toTable, nextKey: toKey });
    if (String(rel.filterDirection || 'single').trim().toLowerCase() === 'both') {
      if (!adjacency.has(toKey)) adjacency.set(toKey, []);
      adjacency.get(toKey).push({ rel, next: rel.fromTable, nextKey: fromKey });
    }
  }
  const queue = [{ table: source, tableKey: sourceKey, path: [], nodes: [source] }];
  const visitedDepth = new Map([[sourceKey, 0]]);
  let match = null;
  let ambiguous = false;
  while (queue.length) {
    const current = queue.shift();
    if (current.path.length >= maxDepth || (match && current.path.length >= match.relationships.length)) continue;
    for (const edge of adjacency.get(current.tableKey) || []) {
      const nextDepth = current.path.length + 1;
      const previousDepth = visitedDepth.get(edge.nextKey);
      if (previousDepth !== undefined && previousDepth < nextDepth) continue;
      const nextPath = current.path.concat(edge.rel);
      const nextNodes = current.nodes.concat(edge.next);
      if (edge.nextKey === targetKey) {
        if (!match) match = { relationships: nextPath, nodes: nextNodes, ambiguous: false };
        else if (match.relationships.length === nextPath.length) ambiguous = true;
        continue;
      }
      visitedDepth.set(edge.nextKey, nextDepth);
      queue.push({ table: edge.next, tableKey: edge.nextKey, path: nextPath, nodes: nextNodes });
    }
  }
  if (match) match.ambiguous = ambiguous;
  return match;
}

// FILTER_DOMAIN_QUERY pode precisar responder quais valores de uma dimensao
// possuem linhas em uma fato sob o contexto atual. Isso nao muda a direcao do
// relacionamento: cada dimensao precisa continuar alcançando a mesma tabela
// testemunha pelo fluxo dirigido configurado no modelo.
function findFilterDomainWitnessPlan(model, targetTable, contextEntries, domainTable) {
  const target = String(targetTable || '').trim();
  if (!target) return null;
  const relationships = Array.isArray(model && model.relationships)
    ? model.relationships.filter((rel) => rel && rel.active !== false && rel.fromTable && rel.toTable && rel.fromColumn && rel.toColumn)
    : [];
  const candidates = [];
  const seen = new Set();
  const addCandidate = (table) => {
    const name = String(table || '').trim();
    const key = normalizeTableKey(name);
    if (!name || !key || seen.has(key) || key === normalizeTableKey(target)) return;
    seen.add(key);
    candidates.push(name);
  };
  const explicitDomain = String(domainTable || '').trim();
  if (explicitDomain) addCandidate(explicitDomain);
  if (!explicitDomain) relationships.forEach((rel) => {
    addCandidate(rel.fromTable);
    addCandidate(rel.toTable);
  });

  const entries = (contextEntries || []).filter((entry) => entry && entry.table && entry.field && entry.value !== '' && entry.value !== null && entry.value !== undefined);
  let best = null;
  for (const candidate of candidates) {
    const targetPath = findFilterPropagationPath(model, target, candidate);
    if (!targetPath || !targetPath.relationships || !targetPath.relationships.length) continue;
    const contextPaths = [];
    let viable = true;
    let score = targetPath.relationships.length;
    for (const entry of entries) {
      if (sameTableName(entry.table, target)) {
        contextPaths.push({ table: entry.table, anchor: 'target', path: { relationships: [], nodes: [target], ambiguous: false } });
        continue;
      }
      const targetDirectedPath = findFilterPropagationPath(model, entry.table, target);
      if (targetDirectedPath) {
        contextPaths.push({ table: entry.table, anchor: 'target', path: targetDirectedPath });
        score += targetDirectedPath.relationships.length;
        continue;
      }
      const witnessPath = sameTableName(entry.table, candidate)
        ? { relationships: [], nodes: [candidate], ambiguous: false }
        : findFilterPropagationPath(model, entry.table, candidate);
      if (!witnessPath) {
        viable = false;
        break;
      }
      contextPaths.push({ table: entry.table, anchor: 'witness', path: witnessPath });
      score += witnessPath.relationships.length;
    }
    if (!viable) continue;
    const plan = {
      table: candidate,
      targetPath,
      contextPaths,
      score,
      ambiguous: targetPath.ambiguous === true || contextPaths.some((item) => item.path && item.path.ambiguous === true)
    };
    if (!best || plan.score < best.score) best = plan;
  }
  return best;
}

function relationshipColumnForTarget(rel, sourceTable, targetTable) {
  if (!rel) return null;
  const sourceKey = normalizeTableKey(sourceTable);
  const targetKey = normalizeTableKey(targetTable);
  if (normalizeTableKey(rel.fromTable) === sourceKey && normalizeTableKey(rel.toTable) === targetKey) {
    return { sourceColumn: rel.fromColumn, targetColumn: rel.toColumn };
  }
  if (normalizeTableKey(rel.toTable) === sourceKey && normalizeTableKey(rel.fromTable) === targetKey) {
    return { sourceColumn: rel.toColumn, targetColumn: rel.fromColumn };
  }
  return null;
}

function manualIdentitySequenceName(table, column) {
  return 'manual_id_' + crypto.createHash('sha1').update(String(table || '') + '|' + String(column || '')).digest('hex').slice(0, 24);
}

async function ensureManualTableIdentity(table) {
  const pgRef = await resolveManualTablePgRef(table);
  if (!pgRef || !pgRef.meta || !pgRef.meta.cache_table) return null;
  const columns = Array.isArray(pgRef.meta.columns) ? pgRef.meta.columns : [];
  const candidate = columns.find(function(col) {
    const name = String(col && (col.name || col.Field) || '').toLowerCase();
    const type = String(col && (col.type || col.dataType || col.columnType || col.Type) || '').toLowerCase();
    const key = String(col && (col.key || col.columnKey || col.Key) || '').toUpperCase();
    return name === 'id' && key === 'PRI' && /int|serial|numeric|decimal/.test(type);
  });
  if (!candidate) return null;

  const info = await pgCacheQuery(
    'SELECT column_default, is_identity FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3 LIMIT 1',
    [POSTGRES_CACHE_SCHEMA, pgRef.meta.cache_table, candidate.name]
  );
  const actual = info.rows && info.rows[0];
  if (!actual) return null;
  const alreadyGenerated = Boolean(actual.column_default) || String(actual.is_identity || '').toUpperCase() === 'YES';
  const normalizedColumns = columns.map(function(col) {
    if (String(col && col.name || '').toLowerCase() !== String(candidate.name || '').toLowerCase()) return col;
    return { ...col, key: 'PRI', columnKey: 'PRI', primaryKey: true, autoIncrement: true, extra: 'auto_increment' };
  });
  if (alreadyGenerated) {
    if (!candidate.autoIncrement || !/auto_increment/i.test(String(candidate.extra || ''))) {
      await pgCacheQuery(
        'UPDATE ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, '__biwa_cache_meta') + ' SET columns_json = $2, primary_keys = $3 WHERE LOWER(source_table) = LOWER($1)',
        [table, JSON.stringify(normalizedColumns), JSON.stringify([candidate.name])]
      );
    }
    return { column: candidate.name, repaired: false };
  }

  const sequenceName = manualIdentitySequenceName(table, candidate.name);
  const sequenceRef = quotePgQualified(POSTGRES_CACHE_SCHEMA, sequenceName);
  const sequenceRegclass = quotePgIdent(POSTGRES_CACHE_SCHEMA) + '.' + quotePgIdent(sequenceName);
  await pgCacheTransaction(async function(client) {
    await client.query('CREATE SEQUENCE IF NOT EXISTS ' + sequenceRef);
    await client.query('ALTER SEQUENCE ' + sequenceRef + ' OWNED BY ' + pgRef.pgTable + '.' + quotePgIdent(candidate.name));
    await client.query('ALTER TABLE ' + pgRef.pgTable + ' ALTER COLUMN ' + quotePgIdent(candidate.name) + ' SET DEFAULT nextval(' + quotePgLiteral(sequenceRegclass) + '::regclass)');
    const maxResult = await client.query('SELECT COALESCE(MAX(' + quotePgIdent(candidate.name) + '), 0)::bigint AS max_id FROM ' + pgRef.pgTable);
    const nextValue = Math.max(1, Number(maxResult.rows[0] && maxResult.rows[0].max_id || 0) + 1);
    await client.query('SELECT setval($1::regclass, $2, false)', [sequenceRegclass, nextValue]);
    await client.query(
      'UPDATE ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, '__biwa_cache_meta') + ' SET columns_json = $2, primary_keys = $3 WHERE LOWER(source_table) = LOWER($1)',
      [table, JSON.stringify(normalizedColumns), JSON.stringify([candidate.name])]
    );
  });
  return { column: candidate.name, repaired: true };
}

async function refreshManualTableMetadata(table, changedRows, client, pgRef) {
  const ref = pgRef || await resolveManualTablePgRef(table);
  if (!ref) return null;
  const query = client ? client.query.bind(client) : pgCacheQuery;
  const countResult = await query('SELECT COUNT(*)::int AS count FROM ' + ref.pgTable);
  const rowCount = Number(countResult.rows && countResult.rows[0] && countResult.rows[0].count || 0);
  const changed = Math.max(0, Number(changedRows || 0));
  if (changed > 0) {
    await query(
      'UPDATE ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, '__biwa_cache_meta') + ' SET row_count = $2, synced_at = NOW(), last_data_update_at = NOW(), last_changed_rows = $3, sync_mode = $4 WHERE LOWER(source_table) = LOWER($1)',
      [table, rowCount, changed, 'manual']
    );
  } else {
    await query(
      'UPDATE ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, '__biwa_cache_meta') + ' SET row_count = $2, sync_mode = $3 WHERE LOWER(source_table) = LOWER($1)',
      [table, rowCount, 'manual']
    );
  }
  return rowCount;
}

function relationshipMetadataColumn(meta, column) {
  const target = String(column || '').trim().toLowerCase();
  return (meta && Array.isArray(meta.columns) ? meta.columns : []).find(function(item) {
    return String(item && (item.name || item.Field) || item || '').trim().toLowerCase() === target;
  }) || null;
}

function relationshipStorageTypeFamily(column) {
  const raw = String(column && (column.pgType || column.dataType || column.data_type || column.columnType || column.Type || column.type) || '').toLowerCase();
  if (/smallint|\bint\b|integer|inteiro|bigint|decimal|numeric|n[uú]mero|double|float|real|serial/.test(raw)) return 'number';
  if (/char|text|uuid|enum/.test(raw)) return 'text';
  if (/bool/.test(raw)) return 'boolean';
  if (/date|time/.test(raw)) return 'date';
  return '';
}

async function visualRelationshipMetadata(table, body = {}) {
  const tableName = normalizeTableName(table);
  if (!tableName || sameTableName(tableName, CALENDAR_TABLE_NAME) || !postgresCacheAvailable()) return null;
  let cache = body && body._relationshipMetadataPromises;
  if (!(cache instanceof Map)) {
    cache = new Map();
    if (body && typeof body === 'object') body._relationshipMetadataPromises = cache;
  }
  const key = normalizeTableKey(tableName);
  if (!cache.has(key)) {
    cache.set(key, Promise.resolve().then(async function() {
      try {
        const effective = await getPgEffectiveMeta(tableName);
        if (effective) return effective;
      } catch (e) {}
      try {
        const resolved = await resolvePgCacheLookup(tableName);
        return await getPgCacheMeta(resolved.table || tableName);
      } catch (e) {
        return null;
      }
    }));
  }
  return cache.get(key);
}

async function visualRelationshipJoinCondition(leftAlias, leftTable, leftColumn, rightAlias, rightTable, rightColumn, body = {}) {
  if (sameTableName(leftTable, CALENDAR_TABLE_NAME) || sameTableName(rightTable, CALENDAR_TABLE_NAME)) {
    return relationshipJoinCondition(leftAlias, leftTable, leftColumn, rightAlias, rightTable, rightColumn);
  }
  try {
    const metas = await Promise.all([
      visualRelationshipMetadata(leftTable, body),
      visualRelationshipMetadata(rightTable, body)
    ]);
    const leftFamily = relationshipStorageTypeFamily(relationshipMetadataColumn(metas[0], leftColumn));
    const rightFamily = relationshipStorageTypeFamily(relationshipMetadataColumn(metas[1], rightColumn));
    // Igualdade direta preserva o indice no PostgreSQL. Datas ficam no caminho
    // legado porque DATE/TIMESTAMP podem exigir normalizacao do horario.
    if (leftFamily && leftFamily === rightFamily && leftFamily !== 'date') {
      if (body && body._visualPerf) body._visualPerf.directRelationshipJoins = Number(body._visualPerf.directRelationshipJoins || 0) + 1;
      return `${leftAlias}.${quoteIdent(leftColumn)} = ${rightAlias}.${quoteIdent(rightColumn)}`;
    }
    if (body && body._visualPerf) {
      body._visualPerf.fallbackRelationshipJoins = Number(body._visualPerf.fallbackRelationshipJoins || 0) + 1;
      if (body.performanceDiagnostics === true) {
        if (!Array.isArray(body._visualPerf.relationshipDiagnostics)) body._visualPerf.relationshipDiagnostics = [];
        body._visualPerf.relationshipDiagnostics.push({
          leftTable, leftColumn, leftFamily,
          leftMeta: Boolean(metas[0]),
          leftColumnMeta: relationshipMetadataColumn(metas[0], leftColumn),
          leftColumns: (metas[0] && Array.isArray(metas[0].columns) ? metas[0].columns : []).map(function(item) { return item && (item.name || item.Field) || item; }).slice(0, 12),
          rightTable, rightColumn, rightFamily,
          rightColumnMeta: relationshipMetadataColumn(metas[1], rightColumn),
          rightMeta: Boolean(metas[1])
        });
      }
    }
  } catch (e) {}
  return relationshipJoinCondition(leftAlias, leftTable, leftColumn, rightAlias, rightTable, rightColumn);
}

function relationshipJoinCondition(leftAlias, leftTable, leftColumn, rightAlias, rightTable, rightColumn) {
  let leftSql = `${leftAlias}.${quoteIdent(leftColumn)}`;
  let rightSql = `${rightAlias}.${quoteIdent(rightColumn)}`;
  if (sameTableName(leftTable, CALENDAR_TABLE_NAME) || sameTableName(rightTable, CALENDAR_TABLE_NAME)) {
    leftSql = `DATE(${leftSql})`;
    rightSql = `DATE(${rightSql})`;
  } else {
    leftSql = `CAST(${leftSql} AS CHAR)`;
    rightSql = `CAST(${rightSql} AS CHAR)`;
  }
  return leftSql + ' = ' + rightSql;
}

function relationshipJoinConditionPg(leftAlias, leftTable, leftColumn, rightAlias, rightTable, rightColumn) {
  let leftSql = `${leftAlias}.${quotePgIdent(leftColumn)}`;
  let rightSql = `${rightAlias}.${quotePgIdent(rightColumn)}`;
  if (sameTableName(leftTable, CALENDAR_TABLE_NAME) || sameTableName(rightTable, CALENDAR_TABLE_NAME)) {
    leftSql = `DATE(${leftSql})`;
    rightSql = `DATE(${rightSql})`;
  } else {
    leftSql = `CAST(${leftSql} AS TEXT)`;
    rightSql = `CAST(${rightSql} AS TEXT)`;
  }
  return leftSql + ' = ' + rightSql;
}

function calendarFilterExpression(field, targetDateColumn) {
  const raw = String(targetDateColumn || '').trim();
  const col = /[.`"()]/.test(raw) ? raw : quoteIdent(raw);
  switch (String(field || '')) {
    case 'Data': return `DATE(${col})`;
    case 'DataKey': return `CAST(DATE_FORMAT(${col}, '%Y%m%d') AS UNSIGNED)`;
    case 'Ano': return `YEAR(${col})`;
    case 'MesNumero': return `MONTH(${col})`;
    case 'MesNome': return `CASE MONTH(${col}) WHEN 1 THEN 'Janeiro' WHEN 2 THEN 'Fevereiro' WHEN 3 THEN 'Mar\u00E7o' WHEN 4 THEN 'Abril' WHEN 5 THEN 'Maio' WHEN 6 THEN 'Junho' WHEN 7 THEN 'Julho' WHEN 8 THEN 'Agosto' WHEN 9 THEN 'Setembro' WHEN 10 THEN 'Outubro' WHEN 11 THEN 'Novembro' WHEN 12 THEN 'Dezembro' END`;
    case 'MesNomeCurto': return `CASE MONTH(${col}) WHEN 1 THEN 'Jan' WHEN 2 THEN 'Fev' WHEN 3 THEN 'Mar' WHEN 4 THEN 'Abr' WHEN 5 THEN 'Mai' WHEN 6 THEN 'Jun' WHEN 7 THEN 'Jul' WHEN 8 THEN 'Ago' WHEN 9 THEN 'Set' WHEN 10 THEN 'Out' WHEN 11 THEN 'Nov' WHEN 12 THEN 'Dez' END`;
    case 'AnoMes': return `DATE_FORMAT(${col}, '%Y-%m')`;
    case 'AnoMesNome': return `CONCAT(CASE MONTH(${col}) WHEN 1 THEN 'Jan' WHEN 2 THEN 'Fev' WHEN 3 THEN 'Mar' WHEN 4 THEN 'Abr' WHEN 5 THEN 'Mai' WHEN 6 THEN 'Jun' WHEN 7 THEN 'Jul' WHEN 8 THEN 'Ago' WHEN 9 THEN 'Set' WHEN 10 THEN 'Out' WHEN 11 THEN 'Nov' WHEN 12 THEN 'Dez' END, '/', YEAR(${col}))`;
    case 'Dia': return `DAYOFMONTH(${col})`;
    case 'DiaSemanaNumero': return `DAYOFWEEK(${col})`;
    case 'DiaDoAno': return `DAYOFYEAR(${col})`;
    case 'SemanaAno': return `WEEK(${col}, 3)`;
    case 'Trimestre': return `QUARTER(${col})`;
    case 'TrimestreNome': return `CONCAT(QUARTER(${col}), '\u00BA Trimestre')`;
    case 'Semestre': return `CASE WHEN MONTH(${col}) <= 6 THEN 1 ELSE 2 END`;
    case 'InicioMes': return `DATE_FORMAT(${col}, '%Y-%m-01')`;
    case 'FimMes': return `LAST_DAY(${col})`;
    case 'UltimoDiaMes': return `DAYOFMONTH(LAST_DAY(${col}))`;
    case 'EhFimSemana': return `CASE WHEN DAYOFWEEK(${col}) IN (1, 7) THEN 1 ELSE 0 END`;
    case 'DiaUtil': return `CASE WHEN DAYOFWEEK(${col}) IN (1, 7) THEN 0 ELSE 1 END`;
    default: return col;
  }
}

function findRelationshipPath(model, sourceTable, targetTable, maxDepth = 3) {
  const source = String(sourceTable || '').trim();
  const target = String(targetTable || '').trim();
  const sourceKey = normalizeTableKey(source);
  const targetKey = normalizeTableKey(target);
  if (!source || !target) return null;
  if (sourceKey === targetKey) return { relationships: [], nodes: [source] };
  const relationships = Array.isArray(model && model.relationships) ? model.relationships.filter((rel) => rel && rel.active !== false) : [];
  const adjacency = new Map();
  for (const rel of relationships) {
    if (!rel || !rel.fromTable || !rel.toTable || !rel.fromColumn || !rel.toColumn) continue;
    const fromKey = normalizeTableKey(rel.fromTable);
    const toKey = normalizeTableKey(rel.toTable);
    if (!adjacency.has(fromKey)) adjacency.set(fromKey, []);
    if (!adjacency.has(toKey)) adjacency.set(toKey, []);
    adjacency.get(fromKey).push({ rel, next: rel.toTable, nextKey: toKey });
    adjacency.get(toKey).push({ rel, next: rel.fromTable, nextKey: fromKey });
  }
  const queue = [{ table: source, tableKey: sourceKey, path: [], nodes: [source] }];
  const visited = new Set([sourceKey]);
  while (queue.length) {
    const current = queue.shift();
    if (current.path.length >= maxDepth) continue;
    for (const edge of adjacency.get(current.tableKey) || []) {
      if (visited.has(edge.nextKey)) continue;
      const nextPath = current.path.concat(edge.rel);
      const nextNodes = current.nodes.concat(edge.next);
      if (edge.nextKey === targetKey) return { relationships: nextPath, nodes: nextNodes };
      visited.add(edge.nextKey);
      queue.push({ table: edge.next, tableKey: edge.nextKey, path: nextPath, nodes: nextNodes });
    }
  }
  return null;
}

function resolveFilterCondition(filter, targetTable, semanticModel) {
  const filterTable = String(filter.table || '').trim();
  const filterField = String(filter.field || '').trim();
  const target = String(targetTable || '').trim();
  if (!target || !filterTable || sameTableName(filterTable, target)) return { type: 'column', columnSql: quoteIdent(filterField) };

  const directRel = findFilterPropagationRelationship(semanticModel, filterTable, target);
  const directColumns = relationshipColumnForTarget(directRel, filterTable, target);
  if (directColumns) {
    // Relacionamento Calendario -> Fato: filtros de Ano, Mes, Data, Trimestre etc.
    // sao convertidos para expressoes sobre a coluna de data da tabela relacionada.
    if (sameTableName(filterTable, CALENDAR_TABLE_NAME)) {
      return { type: 'column', columnSql: calendarFilterExpression(filterField, `src.${quoteIdent(directColumns.targetColumn)}`) };
    }

    // Quando o clique vem exatamente pela coluna da chave, aplicamos direto na coluna
    // correspondente da tabela de destino, preservando a regra WHERE sem reescrever o visual.
    if (filterField === directColumns.sourceColumn) {
      return { type: 'column', columnSql: `src.${quoteIdent(directColumns.targetColumn)}` };
    }
  }

  const path = findFilterPropagationPath(semanticModel, filterTable, target);
  if (!path || !Array.isArray(path.relationships) || !path.relationships.length) return null;

  // Para atributos de dimensao, usa EXISTS com JOINs pelo caminho de relacionamento.
  // Assim um clique em Cliente[Nome], Fornecedor[Nome] ou Calendario[AnoMes]
  // consegue filtrar uma tabela fato relacionada sem transformar texto em agregacao.
  const nodes = path.nodes || [];
  const rels = path.relationships || [];
  const aliases = nodes.map((_, idx) => 'xf' + idx);
  let sql = `EXISTS (SELECT 1 FROM ${quoteIdent(nodes[0])} AS ${aliases[0]}`;
  for (let i = 0; i < rels.length - 1; i += 1) {
    const cols = relationshipColumnForTarget(rels[i], nodes[i], nodes[i + 1]);
    if (!cols) return null;
    sql += ` JOIN ${quoteIdent(nodes[i + 1])} AS ${aliases[i + 1]} ON ${relationshipJoinCondition(aliases[i], nodes[i], cols.sourceColumn, aliases[i + 1], nodes[i + 1], cols.targetColumn)}`;
  }
  const lastIndex = rels.length - 1;
  const lastCols = relationshipColumnForTarget(rels[lastIndex], nodes[lastIndex], nodes[lastIndex + 1]);
  if (!lastCols) return null;
  const sourceAlias = aliases[lastIndex];
  sql += ` WHERE ${relationshipJoinCondition(sourceAlias, nodes[lastIndex], lastCols.sourceColumn, 'src', target, lastCols.targetColumn)} AND `;
  const filterExpr = `${aliases[0]}.${quoteIdent(filterField)}`;
  return { type: 'exists', prefixSql: sql, columnSql: filterExpr, suffixSql: ')' };
}

function resolveFilterExpression(filter, targetTable, semanticModel) {
  const condition = resolveFilterCondition(filter, targetTable, semanticModel);
  return condition && condition.type === 'column' ? condition.columnSql : null;
}

function wrapResolvedFilterPredicate(condition, predicateSql) {
  if (!condition || condition.type !== 'exists') return predicateSql;
  return condition.prefixSql + predicateSql + (condition.suffixSql || ')');
}

function onlineFilterAppliesToTarget(filter, options = {}) {
  const scope = String(filter.scope || 'global');
  if (scope === 'page') return Boolean(filter.pageId) && String(filter.pageId) === String(options.pageId || '');
  if (scope === 'visual') return Boolean(filter.visualId) && String(filter.visualId) === String(options.visualId || '');
  return true;
}

function onlineFilterRequiresSelectionForPage(filter, pageId) {
  const currentPageId = String(pageId || '').trim();
  if (!filter || String(filter.ui || 'dropdown') !== 'dropdown' || !currentPageId) return false;
  const explicit = Array.isArray(filter.requiredPageIds) ? filter.requiredPageIds.map(String).filter(Boolean) : [];
  if (explicit.length) return explicit.includes(currentPageId);
  return filter.allowAll === false;
}

function synchronizeCalendarFilterEntries(entries) {
  const source = Array.isArray(entries) ? entries : [];
  const navigation = source.find((entry) => {
    if (!entry || !entry.filter || entry.filter.multiSelect !== true || !sameTableName(entry.filter.table, CALENDAR_TABLE_NAME)) return false;
    return ['monthNumber', 'monthName', 'monthShortName', 'yearMonth', 'yearMonthName'].includes(calendarDefaultFilterRole(entry.filter));
  });
  if (!navigation) return source;
  const navigationRole = calendarDefaultFilterRole(navigation.filter);
  const conflicts = ['yearMonth', 'yearMonthName'].includes(navigationRole)
    ? new Set(['date', 'year', 'monthNumber', 'monthName', 'monthShortName', 'yearMonth', 'yearMonthName'])
    : new Set(['date', 'monthNumber', 'monthName', 'monthShortName', 'yearMonth', 'yearMonthName']);
  return source.filter((entry) => {
    if (entry === navigation || !entry || !entry.filter || !sameTableName(entry.filter.table, CALENDAR_TABLE_NAME)) return true;
    return !conflicts.has(calendarDefaultFilterRole(entry.filter));
  });
}

function buildReportFilterWhere(onlineFilters, submittedFilters, options = {}) {
  const normalized = normalizeOnlineFilters(onlineFilters);
  const targetTable = String(options.targetTable || '').trim();
  const semanticModel = options.semanticModel || defaultSemanticModel();
  const filterRemovedByDax = (filter) => Boolean(
    filter
    && !filter.mandatory
    && daxFilterContextRemoves(options.daxFilterContext, filter.table, filter.field)
  );
  const fieldAliasCounts = new Map();
  normalized.forEach((filter) => {
    if (!onlineFilterAppliesToTarget(filter, options)) return;
    const fieldKey = String(filter.field || '').trim();
    if (fieldKey) fieldAliasCounts.set(fieldKey, (fieldAliasCounts.get(fieldKey) || 0) + 1);
  });
  const clauses = [];
  const params = [];
  const unresolvedMandatory = [];
  const unresolvedOptional = [];
  const raw = withDefaultOnlineFilterValues(normalized, submittedFilters);
  const missingRequiredSelections = normalized.filter((filter) => {
    if (!onlineFilterAppliesToTarget(filter, options)) return false;
    const activePageId = String(options.activePageId || options.pageId || '');
    if (options.activePageId && options.pageId && String(options.activePageId) !== String(options.pageId)) return false;
    const requiredPages = Array.isArray(filter.requiredPageIds) ? filter.requiredPageIds.map(String).filter(Boolean) : [];
    const requiresSelection = requiredPages.length ? requiredPages.includes(activePageId) : (filter.allowAll === false && Boolean(activePageId));
    if (!requiresSelection) return false;
    const aliases = [filter.id, filter.key].filter(Boolean);
    if (fieldAliasCounts.get(filter.field) === 1) aliases.push(filter.field);
    return !aliases.some((key) => raw[key] !== '' && raw[key] !== null && raw[key] !== undefined);
  });
  if (missingRequiredSelections.length) {
    throw apiError('Selecione uma opção em ' + missingRequiredSelections.map((filter) => filter.label || filter.field).join(', ') + '.', 400);
  }
  // O frontend e relatorios antigos podem manter o mesmo valor por ID, chave
  // Tabela.Campo e alias curto. Esses aliases identificam UM unico filtro e
  // nao podem gerar predicados/EXISTS repetidos no plano SQL.
  const submittedEntries = [];
  const submittedFilterIds = new Set();
  for (const filter of normalized) {
    if (!onlineFilterAppliesToTarget(filter, options) || filterRemovedByDax(filter)) continue;
    const aliases = Array.from(new Set([filter.id, filter.key, fieldAliasCounts.get(filter.field) === 1 ? filter.field : ''].filter(Boolean)));
    const submittedKey = aliases.find((key) => raw[key] !== '' && raw[key] !== null && raw[key] !== undefined);
    if (!submittedKey) continue;
    const identity = String(filter.id || filter.key || filter.table + '.' + filter.field);
    if (submittedFilterIds.has(identity)) continue;
    submittedFilterIds.add(identity);
    submittedEntries.push({ submittedKey, value: raw[submittedKey], filter });
  }
  const executionEntries = synchronizeCalendarFilterEntries(submittedEntries);
  const calendarEntries = executionEntries.filter((entry) => sameTableName(entry.filter.table, CALENDAR_TABLE_NAME)).map((entry) => ({ table: CALENDAR_TABLE_NAME, field: entry.filter.field, value: entry.value }));
  const calendarRelationship = findRelationshipBetween(semanticModel, CALENDAR_TABLE_NAME, targetTable);
  const calendarColumns = relationshipColumnForTarget(calendarRelationship, CALENDAR_TABLE_NAME, targetTable);
  const calendarRange = calendarColumns ? calendarContextDateRange(calendarEntries) : null;
  if (calendarRange) {
    clauses.push(`src.${quoteIdent(calendarColumns.targetColumn)} >= ? AND src.${quoteIdent(calendarColumns.targetColumn)} < ?`);
    params.push(calendarRange.from, calendarRange.exclusiveTo);
  }
  for (const { submittedKey, value, filter } of executionEntries) {
    if (value === '' || value === null || value === undefined) continue;
    if (calendarRange && sameTableName(filter.table, CALENDAR_TABLE_NAME) && calendarRange.fields.has(filter.field)) continue;
    const condition = resolveFilterCondition(filter, targetTable, semanticModel);
    if (!condition) {
      if (filter.mandatory) unresolvedMandatory.push(filter.label || filter.key || filter.field);
      else unresolvedOptional.push(filter.label || filter.key || filter.field);
      continue;
    }
    const columnSql = condition.columnSql;
    const op = filter.operator === 'LIKE' ? 'LIKE' : (['=', '>=', '<=', 'BETWEEN'].includes(filter.operator) ? filter.operator : '=');
    if (String(value).includes('||')) {
      const vals = String(value).split('||').filter((v) => v !== '');
      if (vals.length) {
        clauses.push(wrapResolvedFilterPredicate(condition, `${columnSql} IN (${vals.map(() => '?').join(', ')})`));
        params.push(...vals);
      }
      continue;
    }
    if (op === 'BETWEEN') {
      const parts = String(value).split('|');
      const from = parts[0] || '';
      const to = parts[1] || '';
      if (from !== '' && to !== '') {
        clauses.push(wrapResolvedFilterPredicate(condition, `${columnSql} BETWEEN ? AND ?`));
        params.push(from, to);
      } else if (from !== '') {
        clauses.push(wrapResolvedFilterPredicate(condition, `${columnSql} >= ?`));
        params.push(from);
      } else if (to !== '') {
        clauses.push(wrapResolvedFilterPredicate(condition, `${columnSql} <= ?`));
        params.push(to);
      }
      continue;
    }
    const filterColumnSql = op === 'LIKE' ? `CAST(${columnSql} AS CHAR)` : columnSql;
    clauses.push(wrapResolvedFilterPredicate(condition, `${filterColumnSql} ${op} ?`));
    params.push(op === 'LIKE' ? `%${String(value)}%` : value);
  }
  if (unresolvedMandatory.length) {
    throw apiError('Restricao obrigatoria de acesso nao pode ser aplicada a esta tabela: ' + unresolvedMandatory.join(', ') + '. Verifique os relacionamentos ativos no Modelo.', 403);
  }
  const warnings = unresolvedOptional.length
    ? ['Filtro sem relacionamento ativo com a tabela "' + targetTable + '": ' + unresolvedOptional.join(', ') + '.']
    : [];
  return { whereSql: clauses.length ? clauses.join(' AND ') : '', params, warnings };
}

function injectWhereIntoSelectSql(sql, whereSql) {
  const clause = String(whereSql || '').trim();
  if (!clause) return sql;
  const source = String(sql || '').replace(/;\s*$/g, '').trim();
  // Consultas SUMX(VALUES(...)) possuem uma agregacao externa. Os filtros de
  // relatorio precisam entrar na fonte interna, onde o alias `src` existe.
  // Os marcadores preservam esse alvo mesmo quando ha mais de uma subconsulta.
  if (/\/\*__BIWA_RUNTIME_FILTER_(?:WHERE|AND)__\*\//.test(source)) {
    return source
      .replace(/\/\*__BIWA_RUNTIME_FILTER_WHERE__\*\//g, ' WHERE ' + clause)
      .replace(/\/\*__BIWA_RUNTIME_FILTER_AND__\*\//g, ' AND ' + clause);
  }
  const topLevelClauses = [];
  let depth = 0;
  let quote = '';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === '\\' && quote !== '`') {
        index += 1;
        continue;
      }
      if (char === quote) {
        if (source[index + 1] === quote) {
          index += 1;
          continue;
        }
        quote = '';
      }
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') {
      depth += 1;
      continue;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0 || (index > 0 && !/\s/.test(source[index - 1]))) continue;
    const match = /^(WHERE\b|GROUP\s+BY\b|ORDER\s+BY\b|LIMIT\b)/i.exec(source.slice(index));
    if (match) {
      topLevelClauses.push({ index, name: match[1].toUpperCase().replace(/\s+/g, ' ') });
      index += match[0].length - 1;
    }
  }
  const trailingClause = topLevelClauses.find((item) => item.name === 'GROUP BY' || item.name === 'ORDER BY' || item.name === 'LIMIT');
  const insertAt = trailingClause ? trailingClause.index : source.length;
  const head = source.slice(0, insertAt);
  const tail = source.slice(insertAt);
  const hasTopLevelWhere = topLevelClauses.some((item) => item.name === 'WHERE' && item.index < insertAt);
  const connector = hasTopLevelWhere ? ' AND ' : ' WHERE ';
  return head.trimEnd() + connector + clause + (tail ? ' ' + tail.trimStart() : '');
}

async function ensureCalendarForSql(sql) {
  // Calendario e uma tabela nativa/virtual do BI WA.
  // Nao tente criar tabela fisica no MySQL aqui, pois o usuario pode ser somente leitura.
  return null;
}


// v3.2.88 - execução de visuais pelo PostgreSQL cache quando possível
function mysqlBacktickSqlToPostgres(sql) {
  return String(sql || '').replace(/`([^`]+)`/g, (_, name) => quotePgIdent(name));
}

function mysqlFunctionsToPostgres(sql) {
  let result = String(sql || '');
  // MySQL ordena NULL depois dos valores em DESC; PostgreSQL faz o inverso.
  // Preservar a ordem evita que LIMIT devolva somente linhas vazias em medidas
  // como Frete e Frete Rateado 2.
  result = result.replace(/\bDESC\b(?!\s+NULLS\s+(?:FIRST|LAST))/gi, 'DESC NULLS LAST');
  // Colunas do Calendario no PG cache sao INTEGER, nao DATE.
  // Remove EXTRACT desnecessario: EXTRACT(YEAR FROM alias."Ano") -> alias."Ano"
  result = result.replace(/EXTRACT\s*\(\s*YEAR\s+FROM\s+(\w+\."(?:Ano|AnoMes)")\s*\)/gi, '$1');
  result = result.replace(/EXTRACT\s*\(\s*MONTH\s+FROM\s+(\w+\."(?:MesNumero|Mes)")\s*\)/gi, '$1');
  result = result.replace(/EXTRACT\s*\(\s*DAY\s+FROM\s+(\w+\."Dia")\s*\)/gi, '$1');
  // Versao sem alias (coluna direta da tabela principal)
  result = result.replace(/EXTRACT\s*\(\s*YEAR\s+FROM\s+"(Ano|AnoMes)"\s*\)/gi, '"$1"');
  result = result.replace(/EXTRACT\s*\(\s*MONTH\s+FROM\s+"(MesNumero|Mes)"\s*\)/gi, '"$1"');
  result = result.replace(/EXTRACT\s*\(\s*DAY\s+FROM\s+"(Dia)"\s*\)/gi, '"$1"');
  // Converte CAST(CAST(col AS CHAR) AS DATE) - usado para
  // colunas inteiras no formato YYYYMMDD (ex: DataKey do Calendario)
  // MySQL: CAST(CAST(20260629 AS CHAR) AS DATE) -> '2026-06-29'
  // PG: REGEXP_REPLACE converte YYYYMMDD -> YYYY-MM-DD antes do CAST
  //     para que funcione com inteiros YYYYMMDD e strings ISO ('2026-06-29')
  result = result.replace(/\bCAST\s*\(\s*CAST\s*\(([^()]+?)\s+AS\s+CHAR\s*\)\s+AS\s+DATE\s*\)/gi, function(_match, expr) {
    return "CAST(REGEXP_REPLACE(CAST(" + expr + " AS TEXT), '^(\\d{4})(\\d{2})(\\d{2})$', '\\1-\\2-\\3') AS DATE)";
  });
  // Converte tipos MySQL em CAST para tipos PostgreSQL
  result = result.replace(/\bCAST\s*\(\s*(.+?)\s+AS\s+DATETIME\s*\)/gi, 'CAST($1 AS TIMESTAMP)');
  result = result.replace(/\bCAST\s*\(\s*(.+?)\s+AS\s+SIGNED\s*\)/gi, 'CAST($1 AS INTEGER)');
  result = result.replace(/\bCAST\s*\(\s*(.+?)\s+AS\s+UNSIGNED\s*\)/gi, 'CAST($1 AS INTEGER)');
  result = result.replace(/\bCAST\s*\(\s*(.+?)\s+AS\s+CHAR\s*\)/gi, 'CAST($1 AS TEXT)');
  result = result.replace(/\bCAST\s*\(\s*(.+?)\s+AS\s+TINYINT\s*\(1\)\s*\)/gi, 'CAST($1 AS BOOLEAN)');
  result = result.replace(/\bCAST\s*\(\s*(.+?)\s+AS\s+VARBINARY\s*\(255\)\s*\)/gi, 'CAST($1 AS BYTEA)');
  // DECIMAL(...) e NUMERIC(...) funcionam igual em ambos
  result = result.replace(/\bCAST\s*\(\s*(.+?)\s+AS\s+DECIMAL\s*(\([\d,\s]+\))?\s*\)/gi, 'CAST($1 AS NUMERIC$2)');
  // Funcoes de data MySQL -> PostgreSQL (para colunas que sao realmente DATE/TIMESTAMP)
  result = result.replace(/\bYEAR\s*\(\s*([^)]+)\s*\)/gi, 'EXTRACT(YEAR FROM $1)');
  result = result.replace(/\bMONTH\s*\(\s*([^)]+)\s*\)/gi, 'EXTRACT(MONTH FROM $1)');
  result = result.replace(/\bDAYOFMONTH\s*\(\s*([^)]+)\s*\)/gi, 'EXTRACT(DAY FROM $1)');
  result = result.replace(/\bDAYOFWEEK\s*\(\s*([^)]+)\s*\)/gi, 'EXTRACT(DOW FROM $1)+1');
  result = result.replace(/\bDAYOFYEAR\s*\(\s*([^)]+)\s*\)/gi, 'EXTRACT(DOY FROM $1)');
  result = result.replace(/\bQUARTER\s*\(\s*([^)]+)\s*\)/gi, 'EXTRACT(QUARTER FROM $1)');
  result = result.replace(/\bWEEK\s*\(\s*([^,]+)\s*,\s*3\s*\)/gi, 'EXTRACT(WEEK FROM $1)');
  result = result.replace(/\bLAST_DAY\s*\(\s*([^)]+)\s*\)/gi, '(DATE_TRUNC(\'month\', $1) + INTERVAL \'1 month\' - INTERVAL \'1 day\')::date');
  result = result.replace(/\bDATE_FORMAT\s*\(\s*([^,]+)\s*,\s*'%Y%m%d'\s*\)/gi, 'TO_CHAR($1, \'YYYYMMDD\')');
  result = result.replace(/\bDATE_FORMAT\s*\(\s*([^,]+)\s*,\s*'%Y-%m'\s*\)/gi, 'TO_CHAR($1, \'YYYY-MM\')');
  result = result.replace(/\bCONCAT\s*\(/gi, 'CONCAT(');
  return result;
}

function sqlLooksLikeDirectTableSelect(sql, table) {
  const t = String(table || '').trim();
  if (!t) return false;
  const source = String(sql || '');
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fromRe = new RegExp('\\bFROM\\s+`?' + escaped + '`?\\s+(?:AS\\s+)?src\\b', 'i');
  if (!fromRe.test(source)) return false;
  // Evita converter SQL manual mais complexo. A conversão é intencionalmente conservadora.
  if (/\bUNION\b|\bWITH\b|;\s*\S/i.test(source)) return false;
  return true;
}

function mysqlQuestionPlaceholdersToPostgres(sql) {
  let index = 0;
  return String(sql || '').replace(/\?/g, () => '$' + (++index));
}

async function resolveSqlTableToPgCache(sql) {
  const refs = new Map();
  const re = /(?:FROM|JOIN)\s+(?:`((?:``|[^`])+)`|"((?:""|[^"])+)"|([A-Za-z_][\w.]*))(?:\s+(?:AS\s+)?(\w+))?/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const name = m[1]
      ? m[1].replace(/``/g, '`')
      : (m[2] ? m[2].replace(/""/g, '"') : (m[3] || ''));
    if (!name || refs.has(name)) continue;
    console.log('[PG] resolve trying name=' + name);
    let cacheMeta;
    try {
      cacheMeta = await getPgEffectiveMeta(name);
      console.log('[PG] resolve getPgCacheMeta(' + name + ') =', cacheMeta ? cacheMeta.cache_table : 'null');
    } catch(e) { console.log('[PG] resolve error', name, e.message); }
    if (!cacheMeta) {
      try {
        const imported = await findImportedTableByName(name);
        console.log('[PG] resolve findImportedTableByName(' + name + ') =', imported ? imported.sourceTable : 'null');
        if (imported && imported.sourceTable) {
          try {
            cacheMeta = await getPgEffectiveMeta(imported.sourceTable);
            console.log('[PG] resolve sourceTable getPgCacheMeta(' + imported.sourceTable + ') =', cacheMeta ? cacheMeta.cache_table : 'null');
          } catch(e) { console.log('[PG] resolve sourceTable error', e.message); }
        }
      } catch (e) { /* ignore */ }
    }
    if (cacheMeta && cacheMeta.cache_table) {
      console.log('[PG] resolve adding', name, '->', cacheMeta.cache_table);
      refs.set(name, cacheMeta);
    } else {
      console.log('[PG] resolve NOT adding', name);
    }
  }
  return refs;
}

async function tryRunSelectFromPostgresCache(sql, limit, options = {}) {
  if (options.noCache) { console.log('[PG] noCache'); return null; }
  if (!postgresCacheAvailable()) { console.log('[PG] not available'); return null; }
  if (/\bWITH\b/i.test(sql)) { console.log('[PG] WITH'); return null; }
  if (/\bUNION\b/i.test(sql) && !/\bJOIN\s*\(/i.test(sql)) { console.log('[PG] UNION'); return null; }
  const builtFilters = options.builtFilters || { whereSql: '', params: [] };
  const rowOffset = Math.max(0, Math.floor(Number(options.offset) || 0));
  console.log('[PG] entering, sql=' + sql.substring(0, 100));
  // Extract all tables from SQL and look up each in the PostgreSQL cache
  let cacheRefs;
  try { cacheRefs = await resolveSqlTableToPgCache(sql); } catch (e) { console.log('[PG] catch:', e.message); return null; }
  console.log('[PG] refs size=' + cacheRefs.size);
  if (!cacheRefs.size) { console.log('[PG] no refs'); return null; }
  // Single-table query: rewrite FROM clause
  if (cacheRefs.size === 1) {
    const entry = cacheRefs.entries().next().value;
    const sqlTableName = entry[0];
    const meta = entry[1];
    const cacheSource = quotePgQualified(POSTGRES_CACHE_SCHEMA, meta.cache_table) + ' src';
    const escapedName = sqlTableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Uma consulta pode conter a mesma fonte em mais de uma subconsulta
    // (por exemplo SUMX(VALUES(...)) ao lado de outra medida). Reescreva todas
    // as ocorrencias para o cache PostgreSQL, nao apenas a primeira.
    const tablePattern = new RegExp('\\bFROM\\s+(?:`' + escapedName + '`|"' + escapedName + '"|' + escapedName + ')\\s+(?:AS\\s+)?src\\b', 'gi');
    if (!tablePattern.test(sql)) { return null; }
    // Rewrite SELECT column list to match cache table columns
    const cacheCols = meta.columns && meta.columns.length ? meta.columns.map((c) => c.name || c) : null;
    if (!cacheCols || !cacheCols.length) return null;
    const convertedInner = mysqlBacktickSqlToPostgres(String(sql).replace(tablePattern, 'FROM ' + cacheSource));
    const pgInner = mysqlQuestionPlaceholdersToPostgres(mysqlFunctionsToPostgres(convertedInner.replace(/;\s*$/g, '')));
    const params = Array.isArray(builtFilters.params) ? builtFilters.params : [];
    const finalSql = 'SELECT * FROM (' + pgInner + ') AS bi_query LIMIT $' + (params.length + 1) + (rowOffset ? ' OFFSET $' + (params.length + 2) : '');
    let result;
    try {
      result = await cachedPgAnalyticsQuery(finalSql, [...params, clampLimit(limit, 200), ...(rowOffset ? [rowOffset] : [])], {
        noCache: Boolean(options.noResultCache),
        cacheScope: String(options.cacheScope || '')
      });
    } catch(e) {
      // Uma falha de SQL nao significa cache vazio. Propagar o erro evita que o
      // construtor esconda medidas invalidas sob a mensagem "sem linhas".
      throw e;
    }
    return {
      rows: serializeRows(result.rows || []),
      fields: (result.fields || []).map((field) => ({ name: field.name })),
      cached: true,
      cacheEngine: result.cached ? 'postgres-memory' : 'postgres',
      cacheAgeMs: Number(result.cacheAgeMs || 0),
      cacheStatus: publicPgCacheStatusFromMeta(meta)
    };
  }
  // Multi-table (JOINs): rewrite all table references to cache tables
  let converted = String(sql);
  for (const [sqlTableName, meta] of cacheRefs) {
    const cacheTable = quotePgQualified(POSTGRES_CACHE_SCHEMA, meta.cache_table);
    const escapedName = sqlTableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tableRefPattern = new RegExp('(\\b(?:FROM|JOIN)\\s+)(?:`' + escapedName + '`|"' + escapedName + '"|' + escapedName + ')(\\s+(?:AS\\s+)?\\w+)?', 'gi');
    converted = converted.replace(tableRefPattern, function(_match, prefix, aliasPart) {
      return prefix + cacheTable + (aliasPart || '');
    });
  }
  converted = mysqlBacktickSqlToPostgres(converted);
  converted = mysqlFunctionsToPostgres(converted);
  const pgInner = mysqlQuestionPlaceholdersToPostgres(converted.replace(/;\s*$/g, ''));
  const params = Array.isArray(builtFilters.params) ? builtFilters.params : [];
  const finalSql = 'SELECT * FROM (' + pgInner + ') AS bi_query LIMIT $' + (params.length + 1) + (rowOffset ? ' OFFSET $' + (params.length + 2) : '');
  const result = await cachedPgAnalyticsQuery(finalSql, [...params, clampLimit(limit, 200), ...(rowOffset ? [rowOffset] : [])], {
    noCache: Boolean(options.noResultCache),
    cacheScope: String(options.cacheScope || '')
  });
  return {
    rows: serializeRows(result.rows || []),
    fields: (result.fields || []).map((field) => ({ name: field.name })),
    cached: true,
    cacheEngine: result.cached ? 'postgres-memory' : 'postgres',
    cacheAgeMs: Number(result.cacheAgeMs || 0),
    cacheStatus: publicPgCacheStatusFromMeta(cacheRefs.values().next().value)
  };
}

function findImportedTableByNameSync(table) {
  try {
    const importedPath = path.join(DATA_DIR, 'imported_tables.json');
    if (!fsSync.existsSync(importedPath)) return null;
    const imported = JSON.parse(fsSync.readFileSync(importedPath, 'utf-8'));
    const requested = String(table || '').toLowerCase();
    return (imported || []).find((item) => (item.name || '').toLowerCase() === requested)
      || (imported || []).find((item) => (item.sourceTable || '').toLowerCase() === requested);
  } catch (e) { return null; }
}

async function runSelect(sql, limit, options = {}) {
  const safeSql = assertReadOnlySqlPreservingRuntimeFilterMarkers(sql);
  const runtimeFilterTargetCount = Math.max(1, (safeSql.match(/\/\*__BIWA_RUNTIME_FILTER_(?:WHERE|AND)__\*\//g) || []).length);
  await ensureCalendarForSql(safeSql);
  const safeLimit = clampLimit(limit, 200);
  const semanticModel = options.semanticModel || await readSemanticModel();
  const builtFilters = buildReportFilterWhere(options.onlineFilters || [], options.filters || {}, {
    targetTable: options.targetTable || options.table || '',
    semanticModel,
    pageId: options.pageId || '',
    visualId: options.visualId || '',
    activePageId: options.activePageId || '',
    daxFilterContext: options.daxFilterContext || null
  });
  // Injeta rowFilter e dateFilter da tabela importada diretamente na clausula WHERE
  let extraWhere = '';
  const targetTable = options.targetTable || options.table || '';
  // No PostgreSQL, rowFilter/dateFilter ja fazem parte da view logica efetiva.
  // A injecao direta permanece apenas no fallback MySQL legado.
  if (targetTable && !postgresCacheAvailable()) {
    try {
      const imported = await findImportedTableByName(targetTable);
      if (imported) {
        if (imported.rowFilter && imported.rowFilter.column && Array.isArray(imported.rowFilter.values) && imported.rowFilter.values.length) {
          const col = quoteIdent(imported.rowFilter.column);
          const vals = imported.rowFilter.values.map(v => "'" + String(v).replace(/'/g, "''") + "'").join(',');
          extraWhere += (extraWhere ? ' AND ' : '') + `(${col} IN (${vals}))`;
        }
        if (imported.dateFilter && imported.dateFilter.column) {
          const col = quoteIdent(imported.dateFilter.column);
          if (imported.dateFilter.start) extraWhere += (extraWhere ? ' AND ' : '') + `(${col} >= '${String(imported.dateFilter.start).replace(/'/g, "''")}')`;
          if (imported.dateFilter.end) extraWhere += (extraWhere ? ' AND ' : '') + `(${col} <= '${String(imported.dateFilter.end).replace(/'/g, "''")}')`;
        }
      }
    } catch (e) { /* ignora */ }
  }

  if (extraWhere) {
    builtFilters.whereSql = builtFilters.whereSql ? `(${builtFilters.whereSql}) AND (${extraWhere})` : extraWhere;
  }

  if (runtimeFilterTargetCount > 1 && Array.isArray(builtFilters.params) && builtFilters.params.length) {
    const sourceFilterParams = builtFilters.params.slice();
    builtFilters.params = [];
    for (let index = 0; index < runtimeFilterTargetCount; index += 1) {
      builtFilters.params.push.apply(builtFilters.params, sourceFilterParams);
    }
  }

  debugLog('[REPORT] builtFilters whereSql=' + builtFilters.whereSql + ' params=' + JSON.stringify(builtFilters.params) + ' targetTable=' + targetTable + ' submittedFilters=' + JSON.stringify(options.filters || {}));
  const filteredSql = injectWhereIntoSelectSql(safeSql, builtFilters.whereSql);
  visualFieldDebug('SQL PARAMETERS', {
    visualId: String(options.visualId || ''),
    runtimeTargetCount: runtimeFilterTargetCount,
    placeholderCount: (String(filteredSql || '').match(/\?/g) || []).length,
    paramCount: Array.isArray(builtFilters.params) ? builtFilters.params.length : 0,
    params: Array.isArray(builtFilters.params) ? builtFilters.params : []
  });
  debugLog('[REPORT] filteredSql(200)=' + filteredSql.substring(0, 200));
  
  let pgExecutionError = null;
  const pgCachedResult = await tryRunSelectFromPostgresCache(filteredSql, safeLimit, {
    ...options,
    targetTable,
    builtFilters
  }).catch((err) => {
    debugLog('[REPORT] PostgreSQL execution failed: ' + (err && err.message ? err.message : String(err)));
    visualFieldDebug('QUERY EXECUTION ERROR', {
      visualId: String(options.visualId || ''),
      message: err && err.message ? err.message : String(err),
      sql: filteredSql
    });
    pgExecutionError = err;
    return null;
  });
  debugLog('[REPORT] pgCachedResult=' + (pgCachedResult ? 'rows=' + pgCachedResult.rows.length : 'null'));
  if (pgCachedResult) {
    pgCachedResult.filterWarnings = Array.isArray(builtFilters.warnings) ? builtFilters.warnings : [];
    return pgCachedResult;
  }
  if (pgExecutionError) throw pgExecutionError;
  // Fallback: PG cache tem dados mas query com colunas especificas falhou
  // (ex.: encoding de caracteres acentuados). Tenta SELECT * como ultimo recurso.
  if (targetTable && postgresCacheAvailable() && !options.noCache && !builtFilters.whereSql && !(Array.isArray(builtFilters.params) && builtFilters.params.length)) {
    try {
      const resolvedFallback = await resolvePgCacheLookup(targetTable);
      const fbMeta = await getPgCacheMeta(resolvedFallback.table || targetTable);
      if (fbMeta && fbMeta.cache_table) {
        const fbRef = quotePgQualified(POSTGRES_CACHE_SCHEMA, fbMeta.cache_table);
        const fbResult = await pgCacheQuery(`SELECT * FROM ${fbRef} LIMIT $1`, [safeLimit]);
        if (fbResult && Array.isArray(fbResult.rows) && fbResult.rows.length > 0) {
          var fbRows = applyChangeTypeToRows(serializeRows(fbResult.rows), targetTable);
          return {
            rows: fbRows,
            fields: (fbResult.fields || []).map(function(f) { return { name: f.name }; }),
            cached: true,
            cacheEngine: 'postgres-fallback',
            cacheAgeMs: 0,
            filterWarnings: Array.isArray(builtFilters.warnings) ? builtFilters.warnings : []
          };
        }
      }
    } catch (e) { /* fallback falhou */ }
  }
  // Dados nao encontrados no cache PostgreSQL. Retorna vazio.
  return { rows: [], fields: [], cached: false, cacheEngine: 'none', cacheAgeMs: 0, filterWarnings: Array.isArray(builtFilters.warnings) ? builtFilters.warnings : [] };
}


function pad2(value) {
  return String(value).padStart(2, '0');
}

function isoDateOnly(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function lastDayOfMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function isoWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function calendarRow(date) {
  const meses = ['Janeiro', 'Fevereiro', 'Mar\u00E7o', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  const mesesCurto = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  const dias = ['Domingo', 'Segunda-feira', 'Ter\u00E7a-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'S\u00E1bado'];
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const dow = date.getDay();
  const quarter = Math.floor((m - 1) / 3) + 1;
  const start = new Date(date.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((date - start) / 86400000);
  const fimMesDia = lastDayOfMonth(y, date.getMonth());
  const inicioMes = `${y}-${pad2(m)}-01`;
  const fimMes = `${y}-${pad2(m)}-${pad2(fimMesDia)}`;
  return [
    isoDateOnly(date),
    Number(`${y}${pad2(m)}${pad2(d)}`),
    y,
    m,
    meses[m - 1],
    mesesCurto[m - 1],
    `${y}-${pad2(m)}`,
    `${mesesCurto[m - 1]}/${y}`,
    d,
    dow + 1,
    dias[dow],
    dayOfYear,
    isoWeekNumber(date),
    quarter,
    `${quarter}\u00BA Trimestre`,
    m <= 6 ? 1 : 2,
    inicioMes,
    fimMes,
    fimMesDia,
    dow === 0 || dow === 6 ? 1 : 0,
    dow === 0 || dow === 6 ? 0 : 1
  ];
}

function calendarCreateSql() {
  return `CREATE TABLE IF NOT EXISTS ${quoteIdent(CALENDAR_TABLE_NAME)} (
    ${quoteIdent('Data')} DATE NOT NULL,
    ${quoteIdent('DataKey')} INT NOT NULL,
    ${quoteIdent('Ano')} INT NOT NULL,
    ${quoteIdent('MesNumero')} INT NOT NULL,
    ${quoteIdent('MesNome')} VARCHAR(20) NOT NULL,
    ${quoteIdent('MesNomeCurto')} VARCHAR(10) NOT NULL,
    ${quoteIdent('AnoMes')} VARCHAR(7) NOT NULL,
    ${quoteIdent('AnoMesNome')} VARCHAR(20) NOT NULL,
    ${quoteIdent('Dia')} INT NOT NULL,
    ${quoteIdent('DiaSemanaNumero')} INT NOT NULL,
    ${quoteIdent('DiaSemanaNome')} VARCHAR(20) NOT NULL,
    ${quoteIdent('DiaDoAno')} INT NOT NULL,
    ${quoteIdent('SemanaAno')} INT NOT NULL,
    ${quoteIdent('Trimestre')} INT NOT NULL,
    ${quoteIdent('TrimestreNome')} VARCHAR(20) NOT NULL,
    ${quoteIdent('Semestre')} INT NOT NULL,
    ${quoteIdent('InicioMes')} DATE NOT NULL,
    ${quoteIdent('FimMes')} DATE NOT NULL,
    ${quoteIdent('UltimoDiaMes')} INT NOT NULL,
    ${quoteIdent('EhFimSemana')} TINYINT(1) NOT NULL,
    ${quoteIdent('DiaUtil')} TINYINT(1) NOT NULL,
    PRIMARY KEY (${quoteIdent('Data')}),
    KEY ${quoteIdent('idx_calendario_datakey')} (${quoteIdent('DataKey')}),
    KEY ${quoteIdent('idx_calendario_anomes')} (${quoteIdent('AnoMes')})
  )`;
}

function calendarColumnNames() {
  return calendarColumnMetadata().map((col) => col.name);
}

function calendarVirtualRows(options = {}) {
  const startYear = Math.max(1900, Math.min(2200, Number(options.startYear || new Date().getFullYear() - 5)));
  const endYear = Math.max(startYear, Math.min(2200, Number(options.endYear || new Date().getFullYear() + 5)));
  const cols = calendarColumnNames();
  const rows = [];
  for (let date = new Date(startYear, 0, 1); date <= new Date(endYear, 11, 31); date.setDate(date.getDate() + 1)) {
    const values = calendarRow(date);
    const row = {};
    for (let i = 0; i < cols.length; i += 1) row[cols[i]] = values[i];
    rows.push(row);
  }
  return { table: CALENDAR_TABLE_NAME, startYear, endYear, rows };
}

function calendarDerivedSql(columns = []) {
  const allowed = new Set(calendarColumnNames());
  const cols = (Array.isArray(columns) ? columns : [])
    .map((c) => String(c || '').trim())
    .filter((c, idx, arr) => c && allowed.has(c) && arr.indexOf(c) === idx);
  const selected = cols.length ? cols : ['Data', 'DataKey', 'Ano', 'MesNumero', 'MesNome', 'Dia'];
  const virtual = calendarVirtualRows({});
  if (!virtual.rows.length) {
    return `(SELECT ${selected.map((col) => `NULL AS ${quoteIdent(col)}`).join(', ')}) AS src`;
  }
  const selectRows = virtual.rows.map((row) => {
    const parts = selected.map((col) => `${sqlLiteral(row[col])} AS ${quoteIdent(col)}`);
    return `SELECT ${parts.join(', ')}`;
  });
  return `(\n${selectRows.join('\nUNION ALL\n')}\n) AS src`;
}

async function ensureCalendarTable(options = {}) {
  const virtual = calendarVirtualRows(options);
  return {
    ok: true,
    virtual: true,
    table: CALENDAR_TABLE_NAME,
    startYear: virtual.startYear,
    endYear: virtual.endYear,
    rows: virtual.rows.length,
    message: 'Calendário nativo disponível em modo virtual. Nenhuma tabela física foi criada no MySQL.'
  };
}

function distinctCalendarValues(field, limit = 5000) {
  const columns = new Set(calendarColumnNames());
  if (!columns.has(field)) throw apiError('Campo nao encontrado para filtro: Calendario[' + field + ']', 400);
  const virtual = calendarVirtualRows({});
  const seen = new Set();
  const values = [];
  for (const row of virtual.rows) {
    const value = row[field];
    if (value === null || value === undefined || value === '') continue;
    const key = String(value);
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(value);
  }
  values.sort((a, b) => String(a).localeCompare(String(b), 'pt-BR', { numeric: true }));
  return Number.isFinite(Number(limit)) && Number(limit) > 0 ? values.slice(0, Math.floor(Number(limit))) : values;
}

const COLUMN_TYPES = {
  int: 'INT', inteiro: 'INT', integer: 'INT',
  decimal: 'DECIMAL(12,2)', numeric: 'DECIMAL(12,2)', dec: 'DECIMAL(12,2)', double: 'DECIMAL(12,2)', float: 'DECIMAL(12,2)', real: 'DECIMAL(12,2)',
  varchar: 'VARCHAR(255)', texto: 'VARCHAR(255)', string: 'VARCHAR(255)', char: 'VARCHAR(255)',
  text: 'TEXT',
  date: 'DATE', data: 'DATE',
  datetime: 'DATETIME', timestamp: 'DATETIME',
  time: 'TIME', hora: 'TIME',
  boolean: 'TINYINT(1)', bool: 'TINYINT(1)',
  binary: 'VARBINARY(255)', binario: 'VARBINARY(255)', blob: 'VARBINARY(255)'
};

function normalizeColumnType(type) {
  const key = String(type || '').toLowerCase();
  if (!COLUMN_TYPES[key]) throw apiError('Tipo de coluna nao permitido: ' + type, 400);
  return COLUMN_TYPES[key];
}

function buildColumnSql(input, options = {}) {
  const name = String(input.name || '').trim();
  if (!name) throw apiError('Nome da coluna e obrigatorio.', 400);
  const sqlName = quoteIdent(name);
  let typeSql = normalizeColumnType(input.type || 'texto');
  const primaryKey = Boolean(input.primaryKey);
  const autoIncrement = Boolean(input.autoIncrement);
  const nullable = Boolean(input.nullable);

  if (autoIncrement) {
    if (!primaryKey) {
      throw apiError('AUTO_INCREMENT precisa estar marcado tambem como chave primaria (PK).', 400);
    }
    if (!['int', 'inteiro'].includes(String(input.type || '').toLowerCase())) {
      throw apiError('AUTO_INCREMENT so pode ser usado com INT.', 400);
    }
    typeSql = normalizeColumnType(input.type || 'inteiro');
  }

  let sql = `${sqlName} ${typeSql}`;
  if (autoIncrement || primaryKey || !nullable) sql += ' NOT NULL';
  else sql += ' NULL';
  if (autoIncrement) sql += ' AUTO_INCREMENT';

  if (options.allowDefault && input.defaultValue !== undefined && input.defaultValue !== null && String(input.defaultValue) !== '') {
    sql += ' DEFAULT ?';
  }

  return { sql, name, primaryKey, autoIncrement, defaultValue: input.defaultValue };
}

function mapColumnTypeToPostgres(type) {
  var t = String(type || '').toLowerCase();
  if (/int|inteiro|auto_increment/i.test(t)) return 'INTEGER';
  if (/decimal|double|float|real|numeric|moeda|number/i.test(t)) return 'NUMERIC(18,2)';
  if (/date|data/i.test(t)) return 'DATE';
  if (/datetime|timestamp|data_hora/i.test(t)) return 'TIMESTAMP';
  if (/bool|booleano|logico/i.test(t)) return 'BOOLEAN';
  return 'TEXT';
}

function normalizeManualTableSyncSnapshots(input) {
  if (!Array.isArray(input)) throw apiError('Lista de tabelas manuais invalida.', 400);
  if (input.length > 50) throw apiError('A publicacao aceita no maximo 50 tabelas manuais.', 400);
  let totalRows = 0;
  const seenTables = new Set();
  return input.map(function(table) {
    const name = String(table && table.name || '').trim();
    if (!name || name.length > 63 || name === CALENDAR_TABLE_NAME) throw apiError('Nome de tabela manual invalido na publicacao.', 400);
    const tableKey = name.toLowerCase();
    if (seenTables.has(tableKey)) throw apiError('Tabela manual duplicada na publicacao: ' + name, 400);
    seenTables.add(tableKey);

    const inputColumns = Array.isArray(table && table.columns) ? table.columns : [];
    if (!inputColumns.length || inputColumns.length > 200) throw apiError('Estrutura invalida para a tabela manual: ' + name, 400);
    const seenColumns = new Set();
    const columns = inputColumns.map(function(column) {
      const columnName = String(column && column.name || '').trim();
      const columnKey = columnName.toLowerCase();
      if (!columnName || columnName.length > 63 || seenColumns.has(columnKey)) {
        throw apiError('Coluna invalida ou duplicada na tabela manual "' + name + '".', 400);
      }
      seenColumns.add(columnKey);
      const extra = String(column.extra || '');
      return {
        name: columnName,
        columnType: String(column.columnType || column.dataType || column.type || 'texto'),
        primaryKey: Boolean(column.primaryKey) || String(column.columnKey || column.key || '').toUpperCase() === 'PRI',
        autoIncrement: Boolean(column.autoIncrement) || /auto_increment|serial/i.test(extra),
        allowNull: column.allowNull !== false,
        extra
      };
    });

    const inputRows = Array.isArray(table && table.rows) ? table.rows : [];
    if (inputRows.length > MANUAL_TABLE_SYNC_MAX_ROWS_PER_TABLE) {
      throw apiError('A tabela manual "' + name + '" excede o limite de ' + MANUAL_TABLE_SYNC_MAX_ROWS_PER_TABLE + ' linhas.', 413);
    }
    totalRows += inputRows.length;
    if (totalRows > MANUAL_TABLE_SYNC_MAX_TOTAL_ROWS) {
      throw apiError('A publicacao excede o limite total de ' + MANUAL_TABLE_SYNC_MAX_TOTAL_ROWS + ' linhas manuais.', 413);
    }
    const rows = inputRows.map(function(row) {
      return filterKnownColumns(row && typeof row === 'object' ? row : {}, columns);
    });
    return { name, columns, rows };
  });
}

async function syncManualTableSnapshots(input) {
  const tables = normalizeManualTableSyncSnapshots(input);
  const registeredNames = await readManualTables();
  const registeredKeys = new Set(registeredNames.map(function(name) { return String(name || '').toLowerCase(); }));

  await pgCacheTransaction(async function(client) {
    for (const table of tables) {
      const existingTable = await client.query(
        'SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND LOWER(table_name) = LOWER($2) LIMIT 1',
        [POSTGRES_CACHE_SCHEMA, table.name]
      );
      const existingMeta = await client.query(
        'SELECT sync_mode FROM ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, '__biwa_cache_meta') + ' WHERE LOWER(source_table) = LOWER($1) LIMIT 1',
        [table.name]
      );
      const existingIsManual = registeredKeys.has(table.name.toLowerCase()) ||
        String(existingMeta.rows[0] && existingMeta.rows[0].sync_mode || '').toLowerCase() === 'manual';
      if (existingTable.rows.length && !existingIsManual) {
        throw apiError('Nao foi possivel publicar a tabela manual "' + table.name + '": ja existe uma tabela online nao manual com esse nome.', 409);
      }

      const pgTableRef = quotePgQualified(POSTGRES_CACHE_SCHEMA, table.name);
      if (existingTable.rows.length) await client.query('DROP TABLE ' + pgTableRef);
      await client.query(
        'DELETE FROM ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, '__biwa_cache_meta') + ' WHERE LOWER(source_table) = LOWER($1)',
        [table.name]
      );

      const definitions = table.columns.map(function(column) {
        const pgType = column.autoIncrement ? 'SERIAL' : mapColumnTypeToPostgres(column.columnType);
        const nullable = column.autoIncrement || column.allowNull !== false ? '' : ' NOT NULL';
        return quotePgIdent(column.name) + ' ' + pgType + nullable;
      });
      const primaryKeys = table.columns.filter(function(column) { return column.primaryKey; }).map(function(column) { return quotePgIdent(column.name); });
      if (primaryKeys.length) definitions.push('PRIMARY KEY (' + primaryKeys.join(', ') + ')');
      await client.query('CREATE TABLE ' + pgTableRef + ' (\n  ' + definitions.join(',\n  ') + '\n)');
      await ensureManualTableInPgCache(table.name, table.columns, client);

      const pgRef = { pgTable: pgTableRef, meta: { cache_table: table.name, physical_table: table.name, source_table: table.name } };
      const inserted = await insertManualRowsWithClient(client, pgRef, table.columns, table.rows);
      await resetManualIdentitySequence(client, pgRef, table.columns);
      await refreshManualTableMetadata(table.name, inserted, client, pgRef);
    }
  });

  const mergedNames = registeredNames.slice();
  tables.forEach(function(table) {
    if (!mergedNames.some(function(name) { return String(name || '').toLowerCase() === table.name.toLowerCase(); })) mergedNames.push(table.name);
  });
  await writeManualTables(mergedNames);
  resourceListCache = { key: '', savedAt: 0, resources: [], diagnostics: [] };
  clearQueryCache('manual-tables-published');
  return tables.map(function(table) { return { name: table.name, rowCount: table.rows.length, columnCount: table.columns.length }; });
}

async function ensureManualTableInPgCache(sourceTable, columns, client) {
  if (!postgresCacheAvailable()) return;
  await ensurePgCacheSchema();
  var query = client ? client.query.bind(client) : pgCacheQuery;
  var cacheTable = String(sourceTable || '');
  var colsJson = JSON.stringify(columns.map(function(c) {
    var type = normalizeTransformDataType(c.type || c.dataType || c.columnType || 'texto');
    var primaryKey = Boolean(c.primaryKey) || String(c.key || c.columnKey || '').toUpperCase() === 'PRI';
    var autoIncrement = Boolean(c.autoIncrement) || /auto_increment/i.test(String(c.extra || ''));
    return {
      name: c.name,
      type: type,
      dataType: type,
      columnType: DISPLAY_TYPE_MAP_BY_NORMALIZED(type) || type.toUpperCase(),
      key: primaryKey ? 'PRI' : '',
      columnKey: primaryKey ? 'PRI' : '',
      primaryKey: primaryKey,
      autoIncrement: autoIncrement,
      nullable: c.allowNull === false || primaryKey || autoIncrement ? 'NO' : 'YES',
      extra: autoIncrement ? 'auto_increment' : (c.extra || '')
    };
  }));
  var primaryKeysJson = JSON.stringify(columns.filter(function(c) { return Boolean(c.primaryKey); }).map(function(c) { return String(c.name || ''); }).filter(Boolean));
  var exists = await query('SELECT 1 FROM ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, '__biwa_cache_meta') + ' WHERE LOWER(source_table) = LOWER($1)', [sourceTable]);
  if (exists.rows.length) {
    await query('UPDATE ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, '__biwa_cache_meta') + ' SET physical_table = $1, cache_table = $1, columns_json = $2, primary_keys = $3, row_count = $4, synced_at = NOW(), last_data_update_at = NOW(), sync_mode = $5 WHERE LOWER(source_table) = LOWER($1)', [sourceTable, colsJson, primaryKeysJson, 0, 'manual']);
  } else {
    await query('INSERT INTO ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, '__biwa_cache_meta') + ' (source_table, physical_table, cache_table, columns_json, primary_keys, row_count, synced_at, last_data_update_at, sync_mode) VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW(),$7)', [sourceTable, sourceTable, cacheTable, colsJson, primaryKeysJson, 0, 'manual']);
  }
}

function normalizeReportsForImport(rawReports) {
  if (!Array.isArray(rawReports)) throw apiError('Lista de relatorios invalida.', 400);
  const now = new Date().toISOString();
  return rawReports.slice(0, 500).map((item) => ({
    id: String(item.id || crypto.randomUUID()).slice(0, 80),
    name: String(item.name || 'Relatorio sem nome').slice(0, 120),
    sql: assertReadOnlySql(item.sql),
    visualization: VISUAL_TYPES.includes(item.visualization) ? item.visualization : 'table',
    visuals: normalizeReportVisuals(item.visuals),
    layout: item.layout && typeof item.layout === 'object' ? item.layout : { x: 32, y: 32, width: 560, height: 360 },
    onlineFilters: normalizeOnlineFilters(item.onlineFilters),
    pages: normalizeReportPages(item.pages),
    theme: normalizeReportTheme(item.theme),
    security: normalizeReportSecurity(item.security),
    refreshSeconds: clampLimit(item.refreshSeconds, DEFAULT_REFRESH_SECONDS, 3600),
    limit: clampLimit(item.limit, 200),
    createdAt: item.createdAt || now,
    updatedAt: now
  }));
}

function requireDesktopAdmin(req, res, next) {
  if (req.authRole !== 'admin') {
    throw apiError('Acesso de administrador necessario.', 403);
  }
  next();
}

function requirePermission(permission, label) {
  return (req, res, next) => {
    if (req.authRole !== 'admin') {
      throw apiError('Acesso de administrador necessario.', 403);
    }
    if (!effectivePermissions(req.authRole)[permission]) {
      throw apiError((label || 'Esta permissao') + ' esta desativada em Configuracao.', 403);
    }
    next();
  };
}

function readSyncTokenFromRequest(req) {
  const bearer = String(req.headers.authorization || '');
  if (bearer.toLowerCase().startsWith('bearer ')) return bearer.slice(7).trim();
  return String(req.headers['x-sync-token'] || req.query.token || '').trim();
}

function requireSyncToken(req, res, next) {
  const token = getSettings().publish.syncToken || process.env.SYNC_TOKEN || '';
  if (!token) throw apiError('SYNC_TOKEN nao configurado na versao online.', 403);
  const supplied = readSyncTokenFromRequest(req);
  if (!supplied || !safeEqual(supplied, token)) {
    throw apiError('Token de sincronizacao invalido.', 403);
  }
  next();
}

function dotenvValue(value) {
  const s = String(value ?? '');
  if (s === '') return '""';
  if (/^[A-Za-z0-9_./:@+\-^!@#$%&*()\[\]{}|;:',.<>?\/~`]+$/.test(s)) return s;
  return s;
}

function sanitizePassword(value) {
  const s = String(value ?? '');
  return s.replace(/^["']|["']$/g, '').trim();
}

function envLine(key, value) {
  return `${key}=${dotenvValue(value)}`;
}

function boolEnvString(value) {
  return ['true', '1', 'yes', 'sim', 's'].includes(String(value || '').toLowerCase()) ? 'true' : 'false';
}

function onlineAccessPayload(settings) {
  const access = settings.access || {};
  const permissions = settings.permissions || {};
  return {
    version: 2,
    users: effectiveOnlineUsers(settings),
    admin: {
      username: String(access.adminUser || '').trim(),
      name: String(access.adminName || 'Administrador').trim(),
      updatedAt: String(access.adminUpdatedAt || ''),
      password: String(access.adminPassword || '')
    },
    permissions: {
      tableWrites: Boolean(permissions.tableWrites),
      schemaChanges: Boolean(permissions.schemaChanges),
      reportEditing: Boolean(permissions.reportEditing),
      publishOnline: Boolean(permissions.publishOnline)
    }
  };
}

function applyPublishedOnlineAccess(settings, onlineAccess) {
  const input = onlineAccess && typeof onlineAccess === 'object' ? onlineAccess : {};
  let accessUpdated = false;
  let adminUpdated = false;
  let permissionsUpdated = false;
  if (Array.isArray(input.users)) {
    const currentUsers = normalizeOnlineUsers(settings.access.onlineUsers || []);
    const currentById = new Map(currentUsers.map((user) => [String(user.id || ''), user]));
    const currentByUsername = new Map(currentUsers.map((user) => [user.username.toLowerCase(), user]));
    const incomingUsers = normalizeOnlineUsers(input.users);
    const incomingIds = new Set(incomingUsers.map((user) => String(user.id || '').trim()).filter(Boolean));
    const incomingUsernames = new Set(incomingUsers.map((user) => user.username.toLowerCase()));
    const mergedIncoming = incomingUsers.map((incoming) => {
      const current = currentById.get(String(incoming.id || '')) || currentByUsername.get(incoming.username.toLowerCase());
      const currentUpdatedAt = Date.parse(current && current.profileUpdatedAt || '') || 0;
      const incomingUpdatedAt = Date.parse(incoming.profileUpdatedAt || '') || 0;
      if (!current || currentUpdatedAt <= incomingUpdatedAt) return incoming;
      return {
        ...incoming,
        username: current.username,
        name: current.name,
        password: current.password,
        profileUpdatedAt: current.profileUpdatedAt,
        allReports: current.allReports,
        reportPermissions: current.reportPermissions,
        dataFilters: current.dataFilters
      };
    });
    // Publicar pelo Desktop nao pode apagar usuarios criados diretamente no
    // portal. Itens ausentes no payload sao preservados; para removê-los, use
    // a tela Usuarios do proprio portal, que grava o estado autoritativo.
    const portalOnlyUsers = currentUsers.filter((current) => {
      const id = String(current.id || '').trim();
      return (!id || !incomingIds.has(id)) && !incomingUsernames.has(current.username.toLowerCase());
    });
    settings.access.onlineUsers = normalizeOnlineUsers(mergedIncoming.concat(portalOnlyUsers));
    accessUpdated = true;
  }
  if (input.admin && typeof input.admin === 'object') {
    const username = String(input.admin.username || '').trim();
    const password = String(input.admin.password || '');
    const incomingUpdatedAt = Date.parse(input.admin.updatedAt || '') || 0;
    const currentUpdatedAt = Date.parse(settings.access.adminUpdatedAt || '') || 0;
    if (username && password && (!settings.access.adminPassword || incomingUpdatedAt >= currentUpdatedAt)) {
      settings.access.adminUser = username;
      settings.access.adminName = String(input.admin.name || 'Administrador').trim().slice(0, 120) || 'Administrador';
      settings.access.adminUpdatedAt = String(input.admin.updatedAt || settings.access.adminUpdatedAt || '');
      settings.access.adminPassword = password;
      adminUpdated = true;
    }
  }
  if (input.permissions && typeof input.permissions === 'object') {
    for (const key of ['tableWrites', 'schemaChanges', 'reportEditing', 'publishOnline']) {
      if (key in input.permissions) settings.permissions[key] = Boolean(input.permissions[key]);
    }
    permissionsUpdated = true;
  }
  return { accessUpdated, adminUpdated, permissionsUpdated };
}

function buildOnlineEnv(settings) {
  const access = settings.access || {};
  const publish = settings.publish || {};
  const web = onlineDbSettingsForDeployment(settings);
  const webPreferences = settings.web || {};
  const pgCacheSettings = settings.pgCache || {};
  const onlineUsers = effectiveOnlineUsers(settings);
  const credentialedUsers = onlineUsers.filter((user) => user.active && user.username && user.password);
  if (!credentialedUsers.length) throw apiError('Cadastre ao menos um usuario online ativo com senha em Configuracao.', 400);
  if (!publish.syncToken) throw apiError('Informe ou gere o token de sincronizacao em Configuracao.', 400);
  const legacyViewer = credentialedUsers[0];
  access.onlineUsers = onlineUsers;

  const lines = [
    '# BI WA - configuracao gerada pelo app Desktop/Admin',
    '# Use este arquivo como .env no servidor da versao web/online.',
    'APP_MODE=online',
    envLine('PORT', webPreferences.port || '3000'),
    '',
    '# Login de visualizacao da versao web',
    envLine('VIEWER_USER', access.viewerUser || legacyViewer.username),
    envLine('VIEWER_PASSWORD', access.viewerPassword || legacyViewer.password),
    envLine('BIWA_AUTH_SECRET', crypto.randomBytes(24).toString('hex')),
    envLine('BIWA_ONLINE_USERS_BASE64', Buffer.from(JSON.stringify(normalizeOnlineUsers(access.onlineUsers))).toString('base64')),
    envLine('BIWA_ONLINE_USERS_JSON', JSON.stringify(normalizeOnlineUsers(access.onlineUsers && access.onlineUsers.length ? access.onlineUsers : [{ username: access.viewerUser || 'viewer', name: 'Visualizador padrão', password: access.viewerPassword || '', active: true, reportPermissions: {} }]))),
    '',
    '# Login administrativo da versao web. Somente este perfil pode abrir o editor.',
    envLine('APP_USER', access.adminUser || ''),
    envLine('APP_ADMIN_NAME', access.adminName || 'Administrador'),
    envLine('APP_PASSWORD', access.adminPassword || ''),
    '',
    '# Token usado pelo Desktop/Admin para publicar dashboards nesta versao web',
    envLine('SYNC_TOKEN', publish.syncToken),
    '',
    '# MySQL da versao web. Recomendado: usuario somente leitura.',
    envLine('MYSQL_HOST', web.mysqlHost || process.env.MYSQL_HOST || '127.0.0.1'),
    envLine('MYSQL_PORT', web.mysqlPort || process.env.MYSQL_PORT || '3306'),
    envLine('MYSQL_USER', web.mysqlUser || 'bi_viewer'),
    envLine('MYSQL_PASSWORD', web.mysqlPassword || ''),
    envLine('MYSQL_DATABASE', web.mysqlDatabase || process.env.MYSQL_DATABASE || ''),
    envLine('MYSQL_SSL', boolEnvString(web.mysqlSsl)),
    envLine('MYSQL_CHARSET', web.mysqlCharset || 'utf8mb4'),
    envLine('DB_CONNECTION_LIMIT', process.env.DB_CONNECTION_LIMIT || '10'),
    '',
    '# PostgreSQL e rotina autonoma de atualizacao no servidor',
    'BIWA_PG_CACHE_ENABLED=true',
    envLine('BIWA_PG_CACHE_HOST', process.env.BIWA_PG_CACHE_HOST || '127.0.0.1'),
    envLine('BIWA_PG_CACHE_PORT', process.env.BIWA_PG_CACHE_PORT || '5432'),
    envLine('BIWA_PG_CACHE_DATABASE', process.env.BIWA_PG_CACHE_DATABASE || process.env.BIWA_PG_CACHE_DB || 'bi_wa_cache'),
    envLine('BIWA_PG_CACHE_USER', process.env.BIWA_PG_CACHE_USER || process.env.BIWA_PG_CACHE_USERNAME || 'biwa_cache'),
    envLine('BIWA_PG_CACHE_PASSWORD', process.env.BIWA_PG_CACHE_PASSWORD || ''),
    'BIWA_PG_CACHE_SYNC_OWNER=server',
    'BIWA_PG_CACHE_STARTUP_SYNC=true',
    'BIWA_PG_CACHE_AUTO_CREATE_MISSING=true',
    'BIWA_MYSQL_STREAM_INACTIVITY_TIMEOUT_MS=300000',
    envLine('BIWA_PG_CACHE_SYNC_INTERVAL_MINUTES', Number(pgCacheSettings.syncIntervalMinutes) || 5),
    envLine('BIWA_PG_CACHE_RECENT_WINDOW_DAYS', Number(pgCacheSettings.recentWindowDays) || 90),
    '',
    '# Permissoes administrativas. Visualizadores continuam sempre em somente leitura.',
    envLine('ALLOW_TABLE_WRITES', boolEnvString(settings.permissions && settings.permissions.tableWrites)),
    envLine('ALLOW_SCHEMA_CHANGES', boolEnvString(settings.permissions && settings.permissions.schemaChanges)),
    envLine('ALLOW_REPORT_EDITING', boolEnvString(settings.permissions && settings.permissions.reportEditing)),
    envLine('ALLOW_PUBLISH', boolEnvString(settings.permissions && settings.permissions.publishOnline)),
    '',
    envLine('DEFAULT_REFRESH_SECONDS', webPreferences.defaultRefreshSeconds || DEFAULT_REFRESH_SECONDS || '15'),
    envLine('SERVER_PUSH_INTERVAL_SECONDS', webPreferences.serverPushIntervalSeconds || SERVER_PUSH_INTERVAL_SECONDS || DEFAULT_REFRESH_SECONDS || '15'),
    envLine('CORS_ORIGIN', webPreferences.corsOrigin || '')
  ];
  return lines.join('\n') + '\n';
}

app.post('/api/sync/manual-tables', express.json({ limit: '25mb' }), requireSyncToken, asyncHandler(async (req, res) => {
  if (!postgresCacheAvailable()) throw apiError('O cache PostgreSQL online nao esta disponivel para receber tabelas manuais.', 503);
  const tables = await syncManualTableSnapshots(req.body && req.body.tables || []);
  res.json({ ok: true, count: tables.length, tables, updatedAt: new Date().toISOString() });
}));

app.use(express.json({ limit: '2mb' }));
if (process.env.CORS_ORIGIN) {
  app.use(cors({ origin: process.env.CORS_ORIGIN.split(',').map((s) => s.trim()), credentials: true }));
} else {
  app.use(cors());
}

app.post('/api/sync/reports', requireSyncToken, asyncHandler(async (req, res) => {
  const reports = normalizeReportsForImport(req.body.reports || []);
  await writeReports(reports);
  let settingsChanged = false;
  let accessUpdated = false;
  let importedTablesUpdated = false;
  let semanticModelUpdated = false;
  let transformsUpdated = false;
  let pgCacheUpdated = false;
  const nextSettings = mergeSettings(defaultSettings(), getSettings());
  if (req.body.onlineCustomization && typeof req.body.onlineCustomization === 'object') {
    nextSettings.onlineCustomization = req.body.onlineCustomization;
    settingsChanged = true;
  }
  if (req.body.onlineAccess && typeof req.body.onlineAccess === 'object') {
    const publishedAccess = applyPublishedOnlineAccess(nextSettings, req.body.onlineAccess);
    accessUpdated = publishedAccess.accessUpdated || publishedAccess.adminUpdated;
    settingsChanged = settingsChanged || accessUpdated || publishedAccess.permissionsUpdated;
  }
  if (req.body.pgCache && typeof req.body.pgCache === 'object') {
    if ('syncIntervalMinutes' in req.body.pgCache) {
      nextSettings.pgCache.syncIntervalMinutes = Math.max(0.5, Math.min(1440, Number(req.body.pgCache.syncIntervalMinutes) || 5));
      pgCacheUpdated = true;
    }
    if ('recentWindowDays' in req.body.pgCache) {
      nextSettings.pgCache.recentWindowDays = Math.max(1, Math.min(730, Number(req.body.pgCache.recentWindowDays) || 90));
      pgCacheUpdated = true;
    }
    settingsChanged = settingsChanged || pgCacheUpdated;
  }
  if (Array.isArray(req.body.importedTables)) {
    await writeImportedTables(req.body.importedTables);
    importedTablesUpdated = true;
  }
  if (req.body.semanticModel && typeof req.body.semanticModel === 'object') {
    await writeSemanticModel(req.body.semanticModel);
    semanticModelUpdated = true;
  }
  if (Array.isArray(req.body.transformQueries)) {
    await writeTransforms(req.body.transformQueries);
    transformsUpdated = true;
  }
  if (settingsChanged) {
    await writeSettings(nextSettings);
    settingsCache = nextSettings;
  }
  if (pgCacheUpdated) startPgCachePeriodicSync();
  if (importedTablesUpdated && pgCacheSyncOwnedByCurrentProcess()) {
    setTimeout(() => {
      runPgCacheScheduledSync('publish')
        .catch((err) => console.error('[PG Cache] Erro ao sincronizar metadados publicados:', err.message));
    }, 1000);
  }
  if (importedTablesUpdated || semanticModelUpdated || transformsUpdated) clearQueryCache('online-metadata-published');
  res.json({
    ok: true,
    count: reports.length,
    mode: APP_MODE,
    customizationUpdated: Boolean(req.body.onlineCustomization),
    accessUpdated,
    importedTablesUpdated,
    semanticModelUpdated,
    transformsUpdated,
    pgCacheUpdated,
    onlineUserCount: accessUpdated ? nextSettings.access.onlineUsers.length : effectiveOnlineUsers(nextSettings).length,
    updatedAt: new Date().toISOString()
  });
}));

app.post('/api/sync/access', requireSyncToken, asyncHandler(async (req, res) => {
  const onlineAccess = req.body && req.body.onlineAccess;
  const users = onlineAccess && onlineAccess.users;
  if (!Array.isArray(users)) throw apiError('Lista de usuários online inválida.', 400);
  const normalizedUsers = normalizeOnlineUsers(users);
  if (!normalizedUsers.some((user) => user.active && user.username && user.password)) {
    throw apiError('Cadastre ao menos um usuário online ativo com senha.', 400);
  }
  const nextSettings = mergeSettings(defaultSettings(), getSettings());
  const publishedAccess = applyPublishedOnlineAccess(nextSettings, onlineAccess);
  await writeSettings(nextSettings);
  res.json({ ok: true, accessUpdated: true, adminAccessUpdated: publishedAccess.adminUpdated, permissionsUpdated: publishedAccess.permissionsUpdated, onlineUserCount: nextSettings.access.onlineUsers.length, updatedAt: new Date().toISOString() });
}));

app.get('/api/sync/ping', requireSyncToken, asyncHandler(async (req, res) => {
  const reports = await readReports();
  res.json({
    ok: true,
    mode: APP_MODE,
    version: APP_VERSION,
    onlineViewOnly: APP_MODE === 'online',
    database: currentDatabaseName(),
    reportCount: reports.length,
    reports: summarizePublishedReports(reports),
    access: summarizeOnlineAccess(reports, effectiveOnlineUsers()),
    checkedAt: new Date().toISOString()
  });
}));

app.get('/api/sync/health', requireSyncToken, asyncHandler(async (req, res) => {
  const status = {
    ok: true,
    mode: APP_MODE,
    version: APP_VERSION,
    checkedAt: new Date().toISOString(),
    database: { connected: false },
    pgCache: { connected: false, scheduler: publicPgCacheSchedulerState(), tables: 0, latestSyncAt: null, latestCheckAt: null }
  };
  try {
    await promiseTimeout(dbQuery('SELECT 1 AS ok'), 5000, 'sync-health-mysql');
    status.database.connected = true;
  } catch (err) {
    status.database.errorCode = String(err && err.code || 'MYSQL_UNAVAILABLE');
  }
  if (postgresCacheAvailable()) {
    try {
      await ensurePgCacheSchema();
      const summary = await promiseTimeout(pgCacheQuery(
        'SELECT COUNT(*)::int AS tables, MAX(last_data_update_at) FILTER (WHERE LOWER(source_table) <> LOWER($1)) AS latest_data_update, MAX(synced_at) AS latest_check FROM ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, '__biwa_cache_meta'),
        [CALENDAR_TABLE_NAME]
      ), 5000, 'sync-health-postgres');
      status.pgCache.connected = true;
      status.pgCache.tables = Number(summary.rows && summary.rows[0] && summary.rows[0].tables || 0);
      status.pgCache.latestSyncAt = summary.rows && summary.rows[0] ? summary.rows[0].latest_data_update || null : null;
      status.pgCache.latestCheckAt = summary.rows && summary.rows[0] ? summary.rows[0].latest_check || null : null;
    } catch (err) {
      status.pgCache.errorCode = String(err && err.code || 'POSTGRES_UNAVAILABLE');
    }
  }
  status.ok = Boolean(status.database.connected && status.pgCache.connected && status.pgCache.scheduler.enabled);
  res.json(status);
}));


app.get('/api/local/ping', asyncHandler(async (req, res) => {
  res.json({ ok: true, app: 'BI WA', version: APP_VERSION, mode: APP_MODE, checkedAt: new Date().toISOString() });
}));

app.get('/api/version', asyncHandler(async (req, res) => {
  res.json({ ok: true, app: 'BI WA', version: APP_VERSION, mode: APP_MODE, checkedAt: new Date().toISOString() });
}));


// Debug: log quando app.js e solicitado
app.use((req, res, next) => {
  if (req.path === '/app.js') {
    debugLog('[SERVE] app.js requested, query=' + JSON.stringify(req.query) + ' user-agent=' + (req.headers['user-agent'] || '').substring(0, 60));
  }
  next();
});

async function sendApplicationShell(req, res) {
  const template = await fs.readFile(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const assetVersion = encodeURIComponent(APP_VERSION);
  res.type('html').set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.send(template.replace(/__BIWA_ASSET_VERSION__/g, assetVersion));
}

// O shell e entregue pelo servidor para que CSS/JS usem a versao real do
// pacote. Assim cada atualizacao invalida caches de qualquer navegador.
app.get(['/', '/index.html'], asyncHandler(sendApplicationShell));

app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  etag: false,
  lastModified: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
 }));

app.get('/api/public-config', asyncHandler(async (req, res) => {
  res.json({ ok: true, appName: 'BI WA', version: APP_VERSION, mode: APP_MODE, onlineViewOnly: APP_MODE === 'online' });
}));


async function appendAuditLog(event, req, details = {}) {
  const entry = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    event: String(event || 'event').slice(0, 80),
    mode: APP_MODE,
    user: req && req.authUser ? { username: req.authUser.username || '', role: req.authRole || req.authUser.role || '' } : null,
    ip: req ? String(req.headers && req.headers['x-forwarded-for'] || req.socket && req.socket.remoteAddress || '').split(',')[0].trim() : '',
    details: details && typeof details === 'object' ? details : {}
  };
  try {
    let list = [];
    try { list = JSON.parse(await fs.readFile(AUDIT_LOG_FILE, 'utf8')); } catch (err) { list = []; }
    if (!Array.isArray(list)) list = [];
    list.push(entry);
    list = list.slice(-1000);
    await fs.writeFile(AUDIT_LOG_FILE, JSON.stringify(list, null, 2) + '\n', 'utf8');
  } catch (err) {
    console.warn('Falha ao gravar auditoria:', err && err.message ? err.message : err);
  }
}

async function readAuditLog(limit = 200) {
  try {
    const list = JSON.parse(await fs.readFile(AUDIT_LOG_FILE, 'utf8'));
    return Array.isArray(list) ? list.slice(-Math.max(1, Math.min(1000, Number(limit || 200)))).reverse() : [];
  } catch (err) {
    return [];
  }
}

app.post('/api/auth/login', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const requestedRole = String(body.accessMode || '').toLowerCase() === 'admin' ? 'admin' : 'viewer';
  if (!username || !password) throw apiError('Informe usuário e senha.', 401);
  const basic = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
  const result = validateBasicAuthHeader(basic);
  if (!result.ok || result.role !== requestedRole) {
    await appendAuditLog('login_failed', req, { username, requestedRole });
    throw apiError(requestedRole === 'admin' ? 'Usuário ou senha de administrador inválidos.' : 'Usuário ou senha inválidos.', 401);
  }
  await appendAuditLog('login_success', { ...req, authUser: result.user, authRole: result.role }, { username, requestedRole });
  const token = buildAuthToken(result.user || { username, role: result.role });
  res.json({ ok: true, token, role: result.role, accessMode: requestedRole, username, name: (result.user && result.user.name) || username, mode: APP_MODE, expiresInMs: AUTH_TOKEN_TTL_MS });
}));

app.post('/api/auth/logout', asyncHandler(async (req, res) => {
  res.json({ ok: true });
}));

app.use('/api', apiAuthRequired);

function normalizeProfileUsername(value) {
  const username = String(value || '').trim();
  if (username.length < 3 || username.length > 80 || /[:\r\n]/.test(username)) {
    throw apiError('O login deve ter de 3 a 80 caracteres e não pode conter dois-pontos ou quebras de linha.', 400);
  }
  return username;
}

app.put('/api/auth/profile', rateLimitApi, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const currentUsername = String(req.authUser && req.authUser.username || '').trim();
  const currentPassword = String(body.currentPassword || '');
  const username = normalizeProfileUsername(body.username || currentUsername);
  const name = String(body.name || username).trim().slice(0, 120);
  const newPassword = String(body.newPassword || '');
  if (!name) throw apiError('Informe o nome que será exibido no perfil.', 400);
  if (!currentPassword) throw apiError('Informe a senha atual para confirmar a alteração.', 400);
  if (newPassword && (newPassword.length < 8 || newPassword.length > 128)) {
    throw apiError('A nova senha deve ter entre 8 e 128 caracteres.', 400);
  }

  const basic = 'Basic ' + Buffer.from(currentUsername + ':' + currentPassword).toString('base64');
  const verification = validateBasicAuthHeader(basic);
  if (!verification.ok || verification.role !== req.authRole || !safeEqual(String(verification.user && verification.user.username || ''), currentUsername)) {
    throw apiError('Senha atual inválida.', 401);
  }

  const nextSettings = mergeSettings(defaultSettings(), getSettings());
  const viewers = normalizeOnlineUsers(nextSettings.access.onlineUsers || []);
  const profileUpdatedAt = new Date().toISOString();
  let updatedUser;
  if (req.authRole === 'admin') {
    if (viewers.some((user) => user.username.toLowerCase() === username.toLowerCase())) {
      throw apiError('Este login já está sendo usado por um visualizador.', 409);
    }
    nextSettings.access.adminUser = username;
    nextSettings.access.adminName = name;
    nextSettings.access.adminUpdatedAt = profileUpdatedAt;
    if (newPassword) nextSettings.access.adminPassword = newPassword;
    updatedUser = { username, name, role: 'admin', allReports: true, reportPermissions: {} };
  } else {
    const currentIndex = viewers.findIndex((user) => user.username.toLowerCase() === currentUsername.toLowerCase());
    if (currentIndex === -1) throw apiError('Perfil de visualizador não encontrado.', 404);
    if (String(nextSettings.access.adminUser || '').toLowerCase() === username.toLowerCase()) {
      throw apiError('Este login já está sendo usado pelo administrador.', 409);
    }
    if (viewers.some((user, index) => index !== currentIndex && user.username.toLowerCase() === username.toLowerCase())) {
      throw apiError('Este login já está sendo usado por outro visualizador.', 409);
    }
    updatedUser = {
      ...viewers[currentIndex],
      username,
      name,
      password: newPassword || viewers[currentIndex].password,
      profileUpdatedAt,
      role: 'viewer'
    };
    viewers[currentIndex] = updatedUser;
    nextSettings.access.onlineUsers = normalizeOnlineUsers(viewers);
  }

  await writeSettings(nextSettings);
  const token = buildAuthToken(updatedUser);
  await appendAuditLog('profile_updated', { ...req, authUser: updatedUser, authRole: req.authRole }, {
    previousUsername: currentUsername,
    username,
    role: req.authRole,
    passwordChanged: Boolean(newPassword)
  });
  res.json({
    ok: true,
    token,
    user: { username: updatedUser.username, name: updatedUser.name, role: updatedUser.role },
    passwordChanged: Boolean(newPassword)
  });
}));

app.get('/api/config', asyncHandler(async (req, res) => {
  const permissions = effectivePermissions(req.authRole);
  res.json({
    appName: 'BI WA',
    version: APP_VERSION,
    mode: APP_MODE,
    role: req.authRole || 'viewer',
    user: req.authUser ? {
      username: req.authUser.username,
      name: req.authUser.name,
      role: req.authUser.role,
      dataRestrictionCount: normalizeOnlineUserDataFilters(req.authUser.dataFilters).length,
      dataRestrictionRevision: onlineUserDataRestrictionRevision(req.authUser),
      dataRestrictionFields: normalizeOnlineUserDataFilters(req.authUser.dataFilters).map((filter) => ({
        table: filter.table,
        field: filter.field
      }))
    } : null,
    onlineViewOnly: isOnlineViewerRole(req.authRole),
    permissions,
    writesEnabled: permissions.tableWrites,
    schemaChangesEnabled: permissions.schemaChanges,
    reportEditingEnabled: permissions.reportEditing,
    publishOnlineEnabled: permissions.publishOnline,
    defaultRefreshSeconds: DEFAULT_REFRESH_SECONDS,
    serverPushIntervalSeconds: SERVER_PUSH_INTERVAL_SECONDS,
    timeZone: BIWA_TIME_ZONE,
    database: currentDatabaseName(),
    settings: sanitizeSettingsForClient(req.authRole)
  });
}));

app.get('/api/settings', requireDesktopAdmin, asyncHandler(async (req, res) => {
  res.json({ settings: sanitizeSettingsForClient(req.authRole), mode: APP_MODE });
}));

app.get('/api/audit', requireDesktopAdmin, asyncHandler(async (req, res) => {
  res.json({ ok: true, items: await readAuditLog(req.query.limit || 200) });
}));

app.get('/api/online-customization', requireDesktopAdmin, asyncHandler(async (req, res) => {
  const settings = getSettings();
  res.json({ customization: settings.onlineCustomization || null });
}));

app.post('/api/online-customization', requireDesktopAdmin, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const settings = getSettings();
  settings.onlineCustomization = body.customization || {};
  await writeSettings(settings);
  res.json({ ok: true });
}));

app.put('/api/settings', requireDesktopAdmin, asyncHandler(async (req, res) => {
  const current = getSettings();
  const body = req.body || {};
  const next = mergeSettings(defaultSettings(), current);
  let databasePasswordUpdated = false;
  let webPasswordUpdated = false;

  if (body.permissions && typeof body.permissions === 'object') {
    for (const key of ['tableWrites', 'schemaChanges', 'reportEditing', 'publishOnline']) {
      if (key in body.permissions) next.permissions[key] = Boolean(body.permissions[key]);
    }
  }

  if (body.access && typeof body.access === 'object') {
    let adminProfileChanged = false;
    if ('adminUser' in body.access) {
      const value = String(body.access.adminUser || '').trim();
      adminProfileChanged = adminProfileChanged || value !== String(next.access.adminUser || '');
      next.access.adminUser = value;
    }
    if ('adminName' in body.access) {
      const value = String(body.access.adminName || 'Administrador').trim().slice(0, 120) || 'Administrador';
      adminProfileChanged = adminProfileChanged || value !== String(next.access.adminName || 'Administrador');
      next.access.adminName = value;
    }
    if ('viewerUser' in body.access) next.access.viewerUser = String(body.access.viewerUser || '').trim();
    if (body.access.adminPassword) {
      const value = String(body.access.adminPassword);
      adminProfileChanged = adminProfileChanged || value !== String(next.access.adminPassword || '');
      next.access.adminPassword = value;
    }
    if (adminProfileChanged) next.access.adminUpdatedAt = new Date().toISOString();
    if (body.access.viewerPassword) next.access.viewerPassword = String(body.access.viewerPassword);
    if (Array.isArray(body.access.onlineUsers)) {
      const normalizedCurrentUsers = normalizeOnlineUsers(next.access.onlineUsers);
      const currentUsers = new Map(normalizedCurrentUsers.map((user) => [user.username.toLowerCase(), user]));
      const currentUsersById = new Map(normalizedCurrentUsers.map((user) => [String(user.id || ''), user]));
      const incoming = body.access.onlineUsers.map((user) => {
        const username = String(user && user.username || '').trim();
        const previous = currentUsersById.get(String(user && user.id || '')) || currentUsers.get(username.toLowerCase());
        const password = user && user.password ? String(user.password) : (previous ? previous.password : '');
        const changed = !previous
          || username !== previous.username
          || String(user && user.name || username) !== previous.name
          || password !== previous.password
          || stableJson(Boolean(user && user.allReports)) !== stableJson(Boolean(previous && previous.allReports))
          || stableJson(user && user.reportPermissions || {}) !== stableJson(previous && previous.reportPermissions || {})
          || stableJson(normalizeOnlineUserDataFilters(user && user.dataFilters)) !== stableJson(normalizeOnlineUserDataFilters(previous && previous.dataFilters));
        return { ...user, password, profileUpdatedAt: changed ? new Date().toISOString() : (previous && previous.profileUpdatedAt || '') };
      });
      next.access.onlineUsers = normalizeOnlineUsers(incoming);
    }
  }

  if (body.database && typeof body.database === 'object') {
    const textKeys = ['mysqlHost', 'mysqlPort', 'mysqlUser', 'mysqlDatabase', 'connectionLimit', 'mysqlCharset'];
    for (const key of textKeys) {
      if (key in body.database) next.database[key] = String(body.database[key] || '').trim();
    }
    if ('mysqlSsl' in body.database) next.database.mysqlSsl = String(Boolean(body.database.mysqlSsl));
    if (body.database.mysqlPassword) {
      next.database.mysqlPassword = sanitizePassword(body.database.mysqlPassword);
      databasePasswordUpdated = true;
    }
  }

  if (body.publish && typeof body.publish === 'object') {
    if ('onlineUrl' in body.publish) next.publish.onlineUrl = String(body.publish.onlineUrl || '').trim();
    if (body.publish.syncToken) next.publish.syncToken = String(body.publish.syncToken).trim();
  }

  if (body.web && typeof body.web === 'object') {
    const textKeys = ['port', 'mysqlHost', 'mysqlPort', 'mysqlUser', 'mysqlDatabase', 'corsOrigin', 'defaultRefreshSeconds', 'serverPushIntervalSeconds', 'mysqlCharset'];
    for (const key of textKeys) {
      if (key in body.web) next.web[key] = String(body.web[key] || '').trim();
    }
    if ('mysqlSsl' in body.web) next.web.mysqlSsl = String(Boolean(body.web.mysqlSsl));
    if (body.web.mysqlPassword) {
      next.web.mysqlPassword = sanitizePassword(body.web.mysqlPassword);
      webPasswordUpdated = true;
    }
  }

  if (body.pgCache && typeof body.pgCache === 'object') {
    if ('syncIntervalMinutes' in body.pgCache) {
      next.pgCache.syncIntervalMinutes = Math.max(0.5, Math.min(1440, Number(body.pgCache.syncIntervalMinutes) || 5));
    }
    if ('recentWindowDays' in body.pgCache) {
      next.pgCache.recentWindowDays = Math.max(1, Math.min(730, Number(body.pgCache.recentWindowDays) || 90));
    }
  }

  if (body.vps && typeof body.vps === 'object') {
    if ('host' in body.vps) next.vps.host = String(body.vps.host || '').trim();
    if ('port' in body.vps) next.vps.port = String(body.vps.port || '22').trim();
    if ('user' in body.vps) next.vps.user = String(body.vps.user || 'root').trim();
    if ('keyPath' in body.vps) next.vps.keyPath = String(body.vps.keyPath || '').trim();
    if ('domain' in body.vps) next.vps.domain = String(body.vps.domain || '').trim();
    if ('appPath' in body.vps) next.vps.appPath = String(body.vps.appPath || '/opt/biwa').trim();
  }

  await writeSettings(next);
  await closePool();
  if (databasePasswordUpdated) {
    await clearMysqlAuthGuardForConfig(buildDbConfigFromSettings(next.database || {}), 'credencial do Desktop/Admin salva novamente');
  }
  if (webPasswordUpdated) {
    await clearMysqlAuthGuardForConfig(buildDbConfigFromSettings(next.web || {}), 'credencial online salva novamente');
  }
  startPgCachePeriodicSync(); // reinicia sync com novo intervalo se alterado
  res.json({ ok: true, settings: sanitizeSettingsForClient(req.authRole) });
}));


app.post('/api/mysql/test', requireDesktopAdmin, asyncHandler(async (req, res) => {
  const current = getSettings();
  const incoming = req.body && typeof req.body.database === 'object' ? req.body.database : {};
  const db = {
    ...(current.database || {}),
    mysqlHost: 'mysqlHost' in incoming ? String(incoming.mysqlHost || '').trim() : (current.database.mysqlHost || ''),
    mysqlPort: 'mysqlPort' in incoming ? String(incoming.mysqlPort || '').trim() : (current.database.mysqlPort || '3306'),
    mysqlUser: 'mysqlUser' in incoming ? String(incoming.mysqlUser || '').trim() : (current.database.mysqlUser || ''),
    mysqlDatabase: 'mysqlDatabase' in incoming ? String(incoming.mysqlDatabase || '').trim() : (current.database.mysqlDatabase || ''),
    mysqlSsl: 'mysqlSsl' in incoming ? String(Boolean(incoming.mysqlSsl)) : (current.database.mysqlSsl || 'false'),
    connectionLimit: 'connectionLimit' in incoming ? String(incoming.connectionLimit || '').trim() : (current.database.connectionLimit || '10')
  };
  if (incoming.mysqlPassword) db.mysqlPassword = sanitizePassword(incoming.mysqlPassword);

  if (!db.mysqlHost) throw apiError('Informe o Host/IP do MySQL.', 400);
  if (!db.mysqlPort) throw apiError('Informe a porta do MySQL, geralmente 3306.', 400);
  if (!db.mysqlUser) throw apiError('Informe o usuario MySQL.', 400);
  if (!db.mysqlDatabase) throw apiError('Informe a base MySQL.', 400);

  const config = buildDbConfigFromSettings(db);
  let conn;
  try {
    await assertMysqlAuthGuardAllows(config);
    conn = await mysql.createConnection(config);
    const [rows] = await conn.query('SELECT 1 AS ok, DATABASE() AS databaseName, CURRENT_USER() AS currentUser');
    await markMysqlAuthenticationSuccessful(config);
    res.json({
      ok: true,
      database: rows[0].databaseName,
      currentUser: rows[0].currentUser,
      host: config.host,
      port: config.port
    });
  } catch (err) {
    await recordMysqlAuthenticationFailure(err, config);
    throw apiError(mysqlTroubleshootingMessage(err), Number(err && err.status) || 400);
  } finally {
    if (conn) {
      try { await conn.end(); } catch (err) {}
    }
  }
}));

function normalizeHealthTimestamp(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function publicDataSourceHealth(snapshot = dataSourceHealthSnapshot) {
  const authGuard = publicMysqlAuthGuard();
  return {
    mysqlAvailable: snapshot.mysqlAvailable === true,
    mysqlAuthBlocked: authGuard.blocked,
    mysqlAuthBlockedAt: authGuard.blockedAt,
    mysqlAutomaticAttemptsBlocked: authGuard.automaticAttemptsBlocked,
    checkedAt: snapshot.checkedAt || null,
    statusChangedAt: snapshot.statusChangedAt || null,
    lastPgSyncAt: snapshot.lastPgSyncAt || null,
    lastCycleCompletedAt: snapshot.lastCycleCompletedAt || null,
    intervalMs: DATA_SOURCE_HEALTH_INTERVAL_MS,
    timeZone: BIWA_TIME_ZONE
  };
}

async function probeDataSourceHealth(options = {}) {
  const force = Boolean(options.force);
  const broadcast = options.broadcast !== false;
  const lastCheckedMs = dataSourceHealthSnapshot.checkedAt ? new Date(dataSourceHealthSnapshot.checkedAt).getTime() : 0;
  if (!force && lastCheckedMs && Date.now() - lastCheckedMs < DATA_SOURCE_HEALTH_INTERVAL_MS) {
    return publicDataSourceHealth();
  }
  if (dataSourceHealthProbePromise) return dataSourceHealthProbePromise;

  dataSourceHealthProbePromise = (async () => {
    let mysqlAvailable = false;
    try {
      await dbQueryWithTimeout('SELECT 1', [], DATA_SOURCE_HEALTH_TIMEOUT_MS);
      mysqlAvailable = true;
    } catch (err) {}

    let lastPgSyncAt = dataSourceHealthSnapshot.lastPgSyncAt || null;
    let lastCycleCompletedAt = dataSourceHealthSnapshot.lastCycleCompletedAt || null;
    if (postgresCacheAvailable()) {
      try {
        await ensurePgCacheSchema();
        const latest = await pgCacheQuery(
          'SELECT MAX(last_data_update_at) AS last_sync FROM ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, '__biwa_cache_meta') + ' WHERE row_count > 0 AND LOWER(source_table) <> LOWER($1)',
          [CALENDAR_TABLE_NAME]
        );
        const nextLastSyncAt = normalizeHealthTimestamp(latest.rows && latest.rows[0] && latest.rows[0].last_sync);
        if (nextLastSyncAt) lastPgSyncAt = nextLastSyncAt;
        const cycleResult = await pgCacheQuery(
          'SELECT MAX(synced_at) AS cycle_at FROM ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, '__biwa_cache_meta') + ' WHERE row_count > 0 AND LOWER(source_table) <> LOWER($1) AND LOWER(sync_mode) <> $2',
          [CALENDAR_TABLE_NAME, 'manual']
        );
        const nextCycleAt = normalizeHealthTimestamp(cycleResult.rows && cycleResult.rows[0] && cycleResult.rows[0].cycle_at);
        if (nextCycleAt) lastCycleCompletedAt = nextCycleAt;
      } catch (err) {}
    }

    const checkedAt = new Date().toISOString();
    const previousAvailable = dataSourceHealthSnapshot.mysqlAvailable;
    const statusChangedAt = previousAvailable === null || previousAvailable !== mysqlAvailable
      ? checkedAt
      : dataSourceHealthSnapshot.statusChangedAt;
    dataSourceHealthSnapshot = {
      mysqlAvailable,
      checkedAt,
      statusChangedAt,
      lastPgSyncAt,
      lastCycleCompletedAt
    };
    const payload = publicDataSourceHealth();
    if (broadcast) io.emit('dashboard:connectionStatus', payload);
    return payload;
  })();

  try {
    return await dataSourceHealthProbePromise;
  } finally {
    dataSourceHealthProbePromise = null;
  }
}

function startDataSourceHealthMonitor() {
  if (dataSourceHealthTimer) clearInterval(dataSourceHealthTimer);
  const refresh = () => probeDataSourceHealth({ force: true, broadcast: true })
    .catch((err) => console.error('[Health] Falha ao verificar MySQL/PostgreSQL:', err.message));
  refresh();
  dataSourceHealthTimer = setInterval(refresh, DATA_SOURCE_HEALTH_INTERVAL_MS);
  if (typeof dataSourceHealthTimer.unref === 'function') dataSourceHealthTimer.unref();
}

app.get('/api/dashboard/connection-status', asyncHandler(async (req, res) => {
  res.json(await probeDataSourceHealth({ force: false, broadcast: false }));
}));

app.get('/api/health', asyncHandler(async (req, res) => {
  const status = {
    ok: true,
    app: 'BI WA',
    version: APP_VERSION,
    mode: APP_MODE,
    uptime: Math.floor(process.uptime()),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString()
  };
  try {
    const [rows] = await promiseTimeout(dbQuery('SELECT 1 AS ok, DATABASE() AS databaseName, NOW() AS serverTime'), 3000, 'health-check-mysql');
    status.database = { connected: true, name: rows[0].databaseName, serverTime: rows[0].serverTime };
  } catch (err) {
    status.database = { connected: false, error: err && err.message ? err.message.split('\n')[0] : 'Desconectado' };
  }
  let poolSize = 0;
  try { poolSize = pool && pool.pool && typeof pool.pool.numFree === 'function' ? pool.pool.numFree() : (pool ? -1 : 0); } catch (e) { poolSize = -1; }
  status.pool = { size: poolSize, connected: Boolean(pool) };
  status.mysqlAuthGuard = publicMysqlAuthGuard();
  status.cache = { queryCache: queryCache.size, realtimeEventTable: Boolean(REALTIME_EVENT_TABLE) };
  status.online = APP_MODE === 'online';

  // PostgreSQL cache diagnostics
  if (postgresCacheAvailable()) {
    try {
      await promiseTimeout((async () => {
        await ensurePgCacheSchema();
        await pgCacheQuery('SELECT 1');
      })(), 3000, 'health-check-pg');
      const caches = await listPgCacheStatus();
      const latestSyncAt = caches.reduce((latest, item) => {
        if (String(item && item.sourceTable || '').toLowerCase() === CALENDAR_TABLE_NAME.toLowerCase()) return latest;
        if (String(item && item.syncMode || '').toLowerCase() === 'manual') return latest;
        const value = item && item.lastDataUpdateAt ? new Date(item.lastDataUpdateAt).getTime() : 0;
        return value > latest ? value : latest;
      }, 0);
      const latestCheckAt = caches.reduce((latest, item) => {
        const value = item && item.syncedAt ? new Date(item.syncedAt).getTime() : 0;
        return value > latest ? value : latest;
      }, 0);
      const lastCycleCompletedAt = caches.reduce((latest, item) => {
        if (String(item && item.sourceTable || '').toLowerCase() === CALENDAR_TABLE_NAME.toLowerCase()) return latest;
        if (String(item && item.syncMode || '').toLowerCase() === 'manual') return latest;
        const value = item && item.syncedAt ? new Date(item.syncedAt).getTime() : 0;
        return value > latest ? value : latest;
      }, 0);
      status.pgCache = {
        connected: true,
        tables: caches.length,
        enabled: POSTGRES_CACHE_ENABLED,
        latestSyncAt: latestSyncAt ? new Date(latestSyncAt).toISOString() : null,
        latestDataUpdateAt: latestSyncAt ? new Date(latestSyncAt).toISOString() : null,
        latestCheckAt: latestCheckAt ? new Date(latestCheckAt).toISOString() : null,
        lastCycleCompletedAt: lastCycleCompletedAt ? new Date(lastCycleCompletedAt).toISOString() : null,
        scheduler: publicPgCacheSchedulerState()
      };
      status.canWorkOffline = true;
    } catch (err) {
      status.pgCache = { connected: false, enabled: POSTGRES_CACHE_ENABLED, error: err.message || 'Desconectado', scheduler: publicPgCacheSchedulerState() };
      if (POSTGRES_CACHE_ENABLED) status.ok = false;
    }
  } else {
    status.pgCache = { connected: false, enabled: false, tables: 0, scheduler: publicPgCacheSchedulerState() };
  }

  // O BI WA funciona exclusivamente com cache PostgreSQL.
  status.dataSource = {
    readEngine: 'postgres',
    syncEngine: 'mysql',
    receivingNewData: Boolean(status.database && status.database.connected),
    offlineFunctional: Boolean(status.pgCache && status.pgCache.connected)
  };
  status.obs = 'O BI WA funciona com cache PostgreSQL proprio. Se o MySQL estiver indisponivel, os dashboards continuam funcionando com os dados em cache PG. O MySQL e usado apenas para sincronizar/atualizar os dados.';

  res.json(status);
}));

app.post('/api/dashboard/resume-updates', requireDesktopAdmin, asyncHandler(async (req, res) => {
  const config = buildDbConfig();
  if (!config.host || !config.user || !config.database) {
    throw apiError('A conexao MySQL ainda nao esta configurada.', 400);
  }

  await loadMysqlAuthGuard();
  const protectedEntry = mysqlAuthGuardEntryForConfig(config);
  const retryWaitMs = mysqlAuthManualRetryWaitMs(protectedEntry);
  if (retryWaitMs > 0) {
    const minutes = Math.max(1, Math.ceil(retryWaitMs / 60000));
    throw apiError('A ultima tentativa manual foi recusada. Para proteger o IP, aguarde ' + minutes + ' minuto(s) antes de tentar novamente.', 429);
  }

  const protectionWasActive = Boolean(protectedEntry);
  if (protectedEntry) {
    await clearMysqlAuthGuardForConfig(config, 'botao Atualizar do dashboard');
  }

  try {
    await ensureMysqlAuthenticationVerified(config);
    const syncResult = await runPgCacheScheduledSync('dashboard-manual');
    if (syncResult && syncResult.authBlocked) {
      await markMysqlAuthManualRetry(config);
      throw apiError('O MySQL recusou a autenticacao durante a sincronizacao. A protecao foi reativada e nenhuma outra tabela sera testada.', 409);
    }
    const health = await probeDataSourceHealth({ force: true, broadcast: true }).catch(function() { return publicDataSourceHealth(); });
    await appendAuditLog('mysql_updates_resumed', req, {
      protectionWasActive,
      syncSkipped: Boolean(syncResult && syncResult.skipped),
      syncedTables: Number(syncResult && syncResult.succeeded || 0),
      failedTables: Number(syncResult && syncResult.failed || 0),
      changedRows: Number(syncResult && syncResult.changedRows || 0)
    });
    res.json({
      ok: true,
      resumed: true,
      protectionWasActive,
      sync: syncResult || null,
      health,
      mysqlAuthGuard: publicMysqlAuthGuard(config)
    });
  } catch (err) {
    if (isMysqlAuthenticationError(err)) {
      await recordMysqlAuthenticationFailure(err, config);
      await markMysqlAuthManualRetry(config);
    }
    throw apiError(mysqlTroubleshootingMessage(err), Number(err && err.status) || (isMysqlAuthenticationError(err) ? 409 : 500));
  }
}));

// --- Logs (consulta de erros) ---
function sanitizeOperationalLog(value) {
  return String(value || '')
    .replace(/(Authorization\s*[:=]\s*Basic\s+)[A-Za-z0-9+/=]+/gi, '$1***')
    .replace(/((?:mysql_|online_mysql_)?(?:password|senha|pwd|token|secret)|authorization)(\s*[=:]\s*)(["']?)[^\s,;"']+/gi, '$1$2***')
    .replace(/(mysql(?:\+\w+)?:\/\/[^:\s/]+:)([^@\s/]+)(@)/gi, '$1***$3')
    .replace(/(Basic\s+)[A-Za-z0-9+/=]+/gi, '$1***');
}

function sanitizeOperationalLogLines(lines) {
  return (Array.isArray(lines) ? lines : []).map(sanitizeOperationalLog);
}

app.get('/api/logs/last-error', requireDesktopAdmin, asyncHandler(async (req, res) => {
  const lastError = sanitizeOperationalLog(logger.getLastError());
  res.json({ ok: true, hasError: Boolean(lastError), error: lastError || '', timestamp: new Date().toISOString() });
}));

app.get('/api/logs/recent', requireDesktopAdmin, asyncHandler(async (req, res) => {
  const maxLines = Math.min(Number(req.query.lines || 50), 200);
  const lines = sanitizeOperationalLogLines(logger.getRecent(maxLines));
  res.json({ ok: true, count: lines.length, lines, timestamp: new Date().toISOString() });
}));

app.get('/api/logs/errors', requireDesktopAdmin, asyncHandler(async (req, res) => {
  const maxLines = Math.min(Number(req.query.lines || 50), 200);
  const lines = sanitizeOperationalLogLines(logger.getRecentErrors(maxLines));
  res.json({ ok: true, count: lines.length, lines, timestamp: new Date().toISOString() });
}));

app.post('/api/errors/log', asyncHandler(async (req, res) => {
  const { message, stack, url, timestamp } = req.body || {};
  if (!message) return res.status(400).json({ ok: false, error: 'message is required' });
  await fs.mkdir(ERRORS_DIR, { recursive: true });
  const safeMessage = sanitizeOperationalLog(message);
  const safeStack = sanitizeOperationalLog(stack || '');
  const safeUrl = sanitizeOperationalLog(url || '');
  const safeName = safeMessage.replace(/[^a-zA-Z0-9_\- ]/g, '_').slice(0, 80);
  const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}_${safeName}.json`;
  const filepath = path.join(ERRORS_DIR, filename);
  await fs.writeFile(filepath, JSON.stringify({
    message: safeMessage,
    stack: safeStack,
    url: safeUrl,
    userAgent: req.headers['user-agent'] || '',
    timestamp: timestamp || new Date().toISOString(),
    savedAt: new Date().toISOString()
  }, null, 2) + '\n', 'utf8');
  res.json({ ok: true, file: filename });
}));

app.get('/api/tables', requireDesktopAdmin, asyncHandler(async (req, res) => {
  const scope = String(req.query.scope || 'imported').toLowerCase();
  const hiddenTables = await readHiddenTables();
  const transforms = (await readTransforms()).map(transformResourceMeta);
  const manualTableNames = await readManualTables();
  let resources = [];
  if (scope === 'mysql') {
    const manualTables = new Set(manualTableNames);
    const manualTableKeys = new Set(manualTableNames.map(function(name) { return String(name || '').toLowerCase(); }));
    try {
      const raw = await collectDatabaseResourcesWithDiagnostics({ force: String(req.query.force || '') === '1' });
      resources = filterHiddenResources(withNativeCalendarFirst(raw.resources, manualTables), hiddenTables);
    } catch (mysqlErr) {
      // MySQL indisponivel: fallback para cache PostgreSQL
      resources = [];
    }
    // Complementa com tabelas do cache PostgreSQL que nao estao na lista do MySQL
    if (postgresCacheAvailable() && (!resources.length || resources.length < 50)) {
      try {
        const cached = await listPgCacheStatus();
        if (cached && cached.length) {
          const existingNames = new Set(resources.map(function(item) { return String(item.name || '').toLowerCase(); }));
          const imported = await readImportedTables();
          const importedNames = new Set(imported.map(function(t) { return String(t.name || '').toLowerCase(); }));
          const importedSources = new Set(imported.map(function(t) { return String(t.sourceTable || '').toLowerCase(); }).filter(Boolean));
          cached.forEach(function(item) {
            const name = item.sourceTable || item.physicalTable || '';
            if (name && !existingNames.has(name.toLowerCase())) {
              const isManual = item.syncMode === 'manual' || manualTableKeys.has(name.toLowerCase());
              resources.push({
                name: name,
                tableType: 'BASE TABLE',
                source: isManual ? 'manual' : 'postgres-cache',
                type: 'table',
                label: isManual ? 'Tabela manual' : 'Tabela',
                imported: importedNames.has(name.toLowerCase()) || importedSources.has(name.toLowerCase()),
                manual: isManual,
                editable: isManual,
                readOnly: !isManual
              });
            }
          });
        }
      } catch (e) { /* ignora */ }
    }
  } else {
    const imported = [];
    const importedDefinitions = await readImportedTables();
    for (const item of importedDefinitions) {
      imported.push(importedResourceMeta(item));
    }
    // Complementa com tabelas do cache PostgreSQL que ainda nao foram importadas
    if (postgresCacheAvailable()) {
      try {
        const cached = await listPgCacheStatus();
        if (cached && cached.length) {
          const importedNames = new Set(imported.flatMap(function(item) {
            return [item.name, item.sourceTable, item.physicalName].map(function(value) { return String(value || '').toLowerCase(); }).filter(Boolean);
          }));
          const manualTableSet = new Set(manualTableNames.map(function(name) { return String(name || '').toLowerCase(); }));
          cached.forEach(function(item) {
            const name = item.sourceTable || item.physicalTable || '';
            if (name && !importedNames.has(name.toLowerCase())) {
              const isManual = item.syncMode === 'manual' || manualTableSet.has(name.toLowerCase());
              imported.push({ name: name, tableType: 'BASE TABLE', source: isManual ? 'manual' : 'postgres-cache', type: 'table', label: isManual ? 'Tabela manual' : 'Tabela', manual: isManual, editable: isManual, readOnly: !isManual });
            }
          });
        }
      } catch (e) { /* ignora */ }
    }
    const map = new Map();
    var calendarResource = calendarResourceMeta();
    [...imported, calendarResource, ...transforms].forEach((item) => map.set(item.name, item));
    resources = sortResourcesForApi(Array.from(map.values()));
  }
  resources = sortResourcesForApi(mergeManualResources(resources, manualTableNames));
  res.json({
    ok: true,
    database: currentDatabaseName(),
    count: resources.length,
    tables: resources.map((item) => item.name),
    resources,
    views: resources.filter((item) => item.type === 'view').map((item) => item.name),
    transforms: resources.filter((item) => item.source === 'transform').map((item) => item.name),
    manualTables: resources.filter((item) => item.manual).map((item) => item.name),
    hiddenTables
  });
}));

// PG cache endpoints
app.get('/api/postgres-cache', requireDesktopAdmin, asyncHandler(async (req, res) => {
  if (!postgresCacheAvailable()) return res.json({ ok: true, available: false, caches: [], connected: false });
  var caches = await listPgCacheStatus({ includeActualCounts: true });
  res.json({ ok: true, available: true, caches: caches, connected: true, schema: POSTGRES_CACHE_SCHEMA });
}));

app.get('/api/postgres-cache/diagnostics', requireDesktopAdmin, asyncHandler(async (req, res) => {
  if (!postgresCacheAvailable()) return res.json({ connected: false, caches: [] });
  var caches = await listPgCacheStatus({ includeActualCounts: true });
  var lastCycleCompletedAt = null;
  if (Array.isArray(caches) && caches.length) {
    var monitored = caches.filter(function(c) {
      return c.exists && String(c.syncMode || '').toLowerCase() !== 'manual' && String(c.sourceTable || '').toLowerCase() !== 'calendario';
    });
    if (monitored.length) {
      var dates = monitored.map(function(c) { return c.syncedAt ? new Date(c.syncedAt).getTime() : 0; }).filter(function(t) { return t > 0; });
      if (dates.length) {
        lastCycleCompletedAt = new Date(Math.max.apply(null, dates)).toISOString();
      }
    }
  }
  res.json({ connected: true, caches: caches, schema: POSTGRES_CACHE_SCHEMA, lastCycleCompletedAt: lastCycleCompletedAt });
}));

app.get('/api/postgres-cache/progress', requireDesktopAdmin, asyncHandler(async (req, res) => {
  var table = String(req.query.table || '').trim();
  if (!table) return res.json({ progress: null });
  var progress = getPgCacheProgress(table);
  var imported = await findImportedTableByName(table);
  if (!progress && imported) {
    progress = getPgCacheProgress(imported.sourceTable);
  }
  res.json({ progress: progress || null, table: table });
}));

app.get('/api/postgres-cache/:table/status', requireDesktopAdmin, asyncHandler(async (req, res) => {
  var table = req.params.table;
  var cache = await publicPgCacheStatus(table);
  res.json({ ok: true, table: table, cache: cache });
}));

app.post('/api/postgres-cache/:table/sync', requirePermission('reportEditing', 'Sincronizacao de cache'), asyncHandler(async (req, res) => {
  var table = req.params.table;
  if (await isManualTableDataSource(table)) {
    throw apiError('Tabelas manuais nao recebem sincronizacao do MySQL. Edite os dados diretamente em Inserir Dados.', 400);
  }
  var mode = String(req.body.mode || 'auto');
  setPgCacheProgress(table, { percent: 0, rowsCopied: 0, totalRows: 0, status: 'starting', table: table });
  try {
    var result = await syncTableToPostgresCache(table, { mode: mode, batchSize: Number(req.body.batchSize || 10000), recentDays: Number(req.body.recentDays) || undefined });
    setPgCacheProgress(table, { percent: 100, rowsCopied: result.rowCount || 0, totalRows: result.rowCount || 0, status: 'done' });
    res.json({ ok: true, table: table, rowCount: result.rowCount, changedRows: result.changedRows, syncMode: result.syncMode });
  } catch (err) {
    var friendly = isRecoverablePgCacheSourceError(err)
      ? 'A origem MySQL ficou indisponivel durante a recarga. A tabela PostgreSQL atual foi preservada; tente novamente quando o MySQL terminar de atualizar.'
      : err.message;
    setPgCacheProgress(table, { percent: 0, rowsCopied: 0, totalRows: 0, status: 'error', phase: 'error', error: friendly });
    console.error('[PG Cache] Sync error for', table + ':', err.message);
    throw apiError(friendly, isRecoverablePgCacheSourceError(err) ? 409 : 500);
  }
}));

app.get('/api/postgres-cache/:table/sync-log', requireDesktopAdmin, asyncHandler(async (req, res) => {
  var table = req.params.table;
  var limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
  if (!postgresCacheAvailable()) return res.json({ table: table, events: [], connected: false });
  try {
    await ensurePgCacheSchema();
    var result = await pgCacheQuery(
      'SELECT id, source_table, synced_at, sync_mode, sync_strategy, sync_column, row_count, changed_rows FROM ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, '__biwa_cache_sync_log') + ' WHERE LOWER(source_table) = LOWER($1) ORDER BY synced_at DESC LIMIT $2',
      [String(table || ''), limit]
    );
    var events = (result.rows || []).map(function(r) {
      return {
        id: r.id,
        sourceTable: r.source_table,
        syncedAt: r.synced_at,
        syncMode: r.sync_mode || '',
        syncStrategy: r.sync_strategy || '',
        syncColumn: r.sync_column || '',
        rowCount: Number(r.row_count || 0),
        changedRows: Number(r.changed_rows || 0)
      };
    });
    res.json({ table: table, events: events, connected: true });
  } catch (err) {
    res.json({ table: table, events: [], connected: true, error: err.message });
  }
}));

async function publicPgCacheStatus(sourceTable) {
  try {
    var meta = await getPgCacheMeta(sourceTable);
    if (meta) meta = await hydratePgCacheMetaWithActualCount(meta);
    return publicPgCacheStatusFromMeta(meta);
  } catch (err) {
    return { available: postgresCacheAvailable(), enabled: POSTGRES_CACHE_ENABLED, exists: false, kind: 'postgres', error: err.message };
  }
}

function calendarContextDateRange(contextEntries) {
  const calendarValues = new Map((contextEntries || []).filter((ctx) => ctx && sameTableName(ctx.table, CALENDAR_TABLE_NAME)).map((ctx) => [String(ctx.field), String(ctx.value ?? '')]));
  const directDate = calendarValues.get('Data');
  if (directDate) {
    const parts = directDate.split('|');
    const from = parts[0] || '';
    const to = parts[1] || parts[0] || '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
      const exclusive = new Date(to + 'T00:00:00Z');
      exclusive.setUTCDate(exclusive.getUTCDate() + 1);
      return { from, exclusiveTo: exclusive.toISOString().slice(0, 10), fields: new Set(['Data']) };
    }
  }
  const normalizeMonth = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  const monthNames = new Map(['janeiro','fevereiro','marco','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'].map((name, index) => [name, index + 1]));
  const year = Number(calendarValues.get('Ano'));
  if (!Number.isInteger(year) || year < 1900 || year > 2200) return null;
  const monthNumber = Number(calendarValues.get('MesNumero')) || monthNames.get(normalizeMonth(calendarValues.get('MesNome')));
  const month = Number.isInteger(monthNumber) && monthNumber >= 1 && monthNumber <= 12 ? monthNumber : 1;
  const maxMonth = Number.isInteger(monthNumber) && monthNumber >= 1 && monthNumber <= 12 ? monthNumber : 12;
  const rawDay = calendarValues.get('Dia') || '';
  const dayParts = rawDay.split('|');
  const maxDay = new Date(Date.UTC(year, maxMonth, 0)).getUTCDate();
  const requestedFromDay = Number(dayParts[0]);
  const requestedToDay = Number(dayParts[1] || dayParts[0]);
  const validDayRange = Boolean(monthNumber && rawDay && Number.isInteger(requestedFromDay) && Number.isInteger(requestedToDay) && requestedFromDay >= 1 && requestedToDay >= requestedFromDay && requestedToDay <= maxDay);
  const fromDay = validDayRange ? requestedFromDay : 1;
  const toDay = validDayRange ? requestedToDay : maxDay;
  const from = new Date(Date.UTC(year, month - 1, fromDay));
  const exclusive = new Date(Date.UTC(year, maxMonth - 1, toDay));
  exclusive.setUTCDate(exclusive.getUTCDate() + 1);
  const fields = new Set(['Ano']);
  if (monthNumber) fields.add(calendarValues.has('MesNumero') ? 'MesNumero' : 'MesNome');
  if (validDayRange) fields.add('Dia');
  return { from: from.toISOString().slice(0, 10), exclusiveTo: exclusive.toISOString().slice(0, 10), fields };
}

app.get('/api/tables/debug', requireDesktopAdmin, asyncHandler(async (req, res) => {
  const raw = await collectDatabaseResourcesWithDiagnostics({ force: String(req.query.force || '') === '1' });
  res.json({
    ok: true,
    database: currentDatabaseName(),
    count: raw.resources.length,
    resources: raw.resources,
    diagnostics: raw.diagnostics
  });
}));

app.get('/api/tables/lite', requireDesktopAdmin, asyncHandler(async (req, res) => {
  const diagnostics = [];
  let rawResources = [];
  try {
    rawResources = await promiseTimeout(getResourcesFromInformationSchema(), RESOURCE_TOTAL_TIMEOUT_MS, 'Listagem leve de tabelas/views');
    diagnostics.push({ method: 'lite:INFORMATION_SCHEMA.TABLES', ok: true, count: rawResources.length });
  } catch (err) {
    diagnostics.push({ method: 'lite:INFORMATION_SCHEMA.TABLES', ok: false, error: err.message || String(err) });
    try {
      rawResources = await promiseTimeout(getResourcesFromShowTables(), RESOURCE_TOTAL_TIMEOUT_MS, 'SHOW TABLES leve');
      diagnostics.push({ method: 'lite:SHOW TABLES', ok: true, count: rawResources.length });
    } catch (err2) {
      diagnostics.push({ method: 'lite:SHOW TABLES', ok: false, error: err2.message || String(err2) });
    }
  }
  const manualTables = new Set(await readManualTables());
  const hiddenTables = await readHiddenTables();
  const baseResources = filterHiddenResources(withNativeCalendarFirst(rawResources, manualTables), hiddenTables);
  const transforms = (await readTransforms()).map(transformResourceMeta);
  const imported = [];
  for (const item of await readImportedTables()) {
    try {
      const physical = await findDatabaseResourceByName(item.sourceTable);
      imported.push(importedResourceMeta(item, physical || { name: item.sourceTable, tableType: 'BASE TABLE' }));
    } catch (err) {
      imported.push(importedResourceMeta(item, { name: item.sourceTable, tableType: 'BASE TABLE' }));
    }
  }
  // Complementa com tabelas do cache PostgreSQL que ainda nao foram importadas
  if (postgresCacheAvailable()) {
    try {
      const cached = await listPgCacheStatus();
      if (cached && cached.length) {
        const importedNames = new Set(imported.flatMap(function(item) {
          return [item.name, item.sourceTable, item.physicalName].map(function(value) { return String(value || '').toLowerCase(); }).filter(Boolean);
        }));
        const manualTableKeys = new Set((await readManualTables()).map(function(name) { return String(name || '').toLowerCase(); }));
        cached.forEach(function(item) {
          const name = item.sourceTable || item.physicalTable || '';
          if (name && !importedNames.has(name.toLowerCase())) {
            const isManual = item.syncMode === 'manual' || manualTableKeys.has(name.toLowerCase());
            imported.push({ name: name, tableType: 'BASE TABLE', source: isManual ? 'manual' : 'postgres-cache', type: 'table', label: isManual ? 'Tabela manual' : 'Tabela', manual: isManual, editable: isManual, readOnly: !isManual });
          }
        });
      }
    } catch (e) { /* ignora */ }
  }
  const map = new Map();
  [...baseResources, ...imported, ...transforms].forEach((item) => map.set(item.name, item));
  const resources = sortResourcesForApi(mergeManualResources(Array.from(map.values()), Array.from(manualTables)));
  res.json({ ok: true, database: currentDatabaseName(), count: resources.length, resources, tables: resources.map((item) => item.name), transforms: resources.filter((item) => item.source === 'transform').map((item) => item.name), diagnostics, hiddenTables });
}));

async function loadFilterOptionsWithContext(table, field, limit, contextEntries, semanticModel, options = {}) {
  const target = String(table).trim();
  if (!target || !semanticModel) return null;
  const domainTable = String(options && options.domainTable || '').trim();
  if ((!contextEntries || !contextEntries.length) && !domainTable) return null;

  async function tryLoadViaContextualWitnessPg(plan) {
    if (!postgresCacheAvailable() || !plan || !plan.table || !plan.targetPath) return null;
    const targetMeta = await getPgEffectiveMeta(target) || await getPgCacheMeta(target);
    if (!targetMeta || !targetMeta.cache_table) return null;
    const joins = [];
    const outerClauses = ['src.' + quotePgIdent(field) + ' IS NOT NULL'];
    const clauses = [];
    const params = [];
    const aliases = new Map([[normalizeTableKey(target), 'src']]);
    const metas = new Map([[normalizeTableKey(target), targetMeta]]);
    const joinedEdges = new Set();
    let aliasIndex = 0;
    const addParam = (value) => {
      params.push(value);
      return '$' + params.length;
    };
    const metaFor = async (tableName) => {
      const key = normalizeTableKey(tableName);
      if (metas.has(key)) return metas.get(key);
      const meta = await getPgEffectiveMeta(tableName) || await getPgCacheMeta(tableName);
      if (!meta || !meta.cache_table) return null;
      metas.set(key, meta);
      return meta;
    };
    const metaColumnType = (meta, column) => {
      const found = (meta && Array.isArray(meta.columns) ? meta.columns : []).find((item) => String(item && (item.name || item.Field) || item).toLowerCase() === String(column || '').toLowerCase());
      return String(found && (found.dataType || found.data_type || found.columnType || found.Type) || '').toLowerCase();
    };
    const typeFamily = (type) => {
      if (/int|decimal|numeric|double|float|real/.test(type)) return 'number';
      if (/date|time/.test(type)) return 'date';
      if (/char|text|uuid/.test(type)) return 'text';
      return '';
    };
    const cachedJoinCondition = (leftAlias, leftTable, leftColumn, leftMeta, rightAlias, rightTable, rightColumn, rightMeta) => {
      const leftFamily = typeFamily(metaColumnType(leftMeta, leftColumn));
      const rightFamily = typeFamily(metaColumnType(rightMeta, rightColumn));
      if (leftFamily && leftFamily === rightFamily) {
        return leftAlias + '.' + quotePgIdent(leftColumn) + ' = ' + rightAlias + '.' + quotePgIdent(rightColumn);
      }
      return relationshipJoinConditionPg(leftAlias, leftTable, leftColumn, rightAlias, rightTable, rightColumn);
    };
    const appendContextClause = (columnSql, rawValue, clauseList = clauses) => {
      const raw = String(rawValue ?? '');
      if (raw.includes('||')) {
        const listValues = raw.split('||').map((value) => value.trim()).filter(Boolean);
        if (listValues.length) clauseList.push(columnSql + ' IN (' + listValues.map(addParam).join(', ') + ')');
        return;
      }
      if (raw.includes('|')) {
        const parts = raw.split('|');
        const from = parts[0] || '';
        const to = parts[1] || '';
        if (from !== '' && to !== '') clauseList.push(columnSql + ' BETWEEN ' + addParam(from) + ' AND ' + addParam(to));
        else if (from !== '') clauseList.push(columnSql + ' >= ' + addParam(from));
        else if (to !== '') clauseList.push(columnSql + ' <= ' + addParam(to));
        return;
      }
      clauseList.push(columnSql + ' = ' + addParam(raw));
    };
    const addRelationshipJoin = async (leftTable, rightTable, rel, newTable) => {
      const leftKey = normalizeTableKey(leftTable);
      const rightKey = normalizeTableKey(rightTable);
      const leftAlias = aliases.get(leftKey);
      const rightAlias = aliases.get(rightKey);
      const leftMeta = await metaFor(leftTable);
      const rightMeta = await metaFor(rightTable);
      if (!leftAlias || !rightAlias || !leftMeta || !rightMeta) return false;
      const cols = relationshipColumnForTarget(rel, leftTable, rightTable);
      if (!cols) return false;
      const edgeKey = [leftAlias, cols.sourceColumn, rightAlias, cols.targetColumn].join('|');
      if (joinedEdges.has(edgeKey)) return true;
      const condition = cachedJoinCondition(leftAlias, leftTable, cols.sourceColumn, leftMeta, rightAlias, rightTable, cols.targetColumn, rightMeta);
      if (newTable) joins.push('JOIN ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, newTable.meta.cache_table) + ' ' + newTable.alias + ' ON ' + condition);
      else clauses.push(condition);
      joinedEdges.add(edgeKey);
      return true;
    };
    const ensureForwardPath = async (path) => {
      const nodes = path && path.nodes || [];
      const rels = path && path.relationships || [];
      for (let index = 0; index < rels.length; index += 1) {
        const leftTable = nodes[index];
        const rightTable = nodes[index + 1];
        const rightKey = normalizeTableKey(rightTable);
        let added = null;
        if (!aliases.has(rightKey)) {
          const rightMeta = await metaFor(rightTable);
          if (!rightMeta) return false;
          const alias = sameTableName(rightTable, plan.table) ? 'fact' : 'dw' + (++aliasIndex);
          aliases.set(rightKey, alias);
          added = { alias, meta: rightMeta };
        }
        if (!await addRelationshipJoin(leftTable, rightTable, rels[index], added)) return false;
      }
      return true;
    };
    const ensureReversePath = async (path) => {
      const nodes = path && path.nodes || [];
      const rels = path && path.relationships || [];
      for (let index = rels.length - 1; index >= 0; index -= 1) {
        const leftTable = nodes[index];
        const rightTable = nodes[index + 1];
        const leftKey = normalizeTableKey(leftTable);
        let added = null;
        if (!aliases.has(leftKey)) {
          const leftMeta = await metaFor(leftTable);
          if (!leftMeta) return false;
          const alias = 'dw' + (++aliasIndex);
          aliases.set(leftKey, alias);
          added = { alias, meta: leftMeta };
        }
        if (!await addRelationshipJoin(leftTable, rightTable, rels[index], added)) return false;
      }
      return true;
    };

    let directWitnessMeta = null;
    let directWitnessCondition = '';
    let directWitnessSourceColumn = '';
    let directWitnessTargetColumn = '';
    const targetPathNodes = plan.targetPath && Array.isArray(plan.targetPath.nodes) ? plan.targetPath.nodes : [];
    const targetPathRelationships = plan.targetPath && Array.isArray(plan.targetPath.relationships) ? plan.targetPath.relationships : [];
    const directWitnessPath = targetPathRelationships.length === 1
      && targetPathNodes.length === 2
      && sameTableName(targetPathNodes[0], target)
      && sameTableName(targetPathNodes[1], plan.table);
    if (directWitnessPath) {
      directWitnessMeta = await metaFor(plan.table);
      if (!directWitnessMeta) return null;
      aliases.set(normalizeTableKey(plan.table), 'fact');
      const columns = relationshipColumnForTarget(targetPathRelationships[0], target, plan.table);
      if (!columns) return null;
      directWitnessSourceColumn = columns.sourceColumn;
      directWitnessTargetColumn = columns.targetColumn;
      directWitnessCondition = cachedJoinCondition('src', target, columns.sourceColumn, targetMeta, 'fact', plan.table, columns.targetColumn, directWitnessMeta);
      joinedEdges.add(['src', columns.sourceColumn, 'fact', columns.targetColumn].join('|'));
      joinedEdges.add(['fact', columns.targetColumn, 'src', columns.sourceColumn].join('|'));
    } else if (!await ensureForwardPath(plan.targetPath)) return null;
    // O mesmo contexto temporal usado pelos visuais deve chegar ao domínio
    // como um intervalo na coluna de data da fato. Juntar a Calendario virtual
    // uma vez por Ano/Mes/Dia força varreduras e DATE(...) sobre a view DAX
    // inteira, apesar de os três campos representarem um único período.
    const calendarRange = calendarContextDateRange(contextEntries || []);
    const pushedCalendarFields = new Set();
    if (calendarRange) {
      const calendarPathInfo = (plan.contextPaths || []).find((item) =>
        sameTableName(item && item.table, CALENDAR_TABLE_NAME)
        && item.path
        && Array.isArray(item.path.relationships)
        && item.path.relationships.length >= 1
        && Array.isArray(item.path.nodes)
        && item.path.nodes.length >= 2
        && sameTableName(item.path.nodes[0], CALENDAR_TABLE_NAME)
        && sameTableName(item.path.nodes[1], plan.table)
      );
      const factAlias = aliases.get(normalizeTableKey(plan.table));
      const calendarColumns = calendarPathInfo
        ? relationshipColumnForTarget(calendarPathInfo.path.relationships[0], CALENDAR_TABLE_NAME, plan.table)
        : null;
      if (factAlias && calendarColumns && calendarColumns.targetColumn) {
        clauses.push(factAlias + '.' + quotePgIdent(calendarColumns.targetColumn) + ' >= ' + addParam(calendarRange.from));
        clauses.push(factAlias + '.' + quotePgIdent(calendarColumns.targetColumn) + ' < ' + addParam(calendarRange.exclusiveTo));
        calendarRange.fields.forEach((fieldName) => pushedCalendarFields.add(String(fieldName)));
      }
    }
    for (const pathInfo of plan.contextPaths || []) {
      if (sameTableName(pathInfo && pathInfo.table, CALENDAR_TABLE_NAME) && pushedCalendarFields.size) continue;
      if (pathInfo.path && pathInfo.path.relationships && pathInfo.path.relationships.length) {
        if (!await ensureReversePath(pathInfo.path)) return null;
      }
    }
    for (const ctx of contextEntries || []) {
      if (!ctx || !ctx.table || !ctx.field || ctx.value === '' || ctx.value === null || ctx.value === undefined) continue;
      if (sameTableName(ctx.table, CALENDAR_TABLE_NAME) && pushedCalendarFields.has(String(ctx.field))) continue;
      const alias = aliases.get(normalizeTableKey(ctx.table));
      if (!alias) return null;
      appendContextClause(alias + '.' + quotePgIdent(ctx.field), ctx.value, alias === 'src' ? outerClauses : clauses);
    }
    const hasLimit = Number.isFinite(Number(limit)) && Number(limit) > 0;
    if (hasLimit) params.push(Math.floor(Number(limit)));
    const targetSourceSql = quotePgQualified(POSTGRES_CACHE_SCHEMA, targetMeta.cache_table) + ' src';
    const witnessKeyAlias = '__biwa_witness_key';
    const witnessProjectionMeta = directWitnessMeta ? {
      columns: [{ name: witnessKeyAlias, dataType: metaColumnType(directWitnessMeta, directWitnessTargetColumn) }]
    } : null;
    const directWitnessMatchCondition = directWitnessCondition
      ? cachedJoinCondition('src', target, directWitnessSourceColumn, targetMeta, 'matched', plan.table, witnessKeyAlias, witnessProjectionMeta)
      : '';
    // Materializa somente as chaves distintas da testemunha dentro da propria
    // consulta. O EXISTS correlacionado levava o PostgreSQL a escolher nested
    // loop sobre views transformadas; a forma abaixo preserva a semantica de
    // semi-join e permite hash join set-based sem executar uma consulta por
    // valor da dimensao.
    const sql = directWitnessCondition
      ? 'SELECT DISTINCT src.' + quotePgIdent(field) + ' AS value FROM ' + targetSourceSql
        + ' JOIN (SELECT DISTINCT fact.' + quotePgIdent(directWitnessTargetColumn) + ' AS ' + quotePgIdent(witnessKeyAlias)
        + ' FROM ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, directWitnessMeta.cache_table) + ' fact '
        + joins.join(' ') + (clauses.length ? ' WHERE ' + clauses.join(' AND ') : '') + ') matched ON ' + directWitnessMatchCondition
        + ' WHERE ' + outerClauses.join(' AND ')
        + ' ORDER BY src.' + quotePgIdent(field) + (hasLimit ? ' LIMIT $' + params.length : '')
      : 'SELECT DISTINCT src.' + quotePgIdent(field) + ' AS value FROM ' + targetSourceSql + ' ' + joins.join(' ')
        + ' WHERE ' + outerClauses.concat(clauses).join(' AND ') + ' ORDER BY src.' + quotePgIdent(field)
        + (hasLimit ? ' LIMIT $' + params.length : '');
    if (options && options.diagnostics) {
      options.diagnostics.sql = sql;
      options.diagnostics.params = params.slice();
      options.diagnostics.queryBuildCount = Number(options.diagnostics.queryBuildCount || 0) + 1;
      options.diagnostics.contextualWitness = plan.table;
    }
    const result = await pgCacheQueryWithTimeout(sql, params, FILTER_OPTIONS_QUERY_TIMEOUT_MS);
    const values = (result && result.rows || []).map((row) => serializeValue(row.value));
    values._engine = 'postgres-contextual-domain';
    return values;
  }

  const contextualValues = await tryLoadViaContextualWitnessPg(options && options.witness);
  if (contextualValues !== null) return contextualValues;

  // FILTER_DOMAIN_QUERY sempre parte da tabela que possui o campo do filtro.
  // O caminho legado via "fato comum" fazia INNER JOIN da dimensão com uma
  // fato e propagava o filtro na direção inversa mesmo em relações single.
  // Contextos externos chegam aqui somente quando existe caminho dirigido até
  // o domínio; buildWhere aplica esse caminho sem trocar a origem do domínio.

  function buildWhere() {
    const clauses = [];
    const params = [];
    const existsGroups = new Map();
    let n = 1;
    function ph() { return '$' + (n++); }
    function addResolvedPredicate(cond, predicateSql) {
      if (cond && cond.type === 'exists') {
        const groupKey = String(cond.prefixSql || '') + '\u0000' + String(cond.suffixSql || ')');
        if (!existsGroups.has(groupKey)) {
          existsGroups.set(groupKey, {
            prefixSql: cond.prefixSql,
            suffixSql: cond.suffixSql || ')',
            predicates: []
          });
        }
        existsGroups.get(groupKey).predicates.push(predicateSql);
        return;
      }
      clauses.push(predicateSql);
    }
    for (const ctx of contextEntries) {
      if (!ctx || !ctx.table || !ctx.field || ctx.value === '' || ctx.value === null) continue;
      const cond = resolveFilterCondition({ table: ctx.table, field: ctx.field }, target, semanticModel);
      if (!cond) {
        return null;
      }
      const ctxValue = String(ctx.value);
      const isList = ctxValue.includes('||');
      const betweenParts = !isList ? ctxValue.split('|') : null;
      const isFullBetween = betweenParts && betweenParts.length === 2 && betweenParts[0] !== '' && betweenParts[1] !== '';
      const isFromOnly = betweenParts && betweenParts.length >= 2 && betweenParts[0] !== '' && betweenParts[1] === '';
      const isToOnly = betweenParts && betweenParts.length >= 2 && betweenParts[0] === '' && betweenParts[1] !== '';
      
      if (cond.type === 'exists') {
        if (isList) {
          const vals = ctxValue.split('||').map((v) => v.trim()).filter(Boolean);
          if (!vals.length) continue;
          addResolvedPredicate(cond, `${cond.columnSql} IN (${vals.map(() => ph()).join(', ')})`);
          params.push(...vals);
        } else if (isFullBetween) {
          const p1 = ph(); const p2 = ph();
          addResolvedPredicate(cond, `${cond.columnSql} >= ${p1} AND ${cond.columnSql} <= ${p2}`);
          params.push(betweenParts[0], betweenParts[1]);
        } else if (isFromOnly) {
          addResolvedPredicate(cond, `${cond.columnSql} >= ${ph()}`);
          params.push(betweenParts[0]);
        } else if (isToOnly) {
          addResolvedPredicate(cond, `${cond.columnSql} <= ${ph()}`);
          params.push(betweenParts[1]);
        } else {
          addResolvedPredicate(cond, `${cond.columnSql} = ${ph()}`);
          params.push(ctxValue);
        }
      } else {
        // cond.type === 'column'
        const columnRef = sameTableName(ctx.table, target) ? `src.${cond.columnSql}` : cond.columnSql;
        if (isList) {
          const vals = ctxValue.split('||').map((v) => v.trim()).filter(Boolean);
          if (!vals.length) continue;
          clauses.push(`${columnRef} IN (${vals.map(() => ph()).join(', ')})`);
          params.push(...vals);
        } else if (isFullBetween) {
          const p1 = ph(); const p2 = ph();
          clauses.push(`${columnRef} >= ${p1} AND ${columnRef} <= ${p2}`);
          params.push(betweenParts[0], betweenParts[1]);
        } else if (isFromOnly) {
          clauses.push(`${columnRef} >= ${ph()}`);
          params.push(betweenParts[0]);
        } else if (isToOnly) {
          clauses.push(`${columnRef} <= ${ph()}`);
          params.push(betweenParts[1]);
        } else {
          clauses.push(`${columnRef} = ${ph()}`);
          params.push(ctxValue);
        }
      }
    }
    existsGroups.forEach((group) => {
      if (group.predicates.length) clauses.push(group.prefixSql + group.predicates.join(' AND ') + group.suffixSql);
    });
    return clauses.length ? { sql: ' AND ' + clauses.join(' AND '), params } : null;
  }

  const where = buildWhere();
  debugLog('[CASCADE:buildWhere] where=' + JSON.stringify(where));
  if (!where) return null;

  // O nome logico continua sendo a origem da consulta. Se houver Transformar,
  // getPgEffectiveMeta resolve a view final da pipeline, nunca a fonte bruta.
  let lookupTable = target;
  try {
    const transform = await findTransformByName(target);
    if (transform) {
      const built = await buildTransformSql(transform, { limit: 0 });
      if (!(built.columns || []).includes(field)) return null;
    }
  } catch (e) {}

  // Tenta PG cache
  if (postgresCacheAvailable()) {
    try {
      const pgMeta = await getPgEffectiveMeta(lookupTable);
      debugLog('[CASCADE:PG] pgMeta=' + !!pgMeta + ' lookupTable=' + lookupTable + ' cache_table=' + (pgMeta ? pgMeta.cache_table : 'N/A') + ' row_count=' + (pgMeta ? pgMeta.row_count : 0));
      if (pgMeta && pgMeta.cache_table) {
        const cacheTable = quotePgQualified(POSTGRES_CACHE_SCHEMA, pgMeta.cache_table);
        const hasLimit = Number.isFinite(Number(limit)) && Number(limit) > 0;
        const allParams = hasLimit ? where.params.concat(Math.floor(Number(limit))) : where.params.slice();
        // Converte backticks MySQL para aspas duplas PostgreSQL
        let pgWhere = mysqlBacktickSqlToPostgres(where.sql);
        // Converte funcoes MySQL (YEAR, MONTH, etc) para PostgreSQL
        pgWhere = mysqlFunctionsToPostgres(pgWhere);
        // Reescreve nomes de tabelas MySQL no EXISTS para nomes do cache PG
        const tableRe = /(?:FROM|JOIN)\s+"((?:""|[^"])+)"/gi;
        const referencedTables = Array.from(new Set(Array.from(pgWhere.matchAll(tableRe)).map((match) => match[1].replace(/""/g, '"'))));
        for (const mysqlTable of referencedTables) {
          try {
            const refMeta = await getPgEffectiveMeta(mysqlTable) || await getPgCacheMeta(mysqlTable);
            if (refMeta && refMeta.cache_table) {
              const pgTable = quotePgQualified(POSTGRES_CACHE_SCHEMA, refMeta.cache_table);
              const escaped = mysqlTable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              pgWhere = pgWhere.replace(new RegExp('(FROM|JOIN)\\s+"' + escaped + '"', 'gi'), '$1 ' + pgTable);
            }
          } catch (e) {}
        }
        const sql = `SELECT DISTINCT src.${quotePgIdent(field)} AS value FROM ${cacheTable} AS src WHERE src.${quotePgIdent(field)} IS NOT NULL${pgWhere} ORDER BY src.${quotePgIdent(field)}${hasLimit ? ' LIMIT $' + allParams.length : ''}`;
        if (options && options.diagnostics) {
          options.diagnostics.sql = sql;
          options.diagnostics.params = allParams.slice();
          options.diagnostics.queryBuildCount = Number(options.diagnostics.queryBuildCount || 0) + 1;
        }
        debugLog('[CASCADE:PG] sql=' + sql + ' params=' + JSON.stringify(allParams));
        const pgResult = await pgCacheQueryWithTimeout(sql, allParams, FILTER_OPTIONS_QUERY_TIMEOUT_MS);
        debugLog('[CASCADE:PG] rows=' + (pgResult.rows ? pgResult.rows.length : 'null/error'));
        if (pgResult.rows) {
          const values = pgResult.rows.map((row) => serializeValue(row.value));
          values._engine = 'postgres';
          return values;
        }
      }
    } catch (e) { debugLog('[CASCADE:PG] error: ' + e.message); }
  } else { debugLog('[CASCADE:PG] not available'); }

  return null;
}

function calendarDomainContextConflicts(targetTable, targetField, entry) {
  if (!sameTableName(targetTable, CALENDAR_TABLE_NAME) || !entry || !sameTableName(entry.table, CALENDAR_TABLE_NAME)) return false;
  const targetRole = calendarDefaultFilterRole({ table: targetTable, field: targetField });
  if (!['monthNumber', 'monthName', 'monthShortName', 'yearMonth', 'yearMonthName'].includes(targetRole)) return false;
  const sourceRole = calendarDefaultFilterRole({ table: entry.table, field: entry.field });
  if (['yearMonth', 'yearMonthName'].includes(targetRole)) {
    return ['date', 'year', 'monthNumber', 'monthName', 'monthShortName', 'yearMonth', 'yearMonthName', 'day'].includes(sourceRole);
  }
  return ['date', 'monthNumber', 'monthName', 'monthShortName', 'yearMonth', 'yearMonthName', 'day'].includes(sourceRole);
}

function filterDomainContextForTarget(table, field, clientEntries, securityEntries, semanticModel, domainTable) {
  const target = String(table || '').trim();
  const targetField = String(field || '').trim();
  const effective = [];
  const excluded = [];
  const propagation = [];
  const contextualCandidates = [];
  for (const rawEntry of [...(clientEntries || []), ...(securityEntries || [])]) {
    if (!rawEntry || !rawEntry.table || !rawEntry.field || rawEntry.value === '' || rawEntry.value === null || rawEntry.value === undefined) continue;
    const entry = { ...rawEntry };
    const isSecurity = entry.mandatory === true || entry.origin === 'security';
    if (!isSecurity && sameTableName(entry.table, target) && String(entry.field).toLocaleLowerCase('pt-BR') === targetField.toLocaleLowerCase('pt-BR')) {
      excluded.push({ table: entry.table, field: entry.field, reason: 'self-filter' });
      continue;
    }
    if (!isSecurity && calendarDomainContextConflicts(target, targetField, entry)) {
      excluded.push({ table: entry.table, field: entry.field, reason: 'temporal-navigation-conflict' });
      continue;
    }
    if (sameTableName(entry.table, target)) {
      effective.push(entry);
      propagation.push({ from: entry.table, to: target, path: [target], direction: 'same-table' });
      continue;
    }
    const path = findFilterPropagationPath(semanticModel, entry.table, target);
    if (!path) {
      contextualCandidates.push(entry);
      continue;
    }
    effective.push(entry);
    propagation.push({
      from: entry.table,
      to: target,
      path: path.nodes,
      direction: path.relationships.map((rel) => String(rel.filterDirection || 'single').toLowerCase()),
      ambiguous: path.ambiguous === true
    });
  }
  const activeRelationships = Array.isArray(semanticModel && semanticModel.relationships)
    ? semanticModel.relationships.filter((rel) => rel && rel.active !== false)
    : [];
  const isDimensionContext = (entry) => activeRelationships.some((rel) => {
    if (sameTableName(rel.fromTable, entry.table)) return true;
    return String(rel.filterDirection || 'single').toLowerCase() === 'both' && sameTableName(rel.toTable, entry.table);
  });
  // A Calendario nativa permanece um eixo de navegação completo. A consulta
  // contextual existe para dimensões dependentes; não converte a dimensão de
  // tempo em uma lista dos meses que por acaso já possuem movimento.
  const contextualEligible = sameTableName(target, CALENDAR_TABLE_NAME)
    ? []
    : contextualCandidates.filter((entry) => entry.mandatory === true || entry.origin === 'security' || domainTable || isDimensionContext(entry));
  const contextualBlocked = contextualCandidates.filter((entry) => !contextualEligible.includes(entry));
  // Quando o relatório informa a tabela factual da página, todos os contextos
  // externos devem convergir na mesma linha dessa fato. Executar um EXISTS para
  // Empresa e outro para Calendário permitiria que cada um fosse satisfeito por
  // linhas diferentes, além de varrer a fato duas vezes. Calendário continua
  // sendo uma dimensão de navegação nativa quando ele próprio é o alvo.
  const explicitWitnessRequested = Boolean(domainTable)
    && !sameTableName(target, CALENDAR_TABLE_NAME)
    && !sameTableName(target, domainTable)
    && effective.some((entry) => !sameTableName(entry.table, target));
  const witnessEntries = explicitWitnessRequested
    ? effective.concat(contextualEligible)
    : contextualEligible.length ? effective.concat(contextualEligible) : [];
  const witness = witnessEntries.length
    ? findFilterDomainWitnessPlan(semanticModel, target, witnessEntries, domainTable)
    : null;
  if (witness) {
    contextualEligible.forEach((entry) => {
      effective.push(entry);
      const contextPath = witness.contextPaths.find((item) => sameTableName(item.table, entry.table));
      propagation.push({
        from: entry.table,
        to: target,
        via: witness.table,
        path: contextPath && contextPath.path && contextPath.path.nodes || [entry.table, witness.table, target],
        direction: 'contextual-domain',
        ambiguous: witness.ambiguous === true
      });
    });
    contextualBlocked.forEach((entry) => excluded.push({ table: entry.table, field: entry.field, reason: 'reverse-filter-not-allowed' }));
  } else {
    contextualCandidates.forEach((entry) => excluded.push({ table: entry.table, field: entry.field, reason: 'reverse-filter-not-allowed' }));
  }
  return {
    effective,
    excluded,
    propagation,
    witness,
    securityCount: effective.filter((entry) => entry.mandatory === true || entry.origin === 'security').length
  };
}

function calendarContextValueMatches(candidate, rawValue) {
  const raw = String(rawValue ?? '');
  if (raw.includes('||')) {
    const allowed = new Set(raw.split('||').map((value) => value.trim()).filter(Boolean));
    return allowed.has(String(candidate));
  }
  if (raw.includes('|')) {
    const parts = raw.split('|');
    const from = parts[0] || '';
    const to = parts[1] || '';
    const numericCandidate = Number(candidate);
    const numericFrom = Number(from);
    const numericTo = Number(to);
    const comparable = Number.isFinite(numericCandidate) && (from === '' || Number.isFinite(numericFrom)) && (to === '' || Number.isFinite(numericTo));
    if (comparable) return (from === '' || numericCandidate >= numericFrom) && (to === '' || numericCandidate <= numericTo);
    const text = String(candidate);
    return (from === '' || text >= from) && (to === '' || text <= to);
  }
  return String(candidate) === raw;
}

function distinctCalendarValuesWithContext(field, limit, contextEntries) {
  const columns = new Set(calendarColumnNames());
  if (!columns.has(field)) throw apiError('Campo nao encontrado para filtro: Calendario[' + field + ']', 400);
  const contexts = (contextEntries || []).filter((entry) => entry && sameTableName(entry.table, CALENDAR_TABLE_NAME) && columns.has(String(entry.field || '')));
  const virtual = calendarVirtualRows({});
  const seen = new Set();
  const values = [];
  for (const row of virtual.rows) {
    if (!contexts.every((entry) => calendarContextValueMatches(row[entry.field], entry.value))) continue;
    const value = row[field];
    if (value === null || value === undefined || value === '') continue;
    const key = String(value);
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(value);
  }
  values.sort((left, right) => String(left).localeCompare(String(right), 'pt-BR', { numeric: true }));
  return Number.isFinite(Number(limit)) && Number(limit) > 0 ? values.slice(0, Math.floor(Number(limit))) : values;
}

app.get('/api/filter-options', asyncHandler(async (req, res) => {
  const requestStartedAt = performance.now();
  const table = String(req.query.table || '').trim();
  const field = String(req.query.field || '').trim();
  const domainTable = String(req.query.domainTable || '').trim();
  const limit = filterOptionsLimit(req.query.limit);
  let clientContext = {};
  try { clientContext = req.query.contextFilters ? JSON.parse(String(req.query.contextFilters)) : {}; } catch (e) { clientContext = {}; }
  const clientContextEntries = Object.entries(clientContext || {}).map(([key, val]) => {
    if (val === null || val === undefined || val === '') return null;
    const dot = key.indexOf('.');
    if (dot <= 0) return null;
    return { table: key.slice(0, dot), field: key.slice(dot + 1), value: String(val), mandatory: false, origin: 'report' };
  }).filter(Boolean);
  const userContextEntries = req.authRole === 'admin'
    ? []
    : normalizeOnlineUserDataFilters(req.authUser && req.authUser.dataFilters).map((filter) => ({
      table: filter.table,
      field: filter.field,
      value: filter.value,
      mandatory: true,
      origin: 'security'
    }));
  const semanticModel = await readSemanticModel();
  const domainContext = filterDomainContextForTarget(table, field, clientContextEntries, userContextEntries, semanticModel, domainTable);
  const contextEntries = domainContext.effective;
  const hasContext = contextEntries.length > 0;
  const securityScope = userContextEntries.length ? stableJson(userContextEntries) : '';
  const effectiveClientContext = Object.fromEntries(contextEntries.filter((entry) => entry.origin !== 'security').map((entry) => [entry.table + '.' + entry.field, entry.value]));
  const diagnostics = {
    queryType: 'FILTER_DOMAIN_QUERY',
    filter: table + '[' + field + ']',
    selectedValues: clientContextEntries.map((entry) => ({ table: entry.table, field: entry.field, value: entry.value })),
    securityContext: userContextEntries.map((entry) => ({ table: entry.table, field: entry.field })),
    effectiveContext: contextEntries.map((entry) => ({ table: entry.table, field: entry.field, mandatory: entry.mandatory === true })),
    excluded: domainContext.excluded,
    relationshipPropagation: domainContext.propagation,
    reversePropagation: domainContext.witness ? 'CONTEXTUAL' : (domainContext.excluded.some((entry) => entry.reason === 'reverse-filter-not-allowed') ? 'BLOCKED' : 'NONE'),
    contextualWitness: domainContext.witness && domainContext.witness.table || '',
    queryBuildCount: 0
  };
  debugLog('[FILTRO] REQ table=' + table + ' field=' + field + ' requestedContext=' + clientContextEntries.length + ' effectiveContext=' + contextEntries.length + ' ctx=' + JSON.stringify(effectiveClientContext));
  if (!table) throw apiError('Tabela/view/consulta do filtro e obrigatoria.', 400);
  if (!field) throw apiError('Campo do filtro e obrigatorio.', 400);
  const optionsCacheKey = filterOptionsCacheKey(table, field, limit, stableJson(effectiveClientContext), securityScope, domainTable);
  const cachedOptions = getFilterOptionsCache(optionsCacheKey);
  if (cachedOptions) {
    debugLog('[FILTRO] CACHE HIT table=' + table + ' field=' + field + ' rows=' + cachedOptions.values.length);
    return res.json({
      ...cachedOptions,
      domainQuery: { ...(cachedOptions.domainQuery || {}), type: 'FILTER_DOMAIN_QUERY', target: table + '[' + field + ']', cacheHit: true },
      performance: { durationMs: Number((performance.now() - requestStartedAt).toFixed(3)), queryBuildCount: 0, cacheHit: true }
    });
  }
  const sendFilterOptions = (payload) => {
    const durationMs = Number((performance.now() - requestStartedAt).toFixed(3));
    diagnostics.durationMs = durationMs;
    diagnostics.resultCount = Array.isArray(payload && payload.values) ? payload.values.length : 0;
    diagnostics.cacheEngine = String(payload && payload.cacheEngine || (payload && payload.nativeCalendar ? 'native-calendar' : ''));
    debugLog('[FILTER DEBUG] ' + JSON.stringify(diagnostics));
    const orderedPayload = {
      ...payload,
      values: orderFilterOptionValues(table, field, payload && payload.values),
      domainQuery: {
        type: 'FILTER_DOMAIN_QUERY',
        target: table + '[' + field + ']',
        excludedSelfFilters: domainContext.excluded.filter((entry) => entry.reason === 'self-filter').length,
        reversePropagation: diagnostics.reversePropagation,
        relationshipPathCount: domainContext.propagation.length,
        contextualWitness: diagnostics.contextualWitness || '',
        contextualSemiJoin: Boolean(domainContext.witness)
      },
      performance: {
        durationMs,
        queryBuildCount: Number(diagnostics.queryBuildCount || 0),
        cacheHit: false
      }
    };
    setFilterOptionsCache(optionsCacheKey, orderedPayload);
    return res.json(orderedPayload);
  };

  // Para o proprio campo protegido, nao consulta uma fonte ampla: devolve
  // diretamente apenas o valor permitido ao usuario.
  const directUserRestrictions = userContextEntries.filter((entry) =>
    String(entry.table || '').toLocaleLowerCase('pt-BR') === table.toLocaleLowerCase('pt-BR')
    && String(entry.field || '').toLocaleLowerCase('pt-BR') === field.toLocaleLowerCase('pt-BR')
  );
  if (directUserRestrictions.length && !domainContext.witness) {
    const allowedValues = [];
    const seenAllowedValues = new Set();
    directUserRestrictions.forEach((entry) => {
      String(entry.value ?? '').split('||').forEach((value) => {
        const normalizedValue = String(value).trim();
        if (!normalizedValue || seenAllowedValues.has(normalizedValue)) return;
        seenAllowedValues.add(normalizedValue);
        allowedValues.push(serializeValue(normalizedValue));
      });
    });
    return sendFilterOptions({
      table,
      field,
      values: allowedValues,
      fromCache: true,
      cacheEngine: 'user-restriction',
      cascadeContext: true,
      userRestricted: true
    });
  }

  // Calendario e uma dimensao virtual nativa. Quando o contexto efetivo
  // pertence a propria dimensao, calcula o DISTINCT nela mesma; jamais usa
  // uma fato para descobrir quais datas/meses existem.
  if (sameTableName(table, CALENDAR_TABLE_NAME) && contextEntries.every((entry) => sameTableName(entry.table, CALENDAR_TABLE_NAME))) {
    diagnostics.queryBuildCount = 1;
    diagnostics.sql = 'CALENDAR_VIRTUAL_DISTINCT ' + table + '[' + field + ']';
    return sendFilterOptions({
      table,
      field,
      nativeCalendar: true,
      cacheEngine: 'native-calendar',
      cascadeContext: contextEntries.length > 0,
      userRestricted: userContextEntries.length > 0,
      values: distinctCalendarValuesWithContext(field, limit, contextEntries).map(serializeValue)
    });
  }

  // Filtros em cascata e restricoes obrigatorias do usuario.
  if (contextEntries.length) {
    let cascadeError = null;
    try {
      debugLog('[CASCADE] model=' + !!semanticModel + ' entries=' + JSON.stringify(contextEntries));
      if (semanticModel) {
        const values = await loadFilterOptionsWithContext(table, field, limit, contextEntries, semanticModel, { domainTable, diagnostics, witness: domainContext.witness });
        debugLog('[CASCADE] result=' + (values === null ? 'null' : (Array.isArray(values) ? values.length + ' rows' : typeof values)));
        if (values !== null) {
          debugLog('[FILTRO] CASCATA OK table=' + table + ' field=' + field + ' rows=' + (Array.isArray(values) ? values.length : '?') + ' engine=' + (values._engine || '?'));
          return sendFilterOptions({ table, field, values: values.map(serializeValue), fromCache: true, cacheEngine: values._engine || 'postgres', cascadeContext: true, userRestricted: userContextEntries.length > 0 });
        }
      }
    } catch (e) {
      cascadeError = e;
      debugLog('[CASCADE] error: ' + e.message);
    }
    // Segurança fail-closed: nunca retorna opcoes sem filtro quando o usuario possui restricao.
    if (domainContext.securityCount > 0) {
      return sendFilterOptions({ table, field, values: [], fromCache: true, cacheEngine: 'restricted', cascadeContext: true, userRestricted: true });
    }
    // Nao devolve uma lista ampla quando a cascata falha. Isso evita que outro
    // filtro pareca sem efeito e impede o usuario de selecionar combinacoes que
    // nao existem no contexto atual.
    const cascadeReason = cascadeError && cascadeError.message ? ' ' + cascadeError.message : '';
    debugLog('[CASCADE] Falha fechada para ' + table + '[' + field + '].' + cascadeReason);
    throw apiError('Nao foi possivel aplicar os filtros em cascata. Tente atualizar as opcoes novamente.', 409);
  }

  if (sameTableName(table, CALENDAR_TABLE_NAME)) {
    const columns = calendarColumnMetadata();
    if (!columns.some((col) => col.name === field)) throw apiError('Campo nao encontrado para filtro: ' + table + '[' + field + ']', 400);
    diagnostics.queryBuildCount = 1;
    diagnostics.sql = 'CALENDAR_VIRTUAL_DISTINCT ' + table + '[' + field + ']';
    return sendFilterOptions({ table, field, nativeCalendar: true, cacheEngine: 'native-calendar', values: distinctCalendarValues(field, limit).map(serializeValue) });
  }
  const transform = await findTransformByName(table);
  if (transform) {
    const built = await buildTransformSql(transform, { limit: 0 });
    if (!(built.columns || []).includes(field)) throw apiError('Campo nao encontrado na consulta transformada: ' + table + '[' + field + ']', 400);
    if (transform.daxExpression && postgresCacheAvailable()) {
      const calculatedMeta = await ensureDaxCalculatedTableView(transform);
      const calculatedColumn = findPgColumn(calculatedMeta.columns || [], field);
      if (!calculatedColumn) throw apiError('Campo nao encontrado na tabela DAX: ' + table + '[' + field + ']', 400);
      const pgResult = await pgCacheQuery(
        `SELECT DISTINCT ${quotePgIdent(calculatedColumn.name)} AS value FROM ${quotePgQualified(POSTGRES_CACHE_SCHEMA, calculatedMeta.cache_table)} WHERE ${quotePgIdent(calculatedColumn.name)} IS NOT NULL ORDER BY ${quotePgIdent(calculatedColumn.name)}${sqlLimitClause(limit, 1)}`,
        Number.isFinite(Number(limit)) && Number(limit) > 0 ? [Math.floor(Number(limit))] : []
      );
      return sendFilterOptions({ table, field, transform: true, calculatedDax: true, values: pgResult.rows.map((row) => serializeValue(row.value)), fromCache: true, cacheEngine: 'postgres-dax-table' });
    }
    // Consultas transformadas usam a relacao logica efetiva, nunca a origem bruta.
    if (postgresCacheAvailable() && transform.source) {
      try {
        const pgMeta = await getPgEffectiveMeta(table);
        if (pgMeta && pgMeta.cache_table) {
          const cacheTable = quotePgQualified(POSTGRES_CACHE_SCHEMA, pgMeta.cache_table);
          const params = [];
          const pgResult = await pgCacheQuery(
            `SELECT DISTINCT ${quotePgIdent(field)} AS value FROM ${cacheTable} WHERE ${quotePgIdent(field)} IS NOT NULL ORDER BY ${quotePgIdent(field)}${sqlLimitClause(limit, 1)}`,
            Number.isFinite(Number(limit)) && Number(limit) > 0 ? [Math.floor(Number(limit))] : params
          );
          if (pgResult.rows && pgResult.rows.length > 0) {
            return sendFilterOptions({ table, field, transform: true, values: pgResult.rows.map((row) => serializeValue(row.value)), fromCache: true, cacheEngine: 'postgres' });
          }
        }
      } catch (e) { /* fallback */ }
    }
    // Dados nao encontrados no cache. Retorna vazio.
    return sendFilterOptions({ table, field, transform: true, values: [] });
  }

  // Caminho rapido: filtros do app devem ler direto do cache PostgreSQL proprio.
  // Evita travar a tela em "Carregando opcoes..." quando o MySQL esta lento/ocupado.
  if (postgresCacheAvailable()) {
    try {
      const resolvedFilterTable = await resolvePgCacheLookup(table);
        const pgMeta = await getPgEffectiveMeta(table) || await getPgCacheMeta(resolvedFilterTable.table || table);
      if (pgMeta && pgMeta.cache_table) {
        const pgColumns = Array.isArray(pgMeta.columns) ? pgMeta.columns : [];
        const matchedColumn = pgColumns.find((col) => String(col && col.name || col || '').toLowerCase() === field.toLowerCase());
        if (pgColumns.length && !matchedColumn) {
          throw apiError('Campo nao encontrado no cache PostgreSQL para filtro: ' + table + '[' + field + ']', 400);
        }
        const pgField = String(matchedColumn && matchedColumn.name || field);
        const cacheTable = quotePgQualified(POSTGRES_CACHE_SCHEMA, pgMeta.cache_table);
        const pgResult = await pgCacheQuery(
          `SELECT DISTINCT ${quotePgIdent(pgField)} AS value FROM ${cacheTable} WHERE ${quotePgIdent(pgField)} IS NOT NULL ORDER BY ${quotePgIdent(pgField)}${sqlLimitClause(limit, 1)}`,
          Number.isFinite(Number(limit)) && Number(limit) > 0 ? [Math.floor(Number(limit))] : []
        );
        if (pgResult.rows && pgResult.rows.length > 0) {
          debugLog('[FILTRO] PG-cache fast path table=' + table + ' field=' + field + ' rows=' + pgResult.rows.length);
          return sendFilterOptions({ table, field, values: pgResult.rows.map((row) => serializeValue(row.value)), fromCache: true, cacheEngine: 'postgres', fastPath: true });
        }
      }
    } catch (e) {
      if (e && e.status) throw e;
      debugLog('[FILTRO] PG-cache fast path falhou table=' + table + ' field=' + field + ': ' + e.message);
    }
  }

  const meta = await ensureTableExists(table);
  const columns = await getColumns(table);
  if (!columns.some((col) => col.name === field)) throw apiError('Campo nao encontrado para filtro: ' + table + '[' + field + ']', 400);
  const physicalTableName = meta.physicalName || meta.name || table;

  // Tenta cache PostgreSQL primeiro para opcoes de filtro
  if (postgresCacheAvailable()) {
    try {
      const resolvedFilterTable = await resolvePgCacheLookup(table);
      const pgMeta = await getPgEffectiveMeta(table) || await getPgCacheMeta(resolvedFilterTable.table || table);
      if (pgMeta && pgMeta.cache_table) {
        const cacheTable = quotePgQualified(POSTGRES_CACHE_SCHEMA, pgMeta.cache_table);
        const pgResult = await pgCacheQuery(
          `SELECT DISTINCT ${quotePgIdent(field)} AS value FROM ${cacheTable} WHERE ${quotePgIdent(field)} IS NOT NULL ORDER BY ${quotePgIdent(field)}${sqlLimitClause(limit, 1)}`,
          Number.isFinite(Number(limit)) && Number(limit) > 0 ? [Math.floor(Number(limit))] : []
        );
        if (pgResult.rows && pgResult.rows.length > 0) {
          debugLog('[FILTRO] PG-cache (sem cascata) table=' + table + ' field=' + field + ' rows=' + pgResult.rows.length);
          return sendFilterOptions({ table, field, values: pgResult.rows.map((row) => serializeValue(row.value)), fromCache: true, cacheEngine: 'postgres' });
        }
      }
    } catch (e) { /* fallback */ }
  }

  // Dados nao encontrados no cache PostgreSQL. Retorna vazio.
  debugLog('[FILTRO] FALLBACK table=' + table + ' field=' + field + ' -> nao encontrado no PG cache');
  sendFilterOptions({ table, field, values: [] });
}));

app.post('/api/debug-log', asyncHandler(async (req, res) => {
  debugLog('[CLIENT-DEBUG] POST endpoint hit, body=' + JSON.stringify(req.body || {}));
  const msg = String(req.body && req.body.message || '').trim();
  if (msg) debugLog('[CLIENT] ' + msg);
  res.json({ ok: true });
}));

app.get('/api/debug-log', asyncHandler(async (req, res) => {
  const msg = String(req.query.message || '').trim();
  if (msg) debugLog('[CLIENT] ' + msg);
  res.json({ ok: true });
}));

app.post('/api/native/calendar/ensure', requireDesktopAdmin, asyncHandler(async (req, res) => {
  const result = await ensureCalendarTable(req.body || {});
  res.status(201).json({ ok: true, ...result });
}));




app.get('/api/imported-tables', requireDesktopAdmin, asyncHandler(async (req, res) => {
  const items = await readImportedTables();
  const manualTableSet = new Set((await readManualTables()).map(function(t) { return String(t || '').toLowerCase(); }));
  const filtered = items.filter(function(item) { return !manualTableSet.has(String(item.name || '').toLowerCase()); });
  if (filtered.length < items.length) {
    await writeImportedTables(filtered);
  }
  res.json({ ok: true, imported: filtered, count: filtered.length });
}));

app.post('/api/imported-tables', requirePermission('reportEditing', 'Inserir dados do MySQL'), asyncHandler(async (req, res) => {
  const sourceTable = String(req.body.sourceTable || '').trim();
  const name = normalizeImportedTableName(req.body.name || sourceTable);
  if (!sourceTable) throw apiError('Selecione a tabela de origem do MySQL.', 400);
  if (!name) throw apiError('Informe um nome valido para a tabela no app.', 400);
  quoteIdent(name);
  const physical = await findDatabaseResourceByName(sourceTable);
  if (!physical) throw apiError('Tabela de origem nao encontrada no MySQL: ' + sourceTable, 404);
  const reserved = new Set([CALENDAR_TABLE_NAME.toLowerCase()]);
  if (reserved.has(name.toLowerCase())) throw apiError('Nome reservado pelo BI WA: ' + name, 400);
  const manualTables = new Set(await readManualTables());
  const transforms = await readTransforms();
  if (manualTables.has(name)) throw apiError('Ja existe uma tabela manual com esse nome: ' + name, 400);
  if (transforms.some((item) => item.name.toLowerCase() === name.toLowerCase())) throw apiError('Ja existe uma consulta transformada com esse nome: ' + name, 400);
  const now = new Date().toISOString();
  const current = await readImportedTables();
  const idx = current.findIndex((item) => item.name.toLowerCase() === name.toLowerCase());
  let autoHidden = '';
  if (idx < 0) {
    const existingPhysical = await findDatabaseResourceByName(name);
    if (existingPhysical && String(existingPhysical.name || '').toLowerCase() !== String(physical.name || '').toLowerCase()) {
      const hidden = await readHiddenTables();
      if (!hidden.some((h) => h.name.toLowerCase() === existingPhysical.name.toLowerCase())) {
        hidden.push({ name: existingPhysical.name, type: normalizeTableType(existingPhysical.tableType), hiddenAt: now, note: 'Ocultada automaticamente ao importar ' + name });
        await writeHiddenTables(hidden);
        autoHidden = existingPhysical.name;
      }
    }
  }
  const incoming = { name, sourceTable: physical.name || sourceTable, note: String(req.body.note || '').trim(), createdAt: idx >= 0 ? current[idx].createdAt : now, updatedAt: now };
  if (idx >= 0) current[idx] = incoming;
  else current.push(incoming);
  await writeImportedTables(current);
  clearQueryCache('imported-tables');
  const pgSyncStarted = postgresCacheAvailable();
  if (pgSyncStarted) {
    syncTableToPgCacheIfAvailable(physical.name || sourceTable, 'full').catch((err) => {
      console.error('[PG Cache] Erro ao sincronizar tabela importada', physical.name || sourceTable + ':', err.message);
    });
  }
  res.status(idx >= 0 ? 200 : 201).json({ ok: true, imported: incoming, resource: importedResourceMeta(incoming, physical), pgCacheSync: pgSyncStarted ? 'started' : 'unavailable', autoHidden });
}));

app.put('/api/imported-tables/:name', requirePermission('reportEditing', 'Atualizar tabela inserida'), asyncHandler(async (req, res) => {
  const oldName = String(req.params.name || '').trim();
  const sourceTable = String(req.body.sourceTable || '').trim();
  const name = normalizeImportedTableName(req.body.name || oldName);
  if (!oldName) throw apiError('Informe a tabela inserida que sera atualizada.', 400);
  if (!sourceTable) throw apiError('Selecione a tabela de origem do MySQL.', 400);
  if (!name) throw apiError('Informe um nome valido para a tabela no app.', 400);
  quoteIdent(name);
  const isCalendar = sourceTable === CALENDAR_TABLE_NAME || name === CALENDAR_TABLE_NAME;
  let physical = null;
  if (isCalendar) {
    physical = { name: CALENDAR_TABLE_NAME, tableType: 'BASE TABLE', source: 'native' };
  } else {
    // Salvar modelagem/formato de uma tabela ja cacheada nao deve abrir uma
    // conexao MySQL. A origem so e consultada ao trocar efetivamente de tabela.
    let cachedImported = null;
    try {
      const importedSnapshot = await readImportedTables();
      cachedImported = importedSnapshot.find((item) => item.name === oldName || item.name.toLowerCase() === oldName.toLowerCase()) || null;
      if (cachedImported && String(cachedImported.sourceTable || '').toLowerCase() === sourceTable.toLowerCase()) {
        const cachedMeta = await getPgCacheMeta(cachedImported.sourceTable);
        if (cachedMeta && cachedMeta.cache_table) physical = { name: cachedImported.sourceTable, tableType: 'BASE TABLE', source: 'postgres-cache' };
      }
    } catch (cacheLookupError) {}
    if (!physical) physical = await findDatabaseResourceByName(sourceTable);
    if (!physical) throw apiError('Tabela de origem nao encontrada no MySQL: ' + sourceTable, 404);
  }
  const reserved = new Set([CALENDAR_TABLE_NAME.toLowerCase()]);
  if (reserved.has(name.toLowerCase()) && !isCalendar) throw apiError('Nome reservado pelo BI WA: ' + name, 400);
  const current = await readImportedTables();
  let idx = current.findIndex((item) => item.name === oldName || item.name.toLowerCase() === oldName.toLowerCase());
  // Auto-cria entrada para Calendario se nao existir
  if (idx < 0 && isCalendar && oldName === CALENDAR_TABLE_NAME) {
    current.push({
      name: CALENDAR_TABLE_NAME,
      sourceTable: CALENDAR_TABLE_NAME,
      note: 'Tabela nativa do BI WA',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      rowFilter: null,
      dateFilter: null,
      steps: []
    });
    idx = current.length - 1;
  }
  if (idx < 0) throw apiError('Tabela inserida nao encontrada para atualizar: ' + oldName, 404);
  const duplicate = current.find((item, itemIdx) => itemIdx !== idx && item.name.toLowerCase() === name.toLowerCase());
  if (duplicate) throw apiError('Ja existe outra tabela inserida com esse nome no app: ' + name, 400);
  const existingPhysical = physical && physical.source === 'postgres-cache'
    ? physical
    : await findDatabaseResourceByName(name);
  const manualTables = new Set(await readManualTables());
  const transforms = await readTransforms();
  if (existingPhysical && String(existingPhysical.name || '').toLowerCase() !== String(physical.name || '').toLowerCase()) throw apiError('Ja existe uma tabela/view fisica com esse nome: ' + name, 400);
  if (manualTables.has(name)) throw apiError('Ja existe uma tabela manual com esse nome: ' + name, 400);
  if (transforms.some((item) => item.name.toLowerCase() === name.toLowerCase())) throw apiError('Ja existe uma consulta transformada com esse nome: ' + name, 400);
  const previous = current[idx];
  const incoming = {
    name,
    sourceTable: physical.name || sourceTable,
    note: String(req.body.note || '').trim(),
    createdAt: previous.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    rowFilter: req.body.rowFilter !== undefined
      ? (req.body.rowFilter && typeof req.body.rowFilter === 'object' ? { column: String(req.body.rowFilter.column || '').trim(), values: Array.isArray(req.body.rowFilter.values) ? req.body.rowFilter.values.map(String).filter(Boolean) : [] } : null)
      : (previous.rowFilter || null),
    dateFilter: req.body.dateFilter !== undefined
      ? (req.body.dateFilter && typeof req.body.dateFilter === 'object' ? { column: String(req.body.dateFilter.column || '').trim(), start: String(req.body.dateFilter.start || '').trim(), end: String(req.body.dateFilter.end || '').trim() } : null)
      : (previous.dateFilter || null),
    steps: Array.isArray(req.body.steps) ? req.body.steps.map(normalizeTransformStep).filter(Boolean) : (Array.isArray(previous.steps) ? previous.steps : []),
    incrementalColumn: req.body.incrementalColumn !== undefined ? (String(req.body.incrementalColumn || '').trim() || null) : (previous.incrementalColumn !== undefined ? previous.incrementalColumn : null)
  };
  current[idx] = incoming;
  await writeImportedTables(current);
  var previousModelSteps = pgImportedEffectiveSteps(previous);
  var incomingModelSteps = pgImportedEffectiveSteps(incoming);
  var modelStepsChanged = JSON.stringify(previousModelSteps) !== JSON.stringify(incomingModelSteps)
    || String(previous.sourceTable || '').toLowerCase() !== String(incoming.sourceTable || '').toLowerCase();
  var effectiveModel = null;
  if (modelStepsChanged && postgresCacheAvailable() && !isCalendar) {
    try {
      effectiveModel = await refreshPgModelView(incoming);
    } catch (modelError) {
      current[idx] = previous;
      await writeImportedTables(current);
      try { await refreshPgModelView(previous); } catch (restoreError) {}
      throw apiError('A modelagem nao foi salva para proteger os relatorios: ' + modelError.message, 400);
    }
  }
  const migrated = await migrateImportedTableAliasReferences(previous.name, incoming.name);
  resourceListCache = { key: '', savedAt: 0, resources: [], diagnostics: [] };
  clearQueryCache('imported-tables');
  clearQueryCache('reports');
  clearQueryCache('model');
  res.json({ ok: true, imported: incoming, previousName: previous.name, migrated, resource: importedResourceMeta(incoming, physical), postgresModel: effectiveModel ? { active: true, view: effectiveModel.cache_table, columns: effectiveModel.columns.length, steps: effectiveModel.modeling_steps } : { active: incomingModelSteps.length > 0 } });
  var stepsChanged = JSON.stringify(physicalChangeTypeSteps(previous.steps)) !== JSON.stringify(physicalChangeTypeSteps(incoming.steps));
  var sourceChanged = String(previous.sourceTable || '').toLowerCase() !== String(physical.name || '').toLowerCase();
  if (sourceChanged || stepsChanged) {
    if (stepsChanged) console.log('[PG Cache] changeType steps alterados para ' + name + ' â€” disparando full resync');
    const pgSyncStarted = postgresCacheAvailable();
    if (pgSyncStarted) {
      syncTableToPgCacheIfAvailable(physical.name || sourceTable, 'full').catch((err) => {
        console.error('[PG Cache] Erro ao resincronizar tabela atualizada', physical.name || sourceTable + ':', err.message);
      });
    }
  }
}));

app.delete('/api/imported-tables/:name', requirePermission('reportEditing', 'Remover tabela inserida'), asyncHandler(async (req, res) => {
  const name = String(req.params.name || '').trim();
  const current = await readImportedTables();
  const item = current.find((i) => i.name === name || i.name.toLowerCase() === name.toLowerCase());
  const next = current.filter((item) => item.name !== name && item.name.toLowerCase() !== name.toLowerCase());
  await writeImportedTables(next);
  clearQueryCache('imported-tables');
  resourceListCache = { key: '', savedAt: 0, resources: [], diagnostics: [] };
  // Remove tambem o cache PostgreSQL para evitar que autoImportUnimportedTables recrie a tabela
  if (item && item.sourceTable && postgresCacheAvailable()) {
    try { await clearPostgresCacheForTable(item.sourceTable); } catch (e) { console.error('[PG Cache] Erro ao limpar cache da tabela removida ' + item.sourceTable + ':', e.message); }
  }
  res.json({ ok: true, count: next.length });
}));

app.get('/api/hidden-tables', requireDesktopAdmin, asyncHandler(async (req, res) => {
  const hidden = await readHiddenTables();
  res.json({ ok: true, hidden, count: hidden.length });
}));

app.post('/api/hidden-tables', requirePermission('reportEditing', 'Ocultar tabela do app'), asyncHandler(async (req, res) => {
  const sourceTable = String(req.body.sourceTable || req.body.name || '').trim();
  if (!sourceTable) throw apiError('Selecione a tabela/view que sera removida apenas do app.', 400);
  if (sourceTable === CALENDAR_TABLE_NAME) throw apiError('A tabela Calendario e nativa do BI WA e nao pode ser ocultada.', 400);
  const physical = await findDatabaseResourceByName(sourceTable);
  if (!physical) throw apiError('Tabela/view nao encontrada no MySQL: ' + sourceTable, 404);
  const manualTables = new Set(await readManualTables());
  if (manualTables.has(physical.name)) throw apiError('Tabela manual nao deve ser ocultada por aqui. Use o gerenciador de tabelas manuais.', 400);
  const hidden = await readHiddenTables();
  const idx = hidden.findIndex((item) => item.name.toLowerCase() === String(physical.name).toLowerCase());
  const incoming = { name: physical.name, type: normalizeTableType(physical.tableType) === 'view' ? 'view' : 'table', hiddenAt: idx >= 0 ? hidden[idx].hiddenAt : new Date().toISOString(), note: String(req.body.note || '').trim() };
  if (idx >= 0) hidden[idx] = incoming;
  else hidden.push(incoming);
  const saved = await writeHiddenTables(hidden);
  const imported = await readImportedTables();
  const importedNext = imported.filter((item) => String(item.sourceTable || '').toLowerCase() !== String(physical.name || '').toLowerCase());
  if (importedNext.length !== imported.length) await writeImportedTables(importedNext);
  resourceListCache = { key: '', savedAt: 0, resources: [], diagnostics: [] };
  clearQueryCache('hidden-tables');
  clearQueryCache('imported-tables');
  // Remove tambem o cache PostgreSQL para evitar que autoImportUnimportedTables recrie a tabela
  if (postgresCacheAvailable()) {
    try { await clearPostgresCacheForTable(physical.name); } catch (e) { console.error('[PG Cache] Erro ao limpar cache da tabela oculta ' + physical.name + ':', e.message); }
  }
  res.status(idx >= 0 ? 200 : 201).json({ ok: true, hidden: incoming, hiddenTables: saved, removedAliases: imported.length - importedNext.length });
}));

app.delete('/api/hidden-tables/:name', requirePermission('reportEditing', 'Restaurar tabela no app'), asyncHandler(async (req, res) => {
  const name = String(req.params.name || '').trim();
  const hidden = await readHiddenTables();
  const next = hidden.filter((item) => item.name !== name && item.name.toLowerCase() !== name.toLowerCase());
  await writeHiddenTables(next);
  resourceListCache = { key: '', savedAt: 0, resources: [], diagnostics: [] };
  clearQueryCache('hidden-tables');
  res.json({ ok: true, count: next.length });
}));

app.get('/api/transforms/diagnostics', requireDesktopAdmin, asyncHandler(async (req, res) => {
  const transforms = await readTransforms();
  const stepCounts = {};
  const issues = [];
  for (const t of transforms) {
    for (const step of (t.steps || [])) stepCounts[step.kind] = (stepCounts[step.kind] || 0) + 1;
    try { await buildTransformSql(t, { limit: 1, skipImportedSteps: true }); }
    catch (err) { issues.push({ id: t.id, name: t.name, source: t.source, message: err.message || String(err) }); }
  }
  res.json({ ok: true, count: transforms.length, stepCounts, issues, validCount: transforms.length - issues.length });
}));

app.get('/api/transforms', requireDesktopAdmin, asyncHandler(async (req, res) => {
  const transforms = await readTransforms();
  res.json({ transforms });
}));

// Transformacao do Calendario em memoria - nao depende de PG/MySQL.
// Aplica os passos de transformacao diretamente sobre os dados virtuais.
async function previewCalendarTransform(steps, limit) {
  const virtual = calendarVirtualRows({});
  const allRows = virtual.rows || [];
  if (!allRows.length) return null;
  const colNames = calendarColumnNames();
  let rows = allRows.slice(0, Math.min(limit || 200, allRows.length));
  let columns = [...colNames];
  console.log('[Cal Transform] rows=' + rows.length + ' cols=' + columns.length + ' steps=' + (steps || []).length);
  // Mapa de tipo original das colunas (para changeType saber o tipo fonte)
  const colType = {};
  for (const c of calendarColumnMetadata()) {
    colType[c[0]] = c[1]; // nome -> tipo (inteiro, data, texto, etc)
  }
  for (const step of (steps || [])) {
    const kind = step.kind;
    console.log('[Cal Transform] step kind=' + kind + ' col=' + step.column + ' dataType=' + step.dataType);
    if (kind === 'changeType' && step.column) {
      const col = step.column;
      const targetType = String(step.dataType || '').toLowerCase();
      console.log('[Cal Transform] changeType col=' + col + ' targetType=' + targetType + ' sampleVal=' + JSON.stringify(rows[0][col]));
      rows = rows.map((row) => {
        const val = row[col];
        let converted = val;
        if (targetType === 'data' || targetType === 'date') {
          // Converte inteiro YYYYMMDD (DataKey) para string ISO de data
          if (typeof val === 'number' && val >= 19000101 && val <= 22001231) {
            const s = String(val);
            converted = s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
          } else if (val instanceof Date) {
            converted = val.toISOString().slice(0, 10);
          }
          // Se ja for string ISO, mantem
        } else if (targetType === 'datetime' || targetType === 'timestamp') {
          if (typeof val === 'number' && val >= 19000101 && val <= 22001231) {
            const s = String(val);
            converted = s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) + ' 00:00:00';
          } else if (val instanceof Date) {
            converted = val.toISOString().replace('T', ' ').slice(0, 19);
          }
        } else if (targetType === 'inteiro' || targetType === 'int' || targetType === 'integer') {
          var intVal = toNumber(val);
          converted = intVal !== null ? Math.trunc(intVal) : val;
        } else if (targetType === 'numero' || targetType === 'number' || targetType === 'decimal') {
          var decVal = toNumber(val);
          converted = decVal !== null ? decVal : val;
        } else if (targetType === 'texto' || targetType === 'text' || targetType === 'char') {
          converted = String(val ?? '');
        } else if (targetType === 'hora' || targetType === 'time') {
          // Converte numero (segundos ou HHMMSS) ou string para formato de hora
          if (typeof val === 'number' && val >= 0 && val < 240000) {
            const s = String(val).padStart(6, '0');
            converted = s.slice(0, 2) + ':' + s.slice(2, 4) + ':' + s.slice(4, 6);
          } else if (typeof val === 'string' && /^\d{2}:\d{2}/.test(val)) {
            converted = val;
          }
        } else if (targetType === 'bool' || targetType === 'boolean') {
          if (typeof val === 'number') converted = val !== 0;
          else if (typeof val === 'string') converted = val.toLowerCase() === 'true' || val === '1';
          else converted = Boolean(val);
        }
        return { ...row, [col]: converted };
      });
      console.log('[Cal Transform] changeType done - sample after: ' + JSON.stringify(rows[0][col]));
    }
    if (kind === 'selectColumns' && Array.isArray(step.columns)) {
      const keep = new Set(step.columns.filter((c) => columns.includes(c)));
      if (keep.size) {
        columns = columns.filter((c) => keep.has(c));
        rows = rows.map((row) => {
          const out = {};
          for (const c of columns) out[c] = row[c];
          return out;
        });
      }
    }
    if (kind === 'removeColumns' && Array.isArray(step.columns)) {
      const remove = new Set(step.columns);
      columns = columns.filter((c) => !remove.has(c));
      rows = rows.map((row) => {
        const out = {};
        for (const c of columns) out[c] = row[c];
        return out;
      });
    }
    if (kind === 'renameColumn' && step.column && step.newName) {
      const idx = columns.indexOf(step.column);
      if (idx >= 0) {
        columns[idx] = step.newName;
        rows = rows.map((row) => {
          const out = {};
          for (const c of columns) {
            out[c] = c === step.newName ? row[step.column] : row[c];
          }
          return out;
        });
      }
    }
    if (kind === 'sortRows' && step.column && columns.includes(step.column)) {
      const dir = step.direction === 'DESC' ? -1 : 1;
      rows = [...rows].sort((a, b) => {
        const va = a[step.column], vb = b[step.column];
        if (va < vb) return -dir;
        if (va > vb) return dir;
        return 0;
      });
    }
    if (kind === 'removeDuplicates') {
      const seen = new Set();
      rows = rows.filter((row) => {
        const key = columns.map((c) => String(row[c] ?? '')).join('\x00');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
  }
  // Aplica LIMIT final
  if (rows.length > (limit || 200)) rows = rows.slice(0, limit || 200);
  const fields = columns.map((name) => ({ name, type: 'text' }));
  return { ok: true, sql: '', rows: serializeRows(rows), fields, columns, fromCache: true, cacheEngine: 'calendar-native', message: 'Calendario em memoria - ' + rows.length + ' linha(s) transformada(s)' };
}

app.post('/api/transforms/preview', requireDesktopAdmin, asyncHandler(async (req, res) => {
  const transform = normalizeTransformQuery({
    id: req.body.id || 'preview',
    name: req.body.name || 'Prévia',
    source: req.body.source,
    steps: req.body.steps || []
  });
  const hasModelingSteps = transform && (transform.steps || []).some(isPgModelingStep);
  const onlyModelingAndFormatting = transform && (transform.steps || []).every((step) => isPgModelingStep(step) || step.kind === 'changeType');
  if (hasModelingSteps && onlyModelingAndFormatting) {
    const calculatedTransform = await findTransformByName(transform.source);
    if (calculatedTransform && calculatedTransform.daxExpression) {
      return res.json(await previewDaxCalculatedModelingSteps(calculatedTransform, transform.steps, req.body.limit || 200));
    }
    return res.json(await previewPgModelingSteps(transform.source, transform.steps, req.body.limit || 200));
  }
  if (!transform) throw apiError('Informe nome, origem e etapas da transformação.', 400);
  // Calendario: tabela nativa/virtual do BI WA. Transforma em memoria,
  // sem depender de PG/MySQL. Evita o UNION ALL pesado do calendarDerivedSql.
  const isCal = String(transform.source || '').trim().toLowerCase() === CALENDAR_TABLE_NAME.toLowerCase();
  console.log('[Cal Transform] source=' + transform.source + ' isCal=' + isCal + ' steps=' + (transform.steps || []).length);
  if (isCal) {
    const calResult = await previewCalendarTransform(transform.steps, req.body.limit || 200);
    console.log('[Cal Transform] result rows=' + (calResult ? calResult.rows.length : 'null'));
    if (calResult) return res.json(calResult);
    // Se o in-memory falhar, cai no fluxo normal abaixo
  }
  const built = await buildTransformSql(transform, { limit: req.body.limit || 200, skipImportedSteps: true });
  // Verifica rowFilter da tabela de origem
  let rowFilter = null;
  let dateFilter = null;
  if (transform.source) {
    try {
      const importedTbl = await findImportedTableByName(transform.source);
      if (importedTbl && importedTbl.rowFilter && importedTbl.rowFilter.column && Array.isArray(importedTbl.rowFilter.values) && importedTbl.rowFilter.values.length) {
        rowFilter = importedTbl.rowFilter;
      }
      if (importedTbl && importedTbl.dateFilter && importedTbl.dateFilter.column) {
        dateFilter = importedTbl.dateFilter;
      }
    } catch (e) { /* ignora */ }
  }
  // Tenta cache PostgreSQL antes de MySQL para transforms simples
  if (postgresCacheAvailable()) {
    try {
      const pgResult = await tryRunSelectFromPostgresCache(built.sql, req.body.limit || 200, { builtFilters: { params: built.params || [] } });
      if (pgResult && Array.isArray(pgResult.rows) && pgResult.rows.length > 0) {
        let rows = serializeRows(pgResult.rows || []);
        if (rowFilter || dateFilter) rows = applyRowFilterToRows(rows, rowFilter, dateFilter);
        var previewColumnFormats = buildColumnFormatsFromImported(transform.source);
        try {
          var previewEffectiveMeta = await getPgEffectiveMeta(transform.source);
          if (previewEffectiveMeta && Array.isArray(previewEffectiveMeta.columns)) {
            previewColumnFormats = buildColumnFormatsForTable(transform.source, previewEffectiveMeta.columns);
          }
        } catch (formatErr) { /* a previa continua mesmo sem metadados de formato */ }
        return res.json({ ok: true, sql: built.sql, rows, fields: (pgResult.fields || []).map((f) => ({ name: f.name, type: f.type || 'text' })), columns: built.columns, columnFormats: previewColumnFormats, fromCache: true, cacheEngine: 'postgres' });
      }
    } catch (e) { /* fallback */ }
  }
  // Dados nao encontrados no cache PostgreSQL.
  res.json({ ok: true, sql: built.sql, rows: [], fields: [], columns: built.columns, message: 'Dados ainda nao sincronizados no PostgreSQL.' });
}));

app.post('/api/transforms/modeling/test', requireDesktopAdmin, asyncHandler(async (req, res) => {
  const source = String(req.body && req.body.source || '').trim();
  const formula = String(req.body && req.body.formula || '').trim();
  if (!source) throw apiError('Selecione a tabela da coluna DAX.', 400);
  const definition = parseDaxColumnDefinition(formula);
  const imported = await findImportedTableByName(source);
  const calculatedTransform = imported ? null : await findTransformByName(source);
  if (!imported && !(calculatedTransform && calculatedTransform.daxExpression)) {
    throw apiError('Selecione uma tabela importada ou uma tabela calculada DAX para adicionar a coluna.', 400);
  }
  const existing = Array.isArray(req.body && req.body.steps)
    ? req.body.steps.map(normalizeTransformStep).filter(Boolean)
    : ((imported || calculatedTransform).steps || []);
  const withoutEdited = existing.filter((step) => !(step.kind === 'daxColumn' && pgModelKey(step.newName) === pgModelKey(definition.name)));
  const step = normalizeTransformStep({ kind: 'daxColumn', newName: definition.name, expression: definition.formula });
  const nextSteps = withoutEdited.concat(step);
  const preview = imported
    ? await previewPgModelingSteps(source, nextSteps, Math.min(20, Number(req.body && req.body.limit || 10)))
    : await previewDaxCalculatedModelingSteps(calculatedTransform, nextSteps, Math.min(20, Number(req.body && req.body.limit || 10)));
  res.json({ ok: true, valid: true, definition, step, preview });
}));

app.post('/api/transforms/dax-table/test', requireDesktopAdmin, asyncHandler(async (req, res) => {
  const formula = String(req.body && (req.body.formula || req.body.daxExpression) || '').trim();
  const definition = parseDaxCalculatedTableDefinition(formula);
  const transform = normalizeTransformQuery({
    id: 'dax-table-preview',
    daxExpression: definition.formula,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const projection = await buildDaxCalculatedTableProjection(transform);
  const limit = Math.max(1, Math.min(20, Number(req.body && req.body.limit || 8)));
  const result = await pgCacheQueryWithTimeout('SELECT * FROM (' + projection.sql + ') bi_dax_preview LIMIT $1', [limit], 20000);
  res.json({
    ok: true,
    valid: true,
    definition: { name: definition.name, formula: definition.formula },
    dependencies: projection.dependencies,
    columns: projection.columns,
    preview: {
      rows: serializeRows(result.rows || []),
      fields: (result.fields || []).map((field) => ({ name: field.name })),
      cacheEngine: 'postgres-dax-table'
    }
  });
}));

app.post('/api/transforms', requirePermission('reportEditing', 'Criacao de transformacoes'), asyncHandler(async (req, res) => {
  const current = await readTransforms();
  const now = new Date().toISOString();
  const incoming = normalizeTransformQuery({ ...req.body, updatedAt: now, createdAt: req.body.createdAt || now });
  const incomingKey = String(incoming && incoming.name || '').toLocaleLowerCase('pt-BR');
  const idx = current.findIndex((item) => item.id === (incoming && incoming.id) || String(item.name || '').toLocaleLowerCase('pt-BR') === incomingKey);
  if (!incoming) throw apiError('Transformação inválida.', 400);
  if (incoming.daxExpression) {
    if (incoming.name === CALENDAR_TABLE_NAME) throw apiError('Nome reservado pelo BI WA: ' + incoming.name, 409);
    const imported = await findImportedTableByName(incoming.name);
    if (imported) throw apiError('Ja existe uma tabela importada com esse nome: ' + incoming.name, 409);
    const manualNames = await readManualTables();
    if (manualNames.some((name) => String(name || '').toLocaleLowerCase('pt-BR') === incomingKey)) {
      throw apiError('Ja existe uma tabela manual com esse nome: ' + incoming.name, 409);
    }
    const rawPgMeta = await getPgCacheMeta(incoming.name);
    if (rawPgMeta) throw apiError('Ja existe uma tabela PostgreSQL com esse nome: ' + incoming.name, 409);
  }
  // Valida antes de salvar.
  await buildTransformSql(incoming, { limit: 1, skipImportedSteps: true });
  if (idx >= 0) current[idx] = { ...current[idx], ...incoming, updatedAt: now };
  else current.push(incoming);
  await writeTransforms(current);
  resourceListCache = { key: '', savedAt: 0, resources: [], diagnostics: [] };
  clearQueryCache('transform-change');
  res.status(idx >= 0 ? 200 : 201).json({ transform: idx >= 0 ? current[idx] : incoming });
}));

app.delete('/api/transforms/:id', requirePermission('reportEditing', 'Criacao de transformacoes'), asyncHandler(async (req, res) => {
  const current = await readTransforms();
  const removed = current.find((item) => item.id === req.params.id || item.name === req.params.id);
  const next = current.filter((item) => item.id !== req.params.id && item.name !== req.params.id);
  await writeTransforms(next);
  if (removed && removed.daxExpression && postgresCacheAvailable()) {
    try {
      const projection = await buildDaxCalculatedTableProjection(removed);
      await pgCacheQuery('DROP VIEW IF EXISTS ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, daxCalculatedTableViewName(removed, projection)));
    } catch (err) {
      console.warn('[DAX Table] Nao foi possivel remover a view calculada:', err.message);
    }
  }
  resourceListCache = { key: '', savedAt: 0, resources: [], diagnostics: [] };
  clearQueryCache('transform-change');
  res.json({ ok: true, count: next.length });
}));

app.post('/api/tables', requirePermission('schemaChanges', 'Criacao de tabelas'), asyncHandler(async (req, res) => {
  const tableName = String(req.body.name || '').trim();
  const columns = Array.isArray(req.body.columns) ? req.body.columns : [];
  if (!tableName) throw apiError('Informe o nome da tabela.', 400);
  if (tableName.length > 63) throw apiError('O nome da tabela deve ter no maximo 63 caracteres.', 400);
  if (tableName === CALENDAR_TABLE_NAME) throw apiError('Nome reservado pelo BI WA.', 400);
  if (!columns.length) throw apiError('Informe pelo menos uma coluna.', 400);
  const names = new Set();
  for (const col of columns) {
    const columnName = String(col && col.name || '').trim();
    if (!columnName) throw apiError('Todas as colunas precisam ter nome.', 400);
    if (columnName.length > 63) throw apiError('O nome da coluna deve ter no maximo 63 caracteres: ' + columnName, 400);
    const columnKey = columnName.toLowerCase();
    if (names.has(columnKey)) throw apiError('Coluna duplicada: ' + columnName, 400);
    names.add(columnKey);
  }
  if (!postgresCacheAvailable()) throw apiError('O cache PostgreSQL nao esta disponivel. Tabelas manuais exigem PostgreSQL ativo.', 503);

  const manualTables = await readManualTables();
  if (manualTables.some(function(name) { return String(name || '').toLowerCase() === tableName.toLowerCase(); })) {
    throw apiError('Ja existe uma tabela manual com esse nome: ' + tableName, 409);
  }
  const importedTables = await readImportedTables();
  if (importedTables.some(function(item) { return String(item && item.name || '').toLowerCase() === tableName.toLowerCase(); })) {
    throw apiError('Ja existe uma tabela inserida com esse nome no app: ' + tableName, 409);
  }
  const transforms = await readTransforms();
  if (transforms.some(function(item) { return String(item && item.name || '').toLowerCase() === tableName.toLowerCase(); })) {
    throw apiError('Ja existe uma consulta transformada com esse nome: ' + tableName, 409);
  }
  const existingPgRelation = await pgCacheQuery(
    'SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND LOWER(table_name) = LOWER($2) LIMIT 1',
    [POSTGRES_CACHE_SCHEMA, tableName]
  );
  if (existingPgRelation.rows.length) {
    throw apiError('Ja existe uma tabela PostgreSQL com esse nome: ' + tableName + '. Use outro nome ou abra a tabela manual existente.', 409);
  }

  var pgTableRef = quotePgQualified(POSTGRES_CACHE_SCHEMA, tableName);
  var pgParts = columns.map(function(col) {
    var pgType = col.autoIncrement ? 'SERIAL' : mapColumnTypeToPostgres(col.type || 'texto');
    var name = quotePgIdent(String(col.name || '').trim());
    if (col.autoIncrement) return name + ' ' + pgType;
    var nullable = col.allowNull === false ? ' NOT NULL' : '';
    return name + ' ' + pgType + nullable;
  });
  var pgPk = columns.filter(function(col) { return col.primaryKey; }).map(function(col) { return quotePgIdent(String(col.name || '').trim()); });
  if (pgPk.length) pgParts.push('PRIMARY KEY (' + pgPk.join(', ') + ')');
  var pgSql = 'CREATE TABLE ' + pgTableRef + ' (\n  ' + pgParts.join(',\n  ') + '\n)';
  await pgCacheTransaction(async function(client) {
    await client.query(pgSql);
    await ensureManualTableInPgCache(tableName, columns, client);
  });
  await addManualTable(tableName);
  await saveTableColumnFormats(tableName, columns);
  clearQueryCache('schema-change');
  res.status(201).json({ ok: true, table: tableName, manual: true, editable: true });
}));

app.delete('/api/tables/:table', requirePermission('schemaChanges', 'Exclusao de tabelas'), asyncHandler(async (req, res) => {
  const tableName = req.params.table;
  await ensureManualTable(tableName, 'Exclusao de tabela');
  await deleteManualTableCleanup(tableName);
  res.json({ ok: true, table: tableName });
}));

app.patch('/api/tables/:table/rename', requirePermission('schemaChanges', 'Renomear tabela'), asyncHandler(async (req, res) => {
  const oldName = req.params.table;
  const newName = String(req.body.name || '').trim();
  if (!newName) throw apiError('Informe o novo nome da tabela.', 400);
  if (newName.length > 63) throw apiError('O nome da tabela deve ter no maximo 63 caracteres.', 400);
  if (oldName === newName) return res.json({ ok: true, table: oldName, renamed: false });
  await ensureManualTable(oldName, 'Renomear tabela');
  var manualTables = await readManualTables();
  if (manualTables.some(function(name) { return String(name || '').toLowerCase() === newName.toLowerCase(); })) throw apiError('Ja existe uma tabela manual com esse nome: ' + newName, 409);
  if (newName === CALENDAR_TABLE_NAME) throw apiError('Nome reservado pelo BI WA.', 400);
  const importedTables = await readImportedTables();
  if (importedTables.some(function(item) { return String(item && item.name || '').toLowerCase() === newName.toLowerCase(); })) throw apiError('Ja existe uma tabela inserida com esse nome no app: ' + newName, 409);
  const transforms = await readTransforms();
  if (transforms.some(function(item) { return String(item && item.name || '').toLowerCase() === newName.toLowerCase(); })) throw apiError('Ja existe uma consulta transformada com esse nome: ' + newName, 409);
  if (postgresCacheAvailable()) {
    const existingPgRelation = await pgCacheQuery(
      'SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND LOWER(table_name) = LOWER($2) LIMIT 1',
      [POSTGRES_CACHE_SCHEMA, newName]
    );
    if (existingPgRelation.rows.length) throw apiError('Ja existe uma tabela PostgreSQL com esse nome: ' + newName, 409);
    var oldRef = quotePgQualified(POSTGRES_CACHE_SCHEMA, oldName);
    var newRef = quotePgQualified(POSTGRES_CACHE_SCHEMA, newName);
    await pgCacheTransaction(async function(client) {
      await client.query('ALTER TABLE ' + oldRef + ' RENAME TO ' + quotePgIdent(newName));
      await client.query('UPDATE ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, '__biwa_cache_meta') + ' SET source_table = $2, physical_table = $2, cache_table = $2 WHERE LOWER(source_table) = LOWER($1)', [oldName, newName]);
    });
  }
  manualTables = manualTables.filter(function(t) { return String(t || '').toLowerCase() !== oldName.toLowerCase(); });
  manualTables.push(newName);
  await writeManualTables(manualTables);
  var colFormats = await readColumnFormats();
  if (colFormats[oldName]) { colFormats[newName] = colFormats[oldName]; delete colFormats[oldName]; await writeColumnFormats(colFormats); }
  const migrated = await migrateTableNameReferences(oldName, newName);
  resourceListCache = { key: '', savedAt: 0, resources: [], diagnostics: [] };
  clearQueryCache('schema-change');
  clearQueryCache('reports');
  clearQueryCache('model');
  res.json({ ok: true, table: newName, oldName: oldName, renamed: true, migrated });
}));

app.get('/api/manual-tables', requireDesktopAdmin, asyncHandler(async (req, res) => {
  var manualTableNames = await readManualTables();
  var tables = [];
  for (var i = 0; i < manualTableNames.length; i++) {
    var name = manualTableNames[i];
    var rowCount = 0;
    if (postgresCacheAvailable()) {
      try {
        var pgMeta = await getPgCacheMeta(name);
        if (pgMeta && pgMeta.cache_table) {
          var pgTable = quotePgQualified(POSTGRES_CACHE_SCHEMA, pgMeta.cache_table);
          var cntResult = await pgCacheQuery('SELECT COUNT(*)::int AS cnt FROM ' + pgTable);
          rowCount = Number((cntResult.rows && cntResult.rows[0] && cntResult.rows[0].cnt) || 0);
          if (rowCount !== Number(pgMeta.row_count || 0)) {
            await pgCacheQuery('UPDATE ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, '__biwa_cache_meta') + ' SET row_count = $2 WHERE LOWER(source_table) = LOWER($1)', [name, rowCount]);
          }
        }
      } catch (e) {}
    }
    tables.push({ name: name, rowCount: rowCount, manual: true, editable: true });
  }
  res.json({ ok: true, tables: tables, count: tables.length });
}));

app.get('/api/tables/:table/data', requireDesktopAdmin, asyncHandler(async (req, res) => {
  const table = req.params.table;
  await ensureManualTable(table, 'Edicao de dados');
  const columns = await getColumns(table);
  const pgRef = await resolveManualTablePgRef(table);
  if (!pgRef) throw apiError('Tabela manual nao encontrada no PostgreSQL.', 503);
  const result = await pgCacheQuery('SELECT * FROM ' + pgRef.pgTable + ' ORDER BY 1 LIMIT 5000');
  const rows = (result.rows || []).map(function(row) {
    var obj = {};
    for (var key in row) { if (row.hasOwnProperty(key)) obj[key] = row[key]; }
    return obj;
  });
  await refreshManualTableMetadata(table, 0, null, pgRef);
  res.json({ ok: true, columns: columns, rows: rows, count: rows.length });
}));

async function insertManualRowsWithClient(client, pgRef, columns, rows) {
  if (!rows.length) return 0;
  const columnMap = new Map(columns.map(function(col) { return [col.name, col]; }));
  const groups = new Map();
  rows.forEach(function(row) {
    const keys = Object.keys(row || {}).filter(function(key) { return columnMap.has(key); });
    const signature = keys.join('\u0001');
    if (!groups.has(signature)) groups.set(signature, { keys: keys, rows: [] });
    groups.get(signature).rows.push(row);
  });
  var affected = 0;
  for (const group of groups.values()) {
    if (!group.keys.length) {
      for (var emptyIndex = 0; emptyIndex < group.rows.length; emptyIndex++) {
        await client.query('INSERT INTO ' + pgRef.pgTable + ' DEFAULT VALUES');
        affected += 1;
      }
      continue;
    }
    const chunkSize = Math.max(1, Math.min(500, Math.floor(60000 / group.keys.length)));
    for (var offset = 0; offset < group.rows.length; offset += chunkSize) {
      const chunk = group.rows.slice(offset, offset + chunkSize);
      const values = [];
      const tuples = chunk.map(function(row) {
        const placeholders = group.keys.map(function(key) {
          const column = columnMap.get(key) || {};
          values.push(sanitizePgValue(row[key], column.columnType || column.dataType || ''));
          return '$' + values.length;
        });
        return '(' + placeholders.join(', ') + ')';
      });
      const sql = 'INSERT INTO ' + pgRef.pgTable + ' (' + group.keys.map(quotePgIdent).join(', ') + ') VALUES ' + tuples.join(', ');
      const inserted = await client.query(sql, values);
      affected += Number(inserted.rowCount || chunk.length);
    }
  }
  return affected;
}

async function resetManualIdentitySequence(client, pgRef, columns) {
  const autoColumn = columns.find(function(col) {
    return /auto_increment/i.test(String(col.extra || '')) || Boolean(col.autoIncrement);
  });
  if (!autoColumn) return;
  const tableRegclass = quotePgIdent(POSTGRES_CACHE_SCHEMA) + '.' + quotePgIdent(pgRef.meta.cache_table);
  const sequenceResult = await client.query('SELECT pg_get_serial_sequence($1, $2) AS sequence_name', [tableRegclass, autoColumn.name]);
  const sequenceName = sequenceResult.rows[0] && sequenceResult.rows[0].sequence_name;
  if (!sequenceName) return;
  const maxResult = await client.query('SELECT COALESCE(MAX(' + quotePgIdent(autoColumn.name) + '), 0)::bigint AS max_id FROM ' + pgRef.pgTable);
  const nextValue = Math.max(1, Number(maxResult.rows[0] && maxResult.rows[0].max_id || 0) + 1);
  await client.query('SELECT setval($1::regclass, $2, false)', [sequenceName, nextValue]);
}

app.put('/api/tables/:table/data', requirePermission('tableWrites', 'Edicao de dados'), asyncHandler(async (req, res) => {
  const table = req.params.table;
  await ensureManualTable(table, 'Edicao de dados');
  const columns = await getColumns(table);
  const pgRef = await resolveManualTablePgRef(table);
  if (!pgRef) throw apiError('Tabela manual nao encontrada no PostgreSQL.', 503);

  const inputRows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (inputRows.length > 5000) throw apiError('A edicao em grade aceita no maximo 5.000 linhas por vez.', 400);
  const autoColumns = new Set(columns.filter(function(col) { return /auto_increment/i.test(String(col.extra || '')); }).map(function(col) { return col.name; }));
  const editableColumns = columns.filter(function(col) { return !autoColumns.has(col.name); });
  const requestedColumns = Array.isArray(req.body.columns) ? req.body.columns.map(function(col) { return String(col && (col.name || col) || '').trim(); }).filter(Boolean) : [];
  if (requestedColumns.length) {
    const expected = editableColumns.map(function(col) { return col.name; });
    if (requestedColumns.length !== expected.length || requestedColumns.some(function(name, index) { return name !== expected[index]; })) {
      throw apiError('A estrutura da tabela mudou. Reabra a edicao de dados; alteracoes de colunas devem ser feitas no gerenciador de estrutura.', 409);
    }
  }

  const sanitizedRows = inputRows.map(function(row) {
    return filterKnownColumns(row || {}, columns, { skipAutoIncrement: true });
  });
  const explicitRows = [];
  const generatedRows = [];
  sanitizedRows.forEach(function(row) {
    const hasExplicitAutoValue = Array.from(autoColumns).some(function(name) {
      return row[name] !== undefined && row[name] !== null && row[name] !== '';
    });
    if (hasExplicitAutoValue) explicitRows.push(row);
    else generatedRows.push(row);
  });

  const result = await pgCacheTransaction(async function(client) {
    const previousCountResult = await client.query('SELECT COUNT(*)::int AS count FROM ' + pgRef.pgTable);
    const previousCount = Number(previousCountResult.rows[0] && previousCountResult.rows[0].count || 0);
    await client.query('DELETE FROM ' + pgRef.pgTable);
    var inserted = await insertManualRowsWithClient(client, pgRef, columns, explicitRows);
    await resetManualIdentitySequence(client, pgRef, columns);
    inserted += await insertManualRowsWithClient(client, pgRef, columns, generatedRows);
    await resetManualIdentitySequence(client, pgRef, columns);
    const rowCount = await refreshManualTableMetadata(table, previousCount + inserted, client, pgRef);
    return { previousCount, inserted, rowCount };
  });
  clearQueryCache('table-write');
  res.json({ ok: true, table, affectedRows: result.previousCount + result.inserted, rowCount: result.rowCount });
}));

async function deleteManualTableCleanup(tableName) {
  var manualTables = await readManualTables();
  manualTables = manualTables.filter(function(t) { return t !== tableName; });
  await writeManualTables(manualTables);

  var importedTables = await readImportedTables();
  importedTables = importedTables.filter(function(t) { return String(t.name || '').toLowerCase() !== tableName.toLowerCase(); });
  await writeImportedTables(importedTables);

  var columnFormats = await readColumnFormats();
  Object.keys(columnFormats).forEach(function(name) {
    if (String(name || '').toLowerCase() === tableName.toLowerCase()) delete columnFormats[name];
  });
  await writeColumnFormats(columnFormats);

  if (postgresCacheAvailable()) {
    var pgTableRef = quotePgQualified(POSTGRES_CACHE_SCHEMA, tableName);
    await pgCacheQuery('DROP TABLE IF EXISTS ' + pgTableRef).catch(function() {});
    await pgCacheQuery('DELETE FROM ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, '__biwa_cache_meta') + ' WHERE LOWER(source_table) = LOWER($1)', [tableName]).catch(function() {});
  }

  await removeTableFromSemanticModel(tableName);
  clearQueryCache('schema-change');
  clearQueryCache('table-write');
}

app.get('/api/column-formats', requireDesktopAdmin, asyncHandler(async (req, res) => {
  const formats = await readColumnFormats();
  res.json(formats);
}));

app.get('/api/column-formats/:table', requireDesktopAdmin, asyncHandler(async (req, res) => {
  const table = req.params.table;
  const formats = await readColumnFormats();
  res.json(formats[table] || {});
}));

app.get('/api/tables/:table/columns', requireDesktopAdmin, asyncHandler(async (req, res) => {
  const table = req.params.table;
  quoteIdent(table);
  if (table === CALENDAR_TABLE_NAME) {
    return res.json({ columns: calendarColumnMetadata(), resource: { name: CALENDAR_TABLE_NAME, type: 'calendar', source: 'native', readOnly: true, nativeCalendar: true } });
  }
  // Se for uma consulta transformada, devolve os metadados derivados das etapas.
  const savedTransform = await findTransformByName(table);
  if (savedTransform) {
    try {
      if (savedTransform.daxExpression) {
        const calculatedMeta = await ensureDaxCalculatedTableView(savedTransform);
        const calculatedColumns = normalizePgCacheColumns(calculatedMeta.columns || []);
        return res.json({
          columns: calculatedColumns,
          resource: { name: table, type: 'transform', source: 'postgres-dax-table', transform: true, calculatedDax: true, editable: true, readOnly: true },
          cache: { available: true, enabled: true, exists: true, kind: 'postgres', cacheEngine: 'postgres-dax-table' }
        });
      }
      const built = await buildTransformSql(savedTransform, { limit: 0 });
      if (Array.isArray(built.columns) && built.columns.length) {
        return res.json({ columns: transformColumnMetadata(built.columns, savedTransform.steps), resource: { name: table, type: 'transform', source: savedTransform.sqlExpression ? 'sql-expression' : 'transform', readOnly: true } });
      }
      const sql = built.sql.replace(/\s+LIMIT\s+\d+\s*$/i, '');
      const result = await dbQueryWithTimeout(`SELECT * FROM (${sql}) q LIMIT 0`, built.params || [], 5000);
      const fields = result[1] || [];
      const columns = transformColumnMetadata(fields.map((f) => f.name), savedTransform.steps);
      return res.json({ columns, resource: { name: table, type: 'transform', source: savedTransform.sqlExpression ? 'sql-expression' : 'transform', readOnly: true } });
    } catch (err) {
      return res.json({ columns: [], resource: { name: table, type: 'transform', source: savedTransform.sqlExpression ? 'sql-expression' : 'transform', readOnly: true }, error: 'Nao foi possivel obter colunas: ' + (err.message || String(err)) });
    }
  }
  const metadataOnly = String(req.query.metadataOnly || '') === '1';

  // Tenta PostgreSQL cache primeiro (para tabelas ja importadas)
  let cacheLookupTable = table;
  try {
    const imported = await findImportedTableByName(table);
    if (imported) cacheLookupTable = imported.sourceTable;
  } catch (err2) { /* usa o nome original */ }

  if (postgresCacheAvailable()) {
    const pgMeta = await getPgEffectiveMeta(cacheLookupTable);
    if (pgMeta && Array.isArray(pgMeta.columns) && pgMeta.columns.length > 0) {
      var pgColumns = applyChangeTypeOverridesToColumns(normalizePgCacheColumns(pgMeta.columns), table);
      var colIsManual = pgMeta.sync_mode === 'manual';
      try { var colManualTables = new Set(await readManualTables()); if (colManualTables.has(table)) colIsManual = true; } catch (e) {}
      return res.json({ columns: pgColumns, resource: { name: table, type: 'cache', source: 'postgres-cache', readOnly: !colIsManual, manual: colIsManual, editable: colIsManual }, cache: publicPgCacheStatusFromMeta(pgMeta) });
    }
  }

  // Fallback: consulta MySQL direto (para tabelas ainda nao importadas)
  try {
    const mysqlCols = await getMysqlColumnsMetadata(cacheLookupTable);
    if (Array.isArray(mysqlCols) && mysqlCols.length > 0) {
      return res.json({
        columns: applyChangeTypeOverridesToColumns(mysqlCols, table),
        resource: { name: table, physicalName: cacheLookupTable, type: 'table', source: 'mysql-preview', readOnly: true }
      });
    }
  } catch (err3) { /* fallback para vazio */ }

  return res.json({ columns: [], resource: { name: table, type: 'unknown', source: 'error', readOnly: true }, error: 'Tabela nao encontrada no cache PostgreSQL. Sincronize primeiro.' });
}));

app.get('/api/tables/:table/values/:column', requireDesktopAdmin, asyncHandler(async (req, res) => {
  const table = req.params.table;
  const column = req.params.column;
  if (!column) return res.json({ values: [] });
  quoteIdent(column);
  const maxValues = Math.max(1, Number(req.query.limit || 500));
  // Cache key para reusar o cache do servidor
  const cacheKey = 'tblvals:' + currentDatabaseName() + ':' + String(table).toLowerCase() + ':' + String(column).toLowerCase() + ':' + maxValues;
  const cachedHit = getFilterOptionsCache(cacheKey);
  if (cachedHit) {
    return res.json(cachedHit);
  }
  // Resolve imported table alias e rowFilter
  let lookupTable = table;
  let rowFilter = null;
  try {
    const imported = await findImportedTableByName(table);
    if (imported) {
      lookupTable = imported.sourceTable;
      if (imported.rowFilter && imported.rowFilter.column && Array.isArray(imported.rowFilter.values)) {
        rowFilter = imported.rowFilter;
      }
    }
  } catch (err) { /* usa o nome original */ }
  // Se a coluna consultada eh a mesma do rowFilter, retorna apenas os valores permitidos
  // (exceto quando skipRowFilter=1, usado pelo editor de etapas para mostrar todos os valores)
  if (!req.query.skipRowFilter && rowFilter && rowFilter.column === column) {
    return res.json({ values: rowFilter.values });
  }
  // Tenta PostgreSQL cache
  if (postgresCacheAvailable()) {
    try {
      const pgMeta = await getPgEffectiveMeta(lookupTable);
      if (pgMeta && pgMeta.cache_table) {
        const tableSql = quotePgQualified(POSTGRES_CACHE_SCHEMA, pgMeta.cache_table);
        const colSql = quotePgIdent(column);
        const result = await pgCacheQuery(`SELECT DISTINCT ${colSql} AS val FROM ${tableSql} WHERE ${colSql} IS NOT NULL ORDER BY ${colSql} LIMIT $1`, [maxValues]);
        const values = result.rows.map((r) => r.val).filter((v) => v !== null && v !== '');
        const payload = { values };
        setFilterOptionsCache(cacheKey, payload);
        return res.json(payload);
      }
    } catch (err) { /* fallback */ }
  }
  res.json({ values: [] });
}));

app.post('/api/tables/:table/columns', requirePermission('schemaChanges', 'Alteracao de estrutura'), asyncHandler(async (req, res) => {
  const table = req.params.table;
  await ensureManualTable(table, 'Alteracao de estrutura');
  const col = buildColumnSql({ ...req.body, primaryKey: false, autoIncrement: false });

  const pgRef = await resolveManualTablePgRef(table);
  if (pgRef) {
    var pgType = mapColumnTypeToPostgres(req.body.type || 'texto');
    var pgColName = quotePgIdent(col.name);
    var pgSql = 'ALTER TABLE ' + pgRef.pgTable + ' ADD COLUMN ' + pgColName + ' ' + pgType;
    await pgCacheQuery(pgSql);
    var colsJson = JSON.stringify(pgRef.meta.columns.concat([{ name: col.name, type: req.body.type || 'texto', key: '', primaryKey: false }]));
    await pgCacheQuery('UPDATE ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, '__biwa_cache_meta') + ' SET columns_json = $2, synced_at = NOW() WHERE LOWER(source_table) = LOWER($1)', [table, colsJson]);
    if (req.body.format) {
      const all = await readColumnFormats();
      if (!all[table]) all[table] = {};
      all[table][col.name] = { format: String(req.body.format).trim(), type: String(req.body.type || 'texto') };
      await writeColumnFormats(all);
    }
    clearQueryCache('schema-change');
    res.status(201).json({ ok: true, table, column: col.name });
    return;
  }
  throw apiError('Tabela manual nao encontrada no PostgreSQL. Verifique se o cache PostgreSQL esta ativo.', 503);
}));

function postgresCacheAvailable() {
  return Boolean(PgPool && POSTGRES_CACHE_ENABLED);
}

async function pgCacheQuery(sql, params) {
  var pool = getPgCachePool();
  var client = await pool.connect();
  try {
    var result = await client.query(sql, params || []);
    return result;
  } finally {
    client.release();
  }
}

async function pgCacheQueryWithTimeout(sql, params, timeoutMs) {
  var pool = getPgCachePool();
  var client = await pool.connect();
  var safeTimeout = Math.max(1000, Math.floor(Number(timeoutMs) || FILTER_OPTIONS_QUERY_TIMEOUT_MS));
  try {
    await client.query('SET statement_timeout TO ' + safeTimeout);
    return await client.query(sql, params || []);
  } finally {
    try { await client.query('RESET statement_timeout'); } catch (e) {}
    client.release();
  }
}

async function pgCacheTransaction(fn) {
  var pool = getPgCachePool();
  var client = await pool.connect();
  try {
    await client.query('BEGIN');
    var result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (rollbackErr) {}
    throw err;
  } finally {
    client.release();
  }
}

async function getPgCacheMeta(sourceTable) {
  if (!postgresCacheAvailable()) return null;
  await ensurePgCacheSchema();
  var result = await pgCacheQuery('SELECT * FROM ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, '__biwa_cache_meta') + ' WHERE LOWER(source_table) = LOWER($1) ORDER BY row_count DESC, synced_at DESC LIMIT 1', [String(sourceTable || '')]);
  var row = result.rows[0];
  if (!row) return null;
  return {
    source_table: row.source_table,
    physical_table: row.physical_table,
    cache_table: row.cache_table,
    columns: Array.isArray(row.columns_json) ? row.columns_json : [],
    row_count: Number(row.row_count || 0),
    synced_at: row.synced_at,
    sync_mode: row.sync_mode,
    last_error: row.last_error || '',
    last_marker: row.last_marker || '',
    source_marker: row.source_marker || '',
    sync_strategy: row.sync_strategy || '',
    sync_column: row.sync_column || '',
    primary_keys: Array.isArray(row.primary_keys) ? row.primary_keys : [],
    last_changed_rows: Number(row.last_changed_rows || 0),
    last_data_update_at: row.last_data_update_at || (Number(row.last_changed_rows || 0) > 0 ? row.synced_at : null)
  };
}

/*
 * Camada de modelagem PostgreSQL
 * ------------------------------
 * O cache fisico continua contendo somente as colunas vindas do MySQL. Colunas
 * DAX e preenchimentos de valores vazios vivem em uma VIEW leve, recriada ao
 * salvar/desfazer uma etapa. Assim nenhuma modelagem dispara sincronizacao da
 * origem e os relatorios/filtros continuam consultando uma unica relacao PG.
 */
var pgModelViewCache = new Map();

function pgLegacyModelViewNameFor(sourceTable) {
  var hash = crypto.createHash('sha1').update('model|' + String(sourceTable || '').toLowerCase()).digest('hex').slice(0, 16);
  return 'model_' + hash;
}

function pgModelViewPrefixFor(sourceTable) {
  var hash = crypto.createHash('sha1').update('model-source|' + String(sourceTable || '').toLowerCase()).digest('hex').slice(0, 12);
  return 'model_' + hash;
}

function pgModelViewNameFor(sourceTable, signature) {
  if (!signature) return pgLegacyModelViewNameFor(sourceTable);
  var versionHash = crypto.createHash('sha1').update(String(signature)).digest('hex').slice(0, 12);
  return pgModelViewPrefixFor(sourceTable) + '_' + versionHash;
}

function isPgModelingStep(step) {
  return Boolean(step && (step.kind === 'daxColumn' || step.kind === 'fillValues'));
}

function pgModelingSteps(steps) {
  var all = Array.isArray(steps) ? steps : [];
  var daxNames = new Set(all.filter(function(step) { return step && step.kind === 'daxColumn'; }).map(function(step) { return pgModelKey(step.newName || parseDaxColumnDefinition(step.expression || '').name); }));
  return all.filter(function(step) {
    return isPgModelingStep(step) || (step && step.kind === 'changeType' && daxNames.has(pgModelKey(step.column)));
  });
}

function pgModelConfigSignature(imported, rawMeta, steps) {
  var effectiveSteps = pgImportedEffectiveSteps(imported, steps);
  var hasLogicalPipeline = effectiveSteps.some(function(step) { return !['daxColumn', 'fillValues', 'changeType'].includes(step.kind); });
  var payload = {
    source: String(imported && imported.sourceTable || ''),
    cacheTable: String(rawMeta && rawMeta.cache_table || ''),
    columns: (rawMeta && rawMeta.columns || []).map(function(col) {
      return String(col && (col.name || col.Field) || col || '') + ':' + String(col && (col.dataType || col.columnType || col.type) || '');
    }),
    steps: hasLogicalPipeline ? effectiveSteps : pgModelingSteps(steps === undefined ? imported && imported.steps : steps)
  };
  if (hasLogicalPipeline) payload.effectivePipelineVersion = 2;
  return crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex');
}

function pgModelKey(value) {
  return String(value || '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
}

function findPgColumn(columns, requested) {
  var key = pgModelKey(requested);
  return (columns || []).find(function(col) { return pgModelKey(col && col.name) === key; }) || null;
}

function pgEffectiveTransformSteps(inputSteps) {
  return (Array.isArray(inputSteps) ? inputSteps : []).map(normalizeTransformStep).filter(Boolean);
}

function pgImportedEffectiveSteps(imported, overrideSteps) {
  var intrinsic = [];
  if (imported && imported.rowFilter && imported.rowFilter.column && Array.isArray(imported.rowFilter.values) && imported.rowFilter.values.length) {
    intrinsic.push(normalizeTransformStep({
      kind: 'filterRows',
      column: imported.rowFilter.column,
      operator: 'in',
      values: imported.rowFilter.values
    }));
  }
  if (imported && imported.dateFilter && imported.dateFilter.column) {
    intrinsic.push(normalizeTransformStep({
      kind: 'filterDate',
      column: imported.dateFilter.column,
      value: imported.dateFilter.start || '',
      value2: imported.dateFilter.end || ''
    }));
  }
  var saved = overrideSteps === undefined ? imported && imported.steps : overrideSteps;
  return intrinsic.concat(pgEffectiveTransformSteps(saved)).filter(Boolean);
}

function pgInlineTransformParams(sql, params) {
  var index = 0;
  return String(sql || '').replace(/\?/g, function() {
    if (index >= (params || []).length) throw apiError('Parametro ausente na transformacao efetiva.', 400);
    return quotePgLiteral(params[index++]);
  });
}

function pgTransformFilterPredicate(columnSql, step) {
  var op = String(step && step.operator || '=').trim().toLowerCase();
  var rawValues = Array.isArray(step && step.values) ? step.values : [];
  if (!rawValues.length && (op === 'in' || (op === '=' && String(step && step.value || '').includes(',')))) {
    rawValues = String(step && step.value || '').split(',');
  }
  var values = rawValues.map(function(value) { return String(value ?? '').trim(); }).filter(Boolean);
  var textColumn = 'BTRIM(CAST(' + columnSql + ' AS TEXT))';
  if (values.length) return textColumn + ' IN (' + values.map(quotePgLiteral).join(', ') + ')';
  if (op === 'contains' || op === 'contem') return textColumn + ' LIKE ' + quotePgLiteral('%' + String(step.value || '') + '%');
  if (op === 'starts') return textColumn + ' LIKE ' + quotePgLiteral(String(step.value || '') + '%');
  if (op === 'ends') return textColumn + ' LIKE ' + quotePgLiteral('%' + String(step.value || ''));
  if (op === 'blank') return '(' + columnSql + " IS NULL OR " + textColumn + " = '')";
  if (op === 'notblank') return '(' + columnSql + " IS NOT NULL AND " + textColumn + " <> '')";
  if (op === 'between') return columnSql + ' BETWEEN ' + quotePgLiteral(step.value) + ' AND ' + quotePgLiteral(step.value2);
  if (op === '=' || op === '!=') return textColumn + (op === '!=' ? ' <> ' : ' = ') + quotePgLiteral(String(step.value ?? '').trim());
  var sqlOp = ['>', '>=', '<', '<='].includes(op) ? op : '=';
  return columnSql + ' ' + sqlOp + ' ' + quotePgLiteral(step.value);
}

function pgTransformLiteralOrColumn(value, columns, alias) {
  var text = String(value ?? '').trim();
  var reference = text.match(/^\[([^\]]+)\]$/);
  if (reference) {
    var referenced = findPgColumn(columns, reference[1]);
    if (!referenced) throw apiError('Coluna nao encontrada no resultado da transformacao: ' + reference[1], 400);
    return alias + '.' + quotePgIdent(referenced.name);
  }
  if (/^-?\d+(?:[.,]\d+)?$/.test(text)) return text.replace(',', '.');
  if (/^null$/i.test(text)) return 'NULL';
  if (/^(today|hoje)$/i.test(text)) return 'CURRENT_DATE';
  return quotePgLiteral(text);
}

function pgTransformAggregateExpression(func, expression) {
  var normalized = String(func || '').toUpperCase();
  if (normalized === 'COUNT') return 'COUNT(' + expression + ')';
  if (normalized === 'COUNTDISTINCT' || normalized === 'DISTINCTCOUNT') return 'COUNT(DISTINCT ' + expression + ')';
  if (normalized === 'AVG' || normalized === 'AVERAGE') return 'AVG(' + expression + ')';
  if (normalized === 'MIN') return 'MIN(' + expression + ')';
  if (normalized === 'MAX') return 'MAX(' + expression + ')';
  return 'SUM(' + expression + ')';
}

async function buildPgEffectiveTransformPipeline(baseSql, baseColumns, inputSteps, options) {
  var state = {
    sql: String(baseSql || ''),
    columns: (baseColumns || []).map(function(column) { return Object.assign({}, column); })
  };
  var steps = pgEffectiveTransformSteps(inputSteps);
  var baseNames = (options && options.baseNames || []).concat(options && options.baseTable || '').filter(Boolean);
  var selectCurrent = function(replacements, extra) {
    var projected = state.columns.map(function(column) {
      var replacement = replacements && replacements.get(pgModelKey(column.name));
      return (replacement || 'src.' + quotePgIdent(column.name)) + ' AS ' + quotePgIdent(column.name);
    });
    if (extra) projected.push(extra.sql + ' AS ' + quotePgIdent(extra.meta.name));
    return projected;
  };
  var replaceOrAppend = function(name, expression, meta, joins, replaceExisting) {
    var existing = findPgColumn(state.columns, name);
    if (existing && !replaceExisting) throw apiError('Ja existe uma coluna com este nome: ' + name, 400);
    var replacements = new Map();
    if (existing) replacements.set(pgModelKey(existing.name), expression);
    var nextMeta = Object.assign({ name: name, dataType: 'text', columnType: 'text', pgType: 'text', nullable: 'YES' }, meta || {}, { name: existing ? existing.name : name });
    state.sql = 'SELECT ' + selectCurrent(replacements, existing ? null : { sql: expression, meta: nextMeta }).join(', ') + ' FROM (' + state.sql + ') src ' + (joins || []).join(' ');
    if (existing) state.columns = state.columns.map(function(column) { return pgModelKey(column.name) === pgModelKey(existing.name) ? nextMeta : column; });
    else state.columns.push(nextMeta);
  };

  for (var index = 0; index < steps.length; index++) {
    var step = steps[index];
    var kind = step.kind;
    var target = findPgColumn(state.columns, step.column);
    if (kind === 'selectColumns') {
      var requested = new Set((step.columns || []).map(pgModelKey));
      var selected = state.columns.filter(function(column) { return requested.has(pgModelKey(column.name)); });
      if (selected.length) {
        state.sql = 'SELECT ' + selected.map(function(column) { return 'src.' + quotePgIdent(column.name); }).join(', ') + ' FROM (' + state.sql + ') src';
        state.columns = selected;
      }
      continue;
    }
    if (kind === 'removeColumns') {
      var removed = new Set((step.columns || []).map(pgModelKey));
      var remaining = state.columns.filter(function(column) { return !removed.has(pgModelKey(column.name)); });
      if (!remaining.length) throw apiError('A transformacao removeu todas as colunas.', 400);
      state.sql = 'SELECT ' + remaining.map(function(column) { return 'src.' + quotePgIdent(column.name); }).join(', ') + ' FROM (' + state.sql + ') src';
      state.columns = remaining;
      continue;
    }
    if (kind === 'renameColumn') {
      if (!target || !step.newName) continue;
      if (findPgColumn(state.columns, step.newName)) throw apiError('Ja existe uma coluna com este nome: ' + step.newName, 400);
      state.sql = 'SELECT ' + state.columns.map(function(column) {
        return 'src.' + quotePgIdent(column.name) + (pgModelKey(column.name) === pgModelKey(target.name) ? ' AS ' + quotePgIdent(step.newName) : '');
      }).join(', ') + ' FROM (' + state.sql + ') src';
      state.columns = state.columns.map(function(column) { return pgModelKey(column.name) === pgModelKey(target.name) ? Object.assign({}, column, { name: step.newName }) : column; });
      continue;
    }
    if (kind === 'filterRows') {
      if (!target) throw apiError('Coluna do filtro de transformacao nao encontrada: ' + step.column, 400);
      state.sql = 'SELECT * FROM (' + state.sql + ') src WHERE ' + pgTransformFilterPredicate('src.' + quotePgIdent(target.name), step);
      continue;
    }
    if (kind === 'filterDate') {
      if (!target) throw apiError('Coluna do filtro de data nao encontrada: ' + step.column, 400);
      var dateClauses = [];
      if (step.value) dateClauses.push('src.' + quotePgIdent(target.name) + ' >= ' + quotePgLiteral(step.value));
      if (step.value2) dateClauses.push('src.' + quotePgIdent(target.name) + ' <= ' + quotePgLiteral(step.value2));
      if (dateClauses.length) state.sql = 'SELECT * FROM (' + state.sql + ') src WHERE ' + dateClauses.join(' AND ');
      continue;
    }
    if (kind === 'changeType') {
      if (!target) continue;
      var changed = pgCastModeledField({ expr: 'src.' + quotePgIdent(target.name), meta: target }, step.dataType);
      replaceOrAppend(target.name, changed.expr, Object.assign({}, target, changed), [], true);
      continue;
    }
    if (kind === 'replaceValues') {
      if (!target) throw apiError('Coluna para substituir valores nao encontrada: ' + step.column, 400);
      replaceOrAppend(target.name, 'REPLACE(CAST(src.' + quotePgIdent(target.name) + ' AS TEXT), ' + quotePgLiteral(step.from || '') + ', ' + quotePgLiteral(step.to || '') + ')', Object.assign({}, target, { dataType: 'text', columnType: 'text', pgType: 'text' }), [], true);
      continue;
    }
    if (kind === 'sortRows') {
      if (target) state.sql = 'SELECT * FROM (' + state.sql + ') src ORDER BY src.' + quotePgIdent(target.name) + (step.direction === 'DESC' ? ' DESC NULLS LAST' : ' ASC NULLS LAST');
      continue;
    }
    if (kind === 'removeDuplicates') {
      state.sql = 'SELECT DISTINCT * FROM (' + state.sql + ') src';
      continue;
    }
    if (kind === 'duplicateColumn') {
      if (!target) throw apiError('Coluna para duplicar nao encontrada: ' + step.column, 400);
      var duplicateName = safeTransformOutputName(step.newName || target.name + ' Copia', target.name + ' Copia');
      replaceOrAppend(duplicateName, 'src.' + quotePgIdent(target.name), Object.assign({}, target, { name: duplicateName }), [], false);
      continue;
    }
    if (kind === 'formatText') {
      if (!target) throw apiError('Coluna para formatar nao encontrada: ' + step.column, 400);
      var textExpr = 'BTRIM(CAST(src.' + quotePgIdent(target.name) + ' AS TEXT))';
      var format = String(step.format || 'trim').toLowerCase();
      if (format === 'upper') textExpr = 'UPPER(CAST(src.' + quotePgIdent(target.name) + ' AS TEXT))';
      if (format === 'lower') textExpr = 'LOWER(CAST(src.' + quotePgIdent(target.name) + ' AS TEXT))';
      if (format === 'trimupper') textExpr = 'UPPER(' + textExpr + ')';
      if (format === 'trimlower') textExpr = 'LOWER(' + textExpr + ')';
      replaceOrAppend(target.name, textExpr, Object.assign({}, target, { dataType: 'text', columnType: 'text', pgType: 'text' }), [], true);
      continue;
    }
    if (kind === 'fillValues') {
      if (!target) throw apiError('Coluna para preencher nao encontrada: ' + step.column, 400);
      var fillExpr = pgFillExpression({ expr: 'src.' + quotePgIdent(target.name), meta: target }, step.value);
      replaceOrAppend(target.name, fillExpr, target, [], true);
      continue;
    }
    if (kind === 'splitColumn') {
      if (!target) throw apiError('Coluna para dividir nao encontrada: ' + step.column, 400);
      var delimiter = String(step.delimiter || '');
      if (!delimiter) throw apiError('Informe o delimitador para dividir a coluna.', 400);
      var leftName = safeTransformOutputName(step.newName1 || target.name + ' 1', target.name + ' 1');
      var rightName = safeTransformOutputName(step.newName2 || target.name + ' 2', target.name + ' 2');
      var splitText = 'CAST(src.' + quotePgIdent(target.name) + ' AS TEXT)';
      var arrayExpr = 'STRING_TO_ARRAY(' + splitText + ', ' + quotePgLiteral(delimiter) + ')';
      replaceOrAppend(leftName, 'SPLIT_PART(' + splitText + ', ' + quotePgLiteral(delimiter) + ', 1)', { name: leftName, dataType: 'text', columnType: 'text', pgType: 'text' }, [], false);
      target = findPgColumn(state.columns, target.name);
      splitText = 'CAST(src.' + quotePgIdent(target.name) + ' AS TEXT)';
      arrayExpr = 'STRING_TO_ARRAY(' + splitText + ', ' + quotePgLiteral(delimiter) + ')';
      replaceOrAppend(rightName, '(' + arrayExpr + ')[CARDINALITY(' + arrayExpr + ')]', { name: rightName, dataType: 'text', columnType: 'text', pgType: 'text' }, [], false);
      if (step.removeOriginal) {
        var keepSplit = state.columns.filter(function(column) { return pgModelKey(column.name) !== pgModelKey(target.name); });
        state.sql = 'SELECT ' + keepSplit.map(function(column) { return 'src.' + quotePgIdent(column.name); }).join(', ') + ' FROM (' + state.sql + ') src';
        state.columns = keepSplit;
      }
      continue;
    }
    if (kind === 'customColumn') {
      var customName = String(step.newName || step.column || '').trim();
      var customFields = new Map(state.columns.map(function(column) { return [column.name, { expr: 'src.' + quoteIdent(column.name) }]; }));
      var customParams = [];
      var customExpr = transformExpressionToSql(step.expression || '', customFields, customParams);
      customExpr = pgInlineTransformParams(mysqlFunctionsToPostgres(mysqlBacktickSqlToPostgres(customExpr)), customParams);
      var customMeta = { name: customName, dataType: 'text', columnType: 'text', pgType: 'text' };
      if (step.dataType) {
        var customCast = pgCastModeledField({ expr: customExpr, meta: customMeta }, step.dataType);
        customExpr = customCast.expr;
        customMeta = Object.assign(customMeta, customCast);
      }
      replaceOrAppend(customName, customExpr, customMeta, [], false);
      continue;
    }
    if (kind === 'conditionalColumn') {
      if (!target) throw apiError('Coluna da condicao nao encontrada: ' + step.column, 400);
      var conditionalName = String(step.newName || '').trim();
      var condition = pgTransformFilterPredicate('src.' + quotePgIdent(target.name), step);
      var conditionalExpr = 'CASE WHEN ' + condition + ' THEN ' + pgTransformLiteralOrColumn(step.trueValue, state.columns, 'src') + ' ELSE ' + pgTransformLiteralOrColumn(step.falseValue, state.columns, 'src') + ' END';
      replaceOrAppend(conditionalName, conditionalExpr, { name: conditionalName, dataType: 'text', columnType: 'text', pgType: 'text' }, [], false);
      continue;
    }
    if (kind === 'daxColumn') {
      var definition = parseDaxColumnDefinition(step.expression || ((step.newName || '') + ' = ' + (step.formula || '')));
      var daxFields = new Map();
      state.columns.forEach(function(column) { daxFields.set(pgModelKey(column.name), { expr: 'src.' + quotePgIdent(column.name), meta: column, derived: false }); });
      var daxContext = { baseTable: options && options.baseTable || '', baseNames: baseNames, fields: daxFields, lookupJoins: [] };
      var compiled = await compileDaxScalarExpression(definition.expression, daxContext);
      replaceOrAppend(definition.name, compiled.sql, Object.assign({ name: definition.name }, compiled.meta || {}), daxContext.lookupJoins, step.replaceExisting === true);
      continue;
    }
    if (kind === 'groupBy') {
      var groupColumns = (step.groupColumns || step.columns || []).map(function(name) { return findPgColumn(state.columns, name); }).filter(Boolean);
      var aggregations = (step.aggregations || []).map(function(aggregation) {
        return { config: aggregation, column: findPgColumn(state.columns, aggregation.column) };
      }).filter(function(item) { return item.column && item.config.newName; });
      if (!groupColumns.length || !aggregations.length) throw apiError('Agrupamento invalido na transformacao efetiva.', 400);
      var groupSelect = groupColumns.map(function(column) { return 'src.' + quotePgIdent(column.name); });
      var nextColumns = groupColumns.map(function(column) { return Object.assign({}, column); });
      aggregations.forEach(function(item) {
        groupSelect.push(pgTransformAggregateExpression(item.config.func, 'src.' + quotePgIdent(item.column.name)) + ' AS ' + quotePgIdent(item.config.newName));
        nextColumns.push({ name: item.config.newName, dataType: 'numeric', columnType: 'numeric', pgType: 'numeric', nullable: 'YES' });
      });
      state.sql = 'SELECT ' + groupSelect.join(', ') + ' FROM (' + state.sql + ') src GROUP BY ' + groupColumns.map(function(column) { return 'src.' + quotePgIdent(column.name); }).join(', ');
      state.columns = nextColumns;
      continue;
    }
    if (kind === 'appendQueries') {
      var appendSource = String(step.source || step.appendSource || '').trim();
      if (baseNames.some(function(name) { return pgModelKey(name) === pgModelKey(appendSource); })) throw apiError('Dependencia circular ao acrescentar ' + appendSource + '.', 400);
      var appendMeta = await getPgEffectiveMeta(appendSource);
      if (!appendMeta || !appendMeta.cache_table) throw apiError('Tabela para acrescentar sem dados efetivos: ' + appendSource, 400);
      var appendColumns = appendMeta.columns || await pgRelationColumns(appendMeta.cache_table);
      var aligned = state.columns.map(function(column) {
        var sourceColumn = findPgColumn(appendColumns, column.name);
        return sourceColumn ? 'other.' + quotePgIdent(sourceColumn.name) + ' AS ' + quotePgIdent(column.name) : 'NULL AS ' + quotePgIdent(column.name);
      });
      state.sql = 'SELECT * FROM (' + state.sql + ') current_rows UNION ALL SELECT ' + aligned.join(', ') + ' FROM ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, appendMeta.cache_table) + ' other';
      continue;
    }
    if (kind === 'mergeQueries') {
      var rightSource = String(step.source || step.rightSource || '').trim();
      if (baseNames.some(function(name) { return pgModelKey(name) === pgModelKey(rightSource); })) throw apiError('Dependencia circular ao mesclar ' + rightSource + '.', 400);
      var rightMeta = await getPgEffectiveMeta(rightSource);
      if (!rightMeta || !rightMeta.cache_table) throw apiError('Tabela para mesclar sem dados efetivos: ' + rightSource, 400);
      var leftColumn = findPgColumn(state.columns, step.leftColumn);
      var rightColumns = rightMeta.columns || await pgRelationColumns(rightMeta.cache_table);
      var rightColumn = findPgColumn(rightColumns, step.rightColumn);
      if (!leftColumn || !rightColumn) throw apiError('Chave da mesclagem nao encontrada.', 400);
      var selectedRight = (step.columns || []).map(function(name) { return findPgColumn(rightColumns, name); }).filter(function(column) { return column && pgModelKey(column.name) !== pgModelKey(rightColumn.name); });
      var joinType = ['INNER', 'RIGHT', 'FULL'].includes(String(step.joinType || '').toUpperCase()) ? String(step.joinType).toUpperCase() : 'LEFT';
      var projections = state.columns.map(function(column) { return 'src.' + quotePgIdent(column.name); });
      selectedRight.forEach(function(column) {
        var alias = prefixedTransformColumn(rightSource, column.name);
        projections.push('other.' + quotePgIdent(column.name) + ' AS ' + quotePgIdent(alias));
        state.columns.push(Object.assign({}, column, { name: alias }));
      });
      state.sql = 'SELECT ' + projections.join(', ') + ' FROM (' + state.sql + ') src ' + joinType + ' JOIN ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, rightMeta.cache_table) + ' other ON CAST(src.' + quotePgIdent(leftColumn.name) + ' AS TEXT) = CAST(other.' + quotePgIdent(rightColumn.name) + ' AS TEXT)';
    }
  }
  return { sql: state.sql, columns: state.columns, steps: steps };
}

async function getRawPgMetaForLogicalTable(table) {
  var lookup = await resolvePgCacheLookup(table);
  var meta = await getPgCacheMeta(lookup.table);
  return { lookup: lookup, meta: meta };
}

async function pgRelationColumns(cacheTable) {
  var result = await pgCacheQuery(
    'SELECT column_name, data_type, udt_name, is_nullable, column_default, ordinal_position FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position',
    [POSTGRES_CACHE_SCHEMA, String(cacheTable || '')]
  );
  return (result.rows || []).map(function(row) {
    return {
      name: row.column_name,
      dataType: String(row.data_type || row.udt_name || 'text').toLowerCase(),
      columnType: String(row.data_type || row.udt_name || 'text'),
      pgType: String(row.data_type || row.udt_name || 'text').toLowerCase(),
      columnKey: '',
      nullable: row.is_nullable || 'YES',
      defaultValue: row.column_default == null ? null : row.column_default,
      extra: ''
    };
  });
}

function pgStorageTypeFamily(value) {
  var type = String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (/^(smallint|integer|bigint|int2|int4|int8)$/.test(type)) return 'integer';
  if (/^(numeric|decimal|real|double precision|float4|float8)$/.test(type)) return 'numeric';
  if (/^(text|character varying|character|varchar|char|citext)$/.test(type)) return 'text';
  if (/^(timestamp without time zone|timestamp with time zone|timestamp|timestamptz)$/.test(type)) return 'timestamp';
  if (/^date$/.test(type)) return 'date';
  if (/^(time without time zone|time with time zone|time|timetz)$/.test(type)) return 'time';
  if (/^(boolean|bool)$/.test(type)) return 'boolean';
  if (/^bytea$/.test(type)) return 'binary';
  if (/^(json|jsonb)$/.test(type)) return 'json';
  return type;
}

async function pgCacheStorageSchemaCompatible(cacheTable, columns, typeOverrides) {
  if (!cacheTable) return false;
  var actual = await pgRelationColumns(cacheTable);
  if (actual.length !== (columns || []).length) return false;
  var actualByName = new Map(actual.map(function(col) { return [String(col.name), col]; }));
  return (columns || []).every(function(col) {
    var found = actualByName.get(String(col.name));
    if (!found) return false;
    var expected = typeOverrides && typeOverrides[col.name] ? typeOverrides[col.name] : pgTypeForMysqlColumn(col);
    return pgStorageTypeFamily(found.pgType || found.dataType) === pgStorageTypeFamily(expected);
  });
}

function stripBalancedOuterParens(value) {
  var text = String(value || '').trim();
  while (text.startsWith('(') && text.endsWith(')')) {
    var depth = 0;
    var quoted = false;
    var balanced = true;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (ch === '"' && text[i - 1] !== '\\') quoted = !quoted;
      if (quoted) continue;
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      if (depth === 0 && i < text.length - 1) { balanced = false; break; }
    }
    if (!balanced || depth !== 0) break;
    text = text.slice(1, -1).trim();
  }
  return text;
}

function splitTopLevelDaxOperator(text, operator) {
  var source = String(text || '');
  var parts = [];
  var start = 0;
  var paren = 0;
  var bracket = 0;
  var single = false;
  var double = false;
  for (var i = 0; i < source.length; i++) {
    var ch = source[i];
    var prev = source[i - 1];
    if (ch === "'" && !double && prev !== '\\') single = !single;
    else if (ch === '"' && !single && prev !== '\\') double = !double;
    if (single || double) continue;
    if (ch === '(') paren += 1;
    else if (ch === ')') paren -= 1;
    else if (ch === '[') bracket += 1;
    else if (ch === ']') bracket -= 1;
    else if (ch === operator && paren === 0 && bracket === 0) {
      parts.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (!parts.length) return [source.trim()];
  parts.push(source.slice(start).trim());
  return parts;
}

function parseDaxColumnDefinition(formula) {
  var text = String(formula || '').trim();
  if (!text) throw apiError('Digite a formula da coluna DAX.', 400);
  if (text.length > 5000) throw apiError('A formula DAX excede 5.000 caracteres.', 400);
  var match = text.match(/^([^=\r\n]{1,120}?)\s*=\s*([\s\S]+)$/);
  if (!match) throw apiError('Use o formato Nome da coluna = formula DAX.', 400);
  var name = String(match[1] || '').trim();
  var expression = String(match[2] || '').trim();
  if (!name || !expression) throw apiError('Informe o nome e a formula da coluna DAX.', 400);
  if (/[ -"`]/.test(name)) throw apiError('Nome de coluna DAX invalido.', 400);
  return { name: name, expression: expression, formula: name + ' = ' + expression };
}

function parseDaxColumnReference(value) {
  var text = stripBalancedOuterParens(value);
  var match = text.match(/^(?:(?:'([^']+)')|([^\[]+))?\[([^\]]+)\]$/);
  if (!match) return null;
  return { table: String(match[1] || match[2] || '').trim(), column: String(match[3] || '').trim() };
}

function daxDoubleQuotedLiteral(value) {
  var text = String(value || '').trim();
  if (!/^"(?:[^"\\]|\\.)*"$/.test(text)) return null;
  return text.slice(1, -1).replace(/\\(["\\])/g, '$1').replace(/""/g, '"');
}

function tableMatchesDaxBase(table, context) {
  if (!String(table || '').trim()) return true;
  var key = pgModelKey(table);
  return context.baseNames.some(function(name) { return pgModelKey(name) === key; });
}

async function resolveDaxReferenceSql(reference, context, related) {
  if (!reference || !reference.column) throw apiError('Referencia de coluna DAX invalida.', 400);
  if (tableMatchesDaxBase(reference.table, context)) {
    var baseField = findPgColumn(Array.from(context.fields.values()).map(function(item) { return item.meta; }), reference.column);
    if (!baseField) throw apiError('Coluna nao encontrada na tabela ' + context.baseTable + ': ' + reference.column, 400);
    var def = context.fields.get(pgModelKey(baseField.name));
    return { sql: def.expr, meta: def.meta, table: context.baseTable };
  }
  if (related && pgModelKey(reference.table) === pgModelKey(related.table)) {
    var relatedCol = findPgColumn(related.columns, reference.column);
    if (!relatedCol) throw apiError('Coluna nao encontrada na tabela ' + related.table + ': ' + reference.column, 400);
    return { sql: related.alias + '.' + quotePgIdent(relatedCol.name), meta: relatedCol, table: related.table };
  }
  throw apiError('A formula referencia uma tabela fora do contexto esperado: ' + (reference.table || context.baseTable), 400);
}

async function daxRelatedExpression(argument, context) {
  var targetRef = parseDaxColumnReference(argument);
  if (!targetRef || !targetRef.table) throw apiError('RELATED exige Tabela[Coluna].', 400);
  var targetLookup = await getRawPgMetaForLogicalTable(targetRef.table);
  if (!targetLookup.meta || !targetLookup.meta.cache_table) throw apiError('Tabela relacionada sem dados no PostgreSQL: ' + targetRef.table, 400);
  var targetColumns = await pgRelationColumns(targetLookup.meta.cache_table);
  var targetValue = findPgColumn(targetColumns, targetRef.column);
  if (!targetValue) throw apiError('Coluna relacionada nao encontrada: ' + targetRef.table + '[' + targetRef.column + ']', 400);
  var model = await readSemanticModel();
  var rel = (model.relationships || []).find(function(item) {
    if (!item || item.active === false) return false;
    var fromBase = tableMatchesDaxBase(item.fromTable, context) && pgModelKey(item.toTable) === pgModelKey(targetRef.table);
    var toBase = tableMatchesDaxBase(item.toTable, context) && pgModelKey(item.fromTable) === pgModelKey(targetRef.table);
    return fromBase || toBase;
  });
  if (!rel) throw apiError('Nao existe relacionamento ativo entre ' + context.baseTable + ' e ' + targetRef.table + '.', 400);
  var baseColumnName = tableMatchesDaxBase(rel.fromTable, context) ? rel.fromColumn : rel.toColumn;
  var targetKeyName = tableMatchesDaxBase(rel.fromTable, context) ? rel.toColumn : rel.fromColumn;
  var baseColumn = findPgColumn(Array.from(context.fields.values()).map(function(item) { return item.meta; }), baseColumnName);
  var targetKey = findPgColumn(targetColumns, targetKeyName);
  if (!baseColumn || !targetKey) throw apiError('As colunas do relacionamento ativo nao foram encontradas.', 400);
  var baseDef = context.fields.get(pgModelKey(baseColumn.name));
  var relationSql = quotePgQualified(POSTGRES_CACHE_SCHEMA, targetLookup.meta.cache_table);
  var sql = '(SELECT rel.' + quotePgIdent(targetValue.name) + ' FROM ' + relationSql + ' rel WHERE CAST(rel.' + quotePgIdent(targetKey.name) + ' AS TEXT) = CAST(' + baseDef.expr + ' AS TEXT) LIMIT 1)';
  return { sql: sql, meta: targetValue };
}

function pgDaxNormalizedLookupKeySql(valueSql) {
  var trimmed = 'BTRIM(CAST((' + valueSql + ') AS TEXT))';
  var numericPattern = "'^[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)$'";
  return '(CASE WHEN NULLIF(' + trimmed + ", '') IS NULL THEN NULL " +
    'WHEN ' + trimmed + ' ~ ' + numericPattern +
    " THEN 'N:' || CAST(TRIM_SCALE(CAST(" + trimmed + " AS NUMERIC)) AS TEXT) " +
    "ELSE 'T:' || " + trimmed + ' END)';
}

function pgDaxSelectedValueAggregateSql(valueSql, outputAlias) {
  var distinctValues = 'COUNT(DISTINCT ' + valueSql + ')';
  var hasBlank = 'COUNT(*) FILTER (WHERE ' + valueSql + ' IS NULL)';
  return 'CASE WHEN (' + distinctValues + ' + CASE WHEN ' + hasBlank +
    ' > 0 THEN 1 ELSE 0 END) = 1 THEN MIN(' + valueSql + ') ELSE NULL END AS ' +
    quotePgIdent(outputAlias);
}

async function daxCalculateExpression(expression, context) {
  var inner = String(expression || '').trim().replace(/^CALCULATE\s*\(/i, '').replace(/\)\s*$/, '');
  var args = splitTopLevelArgs(inner);
  if (args.length < 2) throw apiError('CALCULATE da coluna exige SELECTEDVALUE e FILTER.', 400);
  var selectedMatch = String(args[0] || '').trim().match(/^SELECTEDVALUE\s*\(([\s\S]+)\)$/i);
  var filterMatch = String(args[1] || '').trim().match(/^FILTER\s*\(([\s\S]+)\)$/i);
  if (!selectedMatch || !filterMatch) throw apiError('Nesta coluna, use CALCULATE(SELECTEDVALUE(...), FILTER(...)).', 400);
  var selectedRef = parseDaxColumnReference(selectedMatch[1]);
  var filterArgs = splitTopLevelArgs(filterMatch[1]);
  if (!selectedRef || !selectedRef.table || filterArgs.length < 2) throw apiError('SELECTEDVALUE ou FILTER invalido na coluna DAX.', 400);
  var filterTable = String(filterArgs[0] || '').trim().replace(/^'|'$/g, '');
  if (pgModelKey(filterTable) !== pgModelKey(selectedRef.table)) throw apiError('FILTER deve usar a mesma tabela de SELECTEDVALUE.', 400);
  // A tabela usada como lookup tambem pode ser uma tabela calculada DAX. Nesse
  // caso getPgEffectiveMeta cria/resolve a view derivada sem materializar dados
  // nem alterar as tabelas de origem.
  var targetMeta = await getPgEffectiveMeta(filterTable);
  if (!targetMeta || !targetMeta.cache_table) throw apiError('Tabela de busca sem dados no PostgreSQL: ' + filterTable, 400);
  var targetColumns = Array.isArray(targetMeta.columns) && targetMeta.columns.length
    ? targetMeta.columns
    : await pgRelationColumns(targetMeta.cache_table);
  var selectedColumn = findPgColumn(targetColumns, selectedRef.column);
  if (!selectedColumn) throw apiError('Coluna de SELECTEDVALUE nao encontrada: ' + selectedRef.column, 400);
  var equality = splitTopLevelDaxOperator(filterArgs[1], '=');
  if (equality.length !== 2) throw apiError('O FILTER da coluna DAX deve comparar duas colunas com =.', 400);
  var related = { table: filterTable, alias: 'rel', columns: targetColumns };
  var left = await resolveDaxReferenceSql(parseDaxColumnReference(equality[0]), context, related);
  var right = await resolveDaxReferenceSql(parseDaxColumnReference(equality[1]), context, related);
  var targetSide = pgModelKey(left.table) === pgModelKey(filterTable) ? left : right;
  var baseSide = targetSide === left ? right : left;
  if (pgModelKey(targetSide.table) !== pgModelKey(filterTable) || pgModelKey(baseSide.table) !== pgModelKey(context.baseTable)) {
    throw apiError('O FILTER da coluna DAX deve comparar uma coluna de ' + filterTable + ' com uma coluna de ' + context.baseTable + '.', 400);
  }
  var relationSql = quotePgQualified(POSTGRES_CACHE_SCHEMA, targetMeta.cache_table);
  var selectedSql = 'rel.' + quotePgIdent(selectedColumn.name);
  var targetKeySql = pgDaxNormalizedLookupKeySql(targetSide.sql);
  var baseKeySql = pgDaxNormalizedLookupKeySql(baseSide.sql);

  // Uma juncao agrupada evita uma subconsulta por linha nas tabelas grandes e
  // implementa SELECTEDVALUE sem escolher arbitrariamente entre duplicidades.
  if (Array.isArray(context.lookupJoins)) {
    var lookupAlias = 'dax_calculate_' + context.lookupJoins.length;
    var keyAlias = '__key';
    var valueAlias = '__value';
    context.lookupJoins.push(
      'LEFT JOIN (SELECT ' + targetKeySql + ' AS ' + quotePgIdent(keyAlias) + ', ' +
      pgDaxSelectedValueAggregateSql(selectedSql, valueAlias) + ' FROM ' + relationSql +
      ' rel WHERE ' + targetKeySql + ' IS NOT NULL GROUP BY ' + targetKeySql + ') ' +
      lookupAlias + ' ON ' + lookupAlias + '.' + quotePgIdent(keyAlias) + ' = ' + baseKeySql
    );
    return { sql: lookupAlias + '.' + quotePgIdent(valueAlias), meta: selectedColumn };
  }

  var sql = '(SELECT ' + pgDaxSelectedValueAggregateSql(selectedSql, '__value').replace(/\s+AS\s+"__value"\s*$/i, '') +
    ' FROM ' + relationSql + ' rel WHERE ' + targetKeySql + ' = ' + baseKeySql + ')';
  return { sql: sql, meta: selectedColumn };
}

function pgDaxScalarMetaKind(meta) {
  var type = String(meta && (meta.pgType || meta.dataType || meta.columnType) || '').toLowerCase();
  if (/int|numeric|decimal|double|real|float|money/.test(type)) return 'numeric';
  if (/bool/.test(type)) return 'boolean';
  if (/date|timestamp|time/.test(type)) return 'date';
  if (/char|text|json|uuid|enum/.test(type)) return 'text';
  return type || 'text';
}

function pgDaxIfResultMeta(whenTrue, whenFalse) {
  var trueMeta = whenTrue && whenTrue.meta || {};
  var falseMeta = whenFalse && whenFalse.meta || {};
  var trueKind = pgDaxScalarMetaKind(trueMeta);
  var falseKind = pgDaxScalarMetaKind(falseMeta);
  if (trueKind === 'numeric' && falseKind === 'numeric') {
    return { dataType: 'numeric', columnType: 'numeric', pgType: 'numeric', nullable: 'YES' };
  }
  if (trueKind === falseKind) return Object.assign({}, falseMeta, trueMeta, { nullable: 'YES' });
  return { dataType: 'text', columnType: 'text', pgType: 'text', nullable: 'YES' };
}

async function compileDaxColumnCondition(expression, context) {
  var text = stripBalancedOuterParens(expression);
  var inMatch = text.match(/^([\s\S]+?)\s+IN\s*\{([\s\S]*)\}\s*$/i);
  if (inMatch) {
    var left = await compileDaxScalarExpression(inMatch[1], context);
    var rawValues = splitTopLevelArgs(inMatch[2]);
    if (!rawValues.length) throw apiError('IN da coluna DAX precisa de pelo menos um valor.', 400);
    var values = [];
    for (var i = 0; i < rawValues.length; i++) values.push(await compileDaxScalarExpression(rawValues[i], context));
    return '(' + left.sql + ') IN (' + values.map(function(item) { return item.sql; }).join(', ') + ')';
  }
  var equality = splitTopLevelDaxOperator(text, '=');
  if (equality.length === 2) {
    var equalityLeft = await compileDaxScalarExpression(equality[0], context);
    var equalityRight = await compileDaxScalarExpression(equality[1], context);
    return 'CAST(' + equalityLeft.sql + ' AS TEXT) = CAST(' + equalityRight.sql + ' AS TEXT)';
  }
  throw apiError('Condicao DAX de coluna ainda nao suportada: ' + text, 400);
}

async function daxLookupValueExpression(expression, context) {
  var inner = String(expression || '').trim().replace(/^LOOKUPVALUE\s*\(/i, '').replace(/\)\s*$/, '');
  var args = splitTopLevelArgs(inner);
  if (args.length < 3) throw apiError('LOOKUPVALUE exige coluna de resultado, coluna de busca e valor de busca.', 400);
  var resultRef = parseDaxColumnReference(args[0]);
  if (!resultRef || !resultRef.table) throw apiError('A primeira coluna do LOOKUPVALUE deve informar a tabela.', 400);
  var remaining = args.slice(1);
  var alternateExpression = '';
  if (remaining.length % 2 === 1) alternateExpression = remaining.pop();
  if (!remaining.length || remaining.length % 2 !== 0) throw apiError('Os argumentos de busca do LOOKUPVALUE devem formar pares coluna/valor.', 400);

  var targetMeta = await getPgEffectiveMeta(resultRef.table);
  if (!targetMeta || !targetMeta.cache_table) throw apiError('Tabela de busca sem dados no PostgreSQL: ' + resultRef.table, 400);
  var targetColumns = await pgRelationColumns(targetMeta.cache_table);
  var resultColumn = findPgColumn(targetColumns, resultRef.column);
  if (!resultColumn) throw apiError('Coluna de resultado do LOOKUPVALUE nao encontrada: ' + resultRef.table + '[' + resultRef.column + ']', 400);
  var conditions = [];
  for (var index = 0; index < remaining.length; index += 2) {
    var searchRef = parseDaxColumnReference(remaining[index]);
    if (!searchRef || !searchRef.table || pgModelKey(searchRef.table) !== pgModelKey(resultRef.table)) {
      throw apiError('As colunas de busca do LOOKUPVALUE devem pertencer a ' + resultRef.table + '.', 400);
    }
    var searchColumn = findPgColumn(targetColumns, searchRef.column);
    if (!searchColumn) throw apiError('Coluna de busca do LOOKUPVALUE nao encontrada: ' + searchRef.column, 400);
    var searchValue = await compileDaxScalarExpression(remaining[index + 1], context);
    conditions.push('CAST(rel.' + quotePgIdent(searchColumn.name) + ' AS TEXT) = CAST(' + searchValue.sql + ' AS TEXT)');
  }
  var alternateSql = 'NULL';
  if (alternateExpression) alternateSql = (await compileDaxScalarExpression(alternateExpression, context)).sql;
  var resultSql = 'rel.' + quotePgIdent(resultColumn.name);
  var relationSql = quotePgQualified(POSTGRES_CACHE_SCHEMA, targetMeta.cache_table);
  if (Array.isArray(context.lookupJoins)) {
    var lookupIndex = context.lookupJoins.length;
    var lookupAlias = 'dax_lookup_' + lookupIndex;
    var groupedKeys = [];
    var joinConditions = [];
    for (var keyIndex = 0; keyIndex < remaining.length; keyIndex += 2) {
      var groupedRef = parseDaxColumnReference(remaining[keyIndex]);
      var groupedColumn = findPgColumn(targetColumns, groupedRef && groupedRef.column);
      var groupedValue = await compileDaxScalarExpression(remaining[keyIndex + 1], context);
      var groupedAlias = '__key' + (keyIndex / 2);
      groupedKeys.push('rel.' + quotePgIdent(groupedColumn.name) + ' AS ' + quotePgIdent(groupedAlias));
      joinConditions.push('CAST(' + lookupAlias + '.' + quotePgIdent(groupedAlias) + ' AS TEXT) = CAST(' + groupedValue.sql + ' AS TEXT)');
    }
    var groupedSourceKeys = remaining.filter(function(_, itemIndex) { return itemIndex % 2 === 0; }).map(function(item) {
      var itemRef = parseDaxColumnReference(item);
      var itemColumn = findPgColumn(targetColumns, itemRef && itemRef.column);
      return 'rel.' + quotePgIdent(itemColumn.name);
    });
    var groupedResult = 'CASE WHEN COUNT(DISTINCT ' + resultSql + ') = 1 THEN MIN(' + resultSql + ') ELSE NULL END AS ' + quotePgIdent('__value');
    context.lookupJoins.push('LEFT JOIN (SELECT ' + groupedKeys.concat(groupedResult).join(', ') + ' FROM ' + relationSql + ' rel GROUP BY ' + groupedSourceKeys.join(', ') + ') ' + lookupAlias + ' ON ' + joinConditions.join(' AND '));
    var joinedSql = lookupAlias + '.' + quotePgIdent('__value');
    if (alternateExpression) joinedSql = 'COALESCE(' + joinedSql + ', ' + alternateSql + ')';
    return { sql: joinedSql, meta: resultColumn };
  }
  var sql = '(SELECT CASE WHEN COUNT(DISTINCT ' + resultSql + ') = 1 THEN MIN(' + resultSql + ') ELSE ' + alternateSql + ' END FROM ' + relationSql + ' rel WHERE ' + conditions.join(' AND ') + ')';
  return { sql: sql, meta: resultColumn };
}

async function daxIfExpression(expression, context) {
  var inner = String(expression || '').trim().replace(/^IF\s*\(/i, '').replace(/\)\s*$/, '');
  var args = splitTopLevelArgs(inner);
  if (args.length < 2 || args.length > 3) throw apiError('IF da coluna DAX exige condicao, valor verdadeiro e valor falso opcional.', 400);
  var conditionSql = await compileDaxColumnCondition(args[0], context);
  var whenTrue = await compileDaxScalarExpression(args[1], context);
  var whenFalse = args.length > 2
    ? await compileDaxScalarExpression(args[2], context)
    : { sql: 'NULL', meta: Object.assign({}, whenTrue.meta || {}, { nullable: 'YES' }) };
  var resultMeta = pgDaxIfResultMeta(whenTrue, whenFalse);
  var trueSql = whenTrue.sql;
  var falseSql = whenFalse.sql;
  if (pgDaxScalarMetaKind(whenTrue.meta) !== pgDaxScalarMetaKind(whenFalse.meta) && pgDaxScalarMetaKind(resultMeta) === 'text') {
    trueSql = 'CAST(' + trueSql + ' AS TEXT)';
    falseSql = 'CAST(' + falseSql + ' AS TEXT)';
  }
  return { sql: 'CASE WHEN ' + conditionSql + ' THEN ' + trueSql + ' ELSE ' + falseSql + ' END', meta: resultMeta };
}

async function daxFreightAllocationLineExpression(expression, context) {
  var inner = String(expression || '').trim().replace(/^FRETERATEIO\s*\(/i, '').replace(/\)\s*$/, '');
  var args = splitTopLevelArgs(inner);
  if (args.length !== 5) {
    throw apiError('FRETERATEIO exige Valor Frete, Quantidade, Chave NFe, CFOP e Situacao.', 400);
  }
  var freight = await compileDaxScalarExpression(args[0], context);
  var quantity = await compileDaxScalarExpression(args[1], context);
  var invoiceKey = await compileDaxScalarExpression(args[2], context);
  var cfop = await compileDaxScalarExpression(args[3], context);
  var receiptStatus = await compileDaxScalarExpression(args[4], context);
  var eligible = 'CAST(' + cfop.sql + " AS TEXT) IN ('1.102', '2.102')" +
    ' AND CAST(' + receiptStatus.sql + " AS TEXT) = 'Recebido Total'";
  var partition = 'PARTITION BY ' + invoiceKey.sql;
  var freightTotal = 'MAX(CASE WHEN ' + eligible + ' THEN ' + freight.sql + ' ELSE NULL END) OVER (' + partition + ')';
  var quantityTotal = 'SUM(CASE WHEN ' + eligible + ' THEN ' + quantity.sql + ' ELSE 0 END) OVER (' + partition + ')';
  return {
    sql: 'CASE WHEN ' + eligible + ' THEN COALESCE((' + freightTotal + ') * (' + quantity.sql + ') / NULLIF((' + quantityTotal + '), 0), 0) ELSE 0 END',
    meta: { dataType: 'numeric', columnType: 'numeric', pgType: 'numeric', nullable: 'YES' }
  };
}

async function compileDaxScalarExpression(expression, context) {
  // VAR/RETURN usa o mesmo expansor seguro das medidas. A substituicao ignora
  // nomes dentro de strings, tabelas entre aspas e referencias entre colchetes.
  var text = stripBalancedOuterParens(expandDaxVariables(expression));
  if (!text) throw apiError('Expressao DAX vazia.', 400);
  if (/^FRETERATEIO\s*\(/i.test(text) && /\)\s*$/.test(text)) return daxFreightAllocationLineExpression(text, context);
  if (/^IF\s*\(/i.test(text) && /\)\s*$/.test(text)) return daxIfExpression(text, context);
  if (/^LOOKUPVALUE\s*\(/i.test(text) && /\)\s*$/.test(text)) return daxLookupValueExpression(text, context);
  if (/^RELATED\s*\(/i.test(text) && /\)\s*$/.test(text)) {
    return daxRelatedExpression(text.replace(/^RELATED\s*\(/i, '').replace(/\)\s*$/, ''), context);
  }
  if (/^CALCULATE\s*\(/i.test(text) && /\)\s*$/.test(text)) return daxCalculateExpression(text, context);
  var concatParts = splitTopLevelDaxOperator(text, '&');
  if (concatParts.length > 1) {
    var compiledParts = [];
    for (var i = 0; i < concatParts.length; i++) compiledParts.push(await compileDaxScalarExpression(concatParts[i], context));
    return {
      sql: 'CONCAT(' + compiledParts.map(pgDaxConcatenationOperandSql).join(', ') + ')',
      meta: { dataType: 'text', columnType: 'text', pgType: 'text', nullable: 'YES' }
    };
  }
  var literal = daxDoubleQuotedLiteral(text);
  if (literal !== null) return { sql: quotePgLiteral(literal), meta: { dataType: 'text', columnType: 'text', pgType: 'text', nullable: 'YES' } };
  if (/^BLANK\s*\(\s*\)$/i.test(text)) return { sql: 'NULL', meta: { dataType: 'text', columnType: 'text', pgType: 'text', nullable: 'YES' } };
  if (/^(TRUE|FALSE)\s*\(\s*\)$/i.test(text) || /^(TRUE|FALSE)$/i.test(text)) return { sql: /^TRUE/i.test(text) ? 'TRUE' : 'FALSE', meta: { dataType: 'boolean', columnType: 'boolean', pgType: 'boolean', nullable: 'YES' } };
  if (/^-?\d+(?:[.,]\d+)?$/.test(text)) return { sql: text.replace(',', '.'), meta: { dataType: 'numeric', columnType: 'numeric', pgType: 'numeric', nullable: 'YES' } };
  var reference = parseDaxColumnReference(text);
  if (reference) return resolveDaxReferenceSql(reference, context, null);

  // Expressoes aritmeticas simples continuam linha a linha e nao agregam dados.
  var replacements = [];
  var replaced = text.replace(/(?:(?:'[^']+')|(?:[A-Za-z_][^\[+\-*\/(),=]*))?\[[^\]]+\]/g, function(token) {
    var marker = '__DAXREF_' + replacements.length + '__';
    replacements.push({ marker: marker, reference: parseDaxColumnReference(token) });
    return marker;
  });
  if (!replacements.length || /[^A-Za-z0-9_+\-*\/().,\s]/.test(replaced)) throw apiError('Formula DAX de coluna ainda nao suportada: ' + text, 400);
  for (var r = 0; r < replacements.length; r++) {
    var resolved = await resolveDaxReferenceSql(replacements[r].reference, context, null);
    replaced = replaced.replace(replacements[r].marker, '(' + resolved.sql + ')');
  }
  var residue = replaced.replace(/\([^)]*\)/g, '').replace(/-?\d+(?:[.,]\d+)?/g, '').replace(/[+\-*\/().,\s]/g, '');
  if (residue) throw apiError('Funcao nao suportada na expressao aritmetica DAX: ' + residue, 400);
  return { sql: '(' + replaced.replace(/(\d),(\d)/g, '$1.$2') + ')', meta: { dataType: 'numeric', columnType: 'numeric', pgType: 'numeric', nullable: 'YES' } };
}

function pgFillExpression(field, value) {
  var type = String(field.meta.pgType || field.meta.dataType || 'text').toLowerCase();
  var raw = String(value == null ? '' : value).trim();
  if (/char|text|json|uuid|enum/i.test(type)) return 'COALESCE(NULLIF(BTRIM(CAST(' + field.expr + ' AS TEXT)), \'\'), ' + quotePgLiteral(raw) + ')';
  if (/int|numeric|decimal|double|real|float|money/i.test(type)) {
    var numeric = raw.replace(',', '.');
    if (!/^-?\d+(?:\.\d+)?$/.test(numeric)) throw apiError('Use um numero valido para preencher a coluna ' + field.meta.name + '.', 400);
    return 'COALESCE(' + field.expr + ', ' + numeric + ')';
  }
  if (/date|timestamp|time/i.test(type)) {
    if (/^(hoje|today)$/i.test(raw)) return 'COALESCE(' + field.expr + ', CURRENT_DATE)';
    if (!/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/.test(raw)) throw apiError('Use uma data ISO valida para preencher a coluna ' + field.meta.name + '.', 400);
    return 'COALESCE(' + field.expr + ', ' + quotePgLiteral(raw) + '::' + (/timestamp/i.test(type) ? 'timestamp' : /time/i.test(type) ? 'time' : 'date') + ')';
  }
  if (/bool/i.test(type)) {
    if (!/^(true|false|1|0|sim|nao|não)$/i.test(raw)) throw apiError('Use true/false para preencher a coluna ' + field.meta.name + '.', 400);
    return 'COALESCE(' + field.expr + ', ' + (/^(true|1|sim)$/i.test(raw) ? 'TRUE' : 'FALSE') + ')';
  }
  return 'COALESCE(' + field.expr + ', ' + quotePgLiteral(raw) + ')';
}

function pgCastModeledField(field, dataType) {
  var normalized = normalizeTransformDataType(dataType);
  var expr = field.expr;
  if (normalized === 'inteiro') return { expr: 'CAST(NULLIF(CAST(' + expr + ' AS TEXT), \'\') AS BIGINT)', dataType: 'integer', columnType: 'bigint', pgType: 'bigint' };
  if (normalized === 'decimal') return { expr: 'CAST(NULLIF(CAST(' + expr + ' AS TEXT), \'\') AS NUMERIC)', dataType: 'numeric', columnType: 'numeric', pgType: 'numeric' };
  if (normalized === 'data') return { expr: 'CAST(NULLIF(CAST(' + expr + ' AS TEXT), \'\') AS DATE)', dataType: 'date', columnType: 'date', pgType: 'date' };
  if (normalized === 'datetime') return { expr: 'CAST(NULLIF(CAST(' + expr + ' AS TEXT), \'\') AS TIMESTAMP)', dataType: 'timestamp', columnType: 'timestamp', pgType: 'timestamp' };
  if (normalized === 'hora') return { expr: 'CAST(NULLIF(CAST(' + expr + ' AS TEXT), \'\') AS TIME)', dataType: 'time', columnType: 'time', pgType: 'time' };
  if (normalized === 'bool') return { expr: 'CAST(NULLIF(CAST(' + expr + ' AS TEXT), \'\') AS BOOLEAN)', dataType: 'boolean', columnType: 'boolean', pgType: 'boolean' };
  return { expr: 'CAST(' + expr + ' AS TEXT)', dataType: 'text', columnType: 'text', pgType: 'text' };
}

async function applyPgModelingStepsToFields(fields, context, inputSteps) {
  var steps = pgModelingSteps(inputSteps);
  for (var i = 0; i < steps.length; i++) {
    var step = steps[i];
    if (step.kind === 'fillValues') {
      var fillField = fields.get(pgModelKey(step.column));
      if (!fillField) throw apiError('Coluna para preencher nao encontrada: ' + step.column, 400);
      fillField.expr = pgFillExpression(fillField, step.value);
      continue;
    }
    if (step.kind === 'daxColumn') {
      var definition = parseDaxColumnDefinition(step.expression || ((step.newName || '') + ' = ' + (step.formula || '')));
      var duplicate = fields.get(pgModelKey(definition.name));
      if (duplicate && !step.replaceExisting) throw apiError('Ja existe uma coluna com este nome: ' + definition.name, 400);
      var compiled = await compileDaxScalarExpression(definition.expression, context);
      var meta = Object.assign({ name: definition.name, dataType: 'text', columnType: 'text', pgType: 'text', columnKey: '', nullable: 'YES', defaultValue: null, extra: '' }, compiled.meta || {}, { name: definition.name, columnKey: '', extra: '' });
      fields.set(pgModelKey(definition.name), { expr: compiled.sql, meta: meta, derived: !duplicate, replaced: Boolean(duplicate), formula: definition.formula });
      continue;
    }
    if (step.kind === 'changeType') {
      var modeledField = fields.get(pgModelKey(step.column));
      if (!modeledField || !modeledField.derived) throw apiError('Coluna DAX para formatar nao encontrada: ' + step.column, 400);
      var casted = pgCastModeledField(modeledField, step.dataType);
      modeledField.expr = casted.expr;
      modeledField.meta = Object.assign({}, modeledField.meta, casted, { name: modeledField.meta.name });
    }
  }
  return steps;
}

async function buildPgModelProjection(imported, overrideSteps) {
  if (!imported || !imported.sourceTable) throw apiError('Tabela importada nao encontrada para modelagem.', 404);
  var rawMeta = await getPgCacheMeta(imported.sourceTable);
  if (!rawMeta || !rawMeta.cache_table) throw apiError('Tabela sem cache PostgreSQL: ' + imported.name, 409);
  var physicalColumns = await pgRelationColumns(rawMeta.cache_table);
  if (!physicalColumns.length) throw apiError('Tabela PostgreSQL sem colunas: ' + imported.name, 409);
  var steps = pgImportedEffectiveSteps(imported, overrideSteps);
  var baseNames = [imported.name, imported.sourceTable, rawMeta.source_table, rawMeta.physical_table].filter(Boolean);
  var effective;
  if (steps.every(function(step) { return ['daxColumn', 'fillValues', 'changeType'].includes(step.kind); })) {
    var fields = new Map();
    physicalColumns.forEach(function(meta) {
      fields.set(pgModelKey(meta.name), { expr: 'src.' + quotePgIdent(meta.name), meta: Object.assign({}, meta), derived: false });
    });
    var context = { baseTable: imported.name, baseNames: baseNames, fields: fields, lookupJoins: [] };
    var optimizedSteps = await applyPgModelingStepsToFields(fields, context, steps);
    var ordered = [];
    physicalColumns.forEach(function(column) { ordered.push(fields.get(pgModelKey(column.name))); });
    fields.forEach(function(field) { if (field.derived) ordered.push(field); });
    effective = {
      sql: optimizedSteps.length
        ? 'SELECT ' + ordered.map(function(field) { return field.expr + ' AS ' + quotePgIdent(field.meta.name); }).join(', ') + ' FROM ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, rawMeta.cache_table) + ' src ' + context.lookupJoins.join(' ')
        : 'SELECT * FROM ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, rawMeta.cache_table),
      columns: ordered.map(function(field) { return field.meta; }),
      steps: steps
    };
  } else {
    effective = await buildPgEffectiveTransformPipeline(
      'SELECT * FROM ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, rawMeta.cache_table),
      physicalColumns,
      steps,
      { baseTable: imported.name, baseNames: baseNames }
    );
  }
  return {
    rawMeta: rawMeta,
    steps: effective.steps,
    columns: effective.columns,
    sql: effective.sql,
    signature: pgModelConfigSignature(imported, rawMeta, overrideSteps === undefined ? imported.steps : overrideSteps)
  };
}

async function dropPgModelView(sourceTable) {
  if (!postgresCacheAvailable()) return;
  var lookup = await resolvePgCacheLookup(sourceTable);
  var physical = lookup.table || sourceTable;
  var key = pgModelKey(physical);
  pgModelViewCache.delete(key);
  var legacyName = pgLegacyModelViewNameFor(physical);
  var versionPrefix = pgModelViewPrefixFor(physical) + '_';
  var result = await pgCacheQuery(
    'SELECT viewname FROM pg_views WHERE schemaname = $1 AND (viewname = $2 OR viewname LIKE $3 ESCAPE \'\\\')',
    [POSTGRES_CACHE_SCHEMA, legacyName, pgLikeEscape(versionPrefix) + '%']
  );
  for (var i = 0; i < (result.rows || []).length; i++) {
    var viewName = result.rows[i] && result.rows[i].viewname;
    if (!viewName) continue;
    // Somente views internas derivadas sao removidas. CASCADE inclui tabelas DAX
    // antigas dependentes e elas sao recriadas automaticamente no proximo acesso.
    await pgCacheQuery('DROP VIEW IF EXISTS ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, viewName) + ' CASCADE');
  }
}

async function refreshPgModelView(imported, overrideSteps) {
  var physical = String(imported && imported.sourceTable || '').trim();
  if (!physical || !postgresCacheAvailable()) return null;
  var key = pgModelKey(physical);
  var projection = await buildPgModelProjection(imported, overrideSteps);
  if (!projection.steps.length) {
    // A view anterior pode continuar sustentando uma tabela DAX ja aberta. Ela
    // deixa de ser usada imediatamente pelo metadado efetivo e sera limpa numa
    // futura troca do cache fisico, sem bloquear a exclusao da etapa.
    pgModelViewCache.delete(key);
    return null;
  }
  // A assinatura faz alteracoes de esquema (inclusive exclusao de coluna) criarem
  // uma nova view. Isso preserva relatorios e tabelas DAX que ainda usam a versao
  // anterior durante a troca e nao exige ressincronizacao do MySQL.
  var viewName = pgModelViewNameFor(physical, projection.signature);
  await pgCacheQuery('CREATE OR REPLACE VIEW ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, viewName) + ' AS ' + projection.sql);
  var effective = Object.assign({}, projection.rawMeta, {
    cache_table: viewName,
    columns: projection.columns,
    modeled: true,
    physical_cache_table: projection.rawMeta.cache_table,
    modeling_steps: projection.steps.length
  });
  pgModelViewCache.set(key, { signature: projection.signature, meta: effective });
  return effective;
}

async function getPgEffectiveMeta(table) {
  var rawLookup = await getRawPgMetaForLogicalTable(table);
  if (!rawLookup.meta) {
    var calculatedTransform = await findTransformByName(table);
    if (calculatedTransform && calculatedTransform.daxExpression) return ensureDaxCalculatedTableView(calculatedTransform);
    if (calculatedTransform) return ensurePgTransformQueryView(calculatedTransform);
    return null;
  }
  var imported = rawLookup.lookup.imported || await findImportedTableByName(table);
  var steps = pgImportedEffectiveSteps(imported);
  if (!imported || !steps.length) return rawLookup.meta;
  var key = pgModelKey(imported.sourceTable);
  var cached = pgModelViewCache.get(key);
  var signature = pgModelConfigSignature(imported, rawLookup.meta, imported.steps);
  if (cached && cached.signature === signature) return cached.meta;
  return refreshPgModelView(imported);
}

async function previewPgModelingSteps(source, steps, limit) {
  var imported = await findImportedTableByName(source);
  if (!imported) throw apiError('Selecione uma tabela importada para modelar colunas.', 400);
  var projection = await buildPgModelProjection(imported, steps);
  var safeLimit = clampLimit(limit, 200);
  var result = await pgCacheQuery('SELECT * FROM (' + projection.sql + ') bi_model_preview LIMIT $1', [safeLimit]);
  return {
    ok: true,
    sql: projection.sql,
    rows: serializeRows(result.rows || []),
    fields: projection.columns.map(function(column) {
      return { name: column.name, type: column.dataType || column.columnType || column.pgType || 'text' };
    }),
    columns: projection.columns.map(function(col) { return col.name; }),
    columnFormats: buildColumnFormatsFromMetadata(projection.columns),
    fromCache: true,
    cacheEngine: 'postgres-model'
  };
}

async function previewDaxCalculatedModelingSteps(transform, steps, limit) {
  if (!transform || !transform.daxExpression) throw apiError('Tabela calculada DAX nao encontrada para modelagem.', 404);
  var modeledTransform = Object.assign({}, transform, { steps: Array.isArray(steps) ? steps : (transform.steps || []) });
  var projection = await buildDaxCalculatedTableProjection(modeledTransform);
  var safeLimit = clampLimit(limit, 200);
  var result = await pgCacheQuery('SELECT * FROM (' + projection.sql + ') bi_dax_model_preview LIMIT $1', [safeLimit]);
  return {
    ok: true,
    sql: projection.sql,
    rows: serializeRows(result.rows || []),
    fields: projection.columns.map(function(column) {
      return { name: column.name, type: column.dataType || column.columnType || column.pgType || 'text' };
    }),
    columns: projection.columns.map(function(col) { return col.name; }),
    columnFormats: buildColumnFormatsFromMetadata(projection.columns),
    fromCache: true,
    cacheEngine: 'postgres-dax-table-model'
  };
}

function pgAnalyticsIndexName(sourceTable, column) {
  return 'idx_biwa_' + crypto.createHash('sha1').update(String(sourceTable || '') + '|' + String(column || '')).digest('hex').slice(0, 18);
}

async function pgAnalyticsIndexFields() {
  const fields = new Map();
  const add = (table, column) => {
    const tableKey = String(table || '').trim().toLowerCase();
    const field = String(column || '').trim();
    if (!tableKey || !field || tableKey === CALENDAR_TABLE_NAME.toLowerCase()) return;
    if (!fields.has(tableKey)) fields.set(tableKey, new Set());
    fields.get(tableKey).add(field);
  };
  const model = await readSemanticModel();
  for (const relationship of Array.isArray(model && model.relationships) ? model.relationships : []) {
    if (!relationship || relationship.active === false) continue;
    add(relationship.fromTable, relationship.fromColumn);
    add(relationship.toTable, relationship.toColumn);
  }
  const reports = await readReports();
  for (const report of reports) {
    for (const filter of normalizeOnlineFilters(report && report.onlineFilters)) add(filter.table, filter.field);
    const visuals = Array.isArray(report && report.visuals) ? report.visuals : [];
    const fallbackTable = String(report && report.table || (visuals[0] && visuals[0].table) || '').trim();
    for (const visual of visuals) {
      const visualTable = String(visual && visual.table || fallbackTable).trim();
      add(visualTable, visual && visual.filterColumn);
      add(visualTable, visual && visual.dimension);
      for (const field of Array.isArray(visual && visual.selectedFields) ? visual.selectedFields : []) {
        if (String(field && field.type || '').toLowerCase() === 'measure') continue;
        add(field && field.table || visualTable, field && (field.name || field.column));
      }
      for (const filter of Array.isArray(visual && visual.visualFilters) ? visual.visualFilters : []) {
        add(filter && filter.table || visualTable, filter && (filter.column || filter.field));
      }
    }
    for (const filter of Array.isArray(report && report.pageFilters) ? report.pageFilters : []) {
      add(filter && filter.table || fallbackTable, filter && (filter.column || filter.field));
    }
    for (const filter of Array.isArray(report && report.allPagesFilters) ? report.allPagesFilters : []) {
      add(filter && filter.table || fallbackTable, filter && (filter.column || filter.field));
    }
  }
  return fields;
}

async function ensurePgCacheAnalyticsIndexes(sourceTable = '') {
  if (!postgresCacheAvailable()) return 0;
  const requested = String(sourceTable || '').trim().toLowerCase();
  const fields = await pgAnalyticsIndexFields();
  const statuses = await listPgCacheStatus();
  let created = 0;
  for (const status of statuses) {
    const source = String(status && status.sourceTable || '').trim();
    if (!source || (requested && source.toLowerCase() !== requested)) continue;
    const requestedFields = fields.get(source.toLowerCase());
    if (!requestedFields || !requestedFields.size) continue;
    const meta = await getPgCacheMeta(source);
    if (!meta || !meta.cache_table) continue;
    const columns = new Map((meta.columns || []).map((column) => [String(column && (column.name || column.Field) || column).toLowerCase(), String(column && (column.name || column.Field) || column)]));
    for (const requestedField of requestedFields) {
      const actualField = columns.get(String(requestedField).toLowerCase());
      if (!actualField) continue;
      const indexName = pgAnalyticsIndexName(source, actualField);
      await pgCacheQuery('CREATE INDEX IF NOT EXISTS ' + quotePgIdent(indexName) + ' ON ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, meta.cache_table) + ' (' + quotePgIdent(actualField) + ')');
      created += 1;
    }
  }
  return created;
}

async function listPgCacheStatus(options) {
  if (!postgresCacheAvailable()) return [];
  options = options || {};
  await ensurePgCacheSchema();
  var result = await pgCacheQuery('SELECT source_table, cache_table, physical_table, row_count, synced_at, last_data_update_at, sync_mode, sync_strategy, sync_column, primary_keys, last_changed_rows FROM ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, '__biwa_cache_meta') + ' ORDER BY row_count DESC');
  var items = (result.rows || []).map(function(r) {
    return {
      sourceTable: r.source_table,
      cacheTable: r.cache_table,
      physicalTable: r.physical_table,
      rowCount: Number(r.row_count || 0),
      syncedAt: r.synced_at,
      syncMode: r.sync_mode,
      syncStrategy: r.sync_strategy,
      syncColumn: r.sync_column || '',
      primaryKeys: Array.isArray(r.primary_keys) ? r.primary_keys : [],
      lastChangedRows: Number(r.last_changed_rows || 0),
      lastDataUpdateAt: r.last_data_update_at || (Number(r.last_changed_rows || 0) > 0 ? r.synced_at : null),
      exists: true
    };
  });
  if (options.includeActualCounts) {
    items = await Promise.all(items.map(hydratePgCacheStatusWithActualCount));
  }
  return items;
}

function extractDashboardTableNames(report) {
  var names = [];
  function add(name) {
    var value = String(name || '').trim();
    if (!value || /^medidas$/i.test(value)) return;
    names.push(value);
  }
  function addFromSql(sql) {
    var text = String(sql || '');
    if (!text) return;
    var tableRegex = /(?:FROM|JOIN)\s+(?:`([^`]+)`|"([^"]+)"|([A-Za-z_][\w.]*))(?:\s+(?:AS\s+)?[A-Za-z_]\w*)?/gi;
    var match;
    while ((match = tableRegex.exec(text)) !== null) add(match[1] || match[2] || match[3]);
  }
  if (!report || typeof report !== 'object') return [];
  add(report.table);
  addFromSql(report.sql);
  (Array.isArray(report.visuals) ? report.visuals : []).forEach(function(visual) {
    add(visual && visual.table);
    addFromSql(visual && visual.sql);
  });
  (Array.isArray(report.onlineFilters) ? report.onlineFilters : []).forEach(function(filter) {
    add(filter && (filter.table || filter.source || filter.resource));
  });
  var unique = new Map();
  names.map(function(name) { return String(name || '').trim(); }).filter(Boolean).forEach(function(name) {
    var key = name.toLowerCase();
    if (!unique.has(key)) unique.set(key, name);
  });
  return Array.from(unique.values());
}

async function dashboardPostgresCacheCoverage(report) {
  var tables = extractDashboardTableNames(report);
  var coverage = {
    kind: 'postgres',
    enabled: POSTGRES_CACHE_ENABLED,
    available: postgresCacheAvailable(),
    totalTables: tables.length,
    cachedTables: 0,
    missingTables: 0,
    lastSyncAt: null,
    lastDataUpdateAt: null,
    lastCheckAt: null,
    tables: []
  };
  if (!coverage.available) {
    coverage.missingTables = tables.length;
    coverage.tables = tables.map(function(table) {
      return { table: table, cached: false, rowCount: 0, syncedAt: null, cacheTable: '', physicalTable: '', reason: 'postgres_offline' };
    });
    return coverage;
  }
  await ensurePgCacheSchema();
  for (var i = 0; i < tables.length; i++) {
    var table = tables[i];
    var meta = null;
    try { meta = await getPgCacheMeta(table); } catch (err) { meta = null; }
    if (meta && Number(meta.row_count || 0) > 0) {
      coverage.cachedTables += 1;
      var syncedAt = normalizeHealthTimestamp(meta.synced_at);
      var lastDataUpdateAt = normalizeHealthTimestamp(meta.last_data_update_at);
      if (syncedAt && (!coverage.lastCheckAt || new Date(syncedAt) > new Date(coverage.lastCheckAt))) coverage.lastCheckAt = syncedAt;
      if (String(table || '').toLowerCase() !== CALENDAR_TABLE_NAME.toLowerCase()
        && lastDataUpdateAt
        && (!coverage.lastDataUpdateAt || new Date(lastDataUpdateAt) > new Date(coverage.lastDataUpdateAt))) {
        coverage.lastDataUpdateAt = lastDataUpdateAt;
        coverage.lastSyncAt = lastDataUpdateAt;
      }
      coverage.tables.push({
        table: table,
        cached: true,
        rowCount: Number(meta.row_count || 0),
        syncedAt: syncedAt,
        lastDataUpdateAt: lastDataUpdateAt,
        cacheTable: meta.cache_table || '',
        physicalTable: meta.physical_table || '',
        syncMode: meta.sync_mode || '',
        syncStrategy: meta.sync_strategy || ''
      });
    } else {
      coverage.missingTables += 1;
      coverage.tables.push({ table: table, cached: false, rowCount: 0, syncedAt: null, cacheTable: '', physicalTable: '', reason: 'cache_missing_or_empty' });
    }
  }
  return coverage;
}

async function getPgCacheActualRowCount(cacheTable) {
  if (!cacheTable) return null;
  try {
    var result = await pgCacheQuery('SELECT COUNT(*) AS cnt FROM ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, cacheTable));
    return Number(result.rows && result.rows[0] ? result.rows[0].cnt || 0 : 0);
  } catch (e) {
    return null;
  }
}

function pgLikeEscape(value) {
  return String(value || '').replace(/[\\%_]/g, function(ch) { return '\\' + ch; });
}

async function cleanupPgCacheStageTables(cacheTable) {
  if (!cacheTable) return 0;
  try {
    var prefix = cacheTable + '_stage_';
    var result = await pgCacheQuery(
      'SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename LIKE $2 ESCAPE \'\\\'',
      [POSTGRES_CACHE_SCHEMA, pgLikeEscape(prefix) + '%']
    );
    var dropped = 0;
    for (var i = 0; i < (result.rows || []).length; i++) {
      var name = result.rows[i].tablename;
      if (!name) continue;
      await pgCacheQuery('DROP TABLE IF EXISTS ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, name));
      dropped += 1;
    }
    return dropped;
  } catch (e) {
    console.warn('[PG Cache] Nao foi possivel limpar staging de ' + cacheTable + ':', e.message);
    return 0;
  }
}

async function cleanupAllPgCacheStageTables() {
  if (!postgresCacheAvailable()) return 0;
  await ensurePgCacheSchema();
  var result = await pgCacheQuery(
    "SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename ~ '^cache_[0-9a-f]+_stage_'",
    [POSTGRES_CACHE_SCHEMA]
  );
  var dropped = 0;
  for (var i = 0; i < (result.rows || []).length; i++) {
    var tableName = result.rows[i].tablename;
    if (!tableName) continue;
    await pgCacheQuery('DROP TABLE IF EXISTS ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, tableName));
    dropped += 1;
  }
  return dropped;
}

async function hydratePgCacheStatusWithActualCount(item) {
  if (!item || !item.cacheTable) return item;
  var actual = await getPgCacheActualRowCount(item.cacheTable);
  if (actual === null) return Object.assign({}, item, { exists: false });
  return Object.assign({}, item, {
    metaRowCount: Number(item.rowCount || 0),
    actualRowCount: actual,
    rowCount: actual,
    exists: true
  });
}

async function hydratePgCacheMetaWithActualCount(meta) {
  if (!meta || !meta.cache_table) return meta;
  var actual = await getPgCacheActualRowCount(meta.cache_table);
  if (actual === null) return meta;
  var cloned = Object.assign({}, meta);
  cloned.meta_row_count = Number(meta.row_count || 0);
  cloned.actual_row_count = actual;
  cloned.row_count = actual;
  return cloned;
}

var pgCacheSchemaReady = false;
var pgCacheSchemaPromise = null;

async function ensurePgCacheSchema() {
  if (!postgresCacheAvailable() || pgCacheSchemaReady) return;
  if (pgCacheSchemaPromise) return pgCacheSchemaPromise;
  pgCacheSchemaPromise = (async function() {
    await pgCacheQuery('CREATE SCHEMA IF NOT EXISTS ' + quotePgIdent(POSTGRES_CACHE_SCHEMA));
    await pgCacheQuery('CREATE TABLE IF NOT EXISTS ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, '__biwa_cache_meta') + ' (source_table TEXT PRIMARY KEY, cache_table TEXT, physical_table TEXT, columns_json JSONB, row_count INTEGER DEFAULT 0, synced_at TIMESTAMPTZ, last_data_update_at TIMESTAMPTZ, sync_mode TEXT, last_error TEXT, last_marker TEXT, source_marker TEXT, sync_strategy TEXT, sync_column TEXT, primary_keys JSONB, last_changed_rows INTEGER DEFAULT 0)');
    await pgCacheQuery('ALTER TABLE ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, '__biwa_cache_meta') + ' ADD COLUMN IF NOT EXISTS source_marker TEXT');
    await pgCacheQuery('ALTER TABLE ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, '__biwa_cache_meta') + ' ADD COLUMN IF NOT EXISTS last_data_update_at TIMESTAMPTZ');
    await pgCacheQuery('ALTER TABLE ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, '__biwa_cache_meta') + ' ALTER COLUMN synced_at TYPE TIMESTAMPTZ USING NULLIF(synced_at::text, \'\')::timestamptz');
    await pgCacheQuery('ALTER TABLE ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, '__biwa_cache_meta') + ' ALTER COLUMN last_data_update_at TYPE TIMESTAMPTZ USING NULLIF(last_data_update_at::text, \'\')::timestamptz');
    await pgCacheQuery('CREATE TABLE IF NOT EXISTS ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, '__biwa_cache_sync_log') + ' (id SERIAL PRIMARY KEY, source_table TEXT NOT NULL, synced_at TIMESTAMPTZ NOT NULL, sync_mode TEXT, sync_strategy TEXT, sync_column TEXT, row_count INTEGER DEFAULT 0, changed_rows INTEGER DEFAULT 0)');
    await pgCacheQuery('ALTER TABLE ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, '__biwa_cache_sync_log') + ' ALTER COLUMN synced_at TYPE TIMESTAMPTZ USING NULLIF(synced_at::text, \'\')::timestamptz');
    await pgCacheQuery('CREATE INDEX IF NOT EXISTS idx_sync_log_table_time ON ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, '__biwa_cache_sync_log') + ' (LOWER(source_table), synced_at DESC)');
    await pgCacheQuery('CREATE INDEX IF NOT EXISTS idx_sync_log_data_update ON ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, '__biwa_cache_sync_log') + ' (synced_at DESC) WHERE changed_rows > 0');
    await pgCacheQuery(
      'UPDATE ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, '__biwa_cache_meta') + ' AS meta SET last_data_update_at = history.last_data_update_at FROM (' +
      'SELECT LOWER(source_table) AS source_key, MAX(synced_at) AS last_data_update_at FROM ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, '__biwa_cache_sync_log') + ' WHERE changed_rows > 0 GROUP BY LOWER(source_table)' +
      ') AS history WHERE LOWER(meta.source_table) = history.source_key AND meta.last_data_update_at IS NULL'
    );
  })();
  try {
    await pgCacheSchemaPromise;
    pgCacheSchemaReady = true;
  } finally {
    pgCacheSchemaPromise = null;
  }
}

var pgCachePool = null;
var pgCacheConfigCache = null;

function getPgCachePool() {
  if (!pgCachePool) {
    pgCachePool = new PgPool(pgCachePoolConfig());
  }
  return pgCachePool;
}

function pgCachePoolConfig() {
  if (pgCacheConfigCache) return pgCacheConfigCache;
  var url = POSTGRES_CACHE_DATABASE_URL;
  var poolMax = Math.max(4, Number(process.env.BIWA_PG_CACHE_POOL_MAX || 12));
  var connectionTimeoutMillis = Math.max(5000, Number(process.env.BIWA_PG_CACHE_CONNECT_TIMEOUT_MS || 15000));
  if (url) {
    pgCacheConfigCache = { connectionString: url, max: poolMax, idleTimeoutMillis: 30000, connectionTimeoutMillis: connectionTimeoutMillis };
  } else {
    pgCacheConfigCache = {
      host: POSTGRES_CACHE_HOST,
      port: Number(process.env.BIWA_PG_CACHE_PORT || 5432),
      database: process.env.BIWA_PG_CACHE_DATABASE || process.env.BIWA_PG_CACHE_DB || 'bi_wa_cache',
      user: process.env.BIWA_PG_CACHE_USER || process.env.BIWA_PG_CACHE_USERNAME || 'postgres',
      max: poolMax,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: connectionTimeoutMillis
    };
    var pgPass = process.env.BIWA_PG_CACHE_PASSWORD;
    if (pgPass) pgCacheConfigCache.password = pgPass;
  }
  return pgCacheConfigCache;
}

function syncTableToPgCacheIfAvailable(sourceTable, mode) {
  if (!postgresCacheAvailable()) return Promise.resolve(null);
  return syncTableToPostgresCache(sourceTable, { mode: mode || 'incremental', batchSize: 10000, recentDays: getSettings().pgCache && getSettings().pgCache.recentWindowDays || 90 }).catch(function(err) {
    console.error('[PG Cache] sync error for ' + sourceTable + ':', err.message);
    return null;
  });
}

async function isManualTableDataSource(sourceTable) {
  const requested = String(sourceTable || '').trim().toLowerCase();
  if (!requested) return false;
  try {
    const manualTables = await readManualTables();
    if (manualTables.some(function(name) { return String(name || '').trim().toLowerCase() === requested; })) return true;
  } catch (err) {}
  if (postgresCacheAvailable()) {
    try {
      const meta = await getPgCacheMeta(sourceTable);
      if (meta && meta.sync_mode === 'manual') return true;
    } catch (err) {}
  }
  return false;
}

// Funcoes de sync PG (stubs - sincronizacao via API /api/postgres-cache/:table/sync)
var pgSyncLocks = new Map();
var pgCacheProgress = new Map();

function getPgCacheProgress(table) { return pgCacheProgress.get(String(table || '').toLowerCase()) || null; }
function setPgCacheProgress(table, data) {
  var key = String(table || '').toLowerCase();
  var reset = data && (data.phase === 'init' || data.status === 'starting');
  var current = reset ? {} : (pgCacheProgress.get(key) || {});
  pgCacheProgress.set(key, { ...current, ...(data || {}) });
}
function clearPgCacheProgress(table) { pgCacheProgress.delete(String(table || '').toLowerCase()); }

async function runWithPgSyncLock(sourceTable, fn) {
  var key = String(sourceTable || '').toLowerCase();
  while (pgSyncLocks.has(key)) { await new Promise(function(r) { return setTimeout(r, 100); }); }
  pgSyncLocks.set(key, true);
  try { return await fn(); } finally { pgSyncLocks.delete(key); }
}

async function syncTableToPostgresCache(sourceTable, options) {
  options = options || {};
  if (await isManualTableDataSource(sourceTable)) {
    throw apiError('Tabelas manuais nao recebem sincronizacao do MySQL. Seus dados so mudam por edicao direta no BI WA.', 400);
  }
  return runWithPgSyncLock(sourceTable, async function() {
    try {
      return await _syncTableToPostgresCacheInner(sourceTable, options).catch(async function(err) {
      var existing = null;
      try { existing = await getPgCacheMeta(sourceTable); } catch (e) { existing = null; }
      if (existing && String(options.mode || '').toLowerCase() === 'auto' && isRecoverablePgCacheSourceError(err)) {
        var actual = await getPgCacheActualRowCount(existing.cache_table);
        clearPgCacheProgress(sourceTable);
        return {
          rowCount: actual === null ? Number(existing.row_count || 0) : actual,
          syncMode: 'skipped-source-unavailable',
          changedRows: 0,
          skipped: true,
          error: err.message || String(err)
        };
      }
      setPgCacheProgress(sourceTable, {
        phase: 'error',
        rowsCopied: 0,
        totalRows: 0,
        percent: 0,
        status: 'error',
        previewCacheTable: '',
        error: err.message || String(err)
      });
        throw err;
      });
    } finally {
      try {
        var modeledImported = await findImportedTableByName(sourceTable);
        if (modeledImported && pgImportedEffectiveSteps(modeledImported).length) await refreshPgModelView(modeledImported);
      } catch (modelRefreshError) {
        console.error('[PG Model] Nao foi possivel restaurar a view de ' + sourceTable + ':', modelRefreshError.message);
      }
    }
  });
}

function isRecoverablePgCacheSourceError(err) {
  var code = String(err && err.code || '');
  var message = String(err && err.message || err || '');
  return code === 'ER_NO_SUCH_TABLE'
    || code === 'MYSQL_STREAM_INACTIVITY_TIMEOUT'
    || /doesn'?t exist/i.test(message)
    || /Query inactivity timeout/i.test(message)
    || /stream inactivity timeout/i.test(message)
    || /ETIMEDOUT|ECONNRESET|ECONNREFUSED/i.test(message);
}

function sleepMs(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

async function dbQueryWithPgSyncRetry(sql, params, timeoutMs, attempts) {
  var maxAttempts = Math.max(1, Number(attempts || 1));
  var lastErr = null;
  for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await dbQueryWithTimeout(sql, params || [], timeoutMs);
    } catch (err) {
      lastErr = err;
      if (!isRecoverablePgCacheSourceError(err) || attempt >= maxAttempts) throw err;
      await sleepMs(Math.min(15000, 2000 * attempt));
    }
  }
  throw lastErr;
}

function triggerPgCacheSyncForTable(table) {
  if (!postgresCacheAvailable()) return;
  syncTableToPgCacheIfAvailable(table, 'incremental');
}

async function clearPostgresCacheForTable(sourceTable) {
  var meta = await getPgCacheMeta(sourceTable);
  if (!meta) return { ok: true, removed: false, table: String(sourceTable || '') };
  await dropPgModelView(sourceTable);
  await pgCacheQuery('DROP TABLE IF EXISTS ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, meta.cache_table));
  await pgCacheQuery('DELETE FROM ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, '__biwa_cache_meta') + ' WHERE LOWER(source_table) = LOWER($1)', [String(sourceTable || '')]);
  return { ok: true, removed: true, table: String(sourceTable || ''), kind: 'postgres' };
}

async function syncCalendarToPgCache() {
  if (!postgresCacheAvailable()) return;
  var stageTableSql = '';
  try {
    await ensurePgCacheSchema();
    var cols = calendarColumnMetadata();
    var cacheTable = pgCacheTableNameFor(CALENDAR_TABLE_NAME);
    var tableSql = quotePgQualified(POSTGRES_CACHE_SCHEMA, cacheTable);
    var virtual = calendarVirtualRows({});
    var rows = virtual.rows || [];
    var calendarMarker = [virtual.startYear, virtual.endYear, rows.length, cols.map(function(col) { return col.name; }).join('|')].join(':');
    var syncCompletedAt = new Date().toISOString();
    var existing = await getPgCacheMeta(CALENDAR_TABLE_NAME);
    if (existing && existing.cache_table) {
      try {
        var existingSummary = await pgCacheQuery(
          'SELECT COUNT(*)::int AS row_count, MIN(' + quotePgIdent('Data') + ') AS first_date, MAX(' + quotePgIdent('Data') + ') AS last_date FROM ' + tableSql
        );
        var summaryRow = existingSummary.rows && existingSummary.rows[0] || {};
        var firstDate = summaryRow.first_date instanceof Date ? summaryRow.first_date.toISOString().slice(0, 10) : String(summaryRow.first_date || '').slice(0, 10);
        var lastDate = summaryRow.last_date instanceof Date ? summaryRow.last_date.toISOString().slice(0, 10) : String(summaryRow.last_date || '').slice(0, 10);
        var expectedFirstDate = rows.length ? String(rows[0].Data || '').slice(0, 10) : '';
        var expectedLastDate = rows.length ? String(rows[rows.length - 1].Data || '').slice(0, 10) : '';
        if (Number(summaryRow.row_count || 0) === rows.length && firstDate === expectedFirstDate && lastDate === expectedLastDate) {
          await savePgCacheMeta({
            sourceTable: CALENDAR_TABLE_NAME,
            physicalTable: CALENDAR_TABLE_NAME,
            cacheTable: cacheTable,
            columns: cols,
            rowCount: rows.length,
            syncedAt: syncCompletedAt,
            syncMode: 'incremental',
            lastMarker: calendarMarker,
            syncStrategy: 'calendar-check',
            syncColumn: '',
            primaryKeys: ['Data'],
            lastChangedRows: 0
          });
          await insertPgCacheSyncLog({
            sourceTable: CALENDAR_TABLE_NAME,
            syncedAt: syncCompletedAt,
            syncMode: 'incremental',
            syncStrategy: 'calendar-check',
            syncColumn: '',
            rowCount: rows.length,
            changedRows: 0
          });
          return { rowCount: rows.length, syncMode: 'incremental', changedRows: 0 };
        }
      } catch (summaryError) {}
    }
    var stageTable = cacheTable + '_stage_' + Date.now().toString(36);
    stageTableSql = quotePgQualified(POSTGRES_CACHE_SCHEMA, stageTable);
    await pgCacheQuery('DROP TABLE IF EXISTS ' + stageTableSql);
    var columnDefs = cols.map(function(col) { return quotePgIdent(col.name) + ' ' + pgTypeForMysqlColumn(col); }).join(', ');
    columnDefs += ', PRIMARY KEY (' + quotePgIdent('Data') + ')';
    await pgCacheQuery('CREATE TABLE ' + stageTableSql + ' (' + columnDefs + ')');
    if (rows.length) {
      var colNames = cols.map(function(c) { return c.name; });
      var batchSize = 200;
      for (var offset = 0; offset < rows.length; offset += batchSize) {
        var batch = rows.slice(offset, offset + batchSize);
        var params = [];
        var valueGroups = batch.map(function(row) {
          var placeholders = colNames.map(function(column) {
            params.push(row[column]);
            return '$' + params.length;
          });
          return '(' + placeholders.join(', ') + ')';
        });
        var insertSql = 'INSERT INTO ' + stageTableSql + ' (' + colNames.map(quotePgIdent).join(', ') + ') VALUES ' + valueGroups.join(', ');
        await pgCacheQuery(insertSql, params);
      }
    }
    var countResult = await pgCacheQuery('SELECT COUNT(*)::int AS row_count FROM ' + stageTableSql);
    var insertedRows = Number(countResult.rows[0] && countResult.rows[0].row_count || 0);
    if (insertedRows !== rows.length) {
      throw new Error('Calendario incompleto no cache PostgreSQL: ' + insertedRows + ' de ' + rows.length + ' linhas.');
    }
    await pgCacheTransaction(async function(client) {
      await client.query('DROP TABLE IF EXISTS ' + tableSql);
      await client.query('ALTER TABLE ' + stageTableSql + ' RENAME TO ' + quotePgIdent(cacheTable));
    });
    stageTableSql = '';
    await savePgCacheMeta({
      sourceTable: CALENDAR_TABLE_NAME,
      physicalTable: CALENDAR_TABLE_NAME,
      cacheTable: cacheTable,
      columns: cols,
      rowCount: rows.length,
      syncedAt: syncCompletedAt,
      syncMode: 'full',
      lastMarker: calendarMarker,
      syncStrategy: 'calendar-virtual',
      syncColumn: '',
      primaryKeys: ['Data'],
      lastChangedRows: rows.length
    });
    await insertPgCacheSyncLog({
      sourceTable: CALENDAR_TABLE_NAME,
      syncedAt: syncCompletedAt,
      syncMode: 'full',
      syncStrategy: 'calendar-virtual',
      syncColumn: '',
      rowCount: rows.length,
      changedRows: rows.length
    });
    return { rowCount: rows.length, syncMode: 'full', changedRows: rows.length };
  } catch (e) {
    if (stageTableSql) {
      try { await pgCacheQuery('DROP TABLE IF EXISTS ' + stageTableSql); } catch (cleanupErr) {}
    }
    console.error('[PG Cache] Erro ao sincronizar Calendario:', e.message);
    throw e;
  }
}

async function _syncTableToPostgresCacheInner(sourceTable, options) {
  await ensurePgCacheSchema();
  setPgCacheProgress(sourceTable, { phase: 'init', rowsCopied: 0, totalRows: 0, percent: 1, previewCacheTable: '' });
  var physicalTable = sourceTable;
  try { var imported = await findImportedTableByName(sourceTable); if (imported && imported.sourceTable) physicalTable = imported.sourceTable; } catch (e) {}
  if (physicalTable === CALENDAR_TABLE_NAME) {
    setPgCacheProgress(sourceTable, { phase: 'copying', rowsCopied: 0, totalRows: 0, percent: 20 });
    var calendarSyncResult = await syncCalendarToPgCache();
    var calRows = Number(calendarSyncResult && calendarSyncResult.rowCount || 0);
    setPgCacheProgress(sourceTable, { phase: 'done', rowsCopied: calRows, totalRows: calRows, percent: 100 });
    return {
      rowCount: calRows,
      syncMode: calendarSyncResult && calendarSyncResult.syncMode || 'incremental',
      changedRows: Number(calendarSyncResult && calendarSyncResult.changedRows || 0)
    };
  }
  var existing = await getPgCacheMeta(sourceTable);
  var mode = String(options.mode || (existing ? 'incremental' : 'full')).toLowerCase();
  var forceFull = mode === 'full' || mode === 'rebuild' || !existing;
  var batchSize = clampLimit(options.batchSize, 10000);
  var streamMaxRetries = Math.max(0, Number(options.maxRetries != null ? options.maxRetries : 8));
  var streamInactivityTimeoutMs = Math.max(30000, Number(options.streamInactivityTimeoutMs || process.env.BIWA_MYSQL_STREAM_INACTIVITY_TIMEOUT_MS || 300000));
  // A sincronizacao precisa copiar somente as colunas fisicas da origem MySQL.
  // getColumns() pode devolver colunas logicas/calculadas do modelo e fazer o
  // staging divergir da tabela real, especialmente depois de adicionar DAX.
  var columns = await getMysqlColumnsMetadata(physicalTable);
  if (!columns.length) throw new Error('Tabela sem colunas fisicas para cache.');
  setPgCacheProgress(sourceTable, { phase: 'columns', rowsCopied: 0, totalRows: 0, percent: 5 });
  var ctOverrides = getChangeTypePgOverrides(sourceTable);
  var ctHash = changeTypeOverrideHash(ctOverrides);
  var existingCtHash = (existing && existing.last_marker) || '';
  var compatibleChangeTypeSchema = false;
  if (!forceFull && ctHash && ctHash !== existingCtHash) {
    try {
      compatibleChangeTypeSchema = await pgCacheStorageSchemaCompatible(existing.cache_table, columns, ctOverrides);
    } catch (schemaCheckErr) {
      console.warn('[PG Cache] Nao foi possivel validar o schema de ' + sourceTable + ': ' + schemaCheckErr.message);
    }
    if (compatibleChangeTypeSchema) {
      console.log('[PG Cache] changeType alterado para ' + sourceTable + ', mas o schema fisico ja e compativel; mantendo sincronizacao incremental.');
    }
  }
  if (!forceFull && ctHash && ctHash !== existingCtHash && !compatibleChangeTypeSchema) {
    console.log('[PG Cache] changeType steps alterados para ' + sourceTable + ' — forçando full refresh');
    forceFull = true;
  }
  var incrementalColumn = (imported && imported.incrementalColumn) ? String(imported.incrementalColumn).trim() : '';
  if (!incrementalColumn) {
    try {
      var allImported = await readImportedTables();
      var match = allImported.find(function(t) { return t.sourceTable === sourceTable && t.incrementalColumn; });
      if (match) incrementalColumn = String(match.incrementalColumn).trim();
    } catch (e) {}
  }
  var incrementalColumnValid = Boolean(incrementalColumn && columns.some(function(c) { return c.name === incrementalColumn; }));
  var fullIncColMeta = columns.find(function(c) { return c.name === incrementalColumn; });
  var fullIsDateColumn = Boolean(fullIncColMeta && /^(date|datetime|timestamp|data)$/i.test(String(fullIncColMeta.dataType || '')));
  // Em uma recuperacao sem cache, carregar primeiro o ano atual evita tentar
  // varrer todo o historico de uma view/tabela grande antes de entregar a
  // primeira linha. As atualizacoes seguintes usam a janela incremental.
  var initialRecoveryStart = !existing && incrementalColumnValid && fullIsDateColumn
    ? String(currentCalendarDefaultParts().year) + '-01-01'
    : '';
  var fullWhere = initialRecoveryStart ? quoteIdent(incrementalColumn) + ' >= ?' : null;
  var fullWhereParams = initialRecoveryStart ? [initialRecoveryStart] : null;
  var cacheTable = existing && existing.cache_table ? existing.cache_table : pgCacheTableNameFor(sourceTable);
  var tableSql = quotePgQualified(POSTGRES_CACHE_SCHEMA, cacheTable);
  var existingActualRows = null;
  if (!forceFull) {
    existingActualRows = await getPgCacheActualRowCount(cacheTable);
    if (existingActualRows === null || existingActualRows === 0) forceFull = true;
  }
  var sourceCountKnown = null;
  var sourceFingerprint = null;
  if (!forceFull && !incrementalColumnValid) {
    setPgCacheProgress(sourceTable, { phase: 'fingerprint', rowsCopied: 0, totalRows: 0, percent: 6 });
    sourceFingerprint = await getMysqlSourceFingerprint(physicalTable, columns);
    sourceCountKnown = sourceFingerprint.rowCount;
    if (sourceCountKnown !== existingActualRows || (existing.source_marker && existing.source_marker !== sourceFingerprint.marker)) forceFull = true;
  }
  var doIncremental = !forceFull && incrementalColumnValid;
  var loadTableSql = tableSql;
  var stageCacheTable = '';
  var stageTableSql = '';
  var uniqueKeyCols = [];
  var columnDefs = '';
  if (forceFull) {
    columnDefs = columns.map(function(col) { return quotePgIdent(col.name) + ' ' + (ctOverrides[col.name] || pgTypeForMysqlColumn(col)); }).join(', ');
    try {
      var [idxRows] = await dbQueryWithTimeout('SHOW INDEX FROM ' + quoteIdent(physicalTable) + ' WHERE Non_unique = 0', [], 30000);
      if (idxRows && idxRows.length) {
        var idxGroups = {};
        for (var iIdx = 0; iIdx < idxRows.length; iIdx++) {
          var rIdx = idxRows[iIdx];
          var kn = rIdx.Key_name;
          if (!idxGroups[kn]) idxGroups[kn] = [];
          idxGroups[kn].push({ name: rIdx.Column_name, seq: rIdx.Seq_in_index });
        }
        var pkGroup = idxGroups['PRIMARY'];
        var target = pkGroup || Object.values(idxGroups)[0];
        if (target) {
          target.sort(function(a, b) { return (a.seq || 0) - (b.seq || 0); });
          uniqueKeyCols = target.map(function(c) { return c.name; });
        }
      }
    } catch (e) {}
    if (!uniqueKeyCols.length && columns.some(function(c) { return c.columnKey === 'PRI'; })) {
      uniqueKeyCols = columns.filter(function(c) { return c.columnKey === 'PRI'; }).map(function(c) { return c.name; });
    }
    if (uniqueKeyCols.length) {
      var isPk = columns.some(function(c) { return c.columnKey === 'PRI'; });
      if (isPk) {
        columnDefs += ', PRIMARY KEY (' + uniqueKeyCols.map(quotePgIdent).join(', ') + ')';
      } else {
        columnDefs += ', UNIQUE (' + uniqueKeyCols.map(quotePgIdent).join(', ') + ')';
      }
    }
  } else {
    uniqueKeyCols = (existing && existing.primary_keys && existing.primary_keys.length) ? existing.primary_keys : [];
    if (!uniqueKeyCols.length) {
      uniqueKeyCols = columns.filter(function(c) { return c.columnKey === 'PRI'; }).map(function(c) { return c.name; });
    }
  }
  var totalRows = existingActualRows === null ? 0 : existingActualRows;
  if (forceFull) {
    try {
      if (sourceCountKnown === null) {
        if (sourceFingerprint) {
          sourceCountKnown = sourceFingerprint.rowCount;
        } else {
          setPgCacheProgress(sourceTable, { phase: 'counting', rowsCopied: 0, totalRows: 0, percent: 7 });
          var countTimeoutMs = 45000;
          try {
            var countSql = 'SELECT COUNT(*) AS cnt FROM ' + quoteIdent(physicalTable) + (fullWhere ? ' WHERE ' + fullWhere : '');
            var countQueryResult = await dbQueryWithTimeout(countSql, fullWhereParams || [], countTimeoutMs, false);
            sourceCountKnown = Number(countQueryResult && countQueryResult[0] && countQueryResult[0][0] ? countQueryResult[0][0].cnt : 0);
          } catch (countErr) {
            if (isMysqlQueryTimeout(countErr)) {
              console.warn('[PG Cache] COUNT(*) para ' + physicalTable + ' estourou timeout (' + countTimeoutMs + 'ms). Iniciando streaming sem total previo.');
            } else {
              console.warn('[PG Cache] COUNT(*) para ' + physicalTable + ' falhou: ' + countErr.message + '. Iniciando streaming sem total previo.');
            }
            sourceCountKnown = 0;
          }
        }
      }
      totalRows = sourceCountKnown;
    } catch (err) {
      sourceCountKnown = 0;
      totalRows = 0;
      console.warn('[PG Cache] COUNT da origem excedeu o limite para ' + physicalTable + '; iniciando streaming sem total previo.');
    }
  }
  if (forceFull) {
    await cleanupPgCacheStageTables(cacheTable);
    stageCacheTable = (cacheTable + '_stage_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)).slice(0, 60);
    stageTableSql = quotePgQualified(POSTGRES_CACHE_SCHEMA, stageCacheTable);
    loadTableSql = stageTableSql;
    await pgCacheQuery('DROP TABLE IF EXISTS ' + stageTableSql);
    await pgCacheQuery('CREATE TABLE ' + loadTableSql + ' (' + columnDefs + ')');
  }
  setPgCacheProgress(sourceTable, { phase: 'copying', rowsCopied: 0, totalRows: totalRows, percent: 10, previewCacheTable: stageCacheTable || '' });
  var changedRows = 0;
  // --- full refresh (comportamento original) ---
  if (forceFull) {
    try {
      var copied = 0;
      var streamMaxRows = totalRows > 0 ? totalRows : Number.MAX_SAFE_INTEGER;
      var streamExpectedTotal = totalRows > 0 ? totalRows : 0;
      if (initialRecoveryStart) {
        console.log('[PG Cache] Sync inicial de ' + sourceTable + ' limitado a ' + initialRecoveryStart + '+ via ' + incrementalColumn);
      }
      await copyMysqlTableViaStream(physicalTable, columns, { primaryKeys: uniqueKeyCols }, {
        batchSize: Math.min(batchSize, 5000),
        maxRows: streamMaxRows,
        expectedTotal: streamExpectedTotal,
        maxRetries: streamMaxRetries,
        inactivityTimeoutMs: streamInactivityTimeoutMs,
        where: fullWhere,
        whereParams: fullWhereParams,
        onRestart: async function() {
          await pgCacheQuery('TRUNCATE TABLE ' + loadTableSql);
          copied = 0;
        },
        onRetry: function(info) {
          setPgCacheProgress(sourceTable, {
            phase: 'copying',
            rowsCopied: copied,
            totalRows: totalRows,
            percent: Math.min(90, 10 + Math.round(copied / Math.max(1, totalRows) * 80)),
            retrying: true,
            retryAttempt: info && info.attempt || 0,
            retryError: info && info.error ? info.error.message : ''
          });
        }
      }, async function(batch, copiedSoFar) {
        await insertPgCacheRows(loadTableSql, columns, batch, ctOverrides);
        copied = copiedSoFar;
        setPgCacheProgress(sourceTable, { phase: 'copying', rowsCopied: copied, totalRows: totalRows, percent: Math.min(90, 10 + Math.round(copied / Math.max(1, totalRows) * 80)) });
      });
      var pgFullCountResult = await pgCacheQuery('SELECT COUNT(*) AS cnt FROM ' + loadTableSql);
      totalRows = (pgFullCountResult && pgFullCountResult.rows && pgFullCountResult.rows.length) ? Number(pgFullCountResult.rows[0].cnt || 0) : copied;
      changedRows = totalRows;
      if (stageTableSql) {
        var preserveDependentViews = false;
        if (existing && existing.cache_table) {
          try {
            preserveDependentViews = await pgCacheStorageSchemaCompatible(existing.cache_table, columns, ctOverrides);
          } catch (schemaErr) {
            console.warn('[PG Cache] Falha ao comparar schemas antes da troca de ' + sourceTable + ': ' + schemaErr.message);
          }
        }
        if (preserveDependentViews) {
          var physicalColumnsSql = columns.map(function(col) { return quotePgIdent(col.name); }).join(', ');
          await pgCacheTransaction(async function(client) {
            await client.query('TRUNCATE TABLE ' + tableSql);
            await client.query('INSERT INTO ' + tableSql + ' (' + physicalColumnsSql + ') SELECT ' + physicalColumnsSql + ' FROM ' + stageTableSql);
            await client.query('DROP TABLE ' + stageTableSql);
          });
          console.log('[PG Cache] Atualizacao completa de ' + sourceTable + ' aplicada sem remover as views dependentes.');
        } else {
          await dropPgModelView(sourceTable);
          await pgCacheTransaction(async function(client) {
            // Uma tabela calculada pode depender diretamente do cache fisico
            // quando a origem nao possui etapas de modelagem. CASCADE remove
            // apenas essas views derivadas; elas sao recriadas automaticamente
            // por ensureDaxCalculatedTableView no proximo acesso.
            await client.query('DROP TABLE IF EXISTS ' + tableSql + ' CASCADE');
            await client.query('ALTER TABLE ' + stageTableSql + ' RENAME TO ' + quotePgIdent(cacheTable));
          });
        }
        loadTableSql = tableSql;
        stageTableSql = '';
        setPgCacheProgress(sourceTable, { previewCacheTable: cacheTable });
      }
    } catch (err) {
      if (stageTableSql) {
        try { await pgCacheQuery('DROP TABLE IF EXISTS ' + stageTableSql); } catch (cleanupErr) {}
      }
      await cleanupPgCacheStageTables(cacheTable);
      throw err;
    }
  }
  var recentDays = Math.max(1, Number(options.recentDays) || (getSettings().pgCache && getSettings().pgCache.recentWindowDays) || 90);
  var incColMeta = doIncremental ? columns.find(function(c) { return c.name === incrementalColumn; }) : null;
  var isDateColumn = Boolean(incColMeta && /^(date|datetime|timestamp|data)$/i.test(String(incColMeta.dataType || '')));
  var incrementalRebuiltFull = false;
  if (doIncremental && isDateColumn) {
    var maxResult = await pgCacheQuery('SELECT MAX(' + quotePgIdent(incrementalColumn) + ') AS maxval FROM ' + tableSql);
    var maxVal = (maxResult.rows && maxResult.rows[0] && maxResult.rows[0].maxval != null) ? maxResult.rows[0].maxval : null;
    if (maxVal == null) throw new Error('Cache sem marcador de data; execute uma atualizacao completa.');
    var windowAnchorDate = maxVal instanceof Date ? new Date(maxVal.getTime()) : new Date(String(maxVal));
    if (Number.isNaN(windowAnchorDate.getTime())) throw new Error('Marcador incremental de data invalido: ' + maxVal);
    if (windowAnchorDate.getTime() > Date.now()) windowAnchorDate = new Date();
    windowAnchorDate.setUTCDate(windowAnchorDate.getUTCDate() - recentDays);
    var windowStart = String(incColMeta.dataType || '').toLowerCase() === 'date'
      ? windowAnchorDate.toISOString().slice(0, 10)
      : windowAnchorDate.toISOString().slice(0, 19).replace('T', ' ');
    var windowStageCacheTable = (cacheTable + '_stage_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)).slice(0, 60);
    var windowStageTableSql = quotePgQualified(POSTGRES_CACHE_SCHEMA, windowStageCacheTable);
    try {
      await cleanupPgCacheStageTables(cacheTable);
      await pgCacheQuery('CREATE TABLE ' + windowStageTableSql + ' (LIKE ' + tableSql + ' INCLUDING DEFAULTS)');
      var recentCopied = 0;
      await copyMysqlTableViaStream(physicalTable, columns, { primaryKeys: uniqueKeyCols }, {
        batchSize: Math.min(batchSize, 1000),
        where: quoteIdent(incrementalColumn) + ' >= ?',
        whereParams: [windowStart],
        maxRetries: streamMaxRetries,
        inactivityTimeoutMs: streamInactivityTimeoutMs,
        onRestart: async function() {
          await pgCacheQuery('TRUNCATE TABLE ' + windowStageTableSql);
          recentCopied = 0;
        },
        onRetry: function(info) {
          setPgCacheProgress(sourceTable, {
            phase: 'copying-recent', rowsCopied: recentCopied, totalRows: 0, percent: 50,
            retrying: true, retryAttempt: info && info.attempt || 0,
            retryError: info && info.error ? info.error.message : ''
          });
        }
      }, async function(batch, copiedSoFar) {
        await insertPgCacheRows(windowStageTableSql, columns, batch, ctOverrides);
        recentCopied = copiedSoFar;
        setPgCacheProgress(sourceTable, { phase: 'copying-recent', rowsCopied: recentCopied, totalRows: 0, percent: 50 });
      });
      var stageCountResult = await pgCacheQuery('SELECT COUNT(*)::bigint AS cnt FROM ' + windowStageTableSql);
      var stageRows = Number(stageCountResult.rows && stageCountResult.rows[0] ? stageCountResult.rows[0].cnt || 0 : 0);
      if (stageRows !== recentCopied) throw new Error('Janela incremental incompleta no staging: ' + stageRows + ' de ' + recentCopied + ' linhas.');
      var oldWindowResult = await pgCacheQuery('SELECT COUNT(*)::bigint AS cnt FROM ' + tableSql + ' WHERE ' + quotePgIdent(incrementalColumn) + ' >= $1', [windowStart]);
      var oldWindowRows = Number(oldWindowResult.rows && oldWindowResult.rows[0] ? oldWindowResult.rows[0].cnt || 0 : 0);
      var cacheOutsideRows = Math.max(0, totalRows - oldWindowRows);
      var sourceOutsideRows = cacheOutsideRows;
      var forceReconcile = false;
      try {
        var sourceOutsideResult = await dbQueryWithTimeout(
          'SELECT COUNT(*) AS cnt FROM ' + quoteIdent(physicalTable) + ' WHERE ' + quoteIdent(incrementalColumn) + ' < ? OR ' + quoteIdent(incrementalColumn) + ' IS NULL',
          [windowStart], 15000, false
        );
        sourceOutsideRows = Number(sourceOutsideResult && sourceOutsideResult[0] && sourceOutsideResult[0][0] ? sourceOutsideResult[0][0].cnt || 0 : 0);
      } catch (countErr) {
        console.warn('[PG Cache] COUNT fora da janela falhou para ' + physicalTable + ' (' + countErr.message + '). Prosseguindo com merge da janela.');
      }
      if (sourceOutsideRows !== cacheOutsideRows && sourceOutsideRows > 0) {
        console.warn('[PG Cache] Divergencia fora da janela ' + physicalTable + ': source=' + sourceOutsideRows + ' cache=' + cacheOutsideRows + '. Reconciliando full incremental.');
        forceReconcile = true;
      }
      var windowColumns = columns.map(function(col) { return quotePgIdent(col.name); }).join(', ');
      if (forceReconcile) {
        incrementalRebuiltFull = true;
        await pgCacheQuery('TRUNCATE TABLE ' + windowStageTableSql);
        var reconcileCopied = 0;
        await copyMysqlTableViaStream(physicalTable, columns, { primaryKeys: uniqueKeyCols }, {
          batchSize: Math.min(batchSize, 1000),
          maxRetries: streamMaxRetries,
          inactivityTimeoutMs: streamInactivityTimeoutMs,
          onRestart: async function() {
            await pgCacheQuery('TRUNCATE TABLE ' + windowStageTableSql);
            reconcileCopied = 0;
          },
          onRetry: function(info) {
            setPgCacheProgress(sourceTable, {
              phase: 'reconciling-full', rowsCopied: reconcileCopied, totalRows: 0, percent: 70,
              retrying: true, retryAttempt: info && info.attempt || 0,
              retryError: info && info.error ? info.error.message : ''
            });
          }
        }, async function(batch, copiedSoFar) {
          await insertPgCacheRows(windowStageTableSql, columns, batch, ctOverrides);
          reconcileCopied = copiedSoFar;
          setPgCacheProgress(sourceTable, { phase: 'reconciling-full', rowsCopied: reconcileCopied, totalRows: 0, percent: 70 });
        });
        var reconcileCountResult = await pgCacheQuery('SELECT COUNT(*)::bigint AS cnt FROM ' + windowStageTableSql);
        var reconciledRows = Number(reconcileCountResult.rows && reconcileCountResult.rows[0] ? reconcileCountResult.rows[0].cnt || 0 : 0);
        if (reconciledRows !== reconcileCopied) throw new Error('Reconciliacao completa inconsistente: ' + reconciledRows + ' de ' + reconcileCopied + ' linhas.');
        changedRows = Math.max(1, Math.abs(reconciledRows - totalRows), Math.abs(sourceOutsideRows - cacheOutsideRows));
        if (uniqueKeyCols.length) {
          await pgCacheTransaction(async function(client) {
            await client.query('TRUNCATE TABLE ' + tableSql);
            await client.query('INSERT INTO ' + tableSql + ' (' + windowColumns + ') SELECT ' + windowColumns + ' FROM ' + windowStageTableSql);
          });
          await pgCacheQuery('DROP TABLE IF EXISTS ' + windowStageTableSql);
        } else {
          await dropPgModelView(sourceTable);
          await pgCacheTransaction(async function(client) {
            await client.query('DROP TABLE IF EXISTS ' + tableSql + ' CASCADE');
            await client.query('ALTER TABLE ' + windowStageTableSql + ' RENAME TO ' + quotePgIdent(cacheTable));
          });
        }
        windowStageTableSql = '';
        totalRows = reconciledRows;
      } else {
        changedRows = await countPgCacheWindowDifferences(tableSql, windowStageTableSql, columns, incrementalColumn, windowStart);
        if (changedRows > 0) {
          await pgCacheTransaction(async function(client) {
            await client.query('DELETE FROM ' + tableSql + ' WHERE ' + quotePgIdent(incrementalColumn) + ' >= $1', [windowStart]);
            await client.query('INSERT INTO ' + tableSql + ' (' + windowColumns + ') SELECT ' + windowColumns + ' FROM ' + windowStageTableSql);
          });
          totalRows = Math.max(0, totalRows - oldWindowRows + stageRows);
        }
        await pgCacheQuery('DROP TABLE IF EXISTS ' + windowStageTableSql);
        windowStageTableSql = '';
      }
    } catch (err) {
      if (windowStageTableSql) {
        try { await pgCacheQuery('DROP TABLE IF EXISTS ' + windowStageTableSql); } catch (cleanupErr) {}
      }
      throw err;
    }
  } else if (doIncremental) {
    var scalarMaxResult = await pgCacheQuery('SELECT MAX(' + quotePgIdent(incrementalColumn) + ') AS maxval FROM ' + tableSql);
    var scalarMaxVal = (scalarMaxResult.rows && scalarMaxResult.rows[0] && scalarMaxResult.rows[0].maxval != null) ? scalarMaxResult.rows[0].maxval : null;
    if (scalarMaxVal == null) throw new Error('Cache sem marcador incremental; execute uma atualizacao completa.');
    var scalarWhere = quoteIdent(incrementalColumn) + ' > ?';
    var scalarCountResult = await dbQueryWithPgSyncRetry('SELECT COUNT(*) AS cnt FROM ' + quoteIdent(physicalTable) + ' WHERE ' + scalarWhere, [scalarMaxVal], 30000, 4);
    var scalarNewRows = Number(scalarCountResult[0] && scalarCountResult[0][0] ? scalarCountResult[0][0].cnt : 0);
    if (scalarNewRows > 0) {
      var incColNames = columns.map(function(c) { return c.name; });
      var incPlaceholders = incColNames.map(function(c, i) { var ov = ctOverrides[c]; return ov ? ('$' + (i + 1) + '::' + ov) : ('$' + (i + 1)); }).join(', ');
      var incInsertSql;
      if (uniqueKeyCols.length) {
        var updateColumns = incColNames.filter(function(col) { return uniqueKeyCols.indexOf(col) === -1; });
        var conflictAction = updateColumns.length
          ? ' DO UPDATE SET ' + updateColumns.map(function(col) { return quotePgIdent(col) + ' = EXCLUDED.' + quotePgIdent(col); }).join(', ')
          : ' DO NOTHING';
        incInsertSql = 'INSERT INTO ' + tableSql + ' (' + incColNames.map(quotePgIdent).join(', ') + ') VALUES (' + incPlaceholders + ') ON CONFLICT (' + uniqueKeyCols.map(quotePgIdent).join(', ') + ')' + conflictAction;
      } else {
        var notExistsConds = incColNames.map(function(col, i) { var ov = ctOverrides[col]; var ph = ov ? ('$' + (i + 1) + '::' + ov) : ('$' + (i + 1)); return quotePgIdent(col) + ' IS NOT DISTINCT FROM ' + ph; }).join(' AND ');
        incInsertSql = 'INSERT INTO ' + tableSql + ' (' + incColNames.map(quotePgIdent).join(', ') + ') SELECT ' + incPlaceholders + ' WHERE NOT EXISTS (SELECT 1 FROM ' + tableSql + ' WHERE ' + notExistsConds + ')';
      }
      var scalarCopied = 0;
      var scalarAffected = 0;
      await copyMysqlTableViaStream(physicalTable, columns, { primaryKeys: uniqueKeyCols }, {
        batchSize: Math.min(batchSize, 2000), where: scalarWhere, whereParams: [scalarMaxVal],
        expectedTotal: scalarNewRows, maxRows: scalarNewRows, maxRetries: streamMaxRetries, inactivityTimeoutMs: streamInactivityTimeoutMs
      }, async function(batch, copiedSoFar) {
        for (var rowIndex = 0; rowIndex < batch.length; rowIndex++) {
          var incValues = incColNames.map(function(column) { return normalizePgCacheValue(batch[rowIndex][column]); });
          var insertResult = await pgCacheQuery(incInsertSql, incValues);
          scalarAffected += Number(insertResult.rowCount || 0);
        }
        scalarCopied = copiedSoFar;
        setPgCacheProgress(sourceTable, { phase: 'copying', rowsCopied: scalarCopied, totalRows: scalarNewRows, percent: Math.min(90, 10 + Math.round(scalarCopied / Math.max(1, scalarNewRows) * 80)) });
      });
      var pgCountResult = await pgCacheQuery('SELECT COUNT(*)::bigint AS cnt FROM ' + tableSql);
      totalRows = Number(pgCountResult.rows && pgCountResult.rows[0] ? pgCountResult.rows[0].cnt || 0 : totalRows);
      changedRows = scalarAffected;
    }
  }
  var syncStrategy = forceFull ? 'full-refresh' : (doIncremental ? (isDateColumn ? (incrementalRebuiltFull ? 'incremental-reconcile-full' : 'incremental-window') : 'incremental') : (sourceFingerprint ? 'fingerprint-check' : 'none'));
  var syncCompletedAt = new Date().toISOString();
  await savePgCacheMeta({
    sourceTable: sourceTable,
    physicalTable: physicalTable,
    cacheTable: cacheTable,
    columns: columns,
    rowCount: totalRows,
    syncedAt: syncCompletedAt,
    syncMode: mode,
    lastError: '',
    lastMarker: ctHash,
    sourceMarker: sourceFingerprint ? sourceFingerprint.marker : '',
    syncStrategy: syncStrategy,
    syncColumn: incrementalColumnValid ? incrementalColumn : '',
    primaryKeys: uniqueKeyCols,
    lastChangedRows: changedRows
  });
  if (String(sourceTable || physicalTable || '').trim().toLowerCase() === 'faturamento') {
    await migrateLegacyFaturamento2State().catch(function(err) {
      console.error('[Migracao Faturamento2] Falha apos sincronizar Faturamento:', err.message || err);
    });
  }
  await ensurePgCacheAnalyticsIndexes(sourceTable).catch(function(err) {
    console.error('[PG Cache] Erro ao criar indices analiticos para ' + sourceTable + ':', err.message);
  });
  await insertPgCacheSyncLog({
    sourceTable: sourceTable,
    syncedAt: syncCompletedAt,
    syncMode: mode,
    syncStrategy: syncStrategy,
    syncColumn: incrementalColumnValid ? incrementalColumn : '',
    rowCount: totalRows,
    changedRows: changedRows
  });
  if (changedRows > 0) clearQueryCache('pg-cache-sync:' + String(sourceTable || '').toLowerCase());
  setPgCacheProgress(sourceTable, { phase: 'done', status: 'done', rowsCopied: totalRows, totalRows: totalRows, percent: 100, previewCacheTable: '' });
  console.log('[PG Cache] Sincronizado ' + sourceTable + ': ' + totalRows + ' linhas (modo: ' + (doIncremental ? 'incremental coluna ' + incrementalColumn : (forceFull ? 'full' : 'incremental-sem-coluna')) + ')');
  return { rowCount: totalRows, syncMode: mode, changedRows: changedRows };
}

function pgTypeForMysqlColumn(col) {
  var type = String((col && (col.dataType || col.columnType)) || 'text').toLowerCase().split('(')[0].trim();
  var map = { 'int': 'INTEGER', 'integer': 'INTEGER', 'bigint': 'BIGINT', 'smallint': 'SMALLINT', 'tinyint': 'SMALLINT',
    'decimal': 'NUMERIC', 'numeric': 'NUMERIC', 'double': 'DOUBLE PRECISION', 'float': 'REAL', 'real': 'REAL',
    'varchar': 'TEXT', 'char': 'TEXT', 'text': 'TEXT', 'longtext': 'TEXT', 'mediumtext': 'TEXT', 'tinytext': 'TEXT',
    'datetime': 'TIMESTAMP', 'timestamp': 'TIMESTAMP', 'date': 'DATE', 'time': 'TIME',
    'blob': 'BYTEA', 'longblob': 'BYTEA', 'mediumblob': 'BYTEA', 'tinyblob': 'BYTEA', 'binary': 'BYTEA', 'varbinary': 'BYTEA',
    'json': 'JSONB', 'enum': 'TEXT', 'set': 'TEXT', 'bool': 'BOOLEAN', 'boolean': 'BOOLEAN', 'bit': 'BOOLEAN', 'year': 'SMALLINT'
  };
  return map[type] || 'TEXT';
}

function pgTypeForChangeType(dataType) {
  var dt = String(dataType || '').toLowerCase().trim();
  if (dt === 'inteiro' || dt === 'int' || dt === 'integer' || dt === 'bigint' || dt === 'smallint' || dt === 'tinyint') return 'INTEGER';
  if (dt === 'decimal' || dt === 'numero' || dt === 'number' || dt === 'numeric' || dt === 'double' || dt === 'float' || dt === 'real') return 'NUMERIC';
  if (dt === 'data' || dt === 'date') return 'DATE';
  if (dt === 'datetime' || dt === 'timestamp' || dt === 'timestamptz') return 'TIMESTAMP';
  if (dt === 'hora' || dt === 'time') return 'TIME';
  if (dt === 'texto' || dt === 'text' || dt === 'varchar' || dt === 'char' || dt === 'string' || dt === 'longtext' || dt === 'mediumtext') return 'TEXT';
  if (dt === 'bool' || dt === 'boolean' || dt === 'bit') return 'BOOLEAN';
  if (dt === 'binario' || dt === 'binary' || dt === 'blob' || dt === 'bytea') return 'BYTEA';
  return null;
}

function getChangeTypePgOverrides(tableName) {
  var steps = getChangeTypeStepsFromImported(tableName);
  var map = {};
  for (var i = 0; i < steps.length; i++) {
    var pgType = pgTypeForChangeType(steps[i].dataType);
    if (pgType) map[steps[i].column] = pgType;
  }
  return map;
}

function changeTypeOverrideHash(overrides) {
  var keys = Object.keys(overrides).sort();
  if (!keys.length) return '';
  return keys.map(function(k) { return k + '=' + overrides[k]; }).join('|');
}

function normalizePgCacheValue(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 19).replace('T', ' ');
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'bigint') return value.toString();
  return value;
}

async function getMysqlSourceFingerprint(physicalTable, columns) {
  var fingerprintParts = columns.map(function(col) {
    var identifier = quoteIdent(col.name);
    return "IF(" + identifier + " IS NULL, 'N', CONCAT('V', HEX(CAST(" + identifier + " AS BINARY))))";
  });
  var rowHash = 'CRC32(CONCAT_WS(CHAR(31), ' + fingerprintParts.join(', ') + '))';
  var sql = 'SELECT COUNT(*) AS cnt, COALESCE(BIT_XOR(CAST(' + rowHash + ' AS UNSIGNED)), 0) AS xor_hash, ' +
    'COALESCE(SUM(CAST(' + rowHash + ' AS UNSIGNED)), 0) AS sum_hash FROM ' + quoteIdent(physicalTable);
  var result = await dbQueryWithPgSyncRetry(sql, [], 180000, 3);
  var row = result[0] && result[0][0] ? result[0][0] : {};
  var rowCount = Number(row.cnt || 0);
  return {
    rowCount: rowCount,
    marker: [rowCount, String(row.xor_hash || 0), String(row.sum_hash || 0)].join(':')
  };
}

async function insertPgCacheRows(targetTableSql, columns, rows, typeOverrides) {
  if (!Array.isArray(rows) || !rows.length) return 0;
  var colNames = columns.map(function(col) { return col.name; });
  var maxRowsPerStatement = Math.max(1, Math.min(250, Math.floor(60000 / Math.max(1, colNames.length))));
  var inserted = 0;
  for (var offset = 0; offset < rows.length; offset += maxRowsPerStatement) {
    var batch = rows.slice(offset, offset + maxRowsPerStatement);
    var params = [];
    var valueGroups = batch.map(function(row) {
      var placeholders = colNames.map(function(column) {
        params.push(normalizePgCacheValue(row[column]));
        var placeholder = '$' + params.length;
        var override = typeOverrides && typeOverrides[column];
        return override ? (placeholder + '::' + override) : placeholder;
      });
      return '(' + placeholders.join(', ') + ')';
    });
    await pgCacheQuery(
      'INSERT INTO ' + targetTableSql + ' (' + colNames.map(quotePgIdent).join(', ') + ') VALUES ' + valueGroups.join(', '),
      params
    );
    inserted += batch.length;
  }
  return inserted;
}

async function countPgCacheWindowDifferences(tableSql, stageTableSql, columns, incrementalColumn, windowStart) {
  var projection = columns.map(function(col) { return quotePgIdent(col.name); }).join(', ');
  var windowCondition = quotePgIdent(incrementalColumn) + ' >= $1';
  var result = await pgCacheQuery(
    'SELECT COUNT(*)::bigint AS cnt FROM (' +
      '(SELECT ' + projection + ' FROM ' + tableSql + ' WHERE ' + windowCondition + ' EXCEPT ALL SELECT ' + projection + ' FROM ' + stageTableSql + ') ' +
      'UNION ALL ' +
      '(SELECT ' + projection + ' FROM ' + stageTableSql + ' EXCEPT ALL SELECT ' + projection + ' FROM ' + tableSql + ' WHERE ' + windowCondition + ')' +
    ') AS differences',
    [windowStart]
  );
  return Number(result.rows && result.rows[0] ? result.rows[0].cnt || 0 : 0);
}

var pgCacheAutoSyncRunning = false;

async function autoSyncAllTablesToPgCache(trigger) {
  if (!postgresCacheAvailable()) return { skipped: true, reason: 'postgres-unavailable', total: 0, succeeded: 0, failed: 0, changedRows: 0 };
  await loadMysqlAuthGuard();
  const protectedAuth = mysqlAuthGuardEntryForConfig(buildDbConfig());
  if (protectedAuth) {
    pgCacheSchedulerState.lastSkippedReason = 'mysql-auth-guard-active';
    return { skipped: true, reason: 'mysql-auth-guard-active', total: 0, succeeded: 0, failed: 0, changedRows: 0, authBlocked: true };
  }
  if (pgCacheAutoSyncRunning) {
    console.log('[PG Cache] Sincronizacao periodica anterior ainda em andamento; novo ciclo ignorado.');
    pgCacheSchedulerState.lastSkippedReason = 'local-cycle-running';
    return { skipped: true, reason: 'local-cycle-running', total: 0, succeeded: 0, failed: 0, changedRows: 0 };
  }
  pgCacheAutoSyncRunning = true;
  const startedAt = new Date().toISOString();
  pgCacheSchedulerState.running = true;
  pgCacheSchedulerState.lastStartedAt = startedAt;
  pgCacheSchedulerState.lastTrigger = String(trigger || 'automatic');
  pgCacheSchedulerState.lastSkippedReason = '';
  try {
    var imported = await readImportedTables();
    var cachedTables = await listPgCacheStatus();
    var cachedNames = new Set(cachedTables.map(function(item) { return String(item.sourceTable || '').toLowerCase(); }));
    var normalizedTrigger = String(trigger || 'automatic').toLowerCase();
    var autoCreateMissing = normalizedTrigger === 'publish' || normalizedTrigger === 'startup' || parseBool(process.env.BIWA_PG_CACHE_AUTO_CREATE_MISSING, true);
    var succeeded = 0;
    var failed = 0;
    var changedRows = 0;
    var failedTables = [];
    for (var i = 0; i < imported.length; i++) {
      var physicalName = imported[i].sourceTable;
      if (!physicalName) continue;
      if (!autoCreateMissing && !cachedNames.has(String(physicalName).toLowerCase())) continue;
      try {
        var tableResult = await syncTableToPostgresCache(physicalName, {
          mode: 'auto',
          batchSize: 10000,
          maxRetries: 3,
          streamInactivityTimeoutMs: Number(process.env.BIWA_MYSQL_STREAM_INACTIVITY_TIMEOUT_MS || 300000)
        });
        if (tableResult && tableResult.skipped) {
          failed += 1;
          failedTables.push(String(physicalName));
        } else {
          succeeded += 1;
          changedRows += Number(tableResult && tableResult.changedRows || 0);
        }
      } catch (e) {
        failed += 1;
        failedTables.push(String(physicalName));
        console.error('[PG Cache] Auto-sync erro para ' + physicalName + ':', e.message);
        if (isMysqlAuthenticationError(e) || String(e && e.code || '') === 'MYSQL_AUTH_GUARD_ACTIVE') {
          pgCacheSchedulerState.lastSkippedReason = 'mysql-auth-guard-active';
          break;
        }
      }
    }
    var authBlocked = Boolean(mysqlAuthGuardEntryForConfig(buildDbConfig()));
    var result = { skipped: false, total: succeeded + failed, succeeded: succeeded, failed: failed, changedRows: changedRows, failedTables: failedTables, authBlocked: authBlocked };
    pgCacheSchedulerState.lastResult = result;
    pgCacheSchedulerState.lastCompletedAt = new Date().toISOString();
    if (failed) pgCacheSchedulerState.lastFailureAt = pgCacheSchedulerState.lastCompletedAt;
    else pgCacheSchedulerState.lastSuccessAt = pgCacheSchedulerState.lastCompletedAt;
    return result;
  } catch (e) {
    console.error('[PG Cache] autoSyncAllTablesToPgCache erro:', e.message);
    var failedResult = { skipped: false, total: 0, succeeded: 0, failed: 1, changedRows: 0, failedTables: [] };
    pgCacheSchedulerState.lastResult = failedResult;
    pgCacheSchedulerState.lastCompletedAt = new Date().toISOString();
    pgCacheSchedulerState.lastFailureAt = pgCacheSchedulerState.lastCompletedAt;
    return failedResult;
  } finally {
    pgCacheAutoSyncRunning = false;
    pgCacheSchedulerState.running = false;
  }
}

function parseTableViewFilters(raw) {
  if (!raw) return [];
  try {
    var parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(function(f) { return f && f.field; });
  } catch (e) { return []; }
}

function quotePgQualified(schema, table) {
  return '"' + String(schema || 'public').replace(/"/g, '""') + '"."' + String(table || '').replace(/"/g, '""') + '"';
}

function quotePgIdent(identifier) {
  return '"' + String(identifier || '').replace(/"/g, '""') + '"';
}

function quotePgLiteral(value) {
  return "'" + String(value == null ? '' : value).replace(/'/g, "''") + "'";
}

function pgCacheTableNameFor(sourceTable) {
  var crypto = require('crypto');
  var hash = crypto.createHash('sha1').update(String(sourceTable || '').toLowerCase()).digest('hex').substring(0, 16);
  return 'cache_' + hash;
}

function publicPgCacheStatusFromMeta(meta) {
  if (!meta) return { available: postgresCacheAvailable(), enabled: POSTGRES_CACHE_ENABLED, exists: false, kind: 'postgres', schema: POSTGRES_CACHE_SCHEMA };
  return {
    available: postgresCacheAvailable(), enabled: POSTGRES_CACHE_ENABLED, exists: true, kind: 'postgres', schema: POSTGRES_CACHE_SCHEMA,
    sourceTable: meta.source_table, physicalTable: meta.physical_table, cacheTable: meta.cache_table,
    rowCount: Number(meta.row_count || 0), metaRowCount: Number(meta.meta_row_count || meta.row_count || 0),
    actualRowCount: Number(meta.actual_row_count || meta.row_count || 0), syncedAt: meta.synced_at,
    lastDataUpdateAt: meta.last_data_update_at || (Number(meta.last_changed_rows || 0) > 0 ? meta.synced_at : null), syncMode: meta.sync_mode || '',
    syncStrategy: meta.sync_strategy || '', syncColumn: meta.sync_column || '', primaryKeys: meta.primary_keys || [],
    lastChangedRows: Number(meta.last_changed_rows || 0)
  };
}

function buildPgTableViewWhere(columns, filters, quick) {
  var where = [];
  var params = [];
  var validCols = new Set((columns || []).map(function(c) { return String(c.name || c || ''); }));
  for (var i = 0; i < (filters || []).length; i++) {
    var f = filters[i];
    if (!f || !f.field || !validCols.has(f.field)) continue;
    var col = quotePgIdent(f.field);
    var op = String(f.operator || 'contains').toLowerCase();
    if (op === 'blank') {
      where.push('(' + col + ' IS NULL OR ' + col + " = '')");
    } else if (op === 'notBlank') {
      where.push('(' + col + ' IS NOT NULL AND ' + col + " <> '')");
    } else if (op === 'equals') {
      params.push(f.value); where.push(col + ' = $' + params.length);
    } else if (op === 'notEquals') {
      params.push(f.value); where.push(col + ' <> $' + params.length);
    } else if (op === 'startsWith') {
      params.push(f.value + '%'); where.push(col + ' LIKE $' + params.length);
    } else if (op === 'endsWith') {
      params.push('%' + f.value); where.push(col + ' LIKE $' + params.length);
    } else if (op === 'gte') {
      params.push(f.value); where.push(col + ' >= $' + params.length);
    } else if (op === 'lte') {
      params.push(f.value); where.push(col + ' <= $' + params.length);
    } else if (op === 'between') {
      if (f.value) { params.push(f.value); where.push(col + ' >= $' + params.length); }
      if (f.value2) { params.push(f.value2); where.push(col + ' <= $' + params.length); }
    } else {
      params.push('%' + (f.value || '') + '%'); where.push(col + ' LIKE $' + params.length);
    }
  }
  var q = String(quick || '').trim();
  if (q) {
    var qClauses = [];
    (columns || []).forEach(function(col) {
      var cname = String(col.name || col || '');
      if (!cname) return;
      params.push('%' + q + '%');
      qClauses.push(quotePgIdent(cname) + ' LIKE $' + params.length);
    });
    if (qClauses.length) where.push('(' + qClauses.join(' OR ') + ')');
  }
  return { where: where, params: params };
}

function buildPgTableViewOrder(columns, sortField, sortDir) {
  if (!sortField) return '';
  var validCols = new Set((columns || []).map(function(c) { return String(c.name || c || ''); }));
  if (!validCols.has(sortField)) return '';
  var direction = String(sortDir || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
  return ' ORDER BY ' + quotePgIdent(sortField) + ' ' + direction;
}

function buildMysqlTableViewWhere(columns, filters, quick, rowFilter, dateFilter) {
  var where = [];
  var params = [];
  var validCols = new Set((columns || []).map(function(col) { return String(col.name || col || ''); }));
  for (var i = 0; i < (filters || []).length; i++) {
    var filter = filters[i];
    if (!filter || !filter.field || !validCols.has(filter.field)) continue;
    var col = quoteIdent(filter.field);
    var textCol = 'CAST(' + col + ' AS CHAR)';
    var operator = String(filter.operator || 'contains').toLowerCase();
    if (operator === 'blank') {
      where.push('(' + col + ' IS NULL OR ' + textCol + " = '')");
    } else if (operator === 'notblank') {
      where.push('(' + col + ' IS NOT NULL AND ' + textCol + " <> '')");
    } else if (operator === 'equals') {
      params.push(filter.value); where.push(col + ' = ?');
    } else if (operator === 'notequals') {
      params.push(filter.value); where.push(col + ' <> ?');
    } else if (operator === 'startswith') {
      params.push(String(filter.value || '') + '%'); where.push(textCol + ' LIKE ?');
    } else if (operator === 'endswith') {
      params.push('%' + String(filter.value || '')); where.push(textCol + ' LIKE ?');
    } else if (operator === 'gte') {
      params.push(filter.value); where.push(col + ' >= ?');
    } else if (operator === 'lte') {
      params.push(filter.value); where.push(col + ' <= ?');
    } else if (operator === 'between') {
      if (filter.value) { params.push(filter.value); where.push(col + ' >= ?'); }
      if (filter.value2) { params.push(filter.value2); where.push(col + ' <= ?'); }
    } else {
      params.push('%' + String(filter.value || '') + '%'); where.push(textCol + ' LIKE ?');
    }
  }
  var search = String(quick || '').trim();
  if (search) {
    var searchableColumns = (columns || []).filter(function(col) {
      return !/blob|binary/i.test(String(col.columnType || col.dataType || ''));
    }).slice(0, 40);
    var searchClauses = [];
    searchableColumns.forEach(function(col) {
      params.push('%' + search + '%');
      searchClauses.push('CAST(' + quoteIdent(col.name) + ' AS CHAR) LIKE ?');
    });
    if (searchClauses.length) where.push('(' + searchClauses.join(' OR ') + ')');
  }
  if (rowFilter && rowFilter.column && validCols.has(rowFilter.column) && Array.isArray(rowFilter.values) && rowFilter.values.length) {
    var allowed = rowFilter.values.filter(function(value) { return value !== '' && value !== null && value !== undefined; });
    if (allowed.length) {
      where.push(quoteIdent(rowFilter.column) + ' IN (' + allowed.map(function() { return '?'; }).join(', ') + ')');
      params.push.apply(params, allowed);
    }
  }
  if (dateFilter && dateFilter.column && validCols.has(dateFilter.column)) {
    if (dateFilter.start) { where.push(quoteIdent(dateFilter.column) + ' >= ?'); params.push(dateFilter.start); }
    if (dateFilter.end) { where.push(quoteIdent(dateFilter.column) + ' <= ?'); params.push(dateFilter.end); }
  }
  return { where: where, params: params };
}

async function readRowsFromPostgresSyncPreview(sourceTable, previewCacheTable, options) {
  var source = String(sourceTable || '').trim();
  var previewTable = String(previewCacheTable || '').trim();
  var expectedTable = pgCacheTableNameFor(source);
  if (!previewTable || (previewTable !== expectedTable && !previewTable.startsWith(expectedTable + '_stage_'))) return null;
  if (!/^[A-Za-z0-9_]+$/.test(previewTable)) return null;
  var metadata = await pgCacheQuery(
    'SELECT column_name, data_type, udt_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position',
    [POSTGRES_CACHE_SCHEMA, previewTable]
  );
  var columns = (metadata.rows || []).map(function(row) {
    return {
      name: row.column_name,
      dataType: String(row.data_type || row.udt_name || 'text'),
      columnType: String(row.data_type || row.udt_name || 'text'),
      columnKey: '', nullable: 'YES', defaultValue: null, extra: ''
    };
  });
  if (!columns.length) return null;
  var limit = clampLimit(options.limit, 50);
  var offset = Math.max(0, Number(options.offset || 0));
  var builtWhere = buildPgTableViewWhere(columns, options.filters || [], options.quick || '');
  var validCols = new Set(columns.map(function(col) { return String(col.name || ''); }));
  if (options.rowFilter && options.rowFilter.column && validCols.has(options.rowFilter.column) && Array.isArray(options.rowFilter.values) && options.rowFilter.values.length) {
    builtWhere.where.push(quotePgIdent(options.rowFilter.column) + ' IN (' + options.rowFilter.values.map(function(_, index) {
      return '$' + (builtWhere.params.length + index + 1);
    }).join(', ') + ')');
    builtWhere.params.push.apply(builtWhere.params, options.rowFilter.values);
  }
  if (options.dateFilter && options.dateFilter.column && validCols.has(options.dateFilter.column)) {
    if (options.dateFilter.start) {
      builtWhere.where.push(quotePgIdent(options.dateFilter.column) + ' >= $' + (builtWhere.params.length + 1));
      builtWhere.params.push(options.dateFilter.start);
    }
    if (options.dateFilter.end) {
      builtWhere.where.push(quotePgIdent(options.dateFilter.column) + ' <= $' + (builtWhere.params.length + 1));
      builtWhere.params.push(options.dateFilter.end);
    }
  }
  var whereSql = builtWhere.where.length ? ' WHERE ' + builtWhere.where.join(' AND ') : '';
  var orderSql = buildPgTableViewOrder(columns, options.sortField, options.sortDir);
  var tableSql = quotePgQualified(POSTGRES_CACHE_SCHEMA, previewTable);
  var rowsResult = await pgCacheQuery(
    'SELECT * FROM ' + tableSql + whereSql + orderSql + ' LIMIT $' + (builtWhere.params.length + 1) + ' OFFSET $' + (builtWhere.params.length + 2),
    builtWhere.params.concat(limit + 1, offset)
  );
  var total = null;
  var totalKnown = false;
  if (options.includeCount) {
    var countResult = await pgCacheQuery('SELECT COUNT(*) AS total FROM ' + tableSql + whereSql, builtWhere.params);
    total = Number(countResult.rows[0] ? countResult.rows[0].total || 0 : 0);
    totalKnown = true;
  }
  var pageRows = (rowsResult.rows || []).slice(0, limit);
  return {
    rows: serializeRows(pageRows), columns: columns, total: total, totalKnown: totalKnown,
    limit: limit, offset: offset, nextOffset: offset + pageRows.length, hasMore: (rowsResult.rows || []).length > limit
  };
}

async function readRowsFromMysqlPreview(sourceTable, options) {
  var physicalTable = String(sourceTable || '').trim();
  quoteIdent(physicalTable);
  var columns = await getMysqlColumnsMetadata(physicalTable);
  if (!columns.length) return null;
  var limit = clampLimit(options.limit, 50);
  var offset = Math.max(0, Number(options.offset || 0));
  var builtWhere = buildMysqlTableViewWhere(columns, options.filters || [], options.quick || '', options.rowFilter, options.dateFilter);
  var whereSql = builtWhere.where.length ? ' WHERE ' + builtWhere.where.join(' AND ') : '';
  var validCols = new Set(columns.map(function(col) { return String(col.name || ''); }));
  var orderSql = options.sortField && validCols.has(options.sortField)
    ? ' ORDER BY ' + quoteIdent(options.sortField) + ' ' + (String(options.sortDir || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC')
    : '';
  var queryTimeout = Math.min(TABLE_ROWS_QUERY_TIMEOUT_MS, 5000);
  var rowsResult = await dbQueryWithTimeout(
    'SELECT * FROM ' + quoteIdent(physicalTable) + whereSql + orderSql + ' LIMIT ' + (limit + 1) + ' OFFSET ' + offset,
    builtWhere.params,
    queryTimeout
  );
  var total = null;
  var totalKnown = false;
  if (options.includeCount) {
    var countResult = await dbQueryWithTimeout('SELECT COUNT(*) AS total FROM ' + quoteIdent(physicalTable) + whereSql, builtWhere.params, queryTimeout);
    total = Number(countResult[0] && countResult[0][0] ? countResult[0][0].total || 0 : 0);
    totalKnown = true;
  }
  var rawRows = rowsResult[0] || [];
  var pageRows = rawRows.slice(0, limit);
  return {
    rows: serializeRows(pageRows), columns: columns, total: total, totalKnown: totalKnown,
    limit: limit, offset: offset, nextOffset: offset + pageRows.length, hasMore: rawRows.length > limit
  };
}

async function readRowsFromPostgresCache(sourceTable, options) {
  var meta = await getPgEffectiveMeta(sourceTable);
  if (!meta || !meta.cache_table) return null;
  var columns = normalizePgCacheColumns(meta.columns || []);
  var tableSql = quotePgQualified(POSTGRES_CACHE_SCHEMA, meta.cache_table);
  var limit = clampLimit(options.limit, 50);
  var offset = Math.max(0, Number(options.offset || 0));
  var builtWhere = buildPgTableViewWhere(columns, options.filters || [], options.quick || '');
  if (options.rowFilter && options.rowFilter.column && Array.isArray(options.rowFilter.values) && options.rowFilter.values.length) {
    builtWhere.where.push(quotePgIdent(options.rowFilter.column) + ' IN (' + options.rowFilter.values.map(function(_, i) { return '$' + (builtWhere.params.length + i + 1); }).join(', ') + ')');
    builtWhere.params.push.apply(builtWhere.params, options.rowFilter.values);
  }
  if (options.dateFilter && options.dateFilter.column) {
    if (options.dateFilter.start) {
      builtWhere.where.push(quotePgIdent(options.dateFilter.column) + ' >= $' + (builtWhere.params.length + 1));
      builtWhere.params.push(options.dateFilter.start);
    }
    if (options.dateFilter.end) {
      builtWhere.where.push(quotePgIdent(options.dateFilter.column) + ' <= $' + (builtWhere.params.length + 1));
      builtWhere.params.push(options.dateFilter.end);
    }
  }
  var whereSql = builtWhere.where.length ? ' WHERE ' + builtWhere.where.join(' AND ') : '';
  var orderSql = buildPgTableViewOrder(columns, options.sortField, options.sortDir);
  var rowsResult = await pgCacheQuery('SELECT * FROM ' + tableSql + whereSql + orderSql + ' LIMIT $' + (builtWhere.params.length + 1) + ' OFFSET $' + (builtWhere.params.length + 2), builtWhere.params.concat(limit + 1, offset));
  var total = null;
  var totalKnown = false;
  if (options.includeCount || builtWhere.where.length) {
    var countResult = await pgCacheQuery('SELECT COUNT(*) AS total FROM ' + tableSql + whereSql, builtWhere.params);
    total = Number(countResult.rows[0] ? countResult.rows[0].total || 0 : 0);
    totalKnown = true;
  }
  var pageRows = rowsResult.rows.slice(0, limit);
  return { rows: serializeRows(pageRows), columns: columns, total: total, totalKnown: totalKnown, limit: limit, offset: offset, nextOffset: offset + pageRows.length, hasMore: rowsResult.rows.length > limit, cache: publicPgCacheStatusFromMeta(meta) };
}

async function savePgCacheMeta(payload) {
  await ensurePgCacheSchema();
  var result = await pgCacheQuery('SELECT 1 FROM ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, '__biwa_cache_meta') + ' WHERE LOWER(source_table) = LOWER($1) LIMIT 1', [String(payload.sourceTable || '')]);
  if (result.rows.length) {
    await pgCacheQuery('UPDATE ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, '__biwa_cache_meta') + ' SET cache_table = $2, physical_table = $3, columns_json = $4, row_count = $5, synced_at = $6::timestamptz, sync_mode = $7, last_error = $8, last_marker = $9, source_marker = $10, sync_strategy = $11, sync_column = $12, primary_keys = $13, last_changed_rows = $14::integer, last_data_update_at = CASE WHEN $14::integer > 0 THEN $6::timestamptz ELSE last_data_update_at END WHERE LOWER(source_table) = LOWER($1)', [
      String(payload.sourceTable || ''), String(payload.cacheTable || ''),
      String(payload.physicalTable || ''), JSON.stringify(payload.columns || []),
      Number(payload.rowCount || 0), String(payload.syncedAt || new Date().toISOString()),
      String(payload.syncMode || ''), String(payload.lastError || ''),
      String(payload.lastMarker || ''), String(payload.sourceMarker || ''),
      String(payload.syncStrategy || ''), String(payload.syncColumn || ''), JSON.stringify(payload.primaryKeys || []),
      Number(payload.lastChangedRows || 0)
    ]);
  } else {
    await pgCacheQuery('INSERT INTO ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, '__biwa_cache_meta') + ' (source_table, cache_table, physical_table, columns_json, row_count, synced_at, sync_mode, last_error, last_marker, source_marker, sync_strategy, sync_column, primary_keys, last_changed_rows, last_data_update_at) VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7,$8,$9,$10,$11,$12,$13,$14,$15::timestamptz)', [
      String(payload.sourceTable || ''), String(payload.cacheTable || ''),
      String(payload.physicalTable || ''), JSON.stringify(payload.columns || []),
      Number(payload.rowCount || 0), String(payload.syncedAt || new Date().toISOString()),
      String(payload.syncMode || ''), String(payload.lastError || ''),
      String(payload.lastMarker || ''), String(payload.sourceMarker || ''),
      String(payload.syncStrategy || ''), String(payload.syncColumn || ''), JSON.stringify(payload.primaryKeys || []),
      Number(payload.lastChangedRows || 0),
      Number(payload.lastChangedRows || 0) > 0 ? String(payload.syncedAt || new Date().toISOString()) : null
    ]);
  }
}

async function insertPgCacheSyncLog(payload) {
  if (!postgresCacheAvailable()) return;
  try {
    await ensurePgCacheSchema();
    await pgCacheQuery('INSERT INTO ' + quotePgQualified(POSTGRES_CACHE_SCHEMA, '__biwa_cache_sync_log') + ' (source_table, synced_at, sync_mode, sync_strategy, sync_column, row_count, changed_rows) VALUES ($1,$2::timestamptz,$3,$4,$5,$6,$7)', [
      String(payload.sourceTable || ''),
      String(payload.syncedAt || new Date().toISOString()),
      String(payload.syncMode || ''),
      String(payload.syncStrategy || ''),
      String(payload.syncColumn || ''),
      Number(payload.rowCount || 0),
      Number(payload.changedRows || 0)
    ]);
  } catch (e) {
    console.error('[PG Cache] Erro ao gravar log de sync:', e.message);
  }
}

async function autoImportUnimportedTables() {
  if (!postgresCacheAvailable()) return;
  var cached = await listPgCacheStatus();
  var cachedNames = new Set(cached.map(function(c) { return String(c.sourceTable || '').toLowerCase(); }));
  var imported = await readImportedTables();
  var importedSources = new Set(imported.map(function(t) { return String(t.sourceTable || '').toLowerCase(); }));
  var manualTables = new Set((await readManualTables()).map(function(t) { return String(t || '').toLowerCase(); }));
  var toImport = [];
  for (var i = 0; i < cached.length; i++) {
    var name = cached[i].sourceTable || '';
    if (name && !importedSources.has(name.toLowerCase()) && !manualTables.has(name.toLowerCase())) {
      var cachedItem = cached[i];
      if (cachedItem.syncMode === 'manual') continue;
      if (name.toLowerCase() === 'faturamento2') continue;
      toImport.push(name);
    }
  }
  if (toImport.length) {
    console.log('[PG Cache] Auto-importando ' + toImport.length + ' tabela(s) do cache PG...');
    for (var j = 0; j < toImport.length; j++) {
      try {
        var name = toImport[j];
        imported.push({ name: name, sourceTable: name, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), note: 'Auto-importado do cache PG', rowFilter: null, dateFilter: null, steps: [] });
      } catch (e) { console.error('[PG Cache] Erro ao auto-importar', name + ':', e.message); }
    }
    await writeImportedTables(imported);
  }
}
async function cleanupManualTablesFromImported() {
  var imported = await readImportedTables();
  var manualSet = new Set((await readManualTables()).map(function(t) { return String(t || '').toLowerCase(); }));
  var filtered = imported.filter(function(item) { return !manualSet.has(String(item.name || '').toLowerCase()); });
  if (filtered.length < imported.length) {
    console.log('[PG Cache] Removendo ' + (imported.length - filtered.length) + ' tabela(s) manual(is) do imported_tables.json');
    await writeImportedTables(filtered);
  }
}

app.get('/api/tables/:table/rows', requireDesktopAdmin, asyncHandler(async (req, res) => {
  const table = req.params.table;
  const limit = clampLimit(req.query.limit, 50);
  const offset = Math.max(0, Number(req.query.offset || 0));
  const includeCount = String(req.query.includeCount || '').toLowerCase() === 'true';
  const filters = parseTableViewFilters(req.query.filters);
  const quick = String(req.query.q || '').trim();
  const sortField = String(req.query.sortField || '').trim();
  const sortDir = String(req.query.sortDir || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
  const useCache = String(req.query.useCache || 'auto').toLowerCase() !== 'false';

  let cacheLookupTable = table;
  if (useCache) {
    // Se for uma consulta transformada com sqlExpression, executa diretamente via MySQL
    const savedTransform = await findTransformByName(table);
    if (savedTransform && savedTransform.sqlExpression) {
      try {
        const built = await buildTransformSql(savedTransform, { limit: 0 });
        const whereSql = built.sql.replace(/\s+LIMIT\s+\d+\s*$/i, '');
        const countResult = await dbQueryWithTimeout(`SELECT COUNT(*) AS total FROM (${whereSql}) q`, built.params || [], 15000);
        const total = Number(countResult[0] && countResult[0][0] ? countResult[0][0].total || 0 : 0);
        const finalSql = `SELECT * FROM (${whereSql}) q LIMIT ${limit + 1} OFFSET ${offset}`;
        const rowsResult = await dbQueryWithTimeout(finalSql, built.params || [], TABLE_ROWS_QUERY_TIMEOUT_MS);
        const rows = (rowsResult[0] || []).slice(0, limit);
        return res.json({
          rows: serializeRows(rows),
          columns: [],
          columnFormats: null,
          total, totalKnown: true, limit, offset,
          nextOffset: offset + rows.length, hasMore: rowsResult[0].length > limit,
          resource: { name: table, type: 'transform', source: 'sql-expression', readOnly: true },
          fromCache: false
        });
      } catch (err) {
        console.warn('[Table Rows] SQL expression falhou para', table + ':', err.message);
      }
    }
    let dateFilter = null;
    const imported = await findImportedTableByName(table);
    if (imported) cacheLookupTable = imported.sourceTable;
    const rowFilter = imported ? imported.rowFilter : null;
    dateFilter = imported ? imported.dateFilter : null;
    // Se a tabela importada tem steps, aplica transformacao via PG cache (dados brutos + applyChangeTypeToRows)
    if (imported && Array.isArray(imported.steps) && imported.steps.length) {
      if (postgresCacheAvailable()) {
        try {
          const pgCached = await readRowsFromPostgresCache(cacheLookupTable, { limit, offset, includeCount, rowFilter, dateFilter });
          if (pgCached && Array.isArray(pgCached.rows)) {
            let rows = pgCached.rows;
            rows = applyChangeTypeToRows(rows, table);
            return res.json({
              rows: serializeRows(rows), columns: pgCached.columns, columnFormats: buildColumnFormatsForTable(table, pgCached.columns),
              total: pgCached.total, totalKnown: pgCached.totalKnown, limit: pgCached.limit, offset: pgCached.offset,
              nextOffset: pgCached.nextOffset, hasMore: pgCached.hasMore,
              resource: { name: table, type: 'cache', source: 'postgres-cache', readOnly: true },
              fromCache: true, cacheEngine: 'postgres'
            });
          }
        } catch (e) { console.warn('[Table Rows] PG cache falhou para', table + ':', e.message); }
      }
    }
    if (!(imported && Array.isArray(imported.steps) && imported.steps.length) && postgresCacheAvailable()) {
      try {
        const pgCached = await readRowsFromPostgresCache(cacheLookupTable, { limit, offset, filters, quick, sortField, sortDir, includeCount, rowFilter, dateFilter });
        if (pgCached && Array.isArray(pgCached.rows)) {
          var rowsIsManual = false;
          if (!imported) {
            try { var rowsPgMeta = await getPgCacheMeta(cacheLookupTable); if (rowsPgMeta && rowsPgMeta.sync_mode === 'manual') rowsIsManual = true; } catch (e) {}
            try { var rowsManualTables = new Set(await readManualTables()); if (rowsManualTables.has(table)) rowsIsManual = true; } catch (e) {}
          }
          return res.json({ ...pgCached, columnFormats: buildColumnFormatsForTable(table, pgCached.columns), resource: { name: table, type: 'cache', source: 'postgres-cache', readOnly: !rowsIsManual, manual: rowsIsManual, editable: rowsIsManual }, fromCache: true, cacheEngine: 'postgres' });
        }
      } catch (err) { console.warn('[Table Rows] PG cache falhou para', table + ':', err.message); }
    }
    if (imported && imported.sourceTable) {
      const progress = getPgCacheProgress(imported.sourceTable);
      if (postgresCacheAvailable() && progress && progress.previewCacheTable) {
        try {
          const pgPreview = await readRowsFromPostgresSyncPreview(imported.sourceTable, progress.previewCacheTable, { limit, offset, filters, quick, sortField, sortDir, includeCount, rowFilter, dateFilter });
          if (pgPreview && Array.isArray(pgPreview.rows)) {
            if (Array.isArray(imported.steps) && imported.steps.length) {
              pgPreview.rows = serializeRows(applyChangeTypeToRows(pgPreview.rows, table));
            }
            return res.json({
              ...pgPreview,
              columns: applyChangeTypeOverridesToColumns(pgPreview.columns, table),
              columnFormats: buildColumnFormatsFromImported(table),
              resource: { name: table, physicalName: imported.sourceTable, type: 'table', source: 'postgres-sync-preview', readOnly: true },
              fromCache: false,
              previewFromSync: true,
              syncProgress: progress,
              message: 'Exibindo as linhas que ja foram copiadas enquanto a sincronizacao termina.'
            });
          }
        } catch (err) {
          console.warn('[Table Rows] Previa do cache em sincronizacao falhou para', table + ':', err.message);
        }
      }
      if (progress && progress.status !== 'error' && progress.status !== 'done' && progress.phase !== 'done') {
        return res.json({
          rows: [], columns: [], columnFormats: buildColumnFormatsFromImported(table), total: null, totalKnown: false,
          limit, offset, nextOffset: offset, hasMore: false,
          resource: { name: table, physicalName: imported.sourceTable, type: 'table', source: 'postgres-sync-preview', readOnly: true },
          fromCache: false, previewFromSync: true, syncProgress: progress,
          message: 'Preparando as primeiras linhas no PostgreSQL. A tabela sera atualizada automaticamente.'
        });
      }
      try {
        const mysqlPreview = await readRowsFromMysqlPreview(imported.sourceTable, { limit, offset, filters, quick, sortField, sortDir, includeCount, rowFilter, dateFilter });
        if (mysqlPreview && Array.isArray(mysqlPreview.rows)) {
          if (Array.isArray(imported.steps) && imported.steps.length) {
            mysqlPreview.rows = serializeRows(applyChangeTypeToRows(mysqlPreview.rows, table));
          }
          return res.json({
            ...mysqlPreview,
            columns: applyChangeTypeOverridesToColumns(mysqlPreview.columns, table),
            columnFormats: buildColumnFormatsFromImported(table),
            resource: { name: table, physicalName: imported.sourceTable, type: 'table', source: 'mysql-preview', readOnly: true },
            fromCache: false,
            previewFromSource: true,
            syncProgress: progress || null,
            message: progress ? 'Exibindo uma previa da origem enquanto o cache PostgreSQL e sincronizado.' : 'Exibindo uma previa direta da origem MySQL.'
          });
        }
      } catch (err) {
        console.warn('[Table Rows] Previa MySQL falhou para', table + ':', err.message);
      }
      return res.json({
        rows: [], columns: [], columnFormats: buildColumnFormatsFromImported(table), total: null, totalKnown: false,
        limit, offset, nextOffset: offset, hasMore: false,
        resource: { name: table, physicalName: imported.sourceTable, type: 'table', source: 'mysql-preview', readOnly: true },
        fromCache: false, syncProgress: progress || null,
        message: progress && progress.status === 'error'
          ? 'A sincronizacao falhou: ' + String(progress.error || 'erro desconhecido')
          : 'A origem MySQL nao respondeu rapidamente. Aguarde a sincronizacao PostgreSQL.'
      });
    }
    return res.json({ rows: [], columns: [], columnFormats: null, total: 0, totalKnown: false, limit, offset, nextOffset: offset, hasMore: false, resource: { name: table, type: 'unknown', readOnly: true }, fromCache: false, message: 'Dados ainda nao sincronizados no PostgreSQL. Aguarde a sincronizacao.' });
  }

  if (table === CALENDAR_TABLE_NAME) {
    const virtual = calendarVirtualRows({});
    const allRows = virtual.rows;
    const total = allRows.length;
    let filtered = allRows;
    var calColNames = calendarColumnNames();
    if (Array.isArray(filters) && filters.length) {
      filtered = filtered.filter(function(row) {
        return filters.every(function(f) {
          if (!f || !f.field || !calColNames.includes(f.field)) return true;
          var v = row[f.field];
          var sv = String(v === null || v === undefined ? '' : v);
          var op = String(f.operator || 'contains').toLowerCase();
          var cmp = String(f.value || '');
          if (op === 'blank') return sv === '';
          if (op === 'notBlank') return sv !== '';
          if (op === 'equals') return sv === cmp;
          if (op === 'notEquals') return sv !== cmp;
          if (op === 'startsWith') return sv.indexOf(cmp) === 0;
          if (op === 'endsWith') return sv.endsWith(cmp);
          if (op === 'gte') return Number(v) >= (toNumber(cmp) !== null ? toNumber(cmp) : Number(cmp));
          if (op === 'lte') return Number(v) <= (toNumber(cmp) !== null ? toNumber(cmp) : Number(cmp));
          if (op === 'between') {
            if (f.value) { var fv = toNumber(f.value); if (fv !== null && Number(v) < fv) return false; }
            if (f.value2) { var fv2 = toNumber(f.value2); if (fv2 !== null && Number(v) > fv2) return false; }
            return true;
          }
          return sv.toLowerCase().indexOf(cmp.toLowerCase()) >= 0;
        });
      });
    }
    if (quick) {
      const q = quick.toLowerCase();
      filtered = allRows.filter((row) => Object.values(row).some((v) => String(v || '').toLowerCase().includes(q)));
    }
    if (sortField && calendarColumnNames().includes(sortField)) {
      filtered = [...filtered].sort((a, b) => {
        const av = a[sortField]; const bv = b[sortField];
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        if (typeof av === 'number' && typeof bv === 'number') return sortDir === 'DESC' ? bv - av : av - bv;
        return sortDir === 'DESC' ? String(bv).localeCompare(String(av)) : String(av).localeCompare(String(bv));
      });
    }
    const totalFiltered = filtered.length;
    const paged = filtered.slice(offset, offset + limit);
    const nextOffset = offset + limit;
    const hasMore = nextOffset < totalFiltered;
    return res.json({
      rows: paged, columns: calendarColumnMetadata(), total: totalFiltered, totalKnown: true, limit, offset,
      nextOffset, hasMore,
      resource: { name: CALENDAR_TABLE_NAME, type: 'calendar', source: 'native', readOnly: true, nativeCalendar: true },
      fromCache: false
    });
  }

  return res.json({ rows: [], columns: [], columnFormats: null, total: 0, totalKnown: false, limit, offset, nextOffset: offset, hasMore: false, resource: { name: table, type: 'unknown', readOnly: true }, message: 'Dados nao disponiveis. Ative o cache.' });
}));

app.post('/api/tables/:table/rows/bulk', requirePermission('tableWrites', 'Insercao de registros'), asyncHandler(async (req, res) => {
  const table = req.params.table;
  await ensureManualTable(table, 'Insercao de registros');
  const columns = await getColumns(table);
  const inputRows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!inputRows.length) return res.status(201).json({ ok: true, affectedRows: 0 });
  const sanitizedRows = inputRows
    .map((row) => filterKnownColumns(row || {}, columns, { skipAutoIncrement: true }))
    .filter((row) => Object.keys(row).length);
  if (!sanitizedRows.length) return res.status(201).json({ ok: true, affectedRows: 0 });

  const pgRef = await resolveManualTablePgRef(table);
  if (pgRef) {
    var totalAffected = await pgCacheTransaction(async function(client) {
      const inserted = await insertManualRowsWithClient(client, pgRef, columns, sanitizedRows);
      await resetManualIdentitySequence(client, pgRef, columns);
      await refreshManualTableMetadata(table, inserted, client, pgRef);
      return inserted;
    });
    clearQueryCache('table-write');
    res.status(201).json({ ok: true, affectedRows: totalAffected });
    return;
  }
  throw apiError('Tabela manual nao encontrada no PostgreSQL. Verifique se o cache PostgreSQL esta ativo.', 503);
}));

app.post('/api/tables/:table/rows', requirePermission('tableWrites', 'Edicao de registros'), asyncHandler(async (req, res) => {
  const table = req.params.table;
  await ensureManualTable(table, 'Insercao de registros');
  const columns = await getColumns(table);
  const values = filterKnownColumns(req.body.values || req.body || {}, columns, { skipAutoIncrement: true });
  const keys = Object.keys(values);
  if (!keys.length) throw apiError('Nenhum valor para inserir.', 400);

  const pgRef = await resolveManualTablePgRef(table);
  if (pgRef) {
    var insertedRows = await pgCacheTransaction(async function(client) {
      const inserted = await insertManualRowsWithClient(client, pgRef, columns, [values]);
      await resetManualIdentitySequence(client, pgRef, columns);
      await refreshManualTableMetadata(table, inserted, client, pgRef);
      return inserted;
    });
    clearQueryCache('table-write');
    res.status(201).json({ ok: true, insertId: null, affectedRows: insertedRows });
    return;
  }
  throw apiError('Tabela manual nao encontrada no PostgreSQL. Verifique se o cache PostgreSQL esta ativo.', 503);
}));

app.patch('/api/tables/:table/rows', requirePermission('tableWrites', 'Edicao de registros'), asyncHandler(async (req, res) => {
  const table = req.params.table;
  await ensureManualTable(table, 'Atualizacao de registros');
  const columns = await getColumns(table);
  const pkColumns = primaryKeys(columns);
  if (!pkColumns.length) throw apiError('Esta tabela nao tem chave primaria. Atualizacao segura esta desativada.', 400);
  const values = filterKnownColumns(req.body.values || {}, columns);
  const keys = Object.keys(values).filter((k) => !pkColumns.includes(k));
  if (!keys.length) throw apiError('Nenhum valor editavel para atualizar.', 400);

  const pgRef = await resolveManualTablePgRef(table);
  if (pgRef) {
    var colTypes = {};
    (pgRef.meta.columns || []).forEach(function(c) { colTypes[c.name] = (c.type || '').toLowerCase(); });
    var setVals = keys.map(function(k) {
      var v = values[k] === undefined ? null : values[k];
      return sanitizePgValue(v, colTypes[k] || '');
    });
    var pkVals = pkColumns.map(function(k) { var v = req.body.pk && req.body.pk[k] !== undefined ? req.body.pk[k] : null; return v; });
    var paramIdx = 0;
    var pgSetParts = keys.map(function(k) { paramIdx++; return quotePgIdent(k) + ' = $' + paramIdx; });
    var pgWhereParts = pkColumns.map(function(k) { paramIdx++; return quotePgIdent(k) + ' = $' + paramIdx; });
    var pgSql = 'UPDATE ' + pgRef.pgTable + ' SET ' + pgSetParts.join(', ') + ' WHERE ' + pgWhereParts.join(' AND ');
    var allVals = setVals.concat(pkVals);
    var pgResult = await pgCacheTransaction(async function(client) {
      const updated = await client.query(pgSql, allVals);
      await refreshManualTableMetadata(table, updated.rowCount || 0, client, pgRef);
      return updated;
    });
    clearQueryCache('table-write');
    res.json({ ok: true, affectedRows: pgResult.rowCount || 0 });
    return;
  }
  throw apiError('Tabela manual nao encontrada no PostgreSQL. Verifique se o cache PostgreSQL esta ativo.', 503);
}));

app.delete('/api/tables/:table/rows', requirePermission('tableWrites', 'Edicao de registros'), asyncHandler(async (req, res) => {
  const table = req.params.table;
  await ensureManualTable(table, 'Exclusao de registros');
  const columns = await getColumns(table);
  const pkColumns = primaryKeys(columns);
  if (!pkColumns.length) throw apiError('Esta tabela nao tem chave primaria. Exclusao segura esta desativada.', 400);

  const pgRef = await resolveManualTablePgRef(table);
  if (pgRef) {
    var pgWhereParts = pkColumns.map(function(k, idx) { return quotePgIdent(k) + ' = $' + (idx + 1); });
    var pkVals = pkColumns.map(function(k) { var v = req.body.pk && req.body.pk[k] !== undefined ? req.body.pk[k] : null; return v; });
    var pgSql = 'DELETE FROM ' + pgRef.pgTable + ' WHERE ' + pgWhereParts.join(' AND ');
    var pgResult = await pgCacheTransaction(async function(client) {
      const deleted = await client.query(pgSql, pkVals);
      await refreshManualTableMetadata(table, deleted.rowCount || 0, client, pgRef);
      return deleted;
    });
    clearQueryCache('table-write');
    res.json({ ok: true, affectedRows: pgResult.rowCount || 0 });
    return;
  }
  throw apiError('Tabela manual nao encontrada no PostgreSQL. Verifique se o cache PostgreSQL esta ativo.', 503);
}));


app.get('/api/model', requireDesktopAdmin, asyncHandler(async (req, res) => {
  res.json({ model: await readSemanticModel() });
}));

app.put('/api/model', requirePermission('reportEditing', 'Modelagem de relatorios'), asyncHandler(async (req, res) => {
  const model = normalizeSemanticModel(req.body.model || req.body || {});
  const currentModel = await readSemanticModel();
  const currentLookup = buildMeasureLookup(currentModel);
  for (const measure of Array.isArray(model.measures) ? model.measures : []) {
    const formula = String(measure.formula || '').trim();
    if (!formula) continue;
    const current = currentLookup.get(normalizeMeasureNameKey(measure.name || measure.displayName));
    if (current && String(current.formula || '').trim() === formula) continue;
    const diagnostic = await validateDaxMeasureForModel(measure, model);
    if (!diagnostic.valid) throw apiError(diagnostic.displayMessage, 422);
    measure.diagnosticStatus = diagnostic.status;
    measure.lastDiagnostic = diagnostic.message;
    measure.lastValidatedAt = diagnostic.validatedAt;
  }
  const warnings = await validateModelResources(model);
  const saved = await writeSemanticModel(model);
  res.json({ ok: true, model: saved, warnings: warnings.length ? warnings : undefined });
}));

app.post('/api/model/sql', requireDesktopAdmin, asyncHandler(async (req, res) => {
  const model = normalizeSemanticModel(req.body.model || req.body || {});
  const warnings = await validateModelResources(model);
  const sql = buildModelSql(model, req.body.limit);
  res.json({ sql, warnings: warnings.length ? warnings : undefined });
}));

app.post('/api/model/preview', requireDesktopAdmin, asyncHandler(async (req, res) => {
  const model = normalizeSemanticModel(req.body.model || req.body || {});
  const warnings = await validateModelResources(model);
  const sql = buildModelSql(model, req.body.limit);
  const result = await runSelect(sql, req.body.limit);
  res.json({ ...result, sql, warnings: warnings.length ? warnings : undefined });
}));

app.get('/api/model/diagnostics', requireDesktopAdmin, asyncHandler(async (req, res) => {
  const model = await readSemanticModel();
  const reports = await readReports();
  res.json(reportModelDiagnostics(model, reports));
}));

app.get('/api/readiness/diagnostics', requireDesktopAdmin, asyncHandler(async (req, res) => {
  await readRealtimeEventMarker();
  res.json(await powerBiReadinessDiagnostics());
}));

app.get('/api/model/measures/diagnostics', requireDesktopAdmin, asyncHandler(async (req, res) => {
  const model = await readSemanticModel();
  const diagnostics = daxMeasureDiagnostics(model);
  res.json({ ...diagnostics, items: diagnostics.items.slice(0, 1000) });
}));

app.post('/api/model/measures/validate', requirePermission('reportEditing', 'Modelagem de relatorios'), asyncHandler(async (req, res) => {
  const model = normalizeSemanticModel(req.body.model || await readSemanticModel());
  const measureName = String(req.body.measureName || req.body.name || '').trim();
  const measure = buildMeasureLookup(model).get(normalizeMeasureNameKey(measureName));
  if (!measure) throw apiError('Medida não encontrada para validação: ' + (measureName || '(sem nome)'), 404);
  const diagnostic = await validateDaxMeasureForModel(measure, model);
  res.status(diagnostic.valid ? 200 : 422).json({ ok: diagnostic.valid, diagnostic, error: diagnostic.valid ? undefined : diagnostic.displayMessage });
}));

app.post('/api/model/measures/refresh-status', requirePermission('reportEditing', 'Modelagem de relatorios'), asyncHandler(async (req, res) => {
  const model = await readSemanticModel();
  const selectedName = String(req.body && (req.body.measureName || req.body.name) || '').trim();
  const ordered = daxMeasureDependencyOrder(model, selectedName);
  const validated = [];
  for (const measure of ordered) validated.push(await validateDaxMeasureForModel(measure, model));
  const selectedKey = selectedName ? normalizeMeasureNameKey(selectedName) : '';
  const byName = new Map(validated
    .filter((item) => !selectedKey || normalizeMeasureNameKey(item.name) === selectedKey)
    .map((item) => [normalizeMeasureNameKey(item.name), item]));
  model.measures = (model.measures || []).map((measure) => {
    const diag = byName.get(normalizeMeasureNameKey(measure.displayName || measure.name));
    if (!diag) return measure;
    return {
      ...measure,
      diagnosticStatus: diag.status,
      lastDiagnostic: diag.message,
      lastValidatedAt: diag.validatedAt
    };
  });
  const saved = await writeSemanticModel(model);
  res.json({ ok: true, scope: selectedName ? 'individual' : 'all', validated: validated.length, diagnostics: daxMeasureDiagnostics(saved), model: saved });
}));


app.get('/api/model/relationships/diagnostics', requireDesktopAdmin, asyncHandler(async (req, res) => {
  const model = await readSemanticModel();
  const reports = await readReports();
  res.json(await relationshipDiagnostics(model, reports));
}));

app.get('/api/model/relationships/suggestions', requireDesktopAdmin, asyncHandler(async (req, res) => {
  const model = await readSemanticModel();
  res.json(await suggestRelationshipsForModel(model));
}));


app.get('/api/security/diagnostics', requireDesktopAdmin, asyncHandler(async (req, res) => {
  const reports = await readReports();
  const rows = reports.map((report) => ({
    id: report.id,
    name: report.name || '',
    rowLevelSecurity: normalizeReportSecurity(report.security).enabled,
    rowRules: normalizeReportSecurity(report.security).rowFilters.length,
    exportPolicy: reportExportPolicy(report)
  }));
  res.json({ ok: true, totalReports: reports.length, protectedReports: rows.filter((r) => r.rowLevelSecurity).length, exportRestrictedReports: rows.filter((r) => r.exportPolicy.csv === false || r.exportPolicy.xls === false || r.exportPolicy.json === false).length, reports: rows });
}));

app.get('/api/reports/placeholders', requireDesktopAdmin, asyncHandler(async (req, res) => {
  const reports = await readReports();
  const items = reportPlaceholderItems(reports);
  res.json({
    ok: true,
    total: items.length,
    canTryAutoSql: items.filter((item) => item.canTryAutoSql).length,
    items: items.slice(0, 500)
  });
}));

app.post('/api/reports/placeholders/auto-sql', requireDesktopAdmin, asyncHandler(async (req, res) => {
  const reports = await readReports();
  let updated = 0;
  const skipped = [];
  for (const report of reports) {
    for (const visual of Array.isArray(report.visuals) ? report.visuals : []) {
      if (!isPlaceholderSql(visual.sql)) continue;
      try {
        const sql = await tryBuildSqlForPlaceholderVisual(visual, report.limit || 200);
        if (!sql) {
          skipped.push({ reportId: report.id, visualId: visual.id || '', title: visual.title || '', reason: 'sem tabela/campos reais compatíveis' });
          continue;
        }
        visual.sql = assertReadOnlySql(sql);
        visual.placeholderResolvedAt = new Date().toISOString();
        updated += 1;
      } catch (err) {
        skipped.push({ reportId: report.id, visualId: visual.id || '', title: visual.title || '', reason: err.message || 'erro ao gerar SQL' });
      }
    }
  }
  if (updated) {
    await writeReports(reports);
    clearQueryCache('placeholder-auto-sql');
  }
  res.json({ ok: true, updated, skipped: skipped.slice(0, 100), remaining: reportPlaceholderItems(reports).length });
}));

app.post('/api/model/relationships/auto', requirePermission('reportEditing', 'Modelagem de relatorios'), asyncHandler(async (req, res) => {
  const model = await readSemanticModel();
  const detected = await autoDetectRelationshipsForModel(model);
  const saved = await writeSemanticModel(detected.model);
  res.json({ ok: true, added: detected.added.length, relationships: detected.added, model: saved });
}));


// REGRA_CRITICA_FONTE_DADOS_CONSTRUTOR:
// O construtor de relatorios (visual-query) consulta APENAS o cache PostgreSQL.
// MySQL e usado EXCLUSIVAMENTE para sincronizar/atualizar o PostgreSQL.
// NUNCA consultar MySQL diretamente neste endpoint.
// REGRA_CRITICA_TABELA_MATRIZ_COLUNAS_DIRETAS:
// Tabela/Matriz devem tratar colunas como diretas (raw preview), sem agregacao automatica.
// Campos em Eixo/Dimensao, Valores e selectedFields sao colunas diretas.
app.post('/api/visual-query', requirePermission('reportEditing', 'Criacao de relatorios'), asyncHandler(async (req, res) => {
  const requestStartedAt = performance.now();
  const body = req.body || {};
  const pagedVisual = ['table', 'matrix'].includes(String(body.visualization || '').toLowerCase());
  const visualPage = pagedVisual ? Math.max(1, Math.floor(Number(body.page) || 1)) : 1;
  const visualPageSize = pagedVisual ? Math.max(25, Math.min(500, Math.floor(Number(body.pageSize) || 200))) : Math.max(1, Number(body.limit) || 200);
  if (pagedVisual) body.limit = Math.max(Number(body.limit) || visualPageSize, (visualPage * visualPageSize) + 1);
  body._visualPerf = { daxMs: 0 };
  let queryBuildCount = 1;
  const buildStartedAt = performance.now();
  const table = String(body.table || '').trim();
  const built = await buildVisualQueryFromRequest(body);
  const hasRuntimeReportFilters = Array.isArray(body.onlineFilters) && body.onlineFilters.length > 0;
  const baseBuilt = hasRuntimeReportFilters && built.runtimeFiltersEmbedded
    ? (queryBuildCount += 1, await buildVisualQueryFromRequest({ ...body, _visualPerf: body._visualPerf, onlineFilters: [], filters: {} }))
    : built;
  const queryBuildMs = performance.now() - buildStartedAt;
  const baseSql = String(baseBuilt.storedSql || baseBuilt.sql || '');
  const queryTable = String(built.table || table).trim();
  const requestedFields = normalizeVisualQueryFields(body.fields);
  const requestedFieldObjects = normalizeVisualQueryFieldObjects(body.fields);
  const metadataStartedAt = performance.now();
  const cacheScope = crypto.createHash('sha1').update(String(req.authUser && (req.authUser.id || req.authUser.username) || req.authRole || 'editor')).digest('hex').slice(0, 16);

  function sendVisualQuery(payload, timings) {
    const performanceData = Object.assign({
      queryBuildMs: Number(queryBuildMs.toFixed(3)),
      daxMs: Number(Number(body._visualPerf.daxMs || 0).toFixed(3)),
      queryBuildCount,
      directRelationshipJoins: Number(body._visualPerf.directRelationshipJoins || 0),
      fallbackRelationshipJoins: Number(body._visualPerf.fallbackRelationshipJoins || 0),
      metadataMs: 0,
      databaseMs: 0,
      transformMs: 0
    }, timings || {});
    if (body.performanceDiagnostics === true) performanceData.relationshipDiagnostics = body._visualPerf.relationshipDiagnostics || [];
    performanceData.totalServerMs = Number((performance.now() - requestStartedAt).toFixed(3));
    payload.performance = performanceData;
    performanceData.responseBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    res.setHeader('Server-Timing', [
      'build;dur=' + performanceData.queryBuildMs,
      'dax;dur=' + performanceData.daxMs,
      'db;dur=' + performanceData.databaseMs,
      'transform;dur=' + performanceData.transformMs
    ].join(', '));
    return res.json(payload);
  }

  let cacheLookupTable = queryTable;
  let metadataMs = 0;
  if (queryTable) {
    try {
      const resolved = await resolvePgCacheLookup(queryTable);
      cacheLookupTable = resolved.table || queryTable;
    } catch (e) {}
  }
  let queryColumnFormats = buildColumnFormatsFromImported(queryTable);
  if (queryTable && postgresCacheAvailable()) {
    try {
      const queryPgMeta = await getPgEffectiveMeta(queryTable) || await getPgCacheMeta(cacheLookupTable);
      if (queryPgMeta && Array.isArray(queryPgMeta.columns)) {
        queryColumnFormats = buildColumnFormatsForTable(queryTable, normalizePgCacheColumns(queryPgMeta.columns));
      }
    } catch (e) {}
    const relatedTables = [...new Set(requestedFieldObjects
      .map(function(field) { return normalizeTableName(field.table); })
      .filter(function(fieldTable) { return fieldTable && normalizeTableKey(fieldTable) !== normalizeTableKey(queryTable); }))];
    for (const relatedTable of relatedTables) {
      try {
        const relatedLookup = await resolvePgCacheLookup(relatedTable);
        const relatedMeta = await getPgEffectiveMeta(relatedTable) || await getPgCacheMeta(relatedLookup.table || relatedTable);
        if (relatedMeta && Array.isArray(relatedMeta.columns)) {
          const relatedFormats = buildColumnFormatsForTable(relatedTable, normalizePgCacheColumns(relatedMeta.columns));
          requestedFieldObjects
            .filter(function(field) { return normalizeTableKey(field.table) === normalizeTableKey(relatedTable); })
            .forEach(function(field) {
              if (relatedFormats[field.name]) queryColumnFormats[field.name] = relatedFormats[field.name];
            });
        }
      } catch (e) {}
    }
  }

  function pickColumns(rows, fields) {
    if (!fields || !fields.length || !Array.isArray(rows)) return rows || [];
    const fieldSet = new Set(fields.map(function(f) { return String(f || '').trim(); }).filter(Boolean));
    if (!fieldSet.size) return rows || [];
    return rows.map(function(row) {
      const picked = {};
      fields.forEach(function(f) {
        const key = String(f || '').trim();
        if (fieldSet.has(key) && row && row.hasOwnProperty(key)) picked[key] = row[key];
      });
      return picked;
    });
  }

  // Try PostgreSQL cache first (fonte primaria de dados do construtor)
  if (queryTable && postgresCacheAvailable()) {
    try {
      metadataMs = performance.now() - metadataStartedAt;
      const reportFilterWhere = buildReportFilterWhere(body.onlineFilters || [], body.filters || {}, {
        targetTable: queryTable,
        semanticModel: body.model || defaultSemanticModel(),
        pageId: body.pageId || '',
        visualId: body.visualId || '',
        daxFilterContext: built.daxFilterContext || null
      });
      // TransformContext ja faz parte da tabela logica efetiva resolvida pelo
      // PostgreSQL. Aqui entram somente os filtros interativos do relatorio.
      const visualSql = injectWhereIntoSelectSql(built.sql, reportFilterWhere.whereSql);
      visualFieldDebug('SQL BEFORE EXECUTION', {
        visualId: String(body.visualId || ''),
        fields: requestedFieldObjects.map(function(field) { return field.name; }),
        sql: visualSql
      });
      const runtimeTargetCount = Math.max(1, Math.floor(Number(built.runtimeFilterTargetCount) || 1));
      const repeatFilterParams = function(values) {
        const source = Array.isArray(values) ? values : [];
        const repeated = [];
        for (let index = 0; index < runtimeTargetCount; index += 1) repeated.push.apply(repeated, source);
        return repeated;
      };
      const filterParamTail = Array.isArray(reportFilterWhere.params) ? reportFilterWhere.params : [];
      const segmentedParams = Array.isArray(built.runtimeFilterParamSegments)
        ? built.runtimeFilterParamSegments
        : null;
      const visualParams = segmentedParams && segmentedParams.length === runtimeTargetCount
        ? segmentedParams.flatMap(function(segment) { return [...(Array.isArray(segment) ? segment : []), ...filterParamTail]; })
        : [
            ...(Array.isArray(built.params) ? built.params : []),
            ...repeatFilterParams(reportFilterWhere.params)
          ];
      visualFieldDebug('SQL PARAMETERS', {
        visualId: String(body.visualId || ''),
        runtimeTargetCount,
        markerCount: (String(built.sql || '').match(/\/\*__BIWA_RUNTIME_FILTER_(?:WHERE|AND)__\*\//g) || []).length,
        placeholderCount: (String(visualSql || '').match(/\?/g) || []).length,
        paramCount: visualParams.length,
        params: visualParams.map(function(value) {
          return value instanceof Date ? value.toISOString() : value;
        })
      });
      if (pagedVisual && body.totalsOnly === true) {
        const totalsStartedAt = performance.now();
        const totalsVisual = {
          id: body.visualId || '',
          visualization: body.visualization || 'table',
          table: queryTable,
          dimension: body.dimension || '',
          value: body.value || '',
          selectedFields: requestedFieldObjects,
          matrixRows: normalizeVisualBucketNames(body.matrixRows),
          matrixColumns: normalizeVisualBucketNames(body.matrixColumns),
          matrixValues: normalizeVisualBucketNames(body.matrixValues),
          visualFilters: Array.isArray(body.visualFilters) ? body.visualFilters : [],
          pageId: body.pageId || 'page_1'
        };
        const totalsMeta = await visualTotalsMetadataForRun(totalsVisual, [], visualPageSize, body.model || defaultSemanticModel(), {
          filters: body.filters || {},
          onlineFilters: body.onlineFilters || [],
          pageFilters: body.pageFilters || [],
          allPagesFilters: body.allPagesFilters || [],
          pageId: body.pageId || 'page_1',
          visualId: body.visualId || '',
          cacheScope,
          performanceDiagnostics: body.performanceDiagnostics === true
        });
        return sendVisualQuery(Object.assign({
          rows: [],
          table: queryTable,
          totalsOnly: true,
          columnFormats: queryColumnFormats,
          fromCache: true,
          cacheEngine: 'postgres'
        }, totalsMeta), {
          metadataMs: Number(metadataMs.toFixed(3)),
          databaseMs: Number((performance.now() - totalsStartedAt).toFixed(3)),
          transformMs: 0
        });
      }
      const databaseStartedAt = performance.now();
      const pgCachedResult = await tryRunSelectFromPostgresCache(visualSql, pagedVisual ? visualPageSize + 1 : (body.limit || 200), {
        targetTable: cacheLookupTable,
        builtFilters: { params: visualParams },
        cacheScope,
        offset: pagedVisual ? (visualPage - 1) * visualPageSize : 0
      });
      const databaseMs = performance.now() - databaseStartedAt;
      if (pgCachedResult) {
        const transformStartedAt = performance.now();
        let rows = serializeRows(pgCachedResult.rows || []);
        rows = applyChangeTypeToRows(rows, queryTable);
        const hasMoreRows = pagedVisual && rows.length > visualPageSize;
        if (hasMoreRows) rows = rows.slice(0, visualPageSize);
        var totalsMeta = {};
        if (['table', 'matrix'].includes(String(body.visualization || 'table').toLowerCase())) {
          var visualObj = { id: body.visualId || '', visualization: body.visualization || 'table', table: queryTable, dimension: body.dimension || '', value: body.value || '', selectedFields: requestedFieldObjects, pageId: body.pageId || 'page_1' };
          if (body.deferTotals === true) {
            totalsMeta = { totals: {}, totalsAuthoritative: false, rowsComplete: false, totalsPending: true };
          } else {
            totalsMeta = await visualTotalsMetadataForRun(visualObj, rows, visualPageSize, body.model || defaultSemanticModel(), {
              filters: body.filters || {},
              onlineFilters: body.onlineFilters || [],
              pageFilters: body.pageFilters || [],
              allPagesFilters: body.allPagesFilters || [],
              pageId: body.pageId || 'page_1',
              visualId: body.visualId || '',
              cacheScope,
              performanceDiagnostics: body.performanceDiagnostics === true
            });
          }
        }
        const payload = Object.assign({
          rows,
          table: queryTable,
          columnFormats: queryColumnFormats,
          fields: pgCachedResult.fields || requestedFields.map(function(f) { return { name: f, type: 'text' }; }),
          sql: inlineSqlParams(visualSql, visualParams),
          baseSql,
          filterWarnings: Array.isArray(reportFilterWhere.warnings) ? reportFilterWhere.warnings : [],
          fromCache: true,
          cacheEngine: pgCachedResult.cacheEngine || 'postgres'
          ,pageInfo: pagedVisual ? { page: visualPage, pageSize: visualPageSize, hasMore: hasMoreRows } : undefined
        }, totalsMeta);
        visualFieldDebug('QUERY RESULT', {
          visualId: String(body.visualId || ''),
          columns: rows.length ? Object.keys(rows[0]) : (pgCachedResult.fields || []).map(function(field) { return field && field.name; }).filter(Boolean),
          rowCount: rows.length
        });
        const transformMs = performance.now() - transformStartedAt;
        return sendVisualQuery(payload, {
          metadataMs: Number(metadataMs.toFixed(3)),
          databaseMs: Number(databaseMs.toFixed(3)),
          transformMs: Number(transformMs.toFixed(3))
        });
      }
    } catch (err) {
      if (err && err.message && /n.o existe a rela..o/i.test(err.message)) {
        try { await clearPostgresCacheForTable(queryTable); } catch (cleanupErr) {}
        console.error('[PG visual-query] Cache inexistente para', queryTable + '; metadado removido. O proximo sync recriara a tabela.');
      }
      console.error('[PG visual-query] erro para tabela', queryTable + ':', err.message || err.code || String(err));
      throw apiError('Nao foi possivel executar o visual: ' + String(err && err.message || err), 400);
    }
  }

  // Dados nao encontrados no cache PostgreSQL. Retorna vazio.
  sendVisualQuery({ rows: [], table: queryTable, fields: [], sql: baseSql, baseSql, filterWarnings: [], fromCache: false, message: 'Dados ainda nao sincronizados no cache PostgreSQL.' }, { metadataMs: Number((performance.now() - metadataStartedAt).toFixed(3)) });
}));

app.post('/api/query', requirePermission('reportEditing', 'Criacao de relatorios'), asyncHandler(async (req, res) => {
  const result = await runSelect(req.body.sql, req.body.limit);
  res.json(result);
}));

app.get('/api/realtime/status', asyncHandler(async (req, res) => {
  const marker = await readRealtimeEventMarker();
  res.json({
    cacheEnabled: QUERY_CACHE_ENABLED,
    cacheTtlMs: QUERY_CACHE_TTL_MS,
    cacheItems: queryCache.size,
    inFlight: inFlightQueryCache.size,
    mode: REALTIME_EVENT_TABLE ? 'mysql_event_marker' : 'interval_polling',
    realtimeEventTable: REALTIME_EVENT_TABLE || null,
    realtimeEventColumn: REALTIME_EVENT_TABLE ? REALTIME_EVENT_COLUMN : null,
    realtimeEventPollSeconds: REALTIME_EVENT_TABLE ? REALTIME_EVENT_POLL_SECONDS : null,
    realtimeEventMarker: marker,
    realtimeEventLastCheckedAt: realtimeEventCheckedAt ? new Date(realtimeEventCheckedAt).toISOString() : null,
    realtimeEventLastChangeAt: realtimeEventLastChangeAt ? new Date(realtimeEventLastChangeAt).toISOString() : null,
    realtimeEventLastError: realtimeEventLastError || '',
    defaultRefreshSeconds: DEFAULT_REFRESH_SECONDS,
    serverPushIntervalSeconds: SERVER_PUSH_INTERVAL_SECONDS
  });
}));

app.post('/api/realtime/cache/clear', requireDesktopAdmin, asyncHandler(async (req, res) => {
  clearQueryCache('manual-api');
  res.json({ ok: true, clearedAt: new Date().toISOString() });
}));

app.get('/api/reports', asyncHandler(async (req, res) => {
  const reports = await readReports();
  const semanticModel = isOnlineViewerRole(req.authRole) ? await readSemanticModel() : null;
  const allowedReports = isOnlineViewerRole(req.authRole) ? reportsForAuthUser(reports, req.authUser).map((report) => publicReport(report, semanticModel)) : reports;
  res.json({ reports: allowedReports });
}));

app.post('/api/reports', requirePermission('reportEditing', 'Criacao de relatorios'), asyncHandler(async (req, res) => {
  const sql = assertReadOnlySql(req.body.sql);
  const now = new Date().toISOString();
  const reports = await readReports();
  const report = {
    id: crypto.randomUUID(),
    name: String(req.body.name || 'Relatorio sem nome').slice(0, 120),
    sql,
    visualization: VISUAL_TYPES.includes(req.body.visualization) ? req.body.visualization : 'table',
    visuals: normalizeReportVisuals(req.body.visuals),
    refreshSeconds: clampLimit(req.body.refreshSeconds, DEFAULT_REFRESH_SECONDS, 3600),
    limit: clampLimit(req.body.limit, 200),
    layout: req.body.layout && typeof req.body.layout === 'object' ? req.body.layout : { x: 32, y: 32, width: 560, height: 360 },
    pages: normalizeReportPages(req.body.pages),
    onlineFilters: normalizeOnlineFilters(req.body.onlineFilters),
    pageFilters: Array.isArray(req.body.pageFilters) ? req.body.pageFilters : [],
    allPagesFilters: Array.isArray(req.body.allPagesFilters) ? req.body.allPagesFilters : [],
    theme: normalizeReportTheme(req.body.theme),
    security: normalizeReportSecurity(req.body.security),
    createdAt: now,
    updatedAt: now
  };
  reports.push(report);
  await writeReports(reports);
  clearQueryCache('data-change');
  res.status(201).json({ report });
}));

app.put('/api/reports/:id', requirePermission('reportEditing', 'Criacao de relatorios'), asyncHandler(async (req, res) => {
  const reports = await readReports();
  const idx = reports.findIndex((r) => r.id === req.params.id);
  if (idx === -1) throw apiError('Relatorio nao encontrado.', 404);
  const current = reports[idx];
  const next = {
    ...current,
    name: String(req.body.name || current.name || 'Relatorio sem nome').slice(0, 120),
    sql: req.body.sql ? assertReadOnlySql(req.body.sql) : current.sql,
    visualization: VISUAL_TYPES.includes(req.body.visualization) ? req.body.visualization : current.visualization,
    visuals: Array.isArray(req.body.visuals) ? normalizeReportVisuals(req.body.visuals) : (current.visuals || []),
    refreshSeconds: clampLimit(req.body.refreshSeconds || current.refreshSeconds, DEFAULT_REFRESH_SECONDS, 3600),
    limit: clampLimit(req.body.limit || current.limit, 200),
    layout: req.body.layout && typeof req.body.layout === 'object' ? req.body.layout : (current.layout || { x: 32, y: 32, width: 560, height: 360 }),
    pages: Array.isArray(req.body.pages) ? normalizeReportPages(req.body.pages) : normalizeReportPages(current.pages),
    onlineFilters: Array.isArray(req.body.onlineFilters) ? normalizeOnlineFilters(req.body.onlineFilters) : normalizeOnlineFilters(current.onlineFilters),
    pageFilters: Array.isArray(req.body.pageFilters) ? req.body.pageFilters : (current.pageFilters || []),
    allPagesFilters: Array.isArray(req.body.allPagesFilters) ? req.body.allPagesFilters : (current.allPagesFilters || []),
    theme: normalizeReportTheme(req.body.theme || current.theme),
    security: req.body.security && typeof req.body.security === 'object' ? normalizeReportSecurity(req.body.security) : normalizeReportSecurity(current.security),
    updatedAt: new Date().toISOString()
  };
  reports[idx] = next;
  await writeReports(reports);
  clearQueryCache('data-change');
  res.json({ report: next });
}));

app.delete('/api/reports/:id', requirePermission('reportEditing', 'Criacao de relatorios'), asyncHandler(async (req, res) => {
  const reports = await readReports();
  const next = reports.filter((r) => r.id !== req.params.id);
  if (next.length === reports.length) throw apiError('Relatorio nao encontrado.', 404);
  await writeReports(next);
  clearQueryCache('data-change');
  res.json({ ok: true });
}));


function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[";\n\r,]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
  return text;
}

function rowsToCsv(rows = []) {
  if (!Array.isArray(rows) || !rows.length) return '';
  const columns = Object.keys(rows[0]);
  const lines = [columns.map(csvCell).join(';')];
  for (const row of rows) lines.push(columns.map((col) => csvCell(row[col])).join(';'));
  return lines.join('\n') + '\n';
}

function safeDownloadName(value, fallback = 'relatorio') {
  return String(value || fallback).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || fallback;
}

function rowsToExcelHtml(rows = [], title = 'Relatorio') {
  const safeTitle = String(title || 'Relatorio').replace(/[<>]/g, '');
  const columns = Array.isArray(rows) && rows[0] ? Object.keys(rows[0]) : [];
  const esc = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const header = columns.map((col) => `<th>${esc(col)}</th>`).join('');
  const body = (Array.isArray(rows) ? rows : []).map((row) => `<tr>${columns.map((col) => `<td>${esc(row[col])}</td>`).join('')}</tr>`).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><style>table{border-collapse:collapse;font-family:Arial,sans-serif;font-size:12px}th{background:#eaf2ff;font-weight:bold}th,td{border:1px solid #cbd5e1;padding:5px 8px;white-space:nowrap}</style></head><body><h3>${esc(safeTitle)}</h3><table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></body></html>`;
}

function parseExportFilters(req, accessibleReport) {
  let filters = {};
  let crossFilters = [];
  try { filters = req.query && req.query.filters ? JSON.parse(String(req.query.filters)) : {}; } catch (err) { filters = {}; }
  try { crossFilters = req.query && req.query.crossFilters ? JSON.parse(String(req.query.crossFilters)) : []; } catch (err) { crossFilters = []; }
  const runtimeCross = normalizeRuntimeCrossFilters(crossFilters, accessibleReport.visuals || []);
  const securityRuntime = runtimeSecurityFiltersForReport(accessibleReport, req.authUser || { role: 'viewer' });
  return {
    filters: { ...(filters && typeof filters === 'object' ? filters : {}), ...runtimeCross.values, ...securityRuntime.filters },
    onlineFilters: [...normalizeOnlineFilters(accessibleReport.onlineFilters), ...runtimeCross.filters, ...securityRuntime.onlineFilters]
  };
}

async function runReportForExport(accessibleReport, req) {
  const semanticModel = await readSemanticModel();
  const parsed = parseExportFilters(req, accessibleReport);
  const sql = await normalizeReportSqlForDashboard(accessibleReport, accessibleReport.limit || req.query.limit || 5000, semanticModel);
  return runSelect(sql, accessibleReport.limit || req.query.limit, {
    filters: parsed.filters,
    onlineFilters: parsed.onlineFilters,
    targetTable: accessibleReport.table || '',
    semanticModel
  });
}

function reportPlaceholderItems(reports = []) {
  const items = [];
  for (const report of reports || []) {
    if (isPlaceholderSql(report.sql)) {
      items.push({ reportId: report.id, reportName: report.name || '', visualId: '', visualTitle: report.name || '', table: report.table || '', fields: [], type: 'report', sql: report.sql || '' });
    }
    for (const visual of Array.isArray(report.visuals) ? report.visuals : []) {
      if (!isPlaceholderSql(visual.sql)) continue;
      const fields = visualRawFieldNames(visual);
      items.push({
        reportId: report.id,
        reportName: report.name || '',
        visualId: visual.id || '',
        visualTitle: visual.title || visual.name || '',
        visualization: visual.visualization || '',
        table: visual.table || '',
        dimension: visual.dimension || '',
        value: visual.value || '',
        fields,
        type: 'visual',
        sql: visual.sql || '',
        canTryAutoSql: Boolean(visual.table && fields.length && !/medidas/i.test(String(visual.table)))
      });
    }
  }
  return items;
}

async function tryBuildSqlForPlaceholderVisual(visual, fallbackLimit) {
  const table = String(visual && visual.table || '').trim();
  if (!table || /medidas/i.test(table)) return null;
  const fields = visualRawFieldNames(visual);
  if (!fields.length) return null;
  const cols = await getColumns(table);
  const available = new Set((cols || []).map((col) => String(col.name || '').toLowerCase()));
  const usable = fields.filter((field) => available.has(String(field).toLowerCase()));
  if (!usable.length) return null;
  const built = await buildVisualQueryFromRequest({
    table,
    visualization: ['table', 'matrix'].includes(String(visual.visualization || '').toLowerCase()) ? visual.visualization : 'table',
    dimension: usable[0] || '',
    value: usable[1] || usable[0] || '',
    fields: usable,
    aggregation: visual.aggregation || 'SUM',
    order: visual.order || 'DESC',
    limit: fallbackLimit || 200
  });
  return built.storedSql || built.sql;
}

function visualColumnFormatsForRun(visual, report = null, semanticModel = null) {
  semanticModel = semanticModel || (report && report.__biwaFormattingModel) || null;
  const tableName = visual && visual.table || report && report.table || '';
  const selectedFields = publicVisualQueryFieldObjects(visual && visual.selectedFields, semanticModel);
  const columns = selectedFields.map(function(f) { return { name: f.name, dataType: f.type }; });
  const formats = buildColumnFormatsForTable(tableName, columns);
  selectedFields.forEach(function(field) {
    const fieldFormat = visualRuntimeFormatFromFieldFormat(field.format);
    if (fieldFormat) formats[field.name] = { ...(formats[field.name] || {}), ...fieldFormat };
  });
  const visualFormats = visual && visual.columnFormats;
  if (visualFormats && typeof visualFormats === 'object' && !Array.isArray(visualFormats)) {
    Object.entries(visualFormats).forEach(function([key, value]) {
      if (key && value && typeof value === 'object' && !Array.isArray(value)) formats[key] = { ...(formats[key] || {}), ...value, _formatPriority: 'visual' };
    });
  }
  return formats;
}

async function visualTotalsMetadataForRun(visual, rows, reportLimit, semanticModel, runtimeOptions = {}) {
  const vizType = String(visual && visual.visualization || '').toLowerCase();
  if (!['table', 'matrix'].includes(vizType)) return {};
  const metadata = {
    totals: {},
    totalsAuthoritative: true,
    rowsComplete: (Array.isArray(rows) ? rows.length : 0) < Math.max(1, Number(reportLimit) || 1)
  };
  try {
    const totalsQuery = await sqlForVisualMeasureTotalsRunDetails(visual, semanticModel, runtimeOptions);
    if (!totalsQuery) return metadata;
    if (runtimeOptions.performanceDiagnostics === true) {
      const diagnosticFilters = buildReportFilterWhere(runtimeOptions.onlineFilters || [], runtimeOptions.filters || {}, {
        targetTable: totalsQuery.table || visual.table || '',
        semanticModel,
        pageId: visual.pageId || runtimeOptions.pageId || 'page_1',
        activePageId: runtimeOptions.activePageId || runtimeOptions.pageId || '',
        visualId: visual.id || runtimeOptions.visualId || '',
        daxFilterContext: totalsQuery.daxFilterContext || null
      });
      const markerCount = Math.max(1, (String(totalsQuery.sql || '').match(/\/\*__BIWA_RUNTIME_FILTER_(?:WHERE|AND)__\*\//g) || []).length);
      const diagnosticParams = [];
      for (let index = 0; index < markerCount; index += 1) diagnosticParams.push.apply(diagnosticParams, diagnosticFilters.params || []);
      metadata.totalSql = inlineSqlParams(
        injectWhereIntoSelectSql(totalsQuery.sql, diagnosticFilters.whereSql),
        diagnosticParams
      );
      metadata.totalFields = (totalsQuery.fields || []).map(function(field) { return field && field.name; }).filter(Boolean);
    }
    visualFieldDebug('TOTALS QUERY', {
      visualId: String(visual && visual.id || ''),
      fields: (totalsQuery.fields || []).map(function(field) { return field && field.name; }).filter(Boolean),
      sql: totalsQuery.sql
    });
    const totalsRun = await runSelect(totalsQuery.sql, 1, {
      filters: runtimeOptions.filters || {},
      onlineFilters: runtimeOptions.onlineFilters || [],
      targetTable: totalsQuery.table || visual.table || '',
      semanticModel,
      pageId: visual.pageId || runtimeOptions.pageId || 'page_1',
      activePageId: runtimeOptions.activePageId || runtimeOptions.pageId || '',
      visualId: visual.id || runtimeOptions.visualId || '',
      daxFilterContext: totalsQuery.daxFilterContext || null,
      cacheScope: String(runtimeOptions.cacheScope || '')
    });
    metadata.totals = totalsRun && Array.isArray(totalsRun.rows) && totalsRun.rows[0] ? totalsRun.rows[0] : {};
    visualFieldDebug('TOTALS RESULT', { visualId: String(visual && visual.id || ''), totals: metadata.totals });
    debugLog('[TOTALS] visual=' + (visual && visual.id) + ' table=' + (visual && visual.table) + ' sql=' + (totalsQuery.sql || '').substring(0, 500) + ' totals=' + JSON.stringify(metadata.totals));
    return metadata;
  } catch (err) {
    // Falhar fechado: uma medida DAX nao pode virar silenciosamente a soma das
    // linhas carregadas. Isso seria incorreto para DIVIDE, medias, percentuais,
    // iteradores e qualquer outra medida nao aditiva.
    metadata.totalsAuthoritative = false;
    metadata.totalsError = 'Não foi possível calcular o total deste visual.';
    visualFieldDebug('TOTALS ERROR', {
      visualId: String(visual && visual.id || ''),
      message: err && err.message ? err.message : String(err)
    });
    console.error('[TOTALS] visual=' + String(visual && visual.id || '') + ' error=' + (err && err.stack ? err.stack : String(err)));
    return metadata;
  }
}

function visualTotalsReuseContextKey(visual) {
  return stableJson({
    table: normalizeTableKey(visual && visual.table),
    pageId: String(visual && visual.pageId || 'page_1'),
    visualFilters: Array.isArray(visual && visual.visualFilters) ? visual.visualFilters : []
  });
}

function reusableCardMeasureName(visual) {
  if (!['card', 'kpi'].includes(String(visual && visual.visualization || '').toLowerCase())) return '';
  const measureField = normalizeVisualQueryFieldObjects(visual && visual.selectedFields)
    .find((field) => field && (field.measureId || String(field.type || '').toLowerCase() === 'measure'));
  return String(measureField && (measureField.measureId || measureField.name) || visual && visual.value || '').trim();
}

function reusableCardVisualResult(visual, report, semanticModel, reusableTotals) {
  const measureName = reusableCardMeasureName(visual);
  if (!measureName) return null;
  const totals = reusableTotals.get(visualTotalsReuseContextKey(visual));
  if (!totals || !Object.prototype.hasOwnProperty.call(totals, measureName)) return null;
  return {
    id: visual.id,
    title: visual.title,
    visualization: visual.visualization,
    table: visual.table || '',
    dimension: visual.dimension || '',
    value: visual.value || '',
    selectedFields: normalizeVisualQueryFieldObjects(visual.selectedFields),
    matrixRows: normalizeVisualBucketNames(visual.matrixRows),
    matrixColumns: normalizeVisualBucketNames(visual.matrixColumns),
    matrixValues: normalizeVisualBucketNames(visual.matrixValues),
    layout: visual.layout,
    pageId: visual.pageId || 'page_1',
    style: normalizeVisualStyle(visual.style),
    columnFormats: visualColumnFormatsForRun(visual, report, semanticModel),
    rows: [{ [measureName]: totals[measureName] }],
    cached: true,
    cacheEngine: 'report-total-reuse',
    cacheAgeMs: 0,
    filterWarnings: [],
    sql: ''
  };
}

function rememberReusableVisualTotals(reusableTotals, visual, totalsMetadata) {
  if (!totalsMetadata || totalsMetadata.totalsAuthoritative === false) return;
  const totals = totalsMetadata.totals;
  if (!totals || typeof totals !== 'object' || !Object.keys(totals).length) return;
  reusableTotals.set(visualTotalsReuseContextKey(visual), { ...totals });
}

async function executeReportVisualRun(accessibleReport, options = {}) {
  const filters = options && options.filters;
  const runtimeCross = normalizeRuntimeCrossFilters(options && options.crossFilters, accessibleReport.visuals || []);
  const securityRuntime = runtimeSecurityFiltersForReport(accessibleReport, (options && options.authUser) || { role: 'viewer' });
  const runFilters = { ...(filters && typeof filters === 'object' ? filters : {}), ...runtimeCross.values, ...securityRuntime.filters };
  const runOnlineFilters = [...normalizeOnlineFilters(accessibleReport.onlineFilters), ...runtimeCross.filters, ...securityRuntime.onlineFilters];
  const activePageId = String(options && options.pageId || '');
  const semanticModel = options.semanticModel || await readSemanticModel();
  Object.defineProperty(accessibleReport, '__biwaFormattingModel', { value: semanticModel, configurable: true });
  const cacheCoverage = await dashboardPostgresCacheCoverage(accessibleReport).catch((err) => ({ kind: 'postgres', enabled: POSTGRES_CACHE_ENABLED, available: false, error: err.message, totalTables: 0, cachedTables: 0, missingTables: 0, tables: [] }));
  const reportLimit = accessibleReport.limit || options.limit || 200;
  const cacheScope = String(options.cacheScope || ((options.authUser && (options.authUser.id || options.authUser.username || options.authUser.role)) || 'anonymous'));
  const visualResults = [];
  const reusableVisualTotals = new Map();
  if (Array.isArray(accessibleReport.visuals) && accessibleReport.visuals.length) {
    const runnableVisuals = accessibleReport.visuals.slice(0, 300).filter((visual) => !activePageId || String(visual && visual.pageId || 'page_1') === activePageId);
    for (const visual of runnableVisuals) {
      const vizType = String(visual && visual.visualization || '').toLowerCase();
      if (vizType === 'textbox' || vizType === 'image') {
        const base = { id: visual.id, title: visual.title, visualization: vizType, table: '', dimension: '', value: '', selectedFields: [], layout: visual.layout, pageId: visual.pageId || 'page_1', style: normalizeVisualStyle(visual.style), rows: [], cached: false, cacheEngine: '', cacheAgeMs: 0, sql: '' };
        if (vizType === 'textbox') base.content = visual.content || '';
        if (vizType === 'image') { base.src = visual.src || ''; base.fit = visual.fit || 'contain'; }
        visualResults.push(base);
        continue;
      }
      if (!shouldRunVisualAsRawTable(visual) && !String(visual && visual.sql || '').trim()) {
        visualResults.push({ id: visual.id, title: visual.title, visualization: visual.visualization, table: visual.table || '', dimension: '', value: '', selectedFields: [], matrixRows: [], matrixColumns: [], matrixValues: [], layout: visual.layout, pageId: visual.pageId || 'page_1', style: normalizeVisualStyle(visual.style), rows: [], cached: false, cacheEngine: '', cacheAgeMs: 0, sql: '' });
        continue;
      }
      const reusedCard = reusableCardVisualResult(visual, accessibleReport, semanticModel, reusableVisualTotals);
      if (reusedCard) {
        visualResults.push(reusedCard);
        continue;
      }
      try {
        const visualQuery = await sqlForVisualRunDetails(visual, reportLimit, semanticModel, {
          filters: runFilters,
          onlineFilters: runOnlineFilters,
          pageFilters: accessibleReport.pageFilters || [],
          allPagesFilters: accessibleReport.allPagesFilters || [],
          pageId: visual.pageId || 'page_1',
          activePageId: options.pageId || '',
          visualId: visual.id || ''
        });
        const visualSql = visualQuery.sql;
        const vr = await runSelect(visualSql, reportLimit, { filters: runFilters, onlineFilters: runOnlineFilters, targetTable: visualQuery.table || visual.table || accessibleReport.table || '', semanticModel, pageId: visual.pageId || 'page_1', activePageId: options.pageId || '', visualId: visual.id || '', daxFilterContext: visualQuery.daxFilterContext || null, cacheScope });
        const totalsMetadata = await visualTotalsMetadataForRun(visual, vr.rows || [], reportLimit, semanticModel, {
          filters: runFilters,
          onlineFilters: runOnlineFilters,
          pageFilters: accessibleReport.pageFilters || [],
          allPagesFilters: accessibleReport.allPagesFilters || [],
          pageId: visual.pageId || 'page_1',
          activePageId: options.pageId || '',
          visualId: visual.id || '',
          cacheScope
        });
        rememberReusableVisualTotals(reusableVisualTotals, visual, totalsMetadata);
        visualResults.push({ id: visual.id, title: visual.title, visualization: visual.visualization, table: visual.table || '', dimension: visual.dimension || '', value: visual.value || '', selectedFields: normalizeVisualQueryFieldObjects(visual.selectedFields), matrixRows: normalizeVisualBucketNames(visual.matrixRows), matrixColumns: normalizeVisualBucketNames(visual.matrixColumns), matrixValues: normalizeVisualBucketNames(visual.matrixValues), layout: visual.layout, pageId: visual.pageId || 'page_1', style: normalizeVisualStyle(visual.style), columnFormats: visualColumnFormatsForRun(visual, accessibleReport), rows: vr.rows || [], ...totalsMetadata, cached: Boolean(vr.cached), cacheEngine: vr.cacheEngine || '', cacheAgeMs: vr.cacheAgeMs || 0, filterWarnings: Array.isArray(vr.filterWarnings) ? vr.filterWarnings : [], sql: visualSql });
      } catch (err) {
        const friendly = isMysqlQueryTimeout(err)
          ? 'A consulta deste visual demorou demais. O app evitou travar; reduza campos/filtros ou use uma coluna indexada.'
          : (err.message || 'Erro no visual');
        visualResults.push({ id: visual.id, title: visual.title, visualization: visual.visualization, table: visual.table || '', dimension: visual.dimension || '', value: visual.value || '', selectedFields: normalizeVisualQueryFieldObjects(visual.selectedFields), matrixRows: normalizeVisualBucketNames(visual.matrixRows), matrixColumns: normalizeVisualBucketNames(visual.matrixColumns), matrixValues: normalizeVisualBucketNames(visual.matrixValues), layout: visual.layout, pageId: visual.pageId || 'page_1', style: normalizeVisualStyle(visual.style), columnFormats: visualColumnFormatsForRun(visual, accessibleReport), rows: [], error: friendly });
      }
    }
    const cacheSummary = {
      postgres: visualResults.filter((v) => String(v.cacheEngine || '').toLowerCase() === 'postgres').length,
      memory: visualResults.filter((v) => v.cached && String(v.cacheEngine || '').toLowerCase() !== 'postgres').length,
      mysql: visualResults.filter((v) => !v.cached).length,
      total: visualResults.length
    };
    return { rows: [], fields: [], visualResults, generatedAt: new Date().toISOString(), cached: visualResults.some((v) => v.cached), cacheSummary, cacheCoverage, cacheEngine: cacheSummary.postgres ? 'mixed-postgres' : (cacheSummary.memory ? 'memory' : 'mysql') };
  }

  const reportSql = await normalizeReportSqlForDashboard(accessibleReport, reportLimit, semanticModel);
  const result = await runSelect(reportSql, reportLimit, { filters: runFilters, onlineFilters: runOnlineFilters, targetTable: accessibleReport.table || '', semanticModel });
  result.cacheCoverage = cacheCoverage;
  return result;
}

app.post('/api/reports/:id/run', rateLimitApi, asyncHandler(async (req, res) => {
  const reports = await readReports();
  const report = reports.find((r) => r.id === req.params.id);
  if (!report) throw apiError('Relatorio nao encontrado.', 404);
  const accessibleReport = isOnlineViewerRole(req.authRole) ? applyUserAccessToReport(report, req.authUser) : report;
  if (!accessibleReport) throw apiError('Você não tem permissão para acessar este relatório.', 403);
  const filters = req.body && req.body.filters;
  const runtimeCross = normalizeRuntimeCrossFilters(req.body && req.body.crossFilters, accessibleReport.visuals || []);
  const securityRuntime = runtimeSecurityFiltersForReport(accessibleReport, req.authUser || { role: 'viewer' });
  const runFilters = { ...(filters && typeof filters === 'object' ? filters : {}), ...runtimeCross.values, ...securityRuntime.filters };
  const runOnlineFilters = [...normalizeOnlineFilters(accessibleReport.onlineFilters), ...runtimeCross.filters, ...securityRuntime.onlineFilters];
  const activePageId = String(req.body && req.body.pageId || '');
  const cacheScope = String((req.authUser && (req.authUser.id || req.authUser.username || req.authUser.role)) || 'anonymous');
  const semanticModel = await readSemanticModel();
  Object.defineProperty(accessibleReport, '__biwaFormattingModel', { value: semanticModel, configurable: true });
  const cacheCoverage = await dashboardPostgresCacheCoverage(accessibleReport).catch((err) => ({ kind: 'postgres', enabled: POSTGRES_CACHE_ENABLED, available: false, error: err.message, totalTables: 0, cachedTables: 0, missingTables: 0, tables: [] }));
  const visualResults = [];
  const reusableVisualTotals = new Map();
  const reportLimit = accessibleReport.limit || req.body.limit || 200;
  if (Array.isArray(accessibleReport.visuals) && accessibleReport.visuals.length) {
    const runnableVisuals = accessibleReport.visuals.slice(0, 300).filter((visual) => !activePageId || String(visual && visual.pageId || 'page_1') === activePageId);
    for (const visual of runnableVisuals) {
      const vizType = String(visual && visual.visualization || '').toLowerCase();
      if (vizType === 'textbox' || vizType === 'image') {
        const base = { id: visual.id, title: visual.title, visualization: vizType, table: '', dimension: '', value: '', selectedFields: [], layout: visual.layout, pageId: visual.pageId || 'page_1', style: normalizeVisualStyle(visual.style), rows: [], cached: false, cacheEngine: '', cacheAgeMs: 0, sql: '' };
        if (vizType === 'textbox') base.content = visual.content || '';
        if (vizType === 'image') { base.src = visual.src || ''; base.fit = visual.fit || 'contain'; }
        visualResults.push(base);
        continue;
      }
      if (!shouldRunVisualAsRawTable(visual) && !String(visual && visual.sql || '').trim()) {
        visualResults.push({ id: visual.id, title: visual.title, visualization: visual.visualization, table: visual.table || '', dimension: '', value: '', selectedFields: [], matrixRows: [], matrixColumns: [], matrixValues: [], layout: visual.layout, pageId: visual.pageId || 'page_1', style: normalizeVisualStyle(visual.style), rows: [], cached: false, cacheEngine: '', cacheAgeMs: 0, sql: '' });
        continue;
      }
      const reusedCard = reusableCardVisualResult(visual, accessibleReport, semanticModel, reusableVisualTotals);
      if (reusedCard) {
        visualResults.push(reusedCard);
        continue;
      }
      try {
        const visualQuery = await sqlForVisualRunDetails(visual, reportLimit, semanticModel, {
          filters: runFilters,
          onlineFilters: runOnlineFilters,
          pageFilters: accessibleReport.pageFilters || [],
          allPagesFilters: accessibleReport.allPagesFilters || [],
          pageId: visual.pageId || 'page_1',
          activePageId,
          visualId: visual.id || ''
        });
        const visualSql = visualQuery.sql;
        const vr = await runSelect(visualSql, reportLimit, { filters: runFilters, onlineFilters: runOnlineFilters, targetTable: visualQuery.table || visual.table || accessibleReport.table || '', semanticModel, pageId: visual.pageId || 'page_1', activePageId, visualId: visual.id || '', daxFilterContext: visualQuery.daxFilterContext || null, cacheScope });
        const totalsMetadata = await visualTotalsMetadataForRun(visual, vr.rows || [], reportLimit, semanticModel, {
          filters: runFilters,
          onlineFilters: runOnlineFilters,
          pageFilters: accessibleReport.pageFilters || [],
          allPagesFilters: accessibleReport.allPagesFilters || [],
          pageId: visual.pageId || 'page_1',
          activePageId,
          visualId: visual.id || '',
          cacheScope
        });
        rememberReusableVisualTotals(reusableVisualTotals, visual, totalsMetadata);
        visualResults.push({ id: visual.id, title: visual.title, visualization: visual.visualization, table: visual.table || '', dimension: visual.dimension || '', value: visual.value || '', selectedFields: normalizeVisualQueryFieldObjects(visual.selectedFields), matrixRows: normalizeVisualBucketNames(visual.matrixRows), matrixColumns: normalizeVisualBucketNames(visual.matrixColumns), matrixValues: normalizeVisualBucketNames(visual.matrixValues), layout: visual.layout, pageId: visual.pageId || 'page_1', style: normalizeVisualStyle(visual.style), columnFormats: visualColumnFormatsForRun(visual, accessibleReport), rows: vr.rows || [], ...totalsMetadata, cached: Boolean(vr.cached), cacheEngine: vr.cacheEngine || '', cacheAgeMs: vr.cacheAgeMs || 0, filterWarnings: Array.isArray(vr.filterWarnings) ? vr.filterWarnings : [], sql: visualSql });
      } catch (err) {
        const friendly = isMysqlQueryTimeout(err)
          ? 'A consulta deste visual demorou demais. O app evitou travar; reduza campos/filtros ou use uma coluna indexada.'
          : (err.message || 'Erro no visual');
        visualResults.push({ id: visual.id, title: visual.title, visualization: visual.visualization, table: visual.table || '', dimension: visual.dimension || '', value: visual.value || '', selectedFields: normalizeVisualQueryFieldObjects(visual.selectedFields), matrixRows: normalizeVisualBucketNames(visual.matrixRows), matrixColumns: normalizeVisualBucketNames(visual.matrixColumns), matrixValues: normalizeVisualBucketNames(visual.matrixValues), layout: visual.layout, pageId: visual.pageId || 'page_1', style: normalizeVisualStyle(visual.style), columnFormats: visualColumnFormatsForRun(visual, accessibleReport), rows: [], error: friendly });
      }
    }
    const cacheSummary = {
      postgres: visualResults.filter((v) => String(v.cacheEngine || '').toLowerCase() === 'postgres').length,
      memory: visualResults.filter((v) => v.cached && String(v.cacheEngine || '').toLowerCase() !== 'postgres').length,
      mysql: visualResults.filter((v) => !v.cached).length,
      total: visualResults.length
    };
    const result = { rows: [], fields: [], visualResults, generatedAt: new Date().toISOString(), cached: visualResults.some((v) => v.cached), cacheSummary, cacheCoverage, cacheEngine: cacheSummary.postgres ? 'mixed-postgres' : (cacheSummary.memory ? 'memory' : 'mysql') };
    return res.json({ report: isOnlineViewerRole(req.authRole) ? publicReport(accessibleReport) : report, result, generatedAt: result.generatedAt, cached: Boolean(result.cached), cacheEngine: result.cacheEngine, cacheSummary, cacheCoverage, cacheAgeMs: 0 });
  }
  try {
    const reportSql = await normalizeReportSqlForDashboard(accessibleReport, reportLimit, semanticModel);
    const result = await runSelect(reportSql, reportLimit, { filters: runFilters, onlineFilters: runOnlineFilters, targetTable: accessibleReport.table || '', semanticModel, cacheScope });
    result.cacheCoverage = cacheCoverage;
    res.json({ report: isOnlineViewerRole(req.authRole) ? publicReport(accessibleReport) : report, result, generatedAt: new Date().toISOString(), cached: Boolean(result.cached), cacheEngine: result.cacheEngine || '', cacheCoverage, cacheAgeMs: result.cacheAgeMs || 0 });
  } catch (err) {
    const message = isMysqlQueryTimeout(err)
      ? 'A consulta do relatório demorou demais. O app evitou travar; aplique filtros, diminua o limite ou otimize a view/tabela no MySQL.'
      : (err.message || 'Erro ao executar relatório');
    res.json({ report: isOnlineViewerRole(req.authRole) ? publicReport(accessibleReport) : report, result: { rows: [], fields: [], error: message, generatedAt: new Date().toISOString() }, generatedAt: new Date().toISOString(), cached: false, cacheAgeMs: 0 });
  }
}));


app.get('/api/reports/:id/export.csv', asyncHandler(async (req, res) => {
  const reports = await readReports();
  const report = reports.find((r) => r.id === req.params.id);
  if (!report) throw apiError('Relatorio nao encontrado.', 404);
  const accessibleReport = isOnlineViewerRole(req.authRole) ? applyUserAccessToReport(report, req.authUser) : report;
  if (!accessibleReport) throw apiError('Você não tem permissão para exportar este relatório.', 403);
  if (!canExportReport(accessibleReport, 'csv', req.authUser)) throw apiError('Exportação CSV bloqueada para este relatório.', 403);
  const result = await runReportForExport(accessibleReport, req);
  await appendAuditLog('export_csv', req, { reportId: accessibleReport.id, reportName: accessibleReport.name || '', rows: Array.isArray(result.rows) ? result.rows.length : 0 });
  const csv = rowsToCsv(result.rows || []);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${safeDownloadName(accessibleReport.name)}.csv"`);
  res.send('\ufeff' + csv);
}));

app.get('/api/reports/:id/export.xls', asyncHandler(async (req, res) => {
  const reports = await readReports();
  const report = reports.find((r) => r.id === req.params.id);
  if (!report) throw apiError('Relatorio nao encontrado.', 404);
  const accessibleReport = isOnlineViewerRole(req.authRole) ? applyUserAccessToReport(report, req.authUser) : report;
  if (!accessibleReport) throw apiError('Você não tem permissão para exportar este relatório.', 403);
  if (!canExportReport(accessibleReport, 'xls', req.authUser)) throw apiError('Exportação XLS bloqueada para este relatório.', 403);
  const result = await runReportForExport(accessibleReport, req);
  await appendAuditLog('export_xls', req, { reportId: accessibleReport.id, reportName: accessibleReport.name || '', rows: Array.isArray(result.rows) ? result.rows.length : 0 });
  const html = rowsToExcelHtml(result.rows || [], accessibleReport.name || 'Relatorio');
  res.set('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${safeDownloadName(accessibleReport.name)}.xls"`);
  res.send('\ufeff' + html);
}));

app.get('/api/reports/:id/export.json', asyncHandler(async (req, res) => {
  const reports = await readReports();
  const report = reports.find((r) => r.id === req.params.id);
  if (!report) throw apiError('Relatorio nao encontrado.', 404);
  const accessibleReport = isOnlineViewerRole(req.authRole) ? applyUserAccessToReport(report, req.authUser) : report;
  if (!accessibleReport) throw apiError('Você não tem permissão para exportar este relatório.', 403);
  if (!canExportReport(accessibleReport, 'json', req.authUser)) throw apiError('Exportação JSON bloqueada para este relatório.', 403);
  const result = await runReportForExport(accessibleReport, req);
  await appendAuditLog('export_json', req, { reportId: accessibleReport.id, reportName: accessibleReport.name || '', rows: Array.isArray(result.rows) ? result.rows.length : 0 });
  res.set('Content-Disposition', `attachment; filename="${safeDownloadName(accessibleReport.name)}.json"`);
  res.json({ report: isOnlineViewerRole(req.authRole) ? publicReport(accessibleReport) : report, rows: result.rows || [], fields: result.fields || [], exportedAt: new Date().toISOString() });
}));

app.post('/api/model/calendar/auto', requirePermission('reportEditing', 'Modelagem de relatorios'), asyncHandler(async (req, res) => {
  const model = await readSemanticModel();
  const resources = await getTables();
  const resourceNames = resources.map((item) => item.name).filter((name) => name && name !== CALENDAR_TABLE_NAME);
  const existing = new Set((model.relationships || []).map((r) => `${r.fromTable}.${r.fromColumn}->${r.toTable}.${r.toColumn}`));
  let added = 0;
  for (const table of resourceNames.slice(0, 80)) {
    let cols = [];
    try { cols = await getColumns(table); } catch (err) { cols = []; }
    for (const col of cols) {
      const name = String(col.name || '');
      const type = String(col.dataType || col.columnType || '').toLowerCase();
      const looksDate = type.includes('date') || /(^data$|data_|_data|date|dt_|_dt|emissao|vencimento|movimento|competencia)/i.test(name);
      if (!looksDate) continue;
      const key = `${table}.${name}->${CALENDAR_TABLE_NAME}.Data`;
      if (existing.has(key)) continue;
      model.relationships = model.relationships || [];
      model.relationships.push({
        fromTable: table,
        fromColumn: name,
        toTable: CALENDAR_TABLE_NAME,
        toColumn: 'Data',
        joinType: 'LEFT',
        cardinality: 'many-to-one',
        filterDirection: 'single'
      });
      existing.add(key);
      added += 1;
      break;
    }
  }
  model.tables = model.tables || [];
  if (!model.tables.some((item) => (typeof item === 'string' ? item : item.name) === CALENDAR_TABLE_NAME)) model.tables.unshift({ name: CALENDAR_TABLE_NAME });
  const saved = await writeSemanticModel(model);
  res.json({ ok: true, added, model: saved });
}));


function summarizePublishedReports(reports) {
  return (reports || []).map((report) => {
    const pages = Array.isArray(report.pages) && report.pages.length ? report.pages : [{ id: 'page_1', name: 'Página 1' }];
    const visuals = Array.isArray(report.visuals) && report.visuals.length ? report.visuals : [];
    return {
      id: report.id,
      name: report.name || 'Relatório sem nome',
      visualization: report.visualization || 'table',
      pages: pages.map((page) => ({ id: page.id, name: page.name || page.id })),
      pageCount: pages.length,
      visualCount: visuals.length || 1,
      onlineFilterCount: normalizeOnlineFilters(report.onlineFilters || []).length,
      refreshSeconds: clampLimit(report.refreshSeconds, DEFAULT_REFRESH_SECONDS, 3600),
      updatedAt: report.updatedAt || report.createdAt || ''
    };
  });
}

function summarizeOnlineAccess(reports, users) {
  const reportIds = new Set((reports || []).map((report) => report.id));
  const normalized = normalizeOnlineUsers(users || []);
  let activeUsers = 0;
  let inactiveUsers = 0;
  let permissionCount = 0;
  for (const user of normalized) {
    if (user.active) activeUsers += 1; else inactiveUsers += 1;
    if (user.allReports) {
      permissionCount += reportIds.size;
      continue;
    }
    for (const reportId of Object.keys(user.reportPermissions || {})) {
      if (reportIds.has(reportId)) permissionCount += 1;
    }
  }
  return { totalUsers: normalized.length, activeUsers, inactiveUsers, permissionCount };
}

async function pingOnlineTarget(onlineUrl, syncToken) {
  if (!onlineUrl) throw apiError('Informe a URL da versao online em Configuracao.', 400);
  if (!syncToken) throw apiError('Informe o token de sincronizacao em Configuracao.', 400);
  if (typeof fetch !== 'function') throw apiError('Esta versao do Node.js nao possui fetch. Use Node 20 ou Docker.', 500);
  const response = await fetch(onlineUrl.replace(/\/+$/g, '') + '/api/sync/ping', {
    method: 'GET',
    headers: { 'X-Sync-Token': syncToken }
  });
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch (err) { payload = { raw: text }; }
  if (!response.ok) {
    throw apiError('Falha no teste da versao online: ' + (payload.error || response.statusText || text), response.status || 500);
  }
  return payload;
}

app.get('/api/web/online-env', requireDesktopAdmin, asyncHandler(async (req, res) => {
  const text = buildOnlineEnv(getSettings());
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="rl-mysql-bi-online.env"');
  res.send(text);
}));


app.get('/api/publish/status', requirePermission('publishOnline', 'Publicacao online'), asyncHandler(async (req, res) => {
  const settings = getSettings();
  const reports = await readReports();
  const users = effectiveOnlineUsers(settings);
  const onlineUrl = String(settings.publish.onlineUrl || '').trim().replace(/\/+$/g, '');
  const syncToken = String(settings.publish.syncToken || '').trim();
  const status = {
    ok: true,
    version: APP_VERSION,
    onlineUrl,
    localReportCount: reports.length,
    localReports: summarizePublishedReports(reports),
    access: summarizeOnlineAccess(reports, users),
    publish: sanitizeSettingsForClient(req.authRole).publish,
    checkedAt: new Date().toISOString(),
    online: null
  };
  if (String(req.query.check || '') === '1') {
    const payload = await pingOnlineTarget(onlineUrl, syncToken);
    const next = mergeSettings(defaultSettings(), settings);
    next.publish.lastOnlineCheckAt = status.checkedAt;
    next.publish.lastOnlineMode = payload.mode || '';
    next.publish.lastOnlineReportCount = Number(payload.reportCount || 0);
    next.publish.lastPublishStatus = 'online-ok';
    next.publish.lastPublishMessage = 'Conexão online testada com sucesso.';
    await writeSettings(next);
    settingsCache = next;
    status.publish = sanitizeSettingsForClient(req.authRole).publish;
    status.online = payload;
  }
  res.json(status);
}));

app.post('/api/publish/test', requirePermission('publishOnline', 'Publicacao online'), asyncHandler(async (req, res) => {
  const settings = getSettings();
  const onlineUrl = String(req.body.onlineUrl || settings.publish.onlineUrl || '').trim().replace(/\/+$/g, '');
  const syncToken = String(req.body.syncToken || settings.publish.syncToken || '').trim();
  const payload = await pingOnlineTarget(onlineUrl, syncToken);
  const next = mergeSettings(defaultSettings(), settings);
  next.publish.lastOnlineCheckAt = new Date().toISOString();
  next.publish.lastOnlineMode = payload.mode || '';
  next.publish.lastOnlineReportCount = Number(payload.reportCount || 0);
  next.publish.lastPublishStatus = 'online-ok';
  next.publish.lastPublishMessage = 'Conexão online testada com sucesso.';
  await writeSettings(next);
  settingsCache = next;
  res.json({ ok: true, onlineUrl, response: payload, settings: sanitizeSettingsForClient(req.authRole) });
}));

app.post('/api/publish/access', requirePermission('publishOnline', 'Publicação online'), asyncHandler(async (req, res) => {
  const settings = getSettings();
  const onlineUrl = String(req.body.onlineUrl || settings.publish.onlineUrl || '').trim().replace(/\/+$/g, '');
  const syncToken = String(req.body.syncToken || settings.publish.syncToken || '').trim();
  if (!onlineUrl) throw apiError('Informe a URL da versão online em Configuração.', 400);
  if (!syncToken) throw apiError('Informe o token de sincronização em Configuração.', 400);
  const onlineUsers = effectiveOnlineUsers(settings);
  const publishedAccess = onlineAccessPayload(settings);
  const requestOptions = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sync-Token': syncToken },
    body: JSON.stringify({ onlineAccess: publishedAccess })
  };
  let response = await fetch(onlineUrl + '/api/sync/access', requestOptions);
  if (response.status === 404) {
    const reports = await readReports();
    response = await fetch(onlineUrl + '/api/sync/reports', {
      ...requestOptions,
      body: JSON.stringify({ reports, onlineAccess: publishedAccess })
    });
  }
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch (err) { payload = { raw: text }; }
  if (!response.ok) throw apiError('Falha ao atualizar usuários no portal: ' + (payload.error || response.statusText || text), response.status || 500);
  res.json({ ok: true, onlineUrl, onlineUserCount: onlineUsers.length, response: payload, updatedAt: new Date().toISOString() });
}));

app.post('/api/publish/reports', requirePermission('publishOnline', 'Publicacao online'), asyncHandler(async (req, res) => {
  const settings = getSettings();
  const onlineUrl = String(req.body.onlineUrl || settings.publish.onlineUrl || '').trim().replace(/\/+$/g, '');
  const syncToken = String(req.body.syncToken || settings.publish.syncToken || '').trim();
  if (!onlineUrl) throw apiError('Informe a URL da versao online em Configuracao.', 400);
  if (!syncToken) throw apiError('Informe o token de sincronizacao em Configuracao.', 400);
  if (typeof fetch !== 'function') throw apiError('Esta versao do Node.js nao possui fetch. Use Node 20 ou Docker.', 500);

  const [reports, importedTables, semanticModel, transformQueries, manualTables] = await Promise.all([
    readReports(),
    readImportedTables(),
    readSemanticModel(),
    readTransforms(),
    readManualTableSnapshots()
  ]);
  const publishedAccess = onlineAccessPayload(settings);
  const manualResponse = await fetch(onlineUrl + '/api/sync/manual-tables', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sync-Token': syncToken
    },
    body: JSON.stringify({ tables: manualTables })
  });
  const manualText = await manualResponse.text();
  let manualPayload = null;
  try { manualPayload = JSON.parse(manualText); } catch (err) { manualPayload = { raw: manualText }; }
  if (!manualResponse.ok) {
    const upgradeHint = manualResponse.status === 404 ? ' Atualize o codigo do servidor online antes de publicar novamente.' : '';
    throw apiError('Falha ao publicar tabelas manuais: ' + (manualPayload.error || manualResponse.statusText || manualText) + upgradeHint, manualResponse.status || 500);
  }
  const response = await fetch(onlineUrl + '/api/sync/reports', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sync-Token': syncToken
    },
    body: JSON.stringify({
      reports,
      onlineCustomization: settings.onlineCustomization || null,
      onlineAccess: publishedAccess,
      importedTables,
      semanticModel,
      transformQueries,
      pgCache: {
        syncIntervalMinutes: Number(settings.pgCache && settings.pgCache.syncIntervalMinutes) || 5,
        recentWindowDays: Number(settings.pgCache && settings.pgCache.recentWindowDays) || 90
      }
    })
  });
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch (err) { payload = { raw: text }; }
  if (!response.ok) {
    throw apiError('Falha ao publicar online: ' + (payload.error || response.statusText || text), response.status || 500);
  }
  const publishedAt = new Date().toISOString();
  const next = mergeSettings(defaultSettings(), settings);
  next.publish.lastPublishedAt = publishedAt;
  next.publish.lastPublishedCount = Number(payload.count ?? reports.length);
  next.publish.lastPublishedUrl = onlineUrl;
  next.publish.lastPublishedVersion = APP_VERSION;
  next.publish.lastPublishStatus = 'published';
  next.publish.lastPublishMessage = `Publicados ${next.publish.lastPublishedCount} relatorio(s) com sucesso.`;
  next.publish.lastOnlineCheckAt = payload.updatedAt || publishedAt;
  next.publish.lastOnlineMode = payload.mode || 'online';
  next.publish.lastOnlineReportCount = Number(payload.count ?? reports.length);
  await writeSettings(next);
  settingsCache = next;
  res.json({
    ok: true,
    onlineUrl,
    count: payload.count ?? reports.length,
    manualTableCount: Number(manualPayload && manualPayload.count || manualTables.length),
    publishedAt,
    response: payload,
    manualResponse: manualPayload,
    settings: sanitizeSettingsForClient(req.authRole)
  });
}));

const socketTimers = new Map();

io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token ? 'Bearer ' + socket.handshake.auth.token : (socket.handshake.headers.authorization || '');
  let result = null;
  if (token.startsWith('Bearer ')) {
    const payload = readAuthToken(token.slice(7));
    if (!payload) {
      result = { ok: false };
    } else if (payload.role === 'admin') {
      const settings = getSettings();
      result = settings.access.adminUser && safeEqual(payload.sub, settings.access.adminUser)
        ? { ok: true, role: 'admin', user: { username: payload.sub, name: settings.access.adminName || payload.name || 'Administrador', role: 'admin', allReports: true, reportPermissions: {} } }
        : { ok: false };
    } else {
      const user = effectiveOnlineUsers().find((item) => item.active && safeEqual(item.username, payload.sub));
      result = user ? { ok: true, role: 'viewer', user } : { ok: false };
    }
  } else {
    result = validateBasicAuthHeader(token);
  }
  if (result.ok) {
    socket.authRole = result.role;
    socket.authUser = result.user || { role: result.role, username: result.role };
    return next();
  }
  return next(new Error('Authentication required'));
});

function stopSocketDashboard(socketId) {
  const state = socketTimers.get(socketId);
  if (!state) return;
  for (const timer of state.timers || []) clearInterval(timer);
  socketTimers.delete(socketId);
}

function socketDashboardSubscriptionIsCurrent(socket, subscriptionId) {
  return Boolean(socket && socket.connected)
    && (!subscriptionId || socket.dashboardSubscriptionId === subscriptionId);
}

async function runReportsForSocket(socket, reportIds, filtersByReport = {}, pagesByReport = {}, forced = false, subscriptionId = '') {
  if (!socketDashboardSubscriptionIsCurrent(socket, subscriptionId)) return;
  const realtimeMarker = await readRealtimeEventMarker();
  if (!socketDashboardSubscriptionIsCurrent(socket, subscriptionId)) return;
  const reports = await readReports();
  const allowed = isOnlineViewerRole(socket.authRole) ? reportsForAuthUser(reports, socket.authUser) : reports;
  const selected = allowed.filter((r) => reportIds.includes(r.id));
  const semanticModel = await readSemanticModel();
  const sourceHealth = await probeDataSourceHealth({ force: false, broadcast: false });
  const mysqlAvailable = Boolean(sourceHealth.mysqlAvailable);
  const globalLastSyncAt = sourceHealth.lastPgSyncAt || null;
  // Obtem a ultima sincronizacao bem-sucedida do cache PostgreSQL para as tabelas dos relatorios
  let lastPgSyncAt = null;
  if (postgresCacheAvailable()) {
    try {
      const tableRegex = /FROM\s+`((?:``|[^`])+)`\s+(?:AS\s+)?src\b/gi;
      const reportTables = [...new Set(selected.flatMap((r) => {
        const tables = [];
        const sql = String(r.sql || '');
        let match;
        while ((match = tableRegex.exec(sql)) !== null) {
          tables.push(match[1].replace(/``/g, '`'));
        }
        // Tambem extrai de visuals[].table
        if (Array.isArray(r.visuals)) {
          r.visuals.forEach((v) => { if (v.table) tables.push(String(v.table).trim()); });
        }
        return tables;
      }).filter(Boolean))];
      if (reportTables.length) {
        const placeholders = reportTables.map((_, i) => `LOWER($${i + 1})`).join(', ');
        const pgSyncResult = await pgCacheQuery(
          `SELECT MAX(last_data_update_at) AS last_sync FROM ${quotePgQualified(POSTGRES_CACHE_SCHEMA, '__biwa_cache_meta')} WHERE row_count > 0 AND LOWER(source_table) <> LOWER($${reportTables.length + 1}) AND LOWER(source_table) IN (${placeholders})`,
          reportTables.map((t) => t.toLowerCase()).concat(CALENDAR_TABLE_NAME)
        );
        lastPgSyncAt = pgSyncResult.rows[0] && pgSyncResult.rows[0].last_sync ? new Date(pgSyncResult.rows[0].last_sync).toISOString() : null;
      }
      // Fallback para a ultima sincronizacao global (qualquer tabela)
      if (!lastPgSyncAt) lastPgSyncAt = globalLastSyncAt;
    } catch (err) { /* ignora */ }
  }
  // Fallback para a ultima sincronizacao global (caso nao tenha relatorios com tabelas)
  if (!lastPgSyncAt) lastPgSyncAt = globalLastSyncAt;
  const items = [];
  for (const report of selected) {
    // Trocar de relatório/aba invalida a assinatura anterior. A consulta que já
    // entrou no banco pode terminar, mas não iniciamos os demais relatórios da
    // assinatura obsoleta nem publicamos seus resultados.
    if (!socketDashboardSubscriptionIsCurrent(socket, subscriptionId)) return;
    const accessibleReport = isOnlineViewerRole(socket.authRole) ? applyUserAccessToReport(report, socket.authUser) : report;
    if (!accessibleReport) {
      items.push({ reportId: report.id, ok: false, error: 'Sem permissao para acessar este relatorio.', forced });
      continue;
    }
    try {
      const result = await executeReportVisualRun(accessibleReport, {
        filters: filtersByReport[accessibleReport.id] || filtersByReport[report.id] || {},
        pageId: pagesByReport[accessibleReport.id] || pagesByReport[report.id] || '',
        semanticModel,
        authUser: socket.authUser || { role: 'viewer' }
      });
      if (!socketDashboardSubscriptionIsCurrent(socket, subscriptionId)) return;
      items.push({
        reportId: accessibleReport.id,
        ok: true,
        result,
        cached: Boolean(result.cached),
        forced,
        lastPgSyncAt: normalizeHealthTimestamp(result.cacheCoverage && result.cacheCoverage.lastSyncAt)
      });
    } catch (err) {
      items.push({ reportId: accessibleReport.id || report.id, ok: false, error: err.message, forced });
    }
  }
  if (!socketDashboardSubscriptionIsCurrent(socket, subscriptionId)) return;
  if (items.length) socket.emit('dashboard:update', {
    generatedAt: new Date().toISOString(),
    subscriptionId,
    realtimeMarker,
    realtimeMode: REALTIME_EVENT_TABLE ? 'mysql_event_marker' : 'interval_polling',
    mysqlAvailable,
    lastPgSyncAt,
    items
  });
}

io.on('connection', (socket) => {
  probeDataSourceHealth({ force: false, broadcast: false })
    .then((payload) => socket.emit('dashboard:connectionStatus', payload))
    .catch(() => {});
  socket.on('unsubscribeDashboard', () => {
    socket.dashboardSubscriptionId = '';
    stopSocketDashboard(socket.id);
  });

  socket.on('subscribeDashboard', async (payload = {}) => {
    stopSocketDashboard(socket.id);

    const requested = Array.isArray(payload.reports) ? payload.reports : [];
    const reportIds = requested.length
      ? requested.map((item) => String(item.id || item.reportId || '')).filter(Boolean).slice(0, 50)
      : (Array.isArray(payload.reportIds) ? payload.reportIds.map(String).slice(0, 50) : []);
    const filtersByReport = payload.filtersByReport && typeof payload.filtersByReport === 'object' ? payload.filtersByReport : {};
    const pagesByReport = payload.pagesByReport && typeof payload.pagesByReport === 'object' ? payload.pagesByReport : {};
    const subscriptionId = String(payload.subscriptionId || '').slice(0, 120);
    const skipInitialRun = payload.skipInitialRun === true;

    if (!reportIds.length) return;
    socket.dashboardSubscriptionId = subscriptionId;
    if (!skipInitialRun) {
      await runReportsForSocket(socket, reportIds, filtersByReport, pagesByReport, true, subscriptionId);
    }
    if (subscriptionId && socket.dashboardSubscriptionId !== subscriptionId) return;

    const reports = await readReports();
    const allowed = isOnlineViewerRole(socket.authRole) ? reportsForAuthUser(reports, socket.authUser) : reports;
  const selected = allowed.filter((r) => reportIds.includes(r.id));
    const timers = [];
    const subscriptionState = {
      timers,
      reportIds,
      filtersByReport,
      pagesByReport,
      subscriptionId,
      inFlightReports: new Set(),
      startedAt: Date.now()
    };
    socketTimers.set(socket.id, subscriptionState);
    for (const report of selected) {
      const clientDef = requested.find((item) => String(item.id || item.reportId || '') === report.id) || {};
      const secondsRaw = Number(clientDef.refreshSeconds || report.refreshSeconds || SERVER_PUSH_INTERVAL_SECONDS || DEFAULT_REFRESH_SECONDS);
      const intervalSeconds = Math.max(5, Math.min(secondsRaw || SERVER_PUSH_INTERVAL_SECONDS, 3600));
      const timer = setInterval(() => {
        const activeState = socketTimers.get(socket.id);
        if (!activeState || activeState !== subscriptionState || activeState.inFlightReports.has(report.id)) return;
        activeState.inFlightReports.add(report.id);
        runReportsForSocket(socket, [report.id], filtersByReport, pagesByReport, false, subscriptionId)
          .catch((err) => { socket.emit('dashboard:error', { error: err.message }); })
          .finally(() => activeState.inFlightReports.delete(report.id));
      }, intervalSeconds * 1000);
      timers.push(timer);
    }
  });

  socket.on('disconnect', () => stopSocketDashboard(socket.id));
});

app.get('*', asyncHandler(sendApplicationShell));

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) {
    const path = req && req.path ? req.path : '/';
    const stack = err && err.stack ? err.stack : err;
    console.error('[500]', path, err.message || err);
    logger.error('HTTP_500', path, err.message || '', stack);
  }
  res.status(status).json({ error: err.message || 'Erro inesperado' });
});


process.on('uncaughtException', (err) => {
  const stack = err && err.stack ? err.stack : err;
  console.error('[BI WA] uncaughtException:', stack);
  logger.error('UNCAUGHT_EXCEPTION:', stack);
});

// Periodic PG cache sync (intervalo dinamico via settings)
let pgCacheSyncTimer = null;

async function runPgCacheScheduledSync(trigger) {
  if (!pgCacheSyncOwnedByCurrentProcess()) {
    pgCacheSchedulerState.lastSkippedReason = 'sync-owner-is-' + POSTGRES_CACHE_SYNC_OWNER;
    return { skipped: true, reason: pgCacheSchedulerState.lastSkippedReason, total: 0, succeeded: 0, failed: 0, changedRows: 0 };
  }
  if (!postgresCacheAvailable()) {
    pgCacheSchedulerState.lastSkippedReason = 'postgres-unavailable';
    return { skipped: true, reason: 'postgres-unavailable', total: 0, succeeded: 0, failed: 0, changedRows: 0 };
  }
  var leaseClient = null;
  var leaseAcquired = false;
  try {
    leaseClient = await getPgCachePool().connect();
    var leaseResult = await leaseClient.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', ['biwa-pg-cache-scheduler']);
    leaseAcquired = Boolean(leaseResult.rows && leaseResult.rows[0] && leaseResult.rows[0].acquired);
    if (!leaseAcquired) {
      pgCacheSchedulerState.lastSkippedReason = 'another-server-cycle-running';
      console.log('[PG Cache] Outro servidor ja esta sincronizando; ciclo atual ignorado.');
      return { skipped: true, reason: pgCacheSchedulerState.lastSkippedReason, total: 0, succeeded: 0, failed: 0, changedRows: 0 };
    }
    return await autoSyncAllTablesToPgCache(trigger || 'automatic');
  } finally {
    if (leaseClient) {
      if (leaseAcquired) {
        try { await leaseClient.query('SELECT pg_advisory_unlock(hashtext($1))', ['biwa-pg-cache-scheduler']); } catch (err) {}
      }
      leaseClient.release();
    }
  }
}

function startPgCachePeriodicSync() {
  if (pgCacheSyncTimer) clearInterval(pgCacheSyncTimer);
  pgCacheSyncTimer = null;
  pgCacheSchedulerState.enabled = false;
  if (!postgresCacheAvailable()) {
    pgCacheSchedulerState.lastSkippedReason = 'postgres-unavailable';
    return;
  }
  if (!pgCacheSyncOwnedByCurrentProcess()) {
    pgCacheSchedulerState.lastSkippedReason = 'sync-owner-is-' + POSTGRES_CACHE_SYNC_OWNER;
    console.log('[PG Cache] Agendador desativado neste processo; responsavel configurado: ' + POSTGRES_CACHE_SYNC_OWNER + '.');
    return;
  }
  const settings = getSettings();
  const intervalMinutes = Number(settings.pgCache && settings.pgCache.syncIntervalMinutes) || 5;
  const intervalMs = Math.max(30000, Math.min(86400000, intervalMinutes * 60000));
  pgCacheSchedulerState.enabled = true;
  pgCacheSchedulerState.intervalMinutes = intervalMs / 60000;
  pgCacheSchedulerState.lastSkippedReason = '';
  console.log('[PG Cache] Sincronizacao periodica a cada ' + (intervalMs / 60000) + ' minuto(s).');
  pgCacheSyncTimer = setInterval(() => {
    runPgCacheScheduledSync('periodic')
      .then((result) => {
        if (!result || result.skipped) return;
        if (result.failed) console.error('[PG Cache] Sincronizacao periodica terminou com falha em ' + result.failed + ' tabela(s).');
        else console.log('[PG Cache] Sincronizacao periodica concluida: ' + result.succeeded + ' tabela(s), ' + result.changedRows + ' linha(s) alterada(s).');
      })
      .catch((err) => console.error('[PG Cache] Erro na sincronizacao periodica:', err.message));
  }, intervalMs);
}

// ---------- Deploy VPS ----------
function getVpsConfig() {
  const s = getSettings();
  const vps = s.vps || {};
  if (!vps.host) throw new Error('Host SSH nao configurado.');
  if (!vps.keyPath) throw new Error('Caminho da chave SSH nao configurado.');
  return { ...vps, port: Number(vps.port) || 22 };
}

function sshConnect(vps) {
  return new Promise((resolve, reject) => {
    const conn = new SshClient();
    conn.on('ready', () => resolve(conn));
    conn.on('error', reject);
    conn.connect({
      host: vps.host,
      port: vps.port || 22,
      username: vps.user || 'root',
      privateKey: fsSync.readFileSync(vps.keyPath, 'utf8')
    });
  });
}

function sshExec(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let stdout = '', stderr = '';
      stream.on('close', (code) => {
        if (code !== 0) reject(new Error(stderr.trim() || `Exit code ${code}: ${stdout.trim().slice(0,200)}`));
        else resolve(stdout.trim());
      });
      stream.on('data', (data) => { stdout += data.toString(); });
      stream.stderr.on('data', (data) => { stderr += data.toString(); });
    });
  });
}

function sshWriteFile(conn, remotePath, content) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const ws = sftp.createWriteStream(remotePath);
      ws.on('close', () => { sftp.end(); resolve(); });
      ws.on('error', reject);
      ws.end(content);
    });
  });
}

app.post('/api/deploy/test', requireDesktopAdmin, asyncHandler(async (req, res) => {
  const vps = getVpsConfig();
  let conn;
  try {
    conn = await sshConnect(vps);
    const hostname = await sshExec(conn, 'hostname');
    conn.end();
    res.json({ ok: true, hostname, message: `Conectado a ${vps.host} (${hostname})` });
  } catch (err) {
    if (conn) try { conn.end(); } catch (_) {}
    throw apiError('Falha na conexao SSH: ' + err.message, 400);
  }
}));

app.post('/api/deploy/run', requireDesktopAdmin, asyncHandler(async (req, res) => {
  const vps = getVpsConfig();
  const settings = getSettings();
  const domain = vps.domain || (settings.publish && settings.publish.onlineUrl ? new URL(settings.publish.onlineUrl).hostname : '');
  if (!domain) throw apiError('Defina o dominio (VPS > Dominio) ou a URL publica (Online > URL publica).', 400);

  // Gera arquivos para deploy
  const access = settings.access || {};
  const publish = settings.publish || {};
  const web = settings.web || {};
  const deployOnlineUsers = effectiveOnlineUsers(settings).filter((user) => user.active && user.username && user.password);
  if (!deployOnlineUsers.length) throw apiError('Cadastre ao menos um usuario online ativo com senha em Configuracao (guia Online > Usuarios).', 400);
  if (!publish.syncToken) throw apiError('Informe ou gere o token de sincronizacao em Configuracao (guia Online).', 400);
  const envContent = buildOnlineEnv(settings);
  const dcContent = `version: '3.8'
services:
  biwa-online:
    image: node:22-slim
    container_name: biwa-online
    restart: unless-stopped
    working_dir: /app
    ports:
      - "127.0.0.1:3000:3000"
    environment:
      - NODE_ENV=production
    env_file: .env
    volumes:
      - ./app:/app
      - /app/node_modules
    command: sh -c "npm install --omit=dev && node server.js"`;

  const nginxContent = `server {
    listen 80;
    server_name ${domain};

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400;
    }
}`;

  res.json({ ok: true, message: 'Deploy iniciado. Acompanhe pelo console do servidor.' });

  // Executa deploy em background
  deployToVps(vps, domain, envContent, dcContent, nginxContent).catch((err) => {
    console.error('[Deploy] Erro:', err.message);
  });
}));

async function deployToVps(vps, domain, envContent, dcContent, nginxContent) {
  const log = (msg) => console.log('[Deploy] ' + msg);
  let conn;
  try {
    conn = await sshConnect(vps);
    const appPath = vps.appPath || '/opt/biwa';
    const appCodePath = appPath + '/app';

    log('Criando diretorios...');
    await sshExec(conn, `mkdir -p ${appCodePath}/data ${appCodePath}/public ${appCodePath}/lib`);

    log('Enviando .env...');
    await sshWriteFile(conn, appPath + '/.env', envContent);

    log('Enviando docker-compose.yml...');
    await sshWriteFile(conn, appPath + '/docker-compose.yml', dcContent);

    log('Enviando config Nginx...');
    await sshWriteFile(conn, '/etc/nginx/sites-available/biwa', nginxContent);

    // Detecta SO
    log('Detectando sistema...');
    let isUbuntu = true;
    try {
      const osRelease = await sshExec(conn, 'cat /etc/os-release 2>/dev/null || cat /etc/redhat-release 2>/dev/null || echo unknown');
      isUbuntu = osRelease.includes('Ubuntu') || osRelease.includes('Debian');
    } catch (_) {}

    // Instala Docker se necessario
    log('Verificando Docker...');
    try {
      await sshExec(conn, 'docker --version');
      log('Docker ja instalado.');
    } catch (_) {
      log('Instalando Docker...');
      if (isUbuntu) {
        await sshExec(conn, 'apt update && apt install -y docker.io docker-compose-v2');
      } else {
        await sshExec(conn, 'yum install -y docker docker-compose || dnf install -y docker docker-compose');
      }
      await sshExec(conn, 'systemctl enable --now docker');
    }

    // Instala Nginx se necessario
    log('Verificando Nginx...');
    try {
      await sshExec(conn, 'nginx -v 2>&1');
      log('Nginx ja instalado.');
    } catch (_) {
      log('Instalando Nginx...');
      if (isUbuntu) {
        await sshExec(conn, 'apt install -y nginx');
      } else {
        await sshExec(conn, 'yum install -y nginx || dnf install -y nginx');
      }
    }

    // Ativa config Nginx
    log('Configurando Nginx...');
    try {
      await sshExec(conn, `ln -sf /etc/nginx/sites-available/biwa /etc/nginx/sites-enabled/ 2>/dev/null; nginx -t && systemctl reload nginx`);
    } catch (_) {
      await sshExec(conn, `ln -sf /etc/nginx/sites-available/biwa /etc/nginx/sites-enabled/ 2>/dev/null; nginx -t && nginx -s reload`);
    }

    // Copia codigo do app (server.js)
    log('Enviando codigo do app...');
    const serverCode = await fs.readFile(__filename, 'utf8');
    await sshWriteFile(conn, appCodePath + '/server.js', serverCode);

    // Copia package.json
    const pkgJson = await fs.readFile(path.join(__dirname, 'package.json'), 'utf8');
    await sshWriteFile(conn, appCodePath + '/package.json', pkgJson);

    // Copia data/
    for (const file of ['settings.json', 'reports.json', 'semantic_model.json', 'transform_queries.json', 'imported_tables.json', 'manual_tables.json', 'column_formats.json', 'hidden_tables.json']) {
      try {
        const content = await fs.readFile(path.join(DATA_DIR, file), 'utf8');
        await sshWriteFile(conn, `${appCodePath}/data/${file}`, content);
      } catch (_) { /* arquivo opcional */ }
    }

    // Copia lib/
    try {
      const loggerCode = await fs.readFile(path.join(__dirname, 'lib', 'logger.js'), 'utf8');
      await sshWriteFile(conn, appCodePath + '/lib/logger.js', loggerCode);
    } catch (_) {}

    // Cria public/ vazio (o server.js serve os arquivos estaticos do proprio diretorio)
    await sshWriteFile(conn, appCodePath + '/public/.gitkeep', '');

    // Sobe container Docker
    log('Iniciando container Docker...');
    await sshExec(conn, `cd ${appPath} && docker compose up -d`);

    // SSL com Certbot
    log("Configurando SSL (Let's Encrypt)...");
    try {
      await sshExec(conn, `apt install -y certbot python3-certbot-nginx 2>/dev/null || yum install -y certbot python3-certbot-nginx 2>/dev/null || dnf install -y certbot python3-certbot-nginx 2>/dev/null`);
    } catch (_) {}
    try {
      await sshExec(conn, `certbot --nginx -d ${domain} --non-interactive --agree-tos --email admin@${domain} || true`);
      log('SSL configurado com sucesso.');
    } catch (err) {
      log('Aviso SSL: ' + err.message + ' (execute manualmente: certbot --nginx -d ' + domain + ')');
    }

    // Atualiza settings com a URL
    log('Atualizando URL publica...');
    const s = getSettings();
    s.publish.onlineUrl = 'https://' + domain;
    await writeSettings(s);

    conn.end();
    log(`Deploy concluido! Acesse https://${domain}/api/public-config`);
  } catch (err) {
    log('FALHA: ' + err.message);
    if (conn) try { conn.end(); } catch (_) {}
  }
}

process.on('unhandledRejection', (reason) => {
  const stack = reason && reason.stack ? reason.stack : reason;
  console.error('[BI WA] unhandledRejection:', stack);
  logger.error('UNHANDLED_REJECTION:', stack);
});

ensureStore()
  .then(() => {
    if (APP_MODE === 'online' && !ONLINE_ALLOW_OPEN_ACCESS) {
      const settings = getSettings();
      const hasAnyCredential = Boolean((settings.access && settings.access.viewerUser && settings.access.viewerPassword) || (settings.access && settings.access.adminUser && settings.access.adminPassword));
      if (!hasAnyCredential) {
        console.warn('[BI WA] Modo online exige VIEWER_USER/VIEWER_PASSWORD ou APP_USER/APP_PASSWORD. Defina BIWA_ALLOW_OPEN_ONLINE=true apenas se a visualizacao publica for intencional.');
      }
    }
    server.listen(PORT, () => {
      console.log(`BI WA ${APP_MODE} running on port ${PORT}`);
      startDataSourceHealthMonitor();
      // Auto-import unimported PG cache tables + auto-sync + periodic sync
      if (POSTGRES_CACHE_ENABLED) {
        cleanupAllPgCacheStageTables()
          .then((count) => { if (count) console.log('[PG Cache] Stagings orfaos removidos na inicializacao: ' + count); })
          .catch((err) => console.error('[PG Cache] Erro ao limpar stagings orfaos:', err.message));
        ensurePgCacheAnalyticsIndexes()
          .then((count) => console.log('[PG Cache] Indices analiticos verificados: ' + count))
          .catch((err) => console.error('[PG Cache] Erro ao verificar indices analiticos:', err.message));
        autoImportUnimportedTables()
          .then(() => console.log('[PG Cache] Auto-import de tabelas concluido.'))
          .catch((err) => console.error('[PG Cache] Erro no auto-import:', err.message));
        cleanupManualTablesFromImported()
          .then(() => console.log('[PG Cache] Limpeza de tabelas manuais do imported concluida.'))
          .catch((err) => console.error('[PG Cache] Erro na limpeza manual/imported:', err.message));
        const startupSyncEnabled = String(process.env.BIWA_PG_CACHE_STARTUP_SYNC || 'false').toLowerCase() === 'true' && pgCacheSyncOwnedByCurrentProcess();
        if (startupSyncEnabled) {
          runPgCacheScheduledSync('startup')
            .then((result) => {
              if (result && result.failed) console.error('[PG Cache] Sincronizacao inicial terminou com falha em ' + result.failed + ' tabela(s).');
              else if (!result || !result.skipped) console.log('[PG Cache] Sincronizacao inicial concluida.');
            })
            .catch((err) => console.error('[PG Cache] Erro na sincronizacao inicial:', err.message));
        } else {
          console.log('[PG Cache] Sincronizacao inicial automatica desativada neste processo.');
        }
        startPgCachePeriodicSync();
      }
    });
  })
  .catch((err) => {
    console.error('Failed to start app:', err);
    process.exit(1);
  });
