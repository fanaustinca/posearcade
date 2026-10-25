// Unbound.exe: runs the bundled Python on windows\unbound.py (no console
// window), passes the command line through, and returns its exit code.
#define WIN32_LEAN_AND_MEAN
#define UNICODE
#include <windows.h>
#include <wchar.h>

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE prev, PWSTR args, int show) {
    wchar_t dir[MAX_PATH], cmd[4 * MAX_PATH + 2048], exe[MAX_PATH + 64];
    DWORD n = GetModuleFileNameW(NULL, dir, MAX_PATH);
    if (n == 0 || n >= MAX_PATH) return 1;
    wchar_t *slash = wcsrchr(dir, L'\\');
    if (slash) *slash = 0;

    swprintf(exe, MAX_PATH + 64, L"%s\\runtime\\pythonw.exe", dir);
    swprintf(cmd, sizeof cmd / sizeof *cmd, L"\"%s\" \"%s\\app\\windows\\unbound.py\" %s", exe, dir, args ? args : L"");

    STARTUPINFOW si = {sizeof si};
    PROCESS_INFORMATION pi;
    if (!CreateProcessW(exe, cmd, NULL, NULL, FALSE, 0, NULL, dir, &si, &pi)) {
        wchar_t msg[MAX_PATH + 200];
        swprintf(msg, MAX_PATH + 200, L"Unbound could not start its runtime:\n%s\n\nTry reinstalling Unbound.", exe);
        MessageBoxW(NULL, msg, L"Unbound", MB_ICONERROR);
        return 1;
    }
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 0;
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return (int)code;
}
