const fs = require('fs');
const path = require('path');

module.exports = function () {
  const dir = path.join(__dirname, '..', 'guest-appearances');
  const appearances = [];

  if (fs.existsSync(dir)) {
    fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .forEach(f => {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        appearances.push(data);
      });
  }

  // Sort by date descending if dates exist, otherwise keep file order
  appearances.sort((a, b) => {
    if (a.date && b.date) return b.date.localeCompare(a.date);
    if (a.date) return -1;
    if (b.date) return 1;
    return 0;
  });

  return appearances;
};
