const test = require('node:test');
const assert = require('node:assert/strict');
const { formatRichText } = require('../src/features/format');

const context = { usernames: ['ann', 'ann marie', 'bob'], me: 'bob', channels: [{ id: 7, name: 'welcome' }, { id: 12, name: 'hr-inquiry' }] };
const format = (text) => formatRichText(text, context);

test('plain text is escaped and otherwise unchanged', () => {
  assert.equal(format('1 < 2 && "x"'), '1 &lt; 2 &amp;&amp; &quot;x&quot;');
  assert.equal(format('line one\nline two'), 'line one\nline two');
});

test('emphasis, strikethrough, and inline code', () => {
  assert.equal(format('**bold** and *it* and _it_ and ~~gone~~'),
    '<strong>bold</strong> and <em>it</em> and <em>it</em> and <s>gone</s>');
  assert.equal(format('use `a*b*c` here'), 'use <code class="message-code">a*b*c</code> here');
  assert.equal(format('snake_case_name and 2*3*4'), 'snake_case_name and 2*3*4');
});

test('quotes, bullet lists, and numbered lists', () => {
  assert.equal(format('> first\n> second\nafter'),
    '<blockquote class="message-quote">first<br>second</blockquote>after');
  assert.equal(format('- one\n- **two**'),
    '<ul class="message-list"><li>one</li><li><strong>two</strong></li></ul>');
  assert.equal(format('1. a\n2. b'), '<ol class="message-list"><li>a</li><li>b</li></ol>');
});

test('fenced code blocks keep their content literal', () => {
  assert.equal(format('before\n```\n**not bold** <b>\n```\nafter'),
    'before\n<pre class="message-code-block"><code>**not bold** &lt;b&gt;</code></pre>\nafter');
});

test('links are only made from http(s) URLs', () => {
  assert.equal(format('see https://example.com/a?b=1&c=2.'),
    'see <a class="message-link" href="https://example.com/a?b=1&amp;c=2" data-external-link target="_blank" rel="noopener noreferrer">https://example.com/a?b=1&amp;c=2</a>.');
  assert.equal(format('javascript:alert(1) and file:///c:/x'), 'javascript:alert(1) and file:///c:/x');
});

test('mentions are highlighted, with a marker for mentions of the viewer', () => {
  assert.equal(format('hi @ann marie and @bob'),
    'hi <span class="mention">@ann marie</span> and <span class="mention mention-me">@bob</span>');
});

test('known channel names become clickable shortcuts and unknown hashtags stay plain', () => {
  assert.equal(format('Go to #welcome or #hr-inquiry, not #missing.'),
    'Go to <button type="button" class="message-channel-link" data-channel-shortcut="7">#welcome</button> or <button type="button" class="message-channel-link" data-channel-shortcut="12">#hr-inquiry</button>, not #missing.');
  assert.equal(format('prefix#welcome and #welcome-extra'), 'prefix#welcome and #welcome-extra');
});

test('markup in user text can never become a tag or an attribute', () => {
  const attacks = [
    '<img src=x onerror=alert(1)>',
    '**<script>alert(1)</script>**',
    'https://example.com/"onmouseover="alert(1)',
    '`<b>`',
    '> <iframe src=javascript:alert(1)>',
    '- <svg onload=alert(1)>',
    '```</code></pre><script>alert(1)</script>```',
    '@ann<script>',
  ];
  for (const attack of attacks) {
    const html = format(attack);
    const tags = html.match(/<\/?([a-z]+)/gi) || [];
    for (const tag of tags) {
      assert.match(tag, /^<\/?(strong|em|s|code|pre|blockquote|ul|ol|li|br|a|span)$/i, `${attack} produced ${tag}`);
    }
    assert.doesNotMatch(html, /<[^>]*\son\w+=/i, `${attack} produced an event handler`);
    assert.doesNotMatch(html, /href="(?!https?:\/\/)/i, `${attack} produced a non-http link`);
  }
});
