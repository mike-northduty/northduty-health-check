const { readFileSync } = require('fs');
const { join } = require('path');
const { LIMITS } = require('../constants');

let _axeSource = null;

function getAxeSource() {
  if (_axeSource === null) {
    _axeSource = readFileSync(
      join(__dirname, '../../node_modules/axe-core/axe.min.js'),
      'utf8',
    );
  }
  return _axeSource;
}

async function runAccessibilityAudit(page) {

  await page.evaluate(getAxeSource());

  const raw = await page.evaluate(async () => {
    return window.axe.run(document, {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'],
      },
      resultTypes: ['violations'],
    });
  });

  const allViolations = (raw.violations || []).map((v) => ({
    id: v.id,
    impact: v.impact || 'minor',
    description: v.description,
    nodeCount: v.nodes?.length ?? 0,
  }));

  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const v of allViolations) {
    const impact = v.impact in counts ? v.impact : 'minor';
    counts[impact]++;
  }

  const penalty =
    Math.min(counts.critical * 10, 50) +
    Math.min(counts.serious * 5, 25) +
    Math.min(counts.moderate * 3, 15) +
    Math.min(counts.minor * 1, 10);

  return {
    violations: allViolations.slice(0, LIMITS.MAX_ACCESSIBILITY_VIOLATIONS),
    criticalCount: counts.critical,
    seriousCount: counts.serious,
    moderateCount: counts.moderate,
    minorCount: counts.minor,

    ruleCount: allViolations.length,
    affectedElementCount: allViolations.reduce((total, v) => total + (v.nodeCount || 0), 0),
    score: Math.max(0, 100 - penalty),
  };
}

module.exports = { runAccessibilityAudit };
