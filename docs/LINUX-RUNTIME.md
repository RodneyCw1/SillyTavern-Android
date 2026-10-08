# Linux 重建 Node.js Android 运行库

已发布运行库的源文件、Android 补丁、构建脚本和完整依赖许可证位于 [runtime Release](https://github.com/RodneyCw1/SillyTavern-Android/releases/tag/runtime-node-22.23.2-16k)。Node 原始源码 SHA-256 为 `bbe768df8d5815d7fa76124052985332452e0a4742d39f32027550d1aab8f6fb`。构建脚本在解包前核对该值，随后应用仓库中的 `patch-node22.py`。

在 x86_64 Linux 上安装 Git、Python 3、GNU make、GCC/G++、curl、xz-utils 和 Node.js 22.23.2。通过 Android SDK 的 sdkmanager 安装 `ndk;28.2.13676358`，然后设置 NDK 的绝对路径：

```bash
export ST_ANDROID_NDK="$ANDROID_SDK_ROOT/ndk/28.2.13676358"
export ST_NODE_BUILD_JOBS=4
npm ci --ignore-scripts
npm --prefix server ci --omit=dev --ignore-scripts
bash scripts/build-node22-linux.sh arm64
bash scripts/build-node22-linux.sh x86_64
node scripts/build-runtime-bundle.mjs
```

默认构建目录为项目内 `.local/node-build`，可通过 `ST_NODE_BUILD_ROOT` 指定其他可写位置。构建不需要向 `/usr` 安装文件；`make install DESTDIR=...` 只负责暂存 Node 公共头文件。两个 ABI 的库、ELF 检查记录和构建日志会写入 `.local/runtime22`，随后自动整理为 `.local/runtime-bundle`。打包输出位于 `.local/runtime-release`。

构建以 API 29 为最低平台，使用完整 ICU，禁用 Node snapshot 和 inspector，并将 ELF LOAD 段对齐到 16 KB。打包前确认暂存目录包含 `libraries/arm64-v8a`、`libraries/x86_64`、`libraries/installed.json`、`libraries/LICENSE`、`headers/node.h` 及 `node-source.json`。构建脚本会生成库的 SHA-256 和 ELF 记录；不同编译环境的输出不承诺与已发布二进制逐字节相同。

重建后 `build-runtime-bundle.mjs` 会更新 `docs/runtime-bundle.json`。先创建新的、非 Latest 的 runtime Release 并上传 ZIP、源码、补丁、许可证和清单，再提交新的下载地址及 SHA-256。不要覆盖已有版本的固定下载资产；旧 APK 的构建仍需能够下载原运行库。应用更新渠道只使用正式 APK Release。