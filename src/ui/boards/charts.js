// Small SVG/HTML chart builders for the dashboards (pure string output, no dependencies).
// Colours come from CSS custom properties; every mark carries a <title> hover tooltip.

export const SERIES = Object.freeze(['var(--score-f0)', 'var(--score-level)', 'var(--score-h)', 'var(--score-rate)', 'var(--score-dose)', 'var(--series-6)']);

/** Sequential blue ramp for dark surfaces: low values recede toward the surface. */
export const SEQUENTIAL = Object.freeze(['#184f95', '#1c5cab', '#256abf', '#2a78d6', '#3987e5', '#5598e7', '#6da7ec', '#86b6ef', '#9ec5f4', '#b7d3f6', '#cde2fb']);

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const num = (v, digits = 0) => (Number.isFinite(v) ? Number(v).toLocaleString('es-AR', { maximumFractionDigits: digits, minimumFractionDigits: 0 }) : '—');

/** Compact number for axes: 12 400 -> "12,4 k", 3 200 000 -> "3,2 M". */
export function compact(v) {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e6) return `${num(v / 1e6, 1)} M`;
  if (a >= 1e4) return `${num(v / 1e3, 1)} k`;
  return num(v, a < 10 ? 2 : 0);
}

/** Nice axis ticks over [lo, hi]. */
export function ticks(lo, hi, count = 4) {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / count;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

const M = { top: 10, right: 12, bottom: 30, left: 46 };

function frame({ width, height, xTicks, yTicks, x, y, xFormat = compact, yFormat = compact, xLabel = '', yLabel = '' }) {
  const parts = [];
  for (const t of yTicks) {
    parts.push(`<line x1="${M.left}" x2="${width - M.right}" y1="${y(t)}" y2="${y(t)}" class="grid"/>`);
    parts.push(`<text x="${M.left - 6}" y="${y(t) + 3}" text-anchor="end" class="tick">${esc(yFormat(t))}</text>`);
  }
  for (const t of xTicks) parts.push(`<text x="${x(t)}" y="${height - M.bottom + 14}" text-anchor="middle" class="tick">${esc(xFormat(t))}</text>`);
  if (xLabel) parts.push(`<text x="${(M.left + width - M.right) / 2}" y="${height - 2}" text-anchor="middle" class="axis-label">${esc(xLabel)}</text>`);
  if (yLabel) parts.push(`<text transform="translate(11 ${(M.top + height - M.bottom) / 2}) rotate(-90)" text-anchor="middle" class="axis-label">${esc(yLabel)}</text>`);
  return parts.join('');
}

const svg = (width, height, body, label) =>
  `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">${body}</svg>`;

const scale = (d0, d1, r0, r1) => (v) => r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0);

/** Grouped bars. series: [{ name, values, color }]. */
export function barChart({ labels, series, width = 520, height = 200, yLabel = '', label = 'Gráfico de barras' }) {
  const max = Math.max(1, ...series.flatMap((s) => s.values.filter(Number.isFinite)));
  const yt = ticks(0, max);
  const y = scale(0, yt.at(-1), height - M.bottom, M.top);
  const band = (width - M.left - M.right) / Math.max(1, labels.length);
  const barW = Math.max(2, (band * 0.7) / series.length - 2);
  const bars = labels.map((lab, i) =>
    series.map((s, k) => {
      const v = s.values[i];
      if (!Number.isFinite(v)) return '';
      const x0 = M.left + i * band + band * 0.15 + k * (barW + 2);
      return `<rect x="${x0}" y="${y(v)}" width="${barW}" height="${Math.max(0, y(0) - y(v))}" rx="2" fill="${s.color}"><title>${esc(`${lab} · ${s.name}: ${num(v)}`)}</title></rect>`;
    }).join(''),
  ).join('');
  const xs = labels.map((lab, i) => `<text x="${M.left + (i + 0.5) * band}" y="${height - M.bottom + 14}" text-anchor="middle" class="tick">${esc(lab)}</text>`).join('');
  const body = frame({ width, height, xTicks: [], yTicks: yt, x: () => 0, y, yLabel }) + xs + bars;
  return svg(width, height, body, label);
}

