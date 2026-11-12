// IT Avenue Workspace - the go-live switch (Pre-launch / Live).
//
// Pre-launch is the relaxed testing mode: a shared test password, clocking from anywhere. Going Live turns the rules on
// together: the shared password goes off (everyone must choose their own at next sign-in) and clocking is limited to the
// office networks. Returning to pre-launch relaxes the clocking rule again but NEVER brings the shared password back
// (that would reset everyone's password): switch that on deliberately from the sign-up card if you ever need it.
// readiness() lists what is not ready, as checks: a `blocker` stops going live, the rest are warnings.
const config = require('./config');

// ctx: { query, prelaunch, secure, proxied }. Pure apart from the queries; covered by test/launch.test.js.
async function readiness({ query, prelaunch, secure, proxied }) {
  const settings = (await query('SELECT go_live FROM moderation_settings WHERE id = 1')).rows[0] || {};
  const networks = (await query('SELECT COUNT(*)::int AS n FROM attendance_networks')).rows[0].n;
  const sharedOn = await prelaunch.isEnabled();
  const secret = String(config.JWT_SECRET || '');
  const checks = [
    { id: 'shared_password', ok: !sharedOn, blocker: false, label: 'No shared test password',
      detail: sharedOn ? 'Going live turns it off and makes everyone choose a new password at their next sign-in.' : 'Everyone uses their own password.' },
    { id: 'office_network', ok: networks > 0, blocker: true, label: 'Office network listed for clocking',
      detail: networks > 0 ? `${networks} network${networks === 1 ? '' : 's'} listed.` : 'Add your office network in People > Attendance first, or nobody could clock in once the rule is on.' },
    { id: 'https', ok: Boolean(secure), blocker: false, label: 'Connection is encrypted (https)',
      detail: secure ? 'This page was reached over https.' : 'This page was reached over plain http: passwords and messages cross the network in the clear. See deploy/README.md.' },
    { id: 'proxy_ip', ok: !proxied || Boolean(config.TRUST_PROXY), blocker: false, label: 'Real addresses are recorded behind the proxy',
      detail: !proxied || config.TRUST_PROXY ? 'Clock-in addresses are the people\'s own.' : 'A proxy is in front but TRUST_PROXY is not set, so every address looks like the proxy\'s and the office rule cannot tell them apart. Set TRUST_PROXY=1.' },
    { id: 'secret', ok: secret.length >= 32 && secret !== 'dev-secret-change-me', blocker: false, label: 'Strong signing secret',
      detail: secret.length >= 32 && secret !== 'dev-secret-change-me' ? 'JWT_SECRET is long and not the default.' : 'JWT_SECRET is short or the default: set a long random value in .env.' },
    { id: 'cors', ok: !String(config.CORS_ORIGINS || '').split(',').map((v) => v.trim()).includes('*'), blocker: false, label: 'Web origins are not open to every site',
      detail: 'CORS_ORIGINS should list your own addresses, not *.' },
  ];
  return { live: Boolean(settings.go_live), checks, blockers: checks.filter((c) => !c.ok && c.blocker).map((c) => c.id) };
}

module.exports = { readiness };
