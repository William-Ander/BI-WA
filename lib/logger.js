const fs = require('fs');
const path = require('path');
const util = require('util');

const LOGS_DIR = path.join(__dirname, '..', 'logs');
const APP_LOG = path.join(LOGS_DIR, 'app.log');
const ERROR_LOG = path.join(LOGS_DIR, 'error.log');
const LAST_ERROR_LOG = path.join(LOGS_DIR, 'last-error.log');
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB antes de rotacionar
const MAX_LOG_FILES = 3;

function ensureLogsDir() {
  try {
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
  } catch (err) {
    console.error('Nao foi possivel criar diretorio de logs:', err.message);
  }
}

function rotateIfNeeded(filepath) {
  try {
    if (fs.existsSync(filepath) && fs.statSync(filepath).size > MAX_LOG_SIZE) {
      for (let i = MAX_LOG_FILES - 1; i > 0; i--) {
        const older = filepath + '.' + i;
        const newer = filepath + '.' + (i + 1);
        if (fs.existsSync(older)) fs.renameSync(older, newer);
      }
      fs.renameSync(filepath, filepath + '.1');
    }
  } catch (err) {
    // Silencia erros de rotacao
  }
}

function appendToFile(filepath, text) {
  try {
    ensureLogsDir();
    rotateIfNeeded(filepath);
    fs.appendFileSync(filepath, text, 'utf8');
  } catch (err) {
    // Ultimo recurso: fallback silencioso
  }
}

function overwriteFile(filepath, text) {
  try {
    ensureLogsDir();
    fs.writeFileSync(filepath, text, 'utf8');
  } catch (err) {
    // Fallback silencioso
  }
}

function timestamp() {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

function formatMessage(level, args) {
  const message = args.map((a) => (typeof a === 'string' ? a : util.inspect(a, { depth: 3, colors: false }))).join(' ');
  return `[${timestamp()}] [${level}] ${message}\n`;
}

function getRecentLines(filepath, maxLines = 50) {
  try {
    ensureLogsDir();
    if (!fs.existsSync(filepath)) return [];
    const content = fs.readFileSync(filepath, 'utf8');
    const lines = content.trim().split('\n');
    return lines.slice(-maxLines);
  } catch (err) {
    return [];
  }
}

function log(level, args) {
  const text = formatMessage(level, args);
  if (level === 'ERROR') {
    appendToFile(ERROR_LOG, text);
    overwriteFile(LAST_ERROR_LOG, text);
  }
  appendToFile(APP_LOG, text);
}

const logger = {
  info(...args) { log('INFO', args); },
  warn(...args) { log('WARN', args); },
  error(...args) { log('ERROR', args); },
  log(...args) { log('LOG', args); },

  getRecent(maxLines = 50) {
    return getRecentLines(APP_LOG, maxLines);
  },

  getRecentErrors(maxLines = 50) {
    return getRecentLines(ERROR_LOG, maxLines);
  },

  getLastError() {
    try {
      ensureLogsDir();
      if (!fs.existsSync(LAST_ERROR_LOG)) return null;
      return fs.readFileSync(LAST_ERROR_LOG, 'utf8').trim() || null;
    } catch (err) {
      return null;
    }
  },

  clearLastError() {
    try {
      overwriteFile(LAST_ERROR_LOG, '');
    } catch (err) { /* silencio */ }
  }
};

module.exports = logger;
