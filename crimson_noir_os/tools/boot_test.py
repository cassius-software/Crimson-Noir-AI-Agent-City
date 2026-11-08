#!/usr/bin/env python3
# Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
# SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
# Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
"""
Why does this file exist? It boots the bootable media in QEMU with UEFI firmware (OVMF on a PC, AAVMF on QEMU's Arm
`virt` machine with `--arch aarch64`), as a machine would, and checks what the system reports: the serial log must reach
every marker asked for (SELFTEST PASS, the tutorial's states) within the time allowed, and the screen is captured as PNG
along the way. It can type into the system and capture again, so the terminal is tested the same way: on x86-64 into a
PS/2 keyboard through QEMU's monitor; on aarch64 (no PS/2 controller, and the image has no USB stack) into the serial
line, a terminal's bytes and escape sequences. `--step` runs a script of steps in
order (wait:MARKER, shot:FILE.png, type:TEXT with \n for Enter, key:QEMU-KEY, sleep:SECONDS, exit: the machine
powers itself off); each wait looks only at what the log gained since the last one. Nothing leaves this machine.
What breaks if it is removed? Nothing would check that the image boots into the tutorial.
"""
import argparse
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import zlib

OVMF_CODE = "/usr/share/OVMF/OVMF_CODE_4M.fd"
OVMF_VARS = "/usr/share/OVMF/OVMF_VARS_4M.fd"
# Debian and Ubuntu's qemu-efi-aarch64: edk2 for QEMU's Arm virt machine (64 MiB flash images).
AAVMF_CODE = "/usr/share/AAVMF/AAVMF_CODE.fd"
AAVMF_VARS = "/usr/share/AAVMF/AAVMF_VARS.fd"

# What a terminal sends for the QEMU key names a `key:` step uses, on the serial line (aarch64).
SERIAL_KEYS = {"ret": b"\r", "esc": b"\x1b", "backspace": b"\x7f", "tab": b"\t", "spc": b" ", "up": b"\x1b[A",
               "down": b"\x1b[B", "right": b"\x1b[C", "left": b"\x1b[D", "pgup": b"\x1b[5~", "pgdn": b"\x1b[6~"}

KEYS = {" ": "spc", "\n": "ret", "-": "minus", "=": "equal", ".": "dot", ",": "comma", "/": "slash", ";": "semicolon",
        "'": "apostrophe", "[": "bracket_left", "]": "bracket_right", "\\": "backslash", "`": "grave_accent",
        "*": "shift-8", "+": "shift-equal", ":": "shift-semicolon", "(": "shift-9", ")": "shift-0", "!": "shift-1",
        "@": "shift-2", "\"": "shift-apostrophe", "<": "shift-comma", ">": "shift-dot", "?": "shift-slash",
        "_": "shift-minus", "\x1b": "esc", "\b": "backspace", "#": "shift-3", "$": "shift-4", "%": "shift-5",
        "^": "shift-6", "&": "shift-7", "|": "shift-backslash", "{": "shift-bracket_left", "}": "shift-bracket_right",
        "~": "shift-grave_accent"}


def monitor(path, command):
    """One command on QEMU's human monitor; returns what it answered."""
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.connect(path)
    s.settimeout(10)
    buf = b""
    while not buf.endswith(b"(qemu) "):
        chunk = s.recv(4096)
        if not chunk:
            raise OSError("QEMU closed its monitor before the prompt")
        buf += chunk
    s.sendall(command.encode() + b"\n")
    out = b""
    deadline = time.time() + 10
    while time.time() < deadline and not out.endswith(b"(qemu) "):
        try:
            chunk = s.recv(4096)
        except socket.timeout:
            break
        # A closed monitor (QEMU quitting) answers nothing more: stop rather than spin to the deadline.
        if not chunk:
            break
        out += chunk
    s.close()
    return out.decode(errors="replace")


