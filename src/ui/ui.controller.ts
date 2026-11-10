import { Controller, Get, Redirect, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { CAPABILITY_UI } from '../limits/capability';

/**
 * Các trang của dashboard, theo thứ tự trên nav. Mỗi trang có URL `/<id>`, view `views/pages/<id>.hbs`
 * và danh sách script riêng trong `public/js` (theo đúng thứ tự nạp).
 */
const PAGES = [
  { id: 'keys', label: 'Keys Google', scripts: ['keys'] },
  { id: 'clients', label: 'Client keys', scripts: ['snippet', 'clients'] },
  { id: 'quota', label: 'Quota', scripts: ['quota'] },
  { id: 'limits', label: 'Limits', scripts: ['limits'] },
  { id: 'logs', label: 'Logs', scripts: ['logs'] },
];

/** Đổi mỗi lần khởi động (= mỗi lần deploy) để trình duyệt không giữ css/js cũ. */
const ASSET_VERSION = Date.now().toString(36);

/** JSON nhúng trong thẻ <script>: chặn `</script>` và `<!--` trong dữ liệu. */
const inlineJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

/**
 * Các trang dashboard. Trang không cần đăng nhập (mọi dữ liệu đi qua /api/* có AdminGuard),
 * nên chỉ nhúng vào đây những thứ không nhạy cảm.
 */
@Controller()
export class UiController {
  @Get()
  @Redirect(`/${PAGES[0].id}`, 302)
  home() {}

  @Get(PAGES.map((p) => p.id))
  page(@Req() req: Request, @Res() res: Response) {
    const current = PAGES.find((p) => p.id === req.path.replace(/\//g, ''))!;
    res.setHeader('Cache-Control', 'no-cache');
    res.render(`pages/${current.id}`, {
      pageTitle: current.label,
      pages: PAGES.map((p) => ({ id: p.id, label: p.label, active: p === current })),
      // core dùng chung nạp trước, backup phục vụ nút Export/Import trên header, app khởi động nên nạp cuối
      scripts: ['core', ...current.scripts, 'backup', 'app'],
      assetVersion: ASSET_VERSION,
      boot: inlineJson({ capabilities: CAPABILITY_UI }),
    });
  }
}
