'use strict';
// 原料供应批号库存计量（克）。
//
// 仓管可为“已有”原料供应批号登记一次非负整数克数的期初实物结存（每批号至多一次），
// 并以唯一入库单号登记后续正整数克数入库；启用计量（期初登记）后的入库流水只增不改。
//
// 计量规则（与 validation.js 的全量校验配合）：
//   - 已登记期初的批号视为“已启用计量”：此后新增、断网补录或更正加工事件时，
//     该批号的每笔原料输入都必须填写正整数克数（qty_grams）；
//     按批号累计领用（所有现存事件输入克数之和）不得超过「期初 + 入库」。
//   - 未启用计量的批号沿用原输入规则（不填克数）；批号未知的输入同样不填克数。
//   - 旧事件中缺少数量的输入原样保留且不计入领用；更正这些输入时必须补量。
// 事件删除 / 更正 / 整组换线确认在同一事务中按“最终事件集”重算领用，
// 余额不足整次拒绝、原事件与库存不变；换线预演只展示各批号余额差异、不占用库存。
// 断网补录同内容重试或复用既有外部记录不重复领用（不重复写入即不重复占用）。

const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

class InventoryError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'InventoryError';
    this.code = code;
    this.details = details || [];
  }
}

// 严格非负整数（0 允许）：数字或纯数字字符串均可；1.5、负数、空白一律非法。
function parseNonNegInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
  return NaN;
}
function nonNegGrams(v, field) {
  const n = parseNonNegInt(v);
  if (!Number.isInteger(n) || n < 0) {
    throw new InventoryError('INVALID_REQUEST', `${field}必须是非负整数克数（允许 0）`);
  }
  if (n > 1e12) throw new InventoryError('INVALID_REQUEST', `${field}超出允许范围`);
  return n;
}
function posGrams(v, field) {
  const n = parseNonNegInt(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new InventoryError('INVALID_REQUEST', `${field}必须是大于 0 的正整数克数`);
  }
  if (n > 1e12) throw new InventoryError('INVALID_REQUEST', `${field}超出允许范围`);
  return n;
}

function parseTime(v, field) {
  const t = String(v || '').trim();
  if (!t) return '';
  if (!TIME_RE.test(t)) {
    throw new InventoryError('INVALID_REQUEST', `${field}格式应为 YYYY-MM-DDTHH:MM，例如 2026-10-01T08:00`);
  }
  return t;
}

// ---------- 批号档案读取 ----------
function getLotRow(db, lotId) {
  return db.prepare(
    `SELECT l.id, l.lot_code, l.material_id, m.code AS material_code, m.name AS material_name
       FROM material_lots l JOIN materials m ON m.id = l.material_id
      WHERE l.id = ?`
  ).get(lotId);
}

// 已启用计量的批号 id 集合（已登记期初结存）。
function meteredLotIds(db) {
  return new Set(db.prepare('SELECT lot_id FROM lot_opening_balances').all().map((r) => r.lot_id));
}

function getOpening(db, lotId) {
  return db.prepare(
    `SELECT id, lot_id, quantity_grams, registered_by, registered_at, note, created_at
       FROM lot_opening_balances WHERE lot_id = ?`
  ).get(lotId) || null;
}

function listInbound(db, lotId) {
  return db.prepare(
    `SELECT id, receipt_code, lot_id, quantity_grams, received_by, received_at, note, created_at
       FROM lot_inbound_receipts WHERE lot_id = ? ORDER BY id`
  ).all(lotId == null ? null : lotId);
}

function inboundTotal(db, lotId) {
  return db.prepare(
    'SELECT COALESCE(SUM(quantity_grams),0) AS total, COUNT(*) AS c FROM lot_inbound_receipts WHERE lot_id = ?'
  ).get(lotId).total;
}

// 该批号累计领用克数：仅统计填写了正整数克数的输入；旧输入 NULL 不计入。
function usedTotal(db, lotId) {
  return db.prepare(
    `SELECT COALESCE(SUM(qty_grams),0) AS total
       FROM process_inputs pi JOIN events ev ON ev.id = pi.event_id
      WHERE pi.material_lot_id = ? AND pi.qty_grams IS NOT NULL`
  ).get(lotId).total;
}

