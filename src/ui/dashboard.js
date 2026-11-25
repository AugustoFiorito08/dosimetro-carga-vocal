// Final dashboard (spec §12). Audio events only store data; every DOM and canvas
// update runs inside requestAnimationFrame, decoupled from the worklet messages.
import { createAudioManager } from '../audio/audio-manager.js';
import { MODES } from '../audio/session-controller.js';
import { hasUnsavedWork } from '../audio/session-lifecycle.js';
import { splFromPressure } from '../dsp/acoustic-calibration.js';
import { toDb } from '../dsp/signal-quality.js';
import { ALGORITHM_VERSION, csvFileName, downloadCsv, downloadCsvGzip, supportsGzip } from '../export/csv-exporter.js';
import { detectEvents } from '../store/auto-events.js';
import { buildWorkday, validateCode } from '../store/workday.js';
import { STANDARD_TEXT_ID } from '../store/voice-assessment.js';
import { createIndexedDbRepository } from '../store/workday-repository.js';
import { createIndexedDbOutbox } from '../store/outbox.js';
import { createSyncingRepository } from '../store/sync-service.js';
import { createOptInRepository } from '../store/sync-settings.js';
import { bindAutosaveTriggers, createWorkdayAutosaver, recoverCheckpoints } from '../store/workday-autosave.js';
import { createBoards } from './boards/boards.js';
import { preserveRecovery } from '../store/recovery.js';
import { createRecoveryNotifier } from '../store/recovery-reminders.js';
import { EVENT_LABELS } from './boards/views.js';
import { DEFAULT_MODEL_PARAMS, meanDuration, phonationPercentage } from '../vocal-load.js';
import { createLoadChart, zoneFor } from './load-chart.js';
import { createScoreChart } from './score-chart.js';
import { createScoreSeries } from './score-series.js';
import { createSecondSeries } from '../store/second-series.js';
import { createSyncPanel } from './sync-panel.js';
import { createVoiceAssessmentPanel } from './voice-assessment-panel.js';
import { createTeacherApp, initialView } from './teacher/teacher-app.js';

const CATEGORY_LABELS = {
  fonacion_atribuida: 'Fonación atribuida',
  voz_no_atribuida: 'Voz no atribuida',
  ruido_descartado: 'Ruido descartado',
  silencio: 'Silencio',
  senal_incierta: 'Señal incierta',
};
const ENGINE_TO_CATEGORY = {
  attributed: 'fonacion_atribuida',
  unattributed_voice: 'voz_no_atribuida',
  noise: 'ruido_descartado',
  silence: 'silencio',
  uncertain: 'senal_incierta',
};
const REASON_LABELS = {
  below_gate: 'Por debajo de la puerta de ruido',
  impulsive: 'Transitorio impulsivo',
  aperiodic: 'Señal aperiódica',
  out_of_band: 'Energía fuera de la banda vocal',
  weak_periodicity: 'Periodicidad insuficiente',
  low_snr: 'SNR insuficiente',
  speaker_mismatch: 'No coincide con el perfil',
  f0_out_of_range: 'Tono fuera del rango enrolado',
  no_profile: 'Sin perfil enrolado',
};
const MODE_LABELS = {
  [MODES.IDLE]: 'Listo',
  [MODES.CALIBRATING]: 'Calibrando ambiente',
  [MODES.ACOUSTIC_CALIBRATING]: 'Calibrando nivel',
  [MODES.ENROLLING]: 'Enrolando hablante',
  [MODES.REFERENCING]: 'Tomando referencia vocal',
  [MODES.RECORDING]: 'Grabando muestra (solo en memoria)',
  [MODES.MEASURING]: 'Midiendo',
  [MODES.PAUSED]: 'En pausa',
};
const DOSE_MODELS = ['none', 'linear', 'power', 'exponential', 'saturating'];
const DOSE_UNITS_TEXT = {
  calibrated: () => 'Presión calibrada en Pa.',
  normalized: (load) => `Intensidad relativa a tu voz normal (I = 1 a ${fixed(load.ownVoiceReferenceDbfs, 1)} dBFS): ciclos equivalentes a voz normal.`,
  relative: () => 'Unidades relativas (sin calibración de presión).',
};
const START_ERRORS = {
  distance_dose_needs_calibration:
    'No se inició la sesión: la dosis de distancia necesita la calibración acústica. Calibrá con el tono de referencia o elegí «Sin dosis de distancia».',
};
const INTERRUPTION_LABELS = {
  track_ended: 'el micrófono se desconectó o se revocó el permiso',
  context_suspended: 'el navegador suspendió el audio',
  context_interrupted: 'el sistema interrumpió el audio (llamada u otra app)',
  context_closed: 'el navegador cerró el audio',
};
const INTERRUPTION_ACTIONS = {
  paused: 'La sesión quedó en pausa y el hueco quedó marcado en la jornada.',
  cancelled: 'La tarea en curso se canceló; repetila cuando vuelva el audio.',
  none: '',
};
/** Hidden for less than this is not worth a notice when capture went on. */
const HIDDEN_NOTICE_MS = 5000;
const CALIBRATION_REASONS = {
  too_short: 'el tono fue demasiado corto',
  clipping: 'el tono satura la entrada; bajá la ganancia',
  silent: 'no se detectó el tono de referencia',
  unstable: 'el nivel del tono no fue estable',
};

