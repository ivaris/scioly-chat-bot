import { defineAuth, defineBackend } from '@aws-amplify/backend';
import { data } from './data/resource';
import { chatFunction } from './functions/chat/resource';
import { documentsFunction } from './functions/documents/resource';

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
