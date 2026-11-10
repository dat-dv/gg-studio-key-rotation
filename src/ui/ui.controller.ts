import { Controller, Get, Header, Render } from '@nestjs/common';
import { CAPABILITY_UI } from '../limits/capability';

/** Các tab của dashboard, theo thứ tự trên nav. Mỗi tab có partial `views/partials/tab-<id>.hbs`. */
const TABS = [
  { id: 'keys', label: 'Keys Google' },
  { id: 'clients', label: 'Client keys' },
  { id: 'quota', label: 'Quota' },
  { id: 'limits', label: 'Limits' },
  { id: 'logs', label: 'Logs' },
];

/** Script của trang, theo đúng thứ tự nạp (file sau dùng hàm của file trước; app.js khởi động nên nạp cuối). */
const SCRIPTS = ['core', 'keys', 'quota', 'limits', 'logs', 'snippet', 'clients', 'backup', 'app'];

/** Đổi mỗi lần khởi động (= mỗi lần deploy) để trình duyệt không giữ css/js cũ. */
const ASSET_VERSION = Date.now().toString(36);

/** JSON nhúng trong thẻ <script>: chặn `</script>` và `<!--` trong dữ liệu. */
const inlineJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

/**
 * Trang dashboard. Trang không cần đăng nhập (mọi dữ liệu đi qua /api/* có AdminGuard),
 * nên chỉ nhúng vào đây những thứ không nhạy cảm.
 */
@Controller()
export class UiController {
  @Get()
  @Header('Cache-Control', 'no-cache')
  @Render('index')
  index() {
    return {
      title: 'GG Studio Key Pool',
      tabs: TABS,
      scripts: SCRIPTS,
      assetVersion: ASSET_VERSION,
      boot: inlineJson({ capabilities: CAPABILITY_UI }),
    };
  }
}