// 未计量旧输入数：引用该批号但缺少克数的原料输入行数。
//   已启用计量批号 = 启用前遗留、尚未更正补量的旧输入；
//   未启用计量批号 = 其全部输入（沿用原输入规则，均无数量）。
function unmeasuredCount(db, lotId) {
  return db.prepare(
    'SELECT COUNT(*) AS c FROM process_inputs WHERE material_lot_id = ? AND qty_grams IS NULL'
  ).get(lotId).c;
}

// ---------- 台账读取模型 ----------
function formatOpening(o) {
  return o ? {
    id: o.id,
    quantity_grams: o.quantity_grams,
    registered_by: o.registered_by,
    registered_at: o.registered_at,
    note: o.note,
    created_at: o.created_at
  } : null;
}

function formatInbound(r) {
  return {
    id: r.id,
    receipt_code: r.receipt_code,
    quantity_grams: r.quantity_grams,
    received_by: r.received_by,
    received_at: r.received_at,
    note: r.note,
    created_at: r.created_at
  };
}

// 单批号台账（写入后回读用）。
function lotBalanceFromRow(lot, opening, inboundRows, usedQty, unmeasured) {
  const opening_qty = opening ? opening.quantity_grams : null;
  const inbound_qty = opening ? inboundRows.reduce((s, r) => s + r.quantity_grams, 0) : null;
  const used_qty = opening ? usedQty : 0;
  return {
    lot_id: lot.id,
    lot_code: lot.lot_code,
    material_id: lot.material_id,
    material_code: lot.material_code,
    material_name: lot.material_name,
    metered: opening !== null,
    opening_qty,                                  // 期初（未启用为 null）
    inbound_qty: opening ? inbound_qty : null,    // 入库合计（未启用为 null）
    used_qty,                                     // 领用合计（旧输入不计入）
    available_qty: opening
      ? opening.quantity_grams + inbound_qty - used_qty
      : null,                                     // 可用量（未启用为 null）
    unmeasured_input_count: unmeasured,
    opening: formatOpening(opening),
    inbound: inboundRows.map(formatInbound),
    inbound_count: inboundRows.length
  };
}

// ---------- 单批号台账 ----------
function lotBalance(db, lotId) {
  const lot = getLotRow(db, lotId);
  if (!lot) return null;
  const opening = getOpening(db, lotId);
  const inboundRows = listInbound(db, lotId);
  const usedQty = opening ? usedTotal(db, lotId) : 0;
  return lotBalanceFromRow(lot, opening, inboundRows, usedQty, unmeasuredCount(db, lotId));
}

