/*!
 * Copyright (c) 2014-2015, Fedor Indutny
 * Copyright (c) 2014-2017, Christopher Jeffrey
 * Copyright (c) 2017, Park Alter (pseudonym)
 * Distributed under the MIT software license, see the accompanying
 * file COPYING or http://www.opensource.org/licenses/mit-license.php
 *
 * https://github.com/park-alter/wmcc-core
 * ldb.js - database backend for wmcc_core.
 */

'use strict';

const assert = require('assert');
const LowlevelUp = require('./lowlevelup');
const backends = require('./backends');

/**
 * Create a database.
 * @alias module:db.LDB
 * @param {Object} options
 * @returns {LowlevelUp}
 */

function LDB(options) {
  const result = LDB.getBackend(options);
  const backend = result.backend;
  const location = result.location;

  return new LowlevelUp(backend, location, options);
}

/**
 * Get database name and extension based on options.
 * @param {String} db
 * @returns {Object}
 */

LDB.getName = function getName(db) {
  let name, ext;

  if (!db)
    db = 'memory';

  switch (db) {
    case 'ldb':
    case 'leveldb':
    case 'leveldown':
      name = 'leveldown';
      ext = 'ldb';
      break;
    case 'rdb':
    case 'rocksdb':
    case 'rocksdown':
      name = 'rocksdown';
      ext = 'rdb';
      break;
    case 'mdb':
    case 'lmdb':
      name = 'lmdb';
      ext = 'mdb';
      break;
    case 'mem':
    case 'memory':
    case 'rbt':
      name = 'memory';
      ext = 'mem';
      break;
    default:
      name = db;
      ext = 'db';
      break;
  }

  return [name, ext];
};

/**
 * Get target backend and location.
 * @param {Object} options
 * @returns {Object}
 */

LDB.getBackend = function getBackend(options) {
  const [name, ext] = LDB.getName(options.db);
  const backend = backends.get(name);
  let location = options.location;

  if (typeof location !== 'string') {
    assert(name === 'memory', 'Location required.');
    location = 'memory';
  }

  return {
    backend: backend,
    location: `${location}.${ext}`
  };
};

/*
 * Expose
 */

module.exports = LDB;
