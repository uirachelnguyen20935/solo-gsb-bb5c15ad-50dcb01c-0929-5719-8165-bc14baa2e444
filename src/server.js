'use strict';

const path = require('path');
const express = require('express');
const db = require('./db');
const csvimport = require('./csvimport');
const { parseTime } = require('./timeutil');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');

db.connect(DB_PATH);

const app = express();
// CSV 导入文本随 JSON 提交，放宽请求体上限（100 行 CSV 远低于此值）
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/print', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'print.html'));
});

/* ---------- 接口 ---------- */

app.get('/api/cues', (_req, res) => {
  res.json(db.listCues());
});

app.get('/api/schedule', (_req, res) => {
  res.json(db.computeSchedule());
});

app.get('/api/conflicts', (_req, res) => {
  res.json(db.computeSchedule().conflicts);
});

/**
 * 演员错峰建议：只读接口。基于正式数据在内存中叠加同一演员相邻提示点的
 * 先后约束后重新排程，返回候选走台时间；不写入数据库。
 */
app.get('/api/schedule/stagger-suggestion', (_req, res) => {
  res.json(db.computeStaggerSuggestion());
});

/**
 * 延误推演：纯内存计算，不写入数据库。
 * body: { cueId: number, delay: "10" / "1:30" / 整数秒 ... }（与时长输入一致：纯数字按分钟）
 */
app.post('/api/schedule/simulate-delay', (req, res, next) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object') badRequest('请求体必须是 JSON 对象');

    const cueId = Number(body.cueId);
    if (!Number.isInteger(cueId) || cueId <= 0) badRequest('请选择一个已排程提示点作为延误起点');

    const delay = parseTime(body.delay, { asMinutes: true });
    if (delay == null || !Number.isFinite(delay) || delay < 0) {
      badRequest('请填写非负延误量（格式如 5、5:30、1:02:30，纯数字按分钟）');
    }

    res.json(db.computeDelaySimulation(cueId, delay));
  } catch (err) {
    next(err);
  }
});

app.get('/api/cues/:id', (req, res) => {
  const cue = db.getCue(Number(req.params.id));
  if (!cue) return res.status(404).json({ error: '提示点不存在' });
  res.json(cue);
});

/**
 * CSV 批量导入 · 预览：解析并校验 CSV 文本，逐行返回错误，不写入数据库。
 * body: { csv: "ref,title,...\n..." }
 */
app.post('/api/cues/import/preview', (req, res, next) => {
  try {
    const csv = readCsvBody(req.body);
    const result = csvimport.validateImport(csv, db.getExistingRefs());
    res.json(csvimport.toPreview(result));
  } catch (err) {
    next(err);
  }
});

/**
 * CSV 批量导入 · 确认：基于当前数据库重新校验，全部通过后在单个事务内
 * 写入全部提示点、演员与依赖；任何错误都不留下部分数据。
 * body: { csv: "ref,title,...\n..." }
 */
app.post('/api/cues/import', (req, res, next) => {
  try {
    const csv = readCsvBody(req.body);
    // 确认时基于当前数据库重新校验（预览之后数据可能已变化）
    const result = csvimport.validateImport(csv, db.getExistingRefs());
    if (!result.valid) {
      return res.status(400).json({
        error: 'CSV 未通过校验，未导入任何数据',
        preview: csvimport.toPreview(result),
      });
    }
    const cues = db.importCues(result.prepared);
    res.status(201).json({ imported: cues.length, cues });
  } catch (err) {
    next(err);
  }
});

function readCsvBody(body) {
  if (!body || typeof body !== 'object') badRequest('请求体必须是 JSON 对象');
  if (typeof body.csv !== 'string' || body.csv.trim() === '') {
    badRequest('请提供 csv 文本字段');
  }
  return body.csv;
}

app.post('/api/cues', (req, res, next) => {
  try {
    const data = validateCueBody(req.body, { db, id: null });
    const cue = db.createCue(data);
    res.status(201).json(cue);
  } catch (err) {
    next(err);
  }
});

app.put('/api/cues/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!db.getCue(id)) {
      return res.status(404).json({ error: '提示点不存在' });
    }
    const data = validateCueBody(req.body, { db, id });
    res.json(db.updateCue(id, data));
  } catch (err) {
    next(err);
  }
});

app.delete('/api/cues/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!db.getCue(id)) return res.status(404).json({ error: '提示点不存在' });
  db.deleteCue(id);
  res.status(204).end();
});

/* ---------- 校验 ---------- */

function validateCueBody(body, { db: database, id }) {
  if (!body || typeof body !== 'object') {
    const err = new Error('请求体必须是 JSON 对象');
    err.statusCode = 400;
    throw err;
  }

  const title = String(body.title ?? '').trim();
  if (!title) badRequest('请填写提示点名称');

  const ref = body.ref != null ? String(body.ref).trim() : '';

  const duration = parseTime(body.duration, { asMinutes: true });
  if (duration == null || duration <= 0) badRequest('请填写正确的时长（大于 0，格式如 5、5:30、1:02:30）');

  const minStart = body.minStart != null && String(body.minStart).trim() !== ''
    ? parseTime(body.minStart)
    : 0;
  if (minStart < 0) badRequest('最早开始时间不能为负');

  let maxFinish = null;
  if (body.maxFinish != null && String(body.maxFinish).trim() !== '') {
    maxFinish = parseTime(body.maxFinish);
    if (maxFinish < minStart) badRequest('最晚完成时间不能早于最早开始时间');
  }

  let actors = [];
  if (body.actors != null) {
    if (!Array.isArray(body.actors)) badRequest('演员必须是名字数组');
    actors = Array.from(
      new Set(body.actors.map((a) => String(a).trim()).filter(Boolean))
    );
    if (actors.length > 20) badRequest('单个提示点最多填写 20 名演员');
    if (actors.some((a) => a.length > 30)) badRequest('演员名字过长（最多 30 字）');
  }

  let prerequisites = [];
  if (body.prerequisites != null) {
    if (!Array.isArray(body.prerequisites)) badRequest('前置提示点必须是编号数组');
    prerequisites = body.prerequisites.map((p) => Number(p));
    if (prerequisites.some((p) => !Number.isInteger(p) || p <= 0)) {
      badRequest('前置提示点编号不合法');
    }
    prerequisites = Array.from(new Set(prerequisites));
    for (const preId of prerequisites) {
      if (id != null && preId === id) continue; // 自环允许保存，由排程器指出
      if (!database.getCue(preId)) badRequest(`前置提示点 #${preId} 不存在`);
    }
  }

  return { ref, title, duration, minStart, maxFinish, actors, prerequisites };
}

function badRequest(msg) {
  const err = new Error(msg);
  err.statusCode = 400;
  throw err;
}

/* ---------- 错误处理 ---------- */

app.use((err, _req, res, _next) => {
  const status = err.statusCode || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: err.message || '服务器内部错误' });
});

app.listen(PORT, HOST, () => {
  console.log(`走台排程应用已启动: http://localhost:${PORT}`);
});
