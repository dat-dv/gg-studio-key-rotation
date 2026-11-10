import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../common/token.guard';
import { QuotaService } from '../router/quota.service';
import { LimitsService } from './limits.service';

@UseGuards(AdminGuard)
@Controller('api/limits')
export class LimitsController {
  constructor(
    private readonly limits: LimitsService,
    private readonly quota: QuotaService,
  ) {}

  @Get()
  list() {
    return this.limits.list();
  }

  /** Xem trước: model nào sẽ được nạp, model nào bị lược bớt vì gateway không hỗ trợ. Không ghi gì. */
  @Post('preview')
  preview(@Body() body: { raw?: string; mode?: 'merge' | 'replace' }) {
    return this.limits.preview(body?.raw || '', body?.mode === 'replace' ? 'replace' : 'merge');
  }

  /** Paste nguyên bảng Rate limits từ AI Studio. mode=replace xoá hết rồi nạp lại. */
  @Post('import')
  import(@Body() body: { raw?: string; mode?: 'merge' | 'replace' }) {
    return this.limits.import(body?.raw || '', body?.mode === 'replace' ? 'replace' : 'merge');
  }

  @Post()
  create(@Body() body: any) {
    return this.limits.create(body || {});
  }

  @Patch(':modelId')
  async update(@Param('modelId') modelId: string, @Body() body: any) {
    const updated = this.limits.update(modelId, body || {});
    if (updated && updated.modelId !== modelId) {
      // đổi model id: request_log đã theo id mới -> dựng lại bộ đếm Redis theo id mới, bỏ cooldown của id cũ
      await this.quota.clearModelCooldowns(modelId);
      await this.quota.resetCounters();
    }
    return updated;
  }

  @Delete(':modelId')
  remove(@Param('modelId') modelId: string) {
    return this.limits.remove(modelId);
  }
}
