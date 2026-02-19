import { defineFunction } from '@aws-amplify/backend';

export const preSignupFunction = defineFunction({
  name: 'pre-signup',
  entry: './handler.ts',
});
