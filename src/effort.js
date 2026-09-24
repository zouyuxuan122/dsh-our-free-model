/**
 * Reasoning-effort policy.
 *
 * A live probe of this lane (2026-09-24) settled the design: the gateway accepts
 * `reasoning_effort`, `thinking.budget_tokens`, `enable_thinking` and
 * `thinking_budget` and then ignores all of them — three samples per spelling
 * showed `low` producing *more* reasoning tokens than `xhigh`, and the unknown
 * fields occasionally surfaced as an upstream 503. The single control the pooled
 * account actually enforces is `max_tokens`, and reasoning volume tracks it
 * directly (a 64-token ceiling pulled reasoning from ~397 tokens down to ~63).
 *
 * So an effort level here is a real, enforced generation budget rather than a
 * hint. Every declared level therefore changes measured behaviour; a level that
 * could not be enforced would not be declared, because an effort menu that does
 * nothing is worse to a user than no effort menu at all.
 *
 * Because the ceiling is shared by thinking and the visible answer, a lower
 * level shortens both — that is the only modulation this lane offers, and it is
 * why the levels are stated as token budgets rather than as vague adjectives.
 *
 * @module src/effort.js
 */

/** Ordered for display: the array order is the picker's order. */
export const LEVELS = [
  { id: 'light', name: 'Light', zh: '精简', ceiling: 2048, description: 'A 2K ceiling shared by thinking and the answer: terse deliberation.' },
  { id: 'balanced', name: 'Balanced', zh: '均衡', ceiling: 8192, description: 'An 8K ceiling, enough to reason through a normal turn.' },
  { id: 'deep', name: 'Deep', zh: '深思', ceiling: undefined, description: 'The model full output capacity, with extended deliberation.' },
]

export const DEFAULT_LEVEL = 'balanced'

/**
 * Resolve the generation ceiling for one level against one model.
 *
 * The level ceiling is the controlling term; the model's own capacity and the
 * session's request can only lower it further, never raise it. A level with no
 * ceiling inherits the model capacity, which is why "Deep" is the top row.
 *
 * @param {string|undefined} level - the effort id the harness selected
 * @param {object} model - catalog entry, supplying `maxOutput`
 * @param {number|undefined} requested - the session maxTokens, when it set one
 * @param {number|undefined} fallback - the plugin default ceiling
 * @returns {number} tokens
 */
export function budgetFor(level, model, requested, fallback) {
  const capacity = Math.min(
    model?.maxOutput ?? 32768,
    requested ?? Number.POSITIVE_INFINITY,
    fallback ?? Number.POSITIVE_INFINITY,
  )
  const entry = LEVELS.find(candidate => candidate.id === level)
  if (entry === undefined || entry.ceiling === undefined) return Math.max(MIN_BUDGET, Math.trunc(capacity))
  return Math.max(MIN_BUDGET, Math.trunc(Math.min(entry.ceiling, capacity)))
}

/** Below this the answer itself cannot land, so no level is allowed to go. */
const MIN_BUDGET = 512

/** Does this model expose an effort menu at all? */
export function supportsEffort(model) {
  return model?.reasoning === true
}

/** The declared effort list for one model, in picker order. */
export function effortsFor(model) {
  if (!supportsEffort(model)) return undefined
  return LEVELS.map(level => ({
    id: level.id,
    name: level.name,
    ...level.description === undefined ? {} : { description: level.description },
  }))
}
