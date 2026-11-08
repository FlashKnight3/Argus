/**
 * LLM planning agent (Claude). It reads network state through tools and may only *draft*:
 * transfer proposals (bounded by the same surplus rules the planner and database enforce)
 * and FDA match suggestions. People approve everything.
 */
import Anthropic from '@anthropic-ai/sdk';

export const AGENT_MODEL = process.env.ARGUS_AGENT_MODEL ?? 'claude-opus-5-5';
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const EFFORT = (process.env.ARGUS_AGENT_EFFORT ?? 'medium') as Effort;
const MAX_TURNS = 14;

export interface AgentToolbox {
  overview(): unknown;
  itemDetail(inventoryKey: string): unknown;
  searchFda(query: string, limit: number): unknown;
  /** Returns a human-readable outcome; throws on a rejected draft. */
  proposeTransfer(a: { source_site_id: number; dest_site_id: number; ndc: string; quantity: number; reason: string }): Promise<string>;
  suggestMatch(a: { inventory_key: string; shortage_key: string; confidence: number; rationale: string }): Promise<string>;
  step(kind: 'plan' | 'thought' | 'tool_call' | 'tool_result' | 'final' | 'error', tool: string, content: string): Promise<void>;
}

const SYSTEM = `You are the planning agent for Argus, a multi-site hospital pharmacy shortage coordination network.
Your job: find sites at risk of running out of a product before resupply, and draft transfers from sites with genuine surplus of the same package NDC; and suggest links between local inventory items and FDA shortage notices.

Rules:
- You only draft. Managers at both sites must request, reserve, ship, and receive. Never imply that stock has moved.
- Only propose between the same canonical NDC and unit. Respect each source's max_give from the overview; the tool rejects anything larger.
- Prefer few, well-justified drafts. Explain each in one or two sentences citing stockout probability and days of cover.
- FDA matches: suggest only when the evidence is concrete (same NDC, same product code with a different package, or a clearly identical product name). State the evidence and what a pharmacist must confirm.
- Do not give clinical advice or recommend therapeutic substitutions.
- When finished, reply with a short summary (under ~150 words): one opening sentence saying what you drafted, then at most a few bullets on why and what a person should check. Use a small markdown table only if it genuinely helps. Don't repeat numbers the dashboard already shows unless they explain a decision.`;

const strictObject = (properties: Record<string, unknown>, required: string[]) =>
  ({ type: 'object' as const, properties, required, additionalProperties: false });

export const TOOLS: Anthropic.Beta.Messages.BetaTool[] = [
  { name: 'get_network_overview', strict: true,
    description: 'All sites and tracked items with free stock, demand rate, stockout probability before resupply, days-of-cover range, risk, linked FDA status, open transfers, and max_give for each potential source.',
    input_schema: strictObject({}, []) },
  { name: 'get_item_detail', strict: true,
    description: 'Detail for one inventory item: recent usage by day, forecast explanation, linked FDA notice, and pending suggestions.',
    input_schema: strictObject({ inventory_key: { type: 'string', description: 'Inventory key, e.g. "2:00409488810"' } }, ['inventory_key']) },
  { name: 'search_fda', strict: true,
    description: 'Search active FDA shortage notices by product name, company, or NDC digits.',
    input_schema: strictObject({ query: { type: 'string' }, limit: { type: 'integer', description: '1-20' } }, ['query', 'limit']) },
  { name: 'propose_transfer', strict: true,
    description: 'Draft a transfer for human review. Quantity must not exceed the source max_give.',
    input_schema: strictObject({
      source_site_id: { type: 'integer' }, dest_site_id: { type: 'integer' }, ndc: { type: 'string' },
      quantity: { type: 'integer' }, reason: { type: 'string' },
    }, ['source_site_id', 'dest_site_id', 'ndc', 'quantity', 'reason']) },
  { name: 'suggest_fda_match', strict: true,
    description: 'Suggest linking a local inventory item to an FDA shortage record for a pharmacist to confirm.',
    input_schema: strictObject({
      inventory_key: { type: 'string' }, shortage_key: { type: 'string' },
      confidence: { type: 'number', description: '0-1' }, rationale: { type: 'string' },
    }, ['inventory_key', 'shortage_key', 'confidence', 'rationale']) },
];

