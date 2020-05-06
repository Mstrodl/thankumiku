const {EventEmitter} = require("events");
const child_process = require("child_process");
const NMP = require("minecraft-protocol");
const IDMap = require("./IDMap");
const fs = require("fs-extra");
const path = require("path");
let pty = null;
const {autoVersionForge} = require("minecraft-protocol-forge");
const {Tail} = require("tail");

function ensurePty() {
  if (pty) return pty;
  pty = require("node-pty");
}

const debug = require("debug")("ProcessManager");

const ENTITY_PROPS = [
  "entityId",
  "collectedEntityId",
  "collectorEntityId",
  "target",
  "vehicleId",
];
const ENTITY_ARRAY_PROPS = ["entityIds", "passengers"];

const NO_LOGS = [
  "entity_move_look",
  "entity_head_rotation",
  "entity_velocity",
  "rel_entity_move",
  "soundEffect",
  "entity_teleport",
];

class Manager extends EventEmitter {
  constructor(options) {
    super();

    this.port = options.port;
    this.address = options.address;

    this.cwd = options.process.cwd;
    this.imageHolder =
      options.process.imageHolder || path.join(this.cwd, "suspension");
    this.executable = options.process.executable;
    this.args = options.process.args;
    this.ipForwarding = options.ipForwarding;
    this.suspendable = options.suspendable;
    if (this.suspendable) {
      ensurePty();
    }
    this.external = options.external;
    this.startupDelay = options.startupDelay || 0;

    this.entities = new IDMap();

    if (this.external) {
      this.status = "ONLINE";
    } else {
      this.status = "OFFLINE";
    }

    this.shutdownTime = options.process.shutdownTime;
    this._shutdownTimeout = null;

    this.tail = new Tail(path.join(this.cwd, "logs/latest.log"));
    this.tail.on("line", (data) => {
      this.processData(data);
    });

    this.entityTypes = {
      firework_rocket: 27,
      fishing_float: 102,
      dragon_fireball: 15,
      fireball: 37,
      small_fireball: 69,
      spectral_arrow: 72,
      arrow: 2,
      wither_skull: 93,
    };
  }

