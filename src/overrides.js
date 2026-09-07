// Moirai 自己的 session 覆寫層(rename/pin/archive/delete)，不動官方 App 的資料。
// 對應 app.py 的 OV_PATH / _load_overrides / _save_overrides / _apply_overrides。
import fs from 'node:fs';
import path from 'node:path';

export function makeOverrides(HERE) {
  const OV_PATH = path.join(HERE, 'duo_overrides.json');

  function load() {
    try { return JSON.parse(fs.readFileSync(OV_PATH, 'utf8')); } catch { return {}; }
  }
  function save(d) {
    try { fs.writeFileSync(OV_PATH, JSON.stringify(d)); } catch {}
  }
  function apply(engine, rows, includeHidden = false) {
    const ov = load()[engine] || {};
    const out = [];
    for (const src of rows) {
      const o = ov[src.id] || {};
      if ((o.deleted || o.archived) && !includeHidden) continue;
      const r = { ...src };
      if (o.title) r.title = o.title;
      r.pinned = !!o.pinned;
      r.archived = !!o.archived;
      r.deleted = !!o.deleted;
      out.push(r);
    }
    out.sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return b.ts - a.ts;
    });
    return out;
  }
  function patch(engine, sid, patchObj) {
    const ov = load();
    ov[engine] = ov[engine] || {};
    ov[engine][sid] = ov[engine][sid] || {};
    for (const [k, v] of Object.entries(patchObj)) {
      if (v == null) delete ov[engine][sid][k];
      else ov[engine][sid][k] = v;
    }
    if (!Object.keys(ov[engine][sid]).length) delete ov[engine][sid];
    save(ov);
  }

  return { load, save, apply, patch };
}
