// Sign-in with an email link against Supabase Auth, over its REST API (no SDK; odd/tasks/
// base-por-roles.md, T2, S6). Accounts are created by the study lead, so a link is asked only
// for existing users (create_user: false). The link returns to the app with the session in the
// address fragment (implicit flow); the session is kept in this browser and refreshed before it
// expires. rest() reads the database as the signed-in user, so RLS decides what comes back.
import { isSecretKey } from '../store/sync-settings.js';

export const AUTH_STORAGE_KEY = 'dosimetro.auth';
/** Refresh when less than this is left, so a request never leaves with an expired token. */
const REFRESH_MARGIN_MS = 60 * 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class AuthError extends Error {
  /** @param {'invalid_email' | 'not_allowed' | 'rate_limited' | 'network' | 'expired' | 'server'} code */
  constructor(code, message) {
    super(message ?? code);
    this.code = code;
  }
}

/** Claims of a JWT, or {} when it cannot be read. */
function claims(token) {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(part.padEnd(part.length + ((4 - (part.length % 4)) % 4), '=')));
  } catch {
    return {};
  }
}

/**
 * @param {{ url: string, anonKey: string, fetch?: typeof fetch, storage?: Storage, now?: () => number }} deps
 */
export function createAuthClient({ url, anonKey, fetch = globalThis.fetch, storage = globalThis.localStorage, now = () => Date.now() }) {
  if (anonKey && isSecretKey(anonKey)) throw new RangeError('a secret key never goes to the app: use the public (anon or publishable) key');
  const configured = Boolean(url && anonKey);
  const base = url?.replace(/\/+$/, '');

  const read = () => {
    try {
      const s = JSON.parse(storage?.getItem(AUTH_STORAGE_KEY) ?? 'null');
      return s && typeof s.accessToken === 'string' && typeof s.refreshToken === 'string' ? s : null;
    } catch {
      return null;
    }
  };
  const write = (s) => {
    try {
      if (s) storage?.setItem(AUTH_STORAGE_KEY, JSON.stringify(s));
      else storage?.removeItem(AUTH_STORAGE_KEY);
    } catch {
      // private mode or blocked storage: the session lives only in this page
    }
  };
  let memory = read();

  const toSession = ({ access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn }) => {
    const c = claims(accessToken);
    return { accessToken, refreshToken, expiresAt: now() + Number(expiresIn) * 1000, userId: c.sub ?? null, email: c.email ?? null };
  };

  async function call(path, init) {
    try {
      return await fetch(`${base}${path}`, init);
    } catch {
      throw new AuthError('network', 'no connection');
    }
  }
  const body = async (res) => {
    try {
      return await res.json();
    } catch {
      return {};
    }
  };

  async function refresh(current) {
    const res = await call('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: { apikey: anonKey, 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: current.refreshToken }),
    });
    if (!res.ok) {
      if (res.status >= 500) throw new AuthError('server', `refresh failed (${res.status})`);
      memory = null;
      write(null); // revoked, used or expired: sign in again
      return null;
    }
    memory = toSession(await body(res));
    write(memory);
    return memory;
  }

  return {
    configured,

    /** Sends the sign-in link to an existing user's email. */
    async requestLink(email, redirectTo) {
      const address = String(email ?? '').trim().toLowerCase();
      if (!EMAIL.test(address)) throw new AuthError('invalid_email', 'not an email address');
      const res = await call(`/auth/v1/otp?redirect_to=${encodeURIComponent(redirectTo)}`, {
        method: 'POST',
        headers: { apikey: anonKey, 'content-type': 'application/json' },
        body: JSON.stringify({ email: address, create_user: false }),
      });
      if (res.ok) return;
      if (res.status === 429) throw new AuthError('rate_limited', 'too many links requested');
      if (res.status >= 500) throw new AuthError('server', `link request failed (${res.status})`);
      throw new AuthError('not_allowed', (await body(res)).error_code ?? `status ${res.status}`);
    },

    /**
     * The session (or the error) carried by the address fragment the link returned to; null when
     * the fragment is not a sign-in return. The caller removes the fragment from the address.
     */
    consumeRedirect(hash) {
      const params = new URLSearchParams(String(hash ?? '').replace(/^#/, ''));
      if (params.get('error') || params.get('error_code')) {
        return { error: { code: params.get('error_code') ?? params.get('error'), description: params.get('error_description') ?? '' } };
      }
      if (!params.get('access_token') || !params.get('refresh_token')) return null;
      memory = toSession({ access_token: params.get('access_token'), refresh_token: params.get('refresh_token'), expires_in: params.get('expires_in') ?? 3600 });
      write(memory);
      return { session: memory };
    },

    /** The current session, refreshed when about to expire; null when signed out. */
    async session() {
      const current = memory ?? read();
      if (!current) return null;
      if (current.expiresAt - now() > REFRESH_MARGIN_MS) return current;
      return refresh(current);
    },

    /** Ends the session on the server when it can, and always on this device. */
    async signOut() {
      const current = memory ?? read();
      memory = null;
      write(null);
      if (!current) return;
      try {
        await call('/auth/v1/logout', { method: 'POST', headers: { apikey: anonKey, authorization: `Bearer ${current.accessToken}` } });
      } catch {
        // offline: the token expires on its own
      }
    },

    /** GET or POST on the database REST API as the signed-in user; resolves to the JSON body. */
    async rest(path, { method = 'GET', body: payload } = {}) {
      const current = await this.session();
      if (!current) throw new AuthError('expired', 'sign in again');
      const res = await call(`/rest/v1/${path}`, {
        method,
        headers: { apikey: anonKey, authorization: `Bearer ${current.accessToken}`, 'content-type': 'application/json' },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      const data = await body(res);
      if (!res.ok) throw Object.assign(new AuthError(res.status === 401 ? 'expired' : 'server', data.message ?? `status ${res.status}`), { status: res.status, pgCode: data.code });
      return data;
    },
  };
}
