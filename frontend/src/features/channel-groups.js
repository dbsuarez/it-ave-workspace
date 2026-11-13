// IT Avenue Workspace - the sidebar's built-in "Personal channels" group (pure; covered by test/channel-groups.test.js).
//
// Personal channels are explicitly marked by the server and remain private to their creator.

function isPersonalChannel(channel, myId) {
  return Boolean(channel.isPersonal) && Number(channel.createdBy) === Number(myId);
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
