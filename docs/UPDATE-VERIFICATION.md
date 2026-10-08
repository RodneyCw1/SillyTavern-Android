# 更新与覆盖安装验收

公开构建保留 SillyTavern 1.19.0 原生功能。Node 回归测试 162 项及 Android 更新策略测试 6 项通过，GitHub 的干净 Windows 构建通过 Android 单元测试、Lint、原证书签名、16 KB 对齐及 APK 内容审计。APK 不含第三方预装插件、角色卡或世界书。

在专门创建的 x86_64 模拟器上，从原版 1.1.4 覆盖升级并重启，合成测试角色卡、世界书、聊天、API 配置、密钥及插件/工坊下载状态的文件 SHA-256 保持一致；原版已安装的三个第三方插件也保留。Android 10 使用 4 KB 内存页，Android 15 使用 16 KB 内存页。测试材料没有使用或上传个人内容。

连续 main 推送产生递增版本及独立公告；重跑较早工作流没有重复公告，也没有改变较新 Latest。更新清单固定仓库、包名和原签名，按数字 versionCode 比较。下载由 Android DownloadManager 持久保存，界面支持取消、后台下载及重新打开后读取进度。

Android 10 的 `getPackageArchiveInfo` 只有在同时请求 `GET_SIGNATURES` 时才会实际收集 APK 证书，单独请求 `GET_SIGNING_CERTIFICATES` 会得到空签名信息。已在真实 Android 10 模拟器复现，并改为同时请求两个标志；仍严格比较当前 `apkContentsSigners` 与原证书。实现依据见 [AOSP Android 10 PackageManager](https://github.com/aosp-mirror/platform_frameworks_base/blob/android-10.0.0_r1/core/java/android/content/pm/PackageManager.java)。

Android 15 测试镜像自带的 WebView 124 曾在旧 APK 和新 APK 的主进程内发生 MemoryInfra 原生崩溃，后台 Node 继续运行。该平台问题未标记为修复。Android 10 的界面及更新操作单独验收；模拟器测试不能代替 ARM64 真机或厂商后台策略测试。Linux 重建流程及源文件已提供，本轮没有重编耗时较长的 Node C++ 运行库。
Android 10 已用真实 DownloadManager 验证下载、取消、断网后的重试，以及应用重启后继续使用原下载记录。大小不符、字节损坏和不同签名的 APK 均被拒绝；错误签名使用实际重新签名的 APK 验证。后台聊天、未完成保存队列及保存失败阻止安装，伪造安装 nonce 被拒绝。拒绝安装来源权限或取消系统安装后，已有数据和已下载更新继续保留；再次安装完成原签名覆盖升级。故障包测试通过模拟器上的独立测试工具准备 DownloadManager 已完成记录，该工具没有包含在公开源码或 APK 中。

取消流式请求时，上游处理器可能移除 HTTP socket 的内部 close 监听，导致响应对象不再发出 close/finish 事件。保存屏障现同时清理已断开的连接，防止取消聊天后永久阻止更新；新增真实 HTTP 连接回归测试，确认正常保存仍阻止安装、保存完成和流式取消均正确释放屏障。