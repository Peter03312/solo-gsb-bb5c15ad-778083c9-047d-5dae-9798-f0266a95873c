'use strict';
// 换线预演“拟插入清洗事件编号”一致性：端到端 HTTP 测试。
// 背景：删除当前最大编号的清洗事件后，正式库保留自增序列（sqlite_sequence 不回退），
// 而预演影子库此前按剩余事件重建序列，导致预演编号与确认应用编号不同、无法按号对账。
// 本测试验证修复后的语义：
//   1) 同一有效预演版本中，预演与成功确认的 inserted_clean_events 逐项 event_id 一致
//      （带 client_key 的按该键匹配，未带的按既有规范化顺序匹配）；
//   2) 预演仍不写正式库，响应字段与错误语义保持兼容；
//   3) 预演后任何改变“将分配编号”的正式写入（哪怕现存事件清单随后恢复原样）
//      使旧版本 409 VERSION_EXPIRED，须重新预演；
//   4) 版本冲突或整组校验失败不产生部分事件，也不占用正式编号。
// 运行：node scripts/test-replan-event-ids.js   退出码 0 表示全部通过。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = '39231';
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replan-ids-test-'));
const dbPath = path.join(tmpDir, 'test.db');

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : '');
  }
}

async function api(method, urlPath, body) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* 非 JSON */ }
  return { status: res.status, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(proc) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(BASE + '/api/state');
      if (res.ok) return;
    } catch (_) { /* 未就绪 */ }
    if (proc.exitCode !== null) throw new Error('服务提前退出');
    await sleep(250);
  }
  throw new Error('服务启动超时');
}

// 按需求语义逐项匹配预演与确认应用的 inserted_clean_events：
// 带 client_key 的按该键匹配；未带的按既有规范化顺序（两个数组各自的相对顺序）匹配。
// 返回匹配对 [[previewItem, appliedItem], ...]，无法一一对应时返回 null。
function matchInserted(previewList, applyList) {
  if (!Array.isArray(previewList) || !Array.isArray(applyList)) return null;
  if (previewList.length !== applyList.length) return null;
  const remaining = applyList.slice();
  const pairs = [];
  const keylessPreview = [];
  for (const p of previewList) {
    if (p.client_key !== null && p.client_key !== undefined) {
      const i = remaining.findIndex((a) => a.client_key === p.client_key);
      if (i < 0) return null;
      pairs.push([p, remaining.splice(i, 1)[0]]);
    } else {
      keylessPreview.push(p);
    }
  }
  // 剩余应全部为未带 client_key 的项，且数量与预演侧一致
  if (remaining.length !== keylessPreview.length) return null;
  if (remaining.some((a) => a.client_key !== null && a.client_key !== undefined)) return null;
  keylessPreview.forEach((p, i) => pairs.push([p, remaining[i]]));
  return pairs;
}

