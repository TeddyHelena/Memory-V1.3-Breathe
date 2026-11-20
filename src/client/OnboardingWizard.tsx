/**
 * 「认识一下」向导（`#ob-view`）—— 第 3 轮
 *
 * ## 两卡布局（原型截图 02/03）
 * ```
 * [左卡 预览]  它正在变成什么样 · 头像(可跳过) · 名字 · 关系 · 一句话底线 · 说明两行
 * [右卡 问题]  10 段进度条 ·「第 N 步 / 共 10 步 · <标题>」· 大标题 + 副标题 · 问题组
 *              底部：上一步 ·「两处必填 · 一处可空」· 下一步（未填则禁用）
 * ```
 * 背景有渐变光斑（blobs），卡片浮在其上。
 *
 * ## ⚠️ 内容来源与"待补"（⛔ 不编）
 * 步骤标题/副标题摘自原型 HTML（`s1`–`s10`）；
 * 选项从原型 **JS 里抽出来的只有一部分**（s6 共事 6 项、s7 底线 5 项、s8 四轴 8 项）。
 * **s2 位置 / s4 性子 / s5 认知 三组选项我在 JS 里还没抽全** ⇒ 这里如实标 `待补`，
 * ⛔ 绝不自己编一套题目（编出来的东西会看起来"完成度很高"，那是糊弄）。
 *
 * ## 交互的两个硬约束（原型 §1.3 + Teddy 的裁决）
 *   ① **面板内覆盖层，⛔ 不做成"必须先过的启动页"**（Teddy：直接进 Agent 页就行）；
 *   ② 首启判定走 `/onboarding`（**读不到 ⇒ 不弹**，⛔ 不白屏）。
 */

import { OPTS } from './onboarding-options.ts'
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { avatarPatchFromDataUrl, resolveIdentityPreview } from '../identityView.js'

export interface OnboardingWizardProps {
  /** 走完/跳过后的回调（外面据此重载并提供"记下版本"） */
  onDone: (patch: Record<string, unknown>) => void
  onSkip: () => void
  /** 已存身份档案（预览回落用；可空） */
  identity?: Record<string, unknown>
  /** 当前产品版本（写进 `.onboarded` 的那个号） */
  version: string
}

type Question =
  | { kind: 'text'; key: string; label: string; hint?: string; placeholder?: string; required?: boolean }
  | { kind: 'chips'; key: string; label: string; hint?: string; options: Array<{ k: string; t: string; d?: string }>; required?: boolean }
  | { kind: 'multi'; key: string; label: string; hint?: string; options: Array<{ k: string; t: string; d?: string }>; max?: number }

interface Step { title: string; lead: string; questions: Question[] }

/**
 * 10 步（标题/副标题**照抄原型**；选项只放**已抽到的**，其余标 `TODO`）
 * ⚠️ `options: []` + `TODO` = "原型里有、我还没抽全" —— 界面上会明说，不会假装是空的。
 */
/**
 * 从抽取源（`onboarding-options.ts`）取**一对**选项（原理是"每题两选项"的结构）。
 *
 * ⛔ **只取 `k`/`t`，刻意不取 `d`**（描述）—— 因为这一步是**纯重构**：
 *    原型的那些选项带 `d`，而向导这两组**本来就没显示描述**
 *    ⇒ 照搬会把描述加进画面 = **视觉改变**，那得先跟 Teddy 说。
 *    "要不要把描述也显示出来（跟其它步骤一致）"是**另一个问题**，另行处置。
 */
const pairOf = (q: { a: { k: string; t: string }; b: { k: string; t: string } }): Array<{ k: string; t: string }> =>
  [q.a, q.b].map((o) => ({ k: o.k, t: o.t }))

/**
 * **把向导的界面答案归一化成落库契约的形状**（2026-10-14 对抗验证 F 修）。
 *
 * 两处形状不一致（都不报错，只是**存进去的东西跟契约说的不一样**）：
 *   · `selfGrow`：界面用 `'on'/'off'`，契约写的是 **true/false**
 *   · `gender`：界面有个"不设定"选项，契约写的是 **'' = 不设定**（空串会让 writeIdentity 删掉该字段）
 * ⛔ 归一化只做**形状**，不改语义；⛔ 也别在这里偷偷丢字段 —— 丢字段是白名单的事，见 `identity.ts`。
 */
