import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../common/token.guard';
import { ClientsService } from './clients.service';

@UseGuards(AdminGuard)
@Controller('api/clients')
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}

  @Get()
  list() {
    return this.clients.list();
  }

  /** Response chứa `token` — lần duy nhất token đầy đủ được trả ra. */
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
