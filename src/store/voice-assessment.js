// PRE/POST voice assessment of one workday (spec §23): the vocal effort (Borg CR10, protocol
// key), the VAS of fatigue, dryness and discomfort, and the acoustic results of the
// standardised takes. Holds measures only, never audio; it survives a page reload
// (local storage) so the morning PRE is still there for the afternoon POST.

export const TIMEPOINTS = Object.freeze(['PRE', 'POST']);
export const TASKS = Object.freeze(['VOWEL', 'SPEECH']);
/** VAS 0-100 in the order of the protocol; the effort is a Borg CR10 rating (BORG_SCALE). */
export const VAS_ITEMS = Object.freeze(['fatigue', 'dryness', 'discomfort']);

/**
 * Vocal effort: the ten phrases of the response sheet and the value of the protocol key, an
 * adaptation of Borg CR10 ("extremadamente fuerte" = 9, "esfuerzo máximo absoluto" = 10).
 * The teacher picks the phrase, never the number.
 */
export const BORG_SCALE = Object.freeze([
  { label: 'Ningún esfuerzo / Nada en absoluto', value: 0 },
  { label: 'Extremadamente ligero (apenas perceptible)', value: 0.5 },
  { label: 'Muy ligero', value: 1 },
  { label: 'Ligero', value: 2 },
  { label: 'Moderado', value: 3 },
  { label: 'Algo fuerte', value: 4 },
  { label: 'Fuerte', value: 5 },
  { label: 'Muy fuerte', value: 7 },
  { label: 'Extremadamente fuerte', value: 9 },
  { label: 'Esfuerzo máximo absoluto', value: 10 },
].map(Object.freeze));
/**
 * Values a workday may hold: the ten phrases plus 6 and 8, which the paper key allows when the
 * participant says an intermediate effort (records loaded from paper).
 */
