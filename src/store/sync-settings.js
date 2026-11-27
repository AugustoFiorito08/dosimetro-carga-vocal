// Per-device sync settings (spec §14.1, phase F3). The Supabase project url, its public
// key and the upload token are typed on each device and kept only in that browser's
// storage. (The role-based sign-in of odd/tasks/base-por-roles.md reads the url and public key
// from src/app-config.js instead; the upload token never lives in the repository.)
// - validateSyncSettings() checks the three fields and refuses secret keys, which must
//   never reach a device (a secret key bypasses RLS).
// - load/save/clear read and write one storage key; a corrupt or invalid entry counts as
//   absent, so the sync can never start from a bad configuration.
// - createOptInRepository() queues sends only while the sync is enabled: without opt-in,
//   nothing is queued and nothing leaves the browser.

export const SYNC_SETTINGS_KEY = 'dosimetro.sync';

const MIN_KEY_CHARS = 20;
const MIN_TOKEN_CHARS = 16;
const MAX_FIELD_CHARS = 4096;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const NO_SPACES = /^\S+$/;

function checkUrl(raw) {
  if (!raw) return { error: 'required' };
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { error: 'invalid' };
  }
  const local = LOCAL_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) return { error: 'not_https' };
  if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) return { error: 'has_path' };
  return { value: parsed.origin };
}

/** Role claimed by a legacy JWT key, or null when the key is not a readable JWT. */
function jwtRole(key) {
  const parts = key.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json)?.role ?? null;
  } catch {
    return null;
  }
}

/** True for a Supabase secret key (new format or a service_role JWT): it bypasses RLS and never goes to a device. */
export const isSecretKey = (key) => key.startsWith('sb_secret_') || jwtRole(key) === 'service_role';

function checkAnonKey(raw) {
  if (!raw) return { error: 'required' };
  if (isSecretKey(raw)) return { error: 'secret_key' };
  if (raw.length < MIN_KEY_CHARS || raw.length > MAX_FIELD_CHARS || !NO_SPACES.test(raw)) return { error: 'invalid' };
  return { value: raw };
}

function checkToken(raw) {
  if (!raw) return { error: 'required' };
  if (raw.length < MIN_TOKEN_CHARS || raw.length > MAX_FIELD_CHARS || !NO_SPACES.test(raw)) return { error: 'invalid' };
  return { value: raw };
}

const text = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * @param {{ url?: string, anonKey?: string, uploadToken?: string }} input
 * @returns {{ ok: boolean, errors: Record<string, string>, value: { url, anonKey, uploadToken } | null }}
 *   error codes: required, invalid, not_https, has_path, secret_key
 */
export function validateSyncSettings(input = {}) {
  const checks = { url: checkUrl(text(input.url)), anonKey: checkAnonKey(text(input.anonKey)), uploadToken: checkToken(text(input.uploadToken)) };
  const errors = {};
  for (const [field, check] of Object.entries(checks)) if (check.error) errors[field] = check.error;
  const ok = Object.keys(errors).length === 0;
  return { ok, errors, value: ok ? { url: checks.url.value, anonKey: checks.anonKey.value, uploadToken: checks.uploadToken.value } : null };
}

/**
 * Version of the data consent shown before enabling the sync (sync panel, spec §14.1). Changing
 * what the app records or sends means a new version, and every device has to accept it again.
 */
export const CONSENT_VERSION = 'vd-consent-datos-v2';

/** A consent of the current version with an ISO acceptance date, or null. */
function currentConsent(consent) {
  return consent?.version === CONSENT_VERSION && typeof consent.acceptedAt === 'string' && !Number.isNaN(Date.parse(consent.acceptedAt))
    ? { version: consent.version, acceptedAt: consent.acceptedAt }
    : null;
}

/** Stored settings, or null when absent, unreadable or invalid. */
export function loadSyncSettings(storage = globalThis.localStorage) {
  let raw;
  try {
    raw = storage?.getItem(SYNC_SETTINGS_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let stored;
  try {
    stored = JSON.parse(raw);
  } catch {
    return null;
  }
  const { ok, value } = validateSyncSettings(stored ?? {});
  if (!ok) return null;
  // Enabled only with the current consent: settings saved before it (or under an older one) load disabled.
  const consent = currentConsent(stored.consent);
  return { enabled: stored.enabled === true && consent !== null, consent, ...value };
}

/**
 * Validates and stores the settings; throws on invalid settings, on enabling without the current
 * consent, or on unavailable storage. Disabling withdraws the consent (stored as null).
 */
export function saveSyncSettings(storage, settings) {
  const { ok, value, errors } = validateSyncSettings(settings);
  if (!ok) throw new RangeError(`invalid sync settings: ${Object.keys(errors).join(', ')}`);
  const enabled = settings.enabled === true;
  const consent = enabled ? currentConsent(settings.consent) : null;
  if (enabled && consent === null) throw new RangeError(`enabling the sync needs the data consent ${CONSENT_VERSION}`);
  const stored = { enabled, consent, ...value };
  storage.setItem(SYNC_SETTINGS_KEY, JSON.stringify(stored));
  return stored;
}

/** Removes the stored settings; unavailable storage is ignored. */
export function clearSyncSettings(storage = globalThis.localStorage) {
  try {
    storage?.removeItem(SYNC_SETTINGS_KEY);
  } catch {
    /* storage unavailable: nothing was stored there */
  }
}

/**
 * Same port as the workday repository. save() goes through the syncing repository (which
 * queues the send) only while isEnabled() is true; remove() and clear() always do, so
 * deleting a workday also cancels a send queued before the sync was turned off.
 */
export function createOptInRepository({ repository, syncingRepository, isEnabled }) {
  return {
    ...repository,
    save: (workday) => (isEnabled() ? syncingRepository.save(workday) : repository.save(workday)),
    remove: (id) => syncingRepository.remove(id),
    clear: () => syncingRepository.clear(),
  };
}
