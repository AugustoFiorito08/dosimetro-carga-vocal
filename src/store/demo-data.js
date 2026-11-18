// Simulated workdays for showing the dashboards before real data exist. Seeded and
// reproducible. The simulated fatigue follows the protocol's null hypothesis (H0: the
// memory term adds nothing): it depends on D_0, the teacher's susceptibility and noise
// only, so no memory model is favoured by construction. The demo is not evidence.
import { vibrationAmplitude } from '../math/distance-dose.js';
import { WORKDAY_SCHEMA, workdayId } from './workday.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pad = (n) => String(n).padStart(2, '0');

/**
 * @param {{ seed?: number, schools?: number, classroomsPerSchool?: number, weeks?: number, firstMonday?: Date }} [options]
 */
export function generateDemoWorkdays({ seed = 2026, schools = 3, classroomsPerSchool = 4, weeks = 4, firstMonday = new Date(2026, 9, 19) } = {}) {
  const rand = mulberry32(seed);
  const normal = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const teachers = [];
  let code = 100;
  for (let s = 1; s <= schools; s++) {
    for (let c = 0; c < classroomsPerSchool; c++) {
      const classroom = `${1 + Math.floor(c / 2)}${'AB'[c % 2]}`;
      const count = 3 + Math.floor(rand() * 2);
      for (let k = 0; k < count; k++) {
        const female = rand() < 0.8;
        teachers.push({
          participantId: `P-${String(code++).padStart(4, '0')}`,
          schoolId: `E-${pad(10 + s * 7)}`,
          classroom,
          profile: female ? 'female' : 'male',
          f0: female ? 205 + 20 * normal() : 120 + 12 * normal(),
          level: 80 + 3 * normal(),
          talk: clamp(0.27 + 0.05 * normal(), 0.15, 0.4),
          susceptibility: normal(),
        });
      }
    }
  }

  const out = [];
  for (let week = 0; week < weeks; week++) {
    for (let day = 0; day < 5; day++) {
      const date = new Date(firstMonday);
      date.setDate(firstMonday.getDate() + week * 7 + day);
      for (const t of teachers) {
        if (rand() < 0.05) continue; // absence or leave
        const startedAt = new Date(date);
        startedAt.setHours(7 + Math.floor(rand() * 2), 45 + Math.floor(rand() * 15), 0, 0);
        const durationS = Math.round((3.5 + 2 * rand()) * 3600);
        const phonationS = Math.round(durationS * clamp(t.talk + 0.04 * normal(), 0.12, 0.42));
        const f0 = clamp(t.f0 + 8 * normal(), 90, 320);
        const level = clamp(t.level + 2.5 * normal(), 68, 95);
        const burstiness = rand(); // 0 = evenly spread phonation, 1 = long blocks with short pauses
        const intensity = (20e-6 * 10 ** (level / 20)) ** 2; // (P / 1 Pa)^2
        const none = f0 * intensity * phonationS;
        const doses = {
          none,
          linear: none * (1.25 + 0.5 * burstiness),
          power: none * (1.1 + 0.6 * burstiness),
          exponential: none * (1.2 + 0.9 * burstiness),
          saturating: none * (1.4 + 0.4 * burstiness),
          distance: 4 * vibrationAmplitude(f0, level - 20, t.profile) * f0 * phonationS,
          time: phonationS,
          cycle: f0 * phonationS,
        };
        const minutes = Math.ceil(durationS / 60);
        const breakAt = Math.floor(minutes * (0.35 + 0.1 * rand()));
        const weights = Array.from({ length: minutes }, (_, i) => (i >= breakAt && i < breakAt + 20 ? 0 : 0.4 + rand()));
        const total = weights.reduce((a, b) => a + b, 0);
        const timeline = { minutes: Array.from({ length: minutes }, (_, i) => i + 1), doses: {} };
        for (const [name, value] of Object.entries(doses)) {
          if (name === 'time' || name === 'cycle') continue;
          let acc = 0;
          timeline.doses[name] = weights.map((w) => (acc += (w / total) * value));
          timeline.doses[name][minutes - 1] = value;
        }
        const events = [{ t: breakAt * 60, type: 'recreo', source: 'docente' }];
        for (let e = 0; e < 3; e++) {
          if (rand() < 0.5) events.push({ t: Math.floor(rand() * durationS), type: ['llamado_atencion', 'explicacion', 'actividad_grupal'][e], source: 'docente' });
        }
        if (burstiness > 0.6) events.push({ t: Math.floor(rand() * durationS), type: 'fonacion_sostenida', source: 'algoritmo' });
        events.sort((a, b) => a.t - b.t);
        const pre = clamp(Math.round(14 + 8 * t.susceptibility + 7 * normal()), 0, 100);
        const load = Math.log(none / 2000) + 0.4 * t.susceptibility; // H0: no memory effect
        const post = clamp(Math.round(pre + 14 * load + 10 * normal()), 0, 100);
        out.push({
          schema: WORKDAY_SCHEMA,
          id: workdayId(startedAt, t.participantId),
          participantId: t.participantId,
          schoolId: t.schoolId,
          classroom: t.classroom,
          date: `${startedAt.getFullYear()}-${pad(startedAt.getMonth() + 1)}-${pad(startedAt.getDate())}`,
          startedAt: startedAt.toISOString(),
          durationS,
          phonationS,
          validRatio: clamp(0.965 + 0.015 * normal(), 0.9, 1),
          doses,
          hMax: clamp(60 + 80 * burstiness + 15 * normal(), 5, 300),
          f0: { p10: f0 * 0.82, p50: f0, p90: f0 * 1.22 },
          level: { p10: level - 6, p50: level, p90: level + 7 },
          units: 'calibrated',
          timeline,
          events,
          fatigue: { pre: rand() < 0.06 ? null : pre, post: rand() < 0.08 ? null : post },
          algorithmVersion: '0.4.0',
          source: 'demo',
        });
      }
    }
  }
  return out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}
