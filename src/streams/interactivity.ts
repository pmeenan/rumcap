import type { RelMs, DurationMs } from '../time.js';
import type { ElementRef } from './rendering.js';

/**
 * Event Timing entry — covers both `event` and `first-input`. `interactionId` groups raw events
 * into a single logical interaction; INP is derived offline in `analysis` from these. `target` is
 * LIVE attribution (the element behind the interaction). `processingStart`/`processingEnd` bound
 * the event handlers, which lets analysis split input delay / processing / presentation delay.
 */
export interface InteractionEntry {
  name: string;
  startTime: RelMs;
  duration: DurationMs;
  processingStart?: RelMs;
  processingEnd?: RelMs;
  /** 0 for non-interaction events; a nonzero id groups events into one interaction. */
  interactionId?: number;
  cancelable?: boolean;
  /** True for the single `first-input` entry. */
  firstInput?: boolean;
  target?: ElementRef;
}

export interface InteractionsStream {
  events: InteractionEntry[];
}

/** Long Task (>50ms) with coarse container attribution. Largely superseded by LoAF, but cheap. */
export interface LongTaskEntry {
  startTime: RelMs;
  duration: DurationMs;
  /**
   * Which browsing context the task belongs to — the entry-level `name`:
   * 'self' | 'same-origin[-ancestor|-descendant]' | 'cross-origin[-ancestor|-descendant|-unreachable]'
   * | 'multiple-contexts' | 'unknown' (https://w3c.github.io/longtasks/#sec-PerformanceLongTaskTiming).
   * The corpus exhibits 'self' and 'unknown'.
   */
  name?: string;
  attribution?: LongTaskAttribution[];
}

export interface LongTaskAttribution {
  name?: string;
  containerType?: string;
  containerName?: string;
  containerId?: string;
  containerSrc?: string;
}

export interface LongTasksStream {
  tasks: LongTaskEntry[];
}

/**
 * Long Animation Frame — the richest "what ran" signal: per-frame render/layout boundaries plus a
 * `scripts` list with invoker + source attribution. Grounded against real Chrome 149 LoAF output
 * (see samples). `paintTime`/`presentationTime` are absent on frames that produced no paint.
 */
export interface LoafEntry {
  startTime: RelMs;
  duration: DurationMs;
  renderStart?: RelMs;
  styleAndLayoutStart?: RelMs;
  firstUIEventTimestamp?: RelMs;
  blockingDuration?: DurationMs;
  paintTime?: RelMs;
  presentationTime?: RelMs;
  scripts?: LoafScript[];
}

export interface LoafScript {
  startTime: RelMs;
  duration: DurationMs;
  /** e.g. 'classic-script' | 'module-script' | 'user-callback' | 'event-listener' | 'resolve-promise'. */
  invokerType?: string;
  /** The attributed source, e.g. a script URL or 'IMG#hero.onload'. */
  invoker?: string;
  executionStart?: RelMs;
  forcedStyleAndLayoutDuration?: DurationMs;
  pauseDuration?: DurationMs;
  /** Source location — left unsymbolicated here; `symbolication` resolves it later. */
  sourceURL?: string;
  sourceFunctionName?: string;
  sourceCharPosition?: number;
  /** 'self' | 'descendant' | 'ancestor' | 'same-page' | 'other' — which window the script ran in. */
  windowAttribution?: string;
}

export interface LoafStream {
  frames: LoafEntry[];
}
