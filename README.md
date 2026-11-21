# WeNote

WeNote 用普通 Markdown、TXT 和 JSON 文件保存笔记。桌面端同步本地目录，网页端提供文件树、阅读、源码编辑、版本历史和回收站。收件人可以把分享快照及其附件导入自己的笔记库，再独立编辑。

## 启动网页和服务端

在仓库根目录执行以下命令。Go 服务使用 SQLite，需要可用的 C 编译器。

```sh
npm ci --prefix apps/web
npm run build --prefix apps/web
cd services/api
go run ./cmd/wenote-api -addr 127.0.0.1:8080 -web-dir ../../apps/web/dist
```

在浏览器打开 `http://localhost:8080`，注册账户并用左侧的 `＋` 创建笔记库。点击「新建笔记」或「上传笔记」即可开始。文件路径可以包含目录，例如 `daily/周一.md`。源码编辑器可以插入附件。点击「分享快照」，填写另一个已注册账户的邮箱以及文件或目录路径。收件人在目标笔记库的「收件箱」确认导入。

## 启动桌面同步

在装有 Rust 和 Tauri 2 平台构建依赖的 Mac 或 Windows 上，从仓库根目录执行 `cargo run --locked -p wenote-desktop --release`。Windows 客户端使用 WebView2。桌面端登录后，选择笔记库并输入已有本地目录的完整路径。勾选「每 15 秒自动同步」后，可以在自己的文本编辑器里读写该目录。

同一设备上的绑定信息、待确认操作和删除前的副本保存在应用数据目录的相应 Vault 子目录中。两端离线修改了不同文本行时，客户端尝试三方合并。遇到重叠修改时，原路径接收远端版本，本地编辑保存为同目录带 `conflict` 的文件。下次扫描也会同步该副本。

## HTTPS 与存储

默认数据库和本地 Blob 保存在 API 进程工作目录的 `data/` 下。跨设备部署时，用 `-public-url` 指定所有设备都能访问的 HTTPS 源站。可在反向代理终止 TLS，也可给 API 传入 `-tls-cert` 和 `-tls-key`。该源站用于生成稳定的 `/assets/{asset_id}` 地址。资源网关验证账户访问权限。网页端在本地开发时也能预览私有附件。

指定 `-s3-bucket` 即可使用 S3。`-s3-region` 选择区域，`-s3-prefix` 指定对象前缀。MinIO 等兼容服务可通过 `-s3-endpoint` 配置地址。凭据由 AWS SDK 的默认凭据链提供。应将 SQLite 数据库与对应的 Blob 存储一同备份。

## 运行验收

先构建网页，再从仓库根目录执行以下命令。浏览器验收使用 Chrome，`CHROME_PATH` 可指定其他 Chrome 安装路径。脚本创建临时数据库，启动回环地址服务并在测试结束时清理。

```sh
(cd services/api && go test -race ./... && go vet ./... && go build -o /tmp/wenote-api ./cmd/wenote-api)
WENOTE_API=/tmp/wenote-api node tests/e2e/desktop.mjs --browser
node --test tests/protocol/*.test.mjs scripts/*.test.mjs
node tests/protocol/mutation-check.mjs
```

桌面用例在两个目录间验证新增、编辑、移动、恢复和冲突处理。浏览器用例使用两个独立账户验证图片预览、分享时刻的正文、接收方独立编辑及回收站恢复。指定 `WENOTE_TEST_BUCKET`、`WENOTE_TEST_S3` 与测试凭据可在专用 S3 测试桶上运行相同流程。仓库的原生验收工作流分别在 macOS 与 Windows 上构建并运行上述桌面和网页用例。
