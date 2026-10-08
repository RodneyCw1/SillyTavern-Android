from pathlib import Path

def write_if_changed(p, content):
    if p.read_text() != content: p.write_text(content)
p = Path('android-configure')
write_if_changed(p, p.read_text().replace('acceptable_pythons = ((3, 11),', 'acceptable_pythons = ((3, 12), (3, 11),'))
p = Path('android_configure.py')
write_if_changed(p, p.read_text().replace('--with-intl=none', '--with-intl=full-icu').replace('--cross-compiling --shared', '--cross-compiling --without-inspector --shared'))
# NDK r28 (LLVM 19) removed nonstandard char_traits<uint16_t>.
# Keep V8's existing 16-bit public interface using an explicit internal trait.
header = Path('deps/v8/src/inspector/string-16.h')
s = header.read_text()
traits = '''
// Android r28 compatibility: std::char_traits has no generic uint16_t specialization.
struct UCharTraits : std::char_traits<char16_t> {
  using char_type = UChar;
  using int_type = uint32_t;
  static void assign(char_type& left, const char_type& right) { left = right; }
  static char_type* assign(char_type* p, size_t n, char_type value) {
    for (size_t i = 0; i < n; ++i) p[i] = value;
    return p;
  }
  static bool eq(char_type a, char_type b) { return a == b; }
  static bool lt(char_type a, char_type b) { return a < b; }
  static int compare(const char_type* a, const char_type* b, size_t n) {
    for (size_t i = 0; i < n; ++i) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; }
    return 0;
  }
  static size_t length(const char_type* p) { size_t n = 0; while (p[n]) ++n; return n; }
  static const char_type* find(const char_type* p, size_t n, const char_type& value) {
    for (size_t i = 0; i < n; ++i) if (p[i] == value) return p + i;
    return nullptr;
  }
  static char_type* move(char_type* dst, const char_type* src, size_t n) {
    return static_cast<char_type*>(std::memmove(dst, src, n * sizeof(char_type)));
  }
  static char_type* copy(char_type* dst, const char_type* src, size_t n) {
    return static_cast<char_type*>(std::memcpy(dst, src, n * sizeof(char_type)));
  }
  static int_type to_int_type(char_type c) { return c; }
  static char_type to_char_type(int_type c) { return static_cast<char_type>(c); }
  static bool eq_int_type(int_type a, int_type b) { return a == b; }
  static int_type eof() { return UINT32_MAX; }
  static int_type not_eof(int_type c) { return c == eof() ? 0 : c; }
};
'''
if 'struct UCharTraits' not in s:
    s = s.replace('using UChar = uint16_t;', 'using UChar = uint16_t;\n' + traits)
write_if_changed(header, s.replace('std::basic_string<UChar>', 'std::basic_string<UChar, UCharTraits>'))
p = Path('deps/v8/src/inspector/string-16.cc')
write_if_changed(p, p.read_text().replace('std::basic_string<UChar>', 'std::basic_string<UChar, UCharTraits>').replace('std::char_traits<UChar>', 'UCharTraits'))

p = Path('deps/v8/src/inspector/v8-string-conversions.h')
s = p.read_text()
if '#include "src/inspector/string-16.h"' not in s:
    s = s.replace('#include <string>', '#include <string>\n#include "src/inspector/string-16.h"')
write_if_changed(p, s.replace('std::basic_string<uint16_t>', 'std::basic_string<uint16_t, UCharTraits>'))
p = Path('deps/v8/src/inspector/v8-string-conversions.cc')
write_if_changed(p, p.read_text().replace('std::basic_string<UChar>', 'std::basic_string<UChar, UCharTraits>'))

# Keep all inspector call sites consistent with String16's explicit storage trait.
for p in Path('deps/v8/src/inspector').glob('*'):
    if p.suffix not in ('.cc', '.h'): continue
    s = p.read_text()
    fixed = s.replace('std::basic_string<uint16_t>', 'std::basic_string<uint16_t, UCharTraits>').replace('std::basic_string<UChar>', 'std::basic_string<UChar, UCharTraits>')
    if fixed != s: write_if_changed(p, fixed)
