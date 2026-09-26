'use strict';

let state = {
  cues: [], // 原始提示点（供前置选择）
  scheduled: [], // 正式排程结果
  cycle: null,
  conflicts: [], // 正式排程的演员时间冲突
  editingId: null,
  sim: null, // 延误推演结果（null 表示未推演 / 已清除）
};

const els = {
  tbody: document.getElementById('cue-tbody'),
  banner: document.getElementById('cycle-banner'),
  conflictBanner: document.getElementById('conflict-banner'),
  simBanner: document.getElementById('sim-banner'),
  okBanner: document.getElementById('ok-banner'),
  stats: document.getElementById('stats'),
  mask: document.getElementById('modal-mask'),
  form: document.getElementById('cue-form'),
  modalTitle: document.getElementById('modal-title'),
  preList: document.getElementById('pre-list'),
  formError: document.getElementById('form-error'),
  simForm: document.getElementById('sim-form'),
  simCue: document.getElementById('sim-cue'),
  simDelay: document.getElementById('sim-delay'),
  simError: document.getElementById('sim-error'),
  simResult: document.getElementById('sim-result'),
  scheduleTitle: document.getElementById('schedule-title'),
  scheduleHint: document.getElementById('schedule-hint'),
  importMask: document.getElementById('import-mask'),
  importFile: document.getElementById('import-file'),
  importPreviewBtn: document.getElementById('btn-import-preview'),
  importCommitBtn: document.getElementById('btn-import-commit'),
  importError: document.getElementById('import-error'),
  importPreview: document.getElementById('import-preview'),
};

document.getElementById('btn-new').addEventListener('click', () => openModal());
document.getElementById('btn-cancel').addEventListener('click', closeModal);
els.mask.addEventListener('click', (e) => {
  if (e.target === els.mask) closeModal();
});
els.form.addEventListener('submit', onSubmit);
els.simForm.addEventListener('submit', onSimulate);
document.getElementById('btn-sim-clear').addEventListener('click', clearSimulation);
document.getElementById('btn-import').addEventListener('click', openImportModal);
document.getElementById('btn-import-cancel').addEventListener('click', closeImportModal);
els.importMask.addEventListener('click', (e) => {
  if (e.target === els.importMask) closeImportModal();
});
els.importFile.addEventListener('change', () => {
  importState = { csv: null, preview: null };
  els.importPreview.innerHTML = '';
  els.importError.classList.add('hidden');
  els.importPreviewBtn.disabled = !els.importFile.files.length;
  els.importCommitBtn.disabled = true;
});
els.importPreviewBtn.addEventListener('click', onImportPreview);
els.importCommitBtn.addEventListener('click', onImportCommit);

/** 推演时表格/统计使用模拟排程，清除后恢复正式排程 */
function viewScheduled() {
  return state.sim ? state.sim.simulated.cues : state.scheduled;
}
function viewConflicts() {
  return state.sim ? state.sim.simulated.conflicts : state.conflicts;
}

async function refresh() {
  const [cues, scheduleResult] = await Promise.all([
    CS.api('/api/cues'),
    CS.api('/api/schedule'),
  ]);
  state.cues = cues;
  state.scheduled = scheduleResult.cues;
  state.cycle = scheduleResult.cycle;
  state.conflicts = scheduleResult.conflicts || [];
  // 正式数据已变化（增删改后），内存中的推演结果失效，恢复正式排程视图
  if (state.sim) resetSimulation({ keepInput: true });
  // 数据刷新后，上一次导入的成功提示不再适用
  els.okBanner.classList.add('hidden');
  render();
}

function render() {
  renderBanner();
  renderConflictBanner();
  renderSimBanner();
  renderStats();
  renderSimSelect();
  renderSimResult();
  renderTable();
}

