/**
 * Time base. Every timestamp in the model is high-resolution milliseconds relative to the
 * capture's `performance.timeOrigin` (a DOMHighResTimeStamp) — the single clock the whole
 * timeline is anchored to. Wall-clock (epoch) values are metadata only and must NEVER drive
 * ordering: a system-clock adjustment moves them and would silently bend the timeline.
 *
 * The brands make epoch-vs-relative a compile error instead of a `value > 1e12` guess — the
 * exact heuristic that shattered timelines in waterfall-tools. They erase at runtime (the casts
 * are identity), so there is no on-the-wire or on-page cost.
 */

/** High-res ms relative to `timeOrigin`. The canonical timeline unit. */
export type RelMs = number & { readonly __unit: 'rel-ms' };

/** A duration in ms (the delta between two RelMs instants). */
export type DurationMs = number & { readonly __unit: 'dur-ms' };

/** Wall-clock ms since the UNIX epoch. Correlation metadata only — never used for ordering. */
export type EpochMs = number & { readonly __unit: 'epoch-ms' };

export const asRelMs = (n: number): RelMs => n as RelMs;
export const asDurationMs = (n: number): DurationMs => n as DurationMs;
export const asEpochMs = (n: number): EpochMs => n as EpochMs;