/** Histogram with an optional vertical marker. */
export function histogramChart({ edges, counts, color, width = 420, height = 190, xLabel = '', marker = null, label = 'Histograma' }) {
  if (!counts.length) return svg(width, height, `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" class="tick">Sin datos</text>`, label);
  const yt = ticks(0, Math.max(1, ...counts));
  const x = scale(edges[0], edges.at(-1), M.left, width - M.right);
  const y = scale(0, yt.at(-1), height - M.bottom, M.top);
  const bars = counts.map((c, i) => {
    const x0 = x(edges[i]) + 1;
    const w = Math.max(1, x(edges[i + 1]) - x(edges[i]) - 2);
    return `<rect x="${x0}" y="${y(c)}" width="${w}" height="${Math.max(0, y(0) - y(c))}" rx="1.5" fill="${color}"><title>${esc(`${compact(edges[i])}–${compact(edges[i + 1])}: ${c}`)}</title></rect>`;
  }).join('');
  const m = marker && Number.isFinite(marker.x)
    ? `<line x1="${x(marker.x)}" x2="${x(marker.x)}" y1="${M.top}" y2="${height - M.bottom}" class="marker"/><text x="${x(marker.x) + 4}" y="${M.top + 10}" class="marker-label">${esc(marker.label)}</text>`
    : '';
  return svg(width, height, frame({ width, height, xTicks: ticks(edges[0], edges.at(-1)), yTicks: yt, x, y, xLabel, yLabel: 'Frecuencia' }) + bars + m, label);
}

/** Lines over categorical or numeric x. series: [{ name, values, color }]. */
export function lineChart({ xs, series, width = 520, height = 200, xFormat = (v) => v, yLabel = '', yMin = 0, label = 'Gráfico de líneas' }) {
  const all = series.flatMap((s) => s.values.filter(Number.isFinite));
  const yt = ticks(Math.min(yMin, ...all), Math.max(1, ...all));
  const x = scale(0, Math.max(1, xs.length - 1), M.left + 8, width - M.right - 8);
  const y = scale(yt[0], yt.at(-1), height - M.bottom, M.top);
  const lines = series.map((s) => {
    let d = '';
    s.values.forEach((v, i) => { if (Number.isFinite(v)) d += `${d && Number.isFinite(s.values[i - 1]) ? 'L' : 'M'}${x(i)},${y(v)}`; });
    const dots = s.values.map((v, i) => (Number.isFinite(v) ? `<circle cx="${x(i)}" cy="${y(v)}" r="4" fill="${s.color}" class="dot"><title>${esc(`${xFormat(xs[i])} · ${s.name}: ${num(v, 1)}`)}</title></circle>` : '')).join('');
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2"/>${dots}`;
  }).join('');
  const xt = xs.map((v, i) => `<text x="${x(i)}" y="${height - M.bottom + 14}" text-anchor="middle" class="tick">${esc(xFormat(v))}</text>`).join('');
  return svg(width, height, frame({ width, height, xTicks: [], yTicks: yt, x, y, yLabel }) + xt + lines, label);
}

/** Scatter with an OLS line and its 95 % band. */
export function scatterChart({ points, fit, color, width = 460, height = 240, xLabel = '', yLabel = '', label = 'Dispersión' }) {
  const xsv = points.map(([a]) => a);
  const ysv = points.map(([, b]) => b);
  const xt = ticks(0, Math.max(1, ...xsv));
  const yt = ticks(Math.min(0, ...ysv), Math.max(1, ...ysv));
  const x = scale(xt[0], xt.at(-1), M.left, width - M.right);
  const y = scale(yt[0], yt.at(-1), height - M.bottom, M.top);
  const clampY = (v) => Math.min(height - M.bottom, Math.max(M.top, y(v)));
  let band = '';
  if (fit && Number.isFinite(fit.slope)) {
    const grid = Array.from({ length: 30 }, (_, i) => xt[0] + ((xt.at(-1) - xt[0]) * i) / 29);
    const b = grid.map((g) => fit.band(g));
    band = `<path d="M${grid.map((g, i) => `${x(g)},${clampY(b[i].hi)}`).join('L')}L${grid.map((g, i) => `${x(g)},${clampY(b[i].lo)}`).reverse().join('L')}Z" class="band"/>`
      + `<path d="M${grid.map((g, i) => `${x(g)},${clampY(b[i].fit)}`).join('L')}" class="fit"/>`;
  }
  const dots = points.map(([a, b]) => `<circle cx="${x(a)}" cy="${y(b)}" r="3" fill="${color}" fill-opacity="0.55"><title>${esc(`${xLabel}: ${compact(a)} · ${yLabel}: ${num(b)}`)}</title></circle>`).join('');
  return svg(width, height, frame({ width, height, xTicks: xt, yTicks: yt, x, y, xLabel, yLabel }) + dots + band, label);
}

