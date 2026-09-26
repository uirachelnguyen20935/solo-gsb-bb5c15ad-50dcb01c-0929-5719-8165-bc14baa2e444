'use strict';

/**
 * CSV 批量导入：解析与校验（纯函数，不涉及数据库写入）。
 *
 * 文件格式：
 * - 表头固定为 ref,title,duration,minStart,maxFinish,actors,prerequisites
 * - actors / prerequisites 为多值列，多个值用 | 分隔
 * - 时间格式与手动录入一致（时长纯数字按分钟；时间点支持 HH:MM:SS / MM:SS / 纯秒）
 * - 支持标准 CSV 引号转义：字段被 "..." 包裹时可包含逗号与换行，字段内的 "" 表示一个字面引号
 * - 单次最多 100 行数据
 *
 * 校验规则：
 * - 文件内 ref 必填且唯一，且不得与数据库中现有非空 ref 重复
 * - 前置引用（prerequisites 列按 ref 引用）可指向文件中后续行或现有唯一 ref；
 *   未找到或对应多个现有提示点（歧义）均为错误
 * - 文件行之间的前置引用不得构成依赖环（含自环）
 */

const { parseTime } = require('./timeutil');
const { schedule } = require('./scheduler');

const HEADER = ['ref', 'title', 'duration', 'minStart', 'maxFinish', 'actors', 'prerequisites'];
const MAX_ROWS = 100;
const MAX_REF_LEN = 20;
const MAX_TITLE_LEN = 100;
const MAX_ACTORS = 20;
const MAX_ACTOR_LEN = 30;

/**
 * 解析 CSV 文本为行数组。
 * 返回 { rows: [{ cells: [..], line }], errors: [..] }，line 为 1 起始的物理行号。
 */
function parseCsv(text) {
  const errors = [];
  const rows = [];
  const s = String(text ?? '').replace(/^\uFEFF/, ''); // 去掉 BOM

  let field = '';
  let cells = [];
  let inQuotes = false;
  let quoted = false; // 当前字段以引号开始
  let afterQuote = false; // 闭合引号之后、等待分隔符
  let line = 1;
  let rowLine = 1;
  let quoteErrReported = false; // 每行最多报一次引号位置错误

  const pushRow = () => {
    cells.push(field);
    // 跳过完全空白的行（整行只有一个空字段）
    if (!(cells.length === 1 && cells[0].trim() === '')) {
      rows.push({ cells, line: rowLine });
    }
    cells = [];
    field = '';
    quoted = false;
    afterQuote = false;
    quoteErrReported = false;
  };

  let i = 0;
  while (i < s.length) {
    const ch = s[i];

    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          afterQuote = true;
          i += 1;
        }
      } else {
        if (ch === '\n') line += 1;
        field += ch;
        i += 1;
      }
      continue;
    }

    if (afterQuote) {
      // 闭合引号之后只允许分隔符 / 换行 / 空白
      if (ch === ',') {
        cells.push(field);
        field = '';
        quoted = false;
        afterQuote = false;
        i += 1;
      } else if (ch === '\r' || ch === '\n') {
        pushRow();
        if (ch === '\r' && s[i + 1] === '\n') i += 2;
        else i += 1;
        line += 1;
        rowLine = line;
      } else if (ch === ' ' || ch === '\t') {
        i += 1; // 容忍闭合引号后的空白
      } else {
        if (!quoteErrReported) {
          errors.push(`第 ${line} 行：闭合引号后存在多余字符`);
          quoteErrReported = true;
        }
        field += ch;
        i += 1;
      }
      continue;
    }

    if (ch === '"' && field === '') {
      inQuotes = true;
      quoted = true;
      i += 1;
    } else if (ch === ',') {
      cells.push(field);
      field = '';
      quoted = false;
      i += 1;
    } else if (ch === '\r' || ch === '\n') {
      pushRow();
      if (ch === '\r' && s[i + 1] === '\n') i += 2;
      else i += 1;
      line += 1;
      rowLine = line;
    } else {
      if (ch === '"' && !quoteErrReported) {
        errors.push(`第 ${line} 行：字段中的引号需写成两个（""）或用引号包裹整个字段`);
        quoteErrReported = true;
      }
      field += ch;
      i += 1;
    }
  }

  if (inQuotes) {
    errors.push(`第 ${rowLine} 行：引号未闭合`);
  }
  // 文件末尾没有换行符时收尾最后一行
  if (field !== '' || cells.length > 0 || quoted) {
    pushRow();
  }

  return { rows, errors };
}

