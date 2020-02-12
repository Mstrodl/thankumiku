const { EventEmitter } = require("events");
const child_process = require("child_process");
const NMP = require("minecraft-protocol");
const IDMap = require("./IDMap");

const ENTITY_PROPS = ["entityId", "collectedEntityId", "collectorEntityId"];
const ENTITY_ARRAY_PROPS = ["entityIds", "passengers"];

class Manager extends EventEmitter {
  constructor(options) {
    super();

    this.port = options.port;
    this.address = options.address;

    this.cwd = options.process.cwd;
    this.executable = options.process.executable;
    this.args = options.process.args;

    this.entities = new IDMap();

    this.status = "OFFLINE";
  }

  startup() {
    if (this.process || this.status != "OFFLINE") {
      throw new Error("Manager.startup() called but server isn't offline?");
    }
    this.process = child_process.execFile(this.executable, this.args, {
      cwd: this.cwd,
      encoding: "utf8",
      stdio: "pipe",
      shell: false
    });
    this.status = "STARTING";
    this.emit("starting");
    console.log("Starting server");
    this.process.stdout.on("data", msg => {
      console.log("Msg", msg);
      if (
        msg.match(
          /^\[(?:\d{2}\:){2}\d{2} INFO\]: Done \(\d+.\d+s\)! For help, type "help"\n$/
        )
      ) {
        console.log("Started server");
        this.status = "ONLINE";
        this.emit("online");
      }
    });
  }

  createProxy(client) {
    const proxy = NMP.createClient({
      host: this.address,
      port: this.port,
      username: client.username,
      version: client.server.version
    });

    proxy.on("packet", (data, metadata) => {
      if (metadata.name == "login" || metadata.state != "play") return;

      console.log("Sending to client...", metadata, data);

      this.entityClobber(metadata, data, true);

      client.write(metadata.name, data);
    });

    client.on("packet", (data, metadata) => {
      if (metadata.name == "keep_alive" || metadata.state != "play") {
        return console.log("Dropping bad", metadata);
      }
      console.log("Sending to proxy...", metadata, data);

      if(this.entityClobber(metadata, data, true) === null) return;

      proxy.write(metadata.name, data);
    });

    return proxy;
  }
  entityClobber(metadata, data, toServer) {
    if(metadata.name == "tags") {
      for(const tagIndex in data.entityTags) {
        const tag = data.entityTags[tagIndex];
        for(const entryIndex in tag.entries) {
          tag.entries[entryIndex] = toServer ? this.entities.fromClientId(tag.entries[entryIndex]) : this.entities.fromProxyId(tag.entries[entryIndex]);
        }
        if(toServer) {
          tag.entries = tag.entries.filter(val => val); 
          if(!tag.entries.length) {
            console.log("Tag has no entries. Dropping");
            data.entityTags[tagIndex] = null;
          }
        }
      }
      if(toServer) {
        data.entityTags = data.entityTags.filter(tag => tag);
        if(!data.entityTags.length) {
          return null;
        }
      }
    }
    
    for (const id of ENTITY_PROPS) {
      if (data[id]) {
        data[id] = toServer ? this.entities.fromClientId(data[id]) : this.entities.fromProxyId(data[id]);
        if (!data[id]) {
          console.log("Concerning... No entity id, dropping...");
          return null;
        }
      }
    }

    for (const id of ENTITY_ARRAY_PROPS) {
      if (data[id]) {
        for (const index in data[id]) {
          data[id][index] = toServer ? this.entities.fromClientId(data[id][index]) : this.entities.fromProxyId(data[id][index]);
          if (!data[id][index]) {
            console.log("Concerning... No entity id in arr, dropping...");
            return null;
          }
        }
        if(toServer) {
          data[id] = data[id].filter(val => val);
          if (!data[id].length) {
            console.log(
              "Concerning... No entity id AT ALL in arr, dropping..."
            );
            return null;
          }
        }
      }
    } 
  }
}

module.exports = Manager;
