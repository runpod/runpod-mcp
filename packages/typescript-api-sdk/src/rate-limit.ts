import { parseList, Token } from 'structured-headers';

export interface RateLimitWindow {
  name: string;
  remaining: number;
  resetAfterMs?: number;
}
export interface RateLimitInfo {
  windows: RateLimitWindow[];
  retryAfterMs?: number;
  /** Longest known wait. When incomplete is true, this is only a lower bound. */
  retryDelayMs?: number;
  /** Malformed metadata or an exhausted window without a usable reset. */
  incomplete: boolean;
}

export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) {
    const ms = Number(value) * 1000;
    return Number.isSafeInteger(ms) ? ms : undefined;
  }
  // Do not let Date.parse interpret invalid numeric delays as calendar dates.
  if (!/^[A-Za-z]{3},? /.test(value)) return undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function secondsToMilliseconds(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return undefined;
  const milliseconds = value * 1000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

/** Parse response metadata without throwing on malformed headers. */
export function getRateLimitInfo(headers: Pick<Headers, 'get'>, now = Date.now()): RateLimitInfo {
  const retryAfter = headers.get('Retry-After');
  const retryAfterMs = parseRetryAfter(retryAfter, now);
  const info: RateLimitInfo = {
    windows: [],
    retryAfterMs,
    retryDelayMs: retryAfterMs,
    incomplete: retryAfter !== null && retryAfterMs === undefined,
  };
  const raw = headers.get('RateLimit');
  if (raw === null) return info;
  if (!raw.trim()) return { ...info, incomplete: true };

  try {
    for (const [value, params] of parseList(raw)) {
      const name = value instanceof Token ? value.toString() : value;
      const remaining = params.get('r');
      if (typeof name !== 'string' || typeof remaining !== 'number' ||
          !Number.isSafeInteger(remaining) || remaining < 0) {
        info.incomplete = true;
        continue;
      }
      const resetAfterMs = secondsToMilliseconds(params.get('t'));
      info.windows.push({ name, remaining, resetAfterMs });
      if (remaining !== 0) continue;
      if (resetAfterMs === undefined) {
        info.incomplete = true;
        continue;
      }
      info.retryDelayMs = Math.max(info.retryDelayMs ?? 0, resetAfterMs);
    }
  } catch {
    info.incomplete = true;
  }
  return info;
}
