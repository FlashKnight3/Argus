import { useMemo, useState } from 'react';
import { Bot, Check, Play, Wrench } from 'lucide-react';
import { Empty, Panel, Pill, canManage, date, errorText, percent, siteName } from './ui';
import { Markdown, plainPreview } from './Markdown';
import type { Notify } from './App';
import type { AgentRun, AgentStep, SupplyActions, SupplyState } from './useSupply';

const triggerText = (run: AgentRun) => run.trigger === 'auto'
  ? `Started automatically: ${run.note.replace(/\s*\[[0-9a-f]+\]\s*$/, '').toLowerCase() || 'at-risk items changed'}.`
  : run.note ? `Requested by a manager — focus: “${run.note}”` : 'Requested by a manager.';

const outcome = (run: AgentRun) => {
  if (run.status !== 'done') return run.status === 'failed' ? 'Run failed' : run.status === 'queued' ? 'Waiting to start' : 'Working…';
  const parts = [run.proposals ? `${run.proposals} transfer draft${run.proposals === 1 ? '' : 's'}` : '', run.matches ? `${run.matches} FDA link suggestion${run.matches === 1 ? '' : 's'}` : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'No action needed';
};
const stripModel = (text: string) => text.replace(/^Model \S+ \(effort \w+\) reviewing/, 'Reviewing');

function pretty(content: string): string {
  try { return JSON.stringify(JSON.parse(content), null, 2); } catch { return content; }
}

function Step({ step }: { step: AgentStep }) {
  if (step.kind === 'tool_call') {
    let args = step.content;
    try { const o = JSON.parse(step.content) as Record<string, unknown>; args = Object.entries(o).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', '); } catch { /* keep raw */ }
    return <div className="trace-step tool_call"><div className="trace-head"><Wrench size={13}/><b>Calls</b><code>{step.tool}</code><small>{date(step.at)}</small></div>{args && args !== '{}' && <div className="trace-args">{args}</div>}</div>;
  }
  if (step.kind === 'tool_result') {
    const rejected = step.content.startsWith('Rejected:');
    return <div className={`trace-step tool_result ${rejected ? 'rejected' : ''}`}>
      <details><summary><Wrench size={13}/><b>{rejected ? 'Rejected' : 'Result'}</b><code>{step.tool}</code><span className="muted">{rejected ? step.content.slice(9).trim() : `${step.content.length.toLocaleString()} chars · show`}</span></summary>
        {!rejected && <pre className="trace-json">{pretty(step.content)}</pre>}</details></div>;
  }
  return <div className={`trace-step ${step.kind}`}>
    <div className="trace-head"><Bot size={13}/><b>{kindLabel[step.kind] ?? step.kind}</b><small>{date(step.at)}</small></div>
    <Markdown text={stripModel(step.content)} /></div>;
}

const tone = (run: AgentRun) => run.status === 'done' ? 'good' : run.status === 'failed' ? 'danger' : run.status === 'running' ? 'info' : 'watch';
const kindLabel: Record<string, string> = { plan: 'Plan', thought: 'Reasoning', tool_call: 'Tool call', tool_result: 'Result', final: 'Summary', error: 'Issue' };

