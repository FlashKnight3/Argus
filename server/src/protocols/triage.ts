/**
 * Triage protocols encoded as plain, deterministic decision trees.
 *
 *  - SALT  (Sort, Assess, Lifesaving interventions, Treatment/Transport) — the
 *    CDC-sponsored national all-hazards standard and the only system meeting
 *    the Model Uniform Core Criteria.
 *  - START (Simple Triage And Rapid Treatment) for adults.
 *  - JumpSTART for children (< 8 years) when the local protocol is START.
 *
 * Each function returns the category *and* the exact path through the tree so
 * every screen can show which protocol produced the category and why.
 */
import type { Assessment, TriageProtocol, TriageResult, Vitals } from './types';

/** Age under which START teams route to JumpSTART. */
export const JUMPSTART_MAX_AGE = 8;

/**
 * Fill unanswered observations from vitals. These approximations are
 * illustrative and conservative; a medic's explicit answer always wins.
 */
export function deriveAssessment(v: Vitals, a: Assessment = {}): Required<Omit<Assessment, 'avpu' | 'painResponseAppropriate' | 'pulsePresent' | 'breathingAfterRescueBreaths'>> & Assessment {
  const breathing = a.breathing ?? v.rr > 0;
  const obeysCommands = a.obeysCommands ?? v.gcs >= 13;
  return {
    ...a,
    walks: a.walks ?? false,
    purposefulMovement: a.purposefulMovement ?? v.gcs >= 9,
    breathing,
    obeysCommands,
    // A radial pulse is generally palpable down to roughly SBP 80 mmHg.
    peripheralPulse: a.peripheralPulse ?? (v.sbp >= 80 && v.hr > 0),
    respiratoryDistress: a.respiratoryDistress ?? (v.rr > 30 || (v.rr > 0 && v.rr < 10) || v.spo2 < 90),
    hemorrhageControlled: a.hemorrhageControlled ?? true,
    minorInjuriesOnly: a.minorInjuriesOnly ?? false,
    capRefillOver2s: a.capRefillOver2s ?? (v.sbp < 90 || v.hr > 120),
    // Never inferred as false: only a medic can make an Expectant call.
    likelyToSurvive: a.likelyToSurvive ?? true,
  };
}

/** SALT individual assessment (step 2), after the global sort. */
export function salt(v: Vitals, raw: Assessment = {}): TriageResult {
  const a = deriveAssessment(v, raw);
  const trace: string[] = [];

  // Step 1 — global sort only orders who is assessed first; it never sets the
  // final category on its own, but we record it for the audit trail.
  if (a.walks) trace.push('Sort: walks → assess third');
  else if (a.purposefulMovement) trace.push('Sort: waves / purposeful movement → assess second');
  else trace.push('Sort: still or obvious life threat → assess first');

  trace.push('Lifesaving interventions: haemorrhage control, airway, decompression, antidotes as indicated');

  if (!a.breathing) {
    trace.push('Not breathing after airway opened → Dead');
    return { protocol: 'SALT', category: 'dead', trace };
  }

  const checks: Array<[boolean, string]> = [
    [a.obeysCommands, 'obeys commands / purposeful movement'],
    [a.peripheralPulse, 'peripheral pulse present'],
    [!a.respiratoryDistress, 'not in respiratory distress'],
    [a.hemorrhageControlled, 'major haemorrhage controlled'],
  ];
  const failed = checks.filter(([ok]) => !ok).map(([, label]) => label);

  if (failed.length === 0) {
    trace.push('All four assessment questions: yes');
    if (a.minorInjuriesOnly) {
      trace.push('Minor injuries only → Minimal');
      return { protocol: 'SALT', category: 'minimal', trace };
    }
    trace.push('Not minor only → Delayed');
    return { protocol: 'SALT', category: 'delayed', trace };
  }

  trace.push(`Fails: ${failed.join('; ')}`);
  if (a.likelyToSurvive) {
    trace.push('Likely to survive given current resources → Immediate');
    return { protocol: 'SALT', category: 'immediate', trace };
  }
  trace.push('Medic judged unlikely to survive given current resources → Expectant');
  return { protocol: 'SALT', category: 'expectant', trace };
}