function toContract(a: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a }
  if (out.selfGrow === 'on') out.selfGrow = true
  else if (out.selfGrow === 'off') out.selfGrow = false
  if (out.gender === '不设定') out.gender = ''
  return out
}

const STEPS: Step[] = [
  {
    title: '先认个人',
    lead: '这两处必须你亲手写。',
    questions: [
      { kind: 'text', key: 'callName', label: '你希望我怎么称呼你？', placeholder: '你的名字，或你想让我怎么叫你', required: true },
      { kind: 'text', key: 'name', label: '我的名字', placeholder: '你想怎么叫我', required: true },
      { kind: 'text', key: 'notCallName', label: '不要怎么叫我', hint: '（可以空着）', placeholder: '主人 / 老板 / 您…' },
      { kind: 'chips', key: 'gender', label: '我的性别', options: [{ k: '女', t: '女' }, { k: '男', t: '男' }, { k: '不设定', t: '不设定' }] },
      {
        kind: 'chips', key: 'relation', label: '我们的关系',
        options: [{ k: '同行者', t: '同行者' }, { k: '搭档', t: '搭档' }, { k: '助理', t: '助理' }, { k: '朋友', t: '朋友' }, { k: '家人', t: '家人' }, { k: '其他', t: '其他' }],
      },
    ],
  },
  { title: '我在这儿是什么位置？', lead: '这一条最要紧——它不是配置，是往后所有事的底。选一个。', questions: [{ kind: 'chips', key: 'role', label: '选一个', options: OPTS.role.map((o) => ({ k: o.k, t: o.b, d: o.d })), required: true }] },
  { title: '我该怎么跟你说话？', lead: '选一个。这一段会进声音层，每轮对话强制生效。', questions: [{ kind: 'chips', key: 'tone', label: '选一个', options: OPTS.voice.map((o) => ({ k: o.k, t: o.b, d: o.d })), required: true }] },
  { title: '我该是什么性子？', lead: '选一个。', questions: [{ kind: 'chips', key: 'traits', label: '选一个', options: OPTS.persona.map((o) => ({ k: o.k, t: o.b, d: o.d })), required: true }] },
  {
    title: '事到你手上之前，我先怎么想？', lead: '这一组不互斥，最多挑三个。挑多了就成了空话。',
    questions: [{
      kind: 'multi', key: 'thinking', label: '最多挑三个', max: 3,
      options: OPTS.cognition.map((o) => ({ k: o.k, t: o.b, d: o.d })),
    }],
  },
  {
    title: '我们怎么共事？', lead: '三件小事，各二选一。这三条决定我敢不敢拦你。',
    questions: [
      // 【2026-10-14】选项内容改为**引用抽取源**（⛔ 不再手抄 —— 手抄是"将来错位"的入口）。
      //   `label` 保留向导自己的短问法（原型那句 "大事怎么走？" 更长，是有意的 UI 选择）。
      { kind: 'chips', key: 'teamwork1', label: '① 有想法时', options: pairOf(OPTS.coWork[0]) },
      { kind: 'chips', key: 'teamwork2', label: '② 不同意你时', options: pairOf(OPTS.coWork[1]) },
      { kind: 'chips', key: 'teamwork3', label: '③ 说话分寸', options: pairOf(OPTS.coWork[2]) },
    ],
  },
  {
    title: '哪些是打死也不能破的？', lead: '默认全给你勾上了——这几条本来就不该是选项。要松掉哪条，自己点。',
    questions: [{
      kind: 'multi', key: 'redlines', label: '默认全勾', max: 99,
      // 【2026-10-14】同上：引用抽取源（原型这组字段是 t/s，`s` 是说明，这里同样只取 k/t）
      options: OPTS.values.map((v) => ({ k: v.k, t: v.t })),
    }],
  },
  {
    title: '你希望的我是？', lead: '四道题，二选一。不用懂 MBTI——按你想要的相处方式答就行。',
    questions: [
      { kind: 'chips', key: 'axisIE', label: '安静还是主动', options: pairOf(OPTS.axes[0]) },
      { kind: 'chips', key: 'axisNS', label: '联想还是就事论事', options: pairOf(OPTS.axes[1]) },
      { kind: 'chips', key: 'axisTF', label: '直说还是先顾感受', options: pairOf(OPTS.axes[2]) },
      { kind: 'chips', key: 'axisJP', label: '有准谱还是留活口', options: pairOf(OPTS.axes[3]) },
    ],
  },
  {
    title: '它要不要自己长？', lead: '这件事得你点头。没有默认值，选一个才能往下走。',
    questions: [{
      kind: 'chips', key: 'selfGrow', label: '选一个', required: true,
      options: [{ k: 'on', t: '开着吧 —— 我会从对话里自己长。你不用管。' }, { k: 'off', t: '先不要 —— 只保留我手写的那几条。对话不留档，也不自动学。' }],
    }],
  },
  { title: '行了', lead: '下面这些会写进你的记忆容器。之后在「记忆」页里随时改。', questions: [] },
]
const TOTAL = STEPS.length