function renderBanner() {
  // 环依赖属于正式排程问题，推演期间也持续可见
  if (!state.cycle) {
    els.banner.classList.add('hidden');
    els.banner.innerHTML = '';
    return;
  }
  const byId = new Map(state.scheduled.map((c) => [c.id, c]));
  const chains = (state.cycle.paths || (state.cycle.path ? [state.cycle.path] : []))
    .map(
      (p) =>
        `<span class="cycle-chain">${p
          .map((id) => CS.esc(CS.labelOf(byId, id)))
          .join(' → ')}</span>`
    )
    .join(' ');
  const names = state.cycle.nodes
    .map((id) => {
      const c = byId.get(id);
      return c ? `${c.ref ? c.ref + ' ' : ''}「${CS.esc(c.title)}」` : `#${id}`;
    })
    .join('、');
  els.banner.innerHTML =
    `⚠ <strong>发现环依赖，涉及 ${state.cycle.nodes.length} 个提示点：</strong>${names}<br>` +
    (chains ? `环路：${chains}<br>` : '') +
    `<span>环上及其下游提示点暂无法排程，请在编辑中移除构成环的某项前置关系。</span>`;
  els.banner.classList.remove('hidden');
}

function renderConflictBanner() {
  // 始终展示正式排程中已有的演员冲突（推演期间这些是“已有问题”，不计为新增）
  if (!state.conflicts.length) {
    els.conflictBanner.classList.add('hidden');
    els.conflictBanner.innerHTML = '';
    return;
  }
  const cueLabel = (c) => `${c.ref ? CS.esc(c.ref) + ' ' : ''}「${CS.esc(c.title)}」`;
  const items = state.conflicts
    .map(
      (cf) =>
        `<span class="conflict-item"><strong>${CS.esc(cf.actor)}</strong>：` +
        `${cueLabel(cf.cueA)} 与 ${cueLabel(cf.cueB)} 重叠 ` +
        `<code>${CS.fmtTime(cf.overlapStart)} – ${CS.fmtTime(cf.overlapEnd)}</code></span>`
    )
    .join(' ');
  els.conflictBanner.innerHTML =
    `⚠ <strong>正式排程存在 ${state.conflicts.length} 处演员时间冲突（推演中仍计为已有问题）：</strong><br>` +
    `${items}<br>` +
    `<span>结束恰好等于另一项开始不算冲突；环依赖及其阻塞项不参与检查。修改演员、时长或前置关系后自动重新检查。</span>`;
  els.conflictBanner.classList.remove('hidden');
}

/* ---------- 延误推演 ---------- */

function cueFullLabel(c) {
  return `${c.ref ? c.ref + ' · ' : ''}${c.title}`;
}

function renderSimBanner() {
  if (!state.sim) {
    els.simBanner.classList.add('hidden');
    els.simBanner.innerHTML = '';
    els.scheduleTitle.textContent = '走台单（按最早开始时间排序）';
    els.scheduleHint.textContent = '修改任一项后自动重新排程';
    return;
  }
  const t = state.sim.target;
  const label = `${t.ref ? CS.esc(t.ref) + ' ' : ''}「${CS.esc(t.title)}」`;
  els.simBanner.innerHTML =
    `🧪 <strong>延误推演进行中：</strong>起点 ${label} 延后 <code>${CS.fmtDur(t.delay)}</code>` +
    `（正式开始 ${CS.fmtTime(t.baselineStart)} → 模拟开始 ${CS.fmtTime(t.simulatedStart)}）。` +
    `推演仅在内存中计算，<strong>未写入数据库</strong>；下方表格展示的是模拟排程，` +
    `变化见“延误推演”区块，点击“清除推演”恢复正式排程。`;
  els.simBanner.classList.remove('hidden');
  els.scheduleTitle.textContent = '走台单 · 模拟排程（推演中）';
  els.scheduleHint.textContent = '清除推演后恢复正式排程';
}

