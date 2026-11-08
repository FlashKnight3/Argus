import { useMemo, useState } from 'react';
import { Bot, Check, Play, Wrench } from 'lucide-react';
import { Empty, PageHead, Pill, Tabs, canManage, date, errorText, percent, siteName, type Tone } from './ui';
import { Markdown, plainPreview } from './Markdown';
import type { Notify } from './App';
import type { AgentRun, AgentStep, SupplyActions, SupplyState } from './useSupply';

const tone = (r: AgentRun): Tone => r.status === 'done' ? 'good' : r.status === 'failed' ? 'danger' : r.status === 'running' ? 'info' : 'watch';
const outcome = (r: AgentRun) => {
  if (r.status !== 'done') return r.status === 'failed' ? 'Run failed' : r.status === 'queued' ? 'Waiting to start' : 'Working…';
  const parts = [r.proposals ? `${r.proposals} transfer draft${r.proposals === 1 ? '' : 's'}` : '', r.matches ? `${r.matches} FDA link suggestion${r.matches === 1 ? '' : 's'}` : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'No action needed';
};
const trigger = (r: AgentRun) => r.trigger === 'auto' ? 'Started automatically because at-risk products changed.' : r.note ? `You asked: “${r.note}”` : 'Requested by a manager.';
const stripModel = (text: string) => text.replace(/^Model \S+ \(effort \w+\) reviewing/, 'Reviewing');
const kindLabel: Record<string, string> = { plan: 'Plan', thought: 'Reasoning', final: 'Summary', error: 'Issue' };
function pretty(content: string) { try { return JSON.stringify(JSON.parse(content), null, 2); } catch { return content; } }

function Step({ step }: { step: AgentStep }) {
  if (step.kind === 'tool_call') {
    let args = step.content;
    try { const o = JSON.parse(step.content) as Record<string, unknown>; args = Object.entries(o).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', '); } catch { /* raw */ }
    return <div className="step tool_call"><div className="step-head"><Wrench size={12}/><b>Looked up</b><code>{step.tool}</code><small>{date(step.at)}</small></div>{args && args !== '{}' && <div className="args">{args}</div>}</div>;
  }
  if (step.kind === 'tool_result') {
    const rejected = step.content.startsWith('Rejected:');
    return <div className={`step tool_result ${rejected ? 'rejected' : ''}`}><details><summary className="step-head"><Wrench size={12}/><b>{rejected ? 'Rejected' : 'Result'}</b><code>{step.tool}</code>
      <small>{rejected ? step.content.slice(9).trim() : 'show'}</small></summary>{!rejected && <pre>{pretty(step.content)}</pre>}</details></div>;
  }
  return <div className={`step ${step.kind}`}><div className="step-head"><Bot size={12}/><b>{kindLabel[step.kind] ?? step.kind}</b><small>{date(step.at)}</small></div><Markdown text={stripModel(step.content)} /></div>;
}

