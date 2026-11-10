import 'reflect-metadata';
import './redis-env';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';

const dir = mkdtempSync(join(tmpdir(), 'gg-studio-overload-'));
process.env.DB_PATH = join(dir, 'test.db');
delete process.env.PROXY_TOKEN;
delete process.env.ADMIN_TOKEN;
process.env.MAX_ATTEMPTS = '6';
process.env.OVERLOAD_THRESHOLD = '3';
process.env.OVERLOAD_PAUSE_MS = '2000';
process.env.ROUTER_DEADLINE_MS = '400';
process.env.MAX_INFLIGHT_PER_KEY = '2';

const MODEL = 'gemini-3.8-flash';
let app: NestExpressApplication;
let upstream: Server;
let base: string;
/** cách Google giả trả lời: status + độ trễ (ms) */
let mode: { status: number; delay: number; quotaId?: string } = { status: 200, delay: 0 };
let hits = 0;
let concurrent = 0;
let peak = 0;

const call = () =>
  fetch(`${base}/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }] }),
  });

before(async () => {
  upstream = createServer((req, res) => {
    hits++;
    concurrent++;
    peak = Math.max(peak, concurrent);
    req.resume();
    const { status, delay, quotaId } = mode;
    const done = () => {
      concurrent--;
      if (res.destroyed) return;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(
        status === 200
          ? JSON.stringify({ candidates: [], usageMetadata: { totalTokenCount: 7 } })
          : JSON.stringify({
              error: {
                code: status,
                status: status === 429 ? 'RESOURCE_EXHAUSTED' : 'UNAVAILABLE',
                message: status === 429 ? 'Resource has been exhausted (e.g. check quota).' : 'This model is currently experiencing high demand.',
                details: quotaId ? [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId }] }] : [],
              },
            }),
      );
    };
    setTimeout(done, delay);
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
      body: JSON.stringify({ account: 'acc', project: p, apiKey: 'AIzaSy' + p.repeat(33) }),
    });
    assert.equal(res.status, 201, await res.text());
  }
});

after(async () => {
  await app.close();
  upstream.close();
  rmSync(dir, { recursive: true, force: true });
});

const usage = async () =>
  (await (await fetch(`${base}/api/usage`)).json()) as { cooldowns: { keyId: number; modelId: string; reason: string }[] };
const clearAll = async () => {
  const { cooldowns } = await usage();
  for (const c of cooldowns) await fetch(`${base}/api/cooldowns/${c.keyId}/${c.modelId}`, { method: 'DELETE' });
  // xoá luôn trạng thái tạm nghỉ của model (đi kèm xoá cooldown theo model)
  await fetch(`${base}/api/cooldowns/1/${MODEL}`, { method: 'DELETE' });
};

beforeEach(async () => {
  mode = { status: 200, delay: 0 };
  await clearAll();
  hits = 0;
  peak = 0;
});

test('429 không rõ quota trên nhiều key: dừng sớm, tạm nghỉ model, request sau không tới Google', async () => {
  mode = { status: 429, delay: 0 };
  const r = await call();
  assert.equal(r.status, 429);
  assert.equal(hits, 2, 'mỗi request chỉ chịu 2 lần quá tải cho 1 model, không thử hết 6 key');

  await call(); // thêm key thứ 3 bị -> đủ ngưỡng, model tạm nghỉ
  const before = hits;
  const r2 = await call();
  assert.equal(r2.status, 503);
  assert.ok(Number(r2.headers.get('retry-after')) >= 1);
  assert.match(((await r2.json()) as any).error.message, /quá tải/);
  assert.equal(hits, before, 'đang tạm nghỉ: không gọi Google');
});

test('key bị 429 lúc model đã tạm nghỉ thì không bị khoá thêm', async () => {
  mode = { status: 429, delay: 0 };
  await call();
  await call();
  const locked = new Set((await usage()).cooldowns.map((c) => c.keyId));
  assert.ok(locked.size <= 2, `chỉ các key trước khi đủ ngưỡng bị khoá, thực tế ${locked.size}`);
});

test('429 có ghi rõ quota phút vẫn khoá theo key như cũ, không tính là quá tải', async () => {
  mode = { status: 429, delay: 0, quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' };
  await call();
  assert.equal(hits, 6, 'quota thật của key: thử hết các key');
  mode = { status: 200, delay: 0 };
  await clearAll();
  assert.equal((await call()).status, 200, 'model không bị tạm nghỉ');
});

test('503 high demand trên nhiều key cũng tạm nghỉ model', async () => {
  mode = { status: 503, delay: 0 };
  await call();
  await call();
  const before = hits;
  assert.equal((await call()).status, 503);
  assert.equal(hits, before);
});

test('lần thử lại quá ROUTER_DEADLINE_MS thì huỷ và trả lỗi kèm Retry-After', async () => {
  mode = { status: 503, delay: 50 };
  // lần đầu 503 nhanh, sau đó Google treo lâu hơn deadline
  const started = Date.now();
  const p = call();
  await new Promise((r) => setTimeout(r, 20));
  mode = { status: 503, delay: 5000 };
  const r = await p;
  const took = Date.now() - started;
  assert.ok(took < 1500, `trả về trong ~deadline, thực tế ${took}ms`);
  assert.equal(r.headers.get('x-gg-deadline'), '400');
  assert.ok(r.headers.get('retry-after'));
});

test('mỗi key chỉ chạy tối đa MAX_INFLIGHT_PER_KEY request; dư thì chờ chứ không lỗi', async () => {
  mode = { status: 200, delay: 150 };
  const leftover = concurrent; // request treo của test trước (client đã huỷ) vẫn đang được Google giả giữ
  peak = 0;
  const statuses = (await Promise.all(Array.from({ length: 14 }, () => call()))).map((r) => r.status);
  assert.deepEqual(statuses, Array(14).fill(200));
  assert.ok(peak - leftover <= 12, `6 key x 2 = tối đa 12 request đồng thời, thực tế ${peak - leftover}`);
});
