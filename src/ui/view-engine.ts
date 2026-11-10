import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { NestExpressApplication } from '@nestjs/platform-express';
import hbs from 'hbs';

/** Gốc project: chứa `views/` (template Handlebars) và `public/` (css, js). Đúng cả khi chạy từ src/ lẫn dist/. */
const ROOT = join(__dirname, '..', '..');

/** Gắn view engine Handlebars và thư mục file tĩnh cho dashboard. */
export function setupViews(app: NestExpressApplication) {
  const views = join(ROOT, 'views');
  const partials = join(views, 'partials');
  // nạp đồng bộ để partial sẵn sàng trước request đầu tiên (hbs.registerPartials chạy bất đồng bộ)
  for (const file of readdirSync(partials)) {
    if (file.endsWith('.hbs')) hbs.registerPartial(basename(file, '.hbs'), readFileSync(join(partials, file), 'utf8'));
  }
  app.useStaticAssets(join(ROOT, 'public'), { index: false });
  app.setBaseViewsDir(views);
  app.setViewEngine('hbs');
}