export function AgentPage({ state, actions, notify }: { state: SupplyState; actions: SupplyActions; notify: Notify }) {
  const pending = state.matches.filter(m => m.status === 'pending').sort((a, b) => b.confidence - a.confidence);
  const [tab, setTab] = useState<'runs' | 'review'>('runs');
  const [selectedId, setSelectedId] = useState(0);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const run = state.agentRuns.find(r => r.id === selectedId) ?? state.agentRuns[0];
  const steps = useMemo(() => run ? state.agentSteps.filter(s => s.runId === run.id) : [], [run, state.agentSteps]);
  const final = [...steps].reverse().find(s => s.kind === 'final');
  const others = steps.filter(s => s !== final);
  const canAsk = state.me?.role === 'admin' || state.me?.role === 'manager';
  const inFlight = state.agentRuns.some(r => r.status === 'queued' || r.status === 'running');

  const ask = async () => {
    setBusy(true);
    try { await actions.requestAgentRun({ note }); setNote(''); setSelectedId(0); notify('The agent is on it. Results appear here in a few seconds.'); }
    catch (e) { notify(errorText(e), true); } finally { setBusy(false); }
  };
  const decide = async (key: string, accept: boolean) => {
    try { await (accept ? actions.acceptMatch({ key }) : actions.dismissMatch({ key })); notify(accept ? 'FDA notice linked.' : 'Suggestion dismissed.'); }
    catch (e) { notify(errorText(e), true); }
  };

  return <>
    <PageHead title="Agent" subtitle="Reviews every site, drafts transfers where one site can safely help another, and suggests FDA links. It can't move stock; you approve everything." />
    {canAsk && <div className="ask" style={{ marginTop: 22 }}><Bot size={18}/>
      <input placeholder="Ask the agent something, e.g. “Which sites could cover heparin this week?”" value={note} onChange={e => setNote(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !busy && !inFlight) void ask(); }} />
      <button className="button primary" disabled={busy || inFlight} onClick={ask}><Play size={14}/> {inFlight ? 'Working…' : 'Run'}</button></div>}
    <Tabs value={tab} onChange={setTab} tabs={[{ id: 'runs', label: 'Runs', count: state.agentRuns.length }, { id: 'review', label: 'FDA link review', count: pending.length }]} />

    {tab === 'runs' && (state.agentRuns.length ? <div className="split">
      <div className="list-card">{state.agentRuns.slice(0, 40).map(r => <button key={r.id} className={`list-row clickable ${run?.id === r.id ? 'selected' : ''}`} onClick={() => setSelectedId(r.id)}>
        <div style={{ minWidth: 0 }}><strong>Run #{r.id} <span className="muted" style={{ fontWeight: 400 }}>· {r.trigger === 'auto' ? 'automatic' : 'asked'} · {date(r.createdAt)}</span></strong>
          <div className="run-preview">{r.summary ? plainPreview(r.summary) : r.status === 'queued' ? 'Waiting for a worker…' : 'Working…'}</div>
          <small className={`outcome ${r.proposals || r.matches ? 'act' : ''}`}>{outcome(r)}</small></div>
        <Pill tone={tone(r)}>{r.status}</Pill></button>)}</div>
      {run && <div className="result">
        <div className="inline" style={{ justifyContent: 'space-between' }}><h3 style={{ fontSize: 16 }}>Run #{run.id}</h3><Pill tone={tone(run)}>{run.status}</Pill></div>
        <div className="trigger">{trigger(run)}</div>
        <div className={`result-outcome ${run.proposals || run.matches ? 'act' : ''}`}>{run.proposals || run.matches ? <Check size={15}/> : null}{outcome(run)}
          {run.proposals > 0 && <span className="muted" style={{ fontWeight: 400 }}>· review under Transfers</span>}{run.matches > 0 && <span className="muted" style={{ fontWeight: 400 }}>· review in FDA link review</span>}</div>
        {final ? <Markdown text={final.content} /> : <p className="help">{run.summary || (run.status === 'running' || run.status === 'queued' ? 'The agent is working…' : 'No summary.')}</p>}
        {others.length > 0 && <details className="steps"><summary>How the agent worked ({others.length} step{others.length === 1 ? '' : 's'})</summary>{others.map(s => <Step key={s.id} step={s} />)}</details>}
      </div>}
    </div> : <div className="card"><Empty title="No runs yet" detail="The agent runs on its own when products become at risk, or ask it something above." /></div>)}

    {tab === 'review' && (pending.length ? <div className="table-wrap"><table className="table"><thead><tr><th>Your product</th><th>Suggested FDA notice</th><th>Confidence</th><th>Why</th><th className="actions">Actions</th></tr></thead><tbody>
      {pending.map(m => { const item = state.inventory.find(i => i.key === m.inventoryKey); const s = state.shortages.find(x => x.key === m.shortageKey);
        return <tr key={m.key}><td><strong title={item?.label}>{item?.label ?? m.inventoryKey}</strong><small>{item ? `${siteName(state.sites, item.siteId)} · NDC ${item.ndc}` : ''}</small></td>
          <td>{s ? <><strong>{s.genericName}</strong><small>{s.packageNdc} · {s.status}</small></> : m.shortageKey}</td><td><Pill tone="info">{percent(m.confidence)}</Pill></td>
          <td style={{ maxWidth: 340 }}><small style={{ color: 'var(--text-2)' }}>{m.rationale}</small></td>
          <td className="actions">{item && canManage(state.me, item.siteId) ? <><button className="link" onClick={() => decide(m.key, true)}>Link</button><button className="link danger" onClick={() => decide(m.key, false)}>Dismiss</button></> : <span className="muted" style={{ fontSize: 12 }}>Site manager</span>}</td></tr>; })}
    </tbody></table></div> : <div className="card"><Empty title="Nothing to review" detail="Suggestions appear when the agent finds an FDA notice that matches something you stock." /></div>)}
  </>;
}
