import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';

import {
  ALGORITHM_VERSION,
  CSV_COLUMNS,
  CSV_ROWS_PER_CHUNK,
  buildCsv,
  createFrameRecordLog,
  csvFileName,
  csvHeader,
  downloadCsv,
  downloadCsvGzip,
  gzipCsv,
  supportsGzip,
  escapeCsvCell,
  formatFrameRow,
  formatNumber,
  serializeParameters,
} from '../src/export/csv-exporter.js';

/** Minimal RFC 4180 parser so tests check the tabular structure, not string details. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += ch;
  }
  return rows;
}

const column = (row, name) => row[CSV_COLUMNS.indexOf(name)];

const load = {
  h: 1.25,
  doses: { none: 100, linear: 101.5, power: 102.25, exponential: 103.125, saturating: 104 },
  conventionalDoses: { time: 3.5, cycle: 612.75 },
};
const attributed = {
  timestamp: 12.288, dt: 0.064, f0: 151.234567891234, levelDb: -18.5, snrDb: 42.1, periodicity: 0.98,
  speakerScore: 0.93, V: 1, W: 1, Q: 1, phi: 1, category: 'fonacion_atribuida', rejectionReason: null,
};
const silenceFrame = {
  timestamp: 12.352, dt: 0.064, f0: null, levelDb: -240, snrDb: -180, periodicity: 0,
  speakerScore: null, V: 0, W: 0, Q: 0, phi: 0, category: 'silencio', rejectionReason: 'below_gate',
};
const foreign = { ...attributed, speakerScore: 0.31, W: 0, phi: 0, category: 'voz_no_atribuida', rejectionReason: 'speaker_mismatch' };
const params = { beta: 1 / 300, alphaL: 0.01, units: 'relative' };

describe('CSV header (spec §13)', () => {
  it('matches the mandatory columns exactly and in order', () => {
    assert.equal(
      csvHeader(),
      'timestamp,frame_duration,f0,level,snr,periodicity,speaker_score,decision_v,decision_w,decision_q,' +
        'phi_k,final_category,rejection_reason,h_k,d_0,d_l,d_p,d_e,d_s,algorithm_version,parameters,d_t,d_c,' +
        'pressure_pa,spl_db,d_d',
    );
    assert.equal(CSV_COLUMNS.length, 26);
    assert.ok(Object.isFrozen(CSV_COLUMNS));
  });
});

describe('formatFrameRow', () => {
  it('attributed phonation: every column filled', () => {
    const row = formatFrameRow(attributed, load, { parameters: params });
    assert.equal(row.length, CSV_COLUMNS.length);
    assert.deepEqual(row.slice(0, 14), [
      '12.288', '0.064', '151.2345679', '-18.5', '42.1', '0.98', '0.93',
      '1', '1', '1', '1', 'fonacion_atribuida', '', '1.25',
    ]);
    assert.deepEqual(row.slice(14, 19), ['100', '101.5', '102.25', '103.125', '104']);
    assert.equal(column(row, 'algorithm_version'), ALGORITHM_VERSION);
    assert.equal(column(row, 'parameters'), 'beta=0.003333333333;alphaL=0.01;units=relative');
    assert.deepEqual([column(row, 'd_t'), column(row, 'd_c')], ['3.5', '612.75']);
  });

  it('pressure_pa and spl_db are filled only for calibrated sessions', () => {
    const frame = { ...attributed, pressure: 0.2 };
    const calibrated = formatFrameRow(frame, { ...load, units: 'calibrated' });
    assert.equal(column(calibrated, 'pressure_pa'), '0.2');
    assert.equal(column(calibrated, 'spl_db'), formatNumber(20 * Math.log10(0.2 / 20e-6)));
    const relative = formatFrameRow(frame, { ...load, units: 'relative' });
    assert.deepEqual([column(relative, 'pressure_pa'), column(relative, 'spl_db')], ['', '']);
    const silent = formatFrameRow({ ...frame, pressure: 0 }, { ...load, units: 'calibrated' });
    assert.deepEqual([column(silent, 'pressure_pa'), column(silent, 'spl_db')], ['', '']);
  });

  it('d_d holds the distance dose in m and stays empty when it is not computed', () => {
    assert.equal(column(formatFrameRow(attributed, { ...load, distanceDose: 12.5 }), 'd_d'), '12.5');
    assert.equal(column(formatFrameRow(attributed, { ...load, distanceDose: null }), 'd_d'), '');
    assert.equal(column(formatFrameRow(attributed, load), 'd_d'), '');
  });

  it('silence: empty F0 / score, decisions 0, reason below_gate', () => {
    const row = formatFrameRow(silenceFrame, load, { parameters: 'p=1' });
    assert.equal(column(row, 'f0'), '');
    assert.equal(column(row, 'speaker_score'), '');
    assert.equal(column(row, 'phi_k'), '0');
    assert.equal(column(row, 'final_category'), 'silencio');
    assert.equal(column(row, 'rejection_reason'), 'below_gate');
  });

  it('rejection keeps the continuous score and the reason', () => {
    const row = formatFrameRow(foreign, load);
    assert.equal(column(row, 'speaker_score'), '0.31');
    assert.deepEqual([column(row, 'decision_v'), column(row, 'decision_w'), column(row, 'decision_q')], ['1', '0', '1']);
    assert.equal(column(row, 'rejection_reason'), 'speaker_mismatch');
  });

  it('uses the session timestamp override when provided', () => {
    assert.equal(column(formatFrameRow(attributed, load, { timestamp: 99.5 }), 'timestamp'), '99.5');
  });

  it('null / undefined / NaN / Infinity never break the column structure', () => {
    const broken = { dt: undefined, f0: NaN, levelDb: -Infinity, snrDb: Infinity, V: null, category: undefined };
    for (const row of [formatFrameRow(broken, null), formatFrameRow(undefined, undefined), formatFrameRow(null, { h: NaN })]) {
      assert.equal(row.length, CSV_COLUMNS.length);
      assert.ok(row.every((c) => typeof c === 'string'));
      assert.ok(row.slice(0, 19).every((c) => c === ''), JSON.stringify(row));
      assert.deepEqual([column(row, 'd_t'), column(row, 'd_c')], ['', '']);
    }
  });
});

describe('CSV document', () => {
  it('assembles header + rows with CRLF and parses back to a rectangular table', () => {
    const csv = buildCsv([
      formatFrameRow(attributed, load, { parameters: params }),
      formatFrameRow(silenceFrame, load, { parameters: params }),
      formatFrameRow(foreign, load, { parameters: params }),
    ]);
    assert.ok(csv.endsWith('\r\n'));
    const table = parseCsv(csv);
    assert.equal(table.length, 4);
    assert.ok(table.every((r) => r.length === CSV_COLUMNS.length));
    assert.deepEqual(table[0], CSV_COLUMNS);
    assert.deepEqual(table.slice(1).map((r) => column(r, 'final_category')), ['fonacion_atribuida', 'silencio', 'voz_no_atribuida']);
  });

  it('accepts pre-serialised lines', () => {
    const csv = buildCsv(['1,2']);
    assert.equal(csv, `${csvHeader()}\r\n1,2\r\n`);
  });

  it('quotes cells containing commas, quotes or line breaks', () => {
    assert.equal(escapeCsvCell('a,b'), '"a,b"');
    assert.equal(escapeCsvCell('say "hi"'), '"say ""hi"""');
    assert.equal(escapeCsvCell('x\ny'), '"x\ny"');
    assert.equal(escapeCsvCell('plain'), 'plain');
    const table = parseCsv(buildCsv([formatFrameRow(attributed, load, { parameters: 'note=a,"b"' })]));
    assert.equal(table[1].length, CSV_COLUMNS.length);
    assert.equal(column(table[1], 'parameters'), 'note=a,"b"');
  });

  it('number formatting is locale independent (dot decimal, no grouping)', () => {
    assert.equal(formatNumber(1234567.891), '1234567.891');
    assert.equal(formatNumber(0.1 + 0.2), '0.3');
    assert.equal(formatNumber(1e-7), '1e-7');
    assert.equal(formatNumber(NaN), '');
  });

  it('serializes parameters skipping undefined values', () => {
    assert.equal(serializeParameters({ a: 1, b: undefined, c: true }), 'a=1;c=1');
    assert.equal(serializeParameters(), '');
  });
});

describe('download', () => {
  it('builds a filename-safe timestamped name', () => {
    assert.equal(csvFileName(new Date(2026, 10, 4, 9, 5, 7)), 'dosimetro_2026-11-04T09-05-07.csv');
  });

  it('downloads through a Blob URL and an <a download> click', async () => {
    const events = [];
    const link = { style: {}, click: () => events.push(`click:${link.download}`), remove: () => events.push('remove') };
    const doc = { createElement: (tag) => (events.push(`create:${tag}`), link), body: { append: () => events.push('append') } };
    let blob = null;
    const url = { createObjectURL: (b) => ((blob = b), 'blob:x'), revokeObjectURL: (h) => events.push(`revoke:${h}`) };
    const name = downloadCsv('a,b\r\n', { fileName: 'f.csv', doc, url });
    assert.equal(name, 'f.csv');
    assert.equal(link.href, 'blob:x');
    assert.equal(blob.type, 'text/csv;charset=utf-8');
    assert.equal(await blob.text(), 'a,b\r\n');
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(events, ['create:a', 'append', 'click:f.csv', 'remove', 'revoke:blob:x']);
  });
});

describe('frame record log (parameters once per session, spec §13)', () => {
  const PARAMS = 'p';
  const at = CSV_COLUMNS.indexOf('parameters');
  const rowsOf = (csv) => parseCsv(csv).slice(1);

  it('exports the parameters on the first row only, keeping every column in place', () => {
    const log = createFrameRecordLog();
    for (const frame of [attributed, silenceFrame, foreign]) log.push(formatFrameRow(frame, load, { parameters: 'beta=1;note=a,"b"' }));
    assert.equal(log.length, 3);
    const table = parseCsv(log.toCsv('beta=1;note=a,"b"'));
    assert.deepEqual(table[0], [...CSV_COLUMNS]);
    const rows = table.slice(1);
    assert.ok(rows.every((r) => r.length === CSV_COLUMNS.length));
    assert.deepEqual(rows.map((r) => r[at]), ['beta=1;note=a,"b"', '', '']);
    assert.deepEqual(rows.map((r) => column(r, 'final_category')), ['fonacion_atribuida', 'silencio', 'voz_no_atribuida']);
    assert.deepEqual(rows.map((r) => column(r, 'algorithm_version')), [ALGORITHM_VERSION, ALGORITHM_VERSION, ALGORITHM_VERSION]);
  });

  it('writes the parameters given at export time (e.g. after the post calibration)', () => {
    const log = createFrameRecordLog();
    log.push(formatFrameRow(attributed, load, { parameters: 'a=1' }));
    log.push(formatFrameRow(silenceFrame, load, { parameters: 'a=1' }));
    assert.deepEqual(rowsOf(log.toCsv('a=1;calDriftDb=0.2')).map((r) => r[at]), ['a=1;calDriftDb=0.2', '']);
  });

  it('keeps every other cell identical to the full row', () => {
    const log = createFrameRecordLog();
    const cells = formatFrameRow(silenceFrame, load, { parameters: PARAMS });
    log.push(formatFrameRow(attributed, load, { parameters: PARAMS }));
    log.push(cells);
    const [, second] = rowsOf(log.toCsv(PARAMS));
    assert.deepEqual(second, cells.map((c, i) => (i === at ? '' : c)));
  });

  it('is empty (null CSV) until a frame arrives, and clear() drops everything', () => {
    const log = createFrameRecordLog();
    assert.equal(log.toCsv(PARAMS), null);
    log.push(formatFrameRow(attributed, load, { parameters: PARAMS }));
    log.clear();
    assert.equal(log.length, 0);
    assert.equal(log.toCsv(PARAMS), null);
  });

  it('stores far less per frame than rows repeating the parameters', () => {
    // A parameters cell as long as a real session's (~40 keys).
    const parameters = serializeParameters(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`parameter${i}`, 1 / (i + 3)])));
    assert.ok(parameters.length > 700, `parameters: ${parameters.length} chars`);
    const log = createFrameRecordLog();
    let legacyChars = 0;
    const frames = 10000;
    for (let k = 0; k < frames; k++) {
      const cells = formatFrameRow({ ...attributed, timestamp: k * 0.064 }, load, { parameters });
      legacyChars += buildCsv([cells]).length - csvHeader().length - 4; // the old in-memory line
      log.push(cells);
    }
    const perFrame = log.storedChars / frames;
    const legacyPerFrame = legacyChars / frames;
    assert.ok(perFrame < legacyPerFrame - parameters.length + 10, `${perFrame.toFixed(0)} vs ${legacyPerFrame.toFixed(0)} chars per frame`);
    assert.ok(perFrame / legacyPerFrame < 0.25, `kept ${(100 * perFrame / legacyPerFrame).toFixed(1)} % of the memory`);
  });
});

describe('chunked CSV export (no single document-sized string)', () => {
  const frames = [attributed, silenceFrame, foreign, attributed, silenceFrame];
  function filledLog() {
    const log = createFrameRecordLog();
    frames.forEach((f, k) => log.push(formatFrameRow({ ...f, timestamp: k * 0.064 }, load, { parameters: 'x=1' })));
    return log;
  }
  /** The same document built the pre-chunking way: every row serialised and joined at once. */
  function reference(parameters) {
    const at = CSV_COLUMNS.indexOf('parameters');
    return buildCsv(frames.map((f, k) => {
      const cells = formatFrameRow({ ...f, timestamp: k * 0.064 }, load, { parameters });
      return cells.map((c, i) => (i === at && k > 0 ? '' : c));
    }));
  }

  it('yields the header and at most rowsPerChunk rows per chunk, each ending in CRLF', () => {
    const chunks = [...filledLog().chunks('x=1', { rowsPerChunk: 2 })];
    assert.equal(chunks.length, 4, 'header + 3 chunks of rows');
    assert.equal(chunks[0], `${csvHeader()}\r\n`);
    assert.ok(chunks.every((c) => c.endsWith('\r\n')));
    assert.deepEqual(chunks.slice(1).map((c) => c.split('\r\n').length - 1), [2, 2, 1]);
  });

  it('joins into exactly the same bytes as the single-string export, for any chunk size', () => {
    const expected = reference('x=1;calDriftDb=0.2');
    for (const rowsPerChunk of [1, 2, 3, 5, 10000]) {
      assert.equal([...filledLog().chunks('x=1;calDriftDb=0.2', { rowsPerChunk })].join(''), expected, `rowsPerChunk=${rowsPerChunk}`);
    }
    assert.equal(filledLog().toCsv('x=1;calDriftDb=0.2'), expected);
  });

  it('defaults to 10 000 rows per chunk, rejects invalid sizes and yields nothing when empty', () => {
    assert.equal(CSV_ROWS_PER_CHUNK, 10000);
    assert.equal([...filledLog().chunks('x=1')].length, 2);
    assert.throws(() => [...filledLog().chunks('x=1', { rowsPerChunk: 0 })], RangeError);
    assert.deepEqual([...createFrameRecordLog().chunks('x=1')], []);
  });

  it('builds the download Blob from the chunks with the same content', async () => {
    const link = { style: {}, click() {}, remove() {} };
    const doc = { createElement: () => link, body: { append() {} } };
    let blob = null;
    const url = { createObjectURL: (b) => ((blob = b), 'blob:y'), revokeObjectURL() {} };
    downloadCsv(filledLog().chunks('x=1', { rowsPerChunk: 2 }), { fileName: 'c.csv', doc, url });
    assert.equal(blob.type, 'text/csv;charset=utf-8');
    assert.equal(await blob.text(), reference('x=1'));
  });
});

