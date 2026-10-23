"""Server TCP: accetta i client e gestisce ognuno in un thread separato."""
import socket
import threading

from dispatcher import dispatch
from protocol import ProtocolError, read_packet

HOST = "0.0.0.0"
PORT = 9000


def handle_client(conn, addr):
    session = {}
    with conn:
        while True:
            try:
                ptype, payload = read_packet(conn)
                reply = dispatch(session, ptype, payload)
                conn.sendall(reply)
            except (ConnectionError, ProtocolError) as e:
                print(f"{addr}: chiusura ({e})")
                return


def main():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as srv:
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind((HOST, PORT))
        srv.listen()
        print(f"in ascolto su {HOST}:{PORT}")
        while True:
            conn, addr = srv.accept()
            threading.Thread(target=handle_client, args=(conn, addr), daemon=True).start()


if __name__ == "__main__":
    main()
