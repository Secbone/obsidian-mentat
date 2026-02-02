import { createMockSkillContext } from '../../../utils/test-helpers';

export const mockContextWithBrowserless = createMockSkillContext({
  plugin: {
    settings: {
      browserlessApiKey: 'test-api-key-12345'
    }
  } as any
});

export const mockContextWithoutBrowserless = createMockSkillContext({
  plugin: {
    settings: {
      browserlessApiKey: ''
    }
  } as any
});
