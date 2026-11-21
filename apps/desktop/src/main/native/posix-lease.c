#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* Only anchor() signals. Once the controller acknowledges the reaper PID,
 * the reaper moves to a second group so it can wait for the killed anchor. */
static int control, report, result, journal = -1;
static int64_t grace;

static int64_t now(void) {
    struct timespec t;
    if (clock_gettime(CLOCK_MONOTONIC, &t) < 0) _exit(125);
    return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}

static int receipt(const char *line) {
    size_t len = strlen(line);
    return write(report, line, len) == (ssize_t)len;
}

/* One bounded append per record; no provider argv or environment goes here.
 * A short write leaves invalid framing, never a complete ownership proof. */
static int record(const char *line) {
    if (journal < 0) return 1;
    size_t len = strlen(line);
    ssize_t n;
    do n = write(journal, line, len); while (n < 0 && errno == EINTR);
    if (n != (ssize_t)len) return 0;
    int synced;
    do synced = fsync(journal); while (synced < 0 && errno == EINTR);
    return synced == 0;
}

static int record_pid(const char *kind) {
    char line[64];
    snprintf(line, sizeof line, "%s %ld\n", kind, (long)getpid());
    return record(line);
}

static void failure(const char *phase, int error) {
    char line[128];
    snprintf(line, sizeof line, "ERROR %s %d\n", phase, error);
    record(line); /* Persist the fault before any fallback or report to main. */
    receipt(line);
}

/* Nonblocking even if a peer sends a partial frame or disappears. */
static int receive(int fd, void *data, size_t size, int64_t deadline) {
    char *out = data;
    while (size) {
        int64_t remaining = deadline ? deadline - now() : -1;
        if (deadline && remaining <= 0) return ETIMEDOUT;
        ssize_t count = read(fd, out, size);
        if (count == 0) return EPIPE;
        if (count < 0) {
            if (errno == EINTR) continue;
            if (errno != EAGAIN) return errno;
            struct pollfd p = {fd, POLLIN, 0};
            int ready = poll(&p, 1, remaining < 0 || remaining > 100 ? 100 : (int)remaining);
            if (ready < 0 && errno != EINTR) return errno;
            continue;
        }
        out += count;
        size -= (size_t)count;
    }
    return 0;
}

static void terminate(int sig) {
    if (sig != SIGKILL) {
        if (kill(0, sig) < 0) failure("term", errno);
        else receipt("TERM\n");
        int64_t end = now() + grace;
        for (int64_t left; (left = end - now()) > 0;) poll(NULL, 0, (int)left);
    }
    /* SIGKILL also kills the sender: this is intent, NOT an execution ack. */
    receipt("KILL\n");
    if (kill(0, SIGKILL) < 0) failure("kill", errno);
    _exit(125);
}

