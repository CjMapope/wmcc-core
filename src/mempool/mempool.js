/*!
 * Copyright (c) 2014-2017, Christopher Jeffrey
 * Copyright (c) 2017, Park Alter (pseudonym)
 * Distributed under the MIT software license, see the accompanying
 * file COPYING or http://www.opensource.org/licenses/mit-license.php
 *
 * https://github.com/park-alter/wmcc-core
 * mempool.js - mempool for wmcc_core.
 */

'use strict';

const assert = require('assert');
const path = require('path');
const AsyncObject = require('../utils/asyncobject');
const common = require('../blockchain/common');
const consensus = require('../protocol/consensus');
const policy = require('../protocol/policy');
const util = require('../utils/util');
const random = require('../crypto/random');
const {VerifyError} = require('../protocol/errors');
const RollingFilter = require('../utils/rollingfilter');
const Address = require('../primitives/address');
const Script = require('../script/script');
const Outpoint = require('../primitives/outpoint');
const TX = require('../primitives/tx');
const Coin = require('../primitives/coin');
const TXMeta = require('../primitives/txmeta');
const MempoolEntry = require('./mempoolentry');
const Network = require('../protocol/network');
const encoding = require('../utils/encoding');
const layout = require('./layout');
const LDB = require('../db/ldb');
const Fees = require('./fees');
const CoinView = require('../coins/coinview');
//const Coins = require('../coins/coins');
const Heap = require('../utils/heap');

/**
 * Represents a mempool.
 * @alias module:mempool.Mempool
 * @constructor
 * @param {Object} options
 * @param {String?} options.name - Database name.
 * @param {String?} options.location - Database file location.
 * @param {String?} options.db - Database backend (`"memory"` by default).
 * @param {Boolean?} options.limitFree
 * @param {Number?} options.limitFreeRelay
 * @param {Number?} options.maxSize - Max pool size (default ~300mb).
 * @param {Boolean?} options.relayPriority
 * @param {Boolean?} options.requireStandard
 * @param {Boolean?} options.rejectAbsurdFees
 * @param {Boolean?} options.relay
 * @property {Boolean} loaded
 * @property {Object} db
 * @property {Number} size
 * @property {Lock} locker
 * @property {Number} freeCount
 * @property {Number} lastTime
 * @property {Number} maxSize
 * @property {Rate} minRelayFee
 * @emits Mempool#open
 * @emits Mempool#error
 * @emits Mempool#tx
 * @emits Mempool#add tx
 * @emits Mempool#remove tx
 */

function Mempool(options) {
  if (!(this instanceof Mempool))
    return new Mempool(options);

  AsyncObject.call(this);

  this.options = new MempoolOptions(options);

  this.network = this.options.network;
  this.logger = this.options.logger.context('mempool');
  this.workers = this.options.workers;
  this.chain = this.options.chain;
  this.fees = this.options.fees;

  this.locker = this.chain.locker;

  this.cache = new MempoolCache(this.options);

  this.size = 0;
  this.freeCount = 0;
  this.lastTime = 0;
  this.lastFlush = 0;
  this.tip = this.network.genesis.hash;

  this.waiting = new Map();
  this.orphans = new Map();
  this.map = new Map();
  this.spents = new Map();
  this.rejects = new RollingFilter(120000, 0.000001);

  this.coinIndex = new CoinIndex();
  this.txIndex = new TXIndex();
}

Object.setPrototypeOf(Mempool.prototype, AsyncObject.prototype);

/**
 * Open the chain, wait for the database to load.
 * @method
 * @alias Mempool#open
 * @returns {Promise}
 */

Mempool.prototype._open = async function _open() {
  await this.chain.open();
  await this.cache.open();

  if (this.options.persistent) {
    const entries = await this.cache.getEntries();

    for (const entry of entries)
      this.trackEntry(entry);

    for (const entry of entries) {
      this.updateAncestors(entry, addFee);

      if (this.options.indexAddress) {
        const view = await this.getCoinView(entry.tx);
        this.indexEntry(entry, view);
      }
    }

    this.logger.info(
      'Loaded mempool from disk (%d entries).',
      entries.length);

    if (this.fees) {
      const fees = await this.cache.getFees();

      if (fees) {
        this.fees.inject(fees);
        this.logger.info(
          'Loaded mempool fee data (rate=%d).',
          this.fees.estimateFee());
      }
    }
  }

  this.tip = this.chain.tip.hash;

  const size = (this.options.maxSize / 1024).toFixed(2);

  this.logger.info('Mempool loaded (maxsize=%dkb).', size);
};

/**
 * Close the chain, wait for the database to close.
 * @alias Mempool#close
 * @returns {Promise}
 */

Mempool.prototype._close = async function _close() {
  await this.cache.close();
};

/**
 * Notify the mempool that a new block has come
 * in (removes all transactions contained in the
 * block from the mempool).
 * @method
 * @param {ChainEntry} block
 * @param {TX[]} txs
 * @returns {Promise}
 */

Mempool.prototype.addBlock = async function addBlock(block, txs) {
  const unlock = await this.locker.lock();
  try {
    return await this._addBlock(block, txs);
  } finally {
    unlock();
  }
};

/**
 * Notify the mempool that a new block
 * has come without a lock.
 * @private
 * @param {ChainEntry} block
 * @param {TX[]} txs
 * @returns {Promise}
 */

Mempool.prototype._addBlock = async function _addBlock(block, txs) {
  if (this.map.size === 0) {
    this.tip = block.hash;
    return;
  }

  const entries = [];

  for (let i = txs.length - 1; i >= 1; i--) {
    const tx = txs[i];
    const hash = tx.hash('hex');
    const entry = this.getEntry(hash);

    if (!entry) {
      this.removeOrphan(hash);
      //this.resolveOrphans(tx);
      this.removeDoubleSpends(tx);
      if (this.waiting.has(hash))
        await this.handleOrphans(tx);
      continue;
    }

    this.removeEntry(entry);

    this.emit('confirmed', tx, block);

    entries.push(entry);
  }

  // We need to reset the rejects filter periodically.
  // There may be a locktime in a TX that is now valid.
  this.rejects.reset();

  if (this.fees) {
    this.fees.processBlock(block.height, entries, this.chain.synced);
    this.cache.writeFees(this.fees);
  }

  this.cache.sync(block.hash);

  await this.cache.flush();

  this.tip = block.hash;

  if (entries.length === 0)
    return;

  this.logger.debug(
    'Removed %d txs from mempool for block %d.',
    entries.length, block.height);
};

/**
 * Notify the mempool that a block has been disconnected
 * from the main chain (reinserts transactions into the mempool).
 * @method
 * @param {ChainEntry} block
 * @param {TX[]} txs
 * @returns {Promise}
 */

Mempool.prototype.removeBlock = async function removeBlock(block, txs) {
  const unlock = await this.locker.lock();
  try {
    return await this._removeBlock(block, txs);
  } finally {
    unlock();
  }
};

/**
 * Notify the mempool that a block
 * has been disconnected without a lock.
 * @method
 * @private
 * @param {ChainEntry} block
 * @param {TX[]} txs
 * @returns {Promise}
 */

Mempool.prototype._removeBlock = async function _removeBlock(block, txs) {
  if (this.map.size === 0) {
    this.tip = block.prevBlock;
    return;
  }

  let total = 0;

  for (let i = 1; i < txs.length; i++) {
    const tx = txs[i];
    const hash = tx.hash('hex');

    if (this.hasEntry(hash))
      continue;

    try {
      await this.insertTX(tx, -1);
      total++;
    } catch (e) {
      this.emit('error', e);
      continue;
    }

    this.emit('unconfirmed', tx, block);
  }

  this.rejects.reset();

  this.cache.sync(block.prevBlock);

  await this.cache.flush();

  this.tip = block.prevBlock;

  if (total === 0)
    return;

  this.logger.debug(
    'Added %d txs back into the mempool for block %d.',
    total, block.height);
};

/**
 * Sanitize the mempool after a reorg.
 * @private
 * @returns {Promise}
 */

