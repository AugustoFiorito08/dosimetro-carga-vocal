// Teacher view (odd/tasks/vista-docente-movil.md): a guided phone flow over the same measuring
// session as the technical view. It never measures on its own: every step calls the named
// session actions of dashboard.js, and the VAS and codes are written into the same form fields
// the technical view reads, so both views always agree.
import { MODES } from '../../audio/session-controller.js';
import { splFromPressure } from '../../dsp/acoustic-calibration.js';
import { describe } from '../../stats/descriptive.js';
import { BORG_SCALE } from '../../store/voice-assessment.js';
import { validateCode } from '../../store/workday.js';
import { EVENT_LABELS } from '../boards/views.js';
import { comparisonText, nextTeacherStep, personalComparison } from './teacher-model.js';

const PREP_STEPS = [
  ['codes', 'Datos'], ['microphone', 'Micrófono'], ['ambient', 'Silencio'],
  ['enrol', 'Tu voz'], ['reference', 'Voz habitual'], ['pre', 'Antes'],
];
/** VAS of the protocol with the words of each end of the line (response sheet). */
const VAS_ITEMS = {
  fatigue: { label: 'Cansancio de la voz', low: 'Voz completamente descansada', high: 'Máximo cansancio vocal imaginable' },
  dryness: { label: 'Sequedad de la garganta', low: 'Garganta nada seca / bien hidratada', high: 'Máxima sequedad imaginable' },
  discomfort: { label: 'Molestia o irritación en la garganta', low: 'Ninguna molestia / Nada en absoluto', high: 'Máxima molestia imaginable' },
};
/** Set once the teacher has read the three effort examples (familiarization before the first PRE). */
const FAMILIARIZED_KEY = 'dosimetro.borg-familiarized';
const vasInputId = (timepoint, item) => (item === 'fatigue' ? `jr-${timepoint}` : `va-${timepoint}-${item}`);
const TASK_LABELS = { [MODES.CALIBRATING]: 'Silencio…', [MODES.REFERENCING]: 'Leé con tu voz habitual' };
const VIEW_KEY = 'dosimetro.view';
const RENDER_EVERY_MS = 250;
const WINDOW_S = 10;

const pad = (n) => String(n).padStart(2, '0');
const clock = (seconds) => {
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
};
const span = (seconds) => {
  const s = Math.round(seconds || 0);
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
};
const num = (v, d = 0) => (Number.isFinite(v) ? v.toLocaleString('es-AR', { maximumFractionDigits: d, minimumFractionDigits: d }) : '—');
const millions = (v) => (!Number.isFinite(v) ? '—' : v >= 1e6 ? `${num(v / 1e6, 1)} M` : v >= 1e3 ? `${num(v / 1e3, 1)} mil` : num(v, 0));
const hhmm = (date) => date.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function setText(node, text) {
  if (node && node.textContent !== text) node.textContent = text;
}

/** The user's chosen view, else the teacher view on a phone-sized screen. */
export function initialView({ storage = globalThis.localStorage, matchMedia = globalThis.matchMedia } = {}) {
  try {
    const saved = storage?.getItem(VIEW_KEY);
    if (saved === 'teacher' || saved === 'technical') return saved;
  } catch {
    // storage unavailable: fall back to the screen size
  }
  return matchMedia?.('(max-width: 760px)').matches ? 'teacher' : 'technical';
}

