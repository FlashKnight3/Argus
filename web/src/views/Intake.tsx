import { ArrowLeft, CheckCircle2, Loader2, Mic, MicOff, Send, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  INJURIES,
  PRECEDENCE_LABEL,
  injurySpec,
  precedenceFor,
  revisedTraumaScore,
  triage,
  type Assessment,
  type Precedence,
  type TriageCategory,
  type Vitals,
} from '@protocols';
import { ArgusMark, CategoryBadge, PrecedenceBadge, cx } from '../components/ui';
import { CATEGORY_STYLE, asCategory, errorMessage, round } from '../lib/format';
import { llmAvailable, nineLineLine3, structureHandoff, type Handoff, type MistCard } from '../lib/handoff';
import { useActions, type ArgusState } from '../lib/useArgus';

type Tri = boolean | undefined;

const QUESTIONS: Array<{ key: keyof Assessment; q: string; hint: string; invert?: boolean }> = [
  { key: 'walks', q: 'Walks?', hint: 'SALT sort' },
  { key: 'obeysCommands', q: 'Obeys commands / purposeful movement?', hint: 'Assess' },
  { key: 'peripheralPulse', q: 'Peripheral pulse present?', hint: 'Assess' },
  { key: 'respiratoryDistress', q: 'In respiratory distress?', hint: 'Assess', invert: true },
  { key: 'hemorrhageControlled', q: 'Major haemorrhage controlled?', hint: 'Assess' },
  { key: 'minorInjuriesOnly', q: 'Minor injuries only?', hint: 'Minimal vs Delayed' },
];

const BLANK_VITALS: Vitals = { hr: 0, sbp: 0, rr: 0, spo2: 0, gcs: 15 };

// Minimal typing for the Web Speech API (not in lib.dom for all targets).
type SpeechRec = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
};

function speechCtor(): (new () => SpeechRec) | undefined {
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition) as (new () => SpeechRec) | undefined;
}

function YesNo({ value, onChange, danger }: { value: Tri; onChange: (v: Tri) => void; danger?: 'yes' | 'no' }) {
  const btn = (v: boolean, label: string) => {
    const on = value === v;
    const isDanger = (danger === 'yes' && v) || (danger === 'no' && !v);
    return (
      <button
        type="button"
        onClick={() => onChange(on ? undefined : v)}
        className={cx(
          'h-11 flex-1 rounded-lg border text-[14px] font-semibold transition-colors',
          on ? (isDanger ? 'border-red/50 bg-red/15 text-red' : 'border-accent/50 bg-accent/15 text-accent') : 'border-line bg-ink-800 text-fg-muted'
        )}
      >
        {label}
      </button>
    );
  };
  return (
    <div className="flex w-36 shrink-0 gap-1.5">
      {btn(true, 'Yes')}
      {btn(false, 'No')}
    </div>
  );
}