function renderSimSelect() {
  const selectable = state.scheduled.filter((c) => c.scheduled);
  const disabled = state.scheduled.filter((c) => !c.scheduled);
  const keepId = Number(els.simCue.value);
  const currentId = state.sim ? state.sim.target.id : keepId;

  const groups = [];
  groups.push(
    `<option value="">请选择已排程提示点…</option>` +
      selectable
        .map(
          (c) =>
            `<option value="${c.id}"${c.id === currentId ? ' selected' : ''}>${CS.esc(
              cueFullLabel(c)
            )}（开始 ${CS.fmtTime(c.earliestStart)}）</option>`
        )
        .join('')
  );
  if (disabled.length) {
    const inCycle = disabled.filter((c) => c.inCycle);
    const blocked = disabled.filter((c) => !c.inCycle);
    const opt = (c, reason) =>
      `<option value="${c.id}" disabled>${CS.esc(cueFullLabel(c))}（${reason}，不可选）</option>`;
    groups.push(
      `<optgroup label="不可作为起点">` +
        inCycle.map((c) => opt(c, '环依赖')).join('') +
        blocked.map((c) => opt(c, '环阻塞')).join('') +
        `</optgroup>`
    );
  }
  els.simCue.innerHTML = groups.join('');
}

async function onSimulate(e) {
  e.preventDefault();
  els.simError.classList.add('hidden');
  const cueId = Number(els.simCue.value);
  const delay = els.simDelay.value.trim();
  if (!cueId) return simError('请选择一个已排程提示点作为延误起点');
  if (!delay) return simError('请填写非负延误量（格式如 5、5:30、1:02:30，纯数字按分钟）');

  try {
    const result = await CS.api('/api/schedule/simulate-delay', {
      method: 'POST',
      body: JSON.stringify({ cueId, delay }),
    });
    state.sim = result;
    render();
  } catch (err) {
    simError(err.message);
  }
}

function simError(msg) {
  els.simError.textContent = msg;
  els.simError.classList.remove('hidden');
}

/** 清除推演：恢复正式排程（不重新拉取数据，直接丢弃内存中的模拟结果） */
function clearSimulation() {
  resetSimulation({ keepInput: false });
  render();
}

function resetSimulation({ keepInput }) {
  state.sim = null;
  els.simError.classList.add('hidden');
  els.simError.textContent = '';
  if (!keepInput) {
    els.simForm.reset();
  }
}

