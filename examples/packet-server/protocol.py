"""Formato dei pacchetti: header fisso di 10 byte + payload."""
import struct

MAGIC = b"DUNG"
VERSION = 1
HEADER = struct.Struct("!4sBBI")  # magic, versione, tipo, lunghezza del payload

TYPE_PING = 0x01
TYPE_LOGIN = 0x02
TYPE_MESSAGE = 0x03


class ProtocolError(Exception):
    pass


def recv_exact(sock, n):
    data = bytearray()
    while len(data) < n:
        chunk = sock.recv(n - len(data))
        if not chunk:
            raise ConnectionError("connessione chiusa dal client")
        data.extend(chunk)
    return bytes(data)


def read_packet(sock):
    raw = recv_exact(sock, HEADER.size)
    magic, version, ptype, length = HEADER.unpack(raw)
    if magic != MAGIC:
        raise ProtocolError("magic number non valido")
    if version != VERSION:
        raise ProtocolError(f"versione non supportata: {version}")
    payload = recv_exact(sock, length)
    return ptype, payload


def build_packet(ptype, payload=b""):
    return HEADER.pack(MAGIC, VERSION, ptype, len(payload)) + payload
