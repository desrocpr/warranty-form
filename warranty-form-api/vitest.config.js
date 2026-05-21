import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.js', 'tests/integration/**/*.test.js'],
    env: {
      EASYTERRITORY_BASE_URL: 'https://apps.easyterritory.com',
      EASYTERRITORY_GUID: 'test-guid',
      EASYTERRITORY_INSTANCE_TYPE: 'APP',
      EASYTERRITORY_USERNAME: 'testuser',
      EASYTERRITORY_PASSWORD: 'testpass',
      EASYTERRITORY_PROJECT_ID: 'test-project-id',
    },
  },
});