const $ = (id) => document.getElementById(id);
const el = Object.fromEntries(
  [
    'device', 'connect', 'device-info', 'cal-ref', 'cal-pre', 'cal-post', 'cal-status', 'cal-drift', 'step-acoustic',
    'dd-profile', 'dd-method', 'dd-value', 'dd-unit', 'dd-status', 'step-distance', 'kpi-distance', 'kpi-distance-note',
    'calibrate', 'enroll', 'reference', 'reference-status', 'step-reference', 'threshold', 'threshold-value',
    'noise-floor', 'enrolment', 'step-calibrate', 'step-enroll', 'progress', 'progress-label',
    'progress-value', 'progress-bar', 'message', 'start', 'pause', 'resume', 'finish', 'export',
    'mode-dot', 'mode-label', 'session-clock', 'status-card', 'kpi-category', 'kpi-reason', 'kpi-f0',
    'kpi-snr', 'kpi-score', 'kpi-level', 'kpi-level-unit', 'kpi-phonation-pct', 'kpi-phonation-time',
    'kpi-nonphonation-time', 'kpi-total-time', 'kpi-episodes', 'kpi-pause', 'kpi-h', 'kpi-zone', 'dose-units',
    'd-received', 'd-processed', 'd-dropped', 'd-discontinuities', 'd-overruns', 'd-max-ms', 'd-format',
  ].map((id) => [id, $(id)]),
);
const doseRows = Object.fromEntries(
  DOSE_MODELS.map((m) => {
    const row = document.querySelector(`tr[data-model="${m}"]`);
    return [m, { dose: row.querySelector('[data-dose]'), ratio: row.querySelector('[data-ratio]') }];
  }),
);
const categoryTimes = Object.fromEntries(Object.keys(CATEGORY_LABELS).map((c) => [c, $(`t-${c}`)]));

const manager = createAudioManager();
const chart = createLoadChart($('load-chart'), { beta: DEFAULT_MODEL_PARAMS.beta });
let progress = null;
let busy = false;
let sessionStartedAt = null;
let microphoneLabel = '';
let teacher = null; // teacher view (src/ui/teacher), created once every action exists

// ---------- formatting ----------
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const fixed = (v, d = 1) => (isNum(v) ? v.toFixed(d) : '—');
const percent = (v) => `${Math.round(100 * v)} %`;
/** Below this estimated own-voice acceptance the enrolment is worth repeating (provisional). */
const LOW_PROFILE_QUALITY = 0.6;
function duration(seconds) {
  if (!isNum(seconds)) return '—';
  const s = Math.floor(seconds);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}
const dose = (v) => (!isNum(v) ? '—' : v < 1e6 ? v.toFixed(1) : v.toExponential(3));

/** textContent writes only when the value changed, to keep rAF frames cheap. */
function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}
function setAttr(node, name, value) {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

function say(text, tone = 'info') {
  el.message.textContent = text;
  el.message.dataset.tone = tone;
  teacher?.toast(text, tone);
}

// ---------- device & setup ----------
async function populateDevices() {
  const selected = el.device.value;
  const devices = await manager.listInputDevices();
  el.device.replaceChildren(
    new Option('Predeterminado del sistema', ''),
    ...devices.map((d) => new Option(d.label, d.deviceId, false, d.deviceId === selected)),
  );
}

// ---------- vocal-load score tab ----------
const SCORE_DOSE_NAMES = {
  none: 'D<sub>0</sub>', linear: 'D<sub>L</sub>', power: 'D<sub>P</sub>',
  exponential: 'D<sub>E</sub>', saturating: 'D<sub>S</sub>', distance: 'D<sub>d</sub>',
};
const scoreSeries = createScoreSeries();
/** Per-second phonated time and F0·I of the session, kept in the workday (perSecond). */
const secondSeries = createSecondSeries();
const score = createScoreChart($('tab-score'), { series: scoreSeries });
const scoreDose = $('score-dose');

function applyScoreDose() {
  const dose = scoreDose.value;
  const unit = dose === 'distance' ? 'm' : 'u';
  $('score-dose-name').innerHTML = SCORE_DOSE_NAMES[dose];
  setText($('score-dose-unit'), unit);
  setText($('score-rate-unit'), `${unit}/min`);
  score.configure({ dose, doseUnit: unit });
}
scoreDose.addEventListener('change', applyScoreDose);

function resetScore(load, startDate) {
  scoreSeries.reset();
  secondSeries.reset();
  const distanceOption = scoreDose.querySelector('option[value="distance"]');
  distanceOption.disabled = load.distanceDose === null;
  if (distanceOption.disabled && scoreDose.value === 'distance') scoreDose.value = 'none';
  const levelUnit = load.units === 'calibrated' ? 'dB SPL' : 'dBFS';
  setText($('score-level-unit'), levelUnit);
  $('score-empty').hidden = false;
  score.configure({ beta: load.params.beta, startDate, levelUnit });
  applyScoreDose();
}

function recordScoreFrame({ analysis: a, load, timestamp }) {
  const level = load.units === 'calibrated' && a.pressure > 0 ? splFromPressure(a.pressure) : a.levelDb;
  scoreSeries.push({
    t: timestamp, dt: a.dt, phi: a.phi, f0: a.phi ? a.f0 : null, level: a.phi ? level : null,
    h: load.h, doses: load.doses, distanceDose: load.distanceDose,
  });
  secondSeries.push({ dt: a.dt, phi: load.lastFrame?.phi ?? a.phi, f0: a.f0, intensity: load.lastFrame?.intensity ?? 0 });
  if (scoreSeries.length === 1) $('score-empty').hidden = true;
  score.invalidate();
}

// ---------- dashboards (Mi jornada, Dirección, Analítica) ----------
function downloadText(text, fileName, type) {
  const href = URL.createObjectURL(new Blob([text], { type }));
  const link = Object.assign(document.createElement('a'), { href, download: fileName });
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 0);
}
// Local workdays, plus the opt-in sync of their summaries (spec §14.1): saves are queued in
// the outbox only while the sync panel has it enabled.
const localWorkdays = createIndexedDbRepository();
const outbox = createIndexedDbOutbox();
const syncPanel = createSyncPanel({ $, outbox, repository: localWorkdays, onPurged: () => boards.refresh() });
// A rebuilt record of a saved workday keeps the recovery points recorded after it (hito 10).
const workdayRepository = preserveRecovery(createOptInRepository({
  repository: localWorkdays,
  syncingRepository: createSyncingRepository(localWorkdays, outbox, {
    onEnqueued: () => syncPanel.flush(),
    onError: (error) => say(`La jornada quedó guardada en este equipo, pero no se pudo encolar su envío: ${error.message}`, 'error'),
  }),
  isEnabled: syncPanel.isEnabled,
}));
// Recovery reminders (hito 10): a notification while the app is open, the in-app message
// otherwise; the calendar file covers the app being closed.
const recoveryNotifier = createRecoveryNotifier({
  list: () => workdayRepository.list(),
  notify: (r) => {
    const until = r.closesAt.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const body = `Registrá tu fatiga (${r.label}) en «Mi jornada». Se puede hasta las ${until}.`;
    say(`Recuperación: ${body}`);
    try {
      if (globalThis.Notification?.permission === 'granted') new Notification('VocalDose · fatiga vocal', { body, tag: `${r.workdayId}:${r.slot}` });
    } catch {
      // Some mobile browsers only notify through a service worker; the in-app message stays.
    }
  },
});
const refreshReminders = () => recoveryNotifier.refresh().catch(() => {});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshReminders();
});
refreshReminders();

