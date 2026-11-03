# Codec adapted from the own-account wechat-research tools/wework_decrypt.py, reviewed 2026-11-03.
#!/usr/bin/env python3
"""Offline decryptor for WeCom 5.0.13 local SQLite databases (own account only).

Key input is the account VID encoded as 8-byte little-endian, matching the
recovered sqlite3_key path. Reads the original database read-only and writes a
new plaintext copy; never modifies the source and never touches a running app.
"""

import argparse
import ctypes
import hashlib
import json
import sqlite3
import struct
from pathlib import Path

PDF_PAD = bytes.fromhex(
    "28bf4e5e4e758a4164004e56fffa01082"
    "e2e00b6d0683e802f0ca9fe6453697a"
)
SQLITE_HEADER = b"SQLite format 3\x00"


def md5(data):
    return hashlib.md5(data).digest()


def rc4(key, data):
    state = list(range(256))
    j = 0
    for i in range(256):
        j = (j + state[i] + key[i % len(key)]) & 255
        state[i], state[j] = state[j], state[i]
    i = j = 0
    out = bytearray()
    for value in data:
        i = (i + 1) & 255
        j = (j + state[i]) & 255
        state[i], state[j] = state[j], state[i]
        out.append(value ^ state[(state[i] + state[j]) & 255])
    return bytes(out)


def derive_base_key(password):
    padded = password[:32] + PDF_PAD[:max(0, 32 - len(password))]
    digest = md5(PDF_PAD)
    for _ in range(50):
        digest = md5(digest)
    owner = padded
    for i in range(20):
        owner = rc4(bytes(value ^ i for value in digest), owner)
    digest = md5(padded + owner)
    for _ in range(50):
        digest = md5(digest)
    return digest


def page_key(base_key, page_number):
    return md5(base_key + struct.pack("<I", page_number) + b"sAlT")


def page_iv(page_number):
    state = page_number + 1
    words = []
    for _ in range(4):
        quotient = state // 52774
        state = 40692 * (state - quotient * 52774) - 3791 * quotient
        if state < 0:
            state += 2147483399
        words.append(state)
    return md5(struct.pack("<4I", *words))


class AES:
    def __init__(self):
        self.lib = ctypes.CDLL("/usr/lib/system/libcommonCrypto.dylib")
        self.lib.CCCrypt.argtypes = [
            ctypes.c_uint, ctypes.c_uint, ctypes.c_uint,
            ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p,
            ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p,
            ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t),
        ]
        self.lib.CCCrypt.restype = ctypes.c_int

    def decrypt(self, data, key, iv):
        if len(key) != 16 or len(iv) != 16 or not data or len(data) % 16:
            raise ValueError("AES128 CBC requires 16-byte key/IV and whole blocks")
        output = ctypes.create_string_buffer(len(data))
        written = ctypes.c_size_t()
        status = self.lib.CCCrypt(
            1, 0, 0, key, len(key), iv, data, len(data),
            output, len(data), ctypes.byref(written),
        )
        if status != 0 or written.value != len(data):
            raise RuntimeError("CommonCrypto AES operation failed")
        return output.raw[:written.value]


def metadata_valid(header):
    if len(header) < 24:
        return False
    size = int.from_bytes(header[16:18], "big")
    size = 65536 if size == 1 else size
    return (
        512 <= size <= 65536 and size & (size - 1) == 0
        and header[18] in (1, 2) and header[19] in (1, 2)
        and header[21:24] == bytes((64, 32, 32))
    )


def decrypt_page(aes, data, base_key, page_number):
    key = page_key(base_key, page_number)
    iv = page_iv(page_number)
    if page_number == 1:
        tail = aes.decrypt(data[8:16] + data[24:], key, iv)
        if tail[:8] != data[16:24]:
            raise ValueError("page one metadata check failed")
        return SQLITE_HEADER + tail
    return aes.decrypt(data, key, iv)


def wal_checksum(data, s1, s2, order):
    if len(data) % 8:
        data = data + bytes(8 - len(data) % 8)
    for offset in range(0, len(data), 8):
        w1 = int.from_bytes(data[offset:offset + 4], order)
        w2 = int.from_bytes(data[offset + 4:offset + 8], order)
        s1 = (s1 + w1 + s2) & 0xFFFFFFFF
        s2 = (s2 + w2 + s1) & 0xFFFFFFFF
    return s1, s2


