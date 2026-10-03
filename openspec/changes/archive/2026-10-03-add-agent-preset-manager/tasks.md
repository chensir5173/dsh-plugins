# Tasks: add-agent-preset-manager

> 归档补记（2026-10-03）：实现落地时测试文件名与计划不同 —— 原计划的 `test/host-core.test.mjs` 与 `test/client-render.test.mjs` 分别落在 `test/bundle.test.mjs`（39 例）与 `test/client.test.mjs`（5 例）；除 6.3 外各条均已完成并验证。

## 0. 前置状态（已完成）

- [x] 0.1 创建 change 并填充 proposal.md，验证 `openspec validate add-agent-preset-manager --strict` 输出 valid
- [x] 0.2 填充 specs/agent-preset-manager/spec.md（Purpose + 12 条 ADDED Requirement），验证 --strict 通过
- [x] 0.3 填充 design.md（D1–D10 决策、风险、迁移计划），验证 --strict 通过

## 1. 包骨架

- [x] 1.1 新建 `sub-plugins/dsh-agent-preset-manager/`，写 package.json（name `dsh-agent-preset-manager`、version 0.1.0、`type: module`、`main: src/index.js`、exports `.`/`./client`/`./package.json`、`dsh.client.platform: web`、**不声明** `dsh.bundle`、engines node >=20、files 含 src/README.md/ACCEPTANCE.md），验证 `node -e "JSON.parse(require('fs').readFileSync('sub-plugins/dsh-agent-preset-manager/package.json','utf8'))"` 通过且 `dsh.bundle` 不存在
- [x] 1.2 建 src/ 与 test/ 骨架（src/host-core.js、src/index.js、src/client.js、test/host-core.test.mjs、test/bundle.test.mjs 占位），验证 `node --check` 对三个 src 文件与 `node --test sub-plugins/dsh-agent-preset-manager/test` 都能执行（占位测试先通过）

## 2. host 半区核心逻辑（纯函数，可离线测）

- [x] 2.1 实现目录扫描与状态推导（两类目录、preset.yml 元数据、agent.cordis.yml 行清单、位置冲突时旧目录优先、目录不存在=空集、元数据不可读回退目录名），验证 host-core 单测覆盖 spec 场景「两个目录都有内容 / 目录不存在 / 元数据不可读 / 同一 id 出现在两个目录」
- [x] 2.2 实现组成行读取与校验（YAML 解析、行必须是含非空 name 的映射、`cordis:group` 递归、解析失败给出「哪一行、缺什么」），验证单测覆盖「组成内容无效」并断言错误文本含行号
- [x] 2.3 实现 id 校验与撞车判定（`^[a-z0-9][a-z0-9_-]{0,63}$`、与两目录既有 id/已声明 id 比对），验证单测覆盖「id 非法」「id 撞车」两类场景
- [x] 2.4 实现行名可用性体检（`cordis:` 内置行、`./x`/绝对路径查文件、`@deepseek-ai/dsh-*` 与裸包名走注入的 resolver + 子路径 exports 检查、分组行递归、三色 + 具名理由），验证单测覆盖「包已从发行物移除」「相对文件缺失」「组行递归」并断言理由含行 id 与原行名
- [x] 2.5 实现启用集合状态（`$DSH_HOME/agent-preset-manager/state.json` 的读/写/迁移、缺失=空集、JSON 损坏降级空集并置提示标志、写入原子替换），验证单测覆盖「状态文件损坏」「状态里有已消失的 id」
- [x] 2.6 实现文件写入原语（备份到 `<id>/.backup/` 保留最近 3 份、写临时文件后 rename 的原子替换、备份失败即拒绝），验证单测覆盖「保存后生成备份」「备份不超过 3 份」「备份失败则不落盘」
- [x] 2.7 实现骨架读取（从宿主 `@deepseek-ai/dsh-web-app/presets/standard.patch.yml` 的 `preset-standard` 行取 `config.plugins`，优先用 profile 的 js-yaml，缺失时用内置极简 YAML 子集解析），验证单测覆盖「骨架来源不可读则拒绝且不留半成品」并对真实文件跑一次解析得到非空行数组
- [x] 2.8 实现导入与迁移（源目录校验、id 校验与撞车、复制时跳过 `.backup/` 与隐藏临时文件、失败清理已创建部分、迁移不删旧目录），验证单测覆盖「导入成功」「路径不是预设目录」「目标 id 已存在」「迁移旧预设」「迁移前提示不可用行」「不覆盖已有新条目」
- [x] 2.9 跑 `node --test test/host-core.test.mjs` 并确认 spec 第 2/6/7/9/10/11 条 Requirement 的每个 Scenario 都有对应用例名

## 3. host 半区 HTTP 与注册表接线

