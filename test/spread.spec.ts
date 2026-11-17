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

test('ít request trên nhiều model: rải ra cả pool, không dồn vào mấy key đầu', async () => {
  // 3 model x 4 request = 12 request trên 12 key. Con trỏ xoay vòng riêng từng model thì model nào cũng bắt đầu
  // từ key đầu: 4 key đầu nhận 3 request, 8 key (2 account) còn lại không được gọi lần nào.
  for (let i = 0; i < 4; i++) for (const m of MODELS) assert.equal((await call(m)).status, 200);
  const u = (await (await json('/api/usage', 'GET')).json()) as Usage;
  const totals = u.keys.map((k) => Object.values(u.usage[k.id] || {}).reduce((s, x) => s + x.rpd, 0));
  assert.deepEqual(totals, Array(KEYS).fill(1), 'mỗi key đúng 1 request');
});

test('vẫn ưu tiên key ít dùng nhất của TỪNG model', async () => {
  // thêm 8 request cho 1 model: 4 key đã chạy model này (1 lần) phải đợi 8 key chưa chạy
  for (let i = 0; i < 8; i++) assert.equal((await call(MODELS[0])).status, 200);
  const u = (await (await json('/api/usage', 'GET')).json()) as Usage;
  for (const k of u.keys) assert.equal(u.usage[k.id][MODELS[0]].rpd, 1, `key #${k.id}`);
});
