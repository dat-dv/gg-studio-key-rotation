import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * Kết nối Redis dùng chung. Redis giữ toàn bộ trạng thái quota (bộ đếm RPM/TPM/RPD, hạn mức client,
 * cooldown, con trỏ xoay vòng) nên là thành phần BẮT BUỘC: không kết nối được thì app không khởi động.
 *   REDIS_URL     mặc định redis://127.0.0.1:6379
 *   REDIS_PREFIX  mặc định "gg:" (đổi khi nhiều môi trường dùng chung 1 Redis)
 */
@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly log = new Logger('Redis');
  readonly url = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  readonly prefix = process.env.REDIS_PREFIX || 'gg:';
  readonly client: Redis;
  private connecting?: Promise<void>;

  constructor() {
    this.client = new Redis(this.url, {
      lazyConnect: true,
      // Redis rớt giữa chừng: lệnh lỗi sau vài lần thử thay vì treo request vô thời hạn
      maxRetriesPerRequest: 2,
      connectTimeout: 5000,
    });
    this.client.on('error', (e) => this.log.error(e.message));
  }

  /** Chờ kết nối xong (gọi nhiều lần vẫn chỉ kết nối 1 lần). Lỗi -> ném ra để app dừng khởi động. */
  ready(): Promise<void> {
    return (this.connecting ??= this.client
      .connect()
      .then(() => this.client.ping())
      .then(() => this.log.log(`Đã kết nối ${this.url.replace(/\/\/[^@]*@/, '//***@')} (prefix "${this.prefix}")`))
      .catch((e) => {
        throw new Error(`Không kết nối được Redis (${this.url.replace(/\/\/[^@]*@/, '//***@')}): ${e?.message || e}. Đặt REDIS_URL cho đúng.`);
      }));
  }

  /** Mọi key khớp pattern (đã kèm prefix). Dùng SCAN, không chặn Redis. */
  async scan(pattern: string): Promise<string[]> {
    const out: string[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await this.client.scan(cursor, 'MATCH', this.prefix + pattern, 'COUNT', 500);
      cursor = next;
      out.push(...keys);
    } while (cursor !== '0');
    return out;
  }

  async onApplicationShutdown() {
    await this.client.quit().catch(() => this.client.disconnect());
  }
}
