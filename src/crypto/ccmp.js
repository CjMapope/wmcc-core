/*!
 * Copyright (c) 2016-2017, Christopher Jeffrey
 * Copyright (c) 2017, Park Alter (pseudonym)
 * Distributed under the MIT software license, see the accompanying
 * file COPYING or http://www.opensource.org/licenses/mit-license.php
 *
 * https://github.com/park-alter/wmcc-core
 * ccmp.js - constant-time compare for wmcc_core.
 */

'use strict';

const assert = require('assert');

/**
 * memcmp in constant time (can only return true or false).
 * This protects us against timing attacks when
 * comparing an input against a secret string.
 * @alias module:crypto.ccmp
 * @see https://cryptocoding.net/index.php/Coding_rules
 * @see `$ man 3 memcmp` (NetBSD's consttime_memequal)
 * @param {Buffer} a
 * @param {Buffer} b
 * @returns {Boolean}
 */

module.exports = function ccmp(a, b) {
  assert(Buffer.isBuffer(a));
  assert(Buffer.isBuffer(b));

  if (b.length === 0)
    return a.length === 0;

  let res = a.length ^ b.length;

  for (let i = 0; i < a.length; i++)
    res |= a[i] ^ b[i % b.length];

  return res === 0;
};
