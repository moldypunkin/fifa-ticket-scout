// Absolute path to extension/, derived from this file's location.
//
// The suite used to hardcode a full Windows path, which meant it only ran on
// the machine it was written on — the reason tests kept "disappearing" when
// working across two stations.
const path = require("path");
module.exports = path.resolve(__dirname, "..", "extension") + "/";
