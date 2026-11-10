import 'reflect-metadata';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';

const dir = mkdtempSync(join(tmpdir(), 'gg-studio-ui-'));
process.env.DB_PATH = join(dir, 'test.db');

let app: NestExpressApplication;
let base: string;

before(async () => {
  const { AppModule } = await import('../src/app.module');
  const { setupViews } = await import('../src/ui/view-engine');
  app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
  setupViews(app);
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});

after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

test('dashboard: render đủ layout, nav và 5 tab', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/html/);
  const html = await res.text();
  assert.match(html, /^<!doctype html>/);
  for (const tab of ['keys', 'clients', 'quota', 'limits', 'logs']) {
    assert.ok(html.includes(`<section id="tab-${tab}"`), `thiếu section tab-${tab}`);
    assert.ok(html.includes(`data-tab="${tab}"`), `thiếu nút nav ${tab}`);
  }
  assert.equal(html.match(/<button data-tab="[a-z]+" class="active">/g)?.length, 1, 'đúng một tab active lúc đầu');
  assert.ok(!html.includes('{{'), 'còn sót cú pháp template chưa render');
});

test('dashboard: dữ liệu boot là JSON hợp lệ, có đủ loại model', async () => {
  const html = await (await fetch(base + '/')).text();
  const boot = JSON.parse(html.match(/<script id="boot" type="application\/json">(.*?)<\/script>/s)![1]);
  assert.deepEqual(Object.keys(boot.capabilities), ['chat', 'embedding', 'tts', 'image', 'other']);
  assert.equal(typeof boot.capabilities.tts.label, 'string');
});

test('dashboard: mọi css/js trang tham chiếu đều tải được', async () => {
  const html = await (await fetch(base + '/')).text();
  const assets = [...html.matchAll(/(?:href|src)="(\/(?:css|js)\/[^"]+)"/g)].map((m) => m[1]);
  assert.equal(assets.filter((a) => a.startsWith('/js/')).length, 9);
  assert.equal(assets.filter((a) => a.startsWith('/css/')).length, 1);
  for (const a of assets) {
    const res = await fetch(base + a);
    assert.equal(res.status, 200, a);
    assert.match(res.headers.get('content-type') || '', a.startsWith('/css/') ? /text\/css/ : /javascript/, a);
  }
});

test('proxy và admin API vẫn nằm đúng chỗ bên cạnh trang dashboard', async () => {
  assert.equal((await fetch(base + '/healthz')).status, 200);
  assert.equal((await fetch(base + '/api/usage')).status, 200);
});
