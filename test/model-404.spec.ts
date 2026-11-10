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

const dir = mkdtempSync(join(tmpdir(), 'gg-studio-404-'));
process.env.DB_PATH = join(dir, 'test.db');
delete process.env.PROXY_TOKEN;
delete process.env.ADMIN_TOKEN;

const GONE = 'gemini-3-flash';
const GOOD = 'gemini-3.8-flash';
let app: NestExpressApplication;
let upstream: Server;
let base: string;
/** số lần Google giả bị gọi, theo model */
const hits: Record<string, number> = {};

const json = (path: string, method: string, body?: unknown, token?: string) =>
  fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

before(async () => {
  upstream = createServer((req, res) => {
    const model = req.url?.match(/models\/([^:]+):/)?.[1] ?? '?';
    hits[model] = (hits[model] ?? 0) + 1;
    req.resume();
    const gone = model === GONE;
    res.writeHead(gone ? 404 : 200, { 'content-type': 'application/json' });
    res.end(
      gone
        ? JSON.stringify({ error: { code: 404, status: 'NOT_FOUND', message: `models/${model} is not found` } })
        : JSON.stringify({ candidates: [], usageMetadata: { totalTokenCount: 7 } }),
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

test('model gateway tự chọn bị Google trả 404: chỉ thử 1 lần, các request sau bỏ qua luôn', async () => {
  const c = (await (await json('/api/clients', 'POST', { name: 'auto', allowedModels: [GONE, GOOD] })).json()) as { token: string };
  const call = () => json('/v1beta/models/auto:generateContent', 'POST', { contents: [{ parts: [{ text: 'hi' }] }] }, c.token);

  const first = await call();
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('x-gg-model'), GOOD);
  assert.equal(hits[GONE], 1);

  for (let i = 0; i < 3; i++) {
    const res = await call();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-gg-model'), GOOD);
  }
  assert.equal(hits[GONE], 1, 'model 404 không được gọi lại');
  assert.equal(hits[GOOD], 4);

  const usage = (await (await json('/api/usage', 'GET')).json()) as { cooldowns: { modelId: string; reason: string }[] };
  const cds = usage.cooldowns.filter((x) => x.modelId === GONE);
  assert.equal(cds.length, 2, 'khoá trên cả 2 key');
  assert.match(cds[0].reason, /404/);
});

test('gọi đích danh model bị 404 thì vẫn trả nguyên lỗi của Google', async () => {
  // xoá cooldown để request tới được Google
  const keys = (await (await json('/api/keys', 'GET')).json()) as { id: number }[];
  for (const k of keys) await json(`/api/cooldowns/${k.id}/${GONE}`, 'DELETE');
  const before = hits[GONE];
  const c = (await (await json('/api/clients', 'POST', { name: 'direct' })).json()) as { token: string };
  const res = await json(`/v1beta/models/${GONE}:generateContent`, 'POST', { contents: [{ parts: [{ text: 'hi' }] }] }, c.token);
  assert.equal(res.status, 404);
  assert.equal(hits[GONE], before + 1);
});
