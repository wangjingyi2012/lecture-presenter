# Lecture Web 后端项目位置与部署信息

- 仓库：`/Users/jingyi.wang/Documents/workspace/lecture-presenter-public-web`（Lecture Web，演讲宝的云 Web 版，独立于桌面端 update-server）。
- 后端：`backend/`，FastAPI，入口 `backend/app/main.py`，路由前缀 `/api/web/...`。
- 测试：`backend/tests/`（pytest），运行方式：`cd backend && .venv/bin/pytest tests`（已有 `.venv`）。
- 前端：`frontend/`（静态文件，随 Docker 镜像一起 COPY）。
- 本地数据库：仓库根目录 `lecture_web.db`（SQLite，勿提交到公共仓库）。

## 服务器

- 连接：`ssh -p 52222 root@154.19.186.138`（已配本地 root 免密）。
- **服务器上有多个业务，操作必须只影响 lecture-web**：Docker 容器包括 `vsep-backend`、`vsep-frontend`、`vsep-student-frontend`、`vsep-backend-dryrun`、`hz-new-api`、`update-server`、`redis`、`mysql8`、`lecture-web`。不要执行 `docker compose down`、`docker system prune`、重启 nginx 之外的兜底操作；docker compose 命令只在 `/opt/lecture-web` 目录内执行。
- 部署目录：`/opt/lecture-web`（**不是 git 仓库**，纯源码目录，用 rsync 同步代码；`.env.prod` 也在那里）。
- 域名与 nginx（`/etc/nginx/sites-available/open-design`）：
  - `https://design.hz-study-system.com/` → `127.0.0.1:8090`（lecture-web，根路径 302 到 `/app/`）
  - `https://design.homework.it.com/` → `127.0.0.1:8080`（update-server）
  - 证书：letsencrypt `/etc/letsencrypt/live/design.hz-study-system.com/`
- MySQL 容器 `mysql8` 映射在宿主 `3307`；redis 在 `6379`（注意 6379 对公网开放）。

## 部署流程（沿用既往惯例）

1. 本地跑测试：`cd backend && .venv/bin/pytest tests`。
2. 服务器备份：`cp -a /opt/lecture-web /root/deploy-backups/lecture-web-<ts>`，并打回滚镜像 `docker tag lecture-web:latest lecture-web:pre-redeploy-<ts>`。
3. rsync 改动文件到 `/opt/lecture-web/backend/`（可先对比 md5 确认服务器与本地无其他分叉）。
4. `cd /opt/lecture-web && docker compose build api && docker compose up -d api`（只重建 lecture-web，不影响其他容器）。
5. 验证：容器 healthy、`curl http://127.0.0.1:8090/healthz/ready` 200、`https://design.hz-study-system.com/app/` 200、`docker ps` 确认其他容器 uptime 未变。
6. 在 web 仓库 `.gstack/deploy-reports/` 写部署报告（格式见 `2026-07-11-ed757e0-redeploy.md`）。

**前端缓存**：StaticFiles 不发 Cache-Control，浏览器会长期缓存 `app.js` / `styles.css`。`index.html` 里的引用带 `?v=YYYYMMDD` 版本号，每次改前端部署时必须 bump，否则用户看不到更新（2026-07-25 踩过坑）。

## 部署

- `Dockerfile`：python:3.12-slim 多阶段构建，CMD 为 `uvicorn app.main:app --host 0.0.0.0 --port 8090 --workers 1`，工作目录 `/app/backend`。
  - **必须保持 `--workers 1`**：验证码（`captcha_store`）和登录限流都是进程内存实现，多 worker 时登录会间歇性报「验证码错误或已过期」（2026-07-25 线上事故修复）。要扩 worker 需先把验证码/限流改成 DB 或 Redis 共享存储。
- `docker-compose.yml`：单服务 `api`，镜像 `lecture-web:latest`，容器名 `lecture-web`，端口映射 `127.0.0.1:8090:8090`，env 文件 `.env.prod`（不入库，模板为 `.env.prod.example`），存储卷 `./backend/storage:/opt/lecture-web/backend/storage`，健康检查 `/healthz/ready`。
- 生产必需环境变量：`LECTURE_WEB_APP_ENV=production`、`LECTURE_WEB_SECRET_KEY`、`LECTURE_WEB_DATABASE_URL`（MySQL）、`LECTURE_WEB_STORAGE_ROOT`、`LECTURE_WEB_LLM_*`（provider/api_key/base_url/model）。
- 桌面端通过 `updateServer` 设置指向同一公网源，反代路径 `/app/` 和 `/api/web/`。

## 认证相关约定

- 密码哈希：`app/core/security.py`，bcrypt（rounds=12），先 SHA-256 预哈希规避 bcrypt 72 字节限制。
- 登录需验证码 + 限流（`app/services/security/`）；注册/登录/改密均写审计日志（`create_audit_log`，action 形如 `auth.login` / `auth.change_password`）。
- 会话：JWT（HS256），经 `Authorization: Bearer`、`?token=` 或 `lecture_web_token` cookie 传递，见 `app/api/deps.py:get_current_user`。
