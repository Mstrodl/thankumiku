const NMP = require("minecraft-protocol");
const config = require("./config");
const Manager = require("./Manager");
const fs = require("fs");

for (const serverConfig of config.servers) {
  const server = NMP.createServer({
    motd: serverConfig.proxy.motd,
    maxPlayers: serverConfig.proxy.maxPlayers,
    port: serverConfig.proxy.port,
    "online-mode": serverConfig.proxy.onlineMode,
    version: serverConfig.proxy.version
  });
  const manager = new Manager(serverConfig.backend);

  const chunks = {};
  const chunkList = fs.readdirSync(serverConfig.proxy.lobbyChunks);
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
        [z]: chunkData
      };
    }
  }
  console.log("Loaded chunks into memory");

  server.on("connection", client => {
    client.server = server;
    console.log("Server got a connection");
  });

  function hotLobby(client) {
    client.write("respawn", {
      dimension: -1,
      gamemode: 0,
      levelType: "normal",
      hashedSeed: [0, 0]
    });

    client.write("respawn", {
      dimension: 0,
      hashedSeed: [0, 0],
      gameMode: 2,
      levelType: "normal"
    });
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
        )
      ]);
    }

    client.write("map_chunk", {
      x: 0,
      z: 0,
      groundUp: false,
      bitMap: 0xffff,
      heightmaps: {
        name: "",
        type: "compound",
        value: {
          MOTION_BLOCKING: {
            type: "longArray",
            value: values
          }
        }
      },
      chunkData: chunks[0][0],
      blockEntities: []
    });

    client.write("position", {
      x: 15,
      y: 4,
      z: 15,
      yaw: 137,
      pitch: 0,
      onGround: true,
      flags: 0x00
    });

    client.write("update_view_position", {
      chunkX: 0,
      chunkZ: 0
    });
  }

  manager.on("online", () => {
    for (const clientId in server.clients) {
      const client = server.clients[clientId];
      if (client.username) {
        const proxy = manager.createProxy(client);
        proxy.once("login", data => {
          manager.entities.associate(data.entityId, client.entityId);
          client.write("respawn", {
            dimension: -1,
            gamemode: data.gameMode,
            levelType: data.levelType,
            hashedSeed: data.hashedSeed
          });
          client.write("respawn", {
            dimension: data.dimension,
            gamemode: data.gameMode,
            levelType: data.levelType,
            hashedSeed: data.hashedSeed
          });
        });
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

  server.on("login", client => {
    console.log(
      `New login from ${client.uuid}. Manager is currently ${manager.status}`
    );
    if (serverConfig.whitelist && !serverConfig.whitelist[client.uuid]) {
      client.end("You are not whitelisted");
      console.log(`Kicked ${client.uuid} for not being in whitelist`);
      return;
    }

    manager.unqueueShutdown();

    if (manager.status == "OFFLINE") {
      console.log("Manager says we're offline, spinning it up!");
      manager.startup();
    }

    const entityId = manager.entities.id();
    client.entityId = entityId;

    if (manager.status != "ONLINE") {
      console.log("Manager isn't ready yet, bringing up the lobby");

      const data = {
        entityId,
        levelType: "default",
        gameMode: 2,
        dimension: 0,
        viewDistance: 10,
        maxPlayers: server.maxPlayers,
        reducedDebugInfo: false,
        enableRespawnScreen: true,
        hashedSeed: [0, 0]
      };

      console.log("Lobby login", data);

      client.write("login", data);

      createLobby(client);
    } else {
      const proxy = manager.createProxy(client);
      proxy.once("login", data => {
        manager.entities.associate(data.entityId, client.entityId);
        console.log("Login packet...", data);
        client.write(
          "login",
          Object.assign({}, data, {
            entityId,
            reducedDebugInfo: false
          })
        );
      });
    }

    client.on("end", reason => {
      if (server.playerCount == 0) {
        console.log("No more players left... Starting a shutdown request");
        manager.queueShutdown();
      }

      console.log("End...", reason);
    });
  });
}
