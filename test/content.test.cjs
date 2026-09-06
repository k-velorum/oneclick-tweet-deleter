const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { JSDOM } = require('jsdom');
const source = readFileSync('content.js', 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 40));
const tweet = (author, id, body = '') => `<article data-testid="tweet"><div data-testid="User-Name"><a href="/${author}/status/${id}"><time>today</time></a></div><div><button data-testid="caret">More</button></div>${body}</article>`;

function setup({ author = 'me', profile = 'me', body = '', heading = 'ポストを削除しますか？', label = '削除', cancelLabel = 'キャンセル', menuLabel = '削除', beforeSheet = () => {} } = {}) {
  const dom = new JSDOM(`<a data-testid="AppTabBar_Profile_Link" href="/${profile}">Profile</a>${tweet(author, '123', body)}`, { url: 'https://x.com/home', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const { document } = window;
  window.requestAnimationFrame = callback => window.setTimeout(callback, 0);
  window.HTMLElement.prototype.getClientRects = function () { return this.isConnected ? [{}] : []; };
  const state = { deletes: 0, opens: 0 };
  document.querySelector('[data-testid="caret"]').onclick = () => {
    state.opens++;
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `<button role="menuitem">${menuLabel}</button>`;
    menu.firstChild.onclick = () => {
      menu.remove();
      beforeSheet(document);
      const sheet = document.createElement('div');
      sheet.dataset.testid = 'confirmationSheetDialog';
      sheet.setAttribute('role', 'alertdialog');
      sheet.innerHTML = `<h1>${heading}</h1><button data-testid="confirmationSheetConfirm">${label}</button><button data-testid="confirmationSheetCancel">${cancelLabel}</button>`;
      state.originalLabel = sheet.querySelector('[data-testid="confirmationSheetConfirm"]').firstElementChild;
      sheet.querySelector('[data-testid="confirmationSheetConfirm"]').onclick = () => { state.deletes++; sheet.remove(); };
      sheet.querySelector('[data-testid="confirmationSheetCancel"]').onclick = () => sheet.remove();
      document.body.append(sheet);
    };
    document.body.append(menu);
  };
  window.eval(source);
  return {
    document, window, state,
    click(shiftKey = false) { document.querySelector('.octd-delete').dispatchEvent(new window.MouseEvent('click', { bubbles: true, shiftKey })); },
    key(key) { document.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key })); },
    close() { window.close(); }
  };
}

test('own posts only, case-insensitive identity, unknown account hidden', async t => {
  for (const [author, profile, count] of [['me', 'me', 1], ['Me', 'ME', 1], ['other', 'me', 0], ['me', '', 0]]) {
    const app = setup({ author, profile });
    assert.equal(app.document.querySelectorAll('.octd-delete').length, count);
    app.close();
  }
});

test('embedded own quote does not make someone else’s post deletable', () => {
  const app = setup({ author: 'other', body: tweet('me', '456') });
  assert.equal(app.document.querySelector('article > div > .octd-delete'), null);
  app.close();
});

for (const key of ['n', 'Escape']) test(`normal click and ${key} cancel without deleting`, async () => {
  const app = setup();
  app.click();
  await tick();
  assert.equal(app.state.deletes, 0);
  assert.equal(app.document.querySelector('[data-testid="confirmationSheetConfirm"]').textContent, '削除 Y');
  assert.equal(app.document.activeElement.dataset.testid, 'confirmationSheetCancel');
  app.key(key);
  await tick();
  assert.equal(app.state.deletes, 0);
  assert.equal(app.document.querySelector('[role="alertdialog"]'), null);
  app.key('y');
  assert.equal(app.state.deletes, 0);
  app.close();
});

test('normal click requires Y, and sends only one deletion', async () => {
  const app = setup();
  app.click(); await tick();
  app.key('y'); await tick(); app.key('y');
  assert.equal(app.state.deletes, 1);
  app.close();
});

test('Shift bypasses confirmation and duplicate clicks are ignored', async () => {
  const app = setup();
  app.click(true); app.click(true); await tick();
  assert.equal(app.state.deletes, 1);
  assert.equal(app.state.opens, 1);
  app.close();
});

