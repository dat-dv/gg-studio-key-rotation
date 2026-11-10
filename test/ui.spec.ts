import 'reflect-metadata';
import './redis-env';
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

const PAGES: Record<string, { marker: string; scripts: string[] }> = {
  keys: { marker: 'id="keysBody"', scripts: ['core', 'keys', 'backup', 'app'] },
  clients: { marker: 'id="clientsBody"', scripts: ['core', 'snippet', 'clients', 'backup', 'app'] },
  quota: { marker: 'id="quotaBody"', scripts: ['core', 'quota', 'backup', 'app'] },
  limits: { marker: 'id="limitsBody"', scripts: ['core', 'limits', 'backup', 'app'] },
  logs: { marker: 'id="logsBody"', scripts: ['core', 'logs', 'backup', 'app'] },
};
const scriptsOf = (html: string) => [...html.matchAll(/<script src="\/js\/(\w+)\.js\?v=\w+"><\/script>/g)].map((m) => m[1]);

test('trang gốc chuyển hướng về /keys', async () => {
  const res = await fetch(base + '/', { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/keys');
});

for (const [id, page] of Object.entries(PAGES)) {
  test(`/${id}: render đúng nội dung, nav và script của trang`, async () => {
    const res = await fetch(`${base}/${id}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    const html = await res.text();
    assert.match(html, /^<!doctype html>/);
    assert.ok(html.includes(page.marker), `thiếu nội dung trang ${id}`);
    for (const [other, o] of Object.entries(PAGES)) {
      assert.ok(html.includes(`<a href="/${other}"`), `thiếu link nav ${other}`);
      if (other !== id) assert.ok(!html.includes(o.marker), `trang ${id} lẫn nội dung trang ${other}`);
    }
    assert.deepEqual(html.match(/<a href="\/\w+" class="active"/g), [`<a href="/${id}" class="active"`]);
    assert.deepEqual(scriptsOf(html), page.scripts);
    assert.ok(!html.includes('{{'), 'còn sót cú pháp template chưa render');
  });
}

test('dữ liệu boot là JSON hợp lệ, có đủ loại model', async () => {
  const html = await (await fetch(base + '/limits')).text();
  const boot = JSON.parse(html.match(/<script id="boot" type="application\/json">(.*?)<\/script>/s)![1]);
  assert.deepEqual(Object.keys(boot.capabilities), ['chat', 'embedding', 'tts', 'image', 'other']);
  assert.equal(typeof boot.capabilities.tts.label, 'string');
});

test('mọi css/js các trang tham chiếu đều tải được', async () => {
  const assets = new Set<string>();
  for (const id of Object.keys(PAGES)) {
    const html = await (await fetch(`${base}/${id}`)).text();
    for (const m of html.matchAll(/(?:href|src)="(\/(?:css|js)\/[^"]+)"/g)) assets.add(m[1]);
  }
  assert.equal(assets.size, 10); // app.css + 9 script
  for (const a of assets) {
    const res = await fetch(base + a);
    assert.equal(res.status, 200, a);
    assert.match(res.headers.get('content-type') || '', a.startsWith('/css/') ? /text\/css/ : /javascript/, a);
  }
});

test('URL lạ trả 404; proxy và admin API vẫn nằm đúng chỗ', async () => {
  assert.equal((await fetch(base + '/khong-co-trang-nay')).status, 404);
  assert.equal((await fetch(base + '/healthz')).status, 200);
  assert.equal((await fetch(base + '/api/usage')).status, 200);
  assert.equal((await fetch(base + '/api/clients')).status, 200);
});

test('import JSON nhiều key: lưu dòng hợp lệ, bỏ qua dòng trùng/thiếu key', async () => {
  const post = (path: string, body: unknown) =>
    fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = JSON.stringify({
    1: { name: 'imp193-1', key: 'AQ.Ab_IMPORT-1234567890123456' },
    2: { name: 'imp193-2', key: 'AQ.Ab_IMPORT-2234567890123456' },
    3: { name: 'imp193-3', key: '' },
  });

  const preview = await (await post('/api/keys/parse', { curl: json })).json();
  assert.equal(preview.bulk.length, 3);
  assert.equal(preview.bulk[0].account, 'imp193');
  assert.ok(!JSON.stringify(preview).includes('AQ.Ab_IMPORT-1234567890123456'));

  const r = await (await post('/api/keys/import', { json })).json();
  assert.deepEqual(r.added.map((k: any) => [k.account, k.project]), [['imp193', 'imp193-1'], ['imp193', 'imp193-2']]);
  assert.deepEqual(r.skipped.map((s: any) => s.project), ['imp193-3']);

  const again = await (await post('/api/keys/import', { json, account: 'other' })).json();
  assert.equal(again.added.length, 0);
  assert.equal(again.skipped.length, 3);

  assert.equal((await post('/api/keys/import', { json: 'not json' })).status, 400);
});

test('trang Keys có nút copy script tạo key và script tải được', async () => {
  assert.ok((await (await fetch(base + '/keys')).text()).includes('id="copyCreateScript"'));
  const res = await fetch(base + '/tools/aistudio-create-project-key.js');
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes('JSON.stringify(result'));
});
