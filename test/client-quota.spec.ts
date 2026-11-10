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

const dir = mkdtempSync(join(tmpdir(), 'gg-studio-quota-'));
process.env.DB_PATH = join(dir, 'test.db');
delete process.env.PROXY_TOKEN;
delete process.env.ADMIN_TOKEN;

// bảng limits mặc định: Gemini 3.8 Flash 5 RPM / 20 RPD, Gemini 3.6 Flash 5 RPM / 20 RPD
const MODEL = 'gemini-3.8-flash';
const OTHER = 'gemini-3.6-flash';
let app: NestExpressApplication;
let upstream: Server;
let base: string;
/** trả lời tiếp theo của Google giả: 200, 400, hoặc 429 theo ngày */
let upstreamStatus = 200;
let upstreamHits = 0;
const keyIds: number[] = [];

const json = (path: string, method: string, body?: unknown, token?: string) =>
  fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const call = (token: string, model = MODEL) =>
  json(`/v1beta/models/${model}:generateContent`, 'POST', { contents: [{ parts: [{ text: 'hi' }] }] }, token);
const quota = async (token: string, q = '') => {
  const res = await json(`/v1/quota${q}`, 'GET', undefined, token);
  return { res, body: (await res.json()) as any };
};
const modelOf = (body: any, id: string) => body.models.find((m: any) => m.model === id);

before(async () => {
  upstream = createServer((req, res) => {
    upstreamHits++;
    req.resume();
    res.writeHead(upstreamStatus, { 'content-type': 'application/json' });
    if (upstreamStatus === 200) res.end(JSON.stringify({ candidates: [], usageMetadata: { totalTokenCount: 7 } }));
    else if (upstreamStatus === 429)
      res.end(
        JSON.stringify({
          error: {
            code: 429,
            status: 'RESOURCE_EXHAUSTED',
            message: 'quota',
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
                violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }],
              },
            ],
          },
        }),
      );
    else res.end(JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'bad' } }));
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  const { AppModule } = await import('../src/app.module');
  app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

  for (const p of ['a', 'b']) {
    const res = await json('/api/keys', 'POST', { account: 'acc', project: p, apiKey: 'AIzaSy' + p.repeat(33) });
    const text = await res.text();
    assert.equal(res.status, 201, text);
    keyIds.push((JSON.parse(text) as { key: { id: number } }).key.id);
  }
});

after(async () => {
  await app.close();
  upstream.close();
  rmSync(dir, { recursive: true, force: true });
});

const client = async (body: object) =>
  (await (await json('/api/clients', 'POST', body)).json()) as { id: number; token: string };

test('client có hạn mức: /v1/quota và header trên response cho biết còn bao nhiêu', async () => {
  const c = await client({ name: 'limited', dailyLimit: 3, allowedModels: [MODEL, OTHER] });

  let q = await quota(c.token);
  assert.equal(q.res.status, 200);
  assert.equal(q.body.estimated, true);
  assert.deepEqual(q.body.client, { name: 'limited', dailyLimit: 3, usedToday: 0, remainingToday: 3 });
  assert.deepEqual(q.body.models.map((m: any) => m.model).sort(), [MODEL, OTHER].sort());
  assert.equal(modelOf(q.body, MODEL).remainingToday, 40); // 2 key x 20 RPD
  assert.equal(modelOf(q.body, MODEL).remainingThisMinute, 10); // 2 key x 5 RPM
  assert.equal(q.body.autoRemainingToday, 3); // hạn mức client nhỏ hơn pool
  assert.ok(q.body.resetInSeconds > 0);
  assert.equal(q.res.headers.get('x-gg-client-remaining-requests'), '3');

  const res = await call(c.token);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gg-client-remaining-requests'), '2');
  assert.equal(res.headers.get('x-ratelimit-remaining-requests'), '2');
  assert.equal(res.headers.get('x-gg-client-limit-requests'), '3');
  assert.match(res.headers.get('x-gg-client-reset-requests') || '', /^\d+s$/);

  q = await quota(c.token, `?model=${MODEL}`);
  assert.equal(q.body.client.usedToday, 1);
  assert.equal(q.body.client.remainingToday, 2);
  assert.equal(q.body.models.length, 1);
  assert.equal(q.body.models[0].usedToday, 1);
  assert.equal(q.body.models[0].remainingToday, 39);
  assert.equal(q.body.models[0].remainingThisMinute, 9);
  assert.deepEqual(q.body.models[0].keys, { enabled: 2, available: 2, coolingDown: 0, nextAvailableAt: null });
});

