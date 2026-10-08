#!/usr/bin/env bash
set -euo pipefail
project="$(cd "$(dirname "$0")/.." && pwd)"
build="${ST_NODE_BUILD_ROOT:-$project/.local/node-build}"
version=22.23.2
archive="node-v$version.tar.xz"
sha=bbe768df8d5815d7fa76124052985332452e0a4742d39f32027550d1aab8f6fb
arch="${1:-arm64}"
jobs="${ST_NODE_BUILD_JOBS:-4}"
case "$arch" in
  arm64) abi=arm64-v8a; triple=aarch64-linux-android; cpu=arm64 ;;
  x86_64) abi=x86_64; triple=x86_64-linux-android; cpu=x64 ;;
  *) echo "Supported targets: arm64, x86_64" >&2; exit 1 ;;
esac
mkdir -p "$build"
if [ ! -f "$build/$archive" ]; then
  curl -fL --retry 2 "https://nodejs.org/dist/v$version/$archive" -o "$build/$archive"
fi
echo "$sha  $build/$archive" | sha256sum -c -
source="$build/node22-$arch"
if [ ! -f "$source/configure" ]; then
  mkdir -p "$source"
  tar -xJf "$build/$archive" -C "$source" --strip-components=1
fi
cd "$source"
python3 "$project/scripts/patch-node22.py"
ndk="${ST_ANDROID_NDK:-${ANDROID_NDK_HOME:-$build/android-ndk-r28c}}"
if ! grep -q 'Pkg.Revision = 28.2.13676358' "$ndk/source.properties"; then
  echo 'Android NDK 28.2.13676358 is required. Set ST_ANDROID_NDK to that NDK directory.' >&2
  exit 1
fi
toolchain="$ndk/toolchains/llvm/prebuilt/linux-x86_64"
export PATH="$toolchain/bin:$PATH"
export CC="$toolchain/bin/${triple}29-clang"
export CXX="$toolchain/bin/${triple}29-clang++"
export AR="$toolchain/bin/llvm-ar"
export CC_host=gcc CXX_host=g++ AR_host=ar
export GYP_DEFINES="target_arch=$cpu v8_target_arch=$cpu android_target_arch=$cpu host_os=linux OS=android android_ndk_path=$ndk"
export LDFLAGS="-Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384"
./configure --dest-cpu="$cpu" --dest-os=android --openssl-no-asm --cross-compiling --shared --without-node-snapshot --without-inspector --with-intl=full-icu
make -j"$jobs" > "$build/build-node22-$arch.log" 2>&1
output=out/Release/obj.target/libnode.so
if [ ! -f "$output" ]; then output=out/Release/lib.target/libnode.so; fi
mkdir -p "$project/.local/runtime22/$abi"
"$toolchain/bin/llvm-strip" --strip-unneeded "$output" -o "$project/.local/runtime22/$abi/libnode.so"
"$toolchain/bin/llvm-readelf" -lW "$output" > "$project/.local/runtime22/$abi/elf-program-headers.txt"
"$toolchain/bin/llvm-readelf" -dW "$output" > "$project/.local/runtime22/$abi/elf-dynamic.txt"
sha256sum "$project/.local/runtime22/$abi/libnode.so"
# Node's install target stages public headers without writing to the host /usr.
make install DESTDIR="$build/installed-$arch" >> "$build/build-node22-$arch.log" 2>&1
cp "$build/build-node22-$arch.log" "$project/.local/runtime22/$abi/build.log"
node "$project/scripts/stage-node-runtime.mjs" "$build/installed-$arch/usr/local/include/node" "$source/LICENSE"