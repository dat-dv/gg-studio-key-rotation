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

const dir = mkdtempSync(join(tmpdir(), 'gg-studio-redis-'));
process.env.DB_PATH = join(dir, 'test.db');
delete process.env.PROXY_TOKEN;
delete process.env.ADMIN_TOKEN;

const MODEL = 'gemini-3.8-flash'; // bảng limits mặc định: RPM 5, RPD 20
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
const call = () => json(`/v1beta/models/${MODEL}:generateContent`, 'POST', { contents: [{ parts: [{ text: 'hi' }] }] });
const boot = async () => {
  const { AppModule } = await import('../src/app.module');
  app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
};
type Usage = { keys: { id: number }[]; usage: Record<string, Record<string, { rpm: number; rpd: number }>> };
const usage = async () => (await (await json('/api/usage', 'GET')).json()) as Usage;

before(async () => {
  upstream = createServer((req, res) => {
    upstreamHits++;
    req.resume();
    // trả lời chậm để mọi request cùng "đang chạy" lúc gateway chọn key
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ candidates: [], usageMetadata: { totalTokenCount: 7 } }));
    }, 30);
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  await boot();
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

test('30 request cùng lúc: mỗi request cộng Redis ngay nên không vượt RPM 5 x 2 key', async () => {
  const statuses = (await Promise.all(Array.from({ length: 30 }, call))).map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 200).length, 10);
  assert.equal(statuses.filter((s) => s === 429).length, 20);
  assert.equal(upstreamHits, 10, 'request vượt RPM không được tới Google');

  const u = await usage();
  for (const k of u.keys) assert.deepEqual(u.usage[k.id][MODEL], { rpm: 5, tpm: 35, rpd: 5 }, `key #${k.id} chia đều`);
});

test('restart app: bộ đếm vẫn còn vì nằm ở Redis, không nằm trong RAM của process', async () => {
  await app.close();
  await boot();
  const u = await usage();
  for (const k of u.keys) assert.equal(u.usage[k.id][MODEL].rpd, 5);
  const hits = upstreamHits;
  assert.equal((await call()).status, 429, 'RPM vẫn đang đầy sau restart');
  assert.equal(upstreamHits, hits);
});
