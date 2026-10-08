#!/usr/bin/env bash
set -euo pipefail
build=/opt/st-android-build
mkdir -p "$build"
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y build-essential python3 git curl unzip ca-certificates
cd "$build"
if [ ! -f android-ndk-r28c-linux.zip ]; then curl -fL --retry 3 -o android-ndk-r28c-linux.zip https://dl.google.com/android/repository/android-ndk-r28c-linux.zip; fi
echo 'dfb20d396df28ca02a8c708314b814a4d961dc9074f9a161932746f815aa552f  android-ndk-r28c-linux.zip' | sha256sum --check
if [ ! -d android-ndk-r28c ]; then unzip -q android-ndk-r28c-linux.zip; fi
