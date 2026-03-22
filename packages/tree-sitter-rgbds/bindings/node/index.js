const path = require('path');
const binding = require('node-gyp-build')(path.join(__dirname, '..', '..'));

// Export as an object with a 'language' property —
// this is what tree-sitter 0.25's setLanguage expects
module.exports = binding;
