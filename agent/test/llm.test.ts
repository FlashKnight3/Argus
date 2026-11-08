import { describe, expect, it, vi } from 'vitest';
import { runLlmAgent, TOOLS, type AgentToolbox } from '../src/llm.ts';

type Scripted = { stop_reason: string; content: unknown[]; stop_details?: unknown };

function fakeClient(script: Scripted[]) {
  const calls: Array<Record<string, unknown>> = [];
  const create = vi.fn(async (params: Record<string, unknown>) => {
    calls.push(structuredClone(params));
    const next = script.shift();
    if (!next) throw new Error('script exhausted');
    return { id: 'msg', model: 'claude-opus-5-5', role: 'assistant', type: 'message', usage: {}, ...next };
  });
  return { client: { beta: { messages: { create } } } as never, calls };
}

function toolbox(overrides: Partial<AgentToolbox> = {}) {
  const steps: Array<[string, string, string]> = [];
  const tb: AgentToolbox = {
    overview: () => ({ items: [{ inventory_key: '1:n', max_give: 0 }, { inventory_key: '2:n', max_give: 50 }] }),
    itemDetail: () => ({}), searchFda: () => [],
    proposeTransfer: vi.fn(async a => { if (a.quantity > 50) throw new Error('Quantity must be between 1 and the source max_give (50).'); return 'Drafted'; }),
    suggestMatch: vi.fn(async () => 'ok'),
    step: async (kind, tool, content) => { steps.push([kind, tool, content]); },
    ...overrides,
  };
  return { tb, steps };
}

describe('Claude planning loop', () => {
  it('declares strict schemas for every tool', () => {
    for (const tool of TOOLS) {
      expect(tool.strict).toBe(true);
      expect((tool.input_schema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
    }
  });

  it('runs tools, returns rejections as is_error, and records a trace', async () => {
    const { client, calls } = fakeClient([
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'get_network_overview', input: {} }] },
      { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Site 2 has surplus.' },
        { type: 'tool_use', id: 't2', name: 'propose_transfer', input: { source_site_id: 2, dest_site_id: 1, ndc: 'n', quantity: 80, reason: 'r' } }] },
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't3', name: 'propose_transfer', input: { source_site_id: 2, dest_site_id: 1, ndc: 'n', quantity: 40, reason: 'r' } }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Drafted 40 units from site 2.' }] },
    ]);
    const { tb, steps } = toolbox();
    const summary = await runLlmAgent(client, tb, 'focus');
    expect(summary).toBe('Drafted 40 units from site 2.');
    expect(tb.proposeTransfer).toHaveBeenCalledTimes(2);
    const rejected = (calls[2].messages as Array<{ content: unknown }>).at(-1)!.content as Array<{ is_error?: boolean; content: string }>;
    expect(rejected[0].is_error).toBe(true);
    expect(rejected[0].content).toMatch(/max_give/);
    expect(calls[0]).toMatchObject({ model: 'claude-opus-5-5', fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'] });
    expect(steps.map(s => s[0])).toEqual(['plan', 'tool_call', 'tool_result', 'thought', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'final']);
  });

  it('stops cleanly on a refusal without drafting', async () => {
    const { client } = fakeClient([{ stop_reason: 'refusal', content: [], stop_details: { category: 'bio' } }]);
    const { tb, steps } = toolbox();
    expect(await runLlmAgent(client, tb, '')).toMatch(/declined/);
    expect(tb.proposeTransfer).not.toHaveBeenCalled();
    expect(steps.at(-1)![0]).toBe('error');
  });
});
