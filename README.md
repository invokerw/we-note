# WeNote

WeNote 是一款可自托管的跨设备笔记应用。你可以在网页上写 Markdown、画思维导图，把同一个笔记库同步到电脑或 Android 手机，断网时继续编辑，联网后再同步。

## 写下第一篇笔记

1. 在浏览器打开你的 WeNote 服务地址。如果要在自己的电脑上试用，先按[本地启动步骤](#本地启动)运行服务，再打开 `http://localhost:8080`。
2. 用邮箱和密码登录。首次使用时，选择「创建账户」，输入邮箱和至少 8 位的密码，点击「注册并登录」。如果站点启用了邮箱验证或邀请注册，请按邮件提示操作。
3. 点击「创建笔记库」，输入库名，例如「工作笔记」。之后可以用侧栏笔记库旁的 `＋` 添加其他库。
4. 点击「新建笔记 → Markdown」，输入 `会议记录.md`，写下正文。点击「保存」，或按 `Ctrl+S`（macOS 用 `⌘S`）。已有笔记可以从同一个新建窗口选择「上传文件」或「上传文件夹」导入。

## 编辑和整理

| 想做什么 | 怎么操作 |
| --- | --- |
| 写 Markdown | 默认在「可视化编辑」中直接排版。切到「分屏编辑」可在左边写 Markdown、右边看效果。「预览」支持表格、任务列表、KaTeX 公式和 Mermaid 图表。 |
| 插入图片和附件 | 编辑 Markdown 时，把图片粘贴到正文，或把文件拖入编辑器。单个附件最大 256 MiB，大文件上传中断后可重新选择同一文件续传。 |
| 画思维导图 | 选「新建笔记 → 思维导图」，右键点击画布上的主题，从菜单添加「子主题」。导图保存为 `.mind.json` 文件。 |
| 编辑其他文本 | 上传 `.txt`、`.json`、`.csv`、`.log` 或无扩展名的 UTF-8 文本后即可编辑。要为某种格式安装专用编辑器，可在「插件」页面安装并启用文件插件。 |
| 快速找到笔记 | 在笔记列表的「搜索笔记」中输入名称、路径或已保存正文里的关键词。常用笔记可以点标题栏的星形按钮，再从侧栏「加星」打开。 |
| 关联笔记 | 在正文输入 `[[会议记录\|上次会议]]`，或写相对路径链接。保存后打开目标笔记，可在「反向链接」里找到引用它的笔记。 |

## 在电脑和 Android 手机上同步

从项目的 [GitHub Releases](https://github.com/invokerw/we-note/releases) 选择对应平台的安装包。Windows x64 使用 `.exe`，macOS 使用通用 `.dmg`，Linux x64 使用 `.deb`，Android ARM64 使用 `.apk`。文件名以 `-unsigned.apk` 结尾的包需要先签名才能安装。

1. 在客户端填写服务地址，用网页端的账号登录，选择同一个笔记库。跨设备使用时，填写各设备都能访问的 HTTPS 地址。
2. **桌面端**在「本地笔记目录」填入已有文件夹的完整路径。**Android** 使用应用私有目录，可在编辑器中通过「导入笔记」选择手机上的文件。
3. 点击「立即同步」，完成后点击「打开本地编辑器」。此后即使断网重启，也可以从这里打开最近同步的笔记、编辑并保存。联网后再点「立即同步」，就能在网页端看到修改。

勾选「应用打开时每 15 秒同步」可自动同步。手机还可以启用「Android 后台同步」，由系统在网络可用时安排运行。如果两台设备离线修改了同一篇笔记，客户端会尝试合并。遇到重叠修改时，原文件保留远端版本，本地修改保存在同一目录下文件名带 `conflict` 的副本中，可打开两份笔记核对。

## 分享、恢复和导出

- **分享一篇笔记**。在网页端打开已保存的笔记，点击「分享」，选择 1 天、3 天、7 天或永久，再点「生成链接 → 复制链接」。接收者看到分享时的版本，可以下载源文件，也可以登录后选择「保存到我的笔记」独立编辑。要停止分享，点击头像进入「个人设置 → 我的分享」，在对应笔记库下撤销链接。
- **找回改写前的内容**。在网页端打开笔记，选「更多操作 → 历史版本」，点击一个版本预览原文。确认后点「恢复此版本」，这份内容会成为新的当前版本。
- **恢复误删的笔记**。打开网页侧栏的「回收站」，选中笔记预览，点「恢复」。要恢复整个文件夹，在回收站的文件夹菜单中选择「恢复」。
- **导出笔记库**。点击头像进入「个人设置 → 导出」，选择「仅笔记」或「完整笔记库」，点「创建导出」，完成后点「下载 ZIP」。要在离线时也能看到笔记里的图片，选「完整笔记库」，将「图片链接」设为「离线便携（使用包内图片）」。解压后用本地 Markdown 阅读器打开 `notes/` 中的笔记即可。

## 本地启动

在装有 Python 3.8+、Node.js 24、npm、Go 1.27 和 C 编译器的 macOS 或 Linux 上，从仓库根目录运行：

```sh
./scripts/local.py start
```

脚本会构建网页和 API，在后台启动服务并打印访问地址。默认地址为 `http://localhost:8080`。用 `./scripts/local.py status` 查看运行状态，`./scripts/local.py stop` 停止服务。如需换端口，停止后执行 `./scripts/local.py start --port 8081`。笔记和附件保存在 `services/api/data/`，日志在 `dist/local/server.log`。

## 自托管与开发参考

<details>
<summary>用 Docker Compose 部署</summary>

将 [Compose 示例](docs/examples/compose.yaml) 保存为部署目录中的 `compose.yaml`。镜像已包含网页端和 API，支持 `linux/amd64` 和 `linux/arm64`。

在同一目录创建 `.env`，将 `vX.Y.Z` 换成要部署的实际发布标签。本机试用只需第一行。通过域名提供服务时，取消第二行的注释，填写自己的 HTTPS 地址，并将宿主机上的反向代理指向 `127.0.0.1:8080`。

```dotenv
WENOTE_VERSION=vX.Y.Z
# WENOTE_PUBLIC_URL=https://notes.example.com
```

在部署目录执行以下命令。若镜像为私有，先用具有 `read:packages` 权限的账号登录 `ghcr.io`。

```sh
docker compose up -d
curl -fsS --retry 10 --retry-connrefused http://127.0.0.1:8080/healthz
```

服务就绪后，本机可打开 `http://localhost:8080`，其他设备使用配置的 HTTPS 地址。`docker compose logs -f wenote` 可查看日志，`docker compose down` 可停止服务并保留 `wenote-data` 卷中的数据库、附件和设置密钥。管理员可从 `/gm` 管理注册方式、存储位置和备份。

</details>

<details>
<summary>HTTPS、存储与备份恢复</summary>

默认数据库和本地 Blob 保存在 API 进程工作目录的 `data/` 下。跨设备部署时，用 `-public-url` 指定所有设备都能访问的 HTTPS 源站。可在反向代理终止 TLS，也可给 API 传入 `-tls-cert` 和 `-tls-key`。该源站用于生成稳定的 `/assets/YYYY/MM/DD/<sha256>` 地址。资源网关验证账户访问权限。网页端在本地开发时也能预览私有附件。

指定 `-s3-bucket` 即可使用 S3。`-s3-region` 选择区域，`-s3-prefix` 指定对象前缀。MinIO 等兼容服务可通过 `-s3-endpoint` 配置地址。凭据由 AWS SDK 的默认凭据链提供。应将 SQLite 数据库与对应的 Blob 存储一同备份。

在 GM 的「存储配置 → 存储位置」中，可以添加、命名和编辑多个本地目录、S3 或 WebDAV 位置，再从「用途分配」中分别为在线内容和备份选择位置。两种用途可以共用同一位置。切换备份位置只影响新备份。旧配置会自动出现在列表中。在线内容包括笔记正文、历史版本、附件、历史加密库密文和导出文件。选择本地目录、S3 或 WebDAV 后，确认迁移，服务器会暂停访问、复制并读回校验，成功后启用新位置。数据库和搜索索引继续保存在 SQLite 中。WebDAV 地址应指向已有目录，S3 使用已创建的桶和可选的对象前缀。

在「备份」选择「恢复备份」，核对时间后点击「备份当前数据并恢复」。服务器先生成并校验「恢复前自动备份」，再恢复所选的数据库和文件。恢复期间暂停访问。所有用户需使用备份时的密码重新登录。恢复后保留当前存储配置和备份清单，可从列表中选择恢复前的备份撤回本次操作。

远程备份会在本地保留副本。若本地副本丢失或校验失败，GM 会从创建时的远程位置取回归档。跨主机灾难恢复需要独立保管服务器的 `settings.key`，用于解密 SMTP 与存储凭据。新实例没有原来的备份清单时，可取回 `backup_*.tar.gz`，在空目录中解出 `wenote.db` 和 `storage/`。要使用归档内的本地文件启动，在**解出的数据库副本**中执行 `DELETE FROM system_settings WHERE key IN ('storage_online','storage_catalog')`，再将 `-db`、`-blobs` 和 `-settings-key-file` 指向恢复文件与原设置密钥。

</details>

<details>
<summary>从源码构建客户端、运行验收与发布</summary>

**桌面端**需要 Rust 和 Tauri 2 的平台构建依赖，Windows 还需要 WebView2。从仓库根目录执行：

```sh
npm ci --prefix apps/web
npm run build:desktop --prefix apps/web
cargo run --locked -p wenote-desktop --release
```

**Android** 准备 JDK、Android SDK Platform 36 和 37.0、Build Tools 37 和 NDK，设置 `JAVA_HOME`、`ANDROID_HOME` 与 `NDK_HOME`。在仓库根目录执行以下命令，构建可安装在 ARM64 手机上的调试版。

```sh
rustup target add aarch64-linux-android
npm ci --prefix apps/web
npm ci --prefix apps/client
npm run android --prefix apps/client -- --debug
```

APK 位于 `apps/client/src-tauri/gen/android/app/build/outputs/apk/`。调试本地服务时，可运行 `adb reverse tcp:8080 tcp:8080`，在模拟器中填写 `http://127.0.0.1:8080`。

**运行验收**

先构建网页和桌面前端，再从仓库根目录执行以下命令。浏览器验收使用 Chrome，`CHROME_PATH` 可指定其他 Chrome 安装路径。脚本创建临时数据库，启动回环地址服务并在测试结束时清理。

```sh
(cd services/api && go test -race ./... && go vet ./... && go build -o /tmp/wenote-api ./cmd/wenote-api)
WENOTE_API=/tmp/wenote-api node tests/e2e/desktop.mjs --browser
node --test tests/protocol/*.test.mjs
node tests/protocol/mutation-check.mjs
```

桌面用例在两个目录间验证新增、编辑、移动、恢复和冲突处理，并检查离线编辑、附件缓存和下载。浏览器用例使用两个独立账户验证图片预览、分享时刻的正文、接收方独立编辑及回收站恢复。指定 `WENOTE_TEST_BUCKET`、`WENOTE_TEST_S3` 与测试凭据可在专用 S3 测试桶上运行相同流程。仓库的原生验收工作流分别在 macOS 与 Windows 上构建并运行上述桌面和网页用例。

在专用 Android 模拟器上安装调试 APK，设置 `ANDROID_SERIAL` 为该模拟器的序列号，然后执行 `WENOTE_API=/tmp/wenote-api node tests/e2e/desktop.mjs --android`。该用例使用临时 API 验证断网重启、保存、后台同步和冲突恢复。

**发布安装包**。推送 `v主版本.次版本.修订号` 格式的 Git 标签会触发发布。Windows 和 macOS 安装包未配置发行者签名或公证。要生成可直接安装并覆盖升级的 Android APK，请在仓库 Actions secrets 中配置 `ANDROID_KEYSTORE_BASE64`、`ANDROID_KEY_ALIAS`、`ANDROID_KEYSTORE_PASSWORD` 和 `ANDROID_KEY_PASSWORD`，后续版本沿用同一密钥。详见[发布工作流](.github/workflows/release.yml)。

</details>

相关文档：[服务端 API](services/api/README.md) · [插件 SDK](apps/web/plugin-sdk/README.md) · [开发工作流](docs/开发工作流.md) · [开发账本](docs/开发账本.md)
