import { defineAuth, defineBackend } from '@aws-amplify/backend';
import { data } from './data/resource.ts';
import { chatFunction } from './functions/chat/resource.ts';
import { documentsFunction } from './functions/documents/resource.ts';

const auth = defineAuth({
  loginWith: {
    email: true,
  },
});

defineBackend({
  auth,
  data,
  chatFunction,
  documentsFunction,
});
