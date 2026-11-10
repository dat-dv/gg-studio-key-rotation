// Lệnh curl mẫu cho client key: Domain / Local, chuẩn OpenAI / Gemini, đúng endpoint theo loại model.
let gwConfig = { publicBaseUrl: null, localBaseUrl: null };
api('/api/config').then((c) => { gwConfig = c; }).catch(() => {});
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
function baseFor(mode) {
  const saved = lsGet('snippetBase:' + mode);
  if (saved) return saved;
  return mode === 'domain' ? (gwConfig.publicBaseUrl || location.origin) : (gwConfig.localBaseUrl || 'http://gg-studio:3000');
}
const capOf = (modelId) => state.limits.find((l) => l.modelId === modelId)?.capability || 'chat';
/** Lệnh curl đúng endpoint cho loại model (chat / embedding / tts / image / other). */
function curlText(base, key, model, fmt, cap) {
  const native = (op, body) => `curl "${base}/v1beta/models/${model}:${op}" \\
  -H "x-goog-api-key: ${key}" \\
  -H "Content-Type: application/json" \\
  -d '${body}'`;
  const openai = (path, body) => `curl ${base}${path} \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '${body}'`;
  if (cap === 'embedding')
    return fmt === 'gemini'
      ? native('embedContent', '{"content":{"parts":[{"text":"Xin chào"}]}}')
      : openai('/v1/embeddings', `{"model":"${model}","input":"Xin chào"}`);
  if (cap === 'tts')
    return native('generateContent', '{"contents":[{"parts":[{"text":"Xin chào"}]}],"generationConfig":{"responseModalities":["AUDIO"],"speechConfig":{"voiceConfig":{"prebuiltVoiceConfig":{"voiceName":"Kore"}}}}}');
  if (cap === 'image')
    return native('generateContent', '{"contents":[{"parts":[{"text":"Vẽ một con mèo đang ngủ"}]}],"generationConfig":{"responseModalities":["IMAGE"]}}');
  if (cap === 'other' || fmt === 'gemini') return native('generateContent', '{"contents":[{"parts":[{"text":"Xin chào"}]}]}');
  return openai('/v1/chat/completions', `{"model":"${model}","messages":[{"role":"user","content":"Xin chào"}]}`);
}
let snipSeq = 0;
/** Vẽ khối lệnh mẫu vào `box`. sn = { head (html), token | null, models[] }. Mỗi box tự giữ state riêng. */
function renderSnippet(box, sn, onClose) {
  const mode = lsGet('snippetMode') || 'domain';
  const radio = 'snipMode' + ++snipSeq;
  const models = sn.models.length ? sn.models : ['gemini-2.5-flash'];
  box.innerHTML = `${sn.head || ''}
    <div class="row" style="margin-top:12px">
      <label class="row" style="margin:0;color:var(--text);cursor:pointer"><input type="radio" name="${radio}" value="domain" style="width:auto" ${mode === 'domain' ? 'checked' : ''} /> Domain (từ ngoài vào)</label>
      <label class="row" style="margin:0;color:var(--text);cursor:pointer"><input type="radio" name="${radio}" value="local" style="width:auto" ${mode === 'local' ? 'checked' : ''} /> Local (nội bộ)</label>
      <select data-s="model" style="width:auto;max-width:280px" title="Model dùng trong lệnh mẫu">${models.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('')}</select>
      <select data-s="fmt" style="width:auto"><option value="openai">Chuẩn OpenAI</option><option value="gemini">Chuẩn Gemini</option></select>
    </div>
    <div class="row" style="margin-top:8px"><input data-s="base" style="max-width:420px" spellcheck="false" /><span class="hint" data-s="hint"></span></div>
    <div class="hint" style="margin-top:8px" data-s="note"></div>
    <pre data-s="curl"></pre>
    <div class="row" style="margin-top:8px"><button class="btn sm" data-s="copy">Copy curl</button><button class="btn sm" data-s="close">Đóng</button></div>
    <div class="hint" style="margin-top:12px">Xem số request còn lại của key này (không tốn quota). Response thành công cũng có header <code>x-gg-client-remaining-requests</code> khi key có hạn mức riêng.</div>
    <pre data-s="quota"></pre>
    <div class="row" style="margin-top:8px"><button class="btn sm" data-s="copyQuota">Copy curl quota</button></div>`;
  const q = (n) => box.querySelector(`[data-s="${n}"]`);
  const curMode = () => box.querySelector(`input[name=${radio}]:checked`).value;
  let fmtChoice = 'openai';
  const update = () => {
    const base = q('base').value.trim().replace(/\/+$/, '');
    const model = q('model').value;
    const cap = capOf(model);
    const nativeOnly = cap !== 'chat' && cap !== 'embedding';
    q('fmt').disabled = nativeOnly;
    q('fmt').value = nativeOnly ? 'gemini' : fmtChoice; // model chỉ-native: ép Gemini, đổi lại model khác thì trả về lựa chọn cũ
    q('note').innerHTML = `Loại model: <b>${esc(CAPS[cap].label)}</b> — ${esc(CAPS[cap].how)}${nativeOnly ? '' : ` · Base URL cho OpenAI SDK: <code>${esc(base)}/v1</code>`}`;
    q('curl').textContent = curlText(base, sn.token || '<CLIENT_KEY>', model, q('fmt').value, cap);
    q('quota').textContent = `curl "${base}/v1/quota?model=${model}" \\\n  -H "Authorization: Bearer ${sn.token || '<CLIENT_KEY>'}"`;
  };
  const setMode = (m) => {
    lsSet('snippetMode', m);
    q('base').value = baseFor(m);
    q('hint').textContent = m === 'domain' ? 'địa chỉ public của gateway' : 'địa chỉ trong docker network / cùng máy, sửa cho đúng môi trường của anh';
    update();
  };
  box.querySelectorAll(`input[name=${radio}]`).forEach((r) => (r.onchange = () => setMode(r.value)));
  q('base').oninput = () => { lsSet('snippetBase:' + curMode(), q('base').value.trim()); update(); };
  q('model').onchange = update;
  q('fmt').onchange = () => { fmtChoice = q('fmt').value; update(); };
  q('copy').onclick = async () => { await navigator.clipboard.writeText(q('curl').textContent); toast('Đã copy curl'); };
  q('copyQuota').onclick = async () => { await navigator.clipboard.writeText(q('quota').textContent); toast('Đã copy curl'); };
  q('close').onclick = onClose;
  const copyToken = box.querySelector('[data-s="copyToken"]');
  if (copyToken) copyToken.onclick = async () => { await navigator.clipboard.writeText(sn.token); toast('Đã copy key'); };
  setMode(mode);
  return { setToken: (t) => { sn.token = t; update(); } };
}
