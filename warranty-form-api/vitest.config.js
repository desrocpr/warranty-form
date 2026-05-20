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
      RENOLUTION_EASYTERRITORY_PROJECT_ID: 'test-renolution-project-id',
      RENOLUTION_API_URL: 'https://renolution.test/api/leads/external',
      RENOLUTION_API_KEY: 'test-renolution-api-key',
      OUT_OF_SERVICE_URL: 'https://www.mossbuildinganddesign.com/out-of-service-area',
    },
  },
});
