import { defineFunction, secret } from '@aws-amplify/backend';

export const chatFunction = defineFunction({
  name: 'chat',
  entry: './handler.ts',
  timeoutSeconds: 30,
  environment: {
    OPENAI_API_KEY: secret('OPENAI_API_KEY'),
    GOOGLE_API_KEY: secret('GOOGLE_API_KEY'),
  },
});
