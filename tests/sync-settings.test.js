import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryRepository } from '../src/store/workday-repository.js';
import { createMemoryOutbox } from '../src/store/outbox.js';
import { createSyncingRepository } from '../src/store/sync-service.js';
import {
  SYNC_SETTINGS_KEY,
  clearSyncSettings,
  createOptInRepository,
  loadSyncSettings,
  saveSyncSettings,
  validateSyncSettings,
} from '../src/store/sync-settings.js';
import { buildWorkday } from '../src/store/workday.js';
import { createScoreSeries } from '../src/ui/score-series.js';

// Placeholder values only: no real project, key or token belongs in the repository.
const URL_OK = 'https://example-project.supabase.co';
const ANON_OK = 'sb_publishable_placeholder_key_0000';
const TOKEN_OK = 'tk_placeholder_upload_token_0000';

const jwt = (payload) => ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'signature'].join('.');

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
    data,
  };
}

function workday({ source = 'live' } = {}) {
  const series = createScoreSeries();
  series.push({ t: 0, dt: 60, phi: 1, f0: 180, level: 80, h: 1, doses: { none: 60, linear: 60, power: 60, exponential: 60, saturating: 60 }, distanceDose: null });
  const load = {
    h: 1, units: 'relative', ownVoiceReferenceDbfs: null, params: { beta: 1 / 300 },
    doses: { none: 60, linear: 60, power: 60, exponential: 60, saturating: 60 },
    conventionalDoses: { time: 60, cycle: 10800 }, distanceDose: null,
    metrics: { totalTime: 60, phonationTime: 60, nonPhonationTime: 0, timeByCategory: { attributed: 60, uncertain: 0 } },
  };
  const meta = { participantId: 'P-0421', schoolId: 'E-25', classroom: '2B', fatiguePre: null, fatiguePost: null, events: [] };
  return buildWorkday({ meta, load, series, startedAt: new Date(2026, 10, 23, 8, 0, 0), algorithmVersion: '0.8.0', source });
}

describe('validateSyncSettings', () => {
  it('accepts a project url, a public key and a token, trimmed, with the url reduced to its origin', () => {
    const result = validateSyncSettings({ url: `  ${URL_OK}/  `, anonKey: ` ${ANON_OK} `, uploadToken: ` ${TOKEN_OK} ` });
    assert.deepEqual(result, { ok: true, errors: {}, value: { url: URL_OK, anonKey: ANON_OK, uploadToken: TOKEN_OK } });
  });

  it('accepts a legacy anon JWT', () => {
    assert.equal(validateSyncSettings({ url: URL_OK, anonKey: jwt({ role: 'anon' }), uploadToken: TOKEN_OK }).ok, true);
  });

  it('reports every missing field', () => {
    const { ok, errors } = validateSyncSettings({ url: '', anonKey: '', uploadToken: '' });
    assert.equal(ok, false);
    assert.deepEqual(errors, { url: 'required', anonKey: 'required', uploadToken: 'required' });
  });

  it('rejects a url that is not https (http only for localhost) or has a path', () => {
    assert.equal(validateSyncSettings({ url: 'http://example-project.supabase.co', anonKey: ANON_OK, uploadToken: TOKEN_OK }).errors.url, 'not_https');
    assert.equal(validateSyncSettings({ url: 'no es una url', anonKey: ANON_OK, uploadToken: TOKEN_OK }).errors.url, 'invalid');
    assert.equal(validateSyncSettings({ url: `${URL_OK}/rest/v1`, anonKey: ANON_OK, uploadToken: TOKEN_OK }).errors.url, 'has_path');
    assert.equal(validateSyncSettings({ url: 'http://localhost:54321', anonKey: ANON_OK, uploadToken: TOKEN_OK }).ok, true);
  });

  it('refuses secret keys: they must never reach a device', () => {
    assert.equal(validateSyncSettings({ url: URL_OK, anonKey: 'sb_secret_placeholder_key_0000', uploadToken: TOKEN_OK }).errors.anonKey, 'secret_key');
    assert.equal(validateSyncSettings({ url: URL_OK, anonKey: jwt({ role: 'service_role' }), uploadToken: TOKEN_OK }).errors.anonKey, 'secret_key');
  });

  it('rejects short values or values with spaces', () => {
    const { errors } = validateSyncSettings({ url: URL_OK, anonKey: 'short', uploadToken: 'tk with spaces 0000000' });
    assert.deepEqual(errors, { anonKey: 'invalid', uploadToken: 'invalid' });
  });
});

describe('sync settings storage', () => {
  it('saves, loads and clears the settings under one key', () => {
    const storage = memoryStorage();
    assert.equal(loadSyncSettings(storage), null);
    saveSyncSettings(storage, { enabled: true, url: URL_OK, anonKey: ANON_OK, uploadToken: TOKEN_OK });
    assert.deepEqual(loadSyncSettings(storage), { enabled: true, url: URL_OK, anonKey: ANON_OK, uploadToken: TOKEN_OK });
    clearSyncSettings(storage);
    assert.equal(storage.data.has(SYNC_SETTINGS_KEY), false);
    assert.equal(loadSyncSettings(storage), null);
  });

  it('treats corrupt or invalid stored settings as absent and never enabled', () => {
    assert.equal(loadSyncSettings(memoryStorage({ [SYNC_SETTINGS_KEY]: '{oops' })), null);
    const invalid = JSON.stringify({ enabled: true, url: 'http://example.com', anonKey: ANON_OK, uploadToken: TOKEN_OK });
    assert.equal(loadSyncSettings(memoryStorage({ [SYNC_SETTINGS_KEY]: invalid })), null);
  });

  it('survives unavailable storage', () => {
    const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
    assert.equal(loadSyncSettings(broken), null);
    assert.throws(() => saveSyncSettings(broken, { enabled: false, url: URL_OK, anonKey: ANON_OK, uploadToken: TOKEN_OK }), /denied/);
    assert.doesNotThrow(() => clearSyncSettings(broken));
  });
});

describe('createOptInRepository', () => {
  function setup(enabled) {
    const repository = createMemoryRepository();
    const outbox = createMemoryOutbox();
    const syncing = createSyncingRepository(repository, outbox);
    const state = { enabled };
    return { repository, outbox, state, gated: createOptInRepository({ repository, syncingRepository: syncing, isEnabled: () => state.enabled }) };
  }

  it('queues nothing while the sync is off: nothing leaves the browser without opt-in', async () => {
    const { gated, outbox, repository } = setup(false);
    const w = workday();
    await gated.save(w);
    assert.equal((await repository.list()).length, 1);
    assert.deepEqual(await outbox.list(), []);
  });

  it('queues saved live workdays once the sync is on', async () => {
    const { gated, outbox } = setup(true);
    await gated.save(workday());
    assert.equal((await outbox.list()).length, 1);
  });

  it('still cancels queued sends when a workday is removed with the sync off', async () => {
    const { gated, outbox, state } = setup(true);
    const w = workday();
    await gated.save(w);
    state.enabled = false;
    await gated.remove(w.id);
    assert.deepEqual(await outbox.list(), []);
  });
});