/** True when the SDK can find credentials (API key, auth token, or a stored profile). */
export function makeClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_PROFILE) return null;
  try { return new Anthropic(); } catch { return null; }
}

async function execute(tools: AgentToolbox, name: string, input: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'get_network_overview': return JSON.stringify(tools.overview());
    case 'get_item_detail': return JSON.stringify(tools.itemDetail(String(input.inventory_key)));
    case 'search_fda': return JSON.stringify(tools.searchFda(String(input.query), Math.min(20, Math.max(1, Number(input.limit) || 8))));
    case 'propose_transfer': return tools.proposeTransfer(input as Parameters<AgentToolbox['proposeTransfer']>[0]);
    case 'suggest_fda_match': return tools.suggestMatch(input as Parameters<AgentToolbox['suggestMatch']>[0]);
    default: throw new Error(`Unknown tool ${name}`);
  }
}

const clip = (s: string, n = 1500) => (s.length > n ? `${s.slice(0, n)}…` : s);

export async function runLlmAgent(client: Pick<Anthropic, 'beta'>, tools: AgentToolbox, note: string): Promise<string> {
  const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [{ role: 'user', content:
    `Review the network now and draft what is warranted.${note ? `\nRequest from a manager: ${note}` : ''}` }];
  await tools.step('plan', '', `Model ${AGENT_MODEL} (effort ${EFFORT}) reviewing the network${note ? ` for: ${note}` : ''}.`);
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let response: Anthropic.Beta.Messages.BetaMessage;
    try {
      response = await client.beta.messages.create({
        model: AGENT_MODEL, max_tokens: 16000, system: SYSTEM, tools: TOOLS, messages,
        output_config: { effort: EFFORT },
        betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      });
    } catch (error) {
      if (error instanceof Anthropic.RateLimitError) throw new Error('Claude API rate limited; run will be retried later.');
      if (error instanceof Anthropic.AuthenticationError) throw new Error('Claude API credentials were rejected.');
      if (error instanceof Anthropic.APIError) throw new Error(`Claude API error ${error.status}: ${error.message}`);
      throw error;
    }
    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim() && response.stop_reason !== 'end_turn') await tools.step('thought', '', clip(block.text));
    }
    if (response.stop_reason === 'refusal') {
      await tools.step('error', '', `Model declined (${response.stop_details?.category ?? 'unspecified'}).`);
      return 'The model declined this request; no drafts were made.';
    }
    if (response.stop_reason === 'max_tokens') {
      await tools.step('error', '', 'Response hit the token limit before finishing.');
      return 'Stopped at the token limit.';
    }
    messages.push({ role: 'assistant', content: response.content });
    if (response.stop_reason === 'pause_turn') continue;
    if (response.stop_reason !== 'tool_use') {
      const summary = response.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n').trim();
      await tools.step('final', '', clip(summary || 'Done.', 3000));
      return summary || 'Done.';
    }
    const results: Anthropic.Beta.Messages.BetaToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      const input = (block.input ?? {}) as Record<string, unknown>;
      await tools.step('tool_call', block.name, clip(JSON.stringify(input), 800));
      try {
        const out = await execute(tools, block.name, input);
        await tools.step('tool_result', block.name, clip(out, 600));
        results.push({ type: 'tool_result', tool_use_id: block.id, content: out });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await tools.step('tool_result', block.name, `Rejected: ${message}`);
        results.push({ type: 'tool_result', tool_use_id: block.id, content: message, is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  await tools.step('error', '', `Stopped after ${MAX_TURNS} turns.`);
  return `Stopped after ${MAX_TURNS} turns.`;
}