Mempool.prototype._handleReorg = async function _handleReorg() {
  const height = this.chain.height + 1;
  const mtp = await this.chain.getMedianTime(this.chain.tip);
  const remove = [];

  for (const [hash, entry] of this.map) {
    const {tx} = entry;

    if (!tx.isFinal(height, mtp)) {
      remove.push(hash);
      continue;
    }

    if (tx.version > 1) {
      let hasLocks = false;

      for (const {sequence} of tx.inputs) {
        if (!(sequence & consensus.SEQUENCE_DISABLE_FLAG)) {
          hasLocks = true;
          break;
        }
      }

      if (hasLocks) {
        remove.push(hash);
        continue;
      }
    }

    if (entry.coinbase)
      remove.push(hash);
  }

  for (const hash of remove) {
    const entry = this.getEntry(hash);

    if (!entry)
      continue;

    this.evictEntry(entry);
  }
};

/**
 * Reset the mempool.
 * @method
 * @returns {Promise}
 */

Mempool.prototype.reset = async function reset() {
  const unlock = await this.locker.lock();
  try {
    return await this._reset();
  } finally {
    unlock();
  }
};

/**
 * Reset the mempool without a lock.
 * @private
 */

Mempool.prototype._reset = async function _reset() {
  this.logger.info('Mempool reset (%d txs removed).', this.map.size);

  this.size = 0;

  this.waiting.clear();
  this.orphans.clear();
  this.map.clear();
  this.spents.clear();
  this.coinIndex.reset();
  this.txIndex.reset();

  this.freeCount = 0;
  this.lastTime = 0;

  if (this.fees)
    this.fees.reset();

  this.rejects.reset();

  if (this.options.persistent) {
    await this.cache.wipe();
    this.cache.clear();
  }

  this.tip = this.chain.tip.hash;
};

/**
 * Ensure the size of the mempool stays below `maxSize`.
 * Evicts entries by timestamp and cumulative fee rate.
 * @param {MempoolEntry} added
 * @returns {Promise}
 */

Mempool.prototype.limitSize = function limitSize(added) {
  const maxSize = this.options.maxSize;

  if (this.size <= maxSize)
    return false;

  const threshold = maxSize - (maxSize / 10);
  const expiryTime = this.options.expiryTime;

  const now = util.now();
  let start = util.hrtime();
  const queue = new Heap(cmpRate);

  for (const entry of this.map.values()) {
    if (this.hasDepends(entry.tx))
      continue;

    if (now < entry.time + expiryTime) {
      queue.insert(entry);
      continue;
    }

    this.logger.debug(
      'Removing package %s from mempool (too old).',
      entry.txid());

    this.evictEntry(entry);
  }

  if (this.size <= threshold)
    return !this.hasEntry(added);

  this.logger.debug(
    '(bench) Heap mempool traversal: %d.',
    util.hrtime(start));

  start = util.hrtime();

  this.logger.debug(
    '(bench) Heap mempool queue size: %d.',
    queue.size());

  while (queue.size() > 0) {
    const entry = queue.shift();
    const hash = entry.hash('hex');

    assert(this.hasEntry(hash));

    this.logger.debug(
      'Removing package %s from mempool (low fee).',
      entry.txid());

    this.evictEntry(entry);

    if (this.size <= threshold)
      break;
  }

  this.logger.debug(
    '(bench) Heap mempool map removal: %d.',
    util.hrtime(start));

  return !this.hasEntry(added);
};

/**
 * Retrieve a transaction from the mempool.
 * @param {Hash} hash
 * @returns {TX}
 */

Mempool.prototype.getTX = function getTX(hash) {
  const entry = this.map.get(hash);

  if (!entry)
    return null;

  return entry.tx;
};

/**
 * Retrieve a transaction from the mempool.
 * @param {Hash} hash
 * @returns {MempoolEntry}
 */

Mempool.prototype.getEntry = function getEntry(hash) {
  return this.map.get(hash);
};

/**
 * Retrieve a coin from the mempool (unspents only).
 * @param {Hash} hash
 * @param {Number} index
 * @returns {Coin}
 */

Mempool.prototype.getCoin = function getCoin(hash, index) {
  const entry = this.map.get(hash);

  if (!entry)
    return null;

  if (this.isSpent(hash, index))
    return null;

  if (index >= entry.tx.outputs.length)
    return null;

  return Coin.fromTX(entry.tx, index, -1);
};

/**
 * Check to see if a coin has been spent. This differs from
 * {@link ChainDB#isSpent} in that it actually maintains a
 * map of spent coins, whereas ChainDB may return `true`
 * for transaction outputs that never existed.
 * @param {Hash} hash
 * @param {Number} index
 * @returns {Boolean}
 */

Mempool.prototype.isSpent = function isSpent(hash, index) {
  const key = Outpoint.toKey(hash, index);
  return this.spents.has(key);
};

/**
 * Get an output's spender entry.
 * @param {Hash} hash
 * @param {Number} index
 * @returns {MempoolEntry}
 */

Mempool.prototype.getSpent = function getSpent(hash, index) {
  const key = Outpoint.toKey(hash, index);
  return this.spents.get(key);
};

/**
 * Get an output's spender transaction.
 * @param {Hash} hash
 * @param {Number} index
 * @returns {MempoolEntry}
 */

Mempool.prototype.getSpentTX = function getSpentTX(hash, index) {
  const key = Outpoint.toKey(hash, index);
  const entry = this.spents.get(key);

  if (!entry)
    return null;

  return entry.tx;
};

/**
 * Find all coins pertaining to a certain address.
 * @param {Address[]} addrs
 * @returns {Coin[]}
 */

Mempool.prototype.getCoinsByAddress = function getCoinsByAddress(addrs) {
  if (!Array.isArray(addrs))
    addrs = [addrs];

  const out = [];

  for (const addr of addrs) {
    const hash = Address.getHash(addr, 'hex');
    const coins = this.coinIndex.get(hash);

    for (const coin of coins)
      out.push(coin);
  }

  return out;
};

/**
 * Find all transactions pertaining to a certain address.
 * @param {Address[]} addrs
 * @returns {TX[]}
 */

Mempool.prototype.getTXByAddress = function getTXByAddress(addrs) {
  if (!Array.isArray(addrs))
    addrs = [addrs];

  const out = [];

  for (const addr of addrs) {
    const hash = Address.getHash(addr, 'hex');
    const txs = this.txIndex.get(hash);

    for (const tx of txs)
      out.push(tx);
  }

  return out;
};

/**
 * Find all transactions pertaining to a certain address.
 * @param {Address[]} addrs
 * @returns {TXMeta[]}
 */

Mempool.prototype.getMetaByAddress = function getMetaByAddress(addrs) {
  if (!Array.isArray(addrs))
    addrs = [addrs];

  const out = [];

  for (const addr of addrs) {
    const hash = Address.getHash(addr, 'hex');
    const txs = this.txIndex.getMeta(hash);

    for (const tx of txs)
      out.push(tx);
  }

  return out;
};

/**
 * Find all transactions to a certain address.
 * @param {Address[]} addrs
 * @returns {TXMeta[]}
 */

Mempool.prototype.getAllMetaByAddress = function getAllMetaByAddress(addr) {
  const meta = [];
  this.map.forEach((entry, hash) => {
    for(let input of entry.tx.inputs) {
      if (input.getAddress().equals(addr))
        meta.push(TXMeta.fromTX(entry.tx));
    }
    for(let output of entry.tx.outputs) {
      if (output.getAddress().equals(addr))
        meta.push(TXMeta.fromTX(entry.tx));
    }
  });

  return meta;
};

/**
 * Retrieve a transaction from the mempool.
 * @param {Hash} hash
 * @returns {TXMeta}
 */

Mempool.prototype.getMeta = function getMeta(hash) {
  const entry = this.getEntry(hash);

  if (!entry)
    return null;

  const meta = TXMeta.fromTX(entry.tx);
  meta.mtime = entry.time;

  return meta;
};

/**
 * Test the mempool to see if it contains a transaction.
 * @param {Hash} hash
 * @returns {Boolean}
 */

Mempool.prototype.hasEntry = function hasEntry(hash) {
  return this.map.has(hash);
};