const boards = createBoards({
  roots: { teacher: $('tab-teacher'), director: $('tab-director'), analytics: $('tab-analytics') },
  bar: $('board-bar'),
  repository: workdayRepository,
  download: downloadText,
  say,
  reminders: {
    async enable() {
      if (!globalThis.Notification) return 'unsupported';
      const permission = await Notification.requestPermission();
      refreshReminders();
      return permission;
    },
    refresh: refreshReminders,
  },
});

const tabs = [
  { button: $('tab-btn-live'), panel: $('tab-live') },
  { button: $('tab-btn-score'), panel: $('tab-score') },
  { button: $('tab-btn-teacher'), panel: $('tab-teacher'), board: 'teacher' },
  { button: $('tab-btn-director'), panel: $('tab-director'), board: 'director' },
  { button: $('tab-btn-analytics'), panel: $('tab-analytics'), board: 'analytics' },
];
let currentTab = 0;
function selectTab(index) {
  currentTab = index;
  tabs.forEach(({ button, panel }, i) => {
    const selected = i === index;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    panel.hidden = !selected;
  });
  if (index === 1) score.refresh();
  boards.show(tabs[index].board ?? null);
}

// ---------- workday form (codes, VAS, context events, save) ----------
const WORKDAY_FIELDS = ['jr-participant', 'jr-school', 'jr-classroom'];
let workdayEvents = [];
let workdaySaved = false;
for (const id of WORKDAY_FIELDS) {
  try { $(id).value = localStorage.getItem(`dosimetro.${id}`) ?? ''; } catch { /* storage unavailable */ }
  $(id).addEventListener('change', () => {
    try { localStorage.setItem(`dosimetro.${id}`, $(id).value.trim()); } catch { /* storage unavailable */ }
  });
}
const vasValue = (id) => {
  const raw = $(id).value.trim();
  if (raw === '') return null;
  const v = Number(raw);
  if (!(v >= 0 && v <= 100)) throw new RangeError('La EVA debe estar entre 0 y 100.');
  return v;
};
const eventLabel = (e) => (e.note?.startsWith('interrupcion:') ? `Interrupción de captura${e.durationS ? ` (${duration(e.durationS)})` : ''}` : EVENT_LABELS[e.type]);
function renderWorkdayEvents() {
  setText($('jr-events'), workdayEvents.length
    ? workdayEvents.map((e) => `${duration(e.t)} ${eventLabel(e)}`).join(' · ')
    : 'Sin eventos marcados.');
}
const assessment = createVoiceAssessmentPanel({
  $,
  say,
  getSession: () => manager.session,
  getMicrophone: () => microphoneLabel,
  getParticipant: () => validateCode('Docente', $('jr-participant').value.trim()),
  downloadCsv,
  csvFileName,
});
/** Context event marked by the teacher at the current session time. */
function markEvent(type) {
  const t = manager.session?.latest?.timestamp ?? 0;
  const event = { t, type, source: 'docente' };
  workdayEvents.push(event);
  renderWorkdayEvents();
  return event;
}
$('jr-event-add').addEventListener('click', () => markEvent($('jr-event-type').value));
/**
 * Workday of the current session. A checkpoint (lenient) skips an invalid VAS instead of
 * failing; the codes are always required, since they make the record id.
 */
