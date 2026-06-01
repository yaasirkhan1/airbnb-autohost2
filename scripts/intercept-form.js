// Loads Magic Form Builder directly (bypasses Wix headless detection).
// Run: node scripts/intercept-form.js
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

// The Magic Form Builder widget URL with the Peachtree Towers instance ID
// (extracted from Wix page model JSON — appDefinitionId 13a953c0)
const FORM_URL = 'https://wix.magicformbuilder.com/form?instanceId=13af29cc-61bc-becc-49f8-129e6d2cf8f8&appDefinitionId=13a953c0-ec89-35d3-5339-d8432d7a1a03&locale=en&deviceType=desktop';

const REAL_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const TEST_DATA = [
  'scherkhan15@gmail.com',  // email
  '7B',                     // unit
  '06/11/2026',             // arrival date
  '3:00 PM',                // arrival time
  '07/19/2026',             // departure
  '2',                      // guests
  'Yasser Khan',            // guest name
  '4045550001',             // phone
  'Yasser Khan',            // signature
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('Launching real Chrome...');
  const browser = await puppeteer.launch({
    executablePath: REAL_CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=900,900'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 900 });

  // Capture ALL requests + responses
  const requests = [];
  await page.setRequestInterception(true);
  page.on('request', req => {
    requests.push({ url: req.url(), method: req.method(), postData: req.postData(), headers: req.headers() });
    req.continue();
  });

  page.on('response', async res => {
    const url = res.url();
    if (url.includes('magicform') || url.includes('form')) {
      try {
        const body = await res.text();
        if (body.length < 20000) {
          console.log(`\nRESPONSE [${res.status()}] ${url.slice(0, 100)}`);
          console.log(body.slice(0, 800));
        }
      } catch (_) {}
    }
  });

  console.log('Loading form:', FORM_URL);
  try {
    await page.goto(FORM_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  } catch (e) {
    console.log('Timeout/nav error (continuing):', e.message.slice(0, 80));
  }
  await sleep(4000);

  await page.screenshot({ path: '/tmp/form-direct.png', fullPage: true });
  console.log('Screenshot: /tmp/form-direct.png');

  // Dump all fields
  const fields = await page.evaluate(() =>
    [...document.querySelectorAll('input, textarea, select')].map((el, i) => ({
      i, tag: el.tagName, type: el.type, name: el.name,
      id: el.id, placeholder: el.placeholder,
      label: document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim() || el.getAttribute('aria-label') || '',
      value: el.value,
    }))
  );
  console.log(`\n=== ${fields.length} fields ===`);
  fields.forEach(f => console.log(`  [${f.i}] ${f.tag}[${f.type}] name="${f.name}" placeholder="${f.placeholder}" label="${f.label}"`));

  if (fields.length === 0) {
    console.log('\nNo fields found — page source:');
    const src = await page.evaluate(() => document.body?.innerHTML || '');
    console.log(src.slice(0, 2000));

    console.log('\nAll API requests:');
    requests.filter(r => r.url.includes('magicform') || r.url.includes('form')).forEach(r => {
      console.log(`  [${r.method}] ${r.url}`);
      if (r.postData) console.log(`    body: ${r.postData.slice(0, 300)}`);
    });

    await browser.close();
    process.exit(1);
  }

  // Fill
  const handles = await page.$$('input:not([type=hidden]):not([type=submit]):not([type=checkbox]):not([type=radio]):not([type=button]), textarea');
  console.log('\nFilling...');
  for (let i = 0; i < Math.min(handles.length, TEST_DATA.length); i++) {
    try {
      await handles[i].focus();
      await handles[i].click({ clickCount: 3 });
      await page.evaluate(el => { el.value = ''; }, handles[i]);
      await handles[i].type(TEST_DATA[i], { delay: 30 });
      const got = await page.evaluate(el => el.value, handles[i]);
      console.log(`  [${i}] → "${got}"`);
    } catch (e) {
      console.log(`  [${i}] error: ${e.message}`);
    }
  }

  await page.screenshot({ path: '/tmp/form-filled.png', fullPage: true });

  // Clear requests, then submit
  requests.length = 0;

  const btns = await page.$$('button, input[type=submit]');
  let clicked = false;
  for (const b of btns) {
    const txt = await page.evaluate(el => (el.textContent || el.value || '').trim(), b);
    console.log(`\nButton: "${txt}"`);
    if (/submit|send|register|save/i.test(txt) || btns.length === 1) {
      await b.click();
      clicked = true;
      break;
    }
  }
  if (!clicked) { await page.keyboard.press('Enter'); }

  await sleep(8000);
  await page.screenshot({ path: '/tmp/form-submitted.png', fullPage: true });

  // Results
  const posts = requests.filter(r => r.method === 'POST');
  const formReqs = requests.filter(r => r.url.includes('magicform') || r.url.includes('submit') || r.url.includes('response'));

  console.log('\n\n╔═══════════════════════════════════╗');
  console.log('║      SUBMISSION REQUESTS          ║');
  console.log('╚═══════════════════════════════════╝');
  console.log(`POSTs: ${posts.length}  |  Form-related: ${formReqs.length}\n`);

  [...new Set([...posts, ...formReqs])].forEach((r, i) => {
    console.log(`\n█ ${i + 1}. [${r.method}] ${r.url}`);
    console.log(`   Content-Type: ${r.headers['content-type'] || ''}`);
    if (r.postData) console.log(`   Body: ${r.postData.slice(0, 2000)}`);
  });

  if (posts.length === 0 && formReqs.length === 0) {
    console.log('No form submission requests. All requests after clicking submit:');
    requests.forEach(r => console.log(`  [${r.method}] ${r.url.slice(0, 120)}`));
  }

  await browser.close();
  console.log('\nDone. Screenshots: /tmp/form-*.png');
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
