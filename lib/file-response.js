'use strict';

const INLINE_TYPES = new Set([
  'image/avif', 'image/bmp', 'image/gif', 'image/jpeg', 'image/png', 'image/webp',
  'video/mp4', 'video/mpeg', 'video/ogg', 'video/quicktime', 'video/webm', 'video/x-matroska',
  'video/x-msvideo', 'video/x-ms-wmv',
  'audio/aac', 'audio/aiff', 'audio/flac', 'audio/mp4', 'audio/midi', 'audio/mpeg', 'audio/ogg',
  'audio/wav', 'audio/webm', 'audio/x-ms-wma',
  'application/pdf'
]);

function fileDelivery(requestInline, contentType) {
  const type = String(contentType || '').split(';', 1)[0].trim().toLowerCase();
  const safeInline = INLINE_TYPES.has(type);
  return {
    inline: !!requestInline && safeInline,
    contentType: safeInline ? type : 'application/octet-stream'
  };
}

module.exports = { fileDelivery };
