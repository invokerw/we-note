# WeNote

WeNote 用普通 Markdown、TXT 和 JSON 文件保存笔记。桌面端同步本地目录，与网页端共用 Markdown 编辑器。网页端还提供文件树、版本历史和回收站。收件人可以把分享快照及其附件导入自己的笔记库，再独立编辑。

## 启动网页和服务端

在仓库根目录执行以下命令。Go 服务使用 SQLite，需要可用的 C 编译器。

```sh
npm ci --prefix apps/web
npm run build --prefix apps/web
cd services/api
go run ./cmd/wenote-api -addr 127.0.0.1:8080 -web-dir ../../apps/web/dist
```

在浏览器打开 `http://localhost:8080`，注册账户并用左侧的 `＋` 创建笔记库。点击「新建笔记」或「上传笔记」即可开始。文件路径可以包含目录，例如 `daily/周一.md`。源码编辑器可以插入附件。点击「分享快照」，填写另一个已注册账户的邮箱以及文件或目录路径。收件人在目标笔记库的「收件箱」确认导入。

## 编辑、查找和导出

点击「实时预览」后直接点选段落即可编辑，其他段落保持排版。点击「完成段落」查看结果，按 `⌘S` 或 `Ctrl+S` 保存。源码模式支持查找和撤销。编辑器支持 GFM 表格、任务复选框、KaTeX 公式、Mermaid 图表和 `> [!NOTE]` 提示块。可粘贴图片或用「插入附件」添加文件。

展开「目录与属性」查看标题、YAML 属性和标签。「思维导图」按标题层级展开，点击节点可定位正文。用 `[[笔记名|显示文字]]` 或相对 Markdown 链接连接笔记，在目标笔记下方查看「反向链接」。侧栏的「搜索」支持正文、路径和标签筛选，「附件」可预览图片、音视频和 PDF。

「导出」可选择仅笔记、仅附件或完整笔记库。任务冻结创建时的版本，完成后可下载 ZIP。`notes/` 保留原笔记路径、字节和 HTTPS 附件链接，`assets/` 按附件 ID 区分重名文件。`manifest.json` 记录路径、版本和 SHA-256，含附件的包另有 `asset-manifest.json` 供查找原始资源。

## 启动桌面同步

在装有 Rust 和 Tauri 2 平台构建依赖的 Mac 或 Windows 上，在仓库根目录先执行 `npm ci --prefix apps/web` 和 `npm run build:desktop --prefix apps/web`，再执行 `cargo run --locked -p wenote-desktop --release`。Windows 客户端使用 WebView2。桌面端登录后，选择笔记库并输入已有本地目录的完整路径。首次同步后，点击「打开本地编辑器」即可读写该目录。断网重启后也可以重新打开最近绑定的目录，查看已缓存的图片并继续保存笔记。登录后可粘贴新附件、搜索已同步的内容或下载导出包。勾选「每 15 秒自动同步」可将修改传给其他设备。

同一设备上的绑定信息、待确认操作和删除前的副本保存在应用数据目录的相应 Vault 子目录中。两端离线修改了不同文本行时，客户端尝试三方合并。遇到重叠修改时，原路径接收远端版本，本地编辑保存为同目录带 `conflict` 的文件。下次扫描也会同步该副本。

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
