/*!
 * Copyright (c) 2016-2017, Christopher Jeffrey
 * Copyright (c) 2017, Park Alter (pseudonym)
 * Distributed under the MIT software license, see the accompanying
 * file COPYING or http://www.opensource.org/licenses/mit-license.php
 *
 * https://github.com/park-alter/wmcc-core
 * paymentrequest.js - BIP70 paymentrequest for wmcc_core.
 */
 
'use strict';

const assert = require('assert');
const util = require('../utils/util');
const digest = require('../crypto/digest');
const x509 = require('./x509');
const PEM = require('../utils/pem');
const ProtoReader = require('../utils/protoreader');
const ProtoWriter = require('../utils/protowriter');
const PaymentDetails = require('./paymentdetails');

/**
 * Represents a BIP70 payment request.
 * @alias module:bip70.PaymentRequest
 * @constructor
 * @param {Object?} options
 * @property {Number} version
 * @property {String|null} pkiType
 * @property {Buffer|null} pkiData
 * @property {PaymentDetails} paymentDetails
 * @property {Buffer|null} signature
 */

function PaymentRequest(options) {
  if (!(this instanceof PaymentRequest))
    return new PaymentRequest(options);

  this.version = -1;
  this.pkiType = null;
  this.pkiData = null;
  this.paymentDetails = new PaymentDetails();
  this.signature = null;

  if (options)
    this.fromOptions(options);
}

/**
 * Inject properties from options.
 * @private
 * @param {Object} options
 * @returns {PaymentRequest}
 */

PaymentRequest.prototype.fromOptions = function fromOptions(options) {
  if (options.version != null) {
    assert(util.isInt(options.version));
    this.version = options.version;
  }

  if (options.pkiType != null) {
    assert(typeof options.pkiType === 'string');
    this.pkiType = options.pkiType;
  }

  if (options.pkiData) {
    assert(Buffer.isBuffer(options.pkiData));
    this.pkiData = options.pkiData;
  }

  if (options.paymentDetails)
    this.paymentDetails.fromOptions(options.paymentDetails);

  if (options.signature) {
    assert(Buffer.isBuffer(options.signature));
    this.signature = options.signature;
  }

  if (options.chain)
    this.setChain(options.chain);

  return this;
};

/**
 * Instantiate payment request from options.
 * @param {Object} options
 * @returns {PaymentRequest}
 */

PaymentRequest.fromOptions = function fromOptions(options) {
  return new PaymentRequest().fromOptions(options);
};

/**
 * Inject properties from serialized data.
 * @private
 * @param {Buffer} data
 * @returns {PaymentRequest}
 */

PaymentRequest.prototype.fromRaw = function fromRaw(data) {
  const br = new ProtoReader(data);

  this.version = br.readFieldU32(1, true);
  this.pkiType = br.readFieldString(2, true);
  this.pkiData = br.readFieldBytes(3, true);
  this.paymentDetails.fromRaw(br.readFieldBytes(4));
  this.signature = br.readFieldBytes(5, true);

  return this;
};

/**
 * Instantiate payment request from serialized data.
 * @param {Buffer} data
 * @returns {PaymentRequest}
 */

PaymentRequest.fromRaw = function fromRaw(data, enc) {
  if (typeof data === 'string')
    data = Buffer.from(data, enc);
  return new PaymentRequest().fromRaw(data);
};

/**
 * Serialize the payment request (protobuf).
 * @returns {Buffer}
 */

PaymentRequest.prototype.toRaw = function toRaw() {
  const bw = new ProtoWriter();

  if (this.version !== -1)
    bw.writeFieldU32(1, this.version);

  if (this.pkiType != null)
    bw.writeFieldString(2, this.pkiType);

  if (this.pkiData)
    bw.writeFieldBytes(3, this.pkiData);

  bw.writeFieldBytes(4, this.paymentDetails.toRaw());

  if (this.signature)
    bw.writeFieldBytes(5, this.signature);

  return bw.render();
};

/**
 * Get payment request signature algorithm.
 * @returns {Object|null}
 */

