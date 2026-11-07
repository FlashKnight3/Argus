/**
 * Handoff assistant.
 *
 * Turns a medic's free text (typed or dictated) into a MIST card
 * (Mechanism, Injuries, Signs, Treatment) plus a draft 9-line line 3/4 note.
 *
 * Guardrail: the LLM only structures and summarises. It never scores, ranks,
 * triages or recommends treatment — any such fields it returns are dropped,
 * and the medic confirms every field before saving.
 *
 * Runs against a local Ollama instance; if that is not reachable (or slow),
 * a deterministic rule-based parser fills the same card so the demo never
 * depends on the model.
 */
import type { Vitals } from '@protocols';

export interface MistCard {
  mechanism: string;
  injuries: string;
  signs: string;
  treatment: string;
}

export interface Handoff {
  mist: MistCard;
  vitals: Partial<Vitals>;
  injuryType: string | null;
  age: number | null;
  observations: {
    walks?: boolean;
    hemorrhageControlled?: boolean;
    breathing?: boolean;
    obeysCommands?: boolean;
  };
  /** 9-line line 4 (special equipment) draft. */
  specialEquipment: string;
  source: 'llm' | 'rules';
  model?: string;
}

const OLLAMA_URL = import.meta.env.VITE_OLLAMA_URL ?? 'http://localhost:11434';
const OLLAMA_MODEL = import.meta.env.VITE_OLLAMA_MODEL ?? 'llama3.2:3b';

// ── Rule-based parser ────────────────────────────────────────────────────────

const INJURY_PATTERNS: Array<[string, RegExp]> = [
  ['penetrating_torso', /\b(penetrat\w*|stab\w*|gunshot|gsw|impal\w*|shrapnel|rebar)\b.*\b(chest|abdom\w*|torso|flank|belly|thora\w*)\b|\b(chest|abdom\w*|torso|flank)\b.*\b(penetrat\w*|stab\w*|impal\w*|shrapnel|wound)\b/i],
  ['blast_extremity', /\b(amputat\w*|mangled|blast|tourniquet)\b|\b(leg|arm|limb|forearm|thigh)\b.*\b(bleed\w*|open fracture|blown)\b/i],
  ['head_injury', /\b(head|skull|tbi|pupil\w*|unresponsive|concuss\w*|scalp)\b/i],
  ['burns', /\b(burn\w*|scald\w*|tbsa|singed|flash)\b/i],
  ['crush', /\b(crush\w*|trapped|pinned|entrap\w*|pelvi\w*)\b/i],
  ['inhalation', /\b(smoke|inhal\w*|hoarse|cough\w*|dust)\b/i],
  ['fracture', /\b(fractur\w*|broken|deformit\w*|splint\w*)\b/i],
  ['minor_laceration', /\b(laceration|abrasion|cut|bruis\w*|scrape)\b/i],
];

const TREATMENTS: Array<[RegExp, string]> = [
  [/\btourniquet\w*\b/i, 'Tourniquet'],
  [/\b(txa|tranexamic)\b/i, 'TXA'],
  [/\bchest seal\b/i, 'Chest seal'],
  [/\bneedle (decompression|decomp|thoracostomy)\b/i, 'Needle decompression'],
  [/\b(npa|nasopharyngeal)\b/i, 'NPA'],
  [/\b(packed|packing|hemostatic|haemostatic|gauze)\b/i, 'Wound packing'],
  [/\b(splint\w*)\b/i, 'Splint'],
  [/\b(oxygen|o2|non-?rebreather|nrb)\b/i, 'Oxygen'],
  [/\b(iv|io)\b.*\b(fluid|access|line)\b|\b(fluid\w*|saline)\b/i, 'IV/IO access'],
  [/\b(morphine|fentanyl|ketamine|analges\w*)\b/i, 'Analgesia'],
  [/\b(c-?collar|collar)\b/i, 'C-collar'],
  [/\b(pressure dressing|dressing|bandag\w*)\b/i, 'Pressure dressing'],
];

function num(re: RegExp, text: string): number | undefined {
  const m = text.match(re);
  return m ? Number(m[1]) : undefined;
}

function sentenceWith(text: string, re: RegExp): string {
  const parts = text.split(/(?<=[.;!?])\s+|\n+/);
  return (parts.find(p => re.test(p)) ?? '').trim().replace(/[.;]$/, '');
}

