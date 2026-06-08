# Publishing to GitHub / 发布到 GitHub

## Recommended Approach / 推荐方式

This directory is the GitHub working repository for Lecture Presenter. Make future public client changes here and push from here.

这个目录是 Lecture Presenter 的 GitHub 工作仓库。后续公开客户端代码建议都在这里维护并从这里推送。

## What to Publish / 应发布内容

- `lecture-app/`
- `COURSE_FORMAT.md`
- `README.md`
- `.gitignore`
- `.github/workflows/build-windows.yml`

## Keep Out of Git / 不应提交内容

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

From this repository:

```bash
git add .
git commit -m "Initial public client release"
git branch -M main
git push -u origin main
```

## macOS Releases / macOS 发布

macOS installers are built by `.github/workflows/build-macos.yml`.

Tag pushes such as `v0.1.0` create or update a GitHub Release with two DMG files:

- `Lecture-Presenter_0.1.0_macOS_aarch64.dmg` for Apple Silicon Macs, including M1/M2/M3/M4.
- `Lecture-Presenter_0.1.0_macOS_x64.dmg` for Intel Macs.

Create a release from the repository root:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The workflow can also be run manually from GitHub Actions. Manual runs upload the
DMGs as workflow artifacts but do not create a GitHub Release unless the run is
triggered by a tag.

### Signing and Notarization / 签名与公证

The current public workflow builds unsigned DMGs. macOS users may see a Gatekeeper
warning when opening them. For a polished public release, configure an Apple
Developer ID certificate and notarization credentials in GitHub Actions secrets.
