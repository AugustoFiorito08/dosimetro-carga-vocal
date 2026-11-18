// Final dashboard (spec §12). Audio events only store data; every DOM and canvas
// update runs inside requestAnimationFrame, decoupled from the worklet messages.
import { createAudioManager } from '../audio/audio-manager.js';
import { MODES } from '../audio/session-controller.js';
import { splFromPressure } from '../dsp/acoustic-calibration.js';
import { toDb } from '../dsp/signal-quality.js';
import { csvFileName, downloadCsv } from '../export/csv-exporter.js';
import { DEFAULT_MODEL_PARAMS, meanDuration, phonationPercentage } from '../vocal-load.js';
import { createLoadChart, zoneFor } from './load-chart.js';

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
  no_profile: 'Sin perfil enrolado',
};
const MODE_LABELS = {
  [MODES.IDLE]: 'Listo',
  [MODES.CALIBRATING]: 'Calibrando ambiente',
  [MODES.ACOUSTIC_CALIBRATING]: 'Calibrando nivel',
  [MODES.ENROLLING]: 'Enrolando hablante',
  [MODES.MEASURING]: 'Midiendo',
  [MODES.PAUSED]: 'En pausa',
};
const DOSE_MODELS = ['none', 'linear', 'power', 'exponential', 'saturating'];
const START_ERRORS = {
  distance_dose_needs_calibration:
    'No se inició la sesión: la dosis de distancia necesita la calibración acústica. Calibrá con el tono de referencia o elegí «Sin dosis de distancia».',
};
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
    'calibrate', 'enroll', 'threshold', 'threshold-value',
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

// ---------- formatting ----------
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const fixed = (v, d = 1) => (isNum(v) ? v.toFixed(d) : '—');
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

function onSessionEvent(event) {
  if (event.type === 'progress') progress = event;
  else if (event.type === 'frame') {
    const category = event.analysis.category;
    chart.push(event.timestamp, event.load.h, category);
  }
}

el.connect.addEventListener('click', async () => {
  busy = true;
  try {
    const info = await manager.open({ deviceId: el.device.value || undefined });
    info.session.subscribe(onSessionEvent);
    info.session.setSimilarityThreshold(Number(el.threshold.value));
    const s = info.trackSettings;
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
  } catch (error) {
    say(`No se pudo conectar el micrófono: ${error.message}`, 'error');
  } finally {
    busy = false;
  }
});

el.threshold.addEventListener('input', () => {
  setText(el['threshold-value'], Number(el.threshold.value).toFixed(2));
  manager.session?.setSimilarityThreshold(Number(el.threshold.value));
});

async function runTask(label, fn, done) {
  try {
    say(`${label} en curso…`);
    const result = await fn();
    say(done(result));
  } catch (error) {
    say(`${label}: ${error.message}`, 'error');
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

el.calibrate.addEventListener('click', () =>
  runTask('Calibración', () => manager.session.calibrate(), (rms) => `Ambiente calibrado: ${fixed(toDb(rms), 1)} dBFS. Ahora enrolá la voz.`),
);
el.enroll.addEventListener('click', () =>
  runTask('Enrolamiento', () => manager.session.enroll(), (p) => `Perfil creado con ${p.prototypes.length} prototipos. Ya podés iniciar.`),
);

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

// ---------- session controls ----------
el.start.addEventListener('click', () => {
  try {
    manager.session.setDistanceDoseOptions(distanceDoseOptionsFromForm());
    const load = manager.session.start();
    chart.reset({ beta: load.params.beta });
    sessionStartedAt = new Date();
    setText(el['dose-units'], load.units === 'relative' ? 'Unidades relativas (sin calibración de presión).' : 'Presión calibrada en Pa.');
    say('Sesión en curso.');
  } catch (error) {
    say(START_ERRORS[error.code] ?? error.message, 'error');
  }
});
el.pause.addEventListener('click', () => {
  manager.session.pause();
  say('Sesión en pausa. Podés continuar o exportar lo registrado hasta ahora.');
});
el.resume.addEventListener('click', () => {
  manager.session.resume();
  say('Sesión en curso.');
});
el.finish.addEventListener('click', () => {
  manager.session.stop();
  say(`Sesión finalizada: ${manager.session.recordCount} tramas registradas. Exportá el CSV para conservarlas.`);
});
el.export.addEventListener('click', () => {
  const csv = manager.session?.exportCsv();
  if (!csv) return say('No hay tramas registradas para exportar.', 'error');
  const name = downloadCsv(csv, { fileName: csvFileName(sessionStartedAt ?? new Date()) });
  say(`CSV exportado: ${name}`);
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
  el.start.disabled = !idle || session.profile === null;
  el.pause.disabled = mode !== MODES.MEASURING;
  el.resume.disabled = mode !== MODES.PAUSED;
  el.finish.disabled = mode !== MODES.MEASURING && mode !== MODES.PAUSED;
  el.export.disabled = !(idle || mode === MODES.PAUSED) || !session?.recordCount;

  setAttr(el['mode-dot'], 'data-mode', mode ?? 'none');
  setText(el['mode-label'], mode ? MODE_LABELS[mode] : 'Sin audio');

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
    setText(el.enrolment, session.profile ? `${session.profile.prototypes.length} prototipos` : 'Sin perfil');
    setAttr(el['step-enroll'], 'data-done', String(session.profile !== null));
  }

  el.progress.hidden = !progress;
  if (progress) {
    const enrolling = progress.validTime !== undefined;
    const done = enrolling ? progress.validTime : progress.elapsed;
    const label = enrolling ? 'Voz válida' : progress.mode === MODES.ACOUSTIC_CALIBRATING ? 'Tono de referencia' : 'Ambiente';
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
  const a = enrolling || load ? session.latest?.analysis : undefined;
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
  requestAnimationFrame(render);
}

populateDevices().catch((error) => say(error.message, 'error'));
chart.start();
requestAnimationFrame(render);
