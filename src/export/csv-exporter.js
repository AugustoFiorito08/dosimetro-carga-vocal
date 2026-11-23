// Spec §13 — per-frame CSV export (RFC 4180: comma separator, dot decimal, CRLF).
import { splFromPressure } from '../dsp/acoustic-calibration.js';

export const ALGORITHM_VERSION = '0.8.0';

/** Mandatory columns of spec §13, in order. New columns are appended so positional readers keep working. */
export const CSV_COLUMNS = Object.freeze([
  'timestamp',
  'frame_duration',
  'f0',
  'level',
  'snr',
  'periodicity',
  'speaker_score',
  'decision_v',
  'decision_w',
  'decision_q',
  'phi_k',
  'final_category',
  'rejection_reason',
  'h_k',
  'd_0',
  'd_l',
  'd_p',
  'd_e',
  'd_s',
  'algorithm_version',
  'parameters',
  'd_t',
  'd_c',
  'pressure_pa',
  'spl_db',
  'd_d',
]);

const LINE_BREAK = '\r\n';

/** Numbers keep 10 significant digits; null / undefined / NaN / ±Infinity become an empty cell. */
export function formatNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return String(Number(value.toPrecision(10)));
}

function formatCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return String(value);
}

/** Quotes a cell when it contains separators, quotes or line breaks. */
export function escapeCsvCell(cell) {
  return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

export const serializeCsvRow = (cells) => cells.map(escapeCsvCell).join(',');

export const csvHeader = () => serializeCsvRow(CSV_COLUMNS);

/**
 * Compact, stable serialisation of the parameters used ("key=value;..."),
 * computed once per session and written on the first row only (createFrameRecordLog).
 */
export function serializeParameters(parameters = {}) {
  return Object.entries(parameters)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === 'number' ? formatNumber(v) : formatCell(v)}`)
    .join(';');
}

/**
 * Formats one frame as the cells of CSV_COLUMNS.
 * @param {object} analysis classifyFrame() analysis record
 * @param {{ h?: number, doses?: object, conventionalDoses?: object, distanceDose?: number | null } | null} state
 *   vocal-load state after the frame
 * @param {{ algorithmVersion?: string, parameters?: string | object, timestamp?: number }} [sessionParams]
 * @returns {string[]}
 */
export function formatFrameRow(analysis = {}, state = null, sessionParams = {}) {
  const a = analysis ?? {};
  const doses = state?.doses ?? {};
  const conventional = state?.conventionalDoses ?? {};
  const pressurePa = state?.units === 'calibrated' && a.pressure > 0 ? a.pressure : null;
  const parameters =
    typeof sessionParams.parameters === 'string' ? sessionParams.parameters : serializeParameters(sessionParams.parameters);
  return [
    sessionParams.timestamp ?? a.timestamp,
    a.dt,
    a.f0,
    a.levelDb,
    a.snrDb,
    a.periodicity,
    a.speakerScore,
    a.V,
    a.W,
    a.Q,
    a.phi,
    a.category,
    a.rejectionReason,
    state?.h,
    doses.none,
    doses.linear,
    doses.power,
    doses.exponential,
    doses.saturating,
    sessionParams.algorithmVersion ?? ALGORITHM_VERSION,
    parameters,
    conventional.time,
    conventional.cycle,
    pressurePa,
    pressurePa === null ? null : splFromPressure(pressurePa),
    state?.distanceDose,
  ].map(formatCell);
}

/** Full CSV document from rows of cells or pre-serialised lines. Ends with a line break. */
export function buildCsv(rows) {
  const lines = rows.map((row) => (Array.isArray(row) ? serializeCsvRow(row) : row));
  return [csvHeader(), ...lines].join(LINE_BREAK) + LINE_BREAK;
}

const PARAMETERS_INDEX = CSV_COLUMNS.indexOf('parameters');

/** Rows per export chunk: ~2 MB of text, so the export never holds the whole document as one string. */
export const CSV_ROWS_PER_CHUNK = 10000;

/**
 * In-memory rows of a session (spec §13). Each frame is kept as one serialised line with
 * an empty `parameters` cell, so a long session does not repeat that cell (hundreds of
 * characters) on every frame; the export writes the parameters on the first row only.
 * Every other cell, and the position of every column, stays as formatFrameRow() made it.
 */
export function createFrameRecordLog() {
  let lines = [];
  let firstCells = null;
  let storedChars = 0;
  return {
    /** @param {string[]} cells formatFrameRow() output */
    push(cells) {
      if (firstCells === null) firstCells = cells.slice();
      const compact = cells.slice();
      compact[PARAMETERS_INDEX] = '';
      const line = serializeCsvRow(compact);
      lines.push(line);
      storedChars += line.length;
    },
    clear() {
      lines = [];
      firstCells = null;
      storedChars = 0;
    },
    get length() { return lines.length; },
    /** Characters held for the rows (measures the per-frame memory). */
    get storedChars() { return storedChars; },
    /**
     * The CSV document as consecutive pieces: the header, then up to `rowsPerChunk` rows
     * per piece, each ending in CRLF, with `parameters` on the first row. Joined, they are
     * exactly toCsv(). Lazy: each piece is built only when requested.
     */
    *chunks(parameters, { rowsPerChunk = CSV_ROWS_PER_CHUNK } = {}) {
      if (!Number.isInteger(rowsPerChunk) || rowsPerChunk < 1) throw new RangeError(`rowsPerChunk must be a positive integer, got ${rowsPerChunk}`);
      if (lines.length === 0) return;
      yield csvHeader() + LINE_BREAK;
      const first = firstCells.slice();
      first[PARAMETERS_INDEX] = parameters;
      for (let from = 0; from < lines.length; from += rowsPerChunk) {
        const rows = lines.slice(from, from + rowsPerChunk);
        if (from === 0) rows[0] = serializeCsvRow(first);
        yield rows.join(LINE_BREAK) + LINE_BREAK;
      }
    },
    /** CSV document with `parameters` on the first row; null when nothing was recorded. */
    toCsv(parameters) {
      return lines.length === 0 ? null : [...this.chunks(parameters)].join('');
    },
  };
}

/** dosimetro_2026-11-04T14-30-05.csv (local time, filename-safe). */
export function csvFileName(date = new Date(), prefix = 'dosimetro') {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  return `${prefix}_${stamp}.csv`;
}

/**
 * Browser download through a Blob URL. Dependencies are injectable for tests.
 * `content` is the CSV text or an iterable of its chunks (createFrameRecordLog().chunks()):
 * each chunk becomes a small Blob as soon as it is produced, so the whole document never
 * exists as a single JavaScript string.
 * @param {string | Iterable<string>} content
 * @returns {string} the file name used
 */
export function downloadCsv(content, { fileName = csvFileName(), doc = globalThis.document, url = globalThis.URL } = {}) {
  const parts = typeof content === 'string' ? [content] : Array.from(content, (chunk) => new Blob([chunk]));
  const blob = new Blob(parts, { type: 'text/csv;charset=utf-8' });
  const href = url.createObjectURL(blob);
  const link = doc.createElement('a');
  link.href = href;
  link.download = fileName;
  link.style.display = 'none';
  doc.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => url.revokeObjectURL(href), 0);
  return fileName;
}
