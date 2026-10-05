'use strict';
// 核销更正：端到端 HTTP 测试。
// 启动使用临时 SQLite 文件的真实服务实例（含演示数据），逐条验证：
//   更正成功：目标贴用/作废（非负整数，允许均 0）、卷累计按各笔最新有效数量重算、
//     修订号每次成功 +1、剩余量同步；原核销与每次更正均留不可改流水、更正链与最新有效数量可查；
//   整次拒绝（不推进修订号）：未知/跨卷原核销、非法数量、缺原因、旧修订号、
//     body.usage_id 与路径不一致；
//   业务约束：更正后累计贴用不得低于已分配出货张数（历史出货分配/快照不改）、
//     贴用+作废不得超过印量（边界恰好相等允许）；
//   卷状态：永久停用卷、质量隔离暂停贴用期间不可更正，解除隔离后恢复；
//   兼容：既有核销接口语义不变、/api/state 卷字段不变（另附 usages）、可出货余额按
//     最新有效数量同步更新。
//   node scripts/test-label-corrections.js
// 退出码 0 表示全部通过。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = '39147';
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'label-corr-test-'));
const dbPath = path.join(tmpDir, 'test.db');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
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

async function main() {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, PORT, HOST: '127.0.0.1', DB_PATH: dbPath, SEED_DEMO: 'true' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  try {
    await waitReady(proc);
    console.log('服务已就绪，开始测试');

    const state0 = (await api('GET', '/api/state')).json;
    const b3 = state0.batches.find((b) => b.code === 'BATCH-003');
    const rel3 = b3.releases.find((r) => r.status === 'ACTIVE').id;
    const set3 = ['蛋', '乳', '芝麻'];
    const milkLotB = state0.materials.find((m) => m.code === 'MILK-01').lots
      .find((l) => l.lot_code === 'SUP-MILK-20260926-B').id;

    // ---------- 1. 准备：新卷 + 两笔核销 ----------
    console.log('1) 准备卷：印 100，两笔核销 60/5（rev0→1）、10/5（rev1→2），累计 70/10');
    let r = await api('POST', '/api/label-rolls', {
      batch_id: b3.id, release_id: rel3, allergens: set3, print_qty: 100, registered_by: '甲'
    });
    check('登记成功', r.status === 200, r.json);
    const rollId = r.json.id;
    r = await api('POST', `/api/label-rolls/${rollId}/consume`,
      { expected_revision: 0, applied: 60, voided: 5, used_by: '包装工' });
    check('核销 60/5 成功 rev→1',
      r.status === 200 && r.json.applied_qty === 60 && r.json.void_qty === 5 && r.json.revision === 1, r.json);
    r = await api('POST', `/api/label-rolls/${rollId}/consume`,
      { expected_revision: 1, applied: 10, voided: 5, used_by: '包装工' });
    check('核销 10/5 成功 rev→2',
      r.status === 200 && r.json.applied_qty === 70 && r.json.void_qty === 10 &&
      r.json.remaining_qty === 20 && r.json.revision === 2, r.json);
    r = await api('GET', `/api/label-rolls/${rollId}/usages`);
    check('流水查询返回 2 笔', r.status === 200 && r.json.usages.length === 2, r.json);
    const usage1 = r.json.usages[0];
    const usage2 = r.json.usages[1];
    check('无更正时最新有效数量=原始数量',
      usage1.applied_qty === 60 && usage1.void_qty === 5 &&
      usage1.corrected === false && usage1.correction_count === 0 &&
      usage1.corrections.length === 0, usage1);
    check('state 卷对象内嵌 usages 且既有字段保留',
      await (async () => {
        const rr = (await api('GET', '/api/state')).json.label_rolls.find((x) => x.id === rollId);
        return rr && Array.isArray(rr.usages) && rr.usages.length === 2 &&
          rr.applied_qty === 70 && rr.void_qty === 10 && rr.remaining_qty === 20;
      })());

    // ---------- 2. 更正成功：累计按最新有效数量重算、修订号前进 ----------
    console.log('2) 更正 usage1 60/5 → 55/8：累计 65/13，剩 22，rev→3');
    r = await api('POST', `/api/label-rolls/${rollId}/usages/${usage1.id}/corrections`, {
      expected_revision: 2, target_applied_qty: 55, target_void_qty: 8,
      corrected_by: '仓管-周九', reason: '盘点复核：贴用多录5、作废少录3'
    });
    check('200 且返回 roll/usage/correction',
      r.status === 200 && r.json.roll && r.json.usage && r.json.correction, r.json);
    check('卷累计 65/13、剩 22、rev3',
      r.json.roll.applied_qty === 65 && r.json.roll.void_qty === 13 &&
      r.json.roll.remaining_qty === 22 && r.json.roll.revision === 3, r.json.roll);
    check('该笔最新有效数量 55/8，更正链 seq1',
      r.json.usage.applied_qty === 55 && r.json.usage.void_qty === 8 &&
      r.json.usage.original_applied_qty === 60 && r.json.usage.original_void_qty === 5 &&
      r.json.usage.correction_count === 1 && r.json.correction.seq === 1 &&
      r.json.correction.reason.includes('盘点复核'), r.json.usage);

    // ---------- 3. 同一笔再次更正：以最新有效数量为基线 ----------
    console.log('3) 再次更正同一笔 55/8 → 50/0：以最新有效数量为基线，rev→4');
    r = await api('POST', `/api/label-usages/${usage1.id}/corrections`, {
      expected_revision: 3, target_applied_qty: 50, target_void_qty: 0,
      operator: '仓管-周九', reason: '二次复核：8 张作废为误判，贴用再核减5'
    });
    check('无卷作用域端点更正成功，累计 60/5、剩 35、rev4',
      r.status === 200 && r.json.roll.applied_qty === 60 && r.json.roll.void_qty === 5 &&
      r.json.roll.remaining_qty === 35 && r.json.roll.revision === 4, r.json.roll);
    r = await api('GET', `/api/label-usages/${usage1.id}`);
    check('单笔查询展示完整更正链（2 条，只增不改）',
      r.status === 200 && r.json.correction_count === 2 &&
      r.json.corrections[0].target_applied_qty === 55 &&
      r.json.corrections[1].target_applied_qty === 50 &&
      r.json.corrections[1].target_void_qty === 0 &&
      r.json.original_applied_qty === 60 && r.json.applied_qty === 50, r.json);

    // ---------- 4. 旧修订号整次拒绝且不推进 ----------
    console.log('4) 旧修订号 / 非法数量 / 缺原因 / body 不一致：整次拒绝');
    r = await api('POST', `/api/label-rolls/${rollId}/usages/${usage1.id}/corrections`, {
      expected_revision: 3, target_applied_qty: 50, target_void_qty: 0, reason: 'x'
    });
    check('旧修订号 → 409 REVISION_MISMATCH',
      r.status === 409 && r.json.code === 'REVISION_MISMATCH', r.json);
    for (const bad of [-1, 1.5, 'abc', null]) {
      r = await api('POST', `/api/label-rolls/${rollId}/usages/${usage1.id}/corrections`, {
        expected_revision: 4, target_applied_qty: bad, target_void_qty: 0, reason: 'x'
      });
      check(`目标贴用 ${JSON.stringify(bad)} → 400`,
        r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);
    }
    r = await api('POST', `/api/label-rolls/${rollId}/usages/${usage1.id}/corrections`, {
      expected_revision: 4, target_applied_qty: 50, target_void_qty: 0
    });
    check('缺原因 → 400', r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);
    r = await api('POST', `/api/label-rolls/${rollId}/usages/${usage1.id}/corrections`, {
      expected_revision: 4, target_applied_qty: 50, target_void_qty: 0,
      reason: 'x', usage_id: usage2.id
    });
    check('body.usage_id 与路径不一致 → 400 USAGE_MISMATCH',
      r.status === 400 && r.json.code === 'USAGE_MISMATCH', r.json);
    r = await api('GET', `/api/label-rolls/${rollId}/usages`);
    check('拒绝后修订号与数量不变（仍 rev4、有效 50/0）',
      r.json.usages[0].applied_qty === 50 && r.json.usages[0].void_qty === 0 &&
      r.json.usages[0].correction_count === 2, r.json.usages[0]);

    // ---------- 5. 未知 / 跨卷原核销 ----------
    console.log('5) 未知原核销 404；跨卷 400 USAGE_CROSS_ROLL');
    r = await api('POST', `/api/label-rolls/${rollId}/usages/99999/corrections`, {
      expected_revision: 4, target_applied_qty: 1, target_void_qty: 0, reason: 'x'
    });
    check('未知原核销 → 404 USAGE_NOT_FOUND',
      r.status === 404 && r.json.code === 'USAGE_NOT_FOUND', r.json);
    const demoRollId = state0.label_rolls.find((x) => x.roll_code === 'LABEL-0001').id;
    r = await api('POST', `/api/label-rolls/${demoRollId}/usages/${usage1.id}/corrections`, {
      expected_revision: 2, target_applied_qty: 50, target_void_qty: 0, reason: 'x'
    });
    check('跨卷核销 → 400 USAGE_CROSS_ROLL',
      r.status === 400 && r.json.code === 'USAGE_CROSS_ROLL', r.json);
    r = await api('GET', `/api/label-usages/99999`);
    check('单笔查询未知核销 → 404', r.status === 404, r.json);

    // ---------- 6. 印量约束：超印量拒绝、恰好印量允许 ----------
    console.log('6) 更正后贴用+作废超过印量 → 409；恰好等于印量允许');
    // 当前有效：u1 50/0，u2 10/5，累计 60/5（65）。u1 改 50/40 → 合计 105 > 100。
    r = await api('POST', `/api/label-rolls/${rollId}/usages/${usage1.id}/corrections`, {
      expected_revision: 4, target_applied_qty: 50, target_void_qty: 40, reason: 'x'
    });
    check('合计 105 > 印量 100 → 409 OVER_LIMIT',
      r.status === 409 && r.json.code === 'OVER_LIMIT', r.json);
    // u1 改 50/35 → 50+10 贴=60，作废 35+5=40，合计 100 恰好。
    r = await api('POST', `/api/label-rolls/${rollId}/usages/${usage1.id}/corrections`, {
      expected_revision: 4, target_applied_qty: 50, target_void_qty: 35, reason: '贴满边界'
    });
    check('合计恰好 100 → 成功，剩 0，rev→5',
      r.status === 200 && r.json.roll.remaining_qty === 0 && r.json.roll.revision === 5,
      r.json.roll);
    // 目标均为 0 允许（非负整数）：u1 0/0 → 合计 贴10 作废5，但本卷无出货分配，故成功。
    r = await api('POST', `/api/label-rolls/${rollId}/usages/${usage1.id}/corrections`, {
      expected_revision: 5, target_applied_qty: 0, target_void_qty: 0, reason: '整笔冲回'
    });
    check('目标均为 0（无分配约束时）允许：累计 10/5，rev→6',
      r.status === 200 && r.json.roll.applied_qty === 10 && r.json.roll.void_qty === 5 &&
      r.json.roll.revision === 6, r.json.roll);

    // ---------- 7. 已分配出货约束 + 历史快照不改 + 可出货余额同步 ----------
    console.log('7) 出货分配后：累计贴用不得低于已分配张数；历史出货与快照不改；余额同步');
    // 恢复 u1 有效 50/0（当前 u1 0/0，u2 10/5 → 累计 10/5 rev6）。
    r = await api('POST', `/api/label-rolls/${rollId}/usages/${usage1.id}/corrections`, {
      expected_revision: 6, target_applied_qty: 50, target_void_qty: 0, reason: '恢复'
    });
    check('恢复 u1 50/0：累计 60/5，rev→7', r.status === 200 && r.json.roll.revision === 7, r.json);
    // 出货 40 张（全部从本卷分配）。
    r = await api('POST', '/api/shipments', {
      batch_id: b3.id, ship_qty: 40, shipped_by: '仓管',
      allocations: [{ roll_id: rollId, qty: 40 }]
    });
    check('出货 40 张成功', r.status === 200 && r.json.shipment_code === 'SHIP-0002', r.json);
    const shipmentId = r.json.id;
    // u1 改 25/0 → 累计贴用 25+10=35 < 40 → 拒绝。
    r = await api('POST', `/api/label-rolls/${rollId}/usages/${usage1.id}/corrections`, {
      expected_revision: 7, target_applied_qty: 25, target_void_qty: 0, reason: 'x'
    });
    check('累计贴用 35 < 已分配 40 → 409 APPLIED_BELOW_ALLOCATED',
      r.status === 409 && r.json.code === 'APPLIED_BELOW_ALLOCATED', r.json);
    // 边界：u1 30/0 → 累计 40 == 分配 40，允许。
    r = await api('POST', `/api/label-rolls/${rollId}/usages/${usage1.id}/corrections`, {
      expected_revision: 7, target_applied_qty: 30, target_void_qty: 0, reason: '核减到出货底线'
    });
    check('累计贴用恰好 40 → 成功 rev→8',
      r.status === 200 && r.json.roll.applied_qty === 40 && r.json.roll.revision === 8, r.json.roll);
    r = await api('GET', `/api/shipments/${shipmentId}`);
    check('历史出货分配与快照不改（仍 40 张、修订号快照停留在出货当时）',
      r.status === 200 && r.json.items[0].qty === 40 &&
      r.json.items[0].roll_revision === 7, r.json.items);
    r = await api('GET', `/api/batches/${b3.id}/shipment-balance`);
    const bal = r.json.rolls.find((x) => x.roll_id === rollId);
    check('可出货余额按最新有效数量同步：贴40 - 已分配40 = 0',
      r.status === 200 && bal.applied_qty === 40 && bal.allocated_qty === 40 &&
      bal.available_qty === 0, bal);

    // ---------- 8. 质量隔离：暂停更正，解除后恢复 ----------
    console.log('8) 质量隔离生效期间不可更正（409 ROLL_QUARANTINED，修订号不前进）');
    r = await api('POST', '/api/quarantine-orders', {
      lot_id: milkLotB, reason: '供应商通报异常，隔离待查', issued_by: 'QA',
      issued_at: '2026-10-02T09:00'
    });
    check('签发隔离令', r.status === 200 && r.json.ok, r.json);
    const qid = r.json.order.id;
    r = await api('POST', `/api/label-rolls/${rollId}/usages/${usage1.id}/corrections`, {
      expected_revision: 8, target_applied_qty: 35, target_void_qty: 0, reason: '隔离期间'
    });
    check('受控期间更正 → 409 ROLL_QUARANTINED',
      r.status === 409 && r.json.code === 'ROLL_QUARANTINED', r.json);
    r = await api('GET', `/api/label-rolls/${rollId}/usages`);
    check('拒绝后修订号不前进（有效仍 30/0，更正链条数不变）',
      r.json.usages[0].applied_qty === 30 &&
      r.json.usages[0].corrections[r.json.usages[0].corrections.length - 1].target_applied_qty === 30,
      r.json.usages[0]);
    r = await api('POST', `/api/quarantine-orders/${qid}/lift`, {
      lifted_by: 'QA', lift_reason: '排查无异常', lifted_at: '2026-10-02T12:00'
    });
    check('解除隔离', r.status === 200 && r.json.ok, r.json);
    r = await api('POST', `/api/label-rolls/${rollId}/usages/${usage1.id}/corrections`, {
      expected_revision: 8, target_applied_qty: 35, target_void_qty: 0, reason: '解除后更正'
    });
    check('解除后更正恢复成功 rev→9',
      r.status === 200 && r.json.roll.revision === 9 && r.json.roll.applied_qty === 45, r.json.roll);

    // ---------- 9. 永久停用卷不可更正 ----------
    console.log('9) 永久停用卷不可更正（409 ROLL_RETIRED，流水仍可查）');
    r = await api('DELETE', `/api/releases/${rel3}`);
    check('删除放行 200，本卷被停用',
      r.status === 200 && r.json.retired_rolls.some((x) => x.id === rollId), r.json);
    r = await api('POST', `/api/label-rolls/${rollId}/usages/${usage1.id}/corrections`, {
      expected_revision: 9, target_applied_qty: 40, target_void_qty: 0, reason: '停用后'
    });
    check('停用卷更正 → 409 ROLL_RETIRED',
      r.status === 409 && r.json.code === 'ROLL_RETIRED', r.json);
    r = await api('GET', `/api/label-rolls/${rollId}/usages`);
    check('停用后流水与更正链仍可查、数量停留在最后有效值',
      r.status === 200 && r.json.usages[0].applied_qty === 35, r.json.usages[0]);

    // ---------- 10. 既有核销接口语义保持兼容 ----------
    console.log('10) 既有核销接口语义不变（新放行 + 新卷上验证旧修订号/超量拒绝）');
    // rel3 已在第 9 步删除：先登记新的有效放行与新卷。
    r = await api('POST', '/api/releases',
      { batch_id: b3.id, released_at: '2026-10-02T15:00', released_by: '复核员' });
    check('更正后可重新登记有效放行', r.status === 200, r.json);
    const newRel = r.json.id;
    r = await api('POST', '/api/label-rolls', {
      batch_id: b3.id, release_id: newRel, allergens: set3, print_qty: 50, registered_by: '乙'
    });
    check('新卷登记成功', r.status === 200 && r.json.roll_code === 'LABEL-0003', r.json);
    const freshRoll = r.json.id;
    r = await api('POST', `/api/label-rolls/${freshRoll}/consume`,
      { expected_revision: 0, applied: 10, voided: 0, used_by: '包装工' });
    check('既有核销正常成功 rev→1', r.status === 200 && r.json.revision === 1, r.json);
    r = await api('POST', `/api/label-rolls/${freshRoll}/consume`,
      { expected_revision: 0, applied: 1, voided: 0 });
    check('既有核销旧修订号仍 409 REVISION_MISMATCH',
      r.status === 409 && r.json.code === 'REVISION_MISMATCH', r.json);
    r = await api('POST', `/api/label-rolls/${freshRoll}/consume`,
      { expected_revision: 1, applied: 999, voided: 0 });
    check('既有核销超印量仍 409 OVER_LIMIT',
      r.status === 409 && r.json.code === 'OVER_LIMIT', r.json);
    // 演示卷已随放行删除停用：核销仍按 ROLL_RETIRED 拒绝。
    const demo = (await api('GET', '/api/state')).json.label_rolls
      .find((x) => x.roll_code === 'LABEL-0001');
    r = await api('POST', `/api/label-rolls/${demo.id}/consume`,
      { expected_revision: demo.revision, applied: 1, voided: 0 });
    check('停用演示卷核销仍 409 ROLL_RETIRED',
      r.status === 409 && r.json.code === 'ROLL_RETIRED', r.json);

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
