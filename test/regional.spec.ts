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

const dir = mkdtempSync(join(tmpdir(), 'gg-studio-regional-'));
process.env.DB_PATH = join(dir, 'test.db');
delete process.env.PROXY_TOKEN;
delete process.env.ADMIN_TOKEN;
process.env.MAX_ATTEMPTS = '2';
process.env.OVERLOAD_THRESHOLD = '3';

const apiKey = (p: string) => 'AIzaSy' + p.repeat(33);
/** project không có hạn mức theo vùng: Google từ chối mọi model, kể cả lần gọi đầu tiên */
const DEAD = new Set(['a', 'b', 'c', 'd'].map(apiKey));
const GOOD = ['e', 'f'];
let app: NestExpressApplication;
let upstream: Server;
let base: string;
const hits = new Map<string, number>();

const call = (model: string) =>
  fetch(`${base}/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }] }),
  });

before(async () => {
  upstream = createServer((req, res) => {
    const k = String(req.headers['x-goog-api-key']);
    hits.set(k, (hits.get(k) || 0) + 1);
    req.resume();
    res.setHeader('content-type', 'application/json');
    if (!DEAD.has(k)) return res.end(JSON.stringify({ candidates: [], usageMetadata: { totalTokenCount: 7 } }));
    res.statusCode = 429;
    res.end(
      JSON.stringify({
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          message:
            "Quota exceeded for quota metric 'API requests' and limit 'Request limit per minute for a region' of service 'generativelanguage.googleapis.com' for consumer 'project_number:1'.",
        },
      }),
    );
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  const { AppModule } = await import('../src/app.module');
  app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

  for (const p of 'abcdef') {
    const res = await fetch(`${base}/api/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: 'acc', project: p, apiKey: apiKey(p) }),
    });
    assert.equal(res.status, 201, await res.text());
  }
});

after(async () => {
  await app.close();
  upstream.close();
  rmSync(dir, { recursive: true, force: true });
});

test('429 hạn mức theo vùng: khoá cả key đó, không tạm nghỉ model, request vẫn chạy bằng key còn tốt', async () => {
  // 4/6 key hỏng, MAX_ATTEMPTS 2, ngưỡng quá tải 3 key: nếu tính là "Google quá tải" thì model bị tạm nghỉ (503),
  // nếu tính vào số lượt thử thì request trúng 2 key hỏng liên tiếp sẽ bị 429.
  for (let i = 0; i < 8; i++) assert.equal((await call('gemini-3.8-flash')).status, 200, `request ${i + 1}`);
  // model khác cũng không gọi lại key đã bị khoá
  for (let i = 0; i < 8; i++) assert.equal((await call('gemini-3.1-flash-lite')).status, 200, `request lite ${i + 1}`);

  for (const k of DEAD) assert.ok((hits.get(k) || 0) <= 1, `key hỏng bị gọi ${hits.get(k)} lần`);
  assert.equal(GOOD.reduce((s, p) => s + (hits.get(apiKey(p)) || 0), 0), 16);

  const u = (await (await fetch(`${base}/api/usage`)).json()) as {
    keys: { id: number; project: string }[];
    cooldowns: { keyId: number; modelId: string; reason: string }[];
  };
  const good = new Set(u.keys.filter((k) => GOOD.includes(k.project)).map((k) => k.id));
  assert.ok(u.cooldowns.length > 0, 'ít nhất 1 key hỏng đã bị gọi và bị khoá');
  for (const c of u.cooldowns) {
    assert.equal(c.modelId, '*', 'khoá cả key, không riêng 1 model');
    assert.match(c.reason, /theo vùng/);
    assert.ok(!good.has(c.keyId), 'key tốt không bị khoá');
  }
});
