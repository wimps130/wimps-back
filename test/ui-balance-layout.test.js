const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('shop pages should not render wallet balance, user, or deposit card blocks', () => {
  const pageFiles = [
    'wimps/mtn.html',
    'wimps/atgo.html',
    'wimps/telecel.html'
  ];

  for (const page of pageFiles) {
    const filePath = path.join(__dirname, '..', '..', page);
    const html = fs.readFileSync(filePath, 'utf8');
    assert.equal(html.includes('id="wallet-balance"'), false, `${page} must not render wallet balance in the shop hero summary`);
    assert.equal(html.includes('id="user-name"'), false, `${page} must not render the user summary card`);
    assert.equal(html.includes('id="deposit-amount"'), false, `${page} must not render a deposit form card`);
  }
});

test('home page dashboard state must guard accountStats for anonymous users', () => {
  const helperFile = path.join(__dirname, '..', '..', 'wimps', 'home-page.js');
  const source = fs.readFileSync(helperFile, 'utf8');

  assert.ok(source.includes("localStorage.removeItem('accountStats')"), 'anonymous users must clear stale accountStats from localStorage');
  assert.ok(source.includes("if (!user || !user.email)"), 'dashboard load must confirm a user before rendering account stats');
});

test('shared page scripts must avoid top-level duplicate globals', () => {
  const files = ['wimps/mtn.js', 'wimps/atgo.js', 'wimps/login-page.js'];

  for (const file of files) {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
    assert.ok(source.includes('(() => {') || source.includes('window.WIMPS'), `${file} must scope top-level script state to avoid duplicate global declarations`);
  }
});

test('admin routes should degrade to file-backed data when MongoDB is unavailable', () => {
  const adminRouteSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'), 'utf8');

  assert.ok(adminRouteSource.includes('readData("users.json")'), 'customers route should offer a file-backed fallback for the admin customer view');
  assert.ok(adminRouteSource.includes('readData("transactions.json")'), 'orders and overview route should offer a file-backed fallback for the admin view');
});

test('deleted accounts cannot keep using old sessions or legacy demo logins', () => {
  const authSource = fs.readFileSync(path.join(__dirname, '..', 'utils', 'auth.js'), 'utf8');
  const loginSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');
  assert.ok(authSource.includes('Your account no longer exists'), 'authenticated requests must reject deleted accounts');
  assert.equal(loginSource.includes('DEMO_ACCOUNTS'), false, 'deleted demo accounts must not be recreated');
});

test('Google sign-in supports the fallback user store', () => {
  const authSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');
  assert.ok(authSource.includes('if (isFallback(req))'), 'Google sign-in must work when fallback storage is active');
  assert.ok(authSource.includes('writeUsers(users)'), 'Google sign-in must persist fallback users');
});

test('completed purchases include SMS notification and delivery fee wiring', () => {
  const walletSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'wallet.js'), 'utf8');
  const smsSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'sendcomms.js'), 'utf8');
  const pricingSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'resellerxpress.js'), 'utf8');
  assert.ok(walletSource.includes('if (tx.status === "completed")'), 'SMS must only send after confirmed delivery');
  assert.ok(walletSource.includes('sendSms({ phone, message })'), 'completed purchases must send a confirmation SMS');
  assert.ok(smsSource.includes('/sms/pricing'), 'SendComms pricing endpoint must be supported');
  assert.ok(pricingSource.includes('getConfiguredSmsFee'), 'SMS delivery fee must be included in plan pricing');
});

test('bundle handling fee is fixed per network', () => {
  const { calculateSellingPrice, configurePricingRules } = require('../services/resellerxpress');
  configurePricingRules({ handlingFees: { test: 0.5 } });
  const oneGb = calculateSellingPrice(4, 1, "test");
  const twoGb = calculateSellingPrice(7, 2, "test");
  const threeGb = calculateSellingPrice(10, 3, "test");
  assert.equal(oneGb.expectedProfit, 0.5, 'one GB should use one handling fee');
  assert.equal(twoGb.expectedProfit, 1, 'two GB should use two handling fees');
  assert.equal(threeGb.sellingPrice, 11.5, 'three GB should add three handling fees');
});

