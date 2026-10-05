'use strict';
// 过敏原标签卷。
//
// 登记（包装前）：按“现有批次 + 有效放行记录”登记一卷过敏原标签。
//   拟印过敏原集合必须与①该批次当前推导结果、②所选放行快照“完全一致”（三方一致），
//   印量为正整数；登记后返回卷号与可用张数。
//
// 核销：每卷凭“预期修订号”核销贴用与作废张数，累计不得超过印量。
//   旧修订号、负数、超量均整次拒绝（事务回滚，修订号不前进）。
//
// 核销更正（仓管纠错）：对同一卷已存在的一笔核销流水（原核销编号）提交更正，
//   给出该笔的目标贴用数/作废数（非负整数，允许均为 0）。原核销行与每次更正行均为
//   只增不改流水；每笔的“最新有效数量”取其最后一次更正目标，卷累计贴用/作废按各笔
//   最新有效数量重算。更正后：累计贴用不得低于该卷已分配出货张数（历史出货分配与
//   快照不改），贴用+作废不得超过印量。未知/跨卷原核销、非法数量、旧修订号、
//   永久停用或质量隔离暂停贴用的卷均整次拒绝（修订号不前进）；成功后修订号 +1，
//   卷剩余量与可出货余额随最新有效数量同步更新。
//
// 永久停用：原料或加工事件变更、换线整组确认应用使集合改变，或绑定放行失效/删除时，
//   该卷永久停用（RETIRED，终态）：已贴数量标记待复核，余量不可再贴；
//   即使集合后来恢复也不自动解冻。

class LabelError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'LabelError';
    this.code = code;
    this.details = details || [];
  }
}

