"""Opt-in RSS ceilings; no external dependency or normal-mode policy change."""
import os
import sys
import threading
import time


def rss_bytes(pid=None):
    pid = os.getpid() if pid is None else pid
    if sys.platform == 'win32':
        import ctypes
        from ctypes import wintypes
        class Counters(ctypes.Structure):
            _fields_ = [('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD)] + [
                (name, ctypes.c_size_t) for name in ('PeakWorkingSetSize', 'WorkingSetSize',
                 'QuotaPeakPagedPoolUsage', 'QuotaPagedPoolUsage', 'QuotaPeakNonPagedPoolUsage',
                 'QuotaNonPagedPoolUsage', 'PagefileUsage', 'PeakPagefileUsage')]
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x1000 | 0x0010, False, pid)
        if not handle:
            raise OSError('Cannot open worker for RSS measurement')
        try:
            counters = Counters(); counters.cb = ctypes.sizeof(counters)
            psapi = ctypes.WinDLL('psapi')
            psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
            if not psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
                raise OSError('Cannot measure worker RSS')
            return counters.WorkingSetSize
        finally:
            kernel.CloseHandle(handle)
    if sys.platform == 'darwin':
        import ctypes
        lib = ctypes.CDLL('/usr/lib/libproc.dylib')
        data = ctypes.create_string_buffer(96)
        if lib.proc_pidinfo(pid, 4, 0, data, len(data)) != len(data):
            raise OSError('Cannot measure worker RSS')
        return int.from_bytes(data.raw[8:16], sys.byteorder)
    with open(f'/proc/{pid}/statm') as source:
        return int(source.read().split()[1]) * os.sysconf('SC_PAGE_SIZE')


def start_memory_guard():
    value = os.environ.get('EAGLE_WORKER_RSS_BYTES')
    if not value:
        return
    budget = int(value)
    def watch():
        while True:
            try:
                if rss_bytes() > budget:
                    print('Worker memory budget exceeded', file=sys.stderr, flush=True)
                    os._exit(75)
            except Exception as error:
                print('Worker memory guard failed: ' + str(error), file=sys.stderr, flush=True)
                os._exit(75)
            time.sleep(.1)
    threading.Thread(target=watch, daemon=True).start()


def windows_job(child):
    """Kill guarded grandchildren when Windows terminates the wrapper process."""
    if sys.platform != 'win32':
        return lambda: None
    import ctypes
    from ctypes import wintypes
    class Basic(ctypes.Structure):
        _fields_ = [('ProcessTime', ctypes.c_int64), ('JobTime', ctypes.c_int64),
                    ('LimitFlags', wintypes.DWORD), ('MinWorkingSet', ctypes.c_size_t),
                    ('MaxWorkingSet', ctypes.c_size_t), ('ActiveProcesses', wintypes.DWORD),
                    ('Affinity', ctypes.c_size_t), ('PriorityClass', wintypes.DWORD),
                    ('SchedulingClass', wintypes.DWORD)]
    class Io(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint64) for name in ('ReadOps', 'WriteOps', 'OtherOps', 'ReadBytes', 'WriteBytes', 'OtherBytes')]
    class Extended(ctypes.Structure):
        _fields_ = [('Basic', Basic), ('Io', Io)] + [(name, ctypes.c_size_t) for name in
                    ('ProcessMemory', 'JobMemory', 'PeakProcessMemory', 'PeakJobMemory')]
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    job = kernel.CreateJobObjectW(None, None)
    limits = Extended(); limits.Basic.LimitFlags = 0x2000  # KILL_ON_JOB_CLOSE
    if not job or not kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)) or \
            not kernel.AssignProcessToJobObject(job, wintypes.HANDLE(int(child._handle))):
        child.kill(); child.wait()
        if job: kernel.CloseHandle(job)
        raise OSError('Cannot establish guarded Windows child lifetime')
    return lambda: kernel.CloseHandle(job)


def guarded_command(budget, command):
    import signal
    import subprocess
    child = subprocess.Popen(command)
    close_job = windows_job(child)
    def stop(signum, frame):
        child.kill()
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, stop)
    try:
        while child.poll() is None:
            try:
                if rss_bytes(child.pid) > budget:
                    print('Native worker memory budget exceeded', file=sys.stderr, flush=True)
                    child.kill(); child.wait(); return 75
            except OSError:
                if child.poll() is None:
                    child.kill(); child.wait(); return 75
            time.sleep(.1)
        return child.returncode
    finally:
        if child.poll() is None:
            child.kill()
        child.wait()
        close_job()


if __name__ == '__main__':
    raise SystemExit(guarded_command(int(sys.argv[1]), sys.argv[2:]))
