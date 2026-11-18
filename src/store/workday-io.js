// Workday exchange between devices: a JSON envelope { format, exportedAt, workdays }.
import { validateWorkday } from './workday.js';

export const EXPORT_FORMAT = 'vd-des-workdays/1';

export function exportWorkdays(workdays, now = new Date()) {
  return JSON.stringify({ format: EXPORT_FORMAT, exportedAt: now.toISOString(), workdays }, null, 2);
}

/**
 * Adds the valid workdays not already stored (by id), marked as imported.
 * @returns {Promise<{ added: number, skipped: number, invalid: { id: string, error: string }[] }>}
 */
export async function importWorkdays(repository, text) {
  const data = JSON.parse(text);
  if (data?.format !== EXPORT_FORMAT || !Array.isArray(data.workdays)) {
    throw new Error(`unsupported file: expected format ${EXPORT_FORMAT}`);
  }
  const result = { added: 0, skipped: 0, invalid: [] };
  for (const raw of data.workdays) {
    const w = { ...raw, source: raw?.source === 'demo' ? 'demo' : 'import' };
    try {
      validateWorkday(w);
    } catch (error) {
      result.invalid.push({ id: String(raw?.id ?? '?'), error: error.message });
      continue;
    }
    if (await repository.get(w.id)) result.skipped++;
    else {
      await repository.save(w);
      result.added++;
    }
  }
  return result;
}
