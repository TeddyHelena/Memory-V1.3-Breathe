/**
 * 身份档案（H2）—— 「认识一下」十步里填的那点东西的**落点**
 *
 * ## 为什么放容器里（`<containerRoot>/identity/profile.json`）
 * `voice.md` 就住在**容器根**（已核实）。身份和声音是同一类东西：
 *   · 换机器要能跟着走 ⇒ 跟容器走，别散在插件目录或浏览器里；
 *   · 重装/换容器 ⇒ 一起没，正是我们要的语义；
 *   · ⛔ **不许**放 localStorage（沙箱 iframe 里直接抛异常，需求 §5.3 已定死）。
 *
 * ## 三条纪律
 *   ① **原子写**（tmp + rename）—— 写一半被 kill 不许留半截 JSON；
 *   ② **字段在白名单里**（`IDENTITY_FIELDS`）—— 与条目契约同源的做法：
 *      ⛔ 不许"谁来都能塞个字段"，否则又是"两处要同步"的老病；
 *   ③ **读不到不抛错**：返回空档案（UI 显示占位），⛔ 不许因为一个档案把面板搞白。
 */
import fs from 'node:fs';
import path from 'node:path';
// ⛔ 不导出（内部件）：落点由本模块与判据共同钉住。
const IDENTITY_DIR = 'identity';
const IDENTITY_FILE = 'profile.json';
const SCHEMA = 'dsh-memory-container/identity/1';
/**
 * 允许的身份字段（白名单）——**它同时是契约**：
 *   · 写入时白名单外的键**直接丢弃并留痕**（不静默接受）；
 *   · 新增字段要改这里（一处），⛔ 不许各处自己塞。
 */
export const IDENTITY_FIELDS = [
    'name', // 我的名字
    'callName', // 你希望我怎么称呼你
    'notCallName', // 不要怎么叫我
    'gender', // 性别（不设定 = ''）
    'relation', // 我们的关系（同行者/搭档/…）
    'avatar', // 头像（dataURL；空 = 显示占位文字）
    'role', // 我在这儿是什么位置
    'tone', // 我该怎么跟你说话（→ 写进声音层）
    'traits', // 我该是什么性子
    'thinking', // 事到你手上之前我先怎么想（最多三个）
    // ⛔ 【2026-10-14 对抗验证 F 修】这里原来是聚合名 `teamwork` / `aspiration`，
    //   而**向导交出去的是逐题分开的 key** ⇒ 7 个键全在白名单外 ⇒ `writeIdentity`
    //   **静默丢弃**（只在返回体的 `droppedKeys` 里留痕，向导没看）⇒
    //   用户在第 6 步（共事三题）与第 8 步（四道轴）填了、界面高亮了，**容器里一个字节没有**；
    //   而那两步**不是必填**，最省事的走法正好是跳过。
    //   ⇒ 白名单必须与**真实载荷**对齐（⛔ 不许留一个"设想中的聚合名"占位）。
    'teamwork1', // 共事①有想法时（plan/do）
    'teamwork2', // 共事②不同意你时（speak/yield）
    'teamwork3', // 共事③说话分寸（yes/no）
    'redlines', // 打死也不能破的（默认全勾）
    'axisIE', // 你希望的我是①安静还是主动
    'axisNS', // ②联想还是就事论事
    'axisTF', // ③直说还是先顾感受
    'axisJP', // ④有准谱还是留活口
    'selfGrow', // 它要不要自己长（true/false）
];
function fileOf(root) {
    return path.join(root, IDENTITY_DIR, IDENTITY_FILE);
}
/** 读档案。**永不抛错**：读不到/解析不了 ⇒ 返回空档案（UI 显示占位）。 */
export function readIdentity(root) {
    const empty = { schema: SCHEMA, fields: {}, updatedAt: null, droppedKeys: [] };
    try {
        const raw = JSON.parse(fs.readFileSync(fileOf(root), 'utf8'));
        const src = (raw.fields ?? {});
        const fields = {};
        const dropped = [];
        for (const [k, v] of Object.entries(src)) {
            if (IDENTITY_FIELDS.includes(k))
                fields[k] = v;
            else
                dropped.push(k);
        }
        return { schema: SCHEMA, fields, updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null, droppedKeys: dropped };
    }
    catch {
        return empty;
    }
}
/** 写档案（原子）。白名单外的键**丢弃并留痕**，返回值里能看见丢了哪些。 */
export function writeIdentity(root, patch, at = new Date()) {
    const current = readIdentity(root);
    const fields = { ...current.fields };
    const dropped = [];
    for (const [k, v] of Object.entries(patch)) {
        if (IDENTITY_FIELDS.includes(k)) {
            if (v === null || v === undefined || v === '')
                delete fields[k];
            else
                fields[k] = v;
        }
        else
            dropped.push(k);
    }
    const profile = { schema: SCHEMA, fields, updatedAt: at.toISOString(), droppedKeys: dropped };
    const dir = path.join(root, IDENTITY_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const file = fileOf(root);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(profile, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
    return profile;
}
