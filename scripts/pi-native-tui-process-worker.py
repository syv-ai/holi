"""Keep a PTY session anchor owned until the final process-group signal."""

from __future__ import annotations

import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time
import tty
import typing as t


class NativeSpec(t.TypedDict):
    """Native process configuration from the owning Node module."""

    command: str
    args: list[str]
    cwd: str
    env: dict[str, str]
    terminalSize: t.NotRequired[dict[str, int]]


def main() -> None:
    """Pump native bytes and a separate supervisor control channel."""
    spec: NativeSpec = json.loads(sys.argv[1])
    stopping = False

    def stop_supervisor(_signal: int, _frame: object) -> None:
        """Defer signal handling until the owned session can be drained.

        Args:
            _signal:
                Delivered shutdown signal.
            _frame:
                Interrupted interpreter frame.
        """
        nonlocal stopping
        stopping = True
        try:
            _emit(fd=3, event={"type": "interrupted", "signal": _signal})
        except OSError:
            # Losing the observer must not interrupt owned session drainage.
            pass

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, stop_supervisor)
    os.chdir(spec["cwd"])
    commands_read, commands_write = os.pipe()
    events_read, events_write = os.pipe()
    anchor, master = pty.fork()
    if anchor == 0:
        os.close(commands_write)
        os.close(events_read)
        _anchor(spec=spec, commands=commands_read, events=events_write)
        os._exit(1)
    os.close(commands_read)
    os.close(events_write)
    native_reaped = False
    event_buffer = bytearray()
    control_buffer = bytearray()

    def receive_events() -> None:
        """Forward the anchor's ownership events, not native output."""
        nonlocal native_reaped, event_buffer
        data = os.read(events_read, 4096)
        if not data:
            raise RuntimeError("Session anchor lost its event channel")
        event_buffer.extend(data)
        while b"\n" in event_buffer:
            line, _, event_buffer = event_buffer.partition(b"\n")
            event = json.loads(line)
            if event["type"] == "native-exit":
                native_reaped = True
            _emit(fd=3, event=event)

    try:
        _emit(fd=3, event={"type": "started", "anchorPid": anchor})
        running = True
        while running and not stopping:
            ready, _, _ = select.select([master, 4, events_read], [], [], 0.1)
            for fd in ready:
                if fd == master:
                    _pump(master=master)
                elif fd == events_read:
                    receive_events()
                else:
                    data = os.read(4, 65536)
                    if not data:
                        running = False
                        break
                    control_buffer.extend(data)
                    while b"\n" in control_buffer:
                        line, _, control_buffer = control_buffer.partition(b"\n")
                        message = json.loads(line)
                        action = message["type"]
                        if action == "input":
                            os.write(master, bytes.fromhex(message["hex"]))
                            _emit(
                                fd=3, event={"type": "input-ack", "id": message["id"]}
                            )
                        elif action == "stop":
                            _signal_group(anchor=anchor, sig=signal.SIGTERM)
                        elif action == "kill-native":
                            os.write(commands_write, b"kill\n")
                        elif action == "release":
                            running = False
                            break
    finally:
        # B has never been reaped by A: its PID cannot have been recycled.
        _signal_group(anchor=anchor, sig=signal.SIGTERM)
        try:
            os.write(commands_write, b"kill\n")
            deadline = time.monotonic() + 2
            while not native_reaped and time.monotonic() < deadline:
                ready, _, _ = select.select([master, events_read], [], [], 0.05)
                for fd in ready:
                    if fd == master:
                        _pump(master=master)
                    else:
                        receive_events()
        except (BrokenPipeError, RuntimeError):
            pass
        finally:
            _signal_group(anchor=anchor, sig=signal.SIGKILL)
        os.waitpid(anchor, 0)
        # No signals after waitpid: absence probes may only fail conservatively.
        deadline = time.monotonic() + 2
        while _group_exists(anchor=anchor) and time.monotonic() < deadline:
            time.sleep(0.02)
        group_gone = not _group_exists(anchor=anchor)
        os.close(master)
        _emit(
            fd=3,
            event={
                "type": "drained",
                "anchorPid": anchor,
                "nativeReaped": native_reaped,
                "groupGone": group_gone,
            },
        )
        if not native_reaped or not group_gone:
            raise RuntimeError("Native session drainage is uncertain")


def _anchor(*, spec: NativeSpec, commands: int, events: int) -> None:
    """Reap the native child while retaining the session leader.

    Args:
        spec:
            Native command, arguments, working directory and clean environment.
        commands:
            Dedicated parent-to-anchor command pipe.
        events:
            Dedicated anchor-to-parent event pipe.
    """
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(sig, signal.SIG_IGN)
    if size := spec.get("terminalSize"):
        fcntl.ioctl(
            0,
            termios.TIOCSWINSZ,
            struct.pack("HHHH", size["rows"], size["columns"], 0, 0),
        )
    tty.setraw(0)
    native = os.fork()
    if native == 0:
        os.close(commands)
        os.close(3)
        os.close(4)
        for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
            signal.signal(sig, signal.SIG_DFL)
        os.execvpe(spec["command"], [spec["command"], *spec["args"]], spec["env"])
    _emit(fd=events, event={"type": "native-pid", "pid": native})
    reaped = False
    buffer = bytearray()
    while True:
        if not reaped:
            waited, status = os.waitpid(native, os.WNOHANG)
            if waited:
                reaped = True
                code = os.waitstatus_to_exitcode(status)
                _emit(
                    fd=events,
                    event={
                        "type": "native-exit",
                        "code": code if code >= 0 else None,
                        "signal": -code if code < 0 else None,
                    },
                )
        ready, _, _ = select.select([commands], [], [], 0.02)
        if ready:
            data = os.read(commands, 4096)
            if not data:
                raise RuntimeError("Supervisor command channel closed")
            buffer.extend(data)
            while b"\n" in buffer:
                command, _, buffer = buffer.partition(b"\n")
                if command == b"kill" and not reaped:
                    # Only B signals C, and only before B has reaped C.
                    os.kill(native, signal.SIGKILL)


def _pump(*, master: int) -> None:
    """Forward available terminal bytes without mixing in control messages.

    Args:
        master:
            PTY master descriptor.
    """
    try:
        data = os.read(master, 65536)
        if data:
            os.write(1, data)
    except OSError as error:
        if error.errno != errno.EIO:
            raise


def _emit(*, fd: int, event: dict[str, object]) -> None:
    """Write one bounded ownership event to a dedicated pipe.

    Args:
        fd:
            Destination descriptor.
        event:
            Ownership event, never native terminal input.
    """
    os.write(fd, (json.dumps(event) + "\n").encode())


def _signal_group(*, anchor: int, sig: int) -> None:
    """Signal an unreaped direct child's session group.

    Args:
        anchor:
            Positive session leader PID owned and not yet reaped by this process.
        sig:
            Signal to deliver.
    """
    if anchor <= 1:
        raise RuntimeError("Invalid session anchor")
    try:
        os.killpg(anchor, sig)
    except ProcessLookupError:
        pass


def _group_exists(*, anchor: int) -> bool:
    """Probe absence after the last signal; permission errors remain failures.

    Args:
        anchor:
            Previously owned session group ID.

    Returns:
        Whether the group is still present.
    """
    try:
        os.killpg(anchor, 0)
        return True
    except ProcessLookupError:
        return False


if __name__ == "__main__":
    main()
