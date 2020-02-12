const { EventEmitter } = require("events");
const child_process = require("child_process");
const NMP = require("minecraft-protocol");
const IDMap = require("./IDMap");

const ENTITY_PROPS = ["entityId", "collectedEntityId", "collectorEntityId"];
const ENTITY_ARRAY_PROPS = ["entityIds"];

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

      for (const id of ENTITY_PROPS) {
        if (data[id]) {
          data[id] = this.entities.fromProxyId(data[id]);
        }
      }
      for (const id of ENTITY_ARRAY_PROPS) {
        if (data[id]) {
          for (const index in data[id]) {
            data[id][index] = this.entities.fromProxyId(data[id][index]);
          }
        }
      }

      client.write(metadata.name, data);
    });

    client.on("packet", (data, metadata) => {
      if (metadata.name == "keep_alive" || metadata.state != "play") {
        return console.log("Dropping bad", metadata);
      }
      console.log("Sending to proxy...", metadata, data);

      for (const id of ENTITY_PROPS) {
        if (data[id]) {
          data[id] = this.entities.fromClientId(data[id]);
          if (!data[id]) {
            console.log("Concerning... No entity id, dropping...");
            return;
          }
        }
      }

      for (const id of ENTITY_ARRAY_PROPS) {
        if (data[id]) {
          for (const index in data[id]) {
            data[id][index] = this.entities.fromClientId(data[id][index]);
            if (!data[id][index]) {
              console.log("Concerning... No entity id in arr, dropping...");
            }
          }
          data[id] = data[id].filter(val => val);
          if (!data[id].length) {
            console.log(
              "Concerning... No entity id AT ALL in arr, dropping..."
            );
            return;
          }
        }
      }

      proxy.write(metadata.name, data);
    });

    return proxy;
  }
}

module.exports = Manager;
