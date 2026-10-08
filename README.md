# SillyTavern Android 独立版

原生 SillyTavern 1.19.0 + Kotlin WebView + 嵌入式 Node.js 22.23.2。Android 10 / API 29 起，支持 ARM64 和 x86_64、16 KB 内存页。上游来源见 docs/upstream-1.19.0.json，保留 GNU AGPL-3.0 许可证及依赖自身许可证。

本项目不预装第三方插件、生图脚本、角色卡或世界书，包括官方示例角色。原生主题、预设、角色导入、世界书和扩展功能仍可使用。LocalDream 同源代理等 Android 兼容代码仍保留，第三方脚本由用户自行安装。

覆盖安装更新已有 APK 会保留手机中的角色卡、世界书、聊天记录、设置、密钥和插件。更新只替换运行时目录，不清空用户数据。不要卸载旧版后再安装，否则 Android 会删除应用私有数据。

## 下载与更新

在 Releases 下载签名 APK；Issues 中有每个版本的更新公告。旧 APK 首次手动覆盖安装，之后点击原生工具栏的“更新”，检查版本并在应用内下载，校验后由 Android 系统确认安装。未授权安装时按系统提示允许此应用安装更新。网络检查失败会明确报错，不会显示“已是最新”。

## 另一台 Windows 电脑开发

安装 Git、完整 JDK 21（Temurin 等）和 Node.js 22.23.2，然后：

    git clone https://github.com/RodneyCw1/SillyTavern-Android.git
    cd SillyTavern-Android
    $env:ST_ANDROID_JAVA_HOME = '你的JDK21路径'
    ./scripts/setup-sdk.ps1
    ./scripts/fetch-runtime.ps1
    npm test
    ./scripts/build.ps1 -Variant Debug

工具下载、SDK、Gradle、npm 缓存全部位于 .local。Node 运行库从专门的 runtime Release 下载，固定 SHA-256、Node 源码及 NDK 版本。仓库不会包含大型 .so 文件。下载完成后可以离线复用已安装依赖进行构建。

调试包使用独立的 .debug 包名，不覆盖正式软件。两台电脑正常 git pull、开发、提交并推送 main，GitHub 会分配正式版本并打包；公共 PR 只运行不带签名 Secrets 的检查。

## 共用原签名证书

仅通过你自己的私密渠道传输原 sillytavern-release.p12 和原密码，不能上传到公开仓库或 Issue。每台电脑执行：

    ./scripts/import-signing.ps1 -Certificate '原证书路径\sillytavern-release.p12'

输入密码后会验证原证书，再在仓库旁的 SillyTavern-Android-Signing 中保存证书及当前 Windows 账号的 password.dpapi。DPAPI 文件不能直接搬到另一台电脑使用；必须重新导入。备份原证书与可恢复密码，丢失证书会失去覆盖更新能力。

重建已发布的正式包时，先检出该 Release 标签，读取它的 update.json，再设置 ST_ANDROID_VERSION_NAME、ST_ANDROID_VERSION_CODE，然后执行 build.ps1 -Variant Release。不要自行占用下一次 CI 的编号。

## GitHub 自动发布

release-signing Environment 只允许 main 分支使用，配置以下加密 Secrets：

- ST_ANDROID_KEYSTORE_B64：原 PKCS12 证书的 Base64。
- ST_ANDROID_STORE_PASSWORD：原证书密码。
- ST_ANDROID_KEY_PASSWORD：原密钥密码。

正式发布工作流的每次运行 N 使用版本名 1.1.5+build.N、版本编号 1000+N。重跑不增加编号。保持该工作流名称和文件稳定；若将来重建工作流导致运行编号重置，必须提高 release-config.json 的 versionCodeOffset。

工作流通过源码审计、Node 测试、Android 测试、APK 签名、16 KB 对齐及资源审计后，先上传草稿 Release 的全部文件，核对服务端哈希，再公开发布并创建 Issue。重跑不会重复创建公告；旧任务不会降低 Latest 版本。只在用户手动检查时获取更新信息，不会自动下载或安装。

## 重建 Node 运行库

docs/node-source.json 固定源码、SHA-256、NDK、API 和内存页大小。scripts/build-node22-linux.sh 与 scripts/patch-node22.py 保留完整 Android 构建修改；安装 NDK r28c，并分别构建 arm64 与 x86_64。运行库 Release 同时提供两个 ABI、头文件、原生 ELF 检查记录、Node 源码信息与完整许可证。

使用固定的 Node 源码和补丁重新生成 .local/runtime-bundle 的 libraries 与 headers 后执行：

    node scripts/build-runtime-bundle.mjs

更新运行库时先上传新的专用 runtime Release，再提交 docs/runtime-bundle.json 的新校验值。runtime Release 使用 prerelease 且不设为 Latest，应用仅识别正式 APK Release。

## 检查

    npm test
    node scripts/check-public-source.mjs

签名构建和资源审计的详细结果随 Release 发布。更新清单协议为 schemaVersion 1，包含 versionName、versionCode、packageName、minSdk、apkUrl、size、sha256、signingSha256、commit、sourceHash、notes。客户端固定仓库地址、包名及原证书，拒绝旧版、损坏 APK 和错误签名。

完整 Linux 命令和暂存目录说明见 [docs/LINUX-RUNTIME.md](docs/LINUX-RUNTIME.md)。
