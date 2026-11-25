// Recovery indices of one workday (hito 10) from its fatigue trajectory F(t): F_pre before
// the workday, F_post at its end (t = 0) and the VAS points recorded afterwards.
//   ΔF     = F_post − F_pre
//   R(t)   = (F_post − F(t)) / ΔF, the share of the fatigue increase already recovered
//   T50/T90 = first time R reaches 0.5 / 0.9, linear interpolation between points
//   AUC_F  = ∫ max(0, F(t) − F_pre) dt from t = 0 to the last point, trapezoids, in VAS·h
// R, T50 and T90 need ΔF > 0 (nothing to recover otherwise). A level not reached by the
// last point is censored (null, with the *Censored flag), never extrapolated.

const isVas = (v) => typeof v === 'number' && Number.isFinite(v);

function timeToReach(level, curve) {
  for (let i = 1; i < curve.length; i++) {
    const [t0, r0] = curve[i - 1];
    const [t1, r1] = curve[i];
    if (r1 >= level) return r1 === r0 ? t1 : t0 + ((level - r0) / (r1 - r0)) * (t1 - t0);
  }
  return null;
}

/**
 * @param {{ pre: number | null, post: number | null, points: { minutes: number, value: number }[] }} args
 * @returns {{ deltaF: number | null, points: { minutes: number, value: number, r: number | null }[],
 *   t50Min: number | null, t50Censored: boolean, t90Min: number | null, t90Censored: boolean,
 *   aucF: number | null, horizonMin: number | null }}
 */
export function recoveryIndices({ pre, post, points = [] }) {
  const sorted = [...points].sort((a, b) => a.minutes - b.minutes);
  const deltaF = isVas(pre) && isVas(post) ? post - pre : null;
  const recovering = deltaF !== null && deltaF > 0;
  const withR = sorted.map((p) => ({ minutes: p.minutes, value: p.value, r: recovering ? (post - p.value) / deltaF : null }));
  const horizonMin = sorted.length ? sorted[sorted.length - 1].minutes : null;

  const curve = [[0, 0], ...withR.map((p) => [p.minutes, p.r])];
  const reach = (level) => {
    if (!recovering || !sorted.length) return { t: null, censored: false };
    const t = timeToReach(level, curve);
    return { t, censored: t === null };
  };
  const t50 = reach(0.5);
  const t90 = reach(0.9);

  let aucF = null;
  if (deltaF !== null && sorted.length) {
    const residual = [[0, Math.max(0, post - pre)], ...sorted.map((p) => [p.minutes, Math.max(0, p.value - pre)])];
    aucF = 0;
    for (let i = 1; i < residual.length; i++) {
      aucF += ((residual[i - 1][1] + residual[i][1]) / 2) * ((residual[i][0] - residual[i - 1][0]) / 60);
    }
  }
  return { deltaF, points: withR, t50Min: t50.t, t50Censored: t50.censored, t90Min: t90.t, t90Censored: t90.censored, aucF, horizonMin };
}