function renderSimResult() {
  const sim = state.sim;
  if (!sim) {
    els.simResult.innerHTML = '';
    return;
  }

  const t = sim.target;
  const label = (a) => `${a.ref ? CS.esc(a.ref) + ' ' : ''}「${CS.esc(a.title)}」`;
  const delta = (d) =>
    d === 0
      ? '<span class="sim-delta-zero">±0:00</span>'
      : `<span class="sim-delta-up">+${CS.fmtDur(d)}</span>`;

  const affectedRows = sim.affected.length
    ? sim.affected
        .map(
          (a) => `
        <tr class="sim-affected-row${a.newOverdue ? ' row-overdue' : ''}">
          <td>${label(a)}</td>
          <td class="num">${CS.fmtTime(a.baseStart)}</td>
          <td class="num">${CS.fmtTime(a.simulatedStart)}</td>
          <td class="num">${delta(a.deltaStart)}</td>
          <td class="num">${CS.fmtTime(a.baseFinish)}</td>
          <td class="num ${a.newOverdue ? 't-overdue' : ''}">${CS.fmtTime(
            a.simulatedFinish
          )}</td>
          <td class="num">${delta(a.deltaFinish)}</td>
          <td>${simRowBadges(a)}</td>
        </tr>`
        )
        .join('')
    : `<tr><td colspan="8" class="sim-empty">该延误量下没有提示点的排程发生变化。</td></tr>`;

  const newOverdueBlock = sim.newOverdue.length
    ? `<div class="sim-sub sim-sub-danger">
         <h4>新增超时（${sim.newOverdue.length}）</h4>
         <ul>${sim.newOverdue
           .map(
             (a) =>
               `<li>${label(a)}：模拟结束 ${CS.fmtTime(a.simulatedFinish)}，结束时间后移 ${CS.fmtDur(
                 a.deltaFinish
               )}，新超过最晚完成时间</li>`
           )
           .join('')}</ul>
       </div>`
    : `<div class="sim-sub sim-sub-ok"><h4>新增超时（0）</h4><span>没有新出现的超时。</span></div>`;

  const newConflictsBlock = sim.newConflicts.length
    ? `<div class="sim-sub sim-sub-warn">
         <h4>新增演员时间冲突（${sim.newConflicts.length}）</h4>
         <ul>${sim.newConflicts
           .map(
             (cf) =>
               `<li><strong>${CS.esc(cf.actor)}</strong>：${label(cf.cueA)} 与 ${label(
                 cf.cueB
               )} 在 <code>${CS.fmtTime(cf.overlapStart)} – ${CS.fmtTime(
                 cf.overlapEnd
               )}</code> 重叠</li>`
           )
           .join('')}</ul>
         <span class="hint">正式排程中已存在的冲突仍在上方琥珀色横幅与表格中可见，不计为新增。</span>
       </div>`
    : `<div class="sim-sub sim-sub-ok"><h4>新增演员时间冲突（0）</h4><span>没有新出现的演员时间冲突。</span></div>`;

  els.simResult.innerHTML = `
    <div class="sim-summary">
      <div class="stat"><div class="num">${CS.fmtDur(t.delay)}</div><div class="label">延误量</div></div>
      <div class="stat"><div class="num">${sim.affected.length}</div><div class="label">受影响提示点</div></div>
      <div class="stat ${sim.newOverdue.length ? 'danger' : ''}"><div class="num">${sim.newOverdue.length}</div><div class="label">新增超时</div></div>
      <div class="stat ${sim.newConflicts.length ? 'warn' : ''}"><div class="num">${sim.newConflicts.length}</div><div class="label">新增演员冲突</div></div>
    </div>
    <div class="table-wrap">
      <table class="cue-table sim-table">
        <thead>
          <tr>
            <th>提示点</th>
            <th class="num">原开始</th>
            <th class="num">模拟开始</th>
            <th class="num">开始变化</th>
            <th class="num">原结束</th>
            <th class="num">模拟结束</th>
            <th class="num">结束变化</th>
            <th>新增问题</th>
          </tr>
        </thead>
        <tbody>${affectedRows}</tbody>
      </table>
    </div>
    ${newOverdueBlock}
    ${newConflictsBlock}`;
}

function simRowBadges(a) {
  const badges = [];
  if (a.newOverdue) badges.push('<span class="badge badge-overdue">新增超时</span>');
  if (a.newConflictActors && a.newConflictActors.length) {
    badges.push(
      `<span class="badge badge-conflict" title="演员 ${CS.esc(
        a.newConflictActors.join('、')
      )} 新增时间重叠">新增演员冲突</span>`
    );
  }
  if (!badges.length) return '<span class="hint">—</span>';
  return badges.join(' ');
}

/* ---------- 统计与走台单 ---------- */

function renderStats() {
  const list = viewScheduled();
  const conflicts = viewConflicts();
  const total = list.length;
  const scheduled = list.filter((c) => c.scheduled);
  const overdue = list.filter((c) => c.overdue).length;
  const cyclic = list.filter((c) => c.inCycle).length;
  const blocked = list.filter((c) => c.blockedByCycle).length;
  const finish = scheduled.length ? Math.max(...scheduled.map((c) => c.earliestFinish)) : null;

  const stat = (cls, num, label) =>
    `<div class="stat ${cls}"><div class="num">${num}</div><div class="label">${label}</div></div>`;

  els.stats.innerHTML =
    stat('', total, '提示点总数') +
    stat('', scheduled.length, '可排程') +
    stat(cyclic ? 'danger' : '', cyclic, '环依赖') +
    stat(blocked ? 'warn' : '', blocked, '被环阻塞') +
    stat(conflicts.length ? 'warn' : '', conflicts.length, state.sim ? '模拟冲突' : '演员冲突') +
    stat(overdue ? 'danger' : '', overdue, state.sim ? '模拟超时' : '超过最晚完成') +
    stat('', finish == null ? '—' : CS.fmtTime(finish), '预计全部完成');
}