export function parseRuleBased(text: string): Handoff {
  const t = text.replace(/\s+/g, ' ').trim();
  const vitals: Partial<Vitals> = {};
  const hr = num(/\b(?:hr|heart rate|pulse)\s*(?:of|is|:)?\s*(\d{2,3})\b/i, t);
  const bp = t.match(/\b(?:bp|blood pressure)\s*(?:of|is|:)?\s*(\d{2,3})\s*(?:\/|over)\s*(\d{2,3})/i);
  const sbp = bp ? Number(bp[1]) : num(/\b(?:sbp|systolic)\s*(?:of|is|:)?\s*(\d{2,3})\b/i, t);
  const rr = num(/\b(?:rr|resp(?:iratory)?(?: rate)?|respirations|breathing)\s*(?:of|is|at|:)?\s*(\d{1,2})\b/i, t);
  const spo2 = num(/\b(?:spo2|sats?|o2 sat\w*|saturation\w*|pulse ox)\s*(?:of|is|at|:)?\s*(\d{2,3})\s*%?/i, t);
  const gcs = num(/\bgcs\s*(?:of|is|:)?\s*(\d{1,2})\b/i, t);
  if (hr !== undefined) vitals.hr = hr;
  if (sbp !== undefined) vitals.sbp = sbp;
  if (rr !== undefined) vitals.rr = rr;
  if (spo2 !== undefined) vitals.spo2 = Math.min(100, spo2);
  if (gcs !== undefined && gcs >= 3 && gcs <= 15) vitals.gcs = gcs;

  const age = num(/\b(\d{1,2})\s*(?:yo|y\/o|year[- ]old|yr[- ]old|years old)\b/i, t) ?? num(/\bage\s*(\d{1,2})\b/i, t) ?? null;

  let injuryType: string | null = null;
  for (const [key, re] of INJURY_PATTERNS) {
    if (re.test(t)) {
      injuryType = key;
      break;
    }
  }

  const treatments = TREATMENTS.filter(([re]) => re.test(t)).map(([, label]) => label);
  const uniqueTreatments = [...new Set(treatments)];

  const mechanism =
    sentenceWith(t, /\b(fell|fall|collapse\w*|blast|explosion|struck|hit by|crush\w*|trapped|fire|smoke|stab\w*|shot|debris)\b/i)
      // Drop a leading demographic clause ("About 34 year old female, …").
      .replace(/^[^,]*\b(?:\d{1,2}\s*(?:yo|y\/o|year[- ]old|yr[- ]old)|male|female|man|woman|child|boy|girl)\b[^,]*,\s*/i, '')
      .replace(/^./, c => c.toUpperCase()) || 'Not stated';
  const injuries =
    sentenceWith(t, /\b(wound|injur\w*|fractur\w*|amputat\w*|burn\w*|laceration|bleed\w*|impal\w*|trauma)\b/i) ||
    'Not stated';
  const signParts = [
    vitals.hr !== undefined && `HR ${vitals.hr}`,
    vitals.sbp !== undefined && `SBP ${vitals.sbp}`,
    vitals.rr !== undefined && `RR ${vitals.rr}`,
    vitals.spo2 !== undefined && `SpO₂ ${vitals.spo2}%`,
    vitals.gcs !== undefined && `GCS ${vitals.gcs}`,
  ].filter(Boolean);

  const observations: Handoff['observations'] = {};
  if (/\b(walking|ambulatory|walked)\b/i.test(t)) observations.walks = true;
  if (/\b(can'?t walk|unable to walk|non-?ambulatory)\b/i.test(t)) observations.walks = false;
  if (/\b(bleeding controlled|hemorrhage controlled|haemorrhage controlled|tourniquet)\b/i.test(t)) {
    observations.hemorrhageControlled = true;
  }
  if (/\b(uncontrolled|still bleeding|active bleed\w*|massive bleed\w*|arterial bleed\w*)\b/i.test(t)) {
    observations.hemorrhageControlled = false;
  }
  if (/\b(not breathing|apnoeic|apneic)\b/i.test(t)) observations.breathing = false;
  if (/\b(follows commands|obeys commands|alert and oriented|a&o|talking)\b/i.test(t)) observations.obeysCommands = true;
  if (/\b(unresponsive|doesn'?t follow|not following commands|confused)\b/i.test(t)) observations.obeysCommands = false;

  const equipment: string[] = [];
  if (/\b(intubat\w*|ventilat\w*|bvm|bag)\b/i.test(t)) equipment.push('Ventilator');
  if (/\b(trapped|pinned|entrap\w*)\b/i.test(t)) equipment.push('Extraction equipment');
  if (/\bhoist\b/i.test(t)) equipment.push('Hoist');

  return {
    mist: {
      mechanism,
      injuries,
      signs: signParts.length ? signParts.join(', ') : 'Not recorded',
      treatment: uniqueTreatments.length ? uniqueTreatments.join(', ') : 'None recorded',
    },
    vitals,
    injuryType,
    age,
    observations,
    specialEquipment: equipment.length ? equipment.join(', ') : 'None',
    source: 'rules',
  };
}

// ── Local LLM (Ollama) ──────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You convert a medic's casualty report into a MIST handoff card.
You ONLY restate what the report says. Never add diagnoses, never triage,
never score, never rank, never recommend treatment. If something is not
stated, write "Not stated". Numbers must be copied exactly from the report.`;

const FEW_SHOT_USER =
  'Male about 30, fell from the upper deck when the stand collapsed. Open fracture right femur, heavy bleeding, tourniquet on. HR 128, BP 92/60, RR 26, sats 95, GCS 15. Gave TXA.';
const FEW_SHOT_ASSISTANT = JSON.stringify({
  mechanism: 'Fall from upper deck during stand collapse',
  injuries: 'Open fracture right femur with heavy bleeding',
  signs: 'HR 128, SBP 92, RR 26, SpO2 95%, GCS 15',
  treatment: 'Tourniquet, TXA',
  age: 30,
  hr: 128,
  sbp: 92,
  rr: 26,
  spo2: 95,
  gcs: 15,
});

const SCHEMA = {
  type: 'object',
  properties: {
    mechanism: { type: 'string' },
    injuries: { type: 'string' },
    signs: { type: 'string' },
    treatment: { type: 'string' },
    age: { type: ['integer', 'null'] },
    hr: { type: ['number', 'null'] },
    sbp: { type: ['number', 'null'] },
    rr: { type: ['number', 'null'] },
    spo2: { type: ['number', 'null'] },
    gcs: { type: ['integer', 'null'] },
  },
  required: ['mechanism', 'injuries', 'signs', 'treatment'],
};

export async function structureWithLlm(text: string, timeoutMs = 12000): Promise<Handoff> {
  const rules = parseRuleBased(text);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        format: SCHEMA,
        options: { temperature: 0 },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: FEW_SHOT_USER },
          { role: 'assistant', content: FEW_SHOT_ASSISTANT },
          { role: 'user', content: text },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const body = await res.json();
    const out = JSON.parse(body?.message?.content ?? '{}');
    const pick = (k: string) => (typeof out[k] === 'number' && Number.isFinite(out[k]) ? out[k] : undefined);
    // Only accept numbers the medic actually said; prefer the deterministic parse.
    const vitals: Partial<Vitals> = { ...rules.vitals };
    for (const k of ['hr', 'sbp', 'rr', 'spo2', 'gcs'] as const) {
      const v = pick(k);
      if (vitals[k] === undefined && v !== undefined && text.includes(String(v))) vitals[k] = v;
    }
    const str = (k: string, fb: string) => (typeof out[k] === 'string' && out[k].trim() ? out[k].trim() : fb);
    return {
      ...rules,
      vitals,
      age: rules.age ?? pick('age') ?? null,
      mist: {
        mechanism: str('mechanism', rules.mist.mechanism),
        injuries: str('injuries', rules.mist.injuries),
        signs: str('signs', rules.mist.signs),
        treatment: str('treatment', rules.mist.treatment),
      },
      source: 'llm',
      model: OLLAMA_MODEL,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Try the local LLM; fall back to rules. Never throws. */
export async function structureHandoff(text: string): Promise<Handoff> {
  try {
    return await structureWithLlm(text);
  } catch {
    return parseRuleBased(text);
  }
}

export async function llmAvailable(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1200);
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/** Draft 9-line line 3 (patients by precedence) for a single casualty. */
export function nineLineLine3(precedence: string | null): string {
  if (!precedence) return 'Line 3: — (not eligible for auto-precedence; commander to re-evaluate)';
  return `Line 3: 1 × ${precedence}`;
}
