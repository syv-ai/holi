#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static void pause_ms(void) {
    struct timespec t = {0, 10000000};
    nanosleep(&t, NULL);
}

int main(int argc, char **argv) {
    if (argc == 3 && (!strcmp(argv[1], "probe") || !strcmp(argv[1], "probe-pid"))) {
        pid_t pid = (pid_t)atoi(argv[2]);
        if (pid <= 1) return 2;
        if (kill(!strcmp(argv[1], "probe") ? -pid : pid, 0) == 0) return 0;
        return errno == ESRCH ? 1 : (errno == EPERM ? 0 : 2);
    }
    if (argc == 4 && !strcmp(argv[1], "in-group")) {
        pid_t group = getpgid((pid_t)atoi(argv[2]));
        return group < 0 ? 2 : (group == (pid_t)atoi(argv[3]) ? 0 : 1);
    }
    if (argc != 3) return 2;
    pid_t group = getpid();
    pid_t parent = fork();
    if (parent < 0) return 3;
    if (parent == 0) {
        close(0); close(1); close(2);
        if (setpgid(0, 0) < 0) _exit(4);
        pid_t child = fork();
        if (child < 0) _exit(5);
        if (child == 0) _exit(setpgid(0, group) < 0 ? 90 : 0);
        siginfo_t status;
        if (waitid(P_PID, child, &status, WEXITED | WNOWAIT) < 0 || status.si_status != 0) _exit(6);
        int fd = open(argv[1], O_CREAT | O_EXCL | O_WRONLY, 0600);
        if (fd < 0) _exit(7);
        dprintf(fd, "%ld %ld\n", (long)getpid(), (long)child);
        close(fd);
        /* Self-clean up even when a test assertion fails. */
        for (int i = 0; i < 300 && access(argv[2], F_OK) < 0; i++) pause_ms();
        return waitpid(child, NULL, 0) == child ? 0 : 8;
    }
    for (int i = 0; i < 300 && access(argv[1], F_OK) < 0; i++) pause_ms();
    return access(argv[1], F_OK) == 0 ? 0 : 9;
}
