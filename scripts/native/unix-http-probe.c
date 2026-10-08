#define _GNU_SOURCE
#include <errno.h>
#include <ctype.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#define MAX_REQUEST (1024 * 1024)

static void fail(int code, const char *message) {
    fprintf(stderr, "unix-http-probe: %s\n", message);
    exit(code);
}

static int64_t now_ms(void) {
    struct timespec value;
    if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) fail(5, "clock failed");
    return (int64_t)value.tv_sec * 1000 + value.tv_nsec / 1000000;
}

static void wait_ready(int fd, short events, int64_t deadline) {
    for (;;) {
        int64_t left = deadline - now_ms();
        if (left <= 0) fail(4, "I/O timeout");
        struct pollfd item = { .fd = fd, .events = events };
        int result = poll(&item, 1, (int)left);
        if (result < 0 && errno == EINTR) continue;
        if (result == 0) fail(4, "I/O timeout");
        if (result < 0 || (item.revents & POLLNVAL)) fail(5, "poll failed");
        if (item.revents & (events | POLLHUP | POLLERR)) return;
    }
}

static size_t framed_request_size(const unsigned char *request, size_t size) {
    const unsigned char *end = memmem(request, size, "\r\n\r\n", 4);
    if (!end) {
        if (size > 65536) fail(3, "request headers exceed 64 KiB");
        return 0;
    }
    size_t header_size = (size_t)(end - request) + 4;
    if (header_size > 65536) fail(3, "request headers exceed 64 KiB");
    const unsigned char *line = memmem(request, header_size, "\r\n", 2);
    if (!line) fail(2, "invalid HTTP request");
    line += 2;
    size_t content_size = 0;
    int length_found = 0;
    while (line < end) {
        const unsigned char *next = memmem(line, (size_t)(end - line) + 2, "\r\n", 2);
        if (!next) fail(2, "invalid HTTP headers");
        const unsigned char *colon = memchr(line, ':', (size_t)(next - line));
        if (!colon) fail(2, "invalid HTTP header");
        size_t key_size = (size_t)(colon - line);
        if (key_size == 0) fail(2, "invalid HTTP header name");
        for (const unsigned char *key = line; key < colon; key++) {
            if (*key == 0 || (!isalnum(*key) && !strchr("!#$%&'*+-.^_`|~", *key))) fail(2, "invalid HTTP header name");
        }
        if (key_size == 17 && strncasecmp((const char *)line, "transfer-encoding", 17) == 0) fail(2, "transfer encoding is unsupported");
        if (key_size == 14 && strncasecmp((const char *)line, "content-length", 14) == 0) {
            if (length_found++) fail(2, "duplicate content length");
            const unsigned char *value = colon + 1;
            while (value < next && (*value == ' ' || *value == '\t')) value++;
            if (value == next) fail(2, "invalid content length");
            while (value < next && *value >= '0' && *value <= '9') {
                content_size = content_size * 10 + *value++ - '0';
                if (content_size > MAX_REQUEST) fail(3, "request exceeds 1 MiB");
            }
            while (value < next && (*value == ' ' || *value == '\t')) value++;
            if (value != next) fail(2, "invalid content length");
        }
        line = next + 2;
    }
    if (content_size > MAX_REQUEST - header_size) fail(3, "request exceeds 1 MiB");
    return header_size + content_size;
}

int main(int argc, char **argv) {
    if (argc == 2 && strcmp(argv[1], "--check") == 0) {
        printf("unix-http-probe-v1 uid=%u\n", (unsigned)getuid());
        return 0;
    }
    if ((argc != 2 && argc != 3) || argv[1][0] != '/') fail(2, "expected filesystem socket path and optional response timeout");
    long response_timeout = 30000;
    if (argc == 3) {
        char *end;
        errno = 0;
        response_timeout = strtol(argv[2], &end, 10);
        if (errno || !argv[2][0] || *end || response_timeout < 100 || response_timeout > 600000) fail(2, "invalid response timeout");
    }
    struct sockaddr_un address = { .sun_family = AF_UNIX };
    size_t length = strlen(argv[1]);
    if (length == 0 || length >= sizeof(address.sun_path)) fail(2, "socket path is too long");
    memcpy(address.sun_path, argv[1], length + 1);
    signal(SIGPIPE, SIG_IGN);

    unsigned char *request = malloc(MAX_REQUEST + 1);
    if (!request) fail(5, "allocation failed");
    size_t request_size = 0;
    int64_t deadline = now_ms() + 5000;
    for (;;) {
        wait_ready(STDIN_FILENO, POLLIN, deadline);
        ssize_t count = read(STDIN_FILENO, request + request_size, MAX_REQUEST + 1 - request_size);
        if (count < 0 && errno == EINTR) continue;
        if (count < 0) fail(5, "stdin failed");
        if (count == 0) fail(2, "incomplete HTTP request");
        request_size += (size_t)count;
        if (request_size > MAX_REQUEST) fail(3, "request exceeds 1 MiB");
        size_t framed_size = framed_request_size(request, request_size);
        if (framed_size && request_size >= framed_size) {
            if (request_size != framed_size) fail(2, "multiple requests are unsupported");
            break;
        }
    }
    if (request_size == 0) fail(2, "empty request");

    int socket_fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
    if (socket_fd < 0) fail(5, "socket failed");
    int connected = connect(socket_fd, (struct sockaddr *)&address, (socklen_t)(offsetof(struct sockaddr_un, sun_path) + length + 1));
    if (connected < 0 && errno != EINPROGRESS) fail(5, "connect failed");
    if (connected < 0) {
        wait_ready(socket_fd, POLLOUT, now_ms() + 3000);
        int error = 0;
        socklen_t error_size = sizeof(error);
        if (getsockopt(socket_fd, SOL_SOCKET, SO_ERROR, &error, &error_size) != 0 || error != 0) fail(5, "connect failed");
    }
    struct ucred peer;
    socklen_t peer_size = sizeof(peer);
    if (getsockopt(socket_fd, SOL_SOCKET, SO_PEERCRED, &peer, &peer_size) != 0 || peer_size != sizeof(peer)) fail(5, "peer credentials unavailable");
    if (peer.uid != getuid()) fail(6, "peer UID mismatch");

    deadline = now_ms() + 10000;
    size_t sent = 0;
    while (sent < request_size) {
        wait_ready(socket_fd, POLLOUT, deadline);
        ssize_t count = send(socket_fd, request + sent, request_size - sent, MSG_NOSIGNAL);
        if (count < 0 && (errno == EINTR || errno == EAGAIN)) continue;
        if (count <= 0) fail(5, "send failed");
        sent += (size_t)count;
    }
    memset(request, 0, request_size);
    free(request);

    deadline = now_ms() + response_timeout;
    unsigned char response[16384];
    for (;;) {
        wait_ready(socket_fd, POLLIN, deadline);
        ssize_t count = recv(socket_fd, response, sizeof(response), 0);
        if (count < 0 && (errno == EINTR || errno == EAGAIN)) continue;
        if (count < 0) fail(5, "receive failed");
        if (count == 0) break;
        ssize_t offset = 0;
        while (offset < count) {
            wait_ready(STDOUT_FILENO, POLLOUT, deadline);
            ssize_t written = write(STDOUT_FILENO, response + offset, (size_t)(count - offset));
            if (written < 0 && errno == EINTR) continue;
            if (written <= 0) fail(5, "stdout failed");
            offset += written;
        }
    }
    close(socket_fd);
    return 0;
}
