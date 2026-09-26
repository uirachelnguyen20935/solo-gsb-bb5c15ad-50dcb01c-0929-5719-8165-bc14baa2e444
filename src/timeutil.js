'use strict';

/** 时间以“秒”为整数存储；录入支持 HH:MM:SS、MM:SS、纯秒、纯数字（分钟） */

function parseTime(value, { asMinutes = false } = {}) {
  if (value == null) return null;
  if (typeof value === 'number') return asMinutes ? value * 60 : value;
  const s = String(value).trim();
  if (s === '') return null;

  // 纯数字：asMinutes 时按分钟（时长输入框），否则按秒
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return asMinutes ? n * 60 : n;
  }

  const parts = s.split(':').map((p) => p.trim());
  if (parts.length < 1 || parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) {
    const err = new Error(`无法识别的时间格式：${s}（请使用 HH:MM:SS 或 MM:SS）`);
    err.statusCode = 400;
    throw err;
  }

  let sec = 0;
  if (parts.length === 3) {
    sec = Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
  } else if (parts.length === 2) {
    sec = Number(parts[0]) * 60 + Number(parts[1]);
  } else {
    sec = Number(parts[0]);
  }
  return sec;
}

/** 秒 -> HH:MM:SS */
function formatTime(totalSeconds) {
  if (totalSeconds == null) return '—';
  const s = Math.max(0, Math.round(totalSeconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return [hh, mm, ss].map((n) => String(n).padStart(2, '0')).join(':');
}

/** 时长（秒） -> 易读文本，如 5:00 / 1:02:30 */
function formatDuration(totalSeconds) {
  if (totalSeconds == null) return '—';
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

module.exports = { parseTime, formatTime, formatDuration };