/**
 * Test the mempool to see if it
 * contains a transaction or an orphan.
 * @param {Hash} hash
 * @returns {Boolean}
 */

Mempool.prototype.has = function has(hash) {
  if (this.locker.has(hash))
    return true;

  if (this.hasOrphan(hash))
    return true;

  return this.hasEntry(hash);
};

/**
 * Test the mempool to see if it
 * contains a transaction or an orphan.
 * @private
 * @param {Hash} hash
 * @returns {Boolean}
 */

Mempool.prototype.exists = function exists(hash) {
  if (this.locker.hasPending(hash))
    return true;

  if (this.hasOrphan(hash))
    return true;

  return this.hasEntry(hash);
};

/**
 * Test the mempool to see if it
 * contains a recent reject.
 * @param {Hash} hash
 * @returns {Boolean}
 */

Mempool.prototype.hasReject = function hasReject(hash) {
  return this.rejects.test(hash, 'hex');
};

/**
 * Add a transaction to the mempool. Note that this
 * will lock the mempool until the transaction is
 * fully processed.
 * @method
 * @param {TX} tx
 * @param {Number?} id
 * @returns {Promise}
 */

Mempool.prototype.addTX = async function addTX(tx, id) {
  const hash = tx.hash('hex');
  const unlock = await this.locker.lock(hash);
  try {
    return await this._addTX(tx, id);
  } finally {
    unlock();
  }
};

/**
 * Add a transaction to the mempool without a lock.
 * @method
 * @private
 * @param {TX} tx
 * @param {Number?} id
 * @returns {Promise}
 */

Mempool.prototype._addTX = async function _addTX(tx, id) {
  if (id == null)
    id = -1;

  let missing;
  try {
    missing = await this.insertTX(tx, id);
  } catch (err) {
    if (err.type === 'VerifyError') {
      if (!tx.hasWitness() && !err.malleated)
        this.rejects.add(tx.hash());
    }
    throw err;
  }

  if (util.now() - this.lastFlush > 10) {
    await this.cache.flush();
    this.lastFlush = util.now();
  }

  return missing;
};

/**
 * Add a transaction to the mempool without a lock.
 * @method
 * @private
 * @param {TX} tx
 * @param {Number?} id
 * @returns {Promise}
 */

Mempool.prototype.insertTX = async function insertTX(tx, id) {
  assert(!tx.mutable, 'Cannot add mutable TX to mempool.');

  const lockFlags = common.lockFlags.STANDARD_LOCKTIME_FLAGS;
  const height = this.chain.height;
  const hash = tx.hash('hex');

  // Basic sanity checks.
  // This is important because it ensures
  // other functions will be overflow safe.
  const [valid, reason, score] = tx.checkSanity(height);

  if (!valid)
    throw new VerifyError(tx, 'invalid', reason, score);

  // Coinbases are an insta-ban.
  // Why? Who knows.
  if (tx.isCoinbase()) {
    throw new VerifyError(tx,
      'invalid',
      'coinbase',
      100);
  }

  // Do not allow CSV until it's activated.
  if (this.options.requireStandard) {
    if (!this.chain.state.hasCSV() && tx.version >= 2) {
      throw new VerifyError(tx,
        'nonstandard',
        'premature-version2-tx',
        0);
    }
  }

  // Do not allow segwit until it's activated.
  if (!this.chain.state.hasWitness() && !this.options.prematureWitness) {
    if (tx.hasWitness()) {
      throw new VerifyError(tx,
        'nonstandard',
        'no-witness-yet',
        0,
        true);
    }
  }

  // Non-contextual standardness checks.
  if (this.options.requireStandard) {
    const [valid, reason, score] = tx.checkStandard();

    if (!valid)
      throw new VerifyError(tx, 'nonstandard', reason, score);

    if (!this.options.replaceByFee) {
      if (tx.isRBF()) {
        throw new VerifyError(tx,
          'nonstandard',
          'replace-by-fee',
          0);
      }
    }
  }

  // Verify transaction finality (see isFinal()).
  if (!await this.verifyFinal(tx, lockFlags)) {
    throw new VerifyError(tx,
      'nonstandard',
      'non-final',
      0);
  }

  // We can maybe ignore this.
  if (this.exists(hash)) {
    throw new VerifyError(tx,
      'alreadyknown',
      'txn-already-in-mempool',
      0);
  }

  // We can test whether this is an
  // non-fully-spent transaction on
  // the chain.
  if (await this.chain.hasCoins(tx)) {
    throw new VerifyError(tx,
      'alreadyknown',
      'txn-already-known',
      0);
  }

  // Quick and dirty test to verify we're
  // not double-spending an output in the
  // mempool.
  if (this.isDoubleSpend(tx)) {
    this.emit('conflict', tx);
    throw new VerifyError(tx,
      'duplicate',
      'bad-txns-inputs-spent',
      0);
  }

  // Get coin viewpoint as it
  // pertains to the mempool.
  const view = await this.getCoinView(tx);

  /*// Find missing outpoints.
  const missing = this.findMissing(tx, view);*/

  // Maybe store as an orphan.
  const missing = this.maybeOrphan(tx, view, id);

  // Return missing outpoint hashes.
  if (missing)
    //return this.storeOrphan(tx, missing, id);
    return missing;

  // Create a new mempool entry
  // at current chain height.
  const entry = MempoolEntry.fromTX(tx, view, height);

  // Contextual verification.
  await this.verify(entry, view);

  // Add and index the entry.
  await this.addEntry(entry, view);

  // Trim size if we're too big.
  if (this.limitSize(hash)) {
    throw new VerifyError(tx,
      'insufficientfee',
      'mempool full',
      0);
  }

  return null;
};

/**
 * Verify a transaction with mempool standards.
 * @method
 * @param {TX} tx
 * @param {CoinView} view
 * @returns {Promise}
 */

Mempool.prototype.verify = async function verify(entry, view) {
  const height = this.chain.height + 1;
  const lockFlags = common.lockFlags.STANDARD_LOCKTIME_FLAGS;
  const tx = entry.tx;

  // Verify sequence locks.
  if (!await this.verifyLocks(tx, view, lockFlags)) {
    throw new VerifyError(tx,
      'nonstandard',
      'non-BIP68-final',
      0);
  }

  // Check input an witness standardness.
  if (this.options.requireStandard) {
    if (!tx.hasStandardInputs(view)) {
      throw new VerifyError(tx,
        'nonstandard',
        'bad-txns-nonstandard-inputs',
        0);
    }
    if (this.chain.state.hasWitness()) {
      if (!tx.hasStandardWitness(view)) {
        throw new VerifyError(tx,
          'nonstandard',
          'bad-witness-nonstandard',
          0,
          true);
      }
    }
  }

  // Annoying process known as sigops counting.
  if (entry.sigops > policy.MAX_TX_SIGOPS_COST) {
    throw new VerifyError(tx,
      'nonstandard',
      'bad-txns-too-many-sigops',
      0);
  }

  // Make sure this guy gave a decent fee.
  const minFee = policy.getMinFee(entry.size, this.options.minRelay);

  if (this.options.relayPriority && entry.fee < minFee) {
    if (!entry.isFree(height)) {
      throw new VerifyError(tx,
        'insufficientfee',
        'insufficient priority',
        0);
    }
  }

  // Continuously rate-limit free (really, very-low-fee)
  // transactions. This mitigates 'penny-flooding'.
  if (this.options.limitFree && entry.fee < minFee) {
    const now = util.now();

    // Use an exponentially decaying ~10-minute window.
    this.freeCount *= Math.pow(1 - 1 / 600, now - this.lastTime);
    this.lastTime = now;

    // The limitFreeRelay unit is thousand-bytes-per-minute
    // At default rate it would take over a month to fill 1GB.
    if (this.freeCount > this.options.limitFreeRelay * 10 * 1000) {
      throw new VerifyError(tx,
        'insufficientfee',
        'rate limited free transaction',
        0);
    }

    this.freeCount += entry.size;
  }

  // Important safety feature.
  if (this.options.rejectAbsurdFees && entry.fee > minFee * 10000)
    throw new VerifyError(tx, 'highfee', 'absurdly-high-fee', 0);

  // Why do we have this here? Nested transactions are cool.
  if (this.countAncestors(entry) + 1 > this.options.maxAncestors) {
    throw new VerifyError(tx,
      'nonstandard',
      'too-long-mempool-chain',
      0);
  }

  // Contextual sanity checks.
  const [fee, reason, score] = tx.checkInputs(view, height);

  if (fee === -1)
    throw new VerifyError(tx, 'invalid', reason, score);

  // Script verification.
  let flags = Script.flags.STANDARD_VERIFY_FLAGS;
  try {
    await this.verifyInputs(tx, view, flags);
  } catch (err) {
    if (tx.hasWitness())
      throw err;

    // Try without segwit and cleanstack.
    flags &= ~Script.flags.VERIFY_WITNESS;
    flags &= ~Script.flags.VERIFY_CLEANSTACK;

    // If it failed, the first verification
    // was the only result we needed.
    if (!await this.verifyResult(tx, view, flags))
      throw err;

    // If it succeeded, segwit may be causing the
    // failure. Try with segwit but without cleanstack.
    flags |= Script.flags.VERIFY_CLEANSTACK;

    // Cleanstack was causing the failure.
    if (await this.verifyResult(tx, view, flags))
      throw err;

    // Do not insert into reject cache.
    err.malleated = true;
    throw err;
  }

  // Paranoid checks.
  if (this.options.paranoidChecks) {
    const flags = Script.flags.MANDATORY_VERIFY_FLAGS;
    assert(await this.verifyResult(tx, view, flags),
      'BUG: Verify failed for mandatory but not standard.');
  }
};

