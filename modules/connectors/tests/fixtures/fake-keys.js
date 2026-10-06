module.exports = {
  // Runtime-built high-entropy fixture values to validate secret redaction logic
  // without using real credentials. These are intentionally synthetic and safe.
  fakeKeyLikeValues: [
    'AKIAIOSFODNN7EXAMPLE1234567890abcdef',
    'ghp_1234567890abcdefghijklmnopqrstuvwx',
    'xoxb-123456789012-abcdefghijklmnopqrstuv',
    'AIzaSyA1b2C3d4E5f6G7h8J9k0L1m2N3o4P5q6R7s8T9u0V1w2X3Y4Z5',
    'sk_live_0123456789abcdef0123456789abcdef01234567',
  ],
};
