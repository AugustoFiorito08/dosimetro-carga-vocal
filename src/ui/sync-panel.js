// Sync settings panel (spec §14.1, phase F3): the device's Supabase url, public key and
// upload token, typed here and stored only in this browser, plus the opt-in switch. While
// enabled, it runs the sync service over the existing outbox with the Supabase transport.
import { createSupabaseTransport } from '../store/supabase-transport.js';
import { createSyncService } from '../store/sync-service.js';
import { clearSyncSettings, loadSyncSettings, saveSyncSettings, validateSyncSettings } from '../store/sync-settings.js';

const FIELDS = { url: 'sync-url', anonKey: 'sync-anon', uploadToken: 'sync-token' };
const FIELD_ERRORS = {
  url: {
    required: 'Ingresá la URL del proyecto.',
    invalid: 'No es una URL válida.',
    not_https: 'La URL debe usar https.',
    has_path: 'Usá solo la URL del proyecto (https://<proyecto>.supabase.co), sin ruta.',
  },
  anonKey: {
    required: 'Ingresá la clave pública (anon o publishable).',
    invalid: 'La clave parece incompleta o tiene espacios.',
    secret_key: 'Esa es una clave secreta (service_role o secret): nunca la cargues en un equipo. Usá la clave pública.',
  },
  uploadToken: {
    required: 'Ingresá el token de subida.',
    invalid: 'El token parece incompleto o tiene espacios.',
  },
};
const ERROR_HINTS = {
  unauthorized: 'el servidor no aceptó el token de subida (revisalo o pedí uno nuevo)',
  forbidden: 'la jornada es de una escuela distinta a la del token',
  not_found: 'no se encontró la función en el servidor (¿se ejecutó la última versión de supabase/workday_sync.sql?)',
};

const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * @param {object} deps
 * @param {(id: string) => HTMLElement} deps.$
 * @param {{ list, removeIfRev, updateIfRev }} deps.outbox
 * @param {{ removeIf }} deps.repository the plain local repository
 * @param {() => void} [deps.onPurged] a sent workday was removed locally (refresh the boards)
 * @param {Storage} [deps.storage]
 * @param {Window} [deps.win]
 */
