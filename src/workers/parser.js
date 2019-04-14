/*!
 * Copyright (c) 2014-2015, Fedor Indutny
 * Copyright (c) 2014-2017, Christopher Jeffrey
 * Copyright (c) 2017, Park Alter (pseudonym)
 * Distributed under the MIT software license, see the accompanying
 * file COPYING or http://www.opensource.org/licenses/mit-license.php
 *
 * https://github.com/park-alter/wmcc-core
 * workers.js - worker processes for wmcc_core.
 */

'use strict';

const assert = require('assert');
const EventEmitter = require('events');
const packets = require('./packets');

/**
 * Parser
 * @alias module:workers.Parser
 * @constructor
 */

function Parser() {
  if (!(this instanceof Parser))
    return new Parser();

  EventEmitter.call(this);

  this.waiting = 9;
  this.header = null;
  this.pending = [];
  this.total = 0;
}

Object.setPrototypeOf(Parser.prototype, EventEmitter.prototype);

Parser.prototype.feed = function feed(data) {
  this.total += data.length;
  this.pending.push(data);

  while (this.total >= this.waiting) {
    const chunk = this.read(this.waiting);
    this.parse(chunk);
  }
};

Parser.prototype.read = function read(size) {
  assert(this.total >= size, 'Reading too much.');

  if (size === 0)
    return Buffer.alloc(0);

  const pending = this.pending[0];

  if (pending.length > size) {
    const chunk = pending.slice(0, size);
    this.pending[0] = pending.slice(size);
    this.total -= chunk.length;
    return chunk;
  }

  if (pending.length === size) {
    const chunk = this.pending.shift();
    this.total -= chunk.length;
    return chunk;
  }

  const chunk = Buffer.allocUnsafe(size);
  let off = 0;

  while (off < chunk.length) {
    const pending = this.pending[0];
    const len = pending.copy(chunk, off);
    if (len === pending.length)
      this.pending.shift();
    else
      this.pending[0] = pending.slice(len);
    off += len;
  }

  assert.strictEqual(off, chunk.length);

  this.total -= chunk.length;

  return chunk;
};

Parser.prototype.parse = function parse(data) {
  let header = this.header;

  if (!header) {
    try {
      header = this.parseHeader(data);
    } catch (e) {
      this.emit('error', e);
      return;
    }

    this.header = header;
    this.waiting = header.size + 1;

    return;
  }

  this.waiting = 9;
  this.header = null;

  let packet;
  try {
    packet = this.parsePacket(header, data);
  } catch (e) {
    this.emit('error', e);
    return;
  }

  if (data[data.length - 1] !== 0x0a) {
    this.emit('error', new Error('No trailing newline.'));
    return;
  }

  packet.id = header.id;

  this.emit('packet', packet);
};

Parser.prototype.parseHeader = function parseHeader(data) {
  const id = data.readUInt32LE(0, true);
  const cmd = data.readUInt8(4, true);
  const size = data.readUInt32LE(5, true);
  return new Header(id, cmd, size);
};

Parser.prototype.parsePacket = function parsePacket(header, data) {
  switch (header.cmd) {
    case packets.types.ENV:
      return packets.EnvPacket.fromRaw(data);
    case packets.types.EVENT:
      return packets.EventPacket.fromRaw(data);
    case packets.types.LOG:
      return packets.LogPacket.fromRaw(data);
    case packets.types.ERROR:
      return packets.ErrorPacket.fromRaw(data);
    case packets.types.ERRORRESULT:
      return packets.ErrorResultPacket.fromRaw(data);
    case packets.types.CHECK:
      return packets.CheckPacket.fromRaw(data);
    case packets.types.CHECKRESULT:
      return packets.CheckResultPacket.fromRaw(data);
    case packets.types.SIGN:
      return packets.SignPacket.fromRaw(data);
    case packets.types.SIGNRESULT:
      return packets.SignResultPacket.fromRaw(data);
    case packets.types.CHECKINPUT:
      return packets.CheckInputPacket.fromRaw(data);
    case packets.types.CHECKINPUTRESULT:
      return packets.CheckInputResultPacket.fromRaw(data);
    case packets.types.SIGNINPUT:
      return packets.SignInputPacket.fromRaw(data);
    case packets.types.SIGNINPUTRESULT:
      return packets.SignInputResultPacket.fromRaw(data);
    case packets.types.ECVERIFY:
      return packets.ECVerifyPacket.fromRaw(data);
    case packets.types.ECVERIFYRESULT:
      return packets.ECVerifyResultPacket.fromRaw(data);
    case packets.types.ECSIGN:
      return packets.ECSignPacket.fromRaw(data);
    case packets.types.ECSIGNRESULT:
      return packets.ECSignResultPacket.fromRaw(data);
    case packets.types.MINE:
      return packets.MinePacket.fromRaw(data);
    case packets.types.MINERESULT:
      return packets.MineResultPacket.fromRaw(data);
    case packets.types.SCRYPT:
      return packets.ScryptPacket.fromRaw(data);
    case packets.types.SCRYPTRESULT:
      return packets.ScryptResultPacket.fromRaw(data);
    default:
      throw new Error('Unknown packet.');
  }
};

/**
 * Header
 * @constructor
 * @ignore
 */

function Header(id, cmd, size) {
  this.id = id;
  this.cmd = cmd;
  this.size = size;
}

/*
 * Expose
 */

module.exports = Parser;