test('gọi /v1/quota không tốn quota và không gọi Google', async () => {
  const c = await client({ name: 'readonly', dailyLimit: 5 });
  const hits = upstreamHits;
  const before = modelOf((await quota(c.token)).body, MODEL).usedToday;
  for (let i = 0; i < 3; i++) await quota(c.token);
  const q = await quota(c.token);
  assert.equal(upstreamHits, hits);
  assert.equal(q.body.client.usedToday, 0);
  assert.equal(modelOf(q.body, MODEL).usedToday, before);
});

test('request bị Google trả 400 không trừ quota nên không gửi header số còn lại', async () => {
  const c = await client({ name: 'bad-request', dailyLimit: 2 });
  upstreamStatus = 400;
  const res = await call(c.token);
  upstreamStatus = 200;
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('x-gg-client-remaining-requests'), null);
  assert.equal((await quota(c.token)).body.client.remainingToday, 2);
});

test('hết hạn mức client: 429 kèm remaining = 0', async () => {
  const c = await client({ name: 'one', dailyLimit: 1 });
  assert.equal((await call(c.token)).status, 200);
  const res = await call(c.token);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('x-gg-client-remaining-requests'), '0');
  const q = await quota(c.token);
  assert.equal(q.body.client.remainingToday, 0);
  assert.equal(q.body.autoRemainingToday, 0);
});

test('client không có hạn mức: không có header, usedToday đọc từ log', async () => {
  const c = await client({ name: 'unlimited' });
  const res = await call(c.token, OTHER);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gg-client-remaining-requests'), null);
  const q = await quota(c.token);
  assert.equal(q.body.client.dailyLimit, null);
  assert.equal(q.body.client.usedToday, 1);
  assert.equal(q.body.client.remainingToday, null);
  assert.equal(q.res.headers.get('x-gg-client-remaining-requests'), null);
  // không giới hạn riêng -> auto bị chặn bởi tổng các model chat của pool
  assert.ok(q.body.autoRemainingToday > 0);
});

test('key bị Google 429 theo ngày tính 0 cho model đó', async () => {
  const c = await client({ name: 'cooldown', allowedModels: [OTHER] });
  const before = modelOf((await quota(c.token)).body, OTHER);
  upstreamStatus = 429;
  // key đầu tiên bị 429 theo ngày -> khoá tới hết ngày; gateway thử tiếp key thứ hai, cũng bị 429
  assert.equal((await call(c.token, OTHER)).status, 429);
  upstreamStatus = 200;
  const after = modelOf((await quota(c.token)).body, OTHER);
  assert.equal(after.remainingToday, 0);
  assert.equal(after.remainingThisMinute, 0);
  assert.deepEqual(after.keys, { enabled: 2, available: 0, coolingDown: 2, nextAvailableAt: null });
  assert.ok(before.remainingToday > 0);

  // bỏ cooldown 1 key -> phần RPD còn lại của key đó quay lại
  assert.equal((await json(`/api/cooldowns/${keyIds[0]}/${OTHER}`, 'DELETE')).status, 200);
  const one = modelOf((await quota(c.token)).body, OTHER);
  assert.ok(one.remainingToday > 0 && one.remainingToday < before.remainingToday);
  assert.equal(one.keys.available, 1);
  assert.equal(one.keys.coolingDown, 1);
});

test('chỉ liệt kê model được phép; hỏi model ngoài danh sách bị 403, model lạ 404, token sai 401', async () => {
  const c = await client({ name: 'only-one', allowedModels: [MODEL] });
  const q = await quota(c.token);
  assert.deepEqual(q.body.models.map((m: any) => m.model), [MODEL]);
  assert.equal((await quota(c.token, `?model=${OTHER}`)).res.status, 403);
  assert.equal((await quota(c.token, '?model=khong-co-model-nay')).res.status, 404);
  assert.equal((await quota('sk-gg-sai')).res.status, 401);
  // alias OpenAI
  assert.equal((await json('/openai/v1/quota', 'GET', undefined, c.token)).status, 200);
});
