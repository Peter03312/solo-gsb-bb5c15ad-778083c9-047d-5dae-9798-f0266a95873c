'use strict';
// 换线预演版本有效性：标签卷正式写入使旧预演版本过期——端到端 HTTP 测试。
// 背景：换线预演会预测“拟停用标签卷及已贴待复核数量”（diff.label_rolls_will_retire），
// 但标签卷登记、核销、核销更正此前未纳入版本指纹——预演后发生这些正式写入，
// 旧版本仍能确认成功，导致预测与确认结果不符。
// 本测试验证修复后的语义：
//   1) 预演后登记新卷 / 核销 / 核销更正发生正式写入时，携原 version 与相同 changes
//      确认返回既有 409 VERSION_EXPIRED；整组变更不落库、不占用事件编号；
//   2) 重新预演并成功确认后，拟停用卷及已贴待复核数量与确认结果逐项一致；
//   3) 预演只读、原有版本与变更内容校验（VERSION_INVALID / CHANGES_MISMATCH）、
//      带 client_key 与无键清洗事件编号对应规则均保持不变。
// 运行：node scripts/test-replan-label-version.js   退出码 0 表示全部通过。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = '39233';
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replan-label-ver-test-'));
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

// 拟停用卷列表逐项比较（按 roll_id 排序后逐项比对 卷号/已贴待复核数量/原因）。
function sameRetireList(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const key = (x) => `${x.roll_id}|${x.roll_code}|${x.applied_pending_review}|${x.reason}`;
  const sa = a.slice().sort((x, y) => x.roll_id - y.roll_id).map(key);
  const sb = b.slice().sort((x, y) => x.roll_id - y.roll_id).map(key);
  return sa.every((v, i) => v === sb[i]);
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
    const matId = (code) => state0.materials.find((m) => m.code === code).id;
    const MILK = matId('MILK-01');
    const EGG = matId('EGG-01');
    const PEANUT = matId('PEANUT-01');
    const evB2 = state0.events.find((e) => e.type === 'PROCESS' && e.batch_code === 'BATCH-002');
    const batch3 = state0.batches.find((b) => b.code === 'BATCH-003');
    const release1 = (batch3.releases || []).find((r) => r.status === 'ACTIVE');
    const roll1 = state0.label_rolls.find((r) => r.roll_code === 'LABEL-0001');
    check('演示数据齐备（BATCH-002 事件 / BATCH-003 / 放行 #1 / LABEL-0001）',
      !!(evB2 && batch3 && release1 && roll1) && roll1.applied_qty === 120 && roll1.revision === 2,
      { evB2: evB2 && evB2.id, release1: release1 && release1.id, roll1: roll1 && roll1.id });

    // 变更 X：给 BATCH-002 加入花生原料（经批次引用传播到 BATCH-003，集合改变 → 卷停用）
    const changesX = [{
      op: 'update', event_id: evB2.id, type: 'PROCESS',
      event_time: evB2.event_time, equipment_id: lineA, note: evB2.note,
      batch_code: 'BATCH-002', material_ids: [MILK, EGG, PEANUT], ref_batch_ids: []
    }];
    // 变更 Y：撤销花生（集合恢复，新放行/新卷再次失效停用）
    const changesY = [{ ...changesX[0], material_ids: [MILK, EGG] }];

    const eventCount0 = state0.events.length;
    const maxEventId0 = Math.max(...state0.events.map((e) => e.id));

    // ---------- 1. 预演后登记新卷：旧版本 409，不落库、不占号 ----------
    console.log('1) 预演后登记新标签卷 → 旧版本确认 409 VERSION_EXPIRED');
    let r = await api('POST', '/api/replan/preview', { changes: changesX });
    check('预演 200', r.status === 200, r);
    const v1 = r.json.version;
    const retire1 = r.json.diff.label_rolls_will_retire;
    check('首次预演预测仅停用 LABEL-0001（已贴待复核 120）',
      retire1.length === 1 && retire1[0].roll_code === 'LABEL-0001' &&
      retire1[0].applied_pending_review === 120, retire1);
    // 预演只读：正式库卷状态不变
    let st = (await api('GET', '/api/state')).json;
    check('预演只读：LABEL-0001 仍为 ACTIVE',
      st.label_rolls.find((x) => x.id === roll1.id).status === 'ACTIVE', st.label_rolls);

    // 预演后正式写入：登记新卷 LABEL-0002
    r = await api('POST', '/api/label-rolls', {
      batch_id: batch3.id, release_id: release1.id,
      allergens: ['乳', '蛋', '芝麻'], print_qty: 200, registered_by: '包装组长-李雷'
    });
    check('登记新卷成功', r.status === 200 && r.json.roll_code === 'LABEL-0002', r);
    const roll2Id = r.json.id;

    // 携原 version 与相同 changes 确认 → 既有 409 VERSION_EXPIRED
    r = await api('POST', '/api/replan/apply', { version: v1, changes: changesX });
    check('旧版本确认 → 409 VERSION_EXPIRED', r.status === 409 && r.json.code === 'VERSION_EXPIRED', r);
    st = (await api('GET', '/api/state')).json;
    check('整组变更未落库：事件数不变、LABEL-0001 未停用',
      st.events.length === eventCount0 &&
      st.label_rolls.find((x) => x.id === roll1.id).status === 'ACTIVE',
      { events: st.events.length, rolls: st.label_rolls.map((x) => x.status) });
    // 不占用事件编号：下一个正式事件编号仍为 maxEventId0+1
    r = await api('POST', '/api/events', {
      type: 'CLEAN', event_time: '2026-10-06T08:00', equipment_id: lineA, note: '探针事件（随后删除）'
    });
    check('失败确认未占用事件编号（探针编号连续）', r.status === 200 && r.json.id === maxEventId0 + 1,
      { got: r.json && r.json.id, expected: maxEventId0 + 1 });
    r = await api('DELETE', `/api/events/${maxEventId0 + 1}`);
    check('探针事件已删除', r.status === 200, r);

    // 重新预演 → 确认成功，预测与确认结果逐项一致
    r = await api('POST', '/api/replan/preview', { changes: changesX });
    check('重新预演 200', r.status === 200, r);
    const v2 = r.json.version;
    const retire2 = r.json.diff.label_rolls_will_retire;
    check('重新预演预测停用两卷（新卷一并列入，已贴待复核 120 / 0）',
      retire2.length === 2 &&
      retire2.some((x) => x.roll_code === 'LABEL-0001' && x.applied_pending_review === 120) &&
      retire2.some((x) => x.roll_code === 'LABEL-0002' && x.applied_pending_review === 0),
      retire2);
    r = await api('POST', '/api/replan/apply', { version: v2, changes: changesX });
    check('确认应用 200', r.status === 200, r);
    check('确认结果的拟停用卷与重新预演逐项一致',
      sameRetireList(r.json.diff.label_rolls_will_retire, retire2),
      { applied: r.json.diff.label_rolls_will_retire, preview: retire2 });
    check('retired_rolls 与预测逐项一致（卷号 + 已贴待复核数量）',
      sameRetireList(
        r.json.retired_rolls.map((x) => ({ ...x, roll_id: x.id })),
        retire2
      ), r.json.retired_rolls);
    st = (await api('GET', '/api/state')).json;
    check('两卷已实际停用、已贴待复核数量与预测一致',
      st.label_rolls.find((x) => x.id === roll1.id).status === 'RETIRED' &&
      st.label_rolls.find((x) => x.id === roll1.id).applied_pending_review === 120 &&
      st.label_rolls.find((x) => x.id === roll2Id).status === 'RETIRED' &&
      st.label_rolls.find((x) => x.id === roll2Id).applied_pending_review === 0,
      st.label_rolls.map((x) => [x.roll_code, x.status, x.applied_pending_review]));

    // ---------- 2. 预演后核销现有卷：旧版本 409 ----------
    console.log('2) 预演后核销现有卷 → 旧版本确认 409 VERSION_EXPIRED');
    // 当前 BATCH-003 集合含花生：登记新放行 + 新卷 LABEL-0003
    r = await api('POST', '/api/releases', {
      batch_id: batch3.id, released_at: '2026-10-01T09:00', released_by: '质检员-王敏'
    });
    check('新放行登记成功', r.status === 200 && Number.isInteger(r.json.id), r);
    const release2 = r.json.id;
    r = await api('POST', '/api/label-rolls', {
      batch_id: batch3.id, release_id: release2,
      allergens: ['乳', '蛋', '芝麻', '花生'], print_qty: 300, registered_by: '包装组长-李雷'
    });
    check('登记 LABEL-0003 成功', r.status === 200 && r.json.roll_code === 'LABEL-0003', r);
    const roll3Id = r.json.id;
    r = await api('POST', `/api/label-rolls/${roll3Id}/consume`, {
      expected_revision: 0, applied: 50, voided: 2, used_by: '包装工-赵强'
    });
    check('核销 50/2 成功（修订号 1）', r.status === 200 && r.json.revision === 1, r);

    r = await api('POST', '/api/replan/preview', { changes: changesY });
    check('预演 200', r.status === 200, r);
    const v3 = r.json.version;
    const retire3 = r.json.diff.label_rolls_will_retire;
    check('预演预测停用 LABEL-0003（已贴待复核 50）',
      retire3.length === 1 && retire3[0].roll_code === 'LABEL-0003' &&
      retire3[0].applied_pending_review === 50, retire3);
    // 预演后正式写入：再核销 30 张（已贴 50 → 80）
    r = await api('POST', `/api/label-rolls/${roll3Id}/consume`, {
      expected_revision: 1, applied: 30, voided: 0, used_by: '包装工-赵强'
    });
    check('预演后续核销成功（已贴 80，修订号 2）',
      r.status === 200 && r.json.applied_qty === 80 && r.json.revision === 2, r);
    r = await api('POST', '/api/replan/apply', { version: v3, changes: changesY });
    check('旧版本确认 → 409 VERSION_EXPIRED', r.status === 409 && r.json.code === 'VERSION_EXPIRED', r);
    st = (await api('GET', '/api/state')).json;
    const roll3Now = st.label_rolls.find((x) => x.id === roll3Id);
    check('整组变更未落库：卷仍 ACTIVE、事件数不变',
      roll3Now.status === 'ACTIVE' && roll3Now.applied_qty === 80 &&
      st.events.length === eventCount0,
      { roll: [roll3Now.status, roll3Now.applied_qty], events: st.events.length });

    r = await api('POST', '/api/replan/preview', { changes: changesY });
    const v4 = r.json.version;
    const retire4 = r.json.diff.label_rolls_will_retire;
    check('重新预演预测已贴待复核更新为 80',
      retire4.length === 1 && retire4[0].roll_code === 'LABEL-0003' &&
      retire4[0].applied_pending_review === 80, retire4);
    r = await api('POST', '/api/replan/apply', { version: v4, changes: changesY });
    check('确认应用 200', r.status === 200, r);
    check('确认结果与重新预演逐项一致（已贴待复核 80）',
      sameRetireList(r.json.diff.label_rolls_will_retire, retire4) &&
      r.json.retired_rolls.length === 1 &&
      r.json.retired_rolls[0].roll_code === 'LABEL-0003' &&
      r.json.retired_rolls[0].applied_pending_review === 80,
      { applied: r.json.diff.label_rolls_will_retire, retired: r.json.retired_rolls });

    // ---------- 3. 预演后更正核销：旧版本 409；带键/无键清洗编号对应不变 ----------
    console.log('3) 预演后核销更正 → 旧版本确认 409 VERSION_EXPIRED；插入清洗编号对应规则保持');
    // 集合已恢复（无花生）：登记新放行 + 新卷 LABEL-0004
    r = await api('POST', '/api/releases', {
      batch_id: batch3.id, released_at: '2026-10-02T09:00', released_by: '质检员-王敏'
    });
    const release3 = r.json.id;
    r = await api('POST', '/api/label-rolls', {
      batch_id: batch3.id, release_id: release3,
      allergens: ['乳', '蛋', '芝麻'], print_qty: 100, registered_by: '包装组长-李雷'
    });
    check('登记 LABEL-0004 成功', r.status === 200 && r.json.roll_code === 'LABEL-0004', r);
    const roll4Id = r.json.id;
    r = await api('POST', `/api/label-rolls/${roll4Id}/consume`, {
      expected_revision: 0, applied: 40, voided: 0, used_by: '包装工-赵强'
    });
    check('核销 40 成功（修订号 1）', r.status === 200 && r.json.revision === 1, r);
    r = await api('GET', `/api/label-rolls/${roll4Id}/usages`);
    const usage4 = r.json.usages[0].id;

    // 变更 Z = X + 两条拟插入清洗（一条带 client_key、一条无键）
    const changesZ = changesX.concat([
      { op: 'insert_clean', client_key: 'final-wash', event_time: '2026-09-30T16:30', equipment_id: lineA, note: '班后追加清洗（带键）' },
      { op: 'insert_clean', event_time: '2026-09-30T16:45', equipment_id: lineA, note: '无键清洗' }
    ]);
    r = await api('POST', '/api/replan/preview', { changes: changesZ });
    check('预演 200', r.status === 200, r);
    const v5 = r.json.version;
    const retire5 = r.json.diff.label_rolls_will_retire;
    const inserted5 = r.json.inserted_clean_events;
    check('预演预测停用 LABEL-0004（已贴待复核 40）',
      retire5.length === 1 && retire5[0].roll_code === 'LABEL-0004' &&
      retire5[0].applied_pending_review === 40, retire5);
    check('预演返回两条拟插入清洗（带键/无键）',
      inserted5.length === 2 && inserted5.some((x) => x.client_key === 'final-wash') &&
      inserted5.some((x) => x.client_key === null), inserted5);
    // 预演后正式写入：更正该笔核销 40 → 25
    r = await api('POST', `/api/label-rolls/${roll4Id}/usages/${usage4}/corrections`, {
      expected_revision: 1, target_applied_qty: 25, target_void_qty: 0,
      corrected_by: '仓管-周九', reason: '盘点复核：贴用多录 15 张'
    });
    check('核销更正成功（已贴 25，修订号 2）',
      r.status === 200 && r.json.roll.applied_qty === 25 && r.json.roll.revision === 2, r);
    r = await api('POST', '/api/replan/apply', { version: v5, changes: changesZ });
    check('旧版本确认 → 409 VERSION_EXPIRED', r.status === 409 && r.json.code === 'VERSION_EXPIRED', r);
    st = (await api('GET', '/api/state')).json;
    const roll4Now = st.label_rolls.find((x) => x.id === roll4Id);
    check('整组变更未落库：卷仍 ACTIVE、拟插入清洗未落库、事件数不变',
      roll4Now.status === 'ACTIVE' && roll4Now.applied_qty === 25 &&
      st.events.length === eventCount0 &&
      !st.events.some((e) => e.event_time === '2026-09-30T16:30' || e.event_time === '2026-09-30T16:45'),
      { events: st.events.length });

    // 重新预演：拟插入编号与上次预演一致（失败的确认未占用编号）
    r = await api('POST', '/api/replan/preview', { changes: changesZ });
    const v6 = r.json.version;
    const retire6 = r.json.diff.label_rolls_will_retire;
    const inserted6 = r.json.inserted_clean_events;
    check('重新预演预测已贴待复核更新为 25',
      retire6.length === 1 && retire6[0].roll_code === 'LABEL-0004' &&
      retire6[0].applied_pending_review === 25, retire6);
    check('失败确认未占用事件编号（重新预演编号与上次一致）',
      JSON.stringify(inserted6.map((x) => [x.client_key, x.event_id]).sort()) ===
      JSON.stringify(inserted5.map((x) => [x.client_key, x.event_id]).sort()),
      { inserted5, inserted6 });
    r = await api('POST', '/api/replan/apply', { version: v6, changes: changesZ });
    check('确认应用 200', r.status === 200, r);
    check('确认结果与重新预演逐项一致（已贴待复核 25）',
      sameRetireList(r.json.diff.label_rolls_will_retire, retire6) &&
      r.json.retired_rolls.length === 1 &&
      r.json.retired_rolls[0].roll_code === 'LABEL-0004' &&
      r.json.retired_rolls[0].applied_pending_review === 25,
      { applied: r.json.diff.label_rolls_will_retire, retired: r.json.retired_rolls });
    // 带键按键、无键按规范化顺序：确认编号与预演逐项一致
    const keyedP = inserted6.find((x) => x.client_key === 'final-wash');
    const keyedA = r.json.inserted_clean_events.find((x) => x.client_key === 'final-wash');
    const keylessP = inserted6.filter((x) => x.client_key === null);
    const keylessA = r.json.inserted_clean_events.filter((x) => x.client_key === null);
    check('带键清洗编号一致、无键清洗编号一致',
      keyedP && keyedA && keyedP.event_id === keyedA.event_id &&
      keylessP.length === 1 && keylessA.length === 1 && keylessP[0].event_id === keylessA[0].event_id,
      { inserted6, applied: r.json.inserted_clean_events });
    st = (await api('GET', '/api/state')).json;
    check('拟插入清洗已按号落库',
      r.json.inserted_clean_events.every((x) =>
        st.events.some((e) => e.id === x.event_id && e.type === 'CLEAN')),
      r.json.inserted_clean_events);

    // ---------- 4. 原有版本与变更内容校验保持 ----------
    console.log('4) 版本/变更内容校验语义不变');
    r = await api('POST', '/api/replan/apply', { version: 'not-a-version', changes: changesY });
    check('签名损坏 → 400 VERSION_INVALID', r.status === 400 && r.json.code === 'VERSION_INVALID', r);
    r = await api('POST', '/api/replan/preview', { changes: changesY });
    const v7 = r.json.version;
    r = await api('POST', '/api/replan/apply', {
      version: v7, changes: [{ ...changesY[0], note: '内容被改动' }]
    });
    check('变更不一致 → 409 CHANGES_MISMATCH', r.status === 409 && r.json.code === 'CHANGES_MISMATCH', r);
    // 上述失败确认均未写库：v7 仍有效，可直接确认成功
    r = await api('POST', '/api/replan/apply', { version: v7, changes: changesY });
    check('失败确认不产生写入，原版本仍可确认成功', r.status === 200 && r.json.ok === true, r);

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
