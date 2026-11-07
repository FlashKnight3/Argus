/**
 * Revised Trauma Score (Champion et al., 1989).
 *
 * Each of GCS, systolic BP and respiratory rate is coded 0–4.
 *  - T-RTS (triage RTS) is the plain sum, 0–12.
 *  - Weighted RTS uses the published coefficients, 0–7.8408.
 */

export const RTS_WEIGHTS = { gcs: 0.9368, sbp: 0.7326, rr: 0.2908 } as const;
export const WEIGHTED_RTS_MAX = 4 * (RTS_WEIGHTS.gcs + RTS_WEIGHTS.sbp + RTS_WEIGHTS.rr);

export function codeGcs(gcs: number): number {
  if (gcs >= 13) return 4;
  if (gcs >= 9) return 3;
  if (gcs >= 6) return 2;
  if (gcs >= 4) return 1;
  return 0;
}

export function codeSbp(sbp: number): number {
  if (sbp > 89) return 4;
  if (sbp >= 76) return 3;
  if (sbp >= 50) return 2;
  if (sbp >= 1) return 1;
  return 0;
}

export function codeRr(rr: number): number {
  if (rr > 29) return 3;
  if (rr >= 10) return 4;
  if (rr >= 6) return 2;
  if (rr >= 1) return 1;
  return 0;
}

export interface RtsResult {
  gcsCode: number;
  sbpCode: number;
  rrCode: number;
  /** Triage RTS, integer 0–12. */
  tRts: number;
  /** Weighted RTS, 0–7.8408. */
  weighted: number;
}

export function revisedTraumaScore(v: { gcs: number; sbp: number; rr: number }): RtsResult {
  const gcsCode = codeGcs(v.gcs);
  const sbpCode = codeSbp(v.sbp);
  const rrCode = codeRr(v.rr);
  const weighted =
    RTS_WEIGHTS.gcs * gcsCode + RTS_WEIGHTS.sbp * sbpCode + RTS_WEIGHTS.rr * rrCode;
  return {
    gcsCode,
    sbpCode,
    rrCode,
    tRts: gcsCode + sbpCode + rrCode,
    weighted: Math.round(weighted * 10000) / 10000,
  };
}