// 全部批号台账（按原料/批号排序）。
// 成批取数：批号档案、期初、入库、按批号领用与未计量输入各一条 SQL，
// 查询数固定（不随供应批号数量逐笔增长）；输出形状与逐批号 lotBalance 完全一致。
function allBalances(db) {
  const lotRows = db.prepare(
    `SELECT l.id, l.lot_code, l.material_id, m.code AS material_code, m.name AS material_name
       FROM material_lots l JOIN materials m ON m.id = l.material_id
      ORDER BY l.id`
  ).all();
  const openingByLot = new Map(
    db.prepare(
      `SELECT id, lot_id, quantity_grams, registered_by, registered_at, note, created_at
         FROM lot_opening_balances`
    ).all().map((o) => [o.lot_id, o])
  );
  const inboundByLot = new Map();
  db.prepare(
    `SELECT id, receipt_code, lot_id, quantity_grams, received_by, received_at, note, created_at
       FROM lot_inbound_receipts ORDER BY id`
  ).all().forEach((r) => {
    if (!inboundByLot.has(r.lot_id)) inboundByLot.set(r.lot_id, []);
    inboundByLot.get(r.lot_id).push(r);
  });
  // 已计量领用按批号合计（仅统计填写了克数的输入；旧输入 NULL 不计入）。
  const usedByLot = new Map(
    db.prepare(
      `SELECT pi.material_lot_id AS lot_id, COALESCE(SUM(pi.qty_grams),0) AS total
         FROM process_inputs pi JOIN events ev ON ev.id = pi.event_id
        WHERE pi.material_lot_id IS NOT NULL AND pi.qty_grams IS NOT NULL
        GROUP BY pi.material_lot_id`
    ).all().map((r) => [r.lot_id, r.total])
  );
  // 未计量旧输入按批号计数（引用该批号但缺少克数的原料输入行）。
  const unmeasuredByLot = new Map(
    db.prepare(
      `SELECT material_lot_id AS lot_id, COUNT(*) AS c
         FROM process_inputs
        WHERE material_lot_id IS NOT NULL AND qty_grams IS NULL
        GROUP BY material_lot_id`
    ).all().map((r) => [r.lot_id, r.c])
  );

  const lotBalances = lotRows.map((lot) => lotBalanceFromRow(
    lot,
    openingByLot.get(lot.id) || null,
    inboundByLot.get(lot.id) || [],
    usedByLot.get(lot.id) || 0,
    unmeasuredByLot.get(lot.id) || 0
  ));
  lotBalances.sort((a, b) =>
    a.material_code.localeCompare(b.material_code, 'zh') ||
    a.lot_code.localeCompare(b.lot_code, 'zh'));
  // 全部“缺少数量的原料输入”：未启用批号的输入 + 已启用批号启用前的旧输入 + 批号未知输入。
  const unmeasuredTotal = db.prepare(
    `SELECT COUNT(*) AS c FROM process_inputs
      WHERE material_id IS NOT NULL AND qty_grams IS NULL`
  ).get().c;
  return {
    lots: lotBalances,
    summary: {
      lot_count: lotBalances.length,
      metered_lot_count: lotBalances.filter((l) => l.metered).length,
      unmeasured_input_count: unmeasuredTotal
    }
  };
}

// ---------- 期初实物结存（每批号一次，非负整数克） ----------
function registerOpening(db, lotId, body) {
  body = body || {};
  const lot = getLotRow(db, lotId);
  if (!lot) throw new InventoryError('LOT_NOT_FOUND', `供应批号 #${lotId} 不存在`);

  const q = nonNegGrams(body.quantity_grams, '期初实物结存');
  const registered_by = String(body.registered_by || body.operator || '').trim();
  if (!registered_by) {
    throw new InventoryError('INVALID_REQUEST', '请录入登记操作人 registered_by');
  }
  const registered_at = parseTime(body.registered_at, '登记时间')
    || new Date().toISOString().slice(0, 16);
  const note = String(body.note || '').trim();

  try {
    db.prepare(
      `INSERT INTO lot_opening_balances (lot_id, quantity_grams, registered_by, registered_at, note)
       VALUES (?,?,?,?,?)`
    ).run(lotId, q, registered_by, registered_at, note);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      throw new InventoryError(
        'OPENING_ALREADY_REGISTERED',
        `供应批号 ${lot.lot_code}（${lot.material_code}）已登记过期初实物结存，` +
        '期初结存每批号只能登记一次；后续到货请登记入库单',
        [`lot_id=${lotId}`]
      );
    }
    throw err;
  }
  return lotBalance(db, lotId);
}