function sortedSet(list) {
  return [...new Set(list.map((a) => String(a).trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh'));
}
function canonical(list) {
  return JSON.stringify(sortedSet(list));
}

function intNonNeg(v, field, { positive = false } = {}) {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : parseInt(v, 10);
  if (!Number.isInteger(n)) {
    throw new LabelError('INVALID_REQUEST', `${field}必须是${positive ? '正' : '非负'}整数`);
  }
  if (positive ? n <= 0 : n < 0) {
    throw new LabelError('INVALID_REQUEST', `${field}必须${positive ? '大于 0' : '不小于 0'}`);
  }
  return n;
}

const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

// ---------- 登记一卷 ----------
function registerRoll(db, body) {
  const batch_id = parseInt(body && body.batch_id, 10);
  if (!Number.isInteger(batch_id)) throw new LabelError('INVALID_REQUEST', '请选择批次');
  const release_id = parseInt(body && body.release_id, 10);
  if (!Number.isInteger(release_id)) throw new LabelError('INVALID_REQUEST', '请选择有效放行记录');
  const print_qty = intNonNeg(body && body.print_qty, '印量', { positive: true });
  if (print_qty > 1e9) throw new LabelError('INVALID_REQUEST', '印量超出允许范围');
  const registered_by = String((body && body.registered_by) || '').trim() || '未署名';
  const registered_at = String((body && body.registered_at) || '').trim();
  if (registered_at && !TIME_RE.test(registered_at)) {
    throw new LabelError('INVALID_REQUEST', '登记时间格式应为 YYYY-MM-DDTHH:MM');
  }
  const declared = Array.isArray(body && body.allergens) ? body.allergens : null;
  if (!declared) throw new LabelError('INVALID_REQUEST', '请录入拟印过敏原集合');
  const declaredSet = sortedSet(declared);

  const batch = db.prepare('SELECT id, code FROM batches WHERE id = ?').get(batch_id);
  if (!batch) throw new LabelError('BATCH_NOT_FOUND', '该批次不存在');
  const out = db.prepare('SELECT allergens FROM batch_outputs WHERE batch_id = ?').get(batch_id);
  const ev = db.prepare('SELECT id FROM events WHERE batch_id = ?').get(batch_id);
  if (!out || !ev) throw new LabelError('BATCH_NOT_PRODUCED', '该批次尚无加工记录，无法登记标签卷');

  // 质量隔离令：受控批次不得登记标签卷（解除或流向变化脱离全部生效令后恢复）。
  const quarantine = require('./quarantine');
  const qOrders = quarantine.batchOrders(db, batch_id);
  if (qOrders.length) {
    throw new LabelError(
      'BATCH_QUARANTINED',
      `批次 ${batch.code} 处于质量隔离令生效范围（${quarantine.describeOrders(qOrders)}），` +
      '隔离期间不得登记标签卷；解除隔离或流向变化脱离全部生效令后恢复'
    );
  }

  const release = db.prepare(
    'SELECT id, batch_id, status, snapshot_allergens FROM releases WHERE id = ?'
  ).get(release_id);
  if (!release) throw new LabelError('RELEASE_NOT_FOUND', '所选放行记录不存在');
  if (release.batch_id !== batch_id) {
    throw new LabelError(
      'RELEASE_BATCH_MISMATCH',
      '所选放行快照不属于该批次，请选择该批次自己的有效放行记录'
    );
  }
  if (release.status !== 'ACTIVE') {
    throw new LabelError('RELEASE_INACTIVE', '所选放行记录已失效，请按当前结果重新登记放行后再包装');
  }

  const currentSet = sortedSet(JSON.parse(out.allergens));
  const snapshotSet = sortedSet(JSON.parse(release.snapshot_allergens));
  const declaredJson = JSON.stringify(declaredSet);
  if (declaredJson !== JSON.stringify(currentSet) || declaredJson !== JSON.stringify(snapshotSet)) {
    throw new LabelError('ALLERGENS_MISMATCH',
      '拟印过敏原集合与当前批次推导结果或所选放行快照不完全一致，拒绝登记',
      [
        `拟印集合：${declaredSet.join('、') || '（空）'}`,
        `当前批次推导：${currentSet.join('、') || '（空）'}`,
        `放行快照：${snapshotSet.join('、') || '（空）'}`
      ]);
  }

  let rollId;
  const tx = db.transaction(() => {
    rollId = db.prepare(
      `INSERT INTO label_rolls
         (roll_code, batch_id, release_id, print_qty, applied_qty, void_qty,
          revision, allergen_set, registered_at, registered_by, status, retired_reason)
       VALUES ('', ?, ?, ?, 0, 0, 0, ?, COALESCE(?, datetime('now')), ?, 'ACTIVE', '')`
    ).run(batch_id, release_id, print_qty, declaredJson, registered_at || null, registered_by)
      .lastInsertRowid;
    const roll_code = `LABEL-${String(rollId).padStart(4, '0')}`;
    db.prepare('UPDATE label_rolls SET roll_code = ? WHERE id = ?').run(roll_code, rollId);
  });
  tx();

  return formatRoll(db.prepare('SELECT * FROM label_rolls WHERE id = ?').get(rollId));
}

// ---------- 核销贴用 / 作废 ----------
function consumeRoll(db, id, body) {
  const roll = db.prepare('SELECT * FROM label_rolls WHERE id = ?').get(id);
  if (!roll) throw new LabelError('ROLL_NOT_FOUND', '标签卷不存在');
  if (roll.status !== 'ACTIVE') {
    throw new LabelError(
      'ROLL_RETIRED',
      `该卷已永久停用（${roll.retired_reason || '见停用原因'}），余量不可再贴；已贴数量待复核`,
      [roll.retired_reason]
    );
  }
  const expected_revision = parseInt(body && body.expected_revision, 10);
  if (!Number.isInteger(expected_revision) || expected_revision < 0) {
    throw new LabelError('INVALID_REQUEST', '请提供预期修订号（非负整数）');
  }
  // applied / voided 为文档用语；兼容 used/void_qty 别名。
  const applied = intNonNeg(body && body.applied != null ? body.applied : body && body.used, '贴用张数');
  const voided = intNonNeg(body && body.voided != null ? body.voided : body && body.void_qty, '作废张数');
  if (applied === 0 && voided === 0) {
    throw new LabelError('INVALID_REQUEST', '贴用与作废张数均为 0，无内容可核销');
  }
  const used_by = String((body && body.used_by) || (body && body.operator) || '').trim() || '未署名';
  const used_at = String((body && body.used_at) || '').trim();
  if (used_at && !TIME_RE.test(used_at)) {
    throw new LabelError('INVALID_REQUEST', '核销时间格式应为 YYYY-MM-DDTHH:MM');
  }

  let result;
  const tx = db.transaction(() => {
    const cur = db.prepare('SELECT revision, applied_qty, void_qty, print_qty FROM label_rolls WHERE id = ?').get(id);
    if (!cur) throw new LabelError('ROLL_NOT_FOUND', '标签卷不存在');
    // 质量隔离令：所属批次受控时暂停贴用（不永久停用；脱离全部生效令后恢复核销）。
    const quarantine = require('./quarantine');
    const qOrders = quarantine.batchOrders(db, roll.batch_id);
    if (qOrders.length) {
      throw new LabelError(
        'ROLL_QUARANTINED',
        `卷 ${roll.roll_code} 所属批次处于质量隔离令生效范围（${quarantine.describeOrders(qOrders)}），` +
        '已暂停贴用（不永久停用）；解除隔离或流向变化脱离全部生效令后恢复'
      );
    }
    if (cur.revision !== expected_revision) {
      throw new LabelError(
        'REVISION_MISMATCH',
        `修订号已过期：卷当前修订号为 ${cur.revision}，提交的预期修订号为 ${expected_revision}；整次拒绝`
      );
    }
    const nextApplied = cur.applied_qty + applied;
    const nextVoid = cur.void_qty + voided;
    if (nextApplied + nextVoid > cur.print_qty) {
      throw new LabelError(
        'OVER_LIMIT',
        `超过印量：印量 ${cur.print_qty}，已贴 ${cur.applied_qty}、已作废 ${cur.void_qty}，` +
        `本次申请贴用 ${applied}、作废 ${voided}，核销后累计 ${nextApplied + nextVoid} 超过印量；整次拒绝`
      );
    }
    db.prepare(
      `INSERT INTO label_roll_usages (roll_id, used_at, applied_qty, void_qty, expected_revision, used_by)
       VALUES (?, COALESCE(?, datetime('now')), ?, ?, ?, ?)`
    ).run(id, used_at || null, applied, voided, expected_revision, used_by);
    db.prepare(
      'UPDATE label_rolls SET applied_qty = ?, void_qty = ?, revision = revision + 1 WHERE id = ?'
    ).run(nextApplied, nextVoid, id);
    result = formatRoll(db.prepare('SELECT * FROM label_rolls WHERE id = ?').get(id));
  });
  tx();
  return result;
}

// ---------- 核销更正（仓管对已录错的一笔核销进行纠错）----------
// rollId 可空：为空时只按 usage_id 定位原核销（原核销所属卷即更正对象）；
// 非空时若原核销属于其他卷，按“跨卷核销”整次拒绝。
// body: { expected_revision, target_applied_qty / applied, target_void_qty / voided,
//         corrected_by / operator, reason, corrected_at? }
function correctUsage(db, rollId, usageId, body) {
  const usage_id = parseInt(usageId, 10);
  if (!Number.isInteger(usage_id)) throw new LabelError('INVALID_REQUEST', '原核销编号不合法');
  if (rollId != null) {
    rollId = parseInt(rollId, 10);
    if (!Number.isInteger(rollId)) throw new LabelError('INVALID_REQUEST', '卷号不合法');
  }
  const bodyUsageId = body && body.usage_id != null ? parseInt(body.usage_id, 10) : null;
  if (bodyUsageId != null) {
    if (!Number.isInteger(bodyUsageId)) {
      throw new LabelError('INVALID_REQUEST', 'body.usage_id 不合法');
    }
    if (bodyUsageId !== usage_id) {
      throw new LabelError(
        'USAGE_MISMATCH',
        `路径原核销编号 ${usage_id} 与请求体 usage_id ${bodyUsageId} 不一致，整次拒绝`
      );
    }
  }

  const expected_revision = parseInt(body && body.expected_revision, 10);
  if (!Number.isInteger(expected_revision) || expected_revision < 0) {
    throw new LabelError('INVALID_REQUEST', '请提供所见卷修订号（非负整数）');
  }
  const targetApplied = intNonNeg(
    body && body.target_applied_qty != null ? body.target_applied_qty : body && body.applied,
    '目标贴用数'
  );
  const targetVoid = intNonNeg(
    body && body.target_void_qty != null ? body.target_void_qty : body && body.voided,
    '目标作废数'
  );
  if (targetApplied > 1e9 || targetVoid > 1e9) {
    throw new LabelError('INVALID_REQUEST', '目标数量超出允许范围');
  }
  const corrected_by = String(
    (body && (body.corrected_by || body.operator)) || ''
  ).trim() || '未署名';
  const reason = String((body && body.reason) || '').trim();
  if (!reason) throw new LabelError('INVALID_REQUEST', '请录入更正原因');
  const corrected_at = String((body && body.corrected_at) || '').trim();
  if (corrected_at && !TIME_RE.test(corrected_at)) {
    throw new LabelError('INVALID_REQUEST', '更正时间格式应为 YYYY-MM-DDTHH:MM');
  }

  let result;
  const tx = db.transaction(() => {
    // 事务内权威复核（最新数据 + 锁内串行）。
    const usage = db.prepare('SELECT * FROM label_roll_usages WHERE id = ?').get(usage_id);
    if (!usage) throw new LabelError('USAGE_NOT_FOUND', `原核销编号 ${usage_id} 不存在，整次拒绝`);
    if (rollId != null && usage.roll_id !== rollId) {
      const other = db.prepare('SELECT roll_code FROM label_rolls WHERE id = ?').get(usage.roll_id);
      throw new LabelError(
        'USAGE_CROSS_ROLL',
        `跨卷核销：原核销编号 ${usage_id} 属于卷 ${other ? other.roll_code : '#' + usage.roll_id}，` +
        `不属于卷 #${rollId}，整次拒绝`
      );
    }
    const cur = db.prepare('SELECT * FROM label_rolls WHERE id = ?').get(usage.roll_id);
    if (!cur) throw new LabelError('ROLL_NOT_FOUND', '标签卷不存在');
    if (cur.status !== 'ACTIVE') {
      throw new LabelError(
        'ROLL_RETIRED',
        `该卷已永久停用（${cur.retired_reason || '见停用原因'}），不可更正`,
        [cur.retired_reason]
      );
    }
    // 质量隔离令：所属批次受控时暂停贴用，期间同样不允许更正（脱离全部生效令后恢复）。
    const quarantine = require('./quarantine');
    const qOrders = quarantine.batchOrders(db, cur.batch_id);
    if (qOrders.length) {
      throw new LabelError(
        'ROLL_QUARANTINED',
        `卷 ${cur.roll_code} 所属批次处于质量隔离令生效范围（${quarantine.describeOrders(qOrders)}），` +
        '已暂停贴用，期间不可更正；解除隔离或流向变化脱离全部生效令后恢复'
      );
    }
    if (cur.revision !== expected_revision) {
      throw new LabelError(
        'REVISION_MISMATCH',
        `修订号已过期：卷当前修订号为 ${cur.revision}，提交的所见修订号为 ${expected_revision}；整次拒绝`
      );
    }

    // 该笔当前有效数量（取最后一条更正目标；无更正即原核销数量）。
    const last = db.prepare(
      'SELECT target_applied_qty, target_void_qty FROM label_usage_corrections WHERE usage_id = ? ORDER BY id DESC LIMIT 1'
    ).get(usage_id);
    const effApplied = last ? last.target_applied_qty : usage.applied_qty;
    const effVoid = last ? last.target_void_qty : usage.void_qty;

    // 卷累计 = 各笔最新有效数量之和；用“目标值 - 当前有效值”调整本卷累计。
    const nextApplied = cur.applied_qty - effApplied + targetApplied;
    const nextVoid = cur.void_qty - effVoid + targetVoid;
    if (nextApplied < 0 || nextVoid < 0) {
      // 正常不可达（各笔有效数量非负，其和即卷累计），防御性兜底。
      throw new LabelError('INVALID_REQUEST', '更正后卷累计出现负数，整次拒绝');
    }

    // 历史出货分配与快照不改：累计贴用不得低于该卷已分配出货张数。
    const allocRow = db.prepare(
      'SELECT COALESCE(SUM(qty),0) AS allocated FROM shipment_items WHERE roll_id = ?'
    ).get(cur.id);
    const allocated = allocRow.allocated;
    if (nextApplied < allocated) {
      throw new LabelError(
        'APPLIED_BELOW_ALLOCATED',
        `更正后卷 ${cur.roll_code} 累计贴用将为 ${nextApplied} 张，低于该卷已分配出货张数 ${allocated} 张；` +
        '历史出货分配不可更改，整次拒绝',
        [`目标贴用数 ${targetApplied}`, `已分配出货 ${allocated}`]
      );
    }
    if (nextApplied + nextVoid > cur.print_qty) {
      throw new LabelError(
        'OVER_LIMIT',
        `更正后超过印量：卷 ${cur.roll_code} 印量 ${cur.print_qty}，按各笔最新有效数量计 ` +
        `累计贴用 ${nextApplied}、作废 ${nextVoid}（合计 ${nextApplied + nextVoid}）超过印量；整次拒绝`
      );
    }

    const seq = (db.prepare(
      'SELECT COALESCE(MAX(seq),0) + 1 AS seq FROM label_usage_corrections WHERE usage_id = ?'
    ).get(usage_id).seq);
    db.prepare(
      `INSERT INTO label_usage_corrections
         (usage_id, roll_id, seq, target_applied_qty, target_void_qty,
          expected_revision, corrected_by, reason, corrected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`
    ).run(usage_id, cur.id, seq, targetApplied, targetVoid,
          expected_revision, corrected_by, reason, corrected_at || null);
    db.prepare(
      'UPDATE label_rolls SET applied_qty = ?, void_qty = ?, revision = revision + 1 WHERE id = ?'
    ).run(nextApplied, nextVoid, cur.id);

    result = {
      roll: formatRoll(db.prepare('SELECT * FROM label_rolls WHERE id = ?').get(cur.id)),
      usage: getUsage(db, usage_id),
      correction: formatCorrection(db.prepare(
        'SELECT * FROM label_usage_corrections WHERE usage_id = ? ORDER BY id DESC LIMIT 1'
      ).get(usage_id))
    };
  });
  tx();
  return result;
}

// ---------- 终态停用 ----------
function deactivateRolls(db, ids, reason) {
  const list = Array.isArray(ids) ? ids : [ids];
  const stmt = db.prepare(
    `UPDATE label_rolls SET status = 'RETIRED', retired_reason = ?
      WHERE id = ? AND status = 'ACTIVE'`
  );
  let count = 0;
  const tx = db.transaction(() => {
    for (const id of list) count += stmt.run(reason, id).changes;
  });
  tx();
  return count;
}

// 放行被删除：其名下所有有效卷永久停用（放行已不存在，无法再保持一致）。
function deactivateForReleaseDeletion(db, releaseId) {
  const release = db.prepare(
    `SELECT r.id, r.batch_id, b.code AS batch_code, r.released_at
       FROM releases r LEFT JOIN batches b ON b.id = r.batch_id WHERE r.id = ?`
  ).get(releaseId);
  const reason = `绑定的放行记录已删除（批次 ${release ? release.batch_code || '#' + release.batch_id : '?'}，` +
    `放行时间 ${release ? release.released_at : '?'}），标签卷永久停用`;
  const rolls = db.prepare(
    "SELECT id, roll_code FROM label_rolls WHERE release_id = ? AND status = 'ACTIVE'"
  ).all(releaseId);
  const count = deactivateRolls(db, rolls.map((r) => r.id), reason);
  return { count, reason, rolls };
}

// 加工事件删除致批次连带删除的兜底：该批次剩余有效卷永久停用。
function deactivateForBatchDeletion(db, batchId, batchCode) {
  const reason = `批次 ${batchCode || '#' + batchId} 的加工事件已删除，标签卷永久停用`;
  const rolls = db.prepare(
    "SELECT id, roll_code FROM label_rolls WHERE batch_id = ? AND status = 'ACTIVE'"
  ).all(batchId);
  const count = deactivateRolls(db, rolls.map((r) => r.id), reason);
  return { count, reason, rolls };
}

// 重算后核对：对所有仍有效的卷检查“绑定放行 / 批次 / 集合”是否仍一致。
// 只在重算事务内调用；停用为终态，不做任何“解冻”。
function syncRollsAfterRecompute(db, batchResult) {
  const rollRows = db.prepare(
    `SELECT lr.id, lr.roll_code, lr.batch_id, lr.release_id, lr.allergen_set,
            b.code AS batch_code
       FROM label_rolls lr LEFT JOIN batches b ON b.id = lr.batch_id
      WHERE lr.status = 'ACTIVE'`
  ).all();
  const upd = db.prepare(
    `UPDATE label_rolls SET status = 'RETIRED', retired_reason = ? WHERE id = ?`
  );
  const retired = [];
  for (const roll of rollRows) {
    let reason = null;

    if (roll.release_id == null) {
      reason = '绑定的放行记录已删除，标签卷永久停用';
    } else {
      const release = db.prepare('SELECT status, invalid_reason FROM releases WHERE id = ?')
        .get(roll.release_id);
      if (!release) {
        reason = '绑定的放行记录已删除，标签卷永久停用';
      } else if (release.status === 'INVALIDATED') {
        reason = `绑定放行已失效：${release.invalid_reason || '放行快照与当前推导结果不一致'}；标签卷永久停用`;
      }
    }

    if (!reason) {
      const result = batchResult.get(roll.batch_id);
      if (!result) {
        reason = '该批次的加工事件已不存在，无法重新推导过敏原，标签卷永久停用';
      } else if (canonical([...result.keys()]) !== roll.allergen_set) {
        const oldSet = JSON.parse(roll.allergen_set);
        const newSet = [...result.keys()];
        const added = newSet.filter((a) => !oldSet.includes(a));
        const removed = oldSet.filter((a) => !newSet.includes(a));
        const parts = [];
        if (added.length) parts.push(`新增：${added.join('、')}`);
        if (removed.length) parts.push(`移除：${removed.join('、')}`);
        reason = `批次过敏原集合已改变（${parts.join('；') || '集合内容变化'}），与拟印集合不一致，标签卷永久停用`;
      }
    }

    if (reason) {
      upd.run(reason, roll.id);
      retired.push({
        id: roll.id, roll_code: roll.roll_code,
        batch_code: roll.batch_code || null, reason,
        applied_pending_review: db.prepare(
          'SELECT applied_qty FROM label_rolls WHERE id = ?'
        ).get(roll.id).applied_qty
      });
    }
  }
  return retired;
}

// ---------- 读取模型 ----------
function formatCorrection(c) {
  if (!c) return null;
  return {
    id: c.id,
    usage_id: c.usage_id,
    roll_id: c.roll_id,
    seq: c.seq,
    target_applied_qty: c.target_applied_qty,
    target_void_qty: c.target_void_qty,
    expected_revision: c.expected_revision,
    corrected_by: c.corrected_by,
    reason: c.reason,
    corrected_at: c.corrected_at
  };
}

// 一笔核销流水：原始数量、最新有效数量（取最后一次更正目标）与更正链（只增不改）。
// corrections 可选传入（整页状态成批取数时复用预取的更正 Map）；缺省则逐笔查询。
function formatUsage(db, u, corrections) {
  if (!u) return null;
  if (corrections === undefined) {
    corrections = db.prepare(
      `SELECT * FROM label_usage_corrections WHERE usage_id = ? ORDER BY id`
    ).all(u.id);
  }
  corrections = corrections.map(formatCorrection);
  const last = corrections.length ? corrections[corrections.length - 1] : null;
  return {
    id: u.id,
    roll_id: u.roll_id,
    used_at: u.used_at,
    used_by: u.used_by,
    expected_revision: u.expected_revision, // 原核销提交时所见修订号
    original_applied_qty: u.applied_qty,
    original_void_qty: u.void_qty,
    corrected: corrections.length > 0,
    correction_count: corrections.length,
    // 最新有效数量：有更正取最后一次更正目标，否则即原核销数量。
    applied_qty: last ? last.target_applied_qty : u.applied_qty,
    void_qty: last ? last.target_void_qty : u.void_qty,
    corrections
  };
}

function getUsage(db, id) {
  const u = db.prepare('SELECT * FROM label_roll_usages WHERE id = ?').get(id);
  return formatUsage(db, u);
}

function listUsages(db, rollId) {
  return db.prepare(
    'SELECT * FROM label_roll_usages WHERE roll_id = ? ORDER BY id'
  ).all(rollId).map((u) => formatUsage(db, u));
}

// 整页状态用：一次取全部核销流水与其更正链，按卷分组（rollId -> 核销数组）。
// 查询数固定为 2（无流水时更正查询跳过），不随标签卷/核销/更正数量逐笔增长；
// 每笔形状与 listUsages 逐笔结果一致，且按 id 排序、只含本卷记录，不会串卷。
function listAllUsagesByRoll(db, rollIds = null) {
  let sql = 'SELECT * FROM label_roll_usages';
  const args = [];
  if (Array.isArray(rollIds) && rollIds.length) {
    sql += ` WHERE roll_id IN (${rollIds.map(() => '?').join(',')})`;
    args.push(...rollIds);
  }
  sql += ' ORDER BY id';
  const usageRows = db.prepare(sql).all(...args);
  const byRoll = new Map();
  const usageIds = [];
  for (const u of usageRows) {
    if (!byRoll.has(u.roll_id)) byRoll.set(u.roll_id, []);
    byRoll.get(u.roll_id).push(u);
    usageIds.push(u.id);
  }
  const correctionsByUsage = new Map();
  if (usageIds.length) {
    const placeholders = usageIds.map(() => '?').join(',');
    db.prepare(
      `SELECT * FROM label_usage_corrections WHERE usage_id IN (${placeholders}) ORDER BY id`
    ).all(...usageIds).forEach((c) => {
      if (!correctionsByUsage.has(c.usage_id)) correctionsByUsage.set(c.usage_id, []);
      correctionsByUsage.get(c.usage_id).push(c);
    });
  }
  const result = new Map();
  for (const [rollId, rows] of byRoll) {
    result.set(rollId, rows.map((u) => formatUsage(db, u, correctionsByUsage.get(u.id) || [])));
  }
  return result;
}

function formatRoll(r) {
  if (!r) return null;
  const applied = r.applied_qty || 0;
  const voided = r.void_qty || 0;
  const print = r.print_qty || 0;
  return {
    id: r.id,
    roll_code: r.roll_code,
    batch_id: r.batch_id,
    release_id: r.release_id,
    allergens: JSON.parse(r.allergen_set || '[]'),
    print_qty: print,
    applied_qty: applied,
    void_qty: voided,
    remaining_qty: print - applied - voided,
    revision: r.revision,
    registered_at: r.registered_at,
    registered_by: r.registered_by,
    status: r.status,
    active: r.status === 'ACTIVE',
    retired_reason: r.retired_reason || '',
    applied_pending_review: r.status === 'RETIRED' ? applied : 0
  };
}

module.exports = {
  LabelError,
  registerRoll,
  consumeRoll,
  correctUsage,
  getUsage,
  listUsages,
  listAllUsagesByRoll,
  deactivateForReleaseDeletion,
  deactivateForBatchDeletion,
  syncRollsAfterRecompute,
  formatRoll,
  formatUsage,
  formatCorrection
};