function currentWorkday({ lenient = false } = {}) {
  const vas = (id) => {
    try { return vasValue(id); } catch (error) { if (lenient) return null; throw error; }
  };
  const meta = {
    participantId: validateCode('Docente', $('jr-participant').value.trim()),
    schoolId: validateCode('Escuela', $('jr-school').value.trim()),
    classroom: validateCode('Aula', $('jr-classroom').value.trim()),
    fatiguePre: vas('jr-pre'),
    fatiguePost: vas('jr-post'),
    events: [...workdayEvents, ...detectEvents(scoreSeries)].sort((a, b) => a.t - b.t),
    assessment: assessment.forWorkday(),
  };
  return buildWorkday({ meta, load: manager.session.load, series: scoreSeries, seconds: secondSeries, startedAt: sessionStartedAt, algorithmVersion: ALGORITHM_VERSION, source: 'live' });
}
/** Saves the workday of the last session; resolves to it, or null when it could not be saved. */
async function saveWorkday() {
  try {
    const workday = currentWorkday();
    if (autosave) {
      await autosave.finalize(workday); // waits for a checkpoint in flight, then writes the clean record
      boards.refresh();
    } else {
      await boards.save(workday);
    }
    workdaySaved = true;
    refreshReminders();
    setText($('jr-status'), `Guardada ${workday.id}`);
    say(`Jornada guardada (${workday.events.length} eventos). Ya aparece en Mi jornada, Dirección y Analítica. En «Mi jornada» registrá tu fatiga a los 30 min, 1 h, 2 h y 4 h de terminar, y a la mañana siguiente; ahí podés agregar esos horarios a tu calendario.`);
    return workday;
  } catch (error) {
    say(`No se pudo guardar la jornada: ${error.message.includes('code of') ? 'completá docente, escuela y aula con códigos (letras, números, «.», «-» o «_», sin espacios).' : error.message}`, 'error');
    return null;
  }
}
/**
 * The technical view warns when the acoustic voice takes or the Borg effort of a timepoint are
 * missing, but lets the user go on (testing and calibration sessions); the teacher view requires them.
 */
function confirmMissingSamples(timepoint) {
  const missing = [
    ...(assessment.samplesDone(timepoint) ? [] : ['las pruebas de voz (vocal /a/ y lectura del texto)']),
    ...($(`va-${timepoint.toLowerCase()}-borg`).value !== '' ? [] : ['el esfuerzo (Borg CR10)']),
  ];
  if (!missing.length) return true;
  const when = timepoint === 'PRE' ? 'antes de empezar' : 'al terminar';
  // eslint-disable-next-line no-alert
  return window.confirm(`Faltan ${missing.join(' y ')} ${when}. ¿Seguir de todos modos?`);
}
$('jr-save').addEventListener('click', () => (confirmMissingSamples('POST') ? saveWorkday() : null));
tabs.forEach(({ button }, i) => {
  button.addEventListener('click', () => selectTab(i));
  button.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const next = (i + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
    selectTab(next);
    tabs[next].button.focus();
  });
});

function onSessionEvent(event) {
  if (event.type === 'progress') progress = event;
  else if (event.type === 'frame') {
    const category = event.analysis.category;
    chart.push(event.timestamp, event.load.h, category);
    recordScoreFrame(event);
  }
}

/** Opens the chosen microphone; resolves true when connected. */
async function connectMicrophone() {
  busy = true;
  try {
    const info = await manager.open({ deviceId: el.device.value || undefined });
    info.session.subscribe(onSessionEvent);
    info.session.setCaptureSettings(info.trackSettings); // recorded with each session (AGC, spec §10.1)
    info.session.setSimilarityThreshold(Number(el.threshold.value));
    const s = info.trackSettings;
    microphoneLabel = info.deviceLabel || '';
    const processed = ['echoCancellation', 'noiseSuppression', 'autoGainControl'].filter((k) => s[k] === true);
    setText(
      el['device-info'],
      processed.length
        ? `${info.deviceLabel} · el navegador mantiene activo: ${processed.join(', ')}`
        : `${info.deviceLabel || 'Micrófono'} · captura sin procesar`,
    );
    setText(el['d-format'], `${info.sampleRate} Hz · tramas de ${info.frameSize} muestras (${fixed((1000 * info.frameSize) / info.sampleRate, 1)} ms)`);
    await populateDevices();
    say('Micrófono conectado. Calibrá el ambiente en silencio.');
    return true;
  } catch (error) {
    say(`No se pudo conectar el micrófono: ${error.message}`, 'error');
    return false;
  } finally {
    busy = false;
  }
}
el.connect.addEventListener('click', connectMicrophone);

el.threshold.addEventListener('input', () => {
  setText(el['threshold-value'], Number(el.threshold.value).toFixed(2));
  manager.session?.setSimilarityThreshold(Number(el.threshold.value));
});

async function runTask(label, fn, done) {
  try {
    say(`${label} en curso…`);
    const result = await fn();
    say(done(result));
    return true;
  } catch (error) {
    say(`${label}: ${error.message}`, 'error');
    return false;
  } finally {
    progress = null;
  }
}

const calibrationMessage = (error) => CALIBRATION_REASONS[error.reason] ?? error.message;