test('English native delete dialog is supported', async () => {
  const app = setup({ menuLabel: 'Delete', label: '<div><span>Delete</span></div>', cancelLabel: '<div><span>Cancel</span></div>', heading: 'Delete post?' });
  app.click(); await tick();
  const confirm = app.document.querySelector('[data-testid="confirmationSheetConfirm"]');
  const cancel = app.document.querySelector('[data-testid="confirmationSheetCancel"]');
  assert.equal(confirm.firstElementChild, app.state.originalLabel);
  assert.equal(confirm.textContent, 'Delete Y');
  assert.equal(cancel.textContent, 'Cancel N');
  assert.equal(confirm.getAttribute('aria-keyshortcuts'), 'Y');
  assert.equal(confirm.getAttribute('aria-label'), null);
  app.key('y'); await tick();
  assert.equal(app.state.deletes, 1);
  app.close();
});

test('unrelated confirmation sharing X test ids is never confirmed', async () => {
  const app = setup({ heading: 'Block account?' });
  app.click(true); await tick();
  assert.equal(app.state.deletes, 0);
  assert.match(app.document.querySelector('.octd-notice').textContent, /識別できなかった/);
  app.close();
});

test('account or post change during automation aborts deletion', async () => {
  for (const beforeSheet of [
    d => d.querySelector('[data-testid="AppTabBar_Profile_Link"]').setAttribute('href', '/other'),
    d => d.querySelector('time').parentElement.setAttribute('href', '/me/status/999')
  ]) {
    const app = setup({ beforeSheet });
    app.click(true); await tick();
    assert.equal(app.state.deletes, 0);
    app.close();
  }
});

test('existing menu prevents automation', async () => {
  const app = setup();
  const menu = app.document.createElement('div'); menu.setAttribute('role', 'menu'); app.document.body.append(menu);
  app.click(true); await tick();
  assert.equal(app.state.opens, 0);
  assert.equal(app.state.deletes, 0);
  app.close();
});

test('missing delete item fails closed', async () => {
  const app = setup({ menuLabel: 'リストから追加/削除' });
  app.click(true); await tick();
  assert.equal(app.state.deletes, 0);
  assert.match(app.document.querySelector('.octd-notice').textContent, /削除項目/);
  app.close();
});

test('dynamic posts, recycled DOM and account changes update buttons without duplication', async () => {
  const app = setup();
  app.document.body.insertAdjacentHTML('beforeend', tweet('me', '456'));
  await tick();
  assert.equal(app.document.querySelectorAll('.octd-delete').length, 2);
  app.document.querySelector('time').parentElement.setAttribute('href', '/other/status/789');
  await tick();
  assert.equal(app.document.querySelectorAll('.octd-delete').length, 1);
  app.document.querySelector('[data-testid="AppTabBar_Profile_Link"]').setAttribute('href', '/other');
  await tick();
  assert.equal(app.document.querySelectorAll('.octd-delete').length, 1);
  app.close();
});

test('account change while Y/N is open also prevents deletion', async () => {
  const app = setup();
  app.click(); await tick();
  app.document.querySelector('[data-testid="AppTabBar_Profile_Link"]').setAttribute('href', '/other');
  app.key('y'); await tick();
  assert.equal(app.state.deletes, 0);
  assert.equal(app.document.querySelector('[role="alertdialog"]'), null);
  app.close();
});

test('detail view timestamp outside author header is supported, quote timestamp excluded', async () => {
  const app = setup();
  const article = app.document.querySelector('article');
  article.querySelector('.octd-delete').remove();
  article.querySelector('[data-testid="User-Name"]').innerHTML = '<a href="/me">Me</a>';
  article.insertAdjacentHTML('beforeend', '<div role="link"><a href="/me/status/999"><time>quoted</time></a></div><a href="/me/status/123"><time>detail</time></a>');
  await tick();
  assert.equal(article.querySelectorAll('.octd-delete').length, 1);
  app.click(true); await tick();
  assert.equal(app.state.deletes, 1);
  app.close();
});
