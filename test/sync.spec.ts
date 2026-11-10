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
import { quotaDayStart } from '../src/common/time';
import { RedisService } from '../src/redis/redis.service';

const dir = mkdtempSync(join(tmpdir(), 'gg-studio-sync-'));
process.env.DB_PATH = join(dir, 'test.db');
delete process.env.PROXY_TOKEN;
delete process.env.ADMIN_TOKEN;

const OK = 'gemini-3.1-flash-lite';
const VAGUE = 'gemini-3.5-flash-lite'; // 429 không nói quota nào
const DAILY = 'gemini-3.6-flash'; // 429 hết quota ngày
const GONE = 'gemini-3-flash'; // 404
let app: NestExpressApplication;
let upstream: Server;
let base: string;

const json = (path: string, method: string, body?: unknown, token?: string) =>
  fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const call = (model: string, token?: string) =>
  json(`/v1beta/models/${model}:generateContent`, 'POST', { contents: [{ parts: [{ text: 'hi' }] }] }, token);

type Usage = {
  usage: Record<string, Record<string, { rpd: number; rpm: number }>>;
  cooldowns: { keyId: number; modelId: string; reason: string }[];
  modelBlocks: { modelId: string }[];
};
const usage = async () => (await (await json('/api/usage', 'GET')).json()) as Usage;

before(async () => {
  upstream = createServer((req, res) => {
    const model = req.url?.match(/models\/([^:]+):/)?.[1] ?? '?';
    req.resume();
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (model === GONE) return send(404, { error: { code: 404, status: 'NOT_FOUND', message: `models/${model} is not found` } });
    if (model === VAGUE) return send(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Resource has been exhausted (e.g. check quota).' } });
    if (model === DAILY)
      return send(429, {
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          message: 'quota exceeded',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
              violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }],
            },
          ],
        },
      });
    send(200, { candidates: [], usageMetadata: { totalTokenCount: 7 } });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  const { AppModule } = await import('../src/app.module');
  app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

  const res = await json('/api/keys', 'POST', { account: 'acc', project: 'a', apiKey: 'AIzaSy' + 'a'.repeat(33) });
  assert.equal(res.status, 201, await res.text());
});

after(async () => {
  await app.close();
  upstream.close();
  rmSync(dir, { recursive: true, force: true });
});

test('Sync: dựng lại bộ đếm từ log, bỏ cooldown tự suy ra, giữ cooldown hết quota ngày', async () => {
  const [{ id: keyId }] = (await (await json('/api/keys', 'GET')).json()) as { id: number }[];
  for (let i = 0; i < 2; i++) assert.equal((await call(OK)).status, 200);
  assert.equal((await call(VAGUE)).status, 429);
  assert.equal((await call(DAILY)).status, 429);
  const c = (await (await json('/api/clients', 'POST', { name: 'auto', allowedModels: [GONE, OK] })).json()) as { token: string };
  assert.equal((await call('auto', c.token)).status, 200); // GONE 404 -> khoá model, rồi OK

  // Redis bị lệch: bộ đếm ngày sai, thêm một cooldown không có thật
  const redis = app.get(RedisService);
  const rpdKey = `${redis.prefix}rpd:${quotaDayStart(Date.now())}:${keyId}|${OK}`;
  await redis.client.set(rpdKey, 499);
  await redis.client.hset(`${redis.prefix}cd:${keyId}`, OK, `${Date.now() + 3600_000}|403 PERMISSION_DENIED`);

  let u = await usage();
  assert.equal(u.usage[keyId][OK].rpd, 499);
  assert.deepEqual(u.cooldowns.map((x) => x.modelId).sort(), [OK, VAGUE, DAILY].sort());
  assert.equal(u.modelBlocks.length, 1);

  const res = await json('/api/sync', 'POST');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, pairs: 1, cooldownsRemoved: 2, cooldownsKept: 1, modelBlocksRemoved: 1 });

  u = await usage();
  assert.equal(u.usage[keyId][OK].rpd, 3, 'đếm lại đúng 3 request thành công trong log');
  assert.equal(u.usage[keyId][OK].rpm, 3);
  assert.deepEqual(u.cooldowns.map((x) => x.modelId), [DAILY]);
  assert.match(u.cooldowns[0].reason, /PerDay/);
  assert.equal(u.modelBlocks.length, 0);
  assert.equal(await redis.client.exists(`${redis.prefix}strike:${keyId}|${VAGUE}`), 0, 'xoá chuỗi 429 liên tiếp');

  // sau sync vẫn gọi được bình thường và bộ đếm cộng tiếp
  assert.equal((await call(OK, c.token)).status, 200);
  assert.equal((await usage()).usage[keyId][OK].rpd, 4);
});
