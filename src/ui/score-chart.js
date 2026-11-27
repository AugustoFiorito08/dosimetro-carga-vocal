// Vocal-load score (Canvas 2D, no dependencies): six synchronized tracks over the whole
// session sharing one time axis. Data comes from score-series.js; drawing happens only in
// requestAnimationFrame, only while the score is visible, and at most every
// `liveIntervalMs` while frames keep arriving. Hover reuses the last reduction.
import { axisTop } from './load-chart.js';
import { DEFAULT_PAUSE_SECONDS } from './score-series.js';

export const SCORE_TRACKS = Object.freeze(['phi', 'f0', 'level', 'h', 'rate', 'dose']);

const COLUMN_PX = 2; // one bucket per 2 px column
const NICE_STEPS_S = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];

/** Round an axis top up to 1, 2 or 5 times a power of ten. */
export function niceCeil(value) {
  if (!(value > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 5, 10].map((m) => m * p).find((v) => v >= value - 1e-12);
}

/** Fixed, comparable scales for F0 (Hz) and level, widened only when the data leave them. */
export const DEFAULT_RANGES = Object.freeze({
  f0: [75, 350],
  'dB SPL': [40, 110],
  dBFS: [-70, 0],
});

/**
 * Y range of the F0 or level track: the default scale, widened to the 2nd-98th percentile
 * of the plotted values (so onset frames do not stretch it), rounded to tens.
 */
export function valueRange(id, values, levelUnit = 'dBFS') {
  const [lo, hi] = id === 'f0' ? DEFAULT_RANGES.f0 : DEFAULT_RANGES[levelUnit] ?? DEFAULT_RANGES.dBFS;
  const finite = Array.from(values).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (finite.length === 0) return [lo, hi];
  const at = (q) => finite[Math.min(finite.length - 1, Math.max(0, Math.round(q * (finite.length - 1))))];
  return [Math.min(lo, Math.floor(at(0.02) / 10) * 10), Math.max(hi, Math.ceil(at(0.98) / 10) * 10)];
}

/** Time-axis step giving at most `maxTicks` ticks over `span` seconds. */
export function timeStep(span, maxTicks) {
  return NICE_STEPS_S.find((s) => span / s <= maxTicks) ?? NICE_STEPS_S.at(-1);
}

/** Tick label: wall-clock HH:MM(:SS) when the session start is known, elapsed time otherwise. */
export function formatTick(seconds, startDate, withSeconds) {
  const pad = (n) => String(n).padStart(2, '0');
  if (startDate) {
    const d = new Date(startDate.getTime() + seconds * 1000);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}${withSeconds ? `:${pad(d.getSeconds())}` : ''}`;
  }
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/**
 * @param {HTMLElement} root element holding `canvas[data-track=<id>]`, `canvas[data-axis]` and `[data-tooltip]`
 * @param {{ series: ReturnType<import('./score-series.js').createScoreSeries>, liveIntervalMs?: number }} options
 */
export function createScoreChart(root, { series, liveIntervalMs = 700 } = {}) {
  const canvases = Object.fromEntries(SCORE_TRACKS.map((id) => [id, root.querySelector(`canvas[data-track="${id}"]`)]));
  const axisCanvas = root.querySelector('canvas[data-axis]');
  const tooltip = root.querySelector('[data-tooltip]');
  let dose = 'none';
  let beta = 1 / 300;
  let startDate = null;
  let format = { levelUnit: 'dBFS', doseUnit: 'u' };
  let reduced = null; // last reduction, reused by hover
  let hoverX = null;
  let dirty = true;
  let forced = true;
  let lastDraw = 0;
  let rafId = null;
  let colors = null;

  const readColors = () => {
    const css = getComputedStyle(root);
    const v = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    return {
      phi: v('--cat-fonacion_atribuida', '#5cc8d6'),
      f0: v('--score-f0', '#3987e5'),
      level: v('--score-level', '#d95926'),
      h: v('--score-h', '#199e70'),
      rate: v('--score-rate', '#c98500'),
      dose: v('--score-dose', '#d55181'),
      pause: v('--score-pause', 'rgba(92, 200, 214, 0.07)'),
      gap: v('--score-gap', 'rgba(226, 232, 238, 0.035)'),
      grid: v('--chart-grid', 'rgba(226,232,238,0.06)'),
      text: v('--chart-text', '#6f7d8c'),
      cursor: v('--text', '#e2e8ee'),
    };
  };

  function sizeCanvas(canvas) {
    const dpr = globalThis.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth));
    const h = Math.max(1, Math.round(canvas.clientHeight));
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  function reduce() {
    const from = series.startTime;
    const to = series.endTime;
    if (from === null) return null;
    const span = Math.max(to - from, 1);
    const width = canvases.phi.clientWidth || 1; // phonation: the one track every view shows
    const buckets = Math.max(1, Math.floor(width / COLUMN_PX));
    return {
      from,
      to: from + span,
      width,
      data: series.bucketize({ from, to: from + span, buckets, dose }),
      pauses: series.pauses(DEFAULT_PAUSE_SECONDS),
      gaps: series.gaps(),
    };
  }

  const xOf = (r, t) => ((t - r.from) / (r.to - r.from)) * r.width;

  function shadeIntervals(ctx, r, h) {
    ctx.fillStyle = colors.pause;
    for (const p of r.pauses) ctx.fillRect(xOf(r, p.from), 0, Math.max(1, xOf(r, p.to) - xOf(r, p.from)), h);
    ctx.fillStyle = colors.gap;
    for (const g of r.gaps) ctx.fillRect(xOf(r, g.from), 0, Math.max(1, xOf(r, g.to) - xOf(r, g.from)), h);
  }

  function yAxis(ctx, w, h, top, digits) {
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const f of [0, 0.5, 1]) {
      const y = Math.round(4 + (h - 8) * (1 - f)) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();
    ctx.fillStyle = colors.text;
    ctx.font = '10px ui-monospace, monospace';
    ctx.textBaseline = 'top';
    ctx.fillText(top.toFixed(digits), 3, 2);
  }

  function drawLine(ctx, values, color, h, lo, hi) {
    const n = values.length;
    const yOf = (v) => 4 + (h - 8) * (1 - (v - lo) / (hi - lo || 1));
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let open = false;
    for (let b = 0; b < n; b++) {
      const v = values[b];
      if (Number.isNaN(v)) { open = false; continue; }
      const x = b * COLUMN_PX + COLUMN_PX / 2;
      if (open) ctx.lineTo(x, yOf(v));
      else { ctx.moveTo(x, yOf(v)); open = true; }
    }
    ctx.stroke();
  }

  const range = (values, fallback) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of values) if (!Number.isNaN(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    return lo === Infinity ? fallback : [lo, hi];
  };

  function drawTrack(id, r) {
    const { ctx, w, h } = sizeCanvas(canvases[id]);
    ctx.clearRect(0, 0, w, h);
    if (!r) return;
    shadeIntervals(ctx, r, h);
    const d = r.data;
    if (id === 'phi') {
      ctx.fillStyle = colors.phi;
      for (let b = 0; b < d.phi.length; b++) {
        if (!(d.phi[b] > 0)) continue;
        ctx.globalAlpha = 0.35 + 0.65 * d.phi[b];
        ctx.fillRect(b * COLUMN_PX, 3, COLUMN_PX, h - 6);
      }
      ctx.globalAlpha = 1;
    } else if (id === 'rate') {
      const top = niceCeil(range(d.rate, [0, 1])[1]);
      yAxis(ctx, w, h, top, top < 10 ? 2 : 0);
      ctx.fillStyle = colors.rate;
      for (let b = 0; b < d.rate.length; b++) {
        const v = d.rate[b];
        if (!(v > 0)) continue;
        const bh = Math.max(1, (h - 8) * (v / top));
        ctx.fillRect(b * COLUMN_PX, h - 4 - bh, COLUMN_PX - (d.rate.length > w / 3 ? 0 : 1), bh);
      }
    } else {
      const values = d[id];
      let lo = 0;
      let hi;
      if (id === 'h') hi = axisTop(range(values, [0, 0])[1], beta);
      else if (id === 'dose') hi = niceCeil(range(values, [0, 1])[1]);
      else [lo, hi] = valueRange(id, values, format.levelUnit);
      yAxis(ctx, w, h, hi, id === 'dose' && hi < 10 ? 2 : 0);
      if (lo !== 0) {
        ctx.fillStyle = colors.text;
        ctx.textBaseline = 'bottom';
        ctx.fillText(String(lo), 3, h - 1);
      }
      drawLine(ctx, values, colors[id], h, lo, hi);
    }
    if (hoverX !== null) {
      ctx.strokeStyle = colors.cursor;
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(hoverX) + 0.5, 0);
      ctx.lineTo(Math.round(hoverX) + 0.5, h);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  function drawAxis(r) {
    const { ctx, w, h } = sizeCanvas(axisCanvas);
    ctx.clearRect(0, 0, w, h);
    if (!r) return;
    const span = r.to - r.from;
    const step = timeStep(span, Math.max(2, Math.floor(w / 80)));
    ctx.fillStyle = colors.text;
    ctx.strokeStyle = colors.grid;
    ctx.font = '10px ui-monospace, monospace';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    for (let t = Math.ceil(r.from / step) * step; t <= r.to + 1e-9; t += step) {
      const x = xOf(r, t);
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, 4);
      ctx.stroke();
      ctx.fillText(formatTick(t, startDate, step < 60), Math.min(w - 24, Math.max(24, x)), 6);
    }
    ctx.textAlign = 'start';
  }

  const fmt = (v, digits) => (Number.isFinite(v) ? v.toFixed(digits) : '—');
  const fmtDose = (v) => (Number.isFinite(v) ? Number(v.toPrecision(4)).toString() : '—');

  function updateTooltip() {
    if (hoverX === null || !reduced) {
      tooltip.hidden = true;
      return;
    }
    const r = reduced;
    const t = r.from + (hoverX / r.width) * (r.to - r.from);
    const s = series.sampleAt(t);
    const b = Math.min(r.data.rate.length - 1, Math.max(0, Math.floor(hoverX / COLUMN_PX)));
    const rows = s
      ? [
          ['Estado', s.phi ? 'Fonación' : 'Pausa'],
          ['F0', s.phi ? `${fmt(s.f0, 0)} Hz` : '—'],
          ['Nivel', s.phi ? `${fmt(s.level, 1)} ${format.levelUnit}` : '—'],
          ['H', `${fmt(s.h, 1)} s`],
          ['ΔD/Δt', `${fmtDose(r.data.rate[b])} ${format.doseUnit}/min`],
          ['D', `${fmtDose(s.doses[dose])} ${format.doseUnit}`],
        ]
      : [['Estado', 'Sesión en pausa']];
    tooltip.replaceChildren(
      Object.assign(document.createElement('strong'), { textContent: formatTick(t, startDate, true) }),
      ...rows.map(([k, v]) => {
        const row = document.createElement('span');
        row.append(Object.assign(document.createElement('em'), { textContent: k }), ` ${v}`);
        return row;
      }),
    );
    tooltip.hidden = false;
    const box = root.querySelector('.score-tracks').getBoundingClientRect();
    const plot = canvases.phi.getBoundingClientRect();
    const left = plot.left - box.left + hoverX;
    tooltip.style.left = `${Math.min(box.width - tooltip.offsetWidth - 4, Math.max(4, left + 12))}px`;
  }

  function draw(now) {
    rafId = null;
    if (root.hidden || root.offsetParent === null) return;
    if (!forced && (!dirty || now - lastDraw < liveIntervalMs)) {
      if (dirty) schedule();
      return;
    }
    colors ??= readColors();
    reduced = reduce();
    for (const id of SCORE_TRACKS) drawTrack(id, reduced);
    drawAxis(reduced);
    updateTooltip();
    dirty = false;
    forced = false;
    lastDraw = now;
  }

  function schedule(force = false) {
    if (force) forced = true;
    if (rafId === null) rafId = requestAnimationFrame(draw);
  }

  function redrawHoverOnly() {
    if (!reduced) return;
    for (const id of SCORE_TRACKS) drawTrack(id, reduced);
    updateTooltip();
  }

  const onMove = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    hoverX = Math.min(rect.width, Math.max(0, event.clientX - rect.left));
    redrawHoverOnly();
  };
  const onLeave = () => {
    hoverX = null;
    redrawHoverOnly();
  };
  for (const c of Object.values(canvases)) {
    c.addEventListener('pointermove', onMove);
    c.addEventListener('pointerleave', onLeave);
  }
  new ResizeObserver(() => schedule(true)).observe(canvases.phi);

  return {
    /** New data arrived (throttled redraw). */
    invalidate() {
      dirty = true;
      schedule();
    },
    /** Redraw now, e.g. when the tab becomes visible or the selection changes. */
    refresh() {
      colors = null;
      schedule(true);
    },
    /**
     * @param {{ dose?: string, beta?: number, startDate?: Date | null, levelUnit?: string, doseUnit?: string }} options
     */
    configure(options) {
      if (options.dose) dose = options.dose;
      if (options.beta !== undefined) beta = options.beta;
      if (options.startDate !== undefined) startDate = options.startDate;
      format = { ...format, ...(options.levelUnit && { levelUnit: options.levelUnit }), ...(options.doseUnit && { doseUnit: options.doseUnit }) };
      schedule(true);
    },
  };
}
