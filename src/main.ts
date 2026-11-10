import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { json } from 'express';

if (existsSync('.env')) process.loadEnvFile('.env');

async function bootstrap() {
  const { AppModule } = await import('./app.module'); // import sau khi load .env
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  app.use(json({ limit: '50mb' })); // request có ảnh/audio base64
  app.useStaticAssets(join(__dirname, '..', 'public'));
  app.enableShutdownHooks();

  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '127.0.0.1';
  await app.listen(port, host);
  Logger.log(`UI:    http://${host}:${port}/`, 'Bootstrap');
  Logger.log(`Proxy: http://${host}:${port}/v1beta/models/{model}:generateContent`, 'Bootstrap');
}
bootstrap();
