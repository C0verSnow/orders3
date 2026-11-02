// CI only: fake exchange and temporary SQLite, no live account or local build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { fixture, response, source, list } from './helpers.ts';
import { Scheduler } from '../../apps/server/src/scheduler/index.ts';

async function flush() { for (let index = 0; index < 10; index++) await setImmediate(); }
const rule = { name: 'BTC_USDT', quanto_multiplier: '0.1', order_price_round: '0.5' };

for (const task of ['sources', 'orders'] as const) {
  test(`${task}: a stalled response body times out, releases the task and permits a later run`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let stream!: ReadableStreamDefaultController<Uint8Array>, cancelled = false, stall = true, settled = false;
    const f = fixture(t, async url => {
      if (stall) return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; }, cancel() { cancelled = true; } }));
      return response(url.pathname.endsWith('/list') ? list([]) : []);
    });
    f.storage.saveSources([source]);
    const run = () => task === 'sources' ? f.dashboard.refreshSources() : f.dashboard.refreshOrders();
    const pending = run().then(() => { settled = true; return null; }, error => { settled = true; return error; });
    await flush();
    try {
      assert.equal(task === 'sources' ? f.dashboard.sourcesBusy : f.dashboard.gateBusy, true);
      t.mock.timers.tick(30_000); await flush();
      assert.equal(settled, true, 'a stalled read must not hold the task indefinitely');
      assert.match(String(await pending), /30 秒/);
      assert.equal(cancelled, true);
      assert.equal(f.dashboard.sourcesBusy || f.dashboard.gateBusy, false);
      assert.equal(f.activity.active, 0);
      assert.equal(f.activity.tasks[task], false);
      assert.equal(f.storage.sources().orders.length, 1);
      f.config.update({ API_KEY: 'rotated-key' });
      stall = false; await run();
      assert.equal(f.dashboard.sourcesBusy || f.dashboard.gateBusy, false);
    } finally {
      if (!cancelled) stream.close();
      await pending;
    }
  });
}

test('shutdown abort settles a sender that ignores AbortSignal, with no late source write', async t => {
  let resolve!: (value: Response) => void, settled = false;
  const f = fixture(t, () => new Promise<Response>(done => { resolve = done; }));
  f.storage.saveSources([source]);
  const pending = f.dashboard.refreshSources().then(() => { settled = true; }, () => { settled = true; });
  await flush(); f.http.controller.abort(); await flush();
  try {
    assert.equal(settled, true, 'shutdown must release the task even if the transport never settles');
    assert.equal(f.dashboard.sourcesBusy, false);
    assert.equal(f.activity.active, 0);
  } finally {
    resolve(response([])); await pending;
  }
  assert.equal(f.storage.sources().orders.length, 1);
});

test('many individually timely pages share a five-minute task budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let end = false, pages = 0, settled = false;
  const f = fixture(t, async url => {
    if (!url.pathname.endsWith('/list')) return response([]);
    await new Promise(done => setTimeout(done, 20_000));
    return response(list(end ? [] : [{ id: String(++pages), contract: 'BTC_USDT', amount: '2', activation_price: '100', reduce_only: false, original_status: 1 }]));
  });
  const pending = f.dashboard.refreshOrders(false).then(() => { settled = true; return null; }, error => { settled = true; return error; });
  try {
    await flush();
    for (let index = 0; index < 15; index++) { t.mock.timers.tick(20_000); await flush(); }
    assert.equal(settled, true, 'per-request timeouts must not allow an unbounded paginated task');
    assert.match(String(await pending), /任务超过 300 秒/);
    assert.equal(f.dashboard.gateBusy, false);
    assert.equal(f.storage.trailing().length, 0, 'partial pagination must not replace saved data');
  } finally {
    end = true; t.mock.timers.tick(30_000); await flush(); await pending;
  }
});

test('opening reports both occupying tasks and elapsed time, and does not queue or submit', async t => {
  let finishSources!: (value: Response) => void, finishOrders!: (value: Response) => void, posts = 0;
  const f = fixture(t, (url, init) => {
    if (init.method === 'POST') posts++;
    return new Promise<Response>(done => { if (url.hostname === 'supabase.invalid') finishSources = done; else finishOrders = done; });
  });
  const sources = f.dashboard.refreshSources(), orders = f.dashboard.refreshOrders(false);
  try {
    await assert.rejects(f.dashboard.executeOpening({ kind: 'manual' }), error => {
      assert.match(String(error), /本次开仓跳过/);
      assert.match(String(error), /来源刷新.*sources.*已运行 \d+ 秒/);
      assert.match(String(error), /订单同步.*orders.*已运行 \d+ 秒/);
      return true;
    });
    assert.equal(posts, 0);
  } finally {
    finishSources(response([])); finishOrders(response(list([])));
    await Promise.all([sources, orders]);
  }
  assert.equal(posts, 0);
});

