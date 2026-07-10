// Thin wrapper around PeerJS (loaded globally via vendor/peerjs.min.js) for
// a simple two-player host/join party system. Host is authoritative for
// the shared world (monster, items, door); the guest runs its own local
// player fully client-side for responsiveness and just sends its state
// upstream, rendering everything else from the host's broadcasts.
const PARTY_PREFIX = "hollowhouse-";
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O/1/I
const CODE_LENGTH = 4;
const MAX_HOST_RETRIES = 3;

export function generateCode() {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

export class Network {
  constructor() {
    this.peer = null;
    this.conn = null;
    this.isHost = false;
    this.connected = false;
    this.code = null;

    this.onPeerConnected = null;
    this.onPeerDisconnected = null;
    this.onMessage = null;
    this.onError = null;
  }

  hostParty() {
    return this._hostAttempt(generateCode(), 0);
  }

  _hostAttempt(code, attempt) {
    return new Promise((resolve, reject) => {
      this.isHost = true;
      const peer = new Peer(PARTY_PREFIX + code, { debug: 0 });
      this.peer = peer;

      const onOpen = () => {
        this.code = code;
        peer.off("error", onError);
        resolve(code);
      };
      const onError = (err) => {
        peer.off("open", onOpen);
        if (err.type === "unavailable-id" && attempt < MAX_HOST_RETRIES) {
          peer.destroy();
          this._hostAttempt(generateCode(), attempt + 1).then(resolve, reject);
        } else {
          if (this.onError) this.onError(err);
          reject(err);
        }
      };

      peer.on("open", onOpen);
      peer.on("error", onError);
      peer.on("connection", (conn) => {
        // Only one guest supported - ignore anyone else trying to join.
        if (this.conn) {
          conn.close();
          return;
        }
        this.conn = conn;
        this._wireConnection(conn);
      });
    });
  }

  joinParty(code) {
    return new Promise((resolve, reject) => {
      this.isHost = false;
      const peer = new Peer({ debug: 0 });
      this.peer = peer;

      peer.on("open", () => {
        const conn = peer.connect(PARTY_PREFIX + code.toUpperCase());
        this.conn = conn;
        this._wireConnection(conn);

        const timeout = setTimeout(() => {
          reject(new Error("Could not reach that party code."));
        }, 10000);

        conn.on("open", () => {
          clearTimeout(timeout);
          resolve();
        });
        conn.on("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
      peer.on("error", (err) => {
        if (this.onError) this.onError(err);
        reject(err);
      });
    });
  }

  _wireConnection(conn) {
    conn.on("open", () => {
      this.connected = true;
      if (this.onPeerConnected) this.onPeerConnected();
    });
    conn.on("data", (data) => {
      if (this.onMessage) this.onMessage(data);
    });
    conn.on("close", () => {
      this.connected = false;
      if (this.onPeerDisconnected) this.onPeerDisconnected();
    });
    conn.on("error", (err) => {
      if (this.onError) this.onError(err);
    });
  }

  send(data) {
    if (this.conn && this.connected) {
      try {
        this.conn.send(data);
      } catch {
        // Connection may have just dropped - next state tick will notice.
      }
    }
  }

  destroy() {
    if (this.peer) this.peer.destroy();
    this.peer = null;
    this.conn = null;
    this.connected = false;
  }
}
