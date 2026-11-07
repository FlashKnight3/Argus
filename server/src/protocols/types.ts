/**
 * Shared clinical types.
 *
 * Argus does not invent triage. Every category, score and precedence below is
 * produced by deterministic code that follows a published protocol. The ML
 * layer only forecasts and orders patients *inside* the tiers these rules set.
 *
 * All numeric thresholds are illustrative placeholders for a hackathon
 * prototype and must be verified by a clinician against the source documents.
 */

export type TriageCategory =
  | 'immediate'
  | 'delayed'
  | 'minimal'
  | 'expectant'
  | 'dead';

export type TriageProtocol = 'SALT' | 'START' | 'JumpSTART';

/** MEDEVAC 9-line, line 3 (TCCC). */
export type Precedence = 'A' | 'B' | 'C' | 'D' | 'E';

export interface Vitals {
  /** Heart rate, beats/min. */
  hr: number;
  /** Systolic blood pressure, mmHg. */
  sbp: number;
  /** Respiratory rate, breaths/min. */
  rr: number;
  /** Peripheral oxygen saturation, %. */
  spo2: number;
  /** Glasgow Coma Scale, 3–15. */
  gcs: number;
}

/**
 * Observations a medic records at the triage point. Anything left undefined is
 * derived from vitals using conservative, documented approximations.
 */
export interface Assessment {
  /** Can the casualty walk? (SALT sort step / START step 1) */
  walks?: boolean;
  /** Waves or makes purposeful movement (SALT global sort). */
  purposefulMovement?: boolean;
  /** Breathing spontaneously (after opening the airway if needed). */
  breathing?: boolean;
  /** Obeys commands or makes purposeful movements (SALT individual assess). */
  obeysCommands?: boolean;
  /** Has a palpable peripheral (radial) pulse. */
  peripheralPulse?: boolean;
  /** In respiratory distress. */
  respiratoryDistress?: boolean;
  /** Major haemorrhage is controlled. */
  hemorrhageControlled?: boolean;
  /** Injuries are minor only. */
  minorInjuriesOnly?: boolean;
  /** Capillary refill > 2 s (START perfusion). */
  capRefillOver2s?: boolean;
  /**
   * SALT: "Likely to survive given current resources?" Only a medic answers
   * this. Argus never sets it to `false` on its own, so it never auto-assigns
   * Expectant.
   */
  likelyToSurvive?: boolean;
  /** JumpSTART: palpable pulse in an apnoeic child. */
  pulsePresent?: boolean;
  /** JumpSTART: breathing after 5 rescue breaths. */
  breathingAfterRescueBreaths?: boolean;
  /** JumpSTART AVPU. */
  avpu?: 'A' | 'V' | 'P' | 'U';
  /** JumpSTART: responds appropriately to pain (if AVPU is P). */
  painResponseAppropriate?: boolean;
}

export interface TriageResult {
  protocol: TriageProtocol;
  category: TriageCategory;
  /** Human-readable decision path, one step per entry. */
  trace: string[];
}