test('provider stock checks compare balance with the provider charge, not the total', async () => {
  const service = require('../services/resellerxpress');
  const originalIsConfigured = service.isConfigured;
  const originalGetWalletBalance = service.getWalletBalance;
  service.isConfigured = () => true;
  service.getWalletBalance = async () => ({ balance: 4.25 });

  try {
    const [plan] = await service.markProviderWalletAvailability([{
      provider: 'resellerxpress', price: 4, cost: 4, total: 4.5, available: true, purchasable: true
    }]);
    assert.equal(plan.available, true, 'wallet balance covers the actual provider charge');
    assert.equal(plan.purchasable, true, 'provider fee must not incorrectly mark this bundle unavailable');
  } finally {
    service.isConfigured = originalIsConfigured;
    service.getWalletBalance = originalGetWalletBalance;
  }
});

test('RemaData bundle listings without prices are enriched from its cost-price endpoint', async () => {
  const axios = require('axios');
  const { getRemaDataPlans, placeProviderOrder } = require('../services/resellerxpress');
  const originalGet = axios.get;
  const originalPost = axios.post;
  const originalApiKey = process.env.REMADATA_API_KEY;
  const originalBaseUrl = process.env.REMADATA_BASE_URL;
  process.env.REMADATA_API_KEY = 'test-key';
  process.env.REMADATA_BASE_URL = 'https://example.test/api';
  axios.get = async (url) => {
    assert.equal(url, 'https://example.test/api/bundles');
    return { data: [
      { network: 'mtn', name: '1GB', volume: '1.00GB', volumeInMB: 1024 },
      { network: 'mtn', name: '2GB', volume: '1.95GB', volumeInMB: 2000 }
    ] };
  };
  axios.post = async (url, body) => {
    if (url.endsWith('/get-cost-price')) {
      assert.ok([1024, 2000].includes(body.volumeInMB));
      return { data: { status: 'success', api_price: '9.30' } };
    }
    assert.equal(url, 'https://example.test/api/buy-data');
    assert.equal(body.volumeInMB, 1024);
    return { data: { status: 'success' } };
  };

  try {
    const plans = await getRemaDataPlans('mtn');
    assert.deepEqual(plans.map((plan) => plan.volumeGb), [1, 2]);
    assert.deepEqual(plans.map((plan) => plan.volume), ['1GB', '2GB']);
    assert.deepEqual(plans.map((plan) => plan.providerVolumeInMB), [1024, 2000]);
    assert.deepEqual(plans.map((plan) => plan.price), [9.3, 9.3]);
    assert.ok(plans.every((plan) => plan.provider === 'remadata' && plan.available));
    await placeProviderOrder('remadata', {
      phone: '0241234567', network: 'mtn', volumeGb: 1, providerVolumeInMB: plans[0].providerVolumeInMB,
      request_id: 'test-remadata-order'
    });
  } finally {
    axios.get = originalGet;
    axios.post = originalPost;
    if (originalApiKey === undefined) delete process.env.REMADATA_API_KEY;
    else process.env.REMADATA_API_KEY = originalApiKey;
    if (originalBaseUrl === undefined) delete process.env.REMADATA_BASE_URL;
    else process.env.REMADATA_BASE_URL = originalBaseUrl;
  }
});

test('resellerxpress plans should return a visible fallback list when upstream plans are empty', async () => {
  const { getPlans } = require('../services/resellerxpress');
  const plans = await getPlans('mtn');

  assert.ok(Array.isArray(plans), 'fallback plans should be returned as an array');
  assert.ok(plans.length > 0, 'fallback plan list must be non-empty when remote provider payloads are empty');
});