// ---------- 入库（唯一入库单号，正整数克；流水只增不改） ----------
function createInbound(db, lotId, body) {
  body = body || {};
  const lot = getLotRow(db, lotId);
  if (!lot) throw new InventoryError('LOT_NOT_FOUND', `供应批号 #${lotId} 不存在`);
  if (!getOpening(db, lotId)) {
    throw new InventoryError(
      'LOT_NOT_METERED',
      `供应批号 ${lot.lot_code}（${lot.material_code}）尚未登记期初实物结存（未启用计量）：` +
      '请先登记一次期初实物结存，再登记入库单',
      [`lot_id=${lotId}`]
    );
  }

  const q = posGrams(body.quantity_grams, '入库克数');
  const received_by = String(body.received_by || body.operator || '').trim();
  if (!received_by) {
    throw new InventoryError('INVALID_REQUEST', '请录入入库操作人 received_by');
  }
  const received_at = parseTime(body.received_at, '入库时间')
    || new Date().toISOString().slice(0, 16);
  const note = String(body.note || '').trim();

  let receipt_code = String(body.receipt_code || body.code || '').trim();
  let generated = false;
  if (!receipt_code) {
    generated = true;
  } else if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(receipt_code)) {
    throw new InventoryError(
      'INVALID_REQUEST',
      '入库单号仅允许字母、数字、点、下划线、冒号与连字符，且以字母或数字开头'
    );
  }

  // 单号重复在写入时由 UNIQUE 兜底；服务端补发 IN-0001 形态单号（事务内取最大号）。
  let receiptId;
  const tx = db.transaction(() => {
    if (generated) {
      const maxNum = db.prepare(
        `SELECT COALESCE(MAX(CAST(SUBSTR(receipt_code, 4) AS INTEGER)), 0) AS m
           FROM lot_inbound_receipts WHERE receipt_code LIKE 'IN-%'`
      ).get().m;
      receipt_code = `IN-${String(maxNum + 1).padStart(4, '0')}`;
    }
    try {
      receiptId = db.prepare(
        `INSERT INTO lot_inbound_receipts
           (receipt_code, lot_id, quantity_grams, received_by, received_at, note)
         VALUES (?,?,?,?,?,?)`
      ).run(receipt_code, lotId, q, received_by, received_at, note).lastInsertRowid;
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        throw new InventoryError(
          'RECEIPT_CODE_CONFLICT',
          `入库单号 "${receipt_code}" 已存在：入库单号必须唯一，整次拒绝、不产生入库流水`,
          [`receipt_code=${receipt_code}`]
        );
      }
      throw err;
    }
  });
  tx();

  return {
    ok: true,
    id: receiptId,
    receipt_code,
    lot_id: lotId,
    lot_code: lot.lot_code,
    material_id: lot.material_id,
    material_code: lot.material_code,
    quantity_grams: q,
    received_by,
    received_at,
    note,
    balance: lotBalance(db, lotId)
  };
}

// ---------- 写入侧校验（新增/更正/补录/换线，在解析出批号后、提交前调用） ----------
// resolvedInputs: [{ material_id, material_lot_id(number|null), qty_raw(原始值/缺省) }]
// 返回中文错误信息数组（为空表示通过）。label 用于指出出错位置（如 events / changes[2] / records[3]）。
function checkWrittenInputs(db, resolvedInputs, label = '原料输入') {
  const errors = [];
  const metered = meteredLotIds(db);
  const lotRows = db.prepare('SELECT id, lot_code FROM material_lots').all();
  const lotCode = new Map(lotRows.map((l) => [l.id, l.lot_code]));

  (resolvedInputs || []).forEach((inp, idx) => {
    const where = `${label}[${idx}]`;
    // 单条事件路径透传原始值 qty_raw；补录/换线解析后为 qty_grams（数字或 null）。
    const raw = inp.qty_raw !== undefined ? inp.qty_raw : inp.qty_grams;
    const provided = raw !== undefined && raw !== null && raw !== '';
    let q = null;
    if (provided) {
      const n = parseNonNegInt(raw);
      if (!Number.isInteger(n) || n <= 0) {
        errors.push(`${where}：领用克数 qty_grams 必须是大于 0 的正整数`);
        return;
      }
      q = n;
    }
    inp.qty_grams = q;

    const lotId = inp.material_lot_id;
    if (lotId == null) {
      // 批号未知 / 引用批次行：计量只按已登记批号进行，不能携带克数。
      if (q !== null) {
        errors.push(`${where}：批号未知的原料输入不能填写克数（计量仅按已登记供应批号进行）`);
      }
      return;
    }
    const code = lotCode.get(lotId) || `#${lotId}`;
    if (metered.has(lotId)) {
      if (q === null) {
        errors.push(
          `${where}：供应批号 ${code} 已启用计量（已登记期初结存），该批号的每笔原料输入都必须填写` +
          '正整数克数 qty_grams；旧输入缺少数量时，更正该输入须补量'
        );
      }
    } else if (q !== null) {
      errors.push(
        `${where}：供应批号 ${code} 尚未启用计量（未登记期初结存），沿用原输入规则、不能填写克数；` +
        '请先由仓管登记期初实物结存后再按克数领用'
      );
    }
  });
  return errors;
}