  queueShutdown() {
    if (!this._shutdownTimeout && !this.external) {
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
    const oldStatus = this.status;
    // No more players please
    this.status = "OFFLINE";
    if (this.pid) {
      this.emit("offline");
      if (this.suspendable) {
        this.hibernateProcess(oldStatus);
      } else if (this.pid) {
        this.process.stdin.write("stop\n");
        // process.kill(this.pid, "SIGINT");
      }
    } else {
      console.log("...There isn't a pid... I guess we'll wait?");
    }
  }

  async startup() {
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
    if (this.suspendable) {
      const imageData = await this.currentImageDir();
      console.log("Current image:", imageData);
      if (imageData) {
        this.resumeProcess(imageData.imagePath, imageData.status);
      } else {
        this.startProcess();
      }
    } else {
      this.startProcess();
    }

    if (this.suspendable) {
      this.process.pipe(process.stdout);
      process.stdin.pipe(this.process);
    } else {
      this.process.stdout.pipe(process.stdout);
      this.process.stderr.pipe(process.stderr);
      process.stdin.pipe(this.process.stdin);
    }

    this.once("exit", async (code) => {
      await this._teardown;
      console.log("Server shut down... Code: " + code);
      this.process = null;
      this.pid = null;
      if (this.status != "OFFLINE") {
        this.status = "OFFLINE";
        this.emit("offline");
      }
      this.emit("processDied");
    });
  }

  get imageDir() {
    return path.join(this.cwd, "suspension");
  }

  drillDown(pid, depth) {
    return new Promise((resolve, reject) => {
      child_process.execFile("ps", ["--ppid", pid], (err, stdout, stderr) => {
        if (err) {
          return reject(err);
        }
        const lineIndex = stdout.indexOf("\n");
        if (lineIndex < 0) return reject("No newline?: " + stdout);
        // Trim to get rid of leading spaces!
        const line = stdout.substring(lineIndex + 1).trim();
        const pidIndex = line.indexOf(" ");
        if (pidIndex < 0) return reject("No pid?: " + stdout);
        const pid = parseInt(line.substring(0, pidIndex));
        if (isNaN(pid)) return reject("pid is NaN?: " + stdout);
        if (depth > 0) {
          this.drillDown(pid, depth - 1)
            .then((res) => resolve(res))
            .catch((err) => reject(err));
        } else {
          resolve(pid);
        }
      });
    });
  }

  resumeProcess(image, status) {
    console.log("resuming process", image);

    this.process = pty.spawn(
      "criu",
      [
        "restore",
        "--images-dir",
        image,
        "-vvvvv",
        "-o",
        "/tmp/restore.log",
        "--shell-job",
      ],
      {
        cwd: this.cwd,
      }
    );
    this.status = "STARTING";
    this.emit("starting");
    let hasRestored = false;
    const handler = async (data) => {
      console.log("HANDLER!", data, status);
      if (status == "ONLINE") {
        console.log("Assuming that CRIU restored, we got terminal data!", data);
        this.status = "ONLINE";
        this.emit("online");
      }
      if (!hasRestored) {
        console.log(data);
        hasRestored = true;
      }
    };
    this.once("online", async () => {
      // We can really do some dangerous stuff if this dangles! Disk IO!!!
      try {
        await fs.remove(this.imageHolder);
      } catch (err) {
        if (err.code != "ENOENT") throw err;
      }
    });

    this.process.once("exit", async (code) => {
      this.tail.removeListener("line", handler);
      hasRestored = true;
      this.pid = null;
      this.process = null;
      if (code != 0 && this.status == "STARTING") {
        console.log("Not relaying, giving up and starting fresh process", code);
        try {
          await fs.remove(this.imageHolder);
        } catch (err) {
          if (err.code != "ENOENT") throw err;
        }
        this.status = "OFFLINE";
        this.startup();
      } else {
        this.emit("exit", code);
      }
    });
    this.tail.once("line", handler);
  }

  async currentImageDir() {
    try {
      const currentData = await fs.readFile(
        path.join(this.imageHolder, "current"),
        "utf8"
      );
      const data = JSON.parse(currentData);
      this.pid = data.pid;
      return {
        imagePath: path.join(this.imageHolder, data.id),
        ...data,
      };
    } catch (err) {
      if (err.code == "ENOENT") {
        try {
          await fs.mkdir(path.join(this.imageHolder));
        } catch (err) {
          if (err.code != "EEXIST") {
            throw err;
          }
        }
        return null;
      } else {
        throw err;
      }
    }
  }

  async hibernateProcess(oldStatus) {
    const previous = await this.currentImageDir();
    const current = Date.now().toString();

    const currentDir = path.join(this.imageHolder, current);
    await fs.mkdir(currentDir);
    console.log("Hibernate!");

    console.log("Dumping from", this.pid);

    // We want the PID from the process's point of view...
    const pid = previous ? previous.pid : this.pid;

    const args = [
      "dump",
      "--tree",
      pid,
      "--images-dir",
      currentDir,
      "--shell-job",
      "--ext-unix-sk",
      "-vvvvv",
      "-o",
      "/tmp/dump.log",
    ];

    const execName = "criu";

    const proc = child_process.execFile(execName, args, {
      cwd: this.cwd,
      env: Object.assign({}, process.env, {
        REAL_PID: previous ? this.pid : "",
        NAMESPACE_PID: pid,
      }),
    });

    this._teardown = new Promise((resolve) => {
      proc.on("exit", async (code) => {
        if (code == 0) {
          console.log(
            "Dumped data to disk, writing current and unlinking previous"
          );
          await fs.writeFile(
            path.join(this.imageHolder, "current"),
            JSON.stringify(
              {
                id: current,
                pid,
                status: oldStatus,
              },
              null,
              2
            ),
            "utf8"
          );
          if (previous) {
            try {
              await fs.remove(previous.imagePath);
            } catch (err) {
              if (err.code != "ENOENT") throw err;
            }
          }
        } else {
          console.log("Non-zero exit code on dump, killing via SIGINT", code);
          process.kill(pid, "SIGINT");
        }
        // No worries about rejecting.. it's just to see if anything happened
        resolve();
      });
    });

    proc.stderr.pipe(process.stderr);
    proc.stdout.pipe(process.stdout);
    process.stdin.pipe(proc.stdin);
  }

  startProcess() {
    const execute = this.suspendable ? pty.spawn : child_process.execFile;
    this.process = execute(this.executable, this.args, {
      cwd: this.cwd,
      encoding: "utf8",
      stdio: "pipe",
      killSignal: "SIGINT",
      shell: "/bin/bash",
    });
    // Real PID, no NS
    this.pid = this.process.pid;
    this.status = "STARTING";
    this.emit("starting");
    console.log("Starting server");
    this.process.on("exit", (code) => this.emit("exit", code));
  }

  processData(msg) {
    this.emit("consoleData", msg);
    if (msg.match(/Done \(\d+\.\d+s\)! For help, type "help"/)) {
      console.log("Server is ready... Waiting for the server to tick a bit");
      this.status = "ONLINE";
      setTimeout(() => {
        console.log("Started server");
        this.emit("online");
      }, this.statupDelay);
    }
  }

  createProxy(client) {
    let tagHost = "";
    if (this.ipForwarding) {
      tagHost += `\0${client.socket.remoteAddress}\0${client.uuid.replace(
        /-/g,
        ""
      )}`;
      console.log(client.serverHost.split("\0"));
      if (client.profile) {
        const tags = client.serverHost.split("\0");
        console.log(client.profile.properties);
        // https://github.com/PaperMC/Waterfall/blob/fda6406e25499a620a502cb6f304708b26cf495b/BungeeCord-Patches/0012-Add-support-for-FML-with-IP-Forwarding-enabled.patch
        if (tags.includes("FML")) {
          console.log(client.serverHost);
          client.profile.properties.push(
            {
              name: "forgeClient",
              value: "true",
            },
            {
              name: "extraData",
              // \1, but zeit pkg's thing thinks this is an octal literal?
              value: "\u0001" + tags.slice(1).join("\u0001"),
              signature: "",
            }
          );
        }
        tagHost += "\0" + JSON.stringify(client.profile.properties);
        console.log("TAG!", tagHost, client.profile.properties);
      }
    }

    const proxy = NMP.createClient({
      host: this.address,
      port: this.port,
      username: client.username,
      // version: client.server.version,
      version: false,
      // https://github.com/SpigotMC/BungeeCord/blob/f1c32f84f46589632d7721d8de87d5589ef8e6a6/proxy/src/main/java/net/md_5/bungee/ServerConnector.java#L103
      tagHost,
    });
    proxy.on("error", (err) => {
      console.error("Error in proxy:", err);
      proxy.end(err.message);
    });

    console.log(
      JSON.stringify(client.serverHost),
      client.serverHost.includes("\0FML\0")
    );

    if (client.serverHost.includes("\0FML\0")) {
      console.log("Forge auto versioning!");
      if (!proxy.autoVersionHooks) proxy.autoVersionHooks = [];
      proxy.autoVersionHooks.push((response, client, options) => {
        console.log(options, response);
      });
      console.log("Forge auto versioning2");
      autoVersionForge(proxy);
      proxy.tagHost = tagHost;
      console.log(proxy.tagHost);
      proxy.autoVersionHooks.push((response, client, options) => {
        console.log(client, options, response);
      });
    } else {
      proxy.tagHost = tagHost;
    }

    client.once("end", (reason) => proxy.end(reason));
    // TODO: send users back to a lobby?
    proxy.once("end", (reason) => {
      if (this.status == "ONLINE") {
        client.end(reason);
      }
      client.removeListener("packet", proxyFromClient);
      proxy.removeAllListeners();
    });

    console.log("Packet from poxy?");
    proxy.on("packet", (data, metadata) => {
      if (metadata.name == "login" || metadata.state != "play") {
        return;
      }

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
      if (
        metadata.name == "keep_alive" ||
        metadata.state != "play" ||
        proxy.state != "play" ||
        (metadata.name == "custom_payload" &&
          data.channel == "chunkpregenerator")
      ) {
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
          tag.entries = tag.entries.filter((val) => val);
          if (!tag.entries.length) {
            console.warn("Tag has no entries. Dropping");
            data.entityTags[tagIndex] = null;
          }
        }
      }
      if (toServer) {
        data.entityTags = data.entityTags.filter((tag) => tag);
        if (!data.entityTags.length) {
          return null;
        }
      }
    } else if (metadata.name == "entity_metadata") {
      const targetEntity = this.entities.fromProxyId(data.entityId, true);
      data.entityId = targetEntity.id;
      if (targetEntity.type == this.entityTypes.firework_rocket) {
        for (const entityMetadata of data.metadata) {
          // Entity ID of entity which used firework (for elytra boosting)
          if (entityMetadata.key == 8 && entityMetadata.type == 17) {
            if (entityMetadata.value !== 0) {
              entityMetadata.value =
                this.entities.fromProxyId(entityMetadata.value - 1) + 1;
            }
          }
        }
      }
    } else if (metadata.name == "spawn_entity") {
      data.entityId = this.entities.fromProxyId(data.entityId, false, {
        type: data.type,
      });
      // Owner of the fishing float
      if (
        data.type == this.entityTypes.fishing_float ||
        data.type == this.entityTypes.fireball ||
        data.type == this.entityTypes.small_fireball ||
        data.type == this.entityTypes.dragon_fireball ||
        data.type == this.entityTypes.wither_skull
      ) {
        data.objectData = this.entities.fromProxyId(data.objectData);
      } else if (
        data.type == this.entityTypes.arrow ||
        data.type == this.entityTypes.spectral_arrow
      ) {
        data.objectData = this.entities.fromProxyId(data.objectData - 1) + 1;
      }
    } else {
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
            data[id] = data[id].filter((val) => val);
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
}

module.exports = Manager;