function renderTable() {
  const list = viewScheduled();
  const sim = state.sim;
  const affectedById = sim ? new Map(sim.affected.map((a) => [a.id, a])) : null;
  const byId = new Map(list.map((c) => [c.id, c]));

  els.tbody.innerHTML = list
    .map((c, i) => {
      const affected = affectedById ? affectedById.get(c.id) : null;
      const hasConflict = (c.conflictActors || []).length > 0;
      const rowCls = c.inCycle
        ? 'row-cycle'
        : c.blockedByCycle
          ? 'row-blocked'
          : c.overdue
            ? 'row-overdue'
            : hasConflict
              ? 'row-conflict'
              : '';

      const pres = c.prerequisites.length
        ? `<div class="pres">${c.prerequisites
            .map((pid) => {
              const exists = byId.has(pid);
              return `<span class="pre-tag ${exists ? '' : 'pre-missing'}" title="${
                exists ? '' : '前置提示点已删除'
              }">${CS.esc(CS.labelOf(byId, pid))}</span>`;
            })
            .join('')}</div>`
        : '<span class="hint">—</span>';

      const newConflictActors = affected ? affected.newConflictActors : [];
      const actors = (c.actors || []).length
        ? `<div class="actors">${c.actors
            .map((name) => {
              const hit = (c.conflictActors || []).includes(name);
              const isNew = newConflictActors.includes(name);
              return `<span class="actor-tag ${hit ? 'actor-conflict' : ''}" title="${
                isNew ? '推演中新出现的时间重叠' : hit ? '该演员与其他提示点时间重叠' : ''
              }">${CS.esc(name)}${isNew ? '🆕' : ''}</span>`;
            })
            .join('')}</div>`
        : '<span class="hint">—</span>';

      const slackCell = c.scheduled
        ? c.slack == null
          ? '—'
          : c.slack < 0
            ? `<span class="t-slack-neg">${CS.fmtDur(Math.abs(c.slack))} 超时</span>`
            : c.slack === 0
              ? `<span class="t-slack-zero">0:00</span>`
              : CS.fmtDur(c.slack)
        : '—';

      // 最迟允许开始 / 连锁余量：环上与被环阻塞项不可计算；无可达截止约束显示“不限”
      let latestStartCell;
      let chainSlackCell;
      if (!c.scheduled) {
        latestStartCell = '<span class="t-na" title="环上或被环阻塞，无法逆推最迟时间">不可计算</span>';
        chainSlackCell = '<span class="t-na">不可计算</span>';
      } else if (c.latestStart == null) {
        latestStartCell =
          '<span class="t-unbounded" title="自身及所有下游提示点均无最晚完成时间">不限</span>';
        chainSlackCell = '<span class="t-unbounded" title="没有任何可达的截止约束">不限</span>';
      } else {
        latestStartCell = `<span class="t-time ${
          c.latestStart < 0 ? 't-chain-neg' : ''
        }" title="由自身及所有下游最晚完成时间沿依赖图逆推得到">${CS.fmtTimeSigned(
          c.latestStart
        )}</span>`;
        const slackCls =
          c.chainSlack < 0 ? 't-chain-neg' : c.chainSlack === 0 ? 't-chain-zero' : '';
        const title =
          c.chainSlack < 0
            ? '连锁余量为负：按当前排程，自身或下游已有截止时间无法满足'
            : c.chainSlack === 0
              ? '连锁余量为零：再延后就会错过自身或下游的最晚完成时间'
              : '最迟允许开始 − 当前计算开始';
        chainSlackCell = `<span class="${slackCls}" title="${title}">${CS.fmtSigned(
          c.chainSlack
        )}</span>`;
      }

      const timeCell = (value, base) => {
        if (!c.scheduled) return '—';
        if (!affected) return CS.fmtTime(value);
        const d = value - base;
        const deltaHtml = d === 0 ? '' : ` <span class="cell-delta">+${CS.fmtDur(d)}</span>`;
        return `${CS.fmtTime(value)}${deltaHtml}`;
      };

      const baseStart = affected ? affected.baseStart : null;
      const baseFinish = affected ? affected.baseFinish : null;

      return `
      <tr class="${rowCls}${affected ? ' row-sim-affected' : ''}">
        <td>${i + 1}</td>
        <td>
          <span class="cue-ref">${CS.esc(c.ref || `#${c.id}`)}</span>
          <span class="cue-name">${CS.esc(c.title)}</span>
        </td>
        <td class="num">${CS.fmtDur(c.duration)}</td>
        <td class="num t-time">${CS.fmtTime(c.minStart)}</td>
        <td>${pres}</td>
        <td>${actors}</td>
        <td class="num t-time">${timeCell(c.earliestStart, baseStart)}</td>
        <td class="num t-time ${c.overdue ? 't-overdue' : ''}">${timeCell(
          c.earliestFinish,
          baseFinish
        )}</td>
        <td class="num t-time">${c.maxFinish == null ? '不限' : CS.fmtTime(c.maxFinish)}</td>
        <td class="num">${slackCell}</td>
        <td class="num">${latestStartCell}</td>
        <td class="num">${chainSlackCell}</td>
        <td>${statusBadge(c, affected)}</td>
        <td>
          <div class="row-ops">
            <button class="btn btn-sm" data-act="edit" data-id="${c.id}">编辑</button>
            <button class="btn btn-sm btn-danger-text" data-act="del" data-id="${c.id}">删除</button>
          </div>
        </td>
      </tr>`;
    })
    .join('');

  els.tbody.querySelectorAll('button[data-act]').forEach((btn) => {
    const id = Number(btn.dataset.id);
    if (btn.dataset.act === 'edit') btn.addEventListener('click', () => openModal(id));
    if (btn.dataset.act === 'del') btn.addEventListener('click', () => onDelete(id));
  });
}

function statusBadge(c, affected) {
  const badges = [];
  if (c.inCycle) badges.push('<span class="badge badge-cycle">⚠ 环依赖</span>');
  else if (c.blockedByCycle) badges.push('<span class="badge badge-blocked">环阻塞</span>');
  else if (c.overdue) {
    badges.push(
      affected && affected.newOverdue
        ? '<span class="badge badge-overdue">⚠ 新增超时（推演）</span>'
        : '<span class="badge badge-overdue">⚠ 超过最晚完成</span>'
    );
  }

  if ((c.conflictActors || []).length) {
    const hasNew = affected && affected.newConflictActors && affected.newConflictActors.length;
    badges.push(
      `<span class="badge badge-conflict" title="演员 ${CS.esc(
        c.conflictActors.join('、')
      )} 与其他提示点时间重叠">${hasNew ? '⚠ 新增演员冲突（推演）' : '⚠ 演员冲突'}</span>`
    );
  } else if (affected && affected.newConflictActors && affected.newConflictActors.length) {
    // 新增冲突的演员一定出现在 conflictActors 中，此分支兜底
    badges.push('<span class="badge badge-conflict">⚠ 新增演员冲突（推演）</span>');
  }
  if (!badges.length) badges.push('<span class="badge badge-ok">正常</span>');
  return badges.join(' ');
}

