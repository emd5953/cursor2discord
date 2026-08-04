/**
 * Edit-shape classifier for Cursor AI activity.
 *
 * Cursor exposes no API for Composer/Chat/agent state, so this is inference,
 * not instrumentation, and it is written to be wrong in the safe direction: a
 * missed AI session shows "editing", a false positive tells everyone you're
 * driving an agent when you pasted a stack trace. Suppressions therefore win
 * outright rather than subtracting from a score.
 *
 * Pure so the thresholds can be tested without a VS Code host.
 */

export interface EditWindow {
  /** Characters inserted across the window. */
  readonly insertedLength: number;
  /** Distinct documents touched in the window. */
  readonly fileCount: number;
  /** Individual content changes across the window. */
  readonly changeCount: number;
  /** ms since the last `Keyboard`-kind selection change, or null if never. */
  readonly msSinceKeyboard: number | null;
  /** ms since `onWillSaveTextDocument`, or null. */
  readonly msSinceWillSave: number | null;
  /** ms since git reported a HEAD change, or null. */
  readonly msSinceHeadChange: number | null;
  /** Whether a Cursor chat/composer tab is currently open. */
  readonly chatTabOpen: boolean;
  /** The window was one insert landing at exactly one cursor. */
  readonly singleInsertAtOneSelection: boolean;
}

/** SPEC.md §Cursor AI heuristic. Every threshold in one place. */
export const THRESHOLDS = {
  activate: 0.7,
  insertedLength: 120,
  largeInsertedLength: 600,
  keyboardQuietMs: 300,
  formatOnSaveMs: 1_000,
  headChangeMs: 2_000,
  refactorMs: 1_000,
} as const;

export function classify(window: EditWindow): number {
  // --- suppressions: each of these is a real false positive ---

  // Format-on-save rewrites a whole file with no keystroke behind it.
  if (within(window.msSinceWillSave, THRESHOLDS.formatOnSaveMs)) return 0;

  // A branch switch rewrites many files at once.
  if (within(window.msSinceHeadChange, THRESHOLDS.headChangeMs)) return 0;

  // Rename-symbol and organize-imports are multi-file edits that look exactly
  // like an agent, so they are separated by whether a chat panel is even open.
  if (window.fileCount >= 2 && !window.chatTabOpen) {
    if (within(window.msSinceKeyboard, THRESHOLDS.refactorMs)) return 0;
  }

  // A paste is one big insert at one cursor. So is an inline AI edit, so this
  // is the weakest rule in the set — it costs recall to protect precision.
  if (window.singleInsertAtOneSelection && window.fileCount === 1) return 0;

  // Typing. The single strongest negative signal there is.
  if (within(window.msSinceKeyboard, THRESHOLDS.keyboardQuietMs)) return 0;

  // --- positive signals ---

  let score = 0;
  if (window.insertedLength >= THRESHOLDS.insertedLength) score += 0.45;
  if (window.insertedLength >= THRESHOLDS.largeInsertedLength) score += 0.15;
  if (window.fileCount >= 2) score += 0.45;
  if (window.changeCount >= 3) score += 0.1;

  // Nothing here is AI-shaped without one of the two headline signals.
  if (score === 0) return 0;

  // Quiet keyboard is necessary but not sufficient, so it lifts rather than
  // decides.
  score += 0.3;

  return Math.min(1, score);
}

export function isActive(confidence: number): boolean {
  return confidence >= THRESHOLDS.activate;
}

function within(elapsed: number | null, limit: number): boolean {
  return elapsed !== null && elapsed <= limit;
}
