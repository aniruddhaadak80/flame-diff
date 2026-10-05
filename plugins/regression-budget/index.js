/**
 * `regression-budget` — a classification rule set.
 *
 * The core classifier decides "this got slower" from one ratio, passed in by the caller. That
 * is right for a default and wrong for a real service: a 2x slowdown on a 40-microsecond span
 * matters far less than a 1.3x slowdown on a 90-millisecond one, and a single ratio cannot
 * express the difference.
 *
 * This plugin claims `classification.regression-budget` at priority 70. Priority decides which
 * plugin wins a contested capability, deterministically, and the loser is reported rather than
 * dropped — see `packages/plugins/src/registry.ts`.
 *
 * The budgets are ordinary data so they can be reviewed as a diff. Nothing here is computed at
 * import time, and nothing here calls a model.
 */

/** Headroom added to a span's own baseline before a slowdown is allowed to count. */
const FLOOR_NS = 1_000

/**
 * @typedef {object} Budget
 * @property {string} name
 * @property {number} significantAtNs spans at or above this duration get the benefit of the doubt
 * @property {number} significantRatio multiplier past which a significant span counts as regressed
 * @property {number} cheapRatio multiplier past which anything counts as regressed
 */

/** @type {readonly Budget[]} */
export const BUDGETS = [
  { name: 'request-total', significantAtNs: 10_000_000, significantRatio: 1.15, cheapRatio: 1.5 },
  { name: 'io', significantAtNs: 1_000_000, significantRatio: 1.25, cheapRatio: 2.0 },
  { name: 'default', significantAtNs: 0, significantRatio: 1.25, cheapRatio: 1.5 },
]

/**
 * @typedef {object} Verdict
 * @property {boolean} regressed
 * @property {number} ratio
 * @property {string} budget
 * @property {string} reason
 */

/**
 * Judge one duration change against the budgets.
 *
 * @param {number} baseNs duration before the change
 * @param {number} headNs duration after the change
 * @returns {Verdict}
 */
export function classify(baseNs, headNs) {
  if (!(baseNs > 0)) {
    return {
      regressed: false,
      ratio: 0,
      budget: 'none',
      reason: 'the baseline was zero, so there is no ratio to judge',
    }
  }

  const ratio = headNs / baseNs
  const budget = BUDGETS.find((entry) => baseNs >= entry.significantAtNs) ?? BUDGETS[BUDGETS.length - 1]
  const threshold = baseNs >= FLOOR_NS ? budget.significantRatio : budget.cheapRatio
  const regressed = ratio >= threshold

  return {
    regressed,
    ratio,
    budget: budget.name,
    reason: regressed
      ? `${ratio.toFixed(2)}x is at or past the ${threshold}x ${budget.name} budget`
      : `${ratio.toFixed(2)}x is inside the ${threshold}x ${budget.name} budget`,
  }
}
