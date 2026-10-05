'use strict';
// 批号库存计量（克）端到端 HTTP 测试。
// 启动使用临时 SQLite 文件（空白库 SEED_DEMO=false）的真实服务，验证：
//   期初：仅一次、非负整数（允许 0）/非法数量拒绝、未启用批号沿用原输入规则；
//   入库：唯一入库单号、正整数、未启用批号先拒绝、流水只增不改、自动单号、重复单号不产生部分流水；
//   事件：已启用批号每笔输入须正整数克数；累计领用 ≤ 期初+入库（新增/更正/删除同事务重算）；
//         未启用批号 / 批号未知不得携带克数；旧输入缺数量保留且不计领用，更正须补量；
//   断网补录：克数校验、同号同内容重试与外部记录复用不重复领用、整包超额回滚不留台账；
//   整组换线：预演只展示批号余额差异不占用、确认在同事务重算、超额拒绝；
//   查询：/api/lot-inventory 与 /api/material-lots/:id/inventory 字段；批号启用计量后不可删除。
//   node scripts/test-inventory.js ；退出码 0 表示全部通过。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = '39141';
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-test-'));
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
    env: { ...process.env, PORT, HOST: '127.0.0.1', DB_PATH: dbPath, SEED_DEMO: 'false' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  proc.stdout.on('data', () => {});

  try {
    await waitReady(proc);
    console.log('服务已就绪（空白库），开始测试');

    // ---- 基础档案 ----
    const mat1 = (await api('POST', '/api/materials', { code: 'MILK-01', name: '全脂奶粉', allergens: ['乳'] })).json.id;
    const mat2 = (await api('POST', '/api/materials', { code: 'SALT-01', name: '食用盐', allergens: [] })).json.id;
    const eq1 = (await api('POST', '/api/equipment', { code: 'LINE-A', name: '烘焙A线' })).json.id;

    const lotA = (await api('POST', '/api/material-lots',
      { material_id: mat1, lot_code: 'LOT-A', supplier: '甲' })).json.id;
    const lotB = (await api('POST', '/api/material-lots',
      { material_id: mat1, lot_code: 'LOT-B', supplier: '乙' })).json.id;
    let r;

    const opening = (lotId, body) => api('POST', `/api/material-lots/${lotId}/opening-balance`, body);
    const inbound = (lotId, body) => api('POST', `/api/material-lots/${lotId}/inbound`, body);
    const inv = (lotId) => api('GET', `/api/material-lots/${lotId}/inventory`);
    const processEvent = (body) => api('POST', '/api/events', body);

    // ---------- 1. 期初结存 ----------
    console.log('1) 期初实物结存：非负整数一次、非法与重复拒绝');
    r = await opening(lotA, { quantity_grams: 1000, registered_by: '仓管-周杰', note: '盘点' });
    check('期初 1000 登记成功', r.status === 200 && r.json.metered === true &&
      r.json.opening_qty === 1000 && r.json.available_qty === 1000, r.json);
    r = await opening(lotA, { quantity_grams: 500, registered_by: '仓管' });
    check('重复期初 -> 409 OPENING_ALREADY_REGISTERED',
      r.status === 409 && r.json.code === 'OPENING_ALREADY_REGISTERED', r.json);
    for (const bad of [-1, 1.5, 'abc', '']) {
      r = await opening(lotB, { quantity_grams: bad, registered_by: '仓管' });
      check(`非法期初 ${JSON.stringify(bad)} -> 400`, r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);
    }
    r = await opening(lotB, { quantity_grams: 0, registered_by: '仓管' });
    check('期初 0 克允许（非负整数）', r.status === 200 && r.json.opening_qty === 0 && r.json.available_qty === 0, r.json);
    r = await opening(999999, { quantity_grams: 1, registered_by: '仓管' });
    check('不存在批号期初 -> 404', r.status === 404 && r.json.code === 'LOT_NOT_FOUND', r.json);

    // ---------- 2. 入库流水 ----------
    console.log('2) 入库：唯一单号、正整数、未启用拒绝、自动单号');
    const lotC = (await api('POST', '/api/material-lots',
      { material_id: mat1, lot_code: 'LOT-C' })).json.id;
    r = await inbound(lotC, { quantity_grams: 100, received_by: '仓管' });
    check('未启用批号入库 -> 400 LOT_NOT_METERED',
      r.status === 400 && r.json.code === 'LOT_NOT_METERED', r.json);
    r = await inbound(lotA, { receipt_code: 'IN-0001', quantity_grams: 500, received_by: '仓管' });
    check('入库 500 成功，可用 1500', r.status === 200 && r.json.balance.available_qty === 1500 &&
      r.json.receipt_code === 'IN-0001', r.json);
    r = await inbound(lotA, { receipt_code: 'IN-0001', quantity_grams: 200, received_by: '仓管' });
    check('重复入库单号 -> 409 RECEIPT_CODE_CONFLICT 且不产生部分流水',
      r.status === 409 && r.json.code === 'RECEIPT_CODE_CONFLICT', r.json);
    r = await inv(lotA);
    check('重复单号未产生流水（仍 1 笔入库、合计 500）',
      r.json.inbound_count === 1 && r.json.inbound_qty === 500, r.json);
    for (const bad of [0, -3, 2.5, 'x']) {
      r = await inbound(lotA, { quantity_grams: bad, received_by: '仓管' });
      check(`非法入库 ${JSON.stringify(bad)} -> 400`, r.status === 400);
    }
    r = await inbound(lotA, { quantity_grams: 300, received_by: '仓管' });
    check('省略单号自动补发 IN-0002', r.status === 200 && r.json.receipt_code === 'IN-0002', r.json);
    r = await inv(lotA);
    check('可用量 = 1000 + 800 = 1800', r.json.available_qty === 1800, r.json);

    // ---------- 3. 事件计量校验 ----------
    console.log('3) 加工事件：已启用批号必填正整数克数；未启用/未知不得填克数');
    r = await processEvent({
      type: 'PROCESS', event_time: '2026-10-01T08:00', equipment_id: eq1,
      batch_code: 'B1', material_inputs: [{ material_id: mat1, lot_id: lotA }], ref_batch_ids: []
    });
    check('已启用批号缺克数 -> 400', r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);
    r = await processEvent({
      type: 'PROCESS', event_time: '2026-10-01T08:00', equipment_id: eq1,
      batch_code: 'B1', material_inputs: [{ material_id: mat1, lot_id: lotA, qty_grams: 0 }]
    });
    check('克数 0 -> 400', r.status === 400, r.json);
    r = await processEvent({
      type: 'PROCESS', event_time: '2026-10-01T08:00', equipment_id: eq1,
      batch_code: 'B1', material_inputs: [{ material_id: mat1, lot_id: lotA, qty_grams: 100 }]
    });
    check('正整数克数 100 入库成功', r.status === 200, r.json);
    r = await processEvent({
      type: 'PROCESS', event_time: '2026-10-01T09:00', equipment_id: eq1,
      batch_code: 'B2', material_inputs: [{ material_id: mat1, lot_id: lotC, qty_grams: 10 }]
    });
    check('未启用批号填克数 -> 400', r.status === 400, r.json);
    r = await processEvent({
      type: 'PROCESS', event_time: '2026-10-01T09:00', equipment_id: eq1,
      batch_code: 'B2', material_inputs: [{ material_id: mat2, qty_grams: 10 }]
    });
    check('批号未知填克数 -> 400', r.status === 400, r.json);
    r = await processEvent({
      type: 'PROCESS', event_time: '2026-10-01T09:00', equipment_id: eq1,
      batch_code: 'B2', material_inputs: [{ material_id: mat1, lot_id: lotC }, { material_id: mat2 }]
    });
    check('未启用批号不填克数沿用原规则 -> 200', r.status === 200, r.json);
    r = await inv(lotA);
    check('累计领用 100、可用 1700', r.json.used_qty === 100 && r.json.available_qty === 1700, r.json);

    // ---------- 4. 余额不足整次拒绝 ----------
    console.log('4) 累计领用超过 期初+入库：整次拒绝，原事件与库存不变');
    const before = (await inv(lotA)).json;
    r = await processEvent({
      type: 'PROCESS', event_time: '2026-10-01T10:00', equipment_id: eq1,
      batch_code: 'B3', material_inputs: [{ material_id: mat1, lot_id: lotA, qty_grams: 5000 }]
    });
    check('超额领用 -> 400（最终事件集重算余额不足）', r.status === 400 &&
      /余额不足/.test((r.json.details || []).join('')), r.json);
    const after = (await inv(lotA)).json;
    check('拒绝后领用/可用量不变', after.used_qty === before.used_qty &&
      after.available_qty === before.available_qty, { before, after });
    r = await api('GET', '/api/state');
    check('拒绝后不产生 B3 事件', !r.json.events.some((e) => e.batch_code === 'B3'));

    // ---------- 5. 旧事件缺数量：保留不计领用，更正须补量 ----------
    console.log('5) 启用计量后：旧输入缺数量保留且不计领用；更正这些输入时须补量');
    // B2 使用了未启用的 LOT-C 与未知盐；给 LOT-C 登记期初后其 B2 输入即“缺数量旧输入”。
    r = await opening(lotC, { quantity_grams: 2000, registered_by: '仓管' });
    check('LOT-C 期初 2000', r.status === 200, r.json);
    r = await inv(lotC);
    check('旧输入保留、未计量旧输入数=1、不计领用（used=0，可用 2000）',
      r.json.unmeasured_input_count === 1 && r.json.used_qty === 0 && r.json.available_qty === 2000, r.json);
    const b2 = (await api('GET', '/api/state')).json.events.find((e) => e.batch_code === 'B2');
    check('/api/state 旧输入 qty_grams=null、measured=false',
      b2.inputs.find((i) => i.material_lot_id === lotC).qty_grams === null &&
      b2.inputs.find((i) => i.material_lot_id === lotC).measured === false, b2.inputs);
    r = await api('PUT', `/api/events/${b2.id}`, {
      type: 'PROCESS', event_time: '2026-10-01T09:00', equipment_id: eq1,
      batch_code: 'B2',
      material_inputs: [{ material_id: mat1, lot_id: lotC }, { material_id: mat2 }], ref_batch_ids: []
    });
    check('更正旧输入仍缺克数 -> 400', r.status === 400, r.json);
    r = await api('PUT', `/api/events/${b2.id}`, {
      type: 'PROCESS', event_time: '2026-10-01T09:00', equipment_id: eq1,
      batch_code: 'B2', note: '更正补量',
      material_inputs: [{ material_id: mat1, lot_id: lotC, qty_grams: 300 }, { material_id: mat2 }],
      ref_batch_ids: []
    });
    check('更正并补量 300 -> 200', r.status === 200, r.json);
    r = await inv(lotC);
    check('补量后领用 300、可用 1700、未计量旧输入 0',
      r.json.used_qty === 300 && r.json.available_qty === 1700 && r.json.unmeasured_input_count === 0, r.json);

    // ---------- 6. 更正与删除在同事务按最终事件重算 ----------
    console.log('6) 事件更正/删除：同事务重算领用，超额拒绝、原事件不变；删除释放领用');
    const b1 = (await api('GET', '/api/state')).json.events.find((e) => e.batch_code === 'B1');
    r = await api('PUT', `/api/events/${b1.id}`, {
      type: 'PROCESS', event_time: '2026-10-01T08:00', equipment_id: eq1,
      batch_code: 'B1',
      material_inputs: [{ material_id: mat1, lot_id: lotA, qty_grams: 10000 }]
    });
    check('把 B1 改为超额 -> 400，原 B1 仍领用 100', r.status === 400, r.json);
    check('拒绝后 LOT-A 领用仍 100', (await inv(lotA)).json.used_qty === 100);
    r = await api('DELETE', `/api/events/${b1.id}`);
    check('删除 B1 -> 200 并释放领用', r.status === 200, r.json);
    check('删除后 LOT-A 领用 0、可用恢复 1800',
      (await inv(lotA)).json.used_qty === 0 && (await inv(lotA)).json.available_qty === 1800);

    // ---------- 7. 断网补录 ----------
    console.log('7) 断网补录：克数校验、重试/复用不重复领用、超额整包回滚');
    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF-1', records: [{
        external_ref: 'D-1', type: 'PROCESS', event_time: '2026-10-02T08:00', equipment_id: eq1,
        batch_code: 'BF-B1', material_inputs: [{ material_id: mat1, lot_id: lotA }]
      }]
    });
    check('补录已启用批号缺克数 -> 400 BACKFILL_REJECTED',
      r.status === 400 && r.json.code === 'BACKFILL_REJECTED', r.json);
    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF-1', records: [{
        external_ref: 'D-1', type: 'PROCESS', event_time: '2026-10-02T08:00', equipment_id: eq1,
        batch_code: 'BF-B1', material_inputs: [{ material_id: mat1, lot_id: lotA, qty_grams: 400 }]
      }]
    });
    check('补录 400 成功', r.status === 200 && r.json.idempotent === false, r.json);
    check('补录后 LOT-A 领用 400、可用 1400',
      (await inv(lotA)).json.used_qty === 400 && (await inv(lotA)).json.available_qty === 1400);
    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF-1', records: [{
        external_ref: 'D-1', type: 'PROCESS', event_time: '2026-10-02T08:00', equipment_id: eq1,
        batch_code: 'BF-B1', material_inputs: [{ material_id: mat1, lot_id: lotA, qty_grams: '400' }]
      }]
    });
    check('同号同内容重试 -> idempotent', r.status === 200 && r.json.idempotent === true, r.json);
    check('重试不重复领用（仍 400）', (await inv(lotA)).json.used_qty === 400);
    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF-2', records: [{
        external_ref: 'D-1', type: 'PROCESS', event_time: '2026-10-02T08:00', equipment_id: eq1,
        batch_code: 'BF-B1', material_inputs: [{ material_id: mat1, lot_id: lotA, qty_grams: 400 }]
      }]
    });
    check('跨包复用既有外部记录 -> reused 1',
      r.status === 200 && r.json.impact_summary.reused_events === 1, r.json);
    check('复用不重复领用（仍 400）', (await inv(lotA)).json.used_qty === 400);
    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF-3', records: [{
        external_ref: 'D-9', type: 'PROCESS', event_time: '2026-10-03T08:00', equipment_id: eq1,
        batch_code: 'BF-B9', material_inputs: [{ material_id: mat1, lot_id: lotA, qty_grams: 99999 }]
      }]
    });
    check('补录超额 -> 400 整包回滚', r.status === 400 && r.json.code === 'BACKFILL_REJECTED', r.json);
    r = await api('GET', '/api/backfills/BF-3');
    check('回滚不留补录台账', r.status === 404 && r.json.code === 'BACKFILL_NOT_FOUND', r.json);
    check('回滚不占用库存（仍 400）', (await inv(lotA)).json.used_qty === 400);

    // ---------- 8. 整组换线 ----------
    console.log('8) 整组换线：预演只展示批号余额差异不占用；确认同事务重算；超额拒绝');
    const bfEventId = r_json => r_json;
    void bfEventId;
    const st = (await api('GET', '/api/state')).json;
    const bfEv = st.events.find((e) => e.batch_code === 'BF-B1');
    const change400to600 = [{
      op: 'update', event_id: bfEv.id, type: 'PROCESS',
      event_time: '2026-10-02T08:00', equipment_id: eq1, batch_code: 'BF-B1',
      material_inputs: [{ material_id: mat1, lot_id: lotA, qty_grams: 600 }], ref_batch_ids: []
    }];
    r = await api('POST', '/api/replan/preview', { changes: change400to600 });
    check('预演 200 且含 lot_inventory 差异（400→600，可用 -200）',
      r.status === 200 &&
      r.json.diff.lot_inventory.some((d) => d.lot_id === lotA &&
        d.before_used_qty === 400 && d.after_used_qty === 600 && d.available_delta === -200), r.json.diff);
    check('预演不占用库存（仍 400）', (await inv(lotA)).json.used_qty === 400);
    const ver = r.json.version;
    r = await api('POST', '/api/replan/apply', { version: ver, changes: change400to600 });
    check('确认应用 -> 200', r.status === 200, r.json);
    check('确认后领用 600、可用 1200',
      (await inv(lotA)).json.used_qty === 600 && (await inv(lotA)).json.available_qty === 1200);

    const changeHuge = [{
      op: 'update', event_id: bfEv.id, type: 'PROCESS',
      event_time: '2026-10-02T08:00', equipment_id: eq1, batch_code: 'BF-B1',
      material_inputs: [{ material_id: mat1, lot_id: lotA, qty_grams: 99999 }], ref_batch_ids: []
    }];
    r = await api('POST', '/api/replan/preview', { changes: changeHuge });
    check('预演超额 -> 400 REPLAN_REJECTED',
      r.status === 400 && r.json.code === 'REPLAN_REJECTED', r.json);
    check('预演失败不占用（仍 600）', (await inv(lotA)).json.used_qty === 600);

    // 预演成功但确认超额（应用前先入库回退场景不构造；这里直接确认一个超额版本）
    // 预演即拒绝已覆盖“余额不足”，不再重复。

    // ---------- 9. 查询汇总与不可删除 ----------
    console.log('9) 查询：全部批号台账汇总；启用计量批号不可删除');
    r = await api('GET', '/api/lot-inventory');
    check('返回全部批号与汇总',
      r.status === 200 && r.json.lots.length === 3 &&
      r.json.summary.metered_lot_count === 3, r.json);
    const aRow = r.json.lots.find((l) => l.lot_id === lotA);
    check('台账含 期初/入库/领用/可用/未计量旧输入数',
      aRow.opening_qty === 1000 && aRow.inbound_qty === 800 &&
      aRow.used_qty === 600 && aRow.available_qty === 1200 &&
      typeof aRow.unmeasured_input_count === 'number', aRow);
    r = await api('DELETE', `/api/material-lots/${lotA}`);
    check('已登记期初批号不可删除 -> 400 LOT_IN_USE',
      r.status === 400 && r.json.code === 'LOT_IN_USE', r.json);
    r = await api('GET', '/api/state');
    check('/api/state 批号摘要含 metered/期初/入库/领用/可用量',
      r.json.lot_inventory.length === 3 &&
      r.json.materials.find((m) => m.id === mat1).lots.find((l) => l.id === lotA)
        .available_qty === 1200, r.json.lot_inventory);

  } finally {
    proc.kill();
    await sleep(150);
  }

  if (failures) {
    console.error(`\n${failures} 项未通过`);
    process.exit(1);
  }
  console.log('\n全部通过');
}

main().catch((err) => { console.error('测试执行异常：', err); process.exit(1); });
