// Avatar choices: an emoji (or your initials) on a background color. Loaded by the browser
// (<script>) and by the server (require) so both accept the same choices.
(function (root) {
  'use strict';

  const COLORS = {
    blue: '#183890', gold: '#d99b00', red: '#c62828', green: '#15803d',
    purple: '#7c3aed', pink: '#c2189b', teal: '#0f766e', gray: '#4b5563'
  };
  const EMOJIS = [
    '🐎', '🦅', '🐺', '🦊', '🐻', '🐱', '🐶', '🐼', '🐸', '🦁', '🐯', '🐙', '🦋', '🐢', '🐧', '🦈',
    '⚽', '🏀', '🏈', '⚾', '🎾', '🏐', '🏒', '🏊', '🎸', '🎹', '🥁', '🎨', '🎭', '📚', '🔬', '💻',
    '🎮', '🎧', '📷', '🌟', '🔥', '🌈', '🍕', '☕'
  ];
  const DEFAULT = { emoji: '', color: 'blue' };

  // Untrusted input -> a valid avatar.
  function clean(a) {
    const src = a && typeof a === 'object' ? a : {};
    return {
      emoji: EMOJIS.includes(src.emoji) ? src.emoji : '',
      color: Object.prototype.hasOwnProperty.call(COLORS, src.color) ? src.color : DEFAULT.color
    };
  }
  // 'Ann L.' -> 'AL'
  function initials(name) {
    const parts = String(name || '').replace(/[^\p{L}\p{N} ]/gu, '').trim().split(/\s+/).filter(Boolean);
    return ((parts[0] ? Array.from(parts[0])[0] : '?') + (parts[1] ? Array.from(parts[1])[0] : '')).toUpperCase();
  }

  const api = { COLORS, EMOJIS, DEFAULT, clean, initials };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MHSAvatars = api;
})(typeof window !== 'undefined' ? window : globalThis);
