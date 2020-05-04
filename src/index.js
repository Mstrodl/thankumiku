const NMP = require("minecraft-protocol");
const config = require("./config");
const Manager = require("./Manager");
const fs = require("fs");

for (const serverConfig of config.servers) {
  const startTime = Date.now();

  let favicon = undefined;
  try {
    favicon =
      "data:image/png;base64," +
      fs.readFileSync(
        serverConfig.backend.process.cwd + "/server-icon.png",
        "base64"
      );
  } catch (err) {
    if (err.code != "ENOENT") throw err;
  }

  const server = NMP.createServer({
    motd: serverConfig.proxy.motd,
    maxPlayers: serverConfig.proxy.maxPlayers,
    port: serverConfig.proxy.port,
    "online-mode": serverConfig.proxy.onlineMode,
    version: serverConfig.proxy.version,
    favicon,
    beforePing: (response, client) => {
      console.log(response);
      response.modinfo = {
        type: "FML",
        modList: [
          {
            modid: "mcp",
            version: "9.42",
          },
          {
            modid: "FML",
            version: "8.0.99.99",
          },
          {
            modid: "Forge",
            version: "14.23.5.2847",
          },
          {
            modid: "Advanced Rocketry Core",
            version: "1",
          },
        ],
      };
      return response;
    },
  });
  const manager = new Manager(serverConfig.backend);

  const chunks = {};
  const chunkList = serverConfig.proxy.lobbyChunks
    ? fs.readdirSync(serverConfig.proxy.lobbyChunks)
    : [];
  for (const chunk of chunkList) {
    if (!chunk.endsWith(".bin")) {
      continue;
    }
    const seperator = chunk.indexOf("_");
    if (seperator == -1) {
      throw new Error(`Invalid chunk filename, no seperator: ${chunk}`);
    }
    const x = parseInt(chunk.substring(0, seperator));
    const z = parseInt(chunk.substring(seperator + 1, chunk.length - 4));
    const chunkData = fs.readFileSync(
      serverConfig.proxy.lobbyChunks + "/" + chunk
    );
    if (chunks[x]) {
      chunks[x][z] = chunkData;
    } else {
      chunks[x] = {
        [z]: chunkData,
      };
    }
  }
  console.log("Loaded chunks into memory.. Now for pterodactyl");

  console.log(
    `[${new Date().toString().slice(16, 24)} INFO\]: Done \(${
      Math.round((Date.now() - startTime) / 10) / 100
    }s\)! For help, type "help"`
  );

  server.on("connection", (client) => {
    client.server = server;
    console.log("Server got a connection");
  });

  function hotLobby(client) {
    const data = {
      dimension: -1,
      difficulty: 0,
      gamemode: 0,
      levelType: "normal",
    };
    if (client.version == "1.12.2") {
      data.difficulty = 0;
    } else {
      data.hashedSeed = [0, 0];
    }
    client.write("respawn", data);
    data.dimension = 0;
    client.write("respawn", data);
  }

  function createLobby(client) {
    const values = [];
    const blockingData = "000000011".repeat(256);
    for (let i = 0; i < 72; i += 2) {
      // 0, 32, 64, 96
      values.push([
        parseInt(
          (blockingData[i * 32] == "1" ? -1 : 1) *
            blockingData.slice(i * 32 + 1, (i + 1) * 32),
          2
        ),
        parseInt(
          (blockingData[(i + 1) * 32] == "1" ? -1 : 1) *
            blockingData.slice((i + 1) * 32 + 1, (i + 2) * 32),
          2
        ),
      ]);
    }

    const chunkData = {
      x: 0,
      z: 0,
      groundUp: false,
      bitMap: 0xffff,

      chunkData: chunks[0][0],
      blockEntities: [],
    };
    if (serverConfig.proxy.version != "1.12.2") {
      chunkData.heightmaps = {
        name: "",
        type: "compound",
        value: {
          MOTION_BLOCKING: {
            type: "longArray",
            value: values,
          },
        },
      };
    }
    client.write("map_chunk", chunkData);

    const positionData = {
      x: 15,
      y: 4,
      z: 15,
      yaw: 137,
      pitch: 0,
      flags: 0x00,
    };
    if (serverConfig.proxy.version != "1.12.2") {
      positionData.onGround = true;
    }
    client.write("position", positionData);

    if (serverConfig.proxy.version != "1.12.2") {
      client.write("update_view_position", {
        chunkX: 0,
        chunkZ: 0,
      });
    }

    const chatData = {
      message: JSON.stringify({
        translate: "chat.type.text",
        with: [
          "Server",
          "The server isn't ready, please wait in this endless void...",
        ],
      }),
    };
    if (serverConfig.proxy.version == "1.12.2") {
      chatData.position = 0;
    }
    client.write("chat", chatData);
  }

  manager.on("online", () => {
    for (const clientId in server.clients) {
      const client = server.clients[clientId];
      if (client.username) {
        const proxy = manager.createProxy(client);
        proxy.once("login", (data) => {
          if (client.settings) {
            proxy.write("settings", client.settings);
          }
          manager.entities.associate(data.entityId, client.entityId);

          const respawnData = {
            dimension: -1,
            gamemode: data.gameMode,
            levelType: data.levelType,
            hashedSeed: data.hashedSeed,
          };

          if (client.version == "1.12.2") {
            respawnData.difficulty = 0;
          } else {
            respawnData.hashedSeed = data.hashedSeed;
          }

          client.write("respawn", respawnData);
          respawnData.dimension = data.dimension;
          client.write("respawn", respawnData);
        });
      }
    }
  });
  manager.on("consoleData", (data) => {
    if (manager.status == "STARTING") {
      const frame = {
        message: JSON.stringify({
          translate: "chat.type.text",
          with: ["Server", data.toString("utf8").trim()],
        }),
      };
      for (const clientId in server.clients) {
        const client = server.clients[clientId];
        if (client.username) {
          client.write("chat", frame);
        }
      }
    }
  });
  manager.on("offline", () => {
    for (const clientId in server.clients) {
      const client = server.clients[clientId];
      if (client.username) {
        hotLobby(client);
        createLobby(client);
      }
    }
  });

  server.on("login", (client) => {
    console.log(
      `New login from ${client.uuid}. Manager is currently ${manager.status}`
    );
    if (serverConfig.whitelist && !serverConfig.whitelist[client.uuid]) {
      client.end("You are not whitelisted");
      console.log(`Kicked ${client.uuid} for not being in whitelist`);
      return;
    }

    client.on("settings", (settings) => {
      client.settings = settings;
    });

    manager.unqueueShutdown();

    if (manager.status == "OFFLINE") {
      console.log("Manager says we're offline, spinning it up!");
      manager.startup();
    }

    const entityId = manager.entities.id();
    client.entityId = entityId;

    if (manager.status != "ONLINE") {
      console.log("Manager isn't ready yet, bringing up the lobby");

      if (serverConfig.proxy.version != "1.12.2") {
        const data = {
          entityId,
          levelType: "default",
          gameMode: 2,
          dimension: 0,
          viewDistance: 10,
          maxPlayers: server.maxPlayers,
          reducedDebugInfo: false,
          enableRespawnScreen: true,
          hashedSeed: [0, 0],
        };

        console.log("Lobby login", data);

        client.write("login", data);
      } else {
        client.write("login", {
          entityId,
          levelType: "default",
          gameMode: 2,
          dimension: 0,
          difficulty: 0,
          maxPlayers: server.maxPlayers,
          reducedDebugInfo: false,
        });
      }

      createLobby(client);
    } else {
      const proxy = manager.createProxy(client);
      proxy.once("login", (data) => {
        manager.entities.associate(data.entityId, client.entityId);
        console.log("Login packet...", data);
        client.write(
          "login",
          Object.assign({}, data, {
            entityId,
            reducedDebugInfo: false,
          })
        );
      });
    }

    client.on("end", (reason) => {
      if (server.playerCount == 0) {
        console.log("No more players left... Starting a shutdown request");
        manager.queueShutdown();
      }

      console.log("End...", reason);
    });
    client.on("error", (err) => {
      console.error("Error in client:", err);
      client.end(err.message);
    });
  });
}
