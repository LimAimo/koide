"""Minimal RFC 6455 server-side WebSocket (stdlib only, so it runs on Termux with zero installs)."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import struct

_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
OP_CONT, OP_TEXT, OP_BIN, OP_CLOSE, OP_PING, OP_PONG = 0x0, 0x1, 0x2, 0x8, 0x9, 0xA


class WebSocketClosed(Exception):
    """Raised when the peer closes the connection or the stream breaks."""


def accept_key(client_key: str) -> str:
    digest = hashlib.sha1((client_key + _GUID).encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")


def _xor_mask(data: bytes, mask: bytes) -> bytes:
    if not data:
        return data
    n = len(data)
    full = (mask * (n // 4 + 1))[:n]
    return (int.from_bytes(data, "big") ^ int.from_bytes(full, "big")).to_bytes(n, "big")


class WebSocket:
    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter,
                 max_message: int = 32 * 1024 * 1024):
        self._r = reader
        self._w = writer
        self._max = max_message
        self._send_lock = asyncio.Lock()
        self.closed = False

    async def _read_frame(self):
        head = await self._r.readexactly(2)
        fin = bool(head[0] & 0x80)
        opcode = head[0] & 0x0F
        masked = bool(head[1] & 0x80)
        length = head[1] & 0x7F
        if length == 126:
            length = struct.unpack("!H", await self._r.readexactly(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", await self._r.readexactly(8))[0]
        if length > self._max:
            raise WebSocketClosed("frame too large")
        mask = await self._r.readexactly(4) if masked else b""
        data = await self._r.readexactly(length) if length else b""
        return fin, opcode, _xor_mask(data, mask) if masked else data

    async def _send_frame(self, opcode: int, payload: bytes = b"") -> None:
        header = bytearray([0x80 | opcode])
        n = len(payload)
        if n < 126:
            header.append(n)
        elif n < 65536:
            header.append(126)
            header += struct.pack("!H", n)
        else:
            header.append(127)
            header += struct.pack("!Q", n)
        async with self._send_lock:
            self._w.write(bytes(header) + payload)
            await self._w.drain()

    async def recv(self):
        """Return the next complete text (str) or binary (bytes) message."""
        buf = bytearray()
        msg_op = None
        while True:
            try:
                fin, op, data = await self._read_frame()
            except (asyncio.IncompleteReadError, ConnectionError, OSError) as e:
                self.closed = True
                raise WebSocketClosed(str(e)) from e
            if op == OP_PING:
                await self._send_frame(OP_PONG, data)
                continue
            if op == OP_PONG:
                continue
            if op == OP_CLOSE:
                if not self.closed:
                    self.closed = True
                    try:
                        await self._send_frame(OP_CLOSE, data[:2])
                    except Exception:
                        pass
                raise WebSocketClosed("closed by peer")
            if op in (OP_TEXT, OP_BIN):
                msg_op = op
                buf = bytearray(data)
            elif op == OP_CONT:
                buf += data
            if len(buf) > self._max:
                raise WebSocketClosed("message too large")
            if fin:
                return buf.decode("utf-8") if msg_op == OP_TEXT else bytes(buf)

    async def send_text(self, text: str) -> None:
        if self.closed:
            raise WebSocketClosed("closed")
        await self._send_frame(OP_TEXT, text.encode("utf-8"))

    async def close(self, code: int = 1000) -> None:
        if self.closed:
            return
        self.closed = True
        try:
            await self._send_frame(OP_CLOSE, struct.pack("!H", code))
            self._w.close()
        except Exception:
            pass