/**
 * Verify inputs, return a boolean
 * instead of an error based on success.
 * @method
 * @param {TX} tx
 * @param {CoinView} view
 * @param {VerifyFlags} flags
 * @returns {Promise}
 */

Mempool.prototype.verifyResult = async function verifyResult(tx, view, flags) {
  try {
    await this.verifyInputs(tx, view, flags);
  } catch (err) {
    if (err.type === 'VerifyError')
      return false;
    throw err;
  }
  return true;
};

/**
 * Verify inputs for standard
 * _and_ mandatory flags on failure.
 * @method
 * @param {TX} tx
 * @param {CoinView} view
 * @param {VerifyFlags} flags
 * @returns {Promise}
 */

Mempool.prototype.verifyInputs = async function verifyInputs(tx, view, flags) {
  if (await tx.verifyAsync(view, flags, this.workers))
    return;

  if (flags & Script.flags.ONLY_STANDARD_VERIFY_FLAGS) {
    flags &= ~Script.flags.ONLY_STANDARD_VERIFY_FLAGS;

    if (await tx.verifyAsync(view, flags, this.workers)) {
      throw new VerifyError(tx,
        'nonstandard',
        'non-mandatory-script-verify-flag',
        0);
    }
  }

  throw new VerifyError(tx,
    'nonstandard',
    'mandatory-script-verify-flag',
    100);
};

/**
 * Add a transaction to the mempool without performing any
 * validation. Note that this method does not lock the mempool
 * and may lend itself to race conditions if used unwisely.
 * This function will also resolve orphans if possible (the
 * resolved orphans _will_ be validated).
 * @method
 * @param {MempoolEntry} entry
 * @param {CoinView} view
 * @returns {Promise}
 */

Mempool.prototype.addEntry = async function addEntry(entry, view) {
  const tx = entry.tx;

  this.trackEntry(entry, view);

  this.updateAncestors(entry, addFee);

  this.emit('tx', tx, view);
  this.emit('add entry', entry);

  if (this.fees)
    this.fees.processTX(entry, this.chain.synced);

  this.logger.debug(
    'Added %s to mempool (txs=%d).',
    tx.txid(), this.map.size);

  this.cache.save(entry);

  await this.handleOrphans(tx);
};

/**
 * Remove a transaction from the mempool.
 * Generally only called when a new block
 * is added to the main chain.
 * @param {MempoolEntry} entry
 */

Mempool.prototype.removeEntry = function removeEntry(entry) {
  const tx = entry.tx;
  const hash = tx.hash('hex');

  this.untrackEntry(entry);

  if (this.fees)
    this.fees.removeTX(hash);

  this.cache.remove(tx.hash());

  this.emit('remove entry', entry);
};

/**
 * Remove a transaction from the mempool.
 * Recursively remove its spenders.
 * @param {MempoolEntry} entry
 */

Mempool.prototype.evictEntry = function evictEntry(entry) {
  this.removeSpenders(entry);
  this.updateAncestors(entry, removeFee);
  this.removeEntry(entry);
};

/**
 * Recursively remove spenders of a transaction.
 * @private
 * @param {MempoolEntry} entry
 */

Mempool.prototype.removeSpenders = function removeSpenders(entry) {
  const tx = entry.tx;
  const hash = tx.hash('hex');

  for (let i = 0; i < tx.outputs.length; i++) {
    const spender = this.getSpent(hash, i);

    if (!spender)
      continue;

    this.removeSpenders(spender);
    this.removeEntry(spender);
  }
};

/**
 * Count the highest number of
 * ancestors a transaction may have.
 * @param {MempoolEntry} entry
 * @returns {Number}
 */

Mempool.prototype.countAncestors = function countAncestors(entry) {
  return this._countAncestors(entry, new Set(), entry, nop);
};

/**
 * Count the highest number of
 * ancestors a transaction may have.
 * Update descendant fees and size.
 * @param {MempoolEntry} entry
 * @param {Function} map
 * @returns {Number}
 */

Mempool.prototype.updateAncestors = function updateAncestors(entry, map) {
  return this._countAncestors(entry, new Set(), entry, map);
};

/**
 * Traverse ancestors and count.
 * @private
 * @param {MempoolEntry} entry
 * @param {Object} set
 * @param {MempoolEntry} child
 * @param {Function} map
 * @returns {Number}
 */

Mempool.prototype._countAncestors = function _countAncestors(entry, set, child, map) {
  const tx = entry.tx;

  //for (const input of tx.inputs) {
    //const hash = input.prevout.hash;
  for (const {prevout} of tx.inputs) {
    const hash = prevout.hash;
    const parent = this.getEntry(hash);

    if (!parent)
      continue;

    if (set.has(hash))
      continue;

    set.add(hash);

    map(parent, child);

    if (set.size > this.options.maxAncestors)
      break;

    this._countAncestors(parent, set, child, map);

    if (set.size > this.options.maxAncestors)
      break;
  }

  return set.size;
};

/**
 * Count the highest number of
 * descendants a transaction may have.
 * @param {MempoolEntry} entry
 * @returns {Number}
 */

Mempool.prototype.countDescendants = function countDescendants(entry) {
  return this._countDescendants(entry, new Set());
};

/**
 * Count the highest number of
 * descendants a transaction may have.
 * @private
 * @param {MempoolEntry} entry
 * @param {Object} set
 * @returns {Number}
 */

Mempool.prototype._countDescendants = function _countDescendants(entry, set) {
  const tx = entry.tx;
  const hash = tx.hash('hex');

  for (let i = 0; i < tx.outputs.length; i++) {
    const child = this.getSpent(hash, i);

    if (!child)
      continue;

    const next = child.hash('hex');

    if (set.has(next))
      continue;

    set.add(next);

    this._countDescendants(child, set);
  }

  return set.size;
};

/**
 * Get all transaction ancestors.
 * @param {MempoolEntry} entry
 * @returns {MempoolEntry[]}
 */

Mempool.prototype.getAncestors = function getAncestors(entry) {
  return this._getAncestors(entry, [], new Set());
};

/**
 * Get all transaction ancestors.
 * @private
 * @param {MempoolEntry} entry
 * @param {MempoolEntry[]} entries
 * @param {Object} set
 * @returns {MempoolEntry[]}
 */

Mempool.prototype._getAncestors = function _getAncestors(entry, entries, set) {
  const tx = entry.tx;

  //for (const input of tx.inputs) {
    //const hash = input.prevout.hash;
  for (const {prevout} of tx.inputs) {
    const hash = prevout.hash;
    const parent = this.getEntry(hash);

    if (!parent)
      continue;

    if (set.has(hash))
      continue;

    set.add(hash);
    entries.push(parent);

    this._getAncestors(parent, entries, set);
  }

  return entries;
};