async function runCalibration(phase) {
  const referenceDbSpl = Number(el['cal-ref'].value);
  if (!(referenceDbSpl >= 60 && referenceDbSpl <= 140)) return say('Ingresá un nivel de referencia entre 60 y 140 dB SPL.', 'error');
  try {
    say(phase === 'pre' ? 'Calibración acústica en curso…' : 'Verificación de calibración en curso…');
    const cal = await manager.session.calibrateAcoustic({ referenceDbSpl, phase });
    if (phase === 'pre') {
      say(`Calibración aplicada: C = ${fixed(cal.coefficient, 3)} Pa por unidad digital. Se usa desde la próxima sesión.`);
    } else {
      const d = manager.session.calibrationDrift;
      say(d.withinTolerance ? 'Deriva dentro de la tolerancia. Exportá el CSV para incluirla.' : 'Deriva fuera de tolerancia: la sesión puede no ser válida.', d.withinTolerance ? 'info' : 'error');
    }
  } catch (error) {
    say(`Calibración acústica: ${calibrationMessage(error)}`, 'error');
  } finally {
    progress = null;
  }
}

el['cal-pre'].addEventListener('click', () => runCalibration('pre'));
el['cal-post'].addEventListener('click', () => runCalibration('post'));

const calibrateAmbient = () =>
  runTask('Calibración', () => manager.session.calibrate(), (rms) => `Ambiente calibrado: ${fixed(toDb(rms), 1)} dBFS. Ahora enrolá la voz.`);
el.calibrate.addEventListener('click', calibrateAmbient);
const enrollSpeaker = () =>
  runTask('Enrolamiento', () => manager.session.enroll(), () => {
    const quality = manager.session.profileQuality;
    if (quality !== null && quality < LOW_PROFILE_QUALITY) {
      return `Perfil creado, pero reconoce solo el ${percent(quality)} de tu voz de prueba. Conviene repetir el enrolamiento: 15 s continuos, primero voz normal y después en voz alta.`;
    }
    const range = manager.session.profile?.f0Range;
    const f0 = range ? ` Tu tono: ${Math.round(range.low)}-${Math.round(range.high)} Hz.` : '';
    const next = manager.session.acousticCalibration ? 'Ya podés iniciar.' : 'Ahora tomá la referencia vocal.';
    return `Perfil creado${quality === null ? '' : `: reconoce el ${percent(quality)} de tu voz de prueba`}.${f0} ${next}`;
  });
el.enroll.addEventListener('click', enrollSpeaker);

/** P90 - P10 of the reference reading: how steady the habitual voice was (spec §10.1). */
const referenceSpread = (ref) => ref.p90Dbfs - ref.p10Dbfs;

/** Standardised habitual-voice reading (spec §10.1); resolves true when the reference was taken. */
async function takeReference() {
  try {
    say('Referencia vocal en curso: leé el texto con tu voz habitual…');
    const ref = await manager.session.captureVoiceReference({ textId: STANDARD_TEXT_ID });
    say(`Referencia tomada: ${fixed(ref.levelDbfs, 1)} dBFS (P10–P90: ${fixed(referenceSpread(ref), 1)} dB, ${fixed(ref.validS, 1)} s de tu voz). Ya podés iniciar.`);
    return true;
  } catch (error) {
    say(error.code === 'reference_too_short'
      ? 'Referencia vocal: se reconoció muy poco de tu voz. Repetila leyendo el texto de corrido durante los 30 s.'
      : `Referencia vocal: ${error.message}`, 'error');
    return false;
  } finally {
    progress = null;
  }
}
el.reference.addEventListener('click', takeReference);

/** Why D_d is (not) shown, so an empty value is never silent. */
function distanceDoseNote(load) {
  if (load.distanceDose !== null) {
    return load.distanceDoseOptions.offsetSource === 'measured' ? 'SPL a 50 cm medido' : 'SPL a 50 cm estimado por distancia (aprox.)';
  }
  return load.units === 'calibrated' ? 'Sin perfil: elegilo antes de iniciar' : 'Sesión sin calibración acústica';
}

function distanceDoseOptionsFromForm() {
  const profile = el['dd-profile'].value;
  if (!profile) return null;
  const value = Number(el['dd-value'].value);
  return el['dd-method'].value === 'measured'
    ? { profile, spl50cmOffsetDb: value }
    : { profile, mouthDistanceM: value / 100 };
}

el['dd-method'].addEventListener('change', () => {
  const measured = el['dd-method'].value === 'measured';
  setText(el['dd-unit'], measured ? 'dB' : 'cm');
  el['dd-value'].value = measured ? '20' : '5';
});

// ---------- capture lifecycle (microphone, AudioContext, visibility, exit) ----------
let openGap = null; // workday event of the interruption in course, closed when audio returns
function onLifecycleEvent(event) {
  if (event.type === 'interrupted') {
    if (event.action === 'paused') {
      openGap = { t: event.timestamp ?? 0, type: 'otro', source: 'algoritmo', note: `interrupcion:${event.reason}` };
      workdayEvents.push(openGap);
      renderWorkdayEvents();
    }
    const next = event.reason === 'track_ended'
      ? ' Finalizá y guardá la jornada; reconectar el micrófono inicia una sesión nueva.'
      : event.action === 'paused' ? ' Cuando vuelva el audio, tocá Continuar.' : '';
    say(`Captura interrumpida: ${INTERRUPTION_LABELS[event.reason]}. ${INTERRUPTION_ACTIONS[event.action]}${next}`, 'error');
  } else if (event.type === 'restored') {
    if (openGap) openGap.durationS = event.interruptedMs / 1000;
    openGap = null;
    renderWorkdayEvents();
    const paused = manager.session?.mode === MODES.PAUSED;
    say(`El audio volvió tras ${duration(event.interruptedMs / 1000)} sin captura.${paused ? ' La sesión sigue en pausa: tocá Continuar.' : ''}`);
  } else if (event.type === 'visible' && !manager.interruption && event.hiddenMs >= HIDDEN_NOTICE_MS) {
    const measuring = manager.session?.mode === MODES.MEASURING;
    if (measuring && event.capturing) say(`La página estuvo ${duration(event.hiddenMs / 1000)} en segundo plano; la captura siguió.`);
  } else if (event.type === 'visible' && manager.interruption) {
    say(`La captura sigue detenida: ${INTERRUPTION_LABELS[manager.interruption.reason]}.`, 'error');
  }
}
manager.onLifecycle(onLifecycleEvent);
// Checkpoint before the browser may freeze or kill the page.
bindAutosaveTriggers({ onLifecycle: manager.onLifecycle, page: window, getAutosave: () => autosave });

