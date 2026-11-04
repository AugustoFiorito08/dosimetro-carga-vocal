// Minimal diagnostic harness for public/index.html (not the final UI).
import { createAudioManager } from './audio/audio-manager.js';
import { MODES } from './audio/session-controller.js';
import { toDb } from './dsp/signal-quality.js';
import { phonationPercentage } from './vocal-load.js';

const $ = (id) => document.getElementById(id);
const ui = {
  device: $('device'),
  init: $('init'),
  calibrate: $('calibrate'),
  enroll: $('enroll'),
  start: $('start'),
  stop: $('stop'),
  sampleRate: $('sample-rate'),
  frameSize: $('frame-size'),
  trackSettings: $('track-settings'),
  noiseFloor: $('noise-floor'),
  enrolment: $('enrolment'),
  mode: $('mode'),
  message: $('message'),
  monitor: $('monitor'),
};

const manager = createAudioManager();
let progress = null;

const fmt = (value, digits = 2) => (value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(digits));

function say(text, isError = false) {
  ui.message.textContent = text;
  ui.message.className = isError ? 'error' : '';
}

async function populateDevices() {
  const selected = ui.device.value;
  const devices = await manager.listInputDevices();
  ui.device.replaceChildren(
    new Option('(predeterminado)', ''),
    ...devices.map((d) => new Option(d.label, d.deviceId, false, d.deviceId === selected)),
  );
}

function refreshButtons() {
  const session = manager.session;
  const mode = session?.mode ?? null;
  const idle = mode === MODES.IDLE;
  ui.calibrate.disabled = !idle;
  ui.enroll.disabled = !idle || session.noiseFloorRms === null;
  ui.start.disabled = !idle || session.profile === null;
  ui.stop.disabled = !session || idle;
  ui.mode.textContent = mode ?? '—';
}

function refreshStatus() {
  const session = manager.session;
  if (!session) return;
  ui.noiseFloor.textContent =
    session.noiseFloorRms === null ? 'sin calibrar' : `${session.noiseFloorRms.toExponential(2)} RMS (${fmt(toDb(session.noiseFloorRms), 1)} dBFS)`;
  ui.enrolment.textContent = session.profile
    ? `${session.profile.prototypes.length} prototipos activos (${session.profile.counts.reduce((a, b) => a + b, 0)} tramas)`
    : 'sin perfil';
  refreshButtons();
}

async function runTask(label, fn) {
  try {
    say(`${label}…`);
    const promise = fn();
    refreshButtons();
    await promise;
    say(`${label}: completado.`);
  } catch (error) {
    say(`${label}: ${error.message}`, true);
  } finally {
    progress = null;
    refreshStatus();
  }
}

ui.init.addEventListener('click', async () => {
  try {
    ui.init.disabled = true;
    const info = await manager.open({ deviceId: ui.device.value || undefined });
    ui.sampleRate.textContent = `${info.sampleRate} Hz`;
    ui.frameSize.textContent = `${info.frameSize} muestras (${fmt((1000 * info.frameSize) / info.sampleRate, 1)} ms)`;
    const s = info.trackSettings;
    ui.trackSettings.textContent =
      `${info.deviceLabel || 'dispositivo'} — echoCancellation=${s.echoCancellation}, ` +
      `noiseSuppression=${s.noiseSuppression}, autoGainControl=${s.autoGainControl}`;
    info.session.subscribe((event) => {
      if (event.type === 'progress') progress = event;
    });
    await populateDevices(); // labels become visible after permission
    say('Audio inicializado. Calibrá el ambiente en silencio.');
  } catch (error) {
    say(`No se pudo inicializar el audio: ${error.message}`, true);
  } finally {
    ui.init.disabled = false;
    refreshStatus();
  }
});

ui.calibrate.addEventListener('click', () => runTask('Calibración de ambiente', () => manager.session.calibrate()));
ui.enroll.addEventListener('click', () => runTask('Enrolamiento', () => manager.session.enroll()));
ui.start.addEventListener('click', () => {
  try {
    manager.session.start();
    say('Sesión de medición en curso.');
  } catch (error) {
    say(error.message, true);
  }
  refreshStatus();
});
ui.stop.addEventListener('click', () => {
  manager.session.stop();
  say('Detenido.');
  refreshStatus();
});

function render() {
  const session = manager.session;
  if (session) {
    const { stats, latest, load } = session;
    const a = latest?.analysis;
    const lines = [
      `Modo: ${session.mode}`,
      progress
        ? `Progreso: ${fmt(progress.elapsed, 1)} s` +
          (progress.validTime !== undefined ? ` (voz válida ${fmt(progress.validTime, 1)} / ${progress.target} s)` : ` / ${progress.target} s`)
        : '',
      '',
      `Categoría: ${a?.category ?? '—'}${a?.rejectionReason ? ` (${a.rejectionReason})` : ''}`,
      `V/W/Q/Phi: ${a ? `${a.V}/${a.W}/${a.Q}/${a.phi}` : '—'}`,
      `F0: ${fmt(a?.f0, 1)} Hz   periodicidad: ${fmt(a?.periodicity)}`,
      `Nivel: ${fmt(a?.levelDb, 1)} dBFS   SNR: ${fmt(a?.snrDb, 1)} dB   cresta: ${fmt(a?.crestFactor)}`,
      `Score hablante: ${fmt(a?.speakerScore, 3)} (suavizado ${fmt(a?.smoothedScore, 3)})`,
      '',
      `H_k: ${fmt(load?.h, 3)} s`,
      `D_0 (sin memoria): ${fmt(load?.doses.none, 1)}`,
      `D_L (lineal):      ${fmt(load?.doses.linear, 1)}`,
      `D_P (potencial):   ${fmt(load?.doses.power, 1)}`,
      `D_E (exponencial): ${fmt(load?.doses.exponential, 1)}`,
      `D_S (saturante):   ${fmt(load?.doses.saturating, 1)}`,
      load ? `Fonación: ${fmt(phonationPercentage(load.metrics), 1)} % de ${fmt(load.metrics.totalTime, 1)} s   episodios: ${load.metrics.episodes.count}   pausas: ${load.metrics.pauses.count}` : '',
      load ? `Unidades de I_k: ${load.units}` : '',
      '',
      `Tramas recibidas: ${stats.framesReceived}   procesadas: ${stats.framesProcessed}`,
      `Caídas (saltos de secuencia): ${stats.droppedFrames}   discontinuidades del worklet: ${stats.discontinuities}`,
      `Sobrecargas de proceso: ${stats.overruns}   máx. proceso por trama: ${fmt(stats.maxProcessingMs, 2)} ms`,
    ];
    ui.monitor.textContent = lines.filter((l, i, all) => l !== '' || all[i - 1] !== '').join('\n');
  }
  requestAnimationFrame(render);
}

populateDevices().catch((error) => say(error.message, true));
requestAnimationFrame(render);