static void anchor(pid_t group, int startup, int64_t deadline) {
    if (!record_pid("ANCHOR")) {
        failure("journal-anchor", EIO);
        _exit(125);
    }
    int membership = setpgid(0, group) < 0 ? errno : 0;
    if (membership || getpgrp() != group || getsid(0) != group) {
        failure("membership", membership ? membership : EINVAL);
        _exit(125);
    }
    /* No more identities can appear after COMPLETE. Only then allow GO. */
    if (!record("COMPLETE\n")) {
        failure("journal-complete", EIO);
        _exit(125);
    }
    char line[64], command;
    snprintf(line, sizeof line, "READY %ld %ld\n", (long)getpid(), (long)getppid());
    if (!receipt(line)) terminate(SIGTERM);
    int error = receive(control, &command, 1, deadline);
    if (error == EPIPE) terminate(SIGTERM);
    if (error || command != 'S') {
        failure("start-command", error ? error : EINVAL);
        terminate(SIGTERM);
    }
    if (!receipt("START\n")) terminate(SIGTERM);
    error = receive(control, &command, 1, deadline);
    if (error == EPIPE) terminate(SIGTERM);
    if (error || command != 'G') {
        failure("commit-command", error ? error : EINVAL);
        terminate(SIGTERM);
    }
    if (!receipt("GO\n") || write(startup, "S", 1) != 1) {
        failure("start-ack", EPIPE);
        terminate(SIGTERM);
    }
    close(startup);
    for (;;) {
        error = receive(control, &command, 1, 0);
        if (error == EPIPE) terminate(SIGTERM);
        if (error) {
            failure("command", error);
            terminate(SIGTERM);
        }
        if (command == 'T') terminate(SIGTERM);
        if (command == 'K') terminate(SIGKILL);
        if (command == 'F') {
            unsigned char sig;
            error = receive(control, &sig, 1, now() + 500);
            if (!error && sig > 0 && sig < NSIG && sig != SIGKILL) {
                /* STOP is a ChildProcess control operation, not group teardown.
                 * POSIX reserves the leader PID for the lifetime of its group;
                 * this anchor pins that identity without stopping itself. */
                pid_t target = sig == SIGSTOP ? group : 0;
                if (kill(target, sig) == 0) {
                    snprintf(line, sizeof line, "SIGNAL %u\n", sig);
                    if (!receipt(line)) terminate(SIGTERM);
                    continue;
                }
                error = errno;
            }
        }
        failure("command", error ? error : EINVAL);
        terminate(SIGTERM);
    }
}

static void join_child(pid_t child) {
    while (waitpid(child, NULL, 0) < 0 && errno == EINTR) {}
}

static void reaper(pid_t group, int startup, int64_t deadline, int fd_limit) {
    if (!record_pid("REAPER")) {
        failure("journal-reaper", EIO);
        _exit(125);
    }
    /* Block rather than ignore to preserve signal defaults in the exec root. */
    sigset_t mask;
    sigfillset(&mask);
    if (sigprocmask(SIG_BLOCK, &mask, NULL) < 0) {
        failure("reaper-mask", errno);
        _exit(125);
    }
    for (int fd = 0; fd < fd_limit; fd++)
        if (fd != control && fd != report && fd != startup && fd != journal) close(fd);

    /* Until RACK, even controller loss leaves this child in the root group.
     * There is no anchor or provider to signal if this handoff fails. */
    char line[64], command;
    snprintf(line, sizeof line, "REAPER %ld\n", (long)getpid());
    if (!receipt(line)) _exit(125);
    int error = receive(control, &command, 1, deadline);
    if (error || command != 'A') {
        if (error != EPIPE) failure("reaper-ack", error ? error : EINVAL);
        _exit(125);
    }
    if (setpgid(0, 0) < 0) {
        failure("reaper-group", errno);
        _exit(125);
    }
    pid_t child = fork();
    if (child == 0) anchor(group, startup, deadline);
    if (child < 0) failure("fork-anchor", errno);
    close(control);
    close(report);
    close(startup);
    if (child > 0) join_child(child);
    _exit(0);
}

static int named_fd(const char *directory, const char *name, int mode) {
    char *file;
    if (asprintf(&file, "%s/%s", directory, name) < 0) _exit(125);
    int fd = open(file, mode | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW);
    if (fd >= 0 && unlink(file) < 0) _exit(125);
    free(file);
    if (fd < 0) _exit(125);
    return fd;
}

