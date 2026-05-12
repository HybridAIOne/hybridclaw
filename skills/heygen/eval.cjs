'use strict';

function runEvalScenarios({
  apiBase,
  apiKeySecret,
  buildHttpRequest,
  classifyPlan,
  classifyRateLimit,
}) {
  const scenarios = [
    {
      name: 'read avatars',
      output: buildHttpRequest({ url: `${apiBase}/v2/avatars` }),
      check: (output) =>
        output.httpRequest.method === 'GET' &&
        output.httpRequest.secretHeaders[0].secretName === apiKeySecret,
    },
    {
      name: 'plan generation',
      output: classifyPlan('Create an avatar video from this approved script'),
      check: (output) =>
        output.operation === 'video-generate' && output.stakesTier === 'amber',
    },
    {
      name: 'rate limit',
      output: classifyRateLimit(['--status', '429', '--retry-after', '3']),
      check: (output) =>
        output.rateLimited === true && output.retryAfterMs === 3_000,
    },
  ];
  const failed = scenarios.filter(
    (scenario) => !scenario.check(scenario.output),
  );
  return {
    scenarioCount: scenarios.length,
    failed: failed.length,
    categories: {
      read: 1,
      planning: 1,
      'rate-limit': 1,
    },
  };
}

module.exports = { runEvalScenarios };