/**
 * Get all a transaction descendants.
 * @param {MempoolEntry} entry
 * @returns {MempoolEntry[]}
 */

Mempool.prototype.getDescendants = function getDescendants(entry) {
  return this._getDescendants(entry, [], new Set());
};

/**
 * Get all a transaction descendants.
 * @param {MempoolEntry} entry
 * @param {MempoolEntry[]} entries
 * @param {Object} set
 * @returns {MempoolEntry[]}
 */

Mempool.prototype._getDescendants = function _getDescendants(entry, entries, set) {
  const tx = entry.tx;
  const hash = tx.hash('hex');

  for (let i = 0; i < tx.outputs.length; i++) {
    const child = this.getSpent(hash, i);

    if (!child)
      continue;

    const next = child.hash('hex');

    if (set.has(next))
      continue;

    set.add(next);
    entries.push(child);

    this._getDescendants(child, entries, set);
  }

  return entries;
};

/**
 * Find a unconfirmed transactions that
 * this transaction depends on.
 * @param {TX} tx
 * @returns {Hash[]}
 */

Mempool.prototype.getDepends = function getDepends(tx) {
  const prevout = tx.getPrevout();
  const depends = [];

  for (const hash of prevout) {
    if (this.hasEntry(hash))
      depends.push(hash);
  }

  return depends;
};

/**
 * Test whether a transaction has dependencies.
 * @param {TX} tx
 * @returns {Boolean}
 */

Mempool.prototype.hasDepends = function hasDepends(tx) {
  //for (const input of tx.inputs) {
    //const hash = input.prevout.hash;
    //if (this.hasEntry(hash))
  for (const {prevout} of tx.inputs) {
    if (this.hasEntry(prevout.hash))
      return true;
  }
  return false;
};

/**
 * Return the full balance of all unspents in the mempool
 * (not very useful in practice, only used for testing).
 * @returns {Amount}
 */

Mempool.prototype.getBalance = function getBalance() {
  let total = 0;

  for (const [hash, entry] of this.map) {
    const tx = entry.tx;
    for (let i = 0; i < tx.outputs.length; i++) {
      const coin = this.getCoin(hash, i);
      if (coin)
        total += coin.value;
    }
  }

  return total;
};

/**
 * Retrieve _all_ transactions from the mempool.
 * @returns {TX[]}
 */

Mempool.prototype.getHistory = function getHistory() {
  const txs = [];

  for (const entry of this.map.values())
    txs.push(entry.tx);

  return txs;
};

/**
 * Retrieve an orphan transaction.
 * @param {Hash} hash
 * @returns {TX}
 */

Mempool.prototype.getOrphan = function getOrphan(hash) {
  return this.orphans.get(hash);
};

/**
 * @param {Hash} hash
 * @returns {Boolean}
 */

Mempool.prototype.hasOrphan = function hasOrphan(hash) {
  return this.orphans.has(hash);
};

/**
 * Store an orphaned transaction.
 * @param {TX} tx
 * @param {Hash[]} missing
 * @param {Number} id

Mempool.prototype.storeOrphan = function storeOrphan(tx, missing, id) {
  if (tx.getWeight() > policy.MAX_TX_WEIGHT) {
    this.logger.debug('Ignoring large orphan: %s', tx.txid());
    if (!tx.hasWitness())
      this.rejects.add(tx.hash());
    return [];
  }

  for (const prev of missing) {
    if (this.hasReject(prev)) {
      this.logger.debug('Not storing orphan %s (rejected parents).', tx.txid());
      this.rejects.add(tx.hash());
      return [];
    }
  }

  if (this.options.maxOrphans === 0)
    return [];

  this.limitOrphans();

  const hash = tx.hash('hex');

  for (const prev of missing) {
    if (!this.waiting.has(prev))
      this.waiting.set(prev, new Set());

    this.waiting.get(prev).add(hash);
  }

  this.orphans.set(hash, new Orphan(tx, missing.length, id));

  this.logger.debug('Added orphan %s to mempool.', tx.txid());

  this.emit('add orphan', tx);

  return missing;
};
 */

/**
 * Maybe store an orphaned transaction.
 * @param {TX} tx
 * @param {CoinView} view
 * @param {Number} id
 */

Mempool.prototype.maybeOrphan = function maybeOrphan(tx, view, id) {
  const hashes = new Set();
  const missing = [];

  for (const {prevout} of tx.inputs) {
    if (view.hasEntry(prevout))
      continue;

    if (this.hasReject(prevout.hash)) {
      this.logger.debug('Not storing orphan %s (rejected parents).', tx.txid());
      this.rejects.add(tx.hash());
      return missing;
    }

    if (this.hasEntry(prevout.hash)) {
      this.logger.debug(
        'Not storing orphan %s (non-existent output).',
        tx.txid());
      this.rejects.add(tx.hash());
      return missing;
    }

    hashes.add(prevout.hash);
  }

  // Not an orphan.
  if (hashes.size === 0)
    return null;

  // Weight limit for orphans.
  if (tx.getWeight() > policy.MAX_TX_WEIGHT) {
    this.logger.debug('Ignoring large orphan: %s', tx.txid());
    if (!tx.hasWitness())
      this.rejects.add(tx.hash());
    return missing;
  }

  if (this.options.maxOrphans === 0)
    return missing;

  this.limitOrphans();

  const hash = tx.hash('hex');

  for (const prev of hashes.keys()) {
    if (!this.waiting.has(prev))
      this.waiting.set(prev, new Set());

    this.waiting.get(prev).add(hash);

    missing.push(prev);
  }

  this.orphans.set(hash, new Orphan(tx, missing.length, id));

  this.logger.debug('Added orphan %s to mempool.', tx.txid());

  this.emit('add orphan', tx);

  return missing;
};

/**
 * Resolve orphans and attempt to add to mempool.
 * @method
 * @param {TX} parent
 * @returns {Promise} - Returns {@link TX}[].
 */

Mempool.prototype.handleOrphans = async function handleOrphans(parent) {
  const resolved = this.resolveOrphans(parent);

  for (const orphan of resolved) {
    let tx, missing;

    try {
      tx = orphan.toTX();
    } catch (e) {
      this.logger.warning('%s %s',
        'Warning: possible memory corruption.',
        'Orphan failed deserialization.');
      continue;
    }

    try {
      //missing = await this.insertTX(tx, -1);
      missing = await this.insertTX(tx, orphan.id);
    } catch (err) {
      if (err.type === 'VerifyError') {
        this.logger.debug(
          'Could not resolve orphan %s: %s.',
          tx.txid(), err.message);

        if (!tx.hasWitness() && !err.malleated)
          this.rejects.add(tx.hash());

        this.emit('bad orphan', err, orphan.id);

        continue;
      }
      throw err;
    }

    //assert(!missing);
    //assert(!missing || missing.length === 0);
    // Can happen if an existing parent is
    // evicted in the interim between fetching
    // the non-present parents.
    if (missing && missing.length > 0) {
      this.logger.debug(
        'Transaction %s was double-orphaned in mempool.',
        tx.txid());
      this.removeOrphan(tx.hash('hex'));
      continue;
    }

    this.logger.debug('Resolved orphan %s in mempool.', tx.txid());
  }
};

/**
 * Potentially resolve any transactions
 * that redeem the passed-in transaction.
 * Deletes all orphan entries and
 * returns orphan objects.
 * @param {TX} parent
 * @returns {Orphan[]}
 */

Mempool.prototype.resolveOrphans = function resolveOrphans(parent) {
  const hash = parent.hash('hex');
  const set = this.waiting.get(hash);

  if (!set)
    return [];

  assert(set.size > 0);

  const resolved = [];

  //for (const orphanHash of set.keys()) {
    //const orphan = this.getOrphan(orphanHash);
  for (const hash of set.keys()) {
    const orphan = this.getOrphan(hash);

    assert(orphan);

    if (--orphan.missing === 0) {
      //this.orphans.delete(orphanHash);
      this.orphans.delete(hash);
      resolved.push(orphan);
    }
  }

  this.waiting.delete(hash);

  return resolved;
};

