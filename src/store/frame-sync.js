// Upload contract of the primary frames (odd/tasks/tramas-primarias.md, S3): a frame record goes
// to the server as ordered parts, each under the 2 MB request limit, keyed by the sync key of its
// workday (sessionUuid ?? id) and the part number, so a retry replaces a part, never duplicates it.
import { MAX_PART_CHARS, framesToParts, validateFramesHeader } from './frame-record.js';

export const FRAME_PART_FORMAT = 'vd-des-frames-part/1';
/** Parts per record the server accepts (64 × 1.5 MB covers far more than a day). */
export const MAX_PARTS = 64;
const PART_FIELDS = Object.freeze(['format', 'syncKey', 'part', 'parts', 'header', 'data']);
const BASE64 = /^[A-Za-z0-9+/]+=*$/;

/**
 * @param {{ header: object, bytes: Uint8Array }} entry a stored frame record
 * @param {string} syncKey the sync key of its workday
 * @returns {Promise<object[]>} the parts, in order
 */
export async function buildFrameParts(entry, syncKey, { maxChars = MAX_PART_CHARS } = {}) {
  const data = await framesToParts(entry.bytes, { maxChars });
  return data.map((chunk, part) => validateFramePart({ format: FRAME_PART_FORMAT, syncKey, part, parts: data.length, header: entry.header, data: chunk }));
}

/** Throws RangeError unless `p` is a valid part; returns it unchanged. */
export function validateFramePart(p) {
  if (p?.format !== FRAME_PART_FORMAT) throw new RangeError(`frame part format must be ${FRAME_PART_FORMAT}`);
  const unknown = Object.keys(p).find((k) => !PART_FIELDS.includes(k));
  if (unknown) throw new RangeError(`unknown field "${unknown}" in a frame part`);
  if (typeof p.syncKey !== 'string' || p.syncKey.length < 1 || p.syncKey.length > 128) throw new RangeError('syncKey is required');
  if (!Number.isInteger(p.parts) || p.parts < 1 || p.parts > MAX_PARTS) throw new RangeError(`parts must be 1-${MAX_PARTS}`);
  if (!Number.isInteger(p.part) || p.part < 0 || p.part >= p.parts) throw new RangeError('part must be within parts');
  validateFramesHeader(p.header);
  if (typeof p.data !== 'string' || p.data.length < 1 || p.data.length > MAX_PART_CHARS || !BASE64.test(p.data)) {
    throw new RangeError(`data must be base64 of 1-${MAX_PART_CHARS} characters`);
  }
  return p;
}
