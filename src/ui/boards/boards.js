// Dashboard controller: chooses the data source (stored workdays or the simulated set),
// keeps the filter state of each tab and re-renders a tab when it is shown or changed.
import { generateDemoWorkdays } from '../../store/demo-data.js';
import { addRecoveryPoint } from '../../store/recovery.js';
import { recoveryCalendar } from '../../store/recovery-reminders.js';
import { exportWorkdays, importWorkdays } from '../../store/workday-io.js';
import { UNIT_LABELS, selectByUnits } from './aggregate.js';
import { paramText, recomputeBody, recomputeState, renderAnalytics, renderDirector, renderTeacher, summariesCsv } from './views.js';

const RENDERERS = { teacher: renderTeacher, director: renderDirector, analytics: renderAnalytics };

/**
 * @param {{ roots: Record<'teacher' | 'director' | 'analytics', HTMLElement>, bar: HTMLElement,
 *   repository: object, download: (text: string, name: string, type: string) => void, say: (text: string, tone?: string) => void,
 *   reminders?: { enable: () => Promise<string>, refresh: () => void } }} deps
 */
export function createBoards({ roots, bar, repository, download, say, reminders }) {
  const shared = { dose: 'none', caseThreshold: 20 };
  const state = { teacher: Object.create(shared), director: Object.create(shared), analytics: shared };
  let source = 'real';
  let demo = null;
  let visible = null;
  let units = null; // null: the units of the most recent workday
  const shown = {}; // workdays on screen per tab, for the recomputation panel

  const workdays = async () => (source === 'demo' ? (demo ??= generateDemoWorkdays()) : repository.list());

  async function render(tab = visible) {
    if (!tab) return;
    const all = await workdays();
    // Doses in different units are on different scales: one units value per view.
    const selection = selectByUnits(all, units);
    const select = bar.querySelector('[data-units]');
    select.replaceChildren(...selection.available.map(({ units: u, count }) => new Option(`${UNIT_LABELS[u] ?? u} (${count})`, u, false, u === selection.units)));
    bar.querySelector('[data-units-wrap]').hidden = selection.available.length < 2;
    bar.querySelector('[data-count]').textContent = `${selection.workdays.length} jornadas${selection.excluded ? ` · ${selection.excluded} con otras unidades, no incluidas` : ''}`;
    bar.querySelector('[data-demo-banner]').hidden = source !== 'demo';
    if (tab === 'teacher') state.teacher.notificationPermission = globalThis.Notification?.permission ?? 'unsupported';
    shown[tab] = selection.workdays;
    RENDERERS[tab](roots[tab], selection.workdays, state[tab]);
  }

  async function saveRecovery(tab, root, slot) {
    if (source !== 'real') return;
    const value = Number(root.querySelector('[data-recovery-value]')?.value);
    try {
      const workday = await repository.get(state[tab].workdayId);
      if (!workday) throw new RangeError('workday not found');
      await repository.save(addRecoveryPoint(workday, { slot, value, at: new Date() }));
      say(`Fatiga de recuperación registrada: ${value}/100.`);
      reminders?.refresh();
    } catch (error) {
      say(`No se pudo registrar la recuperación: ${/not open|already/.test(error.message) ? 'ese momento ya no está abierto o ya tiene un registro.' : error.message}`, 'error');
    }
    render(tab);
  }

  async function downloadCalendar(tab) {
    try {
      const workday = await repository.get(state[tab].workdayId);
      download(recoveryCalendar(workday), 'recuperacion-vocal.ics', 'text/calendar;charset=utf-8');
      say('Abrí el archivo descargado para agregar los horarios a tu calendario.');
    } catch (error) {
      say(`No se pudo crear el calendario: ${error.message.includes('no pending') ? 'ya no quedan horarios pendientes.' : error.message}`, 'error');
    }
  }

  for (const [tab, root] of Object.entries(roots)) {
    root.addEventListener('change', (event) => {
      if (event.target.dataset?.param === 'recomputeWorkday') return void recompute(event);
      const key = event.target.dataset?.filter;
      if (!key) return;
      const { min, max } = event.target;
      const value = event.target.type === 'number'
        ? Math.max(Number(min) || 1, Math.min(Number(max) || 100, Number(event.target.value) || Number(event.target.defaultValue) || 20))
        : event.target.value;
      if (key === 'dose' || key === 'caseThreshold') shared[key] = value;
      else state[tab][key] = value;
      render(tab);
    });
    // Recomputation panel (Analítica): β, α_L and the workday re-render only its body.
    const recompute = (event) => {
      const key = event.target.dataset?.param;
      if (!key) return false;
      state[tab][key] = event.target.value;
      const body = root.querySelector('[data-recompute-body]');
      if (!body || !shown[tab]) return true;
      const values = recomputeState(state[tab]);
      for (const out of root.querySelectorAll('[data-param-out]')) out.textContent = paramText(out.dataset.paramOut, values[out.dataset.paramOut]);
      body.innerHTML = recomputeBody(shown[tab], state[tab]);
      return true;
    };
    root.addEventListener('input', (event) => {
      if (recompute(event)) return;
      if (event.target.dataset?.recoveryValue === undefined) return;
      const output = event.target.parentElement.querySelector('output');
      if (output) output.textContent = event.target.value;
    });
    root.addEventListener('click', async (event) => {
      const action = event.target.dataset?.action;
      if (action === 'recompute-reset') {
        for (const key of Object.keys(state[tab])) if (key.startsWith('recompute:')) delete state[tab][key];
        return render(tab);
      }
      if (action === 'recovery-save') return saveRecovery(tab, root, event.target.dataset.slot);
      if (action === 'recovery-ics') return downloadCalendar(tab);
      if (action === 'recovery-notify') {
        const permission = await reminders?.enable();
        if (permission === 'denied') say('El navegador bloqueó los avisos. Agregá los horarios al calendario.', 'error');
        return render(tab);
      }
      if (action !== 'export-csv') return;
      download(summariesCsv(await workdays()), `jornadas_${source}.csv`, 'text/csv;charset=utf-8');
    });
  }

  bar.querySelector('[data-source]').addEventListener('change', (event) => {
    source = event.target.value;
    units = null;
    render();
  });
  bar.querySelector('[data-units]').addEventListener('change', (event) => {
    units = event.target.value;
    render();
  });
  bar.querySelector('[data-export]').addEventListener('click', async () => {
    const data = await repository.list();
    if (!data.length) return say('No hay jornadas reales guardadas para exportar.', 'error');
    download(exportWorkdays(data), 'jornadas_vd-des.json', 'application/json');
    say(`Exportadas ${data.length} jornadas.`);
  });
  bar.querySelector('[data-import]').addEventListener('change', async (event) => {
    const [file] = event.target.files;
    event.target.value = '';
    if (!file) return;
    try {
      const r = await importWorkdays(repository, await file.text());
      say(`Importación: ${r.added} nuevas, ${r.skipped} ya existentes${r.invalid.length ? `, ${r.invalid.length} inválidas` : ''}.`, r.invalid.length ? 'error' : 'info');
      render();
    } catch (error) {
      say(`No se pudo importar: ${error.message}`, 'error');
    }
  });
  bar.querySelector('[data-clear]').addEventListener('click', async () => {
    const data = await repository.list();
    if (!data.length) return say('No hay jornadas reales guardadas.');
    // eslint-disable-next-line no-alert
    if (!globalThis.confirm(`¿Borrar las ${data.length} jornadas guardadas en este navegador? No se puede deshacer; exportalas antes si las necesitás.`)) return;
    await repository.clear();
    say('Jornadas borradas de este navegador.');
    render();
  });

  return {
    /** Called when a dashboard tab becomes visible (null for the other tabs). */
    show(tab) {
      visible = tab;
      bar.hidden = tab === null;
      render(tab);
    },
    async save(workday) {
      await repository.save(workday);
      reminders?.refresh();
      if (source === 'real') render();
    },
    refresh: () => render(),
  };
}
