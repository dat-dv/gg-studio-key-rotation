import 'reflect-metadata';
import './redis-env';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import type { QuotaService } from '../src/router/quota.service';

const dir = mkdtempSync(join(tmpdir(), 'gg-studio-backoff-'));
process.env.DB_PATH = join(dir, 'test.db');
delete process.env.PROXY_TOKEN;
delete process.env.ADMIN_TOKEN;

const MODEL = 'gemini-3.8-flash';
let app: NestExpressApplication;
let upstream: Server;
let base: string;
let quota: QuotaService;
let keyId: number;
let upstreamStatus = 429;
let upstreamHits = 0;

const json = (path: string, method: string, body?: unknown) =>
  fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const call = () => json(`/v1beta/models/${MODEL}:generateContent`, 'POST', { contents: [{ parts: [{ text: 'hi' }] }] });
const cooldown = async () => {
  const u = (await (await json('/api/usage', 'GET')).json()) as { now: number; cooldowns: { modelId: string; until: number; reason: string }[] };
  const c = u.cooldowns.find((x) => x.modelId === MODEL);
  return c ? { ms: c.until - u.now, reason: c.reason } : null;
};

before(async () => {
  upstream = createServer((req, res) => {
    upstreamHits++;
    req.resume();
    res.writeHead(upstreamStatus, { 'content-type': 'application/json' });
    res.end(
      upstreamStatus === 200
        ? JSON.stringify({ candidates: [], usageMetadata: { totalTokenCount: 7 } })
        : // giống lỗi thật của Google khi cạn quota: không kèm QuotaFailure / RetryInfo
          JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Resource has been exhausted (e.g. check quota).' } }),
    );
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  const { AppModule } = await import('../src/app.module');
  const { QuotaService: Quota } = await import('../src/router/quota.service');
  app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  quota = app.get(Quota);

  const res = await json('/api/keys', 'POST', { account: 'acc', project: 'a', apiKey: 'AIzaSy' + 'a'.repeat(33) });
  const text = await res.text();
  assert.equal(res.status, 201, text);
  keyId = (JSON.parse(text) as { key: { id: number } }).key.id;
  assert.ok(Number.isInteger(keyId));
});

after(async () => {
  await app.close();
  upstream.close();
  rmSync(dir, { recursive: true, force: true });
});

test('429 không rõ loại quota: lần đầu khoá 60s, đang khoá thì không gọi Google nữa', async () => {
  assert.equal((await call()).status, 429);
  assert.equal(upstreamHits, 1);
  const c = await cooldown();
  assert.ok(c && c.ms > 55_000 && c.ms <= 60_000, `khoá ~60s, thực tế ${c?.ms}ms`);
  assert.doesNotMatch(c.reason, /liên tiếp/);

  assert.equal((await call()).status, 429);
  assert.equal(upstreamHits, 1, 'pair đang khoá: không tới Google');
});

test('429 liên tiếp thì khoá gấp đôi mỗi lần, tới mức trần; các 429 đồng thời chỉ tính 1 lần', async () => {
  const B = 40; // ms
  const CAP = 150;
  const M = 'model-x';
  const first = await quota.backoff(keyId, M, B, CAP, '429 X');
  assert.equal(first.strikes, 1);

  // 5 request đã lỡ gửi đi cùng nhận 429 trong lúc pair đang khoá: không cộng thêm lần nào
  const burst = await Promise.all(Array.from({ length: 5 }, () => quota.backoff(keyId, M, B, CAP, '429 X')));
  for (const b of burst) assert.deepEqual(b, first);

  const durations: number[] = [];
  let lockedUntil = first.until;
  for (let i = 2; i <= 4; i++) {
    await sleep(Math.max(0, lockedUntil - Date.now()) + 5); // chờ hết khoá rồi mới "bị 429" lần nữa
    const t = Date.now();
    const b = await quota.backoff(keyId, M, B, CAP, '429 X');
    assert.equal(b.strikes, i);
    durations.push(b.until - t);
    lockedUntil = b.until;
  }
  const near = (got: number, want: number) => assert.ok(Math.abs(got - want) <= 15, `khoá ${got}ms, mong đợi ~${want}ms`);
  near(durations[0], 80);
  near(durations[1], 150); // 160 bị chặn ở trần 150
  near(durations[2], 150);
});

test('có request thành công thì chuỗi 429 được xoá, lần sau tính lại từ đầu', async () => {
  // gỡ khoá của test đầu bằng API của tab Quota -> cũng xoá chuỗi
  assert.equal((await json(`/api/cooldowns/${keyId}/${MODEL}`, 'DELETE')).status, 200);
  upstreamStatus = 429;
  assert.equal((await call()).status, 429); // lần 1
  // hết khoá (giả lập bằng cách xoá riêng cooldown, giữ chuỗi) rồi 429 tiếp -> lần 2
  const two = await quota.backoff(keyId, MODEL, 60_000, 3600_000, '429 RESOURCE_EXHAUSTED');
  assert.equal(two.strikes, 1, 'đang khoá nên chưa cộng');

  await json(`/api/cooldowns/${keyId}/${MODEL}`, 'DELETE');
  upstreamStatus = 200;
  assert.equal((await call()).status, 200);
  upstreamStatus = 429;
  assert.equal((await call()).status, 429);
  const c = await cooldown();
  assert.ok(c && c.ms <= 60_000, 'sau khi có request 200, 429 kế tiếp lại chỉ khoá 60s');
  assert.doesNotMatch(c.reason, /liên tiếp/);
});