/**
 * Remove a transaction from the mempool.
 * @param {Hash} tx
 * @returns {Boolean}
 */

Mempool.prototype.removeOrphan = function removeOrphan(hash) {
  const orphan = this.getOrphan(hash);

  if (!orphan)
    return false;

  let tx;
  try {
    tx = orphan.toTX();
  } catch (e) {
    this.orphans.delete(hash);
    this.logger.warning('%s %s',
      'Warning: possible memory corruption.',
      'Orphan failed deserialization.');
    return false;
  }

  for (const prev of tx.getPrevout()) {
    const set = this.waiting.get(prev);

    if (!set)
      continue;

    assert(set.has(hash));

    set.delete(hash);

    if (set.size === 0)
      this.waiting.delete(prev);
  }

  this.orphans.delete(hash);

  this.emit('remove orphan', tx);

  return true;
};

/**
 * Remove a random orphan transaction from the mempool.
 * @returns {Boolean}
 */

Mempool.prototype.limitOrphans = function limitOrphans() {
  if (this.orphans.size < this.options.maxOrphans)
    return false;

  let index = random.randomRange(0, this.orphans.size);

  let hash;
  for (hash of this.orphans.keys()) {
    if (index === 0)
      break;
    index--;
  }

  assert(hash);

  this.logger.debug('Removing orphan %s from mempool.', util.revHex(hash));

  this.removeOrphan(hash);

  return true;
};

/**
 * Test all of a transactions outpoints to see if they are doublespends.
 * Note that this will only test against the mempool spents, not the
 * blockchain's. The blockchain spents are not checked against because
 * the blockchain does not maintain a spent list. The transaction will
 * be seen as an orphan rather than a double spend.
 * @param {TX} tx
 * @returns {Promise} - Returns Boolean.
 */

Mempool.prototype.isDoubleSpend = function isDoubleSpend(tx) {
  //for (const input of tx.inputs) {
    //const prevout = input.prevout;
    //if (this.isSpent(prevout.hash, prevout.index))
  for (const {prevout} of tx.inputs) {
    const {hash, index} = prevout;
    if (this.isSpent(hash, index))
      return true;
  }

  return false;
};

/**
 * Get coin viewpoint (lock).
 * @method
 * @param {TX} tx
 * @returns {Promise} - Returns {@link CoinView}.
 */

Mempool.prototype.getSpentView = async function getSpentView(tx) {
  const unlock = await this.locker.lock();
  try {
    return await this.getCoinView(tx);
  } finally {
    unlock();
  }
};

/**
 * Get coin viewpoint (no lock).
 * @method
 * @param {TX} tx
 * @returns {Promise} - Returns {@link CoinView}.
 */

Mempool.prototype.getCoinView = async function getCoinView(tx) {
  const view = new CoinView();

  for (const {prevout} of tx.inputs) {
    //const entry = this.getEntry(prevout.hash);
    const {hash, index} = prevout;
    const tx = this.getTX(hash);

    /*if (entry) {
      view.addTX(entry.tx, -1);
      continue;
    }*/
    if (tx) {
      if (index < tx.outputs.length)
        view.addIndex(tx, index, -1);
      continue;
    }

    const coin = await this.chain.readCoin(prevout);

    /*if (!coin) {
      const coins = new Coins();
      view.add(prevout.hash, coins);
      continue;
    }

    view.addEntry(prevout, coin);*/
    if (coin)
      view.addEntry(prevout, coin);
  }

  return view;
};

/**
 * Find missing outpoints.
 * @param {TX} tx
 * @param {CoinView} view
 * @returns {Hash[]}

Mempool.prototype.findMissing = function findMissing(tx, view) {
  const missing = [];

  for (const {prevout} of tx.inputs) {
    if (view.hasEntry(prevout))
      continue;

    missing.push(prevout.hash);
  }

  if (missing.length === 0)
    return null;

  return missing;
};
 */

/**
 * Get a snapshot of all transaction hashes in the mempool. Used
 * for generating INV packets in response to MEMPOOL packets.
 * @returns {Hash[]}
 */

Mempool.prototype.getSnapshot = function getSnapshot() {
  const keys = [];

  for (const hash of this.map.keys())
    keys.push(hash);

  return keys;
};

/**
 * Check sequence locks on a transaction against the current tip.
 * @param {TX} tx
 * @param {CoinView} view
 * @param {LockFlags} flags
 * @returns {Promise} - Returns Boolean.
 */

Mempool.prototype.verifyLocks = function verifyLocks(tx, view, flags) {
  return this.chain.verifyLocks(this.chain.tip, tx, view, flags);
};

/**
 * Check locktime on a transaction against the current tip.
 * @param {TX} tx
 * @param {LockFlags} flags
 * @returns {Promise} - Returns Boolean.
 */

Mempool.prototype.verifyFinal = function verifyFinal(tx, flags) {
  return this.chain.verifyFinal(this.chain.tip, tx, flags);
};

/**
 * Map a transaction to the mempool.
 * @private
 * @param {MempoolEntry} entry
 * @param {CoinView} view
 */

Mempool.prototype.trackEntry = function trackEntry(entry, view) {
  const tx = entry.tx;
  const hash = tx.hash('hex');

  assert(!this.map.has(hash));
  this.map.set(hash, entry);

  assert(!tx.isCoinbase());

  //for (const input of tx.inputs) {
    //const key = input.prevout.toKey();
  for (const {prevout} of tx.inputs) {
    const key = prevout.toKey();
    this.spents.set(key, entry);
  }

  if (this.options.indexAddress && view)
    this.indexEntry(entry, view);

  this.size += entry.memUsage();
};

/**
 * Unmap a transaction from the mempool.
 * @private
 * @param {MempoolEntry} entry
 */

Mempool.prototype.untrackEntry = function untrackEntry(entry) {
  const tx = entry.tx;
  const hash = tx.hash('hex');

  assert(this.map.has(hash));
  this.map.delete(hash);

  assert(!tx.isCoinbase());

  //for (const input of tx.inputs) {
    //const key = input.prevout.toKey();
  for (const {prevout} of tx.inputs) {
    const key = prevout.toKey();
    this.spents.delete(key);
  }

  if (this.options.indexAddress)
    this.unindexEntry(entry);

  this.size -= entry.memUsage();
};

/**
 * Index an entry by address.
 * @private
 * @param {MempoolEntry} entry
 * @param {CoinView} view
 */

Mempool.prototype.indexEntry = function indexEntry(entry, view) {
  const tx = entry.tx;

  this.txIndex.insert(entry, view);

  //for (const input of tx.inputs) {
    //const prev = input.prevout;
    //this.coinIndex.remove(prev.hash, prev.index);
  for (const {prevout} of tx.inputs) {
    const {hash, index} = prevout;
    this.coinIndex.remove(hash, index);
  }

  for (let i = 0; i < tx.outputs.length; i++)
    this.coinIndex.insert(tx, i);
};

/**
 * Unindex an entry by address.
 * @private
 * @param {MempoolEntry} entry
 */

Mempool.prototype.unindexEntry = function unindexEntry(entry) {
  const tx = entry.tx;
  const hash = tx.hash('hex');

  this.txIndex.remove(hash);

  //for (const input of tx.inputs) {
    //const prevout = input.prevout.hash;
    //const prev = this.getTX(prevout.hash);
  for (const {prevout} of tx.inputs) {
    const {hash, index} = prevout;
    const prev = this.getTX(hash);

    if (!prev)
      continue;

    //this.coinIndex.insert(prev, prevout.index);
    this.coinIndex.insert(prev, index);
  }

  for (let i = 0; i < tx.outputs.length; i++)
    this.coinIndex.remove(hash, i);
};

/**
 * Recursively remove double spenders
 * of a mined transaction's outpoints.
 * @private
 * @param {TX} tx
 */

