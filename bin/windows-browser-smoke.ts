#!/usr/bin/env node
import 'dotenv/config';
import { searchFacebookMarketplaceDetailed } from '../src/facebook-marketplace.js';

const url = process.env.WINDOWS_BROWSER_URL;
const token = process.env.WINDOWS_BROWSER_TOKEN || process.env.BROWSER_WORKER_TOKEN;
if (!url || !token) throw new Error('Set WINDOWS_BROWSER_URL and WINDOWS_BROWSER_TOKEN (or BROWSER_WORKER_TOKEN)');
// Read-only. Does not load watches, send alerts or touch listing stores.
const result = await searchFacebookMarketplaceDetailed({
  browserWorkerUrl: url,
  browserWorkerToken: token,
  marketplaceAreaId: process.env.MARKETPLACE_AREA_ID || '',
  httpTimeoutMs: 120000,
}, process.argv[2] || 'robot mower', 7, 5, 20, undefined, undefined, 15000);
console.log(JSON.stringify(result, null, 2));
