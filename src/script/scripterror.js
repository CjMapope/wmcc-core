/*!
 * Copyright (c) 2014-2017, Christopher Jeffrey
 * Copyright (c) 2017, Park Alter (pseudonym)
 * Distributed under the MIT software license, see the accompanying
 * file COPYING or http://www.opensource.org/licenses/mit-license.php
 *
 * https://github.com/park-alter/wmcc-core
 * scripterror.js - script error for wmcc_core.
 */

'use strict';

/**
 * An error thrown from the scripting system,
 * potentially pertaining to Script execution.
 * @alias module:script.ScriptError
 * @constructor
 * @extends Error
 * @param {String} code - Error code.
 * @param {Opcode} op - Opcode.
 * @param {Number?} ip - Instruction pointer.
 * @property {String} message - Error message.
 * @property {String} code - Original code passed in.
 * @property {Number} op - Opcode.
 * @property {Number} ip - Instruction pointer.
 */

function ScriptError(code, op, ip) {
  if (!(this instanceof ScriptError))
    return new ScriptError(code, op, ip);

  Error.call(this);

  this.type = 'ScriptError';
  this.code = code;
  this.message = code;
  this.op = -1;
  this.ip = -1;

  if (typeof op === 'string') {
    this.message = op;
  } else if (op) {
    this.message = `${code} (op=${op.toSymbol()}, ip=${ip})`;
    this.op = op.value;
    this.ip = ip;
  }

  if (Error.captureStackTrace)
    Error.captureStackTrace(this, ScriptError);
};

Object.setPrototypeOf(ScriptError.prototype, Error.prototype);

module.exports = ScriptError;
