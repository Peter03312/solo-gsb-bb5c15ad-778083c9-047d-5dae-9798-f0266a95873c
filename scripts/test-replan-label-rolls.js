'use strict';
// 换线预演“拟停用标签卷及已贴待复核数量”预测的版本有效性：端到端 HTTP 测试。
// 背景：预演会预测 diff.label_rolls_will_retire（拟停用卷及已贴待复核张数），
// 但标签卷登记、核销、核销更正此前未纳入预演版本指纹——预演后这些正式写入
// 不改变版本，旧版本仍可确认成功，导致预测与确认结果不符。
// 本测试验证修复后的语义：
//   1) 预演后标签卷登记 / 核销 / 核销更正发生正式写入时，携原 version 与相同
//      changes 确认返回 409 VERSION_EXPIRED，整组变更不落库、不占用事件编号；
//   2) 重新预演并成功确认后，拟停用卷及已贴待复核数量与确认结果逐项一致；
//   3) 预演只读、原有版本与变更内容校验（VERSION_INVALID / CHANGES_MISMATCH）、
//      带 client_key 与无键清洗事件编号对应规则均保持不变。
// 运行：node scripts/test-replan-label-rolls.js   退出码 0 表示全部通过。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = '39233';
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replan-labels-test-'));
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

// 拟停用卷列表按 roll_id 排序后取关键字段，便于“逐项一致”比较。
// （diff.label_rolls_will_retire 用 roll_id，顶层 retired_rolls 用 id，这里统一。）
function retireList(list) {
  return (list || [])
    .map((x) => ({
      roll_id: x.roll_id !== undefined ? x.roll_id : x.id,
      roll_code: x.roll_code,
      applied_pending_review: x.applied_pending_review
    }))
    .sort((a, b) => a.roll_id - b.roll_id);
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
    const milk = state0.materials.find((m) => m.code === 'MILK-01').id;
    const egg = state0.materials.find((m) => m.code === 'EGG-01').id;
    const peanut = state0.materials.find((m) => m.code === 'PEANUT-01').id;
    const batch3 = state0.batches.find((b) => b.code === 'BATCH-003');
    const release1 = batch3.releases.find((x) => x.status === 'ACTIVE');
    const eventCount0 = state0.events.length;
    const maxEventId0 = Math.max(...state0.events.map((e) => e.id));
    const roll1 = state0.label_rolls.find((r) => r.roll_code === 'LABEL-0001');
    check('演示数据就绪：LABEL-0001 印 500 / 贴 120 / 修订号 2 / ACTIVE',
      roll1 && roll1.print_qty === 500 && roll1.applied_qty === 120 &&
      roll1.revision === 2 && roll1.status === 'ACTIVE', roll1);

    // 整组变更：给 BATCH-002 的加工事件（10:00, LINE-A）加入花生原料
    // （BATCH-003 引用 BATCH-002 -> 集合新增“花生” -> 放行失效 -> 卷将停用），
    // 并拟插入一条带 client_key 的清洗事件（用于核对事件编号不被失败确认占用）。
    const ev3 = state0.events.find((e) => e.batch_code === 'BATCH-002');
    const changes = [
      {
        op: 'update', event_id: ev3.id, type: 'PROCESS',
        event_time: ev3.event_time, equipment_id: lineA, note: '蛋糕糊（加入花生）',
        batch_code: 'BATCH-002', material_ids: [milk, egg, peanut], ref_batch_ids: []
      },
      {
        op: 'insert_clean', client_key: 'wash-final',
        event_time: '2026-10-01T08:00', equipment_id: lineA, note: '换线后追加已核实清洗'
      }
    ];

    // ---------- 1. 预演：预测拟停用卷（只读，不写正式库） ----------
    console.log('1) 预演：预测 LABEL-0001 将停用（已贴待复核 120），预演只读');
    let r = await api('POST', '/api/replan/preview', { changes });
    check('预演 200', r.status === 200, r);
    const v1 = r.json.version;
    const inserted1 = r.json.inserted_clean_events;
    check('拟插入清洗事件编号接续正式序列',
      inserted1.length === 1 && inserted1[0].client_key === 'wash-final' &&
      inserted1[0].event_id === maxEventId0 + 1, inserted1);
    check('预演预测拟停用卷 = [LABEL-0001/120]',
      JSON.stringify(retireList(r.json.diff.label_rolls_will_retire)) ===
      JSON.stringify([{ roll_id: roll1.id, roll_code: 'LABEL-0001', applied_pending_review: 120 }]),
      r.json.diff.label_rolls_will_retire);
    let st = (await api('GET', '/api/state')).json;
    check('预演只读：正式事件数不变、卷仍 ACTIVE',
      st.events.length === eventCount0 &&
      st.label_rolls.every((x) => x.status === 'ACTIVE'),
      { events: st.events.length, rolls: st.label_rolls.map((x) => [x.roll_code, x.status]) });

    // ---------- 2. 预演后登记新卷：旧版本确认 409，整组不落库、不占号 ----------
    console.log('2) 预演后登记新标签卷 -> 旧版本确认 409 VERSION_EXPIRED');
    r = await api('POST', '/api/label-rolls', {
      batch_id: batch3.id, release_id: release1.id,
      allergens: ['乳', '蛋', '芝麻'], print_qty: 300, registered_by: '包装组长-李雷'
    });
    check('登记新卷 LABEL-0002 成功', r.status === 200 && r.json.roll_code === 'LABEL-0002', r);
    const roll2Id = r.json.id;
    r = await api('POST', '/api/replan/apply', { version: v1, changes });
    check('携原 version 与相同 changes 确认 -> 409 VERSION_EXPIRED',
      r.status === 409 && r.json.code === 'VERSION_EXPIRED', r);
    st = (await api('GET', '/api/state')).json;
    check('整组变更未落库：无新增事件、两卷均仍 ACTIVE',
      st.events.length === eventCount0 &&
      !st.events.some((e) => e.event_time === '2026-10-01T08:00') &&
      st.label_rolls.every((x) => x.status === 'ACTIVE'),
      { events: st.events.length, rolls: st.label_rolls.map((x) => [x.roll_code, x.status]) });

    // ---------- 3. 重新预演：编号未被失败确认占用，预测含新卷 ----------
    console.log('3) 重新预演：事件编号未被占用，预测含新登记卷（已贴 0）');
    r = await api('POST', '/api/replan/preview', { changes });
    check('重新预演 200', r.status === 200, r);
    const v2 = r.json.version;
    check('拟插入事件编号不变（失败确认未占用编号）',
      r.json.inserted_clean_events.length === 1 &&
      r.json.inserted_clean_events[0].event_id === maxEventId0 + 1,
      r.json.inserted_clean_events);
    check('预测 = [LABEL-0001/120, LABEL-0002/0]',
      JSON.stringify(retireList(r.json.diff.label_rolls_will_retire)) ===
      JSON.stringify([
        { roll_id: roll1.id, roll_code: 'LABEL-0001', applied_pending_review: 120 },
        { roll_id: roll2Id, roll_code: 'LABEL-0002', applied_pending_review: 0 }
      ]), r.json.diff.label_rolls_will_retire);

    // ---------- 4. 预演后核销现有卷：旧版本确认 409 ----------
    console.log('4) 预演后核销现有卷（贴用 +10）-> 旧版本确认 409 VERSION_EXPIRED');
    r = await api('POST', `/api/label-rolls/${roll1.id}/consume`, {
      expected_revision: 2, applied: 10, voided: 0, used_by: '包装工-赵强'
    });
    check('核销成功（修订号 2 -> 3，累计贴用 130）',
      r.status === 200 && r.json.revision === 3 && r.json.applied_qty === 130, r);
    r = await api('POST', '/api/replan/apply', { version: v2, changes });
    check('旧版本确认 -> 409 VERSION_EXPIRED',
      r.status === 409 && r.json.code === 'VERSION_EXPIRED', r);
    st = (await api('GET', '/api/state')).json;
    check('整组变更仍未落库（无新增事件、卷仍 ACTIVE）',
      st.events.length === eventCount0 &&
      st.label_rolls.every((x) => x.status === 'ACTIVE'),
      { events: st.events.length });

    // ---------- 5. 重新预演：已贴待复核数量随核销更新 ----------
    console.log('5) 重新预演：LABEL-0001 已贴待复核更新为 130');
    r = await api('POST', '/api/replan/preview', { changes });
    check('重新预演 200', r.status === 200, r);
    const v3 = r.json.version;
    check('预测 = [LABEL-0001/130, LABEL-0002/0]',
      JSON.stringify(retireList(r.json.diff.label_rolls_will_retire)) ===
      JSON.stringify([
        { roll_id: roll1.id, roll_code: 'LABEL-0001', applied_pending_review: 130 },
        { roll_id: roll2Id, roll_code: 'LABEL-0002', applied_pending_review: 0 }
      ]), r.json.diff.label_rolls_will_retire);

    // ---------- 6. 预演后核销更正：旧版本确认 409 ----------
    console.log('6) 预演后核销更正（原核销 #1：100/3 -> 110/3）-> 旧版本确认 409 VERSION_EXPIRED');
    r = await api('POST', `/api/label-rolls/${roll1.id}/usages/1/corrections`, {
      expected_revision: 3, target_applied_qty: 110, target_void_qty: 3,
      corrected_by: '仓管-周九', reason: '盘点复核：贴用少录 10 张'
    });
    check('核销更正成功（修订号 3 -> 4，累计贴用 140）',
      r.status === 200 && r.json.roll.revision === 4 && r.json.roll.applied_qty === 140, r);
    r = await api('POST', '/api/replan/apply', { version: v3, changes });
    check('旧版本确认 -> 409 VERSION_EXPIRED',
      r.status === 409 && r.json.code === 'VERSION_EXPIRED', r);
    st = (await api('GET', '/api/state')).json;
    check('整组变更仍未落库（无新增事件、卷仍 ACTIVE）',
      st.events.length === eventCount0 &&
      st.label_rolls.every((x) => x.status === 'ACTIVE'),
      { events: st.events.length });

    // ---------- 7. 重新预演：已贴待复核数量随更正更新；版本/内容校验保留 ----------
    console.log('7) 重新预演：预测随更正更新为 140；版本与变更内容校验保持原有语义');
    r = await api('POST', '/api/replan/preview', { changes });
    check('重新预演 200', r.status === 200, r);
    const v4 = r.json.version;
    const predictedRetire = retireList(r.json.diff.label_rolls_will_retire);
    check('预测 = [LABEL-0001/140, LABEL-0002/0]',
      JSON.stringify(predictedRetire) ===
      JSON.stringify([
        { roll_id: roll1.id, roll_code: 'LABEL-0001', applied_pending_review: 140 },
        { roll_id: roll2Id, roll_code: 'LABEL-0002', applied_pending_review: 0 }
      ]), r.json.diff.label_rolls_will_retire);
    check('拟插入事件编号仍不变（历次失败确认均未占号）',
      r.json.inserted_clean_events[0].event_id === maxEventId0 + 1,
      r.json.inserted_clean_events);
    r = await api('POST', '/api/replan/apply', { version: v4 + 'x', changes });
    check('签名损坏 -> 400 VERSION_INVALID', r.status === 400 && r.json.code === 'VERSION_INVALID', r);
    r = await api('POST', '/api/replan/apply', {
      version: v4,
      changes: [changes[0], { ...changes[1], note: '内容被改动' }]
    });
    check('变更内容不一致 -> 409 CHANGES_MISMATCH',
      r.status === 409 && r.json.code === 'CHANGES_MISMATCH', r);

    // ---------- 8. 确认应用成功：拟停用卷及已贴待复核数量与预演逐项一致 ----------
    console.log('8) 确认应用成功：拟停用卷及已贴待复核数量与最终预演逐项一致');
    r = await api('POST', '/api/replan/apply', { version: v4, changes });
    check('确认应用 200', r.status === 200, r);
    check('应用响应 inserted_clean_events 与预演逐项一致（带键按键匹配）',
      r.json.inserted_clean_events.length === 1 &&
      r.json.inserted_clean_events[0].client_key === 'wash-final' &&
      r.json.inserted_clean_events[0].event_id === maxEventId0 + 1,
      r.json.inserted_clean_events);
    check('应用 diff.label_rolls_will_retire 与最终预演逐项一致',
      JSON.stringify(retireList(r.json.diff.label_rolls_will_retire)) ===
      JSON.stringify(predictedRetire),
      { applied: r.json.diff.label_rolls_will_retire, predicted: predictedRetire });
    check('应用响应 retired_rolls 与预演预测逐项一致（卷号与已贴待复核数量）',
      JSON.stringify(retireList(r.json.retired_rolls)) === JSON.stringify(predictedRetire),
      { retired: r.json.retired_rolls, predicted: predictedRetire });
    check('summary.label_rolls_will_retire 计数一致',
      r.json.diff.summary.label_rolls_will_retire === predictedRetire.length,
      r.json.diff.summary);
    st = (await api('GET', '/api/state')).json;
    const rollsAfter = st.label_rolls.map((x) => [x.roll_code, x.status, x.applied_qty]);
    check('正式库两卷均已 RETIRED，核销/更正后的正式数量保留（140 / 0）',
      JSON.stringify(rollsAfter.sort()) ===
      JSON.stringify([['LABEL-0001', 'RETIRED', 140], ['LABEL-0002', 'RETIRED', 0]].sort()),
      rollsAfter);
    check('拟插入清洗事件已落库且编号与预演一致',
      st.events.some((e) => e.id === maxEventId0 + 1 && e.type === 'CLEAN' &&
        e.event_time === '2026-10-01T08:00'),
      st.events.filter((e) => e.event_time >= '2026-10-01'));
    const batch3After = st.batches.find((b) => b.code === 'BATCH-003');
    check('BATCH-003 推导集合已含花生（换线生效）',
      batch3After.allergens.includes('花生'), batch3After.allergens);

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
