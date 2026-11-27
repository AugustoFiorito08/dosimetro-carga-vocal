// Account dialog (odd/tasks/base-por-roles.md, T2): sign in with an email link, show who is
// signed in and with which role, sign out. Opened from the technical top bar and from the teacher
// view. The roles come from the database (src/auth/access.js); onAccess gets them, or null when
// signed out, so the app shows each role its screens.
import { loadAccess, roleLabel } from '../auth/access.js';

const LINK_ERRORS = {
  invalid_email: 'Escribí un correo válido.',
  not_allowed: 'Ese correo no tiene una cuenta en el estudio. Pedile al equipo que te dé de alta.',
  rate_limited: 'Se pidieron muchos enlaces seguidos. Esperá unos minutos y volvé a intentar.',
  network: 'Sin conexión. Probá de nuevo cuando haya internet.',
  server: 'El servidor no respondió. Probá de nuevo en unos minutos.',
};

/**
 * @param {object} deps
 * @param {ReturnType<import('../auth/supabase-auth.js').createAuthClient>} deps.auth
 * @param {(id: string) => HTMLElement} deps.$
 * @param {HTMLElement[]} deps.buttons buttons that open the dialog; their text shows the state
 * @param {(access: object | null) => void} deps.onAccess
 * @param {Location} [deps.location]
 * @param {History} [deps.history]
 */
export function createAccountPanel({ auth, $, buttons, onAccess, location = globalThis.location, history = globalThis.history }) {
  const dialog = $('account-dialog');
  const form = $('account-form');
  const email = $('account-email');
  const status = $('account-status');
  const who = $('account-who');
  const signedIn = $('account-signed-in');
  let access = null;
  let session = null;

  const say = (text, kind = 'info') => {
    status.textContent = text;
    status.dataset.kind = kind;
    status.hidden = !text;
  };

  function render() {
    form.hidden = Boolean(session) || !auth.configured;
    signedIn.hidden = !session;
    who.textContent = session ? `${session.email ?? 'Cuenta'} · ${access ? roleLabel(access) : 'leyendo el rol…'}` : '';
    for (const b of buttons) b.textContent = session ? (access ? roleLabel(access) : 'Cuenta') : 'Entrar';
    if (!auth.configured) say('El inicio de sesión todavía no está configurado en esta versión de la app.', 'error');
  }

  async function refreshAccess() {
    try {
      session = await auth.session();
    } catch (error) {
      say(error.code === 'network' ? 'Sin conexión: no se pudo renovar la sesión.' : 'No se pudo renovar la sesión.', 'error');
      return render();
    }
    access = null;
    render();
    if (session) {
      try {
        access = await loadAccess(auth);
      } catch (error) {
        say(error.code === 'network' ? 'Sin conexión: no se pudo leer tu rol. Las pantallas de Dirección y Analítica aparecen cuando vuelva la conexión.' : 'No se pudo leer tu rol.', 'error');
      }
    }
    render();
    onAccess(access);
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    say('Enviando el enlace…');
    try {
      await auth.requestLink(email.value, `${location.origin}${location.pathname}`);
      say(`Listo: revisá el correo ${email.value.trim()} y abrí el enlace en este mismo equipo y navegador.`, 'ok');
    } catch (error) {
      say(LINK_ERRORS[error.code] ?? 'No se pudo enviar el enlace.', 'error');
    } finally {
      button.disabled = false;
    }
  });

  $('account-sign-out').addEventListener('click', async () => {
    await auth.signOut();
    session = null;
    access = null;
    say('Cerraste la sesión.', 'ok');
    render();
    onAccess(null);
  });
  $('account-close').addEventListener('click', () => dialog.close());
  for (const b of buttons) {
    b.addEventListener('click', () => {
      if (!dialog.open) dialog.showModal();
    });
  }

  return {
    /** Takes a sign-in return from the address, then reads the session and the roles. */
    async start() {
      if (!auth.configured) {
        render();
        onAccess(null);
        return;
      }
      const back = auth.consumeRedirect(location.hash);
      if (back) {
        history.replaceState(null, '', `${location.pathname}${location.search}`);
        if (back.error) {
          say(back.error.code === 'otp_expired' ? 'El enlace venció o ya se usó. Pedí uno nuevo.' : 'No se pudo iniciar sesión con ese enlace. Pedí uno nuevo.', 'error');
          dialog.showModal();
        } else {
          say('Sesión iniciada.', 'ok');
        }
      }
      await refreshAccess();
    },
    access: () => access,
  };
}
