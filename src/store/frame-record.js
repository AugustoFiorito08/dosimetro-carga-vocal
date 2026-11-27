// Primary frame record of a workday (vd-des-frames/1; odd/tasks/tramas-primarias.md, S4):
// for every analysed frame, the level of its RMS, F0, the decisions V, W, Q and Φ, its category
// and SNR; for the session, what is needed to rebuild P_k and the doses (frame duration, pauses,
// pressure scale, P_0, units, algorithm version). Derived numbers only: no audio, no spectrum,
// no speaker template, no device label.
//
// Binary layout, little-endian columns of `frameCount` values each:
//   level  int16  20·log10(rms) in steps of 0.005 dB (−32768 = no signal)
//   f0     uint16 F0 in steps of 0.1 Hz (0 = none)
//   flags  uint8  bit 0 V, 1 W, 2 Q, 3 Φ; bits 4-6 the category index (FRAME_CATEGORIES)
//   snr    int8   SNR in dB, clamped to ±127 (−128 = unknown)
// For the upload the bytes are gzipped and split in base64 parts (framesToParts).
import { CATEGORIES } from '../dsp/frame-classifier.js';

export const FRAMES_SCHEMA = 'vd-des-frames/1';
export const BYTES_PER_FRAME = 6;
export const FRAME_CATEGORIES = Object.freeze(Object.values(CATEGORIES));
/** Base64 characters per uploaded part: the request stays under the server's 2 MB limit. */
export const MAX_PART_CHARS = 1_500_000;
export const PRESSURE_MODES = Object.freeze(['calibrated', 'own_voice', 'relative']);

const LEVEL_STEP = 0.005;
const NO_LEVEL = -32768;
const NO_SNR = -128;
const HEADER_FIELDS = Object.freeze([
  'schema', 'frameCount', 'dt', 'sampleRate', 'frameSize', 'startTimestamp', 'gaps',
  'pressureScale', 'referencePressure', 'units', 'algorithmVersion', 'layout',
]);
const LAYOUT = 'le:level_i16_0.005db,f0_u16_0.1hz,flags_u8,snr_i8';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Frame log of one session. push() every analysed frame with its audio-clock timestamp;
 * paused intervals (no frames) are kept as gaps.
 * @param {{ sampleRate: number, frameSize: number, pressureScale: object, referencePressure: number,
 *   units: string, algorithmVersion: string }} session
 */
export function createFrameLog(session) {
  let capacity = 4096;
  let level = new Int16Array(capacity);
  let f0 = new Uint16Array(capacity);
  let flags = new Uint8Array(capacity);
  let snr = new Int8Array(capacity);
  let n = 0;
  let dt = null;
  let start = null;
  let nextTime = null;
  const gaps = [];

  const grow = () => {
    capacity *= 2;
    const more = (Old, a) => { const b = new Old(capacity); b.set(a); return b; };
    level = more(Int16Array, level);
    f0 = more(Uint16Array, f0);
    flags = more(Uint8Array, flags);
    snr = more(Int8Array, snr);
  };

  return {
    /** @param {{ dt: number, rms: number, f0: number | null, snrDb: number, V: number, W: number, Q: number, phi: number, category: string }} a */
    push(a, timestamp) {
      if (n === capacity) grow();
      dt ??= a.dt;
      if (start === null) start = timestamp;
      else if (timestamp - nextTime > dt / 2) gaps.push([n, Math.round((timestamp - nextTime) * 1e6) / 1e6]);
      nextTime = timestamp + a.dt;
      level[n] = a.rms > 0 ? clamp(Math.round((20 * Math.log10(a.rms)) / LEVEL_STEP), -32767, 32767) : NO_LEVEL;
      f0[n] = Number.isFinite(a.f0) && a.f0 > 0 ? clamp(Math.round(a.f0 * 10), 1, 65535) : 0;
      const category = FRAME_CATEGORIES.indexOf(a.category);
      flags[n] = (a.V ? 1 : 0) | (a.W ? 2 : 0) | (a.Q ? 4 : 0) | (a.phi ? 8 : 0) | (Math.max(0, category) << 4);
      snr[n] = Number.isFinite(a.snrDb) ? clamp(Math.round(a.snrDb), -127, 127) : NO_SNR;
      n++;
    },
    clear() {
      n = 0;
      dt = null;
      start = null;
      nextTime = null;
      gaps.length = 0;
    },
    get length() {
      return n;
    },
    /** `{ header, bytes }` of the frames so far, or null when there is none. */
    encode() {
      if (n === 0) return null;
      const bytes = new Uint8Array(n * BYTES_PER_FRAME);
      const view = new DataView(bytes.buffer);
      for (let i = 0; i < n; i++) {
        view.setInt16(2 * i, level[i], true);
        view.setUint16(2 * n + 2 * i, f0[i], true);
      }
      bytes.set(flags.subarray(0, n), 4 * n);
      bytes.set(new Uint8Array(snr.buffer, 0, n), 5 * n);
      const header = {
        schema: FRAMES_SCHEMA,
        frameCount: n,
        dt,
        sampleRate: session.sampleRate,
        frameSize: session.frameSize,
        startTimestamp: start,
        gaps: gaps.map((g) => [...g]),
        pressureScale: { ...session.pressureScale },
        referencePressure: session.referencePressure,
        units: session.units,
        algorithmVersion: session.algorithmVersion,
        layout: LAYOUT,
      };
      return { header: validateFramesHeader(header), bytes };
    },
  };
}