static char **environment(int64_t deadline, int *error) {
    unsigned char header[4];
    *error = receive(control, header, sizeof header, deadline);
    if (*error) return NULL;
    uint32_t length = (uint32_t)header[0] << 24 | (uint32_t)header[1] << 16 |
                      (uint32_t)header[2] << 8 | header[3];
    if (length > 8 * 1024 * 1024) { *error = E2BIG; return NULL; }
    char *data = malloc((size_t)length + 1);
    if (!data) { *error = ENOMEM; return NULL; }
    *error = receive(control, data, length, deadline);
    if (*error) return NULL;
    if (length && data[length - 1] != '\0') { *error = EINVAL; return NULL; }
    size_t count = 0;
    for (uint32_t i = 0; i < length; i++) if (!data[i]) count++;
    char **env = calloc(count + 3, sizeof *env);
    if (!env) { *error = ENOMEM; return NULL; }
    /* Node itself installs these for a real ipc stdio descriptor. */
    const char *channel = getenv("NODE_CHANNEL_FD");
    const char *serialization = getenv("NODE_CHANNEL_SERIALIZATION_MODE");
    size_t entries = count;
    count = 0;
    for (size_t i = 0; i < entries; i++) {
        if ((!channel || strncmp(data, "NODE_CHANNEL_FD=", 16)) &&
            (!serialization || strncmp(data, "NODE_CHANNEL_SERIALIZATION_MODE=", 32)))
            env[count++] = data;
        data += strlen(data) + 1;
    }
    if ((channel && asprintf(&env[count++], "NODE_CHANNEL_FD=%s", channel) < 0) ||
        (serialization && asprintf(&env[count], "NODE_CHANNEL_SERIALIZATION_MODE=%s", serialization) < 0)) {
        *error = ENOMEM;
        return NULL;
    }
    return env;
}

extern char **environ;

int main(int argc, char **argv) {
    if (argc < 8) return 125;
    int base = atoi(argv[1]);
    int64_t deadline = now() + atoi(argv[3]);
    grace = atoi(argv[4]);
    if (strcmp(argv[5], "0")) {
        if (base >= 3 && !strcmp(argv[5], "1")) journal = base + 3;
        else if (base < 3 && argv[5][0] == '/')
            journal = open(argv[5], O_WRONLY | O_APPEND | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
        struct stat stat;
        if (journal < 0 || fstat(journal, &stat) < 0 || !S_ISREG(stat.st_mode) ||
            stat.st_nlink != 1 || (stat.st_mode & 077) ||
            fcntl(journal, F_SETFD, FD_CLOEXEC) < 0 || !record_pid("ROOT")) return 125;
    }
    if (base >= 3) {
        control = base;
        report = base + 1;
        result = base + 2;
        for (int fd = base; fd <= result; fd++)
            if (fcntl(fd, F_SETFD, FD_CLOEXEC) < 0) return 125;
    } else {
        report = named_fd(argv[2], "report", O_WRONLY);
        result = named_fd(argv[2], "exec", O_WRONLY);
        control = named_fd(argv[2], "control", O_RDONLY);
    }
    pid_t root = getpid();
    char line[64];
    int valid = root > 1 && getpgrp() == root && getsid(0) == root;
    snprintf(line, sizeof line, "%s %ld\n", valid ? "ROOT" : "WRONG", (long)root);
    if (!receipt(line) || !valid) return 125;
    int error;
    char **env = environment(deadline, &error);
    if (!env) {
        if (error != EPIPE) failure("environment", error);
        return 125;
    }
    int startup[2];
    if (pipe(startup) < 0 || fcntl(startup[0], F_SETFL, O_NONBLOCK) < 0) {
        failure("startup-pipe", errno);
        return 125;
    }
    pid_t child = fork();
    if (child < 0) { failure("fork-reaper", errno); return 125; }
    if (child == 0) {
        close(startup[0]);
        close(result);
        reaper(root, startup[1], deadline, base >= 3 ? base : 3);
    }
    close(startup[1]);
    close(control);
    char start;
    error = receive(startup[0], &start, 1, deadline);
    close(startup[0]);
    if (error || start != 'S') {
        /* A closed gate cannot launch the provider. Reap the helper ourselves
         * when no startup writer remains; the anchor owns any signalling. */
        if (error == EPIPE) join_child(child);
        else failure("exec-gate", error ? error : EINVAL);
        return 125;
    }
    close(report);
    environ = env;
    execvp(argv[6], argv + 7);
    int exec_error = errno;
    snprintf(line, sizeof line, "%d\n", exec_error);
    ssize_t written;
    do written = write(result, line, strlen(line)); while (written < 0 && errno == EINTR);
    (void)written;
    if (base < 3) {
        errno = exec_error;
#ifndef __APPLE__
        perror("execvp(3) failed.");
#endif
        return 1;
    }
    return 125;
}
