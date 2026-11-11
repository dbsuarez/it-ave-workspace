// @mention detection. Usernames may contain spaces and punctuation, so instead
// of tokenising the text we look for "@<username>" for each candidate member.

function isBoundary(char) {
  return char === undefined || !/[A-Za-z0-9_]/.test(char);
}

// Returns the members (objects with `id` and `username`) mentioned in `content`.
// Longer usernames win, so "@ann marie" does not also count as a mention of "ann".
function findMentionedUsers(content, members) {
  if (typeof content !== 'string' || !content.includes('@') || !Array.isArray(members)) return [];
  const text = content.toLowerCase();
  const claimed = [];
  const found = [];
  const candidates = members
    .filter((member) => member && typeof member.username === 'string' && member.username.length > 0)
    .sort((a, b) => b.username.length - a.username.length);

  for (const member of candidates) {
    const needle = `@${member.username.toLowerCase()}`;
    let from = 0;
    let matched = false;
    while (from < text.length) {
      const index = text.indexOf(needle, from);
      if (index === -1) break;
      const end = index + needle.length;
      const before = index === 0 ? undefined : text[index - 1];
      const overlaps = claimed.some(([start, stop]) => index < stop && end > start);
      if (isBoundary(before) && isBoundary(text[end]) && !overlaps) {
        claimed.push([index, end]);
        matched = true;
      }
      from = end;
    }
    if (matched) found.push(member);
  }
  return found;
}

module.exports = { findMentionedUsers };
