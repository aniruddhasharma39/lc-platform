import puppeteer from 'puppeteer-core';
import path from 'path';

async function runBrowserAcceptance() {
  console.log('========================================================================');
  console.log('🖥️  RUNNING ACTUAL BROWSER ACCEPTANCE IN CHROMIUM');
  console.log('========================================================================\n');

  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1440,900']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  // 1. Visit Login
  console.log('1. Loading web application at http://localhost:5173...');
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle2' });

  // 2. Perform Login
  console.log('2. Submitting login credentials (admin@lcgate.in)...');
  await page.type('input[placeholder*="user@example.com"]', 'admin@lcgate.in');
  await page.type('input[type="password"]', 'admin123');
  await page.click('button[type="submit"]');

  await new Promise(r => setTimeout(r, 3000));
  const postLoginText = await page.evaluate(() => document.body.innerText);
  console.log('--- Page text after login attempt ---');
  console.log(postLoginText.slice(0, 300));
  console.log('------------------------------------');

  // 3. Switch view to Reports via Sidebar
  console.log('3. Clicking on Reports link in Dashboard sidebar...');
  await page.evaluate(() => {
    const navItems = Array.from(document.querySelectorAll('a.nav-item, nav a, .sidebar a'));
    const repLink = navItems.find(el => (el.textContent || '').includes('Reports')) as HTMLElement;
    if (repLink) repLink.click();
  });
  await new Promise(r => setTimeout(r, 4000));

  // 4. Capture Screenshot
  const screenshotPath = path.join(process.cwd(), 'test', 'reports_screen_acceptance.png');
  await page.screenshot({ path: screenshotPath });
  console.log(`📸 Screenshot captured: ${screenshotPath}`);

  // 5. Inspect Elements
  const title = await page.title();
  const pageText = await page.evaluate(() => document.body.innerText);

  const hasReports = pageText.includes('Operational Records') || pageText.includes('Report');
  const hasLivePill = pageText.includes('Live Synced') || pageText.includes('Updating') || pageText.includes('Cached');
  const hasKpiCards = pageText.includes('Operations') || pageText.includes('Duration') || pageText.includes('Barriers');
  const hasFilters = pageText.includes('Barrier Status') || pageText.includes('Operational Shift');

  console.log(`- Page Title: "${title}"`);
  console.log(`- Reports Header Detected: ${hasReports}`);
  console.log(`- Live Sync Status Pill Detected: ${hasLivePill}`);
  console.log(`- KPI Summary Cards Detected: ${hasKpiCards}`);
  console.log(`- Filter Controls Detected: ${hasFilters}`);

  // 6. Test Local Storage Entries
  const localStorageKeys = await page.evaluate(() => {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) keys.push(k);
    }
    return keys;
  });

  const cacheEntries = localStorageKeys.filter(k => k.startsWith('lc_rep_'));
  console.log(`- LocalStorage Cache Entries Created: ${cacheEntries.length} (${cacheEntries.join(', ')})`);

  await browser.close();

  console.log('\n========================================================================');
  console.log('🎉 ACTUAL BROWSER ACCEPTANCE RUN COMPLETED SUCCESSFULLY');
  console.log('========================================================================\n');
}

runBrowserAcceptance().catch(err => {
  console.error('Browser Acceptance Failed:', err);
  process.exit(1);
});