Mempool.prototype.removeDoubleSpends = function removeDoubleSpends(tx) {
  //for (const input of tx.inputs) {
    //const prevout = input.prevout;
    //const spent = this.getSpent(prevout.hash, prevout.index);
  for (const {prevout} of tx.inputs) {
    const {hash, index} = prevout;
    const spent = this.getSpent(hash, index);

    if (!spent)
      continue;

    this.logger.debug(
      'Removing double spender from mempool: %s.',
      spent.txid());

    this.evictEntry(spent);

    this.emit('double spend', spent);
  }
};

/**
 * Calculate the memory usage of the entire mempool.
 * @see DynamicMemoryUsage()
 * @returns {Number} Usage in bytes.
 */

Mempool.prototype.getSize = function getSize() {
  return this.size;
};

/**
 * Calculate the mempool mapped txs size.
 * @returns {Number} Mempool map size.
 */

Mempool.prototype.getCount = function getCount() {
  return this.map.size;
};

/**
 * Prioritise transaction.
 * @param {MempoolEntry} entry
 * @param {Number} pri
 * @param {Amount} fee
 */

Mempool.prototype.prioritise = function prioritise(entry, pri, fee) {
  if (-pri > entry.priority)
    pri = -entry.priority;

  entry.priority += pri;

  if (-fee > entry.deltaFee)
    fee = -entry.deltaFee;

  if (fee === 0)
    return;

  this.updateAncestors(entry, prePrioritise);

  entry.deltaFee += fee;
  entry.descFee += fee;

  this.updateAncestors(entry, postPrioritise);
};

/**
 * MempoolOptions
 * @alias module:mempool.MempoolOptions
 * @constructor
 * @param {Object}
 */

function MempoolOptions(options) {
  if (!(this instanceof MempoolOptions))
    return new MempoolOptions(options);

  this.network = Network.primary;
  this.chain = null;
  this.logger = null;
  this.workers = null;
  this.fees = null;

  this.limitFree = true;
  this.limitFreeRelay = 15;
  this.relayPriority = true;
  this.requireStandard = this.network.requireStandard;
  this.rejectAbsurdFees = true;
  this.prematureWitness = false;
  this.paranoidChecks = false;
  this.replaceByFee = false;

  this.maxSize = policy.MEMPOOL_MAX_SIZE;
  this.maxOrphans = policy.MEMPOOL_MAX_ORPHANS;
  this.maxAncestors = policy.MEMPOOL_MAX_ANCESTORS;
  this.expiryTime = policy.MEMPOOL_EXPIRY_TIME;
  this.minRelay = this.network.minRelay;

  this.prefix = null;
  this.location = null;
  this.db = 'memory';
  this.maxFiles = 64;
  this.cacheSize = 32 << 20;
  this.compression = true;
  this.bufferKeys = layout.binary;

  this.persistent = false;

  this.fromOptions(options);
}

/**
 * Inject properties from object.
 * @private
 * @param {Object} options
 * @returns {MempoolOptions}
 */

MempoolOptions.prototype.fromOptions = function fromOptions(options) {
  assert(options, 'Mempool requires options.');
  assert(options.chain && typeof options.chain === 'object',
    'Mempool requires a blockchain.');

  this.chain = options.chain;
  this.network = options.chain.network;
  this.logger = options.chain.logger;
  this.workers = options.chain.workers;

  this.requireStandard = this.network.requireStandard;
  this.minRelay = this.network.minRelay;

  if (options.logger != null) {
    assert(typeof options.logger === 'object');
    this.logger = options.logger;
  }

  if (options.workers != null) {
    assert(typeof options.workers === 'object');
    this.workers = options.workers;
  }

  if (options.fees != null) {
    assert(typeof options.fees === 'object');
    this.fees = options.fees;
  }

  if (options.limitFree != null) {
    assert(typeof options.limitFree === 'boolean');
    this.limitFree = options.limitFree;
  }

  if (options.limitFreeRelay != null) {
    assert(util.isU32(options.limitFreeRelay));
    this.limitFreeRelay = options.limitFreeRelay;
  }

  if (options.relayPriority != null) {
    assert(typeof options.relayPriority === 'boolean');
    this.relayPriority = options.relayPriority;
  }

  if (options.requireStandard != null) {
    assert(typeof options.requireStandard === 'boolean');
    this.requireStandard = options.requireStandard;
  }

  if (options.rejectAbsurdFees != null) {
    assert(typeof options.rejectAbsurdFees === 'boolean');
    this.rejectAbsurdFees = options.rejectAbsurdFees;
  }

  if (options.prematureWitness != null) {
    assert(typeof options.prematureWitness === 'boolean');
    this.prematureWitness = options.prematureWitness;
  }

  if (options.paranoidChecks != null) {
    assert(typeof options.paranoidChecks === 'boolean');
    this.paranoidChecks = options.paranoidChecks;
  }

  if (options.replaceByFee != null) {
    assert(typeof options.replaceByFee === 'boolean');
    this.replaceByFee = options.replaceByFee;
  }

  if (options.maxSize != null) {
    assert(util.isU64(options.maxSize));
    this.maxSize = options.maxSize;
  }

  if (options.maxOrphans != null) {
    assert(util.isU32(options.maxOrphans));
    this.maxOrphans = options.maxOrphans;
  }

  if (options.maxAncestors != null) {
    assert(util.isU32(options.maxAncestors));
    this.maxAncestors = options.maxAncestors;
  }

  if (options.expiryTime != null) {
    assert(util.isU32(options.expiryTime));
    this.expiryTime = options.expiryTime;
  }

  if (options.minRelay != null) {
    assert(util.isU64(options.minRelay));
    this.minRelay = options.minRelay;
  }

  if (options.prefix != null) {
    assert(typeof options.prefix === 'string');
    this.prefix = options.prefix;
    this.location = path.join(this.prefix, 'mempool');
  }

  if (options.location != null) {
    assert(typeof options.location === 'string');
    this.location = options.location;
  }

  if (options.db != null) {
    assert(typeof options.db === 'string');
    this.db = options.db;
  }

  if (options.maxFiles != null) {
    assert(util.isU32(options.maxFiles));
    this.maxFiles = options.maxFiles;
  }

  if (options.cacheSize != null) {
    assert(util.isU64(options.cacheSize));
    this.cacheSize = options.cacheSize;
  }

  if (options.compression != null) {
    assert(typeof options.compression === 'boolean');
    this.compression = options.compression;
  }

  if (options.persistent != null) {
    assert(typeof options.persistent === 'boolean');
    this.persistent = options.persistent;
  }

  if (options.indexAddress != null) {
    assert(typeof options.indexAddress === 'boolean');
    this.indexAddress = options.indexAddress;
  }

  return this;
};

/**
 * Instantiate mempool options from object.
 * @param {Object} options
 * @returns {MempoolOptions}
 */

MempoolOptions.fromOptions = function fromOptions(options) {
  return new MempoolOptions().fromOptions(options);
};

/**
 * TX Address Index
 * @constructor
 * @ignore
 */

function TXIndex() {
  // Map of addr->entries.
  this.index = new Map();

  // Map of txid->addrs.
  this.map = new Map();
}

TXIndex.prototype.reset = function reset() {
  this.index.clear();
  this.map.clear();
};

TXIndex.prototype.get = function get(addr) {
  const items = this.index.get(addr);

  if (!items)
    return [];

  const out = [];

  for (const entry of items.values())
    out.push(entry.tx);

  return out;
};

TXIndex.prototype.getMeta = function getMeta(addr) {
  const items = this.index.get(addr);

  if (!items)
    return [];

  const out = [];

  for (const entry of items.values()) {
    const meta = TXMeta.fromTX(entry.tx);
    meta.mtime = entry.time;
    out.push(meta);
  }

  return out;
};

TXIndex.prototype.insert = function insert(entry, view) {
  const tx = entry.tx;
  const hash = tx.hash('hex');
  const addrs = tx.getHashes(view, 'hex');

  if (addrs.length === 0)
    return;

  for (const addr of addrs) {
    let items = this.index.get(addr);

    if (!items) {
      items = new Map();
      this.index.set(addr, items);
    }

    assert(!items.has(hash));
    items.set(hash, entry);
  }

  this.map.set(hash, addrs);
};

