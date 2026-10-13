'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { resolveEmbed } = require('../lib/live');

const redirects = (map) => async (u) => ({ headers: { get: (k) => (k === 'location' ? map[u] || null : null) } });
const offline = async () => { throw new Error('hors ligne'); };

test('Direct : tous les liens TikTok sont reconnus (vidéo, photo, lien court du téléphone, LIVE)', async () => {
  const id = '7412345678901234567', embed = `https://www.tiktok.com/embed/v2/${id}`;
  assert.equal((await resolveEmbed(`https://www.tiktok.com/@ecole/video/${id}?is_from_webapp=1`, offline)).src, embed);
  assert.equal((await resolveEmbed(`https://m.tiktok.com/@ecole/photo/${id}`, offline)).src, embed);
  assert.equal((await resolveEmbed('https://vm.tiktok.com/ZMh1/', redirects({ 'https://vm.tiktok.com/ZMh1/': `https://www.tiktok.com/@ecole/video/${id}?_r=1` }))).src, embed);
  assert.equal((await resolveEmbed('https://www.tiktok.com/t/ZT2/', redirects({ 'https://www.tiktok.com/t/ZT2/': `/@ecole/video/${id}` }))).src, embed);
  const live = await resolveEmbed('https://www.tiktok.com/@ecole/live', offline);
  assert.equal(live.link, 'https://www.tiktok.com/@ecole/live');
  assert.ok(!live.src);
  // Lien court impossible à suivre, ou qui redirige hors de TikTok : bouton vers TikTok, jamais vers un autre site
  assert.equal((await resolveEmbed('https://vm.tiktok.com/ZMx/', offline)).link, 'https://vm.tiktok.com/ZMx/');
  assert.equal((await resolveEmbed('https://vm.tiktok.com/ZMy/', redirects({ 'https://vm.tiktok.com/ZMy/': 'https://pirate.example/' }))).link, 'https://vm.tiktok.com/ZMy/');
  assert.equal(await resolveEmbed('https://exemple.com/video', offline), null);
});
