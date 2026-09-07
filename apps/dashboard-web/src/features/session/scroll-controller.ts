import type { TranscriptScrollCommand } from '../../entities/transcript/scroll-command';
import { FOLLOW_REARM_DISTANCE_PX } from '../../entities/transcript/virtual-scroll';
import {
  type SessionScrollMemory,
  visibleTranscriptAnchor,
  writeSessionScrollMemory,
} from './scroll-memory';

export type ScrollState = {
  phase: 'restoring' | 'following' | 'reading';
  ready: boolean;
  away: boolean;
  command?: TranscriptScrollCommand;
};
type History = { start: number; hasOlder: boolean };

/** One instance per visit, independent of persistence and React render timing. */
export class SessionScrollController {
  private state: ScrollState;
  private listeners = new Set<() => void>();
  private element?: HTMLDivElement;
  private generation = 0;
  private frame?: number;
  private readyTimer?: number;
  private commandAbort?: AbortController;
  private historyRequest?: object;
  private history?: History;
  private cancelHistory?: () => void;
  private lastSnapshot?: SessionScrollMemory;
  private userDownUntil = 0;
  private previousTop = 0;

  constructor(
    private readonly memory?: SessionScrollMemory,
    private readonly storageKey?: string,
  ) {
    this.state = {
      phase: memory?.mode === 'manual' ? 'restoring' : 'following',
      ready: false,
      away: false,
    };
  }

  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private change(patch: Partial<ScrollState>) {
    const next = { ...this.state, ...patch };
    if (
      Object.keys(patch).every(
        (key) =>
          next[key as keyof ScrollState] ===
          this.state[key as keyof ScrollState],
      )
    )
      return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  connect(element: HTMLDivElement) {
    this.element = element;
    this.previousTop = element.scrollTop;
    this.generation += 1;
    // A layout-effect cleanup/reconnect must not revive old callbacks.
    if (this.state.phase === 'following') this.latest();
  }

  disconnect() {
    // Use the last observation, never a ref that may already point at another
    // thread or a scrollport whose transcript React has just replaced.
    if (this.storageKey && this.lastSnapshot)
      writeSessionScrollMemory(this.storageKey, this.lastSnapshot);
    this.cancelWork();
    this.element = undefined;
  }

  private cancelWork() {
    this.generation += 1;
    if (this.frame !== undefined) window.cancelAnimationFrame(this.frame);
    if (this.readyTimer !== undefined) window.clearTimeout(this.readyTimer);
    this.frame = undefined;
    this.readyTimer = undefined;
    this.commandAbort?.abort();
    this.commandAbort = undefined;
    this.historyRequest = undefined;
    this.userDownUntil = 0;
    this.change({ command: undefined });
  }

  private observe() {
    const element = this.element;
    if (!element || this.state.phase === 'restoring') return;
    this.change({ away: this.state.phase === 'reading' && this.gap() > 120 });
    if (!this.storageKey) return;
    const value: SessionScrollMemory = {
      version: 1,
      mode: this.state.phase === 'following' ? 'following' : 'manual',
      scrollTop: element.scrollTop,
      ...visibleTranscriptAnchor(element),
      ...(this.history ? { oldestOrdinal: this.history.start } : {}),
    };
    this.lastSnapshot = value;
    writeSessionScrollMemory(this.storageKey, value);
  }

  private gap() {
    const element = this.element;
    return element
      ? Math.max(
          0,
          element.scrollHeight - element.scrollTop - element.clientHeight,
        )
      : 0;
  }

  /** Programmatic/layout scrolls are observations, not permission to follow. */
  onScroll = () => {
    const element = this.element;
    if (!element) return;
    const movedDown = element.scrollTop > this.previousTop;
    this.previousTop = element.scrollTop;
    if (
      this.state.phase === 'reading' &&
      movedDown &&
      Date.now() <= this.userDownUntil &&
      this.gap() <= FOLLOW_REARM_DISTANCE_PX
    ) {
      this.latest();
    }
    this.observe();
  };

  read = () => {
    if (!this.element) return;
    if (this.state.phase === 'restoring') this.cancelHistory?.();
    this.cancelWork();
    this.change({ phase: 'reading', ready: true });
    this.observe();
  };

  /** Positive means an intentional movement toward the end, not a scroll event. */
  userIntent(direction: number) {
    if (direction > 0 && this.state.phase === 'following') return;
    this.read();
    if (direction > 0) {
      this.userDownUntil = Date.now() + 500;
      if (this.gap() <= FOLLOW_REARM_DISTANCE_PX) this.latest();
    }
  }

  latest = () => {
    if (!this.element) return;
    this.cancelHistory?.();
    this.cancelWork();
    this.change({ phase: 'following', away: false });
    this.issueCommand('latest');
    this.contentChanged();
  };

  private issueCommand(kind: 'latest' | 'anchor') {
    this.commandAbort?.abort();
    const abort = new AbortController();
    this.commandAbort = abort;
    const generation = this.generation;
    this.change({
      command: {
        kind,
        ...(kind === 'anchor' ? this.memory : {}),
        scrollTop: kind === 'anchor' ? (this.memory?.scrollTop ?? 0) : 0,
        signal: abort.signal,
        complete: () => {
          if (
            !this.element ||
            abort.signal.aborted ||
            generation !== this.generation
          )
            return;
          if (kind === 'anchor') {
            this.change({ phase: 'reading', ready: true, command: undefined });
            this.previousTop = this.element.scrollTop;
            this.observe();
          }
        },
      },
    });
  }

  /** Resize/live updates may move the viewport only in following state. */
  contentChanged = () => {
    if (this.state.phase === 'reading') {
      // Row measurements can change an anchor's offset without moving the
      // scrollport. Remember the measured viewport, but never write to it.
      this.observe();
      return;
    }
    if (
      !this.element ||
      this.state.phase !== 'following' ||
      this.frame !== undefined
    )
      return;
    const element = this.element;
    const generation = this.generation;
    this.frame = window.requestAnimationFrame(() => {
      if (
        this.element !== element ||
        generation !== this.generation ||
        this.state.phase !== 'following'
      )
        return;
      this.frame = undefined;
      element.scrollTop = element.scrollHeight;
      this.observe();
      // Never let resize writes replace/drop the initial readiness request.
      if (!this.state.ready && this.readyTimer === undefined) {
        this.readyTimer = window.setTimeout(() => {
          if (this.element !== element || generation !== this.generation)
            return;
          this.readyTimer = undefined;
          this.change({ ready: true });
        }, 64);
      }
    });
  };

  updateHistory(
    history: History | undefined,
    expected: boolean,
    load?: (ordinal: number) => Promise<boolean>,
    cancel?: () => void,
  ) {
    this.history = history;
    this.cancelHistory = cancel;
    if (
      !this.element ||
      this.state.phase !== 'restoring' ||
      this.state.command ||
      this.historyRequest
    )
      return;
    if (expected && !history) return;
    const target = this.memory?.oldestOrdinal;
    if (
      history?.hasOlder &&
      target !== undefined &&
      history.start > target &&
      load
    ) {
      const request = {};
      this.historyRequest = request;
      const generation = this.generation;
      // Callback identity changes and intermediate coverage renders are not
      // cancellation. Only input, disconnect or another visit invalidate it.
      void load(target)
        .catch(() => false)
        .then(() => {
          if (
            !this.element ||
            generation !== this.generation ||
            this.historyRequest !== request
          )
            return;
          this.historyRequest = undefined;
          this.cancelHistory?.();
          this.issueCommand('anchor');
        });
    } else this.issueCommand('anchor');
  }
}
