import { abortable } from "./abort.js";

/** Known log fields are optional; additional JSON properties are preserved. */
export interface LogEntry {
  source?: string;
  line?: string;
  ts?: string;
  /** Original SSE data when it cannot be represented as a LogEntry. */
  raw?: string;
  [key: string]: unknown;
}

export interface LogEvent {
  /** SSE event name; defaults to "message". */
  event: string;
  /** Last SSE ID received, carried forward until replaced or reset to "". */
  id?: string;
  data: LogEntry;
}

export interface LogStreamOptions {
  signal?: AbortSignal;
  /** Maximum UTF-8 bytes buffered for one SSE event. Default 1 MiB. */
  maxEventBytes?: number;
}

function parseLogEntry(raw: string): LogEntry {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { raw };

    const entry = parsed as Record<string, unknown>;
    const valid = ["source", "line", "ts", "raw"].every(
      key => !(key in entry) || typeof entry[key] === "string",
    );
    return valid ? entry as LogEntry : { raw };
  } catch {
    return { raw };
  }
}

function utf8Size(character: string): number {
  const codePoint = character.codePointAt(0)!;
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  return codePoint <= 0xffff ? 3 : 4;
}

/** Framing state is separate from stream ownership and cancellation. */
class LogEventParser {
  private line = "";
  private dataLines: string[] = [];
  private eventName = "";
  private lastEventId?: string;
  private eventBytes = 0;
  private afterCR = false;

  constructor(private readonly maxEventBytes: number) {}

  push(character: string): LogEvent | undefined {
    if (this.afterCR && character === "\n") {
      this.afterCR = false;
      return;
    }
    this.afterCR = character === "\r";
    this.eventBytes += utf8Size(character);
    if (this.eventBytes > this.maxEventBytes) {
      throw new RangeError("SSE log event exceeds maxEventBytes");
    }
    if (character === "\r" || character === "\n") return this.consumeLine();
    this.line += character;
  }

  private consumeLine(): LogEvent | undefined {
    const line = this.line;
    this.line = "";
    if (line === "") return this.finishEvent();
    if (line.startsWith(":")) return;

    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    switch (field) {
      case "data": this.dataLines.push(value); break;
      case "event": this.eventName = value; break;
      case "id": if (!value.includes("\0")) this.lastEventId = value; break;
    }
  }

  private finishEvent(): LogEvent | undefined {
    const event = this.dataLines.length ? {
      event: this.eventName || "message",
      id: this.lastEventId,
      data: parseLogEntry(this.dataLines.join("\n")),
    } : undefined;
    this.dataLines = [];
    this.eventName = "";
    this.eventBytes = 0;
    return event;
  }
}

/**
 * Decode pod or worker SSE logs. Owns the reader and cancels it on early exit.
 * Incomplete final events are discarded; this does not reconnect or replay logs.
 */
export async function* iterateLogEvents(
  stream: ReadableStream<Uint8Array>, options: LogStreamOptions = {},
): AsyncGenerator<LogEvent> {
  const maxEventBytes = options.maxEventBytes ?? 1_048_576;
  if (!Number.isSafeInteger(maxEventBytes) || maxEventBytes <= 0) {
    throw new RangeError("maxEventBytes must be a positive safe integer");
  }
  const parser = new LogEventParser(maxEventBytes);
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  const signal = options.signal;
  const onAbort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  let finished = false;
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      signal?.throwIfAborted();
      const chunk = await abortable(reader.read(), signal);
      signal?.throwIfAborted();
      if (chunk.done) {
        finished = true;
        return;
      }
      for (const character of decoder.decode(chunk.value, { stream: true })) {
        signal?.throwIfAborted();
        const event = parser.push(character);
        if (event) yield event;
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!finished) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
