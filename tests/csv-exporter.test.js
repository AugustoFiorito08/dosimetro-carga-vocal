import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALGORITHM_VERSION,
  CSV_COLUMNS,
  buildCsv,
  csvFileName,
  csvHeader,
  downloadCsv,
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
        'phi_k,final_category,rejection_reason,h_k,d_0,d_l,d_p,d_e,d_s,algorithm_version,parameters,d_t,d_c',
    );
    assert.equal(CSV_COLUMNS.length, 23);
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
