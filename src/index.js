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
    if (manager.status == "OFFLINE" && !serverConfig.whitelist) {
      console.log(
        "Got a connection, but we're offline... spinning up the server early"
      );
      manager.startup();
    }
  });

  function hotLobby(client) {
    client.write("respawn", {
      dimension: 1 - Math.pow(2, 31),
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
        name: "heightmaps",
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
      y: 101,
      z: 15,
      yaw: 137,
      pitch: 0,
      flags: 0x00
    });
  }

  manager.on("online", () => {
    for (const clientId in server.clients) {
      const client = server.clients[clientId];
      const proxy = manager.createProxy(client);
      proxy.once("login", data => {
        manager.entities.associate(data.entityId, client.entityId);
        client.write("respawn", {
          dimension: data.dimension,
          gamemode: data.gameMode,
          levelType: data.levelType,
          hashedSeed: data.hashedSeed
        });
      });
    }
  });

  server.on("login", client => {
    console.log(
      `New login from ${client.uuid}. Manager is currently ${manager.status}`
    );
    if (serverConfig.whitelist) {
      if (!serverConfig.whitelist[client.uuid]) {
        client.end("You are not whitelisted");
        console.log(`Kicked ${client.uuid} for not being in whitelist`);
        return;
      }

      if (manager.status == "OFFLINE") {
        console.log("Manager says we're offline, spinning it up!");
        manager.startup();
      }
    }

    const entityId = manager.entities.id();
    client.entityId = entityId;

    if (manager.status != "ONLINE") {
      console.log("Manager isn't ready yet, bringing up the lobby");

      client.write("login", {
        entityId,
        levelType: "default",
        gameMode: 2,
        dimension: 0,
        difficulty: 2,
        maxPlayers: server.maxPlayers,
        reducedDebugInfo: false,
        enableRespawnScreen: true,
        hashedSeed: [0, 0]
      });

      createLobby(client);
    } else {
      const proxy = manager.createProxy(client);
      proxy.once("login", data => {
        manager.entities.associate(data.entityId, client.entityId);
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
      console.log("End...", reason);
    });
  });
}
