class IDMap {
  constructor() {
    // Hopefully this is okay...
    this._idCounter = Math.pow(2, 31) - 1;
    this._proxyIds = {};
    this._clientIds = {};
  }

  id() {
    const clientId = this._idCounter--;
    this._clientIds[clientId] = null;
    return clientId;
  }

  associate(proxyId, clientId) {
    this._clientIds[clientId] = proxyId;
    this._proxyIds[proxyId] = clientId;

    return clientId;
  }

  fromProxyId(proxyId) {
    const clientId = this._proxyIds[proxyId];
    return clientId || this.associate(proxyId, this.id());
  }

  fromClientId(clientId) {
    return this._clientIds[clientId];
  }
}

module.exports = IDMap;
