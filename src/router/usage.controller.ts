import { Controller, Delete, Get, Param, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../common/token.guard';
import { KeysService } from '../keys/keys.service';
import { LimitsService } from '../limits/limits.service';
import { QuotaService } from './quota.service';

@UseGuards(AdminGuard)
@Controller('api')
export class UsageController {
  constructor(
    private readonly keys: KeysService,
    private readonly limits: LimitsService,
    private readonly quota: QuotaService,
  ) {}

  /** Toàn bộ số liệu cho dashboard: keys, limits, usage[keyId][modelId], cooldowns. */
  @Get('usage')
  usage() {
    return { keys: this.keys.list(), limits: this.limits.list(), ...this.quota.snapshot() };
  }

  /** Địa chỉ gợi ý cho lệnh curl mẫu ở màn hình Client keys. */
  @Get('config')
  config() {
    return {
      publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '') || null,
      localBaseUrl: (process.env.LOCAL_BASE_URL || '').replace(/\/+$/, '') || null,
    };
  }

  @Get('logs')
  logs(@Query('limit') limit?: string) {
    return this.quota.logs(Number(limit) || 200);
  }

  @Delete('cooldowns/:keyId')
  clearAll(@Param('keyId', ParseIntPipe) keyId: number) {
    this.quota.clearCooldown(keyId);
    return { ok: true };
  }

  @Delete('cooldowns/:keyId/:modelId')
  clearOne(@Param('keyId', ParseIntPipe) keyId: number, @Param('modelId') modelId: string) {
    this.quota.clearCooldown(keyId, modelId);
    return { ok: true };
  }
}
