"""Exclusive process locks on POSIX and Windows; closing the file releases it."""
import os
import errno
import time

LOCK_EX = 2
LOCK_NB = 4


def flock(handle, flags):
    if os.name != 'nt':
        import fcntl
        return fcntl.flock(handle, flags)
    import msvcrt
    # Lock the same first byte for all callers, including append-mode handles.
    position = handle.tell()
    handle.seek(0)
    try:
        while True:
            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                break
            except OSError as error:
                if flags & LOCK_NB or error.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                    raise
                time.sleep(0.05)
    finally:
        handle.seek(position)
