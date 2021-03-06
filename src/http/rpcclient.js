/*!
 * Copyright (c) 2014-2017, Christopher Jeffrey
 * Copyright (c) 2017, Park Alter (pseudonym)
 * Distributed under the MIT software license, see the accompanying
 * file COPYING or http://www.opensource.org/licenses/mit-license.php
 *
 * https://github.com/park-alter/wmcc-core
 * rpcclient.js - json rpc client for wmcc_core.
 */

'use strict';

const Network = require('../protocol/network');
const request = require('./request');

/**
 * WMCC RPC client.
 * @alias module:http.RPCClient
 * @constructor
 * @param {String} uri
 * @param {Object?} options
 */

function RPCClient(options) {
  if (!(this instanceof RPCClient))
    return new RPCClient(options);

  if (!options)
    options = {};

  if (typeof options === 'string')
    options = { uri: options };

  this.options = options;
  this.network = Network.get(options.network);

  this.uri = options.uri || `http://localhost:${this.network.rpcPort}`;
  this.apiKey = options.apiKey;
  this.id = 0;
}

/**
 * Make a json rpc request.
 * @private
 * @param {String} method - RPC method name.
 * @param {Array} params - RPC parameters.
 * @returns {Promise} - Returns Object?.
 */

RPCClient.prototype.execute = async function execute(method, params) {
  const res = await request({
    method: 'POST',
    uri: this.uri,
    pool: true,
    json: {
      method: method,
      params: params,
      id: this.id++
    },
    auth: {
      username: 'wmccrpc',
      password: this.apiKey || ''
    }
  });

  if (res.statusCode === 401)
    throw new RPCError('Unauthorized (bad API key).', -1);

  if (res.statusCode !== 200)
    throw new Error(`Status code: ${res.statusCode}.`);

  if (res.type !== 'json')
    throw new Error('Bad response (wrong content-type).');

  if (!res.body)
    throw new Error('No body for JSON-RPC response.');

  if (res.body.error)
    throw new RPCError(res.body.error.message, res.body.error.code);

  return res.body.result;
};

/*
 * Helpers
 */

function RPCError(msg, code) {
  Error.call(this);

  this.type = 'RPCError';
  this.message = String(msg);
  this.code = code >>> 0;

  if (Error.captureStackTrace)
    Error.captureStackTrace(this, RPCError);
}

Object.setPrototypeOf(RPCError.prototype, Error.prototype);

/*
 * Expose
 */

module.exports = RPCClient;