- [x] 3.1 实现端点层 `GET /__dsh-agent-presets/state` 与 `POST /set-enabled|create|save|remove|import|migrate`（写操作统一返回最新完整 state，失败返回 `{ ok: false, error }`），验证 `test/host-endpoints.test.mjs` 用注入的假 webServer 断言每个端点存在、参数校验与响应形状
- [x] 3.2 实现注册表运行时发现与降级（探测到服务→读 state.json 重放启用集合；探测不到→只读模式，写操作返回明确错误且零磁盘副作用），验证单测覆盖「重启后自动恢复」「首次安装不自动启用」「注册表服务缺失」
- [x] 3.3 实现启用/停用接线（用被声明预设自己的目录作 baseUrl 发起声明、保存撤销句柄、捕获注册表拒绝并按「id 重复」「组成无效」「服务需要 isolate realm」分类回显宿主原文、失败不阻断其它预设），验证单测覆盖「启用后新会话可选到它」「相对行名按预设目录解析」「id 与已声明预设撞车」「服务泄漏到全局 realm」
- [x] 3.4 实现删除语义（先撤销声明 → 清 state 记录 → 删目录；目录删失败时返回「已停用，但目录未能删除」+ 原因），验证单测覆盖「停用不动磁盘」「删除启用中的预设」「删除过程中目录删除失败」
- [x] 3.5 端到端静态验证：断言本包源码中不出现对 profile `cordis.patch.yml`、profile package.json、`dsh.profile.bundles` 的任何写操作，验证 `test/bundle.test.mjs` 的「不干扰既有 setup」用例通过

## 4. client 半区（本地插件页 tab）

- [x] 4.1 实现 client 模块加载外壳（`window.__ModuleLoader__.load({ id: 'dsh-agent-preset-manager', factory })`、返回 `{ apply, inject: ['slots'] }`、无 JSX 只用 React.createElement），验证 `node --check src/client.js` 与 bundle.test.mjs 的「bundle 形状」用例（有 load 调用、无 JSX 语法、无宿主 UI 包 require）通过
- [x] 4.2 实现 tab 注册（`ctx.slots.inject('settings.localPlugins.tab', () => ctx.slots.register({ name: 'settings.localPlugins.tab', id: 'agent-presets', order: 20, label: 'Agent 预设' }, Panel))`；槽缺失时静默跳过），验证用假 slots ctx 断言注册参数，并在本机 web profile 刷新后确认 tab 出现在「本地插件」之后
- [x] 4.3 实现列表视图（显示名/描述/来源目录/行数/状态徽标 + 三色体检明细 + 启用失败原文 + 只读模式提示），验证用假 ctx 渲染快照断言：状态徽标文案与 state 一致、不可用行显示行 id 与原行名、只读模式下开关禁用
- [x] 4.4 实现开关交互与乐观刷新（点击→POST→用返回的最新 state 重绘；错误原位提示），验证渲染断言：成功后该行变 `已启用`、失败时显示宿主原文且其它行不受影响
- [x] 4.5 实现新增/编辑/导入/迁移/删除五个操作面（新增表单含 id 正则提示与撞车报错、YAML 编辑区与保存、导入填绝对路径并先展示「将导入的 id/显示名/行数」确认、迁移按钮与不可用行提示、删除二次确认含绝对路径），验证渲染断言覆盖每个操作面的关键文案与禁用条件
- [x] 4.6 跑 client 侧自检脚本（`node sub-plugins/dsh-agent-preset-manager/test/client-render.test.mjs`）并确认 spec 第 1/3/4/8 条的可见行为都有断言

## 5. 文档与仓库一致性

- [x] 5.1 写 `sub-plugins/dsh-agent-preset-manager/README.md`（能力、端点清单、目录约定、已知限制、与第三方预设中心的关系），验证文档里的每条命令/端点都能在 src 中检索到对应实现
- [x] 5.2 写 `sub-plugins/dsh-agent-preset-manager/test/bundle.test.mjs`（包契约、exports、无 dsh.bundle、client bundle 形状、端点清单、不写 profile），验证 `node --test sub-plugins/dsh-agent-preset-manager/test` 全绿
- [x] 5.3 写 `sub-plugins/dsh-agent-preset-manager/ACCEPTANCE.md`（按 spec 的 12 条 Requirement 逐条给出人工验收步骤与预期），验证每条 Requirement 至少有一条可执行步骤且与 spec 场景一一对应
- [x] 5.4 按 AGENTS.md 约束同步递增版本（根壳 package.json 与 dsh-plugin-manager/package.json 保持一致）并跑 `node --test dsh-plugin-manager/test`，验证 root-install-shell.test.mjs 断言通过

## 6. 校验与验收（停在此处等用户确认）

- [x] 6.1 跑全仓测试 `node --test dsh-plugin-manager/test sub-plugins/*/test`，验证无回归
- [x] 6.2 跑 `openspec validate add-agent-preset-manager --strict`，验证输出 valid，并**停止**（不归档，等用户确认）
- [ ] 6.3 经用户同意后，用本仓 dsh-plugin-manager 面板把新包接入 web profile（devDependency link + stable-id 行），刷新页面，端到端验收：迁移 liangshen → 体检三色 → 启用 → 新建会话可选 → 停用 → 删除；记录实际结果（含失败原文）（归档时状态：面板已接入 web profile、启用/停用已在真机验证；「新建会话可选到该预设」未单独确认）
