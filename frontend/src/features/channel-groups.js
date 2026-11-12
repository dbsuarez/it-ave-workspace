// IT Avenue Workspace - the sidebar's built-in "Personal channels" group (pure; covered by test/channel-groups.test.js).
//
// A channel you created that nobody else is in yet is personal: it shows under "Personal channels" instead of
// "Channels". The moment someone else joins or is added, it moves up to "Channels" by itself.

function isPersonalChannel(channel, myId) {
  return Number(channel.createdBy) === Number(myId) && Number(channel.memberCount || 0) <= 1;
}

// { shared, personal } with the order kept.
function splitPersonalChannels(channels, myId) {
  const shared = [];
  const personal = [];
  for (const channel of channels) (isPersonalChannel(channel, myId) ? personal : shared).push(channel);
  return { shared, personal };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { isPersonalChannel, splitPersonalChannels };
}