// ---------- workday autosave (checkpoints in IndexedDB, spec §12.2) ----------
let autosave = null; // autosaver of the current / last session
let autosaveWarned = false;
function startAutosave() {
  autosaveWarned = false;
  autosave = createWorkdayAutosaver({
    repository: workdayRepository,
    snapshot: () => currentWorkday({ lenient: true }),
    onError(error) {
      if (autosaveWarned) return;
      autosaveWarned = true;
      const codes = error.message.includes('code of');
      say(codes
        ? 'Autoguardado inactivo: completá docente, escuela y aula con códigos para que la jornada se guarde sola.'
        : `No se pudo autoguardar la jornada: ${error.message}`, 'error');
    },
  });
  autosave.start();
}
recoverCheckpoints(workdayRepository)
  .then((lost) => {
    if (lost.length === 0) return;
    const at = (w) => new Date(w.checkpoint.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    say(`Se recuperó${lost.length > 1 ? 'n' : ''} ${lost.map((w) => `${w.id} (autoguardada ${at(w)})`).join(', ')}: la sesión se cerró sin guardar. Ya aparece en los tableros.`);
    boards.refresh();
  })
  .catch((error) => say(`No se pudieron revisar las jornadas autoguardadas: ${error.message}`, 'error'));

window.addEventListener('beforeunload', (event) => {
  if (!hasUnsavedWork({ session: manager.session, workdaySaved })) return;
  event.preventDefault();
  event.returnValue = ''; // older browsers need it to show the standard prompt
});

// ---------- session controls ----------
/** Starts a measuring session; resolves true when it started. */
async function startSession() {
  if (hasUnsavedWork({ session: manager.session, workdaySaved })) {
    if (!window.confirm('La sesión anterior no se guardó como jornada. ¿Descartarla e iniciar una nueva?')) return false;
    try {
      await autosave?.discard();
    } catch (error) {
      say(`No se pudo descartar el autoguardado anterior: ${error.message}`, 'error');
      return false;
    }
  }
  try {
    manager.session.setDistanceDoseOptions(distanceDoseOptionsFromForm());
    const load = manager.session.start();
    chart.reset({ beta: load.params.beta });
    sessionStartedAt = new Date();
    resetScore(load, sessionStartedAt);
    workdayEvents = [];
    openGap = null;
    workdaySaved = false;
    manager.keepAwake(true);
    startAutosave();
    renderWorkdayEvents();
    setText($('jr-status'), 'Midiendo…');
    setText(el['dose-units'], DOSE_UNITS_TEXT[load.units](load));
    say('Sesión en curso.');
    return true;
  } catch (error) {
    say(START_ERRORS[error.code] ?? error.message, 'error');
    return false;
  }
}
el.start.addEventListener('click', () => (confirmMissingSamples('PRE') ? startSession() : null));
function pauseSession() {
  manager.session.pause();
  manager.keepAwake(false);
  autosave?.checkpoint();
  say('Sesión en pausa. Podés continuar o exportar lo registrado hasta ahora.');
}
el.pause.addEventListener('click', pauseSession);
/** Must run from a user gesture, so a suspended audio context can be resumed. */
async function resumeSession() {
  if (manager.interruption && !(await manager.resumeContext())) {
    say(`No se puede continuar: ${INTERRUPTION_LABELS[manager.interruption.reason]}.`, 'error');
    return false;
  }
  manager.session.resume();
  manager.keepAwake(true);
  say('Sesión en curso.');
  return true;
}
el.resume.addEventListener('click', resumeSession);
function finishSession() {
  manager.session.stop();
  manager.keepAwake(false);
  autosave?.stop();
  autosave?.checkpoint(); // kept until the manual save replaces it or the session is discarded
  say(`Sesión finalizada: ${manager.session.recordCount} tramas registradas. Exportá el CSV para conservarlas.`);
}
el.finish.addEventListener('click', finishSession);
// Optional .csv.gz: the plain .csv stays the default; without CompressionStream the option is off.
const gzipOption = $('export-gzip');
if (!supportsGzip()) {
  gzipOption.disabled = true;
  gzipOption.parentElement.title = 'Este navegador no puede comprimir: se exporta el .csv sin comprimir.';
}
let exporting = false;
el.export.addEventListener('click', async () => {
  const chunks = manager.session?.exportCsvChunks(); // pieces of ~10 000 rows, never one huge string
  if (!chunks) return say('No hay tramas registradas para exportar.', 'error');
  const fileName = csvFileName(sessionStartedAt ?? new Date());
  if (!gzipOption.checked) return say(`CSV exportado: ${downloadCsv(chunks, { fileName })}`);
  exporting = true;
  say('Comprimiendo el CSV…');
  try {
    const result = await downloadCsvGzip(chunks, { fileName });
    if (result.compressed) say(`CSV comprimido exportado: ${result.fileName}`);
    else say(`No se pudo comprimir (${result.reason === 'unsupported' ? 'el navegador no lo permite' : result.error.message}); se exportó sin comprimir: ${result.fileName}`, 'error');
  } finally {
    exporting = false;
  }
});

// ---------- render loop ----------
function renderControls(session) {
  const mode = session?.mode ?? null;
  const idle = mode === MODES.IDLE;
  el.connect.disabled = busy || (mode !== null && !idle);
  el.device.disabled = el.connect.disabled;
  el.calibrate.disabled = !idle;
  el['cal-ref'].disabled = !idle;
  el['cal-pre'].disabled = !idle;
  el['cal-post'].disabled = !idle || !session?.sessionCalibration || !session.recordCount;
  const ddOn = Boolean(el['dd-profile'].value);
  el['dd-profile'].disabled = !idle;
  el['dd-method'].disabled = !idle || !ddOn;
  el['dd-value'].disabled = !idle || !ddOn;
  el.enroll.disabled = !idle || session.noiseFloorRms === null;
  el.threshold.disabled = mode === MODES.MEASURING || mode === MODES.PAUSED;
  el.reference.disabled = !idle || session.profile === null;
  el.start.disabled = !idle || session.profile === null || (session.acousticCalibration === null && session.voiceReference === null);
  el.pause.disabled = mode !== MODES.MEASURING;
  el.resume.disabled = mode !== MODES.PAUSED;
  el.finish.disabled = mode !== MODES.MEASURING && mode !== MODES.PAUSED;
  el.export.disabled = exporting || !(idle || mode === MODES.PAUSED) || !session?.recordCount;
  const measuring = mode === MODES.MEASURING || mode === MODES.PAUSED;
  $('jr-event-type').disabled = !measuring;
  $('jr-event-add').disabled = !measuring;
  $('jr-save').disabled = !idle || !session?.recordCount || workdaySaved || !sessionStartedAt;
  if (measuring && autosave?.lastSavedAt) {
    setText($('jr-status'), `Midiendo… · autoguardada ${autosave.lastSavedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
  }
  assessment.renderControls(session);

  setAttr(el['mode-dot'], 'data-mode', mode ?? 'none');
  const interrupted = mode !== null && manager.interruption !== null;
  setText(el['mode-label'], mode ? `${MODE_LABELS[mode]}${interrupted ? ' · captura interrumpida' : ''}` : 'Sin audio');

  if (session) {
    const cal = session.acousticCalibration;
    setText(el['cal-status'], cal ? `${fixed(cal.referenceDbSpl, 1)} dB SPL · C = ${fixed(cal.coefficient, 3)}` : 'Sin calibrar');
    setAttr(el['step-acoustic'], 'data-done', String(cal !== null));
    const drift = session.calibrationDrift;
    if (drift) {
      setText(el['cal-drift'], `Deriva post: ${fixed(drift.db, 2)} dB (${fixed(drift.percent, 1)} %) · tolerancia ±${drift.toleranceDb} dB`);
      setAttr(el['cal-drift'], 'data-alert', String(!drift.withinTolerance));
    }
    setText(el['dd-status'], !ddOn ? 'Desactivada' : cal ? 'Lista' : 'Falta calibrar');
    setAttr(el['step-distance'], 'data-done', String(ddOn && cal !== null));
    setText(el['noise-floor'], session.noiseFloorRms === null ? 'Sin medir' : `${fixed(toDb(session.noiseFloorRms), 1)} dBFS`);
    setAttr(el['step-calibrate'], 'data-done', String(session.noiseFloorRms !== null));
    const quality = session.profileQuality;
    setText(el.enrolment, !session.profile ? 'Sin perfil' : quality === null ? `${session.profile.prototypes.length} prototipos` : `Reconoce ${percent(quality)} de tu voz`);
    setAttr(el['step-enroll'], 'data-done', String(session.profile !== null));
    const ref = session.voiceReference;
    setText(el['reference-status'], ref ? `${fixed(ref.levelDbfs, 1)} dBFS · P10–P90 ${fixed(referenceSpread(ref), 1)} dB` : session.acousticCalibration ? 'No hace falta (calibrado)' : 'Sin tomar');
    setAttr(el['step-reference'], 'data-done', String(ref !== null));
  }

  if (progress?.mode === MODES.RECORDING && session?.mode !== MODES.RECORDING) progress = null; // take finished or cancelled
  el.progress.hidden = !progress;
  if (progress) {
    const enrolling = progress.mode === MODES.ENROLLING;
    const done = enrolling ? progress.validTime : progress.elapsed;
    // Guided enrolment: the profile must cover the raised classroom voice too (spec §6.1).
    const enrolPhase = done < progress.target / 2 ? 'Voz normal' : 'Ahora en voz alta';
    const recordingPhase = done < progress.leadInSeconds ? 'Silencio' : 'Grabando (solo en memoria)';
    const label = enrolling
      ? enrolPhase
      : progress.mode === MODES.REFERENCING
        ? 'Leé el texto con tu voz habitual'
        : progress.mode === MODES.RECORDING
        ? recordingPhase
        : progress.mode === MODES.ACOUSTIC_CALIBRATING ? 'Tono de referencia' : 'Ambiente';
    setText(el['progress-label'], label);
    setText(el['progress-value'], `${fixed(done, 1)} / ${progress.target} s`);
    el['progress-bar'].style.width = `${Math.min(100, (100 * done) / progress.target)}%`;
  }
}

function renderLive(session) {
  const load = session?.load;
  const enrolling = session?.mode === MODES.ENROLLING;
  // Outside enrolment, only frames of a measuring session are shown: the last
  // enrolment frame (classified without a profile) must not linger as "voz no atribuida".
  const a = enrolling || load || session?.mode === MODES.REFERENCING ? session.latest?.analysis : undefined;
  const validForProfile = enrolling && a?.V === 1 && a?.Q === 1;
  const category = validForProfile ? 'fonacion_atribuida' : a?.category ?? 'none';
  setAttr(el['status-card'], 'data-category', category);
  setText(el['kpi-category'], validForProfile ? 'Voz válida para el perfil' : CATEGORY_LABELS[category] ?? '—');
  const reason = enrolling ? (validForProfile ? null : a?.rejectionReason === 'no_profile' ? null : a?.rejectionReason) : a?.rejectionReason;
  setText(el['kpi-reason'], enrolling && !reason ? 'Enrolando…' : reason ? REASON_LABELS[reason] ?? reason : ' ');
  setText(el['kpi-f0'], fixed(a?.f0, 1));
  setText(el['kpi-snr'], fixed(a?.snrDb, 1));
  setText(el['kpi-score'], fixed(a?.speakerScore, 2));
  const calibrated = load?.units === 'calibrated';
  setText(el['kpi-level'], fixed(calibrated && a?.pressure > 0 ? splFromPressure(a.pressure) : a?.levelDb, 1));
  setText(el['kpi-level-unit'], calibrated ? 'dB SPL' : 'dBFS');

  if (!load) return;
  const m = load.metrics;
  setText(el['session-clock'], duration(m.totalTime));
  setText(el['kpi-phonation-pct'], fixed(phonationPercentage(m), 1));
  setText(el['kpi-phonation-time'], duration(m.phonationTime));
  setText(el['kpi-nonphonation-time'], duration(m.nonPhonationTime));
  setText(el['kpi-total-time'], duration(m.totalTime));
  setText(el['kpi-episodes'], String(m.episodes.count));
  setText(el['kpi-distance'], fixed(load.distanceDose, 2));
  setText(el['kpi-distance-note'], distanceDoseNote(load));
  setText(el['kpi-pause'], m.pauses.count ? fixed(meanDuration(m.pauses), 1) : '—');
  setText(el['kpi-h'], fixed(load.h, 1));
  setText(el['kpi-zone'], zoneFor(load.h, load.params.beta).label.toLowerCase());
  for (const [engineName, seconds] of Object.entries(m.timeByCategory)) {
    setText(categoryTimes[ENGINE_TO_CATEGORY[engineName]], `${fixed(seconds, 0)} s`);
  }
  const base = load.doses.none;
  for (const model of DOSE_MODELS) {
    setText(doseRows[model].dose, dose(load.doses[model]));
    setText(doseRows[model].ratio, base > 0 ? `× ${load.doses[model] / base >= 100 ? (load.doses[model] / base).toExponential(2) : (load.doses[model] / base).toFixed(3)}` : '—');
  }
}

function renderDiagnostics(session) {
  if (!session) return;
  const s = session.stats;
  setText(el['d-received'], String(s.framesReceived));
  setText(el['d-processed'], String(s.framesProcessed));
  setText(el['d-dropped'], String(s.droppedFrames));
  setText(el['d-discontinuities'], String(s.discontinuities));
  setText(el['d-overruns'], String(s.overruns));
  setText(el['d-max-ms'], fixed(s.maxProcessingMs, 1));
  setAttr(el['d-dropped'], 'data-alert', String(s.droppedFrames > 0));
  setAttr(el['d-discontinuities'], 'data-alert', String(s.discontinuities > 0));
  setAttr(el['d-overruns'], 'data-alert', String(s.overruns > 0));
}

function render() {
  const session = manager.session;
  renderControls(session);
  renderLive(session);
  renderDiagnostics(session);
  teacher?.render();
  requestAnimationFrame(render);
}

// ---------- teacher view (odd/tasks/vista-docente-movil.md) ----------
teacher = createTeacherApp({
  root: $('teacher-app'),
  $,
  actions: {
    connectMicrophone, calibrateAmbient, enrollSpeaker, takeReference, startSession,
    pauseSession, resumeSession, finishSession, markEvent, saveWorkday,
  },
  getSession: () => manager.session,
  getProgress: () => progress,
  isSaved: () => workdaySaved,
  samplesDone: (timepoint) => assessment.samplesDone(timepoint),
  getInterruption: () => manager.interruption,
  scoreSeries,
  adopt: { score: $('tab-score'), 'teacher-board': $('tab-teacher') },
  boards,
  repository: workdayRepository,
  outbox,
  isSyncEnabled: syncPanel.isEnabled,
  onView: (view) => { if (view === 'technical') selectTab(currentTab); },
  onScoreShown: () => score.refresh(),
  getEvents: () => workdayEvents,
  getStartedAt: () => sessionStartedAt,
});
$('to-teacher').addEventListener('click', () => teacher.setView('teacher'));
teacher.setView(initialView());

populateDevices().catch((error) => say(error.message, 'error'));
chart.start();
requestAnimationFrame(render);
