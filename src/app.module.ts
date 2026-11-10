import { Module } from '@nestjs/common';
import { BackupController } from './backup/backup.controller';
import { ClientsController } from './clients/clients.controller';
import { ClientsService } from './clients/clients.service';
import { AdminGuard } from './common/token.guard';
import { DatabaseService } from './db/database.service';
import { KeysController } from './keys/keys.controller';
import { KeysService } from './keys/keys.service';
import { LimitsController } from './limits/limits.controller';
import { LimitsService } from './limits/limits.service';
import { GeminiProxyController } from './router/gemini-proxy.controller';
import { QuotaService } from './router/quota.service';
import { UsageController } from './router/usage.controller';

@Module({
  controllers: [KeysController, LimitsController, UsageController, BackupController, ClientsController, GeminiProxyController],
  providers: [DatabaseService, KeysService, LimitsService, QuotaService, ClientsService, AdminGuard],
})
export class AppModule {}
