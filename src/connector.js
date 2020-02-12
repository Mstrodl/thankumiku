class ConnectionSet extends Set {
  constructor(manager) {
    super();

    this._manager = manager;
    this._timeout = null;
  }

  add(connection) {
    this._cancelShutdown();

    if (this._manager.status == "ONLINE") {
      this._hook(connection);
    }

    return super.add(connection);
  }

  delete(connection) {
    if (this.size == 1) {
      this._prepareShutdown();
    }

    return Set.prototype.delete.apply(this, arguments);
  }

  _cancelShutdown() {
    if (this._timeout) {
      clearTimeout(this._timeout);
      this._timeout = null;
    } else if (this._manager.status == "OFFLINE") {
      this._manager.startup();
    }
  }

  _prepareShutdown() {
    this._timeout = setTimeout(() => {
      this._timeout = null;
      this._manager.shutdown();
    }, config.SHUTDOWN_TIMEOUT);
  }

  _hook(connection) {
    connection._userClient = new NMP.Client(
      true,
      this._manager.version,
      {},
      false
    );
    connection._userClient.setSocket(connection);
    if (this._manager.status == "ONLINE") {
      connection._serverClient = new NMP.Client(
        false,
        this._manager.version,
        {},
        false
      );
      connection._userClient.on("session", session => {
        connection._serverClient.username = connection._userClient.username;
        connection._serverClient.session = session;
        connection._serverClient.emit("session", session);

        connection._serverClient.setSocket(manager.createConnection());
        connection._serverClient.emit("connect");
      });
    } else {
      connection._userClient.write("disconnect", {
        reason: JSON.stringify({
          text: `Server is spinning up: ${this._manager.status}. Please wait a minute or two while it starts!`
        })
      });
    }
  }
}

const _connections = new Set();
module.exports.connections = Object.assign({}, _connections, {
  _connections,
  [Symbol.iterator]: _connections[Symbol.iterator],
  add(value) {
    _connections.add(value);
    return module.exports.connections;
  },
  get size() {
    return _connections.size;
  }
});
