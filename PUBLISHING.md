# Publishing / 发布手册

Lecture Presenter（演讲宝）的完整发布流程。当前处于开发前期、发布频繁，按本手册执行即可。

## 仓库边界 / Repository Layout

- **本仓库（公开，GitHub `lecture-presenter`）**：桌面端全部代码（`lecture-app/`）。发布的安装包从这里构建。
- **Web 后端仓库（私有，GitHub `lecture-presenter-web`）**：LectureAI 云服务、版本检查端点。部署流程见该仓库的部署规范（备份 → rsync → `docker compose build api && up -d api` → 验证 → 部署报告）。

公开发布只涉及本仓库 + 服务器上一个 JSON 文件，不需要重新部署后端。

## 不应提交的内容 / Keep Out of Git

- `*.db` / `*.sqlite*`
- `.env*`
- 个人课程文件夹或私有教学材料
- 真实 API keys、tokens、签名密钥、证书

## 日常提交 / Commit & Push

- 提交信息用祈使句、措辞中立（如 `feat: stream LectureAI chat via SSE with non-streaming fallback`），不在提交信息或公开注释里讨论源码可见性策略。
- 内部实现术语（Pi、工具 id 等）不进用户可见文案。
- 推送前跑对应测试：前端改动跑 `lecture-app/scripts/test-*.js` 中匹配的脚本，Rust 改动跑 `cargo test`（`src-tauri/` 内）。

## 版本号位置 / Where the Version Lives

发新版必须同步改这两处（二者保持一致）：

- `lecture-app/package.json` → `"version"`
- `lecture-app/src-tauri/tauri.conf.json` → `"version"`

`src-tauri/Cargo.toml` 的 version 不参与安装包版本号，无需同步。

## 发布步骤 / Release Steps

以 2.2.1 为例：

```bash
# 1.  bump 上面两处版本号，提交并推送 main
git add lecture-app/package.json lecture-app/src-tauri/tauri.conf.json
git commit -m "chore: bump version to 2.2.1"
git push

# 2. 打 tag 并推送 —— 触发 GitHub Actions 构建
git tag v2.2.1
git push origin v2.2.1

# 3. 观察构建（约 6-10 分钟）
gh run list --repo wangjingyi2012/lecture-presenter --limit 4
```

Tag 推送会触发两个 workflow，并自动创建/更新同名的 GitHub Release：

- `.github/workflows/build-macos.yml` → `Lecture-Presenter_2.2.1_macOS_aarch64.dmg`（Apple Silicon）+ `..._x64.dmg`（Intel）
- `.github/workflows/build-windows.yml` → Windows 安装包

手动在 GitHub Actions 页面触发 workflow 只会产出 artifacts，不会创建 Release；只有 tag 推送才发版。

## 让客户端收到更新提示 / Update Check JSON

桌面端启动时请求 `GET {serverUrl}/api/version/check?current=x.y.z`，数据源是**服务器上的一个 JSON 文件**，发版后必须更新它，否则用户收不到更新提示：

```bash
# 编辑服务器上的 /opt/lecture-web-data/desktop-release.json（无需重启任何服务）
{
  "version": "2.2.1",
  "download_url": "https://github.com/wangjingyi2012/lecture-presenter/releases/latest",
  "changelog": "## Lecture Presenter 2.2.1\n\n<更新内容，Markdown>",
  "force_update": false
}
```

- 等 GitHub Release 构建完成、DMG 上架后再改，避免用户点了「立即更新」却下载不到新包。
- 验证：`curl "https://design.hz-study-system.com/api/version/check?current=2.2.0"` 应返回 `has_update: true`；`current=2.2.1` 应返回 `false`。
- 版本比较按数字段进行（2.10.0 > 2.9.0）；`force_update: true` 时客户端只保留「立即更新」按钮。
- 本地模板在 `tmp/desktop-release.json`。

## 本地打包与安装 / Local Build & Install

本机（macOS Apple Silicon）自用安装，不走 GitHub Release：

```bash
cd lecture-app
npx tauri build --target aarch64-apple-darwin   # 不要用 npm run build -- -- --target（双 -- 不可靠）
```

产物在 `src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Lecture Presenter.app`。

替换 `/Applications` 前必须：

```bash
# 1. 重签名（构建产物可能带破损的 linker 签名）
codesign --force --deep --sign - "Lecture Presenter.app"
codesign --verify --deep --strict "Lecture Presenter.app"

# 2. 确认应用已退出
pgrep -fl "Lecture Presenter"

# 3. 替换
rm -rf "/Applications/Lecture Presenter.app"
cp -a "Lecture Presenter.app" /Applications/
```

注意事项：

- **备份副本不要留在 `/Applications`**：旧 `.app` 备份会被 Spotlight/Launchpad 索引，名字图标相同极易误开旧版本。备份移到 `/Applications` 之外。
- **WKWebView 缓存坑**：换包后首启若出现「旧 UI 混新功能」，退出应用 → 删 `~/Library/Caches/com.lecture.presenter/WebKit/NetworkCache` → 重开。勿删整个 `~/Library/WebKit/com.lecture.presenter`（含 localStorage 登录态）。
- 默认 Rust 工具链可能是 Rosetta 下的 x86_64，务必显式指定 `--target aarch64-apple-darwin`。

## 签名与公证 / Signing & Notarization

当前公开 workflow 构建的是**未签名** DMG，用户打开会有 Gatekeeper 提示。正式发布如需更顺滑体验，在 GitHub Actions secrets 配置 Apple Developer ID 证书与公证凭据。

## 发布检查单 / Checklist

1. ☐ 测试通过（前端 node 脚本 + `cargo test`）
2. ☐ 两处版本号 bump 并推送 main
3. ☐ `git tag v*` 并推送，Actions 两个 workflow 全绿
4. ☐ GitHub Release 页面确认 DMG/安装包已上架
5. ☐ 更新服务器 `desktop-release.json` 并用 curl 双向验证（旧版本 true / 新版本 false）
6. ☐ 本机 `/Applications` 替换为新版（重签名 + 退出旧进程 + 清 NetworkCache 备选）

## 单项目 Git 身份 / Per-Repository Git Identity

保持全局 Git 身份不变，仅在本仓库设置：

```bash
git config user.name "wangjingyi2012"
git config user.email "YOUR_GITHUB_EMAIL@example.com"
```

## 认证 / Authentication

- GitHub CLI：`gh auth login`
- 或 HTTPS remote + Personal Access Token
- 或 SSH remote + GitHub SSH key

本仓库使用 HTTPS remote：

```bash
git remote add origin https://github.com/wangjingyi2012/lecture-presenter.git
```
