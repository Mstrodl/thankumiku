module.exports = {
  servers: [
    {
      proxy: {
        motd: "Kyle",
        maxPlayers: 20,
        port: 25500,
        onlineMode: false,
        version: "1.15.1",
        lobbyChunks: __dirname + "/../data/chunks"
      },
      backend: {
        port: 25565,
        address: "127.0.0.1",
        process: {
          cwd: "/home/mary/projects/minecraft",
          executable: "/usr/bin/java",
          args: ["-jar", "paper-62.jar"]
        }
      }
    }
  ]
};
