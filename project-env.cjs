'use strict';

module.exports = function projectEnv(name) {
  return process.env[`TERMXXLE_${name}`]
    ?? process.env[`MUXXLE_CONSOLE_${name}`]
    ?? process.env[`NEXTERM_${name}`];
};