def ppm_to_png(ppm_path, png_path):
    data = open(ppm_path, "rb").read()
    # The header is four tokens (P6, width, height, maxval) separated by whitespace and comments; the pixels start after
    # exactly one whitespace byte past the last token (a pixel byte may itself look like whitespace).
    tokens, i = [], 0
    while len(tokens) < 4:
        while data[i:i + 1].isspace() or data[i:i + 1] == b"#":
            if data[i:i + 1] == b"#":
                i = data.index(b"\n", i)
            i += 1
        j = i
        while not data[j:j + 1].isspace():
            j += 1
        tokens.append(data[i:j])
        i = j
    if tokens[0] != b"P6" or tokens[3] != b"255":
        raise ValueError("not an 8-bit binary PPM")
    w, h = int(tokens[1]), int(tokens[2])
    pixels = data[i + 1:i + 1 + w * h * 3]
    rows = b"".join(b"\x00" + pixels[y * w * 3:(y + 1) * w * 3] for y in range(h))

    def chunk(kind, body):
        c = kind + body
        return struct.pack(">I", len(body)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b"")
    open(png_path, "wb").write(png)
    return w, h


def shot(sock, work, png):
    ppm = os.path.join(work, "shot.ppm")
    monitor(sock, f"screendump {ppm}")
    for _ in range(50):
        if os.path.exists(ppm) and os.path.getsize(ppm) > 0:
            break
        time.sleep(0.1)
    w, h = ppm_to_png(ppm, png)
    print(f"screenshot {png} ({w}x{h})")


def type_text(sock, text):
    for ch in text:
        if ch in KEYS:
            key = KEYS[ch]
        elif ch.isalpha() and ch.isupper():
            key = "shift-" + ch.lower()
        else:
            key = ch
        monitor(sock, f"sendkey {key}")
        time.sleep(0.05)


class SerialLine:
    """The aarch64 machine's serial line: QEMU serves it on a Unix socket and waits for this to connect before the
    machine starts, so no byte is lost; a thread copies what the system writes to the log file, and typing writes
    bytes back."""

    def __init__(self, path, log_path, q):
        deadline = time.time() + 30
        while True:
            try:
                self.s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                self.s.connect(path)
                break
            except OSError:
                self.s.close()
                if time.time() > deadline or q.poll() is not None:
                    raise OSError("QEMU never served its serial line")
                time.sleep(0.1)
        self.log = open(log_path, "ab", buffering=0)
        threading.Thread(target=self.copy, daemon=True).start()

    def copy(self):
        while True:
            try:
                chunk = self.s.recv(4096)
            except OSError:
                return
            if not chunk:
                return
            self.log.write(chunk)

    def send(self, data):
        self.s.sendall(data)


def type_serial(line, text):
    for ch in text:
        line.send(b"\r" if ch == "\n" else ch.encode("latin-1"))
        time.sleep(0.02)


def wait_for(log_path, marker, deadline, since=0):
    """Waits for `marker` in the log after offset `since`; returns the offset just past it, or None."""
    while time.time() < deadline:
        if os.path.exists(log_path):
            text = open(log_path, errors="replace").read()
            at = text.find(marker, since)
            if at >= 0:
                return at + len(marker)
        time.sleep(0.25)
    return None