/** ROC curves with the chance diagonal. curves: [{ name, points: [{ fpr, tpr }], color }]. */
export function rocChart({ curves, width = 300, height = 260, label = 'Curvas ROC' }) {
  const t = [0, 0.2, 0.4, 0.6, 0.8, 1];
  const x = scale(0, 1, M.left, width - M.right);
  const y = scale(0, 1, height - M.bottom, M.top);
  const f = (v) => num(v, 1);
  const diag = `<line x1="${x(0)}" y1="${y(0)}" x2="${x(1)}" y2="${y(1)}" class="chance"/>`;
  const lines = curves.map((c) => `<path d="M${c.points.map((p) => `${x(p.fpr)},${y(p.tpr)}`).join('L')}" fill="none" stroke="${c.color}" stroke-width="2"><title>${esc(c.name)}</title></path>`).join('');
  return svg(width, height, frame({ width, height, xTicks: t, yTicks: t, x, y, xFormat: f, yFormat: f, xLabel: '1 − especificidad', yLabel: 'Sensibilidad' }) + diag + lines, label);
}

/** Cumulative dose over the workday with event markers. */
export function timelineChart({ minutes, values, events = [], color, startDate, width = 520, height = 200, yLabel = '', label = 'Dosis acumulada' }) {
  const yt = ticks(0, Math.max(1, ...values.filter(Number.isFinite)));
  const end = Math.max(1, minutes.at(-1) ?? 1);
  const x = scale(0, end, M.left, width - M.right);
  const y = scale(0, yt.at(-1), height - M.bottom, M.top);
  const clock = (m) => {
    const d = new Date(startDate.getTime() + m * 60000);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const xt = ticks(0, end, 5);
  const path = `<path d="M${x(0)},${y(0)}${minutes.map((m, i) => `L${x(m)},${y(values[i])}`).join('')}" fill="none" stroke="${color}" stroke-width="2"/>`;
  const marks = events.map((e) => {
    const xm = x(e.t / 60);
    return `<line x1="${xm}" x2="${xm}" y1="${M.top}" y2="${height - M.bottom}" stroke="${e.color}" stroke-dasharray="3 3"/><circle cx="${xm}" cy="${M.top + 4}" r="5" fill="${e.color}"><title>${esc(`${clock(e.t / 60)} · ${e.label}`)}</title></circle>`;
  }).join('');
  return svg(width, height, frame({ width, height, xTicks: xt, yTicks: yt, x, y, xFormat: clock, yLabel }) + path + marks, label);
}

/** Heat map as an HTML table with a sequential ramp and the value in every cell. */
export function heatmapTable({ rows, cols, cells, format = compact, caption }) {
  const all = cells.flat().filter(Number.isFinite);
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const color = (v) => SEQUENTIAL[Math.round(((v - lo) / (hi - lo || 1)) * (SEQUENTIAL.length - 1))];
  const ink = (v) => ((v - lo) / (hi - lo || 1) > 0.55 ? '#0b1a2b' : '#f0f4f8');
  const head = `<tr><th scope="col">Aula</th>${cols.map((c) => `<th scope="col">${esc(c)}</th>`).join('')}</tr>`;
  const body = rows.map((r, i) => `<tr><th scope="row">${esc(r)}</th>${cells[i].map((v) => (Number.isFinite(v)
    ? `<td style="background:${color(v)};color:${ink(v)}" title="${esc(`${r}: ${format(v)}`)}">${esc(format(v))}</td>`
    : '<td class="empty">—</td>')).join('')}</tr>`).join('');
  return `<table class="heatmap"><caption>${esc(caption)}</caption><thead>${head}</thead><tbody>${body}</tbody></table>`;
}
