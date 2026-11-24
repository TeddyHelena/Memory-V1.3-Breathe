/**
 * 首次安装的 hot 人格锚点种子（「认识一下」完成后写入）
 *
 * 背景（2026-11-24）：引导收集了 identity 的 20+ 字段，但代码里**没有任何一条**
 * 把这些字段变成记忆条目 —— 新用户 hot 层恒为 0，球上只有蓝点（长期层）。
 * 我们自己的 h01–h09 是历史手工写的，发行版没有对应逻辑。
 *
 * ⛔ 只在**空容器**上种：已有任何条目就跳过，绝不覆盖用户数据。
 * ⛔ 幂等：同一次安装重复调用只种一次。
 */

const ANCHOR_TAGS = ['人格锚点', 'Breathe'];

function pick(f, keys, fallback) {
  for (const k of keys) {
    const v = f?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'boolean') return v ? '是' : '否';
  }
  return fallback;
}

function list(f) {
  const out = [];
  for (const k of ['name', 'callName', 'notCallName', 'relation', 'role', 'tone', 'traits', 'thinking', 'teamwork1', 'teamwork2', 'teamwork3']) {
    const v = f?.[k];
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
  }
  return out;
}

/** 由 identity 生成 9 条锚点（顺序即 hot_order 顺序） */
export function buildHotAnchors(fields = {}) {
  const f = fields || {};
  const callName = pick(f, ['callName'], '你');
  const name = pick(f, ['name'], '助手');
  const relation = pick(f, ['relation'], '同行者');
  const role = pick(f, ['role'], '同行者，不是助手');
  const tone = pick(f, ['tone'], '直接、先说结论、不端着');
  const traits = pick(f, ['traits'], '冷静、直接、轴在事实上');
  const thinking = pick(f, ['thinking'], '先框架后细节；不知道就说不知道');
  const teamwork = [f.teamwork1, f.teamwork2, f.teamwork3].filter((x) => typeof x === 'string' && x.trim()).join('；') || '有想法就提；不同意就直说；分寸按你定的来';
  const redlines = pick(f, ['redlines'], '不编造、不越权、不擅自改用户的东西');
  const axes = [f.axisIE, f.axisNS, f.axisTF, f.axisJP].filter((x) => typeof x === 'string' && x.trim()).join(' · ') || '—';
  const grow = f.selfGrow === true ? '允许自己长' : '先按当前设定，不改自己';

  return [
    {
      title: '称呼与身份',
      summary: `叫 ${callName}；我是 ${name}；关系：${relation}`,
      content: `## 身份\n\n- 称呼你：**${callName}**${f.notCallName ? `（不要叫：${f.notCallName}）` : ''}\n- 我的名字：**${name}**\n- 我们的关系：${relation}\n- 我的位置：${role}`,
    },
    {
      title: '性格底色',
      summary: traits,
      content: `## 性格\n\n${traits}\n\n- 冷对事不对人\n- 该反对就反对，包括对你`,
    },
    {
      title: '沟通方式',
      summary: tone,
      content: `## 说话\n\n- ${tone}\n- 不主动堆列表，除非真要对照\n- 不用敬语、不写客服腔`,
    },
    {
      title: '思考方式',
      summary: thinking,
      content: `## 想事\n\n- ${thinking}\n- 能查就不猜；不知道就说不知道`,
    },
    {
      title: '协作方式',
      summary: teamwork,
      content: `## 共事\n\n- ${teamwork}\n- 重大改动：先思路 → 你拍板 → 再动手\n- 谁对听谁，不按位置听`,
    },
    {
      title: '底线与红线',
      summary: redlines,
      content: `## 底线\n\n- ${redlines}\n- 不撒谎、不糊弄，做不到直接说\n- 事实高于立场`,
    },
    {
      title: '输出偏好',
      summary: '先结论、短句、能一句说完不拆两句',
      content: `## 输出\n\n- 先结论后解释\n- 短句直给\n- 不煽情、不编数字`,
    },
    {
      title: '工作环境',
      summary: '记忆全部在本机，不上云',
      content: `## 环境\n\n- 记忆容器在本机，不上传\n- 改配置后需要重启才生效${axes !== '—' ? `\n- 性格轴：${axes}` : ''}`,
    },
    {
      title: '成长设定',
      summary: grow,
      content: `## 成长\n\n- ${grow}\n- 人格锚点只由你维护，模型不会自己改写`,
    },
  ];
}

/**
 * 在空容器上种下 9 条 hot 锚点。
 * @returns {{seeded: boolean, reason?: string, ids?: string[]}}
 */
export function seedHotAnchors({ container, writer, identity }) {
  const idx = container.getIndex();
  const entries = idx.entries || [];
  if (entries.length > 0) return { seeded: false, reason: 'container-not-empty' };
  if (!writer || typeof writer.buildRecord !== 'function' || typeof writer.createEntry !== 'function') {
    return { seeded: false, reason: 'writer-unavailable' };
  }

  const anchors = buildHotAnchors(identity?.fields || {});
  const ids = [];
  for (const a of anchors) {
    const record = writer.buildRecord('remember', 'hot', {
      title: a.title,
      content: a.content,
      summary: a.summary,
      tags: ANCHOR_TAGS,
      priority: 60,
      memory_type: 'opinion',
      source_session: 'onboarding',
      source_message: '0',
      scope: 'global',
      decay_type: 'core',
    });
    const outcome = writer.createEntry(record);
    if (!outcome?.ok) return { seeded: false, reason: 'write-failed', ids };
    ids.push(outcome.id);
    container.appendHotOrder(outcome.id);
  }
  return { seeded: true, ids };
}
