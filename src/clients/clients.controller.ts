import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../common/token.guard';
import { QuotaService } from '../router/quota.service';
import { ClientsService } from './clients.service';

@UseGuards(AdminGuard)
@Controller('api/clients')
export class ClientsController {
  constructor(
    private readonly clients: ClientsService,
    private readonly quota: QuotaService,
  ) {}

  @Get()
  list() {
    // số đã dùng hôm nay đọc từ request_log: ghi nốt log còn trong hàng đợi để khớp với bộ đếm hạn mức trong Redis
    this.quota.flush();
    return this.clients.list();
  }

  /** Key đầy đủ của một client (409 nếu key tạo trước khi gateway lưu lại). */
  @Get(':id/reveal')
  reveal(@Param('id', ParseIntPipe) id: number) {
    return this.clients.reveal(id);
  }

  /** Response chứa `token` đầy đủ; sau đó xem lại qua GET :id/reveal. */
  @Post()
  create(@Body() body: any) {
    return this.clients.create(body || {});
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.clients.update(id, body || {});
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.clients.remove(id);
  }
}
