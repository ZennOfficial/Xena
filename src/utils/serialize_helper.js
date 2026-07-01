/**
 * Helper untuk menangani circular reference saat serialize
 */

// Fungsi untuk menghapus circular reference dari objek
function removeCircularReferences(obj) {
  const seen = new WeakSet();
  
  return JSON.stringify(obj, (key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '[Circular]';
      }
      seen.add(value);
    }
    return value;
  });
}

// Fungsi safe stringify untuk menghindari circular reference
function safeStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch (err) {
    if (err.message.includes('circular')) {
      return removeCircularReferences(obj);
    }
    throw err;
  }
}

module.exports = {
  removeCircularReferences,
  safeStringify
};