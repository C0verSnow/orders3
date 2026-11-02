import { z } from 'zod';
import type { Schedule } from '../../../../packages/shared/types.ts';
import type { Configuration } from '../config/index.ts';
import type { Dashboard } from '../services/dashboard.ts';
import { AppError, safeError } from '../utils/errors.ts';

export class Cron {
  fields: Set<number>[];
  constructor(expression: string) {
    const parts = expression.trim().split(/\s+/);
    if (parts.length !== 5) throw new AppError('Cron 要有五段：分 时 日 月 星期');
    this.fields = parts.map((part, index) => {
      const minimum = [0, 0, 1, 1, 0][index], maximum = [59, 23, 31, 12, 7][index], values = new Set<number>();
      for (const item of part.split(',')) {
        if (!/^(?:\*|\d+(?:-\d+)?)(?:\/\d+)?$/.test(item)) throw new AppError('Cron 只支持数字、*、范围、列表和步长');
        const [range, stepText] = item.split('/'), step = stepText === undefined ? 1 : Number(stepText);
        const endpoints = range.split('-').map(Number);
        const first = range === '*' ? minimum : endpoints[0], last = range === '*' ? maximum : endpoints[1] ?? (stepText ? maximum : first);
        if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || !Number.isSafeInteger(step) || step < 1 || step > maximum + 1 || first < minimum || last > maximum || first > last) throw new AppError('Cron 数字或范围无效');
        for (let value = first; value <= last; value += step) values.add(index === 4 && value === 7 ? 0 : value);
      }
      return values;
    });
  }
  matches(date: Date): boolean {
    const [minute, hour, day, month, weekday] = this.fields, d = day.has(date.getDate()), w = weekday.has(date.getDay());
    return minute.has(date.getMinutes()) && hour.has(date.getHours()) && month.has(date.getMonth() + 1) && (day.size === 31 || weekday.size === 7 ? d && w : d || w);
  }
  nextAfter(date: Date): Date {
    const next = new Date(Math.floor(date.getTime() / 60000) * 60000 + 60000), limit = new Date(date); limit.setFullYear(limit.getFullYear() + 8);
    while (next <= limit) {
      if (this.matches(next)) return next;
      // Step actual minutes through DST, skip whole nonmatching local calendar days safely.
      if (!this.fields[3].has(next.getMonth() + 1)) { next.setDate(next.getDate() + 1); next.setHours(0, 0, 0, 0); }
      else next.setTime(next.getTime() + 60000);
    }
    throw new AppError('Cron 在未来八年内没有执行时间');
  }
}
type Task = 'schedule' | 'opening';
interface TaskState { value: Schedule; next: Date; busy: boolean; result: string; error: string | null; last: string | null; generation: number }
export class Scheduler {
  private config: Configuration;
  private dashboard: Dashboard;
  private tasks: Record<Task, TaskState>;
  timer?: ReturnType<typeof setInterval>;
  gateTimer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private ticking = false;
  private maintenanceNext = Date.now() + 600000;
  constructor(config: Configuration, dashboard: Dashboard) {
    this.config = config; this.dashboard = dashboard;
    dashboard.storage.recoverRuns();
    this.tasks = { schedule: this.load('schedule'), opening: this.load('opening') };
  }
  private load(task: Task): TaskState {
    const last = this.dashboard.storage.lastRun(task);
    try {
      const value = this.config.schedule(task);
      return { value, next: new Cron(value.cron).nextAfter(new Date()), busy: false, result: String(last?.state ?? 'idle'), error: last?.error ? String(last.error) : null, last: last ? new Date(Number(last.due_at)).toISOString() : null, generation: 0 };
    } catch (error) {
      return { value: { enabled: false, cron: '' }, next: new Date(8640000000000000), busy: false, result: 'invalid', error: safeError(error), last: null, generation: 0 };
    }
  }
  get busy() { return this.ticking; }
  get value() { return this.tasks.schedule.value; }
  get next() { return this.tasks.schedule.next; }
  get result() { return this.tasks.schedule.result; }
  private view(task: Task): Schedule {
    const state = this.tasks[task];
    return { ...state.value, next_run: state.value.enabled ? state.next.toISOString() : null, result: state.result, error: state.error, last_run: state.last };
  }
  snapshot(): Schedule { return { ...this.view('schedule'), opening: this.view('opening') }; }
  update(payload: unknown, task: Task = 'schedule') {
    const parsed = z.object({ enabled: z.boolean(), cron: z.string().min(1).max(256) }).strict().safeParse(payload);
    if (!parsed.success) throw new AppError('定时配置格式无效');
    const next = new Cron(parsed.data.cron).nextAfter(new Date());
    this.config.saveSection(task, { enabled: String(parsed.data.enabled), cron: parsed.data.cron });
    const state = this.tasks[task];
    state.value = parsed.data; state.next = next; state.generation++; state.error = null;
    return this.snapshot();
  }
  async tick(now = new Date()) {
    if (this.ticking) return;
    this.ticking = true;
    try {
    // Independent ten-minute maintenance, regardless of source/opening settings.
    if (!this.stopped && !this.dashboard.gateBusy && now.getTime() >= this.maintenanceNext) {
      const due = Math.floor(now.getTime() / 600000) * 600000;
      const id = this.dashboard.storage.claimRun('maintenance', due);
      this.maintenanceNext = now.getTime() + 600000;
      if (id) {
        let error: string | null = null;
        try { await this.dashboard.maintainPositions({ kind: 'maintenance', runId: id, assertAllowed: () => {
          if (this.stopped) throw new AppError('平仓维护已停止', 403);
        } }); }
        catch (failure) { error = safeError(failure); }
        this.dashboard.storage.finishRun(id, error ? 'failed' : 'completed', error);
      }
    }
    // Source refresh and opening are independent. If both are due, finish the read first.
    for (const task of ['schedule', 'opening'] as const) {
      const state = this.tasks[task];
      if (this.stopped || state.busy || !state.value.enabled || now.getTime() < state.next.getTime()) continue;
      const due = state.next.getTime(), cron = state.value.cron, generation = state.generation;
      state.next = new Cron(cron).nextAfter(now);
      if (now.getTime() - due >= 60000) { state.result = 'missed'; continue; }
      const id = this.dashboard.storage.claimRun(task, due);
      if (!id) continue;
      state.busy = true; state.result = 'running'; state.last = new Date(due).toISOString(); state.error = null;
      try {
        if (task === 'schedule') await this.dashboard.refreshSources();
        else await this.dashboard.executeOpening({ kind: 'scheduled', runId: id, assertAllowed: () => {
          const saved = this.config.schedule('opening');
          if (this.stopped || !state.value.enabled || generation !== state.generation || !saved.enabled || saved.cron !== cron || Date.now() < due || !new Cron(cron).matches(new Date(due))) throw new AppError('自动开仓授权已失效', 403);
        } });
        state.result = 'completed';
      } catch (error) { state.result = 'failed'; state.error = safeError(error); }
      finally {
        try { this.dashboard.storage.finishRun(id, state.result, state.error); }
        finally { state.busy = false; }
      }
    }
    } finally { this.ticking = false; }
  }
  private openingReserved(now = Date.now()) {
    const state = this.tasks.opening, until = state.next.getTime() - now;
    // A :57 poll used to overlap a daily :00 opening on successive days.
    // Yield before the slot, including its one-minute dispatch window; never replay it.
    return state.value.enabled && until <= 60_000 && until > -60_000;
  }
  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 1000);
    this.gateTimer = setInterval(() => { if (!this.stopped && !this.ticking && !this.dashboard.gateBusy && !this.openingReserved()) void this.dashboard.refreshOrders().catch(() => {}); }, 60000);
  }
  stop() { this.stopped = true; clearInterval(this.timer); clearInterval(this.gateTimer); this.timer = undefined; this.gateTimer = undefined; }
}
