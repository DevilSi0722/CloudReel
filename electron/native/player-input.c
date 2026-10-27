// CloudReel's small, process-local mouse activation shim (Windows x64).
// All window messages stay native; no callbacks enter the JavaScript runtime.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

typedef LRESULT (CALLBACK *CloudReelSubclassProc)(HWND, UINT, WPARAM, LPARAM, UINT_PTR, DWORD_PTR);
__declspec(dllimport) BOOL WINAPI SetWindowSubclass(HWND, CloudReelSubclassProc, UINT_PTR, DWORD_PTR);
__declspec(dllimport) BOOL WINAPI RemoveWindowSubclass(HWND, CloudReelSubclassProc, UINT_PTR);
__declspec(dllimport) LRESULT WINAPI DefSubclassProc(HWND, UINT, WPARAM, LPARAM);

static const UINT_PTR input_id = 0x4352494E;
static const char *cursor_property = "CloudReelHiddenCursor";

static BOOL cursor_over(HWND window)
{
    POINT point;
    HWND target;
    if (!IsWindowVisible(window) || !GetCursorPos(&point)) return FALSE;
    target = WindowFromPoint(point);
    return target == window || IsChild(window, target);
}

static LRESULT CALLBACK input_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam, UINT_PTR id, DWORD_PTR data)
{
    if (message == WM_MOUSEACTIVATE) return MA_NOACTIVATE;
    if (message == WM_SETCURSOR && LOWORD(lparam) == HTCLIENT && GetPropA(window, cursor_property) && cursor_over(window)) {
        SetCursor(NULL);
        return TRUE;
    }
    if (message == WM_NCDESTROY) {RemovePropA(window, cursor_property); RemoveWindowSubclass(window, input_proc, id);}
    return DefSubclassProc(window, message, wparam, lparam);
}

__declspec(dllexport) BOOL WINAPI CloudReelInputInstall(HWND window)
{
    if (!IsWindow(window) || GetWindowThreadProcessId(window, NULL) != GetCurrentThreadId()) return FALSE;
    return SetWindowSubclass(window, input_proc, input_id, 0);
}

__declspec(dllexport) void WINAPI CloudReelInputRemove(HWND window)
{
    if (IsWindow(window) && GetWindowThreadProcessId(window, NULL) == GetCurrentThreadId()) {
        RemovePropA(window, cursor_property);
        if (cursor_over(window)) SetCursor(LoadCursorA(NULL, MAKEINTRESOURCEA(32512)));
        RemoveWindowSubclass(window, input_proc, input_id);
    }
}

__declspec(dllexport) void WINAPI CloudReelCursorHidden(HWND window, BOOL hidden)
{
    if (!IsWindow(window) || GetWindowThreadProcessId(window, NULL) != GetCurrentThreadId()) return;
    if (hidden) SetPropA(window, cursor_property, (HANDLE)1);
    else RemovePropA(window, cursor_property);
    // Do not use ShowCursor's process-wide counter. Update only while our own
    // visible surface is under the pointer; other apps retain their cursor.
    if (cursor_over(window)) SetCursor(hidden ? NULL : LoadCursorA(NULL, MAKEINTRESOURCEA(32512)));
}
