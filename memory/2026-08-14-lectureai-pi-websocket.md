# LectureAI Pi WebSocket 交接记录

## 状态

截至 2026-08-14，本地 Lecture Presenter 已接入云端 Pi Agent Runtime。用户不需要单独安装 Pi 或 Node。桌面端只保留 PPTE 编辑/保存和本地工具执行，Pi、模型循环、会话 JSONL、上下文压缩、恢复与中止都运行在 Lecture Web 服务端。

## 两仓库

- 桌面仓库：`/Users/jingyi.wang/Documents/workspace/lecture-presenter-public`
  - 分支：`main`
  - Pi 执行提交：`6d2a9ef`
  - WebSocket 子协议鉴权修正：`9cc5e87`
- Web 仓库：`/Users/jingyi.wang/Documents/workspace/lecture-presenter-public-web`
  - 分支：`codex/lectureai-planning`
  - 双向工具桥提交：`c36207d`
  - URL 令牌安全修正：`186ad1a`

两边均已推送到各自 `origin`。桌面仓库已有用户未跟踪内容 `memory/2026-08-13-lectureai-template-generation-quality.md` 和 `模板制作/`，不要误删或加入无关提交。

## 运行链路

```text
Lecture Presenter 工作台
  <-> wss://design.hz-study-system.com/api/web/ai/pi/bridge
FastAPI 鉴权、Deck Plan 门禁、配额处理
  <-> ws://127.0.0.1:8765/bridge
Node Pi Runtime 0.84.1 / Node 22.19.0
  -> 用户配置的服务端模型
```

整套任务先保存 Deck Plan，再分页执行。每页只加载全局精简页序、当前页前后各两页、相邻摘要和阶段审查建议；页面完成后写入 `plan.execution`，每五页做一次教学递进审查。`execution` 中的 `piSessionId`、`piDeckId`、`completedPages`、`summaries`、`stageReviews`、`nextPage`、`status` 用于停止后继续。

Pi 发出 `tool_call` 后，桌面通过 `ppte-workbench-agent.js` 执行当前课件范围内的 `read_slide`、`search_design_examples`、`render_template`、`write_slide`、`insert_slide`、`validate_slide` 等工具，再以相同 `request_id` 回传 `tool_result`。Node Runtime 和桌面各自执行页码、模板 ID、replace/insert 模式与插入位置门禁。页面写入后必须通过 `validate_slide`。

工作台选择非 LectureAI provider 时，仍走旧的客户端页面 Worker；选择 LectureAI 才切换 Pi WebSocket。

## 鉴权与安全

浏览器 WebSocket 不能可靠地自定义 Authorization header，因此使用 `Sec-WebSocket-Protocol`：

- `lectureai.pi.v1`：公开协议名，服务端回选它。
- `lectureai.auth.<JWT>`：只用于握手解析，不回显。

绝对不要把 JWT 放入 `?token=`。第一次实现曾这样做，生产访问日志记录了完整 URL，烟测后已改为子协议并重建容器。普通 HTTP API 仍可使用 `Authorization: Bearer`、query token 或 cookie；该例外只针对 Pi WebSocket。

Tauri CSP 必须允许 `wss://design.hz-study-system.com`。用户点击停止时，客户端发送 `stop`、立即关闭 socket、拒绝当前页 Promise，并阻止下一页启动；服务端断线也会调用 Pi `runtime.stop()`。

## 生产与回滚

- 域名：`https://design.hz-study-system.com`
- 部署目录：`/opt/lecture-web`
- 容器：`lecture-web`，保持单 worker，Pi sidecar 使用 loopback `8765`
- 当前镜像：`sha256:de726a2396e358dcefaa775c6f37921ea7b96f2f82d3570a8d334f019e720593`
- 当前健康检查：`/healthz/ready` 返回 `{"status":"ready"}`；Pi `/health` 为 `ready`、`active: 0`
- 本轮源码备份：`/opt/lecture-web.pre-ws-20260814-150118`
- 本轮旧镜像备份：`lecture-web:pre-ws-20260814-150118`
- 已验证 Nginx Upgrade、真实公网 WebSocket 子协议握手，以及一次 `tool_call -> tool_result -> page_complete` 链路。

桌面安装位置：`/Applications/Lecture Presenter.app`，当前为已签名 arm64 `2.1.0`。原安装备份：`/Applications/Lecture Presenter.app.backup-20260814-150737`。构建命令必须使用：

```bash
cd lecture-app
npx tauri build --target aarch64-apple-darwin
codesign --force --deep --sign - "src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Lecture Presenter.app"
codesign --verify --deep --strict "src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Lecture Presenter.app"
```

## 验证基线

- Web backend：`.venv/bin/pytest -q`，`69 passed`
- Pi Runtime：`npm test`，`9 passed`
- 桌面前端：PPTE、annotator、shared groups、resource center、captions、course manager、auth、workbench 全部通过
- Rust：`cargo test`，`37 passed`、`2 ignored`（需要云语音凭证的 live caption 测试）
- 真实烟测收到：`session_started`、`progress`、`tool_call`、`page_complete`

## 下一步

代码和部署已完成，下一步是用户实际试用。优先测试 20、30、50 页课件，观察模板重复率、页间递进、普通字体投影可读性、Pi 中间进度、停止响应和“继续”恢复。若出现页面质量问题，先检查 Deck Plan 和 `page-worker` 服务端规则，再检查模板选择分布，不要把私有模板骨架复制到桌面仓库。
