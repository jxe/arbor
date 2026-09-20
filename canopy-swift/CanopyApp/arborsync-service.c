#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static void redirect_logs(void) {
    const char *home = getenv("HOME");
    if (home == NULL || home[0] == '\0') return;

    char directory[PATH_MAX];
    char log_path[PATH_MAX];
    if (snprintf(directory, sizeof(directory), "%s/Library/Logs/Arbor", home) >= (int)sizeof(directory)) return;
    if (snprintf(log_path, sizeof(log_path), "%s/arborsync.log", directory) >= (int)sizeof(log_path)) return;
    if (mkdir(directory, 0700) != 0 && errno != EEXIST) return;

    int descriptor = open(log_path, O_WRONLY | O_CREAT | O_APPEND, 0600);
    if (descriptor < 0) return;
    (void)dup2(descriptor, STDOUT_FILENO);
    (void)dup2(descriptor, STDERR_FILENO);
    if (descriptor > STDERR_FILENO) close(descriptor);
}

int main(int argc, char *argv[]) {
    uint32_t size = PATH_MAX;
    char executable[PATH_MAX];
    if (_NSGetExecutablePath(executable, &size) != 0) {
        fprintf(stderr, "Arbor Sync launcher could not resolve its bundle path\n");
        return 70;
    }

    char *macos = strrchr(executable, '/');
    if (macos == NULL) return 70;
    *macos = '\0';
    char *contents_separator = strrchr(executable, '/');
    if (contents_separator == NULL) return 70;
    *contents_separator = '\0';

    char runtime[PATH_MAX];
    char script[PATH_MAX];
    if (snprintf(runtime, sizeof(runtime), "%s/MacOS/arborsync", executable) >= (int)sizeof(runtime)) return 70;
    if (snprintf(script, sizeof(script), "%s/Resources/arborsync/arborsync.js", executable) >= (int)sizeof(script)) return 70;

    char **arguments = calloc((size_t)argc + 2, sizeof(char *));
    if (arguments == NULL) return 71;
    arguments[0] = runtime;
    arguments[1] = script;
    for (int index = 1; index < argc; index += 1) arguments[index + 1] = argv[index];
    arguments[argc + 1] = NULL;

    redirect_logs();
    execv(runtime, arguments);
    fprintf(stderr, "Arbor Sync launcher could not execute %s: %s\n", runtime, strerror(errno));
    free(arguments);
    return 71;
}
