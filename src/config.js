const fs = require("fs");

module.exports = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
