# WeNote

WeNote 用Markdown、TXT、JSON 和 XMind 文件保存笔记。桌面端同步本地目录，Android 端同步应用私有目录，两端与网页端共用 Markdown 编辑器。网页端还提供文件树、版本历史和回收站。收件人可以把分享快照及其附件导入自己的笔记库，再独立编辑。

## 发布与安装

推送 `v主版本.次版本.修订号` 格式的 Git 标签会触发发布。例如，发布 `v0.1.0` 时，在要发布的提交上执行：

```sh
git tag v0.1.0
git push origin v0.1.0
```

构建成功后，可在 GitHub Releases 下载 Windows x64 安装程序、macOS 通用 DMG（Intel 和 Apple Silicon）、Linux x64 DEB 和 Android ARM64 APK。桌面安装包使用标签中的版本号，Windows 和 macOS 安装包未配置发行者签名或公证。

Android 使用 release 模式构建。要生成可直接安装并支持覆盖升级的 APK，请在仓库 Actions secrets 中设置 `ANDROID_KEYSTORE_BASE64`（发行密钥库的 Base64 内容）、`ANDROID_KEY_ALIAS`、`ANDROID_KEYSTORE_PASSWORD` 和 `ANDROID_KEY_PASSWORD`，后续版本使用同一密钥。未配置密钥库时，Release 提供以 `-unsigned.apk` 结尾的包，需自行签名后安装。

服务端镜像包含网页端，支持 `linux/amd64` 和 `linux/arm64`。下例使用命名卷持久化 SQLite 和附件，并将端口绑定到本机供反向代理访问。请将 `-public-url` 替换为实际的 HTTPS 源站。私有镜像需先用有 `read:packages` 权限的账号登录 `ghcr.io`。

```sh
docker run -d --name wenote -p 127.0.0.1:8080:8080 \
  -v wenote-data:/app/data ghcr.io/invokerw/we-note:v0.1.0 \
  -public-url https://notes.example.com
```

## 启动网页和服务端

在装有 Python 3.8+、Node.js/npm、Go 和 C 编译器的 macOS 或 Linux 上，从仓库根目录执行：

```sh
./scripts/local.py start     # 构建网页和 API，在后台启动
./scripts/local.py status    # 查看地址和进程号
./scripts/local.py stop      # 停止服务，保留账户、笔记和附件
```

默认端口为 `8080`。如需换端口，停止服务后执行 `./scripts/local.py start --port 8081`。首次启动或前端依赖锁文件变化时会自动安装依赖；修改源码后，停止再启动即可测试新版本。数据沿用 `services/api/data/`，服务日志写入 `dist/local/server.log`。

也可以从仓库根目录手动在前台启动：

```sh
npm ci --prefix apps/web
npm run build --prefix apps/web
cd services/api
go run ./cmd/wenote-api -addr 127.0.0.1:8080 -web-dir ../../apps/web/dist
```

在浏览器打开启动地址（默认 `http://localhost:8080`），注册账户并用左侧的 `＋` 创建笔记库。点击「新建笔记」或「上传笔记」即可开始。文件路径可以包含目录，例如 `daily/周一.md`。源码编辑器可以插入附件。点击「分享快照」，填写另一个已注册账户的邮箱以及文件或目录路径。收件人在目标笔记库的「收件箱」确认导入。

## 编辑、查找和导出

在「编辑模式」中选择「所见所得」即可连续写作。`Enter` 新起一段，`Shift+Enter` 在段内换行。点击表格或公式可就地编辑 Markdown，移开光标即可预览。按 `⌘S` 或 `Ctrl+S` 保存。源码模式支持查找和撤销。编辑器支持 GFM 表格、任务复选框、KaTeX 公式、Mermaid 图表和 `> [!NOTE]` 提示块。可粘贴图片或用「插入附件」添加文件。

展开「目录与属性」查看标题、YAML 属性和标签。「思维导图」按标题层级展开，点击节点可定位正文。用 `[[笔记名|显示文字]]` 或相对 Markdown 链接连接笔记，在目标笔记下方查看「反向链接」。侧栏的「搜索」支持正文、路径和标签筛选，「附件」可预览图片、音视频和 PDF。

