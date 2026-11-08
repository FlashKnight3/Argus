# Data, inference, and the agent

## FDA source

The `fda` lease holder downloads **every** page of the [openFDA drug shortage endpoint](https://api.fda.gov/drug/shortages.json), checks the declared total, dedupes by a stable hash of package NDC, generic name, company, and presentation, then imports in batches of 200 under one run ID (`begin` → `import` → `finish`). Records missing from a completed run are marked inactive. The feed refreshes every 24 hours; an admin can also sync from the browser. FDA status is a national signal and never proof of local stock.

## Inventory provenance

In a real network every count, baseline, safety stock, and lead time is entered by a person, and every change is attributed to an identity. In a **sandbox** network (`bootstrap_sandbox`), the seeder creates synthetic sites, stock, and backdated usage (`sandbox_seed_history`, which is refused outside a sandbox), around real current FDA notices. The UI shows a sandbox banner on every page.

## Demand model (`agent/src/model.ts`)

Daily demand is Poisson with a Gamma prior on its rate λ:

```text
prior:      baseline set   → Gamma(max(0.5, 7·baseline), 7)        (7 pseudo-days)
            no baseline,   → Gamma(max(0.5, 3·pool), 3)            (pooled: mean rate of other sites with the same NDC)
            other sites
            usage only     → Gamma(0.5, 1)
posterior:  shape + units used in the last 30 days,  rate + observed days in that window
```

With no baseline, no usage, and nothing to pool from, the forecast is `unknown`; no demand is invented. Thirty observed days of *zero* use count as evidence of low demand.

**Stockout before resupply.** For 2,000 deterministic draws: λ ~ posterior; lead time L ~ Gamma with mean = the item's lead time (default 7 days) and CV 0.25; demand D ~ Poisson(λ·L). `p_stockout = P(D > free stock)`. If the item is linked to an FDA record **currently in shortage**, the expected lead time is multiplied by 2.5 and its CV raised to 0.6 (`fda_adjusted`). Days-of-cover p10/p50/p90 come from free / λ.

**Risk:** `critical` if there's no free stock, `p_stockout ≥ 0.5`, or p10 ≤ 7 days; `watch` if `p_stockout ≥ 0.15` or p10 ≤ 21 days; otherwise `stable`.

**Calibration.** At weekly origins (from day 14 of history onward), the model is refit on data *before* the origin only and predicts the next 7 days of demand (Gamma–Poisson predictive). Each site reports the share of held-out weeks whose actual demand fell inside the predicted 80% interval (target ≈ 80%), plus MAE and bias. Results appear in **System**. On the sandbox's Poisson history, sites came out at 73–93% coverage. Note that the baseline used as the prior is the current one, so backtests are slightly optimistic for items whose baseline was set from later knowledge.

Not modeled: recalls, therapeutic substitution, allocation contracts, case-mix shifts, or delivery reliability beyond the lead-time distribution. A pharmacist should validate inputs and interpretation.

## Agent

Runs are queued (`manual` from the Agent page, or `auto` when the at-risk picture changes) and executed by whichever worker holds the `agent` lease. Automatic runs fire only after every item has a current forecast, so they never act on half-updated data. They are keyed on the at-risk items and their potential donors, with a 60 s cooldown.

**Deterministic planner** (`agent/src/planner.ts`, always available):
- **Destinations:** critical or `p_stockout ≥ 0.5` items with known demand, most urgent first. Each is targeted at max(safety stock, 21 days of demand).
- **Sources:** same canonical NDC and unit at another site, `stable` risk, and giveable `free − max(safety, 21 days of own demand)`. Capacity is shared across destinations; several sources can fill one destination.
- **Skipped:** routes that already have an open transfer or a pending draft.
- **Reported:** at-risk items with no internal source are listed for external sourcing.
- **FDA matches** (`agent/src/ndc.ts`): an exact package NDC (local 10-digit codes are tried in all three 11-digit layouts) scores 0.97; the same labeler and product code with a different package size scores 0.75; an identical product name with a different NDC scores 0.5.

**Claude** (`agent/src/llm.ts`, used when `ANTHROPIC_API_KEY` is set):
- **Model and loop:** `claude-opus-5-5`, effort `medium` (set with `ARGUS_AGENT_EFFORT`), and a manual tool loop with strict schemas.
- **Tools:** `get_network_overview`, `get_item_detail`, `search_fda`, `propose_transfer`, and `suggest_fda_match`.
- **Hard limits:** the tools enforce the same limits as the planner (a quantity above the source's `max_give` comes back as a tool error), and the database checks again.
- **Refusals:** server-side refusal fallbacks are on (`fallbacks: "default"`); a refusal ends the run with no drafts.
- **Failures:** if the API fails, the run logs the error and falls back to the deterministic planner.
- **Trace:** every plan, reasoning note, tool call, result, and summary is stored in `agent_step` and shown on the Agent page.

Neither path can reserve, ship, or receive stock. People accept a draft as a request, the source reserves and ships, and the destination confirms receipt.
