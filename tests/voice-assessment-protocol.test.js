// PRE/POST protocol: state, comparison table, workday record and VOICE_ACOUSTIC_ASSESSMENT CSV.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { analyseVoiceSample } from '../src/dsp/voice-assessment.js';
import { ACOUSTIC_CSV_COLUMNS, buildAcousticCsv } from '../src/export/acoustic-exporter.js';
import {
  STANDARD_TEXT, STANDARD_TEXT_ID, comparisonRows, createAssessment, restoreAssessment, withResult, withVas, workdayAssessment,
} from '../src/store/voice-assessment.js';
import { validateWorkday } from '../src/store/workday.js';
import { sustainedVowel, withLeadIn } from './helpers/sustained-vowel.js';

const FS = 16000;
const take = (task, f0, hnrDb, seconds = task === 'VOWEL' ? 3 : 6) =>
  analyseVoiceSample(withLeadIn(sustainedVowel({ sampleRate: FS, f0, hnrDb, seconds }), 1, FS), FS, { task });

const pre = take('VOWEL', 200, 30);
const post = take('VOWEL', 215, 15);
const speech = take('SPEECH', 200, 30);

function filled() {
  let s = createAssessment('2026-11-20');
  s = withVas(s, 'PRE', 'fatigue', 10);
  s = withVas(s, 'POST', 'fatigue', 45);
  s = withVas(s, 'PRE', 'effort', 20);
  s = withResult(s, 'PRE', pre);
  s = withResult(s, 'POST', post);
  return withResult(s, 'PRE', speech);
}

describe('assessment state', () => {
  it('has a standard text of reading length', () => {
    const words = STANDARD_TEXT.split(/\s+/).length;
    assert.ok(words >= 50 && words <= 90, `${words} words`);
    assert.equal(createAssessment('2026-11-20').textId, STANDARD_TEXT_ID);
  });

  it('validates VAS values', () => {
    const s = createAssessment('2026-11-20');
    assert.throws(() => withVas(s, 'PRE', 'effort', 101), RangeError);
    assert.throws(() => withVas(s, 'MID', 'effort', 5), RangeError);
    assert.throws(() => withVas(s, 'PRE', 'pain', 5), RangeError);
    assert.equal(withVas(s, 'PRE', 'effort', null).PRE.vas.effort, null);
  });

  it('refuses rejected takes and anything that retains audio', () => {
    const s = createAssessment('2026-11-20');
    assert.throws(() => withResult(s, 'PRE', { ...pre, quality: { status: 'rejected', reasons: ['low_snr'] } }), /rejected/);
    assert.throws(() => withResult(s, 'PRE', { ...pre, audioRetained: true }), /audio/);
  });

  it('builds the PRE / POST / Δ table without clinical cut-offs', () => {
    const rows = comparisonRows(filled());
    const row = (label) => rows.find((r) => r.label === label);
    assert.deepEqual(row('Fatiga (EVA)'), { label: 'Fatiga (EVA)', unit: '0-100', pre: 10, post: 45, delta: 35 });
    assert.equal(row('Esfuerzo (EVA)').delta, null, 'no POST, no change');
    assert.ok(row('CPPS /a/').delta < 0, 'a noisier POST vowel lowers CPPS');
    assert.ok(Math.abs(row('F0 mediana /a/').delta - 15) < 3);
    assert.equal(row('CPPS texto').post, null);
    assert.ok(rows.every((r) => Object.keys(r).join() === 'label,unit,pre,post,delta'));
  });

  it('survives a reload on the same day only', () => {
    const s = filled();
    assert.deepEqual(restoreAssessment(JSON.stringify(s), '2026-11-20'), s);
    assert.deepEqual(restoreAssessment(JSON.stringify(s), '2026-11-21'), createAssessment('2026-11-21'));
    assert.deepEqual(restoreAssessment('{bad', '2026-11-20'), createAssessment('2026-11-20'));
    const leaky = { ...s, PRE: { ...s.PRE, VOWEL: { ...s.PRE.VOWEL, audioRetained: true } } };
    assert.deepEqual(restoreAssessment(JSON.stringify(leaky), '2026-11-20'), createAssessment('2026-11-20'));
  });
});

describe('assessment in the workday record', () => {
  const base = {
    schema: 'vd-des-workday/1', id: 'S-1', participantId: 'P-1', schoolId: 'E-1', classroom: '2B', date: '2026-11-20',
    durationS: 10, phonationS: 5, fatigue: { pre: 10, post: 45 }, source: 'live', events: [],
  };

  it('keeps the VAS (other than fatigue) and the results', () => {
    const a = workdayAssessment(filled());
    assert.deepEqual(a.vas.effort, { pre: 20, post: null });
    assert.equal(a.vas.fatigue, undefined, 'fatigue stays in workday.fatigue');
    assert.deepEqual(a.results.map((r) => `${r.timepoint}/${r.task}`), ['PRE/VOWEL', 'PRE/SPEECH', 'POST/VOWEL']);
    assert.doesNotThrow(() => validateWorkday({ ...base, assessment: a }));
  });

  it('rejects results that retain audio or have no timepoint', () => {
    const a = workdayAssessment(filled());
    assert.throws(() => validateWorkday({ ...base, assessment: { ...a, results: [{ ...a.results[0], audioRetained: true }] } }), /audio/);
    assert.throws(() => validateWorkday({ ...base, assessment: { ...a, results: [{ ...a.results[0], timepoint: 'X' }] } }), RangeError);
    assert.throws(() => validateWorkday({ ...base, assessment: { ...a, vas: { effort: { pre: 120, post: null } } } }), RangeError);
  });
});

describe('VOICE_ACOUSTIC_ASSESSMENT export', () => {
  const csv = buildAcousticCsv(filled(), { participantId: 'P-1', microphone: 'Mic USB', algorithmVersion: '9.9.9' });
  const lines = csv.trim().split('\r\n');
  const cells = (i) => Object.fromEntries(ACOUSTIC_CSV_COLUMNS.map((c, k) => [c, lines[i].split(',')[k]]));

  it('one row per timepoint × task, with method, version and settings', () => {
    assert.equal(lines[0], ACOUSTIC_CSV_COLUMNS.join(','));
    assert.equal(lines.length, 4);
    const vowel = cells(1);
    assert.equal(vowel.record_type, 'VOICE_ACOUSTIC_ASSESSMENT');
    assert.equal(`${vowel.timepoint}/${vowel.task}`, 'PRE/VOWEL');
    assert.equal(vowel.text_id, '');
    assert.equal(cells(2).text_id, STANDARD_TEXT_ID);
    assert.equal(vowel.algorithm_version, '9.9.9');
    assert.match(vowel.pitch_settings, /^minF0=70;maxF0=500;/);
    assert.match(vowel.cepstral_settings, /stepSeconds=0\.002/);
    assert.equal(vowel.microphone, 'Mic USB');
    assert.equal(vowel.calibrated, 'false');
    assert.equal(vowel.audio_retained, 'false');
    assert.equal(vowel.signal_quality, 'ok');
    assert.ok(Math.abs(Number(vowel.cpps_db) - pre.cpps) < 1e-6);
    assert.equal(vowel.cepstrum_db.split(' ').length, 77);
    assert.equal(vowel.ltas_db.split(' ').length, vowel.ltas_centers_hz.split(' ').length);
    assert.ok(Number(vowel.jitter_local_pct) >= 0 && vowel.shimmer_local_pct !== '', 'vowel rows carry jitter and shimmer');
    assert.equal(cells(2).jitter_local_pct, '', 'not computed on the text');
  });
});
