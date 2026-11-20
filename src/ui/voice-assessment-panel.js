// PRE/POST voice assessment controls (spec §17): VAS, guided takes analysed and discarded
// in memory, the PRE / POST / Δ table and the VOICE_ACOUSTIC_ASSESSMENT export.
import { analyseAndDiscard } from '../audio/assessment-runner.js';
import { MODES } from '../audio/session-controller.js';
import { buildAcousticCsv } from '../export/acoustic-exporter.js';
import {
  RECORDING_SECONDS, STANDARD_TEXT, TIMEPOINTS, VAS_ITEMS, comparisonRows, createAssessment, restoreAssessment, withResult, withVas, workdayAssessment,
} from '../store/voice-assessment.js';

const STORAGE_KEY = 'dosimetro.voice-assessment';
const TASK_LABELS = { VOWEL: '/a/', SPEECH: 'Texto' };
const QUALITY_LABELS = {
  low_snr: 'ruido de fondo alto',
  marginal_snr: 'ruido de fondo moderado',
  clipping: 'saturación: alejá un poco el celular o hablá más suave',
  too_little_voice: 'poca voz: sostené la /a/ o leé el texto completo',
};
const VAS_INPUT = (tp, item) => (item === 'fatigue' ? `jr-${tp.toLowerCase()}` : `va-${tp.toLowerCase()}-${item}`);

const pad = (n) => String(n).padStart(2, '0');
const today = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const num = (v, digits) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '—');
const signed = (v, digits) => (typeof v === 'number' && Number.isFinite(v) ? `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(digits)}` : '—');
const reasons = (r) => r.quality.reasons.map((k) => QUALITY_LABELS[k] ?? k).join('; ');

/**
 * @param {{ $: (id: string) => HTMLElement, say: (text: string, tone?: string) => void,
 *   getSession: () => object | null, getMicrophone: () => string, getParticipant: () => string,
 *   downloadCsv: Function, csvFileName: Function, storage?: Storage | null }} deps
 */
export function createVoiceAssessmentPanel({ $, say, getSession, getMicrophone, getParticipant, downloadCsv, csvFileName, storage = globalThis.localStorage ?? null }) {
  let state = createAssessment(today());
  try {
    const saved = storage?.getItem(STORAGE_KEY);
    if (saved) state = restoreAssessment(saved, today());
  } catch { /* storage unavailable */ }
  let busy = false;

  const persist = () => {
    try { storage?.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* storage unavailable */ }
  };

  document.querySelectorAll('.va-text-body').forEach((node) => { node.textContent = STANDARD_TEXT; });

  for (const tp of TIMEPOINTS) {
    for (const item of VAS_ITEMS) {
      const input = $(VAS_INPUT(tp, item));
      const value = state[tp].vas[item];
      input.value = value === null ? '' : String(value);
      input.addEventListener('change', () => {
        const raw = input.value.trim();
        try {
          state = withVas(state, tp, item, raw === '' ? null : Number(raw));
          persist();
          renderTable();
        } catch (error) {
          say(error.message, 'error');
        }
      });
    }
    for (const task of ['VOWEL', 'SPEECH']) {
      $(`va-${tp.toLowerCase()}-${task === 'VOWEL' ? 'vowel' : 'speech'}`).addEventListener('click', () => record(tp, task));
    }
  }

  async function record(timepoint, task) {
    const session = getSession();
    if (!session || busy) return;
    busy = true;
    const block = $(`va-${timepoint.toLowerCase()}`);
    if (task === 'SPEECH') block.querySelector('.va-text').open = true;
    try {
      say(task === 'VOWEL'
        ? 'Quedate en silencio 1 s; después sostené una /a/ cómoda, a tu tono y volumen habituales, hasta que termine.'
        : 'Quedate en silencio 1 s; después leé el texto en voz alta, como hablás en clase.');
      const samples = await session.recordSample({ seconds: RECORDING_SECONDS[task], leadInSeconds: 1 });
      say('Analizando la muestra… el audio se borra al terminar.');
      const pressureScale = session.acousticCalibration?.coefficient ?? null;
      const result = await analyseAndDiscard(samples, session.sampleRate, { task, pressureScale });
      if (result.quality.status === 'rejected') {
        say(`Muestra ${TASK_LABELS[task]} ${timepoint} rechazada (${reasons(result)}). Repetila.`, 'error');
        return;
      }
      state = withResult(state, timepoint, result);
      persist();
      renderTable();
      say(result.quality.status === 'warning'
        ? `Muestra ${TASK_LABELS[task]} ${timepoint} guardada con advertencia: ${reasons(result)}. Podés repetirla.`
        : `Muestra ${TASK_LABELS[task]} ${timepoint} guardada. El audio ya se borró.`);
    } catch (error) {
      say(`Muestra ${TASK_LABELS[task]}: ${error.message}`, 'error');
    } finally {
      busy = false;
    }
  }

  function statusText(timepoint) {
    return ['VOWEL', 'SPEECH']
      .map((task) => {
        const r = state[timepoint][task];
        const q = !r ? 'pendiente' : r.quality.status === 'ok' ? 'lista' : 'lista con advertencia';
        return `${TASK_LABELS[task]}: ${q}`;
      })
      .join(' · ');
  }

  function renderTable() {
    const rows = comparisonRows(state).filter((r) => r.pre !== null || r.post !== null);
    const digits = (unit) => (unit === 'Hz' || unit === '0-100' ? 0 : unit === '%' ? 2 : 1);
    $('va-results').innerHTML = rows.length
      ? `<thead><tr><th scope="col">Parámetro</th><th scope="col">PRE</th><th scope="col">POST</th><th scope="col" title="Cambio POST − PRE">Δ</th></tr></thead><tbody>${rows
        .map((r) => `<tr><td>${r.label} <small>${r.unit}</small></td><td>${num(r.pre, digits(r.unit))}</td><td>${num(r.post, digits(r.unit))}</td><td>${signed(r.delta, digits(r.unit))}</td></tr>`)
        .join('')}</tbody>`
      : '<tbody><tr><td>Sin datos todavía.</td></tr></tbody>';
    for (const tp of TIMEPOINTS) $(`va-${tp.toLowerCase()}-status`).textContent = statusText(tp);
  }

  $('va-export').addEventListener('click', () => {
    const hasResults = TIMEPOINTS.some((tp) => state[tp].VOWEL || state[tp].SPEECH);
    if (!hasResults) return say('Todavía no hay muestras analizadas para exportar.', 'error');
    let participantId;
    try {
      participantId = getParticipant();
    } catch {
      return say('Completá el código de docente (letras, números, «.», «-» o «_», sin espacios) antes de exportar.', 'error');
    }
    const csv = buildAcousticCsv(state, { participantId, microphone: getMicrophone() });
    const name = downloadCsv(csv, { fileName: csvFileName(new Date(), 'evaluacion-acustica') });
    say(`Evaluación exportada: ${name}`);
  });

  renderTable();

  return {
    /** Enables the take buttons only while the microphone is idle. */
    renderControls(session) {
      const idle = session?.mode === MODES.IDLE && !busy;
      for (const tp of TIMEPOINTS) {
        $(`va-${tp.toLowerCase()}-vowel`).disabled = !idle;
        $(`va-${tp.toLowerCase()}-speech`).disabled = !idle;
      }
    },
    /** The assessment for the workday record, or null when nothing was done. */
    forWorkday() {
      const a = workdayAssessment(state);
      const anyVas = Object.values(a.vas).some(({ pre, post }) => pre !== null || post !== null);
      return a.results.length || anyVas ? a : null;
    },
  };
}
