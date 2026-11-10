// AI Studio: tạo hàng loạt project + API key trước, sau đó mới đi lấy key của mọi project mang prefix,
// xuất JSON { "1": { name, key }, ... }. Được bao nhiêu key thì xuất bấy nhiêu.
// Cách dùng: mở https://aistudio.google.com/projects, F12 -> Console, dán cả đoạn này.
(async () => {
  const COUNT = 10; // số project cần tạo
  const START = 1; // số thứ tự bắt đầu (prefix-1, prefix-2, ...)
  const PREFIX = ''; // trang Keys điền sẵn khi bấm copy; để trống thì script hỏi lúc chạy

  const prefix = (PREFIX || prompt('Nhập name prefix cho project (vd: datvan193):', '') || '').trim();
  if (!prefix) return console.warn('Chưa nhập prefix, dừng.');

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => !!el && el.getClientRects().length > 0 && !el.disabled;
  const waitFor = async (find, label, timeout = 60000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const el = find();
      if (visible(el)) return el;
      await sleep(200);
    }
    throw new Error('Không tìm thấy: ' + label);
  };
  const byText = (selector, text, exact = false) =>
    [...document.querySelectorAll(selector)].find((el) => {
      if (!visible(el)) return false;
      const t = el.innerText.replace(/\s+/g, ' ').trim();
      return exact ? t === text : t.includes(text);
    });
  const step = async (label, find, timeout) => {
    const el = await waitFor(find, label, timeout);
    el.click();
    await sleep(400);
    return el;
  };
  const setValue = (input, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    input.focus();
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const projectRow = (name) =>
    [...document.querySelectorAll('ms-project-table tr[role="row"]')].find((r) =>
      r.innerText.split(/\s+/).includes(name)
    );

  // Bắt nội dung các nút Copy của AI Studio (không phụ thuộc clipboard thật)
  let copied = null;
  const origWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
  const origExec = document.execCommand.bind(document);
  navigator.clipboard.writeText = (text) => {
    copied = text;
    return origWrite(text).catch(() => {});
  };
  document.execCommand = (cmd, ...args) => {
    if (cmd === 'copy') {
      const ae = document.activeElement;
      copied = (ae && ae.value) || String(getSelection());
    }
    return origExec(cmd, ...args);
  };

  const onProjects = () => document.querySelector('button[aria-label="Create a new project"]');
  /** Đưa trang về danh sách Projects dù đang kẹt ở dialog hay trang API keys. */
  const backToProjects = async () => {
    for (let i = 0; i < 3; i++) {
      const close = document.querySelector('button[aria-label="close"]');
      if (!visible(close)) break;
      close.click();
      await sleep(400);
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(300);
    if (location.pathname.endsWith('/api-keys') || !visible(onProjects())) {
      const link = byText('a', 'Projects');
      if (link) link.click();
    }
    await waitFor(onProjects, 'trang Projects');
  };

  // Giai đoạn 1: chỉ tạo project + key, chưa lấy key
  const createOne = async (name) => {
    // dialog của project trước còn mở thì đóng lại đã
    const stale = document.querySelector('button[aria-label="close"]');
    if (visible(stale)) {
      stale.click();
      await sleep(400);
    }
    await step('Create a new project', onProjects);
    const input = await waitFor(
      () => document.querySelector('input[aria-label="Name your project"]'),
      'ô Name your project'
    );
    setValue(input, name);
    await sleep(300);
    await step('Create project', () => byText('button.ms-button-primary', 'Create project'));
    // chờ Google tạo project xong rồi tạo key
    await step('Create key', () => byText('button.ms-button-primary', 'Create key'), 120000);
    // project hiện trong bảng kèm nút View API keys = đã tạo xong
    await waitFor(
      () => projectRow(name)?.querySelector('button[aria-label="View API keys"]'),
      'project ' + name + ' trong bảng',
      120000
    );
  };

  // Giai đoạn 2: mở project theo tên và lấy key
  const readKey = async (name) => {
    await step(
      'View API keys',
      () => projectRow(name)?.querySelector('button[aria-label="View API keys"]'),
      20000
    );
    await waitFor(
      () => location.pathname.endsWith('/api-keys') && document.querySelector('button.key-string-link'),
      'trang API keys',
      30000
    );
    await step('Mở chi tiết key', () => document.querySelector('button.key-string-link'));
    copied = null;
    await step('Copy key', () => byText('button.xap-copy-to-clipboard', 'Copy key', true));
    await sleep(500);
    let key = copied && copied.trim();
    if (!key) {
      // dự phòng: lấy key từ cURL quickstart
      await step('Copy cURL quickstart', () =>
        byText('button.xap-copy-to-clipboard', 'Copy cURL quickstart')
      );
      await sleep(500);
      const m = (copied || '').match(/x-goog-api-key:\s*([^\s"'\\]+)/i);
      key = m ? m[1] : null;
    }
    if (!key) throw new Error('Không lấy được key của ' + name);
    return key;
  };

  /** Các project trong bảng có tên đúng dạng <prefix>-<số> (kể cả project tạo từ lần chạy trước). */
  const nameRe = new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-(\\d+)$');
  const namesInTable = () =>
    [...document.querySelectorAll('ms-project-table tr[role="row"]')]
      .map((r) => r.innerText.split(/\s+/).find((t) => nameRe.test(t)))
      .filter(Boolean);

  const showResult = (json, note) => {
    const box = document.createElement('div');
    box.style.cssText =
      'position:fixed;z-index:2147483647;top:5%;left:50%;transform:translateX(-50%);width:min(720px,90vw);' +
      'background:#fff;color:#111;border:1px solid #888;border-radius:8px;padding:16px;' +
      'box-shadow:0 8px 40px rgba(0,0,0,.4);font:14px sans-serif';
    const title = document.createElement('div');
    title.textContent = note;
    title.style.cssText = 'margin-bottom:8px;font-weight:600';
    const ta = document.createElement('textarea');
    ta.value = json;
    ta.readOnly = true;
    ta.style.cssText = 'width:100%;height:50vh;font:12px monospace;box-sizing:border-box';
    const mk = (text, fn) => {
      const b = document.createElement('button');
      b.textContent = text;
      b.style.cssText = 'margin:8px 8px 0 0;padding:6px 14px;cursor:pointer';
      b.onclick = fn;
      return b;
    };
    const copyBtn = mk('Copy JSON', async () => {
      try {
        await navigator.clipboard.writeText(json);
      } catch {
        ta.select();
        document.execCommand('copy');
      }
      copyBtn.textContent = 'Đã copy ✔';
    });
    box.append(title, ta, copyBtn, mk('Đóng', () => box.remove()));
    document.body.append(box);
  };

  const result = {};
  const created = [];
  const failed = [];
  let createError = null;
  try {
    // Giai đoạn 1: tạo hết project + key trước. Lỗi (vd. hết hạn mức project) thì dừng tạo, vẫn đi lấy key.
    for (let i = 0; i < COUNT; i++) {
      const name = `${prefix}-${START + i}`;
      console.log(`⏳ Tạo [${i + 1}/${COUNT}] ${name}`);
      try {
        await createOne(name);
        created.push(name);
        console.log(`✔ Đã tạo ${name}`);
        await sleep(1000);
      } catch (err) {
        createError = err;
        console.error(`❌ Dừng tạo ở ${name}:`, err.message);
        break;
      }
    }

    // Giai đoạn 2: lấy key của mọi project mang prefix này. Project nào lỗi thì bỏ qua.
    await backToProjects();
    await sleep(1500);
    const names = [...new Set([...namesInTable(), ...created])].sort(
      (a, b) => Number(a.match(nameRe)[1]) - Number(b.match(nameRe)[1])
    );
    for (const [i, name] of names.entries()) {
      console.log(`⏳ Lấy key [${i + 1}/${names.length}] ${name}`);
      try {
        result[name.match(nameRe)[1]] = { name, key: await readKey(name) };
        console.log(`✔ ${name}`);
      } catch (err) {
        failed.push(name);
        console.error(`❌ Bỏ qua ${name}:`, err.message);
      }
      await backToProjects().catch((err) => console.error('❌', err.message));
      await sleep(500);
    }
  } finally {
    navigator.clipboard.writeText = origWrite;
    document.execCommand = origExec;
  }

  const json = JSON.stringify(result, null, 2);
  const done = Object.keys(result).length;
  console.log(json);
  showResult(
    json,
    `Lấy được ${done} key (tạo mới ${created.length}/${COUNT} project)` +
      (createError ? ` · dừng tạo: ${createError.message}` : '') +
      (failed.length ? ` · không lấy được key: ${failed.join(', ')}` : '')
  );
})();