「导出」可选择仅笔记、仅附件或完整笔记库。任务冻结创建时的版本，完成后可下载 ZIP。默认模式下，`notes/` 保留原笔记路径、字节和 HTTPS 附件链接，`assets/` 按附件 ID 区分重名文件。完整库可将「附件链接」切换为「离线便携」，下载并解压 ZIP 后，用本地 Markdown 阅读器打开 `notes/` 下的笔记即可读取 `assets/` 下的图片和附件。仅转换快照中已有附件的 Markdown 链接，外部地址、代码示例和源笔记保持原样。链接转换支持单篇最大 16 MiB 的 Markdown。

`manifest.json` 记录布局、链接模式、版本和包内文件的 SHA-256。转换过的笔记另有 `source_content_hash` 指向原始字节。包含附件的导出包另有 `asset-manifest.json`，记录附件原名和在线地址。在解压目录执行 `shasum -a 256 -c checksums.sha256` 可逐项核对文件及清单。

## 分享与加密笔记库

网页侧栏的「分享管理」可以一次选择多个文件、目录和附件。分享链接可设置密码、到期时间，以及下载 ZIP 和导入笔记库的权限。两项操作共用次数上限，ZIP 开始传输即计一次，成功导入一个目标库计一次。撤销、到期或次数用尽后，已有分享会话也无法继续请求笔记和图片。自己账户的操作记录可在「审计日志」查看。

账户分享导入后，发送者可以在「已发送」中发布原快照所含文件的新版本。接收者在「收件箱」选择「查看来源与更新」，对比上次导入、本地和来源的内容，再决定保留本地编辑或采用来源版本。目录后来新增的文件可通过新的快照发送。

在网页的「加密笔记库」或桌面、Android 登录后的「打开加密笔记库」可以创建独立加密库。首次保存前请备份恢复密钥，其他设备需要用同一账户和密钥解锁。客户端使用 AES-256-GCM 加密库名、文件名、正文及附件，服务端按版本保存整库密文，单库密文上限为 16 MiB。版本冲突时可先导出本地草稿，再打开云端版本。

## 文件插件和思维导图

网页、桌面和 Android 的「插件」页面可启用、禁用和安装文件插件。安装本地 WASM 包时可查看版本、来源文件名、SHA-256 和所需权限。开发接口和可打包示例见 [插件 SDK](apps/web/plugin-sdk/README.md)。

JSON 编辑器支持格式化、压缩、语法校验和 JSON Pointer 节点替换。打开新版 `.xmind` 后进入纯画布编辑，画布支持平移和拖动主题调整位置，自动布局会固定父子节点间距和同级分支间距。右键菜单可删除主题、插入下级、同级和上级主题，并支持上下移动节点，备注通过小弹窗编辑，有内容时会以小字显示在节点标题下方。双击节点或按 F2 可直接在节点内编辑标题，Enter 添加同级主题，Tab 添加下级主题，Delete 删除主题，使用 Ctrl+S 保存。编辑器保留 XMind ZIP 中未识别的资源和字段，并兼容数组形式以及带 `sheets` 或 `workbook.sheets` 外壳的 `content.json`。打开 Markdown 后点击「导出 XMind」生成标题树，打开 XMind 后点击「导出 Markdown」生成当前工作表的标题和备注。Android 导出时通过系统选择保存位置。并发修改 XMind 时，同步客户端保留两份完整文件。

## 启动桌面同步

在装有 Rust 和 Tauri 2 平台构建依赖的 Mac 或 Windows 上，在仓库根目录先执行 `npm ci --prefix apps/web` 和 `npm run build:desktop --prefix apps/web`，再执行 `cargo run --locked -p wenote-desktop --release`。Windows 客户端使用 WebView2。桌面端登录后，选择笔记库并输入已有本地目录的完整路径。首次同步后，点击「打开本地编辑器」即可读写该目录。断网重启后也可以重新打开最近绑定的目录，查看已缓存的图片并继续保存笔记。登录后可粘贴新附件、搜索已同步的内容或下载导出包。勾选「每 15 秒自动同步」可将修改传给其他设备。

