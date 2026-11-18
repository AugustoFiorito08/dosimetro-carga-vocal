// Dashboard controller: chooses the data source (stored workdays or the simulated set),
// keeps the filter state of each tab and re-renders a tab when it is shown or changed.
import { generateDemoWorkdays } from '../../store/demo-data.js';
import { exportWorkdays, importWorkdays } from '../../store/workday-io.js';
import { renderAnalytics, renderDirector, renderTeacher, summariesCsv } from './views.js';

const RENDERERS = { teacher: renderTeacher, director: renderDirector, analytics: renderAnalytics };

/**
 * @param {{ roots: Record<'teacher' | 'director' | 'analytics', HTMLElement>, bar: HTMLElement,
 *   repository: object, download: (text: string, name: string, type: string) => void, say: (text: string, tone?: string) => void }} deps
 */
export function createBoards({ roots, bar, repository, download, say }) {
  const shared = { dose: 'none', caseThreshold: 20 };
  const state = { teacher: Object.create(shared), director: Object.create(shared), analytics: shared };
  let source = 'real';
  let demo = null;
  let visible = null;

  const workdays = async () => (source === 'demo' ? (demo ??= generateDemoWorkdays()) : repository.list());

  async function render(tab = visible) {
    if (!tab) return;
    const data = await workdays();
    bar.querySelector('[data-count]').textContent = `${data.length} jornadas`;
    bar.querySelector('[data-demo-banner]').hidden = source !== 'demo';
    RENDERERS[tab](roots[tab], data, state[tab]);
  }

  for (const [tab, root] of Object.entries(roots)) {
    root.addEventListener('change', (event) => {
      const key = event.target.dataset?.filter;
      if (!key) return;
      const value = event.target.type === 'number' ? Math.max(1, Math.min(100, Number(event.target.value) || 20)) : event.target.value;
      if (key === 'dose' || key === 'caseThreshold') shared[key] = value;
      else state[tab][key] = value;
      render(tab);
    });
    root.addEventListener('click', async (event) => {
      if (event.target.dataset?.action !== 'export-csv') return;
      download(summariesCsv(await workdays()), `jornadas_${source}.csv`, 'text/csv;charset=utf-8');
    });
  }

  bar.querySelector('[data-source]').addEventListener('change', (event) => {
    source = event.target.value;
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
      if (source === 'real') render();
    },
    refresh: () => render(),
  };
}
