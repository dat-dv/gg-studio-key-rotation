import 'reflect-metadata';
import './redis-env';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';

const dir = mkdtempSync(join(tmpdir(), 'gg-studio-spread-'));
process.env.DB_PATH = join(dir, 'test.db');
delete process.env.PROXY_TOKEN;
delete process.env.ADMIN_TOKEN;

const MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3-flash'];
const KEYS = 12;
let app: NestExpressApplication;
let upstream: Server;
let base: string;
let upstreamHits = 0;

const json = (path: string, method: string, body?: unknown) =>
  fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const call = (model: string) =>
  json(`/v1beta/models/${model}:generateContent`, 'POST', { contents: [{ parts: [{ text: 'hi' }] }] });
type Usage = { keys: { id: number }[]; usage: Record<string, Record<string, { rpd: number }>> };

before(async () => {
  upstream = createServer((req, res) => {
    upstreamHits++;
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ candidates: [], usageMetadata: { totalTokenCount: 7 } }));
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const { AppModule } = await import('../src/app.module');
  app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  for (let i = 0; i < KEYS; i++) {
    const res = await json('/api/keys', 'POST', {
      account: `acc${Math.floor(i / 4)}`,
      project: `p${i}`,
      apiKey: 'AIzaSy' + String.fromCharCode(97 + i).repeat(33),
    });
    assert.equal(res.status, 201, await res.text());
  }
});

after(async () => {
  await app.close();
  upstream.close();
  rmSync(dir, { recursive: true, force: true });
});

const totals = async () => {
  const u = (await (await json('/api/usage', 'GET')).json()) as Usage;
  return u.keys.map((k) => Object.values(u.usage[k.id] || {}).reduce((s, x) => s + x.rpd, 0));
};

test('ít request trên nhiều model: chọn ngẫu nhiên nên rải ra cả pool, không dồn vào mấy key đầu', async () => {
  // 2 model (RPM 15) x 60 request trên 12 key, trung bình 10 request/key.
  // Xác suất một key không được gọi lần nào ~ (11/12)^120, coi như không xảy ra.
  for (let i = 0; i < 60; i++)
    for (const m of ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite']) assert.equal((await call(m)).status, 200);
  const t = await totals();
  assert.equal(t.reduce((a, b) => a + b, 0), 120);
  assert.ok(t.every((x) => x > 0), `key nào cũng được gọi: ${t}`);
});

test('không bao giờ chọn key hết lượt: dùng hết đúng tổng số lượt của pool rồi mới báo hết', async () => {
  // gemini-3.8-flash: RPM 5 x 12 key = 60 lượt/phút. Chọn nhầm key đã hết thì Google sẽ bị gọi thừa / request bị 429 sớm.
  const MODEL = MODELS[0];
  for (let i = 0; i < 5 * KEYS; i++) assert.equal((await call(MODEL)).status, 200, `request ${i + 1}`);
  const u = (await (await json('/api/usage', 'GET')).json()) as Usage;
  for (const k of u.keys) assert.equal(u.usage[k.id][MODEL].rpd, 5, `key #${k.id}`);
  const hits = upstreamHits;
  assert.equal((await call(MODEL)).status, 429, 'cả pool hết lượt -> trả luôn');
  assert.equal(upstreamHits, hits, 'không gọi Google khi hết lượt');
});