// ---------- 最终状态校验（validateAll 内调用：按最终事件集重算领用） ----------
// 返回中文错误信息数组。校验：
//   1) 填写了克数的输入必须为正整数、且其批号已启用计量（防御性，正常写入侧已拦截）；
//   2) 已启用批号的累计领用 ≤ 期初 + 入库之和（余额不足整次拒绝）。
function validateInventory(db) {
  const errors = [];

  const badRows = db.prepare(
    `SELECT pi.id AS input_id, pi.event_id, pi.material_lot_id, pi.qty_grams,
            ml.lot_code, m.code AS material_code
       FROM process_inputs pi
       JOIN events ev ON ev.id = pi.event_id
       LEFT JOIN material_lots ml ON ml.id = pi.material_lot_id
       LEFT JOIN materials m ON m.id = pi.material_id
      WHERE pi.material_id IS NOT NULL AND pi.qty_grams IS NOT NULL`
  ).all();
  const metered = meteredLotIds(db);
  for (const r of badRows) {
    if (!Number.isInteger(r.qty_grams) || r.qty_grams <= 0) {
      errors.push(`原料输入 #${r.input_id}（事件 #${r.event_id}）的克数必须是正整数`);
      continue;
    }
    if (r.material_lot_id == null) {
      errors.push(`原料输入 #${r.input_id}（事件 #${r.event_id}）批号未知，不能填写克数`);
    } else if (!metered.has(r.material_lot_id)) {
      errors.push(
        `原料输入 #${r.input_id}（事件 #${r.event_id}）的供应批号 ${r.lot_code}（${r.material_code}）` +
        '尚未启用计量，不能填写克数'
      );
    }
  }

  // 按批号累计领用（缺数量的旧输入不计），与「期初 + 入库」核对。
  const usage = db.prepare(
    `SELECT pi.material_lot_id AS lot_id,
            ml.lot_code, m.code AS material_code,
            SUM(pi.qty_grams) AS used_qty,
            COUNT(*) AS input_count
       FROM process_inputs pi
       JOIN events ev ON ev.id = pi.event_id
       JOIN material_lots ml ON ml.id = pi.material_lot_id
       JOIN materials m ON m.id = ml.material_id
      WHERE pi.qty_grams IS NOT NULL
      GROUP BY pi.material_lot_id`
  ).all();
  for (const u of usage) {
    if (!metered.has(u.lot_id)) continue; // 上面已逐条报错
    const opening = getOpening(db, u.lot_id);
    const inbound = inboundTotal(db, u.lot_id);
    const supply = opening.quantity_grams + inbound;
    if (u.used_qty > supply) {
      errors.push(
        `供应批号 ${u.lot_code}（${u.material_code}）余额不足：按最终事件集累计领用 ${u.used_qty} 克` +
        `（${u.input_count} 笔已计量输入），超过期初 ${opening.quantity_grams} 克与入库合计 ${inbound} 克` +
        `之和 ${supply} 克；整次拒绝，原事件与库存不变`
      );
    }
  }
  return errors;
}

module.exports = {
  InventoryError,
  nonNegGrams,
  posGrams,
  meteredLotIds,
  getOpening,
  listInbound,
  usedTotal,
  unmeasuredCount,
  lotBalance,
  allBalances,
  registerOpening,
  createInbound,
  checkWrittenInputs,
  validateInventory
};
