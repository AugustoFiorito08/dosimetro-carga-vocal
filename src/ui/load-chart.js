// Spec §12 — temporal plot of H_k with provisional load zones (Canvas 2D, no dependencies).
// push() is O(1) and safe to call from the audio message handler; drawing happens
// only inside requestAnimationFrame, and only when new data arrived.

/**
 * Provisional zones as fractions of the steady state under continuous
 * phonation, H_inf = 1 / beta. Not clinical or legal limits (spec §12).
 */
export const PROVISIONAL_ZONES = Object.freeze([
  { id: 'low', label: 'Baja', from: 0, to: 1 / 3 },
  { id: 'moderate', label: 'Moderada', from: 1 / 3, to: 2 / 3 },
  { id: 'high', label: 'Alta', from: 2 / 3, to: 1 },
]);

/** Order of the category tape colours (CSS variables --cat-<id>). */
export const TAPE_CATEGORIES = Object.freeze([
  'fonacion_atribuida',
  'voz_no_atribuida',
  'ruido_descartado',
  'silencio',
  'senal_incierta',
]);

/** H_inf = 1 / beta (Infinity when beta = 0). */
export const steadyStateLoad = (beta) => (beta > 0 ? 1 / beta : Infinity);

/** Zone of an H value given beta; the last zone when H >= H_inf. */
export function zoneFor(h, beta) {
  const ratio = h / steadyStateLoad(beta);
  return PROVISIONAL_ZONES.find((z) => ratio < z.to) ?? PROVISIONAL_ZONES.at(-1);
}

/** Y-axis top: data max with headroom, at least `minTop`, at most H_inf. */
export function axisTop(maxH, beta, minTop = 10) {
  const cap = steadyStateLoad(beta);
  return Math.min(cap, Math.max(minTop, maxH * 1.15));
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ beta: number, windowSeconds?: number, capacity?: number }} options
 */