const positive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Throws RangeError unless `h` is a vd-des-frames/1 header; returns it unchanged. */
export function validateFramesHeader(h) {
  if (!h || h.schema !== FRAMES_SCHEMA) throw new RangeError(`frames schema must be ${FRAMES_SCHEMA}`);
  const unknown = Object.keys(h).find((k) => !HEADER_FIELDS.includes(k));
  if (unknown) throw new RangeError(`unknown field "${unknown}" in a frames header`);
  if (!Number.isInteger(h.frameCount) || h.frameCount < 1) throw new RangeError('frameCount must be a positive integer');
  if (!positive(h.dt) || !positive(h.sampleRate) || !Number.isInteger(h.frameSize) || h.frameSize < 1) throw new RangeError('dt, sampleRate and frameSize must be positive');
  if (typeof h.startTimestamp !== 'number' || !Number.isFinite(h.startTimestamp)) throw new RangeError('startTimestamp must be a number');
  if (!Array.isArray(h.gaps) || h.gaps.some((g) => !Array.isArray(g) || g.length !== 2 || !Number.isInteger(g[0]) || g[0] < 1 || g[0] >= h.frameCount || !positive(g[1]))) {
    throw new RangeError('gaps must be [frameIndex, seconds] pairs inside the record');
  }
  const p = h.pressureScale;
  const scaleOk = p && PRESSURE_MODES.includes(p.mode)
    && (p.mode === 'calibrated' ? positive(p.coefficient) : p.mode === 'own_voice' ? positive(p.a0Rms) : true)
    && Object.keys(p).every((k) => ['mode', 'coefficient', 'a0Rms'].includes(k));
  if (!scaleOk) throw new RangeError('pressureScale must be { mode: calibrated, coefficient } | { mode: own_voice, a0Rms } | { mode: relative }');
  if (!positive(h.referencePressure)) throw new RangeError('referencePressure must be positive');
  if (!['calibrated', 'normalized', 'relative'].includes(h.units)) throw new RangeError(`unknown units ${h.units}`);
  if (typeof h.algorithmVersion !== 'string' || h.algorithmVersion.length > 32) throw new RangeError('algorithmVersion must be a short string');
  if (h.layout !== LAYOUT) throw new RangeError(`layout must be ${LAYOUT}`);
  return h;
}

/**
 * Columns of a record: level (dB re full scale, −Infinity for no signal), f0 (Hz or null), the
 * 0/1 decisions, the category name, SNR (dB or null) and each frame's timestamp (s).
 */
export function decodeFrames(header, bytes) {
  validateFramesHeader(header);
  const n = header.frameCount;
  if (!(bytes instanceof Uint8Array) || bytes.length !== n * BYTES_PER_FRAME) throw new RangeError(`frames bytes must be ${n * BYTES_PER_FRAME} long`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = { levelDb: new Float64Array(n), f0: new Array(n), V: new Uint8Array(n), W: new Uint8Array(n), Q: new Uint8Array(n), phi: new Uint8Array(n), category: new Array(n), snrDb: new Array(n), timestamps: new Float64Array(n) };
  const gapAt = new Map(header.gaps);
  let t = header.startTimestamp;
  for (let i = 0; i < n; i++) {
    const level = view.getInt16(2 * i, true);
    out.levelDb[i] = level === NO_LEVEL ? Number.NEGATIVE_INFINITY : level * LEVEL_STEP;
    const f = view.getUint16(2 * n + 2 * i, true);
    out.f0[i] = f === 0 ? null : f / 10;
    const flags = bytes[4 * n + i];
    out.V[i] = flags & 1;
    out.W[i] = (flags >> 1) & 1;
    out.Q[i] = (flags >> 2) & 1;
    out.phi[i] = (flags >> 3) & 1;
    out.category[i] = FRAME_CATEGORIES[(flags >> 4) & 7] ?? null;
    const s = view.getInt8(5 * n + i);
    out.snrDb[i] = s === NO_SNR ? null : s;
    if (gapAt.has(i)) t += gapAt.get(i);
    out.timestamps[i] = t;
    t += header.dt;
  }
  return out;
}

async function pipe(bytes, stream) {
  const out = await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer();
  return new Uint8Array(out);
}

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Gzipped bytes as base64 parts of at most `maxChars` characters, in order. */
export async function framesToParts(bytes, { maxChars = MAX_PART_CHARS } = {}) {
  const text = toBase64(await pipe(bytes, new CompressionStream('gzip')));
  const parts = [];
  for (let i = 0; i < text.length; i += maxChars) parts.push(text.slice(i, i + maxChars));
  return parts;
}

/** The record bytes back from its base64 parts, in order. */
export async function framesFromParts(parts) {
  return pipe(fromBase64(parts.join('')), new DecompressionStream('gzip'));
}