describe('optional .csv.gz export (CompressionStream)', () => {
  function bigLog(rows = 3000) {
    const log = createFrameRecordLog();
    for (let k = 0; k < rows; k++) log.push(formatFrameRow({ ...(k % 3 ? attributed : silenceFrame), timestamp: k * 0.064 }, load, { parameters: 'x=1' }));
    return log;
  }
  function fakeBrowser() {
    const downloads = [];
    const link = { style: {}, click() { downloads.push({ name: link.download, blob }); }, remove() {} };
    const doc = { createElement: () => link, body: { append() {} } };
    let blob = null;
    const url = { createObjectURL: (b) => ((blob = b), 'blob:z'), revokeObjectURL() {} };
    return { doc, url, downloads };
  }
  const bytes = async (blob) => Buffer.from(await blob.arrayBuffer());

  it('detects support for gzip compression', () => {
    assert.equal(supportsGzip(), true, 'Node and current browsers provide CompressionStream');
    assert.equal(supportsGzip({ CompressionStreamClass: undefined }), false);
  });

  it('gzipCsv decompresses to exactly the plain CSV, and is much smaller', async () => {
    const log = bigLog();
    const gz = await gzipCsv(log.chunks('x=1', { rowsPerChunk: 500 }));
    assert.equal(gz.type, 'application/gzip');
    const raw = await bytes(gz);
    assert.deepEqual([raw[0], raw[1]], [0x1f, 0x8b], 'gzip magic number');
    const plain = log.toCsv('x=1');
    assert.equal(gunzipSync(raw).toString('utf8'), plain);
    assert.ok(raw.length < plain.length / 4, `${raw.length} vs ${plain.length} bytes`);
  });

  it('downloads a .csv.gz with the gzip MIME type when asked', async () => {
    const log = bigLog(10);
    const { doc, url, downloads } = fakeBrowser();
    const result = await downloadCsvGzip(log.chunks('x=1'), { fileName: 'dosimetro_x.csv', doc, url });
    assert.deepEqual(result, { fileName: 'dosimetro_x.csv.gz', compressed: true });
    assert.equal(downloads[0].name, 'dosimetro_x.csv.gz');
    assert.equal(downloads[0].blob.type, 'application/gzip');
    assert.equal(gunzipSync(await bytes(downloads[0].blob)).toString('utf8'), log.toCsv('x=1'));
  });

  it('falls back to the plain .csv, without throwing, when CompressionStream is missing', async () => {
    const log = bigLog(10);
    const { doc, url, downloads } = fakeBrowser();
    const result = await downloadCsvGzip(log.chunks('x=1'), { fileName: 'd.csv', doc, url, CompressionStreamClass: undefined });
    assert.deepEqual(result, { fileName: 'd.csv', compressed: false, reason: 'unsupported' });
    assert.equal(downloads[0].blob.type, 'text/csv;charset=utf-8');
    assert.equal(await downloads[0].blob.text(), log.toCsv('x=1'));
  });

  it('falls back to the plain .csv when compression fails midway', async () => {
    class BrokenCompression {
      constructor() {
        const ts = new TransformStream({ transform() { throw new Error('codec crashed'); } });
        this.readable = ts.readable;
        this.writable = ts.writable;
      }
    }
    const log = bigLog(10);
    const { doc, url, downloads } = fakeBrowser();
    const result = await downloadCsvGzip(log.chunks('x=1'), { fileName: 'd.csv', doc, url, CompressionStreamClass: BrokenCompression });
    assert.equal(result.compressed, false);
    assert.equal(result.reason, 'failed');
    assert.match(result.error.message, /codec crashed/);
    assert.equal(downloads.length, 1, 'exactly one download, the plain CSV');
    assert.equal(downloads[0].name, 'd.csv');
    assert.equal(await downloads[0].blob.text(), log.toCsv('x=1'));
  });

  it('accepts plain text too', async () => {
    const gz = await gzipCsv('a,b\r\n1,2\r\n');
    assert.equal(gunzipSync(await bytes(gz)).toString('utf8'), 'a,b\r\n1,2\r\n');
  });
});
