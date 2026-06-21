const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
try {
  new Function(m[1]);
  console.log('CLIENT_OK');
} catch (e) {
  console.error('CLIENT_ERROR:', e.message);
  process.exit(1);
}
