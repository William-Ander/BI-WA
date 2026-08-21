(function biwaFormattingModule(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BiwaFormatting = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createBiwaFormatting() {
  function clampDecimals(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.min(10, Math.round(parsed))) : fallback;
  }

  function normalizeType(value, prefix, suffix) {
    const type = String(value || '').trim().toLowerCase();
    if (['currency', 'moeda'].includes(type) || /^\s*r\$\s*$/i.test(String(prefix || ''))) return 'currency';
    if (['percentage', 'percent', 'porcentagem'].includes(type) || String(suffix || '').trim() === '%') return 'percentage';
    if (['integer', 'inteiro', 'numero', 'número'].includes(type)) return 'integer';
    return 'decimal';
  }

  function formatNumber(value, options) {
    const opts = options && typeof options === 'object' ? options : {};
    if (value === null || value === undefined || value === '') return '';
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number)) return '';
    const locale = String(opts.locale || 'pt-BR');
    const prefix = String(opts.prefix || '');
    const suffix = String(opts.suffix || '');
    const type = normalizeType(opts.type, prefix, suffix);
    const fallbackDecimals = type === 'integer' ? 0 : 2;
    const decimals = clampDecimals(opts.decimalPlaces != null ? opts.decimalPlaces : opts.decimals, fallbackDecimals);
    const scaled = type === 'percentage' && opts.percentIsWhole !== true ? number * 100 : number;
    const absolute = Math.abs(scaled);
    const formatted = new Intl.NumberFormat(locale, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      useGrouping: opts.useGrouping !== false
    }).format(absolute);
    const negative = scaled < 0 ? '-' : '';
    const effectivePrefix = type === 'currency' && !prefix ? 'R$ ' : prefix;
    const effectiveSuffix = type === 'percentage' && !suffix ? '%' : suffix;
    return negative + effectivePrefix + formatted + effectiveSuffix;
  }

  return { clampDecimals, normalizeType, formatNumber };
});
