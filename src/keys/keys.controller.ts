import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../common/token.guard';
import { maskKey, parseCurl } from './curl-parser';
import { CreateKeyDto, KeysService } from './keys.service';

@UseGuards(AdminGuard)
@Controller('api/keys')
export class KeysController {
  constructor(private readonly keys: KeysService) {}

  @Get()
  list() {
    return this.keys.list();
  }

  /** Preview: paste curl -> xem key/model trích ra được trước khi lưu. */
  @Post('parse')
  parse(@Body() body: { curl?: string }) {
    const p = parseCurl(body?.curl || '');
    return { found: !!p.apiKey, keyMasked: p.apiKey ? maskKey(p.apiKey) : null, model: p.model, url: p.url };
  }

  @Post()
  create(@Body() body: CreateKeyDto) {
    return this.keys.create(body || {});
  }

  @Get(':id/reveal')
  reveal(@Param('id', ParseIntPipe) id: number) {
    return { apiKey: this.keys.get(id).api_key };
  }

  @Post(':id/test')
  test(@Param('id', ParseIntPipe) id: number) {
    return this.keys.test(id);
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.keys.update(id, body || {});
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.keys.remove(id);
  }
}
