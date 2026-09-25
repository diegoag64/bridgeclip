# Jev editorial review

Jev checks whether proposed clips and edits preserve the source's meaning. It uses
OpenRouter with the existing encrypted OpenRouter key; no separate TypeSafe key is
needed. The implementation keeps the actual questions, input evidence and results
so a user can inspect why a clip was accepted, repaired or omitted.

## Requests and saved results

- Requests use `POST https://openrouter.ai/api/alpha/decisions` with
  `typesafe/jev-1.13`. The requested model and returned dated model are recorded
  separately. See the [OpenRouter Jev contract](https://openrouter.ai/docs/guides/community/jev)
  and [typed response examples](https://openrouter.ai/docs/guides/community/typesafe-sdk).
- Noul is the probability of yes. Choice/Score confidence describes concentration
  of the answer distribution, not guaranteed correctness.
- Jev receives bounded transcript text, titles and descriptions, never media.
  Optional visual context sends frames through a separate OpenRouter vision call;
  its observations can then be included in the Jev evidence.
- The adapter validates answers, bounds requests, supports cancellation and caches
  identical evidence/questions/model combinations. It records latency, tokens,
  reported cost and a separately labeled estimate when reported cost is absent.
- Coherence review has a separate 256-request/1,536,000-reserved-token budget.
  Advisory checks have a 64-request/180,000-token budget. Advisory work cannot
  consume the acceptance budget.

## Clip eligibility and repairs

The full source transcript is available to discovery and repair. A selected range
and target duration are preferences; actual source bounds are hard limits.
Candidates include topic, setup and payoff anchors. Speaker turns remain visible
throughout review. One bounded follow-up discovery pass can search underexplored
sections; overlapping alternatives are resolved after review.

Current policy (`coherence-v6`) requires every relevant check to pass independently:

| Check | Minimum probability |
| --- | --- |
| Self-contained meaning | 70% yes |
| Opening context, completed ending, logical flow, source faithfulness, supported title | 75% yes each |
| Not sponsored | 90% yes |
| Sufficient evidence | 50% for the sufficient option |
| Safe removal and logical join for an internal cut | 95% yes each, plus sufficient evidence |

Sponsorship and opening checks use a separate paired request. Both request records
are saved and both must succeed. A high score on one question cannot compensate
for a failed check. Explicitly required visual context must still be supplied.

Quality mode uses GPT-6 Sol for discovery and boundary repair; Economy uses
GLM 5.3 Flash discovery and Gemini 3.8 Flash repair. Repairs receive exact failed
criteria, their thresholds and earlier proposals. They select transcript segment
IDs rather than inventing timestamps or speech. At most two boundary repairs use
60-second and then 180-second surrounding windows. A truncated response can retry
with a larger output allowance; incomplete responses are never applied.

Sponsor segments are omitted without repairs that could hide their disclosures.
An opening referring to an earlier example must include that example or move to
an independent opening. Each revised excerpt requires a fresh review. A missing
or unsuccessful review cannot approve a clip, and no minimum clip count is forced.

## Internal edits and advisory checks

At most 24 actual removals are reviewed. Unknown or unapproved removals are
restored. The complete retained sequence must then pass review before rendering;
a fallback that changes timing also needs review. Reaction-context protection and
contextual acknowledgment checks preserve material needed to understand an edit.
Quality scores and semantic duplicate comparisons remain advisory. Editorial
sorting reweights saved quality scores locally without new model calls.

## Inspection and compatibility

`edit_audit.json` is checkpointed after transcription, candidate review and
rendering, including rejected candidates and runs with no clips. It contains the
transcript, planner requests/responses, Jev evidence/questions/results, repair
requests, restored cuts, retained intervals and output mapping. Credentials and
image payloads are excluded; transcript content is still source material to
consider before sharing a run folder.

**Inspect transcript & edits** opens a readable Jev evaluation view with question
text, probabilities, thresholds, criteria and input evidence. It covers separate
policy calls, context retries, cut checks and final quality reviews. Transcript
search and repair details are available in a second view. Opening either view
makes no provider calls. Thresholds are read from each saved run so older decisions
retain their original interpretation; legacy transcript-only runs remain readable.

## Verification and limits

Offline tests cover provider validation, unavailable responses, cancellation,
budgets, boundary repair, sponsorship, opening context, per-check thresholds,
restored cuts, final-edit review, trace persistence and desktop parsing/display.
Fixtures are synthetic except `coherence-live-decisions.json`, which contains
question definitions and typed results from eight authorized development probes,
without their transcript inputs. Those probes used an earlier policy and are not
an independent accuracy benchmark for the current one.

Model judgments remain probabilistic. Transcript review cannot establish unseen
visual events or guarantee editorial quality. Evidence and repair windows are
bounded, so some usable moments may still be omitted. Full-source transcription,
additional discovery and optional vision can increase processing time and cost.
The current acceptance policy requires usable speech; visual-only clips cannot
pass it. Tests verify implementation behavior, not a universal clip-accuracy rate.
