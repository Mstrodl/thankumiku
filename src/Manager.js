const { EventEmitter } = require("events");
const child_process = require("child_process");
const NMP = require("minecraft-protocol");
const IDMap = require("./IDMap");

const debug = require("debug")("ProcessManager");

const ENTITY_PROPS = [
  "entityId",
  "collectedEntityId",
  "collectorEntityId",
  "target"
];
const ENTITY_ARRAY_PROPS = ["entityIds", "passengers"];

const NO_LOGS = [
  "entity_move_look",
  "entity_head_rotation",
  "entity_velocity",
  "rel_entity_move",
  "soundEffect",
  "entity_teleport"
];

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

    this.shutdownTime = options.process.shutdownTime;
    this._shutdownTimeout = null;
  }

  queueShutdown() {
    if (!this._shutdownTimeout) {
      this._shutdownTimeout = setTimeout(() => {
        console.log("Timeout reached... Shutting down server");
        if (this.status != "OFFLINE") {
          this.shutdown();
        }
      }, this.shutdownTime);
    }
  }
  unqueueShutdown() {
    if (this._shutdownTimeout) {
      console.log("Unqueue-ing shutdown");
      clearTimeout(this._shutdownTimeout);
      this._shutdownTimeout = null;
    }
  }

  shutdown() {
    console.log("Shutting down server");
    this.process.kill("SIGINT");

    this.status = "OFFLINE";
    this.emit("offline");
  }

  startup() {
    this.unqueueShutdown();
    if (this.process && this.status == "OFFLINE") {
      console.log(
        "Startup requested, but we're shutting down... Deferring startup to process death"
      );
      this.once("processDied", () => this.startup());
      return;
    } else if (this.process || this.status != "OFFLINE") {
      throw new Error("Manager.startup() called but server isn't offline?");
    }
    this.process = child_process.execFile(this.executable, this.args, {
      cwd: this.cwd,
      encoding: "utf8",
      stdio: "pipe",
      killSignal: "SIGINT",
      shell: false
    });
    this.status = "STARTING";
    this.emit("starting");
    console.log("Starting server");
    this.process.stdout.pipe(process.stdout);
    this.process.stdout.on("data", msg => {
      if (
        msg.match(
          /^\[(?:\d{2}\:){2}\d{2} INFO\]: Done \(\d+.\d+s\)! For help, type "help"\n$/
        )
      ) {
        console.log(
          "Server is ready... Waiting 10s for the server to tick a bit"
        );
        setTimeout(() => {
          console.log("Started server");
          this.status = "ONLINE";
          this.emit("online");
        }, 1000 * 10);
      }
    });
    process.stdin.pipe(this.process.stdin);

    this.process.once("exit", code => {
      console.log("Server shut down... Code: " + code);
      this.process = null;
      if (this.status != "OFFLINE") {
        this.status = "OFFLINE";
        this.emit("offline");
      }
      this.emit("processDied");
    });
  }

  createProxy(client) {
    const proxy = NMP.createClient({
      host: this.address,
      port: this.port,
      username: client.username,
      version: client.server.version
    });

    client.once("end", reason => proxy.end(reason));
    // TODO: send users back to a lobby?
    proxy.once("end", reason => {
      if (this.status == "ONLINE") {
        client.end(reason);
      }
      client.removeListener("packet", proxyFromClient);
      proxy.removeAllListeners();
    });

    proxy.on("packet", (data, metadata) => {
      if (metadata.name == "login" || metadata.state != "play") return;

      if (
        metadata.name == "respawn" ||
        (!NO_LOGS.includes(metadata.name) &&
          process.env.NODE_ENV != "production")
      ) {
        debug("Sending to client...", metadata, data);
      }

      this.entityClobber(metadata, data);

      client.write(metadata.name, data);
    });

    const proxyFromClient = (data, metadata) => {
      if (metadata.name == "keep_alive" || metadata.state != "play") {
        return debug("Dropping bad", metadata);
      }
      if (process.env.NODE_ENV != "production") {
        debug("Sending to proxy...", metadata, data);
      }

      if (this.entityClobber(metadata, data, true) === null) return;

      proxy.write(metadata.name, data);
    };

    client.on("packet", proxyFromClient);

    return proxy;
  }
  entityClobber(metadata, data, toServer) {
    if (metadata.name == "tags") {
      for (const tagIndex in data.entityTags) {
        const tag = data.entityTags[tagIndex];
        for (const entryIndex in tag.entries) {
          tag.entries[entryIndex] = toServer
            ? this.entities.fromClientId(tag.entries[entryIndex])
            : this.entities.fromProxyId(tag.entries[entryIndex]);
        }
        if (toServer) {
          tag.entries = tag.entries.filter(val => val);
          if (!tag.entries.length) {
            console.warn("Tag has no entries. Dropping");
            data.entityTags[tagIndex] = null;
          }
        }
      }
      if (toServer) {
        data.entityTags = data.entityTags.filter(tag => tag);
        if (!data.entityTags.length) {
          return null;
        }
      }
    }

    for (const id of ENTITY_PROPS) {
      if (data[id]) {
        data[id] = toServer
          ? this.entities.fromClientId(data[id])
          : this.entities.fromProxyId(data[id]);
        if (!data[id]) {
          console.warn("Concerning... No entity id, dropping...");
          return null;
        }
      }
    }

    for (const id of ENTITY_ARRAY_PROPS) {
      if (data[id]) {
        for (const index in data[id]) {
          data[id][index] = toServer
            ? this.entities.fromClientId(data[id][index])
            : this.entities.fromProxyId(data[id][index]);
          if (!data[id][index]) {
            console.warn("Concerning... No entity id in arr, dropping...");
            return null;
          }
        }
        if (toServer) {
          data[id] = data[id].filter(val => val);
          if (!data[id].length) {
            console.warn(
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