export const BORG_VALUES = Object.freeze([0, 0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
export const RECORDING_SECONDS = Object.freeze({ VOWEL: 5, SPEECH: 25 });

/**
 * Standard reading passage: the project's own wording of Aesop's fable "The North Wind
 * and the Sun", the passage used for phonetic illustrations (IPA Handbook). About 20 s
 * at a normal pace; the 25 s take leaves room and the trailing silence counts as a pause.
 */
export const STANDARD_TEXT_ID = 'viento-norte-sol-v1';
export const STANDARD_TEXT =
  'El viento norte y el sol discutían cuál de los dos era el más fuerte, cuando vieron pasar a un viajero envuelto en una capa. ' +
  'Acordaron que ganaría quien lograra que el viajero se la quitara. ' +
  'El viento sopló con toda su fuerza, pero cuanto más soplaba, más se abrigaba el viajero. ' +
  'Entonces el sol brilló con calor y el viajero, sofocado, se quitó la capa. ' +
  'Así, el viento tuvo que reconocer que el sol era el más fuerte.';

/** Longest array a result may hold: the LTAS bands and the 77-value average cepstrum. */
export const MAX_DERIVED_VALUES = 100;

const longestArray = (value) => {
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return Math.max(value.length, ...Array.from(value, longestArray));
  if (value && typeof value === 'object') return Math.max(0, ...Object.values(value).map(longestArray));
  return 0;
};

/** True when a result is not marked audio-free or holds anything long enough to be audio. */
export function retainsAudio(result) {
  return result?.audioRetained !== false || longestArray(result) > MAX_DERIVED_VALUES;
}

const emptyTimepoint = () => ({ vas: Object.fromEntries(VAS_ITEMS.map((k) => [k, null])), borg: null, VOWEL: null, SPEECH: null });

export function createAssessment(date) {
  return { textId: STANDARD_TEXT_ID, date, PRE: emptyTimepoint(), POST: emptyTimepoint() };
}

function checkTimepoint(timepoint) {
  if (!TIMEPOINTS.includes(timepoint)) throw new RangeError(`timepoint must be PRE or POST, got ${timepoint}`);
}

export function withVas(state, timepoint, item, value) {
  checkTimepoint(timepoint);
  if (!VAS_ITEMS.includes(item)) throw new RangeError(`unknown VAS item ${item}`);
  if (value !== null && !(typeof value === 'number' && value >= 0 && value <= 100)) {
    throw new RangeError('La EVA debe estar entre 0 y 100.');
  }
  return { ...state, [timepoint]: { ...state[timepoint], vas: { ...state[timepoint].vas, [item]: value } } };
}

/** Sets the vocal effort of a timepoint: the value of one of the BORG_SCALE phrases, or null. */
export function withBorg(state, timepoint, value) {
  checkTimepoint(timepoint);
  if (value !== null && !BORG_SCALE.some((o) => o.value === value)) throw new RangeError(`Borg effort must be one of the scale values, got ${value}`);
  return { ...state, [timepoint]: { ...state[timepoint], borg: value } };
}

/** Stores an analysed take; a rejected take or anything holding audio is refused. */
export function withResult(state, timepoint, result) {
  checkTimepoint(timepoint);
  if (!TASKS.includes(result?.task)) throw new RangeError(`unknown task ${result?.task}`);
  if (retainsAudio(result)) throw new RangeError('assessment results must not retain audio');
  if (result.quality?.status === 'rejected') throw new RangeError('a rejected take is not stored; repeat it');
  return { ...state, [timepoint]: { ...state[timepoint], [result.task]: result } };
}

const at = (state, timepoint, task, pick) => {
  const r = state[timepoint][task];
  return r ? pick(r) ?? null : null;
};

const levelUnit = (state, timepoint) => {
  const r = state[timepoint].VOWEL;
  if (!r) return null;
  return r.splDb !== null ? 'dB SPL' : 'dBFS';
};

/** PRE / POST / Δ rows of the table "Cambio acústico PRE–POST". No clinical cut-offs. */
export function comparisonRows(state) {
  const vas = (key, label) => ({ label, unit: '0-100', pick: (tp) => state[tp].vas[key] });
  const acoustic = (label, unit, task, pick) => ({ label, unit, pick: (tp) => at(state, tp, task, pick) });
  const sameLevelUnit = levelUnit(state, 'PRE') === levelUnit(state, 'POST');
  const rows = [
    { label: 'Esfuerzo (Borg CR10)', unit: '0-10', pick: (tp) => state[tp].borg ?? null },
    vas('fatigue', 'Fatiga (EVA)'),
    vas('dryness', 'Sequedad (EVA)'),
    vas('discomfort', 'Molestia (EVA)'),
    acoustic('CPPS /a/', 'dB', 'VOWEL', (r) => r.cpps),
    acoustic('CPPS texto', 'dB', 'SPEECH', (r) => r.cpps),
    acoustic('CPP /a/', 'dB', 'VOWEL', (r) => r.cpp),
    acoustic('HNR /a/', 'dB', 'VOWEL', (r) => r.hnr),
    acoustic('F0 mediana /a/', 'Hz', 'VOWEL', (r) => r.f0?.median),
    acoustic('F0 mediana texto', 'Hz', 'SPEECH', (r) => r.f0?.median),
    acoustic('F0 DE texto', 'st', 'SPEECH', (r) => r.f0?.sdSemitones),
    acoustic('Rango F0 texto (p5-p95)', 'st', 'SPEECH', (r) => r.f0?.rangeSemitones),
    acoustic('Jitter local /a/ (exploratorio)', '%', 'VOWEL', (r) => r.jitterLocal),
    acoustic('Shimmer local /a/ (exploratorio)', '%', 'VOWEL', (r) => r.shimmerLocal),
    acoustic('Nivel /a/', levelUnit(state, 'PRE') ?? levelUnit(state, 'POST') ?? 'dB', 'VOWEL', (r) => r.splDb ?? r.levelDbfs),
  ];
  return rows.map(({ label, unit, pick }) => {
    const pre = pick('PRE');
    const post = pick('POST');
    const comparable = label !== 'Nivel /a/' || sameLevelUnit;
    return { label, unit, pre, post, delta: pre !== null && post !== null && comparable ? post - pre : null };
  });
}

/** Restores a saved assessment; another day's (or a malformed) one starts fresh. */
export function restoreAssessment(json, today) {
  try {
    const state = JSON.parse(json);
    if (state?.date !== today || state.textId !== STANDARD_TEXT_ID) return createAssessment(today);
    for (const tp of TIMEPOINTS) {
      if (!state[tp]?.vas) return createAssessment(today);
      for (const task of TASKS) if (state[tp][task] && retainsAudio(state[tp][task])) return createAssessment(today);
      // A state saved before the Borg scale: its effort VAS is not a Borg rating, so it is dropped.
      const { effort: _effort, ...vas } = state[tp].vas;
      state[tp] = { ...state[tp], vas, borg: BORG_SCALE.some((o) => o.value === state[tp].borg) ? state[tp].borg : null };
    }
    return state;
  } catch {
    return createAssessment(today);
  }
}

/**
 * The part of the assessment kept in the workday record: the VAS other than fatigue (which goes
 * in workday.fatigue), the Borg CR10 effort as `effortBorg` and the results.
 */
export function workdayAssessment(state) {
  const vas = {};
  for (const item of VAS_ITEMS.filter((k) => k !== 'fatigue')) vas[item] = { pre: state.PRE.vas[item] ?? null, post: state.POST.vas[item] ?? null };
  const results = [];
  for (const timepoint of TIMEPOINTS) for (const task of TASKS) if (state[timepoint][task]) results.push({ timepoint, ...state[timepoint][task] });
  return { textId: state.textId, vas, effortBorg: { pre: state.PRE.borg ?? null, post: state.POST.borg ?? null }, results };
}
