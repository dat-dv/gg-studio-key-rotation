import 'reflect-metadata';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';

const dir = mkdtempSync(join(tmpdir(), 'gg-studio-limit-'));
process.env.DB_PATH = join(dir, 'test.db');
delete process.env.PROXY_TOKEN;
delete process.env.ADMIN_TOKEN;

const MODEL = 'gemini-3.8-flash';
let app: NestExpressApplication;
let upstream: Server;
let base: string;
/** trả lời tiếp theo của Google giả: 200 hoặc 429 */
let upstreamStatus = 200;
let upstreamHits = 0;

const json = (path: string, method: string, body?: unknown, token?: string) =>
  fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const call = (token: string) => json(`/v1beta/models/${MODEL}:generateContent`, 'POST', { contents: [{ parts: [{ text: 'hi' }] }] }, token);

before(async () => {
  upstream = createServer((req, res) => {
    upstreamHits++;
    req.resume();
    res.writeHead(upstreamStatus, { 'content-type': 'application/json' });
    res.end(
      upstreamStatus === 200
        ? JSON.stringify({ candidates: [], usageMetadata: { totalTokenCount: 7 } })
        : JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota' } }),
    );
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  const { AppModule } = await import('../src/app.module');
  app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

  for (const p of ['a', 'b']) {
    const res = await json('/api/keys', 'POST', { account: 'acc', project: p, apiKey: 'AIzaSy' + p.repeat(33) });
    assert.equal(res.status, 201, await res.text());
  }
});

after(async () => {
  await app.close();
  upstream.close();
  rmSync(dir, { recursive: true, force: true });
});

const client = async (body: object) => (await (await json('/api/clients', 'POST', body)).json()) as { id: number; token: string; dailyLimit: number | null };
const listed = async (id: number) => ((await (await json('/api/clients', 'GET')).json()) as any[]).find((c) => c.id === id);

test('client key có hạn mức: chặn 429 khi dùng hết, không gọi lên Google nữa', async () => {
  const c = await client({ name: 'limited', dailyLimit: 2 });
  assert.equal(c.dailyLimit, 2);
  assert.equal((await call(c.token)).status, 200);
  assert.equal((await call(c.token)).status, 200);

  const hits = upstreamHits;
  const res = await call(c.token);
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) > 0);
  const body = (await res.json()) as any;
  assert.equal(body.error.status, 'RESOURCE_EXHAUSTED');
  assert.equal(body.error.router.clientLimit, 2);
  assert.equal(upstreamHits, hits, 'request bị chặn không được tới Google');

  const row = await listed(c.id);
  assert.equal(row.dailyLimit, 2);
  assert.equal(row.requestsToday, 2);
  assert.deepEqual(row.usedByModel, { [MODEL]: 2 });
});

test('nâng hoặc bỏ hạn mức thì gọi tiếp được ngay; key không đặt hạn mức không bị chặn', async () => {
  const c = await client({ name: 'raised', dailyLimit: 1 });
  assert.equal((await call(c.token)).status, 200);
  assert.equal((await call(c.token)).status, 429);
  assert.equal((await json(`/api/clients/${c.id}`, 'PATCH', { dailyLimit: 2 })).status, 200);
  assert.equal((await call(c.token)).status, 200);
  assert.equal((await call(c.token)).status, 429);
  assert.equal((await json(`/api/clients/${c.id}`, 'PATCH', { dailyLimit: null })).status, 200);
  assert.equal((await call(c.token)).status, 200);
  assert.equal((await listed(c.id)).dailyLimit, null);
});

test('request Google từ chối (429) không bị trừ vào hạn mức của client', async () => {
  const c = await client({ name: 'refund', dailyLimit: 1 });
  upstreamStatus = 429;
  assert.equal((await call(c.token)).status, 429); // thử hết các key Google, đều bị từ chối
  upstreamStatus = 200;
  assert.equal((await listed(c.id)).requestsToday, 0);
  // hạn mức vẫn còn nguyên: bị chặn lúc này là do pool đang cooldown chứ không phải hạn mức riêng
  const res = await call(c.token);
  assert.equal(res.status, 429);
  assert.equal(((await res.json()) as any).error.router.clientLimit, undefined);
});

test('dailyLimit không hợp lệ bị từ chối', async () => {
  for (const bad of [0, -3, 1.5, 'abc'])
    assert.equal((await json('/api/clients', 'POST', { name: 'bad', dailyLimit: bad })).status, 400, String(bad));
});

test('GET /api/logs phân trang: mới nhất trước, page vượt quá thì về trang cuối', async () => {
  type Page = { items: { id: number }[]; total: number; page: number; pageSize: number; pages: number };
  const get = async (q: string) => (await (await json(`/api/logs?${q}`, 'GET')).json()) as Page;

  const p1 = await get('pageSize=1');
  assert.ok(p1.total >= 2, `cần ít nhất 2 dòng log, có ${p1.total}`);
  assert.equal(p1.items.length, 1);
  assert.equal(p1.page, 1);
  assert.equal(p1.pages, p1.total);

  const p2 = await get('pageSize=1&page=2');
  assert.equal(p2.page, 2);
  assert.ok(p2.items[0].id < p1.items[0].id, 'trang 2 phải cũ hơn trang 1');

  const far = await get('pageSize=1&page=99999');
  assert.equal(far.page, far.pages);
  assert.equal(far.items.length, 1);

  const all = await get('');
  assert.equal(all.pageSize, 50);
  assert.equal(all.items.length, Math.min(50, all.total));
});
