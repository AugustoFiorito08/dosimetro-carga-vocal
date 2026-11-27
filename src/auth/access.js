// What the signed-in person may open (odd/tasks/base-por-roles.md, T2, S2, S3). The database
// enforces what each role reads (supabase/schema.sql); this only decides which screens to show.
// Measuring, the score and Mi jornada work for everyone, signed in or not, because they use the
// phone's own data; Dirección needs a director or analyst role, Analítica an analyst role.

const OWN_BOARDS = Object.freeze(['live', 'score', 'teacher']);

/** Roles of the signed-in person from her public.members rows. */
export function accessFromMembers(rows) {
  const teacherRow = rows.find((r) => r.role === 'teacher');
  const analystRows = rows.filter((r) => r.role === 'analyst');
  return {
    signedIn: true,
    roles: [...new Set(rows.map((r) => r.role))],
    teacher: teacherRow ? { participantId: teacherRow.participant_id, schoolId: teacherRow.school_id } : null,
    directorSchools: rows.filter((r) => r.role === 'director').map((r) => r.school_id),
    analyst: analystRows.length
      ? { allSchools: analystRows.some((r) => r.school_id === null), schools: analystRows.map((r) => r.school_id).filter((s) => s !== null) }
      : null,
  };
}

/** Reads the roles of the signed-in person (each one reads only her own rows). */
export async function loadAccess(auth) {
  return accessFromMembers(await auth.rest('members?select=role,school_id,participant_id'));
}

/** Boards the person may open; `access` null when signed out. */
export function allowedBoards(access) {
  const boards = new Set(OWN_BOARDS);
  if (access?.directorSchools.length || access?.analyst) boards.add('director');
  if (access?.analyst) boards.add('analytics');
  return boards;
}

/** The role in plain words, for the account bar. */
export function roleLabel(access) {
  if (access.analyst) return access.analyst.allSchools ? 'Análisis (todas las escuelas)' : `Análisis ${access.analyst.schools.join(', ')}`;
  if (access.directorSchools.length) return `Dirección ${access.directorSchools.join(', ')}`;
  if (access.teacher) return `Docente ${access.teacher.participantId}`;
  return 'Sin rol asignado';
}
