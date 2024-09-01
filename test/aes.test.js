const { deepStrictEqual, throws } = require('assert');
const { should, describe } = require('micro-should');
const crypto = require('node:crypto');
const { hex } = require('@scure/base');
const { concatBytes } = require('../utils.js');
const { ecb, cbc, ctr, siv, gcm, aeskw, aeskwp } = require('../aes.js');
// https://datatracker.ietf.org/doc/html/rfc8452#appendix-C
const NIST_VECTORS = require('./vectors/nist_800_38a.json');
const VECTORS = require('./vectors/siv.json');
const aes_gcm_test = require('./wycheproof/aes_gcm_test.json');
const aes_gcm_siv_test = require('./wycheproof/aes_gcm_siv_test.json');
const aes_cbc_test = require('./wycheproof/aes_cbc_pkcs5_test.json');
const aes_kw_test = require('./wycheproof/aes_wrap_test.json');
const aes_kwp_test = require('./wycheproof/aes_kwp_test.json');

// https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38a.pdf

const CIPHERS = { ecb, cbc, ctr, siv, gcm };

describe('AES', () => {
  should('CTR', () => {
    const nodeAES = (name) => ({
      encrypt: (buf, opts) =>
        Uint8Array.from(crypto.createCipheriv(name, opts.key, opts.nonce).update(buf)),
      decrypt: (buf, opts) =>
        Uint8Array.from(crypto.createDecipheriv(name, opts.key, opts.nonce).update(buf)),
    });
    // MDN says counter should be 64 bit
    // https://developer.mozilla.org/en-US/docs/Web/API/AesCtrParams
    // and links NIST SP800-38A which actually says in B.1 that standard increment function
    // uses all bits, so 128 bit counter. Which is the same as in OpenSSL.
    const key = new Uint8Array(32).fill(32);
    const msg = new Uint8Array(64).fill(64);
    const nonces = [
      new Uint8Array(16).fill(1),
      // 64 bit
      concatBytes(new Uint8Array(8), new Uint8Array(8).fill(255)),
      concatBytes(new Uint8Array(8).fill(255), new Uint8Array(8)),
      // 32 bit
      concatBytes(new Uint8Array(12), new Uint8Array(4).fill(255)),
      concatBytes(new Uint8Array(4).fill(255), new Uint8Array(12)),
      new Uint8Array(16).fill(255), // this wraps in 128 bit
    ];
    // So, current behaviour seems reasonable.
    // We don't have variable counter length at web version for now, but it works.
    for (const nonce of nonces) {
      const nodeVal = nodeAES('aes-256-ctr').encrypt(msg, { key, nonce });
      const c = ctr(key, nonce);
      deepStrictEqual(c.encrypt(msg), nodeVal);
      deepStrictEqual(c.decrypt(nodeVal), msg);
    }
  });
  describe('NIST 800-38a', () => {
    for (const t of NIST_VECTORS) {
      should(`${t.name}`, () => {
        let c;
        const cipher = CIPHERS[t.cipher];
        if (t.iv) c = cipher(hex.decode(t.key), hex.decode(t.iv || ''), { disablePadding: true });
        else c = cipher(hex.decode(t.key), { disablePadding: true });
        const ciphertext = concatBytes(...t.blocks.map((i) => hex.decode(i.ciphertext)));
        const plaintext = concatBytes(...t.blocks.map((i) => hex.decode(i.plaintext)));
        deepStrictEqual(c.decrypt(ciphertext), plaintext);
        deepStrictEqual(c.encrypt(plaintext), ciphertext);
      });
    }
  });
  describe('GCM-SIV', () => {
    for (const flavor of ['aes128', 'aes256', 'counterWrap']) {
      for (let i = 0; i < VECTORS[flavor].length; i++) {
        const v = VECTORS[flavor][i];
        should(`${flavor}(${i}).encrypt`, () => {
          let a = siv(hex.decode(v.key), hex.decode(v.nonce), hex.decode(v.AAD));
          deepStrictEqual(a.encrypt(hex.decode(v.plaintext)), hex.decode(v.result));
        });
        should(`${flavor}(${i}).decrypt`, () => {
          let a = siv(hex.decode(v.key), hex.decode(v.nonce), hex.decode(v.AAD));
          deepStrictEqual(a.decrypt(hex.decode(v.result)), hex.decode(v.plaintext));
        });
      }
    }
  });

  describe('Wycheproof', () => {
    const cases = [
      { name: 'GCM-SIV', groups: aes_gcm_siv_test.testGroups, cipher: 'siv' },
      { name: 'GCM', groups: aes_gcm_test.testGroups, cipher: 'gcm' },
      { name: 'CBC', groups: aes_cbc_test.testGroups, cipher: 'cbc' }, // PCKS5 is enabled by default
    ];
    for (const c of cases) {
      for (const g of c.groups) {
        const name = `Wycheproof/${c.name}/${g.ivSize}/${g.keySize}/${g.tagSize}/${g.type}`;
        for (let i = 0; i < g.tests.length; i++) {
          const t = g.tests[i];
          should(`${name}: ${i}`, () => {
            const ct = concatBytes(hex.decode(t.ct), hex.decode(t.tag || ''));
            const msg = hex.decode(t.msg);
            const cipher = CIPHERS[c.cipher];
            if (t.result === 'valid') {
              if (t.flags.includes('SmallIv')) return; // skip test, we don't support iv < 8b
              const a = cipher(hex.decode(t.key), hex.decode(t.iv), hex.decode(t.aad || ''));
              const ct = concatBytes(hex.decode(t.ct), hex.decode(t.tag || ''));
              deepStrictEqual(a.decrypt(ct), msg);
              deepStrictEqual(a.encrypt(msg), ct);
            } else {
              throws(() =>
                cipher(hex.decode(t.key), hex.decode(t.iv), hex.decode(t.aad || '')).decrypt(ct)
              );
            }
          });
        }
      }
    }
  });
  describe('AESKW', () => {
    should('RFC3394', () => {
      // https://www.rfc-editor.org/rfc/rfc3394#section-4.1
      const vectors = [
        // 4.1 Wrap 128 bits of Key Data with a 128-bit KEK
        {
          KEK: hex.decode('000102030405060708090A0B0C0D0E0F'),
          KeyData: hex.decode('00112233445566778899AABBCCDDEEFF'),
          Ciphertext: hex.decode('1FA68B0A8112B447AEF34BD8FB5A7B829D3E862371D2CFE5'),
        },
        // 4.2 Wrap 128 bits of Key Data with a 192-bit KEK
        {
          KEK: hex.decode('000102030405060708090A0B0C0D0E0F1011121314151617'),
          KeyData: hex.decode('00112233445566778899AABBCCDDEEFF'),
          Ciphertext: hex.decode('96778B25AE6CA435F92B5B97C050AED2468AB8A17AD84E5D'),
        },
        // 4.3 Wrap 128 bits of Key Data with a 256-bit KEK
        {
          KEK: hex.decode('000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F'),
          KeyData: hex.decode('00112233445566778899AABBCCDDEEFF'),
          Ciphertext: hex.decode('64E8C3F9CE0F5BA263E9777905818A2A93C8191E7D6E8AE7'),
        },
        // 4.4 Wrap 192 bits of Key Data with a 192-bit KEK
        {
          KEK: hex.decode('000102030405060708090A0B0C0D0E0F1011121314151617'),
          KeyData: hex.decode('00112233445566778899AABBCCDDEEFF0001020304050607'),
          Ciphertext: hex.decode(
            '031D33264E15D33268F24EC260743EDCE1C6C7DDEE725A936BA814915C6762D2'
          ),
        },
        // 4.5 Wrap 192 bits of Key Data with a 256-bit KEK
        {
          KEK: hex.decode('000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F'),
          KeyData: hex.decode('00112233445566778899AABBCCDDEEFF0001020304050607'),
          Ciphertext: hex.decode(
            'A8F9BC1612C68B3FF6E6F4FBE30E71E4769C8B80A32CB8958CD5D17D6B254DA1'
          ),
        },
        // 4.6 Wrap 256 bits of Key Data with a 256-bit KEK
        {
          KEK: hex.decode('000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F'),
          KeyData: hex.decode('00112233445566778899AABBCCDDEEFF000102030405060708090A0B0C0D0E0F'),
          Ciphertext: hex.decode(
            '28C9F404C4B810F4CBCCB35CFB87F8263F5786E2D80ED326CBC7F0E71A99F43BFB988B9B7A02DD21'
          ),
        },
      ];
      for (const t of vectors) {
        const kw = aeskw(t.KEK);
        deepStrictEqual(kw.encrypt(t.KeyData), t.Ciphertext);
        deepStrictEqual(kw.decrypt(t.Ciphertext), t.KeyData);
      }
    });
    should('Wycheproof', () => {
      for (const group of aes_kw_test.testGroups) {
        for (const t of group.tests) {
          const kw = aeskw(hex.decode(t.key));
          // 8-byte keys considered 'acceptable' by Wychenproof, but seems like bug.
          if (t.flags.includes('ShortKey')) continue;
          if (t.result === 'valid' || t.result === 'acceptable') {
            deepStrictEqual(hex.encode(kw.encrypt(hex.decode(t.msg))), t.ct);
            deepStrictEqual(hex.encode(kw.decrypt(hex.decode(t.ct))), t.msg);
          } else {
            throws(() => kw.decrypt(hex.decode(t.ct)));
            throws(() => deepStrictEqual(kw.encrypt(hex.decode(t.msg)), hex.decode(t.ct)));
          }
        }
      }
    });
    should('KWP', () => {
      // https://www.rfc-editor.org/rfc/rfc5649
      const vectors = [
        {
          KEK: hex.decode('5840df6e29b02af1ab493b705bf16ea1ae8338f4dcc176a8'),
          Key: hex.decode('c37b7e6492584340bed12207808941155068f738'),
          Wrap: hex.decode('138bdeaa9b8fa7fc61f97742e72248ee5ae6ae5360d1ae6a5f54f373fa543b6a'),
        },
        {
          KEK: hex.decode('5840df6e29b02af1ab493b705bf16ea1ae8338f4dcc176a8'),
          Key: hex.decode('466f7250617369'),
          Wrap: hex.decode('afbeb0f07dfbf5419200f2ccb50bb24f'),
        },
      ];
      for (const t of vectors) {
        const kwp = aeskwp(t.KEK);
        deepStrictEqual(kwp.encrypt(t.Key), t.Wrap);
        deepStrictEqual(kwp.decrypt(t.Wrap), t.Key);
      }
    });
    should('AESKWP: Wycheproof', () => {
      for (const group of aes_kwp_test.testGroups) {
        for (const t of group.tests) {
          const kwp = aeskwp(hex.decode(t.key));
          if (t.result === 'valid' || t.result === 'acceptable') {
            deepStrictEqual(hex.encode(kwp.encrypt(hex.decode(t.msg))), t.ct);
            deepStrictEqual(hex.encode(kwp.decrypt(hex.decode(t.ct))), t.msg);
          } else {
            throws(() => kwp.decrypt(hex.decode(t.ct)), 'decrypt');
            throws(() => deepStrictEqual(kwp.encrypt(hex.decode(t.msg)), hex.decode(t.ct)));
          }
        }
      }
    });
  });
});

if (require.main === module) should.run();