/* ---------- 弹窗 ---------- */

function openModal(id) {
  state.editingId = id || null;
  els.form.reset();
  els.formError.classList.add('hidden');
  els.modalTitle.textContent = id ? '编辑提示点' : '新增提示点';

  const cue = id ? state.cues.find((c) => c.id === id) : null;
  els.form.elements.id.value = id || '';
  if (cue) {
    els.form.elements.ref.value = cue.ref || '';
    els.form.elements.title.value = cue.title || '';
    els.form.elements.duration.value = CS.durationForInput(cue.duration);
    els.form.elements.minStart.value = cue.minStart ? CS.fmtTime(cue.minStart) : '';
    els.form.elements.maxFinish.value = cue.maxFinish == null ? '' : CS.fmtTime(cue.maxFinish);
    els.form.elements.actors.value = (cue.actors || []).join('、');
  }

  // 前置候选项不含自身
  const selected = new Set(cue ? cue.prerequisites : []);
  const candidates = state.cues.filter((c) => !id || c.id !== id);
  els.preList.innerHTML = candidates.length
    ? candidates
        .map((c) => {
          const label = `${c.ref ? c.ref + ' · ' : ''}${CS.esc(c.title)}`;
          return `<label class="pre-item">
            <input type="checkbox" name="prerequisites" value="${c.id}" ${
              selected.has(c.id) ? 'checked' : ''
            } /> ${label}</label>`;
        })
        .join('')
    : '<span class="pre-list-empty">暂无其他提示点，可先保存本项后再设置前置。</span>';

  els.mask.classList.remove('hidden');
  els.form.elements.title.focus();
}