const T = {
  /** 原型 `.ob-view .card`：`--r-panel`（28px）+ `elev-prominent` */
  rPanel: 28,
  bg: 'var(--dsw-alias-bg-base, #fff)',
  card: 'var(--dsw-specific-sidebar-fill, #f9fafb)',
  card2: 'var(--dsw-specific-selector, #f5f6f7)',
  line: 'var(--dsw-alias-border-l1, rgba(0,0,0,.04))',
  text: 'var(--dsw-alias-label-primary, #0f1115)',
  text2: 'var(--dsw-alias-label-secondary, #61666b)',
  idle: 'var(--dsw-alias-state-idle-primary, #d4d4d4)',
  brand: 'var(--dsw-alias-brand-primary, #0f1115)',
  elevPanel: 'var(--dsw-elevation-panel, 0 0 0 .5px rgba(0,0,0,.10), 0 3px 8px 0 rgba(0,0,0,.03), 0 0 16px 0 rgba(0,0,0,.02))',
} as const

const ctrl: CSSProperties = { width: '100%', fontFamily: 'inherit', fontSize: 13.5, color: T.text, background: T.card2, border: 'none', borderRadius: 9, padding: '11px 13px', outline: 'none' }
const footBtn = (primary: boolean, disabled: boolean): CSSProperties => ({
  fontFamily: 'inherit', fontSize: 12.5, padding: '8px 18px', borderRadius: 9, border: 'none', cursor: disabled ? 'default' : 'pointer',
  background: primary ? T.brand : T.card, color: primary ? T.bg : T.text, fontWeight: primary ? 600 : 400, opacity: disabled ? 0.45 : 1,
})

