import type { SourceSnapshot, OrdersSnapshot, Execution } from '../../../../packages/shared/types.ts';
import { two, decimal } from '../../../../packages/decimal/index.ts';
import type { Configuration } from '../config/index.ts';
import type { Storage } from '../database/index.ts';
import type { Activity } from './activity.ts';
import { HttpClient } from '../exchange/http.ts';
import { syncEntries } from './entry-history.ts';
import { Gate } from '../exchange/gate.ts';
import { fetchSources } from '../exchange/supabase.ts';
import { sourceOrder } from './source-parser.ts';
import { openOrders, type TradingAuthorization } from './trading.ts';
import { closeOrders } from './closing.ts';
import { syncPositions } from './positions.ts';
import { AppError, safeError } from '../utils/errors.ts';

const taskNames = { sources: '来源刷新', orders: '订单同步', opening: '开仓', maintenance: '持仓维护', 'manual-review': '人工核对' } as const;
type DashboardTask = keyof typeof taskNames;
interface RunningTask { task: DashboardTask; started: number }

export class Dashboard {
  private sourceTask?: RunningTask;
  private gateTask?: RunningTask;
  get sourcesBusy() { return !!this.sourceTask; }
  get gateBusy() { return !!this.gateTask; }
  gateWork: Promise<unknown> = Promise.resolve();
  phase = 'idle';
  sourceError: string | null = null;
  ordersError: string | null = null;
  execution: Execution[] = [];
  closeExecution: Execution[] = [];
  started = performance.now();
  config: Configuration;
  storage: Storage;
  http: HttpClient;
  activity: Activity;
  constructor(config: Configuration, storage: Storage, http: HttpClient, activity: Activity) { this.config = config; this.storage = storage; this.http = http; this.activity = activity; }
  private busyError(message: string) {
    const occupied = [this.sourceTask, this.gateTask].filter((row): row is RunningTask => !!row)
      .map(row => `${taskNames[row.task]}（${row.task}），已运行 ${Math.floor((performance.now() - row.started) / 1000)} 秒`).join('；');
    return new AppError(`${message}；占用任务：${occupied}`, 409);
  }
  private async runTask<T>(task: DashboardTask, work: (http: HttpClient) => Promise<T>): Promise<T> {
    const slot = task === 'sources' ? 'sourceTask' : 'gateTask';
    const release = this.config.acquireConnection();
    this[slot] = { task, started: performance.now() };
    try {
      this.activity.begin(task);
      const result = await this.http.withinTask(task, work);
      this.activity.finish(task, true);
      return result;
    } catch (error) {
      this.activity.finish(task, false);
      throw error;
    } finally { this[slot] = undefined; release(); }
  }
  sources(): SourceSnapshot {
    return { ...this.storage.sources(), execution: this.execution, phase: this.phase, updated_at: this.storage.updated('sources'), error: this.sourceError ?? this.storage.schemaError, refreshing: this.sourcesBusy };
  }
  orders(): OrdersSnapshot {
    const positions = this.storage.positions();
    const total = (field: 'unrealised_pnl' | 'realised_pnl') => two(this.storage.rawPositions().reduce((sum, row) => sum.plus(String(row[field])), decimal('0')));
    return { orders: this.storage.trailing(), positions, close_execution: this.closeExecution, updated_at: this.storage.updated('orders'), position_updated_at: this.storage.updated('positions'), trailing_updated_at: this.storage.updated('trailing'), error: this.ordersError ?? this.storage.schemaError,
      refreshing: this.gateBusy, unrealised_pnl: total('unrealised_pnl'), realised_pnl: total('realised_pnl'), uptime_ms: Math.floor(performance.now() - this.started) };
  }
  async refreshSources() {
    if (this.sourcesBusy) throw this.busyError('来源任务正在运行，请稍后');
    this.phase = 'fetching'; this.sourceError = null; this.execution = [];
    try {
      await this.runTask('sources', async http => {
        const config = this.config.connection();
        if (this.storage.schemaError) throw new AppError(this.storage.schemaError);
        const items = await fetchSources(http, config), gate = new Gate(http, config, 'sources');
        const contracts = new Map<string, Awaited<ReturnType<Gate['contract']>>>();
        for (let index = 0; index < items.length; index++) {
          const order = sourceOrder(items[index], index); if (!order) continue;
          if (!contracts.has(order.contract)) contracts.set(order.contract, await gate.contract(order.contract));
          const rule = contracts.get(order.contract)!;
          items[index].quanto_multiplier = rule.quanto_multiplier;
          items[index].order_price_round = rule.order_price_round;
        }
        this.storage.saveSources(items);
        this.phase = 'completed';
      });
    } catch (error) {
      this.phase = 'failed'; this.sourceError = `抓取失败，保留上次数据：${safeError(error)}`;
      throw new AppError(this.sourceError, 502);
    }
  }
  async executeOpening(authorization: TradingAuthorization) {
    if (this.gateBusy || this.sourcesBusy) throw this.busyError('数据任务正在运行，本次开仓跳过');
    if (this.storage.schemaError) throw new AppError(this.storage.schemaError);
    this.ordersError = null; this.execution = [];
    const work = this.runTask('opening', async http => {
      try {
        this.execution = await openOrders(new Gate(http, this.config.connection(), 'opening'), this.storage, authorization);
        const failure = this.execution.find(row => row.action === 'failed');
        if (failure) throw new AppError(failure.error || '开仓失败', 502);
      } catch (error) { this.ordersError = safeError(error); throw error; }
    });
    this.gateWork = work.catch(() => {});
    return work;
  }
  async resolveIntent(id: string, evidence: string) {
    if (this.gateBusy || this.sourcesBusy) throw this.busyError('请等待当前任务完成');
    const intent = this.storage.intents().find(row => row.id === id);
    if (!intent) throw new AppError('待核对交易不存在', 404);
    const work = this.runTask('manual-review', async http => {
      const gate = new Gate(http, this.config.connection(), 'manual-review');
      if (!intent.owner || intent.owner !== gate.owner) throw new AppError('原凭证指纹缺失或与当前连接不同，不能解除。请恢复原凭证核对；旧版无身份记录需离线人工恢复', 409);
      const trailing = await gate.trailing();
      await gate.positions();
      await syncEntries(gate, this.storage);
      this.storage.saveTrailing(trailing);
      this.storage.transaction(() => {
        this.storage.db.prepare("UPDATE trade_intents SET state='reviewed',review_evidence=? WHERE id=? AND owner=? AND state IN ('pending','unknown')").run(evidence, id, gate.owner);
      });
    });
    this.gateWork = work.catch(() => {});
    await work;
  }
  async maintainPositions(authorization: Extract<TradingAuthorization, { kind: 'maintenance' }>) {
    if (this.gateBusy) throw this.busyError('交易任务正在运行，请稍后');
    this.ordersError = null; this.closeExecution = [];
    const work = this.runTask('maintenance', async http => {
      try {
        const gate = new Gate(http, this.config.connection(), 'maintenance');
        if (this.storage.schemaError) throw new AppError(this.storage.schemaError);
        await syncEntries(gate, this.storage);
        await syncPositions(gate, this.storage);
        this.closeExecution = await closeOrders(gate, this.storage, authorization);
        const failure = this.closeExecution.find(row => row.action === 'failed');
        if (failure) throw new AppError(failure.error || '平仓维护失败', 502);
      } catch (error) { this.ordersError = safeError(error); throw error; }
    });
    this.gateWork = work.catch(() => {});
    return work;
  }
  async refreshOrders(includePositions = true) {
    if (this.gateBusy) throw this.busyError('交易任务正在运行，请稍后');
    this.ordersError = null;
    const work = this.runTask('orders', async http => {
      try {
        const gate = new Gate(http, this.config.connection(), 'orders');
        if (this.storage.schemaError) throw new AppError(this.storage.schemaError);
        if (includePositions) await syncPositions(gate, this.storage);
        this.storage.saveTrailing(await gate.trailing());
      } catch (error) {
        this.ordersError = safeError(error); throw new AppError(this.ordersError, 502);
      }
    });
    this.gateWork = work.catch(() => {});
    return work;
  }
}