def main():
    p = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    p.add_argument("media", help="the disk image (.img) or the ISO (.iso)")
    p.add_argument("--wait", action="append", default=[], help="a serial-log marker to wait for (in order)")
    p.add_argument("--shot", action="append", default=[], help="a PNG to capture after each marker (in order)")
    p.add_argument("--type", default=None, help="text to type after the markers")
    p.add_argument("--after-type-wait", default=None, help="a marker to wait for after typing")
    p.add_argument("--after-type-shot", default=None, help="a PNG to capture after typing")
    p.add_argument("--timeout", type=float, default=600, help="seconds allowed for each marker")
    p.add_argument("--log", default=None, help="where to keep the serial log")
    p.add_argument("--step", action="append", default=[], help="a scripted step, run after the markers (in order)")
    p.add_argument("--arch", choices=["x86_64", "aarch64"], default="x86_64",
                   help="the machine: a PC (q35, OVMF) or QEMU's Arm virt machine (AAVMF, ramfb, virtio disks)")
    a = p.parse_args()

    work = tempfile.mkdtemp(prefix="crimson-boot-")
    arm = a.arch == "aarch64"
    vars_fd = os.path.join(work, "vars.fd")
    shutil.copy(AAVMF_VARS if arm else OVMF_VARS, vars_fd)
    log = a.log or os.path.join(work, "serial.log")
    if os.path.exists(log):
        os.remove(log)
    sock = os.path.join(work, "monitor.sock")
    if arm:
        # The virt machine has no IDE: the disk is virtio-blk, the ISO a SCSI CD-ROM. The screen is ramfb (a plain
        # framebuffer in RAM that QEMU scans out), so what the image writes after ExitBootServices is what is shown;
        # virtio-gpu would need its commands sent. The serial line is a socket this script connects to (SerialLine).
        serial = os.path.join(work, "serial.sock")
        media = (["-device", "virtio-scsi-pci", "-device", "scsi-cd,drive=cd",
                  "-drive", f"if=none,id=cd,media=cdrom,readonly=on,file={a.media}"] if a.media.endswith(".iso") else
                 ["-device", "virtio-blk-pci,drive=hd", "-drive", f"if=none,id=hd,format=raw,file={a.media}"])
        cmd = ["qemu-system-aarch64", "-machine", "virt", "-m", "512M", "-cpu", "cortex-a72",
               "-drive", f"if=pflash,format=raw,readonly=on,file={AAVMF_CODE}",
               "-drive", f"if=pflash,format=raw,file={vars_fd}", *media,
               "-display", "none", "-device", "ramfb", "-serial", f"unix:{serial},server=on,wait=on",
               "-monitor", f"unix:{sock},server,nowait", "-no-reboot"]
    else:
        media = ["-cdrom", a.media] if a.media.endswith(".iso") else ["-drive", f"format=raw,file={a.media}"]
        cmd = ["qemu-system-x86_64", "-machine", "q35", "-m", "512M", "-cpu", "qemu64",
               "-drive", f"if=pflash,format=raw,readonly=on,file={OVMF_CODE}",
               "-drive", f"if=pflash,format=raw,file={vars_fd}", *media,
               "-display", "none", "-vga", "std", "-serial", f"file:{log}",
               "-monitor", f"unix:{sock},server,nowait", "-no-reboot"]
    q = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    line = SerialLine(serial, log, q) if arm else None

    def type_any(text):
        if line:
            type_serial(line, text)
        else:
            type_text(sock, text)

    def key_any(name):
        if line:
            line.send(SERIAL_KEYS.get(name, name.encode()))
        else:
            monitor(sock, f"sendkey {name}")

    ok = True
    try:
        start = time.time()
        cursor = 0
        for i, marker in enumerate(a.wait):
            found = wait_for(log, marker, time.time() + a.timeout, cursor)
            if found is None:
                print(f"FAIL: '{marker}' never reached the serial log ({time.time() - start:.0f} s)")
                ok = False
                break
            cursor = found
            print(f"ok    '{marker}' after {time.time() - start:.1f} s")
            if i < len(a.shot):
                shot(sock, work, a.shot[i])
        for step in a.step if ok else []:
            kind, _, arg = step.partition(":")
            if kind == "wait":
                found = wait_for(log, arg, time.time() + a.timeout, cursor)
                if found is None:
                    print(f"FAIL: '{arg}' never reached the serial log ({time.time() - start:.0f} s)")
                    ok = False
                    break
                cursor = found
                print(f"ok    '{arg}' after {time.time() - start:.1f} s")
            elif kind == "shot":
                shot(sock, work, arg)
            elif kind == "type":
                type_any(arg.replace("\\n", "\n"))
            elif kind == "key":
                key_any(arg)
            elif kind == "sleep":
                time.sleep(float(arg))
            elif kind == "exit":
                try:
                    q.wait(timeout=a.timeout)
                    print(f"ok    the machine powered itself off after {time.time() - start:.1f} s")
                except subprocess.TimeoutExpired:
                    print("FAIL: the machine did not power off")
                    ok = False
                break
            else:
                print(f"FAIL: unknown step '{step}'")
                ok = False
                break
        if ok and a.type is not None:
            type_any(a.type)
            if a.after_type_wait and not wait_for(log, a.after_type_wait, time.time() + a.timeout):
                print(f"FAIL: '{a.after_type_wait}' never reached the serial log after typing")
                ok = False
            elif a.after_type_wait:
                print(f"ok    '{a.after_type_wait}' after typing")
            if a.after_type_shot:
                time.sleep(2)
                shot(sock, work, a.after_type_shot)
    finally:
        try:
            monitor(sock, "quit")
        except OSError:
            pass
        try:
            q.wait(timeout=10)
        except subprocess.TimeoutExpired:
            q.kill()
    print("serial log:")
    print(open(log, errors="replace").read()[-4000:])
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
