'use strict';
// Vercel invokes the shared gateway for each request; importing it never listens.
module.exports = require('../server').requestHandler;
