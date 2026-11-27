// Sign-in with an email link against Supabase Auth, and the screens each role may open
// (odd/tasks/base-por-roles.md, T2, S2, S3, S6).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AUTH_STORAGE_KEY, AuthError, createAuthClient } from '../src/auth/supabase-auth.js';
import { accessFromMembers, allowedBoards, loadAccess, roleLabel } from '../src/auth/access.js';

const URL_OK = 'https://demo.supabase.co';
const ANON = 'sb_publishable_abcdefghijklmnopqrstuvwxyz';

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k), map };
}

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims) => `${b64url({ alg: 'HS256' })}.${b64url(claims)}.sig`;
const USER = '00000000-0000-4000-8000-000000000001';

/** fetch double: records every call and answers from a queue of [status, body]. */
function fakeFetch(...answers) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const [status, body] = answers.shift() ?? [200, {}];
    if (status === 'offline') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

const client = (fetch, { storage = memoryStorage(), now = () => Date.UTC(2026, 10, 27, 12) } = {}) =>
  ({ storage, auth: createAuthClient({ url: URL_OK, anonKey: ANON, fetch, storage, now }) });

describe('email link sign-in (Supabase Auth over REST)', () => {
  it('asks for a link only for existing users, with the app as the return address', async () => {
    const f = fakeFetch([200, {}]);
    const { auth } = client(f.fetch);
    await auth.requestLink('  Docente@Escuela.edu.ar ', 'https://app.example/public/index.html');
    assert.equal(f.calls[0].url, `${URL_OK}/auth/v1/otp?redirect_to=${encodeURIComponent('https://app.example/public/index.html')}`);
    assert.equal(f.calls[0].init.method, 'POST');
    assert.equal(f.calls[0].init.headers.apikey, ANON);
    assert.deepEqual(f.calls[0].body, { email: 'docente@escuela.edu.ar', create_user: false });
  });

  it('explains why a link could not be sent', async () => {
    const reasons = async (answer) => {
      const { auth } = client(fakeFetch(answer).fetch);
      try {
        await auth.requestLink('a@b.co', 'https://app.example/');
        return 'sent';
      } catch (error) {
        assert.ok(error instanceof AuthError);
        return error.code;
      }
    };
    assert.equal(await reasons([422, { error_code: 'otp_disabled' }]), 'not_allowed');
    assert.equal(await reasons([400, { error_code: 'user_not_found' }]), 'not_allowed');
    assert.equal(await reasons([429, {}]), 'rate_limited');
    assert.equal(await reasons(['offline']), 'network');
    const { auth } = client(fakeFetch().fetch);
    await assert.rejects(auth.requestLink('no es un correo', 'https://app.example/'), (e) => e.code === 'invalid_email');
  });

  it('takes the session from the link it returns to and clears it from the address', async () => {
    const { auth, storage } = client(fakeFetch().fetch);
    const token = jwt({ sub: USER, email: 'docente@escuela.edu.ar', exp: 2_000_000_000 });
    const got = auth.consumeRedirect(`#access_token=${token}&expires_in=3600&refresh_token=r1&token_type=bearer&type=magiclink`);
    assert.equal(got.session.userId, USER);
    assert.equal(got.session.email, 'docente@escuela.edu.ar');
    assert.equal(got.session.expiresAt, Date.UTC(2026, 10, 27, 12) + 3600 * 1000);
    assert.equal(JSON.parse(storage.getItem(AUTH_STORAGE_KEY)).refreshToken, 'r1');
    assert.deepEqual(await auth.session(), got.session);
  });

  it('reports an expired or used link and ignores unrelated addresses', () => {
    const { auth, storage } = client(fakeFetch().fetch);
    const got = auth.consumeRedirect('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
    assert.deepEqual(got.error, { code: 'otp_expired', description: 'Email link is invalid or has expired' });
    assert.equal(auth.consumeRedirect(''), null);
    assert.equal(auth.consumeRedirect('#tab=analytics'), null);
    assert.equal(storage.getItem(AUTH_STORAGE_KEY), null);
  });

  it('refreshes a session about to expire, and forgets one the server no longer accepts', async () => {
    let clock = Date.UTC(2026, 10, 27, 12);
    const storage = memoryStorage();
    const token2 = jwt({ sub: USER, email: 'docente@escuela.edu.ar' });
    const f = fakeFetch([200, { access_token: token2, refresh_token: 'r2', expires_in: 3600 }], [400, { error_code: 'refresh_token_not_found' }]);
    const auth = createAuthClient({ url: URL_OK, anonKey: ANON, fetch: f.fetch, storage, now: () => clock });
    auth.consumeRedirect(`#access_token=${jwt({ sub: USER })}&expires_in=3600&refresh_token=r1&token_type=bearer`);
    clock += 3590 * 1000; // ten seconds left
    const s = await auth.session();
    assert.equal(f.calls[0].url, `${URL_OK}/auth/v1/token?grant_type=refresh_token`);
    assert.deepEqual(f.calls[0].body, { refresh_token: 'r1' });
    assert.equal(s.refreshToken, 'r2');
    clock += 3600 * 1000;
    assert.equal(await auth.session(), null);
    assert.equal(storage.getItem(AUTH_STORAGE_KEY), null);
  });

  it('keeps the session when the refresh fails for lack of network', async () => {
    let clock = Date.UTC(2026, 10, 27, 12);
    const f = fakeFetch(['offline']);
    const auth = createAuthClient({ url: URL_OK, anonKey: ANON, fetch: f.fetch, storage: memoryStorage(), now: () => clock });
    auth.consumeRedirect(`#access_token=${jwt({ sub: USER })}&expires_in=3600&refresh_token=r1`);
    clock += 3590 * 1000;
    await assert.rejects(auth.session(), (e) => e.code === 'network');
    clock -= 3590 * 1000;
    assert.ok(await auth.session(), 'still there for the next try');
  });

  it('signs out on the server and on the device, even offline', async () => {
    const f = fakeFetch(['offline']);
    const { auth, storage } = client(f.fetch);
    auth.consumeRedirect(`#access_token=${jwt({ sub: USER })}&expires_in=3600&refresh_token=r1`);
    await auth.signOut();
    assert.equal(f.calls[0].url, `${URL_OK}/auth/v1/logout`);
    assert.match(f.calls[0].init.headers.authorization, /^Bearer /);
    assert.equal(storage.getItem(AUTH_STORAGE_KEY), null);
    assert.equal(await auth.session(), null);
  });

  it('reads the database with the public key and the user token', async () => {
    const f = fakeFetch([200, [{ role: 'teacher' }]]);
    const { auth } = client(f.fetch);
    const token = jwt({ sub: USER });
    auth.consumeRedirect(`#access_token=${token}&expires_in=3600&refresh_token=r1`);
    const rows = await auth.rest('members?select=role');
    assert.deepEqual(rows, [{ role: 'teacher' }]);
    assert.equal(f.calls[0].url, `${URL_OK}/rest/v1/members?select=role`);
    assert.equal(f.calls[0].init.headers.apikey, ANON);
    assert.equal(f.calls[0].init.headers.authorization, `Bearer ${token}`);
  });

  it('is not configured without a url and public key, and refuses a secret key', () => {
    assert.equal(createAuthClient({ url: '', anonKey: '' }).configured, false);
    assert.throws(() => createAuthClient({ url: URL_OK, anonKey: 'sb_secret_abcdefghijklmnopqrstuvwxyz' }), /secret/);
    const { auth } = client(fakeFetch().fetch);
    assert.equal(auth.configured, true);
  });
});

describe('screens by role', () => {
  const teacher = { role: 'teacher', school_id: 'E1', participant_id: 'P1' };
  const director = { role: 'director', school_id: 'E1', participant_id: null };
  const analystE2 = { role: 'analyst', school_id: 'E2', participant_id: null };
  const analystAll = { role: 'analyst', school_id: null, participant_id: null };

  it('reads the roles of the signed-in person', () => {
    assert.deepEqual(accessFromMembers([]), { signedIn: true, roles: [], teacher: null, directorSchools: [], analyst: null });
    const a = accessFromMembers([teacher, director, analystE2]);
    assert.deepEqual(a.roles, ['teacher', 'director', 'analyst']);
    assert.deepEqual(a.teacher, { participantId: 'P1', schoolId: 'E1' });
    assert.deepEqual(a.directorSchools, ['E1']);
    assert.deepEqual(a.analyst, { allSchools: false, schools: ['E2'] });
    assert.deepEqual(accessFromMembers([analystE2, analystAll]).analyst, { allSchools: true, schools: ['E2'] });
  });

  it('measuring, the score and Mi jornada for everyone; Dirección for directors and analysts; Analítica only for analysts', () => {
    const boards = (rows) => [...allowedBoards(rows === null ? null : accessFromMembers(rows))].sort();
    const own = ['live', 'score', 'teacher'];
    assert.deepEqual(boards(null), own, 'signed out');
    assert.deepEqual(boards([]), own, 'signed in without a role');
    assert.deepEqual(boards([teacher]), own);
    assert.deepEqual(boards([director]), [...own, 'director'].sort());
    assert.deepEqual(boards([analystE2]), [...own, 'analytics', 'director'].sort());
  });

  it('names the role in plain words', () => {
    assert.equal(roleLabel(accessFromMembers([teacher])), 'Docente P1');
    assert.equal(roleLabel(accessFromMembers([director])), 'Dirección E1');
    assert.equal(roleLabel(accessFromMembers([analystAll])), 'Análisis (todas las escuelas)');
    assert.equal(roleLabel(accessFromMembers([analystE2])), 'Análisis E2');
    assert.equal(roleLabel(accessFromMembers([])), 'Sin rol asignado');
  });

  it('loads the roles through the signed-in session', async () => {
    const calls = [];
    const auth = { rest: async (path) => { calls.push(path); return [teacher]; } };
    const a = await loadAccess(auth);
    assert.deepEqual(calls, ['members?select=role,school_id,participant_id']);
    assert.deepEqual(a.teacher, { participantId: 'P1', schoolId: 'E1' });
  });
});