/**
 * @param {object} deps
 * @param {HTMLElement} deps.root
 * @param {(id: string) => HTMLElement} deps.$
 * @param {Record<string, Function>} deps.actions named session actions of dashboard.js
 * @param {() => object | null} deps.getSession
 * @param {() => object | null} deps.getProgress
 * @param {() => boolean} deps.isSaved
 * @param {(timepoint: 'PRE' | 'POST') => boolean} deps.samplesDone both acoustic voice takes accepted
 * @param {() => object | null} deps.getInterruption
 * @param {{ voicedValues(key: string): number[] }} deps.scoreSeries
 * @param {Record<string, HTMLElement>} deps.adopt nodes of the technical view shown inside the teacher view, by slot
 * @param {{ show(tab: string | null): void }} deps.boards
 * @param {{ list(): Promise<object[]> }} deps.repository
 * @param {{ list(): Promise<object[]> }} deps.outbox
 * @param {() => boolean} deps.isSyncEnabled
 * @param {(view: string) => void} deps.onView
 * @param {() => void} deps.onScoreShown
 * @param {() => object[]} deps.getEvents context events of the current session
 * @param {() => Date | null} deps.getStartedAt start of the current session
 */
export function createTeacherApp(deps) {
  const { root, $, actions } = deps;
  const q = (selector) => root.querySelector(selector);
  const screens = Object.fromEntries([...root.querySelectorAll('[data-screen]')].map((s) => [s.dataset.screen, s]));
  const navButtons = [...root.querySelectorAll('[data-tab]')];
  const toastNode = $('t-toast');
  const sheet = $('t-activity');
  const ui = {
    view: 'technical', tab: 'flow', codesConfirmed: false, preConfirmed: false, enrolAccepted: false, busy: false,
    history: [], lastSaved: null, lastRender: 0, lastVoicedAt: null, windows: [], f0Median: NaN, f0At: 0,
  };
  const placeholders = new Map();
  let toastTimer = null;

  // ---------- codes and VAS mirror the technical view's fields ----------
  for (const input of root.querySelectorAll('[data-mirror]')) {
    const original = $(input.dataset.mirror);
    input.value = original.value;
    input.addEventListener('input', () => {
      original.value = input.value.trim();
      original.dispatchEvent(new Event('change'));
    });
  }
  const codesValid = () => {
    try {
      for (const id of ['jr-participant', 'jr-school', 'jr-classroom']) validateCode(id, $(id).value.trim());
      return true;
    } catch {
      return false;
    }
  };
  ui.codesConfirmed = codesValid();

  for (const list of root.querySelectorAll('.t-vas-list')) {
    const timepoint = list.dataset.timepoint;
    for (const item of list.dataset.items.split(',')) {
      const { label, low, high } = VAS_ITEMS[item];
      const original = $(vasInputId(timepoint, item));
      const row = document.createElement('label');
      row.className = 't-vas';
      row.innerHTML = `<span class="t-vas-head"><span>${label}</span><output>—</output></span>
        <input type="range" min="0" max="100" step="1" value="0" aria-label="${label}" />
        <span class="t-vas-scale"><span>${low}</span><span>${high}</span></span>`;
      const range = row.querySelector('input');
      const output = row.querySelector('output');
      const sync = () => {
        const empty = original.value.trim() === '';
        range.dataset.empty = String(empty);
        if (!empty) range.value = original.value;
        output.textContent = empty ? 'sin marcar' : original.value;
      };
      range.addEventListener('input', () => {
        original.value = range.value;
        original.dispatchEvent(new Event('change'));
        sync();
      });
      original.addEventListener('change', sync);
      sync();
      list.append(row);
    }
  }
  // Vocal effort: the ten phrases, no numbers; the choice goes to the technical view's select,
  // which holds the value of the protocol key (single source of truth, like the VAS).
  for (const box of root.querySelectorAll('.t-borg')) {
    const timepoint = box.dataset.borg;
    const original = $(`va-${timepoint}-borg`);
    for (const option of BORG_SCALE) {
      const row = document.createElement('label');
      row.className = 't-borg-option';
      row.innerHTML = `<input type="radio" name="t-borg-${timepoint}" value="${option.value}" /><span>${option.label}</span>`;
      row.querySelector('input').addEventListener('change', () => {
        original.value = String(option.value);
        original.dispatchEvent(new Event('change'));
      });
      box.append(row);
    }
    const sync = () => {
      for (const radio of box.querySelectorAll('input')) radio.checked = radio.value === original.value;
    };
    original.addEventListener('change', sync);
    sync();
  }
  const familiarization = q('[data-familiarization]');
  const familiarized = () => {
    try { return globalThis.localStorage?.getItem(FAMILIARIZED_KEY) === '1'; } catch { return ui.familiarized === true; }
  };
  familiarization.hidden = familiarized();

  const fatigueSet = (timepoint) => $(`jr-${timepoint}`).value.trim() !== '';

  // ---------- toast ----------
  // While a teacher action runs, the technical view's info messages (levels in dBFS, P10-P90)
  // are not shown: the action says its own result in plain words. Errors always pass.
  function toast(text, tone = 'info') {
    if (ui.view !== 'teacher' || !text) return;
    if (ui.busy && tone !== 'error') return;
    show(text, tone);
  }
  function show(text, tone = 'info') {
    toastNode.textContent = text;
    toastNode.dataset.tone = tone;
    toastNode.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastNode.hidden = true; }, tone === 'error' ? 10000 : 6000);
  }

  // ---------- actions ----------
  /** Runs an action; on success shows `done` (a text, or a function of the result). */
  async function run(fn, done) {
    if (ui.busy) return undefined;
    ui.busy = true;
    let result;
    try {
      result = await fn();
    } finally {
      ui.busy = false;
      render(true);
    }
    const text = result && (typeof done === 'function' ? done(result) : done);
    if (text) show(text);
    return result;
  }
  const enrolResult = () => {
    const quality = deps.getSession()?.profileQuality;
    return quality !== null && quality !== undefined && quality < 0.6
      ? 'La app reconoció poco tu voz. Repetilo hablando 15 s de corrido, o seguí de todos modos.'
      : 'Listo: la app ya reconoce tu voz.';
  };
  const handlers = {
    codes: () => {
      if (!codesValid()) return toast('Completá docente, escuela y aula con códigos: letras, números, «.», «-» o «_», sin espacios.', 'error');
      ui.codesConfirmed = true;
    },
    connect: () => run(actions.connectMicrophone, 'Micrófono conectado.'),
    ambient: () => run(actions.calibrateAmbient, 'Listo: silencio medido.'),
    enrol: () => run(actions.enrollSpeaker, enrolResult),
    'enrol-accept': () => { ui.enrolAccepted = true; },
    reference: () => run(actions.takeReference, 'Listo: tu voz habitual quedó registrada.'),
    familiarized: () => {
      ui.familiarized = true;
      try { globalThis.localStorage?.setItem(FAMILIARIZED_KEY, '1'); } catch { /* storage unavailable */ }
      familiarization.hidden = true;
    },
    pre: () => {
      if (!familiarized() && !ui.familiarized) return toast('Leé los tres ejemplos de esfuerzo y tocá «Entendido».', 'error');
      if (!fatigueSet('pre')) return toast('Marcá al menos el cansancio de la voz antes de empezar.', 'error');
      if (!deps.samplesDone('PRE')) return toast('Grabá la vocal /a/ y la lectura del texto antes de empezar.', 'error');
      ui.preConfirmed = true;
    },
    start: () => run(async () => {
      ui.history = await deps.repository.list().catch(() => []);
      ui.lastVoicedAt = null;
      ui.windows = [];
      return actions.startSession();
    }, 'La jornada empezó. Dejá el celular con la pantalla encendida.'),
    activity: () => sheet.showModal(),
    pause: () => actions.pauseSession(),
    resume: () => run(actions.resumeSession),
    finish: () => {
      // eslint-disable-next-line no-alert
      if (globalThis.confirm('¿Finalizar la jornada? Después vas a registrar cómo quedó tu voz.')) actions.finishSession();
    },
    save: () => {
      if (!fatigueSet('post')) return toast('Marcá al menos el cansancio de la voz para guardar la jornada.', 'error');
      if (!deps.samplesDone('POST')) return toast('Grabá la vocal /a/ y la lectura del texto para guardar la jornada.', 'error');
      return run(async () => {
        const workday = await actions.saveWorkday();
        if (workday) {
          ui.lastSaved = workday;
          ui.history = await deps.repository.list().catch(() => ui.history);
          renderSummary();
        }
        return workday;
      }, 'Jornada guardada.');
    },
    'new-day': () => globalThis.location.reload(),
  };
  root.addEventListener('click', (event) => {
    const target = event.target.closest('button');
    if (!target || !root.contains(target)) return;
    if (target.dataset.action) handlers[target.dataset.action]?.();
    else if (target.dataset.click) $(target.dataset.click).click();
    else if (target.dataset.go) selectTab(target.dataset.go);
    else if (target.dataset.tab) selectTab(target.dataset.tab);
    render(true);
  });
  sheet.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.event) {
      const marked = actions.markEvent(button.dataset.event);
      setText($('t-last-activity'), `Marcaste «${EVENT_LABELS[marked.type]}» a las ${hhmm(new Date())}.`);
    }
    sheet.close();
  });
  $('to-technical').addEventListener('click', () => setView('technical'));

  // ---------- tabs and adopted panels ----------
  function selectTab(tab) {
    ui.tab = tab;
    for (const b of navButtons) {
      if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
    if (tab === 'journal') {
      deps.boards.show('teacher');
      renderHistory();
    } else {
      deps.boards.show(null);
    }
    if (tab === 'score') renderScoreEvents();
    root.querySelector('.t-main').scrollTop = 0;
    globalThis.scrollTo?.(0, 0);
  }

  function adopt() {
    for (const [slot, node] of Object.entries(deps.adopt)) {
      if (!placeholders.has(slot)) {
        const marker = document.createComment(`teacher-slot:${slot}`);
        node.before(marker);
        placeholders.set(slot, { marker, hidden: node.hidden });
      }
      placeholders.get(slot).hidden = node.hidden;
      q(`[data-slot="${slot}"]`).append(node);
      node.hidden = false;
    }
  }
  function release() {
    for (const [slot, node] of Object.entries(deps.adopt)) {
      const place = placeholders.get(slot);
      if (!place) continue;
      place.marker.after(node);
      node.hidden = place.hidden;
    }
  }

  function setView(view) {
    ui.view = view;
    document.body.dataset.view = view;
    root.hidden = view !== 'teacher';
    try { globalThis.localStorage?.setItem(VIEW_KEY, view); } catch { /* storage unavailable */ }
    if (view === 'teacher') {
      adopt();
      selectTab(ui.tab);
    } else {
      release();
      toastNode.hidden = true;
    }
    deps.onView(view);
    render(true);
  }

  // ---------- render ----------
  /** Below this estimated own-voice acceptance the enrolment is worth repeating (provisional). */
  const lowProfile = (session) => Number.isFinite(session?.profileQuality) && session.profileQuality < 0.6;

  function flowState(session) {
    return {
      codesOk: ui.codesConfirmed,
      connected: Boolean(session),
      ambientDone: session?.noiseFloorRms != null,
      enrolled: Boolean(session?.profile) && (!lowProfile(session) || ui.enrolAccepted),
      referenceDone: Boolean(session?.voiceReference),
      calibrated: Boolean(session?.acousticCalibration),
      preDone: ui.preConfirmed && fatigueSet('pre') && deps.samplesDone('PRE'),
      mode: session?.mode ?? null,
      recordCount: session?.recordCount ?? 0,
      saved: deps.isSaved(),
    };
  }

  function renderSteps(step) {
    const list = $('t-steps');
    const index = PREP_STEPS.findIndex(([id]) => id === step);
    const inPrep = index >= 0 || step === 'ready';
    list.hidden = !inPrep || ui.tab !== 'flow';
    if (list.hidden) return;
    const current = step === 'ready' ? PREP_STEPS.length : index;
    if (list.dataset.current === String(current)) return;
    list.dataset.current = String(current);
    list.innerHTML = PREP_STEPS.map(([, label], i) => `<li data-state="${i < current ? 'done' : i === current ? 'current' : 'todo'}"><span>${i + 1}</span>${label}</li>`).join('');
  }

  function renderProgress(session) {
    const progress = deps.getProgress();
    for (const box of root.querySelectorAll('[data-progress]')) {
      const screen = box.closest('[data-screen]').dataset.screen;
      const active = progress && nextTeacherStep({ ...flowState(session), mode: progress.mode }) === screen
        && [MODES.CALIBRATING, MODES.ENROLLING, MODES.REFERENCING].includes(progress.mode);
      box.hidden = !active;
      if (!active) continue;
      const done = progress.mode === MODES.ENROLLING ? progress.validTime : progress.elapsed;
      const label = progress.mode === MODES.ENROLLING
        ? (done < progress.target / 2 ? 'Voz normal' : 'Ahora en voz alta, como en clase')
        : TASK_LABELS[progress.mode];
      setText(box.querySelector('.t-progress-label'), `${label} · ${num(done, 0)} de ${progress.target} s`);
      box.querySelector('.t-progress-bar').style.width = `${Math.min(100, (100 * done) / progress.target)}%`;
    }
    const idle = session?.mode === MODES.IDLE;
    for (const name of ['ambient', 'enrol', 'reference']) {
      const button = q(`[data-screen="${name}"] [data-action="${name}"]`);
      button.disabled = ui.busy || !idle;
    }
    q('[data-action="connect"]').disabled = ui.busy || Boolean(session);
    const retry = lowProfile(session) && !ui.enrolAccepted;
    q('[data-action="enrol-accept"]').hidden = !retry;
    setText(q('[data-action="enrol"]'), retry ? 'Repetir (15 s)' : 'Empezar a hablar (15 s)');
    q('[data-action="start"]').disabled = ui.busy || !idle;
    q('[data-action="save"]').disabled = ui.busy || deps.isSaved();
  }

  function renderReady(session) {
    const items = [
      ['Micrófono conectado', Boolean(session)],
      ['Silencio medido', session?.noiseFloorRms != null],
      ['Tu voz reconocida', Boolean(session?.profile)],
      [session?.acousticCalibration ? 'Micrófono calibrado' : 'Voz habitual registrada', Boolean(session?.voiceReference || session?.acousticCalibration)],
      ['Cómo estás antes de empezar', fatigueSet('pre')],
      ['Pruebas de voz antes de empezar', deps.samplesDone('PRE')],
    ];
    const html = items.map(([label, ok]) => `<li data-ok="${ok}">${label}</li>`).join('');
    const list = $('t-ready-list');
    if (list.innerHTML !== html) list.innerHTML = html;
  }

  /** Share of the last seconds by frame category, from the running totals of the load. */
  function recentShares(load, now) {
    const totals = { ...load.metrics.timeByCategory };
    ui.windows.push({ now, totals });
    while (ui.windows.length > 1 && now - ui.windows[0].now > WINDOW_S) ui.windows.shift();
    const first = ui.windows[0].totals;
    const delta = (k) => (totals[k] ?? 0) - (first[k] ?? 0);
    const all = Object.keys(totals).reduce((s, k) => s + delta(k), 0);
    return { all, attributed: delta('attributed'), bad: delta('noise') + delta('uncertain') };
  }

  function chip(id, state, text) {
    const node = $(id);
    node.dataset.state = state;
    setText(node, text);
  }

  function renderLive(session) {
    const load = session.load;
    if (!load) return;
    const m = load.metrics;
    const a = session.latest?.analysis;
    const t = session.latest?.timestamp ?? 0;
    const paused = session.mode === MODES.PAUSED;
    const interruption = deps.getInterruption();
    setText($('t-live-clock'), clock(m.totalTime));
    setText($('t-live-state'), interruption ? 'Captura interrumpida' : paused ? 'En pausa' : 'Midiendo');
    q('[data-action="pause"]').hidden = paused;
    q('[data-action="resume"]').hidden = !paused;

    const shares = recentShares(load, t);
    chip('t-chip-mic', interruption ? 'bad' : 'ok', interruption ? 'Micrófono: sin captura' : 'Micrófono conectado');
    const noisy = shares.all > 2 && shares.bad / shares.all > 0.5;
    chip('t-chip-signal', noisy ? 'warn' : 'ok', noisy ? 'Mucho ruido' : 'Señal correcta');
    chip('t-chip-voice', shares.attributed > 0 ? 'ok' : 'idle', shares.attributed > 0 ? 'Tu voz reconocida' : 'Sin tu voz reciente');

    if (a?.phi === 1) ui.lastVoicedAt = t;
    setText($('t-phonation'), span(m.phonationTime));
    setText($('t-phonation-pct'), m.totalTime > 0 ? `${num((100 * m.phonationTime) / m.totalTime, 0)} % del tiempo` : '—');
    setText($('t-pause'), a?.phi === 1 || ui.lastVoicedAt === null ? '—' : span(t - ui.lastVoicedAt));
    setText($('t-f0'), a?.phi === 1 && Number.isFinite(a.f0) ? `${num(a.f0, 0)} Hz` : '—');
    if (t - ui.f0At >= 2) {
      ui.f0Median = describe(deps.scoreSeries.voicedValues('f0')).p50;
      ui.f0At = t;
    }
    setText($('t-f0-mean'), Number.isFinite(ui.f0Median) ? `mediana del día ${num(ui.f0Median, 0)} Hz` : 'mediana del día —');

    if (load.units === 'calibrated') {
      setText($('t-level'), a?.phi === 1 && a.pressure > 0 ? `${num(splFromPressure(a.pressure), 0)} dB` : '—');
      setText($('t-level-note'), 'dB SPL');
    } else {
      const above = a?.phi === 1 && Number.isFinite(load.ownVoiceReferenceDbfs) ? a.levelDb - load.ownVoiceReferenceDbfs : NaN;
      setText($('t-level'), Number.isFinite(above) ? `${above >= 0 ? '+' : '−'}${num(Math.abs(above), 0)} dB` : '—');
      setText($('t-level-note'), 'respecto de tu voz habitual');
    }

    setText($('t-dose'), `${millions(load.doses.none)} vibraciones`);
    const participantId = $('jr-participant').value.trim();
    const c = personalComparison(ui.history, { participantId, units: load.units, elapsedMin: m.totalTime / 60, dose: load.doses.none });
    setText($('t-compare'), comparisonText(c));
  }

  function renderSummary() {
    const w = ui.lastSaved;
    if (!w) return;
    const deltaF = w.fatigue.pre !== null && w.fatigue.post !== null ? w.fatigue.post - w.fatigue.pre : null;
    const card = (title, value, sub = '') => `<article class="t-card"><h3>${title}</h3><p class="t-value">${value}</p>${sub ? `<p class="t-sub-value">${sub}</p>` : ''}</article>`;
    $('t-summary-cards').innerHTML = [
      card('Duración', span(w.durationS)),
      card('Hablaste', span(w.phonationS), w.durationS > 0 ? `${num((100 * w.phonationS) / w.durationS, 0)} % del tiempo` : ''),
      card('Tono (mediana)', Number.isFinite(w.f0?.p50) ? `${num(w.f0.p50, 0)} Hz` : '—'),
      card('Fatiga vocal', deltaF === null ? '—' : `${deltaF > 0 ? '+' : ''}${num(deltaF, 0)}`, `de ${num(w.fatigue.pre ?? NaN, 0)} a ${num(w.fatigue.post ?? NaN, 0)}`),
    ].join('');
    const c = personalComparison(ui.history, { participantId: w.participantId, units: w.units, elapsedMin: w.durationS / 60, dose: w.doses.none, excludeId: w.id });
    setText($('t-summary-compare'), comparisonText(c, { scope: 'day' }));
    const started = Date.parse(w.startedAt);
    const marked = w.events.filter((e) => e.source === 'docente');
    $('t-summary-events').innerHTML = marked.length
      ? marked.map((e) => `<li><span>${hhmm(new Date(started + e.t * 1000))}</span>${EVENT_LABELS[e.type] ?? e.type}</li>`).join('')
      : '<li>No marcaste actividades.</li>';
    renderSync(w);
  }

  function renderScoreEvents() {
    const marked = deps.getEvents().filter((e) => e.source === 'docente');
    const start = deps.getStartedAt();
    $('t-score-events').innerHTML = marked.length && start
      ? marked.map((e) => `<li><span>${hhmm(new Date(start.getTime() + e.t * 1000))}</span>${EVENT_LABELS[e.type] ?? e.type}</li>`).join('')
      : '<li>No marcaste actividades.</li>';
  }

  async function syncText(w) {
    if (!deps.isSyncEnabled()) return 'Guardada solo en este celular. El envío a la base del estudio lo activa el equipo de investigación.';
    const items = await deps.outbox.list().catch(() => []);
    const item = items.find((i) => i.workdayId === w.id);
    if (!item) return 'Enviada a la base del estudio.';
    if (item.state === 'rejected') return 'La base del estudio no la aceptó. Avisale al equipo de investigación.';
    return 'Pendiente de envío: se manda sola cuando haya conexión, por conexión segura (HTTPS), solo el resumen y sin audio.';
  }
  async function renderSync(w) {
    setText($('t-summary-sync'), await syncText(w));
  }

  async function renderHistory() {
    const all = await deps.repository.list().catch(() => []);
    const items = deps.isSyncEnabled() ? await deps.outbox.list().catch(() => []) : [];
    const state = (w) => {
      if (!deps.isSyncEnabled()) return ['local', 'En este celular'];
      const item = items.find((i) => i.workdayId === w.id);
      if (!item) return ['ok', 'Enviada'];
      return item.state === 'rejected' ? ['bad', 'Rechazada'] : ['pending', 'Pendiente'];
    };
    $('t-history').innerHTML = all.filter((w) => w.source === 'live').length
      ? all.filter((w) => w.source === 'live').map((w) => {
        const [tone, label] = state(w);
        const date = new Date(w.startedAt).toLocaleDateString('es-AR', { weekday: 'short', day: '2-digit', month: '2-digit' });
        return `<li><span>${date} · ${span(w.durationS)}</span><span class="t-badge" data-tone="${tone}">${label}</span></li>`;
      }).join('')
      : '<li>Todavía no hay jornadas guardadas.</li>';
  }

  function render(force = false) {
    if (ui.view !== 'teacher') return;
    const now = performance.now();
    if (!force && now - ui.lastRender < RENDER_EVERY_MS) return;
    ui.lastRender = now;
    const session = deps.getSession();
    const step = nextTeacherStep(flowState(session));
    const screen = ui.tab === 'flow' ? step : ui.tab;
    for (const [name, node] of Object.entries(screens)) node.hidden = name !== screen;
    // The partitura draws at its visible width: redraw it once its screen is shown.
    if (screen === 'score' && ui.shown !== 'score') deps.onScoreShown();
    ui.shown = screen;
    setText($('t-sub'), step === 'live' ? 'Dosimetría en curso' : 'Dosimetría vocal');
    renderSteps(step);
    renderProgress(session);
    if (screen === 'ready') renderReady(session);
    if (screen === 'live' && session) renderLive(session);
    for (const node of root.querySelectorAll('[data-mirror-text]')) setText(node, $(node.dataset.mirrorText).textContent);
  }

  return {
    setView,
    render,
    toast,
    get view() { return ui.view; },
  };
}
