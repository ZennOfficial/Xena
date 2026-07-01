const crypto = require('crypto');
const { logger } = require('./logger');

function sanitize(input) {
  return String(input)
    .replace(/[<>]/g, '') // remove HTML tags
    .replace(/[\r\n]/g, ' ') // remove newlines
    .slice(0, 250); // limit to 250 characters
}

function generateRandomString(length = 8) {
  return crypto.randomBytes(length).toString('hex');
}

function isValidPhoneNumber(number) {
  const clean = number.replace(/\D/g, '');
  return clean.startsWith('0') || clean.length < 8 ? null : clean;
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}h ${m}m ${s}s`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waiting(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isValidBaileysCreds(jsonData) {
  if (typeof jsonData !== 'object' || jsonData === null) return false;

  const requiredKeys = [
    'noiseKey',
    'signedIdentityKey',
    'signedPreKey',
    'registrationId',
    'advSecretKey',
    'signalIdentities'
  ];

  return requiredKeys.every(key => key in jsonData);
}

async function downloadToBuffer(url) {
  try {
    const axios = require('axios');
    const response = await axios.get(url, {
      responseType: 'arraybuffer'
    });
    return Buffer.from(response.data);
  } catch (error) {
    logger.error(`Download error: ${error.message}`);
    throw error;
  }
}

module.exports = {
  sanitize,
  generateRandomString,
  isValidPhoneNumber,
  formatUptime,
  sleep,
  waiting,
  isValidBaileysCreds,
  downloadToBuffer
};