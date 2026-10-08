#!/usr/bin/env bash
set -euo pipefail
project="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build=/opt/st-android-build
ndk="$build/android-ndk-r28c"
arch="${1:-arm64}"
source="$build/nodejs-mobile"
if [ "$arch" = x86_64 ]; then
  source="$build/nodejs-mobile-x86_64"
  if [ ! -d "$source" ]; then git clone --local --no-hardlinks "$build/nodejs-mobile" "$source"; fi
fi
cd "$source"
python3 "$project/scripts/patch-node.py"
export LDFLAGS="-Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384"
./android-configure "$ndk" 29 "$arch"
make -j6 > "$build/build-$arch.log" 2>&1
abi="$arch"
if [ "$arch" = arm64 ]; then abi=arm64-v8a; fi
output="out/Release/lib.target/libnode.so"
if [ ! -f "$output" ]; then output="out/Release/obj.target/libnode.so"; fi
mkdir -p "$project/android/app/src/main/jniLibs/$abi" "$project/vendor/runtime/$abi"
"$ndk/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-strip" --strip-unneeded "$output" -o "$project/android/app/src/main/jniLibs/$abi/libnode.so"
cp "$project/android/app/src/main/jniLibs/$abi/libnode.so" "$project/vendor/runtime/$abi/libnode.so"
"$ndk/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-readelf" -lW "$output" > "$project/vendor/runtime/$abi/elf-program-headers.txt"
git diff > "$project/vendor/runtime/nodejs-mobile.patch"
git rev-parse HEAD > "$project/vendor/runtime/source-commit.txt"
sha256sum "$project/vendor/runtime/$abi/libnode.so"
