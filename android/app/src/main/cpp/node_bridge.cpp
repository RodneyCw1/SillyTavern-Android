#include <jni.h>
#include <node.h>
#include <string>
#include <vector>
#include <cstring>
#include <unistd.h>
#include <fcntl.h>
#include <signal.h>
#include <cstdlib>
extern "C" JNIEXPORT jint JNICALL
Java_io_sillytavern_standalone_NodeRuntime_start(JNIEnv* env, jobject, jobjectArray input, jstring logPath) {
    const char* log = env->GetStringUTFChars(logPath, nullptr);
    const int fd = open(log, O_CREAT | O_WRONLY | O_APPEND, 0600);
    env->ReleaseStringUTFChars(logPath, log);
    if (fd >= 0) { dup2(fd, STDOUT_FILENO); dup2(fd, STDERR_FILENO); close(fd); }
    signal(SIGPIPE, SIG_IGN);
    setenv("ST_ANDROID_PAGE_SIZE", std::to_string(sysconf(_SC_PAGESIZE)).c_str(), 1);
    const int count = env->GetArrayLength(input);
    std::vector<std::string> values;
    size_t size = 0;
    for (int i = 0; i < count; ++i) {
        auto value = static_cast<jstring>(env->GetObjectArrayElement(input, i));
        const char* utf = env->GetStringUTFChars(value, nullptr);
        values.emplace_back(utf); size += values.back().size() + 1;
        env->ReleaseStringUTFChars(value, utf); env->DeleteLocalRef(value);
    }
    std::vector<char> buffer(size);
    std::vector<char*> argv(count + 1, nullptr);
    size_t offset = 0;
    for (int i = 0; i < count; ++i) {
        argv[i] = buffer.data() + offset;
        std::memcpy(argv[i], values[i].c_str(), values[i].size() + 1);
        offset += values[i].size() + 1;
    }
    return node::Start(count, argv.data());
}
