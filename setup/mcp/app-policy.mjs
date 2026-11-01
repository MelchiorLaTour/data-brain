// What DataBrain refuses, whatever the app. This is the ONLY place that knows specific apps, and only to say "not read". The readers (app-readers.mjs) choose how to read an app from how it stores data, never from its name.
const NEVER_READ = /password|keychain|wallet|passbook|1password|bitwarden|lastpass|dashlane|keepass|enpass|authenticator/i;
const MESSAGING_BUNDLES = new Set(['com.apple.mail', 'com.apple.mobilesms']);

// -> 'never' (password managers, Keychain, Passwords, Wallet) | 'messages' (mail and messaging apps: not read in this version, even if
// added) | 'ok'.
export function appPolicy(app) {
  if (NEVER_READ.test(`${app.bundleId || ''} ${app.name || ''}`)) return 'never';
  if (MESSAGING_BUNDLES.has(String(app.bundleId || '').toLowerCase())) return 'messages';
  return 'ok';
}

// What status says when such an app is found.
export const MESSAGING_SENTENCE = 'Mail and Messages are not read in this version, to protect your private messages.';

// What status says when an app's dictionary describes people or calendar events (found from the dictionary, never from the app's name).
export const PEOPLE_EVENTS_SENTENCE = 'Contacts and calendars are not read, to protect your private information.';
