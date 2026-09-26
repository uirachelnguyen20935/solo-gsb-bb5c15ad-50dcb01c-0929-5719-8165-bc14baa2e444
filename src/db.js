'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { schedule, simulateDelay, suggestActorStagger } = require('./scheduler');

let db;
let createCueTx;
let updateCueTx;
let importCuesTx;

function connect(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  init();
  if (process.env.SEED_SAMPLE !== 'false' && countCues() === 0) {
    seed();
  }
  createCueTx = db.transaction(createCueImpl);
  updateCueTx = db.transaction(updateCueImpl);
  importCuesTx = db.transaction(importCuesImpl);
  return db;
}

function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cues (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ref        TEXT,
      title      TEXT NOT NULL,
      duration   INTEGER NOT NULL,           -- 时长（秒）
      min_start  INTEGER NOT NULL DEFAULT 0, -- 最早开始（秒，相对开排零点）
      max_finish INTEGER,                    -- 最晚完成（秒），可空
      position   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS dependencies (
      cue_id          INTEGER NOT NULL,
      prerequisite_id INTEGER NOT NULL,
      PRIMARY KEY (cue_id, prerequisite_id),
      FOREIGN KEY (cue_id) REFERENCES cues(id) ON DELETE CASCADE,
      FOREIGN KEY (prerequisite_id) REFERENCES cues(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS cue_actors (
      cue_id INTEGER NOT NULL,
      actor  TEXT NOT NULL,
      PRIMARY KEY (cue_id, actor),
      FOREIGN KEY (cue_id) REFERENCES cues(id) ON DELETE CASCADE
    );
  `);
}

function countCues() {
  return db.prepare('SELECT COUNT(*) AS n FROM cues').get().n;
}

/** 读取全部提示点（含前置 id 列表与演员名单），用于排程计算与接口返回 */
function listCues() {
  const rows = db
    .prepare(
      `SELECT c.id, c.ref, c.title, c.duration, c.min_start AS minStart,
              c.max_finish AS maxFinish, c.position,
              COALESCE(GROUP_CONCAT(d.prerequisite_id), '') AS preIds
         FROM cues c
         LEFT JOIN dependencies d ON d.cue_id = c.id
        GROUP BY c.id
        ORDER BY c.position, c.id`
    )
    .all();

  const actorsByCue = new Map();
  for (const r of db.prepare('SELECT cue_id AS cueId, actor FROM cue_actors ORDER BY cue_id, rowid').all()) {
    const list = actorsByCue.get(r.cueId);
    if (list) list.push(r.actor);
    else actorsByCue.set(r.cueId, [r.actor]);
  }

  return rows.map((r) => ({
    ...r,
    actors: actorsByCue.get(r.id) || [],
    prerequisites: r.preIds ? r.preIds.split(',').map(Number) : [],
  }));
}

function getCue(id) {
  const row = db
    .prepare(
      `SELECT id, ref, title, duration, min_start AS minStart, max_finish AS maxFinish
         FROM cues WHERE id = ?`
    )
    .get(id);
  if (!row) return null;
  row.actors = db
    .prepare('SELECT actor FROM cue_actors WHERE cue_id = ? ORDER BY rowid')
    .all(id)
    .map((r) => r.actor);
  row.prerequisites = db
    .prepare('SELECT prerequisite_id AS pid FROM dependencies WHERE cue_id = ?')
    .all(id)
    .map((r) => r.pid);
  return row;
}

/** 从数据库重建模型并执行排程 */
function computeSchedule() {
  const cues = loadCueModels();
  return schedule(cues);
}

/**
 * 延误推演：从数据库读取正式数据，仅在内存中调整起点的最早开始约束后重新排程，
 * 不写入任何数据。
 */
function computeDelaySimulation(cueId, delaySeconds) {
  return simulateDelay(loadCueModels(), cueId, delaySeconds);
}

/**
 * 演员错峰建议：从数据库读取正式数据，仅在内存中附加“同一演员相邻提示点
 * 先后开始”的前置约束后重新排程，不写入任何数据；刷新页面仍是正式排程。
 */
function computeActorStagger() {
  return suggestActorStagger(loadCueModels());
}

/** 从数据库重建排程器所需的提示点模型 */
function loadCueModels() {
  return listCues().map((c) => ({
    id: c.id,
    ref: c.ref,
    title: c.title,
    duration: c.duration,
    minStart: c.minStart,
    maxFinish: c.maxFinish,
    actors: c.actors,
    prerequisites: c.prerequisites,
  }));
}

function createCue(data) {
  return createCueTx(data);
}

function createCueImpl(data) {
  const maxPos = db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM cues').get().p;
  const info = db
    .prepare(
      `INSERT INTO cues (ref, title, duration, min_start, max_finish, position)
       VALUES (@ref, @title, @duration, @minStart, @maxFinish, @position)`
    )
    .run({
      ref: data.ref || null,
      title: data.title,
      duration: data.duration,
      minStart: data.minStart,
      maxFinish: data.maxFinish ?? null,
      position: maxPos + 1,
    });

  replaceDependencies(info.lastInsertRowid, data.prerequisites || []);
  replaceActors(info.lastInsertRowid, data.actors || []);
  return getCue(info.lastInsertRowid);
}

function updateCue(id, data) {
  return updateCueTx(id, data);
}

function updateCueImpl(id, data) {
  db.prepare(
    `UPDATE cues
        SET ref = @ref, title = @title, duration = @duration,
            min_start = @minStart, max_finish = @maxFinish,
            updated_at = datetime('now')
      WHERE id = @id`
  ).run({
    id,
    ref: data.ref || null,
    title: data.title,
    duration: data.duration,
    minStart: data.minStart,
    maxFinish: data.maxFinish ?? null,
  });
  replaceDependencies(id, data.prerequisites || []);
  replaceActors(id, data.actors || []);
  return getCue(id);
}

function replaceDependencies(cueId, prerequisiteIds) {
  db.prepare('DELETE FROM dependencies WHERE cue_id = ?').run(cueId);
  const insert = db.prepare(
    'INSERT INTO dependencies (cue_id, prerequisite_id) VALUES (?, ?)'
  );
  for (const preId of Array.from(new Set(prerequisiteIds))) {
    if (preId === cueId) {
      // 自环也写入，排程器会把它作为环依赖指出
      insert.run(cueId, preId);
    } else {
      const exists = db.prepare('SELECT 1 FROM cues WHERE id = ?').get(preId);
      if (exists) insert.run(cueId, preId);
    }
  }
}

function replaceActors(cueId, actors) {
  db.prepare('DELETE FROM cue_actors WHERE cue_id = ?').run(cueId);
  const insert = db.prepare('INSERT INTO cue_actors (cue_id, actor) VALUES (?, ?)');
  for (const name of Array.from(new Set(actors))) {
    if (name) insert.run(cueId, name);
  }
}

function deleteCue(id) {
  return db.prepare('DELETE FROM cues WHERE id = ?').run(id);
}

/** 现有非空 ref -> [id, ...]，用于 CSV 导入的唯一性 / 歧义校验与前置引用解析 */
function getExistingRefs() {
  const map = new Map();
  for (const r of db
    .prepare(`SELECT id, ref FROM cues WHERE ref IS NOT NULL AND ref != ''`)
    .all()) {
    const list = map.get(r.ref);
    if (list) list.push(r.id);
    else map.set(r.ref, [r.id]);
  }
  return map;
}

/**
 * CSV 批量导入：在单个事务内写入全部提示点、演员与依赖，任一步失败整体回滚。
 * rows 为已通过校验的数据（prerequisites 为 ref 列表，此处解析为 id：
 * 文件内 ref 指向本次新插入的提示点，其余指向现有唯一 ref 的提示点）。
 */
function importCues(rows) {
  return importCuesTx(rows);
}

function importCuesImpl(rows) {
  const existing = getExistingRefs();
  const maxPos = db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM cues').get().p;
  const insertCue = db.prepare(
    `INSERT INTO cues (ref, title, duration, min_start, max_finish, position)
     VALUES (@ref, @title, @duration, @minStart, @maxFinish, @position)`
  );
  const insertDep = db.prepare(
    'INSERT INTO dependencies (cue_id, prerequisite_id) VALUES (?, ?)'
  );
  const insertActor = db.prepare('INSERT INTO cue_actors (cue_id, actor) VALUES (?, ?)');

  const idByRef = new Map();
  rows.forEach((row, i) => {
    const info = insertCue.run({
      ref: row.ref,
      title: row.title,
      duration: row.duration,
      minStart: row.minStart,
      maxFinish: row.maxFinish ?? null,
      position: maxPos + i + 1,
    });
    idByRef.set(row.ref, info.lastInsertRowid);
  });

  rows.forEach((row) => {
    const cueId = idByRef.get(row.ref);
    for (const preRef of row.prerequisites) {
      const preId = idByRef.has(preRef)
        ? idByRef.get(preRef)
        : (existing.get(preRef) || [])[0];
      if (preId) insertDep.run(cueId, preId);
    }
    for (const actor of row.actors) {
      insertActor.run(cueId, actor);
    }
  });

  return rows.map((row) => getCue(idByRef.get(row.ref)));
}

/**
 * 首次启动写入的示例走台数据：
 * - “换景演练”演示超时标记
 * - “台词专项排练”与“第一场演员走位”共用演员周航且时间重叠，演示演员冲突检查
 */
function seed() {
  const rows = [
    { ref: 'Q1', title: '开场灯光检查', min: 0, dur: 600, max: null, pres: [], actors: [] },
    { ref: 'Q2', title: '第一场演员走位', min: 900, dur: 1200, max: null, pres: ['Q1'], actors: ['林晓', '周航'] },
    { ref: 'Q3', title: '换景演练', min: 0, dur: 600, max: 2400, pres: ['Q2'], actors: [] },
    { ref: 'Q4', title: '暗场转场', min: 0, dur: 300, max: null, pres: ['Q3'], actors: ['苏晴'] },
    { ref: 'Q5', title: '谢幕定位', min: 3300, dur: 480, max: null, pres: ['Q4'], actors: ['林晓', '周航', '苏晴', '陈默'] },
    { ref: 'Q6', title: '台词专项排练', min: 1500, dur: 900, max: null, pres: ['Q1'], actors: ['周航', '陈默'] },
  ];
  const insert = db.prepare(
    `INSERT INTO cues (ref, title, duration, min_start, max_finish, position)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const idByRef = new Map();
  rows.forEach((r, i) => {
    const info = insert.run(r.ref, r.title, r.dur, r.min, r.max, i + 1);
    idByRef.set(r.ref, info.lastInsertRowid);
  });
  const link = db.prepare(
    'INSERT INTO dependencies (cue_id, prerequisite_id) VALUES (?, ?)'
  );
  for (const r of rows) {
    for (const pre of r.pres) link.run(idByRef.get(r.ref), idByRef.get(pre));
  }
  const cast = db.prepare('INSERT INTO cue_actors (cue_id, actor) VALUES (?, ?)');
  for (const r of rows) {
    for (const name of r.actors) cast.run(idByRef.get(r.ref), name);
  }
}

module.exports = {
  connect,
  listCues,
  getCue,
  computeSchedule,
  computeDelaySimulation,
  computeActorStagger,
  createCue,
  updateCue,
  deleteCue,
  getExistingRefs,
  importCues,
};