/** 多值列：| 分隔，去空白、去重（保持先后顺序） */
function splitMulti(text) {
  if (!text) return [];
  return Array.from(
    new Set(
      String(text)
        .split('|')
        .map((v) => v.trim())
        .filter(Boolean)
    )
  );
}

/** 校验单个数据行的字段（不含跨行 / 跨库校验） */
function validateRow({ cells, line }) {
  const errors = [];
  if (cells.length !== HEADER.length) {
    errors.push(`列数应为 ${HEADER.length}，实际为 ${cells.length}`);
  }
  const get = (i) => (cells[i] != null ? String(cells[i]).trim() : '');
  const [ref, title, durationText, minStartText, maxFinishText, actorsText, presText] =
    HEADER.map((_, i) => get(i));

  if (!ref) errors.push('ref 必填');
  else if (ref.length > MAX_REF_LEN) errors.push(`ref 过长（最多 ${MAX_REF_LEN} 字）`);

  if (!title) errors.push('title 必填');
  else if (title.length > MAX_TITLE_LEN) errors.push(`title 过长（最多 ${MAX_TITLE_LEN} 字）`);

  let duration = null;
  if (!durationText) {
    errors.push('duration 必填');
  } else {
    try {
      duration = parseTime(durationText, { asMinutes: true });
      if (duration == null || duration <= 0) errors.push('duration 必须大于 0');
    } catch (e) {
      errors.push(`duration：${e.message}`);
    }
  }

  let minStart = 0;
  if (minStartText) {
    try {
      minStart = parseTime(minStartText);
      if (minStart == null || minStart < 0) errors.push('minStart 不能为负');
    } catch (e) {
      errors.push(`minStart：${e.message}`);
    }
  }

  let maxFinish = null;
  if (maxFinishText) {
    try {
      maxFinish = parseTime(maxFinishText);
      if (maxFinish != null && minStart != null && maxFinish < minStart) {
        errors.push('maxFinish 不能早于 minStart');
      }
    } catch (e) {
      errors.push(`maxFinish：${e.message}`);
    }
  }

  const actors = splitMulti(actorsText);
  if (actors.length > MAX_ACTORS) errors.push(`演员最多 ${MAX_ACTORS} 名`);
  if (actors.some((a) => a.length > MAX_ACTOR_LEN)) {
    errors.push(`演员名字过长（最多 ${MAX_ACTOR_LEN} 字）`);
  }

  const prerequisites = splitMulti(presText);

  return {
    line,
    ref,
    title,
    durationText,
    minStartText,
    maxFinishText,
    actors,
    prerequisites,
    errors,
    parsed: { duration, minStart, maxFinish },
  };
}

/**
 * 校验整个 CSV 文本，返回预览结构。
 * existingRefs: Map<string, number[]> —— 数据库中现有非空 ref -> 对应提示点 id 列表
 *
 * 返回 { valid, fileErrors, rowCount, rows, prepared }：
 * - rows 用于预览展示（含每行 errors）
 * - prepared 为通过校验后的入库数据（prerequisites 仍是 ref 列表，写库时解析为 id）
 */
