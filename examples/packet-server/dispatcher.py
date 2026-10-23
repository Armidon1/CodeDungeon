"""Smista ogni pacchetto alla funzione giusta in base al tipo scritto nell'header."""
from handlers import handle_login, handle_message, handle_ping
from protocol import TYPE_LOGIN, TYPE_MESSAGE, TYPE_PING, ProtocolError

HANDLERS = {
    TYPE_PING: handle_ping,
    TYPE_LOGIN: handle_login,
    TYPE_MESSAGE: handle_message,
}


def dispatch(session, ptype, payload):
    handler = HANDLERS.get(ptype)
    if handler is None:
        raise ProtocolError(f"tipo di pacchetto sconosciuto: {ptype:#04x}")
    return handler(session, payload)
