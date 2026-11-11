// Typed cell values for Lists. One validator per column type. Each takes the raw value from a
// request and returns the normalized value to store (JSON), or null to clear the cell. Anything
// malformed throws an error that carries an HTTP status, so a bad value can never be stored.
const crypto = require('crypto');

const COLUMN_TYPES = ['text', 'checkbox', 'date', 'user', 'select', 'number', 'link'];
const SELECT_COLORS = ['indigo', 'blue', 'cyan', 'pink', 'yellow', 'green', 'gray', 'red', 'purple', 'orange', 'brown'];

const MAX_TEXT = 2000;
const MAX_PRIMARY_TEXT = 200;
const MAX_LINK = 2000;
const MAX_CHOICES = 100;
const MAX_SELECTED = 50;
const MAX_COLUMN_NAME = 80;
const MAX_CHOICE_LABEL = 40;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const isEmpty = (value) => value === null || value === undefined || value === '';

function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

function normalizeColumnOptions(type, raw) {
  const options = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (type === 'select') {
    const input = Array.isArray(options.choices) ? options.choices : [];
    if (input.length > MAX_CHOICES) throw httpError(400, `A select column can have at most ${MAX_CHOICES} choices`);
    const seen = new Set();
    const choices = input.map((choice) => {
      const label = typeof choice?.label === 'string' ? choice.label.trim() : '';
      if (!label || label.length > MAX_CHOICE_LABEL) throw httpError(400, `Choice labels must be 1 to ${MAX_CHOICE_LABEL} characters`);
      const color = choice.color === undefined ? 'gray' : choice.color;
      if (!SELECT_COLORS.includes(color)) throw httpError(400, `Choice color must be one of: ${SELECT_COLORS.join(', ')}`);
      // Ids are stable: a rename keeps the id, so stored cells never break.
      let id = typeof choice.id === 'string' && /^[a-z0-9_]{3,24}$/.test(choice.id) ? choice.id : `c_${crypto.randomBytes(4).toString('hex')}`;
      if (seen.has(id)) id = `c_${crypto.randomBytes(4).toString('hex')}`;
      seen.add(id);
      return { id, label, color };
    });
    return { multiple: options.multiple === true, choices };
  }
  if (type === 'user') return { multiple: options.multiple === true };
  if (type === 'number') {
    if (options.precision === undefined || options.precision === null) return {};
    const precision = Number(options.precision);
    if (!Number.isInteger(precision) || precision < 0 || precision > 10) throw httpError(400, 'Number precision must be a whole number from 0 to 10');
    return { precision };
  }
  return {};
}

function validateColumnName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > MAX_COLUMN_NAME) throw httpError(400, `Column names must be 1 to ${MAX_COLUMN_NAME} characters`);
  return name;
}

// "Due date" -> "due_date". Callers make it unique within the list.
function keyFromName(name) {
  const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return key || 'column';
}

// column: { id, type, options, is_primary }. ctx.isChannelMember(userId) -> Promise<boolean>.
async function normalizeCellValue(column, raw, ctx = {}) {
  if (isEmpty(raw) || (Array.isArray(raw) && raw.length === 0)) {
    if (column.is_primary) throw httpError(400, `"${column.name || 'The primary column'}" cannot be empty`);
    return null;
  }
  const label = column.name || column.type;
  switch (column.type) {
    case 'text': {
      if (typeof raw !== 'string') throw httpError(400, `${label} must be text`);
      const text = raw.trim();
      const limit = column.is_primary ? MAX_PRIMARY_TEXT : MAX_TEXT;
      if (text === '') {
        if (column.is_primary) throw httpError(400, `${label} cannot be empty`);
        return null;
      }
      if (text.length > limit) throw httpError(400, `${label} must be at most ${limit} characters`);
      return text;
    }
    case 'checkbox':
      if (typeof raw !== 'boolean') throw httpError(400, `${label} must be true or false`);
      return raw;
    case 'date': {
      const date = parseDate(raw);
      if (!date) throw httpError(400, `${label} must be a valid YYYY-MM-DD date`);
      return date;
    }
    case 'number': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) throw httpError(400, `${label} must be a number`);
      const precision = column.options?.precision;
      return precision === undefined ? raw : Number(raw.toFixed(precision));
    }
    case 'link': {
      const value = typeof raw === 'string' ? { url: raw } : raw;
      if (!value || typeof value !== 'object' || typeof value.url !== 'string') throw httpError(400, `${label} must be a web address`);
      const url = value.url.trim();
      if (url.length > MAX_LINK) throw httpError(400, `${label} is too long`);
      let parsed;
      try { parsed = new URL(url); } catch (_) { throw httpError(400, `${label} must be a valid web address`); }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw httpError(400, `${label} must start with http:// or https://`);
      const name = typeof value.name === 'string' ? value.name.trim().slice(0, 120) : '';
      return name ? { url, name } : { url };
    }
    case 'select': {
      const ids = Array.isArray(raw) ? raw : [raw];
      const multiple = column.options?.multiple === true;
      if (!multiple && ids.length > 1) throw httpError(400, `${label} allows one choice`);
      if (ids.length > MAX_SELECTED) throw httpError(400, `${label} allows at most ${MAX_SELECTED} choices`);
      const valid = new Set((column.options?.choices || []).map((choice) => choice.id));
      const unique = [];
      for (const id of ids) {
        if (typeof id !== 'string' || !valid.has(id)) throw httpError(400, `${label} has a choice that does not exist`);
        if (!unique.includes(id)) unique.push(id);
      }
      return unique;
    }
    case 'user': {
      const ids = Array.isArray(raw) ? raw : [raw];
      const multiple = column.options?.multiple === true;
      if (!multiple && ids.length > 1) throw httpError(400, `${label} allows one person`);
      const unique = [];
      for (const value of ids) {
        const id = Number(value);
        if (!Number.isSafeInteger(id) || id < 1) throw httpError(400, `${label} needs a valid user`);
        if (!unique.includes(id)) unique.push(id);
      }
      if (ctx.isChannelMember) {
        for (const id of unique) {
          if (!(await ctx.isChannelMember(id))) throw httpError(400, 'People in a list must be members of its channel');
        }
      }
      return unique;
    }
    default:
      throw httpError(400, `Unsupported column type: ${column.type}`);
  }
}

module.exports = {
  COLUMN_TYPES,
  SELECT_COLORS,
  MAX_CHOICES,
  normalizeColumnOptions,
  normalizeCellValue,
  validateColumnName,
  keyFromName,
  parseDate,
};
