'use strict';

/* 前后端共用的展示辅助 */

window.CS = {
  /** 秒 -> HH:MM:SS */
  fmtTime(totalSeconds) {
    if (totalSeconds == null) return '—';
    const s = Math.max(0, Math.round(totalSeconds));
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    return [hh, mm, ss].map((n) => String(n).padStart(2, '0')).join(':');
  },

  /** 时间点（秒）-> HH:MM:SS，允许负值（最迟允许开始可能早于开排零点），如 -0:05:00 */
  fmtTimeSigned(totalSeconds) {
    if (totalSeconds == null) return '—';
    const v = Math.round(totalSeconds);
    return `${v < 0 ? '−' : ''}${this.fmtTime(Math.abs(v))}`;
  },

  /** 时长 -> H:MM:SS 或 M:SS */
  fmtDur(totalSeconds) {
    if (totalSeconds == null) return '—';
    const s = Math.max(0, Math.round(totalSeconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
    }
    return `${m}:${String(ss).padStart(2, '0')}`;
  },

  /** 带符号时长（连锁余量可为负）：负值前缀 -，零显示 0:00 */
  fmtSigned(totalSeconds) {
    if (totalSeconds == null) return '—';
    const v = Math.round(totalSeconds);
    return `${v < 0 ? '−' : ''}${this.fmtDur(Math.abs(v))}`;
  },

  esc(text) {
    return String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  /** 表单回填：秒值在编辑时以分钟（可带 :SS）呈现，时间点以 HH:MM:SS 呈现 */
  durationForInput(totalSeconds) {
    if (totalSeconds == null) return '';
    const m = totalSeconds / 60;
    return Number.isInteger(m) ? String(m) : this.fmtDur(totalSeconds);
  },

  async api(path, options = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    if (!res.ok) {
      let msg = `请求失败（${res.status}）`;
      let data = null;
      try {
        data = await res.json();
        if (data && data.error) msg = data.error;
      } catch (_) { /* 忽略空响应体，如 204 */ }
      const err = new Error(msg);
      err.status = res.status;
      err.body = data; // 保留完整响应体（如导入校验失败时附带的预览）
      throw err;
    }
    if (res.status === 204) return null;
    return res.json();
  },

  /** 根据 id 在排程结果里取显示用编号/名称 */
  labelOf(cueById, id) {
    const c = cueById.get(id);
    if (!c) return `#${id}`;
    return c.ref ? c.ref : c.title;
  },
};
