/**
 * 「认识一下」的状态（H1）—— 首启判定的**唯一真源**
 *
 * ## 为什么是"比版本号"不是布尔
 * 布尔分不出"重装"和"更新"，而过场白要**两者都再弹一次**。
 * 版本号直接用**产品版本**（`product.productVersion`，如 `MemoryV1.3-A.1`）——
 * 它本来就是"每批变更就动"的号，语义正好，⛔ 别再定义第二个。
 *
 * ## ⚠️ 四种情形必须分开（这是白屏事故的根因所在）
 * 需求原文 §5.5 写的是「**读不到 ⇒ 当作不需要弹**」。那条纪律的本意是**防止白屏**，
 * 但它把两件事说成了一件 —— 我在这里拆开：
 *
 * | 情形 | 判定 | 为什么 |
 * |---|---|---|
 * | **文件不存在** | `needed: true` | 这才是**真·首次安装**；按"读不到就不弹"处理的话，**向导永远不会出现** |
 * | **文件存在、版本不同** | `needed: true` | 更新/重装要再走一遍 |
 * | **文件存在、版本相同** | `needed: false` | 正常路径 |
 * | **文件在但读不动/解析不了** | `needed: false` + `reason` 留痕 | ⛔ 这才是那条硬纪律管的情形：**宁可少弹一次，也不许白屏** |
 *
 * ⛔ 后两种都**不许抛错给调用方**：UI 层拿不到明确答案时，只能选"不弹"。
 */
import fs from 'node:fs';
import path from 'node:path';
// ⛔ 不导出（内部件）：文件名由本模块与判据共同钉住。
const ONBOARDING_FILE = '.onboarded';
const SCHEMA = 'dsh-memory-container/onboarding/1';
function fileOf(root) {
    return path.join(root, ONBOARDING_FILE);
}
/**
 * 读状态。**永不抛错** —— 读不动就返回"不弹"（白屏纪律）。
 * `currentVersion` 为空字符串时按"没有可比版本"处理（返回 `no-version`，不弹）。
 */
export function onboardingState(root, currentVersion) {
    const empty = (reason) => ({ needed: false, version: null, onboardedAt: null, reason });
    if (!currentVersion)
        return empty('no-version');
    const file = fileOf(root);
    if (!fs.existsSync(file)) {
        // 真·首次安装：**要弹**（这一支若并进"读不到"，向导就永远不会出现）
        return { needed: true, version: null, onboardedAt: null, reason: 'first-install' };
    }
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        const version = typeof raw.version === 'string' ? raw.version : null;
        const at = typeof raw.at === 'string' ? raw.at : null;
        if (!version)
            return { needed: false, version: null, onboardedAt: at, reason: 'unreadable' };
        return version === currentVersion
            ? { needed: false, version, onboardedAt: at, reason: 'same-version' }
            : { needed: true, version, onboardedAt: at, reason: 'version-changed' };
    }
    catch {
        // ⛔ 文件在但读不动 ⇒ **不弹**（宁可少弹一次，也不许白屏）
        return { needed: false, version: null, onboardedAt: null, reason: 'unreadable' };
    }
}
/**
 * 记下"走过了这一版"。**原子写**（tmp + rename）：写一半被 kill 不许留下半截 JSON。
 * 返回写入后的状态读数。
 */
export function markOnboarded(root, currentVersion, at = new Date()) {
    if (!currentVersion)
        throw new Error('[onboarding] currentVersion 为空 —— 拒绝写入（会把状态写成一个无法比对的版本）');
    const file = fileOf(root);
    const body = JSON.stringify({ schema: SCHEMA, version: currentVersion, at: at.toISOString() }, null, 2) + '\n';
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, file);
    return { needed: false, version: currentVersion, onboardedAt: at.toISOString(), reason: 'same-version' };
}
