// Spec §6.3 — acceptance rule: Phi_k = V_k * W_k * Q_k.

const toBit = (value) => (value === true || value === 1 ? 1 : 0);

/**
 * Accepted phonation for a frame. Any falsy factor (voice, identity, quality)
 * yields 0, so the frame cannot increase H or any dose.
 * @returns {0 | 1}
 */
export function acceptedPhonation(voiced, identityMatch, qualityOk) {
  return toBit(voiced) * toBit(identityMatch) * toBit(qualityOk);
}
