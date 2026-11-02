import { parse } from 'lossless-json';
import type { Activity } from '../services/activity.ts';
import type { RequestLog } from '../services/request-log.ts';
import { AppError } from '../utils/errors.ts';

export interface TransportResult { status: number; headers: Headers; text: string; data: unknown }
export type Sender = (url: URL, init: RequestInit) => Promise<Response>;
export const REQUEST_TIMEOUT_MS = 30_000;
export const TASK_TIMEOUT_MS = 300_000;

// A transport may ignore abort or return a detached body. Bound each awaited I/O
// as well as signalling cancellation. Late results cannot resume the caller.
function abortable<T>(work: Promise<T>, signal: AbortSignal, discard?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let aborted = false;
    const abort = () => { aborted = true; reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    work.then(value => {
      signal.removeEventListener('abort', abort);
      if (aborted) discard?.(value); else resolve(value);
    }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
function cancelBody(response: Response) { void response.body?.cancel().catch(() => {}); }

export class HttpClient {
  controller = new AbortController();
  private activity: Activity;
  private log: RequestLog;
  private sender: Sender;
  private scope?: AbortSignal;
  constructor(activity: Activity, log: RequestLog, sender: Sender = fetch, scope?: AbortSignal) { this.activity = activity; this.log = log; this.sender = sender; this.scope = scope; }
  async withinTask<T>(task: string, work: (http: HttpClient) => Promise<T>): Promise<T> {
    // Design references: Got's total request budget and Undici's body cancellation;
    // see docs/issue-45-task-contention.md. No retries or new HTTP dependency.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new AppError(`任务超过 300 秒，已中止：${task}`, 504)), TASK_TIMEOUT_MS);
    const signal = AbortSignal.any([this.controller.signal, controller.signal, ...(this.scope ? [this.scope] : [])]);
    try { return await work(new HttpClient(this.activity, this.log, this.sender, signal)); }
    finally { clearTimeout(timer); }
  }
  async request(task: string, url: URL, method = 'GET', headers: Record<string, string> = {}, body?: string): Promise<TransportResult> {
    const start = performance.now(), controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const signal = AbortSignal.any([this.controller.signal, controller.signal, ...(this.scope ? [this.scope] : [])]);
    let status = 0, completed = false;
    let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    this.activity.active++; this.activity.total++;
    try {
      this.activity.record({ task, kind: 'request', state: 'started', host: url.hostname, method });
      signal.throwIfAborted();
      response = await abortable(this.sender(url, { method, headers, body, redirect: 'error', signal }), signal, cancelBody);
      status = response.status;
      const length = Number(response.headers.get('content-length'));
      if (length > 32_000_000) throw new AppError('远端响应过大', 502);
      let text = '';
      if (response.body) {
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        while (true) {
          signal.throwIfAborted();
          const result = await abortable(reader.read(), signal); if (result.done) break;
          bytes += result.value.length;
          if (bytes > 32_000_000) throw new AppError('远端响应过大', 502);
          chunks.push(result.value);
        }
        text = Buffer.concat(chunks).toString('utf8');
      }
      signal.throwIfAborted();
      // Every JSON number becomes exact text. Numeric timestamps/codes are explicitly validated later.
      let data: unknown;
      try { data = parse(text, undefined, value => value); }
      catch { throw new AppError(`远端返回无效 JSON（HTTP ${status}）`, 502); }
      completed = status >= 200 && status < 300;
      return { status, headers: response.headers, text, data };
    } catch (error) {
      if (signal.aborted && signal.reason instanceof AppError) throw signal.reason;
      if (error instanceof AppError) throw error;
      throw new AppError('网络请求中断或超过 30 秒；交易写入结果可能未知，请核对交易所', 502);
    } finally {
      clearTimeout(timer);
      if (reader) {
        // Never wait for cancellation: a broken stream's cancel() may also hang.
        if (!completed) void reader.cancel().catch(() => {});
        reader.releaseLock();
      } else if (response && !completed) cancelBody(response);
      this.activity.active--;
      this.activity.record({ task, kind: 'request', state: completed ? 'completed' : 'failed', method, host: url.hostname, status });
      this.log.write('outbound', method, url, status, Math.round(performance.now() - start), completed, task);
    }
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('接口记录必须是对象', 502);
  return value as Record<string, unknown>;
}
export function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw new AppError('接口必须返回数组', 502); return value; }
export function text(value: unknown): string { if (typeof value !== 'string') throw new AppError('接口缺少文本字段', 502); return value; }
export function timestamp(value: unknown): number {
  const string = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : text(value);
  if (!/^\d+$/.test(string) || !Number.isSafeInteger(Number(string))) throw new AppError('接口时间戳或状态码无效', 502);
  return Number(string);
}