export function OnboardingWizard({ onDone, onSkip, identity }: OnboardingWizardProps): ReactNode {
  const [step, setStep] = useState(0)
  const [ans, setAns] = useState<Record<string, unknown>>({ redlines: ['v1', 'v2', 'v3', 'v4', 'v5'] })   // 底线默认全勾
  const cur = STEPS[step]!
  /** 预览：本次已填优先，否则回落到已存档案（与主页面同一套规则） */
  const preview = useMemo(() => resolveIdentityPreview(ans, (typeof identity === 'object' && identity) || undefined), [ans, identity])

  /** 必填校验：原型底部那句「两处必填 · 一处可空」就是按它算的 */
  const missing = useMemo(
    () => cur.questions.filter((q) => 'required' in q && q.required && !ans[q.key]).map((q) => q.key),
    [cur, ans],
  )
  const canNext = missing.length === 0

  /** 左卡那句话：**每选一项就自己长一句**（原型的设计意图） */
  const growing = useMemo(() => {
    const bits: string[] = []
    if (ans.relation) bits.push(`我们是${String(ans.relation)}`)
    if (ans.tone) bits.push(`说话按你选的来`)
    if (Array.isArray(ans.redlines) && ans.redlines.length) {
      // 【2026-10-14】这份 `v1..v5 → 文案` 原来也是**手抄**的（除了 OPTS 与选项列表，这是第三份）
      //   ⇒ 改为从抽取源派生（⛔ 判据 `test/wizard-single-source.test.mjs` 就是抓这个的）
      const names: Record<string, string> = Object.fromEntries(OPTS.values.map((v) => [v.k, v.t]))
      bits.push(`底线：${(ans.redlines as string[]).map((k) => names[k] ?? k).join('、')}`)
    }
    if (ans.selfGrow) bits.push(ans.selfGrow === 'on' ? '我会从对话里自己长' : '我只保留你手写的')
    return bits
  }, [ans])

  const set = (k: string, v: unknown): void => setAns((a) => ({ ...a, [k]: v }))

  return (
    <div style={{ position: 'absolute', inset: 0, background: T.bg, overflow: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      {/* 背景光斑（原型里的 blobs）—— 纯装饰，⛔ 不参与布局 */}
      <div aria-hidden style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
        <div style={{ position: 'absolute', left: '-6%', top: '-10%', width: 420, height: 420, borderRadius: '50%', background: 'rgba(96,165,250,.18)', filter: 'blur(60px)' }} />
        <div style={{ position: 'absolute', right: '-4%', bottom: '-12%', width: 460, height: 460, borderRadius: '50%', background: 'rgba(34,197,94,.16)', filter: 'blur(70px)' }} />
      </div>

      {/* 两张卡并排 */}
      <div style={{ position: 'relative', display: 'grid', gridTemplateColumns: 'minmax(280px, 460px) minmax(360px, 660px)', gap: 18, width: '100%', maxWidth: 1160 }}>
        {/* ── 左卡：它正在变成什么样 ── */}
        <section style={{ background: T.card, borderRadius: T.rPanel, boxShadow: 'var(--dsw-elevation-prominent, 0 0 0 .5px rgba(0,0,0,.10), 0 3px 8px 0 rgba(0,0,0,.04), 0 0 20px 0 rgba(0,0,0,.05))', padding: '26px 26px 22px', display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 13, color: T.text2, marginBottom: 22 }}>它正在变成什么样</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <label title='点这里选头像（可跳过）' style={{ width: 58, height: 58, borderRadius: '50%', background: T.card2, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: T.text2, textAlign: 'center', lineHeight: 1.2, cursor: 'pointer', overflow: 'hidden', flex: '0 0 auto' }}>
              {preview.avatar
                ? <img src={preview.avatar} alt='头像' style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                : <>头像<br />可跳过</>}
              <input type='file' accept='image/*' style={{ display: 'none' }} onChange={(ev) => {
                const file = ev.target.files?.[0]
                if (!file) return
                const reader = new FileReader()
                reader.onload = () => {
                  const patch = avatarPatchFromDataUrl(String(reader.result ?? ''))
                  if (patch) set('avatar', patch.avatar)
                }
                reader.readAsDataURL(file)
              }} />
            </label>
            <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <b style={{ fontSize: 15, color: T.text }}>{preview.name || '—'}</b>
              <span style={{ fontSize: 12.5, color: T.text2 }}>{(ans.relation as string) || '还未确定关系'}</span>
            </span>
          </div>
          {/* 会长的那段话 */}
          <div style={{ background: T.bg, borderRadius: 12, padding: '16px 18px', marginTop: 22, fontSize: 13.5, lineHeight: 1.75, color: T.text, minHeight: 96 }}>
            {growing.length ? growing.join('；') + '。' : <span style={{ color: T.text2 }}>你每选一项，这段话就自己长一句。</span>}
          </div>
          <div style={{ marginTop: 'auto', paddingTop: 18, borderTop: `1px solid ${T.line}`, fontSize: 12, color: T.text2, lineHeight: 1.7 }}>
            全部存在你自己的机器上 · 随时可改可删<br />现在写下的，下一轮对话就会生效
          </div>
        </section>

        {/* ── 右卡：问题 ── */}
        <section style={{ background: T.card, borderRadius: T.rPanel, boxShadow: 'var(--dsw-elevation-prominent, 0 0 0 .5px rgba(0,0,0,.10), 0 3px 8px 0 rgba(0,0,0,.04), 0 0 20px 0 rgba(0,0,0,.05))', padding: '22px 26px', display: 'flex', flexDirection: 'column' }}>
          {/* 10 段进度条 + 「第 N 步 / 共 10 步 · 标题」 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18 }}>
            <div style={{ display: 'flex', gap: 4, flex: '0 0 auto' }}>
              {Array.from({ length: TOTAL }).map((_, i) => (
                <span key={i} style={{ width: 26, height: 2, borderRadius: 1, background: i <= step ? T.text : T.idle }} />
              ))}
            </div>
            <span style={{ fontSize: 12, color: T.text2 }}>第 {step + 1} 步 / 共 {TOTAL} 步 · {cur.title}</span>
          </div>

          <h2 style={{ fontSize: 19, fontWeight: 700, margin: '0 0 6px', color: T.text }}>{cur.title}</h2>
          <p style={{ fontSize: 13, color: T.text2, margin: '0 0 18px' }}>{cur.lead}</p>

          <div style={{ flex: '1 1 auto', overflow: 'auto' }}>
            {cur.questions.map((q) => (
              <div key={q.key} style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12.5, color: T.text, marginBottom: 7 }}>
                  <b style={{ fontWeight: 600 }}>{q.label}</b>
                  {'hint' in q && q.hint ? <span style={{ color: T.text2, marginLeft: 6 }}>{q.hint}</span> : null}
                </div>

                {q.kind === 'text' && (
                  <input
                    value={(ans[q.key] as string) ?? ''} placeholder={q.placeholder}
                    onChange={(e) => set(q.key, e.target.value)} style={ctrl}
                  />
                )}

                {(q.kind === 'chips' || q.kind === 'multi') && (q.options.length === 0 ? (
                  // ⛔ 原型里有、我还没从它的 JS 里抽全 —— 如实说出来，不编选项
                  <div style={{ fontSize: 12, color: T.text2, background: T.card2, borderRadius: 9, padding: '10px 12px' }}>
                    这一组的选项还没从原型里抽全（TODO）—— 我不编，等抽完再填。
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {q.options.map((o) => {
                      const on = q.kind === 'multi'
                        ? Array.isArray(ans[q.key]) && (ans[q.key] as string[]).includes(o.k)
                        : ans[q.key] === o.k
                      return (
                        <button
                          key={o.k}
                          onClick={() => {
                            if (q.kind === 'multi') {
                              const list = ((ans[q.key] as string[]) ?? []).slice()
                              const i = list.indexOf(o.k)
                              if (i >= 0) list.splice(i, 1)
                              else if (list.length < (q.max ?? 99)) list.push(o.k)
                              set(q.key, list)
                            } else set(q.key, on ? undefined : o.k)
                          }}
                          style={{
                            fontFamily: 'inherit', fontSize: 12.5, padding: '8px 15px', borderRadius: 999, cursor: 'pointer', border: 'none',
                            background: on ? T.brand : T.bg, color: on ? T.bg : T.text2, fontWeight: on ? 600 : 400,
                          }}
                        >{o.d ? (
                          /* 原型里选项是「标题 + 描述」两行（`OPTS` 的 b / d）——
                             ⚠️ 我先前只渲染了标题 ⇒ 判据（要求页面出现「你扛事，我扛立场」）**当场红**，
                             才发现把描述整段丢了。这里补回来。 */
                          <>
                            <span style={{ display: 'block' }}>{o.t}</span>
                            <span style={{ display: 'block', fontSize: 11.5, opacity: 0.85, marginTop: 2, fontWeight: 400 }}>{o.d}</span>
                          </>
                        ) : o.t}</button>
                      )
                    })}
                  </div>
                ))}
              </div>
            ))}

            {step === TOTAL - 1 && (
              <div style={{ fontSize: 12.5, color: T.text2, lineHeight: 1.8 }}>
                写进容器的：你刚填的身份与偏好（走 `/identity`）；<br />
                {/* ⛔ 【2026-10-14 对抗验证 F 修】**原文这句是假的**：
                    "声音层另存一份 voice.md" —— 全仓 `voiceFile` **只有读、没有写入口**，
                    这一步根本不碰那个文件。本仓的纪律是"没实现就别说做了"，所以改成真话
                    （而且真话更有用：那个文件是**每轮现读**的，手改存盘下一轮就生效）。 */}
                声音层（<code>voice.md</code>）是**手写维护**的，这一步**不会**动它；
                但它是**每轮现读**的 —— 你改完存盘，下一轮就生效；<br />
                人格锚点（h01–h11）**不会被这一步覆盖** —— 它们只人工维护。
              </div>
            )}
          </div>

          {/* 底部：上一步 · 提示 · 下一步 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 16, borderTop: `1px solid ${T.line}` }}>
            <button onClick={() => (step === 0 ? onSkip() : setStep(step - 1))} style={footBtn(false, false)}>
              {step === 0 ? '先跳过' : '上一步'}
            </button>
            <span style={{ flex: 1, textAlign: 'center', fontSize: 12, color: T.text2 }}>
              {missing.length ? `${missing.length} 处必填还没填` : '可以下一步'}
            </span>
            <button
              disabled={!canNext}
              onClick={() => (step === TOTAL - 1 ? onDone(toContract(ans)) : setStep(step + 1))}
              style={footBtn(true, !canNext)}
            >{step === TOTAL - 1 ? '完成' : '下一步'}</button>
          </div>
        </section>
      </div>
    </div>
  )
}