export function Intake({ state, onError }: { state: ArgusState; onError: (m: string) => void }) {
  const { admitPatient } = useActions();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [mist, setMist] = useState<MistCard>({ mechanism: '', injuries: '', signs: '', treatment: '' });
  const [vitals, setVitals] = useState<Vitals>(BLANK_VITALS);
  const [age, setAge] = useState(30);
  const [injury, setInjury] = useState<string>('');
  const [answers, setAnswers] = useState<Partial<Record<keyof Assessment, Tri>>>({});
  const [survive, setSurvive] = useState<Tri>(undefined);
  const [sent, setSent] = useState<string | null>(null);
  const [llmOk, setLlmOk] = useState<boolean | null>(null);
  const [listening, setListening] = useState(false);
  const rec = useRef<SpeechRec | null>(null);

  useEffect(() => {
    llmAvailable().then(setLlmOk);
  }, []);

  const protocol = state.sim?.protocol === 'START' ? 'START' : 'SALT';
  const vitalsComplete = vitals.hr > 0 && vitals.sbp > 0 && vitals.spo2 > 0;
  const assessment: Assessment = useMemo(() => {
    const a: Assessment = {};
    for (const [k, v] of Object.entries(answers)) if (v !== undefined) (a as Record<string, unknown>)[k] = v;
    if (survive === false) a.likelyToSurvive = false;
    return a;
  }, [answers, survive]);

  const result = useMemo(() => triage(protocol, age, vitals, assessment), [protocol, age, vitals, assessment]);
  const rts = revisedTraumaScore(vitals);
  const spec = injury ? injurySpec(injury) : null;
  const precedence = precedenceFor(result.category, spec?.needsSurgery ?? false);
  const category: TriageCategory = result.category;

  const structure = async () => {
    if (!text.trim()) return;
    setBusy(true);
    const h = await structureHandoff(text);
    setBusy(false);
    setHandoff(h);
    setMist(h.mist);
    setVitals(v => ({ ...v, ...h.vitals }));
    if (h.age) setAge(h.age);
    if (h.injuryType) setInjury(h.injuryType);
    setAnswers(a => ({ ...a, ...h.observations }));
  };

  const toggleMic = () => {
    const Ctor = speechCtor();
    if (!Ctor) {
      onError('Speech input is not available in this browser. Type the report instead (whisper.cpp is the offline path).');
      return;
    }
    if (listening) {
      rec.current?.stop();
      return;
    }
    const r = new Ctor();
    r.lang = 'en-US';
    r.continuous = true;
    r.interimResults = false;
    r.onresult = e => {
      const chunks = Array.from(e.results).map(x => x[0].transcript);
      setText(chunks.join(' '));
    };
    r.onend = () => setListening(false);
    rec.current = r;
    r.start();
    setListening(true);
  };

  const reset = () => {
    setText('');
    setHandoff(null);
    setMist({ mechanism: '', injuries: '', signs: '', treatment: '' });
    setVitals(BLANK_VITALS);
    setAnswers({});
    setSurvive(undefined);
    setInjury('');
  };

  const submit = async () => {
    const n = state.patients.filter(p => p.source === 'medic').length + 1;
    const tag = `M${String(n).padStart(2, '0')}`;
    setBusy(true);
    try {
      await admitPatient({
        tag,
        source: 'medic',
        age,
        injuryType: injury || 'minor_laceration',
        mechanism: mist.mechanism,
        hr: vitals.hr,
        sbp: vitals.sbp,
        rr: vitals.rr,
        oxygenSat: vitals.spo2,
        gcs: vitals.gcs,
        assessment: JSON.stringify(assessment),
        medicCategory: '',
        mistCard: JSON.stringify({ ...mist, source: handoff?.source === 'llm' ? `local LLM (${handoff.model})` : 'medic + rule parser' }),
      });
      setSent(tag);
      reset();
      setTimeout(() => setSent(null), 4000);
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const blood = state.resources.get('blood_unit');
  const vents = state.resources.get('vent');
  const beds = state.resources.get('bed');
  const s = CATEGORY_STYLE[asCategory(category)];

  return (
    <div className="mx-auto flex min-h-full max-w-xl flex-col gap-4 px-4 pb-28 pt-4">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <ArgusMark className="h-8 w-8" />
          <div>
            <div className="text-[14px] font-semibold tracking-[0.18em]">ARGUS · INTAKE</div>
            <div className="text-[11px] text-fg-subtle">
              {state.sim?.scenarioTitle} · protocol {protocol}
            </div>
          </div>
        </div>
        <a href="#/" className="btn-ghost !px-2 !py-1 text-[12px]">
          <ArrowLeft className="h-3.5 w-3.5" /> Board
        </a>
      </header>

      {sent && (
        <div className="animate-fade-in flex items-center gap-2 rounded-xl border border-ok/40 bg-ok/10 px-4 py-3 text-[13px] text-ok">
          <CheckCircle2 className="h-4 w-4" /> {sent} admitted — it is already on the commander's board.
        </div>
      )}

      <section className="panel p-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="eyebrow">1 · Casualty report</span>
          <span className={cx('chip', llmOk ? 'border-accent/40 text-accent' : 'border-line text-fg-subtle')}>
            {llmOk === null ? 'checking LLM…' : llmOk ? 'Local LLM ready' : 'LLM offline · rule parser'}
          </span>
        </div>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          rows={4}
          placeholder="e.g. Male about 40, struck by falling steel. Penetrating wound left flank, still bleeding. HR 132, BP 84/50, RR 30, sats 91, GCS 14. Wound packed, TXA given."
          className="input resize-none text-[14px] leading-relaxed"
        />
        <div className="mt-2 flex gap-2">
          <button type="button" onClick={toggleMic} className={cx('btn h-11 w-14', listening ? 'border-red/50 bg-red/15 text-red' : 'border-line bg-ink-800 text-fg-muted')} aria-label="Dictate">
            {listening ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
          </button>
          <button type="button" onClick={structure} disabled={busy || !text.trim()} className="btn-primary h-11 flex-1 text-[14px]">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Structure into MIST card
          </button>
        </div>
        <p className="mt-2 text-[10.5px] text-fg-subtle">The assistant only restates what you said. It never triages, scores or recommends treatment.</p>
      </section>

      <section className="panel p-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="eyebrow">2 · MIST card · confirm each field</span>
          {handoff && <span className="text-[10.5px] text-fg-subtle">{handoff.source === 'llm' ? `from ${handoff.model}` : 'from rule parser'}</span>}
        </div>
        <div className="space-y-2">
          {(['mechanism', 'injuries', 'signs', 'treatment'] as const).map(k => (
            <label key={k} className="grid grid-cols-[86px_1fr] items-center gap-2">
              <span className="text-[12px] font-medium capitalize text-fg-subtle">{k}</span>
              <input value={mist[k]} onChange={e => setMist(m => ({ ...m, [k]: e.target.value }))} className="input" />
            </label>
          ))}
        </div>
      </section>

      <section className="panel p-4">
        <div className="eyebrow mb-2">3 · Injury</div>
        <div className="grid grid-cols-2 gap-1.5">
          {Object.entries(INJURIES).map(([k, v]) => (
            <button key={k} type="button" onClick={() => setInjury(k)} className={cx('h-11 rounded-lg border text-[13px] font-medium', injury === k ? 'border-accent/50 bg-accent/15 text-accent' : 'border-line bg-ink-800 text-fg-muted')}>
              {v.label}
            </button>
          ))}
        </div>
      </section>

      <section className="panel p-4">
        <div className="eyebrow mb-2">4 · Vitals</div>
        <div className="grid grid-cols-3 gap-2">
          {([
            ['hr', 'HR'],
            ['sbp', 'SBP'],
            ['rr', 'RR'],
            ['spo2', 'SpO₂ %'],
            ['gcs', 'GCS'],
          ] as const).map(([k, label]) => (
            <label key={k} className="block">
              <span className="text-[11px] text-fg-subtle">{label}</span>
              <input
                type="number"
                inputMode="numeric"
                value={vitals[k] || ''}
                onChange={e => setVitals(v => ({ ...v, [k]: Number(e.target.value) }))}
                className="input num mt-1 h-11 text-[16px]"
              />
            </label>
          ))}
          <label className="block">
            <span className="text-[11px] text-fg-subtle">Age</span>
            <input type="number" inputMode="numeric" value={age} onChange={e => setAge(Number(e.target.value))} className="input num mt-1 h-11 text-[16px]" />
          </label>
        </div>
      </section>

      <section className="panel p-4">
        <div className="eyebrow mb-1">5 · {protocol === 'SALT' ? 'SALT assessment' : 'Observations'}</div>
        <p className="mb-2 text-[11px] text-fg-subtle">Unanswered questions are derived from vitals.</p>
        <div className="divide-y divide-line">
          {QUESTIONS.map(q => (
            <div key={q.key} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] text-fg">{q.q}</div>
                <div className="text-[10.5px] text-fg-subtle">{q.hint}</div>
              </div>
              <YesNo
                value={answers[q.key] as Tri}
                onChange={v => setAnswers(a => ({ ...a, [q.key]: v }))}
                danger={q.invert ? 'yes' : q.key === 'walks' || q.key === 'minorInjuriesOnly' ? undefined : 'no'}
              />
            </div>
          ))}
          {protocol === 'SALT' && (
            <div className="py-2">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] text-fg">Likely to survive given current resources?</div>
                  <div className="text-[10.5px] text-fg-subtle">Medic judgement only — Argus never answers this</div>
                </div>
                <YesNo value={survive} onChange={setSurvive} danger="no" />
              </div>
              <div className="num mt-2 grid grid-cols-3 gap-1.5 text-[11px] text-fg-muted">
                <span className="rounded-md border border-line px-2 py-1">
                  Blood {round((blood?.capacity ?? 0) - (blood?.inUse ?? 0), 0)}/{blood?.capacity ?? 0}
                </span>
                <span className="rounded-md border border-line px-2 py-1">
                  Vents {round((vents?.capacity ?? 0) - (vents?.inUse ?? 0), 0)} free
                </span>
                <span className="rounded-md border border-line px-2 py-1">
                  Beds {round((beds?.capacity ?? 0) - (beds?.inUse ?? 0), 0)} free
                </span>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className={cx('rounded-xl border p-4', s.border, s.bg)}>
        <div className="flex items-center justify-between">
          <span className="eyebrow">Protocol result · {result.protocol}</span>
          <span className="num text-[11px] text-fg-muted">
            T-RTS {rts.tRts}/12 · wRTS {round(rts.weighted, 2)}
          </span>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <CategoryBadge category={category} className="!px-2.5 !py-1.5 !text-[14px]" />
          <PrecedenceBadge precedence={precedence ?? ''} full />
        </div>
        <ol className="mt-2 space-y-0.5 text-[11.5px] text-fg-muted">
          {result.trace.map((t, i) => (
            <li key={i}>· {t}</li>
          ))}
        </ol>
        <div className="num mt-3 space-y-0.5 rounded-lg border border-line bg-ink-900/70 p-2.5 text-[11.5px] text-fg-muted">
          <div className="eyebrow mb-1">Draft 9-line (confirm before sending)</div>
          <div>{nineLineLine3(precedence ? `${precedence} (${PRECEDENCE_LABEL[precedence as Precedence]})` : null)}</div>
          <div>Line 4: special equipment — {handoff?.specialEquipment ?? 'None'}</div>
        </div>
      </section>

      <div className="fixed inset-x-0 bottom-0 border-t border-line bg-ink-900/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-xl items-center gap-3">
          <div className="min-w-0 flex-1 text-[11px] text-fg-subtle">
            {vitalsComplete ? 'Review the card, then admit. The board updates instantly.' : 'Enter HR, SBP and SpO₂ to admit.'}
          </div>
          <button type="button" onClick={submit} disabled={busy || !vitalsComplete || !injury} className="btn-primary h-12 px-5 text-[15px]">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Admit casualty
          </button>
        </div>
      </div>
    </div>
  );
}