export function createLoadChart(canvas, { beta, windowSeconds = 120, capacity = 16384 } = {}) {
  const ctx = canvas.getContext('2d');
  const times = new Float64Array(capacity);
  const values = new Float64Array(capacity);
  const categories = new Uint8Array(capacity);
  let head = 0; // next write index
  let size = 0;
  let dirty = true;
  let rafId = null;
  let colors = null;
  let currentBeta = beta;

  const readColors = () => {
    const css = getComputedStyle(canvas);
    const v = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    return {
      line: v('--chart-line', '#4fc3f7'),
      fill: v('--chart-fill', 'rgba(79,195,247,0.12)'),
      grid: v('--chart-grid', 'rgba(255,255,255,0.08)'),
      text: v('--chart-text', '#9aa4b2'),
      tape: TAPE_CATEGORIES.map((c, i) => v(`--cat-${c}`, ['#5cc8d6', '#e0a458', '#d9675f', '#3a4654', '#9b8fd6'][i])),
      zones: [v('--zone-low', 'rgba(76,175,80,0.07)'), v('--zone-moderate', 'rgba(255,193,7,0.08)'), v('--zone-high', 'rgba(244,67,54,0.09)')],
    };
  };

  function resize() {
    const ratio = globalThis.devicePixelRatio || 1;
    const { width, height } = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    colors = readColors();
    dirty = true;
  }

  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  observer?.observe(canvas);

  /** @param {string} [category] one of TAPE_CATEGORIES, drawn on the category tape */
  function push(t, h, category) {
    times[head] = t;
    values[head] = h;
    categories[head] = Math.max(0, TAPE_CATEGORIES.indexOf(category));
    head = (head + 1) % capacity;
    size = Math.min(size + 1, capacity);
    dirty = true;
  }

  function reset({ beta: nextBeta } = {}) {
    head = 0;
    size = 0;
    if (nextBeta !== undefined) currentBeta = nextBeta;
    dirty = true;
  }

  const at = (i) => (head - size + i + capacity) % capacity; // i-th oldest sample

  function draw() {
    if (!colors) resize();
    const { width, height } = canvas.getBoundingClientRect();
    const tapeHeight = 8;
    const pad = { left: 44, right: 12, top: 10, bottom: 24 + tapeHeight + 6 };
    const w = Math.max(1, width - pad.left - pad.right);
    const h = Math.max(1, height - pad.top - pad.bottom);
    ctx.clearRect(0, 0, width, height);

    const tEnd = size ? times[at(size - 1)] : 0;
    const tStart = Math.max(0, tEnd - windowSeconds);
    let first = 0;
    while (first < size && times[at(first)] < tStart) first++;
    let maxH = 0;
    for (let i = first; i < size; i++) maxH = Math.max(maxH, values[at(i)]);
    const top = axisTop(maxH, currentBeta);
    const hInf = steadyStateLoad(currentBeta);
    const x = (t) => pad.left + ((t - tStart) / windowSeconds) * w;
    const y = (v) => pad.top + h - (v / top) * h;

    // Provisional zones (subtle bands).
    PROVISIONAL_ZONES.forEach((zone, i) => {
      const lo = zone.from * hInf;
      const hi = Math.min(zone.to * hInf, top);
      if (!Number.isFinite(lo) || lo >= top) return;
      ctx.fillStyle = colors.zones[i];
      ctx.fillRect(pad.left, y(hi), w, y(lo) - y(hi));
      ctx.fillStyle = colors.text;
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(zone.label, pad.left + w - 4, y(hi) + 12);
    });

    // Grid and axes labels.
    ctx.strokeStyle = colors.grid;
    ctx.fillStyle = colors.text;
    ctx.lineWidth = 1;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'right';
    for (let k = 0; k <= 4; k++) {
      const v = (top * k) / 4;
      ctx.beginPath();
      ctx.moveTo(pad.left, Math.round(y(v)) + 0.5);
      ctx.lineTo(pad.left + w, Math.round(y(v)) + 0.5);
      ctx.stroke();
      ctx.fillText(v.toFixed(v < 10 ? 1 : 0), pad.left - 6, y(v) + 4);
    }
    ctx.textAlign = 'center';
    for (let k = 0; k <= 4; k++) {
      const t = tStart + (windowSeconds * k) / 4;
      ctx.fillText(`${Math.round(t)} s`, x(t), height - 6);
    }

    // Category tape: one segment per frame, gaps where the session was paused.
    const tapeY = pad.top + h + 6;
    for (let i = first; i < size; i++) {
      const idx = at(i);
      const next = i + 1 < size ? times[at(i + 1)] : times[idx];
      const span = Math.min(next - times[idx], 0.5);
      ctx.fillStyle = colors.tape[categories[idx]];
      ctx.fillRect(x(times[idx]), tapeY, Math.max(1, x(times[idx] + span) - x(times[idx])), tapeHeight);
    }

    // H_k curve.
    if (size - first >= 2) {
      ctx.beginPath();
      ctx.moveTo(x(times[at(first)]), y(values[at(first)]));
      for (let i = first + 1; i < size; i++) ctx.lineTo(x(times[at(i)]), y(values[at(i)]));
      ctx.strokeStyle = colors.line;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.lineTo(x(times[at(size - 1)]), y(0));
      ctx.lineTo(x(times[at(first)]), y(0));
      ctx.closePath();
      ctx.fillStyle = colors.fill;
      ctx.fill();
    }
  }

  function frame() {
    if (dirty) {
      dirty = false;
      draw();
    }
    rafId = requestAnimationFrame(frame);
  }

  return {
    push,
    reset,
    start() {
      if (rafId === null) rafId = requestAnimationFrame(frame);
    },
    stop() {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
    },
    destroy() {
      this.stop();
      observer?.disconnect();
    },
    get size() { return size; },
  };
}
