import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

/** Bảo vệ admin API nếu có ADMIN_TOKEN (header x-admin-token). */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(ctx: ExecutionContext) {
    const expected = process.env.ADMIN_TOKEN;
    if (!expected) return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    if (req.header('x-admin-token') === expected) return true;
    throw new UnauthorizedException('Missing or invalid x-admin-token');
  }
}