test('setup failures release the connection and task state', async t => {
  const f = fixture(t);
  const original = f.config.connection.bind(f.config);
  f.config.connection = () => { throw new Error('setup failed'); };
  await assert.rejects(f.dashboard.refreshSources());
  assert.equal(f.dashboard.sourcesBusy, false);
  assert.equal(f.activity.tasks.sources, false);
  f.config.connection = original;
  assert.doesNotThrow(() => f.config.update({ API_KEY: 'new-key' }));
});

test('a timed-out write stays unknown and is never automatically resent', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let posts = 0, stream!: ReadableStreamDefaultController<Uint8Array>, cancelled = false, settled = false;
  const f = fixture(t, async (url, init) => {
    if (init.method === 'POST') {
      posts++;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; }, cancel() { cancelled = true; } }));
    }
    if (url.pathname.includes('/contracts/')) return response(rule);
    return response(url.pathname.endsWith('/list') ? list([]) : []);
  });
  f.storage.saveSources([source]);
  const pending = f.dashboard.executeOpening({ kind: 'manual' }).then(() => { settled = true; return null; }, error => { settled = true; return error; });
  try {
    await flush(); assert.equal(posts, 1);
    t.mock.timers.tick(30_000); await flush();
    assert.equal(settled, true);
    assert.match(String(await pending), /30 秒/);
    assert.equal(f.dashboard.gateBusy, false);
    assert.equal(f.storage.intents()[0].state, 'unknown');
    await assert.rejects(f.dashboard.executeOpening({ kind: 'manual' }), /未知/);
    assert.equal(posts, 1);
  } finally {
    if (!cancelled) stream.close();
    await pending;
  }
});

test('scheduled collision records the occupying task, does not replay the slot, and allows the next slot', async t => {
  const start = new Date('2026-10-19T12:00:00Z').getTime();
  t.mock.timers.enable({ apis: ['Date'], now: start });
  let finish!: (value: Response) => void, stalled = true, posts = 0;
  const f = fixture(t, async (url, init) => {
    if (stalled) return new Promise<Response>(done => { finish = done; });
    if (init.method === 'POST') { posts++; return response({ code: 0, data: { id: '123' } }); }
    if (url.pathname.includes('/contracts/')) return response(rule);
    return response(url.pathname.endsWith('/list') ? list([]) : []);
  });
  f.storage.saveSources([source]);
  const scheduler = new Scheduler(f.config, f.dashboard);
  scheduler.update({ enabled: false, cron: '* * * * *' });
  scheduler.update({ enabled: true, cron: '* * * * *' }, 'opening');
  const refresh = f.dashboard.refreshOrders(false);
  try {
    t.mock.timers.setTime(start + 60_000); await scheduler.tick();
    assert.equal(scheduler.snapshot().opening?.result, 'failed');
    assert.match(scheduler.snapshot().opening?.error ?? '', /订单同步.*orders.*已运行 \d+ 秒/);
    assert.equal(f.storage.lastRun('opening')?.state, 'failed');
  } finally {
    stalled = false; finish(response(list([]))); await refresh;
  }
  await scheduler.tick(); assert.equal(posts, 0);
  t.mock.timers.setTime(start + 120_000); await scheduler.tick();
  assert.equal(scheduler.snapshot().opening?.result, 'completed');
  assert.equal(posts, 1);
});

test('the minute refresh yields before the daily opening slot instead of colliding at :57', async t => {
  const start = new Date('2026-10-31T12:58:57Z').getTime();
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: start });
  let reads = 0, posts = 0;
  const f = fixture(t, async (url, init) => {
    if (init.method === 'POST') { posts++; return response({ code: 0, data: { id: '123' } }); }
    reads++;
    if (url.pathname.includes('/contracts/')) return response(rule);
    return response(url.pathname.endsWith('/list') ? list([]) : []);
  });
  f.storage.saveSources([source]);
  const scheduler = new Scheduler(f.config, f.dashboard);
  scheduler.update({ enabled: false, cron: '* * * * *' });
  scheduler.update({ enabled: true, cron: '0 13 * * *' }, 'opening');
  scheduler.start();
  try {
    t.mock.timers.setTime(start + 60_000); t.mock.timers.tick(60_000); await flush();
    assert.equal(reads, 0, 'the 12:59:57 background refresh must yield to the 13:00 opening');
    t.mock.timers.setTime(start + 63_000); await scheduler.tick();
    assert.equal(scheduler.snapshot().opening?.result, 'completed');
    assert.equal(posts, 1);
    const afterOpening = reads;
    t.mock.timers.setTime(start + 120_000); t.mock.timers.tick(60_000); await flush();
    assert.ok(reads > afterOpening, 'background polling resumes after the opening slot');
    assert.equal(posts, 1);
  } finally { scheduler.stop(); }
});
