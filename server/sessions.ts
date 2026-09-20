import { CALL_LIMIT, CALL_WINDOW_MS } from '../src/operator/contracts.ts';

export const SESSION_LIMIT = 64;
export const SESSION_IDLE_MS = 30 * 60 * 1000;
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
type Session = { attempts: number[]; touched: number; active: boolean };

/** Attempted calls count even when the provider fails or the client cancels. */
export class Sessions {
  private readonly entries = new Map<string, Session>();
  private readonly clock: () => number;
  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  remaining(id: string): number {
    return CALL_LIMIT - this.recentAttempts(id).length;
  }

  retryAfterMs(id: string): number {
    const attempts = this.recentAttempts(id);
    return attempts.length >= CALL_LIMIT
      ? Math.max(1, attempts[0]! + CALL_WINDOW_MS - this.clock())
      : 0;
  }

  private recentAttempts(id: string): number[] {
    const session = this.entries.get(id);
    if (!session) return [];
    session.attempts = session.attempts.filter(
      (at) => this.clock() - at < CALL_WINDOW_MS,
    );
    return session.attempts;
  }

  begin(id: string): { callsRemaining: number; release: () => void } {
    const now = this.clock();
    for (const [key, session] of this.entries) {
      if (!session.active && now - session.touched >= SESSION_IDLE_MS)
        this.entries.delete(key);
    }
    if ([...this.entries.values()].some((session) => session.active))
      throw new ApiError(429, 'Another decision is finishing. Try again shortly.');
    let session = this.entries.get(id);
    if (!session) {
      if (this.entries.size >= SESSION_LIMIT)
        throw new ApiError(
          429,
          'The local session limit is full. Try again after an idle session expires.',
        );
      session = { attempts: [], touched: now, active: false };
      this.entries.set(id, session);
    }
    if (this.remaining(id) <= 0)
      throw new ApiError(
        429,
        'JEV is cooling down after 18 attempts in one minute. Recovery resumes when the window clears.',
      );
    session.attempts.push(now);
    session.active = true;
    session.touched = now;
    return {
      callsRemaining: CALL_LIMIT - session.attempts.length,
      release: () => {
        session.active = false;
        session.touched = this.clock();
      },
    };
  }
}
