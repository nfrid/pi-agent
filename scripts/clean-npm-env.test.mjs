import { describe, expect, it } from 'vitest';
import { cleanAgentEnv } from './clean-npm-env.mjs';

describe('cleanAgentEnv', () => {
  it('removes the delegate marker while retaining other variables and cleanup', () => {
    const cleaned = cleanAgentEnv({
      PI_DELEGATE_CHILD: '1',
      PI_MODEL: 'gpt-test',
      npm_config_devdir: '/tmp/devdir',
      npm_config_cache: '/tmp/cursor-sandbox-cache/npm',
      KEEP_THIS: 'yes',
    });

    expect(cleaned).toEqual({ PI_MODEL: 'gpt-test', KEEP_THIS: 'yes' });
  });
});