export function createSyncPanel({ $, outbox, repository, onPurged, storage = globalThis.localStorage, win = globalThis.window, frames = null }) {
  let settings = loadSyncSettings(storage);
  let service = null;
  let lastEvent = null;

  const isEnabled = () => settings?.enabled === true && service !== null;

  function setStatus(text, tone = 'info') {
    $('sync-status').textContent = text;
    $('sync-status').dataset.tone = tone;
  }

  function showFieldErrors(errors = {}) {
    for (const [field, id] of Object.entries(FIELDS)) {
      const message = errors[field] ? FIELD_ERRORS[field][errors[field]] ?? 'Valor no válido.' : '';
      $(`${id}-error`).textContent = message;
      $(id).setAttribute('aria-invalid', String(Boolean(message)));
    }
  }

  function fillForm() {
    $('sync-url').value = settings?.url ?? '';
    $('sync-anon').value = settings?.anonKey ?? '';
    $('sync-token').value = settings?.uploadToken ?? '';
    $('sync-enabled').checked = settings?.enabled === true;
  }

  function describeError(error) {
    const hint = ERROR_HINTS[error?.code];
    return hint ? `${hint} — ${error.message}` : String(error?.message ?? error);
  }

  function describeEvent(event) {
    if (!event) return '';
    if (event.type === 'sent' && event.kind === 'frames') return ` Últimos datos por trama enviados a las ${clock(event.at)}${event.purged ? ' y borrados de este equipo' : ''}.`;
    if (event.type === 'sent') return ` Última jornada enviada a las ${clock(event.at)}${event.purged ? ' y borrada de este equipo' : ''}.`;
    if (event.type === 'retry') return ` Falló el intento ${event.attempts}; se reintenta a las ${clock(event.nextAttemptAt)}: ${describeError(event.error)}.`;
    if (event.type === 'rejected') return ` El servidor rechazó una jornada y no se reintentará: ${describeError(event.error)}.`;
    return '';
  }

  async function renderStatus() {
    $('sync-badge').textContent = isEnabled() ? 'Activado' : 'Desactivado';
    $('sync-flush').disabled = !isEnabled();
    $('sync-clear').disabled = settings === null;
    let counts = { pending: 0, rejected: 0 };
    try {
      const items = await outbox.list();
      const workdays = items.filter((i) => i.kind !== 'frames');
      counts = {
        pending: workdays.filter((i) => i.state === 'pending').length,
        rejected: workdays.filter((i) => i.state === 'rejected').length,
        frames: items.filter((i) => i.kind === 'frames').length,
      };
    } catch (error) {
      return setStatus(`No se pudo leer la cola de envío: ${error.message}`, 'error');
    }
    const queue = `En cola: ${plural(counts.pending, 'jornada pendiente', 'jornadas pendientes')}${counts.rejected ? `, ${plural(counts.rejected, 'rechazada', 'rechazadas')}` : ''}${counts.frames ? `; datos por trama de ${plural(counts.frames, 'jornada', 'jornadas')}` : ''}.`;
    if (!isEnabled()) {
      setStatus(`${settings ? 'Credenciales guardadas; envío desactivado.' : 'Sin configurar: no se envía nada.'} ${queue}`);
      return;
    }
    const tone = lastEvent && lastEvent.type !== 'sent' ? 'error' : 'info';
    setStatus(`Envío activado. ${queue}${describeEvent(lastEvent)}`, tone);
  }

  function stopService() {
    service?.stop();
    service = null;
  }

  /** Starts or stops the service to match the stored settings. */
  function apply() {
    stopService();
    if (settings?.enabled !== true) return;
    try {
      const transport = createSupabaseTransport({ url: settings.url, anonKey: settings.anonKey, uploadToken: settings.uploadToken });
      service = createSyncService({
        transport,
        outbox,
        repository,
        frames,
        onEvent: (event) => {
          lastEvent = { ...event, at: Date.now() };
          if (event.type === 'sent' && event.purged) onPurged?.();
          renderStatus();
        },
        onError: (error) => setStatus(`Error en la cola de envío: ${error.message}`, 'error'),
      });
      service.start();
      service.flush();
    } catch (error) {
      service = null;
      setStatus(`No se pudo activar el envío: ${error.message}`, 'error');
    }
  }

  $('sync-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = { url: $('sync-url').value, anonKey: $('sync-anon').value, uploadToken: $('sync-token').value };
    const { ok, errors } = validateSyncSettings(input);
    showFieldErrors(errors);
    if (!ok) return setStatus('No se guardó: revisá los campos marcados.', 'error');
    try {
      settings = saveSyncSettings(storage, { ...input, enabled: $('sync-enabled').checked });
    } catch (error) {
      return setStatus(`No se pudo guardar en este navegador: ${error.message}`, 'error');
    }
    fillForm();
    lastEvent = null;
    apply();
    renderStatus().then(() => {
      setStatus(`Configuración guardada. ${$('sync-status').textContent}`, $('sync-status').dataset.tone);
    });
  });

  $('sync-flush').addEventListener('click', async () => {
    if (!service) return;
    setStatus('Enviando…');
    const result = await service.flush();
    await renderStatus();
    if (result.skipped === 'offline') setStatus(`Sin conexión: se enviará al volver. ${$('sync-status').textContent}`, 'error');
    else if (result.sent === 0 && result.failed === 0) setStatus(`No había jornadas para enviar ahora. ${$('sync-status').textContent}`);
  });

  $('sync-clear').addEventListener('click', () => {
    if (!win?.confirm('¿Borrar la URL, la clave y el token guardados en este equipo? El envío se desactiva.')) return;
    stopService();
    clearSyncSettings(storage);
    settings = null;
    lastEvent = null;
    fillForm();
    showFieldErrors();
    renderStatus().then(() => setStatus(`Credenciales borradas de este equipo. ${$('sync-status').textContent}`));
  });

  win?.addEventListener('online', () => { service?.flush(); });

  fillForm();
  apply();
  renderStatus();

  return {
    isEnabled,
    /** Sends what is due now (after a save); no-op while disabled. */
    flush() {
      service?.flush();
    },
  };
}
