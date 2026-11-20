/**
 * `current_time` 工具：按需取当前时间。
 *
 * ── 为什么是工具，而不是注入进系统提示词 ─────────────────────────────
 * 2026-09-15 之前，「当前时间」是拼在声音层头部的（系统提示词第 132 字符处），
 * 每个模型步重算。它的代价被实测出来了：前缀匹配缓存以第一个不同字节为界，
 * 时间行每分钟一变 ⇒ 后面整段前缀（19KB 系统提示 + 对话全文）每分钟作废一次。
 * 一个 29 小时会话实测：156 次全失效、6,992 万 token 按全价重算、折算 ¥15.38
 * （同样内容走缓存只需 ¥0.49，差约 31 倍）。
 *
 * 改成工具后：系统提示词跨调用**字节稳定**，缓存前缀不再被截断；
 * 模型需要判断时辰时自己调一次，拿到的时间一样真实（分钟精度 + 强制时区）。
 * 这不是牺牲能力换钱，是换交付方式——把易变内容从「可缓存前缀的头部」
 * 挪到「按需调用的工具」。
 *
 * ── 时区纪律 ─────────────────────────────────────────────────────
 * 默认时区来自插件配置 `timeZone`（本机是 Asia/Shanghai）。强制走 Intl + 显式 timeZone，
 * 不读系统默认时区——宿主时区可能是 UTC，会让分时段判断整体偏移。
 * 传入非法 IANA 名时**报错并给出默认时区**，不静默回退：静默回退比报错危险得多，
 * 模型会拿着一个它以为是「指定时区」的错误时间继续推理。
 */
import { formatCurrentTime } from './persona.js';
const DEFAULT_TZ_PREFIX = '默认时区';
/**
 * 取当前时间（纯函数，便于测试：now / defaultZone 都可注入）。
 *
 * @param args.timezone 可选 IANA 时区；缺省用插件配置的默认时区
 * @param defaultZone   插件配置的默认时区
 * @param now           当前时刻（默认 new Date()，测试时注入）
 */
export function currentTime(args = {}, defaultZone, now = new Date()) {
    const requested = typeof args.timezone === 'string' && args.timezone.trim() !== ''
        ? args.timezone.trim()
        : undefined;
    if (requested !== undefined && !isValidTimeZone(requested)) {
        return {
            ok: false,
            line: '',
            timezone: requested,
            is_default: false,
            error: `无效的 IANA 时区名: ${requested}（${DEFAULT_TZ_PREFIX}: ${defaultZone}）`,
        };
    }
    const zone = requested ?? defaultZone;
    // 【S1 · P0-1b 同族】默认时区缺失 / 空白 / 非法时**不得静默回退系统时区**。
    //
    // 为什么：本文件开头的纪律写着「不读系统默认时区——宿主时区可能是 UTC，
    // 会让分时段判断整体偏移」，并且对"传入的非法 IANA 名"已经做了报错不回退。
    // 但 `defaultZone` 本身缺失时，原实现会一路走到 `formatCurrentTime(undefined)`
    // ——Intl 用系统默认时区把它格式化出来，**返回 ok:true、timezone:undefined**。
    // 两个后果：① 静默偏移（正好是上面那条纪律要防的）；
    // ② 返回里出现 undefined，宿主按 lossless JSON 整条拒收（与审计 P0-1 同族）。
    // 所以这里与"传入非法时区"同等对待：如实报错，并把 timezone 收成 ''（类型要求 string）。
    if (typeof zone !== 'string' || zone.trim() === '' || !isValidTimeZone(zone)) {
        return {
            ok: false,
            line: '',
            timezone: '',
            is_default: requested === undefined,
            error: `插件默认时区无效或未配置: ${String(zone)}（请在配置里设置 timeZone，如 Asia/Shanghai）`,
        };
    }
    try {
        return {
            ok: true,
            line: formatCurrentTime(zone, now),
            timezone: zone,
            is_default: requested === undefined,
        };
    }
    catch (error) {
        // 配置里的默认时区本身是非法名（人工写错配置）——如实报，不猜
        return {
            ok: false,
            line: '',
            timezone: zone,
            is_default: requested === undefined,
            error: `默认时区 ${zone} 无法格式化: ${String(error)}`,
        };
    }
}
/** Intl 是时区合法性的唯一权威：构造一次不抛即合法 */
function isValidTimeZone(zone) {
    try {
        new Intl.DateTimeFormat('zh-CN', { timeZone: zone });
        return true;
    }
    catch {
        return false;
    }
}
