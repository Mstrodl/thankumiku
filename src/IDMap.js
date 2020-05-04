class IDMap {
  constructor() {
    // Hopefully this is okay...
    this._idCounter = Math.pow(2, 31) - 1;
    this._proxyEntities = new Map();
    this._clientEntities = new Map();
  }

  id() {
    const clientId = this._idCounter--;
    this._clientEntities.set(clientId, null);
    return clientId;
  }

  associate(proxyId, clientId, metadata = null, withMeta = false) {
    this._clientEntities.set(
      clientId,
      Object.assign(
        {
          id: proxyId,
        },
        metadata
      )
    );
    const clientEntity = Object.assign(
      {
        id: clientId,
      },
      metadata
    );
    this._proxyEntities.set(proxyId, clientEntity);
    return withMeta ? clientEntity : clientId;
  }

  fromProxyId(proxyId, withMeta = false, metadata = null) {
    const clientEntity = this._proxyEntities.get(proxyId);
    if (clientEntity === undefined) {
      return this.associate(proxyId, this.id(), metadata, withMeta);
    } else {
      return withMeta ? clientEntity : clientEntity.id;
    }
  }

  fromClientId(clientId, withMeta = false) {
    const entity = this._clientEntities.get(clientId);
    if (withMeta) {
      return entity;
    } else {
      return entity.id;
    }
  }
}

module.exports = IDMap;