function validateImport(text, existingRefs) {
  const { rows: parsed, errors: parseErrors } = parseCsv(text);
  const fileErrors = [...parseErrors];

  if (parsed.length === 0) {
    fileErrors.push('CSV 内容为空：至少需要一行表头');
    return { valid: false, fileErrors, rowCount: 0, rows: [], prepared: [] };
  }

  const headerCells = parsed[0].cells.map((c) => c.trim());
  const headerOk =
    headerCells.length === HEADER.length &&
    HEADER.every((h, i) => headerCells[i].toLowerCase() === h.toLowerCase());
  if (!headerOk) {
    fileErrors.push(`表头不正确（第 1 行）：应为 ${HEADER.join(',')}`);
    return { valid: false, fileErrors, rowCount: 0, rows: [], prepared: [] };
  }

  const dataRows = parsed.slice(1);
  if (dataRows.length === 0) {
    fileErrors.push('没有可导入的数据行');
  }
  if (dataRows.length > MAX_ROWS) {
    fileErrors.push(`单次最多导入 ${MAX_ROWS} 行，当前共 ${dataRows.length} 行`);
  }

  const rows = dataRows.map((r) => validateRow(r));

  /* ---- 文件内 ref 唯一 + 不与现有非空 ref 重复 ---- */
  const refCount = new Map();
  for (const r of rows) {
    if (r.ref) refCount.set(r.ref, (refCount.get(r.ref) || 0) + 1);
  }
  for (const r of rows) {
    if (!r.ref) continue;
    if (refCount.get(r.ref) > 1) {
      r.errors.push(`ref「${r.ref}」在文件内重复出现`);
    }
    if (existingRefs.has(r.ref)) {
      r.errors.push(`ref「${r.ref}」与现有提示点的 ref 重复`);
    }
  }

  /* ---- 前置引用解析：文件内 ref（含后续行）或现有唯一 ref ---- */
  const fileRefSet = new Set(rows.map((r) => r.ref).filter(Boolean));
  for (const r of rows) {
    for (const p of r.prerequisites) {
      if (fileRefSet.has(p)) continue;
      const ids = existingRefs.get(p);
      if (!ids) {
        r.errors.push(`前置引用「${p}」未找到：既不是文件内的 ref，也不是现有提示点的 ref`);
      } else if (ids.length > 1) {
        r.errors.push(`前置引用「${p}」对应 ${ids.length} 个现有提示点，存在歧义`);
      }
    }
  }

  /* ---- 文件内依赖环：只有文件行之间的引用可能成环（现有提示点不依赖新行） ---- */
  const indexByRef = new Map();
  rows.forEach((r, i) => {
    if (r.ref && !indexByRef.has(r.ref)) indexByRef.set(r.ref, i);
  });
  const pseudoCues = rows.map((r, i) => ({
    id: i + 1,
    ref: r.ref,
    title: r.title,
    duration: 60,
    minStart: 0,
    maxFinish: null,
    actors: [],
    prerequisites: r.prerequisites
      .filter((p) => fileRefSet.has(p))
      .map((p) => indexByRef.get(p) + 1),
  }));
  const { cycle } = schedule(pseudoCues);
  if (cycle) {
    const labelOf = (id) => {
      const r = rows[id - 1];
      return r.ref || `第${r.line}行`;
    };
    const paths = cycle.paths || (cycle.path ? [cycle.path] : []);
    for (const id of cycle.nodes) {
      const path = paths.find((p) => p.includes(id)) || [];
      const text = path.length ? path.map(labelOf).join(' → ') : labelOf(id);
      rows[id - 1].errors.push(`文件内依赖环：${text}`);
    }
  }

  const valid = fileErrors.length === 0 && rows.every((r) => r.errors.length === 0);

  const prepared = rows.map((r) => ({
    ref: r.ref,
    title: r.title,
    duration: r.parsed.duration,
    minStart: r.parsed.minStart,
    maxFinish: r.parsed.maxFinish,
    actors: r.actors,
    prerequisites: r.prerequisites,
  }));

  return {
    valid,
    fileErrors,
    rowCount: rows.length,
    rows: rows.map(publicRow),
    prepared,
  };
}

/** 预览用的行结构（原始文本 + 错误列表，不含解析后的秒值） */
function publicRow(r) {
  return {
    line: r.line,
    ref: r.ref,
    title: r.title,
    duration: r.durationText,
    minStart: r.minStartText,
    maxFinish: r.maxFinishText,
    actors: r.actors,
    prerequisites: r.prerequisites,
    errors: r.errors,
  };
}

/** 发送给客户端的预览结构（去掉入库用的 prepared） */
function toPreview(result) {
  return {
    valid: result.valid,
    fileErrors: result.fileErrors,
    rowCount: result.rowCount,
    rows: result.rows,
  };
}

module.exports = { parseCsv, validateImport, toPreview, HEADER, MAX_ROWS };