async function main() {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: {
      ...process.env,
      PORT,
      HOST: '127.0.0.1',
      DB_PATH: dbPath,
      SEED_DEMO: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  try {
    await waitReady(proc);
    console.log('服务已就绪，开始测试');

    const state0 = (await api('GET', '/api/state')).json;
    const lineA = state0.equipment.find((e) => e.code === 'LINE-A').id;
    const maxId0 = Math.max(...state0.events.map((e) => e.id));
    const eventCount0 = state0.events.length;

    // ---------- 1. 删除当前最大编号清洗事件后，预演/确认编号逐项一致 ----------
    console.log('1) 删除最大编号清洗事件后，同一版本内预演与确认编号逐项一致');
    // 先制造“最大编号清洗事件被删除”的场景：新增再删除，正式库序列不回退
    let r = await api('POST', '/api/events', {
      type: 'CLEAN', event_time: '2026-10-02T08:00', equipment_id: lineA, note: '临时清洗（随后删除）'
    });
    check('新增临时清洗事件成功', r.status === 200 && Number.isInteger(r.json.id), r);
    const deletedId = r.json.id;
    check('新事件编号 = 原最大编号+1', deletedId === maxId0 + 1, { deletedId, maxId0 });
    r = await api('DELETE', `/api/events/${deletedId}`);
    check('删除临时清洗事件成功', r.status === 200, r);
    const afterDelete = (await api('GET', '/api/state')).json;
    check('删除后现存最大编号回落', Math.max(...afterDelete.events.map((e) => e.id)) === maxId0,
      afterDelete.events.map((e) => e.id));
    check('删除后事件数复原', afterDelete.events.length === eventCount0,
      [afterDelete.events.length, eventCount0]);

    // 预演：一组三条拟插入清洗（混合带/不带 client_key，故意乱序提交）
    const changes1 = [
      { op: 'insert_clean', client_key: 'b-key', event_time: '2026-10-02T11:00', equipment_id: lineA, note: '第二条（带键 b）' },
      { op: 'insert_clean', event_time: '2026-10-02T10:00', equipment_id: lineA, note: '无键清洗' },
      { op: 'insert_clean', client_key: 'a-key', event_time: '2026-10-02T09:00', equipment_id: lineA, note: '第一条（带键 a）' }
    ];
    r = await api('POST', '/api/replan/preview', { changes: changes1 });
    check('预演 200', r.status === 200, r);
    const r0preview = r.json;
    check('预演响应字段保持兼容（ok/phase/version/business_version/changes/diff）',
      r.json && r.json.ok === true && r.json.phase === 'PREVIEW' &&
      typeof r.json.version === 'string' && typeof r.json.business_version === 'string' &&
      Array.isArray(r.json.changes) && r.json.diff && typeof r.json.diff === 'object', r.json);
    const previewInserted = r.json.inserted_clean_events;
    check('预演返回 3 条拟插入事件', Array.isArray(previewInserted) && previewInserted.length === 3,
      previewInserted);
    // 关键断言①：预演编号沿用正式库保留的自增序列（被删事件编号之后继续），而非按剩余事件重建
    const previewIds = previewInserted.map((x) => x.event_id).sort((a, b) => a - b);
    check('预演编号接续正式库序列（被删编号之后）',
      previewIds.every((id, i) => id === deletedId + 1 + i),
      { previewIds, deletedId });
    check('带 client_key 的项原样回显该键',
      previewInserted.filter((x) => x.client_key).map((x) => x.client_key).sort().join(',') === 'a-key,b-key',
      previewInserted);

    // ---------- 2. 预演不写正式库 ----------
    console.log('2) 预演不写正式库');
    const stateAfterPreview = (await api('GET', '/api/state')).json;
    check('正式事件数不变', stateAfterPreview.events.length === eventCount0,
      [stateAfterPreview.events.length, eventCount0]);
    check('正式库未出现预演拟插入的清洗事件',
      !stateAfterPreview.events.some((e) => e.event_time >= '2026-10-02' && e.type === 'CLEAN'),
      stateAfterPreview.events.filter((e) => e.event_time >= '2026-10-02'));

    // ---------- 3. 确认应用：逐项 event_id 与预演一致 ----------
    console.log('3) 确认应用的 inserted_clean_events 与预演逐项一致');
    r = await api('POST', '/api/replan/apply', { changes: changes1 });
    check('缺 version 拒绝（400，错误语义兼容）', r.status === 400 && r.json.code === 'VERSION_INVALID', r);
    // 上面失败的确认未写正式库、未占用编号：第 1 步预演签发的版本仍然有效
    const v1 = r0preview.version;
    const previewInserted1 = r0preview.inserted_clean_events;
    r = await api('POST', '/api/replan/apply', { version: v1, changes: changes1 });
    check('确认应用 200', r.status === 200, r);
    check('应用响应字段保持兼容（ok/phase/applied_version/inserted_clean_events/invalidated/diff）',
      r.json && r.json.ok === true && r.json.phase === 'APPLIED' &&
      r.json.applied_version === v1 && Array.isArray(r.json.inserted_clean_events) &&
      Array.isArray(r.json.invalidated) && r.json.diff && typeof r.json.diff === 'object', r.json);
    const appliedInserted = r.json.inserted_clean_events;
    const pairs = matchInserted(previewInserted1, appliedInserted);
    check('预演/应用可逐项对应（带键按键、无键按规范化顺序）', pairs !== null,
      { previewInserted1, appliedInserted });
    check('逐项 event_id 完全一致',
      pairs !== null && pairs.every(([p, a]) => p.event_id === a.event_id),
      { previewInserted1, appliedInserted });
    const stateApplied = (await api('GET', '/api/state')).json;
    check('正式库中可按号查到全部拟插入事件',
      appliedInserted.every((x) => stateApplied.events.some((e) => e.id === x.event_id && e.type === 'CLEAN')),
      { appliedInserted, ids: stateApplied.events.map((e) => e.id) });
    const keyedA = appliedInserted.find((x) => x.client_key === 'a-key');
    check('按 client_key 对账：a-key 事件内容正确',
      keyedA && stateApplied.events.some((e) =>
        e.id === keyedA.event_id && e.event_time === '2026-10-02T09:00' && e.note === '第一条（带键 a）'),
      keyedA);

    // ---------- 4. 预演后“新增再删除”使清单复原：旧版本仍须拒绝 ----------
    console.log('4) 预演后其他操作改变将分配编号（清单随后复原）→ 旧版本拒绝确认');
    const changes2 = [
      { op: 'insert_clean', client_key: 'k1', event_time: '2026-10-03T09:00', equipment_id: lineA, note: '第二批预演清洗' }
    ];
    r = await api('POST', '/api/replan/preview', { changes: changes2 });
    check('第二次预演 200', r.status === 200, r);
    const v2 = r.json.version;
    const predicted2 = r.json.inserted_clean_events[0].event_id;
    // 预演后：新增一个事件（占用一个编号）再删除——现存事件清单与预演时完全相同
    r = await api('POST', '/api/events', {
      type: 'CLEAN', event_time: '2026-10-03T08:00', equipment_id: lineA, note: '干扰事件（随后删除）'
    });
    check('干扰事件新增成功', r.status === 200, r);
    const disturbId = r.json.id;
    r = await api('DELETE', `/api/events/${disturbId}`);
    check('干扰事件删除成功', r.status === 200, r);
    const stateRestored = (await api('GET', '/api/state')).json;
    check('现存事件清单与预演时一致（同 id 同内容）',
      JSON.stringify(stateRestored.events.map((e) => e.id).sort((a, b) => a - b)) ===
      JSON.stringify(stateApplied.events.map((e) => e.id).sort((a, b) => a - b)),
      stateRestored.events.map((e) => e.id));
    r = await api('POST', '/api/replan/apply', { version: v2, changes: changes2 });
    check('旧版本确认被拒绝：409 VERSION_EXPIRED', r.status === 409 && r.json.code === 'VERSION_EXPIRED', r);
    const stateAfterReject = (await api('GET', '/api/state')).json;
    check('拒绝后正式库无部分事件（预演清洗未落库）',
      !stateAfterReject.events.some((e) => e.event_time === '2026-10-03T09:00'),
      stateAfterReject.events.filter((e) => e.event_time >= '2026-10-03'));

    // ---------- 5. 重新预演后确认成功，编号按新序列且预演/应用一致 ----------
    console.log('5) 重新预演 → 确认成功，编号按最新序列分配且与预演一致');
    r = await api('POST', '/api/replan/preview', { changes: changes2 });
    check('重新预演 200', r.status === 200, r);
    const v3 = r.json.version;
    const predicted3 = r.json.inserted_clean_events[0].event_id;
    check('新预演编号已推进（反映被占用的编号）', predicted3 === predicted2 + 1,
      { predicted2, predicted3 });
    r = await api('POST', '/api/replan/apply', { version: v3, changes: changes2 });
    check('确认应用 200', r.status === 200, r);
    check('应用编号与重新预演一致',
      r.json.inserted_clean_events[0].event_id === predicted3 &&
      r.json.inserted_clean_events[0].client_key === 'k1', r.json.inserted_clean_events);

    // ---------- 6. 版本冲突/内容不一致不占用正式编号 ----------
    console.log('6) 版本冲突（CHANGES_MISMATCH / VERSION_INVALID）不产生事件、不占号');
    const changes3 = [
      { op: 'insert_clean', client_key: 'k3', event_time: '2026-10-04T09:00', equipment_id: lineA, note: '第三批预演清洗' }
    ];
    r = await api('POST', '/api/replan/preview', { changes: changes3 });
    const v4 = r.json.version;
    const predicted4 = r.json.inserted_clean_events[0].event_id;
    r = await api('POST', '/api/replan/apply', {
      version: v4,
      changes: [{ ...changes3[0], note: '内容被改动' }]
    });
    check('变更不一致 → 409 CHANGES_MISMATCH', r.status === 409 && r.json.code === 'CHANGES_MISMATCH', r);
    r = await api('POST', '/api/replan/apply', { version: v4 + 'x', changes: changes3 });
    check('签名损坏 → 400 VERSION_INVALID', r.status === 400 && r.json.code === 'VERSION_INVALID', r);
    // 下一次正式写入应恰好拿到预演预测的编号（失败的确认没有占用任何编号）
    r = await api('POST', '/api/events', {
      type: 'CLEAN', event_time: '2026-10-04T08:00', equipment_id: lineA, note: '探针事件'
    });
    check('失败确认未占用编号（下一事件编号 = 预演预测号）', r.status === 200 && r.json.id === predicted4,
      { got: r.json && r.json.id, predicted4 });
    // 该正式写入使 v4 过期
    r = await api('POST', '/api/replan/apply', { version: v4, changes: changes3 });
    check('正式写入后旧版本 → 409 VERSION_EXPIRED', r.status === 409 && r.json.code === 'VERSION_EXPIRED', r);

    // ---------- 7. 整组校验失败不产生部分事件、不占号 ----------
    console.log('7) 整组校验失败（预演即拒绝/单条写入回滚）不产生部分事件、不占号');
    const stateBefore7 = (await api('GET', '/api/state')).json;
    const nextId7 = Math.max(...stateBefore7.events.map((e) => e.id)) + 1;
    // 预演阶段整组校验失败：拟插入清洗与既有事件同设备同时刻
    r = await api('POST', '/api/replan/preview', {
      changes: [{ op: 'insert_clean', event_time: '2026-09-30T09:00', equipment_id: lineA, note: '冲突清洗' }]
    });
    check('整组校验失败 → 400 REPLAN_REJECTED', r.status === 400 && r.json.code === 'REPLAN_REJECTED', r);
    // 单条写入校验失败（同设备同时刻）：事务回滚
    r = await api('POST', '/api/events', {
      type: 'CLEAN', event_time: '2026-09-30T09:00', equipment_id: lineA, note: '冲突单条'
    });
    check('单条冲突写入 → 400', r.status === 400, r);
    // 失败的预演与失败的单条写入都不占用正式编号
    r = await api('POST', '/api/events', {
      type: 'CLEAN', event_time: '2026-10-05T08:00', equipment_id: lineA, note: '探针事件 2'
    });
    check('校验失败未占用编号（下一事件编号连续）', r.status === 200 && r.json.id === nextId7,
      { got: r.json && r.json.id, nextId7 });
    const stateEnd = (await api('GET', '/api/state')).json;
    check('失败尝试未留下部分事件',
      !stateEnd.events.some((e) => e.note === '冲突清洗' || e.note === '冲突单条'),
      stateEnd.events.filter((e) => e.note && e.note.includes('冲突')));

  } finally {
    proc.kill('SIGTERM');
    await sleep(300);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
  }

  if (failures) {
    console.error(`\n失败 ${failures} 项`);
    process.exit(1);
  }
  console.log('\n全部通过');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