export function AgentPage({ state, actions, notify }: { state: SupplyState; actions: SupplyActions; notify: Notify }) {
  const [selectedId, setSelectedId] = useState(0);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const run = state.agentRuns.find(r => r.id === selectedId) ?? state.agentRuns[0];
  const steps = useMemo(() => run ? state.agentSteps.filter(s => s.runId === run.id) : [], [run, state.agentSteps]);
  const finalStep = [...steps].reverse().find(s => s.kind === 'final');
  const otherSteps = steps.filter(s => s !== finalStep);
  const holder = state.leases.find(l => l.resource === 'agent');
  const holderName = state.workers.find(w => w.id === holder?.holder)?.name;
  const pendingMatches = state.matches.filter(m => m.status === 'pending').sort((a, b) => b.confidence - a.confidence);
  const canRequest = state.me?.role === 'admin' || state.me?.role === 'manager';
  const busyRun = state.agentRuns.some(r => r.status === 'queued' || r.status === 'running');

  const request = async () => {
    setBusy(true);
    try { await actions.requestAgentRun({ note }); setNote(''); notify('Agent run queued. The worker holding the agent lease will pick it up.'); }
    catch (error) { notify(errorText(error), true); }
    finally { setBusy(false); }
  };
  const decide = async (key: string, accept: boolean) => {
    setBusy(true);
    try { await (accept ? actions.acceptMatch({ key }) : actions.dismissMatch({ key })); notify(accept ? 'FDA notice linked.' : 'Suggestion dismissed.'); }
    catch (error) { notify(errorText(error), true); }
    finally { setBusy(false); }
  };

  return <div className="page-stack">
    <div className="page-intro"><div><div className="eyebrow">AGENTIC PLANNING / HUMAN APPROVAL</div><h1>Agent</h1>
      <p>The planning agent reads the whole network, drafts transfers within hard surplus limits, and suggests FDA links. Every step is recorded. It cannot reserve, ship, or receive stock.</p></div></div>
    {canRequest && <div className="agent-request"><Bot size={18} className="accent-icon"/><input placeholder="Ask the agent to focus on something, e.g. “check heparin across all sites” (optional)" value={note} onChange={e => setNote(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !busy && !busyRun) void request(); }} />
      <button className="button primary" disabled={busy || busyRun} onClick={request}><Play size={15}/> {busyRun ? 'Run in progress…' : 'Run agent'}</button></div>}
    <div className="notice-strip"><Bot size={16}/><span>{holder?.holder ? <>Agent lease held by <b>{holderName ?? holder.holder}</b> (epoch {String(holder.epoch)}). If that worker stops, another takes over and re-runs unfinished work.</> : 'No worker holds the agent lease yet. Start a worker with the service role.'} Runs start automatically when the set of at-risk items changes{state.config && !state.config.agentAutoRun ? ' (auto-run is off)' : ''}.</span></div>
    <div className="agent-layout">
      <Panel eyebrow="RUN HISTORY" title={`${state.agentRuns.length} runs`}>
        {state.agentRuns.length ? <div className="notice-list">{state.agentRuns.slice(0, 40).map(r => <button key={r.id} className={`notice-card ${run?.id === r.id ? 'selected' : ''}`} onClick={() => setSelectedId(r.id)}>
          <div><strong>Run #{r.id} <span className="muted">· {r.trigger === 'auto' ? 'automatic' : 'requested'}</span></strong><small className="run-preview">{r.summary ? plainPreview(r.summary) : r.status === 'queued' ? 'Waiting for a worker…' : 'Working…'}</small><small><span className={r.proposals || r.matches ? 'run-outcome act' : 'run-outcome'}>{outcome(r)}</span> · {date(r.createdAt)}</small></div>
          <Pill tone={tone(r)}>{r.status}</Pill></button>)}</div>
          : <Empty title="No runs yet" detail="Request a run, or add inventory that is at risk." />}
      </Panel>
      <Panel eyebrow="RESULT" title={run ? `Run #${run.id}` : 'Run result'} action={run ? <Pill tone={tone(run)}>{run.status}</Pill> : undefined}>
        {run ? <div className="trace"><div className="trace-note">{triggerText(run)}</div>
          <div className={`run-result ${run.proposals || run.matches ? 'act' : ''}`}><b>{outcome(run)}</b>{run.proposals > 0 && <span> — review them under Transfers.</span>}{run.matches > 0 && <span> — review them in Pharmacist review below.</span>}</div>
          {finalStep ? <Markdown text={finalStep.content} /> : run.status === 'done' || run.status === 'failed' ? <p className="muted">{run.summary || 'No summary.'}</p> : <p className="muted">The agent is working…</p>}
          {otherSteps.length > 0 && <details className="trace-steps"><summary>How the agent worked ({otherSteps.length} step{otherSteps.length === 1 ? '' : 's'})</summary>
            {otherSteps.map(step => <Step key={step.id} step={step} />)}</details>}</div>
          : <Empty title="Select a run" detail="See what the agent concluded and how it got there." />}
      </Panel>
    </div>
    <Panel eyebrow="PHARMACIST REVIEW" title={`${pendingMatches.length} FDA match suggestion${pendingMatches.length === 1 ? '' : 's'}`}>
      {pendingMatches.length ? <div className="proposal-grid">{pendingMatches.map(m => {
        const item = state.inventory.find(i => i.key === m.inventoryKey);
        const s = state.shortages.find(x => x.key === m.shortageKey);
        return <div className="proposal-card" key={m.key}><div className="proposal-head"><Pill tone="info">{percent(m.confidence)} confidence</Pill><small>run #{m.runId}</small></div>
          <h3>{item?.label ?? m.inventoryKey}</h3><p>{item ? `${siteName(state.sites, item.siteId)} · NDC ${item.ndc}` : ''}</p>
          <div className="proposal-reason">↔ {s ? `${s.genericName} · ${s.packageNdc} · ${s.status}` : m.shortageKey}<br/>{m.rationale}</div>
          <div className="proposal-actions">{item && canManage(state.me, item.siteId) ? <><button className="button primary small" disabled={busy} onClick={() => decide(m.key, true)}><Check size={14}/> Link notice</button><button className="button ghost small" disabled={busy} onClick={() => decide(m.key, false)}>Dismiss</button></> : <small>Awaiting the site manager</small>}</div></div>;
      })}</div> : <Empty title="Nothing to review" detail="Suggestions appear when the agent finds evidence connecting local stock to an FDA notice." />}
    </Panel>
  </div>;
}
