'use strict';

async function load() {
  const result = await CS.api('/api/schedule');
  render(result);
}

function render({ cues, cycle, conflicts }) {
  document.getElementById('gen-time').textContent = new Date().toLocaleString('zh-CN');

  const banner = document.getElementById('cycle-banner');
  if (cycle) {
    const byId = new Map(cues.map((c) => [c.id, c]));
    const names = cycle.nodes
      .map((id) => {
        const c = byId.get(id);
        return c ? `${c.ref ? c.ref + ' ' : ''}「${CS.esc(c.title)}」` : `#${id}`;
      })
      .join('、');
    const paths = (cycle.paths || (cycle.path ? [cycle.path] : []))
      .map((p) => p.map((id) => CS.esc(CS.labelOf(byId, id))).join(' → '))
      .join('；');
    banner.innerHTML =
      `⚠ <strong>环依赖（${cycle.nodes.length} 项）：</strong>${names}。` +
      (paths ? ` 环路：${paths}。` : '') +
      `下列标记为“环依赖 / 环阻塞”的项目无法排程。`;
    banner.classList.remove('hidden');
  }

  const conflictBanner = document.getElementById('conflict-banner');
  if (conflicts && conflicts.length) {
    const cueLabel = (c) => `${c.ref ? CS.esc(c.ref) + ' ' : ''}「${CS.esc(c.title)}」`;
    conflictBanner.innerHTML =
      `⚠ <strong>演员时间冲突（${conflicts.length} 处）：</strong>` +
      conflicts
        .map(
          (cf) =>
            `${CS.esc(cf.actor)}：${cueLabel(cf.cueA)} 与 ${cueLabel(cf.cueB)} 重叠 ` +
            `${CS.fmtTime(cf.overlapStart)} – ${CS.fmtTime(cf.overlapEnd)}`
        )
        .join('；') +
      `。`;
    conflictBanner.classList.remove('hidden');
  }

  const tbody = document.getElementById('cue-tbody');
  tbody.innerHTML = cues
    .map((c, i) => {
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
        ? c.prerequisites.map((pid) => CS.esc(CS.labelOf(new Map(cues.map((x) => [x.id, x])), pid))).join('、')
        : '—';
      const actors = (c.actors || []).length
        ? c.actors
            .map((name) =>
              (c.conflictActors || []).includes(name)
                ? `<span class="actor-conflict-text">${CS.esc(name)}⚠</span>`
                : CS.esc(name)
            )
            .join('、')
        : '—';
      let status = '□ 正常';
      if (c.inCycle) status = '⚠ 环依赖';
      else if (c.blockedByCycle) status = '⚠ 环阻塞';
      else if (c.overdue) status = '⚠ 超最晚完成';
      if (hasConflict) {
        const mark = `⚠ 演员冲突（${CS.esc(c.conflictActors.join('、'))}）`;
        status = status === '□ 正常' ? mark : `${status}；${mark}`;
      }

      // 最迟允许开始 / 连锁余量
      let latestStart;
      let chainSlack;
      if (!c.scheduled) {
        latestStart = '<span class="t-na">不可计算</span>';
        chainSlack = '<span class="t-na">不可计算</span>';
      } else if (c.latestStart == null) {
        latestStart = '<span class="t-unbounded">不限</span>';
        chainSlack = '<span class="t-unbounded">不限</span>';
      } else {
        latestStart = `<span class="${c.latestStart < 0 ? 't-chain-neg' : ''}">${CS.fmtTimeSigned(
          c.latestStart
        )}</span>`;
        const cls = c.chainSlack < 0 ? 't-chain-neg' : c.chainSlack === 0 ? 't-chain-zero' : '';
        chainSlack = `<span class="${cls}">${CS.fmtSigned(c.chainSlack)}</span>`;
      }

      return `<tr class="${rowCls}">
        <td>${i + 1}</td>
        <td>${CS.esc(c.ref || `#${c.id}`)}</td>
        <td class="cue-name">${CS.esc(c.title)}</td>
        <td class="num">${CS.fmtDur(c.duration)}</td>
        <td class="num">${c.scheduled ? CS.fmtTime(c.earliestStart) : '—'}</td>
        <td class="num ${c.overdue ? 't-overdue' : ''}">${
          c.scheduled ? CS.fmtTime(c.earliestFinish) : '—'
        }</td>
        <td class="num">${c.maxFinish == null ? '不限' : CS.fmtTime(c.maxFinish)}</td>
        <td class="num">${latestStart}</td>
        <td class="num">${chainSlack}</td>
        <td>${pres}</td>
        <td>${actors}</td>
        <td>${status}</td>
      </tr>`;
    })
    .join('');
}

load().catch((err) => {
  const banner = document.getElementById('cycle-banner');
  banner.textContent = '加载排程失败：' + err.message;
  banner.classList.remove('hidden');
});