PaymentRequest.prototype.getAlgorithm = function getAlgorithm() {
  if (!this.pkiType)
    throw new Error('No PKI type available.');

  const parts = this.pkiType.split('+');

  if (parts.length !== 2)
    throw new Error('Could not parse PKI algorithm.');

  if (parts[0] !== 'x509')
    throw new Error(`Unknown PKI type: ${parts[0]}.`);

  if (parts[1] !== 'sha1' && parts[1] !== 'sha256')
    throw new Error(`Unknown hash algorithm: ${parts[1]}.`);

  return new Algorithm(parts[0], parts[1]);
};

/**
 * Serialize payment request for sighash.
 * @returns {Buffer}
 */

PaymentRequest.prototype.signatureData = function signatureData() {
  const signature = this.signature;

  this.signature = Buffer.alloc(0);

  const data = this.toRaw();

  this.signature = signature;

  return data;
};

/**
 * Get signature hash.
 * @returns {Hash}
 */

PaymentRequest.prototype.signatureHash = function signatureHash() {
  const alg = this.getAlgorithm();
  return digest.hash(alg.hash, this.signatureData());
};

/**
 * Set x509 certificate chain.
 * @param {Buffer[]} chain
 */

PaymentRequest.prototype.setChain = function setChain(chain) {
  const bw = new ProtoWriter();

  assert(Array.isArray(chain), 'Chain must be an array.');

  for (let cert of chain) {
    if (typeof cert === 'string') {
      const pem = PEM.decode(cert);
      assert(pem.type === 'certificate', 'Bad certificate PEM.');
      cert = pem.data;
    }
    assert(Buffer.isBuffer(cert), 'Certificates must be PEM or DER.');
    bw.writeFieldBytes(1, cert);
  }

  this.pkiData = bw.render();
};

/**
 * Get x509 certificate chain.
 * @returns {Buffer[]}
 */

PaymentRequest.prototype.getChain = function getChain() {
  const chain = [];

  if (!this.pkiData)
    return chain;

  const br = new ProtoReader(this.pkiData);

  while (br.nextTag() === 1)
    chain.push(br.readFieldBytes(1));

  return chain;
};

/**
 * Sign payment request (chain must be set).
 * @param {Buffer} key
 * @param {Buffer[]?} certs
 */

PaymentRequest.prototype.sign = function sign(key, certs) {
  if (certs)
    this.setChain(certs);

  if (!this.pkiType)
    this.pkiType = 'x509+sha256';

  const alg = this.getAlgorithm();
  const msg = this.signatureData();
  const chain = this.getChain();

  this.signature = x509.signSubject(alg.hash, msg, key, chain);
};

/**
 * Verify payment request signature.
 * @returns {Boolean}
 */

PaymentRequest.prototype.verify = function verify() {
  if (!this.pkiType || this.pkiType === 'none')
    return false;

  if (!this.signature)
    return false;

  let alg;
  try {
    alg = this.getAlgorithm();
  } catch (e) {
    return false;
  }

  const msg = this.signatureData();
  const sig = this.signature;
  const chain = this.getChain();

  try {
    return x509.verifySubject(alg.hash, msg, sig, chain);
  } catch (e) {
    return false;
  }
};

/**
 * Verify x509 certificate chain.
 * @returns {Boolean}
 */

PaymentRequest.prototype.verifyChain = function verifyChain() {
  if (!this.pkiType || this.pkiType === 'none')
    return false;

  try {
    return x509.verifyChain(this.getChain());
  } catch (e) {
    return false;
  }
};

/**
 * Get root certificate authority.
 * @returns {Object|null}
 */

PaymentRequest.prototype.getCA = function getCA() {
  if (!this.pkiType || this.pkiType === 'none')
    throw new Error('No CA found (pkiType).');

  const chain = this.getChain();

  if (chain.length === 0)
    throw new Error('No CA found (chain).');

  const root = x509.parse(chain[chain.length - 1]);

  return new CA(root);
};

/**
 * Algorithm
 * @constructor
 * @ignore
 */

function Algorithm(key, hash) {
  this.key = key;
  this.hash = hash;
}

/**
 * CA
 * @constructor
 * @ignore
 */

function CA(root) {
  this.name = x509.getCAName(root);
  this.trusted = x509.isTrusted(root);
  this.cert = root;
}

/*
 * Expose
 */

module.exports = PaymentRequest;
