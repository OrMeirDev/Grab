// Optional application metadata, independent of captured browser playback context.
const STAGING_ID = '00000000-0000-4000-8000-000000000000';

function applicationUserAgent(value) {
  return String(value || '').replace(/\s(?:Grab|Electron)\/\S+/g, '').trim();
}

function configureApplicationPrivacy(app) {
  app.userAgentFallback = applicationUserAgent(app.userAgentFallback);
}

function configureSessionPrivacy(ses) {
  // Disabling spellcheck alone does not stop Electron's dictionary download.
  ses.setSpellCheckerLanguages([]);
  ses.setSpellCheckerEnabled(false);
  ses.setUserAgent(applicationUserAgent(ses.getUserAgent()));
}

function configureUpdaterPrivacy(updater) {
  // Public electron-updater API; computeFinalHeaders applies these after its random ID.
  // Grab does not publish staged rollouts. The common value identifies no installation.
  updater.requestHeaders = { ...updater.requestHeaders, 'x-user-staging-id': STAGING_ID };
  updater.logger = null; // updater internals must not write IDs, signed asset URLs or headers
}

module.exports = { STAGING_ID, applicationUserAgent, configureApplicationPrivacy, configureSessionPrivacy, configureUpdaterPrivacy };
