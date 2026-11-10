export interface KeyJsonItem {
  /** Tên project (trường `name` trong JSON). */
  project: string;
  apiKey: string;
  /** Account ghi riêng cho dòng này, nếu JSON có. */
  account: string | null;
  note: string | null;
}

const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');

/**
 * Đọc danh sách key do script tạo project xuất ra. Nhận cả hai dạng:
 *   { "1": { "name": "datvan193-1", "key": "AQ.Ab…" }, "2": { … } }
 *   [ { "name": "datvan193-1", "key": "AQ.Ab…" }, … ]
 * Trả null nếu nội dung không phải JSON kiểu này (để phía gọi coi nó là curl / key trần).
 */
export function parseKeysJson(input: string): KeyJsonItem[] | null {
  const text = (input || '').trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const rows = Array.isArray(data) ? data : Object.values(data as Record<string, unknown>);
  const items: KeyJsonItem[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const project = str(o.name) || str(o.project);
    const apiKey = str(o.key) || str(o.apiKey) || str(o.api_key);
    if (!project && !apiKey) continue;
    items.push({ project, apiKey, account: str(o.account) || null, note: str(o.note) || null });
  }
  return items.length ? items : null;
}

/** "datvan193-7" -> "datvan193": phần prefix đã nhập khi chạy script tạo project. */
export function accountFromProject(project: string) {
  return project.replace(/[-_ ]*\d+$/, '') || project;
}
