import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource.ts';
import { data } from './data/resource.ts';
import { chatFunction } from './functions/chat/resource.ts';
import { documentsFunction } from './functions/documents/resource.ts';

defineBackend({
  auth,
  data,
  chatFunction,
  documentsFunction,
});
