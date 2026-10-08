from pathlib import Path
# Android cannot use V8's desktop signal trap handler. Keep explicit bounds checks.
p = Path('deps/v8/src/trap-handler/trap-handler.h')
s = p.read_text()
if '// ST Android: explicit WASM bounds checks.' not in s:
    start = s.index('// X64 on Linux, Windows, MacOS, FreeBSD.')
    end = s.index('\n#if V8_OS_ANDROID && V8_TRAP_HANDLER_SUPPORTED', start)
    s = s[:start] + '// ST Android: explicit WASM bounds checks.\n#if V8_OS_ANDROID\n#define V8_TRAP_HANDLER_SUPPORTED false\n#else\n' + s[start:end] + '\n#endif\n' + s[end:]
    p.write_text(s)

# Android targets, including Linux-hosted snapshot tools, must never enable
# signal-based WASM bounds checks. Limit host-tool fixes to their call sites.
for filename, function in [
    ('deps/v8/src/api/api.cc', 'bool TryHandleWebAssemblyTrapPosix('),
    ('deps/v8/src/execution/arm64/simulator-arm64.cc', 'bool Simulator::ProbeMemory('),
]:
    p = Path(filename)
    s = p.read_text()
    start = s.index(function)
    end = s.index('\n}', start)
    part = s[start:end]
    old = '#if V8_ENABLE_WEBASSEMBLY && V8_TRAP_HANDLER_SUPPORTED\n'
    new = '#if V8_ENABLE_WEBASSEMBLY && V8_TRAP_HANDLER_SUPPORTED && !defined(V8_TARGET_OS_ANDROID)\n'
    if old in part:
        s = s[:start] + part.replace(old, new, 1) + s[end:]
        p.write_text(s)

p = Path('deps/v8/src/trap-handler/handler-outside.cc')
s = p.read_text()
if '// ST Android: snapshot tools also use explicit bounds checks.' not in s:
    s = s.replace('#if !V8_TRAP_HANDLER_SUPPORTED\n',
                  '#if !V8_TRAP_HANDLER_SUPPORTED || defined(V8_TARGET_OS_ANDROID)\n', 1)
    old = '  if (!V8_TRAP_HANDLER_SUPPORTED) {\n'
    assert old in s
    s = s.replace(old, '// ST Android: snapshot tools also use explicit bounds checks.\n'
                      '#if defined(V8_TARGET_OS_ANDROID)\n'
                      '  return false;\n'
                      '#else\n' + old, 1)
    old = '  g_is_trap_handler_enabled = true;\n  return true;\n}'
    assert old in s
    s = s.replace(old, '  g_is_trap_handler_enabled = true;\n  return true;\n#endif\n}', 1)
    p.write_text(s)

# API 29 already exposes getauxval. Use the same ARM64 HWCAP bits as the
# NDK cpufeatures implementation without requiring its separate static library.
p = Path('deps/zlib/cpu_features.c')
s = p.read_text()
if '/* ST Android ARM64: read CPU features through bionic. */' not in s:
    old = '#if defined(ARMV8_OS_ANDROID)\n#include <cpu-features.h>'
    new = ('/* ST Android ARM64: read CPU features through bionic. */\n'
           '#if defined(ARMV8_OS_ANDROID) && defined(__aarch64__)\n'
           '#include <asm/hwcap.h>\n#include <sys/auxv.h>\n'
           '#elif defined(ARMV8_OS_ANDROID)\n#include <cpu-features.h>')
    assert old in s
    s = s.replace(old, new, 1)
    old = ('#if defined(ARMV8_OS_ANDROID) && defined(__aarch64__)\n'
           '    uint64_t features = android_getCpuFeatures();\n'
           '    arm_cpu_enable_crc32 = !!(features & ANDROID_CPU_ARM64_FEATURE_CRC32);\n'
           '    arm_cpu_enable_pmull = !!(features & ANDROID_CPU_ARM64_FEATURE_PMULL);')
    new = ('#if defined(ARMV8_OS_ANDROID) && defined(__aarch64__)\n'
           '    unsigned long features = getauxval(AT_HWCAP);\n'
           '    arm_cpu_enable_crc32 = !!(features & HWCAP_CRC32);\n'
           '    arm_cpu_enable_pmull = !!(features & HWCAP_PMULL);')
    assert old in s
    p.write_text(s.replace(old, new, 1))
