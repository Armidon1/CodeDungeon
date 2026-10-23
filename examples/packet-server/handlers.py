"""Una funzione per ogni tipo di pacchetto."""
import hmac
import json

from protocol import TYPE_LOGIN, TYPE_MESSAGE, TYPE_PING, build_packet

USERS = {"lumen": "lanterna42"}  # solo per la demo: in produzione si salvano hash, non password


def handle_ping(session, payload):
    return build_packet(TYPE_PING, b"pong")


def handle_login(session, payload):
    data = json.loads(payload)
    user = data.get("user", "")
    password = data.get("password", "")
    expected = USERS.get(user)
    if expected is not None and hmac.compare_digest(expected, password):
        session["user"] = user
        return build_packet(TYPE_LOGIN, b"ok")
    return build_packet(TYPE_LOGIN, b"denied")


def handle_message(session, payload):
    if "user" not in session:
        return build_packet(TYPE_MESSAGE, b"login richiesto")
    text = payload.decode("utf-8", errors="replace")
    print(f"[{session['user']}] {text}")
    return build_packet(TYPE_MESSAGE, b"ricevuto")