function closeModal() {
  els.mask.classList.add('hidden');
  state.editingId = null;
}

async function onSubmit(e) {
  e.preventDefault();
  const f = els.form.elements;
  const payload = {
    ref: f.ref.value.trim(),
    title: f.title.value.trim(),
    duration: f.duration.value.trim(),
    minStart: f.minStart.value.trim(),
    maxFinish: f.maxFinish.value.trim(),
    actors: parseActorsInput(f.actors.value),
    prerequisites: Array.from(els.preList.querySelectorAll('input:checked')).map((i) =>
      Number(i.value)
    ),
  };

  try {
    if (state.editingId) {
      await CS.api(`/api/cues/${state.editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      await CS.api('/api/cues', { method: 'POST', body: JSON.stringify(payload) });
    }
    closeModal();
    await refresh();
  } catch (err) {
    els.formError.textContent = err.message;
    els.formError.classList.remove('hidden');
  }
}

/** 演员输入框：逗号 / 顿号 / 分号 / 换行分隔，去空白去重 */
function parseActorsInput(value) {
  return Array.from(
    new Set(
      String(value || '')
        .split(/[,，、;；\n]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    )
  );
}

async function onDelete(id) {
  const cue = state.cues.find((c) => c.id === id);
  const label = cue ? `${cue.ref ? cue.ref + ' ' : ''}「${cue.title}」` : `#${id}`;
  if (!confirm(`确定删除提示点 ${label} 吗？相关依赖关系会一并移除。`)) return;
  try {
    await CS.api(`/api/cues/${id}`, { method: 'DELETE' });
    await refresh();
  } catch (err) {
    alert(err.message);
  }
}

/* ---------- CSV 批量导入 ---------- */

let importState = { csv: null, preview: null };

function openImportModal() {
  importState = { csv: null, preview: null };
  els.importFile.value = '';
  els.importPreviewBtn.disabled = true;
  els.importCommitBtn.disabled = true;
  els.importError.classList.add('hidden');
  els.importPreview.innerHTML = '';
  els.importMask.classList.remove('hidden');
}

function closeImportModal() {
  els.importMask.classList.add('hidden');
  importState = { csv: null, preview: null };
}

function importError(msg) {
  els.importError.textContent = msg;
  els.importError.classList.remove('hidden');
}

async function readImportFile() {
  const file = els.importFile.files[0];
  if (!file) throw new Error('请先选择 CSV 文件');
  if (file.size > 1024 * 1024) {
    throw new Error('文件过大（单次最多导入 100 行，文件应在 1MB 以内）');
  }
  return file.text();
}

async function onImportPreview() {
  els.importError.classList.add('hidden');
  try {
    importState.csv = await readImportFile();
    const preview = await CS.api('/api/cues/import/preview', {
      method: 'POST',
      body: JSON.stringify({ csv: importState.csv }),
    });
    importState.preview = preview;
    renderImportPreview();
  } catch (err) {
    importState.preview = null;
    els.importPreview.innerHTML = '';
    els.importCommitBtn.disabled = true;
    importError(err.message);
  }
}

function renderImportPreview() {
  const p = importState.preview;
  if (!p) {
    els.importPreview.innerHTML = '';
    els.importCommitBtn.disabled = true;
    return;
  }
  // 有错误时不可提交
  els.importCommitBtn.disabled = !p.valid;

  const fileErrorHtml = p.fileErrors.length
    ? `<div class="form-error import-file-errors"><strong>文件问题：</strong><ul>${p.fileErrors
        .map((e) => `<li>${CS.esc(e)}</li>`)
        .join('')}</ul></div>`
    : '';

  const errorRows = p.rows.filter((r) => r.errors.length).length;
  const summaryHtml = p.rowCount
    ? `<div class="import-summary ${p.valid ? 'ok' : ''}">${
        p.valid
          ? `✔ 共 ${p.rowCount} 行，全部通过校验，可确认导入。`
          : `共 ${p.rowCount} 行，其中 ${errorRows} 行存在错误；修正后请重新预览。`
      }</div>`
    : '';

  const tableHtml = p.rows.length
    ? `<div class="table-wrap import-table-wrap">
        <table class="cue-table import-table">
          <thead>
            <tr>
              <th class="num">行</th>
              <th>ref</th>
              <th>名称</th>
              <th>时长</th>
              <th>最早开始</th>
              <th>最晚完成</th>
              <th>演员</th>
              <th>前置</th>
              <th>校验结果</th>
            </tr>
          </thead>
          <tbody>${p.rows.map(importRowHtml).join('')}</tbody>
        </table>
      </div>`
    : '';

  els.importPreview.innerHTML = fileErrorHtml + summaryHtml + tableHtml;
}

function importRowHtml(r) {
  const result = r.errors.length
    ? `<ul class="import-err-list">${r.errors.map((e) => `<li>${CS.esc(e)}</li>`).join('')}</ul>`
    : '<span class="badge badge-ok">通过</span>';
  const cell = (v) => (v ? CS.esc(v) : '<span class="hint">—</span>');
  const list = (arr) =>
    arr.length ? arr.map((a) => CS.esc(a)).join('、') : '<span class="hint">—</span>';
  return `<tr class="${r.errors.length ? 'row-import-error' : ''}">
    <td class="num">${r.line}</td>
    <td>${cell(r.ref)}</td>
    <td>${cell(r.title)}</td>
    <td>${cell(r.duration)}</td>
    <td>${cell(r.minStart)}</td>
    <td>${cell(r.maxFinish)}</td>
    <td>${list(r.actors)}</td>
    <td>${list(r.prerequisites)}</td>
    <td>${result}</td>
  </tr>`;
}

async function onImportCommit() {
  if (!importState.preview || !importState.preview.valid) return;
  els.importError.classList.add('hidden');
  els.importCommitBtn.disabled = true;
  try {
    const result = await CS.api('/api/cues/import', {
      method: 'POST',
      body: JSON.stringify({ csv: importState.csv }),
    });
    closeImportModal();
    await refresh();
    els.okBanner.innerHTML = `✔ 成功导入 <strong>${result.imported}</strong> 个提示点，走台单已重新排程。`;
    els.okBanner.classList.remove('hidden');
  } catch (err) {
    // 确认时服务端基于当前数据库重新校验；失败则展示返回的最新预览
    if (err.body && err.body.preview) {
      importState.preview = err.body.preview;
      renderImportPreview();
    } else {
      els.importCommitBtn.disabled = !(importState.preview && importState.preview.valid);
    }
    importError(err.message);
  }
}

refresh().catch((err) => {
  els.banner.textContent = '加载排程失败：' + err.message;
  els.banner.classList.remove('hidden');
});
