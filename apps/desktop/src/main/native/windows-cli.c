#define UNICODE
#define _UNICODE
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wchar.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define WIN_LIMIT 32767

static void report(const char *message, DWORD code) {
  char line[160];
  size_t i = 0;
  while (message[i] && i < sizeof(line) - 32) { line[i] = message[i]; i++; }
  line[i++] = ':'; line[i++] = ' ';
  char digits[10]; size_t n = 0;
  do { digits[n++] = (char)('0' + code % 10); code /= 10; } while (code && n < sizeof(digits));
  while (n) line[i++] = digits[--n];
  line[i++] = '\r'; line[i++] = '\n';
  DWORD written;
  HANDLE err = GetStdHandle(STD_ERROR_HANDLE);
  if (err && err != INVALID_HANDLE_VALUE) WriteFile(err, line, (DWORD)i, &written, NULL);
}

static wchar_t *quote(const wchar_t *s, size_t *length) {
  size_t n = wcslen(s), cap = n * 2 + 3, j = 0;
  wchar_t *out = calloc(cap, sizeof(wchar_t));
  if (!out) return NULL;
  out[j++] = L'"';
  for (size_t i = 0; i < n;) {
    size_t slashes = 0;
    while (i < n && s[i] == L'\\') { slashes++; i++; }
    if (i == n) { while (slashes--) out[j++] = L'\\', out[j++] = L'\\'; break; }
    if (s[i] == L'"') { while (slashes--) out[j++] = L'\\', out[j++] = L'\\'; out[j++] = L'\\'; out[j++] = s[i++]; }
    else { while (slashes--) out[j++] = L'\\'; out[j++] = s[i++]; }
  }
  out[j++] = L'"'; out[j] = 0; *length = j; return out;
}

int wmain(int argc, wchar_t **argv) {
  wchar_t exe[WIN_LIMIT], path[WIN_LIMIT], client[WIN_LIMIT], config[WIN_LIMIT];
  DWORD got = GetModuleFileNameW(NULL, exe, WIN_LIMIT);
  if (!got || got >= WIN_LIMIT) { report("holi: cannot locate executable", GetLastError()); return 1; }
  wchar_t *slash = wcsrchr(exe, L'\\');
  if (!slash) { report("holi: invalid executable path", 0); return 1; }
  *(slash + 1) = 0;
  if (swprintf_s(client, WIN_LIMIT, L"%sholi-client.cjs", exe) < 0 || swprintf_s(config, WIN_LIMIT, L"%sholi-runtime.txt", exe) < 0) { report("holi: sibling path too long", 0); return 1; }
  HANDLE file = CreateFileW(config, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  if (file == INVALID_HANDLE_VALUE) { report("holi: cannot open runtime configuration", GetLastError()); return 1; }
  LARGE_INTEGER size;
  if (!GetFileSizeEx(file, &size) || size.QuadPart < 2 || size.QuadPart > (WIN_LIMIT - 1) * 2) { DWORD e = GetLastError(); CloseHandle(file); report("holi: invalid runtime configuration", e); return 1; }
  DWORD bytes = (DWORD)size.QuadPart, read = 0;
  BYTE *raw = malloc(bytes + 2);
  if (!raw || !ReadFile(file, raw, bytes, &read, NULL) || read != bytes) { DWORD e = GetLastError(); free(raw); CloseHandle(file); report("holi: cannot read runtime configuration", e); return 1; }
  CloseHandle(file);
  if (bytes % 2 || raw[0] != 0xff || raw[1] != 0xfe) { free(raw); report("holi: invalid runtime encoding", 0); return 1; }
  size_t chars = bytes / 2 - 1;
  memcpy(path, raw + 2, chars * 2); free(raw); path[chars] = 0;
  if (!chars || wcschr(path, L'\n') || wcschr(path, L'\r')) { report("holi: invalid runtime path", 0); return 1; }
  size_t cap = WIN_LIMIT, used = 0;
  wchar_t *cmd = calloc(cap, sizeof(wchar_t));
  if (!cmd) { report("holi: out of memory", 0); return 1; }
  for (int i = 0; i < argc + 1; i++) {
    const wchar_t *arg = i == 0 ? path : (i == 1 ? client : argv[i - 1]);
    size_t len, qlen;
    wchar_t *q = quote(arg, &qlen);
    if (!q || used + qlen + (i != 0) >= cap) { free(q); free(cmd); report("holi: command line too long", 0); return 1; }
    len = qlen;
    if (i) cmd[used++] = L' ';
    memcpy(cmd + used, q, len * sizeof(wchar_t)); used += len; free(q);
  }
  STARTUPINFOW si;
  ZeroMemory(&si, sizeof(si)); si.cb = sizeof(si); GetStartupInfoW(&si);
  si.dwFlags |= STARTF_USESTDHANDLES;
  si.hStdInput = GetStdHandle(STD_INPUT_HANDLE); si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE); si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  PROCESS_INFORMATION pi;
  if (!CreateProcessW(path, cmd, NULL, NULL, TRUE, 0, NULL, NULL, &si, &pi)) { DWORD e = GetLastError(); free(cmd); report("holi: cannot launch runtime", e); return 1; }
  free(cmd);
  WaitForSingleObject(pi.hProcess, INFINITE);
  DWORD code = 1;
  if (!GetExitCodeProcess(pi.hProcess, &code)) { DWORD e = GetLastError(); CloseHandle(pi.hThread); CloseHandle(pi.hProcess); report("holi: cannot obtain exit status", e); return 1; }
  CloseHandle(pi.hThread); CloseHandle(pi.hProcess); return (int)code;
}