同一设备上的绑定信息、待确认操作和删除前的副本保存在应用数据目录的相应 Vault 子目录中。两端离线修改了不同文本行时，客户端尝试三方合并。遇到重叠修改时，原路径接收远端版本，本地编辑保存为同目录带 `conflict` 的文件。下次扫描也会同步该副本。

## 启动 Android 客户端

准备 JDK、Android SDK Platform 36 和 37.0、Build Tools 37 和 NDK，设置 `JAVA_HOME`、`ANDROID_HOME` 与 `NDK_HOME`。在仓库根目录执行以下命令，构建可安装在 ARM64 手机上的调试版。

```sh
rustup target add aarch64-linux-android
npm ci --prefix apps/web
npm ci --prefix apps/client
npm run android --prefix apps/client -- --debug
```

APK 位于 `apps/client/src-tauri/gen/android/app/build/outputs/apk/`。登录 HTTPS 服务，选择笔记库，点击「立即同步」。首次同步后可以断网重启，从「打开本地编辑器」继续编辑。用「导入笔记」打开系统文件选择器，用「系统分享」发送当前笔记正文。手机与网页同时修改同一行时，手机把离线修改放在带 `conflict` 的同目录副本中。下次同步后，两份笔记都可在网页端查看。

勾选「Android 后台同步」会将当前笔记库交给系统调度，在网络可用时周期性同步。系统按电量、网络和休眠状态安排实际运行时间。打开「设备与同步诊断」可查看上次同步的版本、冲突路径和账户设备，移除旧设备的同步登记。关闭后台同步后可切换笔记库。调试本地 API 时，可用 `adb reverse tcp:8080 tcp:8080`，在模拟器中填写 `http://127.0.0.1:8080`。

网页、桌面与 Android 编辑器对达到 4 MiB 的附件自动分片，单个附件上限为 256 MiB。传输中断后重新选择同一份文件即可续传，刷新页面或重启应用后也可以继续。服务端保留已接收的分片 24 小时，每次成功补传会延长保留时间。所有分片通过整包校验后，附件链接才会写入编辑器。

## HTTPS 与存储

默认数据库和本地 Blob 保存在 API 进程工作目录的 `data/` 下。跨设备部署时，用 `-public-url` 指定所有设备都能访问的 HTTPS 源站。可在反向代理终止 TLS，也可给 API 传入 `-tls-cert` 和 `-tls-key`。该源站用于生成稳定的 `/assets/{asset_id}` 地址。资源网关验证账户访问权限。网页端在本地开发时也能预览私有附件。

指定 `-s3-bucket` 即可使用 S3。`-s3-region` 选择区域，`-s3-prefix` 指定对象前缀。MinIO 等兼容服务可通过 `-s3-endpoint` 配置地址。凭据由 AWS SDK 的默认凭据链提供。应将 SQLite 数据库与对应的 Blob 存储一同备份。

## 运行验收

先构建网页和桌面前端，再从仓库根目录执行以下命令。浏览器验收使用 Chrome，`CHROME_PATH` 可指定其他 Chrome 安装路径。脚本创建临时数据库，启动回环地址服务并在测试结束时清理。

```sh
(cd services/api && go test -race ./... && go vet ./... && go build -o /tmp/wenote-api ./cmd/wenote-api)
WENOTE_API=/tmp/wenote-api node tests/e2e/desktop.mjs --browser
node --test tests/protocol/*.test.mjs scripts/*.test.mjs
node tests/protocol/mutation-check.mjs
```

桌面用例在两个目录间验证新增、编辑、移动、恢复和冲突处理，并检查离线编辑、附件缓存和下载。浏览器用例使用两个独立账户验证图片预览、分享时刻的正文、接收方独立编辑及回收站恢复。指定 `WENOTE_TEST_BUCKET`、`WENOTE_TEST_S3` 与测试凭据可在专用 S3 测试桶上运行相同流程。仓库的原生验收工作流分别在 macOS 与 Windows 上构建并运行上述桌面和网页用例。

在专用 Android 模拟器上安装调试 APK，设置 `ANDROID_SERIAL` 为该模拟器的序列号，然后执行 `WENOTE_API=/tmp/wenote-api node tests/e2e/desktop.mjs --android`。该用例使用临时 API 验证断网重启、保存、后台同步和冲突恢复。
