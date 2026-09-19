#!/usr/bin/env node
/**
 * Test script for POST /api/run endpoint
 * Usage: node scripts/test-api-run.mjs [--port 3000]
 */

import http from 'http';

const PORT = process.argv.includes('--port')
  ? parseInt(process.argv[process.argv.indexOf('--port') + 1], 10) || 3000
  : 3000;

const payload = JSON.stringify({
  worker: 'dsh',
  prompt: '你好',
  session: 'test-session'
});

console.log(`Testing POST /api/run on port ${PORT}...`);

const req = http.request({
  hostname: 'localhost',
  port: PORT,
  path: '/api/run',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  }
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    try {
      const response = JSON.parse(data);
      console.log('Response:', JSON.stringify(response, null, 2));
      
      if (res.statusCode === 200 && response.taskId) {
        console.log('✓ Test PASSED: endpoint works correctly');
        process.exit(0);
      } else if (res.statusCode === 404) {
        console.log('✗ Test EXPECTED: endpoint does not exist (404)');
        process.exit(1);
      } else {
        console.log('✗ Test FAILED: unexpected response');
        process.exit(1);
      }
    } catch (e) {
      console.log('Raw response:', data);
      console.log('✗ Test FAILED: invalid JSON response');
      process.exit(1);
    }
  });
});

req.on('error', (err) => {
  console.error('Request error:', err.message);
  process.exit(1);
});

req.write(payload);
req.end();
