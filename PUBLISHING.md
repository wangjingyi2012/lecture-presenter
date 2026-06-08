# Publishing to GitHub / 发布到 GitHub

## Recommended Approach / 推荐方式

Use a clean release repository instead of pushing this working repository directly. The current working repository has previously tracked files that should not be published, so rewriting or reusing its history is unnecessary risk.

不要直接推送当前工作仓库历史。当前仓库历史中曾经跟踪过不适合公开发布的文件，公开发布应使用干净副本重新初始化 Git。

## What to Publish / 应发布内容

- `lecture-app/`
- `COURSE_FORMAT.md`
- `README.md`
- `.gitignore`
- `.github/workflows/build-windows.yml`

## What Not to Publish / 不应发布内容

- `update-server/`
- deployment scripts such as `sync-to-server.sh`
- databases such as `*.db`, `*.sqlite`, `*.sqlite3`
- `.env*`
- personal course folders or private teaching materials
- real API keys, tokens, signing keys, or certificates

## Per-Repository Git Identity / 单项目 Git 身份

Keep your global Git identity unchanged for Gitee or other projects. In the GitHub release repository, set identity locally:

```bash
git config user.name "wangjingyi2012"
git config user.email "YOUR_GITHUB_EMAIL@example.com"
```

This writes to that repository's `.git/config` only and will not affect other projects.

## Authentication / 认证

For GitHub, use one of these:

- GitHub CLI: `gh auth login`
- HTTPS remote plus a GitHub Personal Access Token when Git prompts
- SSH remote with a GitHub SSH key

If your global config rewrites SSH GitHub URLs to HTTPS, the current global rule is:

```bash
git config --global --get-regexp '^url\\.'
```

Remove it only if you want SSH remotes to stay SSH globally:

```bash
git config --global --unset url.https://github.com/.insteadof
```

For this project only, an HTTPS remote is fine:

```bash
git remote add origin https://github.com/wangjingyi2012/lecture-presenter.git
```

## First Push / 首次推送

From the clean release repository:

```bash
git add .
git commit -m "Initial public client release"
git branch -M main
git push -u origin main
```