TXIndex.prototype.remove = function remove(hash) {
  const addrs = this.map.get(hash);

  if (!addrs)
    return;

  for (const addr of addrs) {
    const items = this.index.get(addr);

    assert(items);
    assert(items.has(hash));

    items.delete(hash);

    if (items.size === 0)
      this.index.delete(addr);
  }

  this.map.delete(hash);
};

/**
 * Coin Address Index
 * @constructor
 * @ignore
 */

function CoinIndex() {
  // Map of addr->coins.
  this.index = new Map();

  // Map of outpoint->addr.
  this.map = new Map();
}

CoinIndex.prototype.reset = function reset() {
  this.index.clear();
  this.map.clear();
};

CoinIndex.prototype.get = function get(addr) {
  const items = this.index.get(addr);

  if (!items)
    return [];

  const out = [];

  for (const coin of items.values())
    out.push(coin.toCoin());

  return out;
};

CoinIndex.prototype.insert = function insert(tx, index) {
  const output = tx.outputs[index];
  const hash = tx.hash('hex');
  const addr = output.getHash('hex');

  if (!addr)
    return;

  let items = this.index.get(addr);

  if (!items) {
    items = new Map();
    this.index.set(addr, items);
  }

  const key = Outpoint.toKey(hash, index);

  assert(!items.has(key));
  items.set(key, new IndexedCoin(tx, index));

  this.map.set(key, addr);
};

CoinIndex.prototype.remove = function remove(hash, index) {
  const key = Outpoint.toKey(hash, index);
  const addr = this.map.get(key);

  if (!addr)
    return;

  const items = this.index.get(addr);

  assert(items);
  assert(items.has(key));
  items.delete(key);

  if (items.size === 0)
    this.index.delete(addr);

  this.map.delete(key);
};

/**
 * IndexedCoin
 * @constructor
 * @ignore
 * @param {TX} tx
 * @param {Number} index
 */

function IndexedCoin(tx, index) {
  this.tx = tx;
  this.index = index;
}

IndexedCoin.prototype.toCoin = function toCoin() {
  return Coin.fromTX(this.tx, this.index, -1);
};

/**
 * Orphan
 * @constructor
 * @ignore
 * @param {TX} tx
 * @param {Hash[]} missing
 * @param {Number} id
 */

function Orphan(tx, missing, id) {
  this.raw = tx.toRaw();
  this.missing = missing;
  this.id = id;
}

Orphan.prototype.toTX = function toTX() {
  return TX.fromRaw(this.raw);
};

/**
 * Mempool Cache
 * @ignore
 * @constructor
 * @param {Object} options
 */

function MempoolCache(options) {
  if (!(this instanceof MempoolCache))
    return new MempoolCache(options);

  this.logger = options.logger;
  this.chain = options.chain;
  this.network = options.network;
  this.db = null;
  this.batch = null;

  if (options.persistent)
    this.db = LDB(options);
}

MempoolCache.VERSION = 2;

MempoolCache.prototype.getVersion = async function getVersion() {
  const data = await this.db.get(layout.V);

  if (!data)
    return -1;

  return data.readUInt32LE(0, true);
};

MempoolCache.prototype.getTip = async function getTip() {
  const hash = await this.db.get(layout.R);

  if (!hash)
    return null;

  return hash.toString('hex');
};

MempoolCache.prototype.getFees = async function getFees() {
  const data = await this.db.get(layout.F);

  if (!data)
    return null;

  let fees;
  try {
    fees = Fees.fromRaw(data);
  } catch (e) {
    this.logger.warning(
      'Fee data failed deserialization: %s.',
      e.message);
  }

  return fees;
};

MempoolCache.prototype.getEntries = function getEntries() {
  return this.db.values({
    gte: layout.e(encoding.ZERO_HASH),
    lte: layout.e(encoding.MAX_HASH),
    parse: MempoolEntry.fromRaw
  });
};

MempoolCache.prototype.getKeys = function getKeys() {
  return this.db.keys({
    gte: layout.e(encoding.ZERO_HASH),
    lte: layout.e(encoding.MAX_HASH)
  });
};

MempoolCache.prototype.open = async function open() {
  if (!this.db)
    return;

  await this.db.open();
  await this.verify();

  this.batch = this.db.batch();
};

MempoolCache.prototype.close = async function close() {
  if (!this.db)
    return;

  await this.db.close();

  this.batch = null;
};

MempoolCache.prototype.save = function save(entry) {
  if (!this.db)
    return;

  this.batch.put(layout.e(entry.tx.hash()), entry.toRaw());
};

MempoolCache.prototype.remove = function remove(hash) {
  if (!this.db)
    return;

  this.batch.del(layout.e(hash));
};

MempoolCache.prototype.sync = function sync(hash) {
  if (!this.db)
    return;

  this.batch.put(layout.R, Buffer.from(hash, 'hex'));
};

MempoolCache.prototype.writeFees = function writeFees(fees) {
  if (!this.db)
    return;

  this.batch.put(layout.F, fees.toRaw());
};

MempoolCache.prototype.clear = function clear() {
  this.batch.clear();
  this.batch = this.db.batch();
};

MempoolCache.prototype.flush = async function flush() {
  if (!this.db)
    return;

  await this.batch.write();

  this.batch = this.db.batch();
};

MempoolCache.prototype.init = async function init(hash) {
  const batch = this.db.batch();
  batch.put(layout.V, encoding.U32(MempoolCache.VERSION));
  batch.put(layout.R, Buffer.from(hash, 'hex'));
  await batch.write();
};

MempoolCache.prototype.verify = async function verify() {
  let version = await this.getVersion();
  let tip;

  if (version === -1) {
    version = MempoolCache.VERSION;
    tip = this.chain.tip.hash;

    this.logger.info(
      'Mempool cache is empty. Writing tip %s.',
      util.revHex(tip));

    await this.init(tip);
  }

  if (version !== MempoolCache.VERSION) {
    this.logger.warning(
      'Mempool cache version mismatch (%d != %d)!',
      version,
      MempoolCache.VERSION);
    this.logger.warning('Invalidating mempool cache.');
    await this.wipe();
    return false;
  }

  tip = await this.getTip();

  if (tip !== this.chain.tip.hash) {
    this.logger.warning(
      'Mempool tip not consistent with chain tip (%s != %s)!',
      util.revHex(tip),
      this.chain.tip.rhash());
    this.logger.warning('Invalidating mempool cache.');
    await this.wipe();
    return false;
  }

  return true;
};

MempoolCache.prototype.wipe = async function wipe() {
  const batch = this.db.batch();
  const keys = await this.getKeys();

  for (const key of keys)
    batch.del(key);

  batch.put(layout.V, encoding.U32(MempoolCache.VERSION));
  batch.put(layout.R, Buffer.from(this.chain.tip.hash, 'hex'));
  batch.del(layout.F);

  await batch.write();

  this.logger.info('Removed %d mempool entries from disk.', keys.length);
};

/*
 * Helpers
 */

function nop(parent, child) {
  ;
}

function addFee(parent, child) {
  parent.descFee += child.deltaFee;
  parent.descSize += child.size;
}

function removeFee(parent, child) {
  parent.descFee -= child.descFee;
  parent.descSize -= child.descSize;
}

function prePrioritise(parent, child) {
  parent.descFee -= child.deltaFee;
}

function postPrioritise(parent, child) {
  parent.descFee += child.deltaFee;
}

function cmpRate(a, b) {
  let xf = a.deltaFee;
  let xs = a.size;
  let yf = b.deltaFee;
  let ys = b.size;
  let x, y;

  if (useDesc(a)) {
    xf = a.descFee;
    xs = a.descSize;
  }

  if (useDesc(b)) {
    yf = b.descFee;
    ys = b.descSize;
  }

  x = xf * ys;
  y = xs * yf;

  if (x === y) {
    x = a.time;
    y = b.time;
  }

  return x - y;
}

function useDesc(a) {
  const x = a.deltaFee * a.descSize;
  const y = a.descFee * a.size;
  return y > x;
}

/*
 * Expose
 */

module.exports = Mempool;