/** START (adults). */
export function start(v: Vitals, raw: Assessment = {}): TriageResult {
  const a = deriveAssessment(v, raw);
  const trace: string[] = [];

  if (a.walks) {
    trace.push('Ambulatory → Minor (Minimal)');
    return { protocol: 'START', category: 'minimal', trace };
  }
  if (!a.breathing) {
    trace.push('Not breathing after airway repositioned → Deceased/Expectant (Dead)');
    return { protocol: 'START', category: 'dead', trace };
  }
  if (v.rr > 30) {
    trace.push(`Respirations ${v.rr}/min > 30 → Immediate`);
    return { protocol: 'START', category: 'immediate', trace };
  }
  trace.push(`Respirations ${v.rr}/min ≤ 30`);
  if (!a.peripheralPulse || a.capRefillOver2s) {
    trace.push('Perfusion: radial pulse absent or cap refill > 2 s → Immediate');
    return { protocol: 'START', category: 'immediate', trace };
  }
  trace.push('Perfusion adequate');
  if (!a.obeysCommands) {
    trace.push('Cannot follow simple commands → Immediate');
    return { protocol: 'START', category: 'immediate', trace };
  }
  trace.push('Follows simple commands → Delayed');
  return { protocol: 'START', category: 'delayed', trace };
}

/** JumpSTART (children under 8). */
export function jumpStart(v: Vitals, raw: Assessment = {}): TriageResult {
  const a = deriveAssessment(v, raw);
  const trace: string[] = [];

  if (a.walks) {
    trace.push('Ambulatory → Minor (Minimal)');
    return { protocol: 'JumpSTART', category: 'minimal', trace };
  }
  if (!a.breathing) {
    trace.push('Apnoeic after airway positioned');
    const pulse = raw.pulsePresent ?? v.hr > 0;
    if (!pulse) {
      trace.push('No palpable pulse → Deceased (Dead)');
      return { protocol: 'JumpSTART', category: 'dead', trace };
    }
    const rescued = raw.breathingAfterRescueBreaths ?? false;
    if (rescued) {
      trace.push('Breathing after 5 rescue breaths → Immediate');
      return { protocol: 'JumpSTART', category: 'immediate', trace };
    }
    trace.push('Still apnoeic after 5 rescue breaths → Deceased (Dead)');
    return { protocol: 'JumpSTART', category: 'dead', trace };
  }
  if (v.rr < 15 || v.rr > 45) {
    trace.push(`Respirations ${v.rr}/min outside 15–45 → Immediate`);
    return { protocol: 'JumpSTART', category: 'immediate', trace };
  }
  trace.push(`Respirations ${v.rr}/min within 15–45`);
  if (!a.peripheralPulse) {
    trace.push('No palpable peripheral pulse → Immediate');
    return { protocol: 'JumpSTART', category: 'immediate', trace };
  }
  trace.push('Palpable peripheral pulse');
  const avpu = raw.avpu ?? (v.gcs >= 14 ? 'A' : v.gcs >= 11 ? 'V' : v.gcs >= 6 ? 'P' : 'U');
  const painOk = raw.painResponseAppropriate ?? v.gcs >= 8;
  if (avpu === 'U' || (avpu === 'P' && !painOk)) {
    trace.push(`AVPU ${avpu}${avpu === 'P' ? ' (inappropriate)' : ''} → Immediate`);
    return { protocol: 'JumpSTART', category: 'immediate', trace };
  }
  trace.push(`AVPU ${avpu} → Delayed`);
  return { protocol: 'JumpSTART', category: 'delayed', trace };
}

/**
 * Run the configured local protocol. Teams on START automatically route
 * paediatric patients to JumpSTART; SALT applies to all ages.
 */
export function triage(
  localProtocol: 'SALT' | 'START',
  age: number,
  v: Vitals,
  a: Assessment = {},
): TriageResult {
  if (localProtocol === 'START') {
    return age < JUMPSTART_MAX_AGE ? jumpStart(v, a) : start(v, a);
  }
  return salt(v, a);
}

export function protocolFor(localProtocol: 'SALT' | 'START', age: number): TriageProtocol {
  if (localProtocol === 'START') return age < JUMPSTART_MAX_AGE ? 'JumpSTART' : 'START';
  return 'SALT';
}

const SEVERITY: Record<string, number> = {
  minimal: 0,
  delayed: 1,
  immediate: 2,
  expectant: 3,
  dead: 4,
};

/**
 * Re-triage after new vitals. The protocol may *escalate* among
 * Minimal → Delayed → Immediate, but it never moves a patient into Expectant
 * or Dead, and never downgrades a category a medic set by hand.
 */
export function retriage(
  current: string,
  medicSet: boolean,
  next: TriageResult,
): { category: string; changed: boolean } {
  if (medicSet) return { category: current, changed: false };
  if (current === 'expectant' || current === 'dead') return { category: current, changed: false };
  if (next.category === 'expectant' || next.category === 'dead') return { category: current, changed: false };
  if ((SEVERITY[next.category] ?? 0) > (SEVERITY[current] ?? 0)) {
    return { category: next.category, changed: true };
  }
  return { category: current, changed: false };
}
