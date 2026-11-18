// Automatic events of a workday (provisional rules, to be calibrated in the pilot phase).
// They describe the acoustic pattern only; they do not identify the activity nor diagnose
// fatigue, and the teacher can add or confirm the context.
import { quantile } from '../stats/descriptive.js';

export const AUTO_EVENT_RULES = Object.freeze({
  sustainedWindowS: 120, // window for sustained phonation
  sustainedMinFraction: 0.6, // phonation share inside the window
  raisedLevelDb: 6, // level above the workday's own median
  raisedMinS: 3, // minimum duration of a raised-level run
});

/**
 * @param {ReturnType<import('../ui/score-series.js').createScoreSeries>} series
 * @returns {{ t: number, type: 'fonacion_sostenida' | 'nivel_elevado', source: 'algoritmo', durationS: number, detail?: string }[]}
 */
export function detectEvents(series, rules = AUTO_EVENT_RULES) {
  if (series.length === 0) return [];
  const from = series.startTime;
  const seconds = Math.max(1, Math.ceil(series.endTime - from));
  const b = series.bucketize({ from, to: from + seconds, buckets: seconds, dose: 'none' });
  const voiced = Array.from(b.phi, (v) => (Number.isNaN(v) ? 0 : v));
  return [...sustained(voiced, from, rules), ...raised(b.level, series, from, rules)].sort((x, y) => x.t - y.t);
}

function sustained(voiced, from, { sustainedWindowS: w, sustainedMinFraction: minFraction }) {
  const n = voiced.length;
  if (n < w) return [];
  const flagged = new Uint8Array(n);
  let sum = voiced.slice(0, w).reduce((a, v) => a + v, 0);
  for (let start = 0; start + w <= n; start++) {
    if (start > 0) sum += voiced[start + w - 1] - voiced[start - 1];
    if (sum >= minFraction * w) flagged.fill(1, start, start + w);
  }
  const events = [];
  for (let i = 0; i < n; ) {
    if (!flagged[i]) { i++; continue; }
    let j = i;
    while (j + 1 < n && flagged[j + 1]) j++;
    let a = i;
    let z = j;
    while (a < z && voiced[a] === 0) a++; // trim the region to its voiced edges
    while (z > a && voiced[z] === 0) z--;
    events.push({ t: from + a, type: 'fonacion_sostenida', source: 'algoritmo', durationS: z - a + 1 });
    i = j + 1;
  }
  return events;
}

function raised(levels, series, from, { raisedLevelDb, raisedMinS }) {
  const median = quantile(series.voicedValues('level'), 0.5);
  if (!Number.isFinite(median)) return [];
  const limit = median + raisedLevelDb;
  const events = [];
  for (let i = 0; i < levels.length; ) {
    if (!(levels[i] >= limit)) { i++; continue; }
    let j = i;
    let sum = 0;
    while (j < levels.length && levels[j] >= limit) sum += levels[j++];
    const durationS = j - i;
    if (durationS >= raisedMinS) {
      events.push({ t: from + i, type: 'nivel_elevado', source: 'algoritmo', durationS, detail: `+${Math.round(sum / durationS - median)} dB` });
    }
    i = j;
  }
  return events;
}
